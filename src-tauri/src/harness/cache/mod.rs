//! Prompt-cache telemetry for the agent loop (F0a/F1.1, PLAN §4.7/§4.8).
//!
//! [`CacheTracker`] consumes the canonical [`PrefixDigest`] emitted by
//! `providers::cache` (owner of the wire prefix identity) plus the normalized
//! [`UsageInfo`] of each request, and produces one [`CacheSample`] per **wire
//! request** (not per turn):
//!
//! - `P`/`Δ`/ceiling are estimated from the digest (`chars / 4` heuristic);
//! - `hit_percent` is always the provider-reported one (`None` = não reportado);
//! - persistent prefix changes are attributed to a [`CacheBreakReason`];
//! - the [`CacheState`] tells the meter whether the request is cold, warming,
//!   stable, degraded or unsupported.
//!
//! F1.1 seeds the tracker from the persisted `cache_state` ([`PersistedCache`])
//! at the start of a turn and keeps the lifecycle totals, so the agent loop can
//! persist `cache_samples`/`cache_state` without this module depending on
//! storage.

#[cfg(test)]
pub mod bench;
pub mod epoch;
pub mod prefix;
pub mod snapshot;

use sha2::{Digest, Sha256};

use crate::domain::{
    now_ms, CacheBreakReason, CacheSample, PrefixDigest, SegmentDigest, SegmentKind, UsageInfo,
};

pub use epoch::{EpochChange, EpochKey, EpochTracker};
pub use prefix::{CacheCounters, PrefixEstimate};

/// Persisted cache state of a conversation, used to seed a new turn (F1.1).
///
/// Mirrors the fields of `db::CacheStateRecord` that the tracker consumes; the
/// mapping lives in the harness so this module stays independent from storage.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PersistedCache {
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub protocol: Option<String>,
    pub epoch: u32,
    pub prefix_segments: Option<Vec<SegmentDigest>>,
    pub cache_read: u32,
    pub cache_write: u32,
    pub uncached: u32,
    pub samples: u32,
    pub last_break_reason: Option<CacheBreakReason>,
    pub last_break_detail: Option<String>,
}

/// In-memory cache tracker: last digest of the current epoch + lifecycle totals.
#[derive(Debug, Clone, Default)]
pub struct CacheTracker {
    epochs: EpochTracker,
    /// Digest of the last request observed in the current epoch.
    previous: Option<PrefixDigest>,
    last_sample: Option<CacheSample>,
    /// Cumulative counters (`cache_state`): restored from the DB + this turn.
    totals: CacheCounters,
    /// Cumulative sample count (`cache_state`): restored + this turn.
    persisted_samples: u32,
    /// Most recent persistent break (survives samples without a break).
    last_break: Option<(CacheBreakReason, Option<String>)>,
    /// Catalog `minTokens` of the route (`None` = unknown).
    min_cacheable_tokens: Option<u32>,
    /// Break cause of an explicit epoch bump (compaction) applied to the next
    /// observation (F3b).
    pending_epoch_break: Option<CacheBreakReason>,
}

impl CacheTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seeds a tracker from the persisted `cache_state` of a conversation.
    ///
    /// The persisted epoch/route is kept: the first request of the new turn
    /// continues it when the route matches (no artificial `Cold`) or starts
    /// `epoch + 1` with `ModelSwitch`/`ProtocolFallback` when it does not.
    pub fn from_persisted(persisted: PersistedCache) -> Self {
        let mut tracker = Self::new();
        tracker.totals = CacheCounters {
            input_total: persisted
                .cache_read
                .saturating_add(persisted.cache_write)
                .saturating_add(persisted.uncached),
            cache_read: persisted.cache_read,
            cache_write: persisted.cache_write,
            uncached: persisted.uncached,
        };
        tracker.persisted_samples = persisted.samples;
        tracker.last_break = persisted
            .last_break_reason
            .map(|reason| (reason, persisted.last_break_detail.clone()));
        if persisted.epoch > 0 {
            // A legacy record without identity keeps the epoch: the first
            // request differs from the empty route and starts `epoch + 1`.
            tracker.epochs.seed(
                persisted.epoch,
                Some(EpochKey {
                    provider_id: persisted.provider_id.clone().unwrap_or_default(),
                    model_id: persisted.model_id.clone().unwrap_or_default(),
                    protocol: persisted.protocol.clone().unwrap_or_default(),
                }),
            );
        }
        if let Some(segments) = persisted
            .prefix_segments
            .filter(|segments| !segments.is_empty())
        {
            tracker.previous = Some(prefix_digest(
                persisted.protocol.clone().unwrap_or_default(),
                segments,
            ));
        }
        tracker
    }

    /// Current epoch (`0` before the first request).
    #[allow(dead_code)]
    pub fn epoch(&self) -> u32 {
        self.epochs.epoch()
    }

    /// Requests observed by this tracker instance.
    #[allow(dead_code)]
    pub fn samples(&self) -> u32 {
        self.epochs.samples()
    }

    /// Cumulative requests of the conversation (`cache_state.samples`).
    pub fn total_samples(&self) -> u32 {
        self.persisted_samples
    }

    /// Cumulative cache counters of the conversation (`cache_state`).
    pub fn totals(&self) -> CacheCounters {
        self.totals
    }

    /// Most recent persistent break (reason + detail), if any.
    pub fn last_break(&self) -> Option<(CacheBreakReason, Option<String>)> {
        self.last_break.clone()
    }

    /// Catalog `minTokens` used by eligibility (`None` = unknown).
    ///
    /// Set by the harness with `providers::cache::capabilities_for(...)`; a
    /// route without capabilities keeps `None` (`unknown_min`).
    pub fn set_min_cacheable_tokens(&mut self, min_tokens: Option<u32>) {
        self.min_cacheable_tokens = min_tokens;
    }

    /// Starts a new explicit epoch (compaction/regenerate): bumps the epoch and
    /// makes the next sample report `break_reason = reason` with `Cold` state
    /// and no reusable prefix (F3b, PLAN "epoch compaction").
    pub fn trigger_epoch_break(&mut self, reason: CacheBreakReason) {
        self.epochs.bump_epoch();
        self.pending_epoch_break = Some(reason);
        // Sem reuso de P/Δ do epoch anterior (novo domínio de prefixo).
        self.previous = None;
    }

    /// Observer without raw usage (compat para testes/unidades que não têm o
    /// payload bruto do provedor). Delega para [`Self::observe_with_raw`].
    #[cfg(test)]
    pub fn observe(
        &mut self,
        provider_id: &str,
        model_id: &str,
        protocol: &str,
        digest: Option<&PrefixDigest>,
        usage: Option<&UsageInfo>,
        step: u32,
        turn_id: &str,
    ) -> CacheSample {
        self.observe_with_raw(
            provider_id,
            model_id,
            protocol,
            digest,
            usage,
            None,
            step,
            turn_id,
        )
    }

    /// Observes one provider request and builds its [`CacheSample`].
    ///
    /// `protocol` is the wire protocol that actually served the request; when
    /// empty it is taken from the digest. `digest`/`usage` are optional so a
    /// request that failed before producing either still yields an honest
    /// "não reportado" sample instead of a fabricated hit. `raw_usage` é o
    /// recorte seguro emitido por `ProviderEvent::UsageRaw` (B2), persistido na
    /// amostra para o popover/"copiar usage bruto".
    #[allow(clippy::too_many_arguments)]
    pub fn observe_with_raw(
        &mut self,
        provider_id: &str,
        model_id: &str,
        protocol: &str,
        digest: Option<&PrefixDigest>,
        usage: Option<&UsageInfo>,
        raw_usage: Option<&serde_json::Value>,
        step: u32,
        turn_id: &str,
    ) -> CacheSample {
        let protocol = if protocol.is_empty() {
            digest.map_or("", |digest| digest.protocol.as_str())
        } else {
            protocol
        };
        let change = self.epochs.observe(provider_id, model_id, protocol);
        // Explicit epoch break (compaction/regenerate) wins over a plain
        // continuation: the prefix was rewritten deliberately (F3b).
        let pending_break = self.pending_epoch_break.take();
        let started_epoch = pending_break.is_some() || !matches!(change, EpochChange::Continue);
        let first_request = started_epoch;
        // Cross-epoch comparisons are meaningless: a new cache domain has no
        // reusable prefix, so `P = 0` and the ceiling stays unknown.
        let baseline = if started_epoch {
            None
        } else {
            self.previous.as_ref()
        };

        let estimate = digest.map_or_else(PrefixEstimate::default, |digest| {
            prefix::estimate(digest, baseline)
        });
        let counters = usage.map_or_else(CacheCounters::default, |usage| {
            prefix::counters(protocol, usage)
        });
        let reported = usage.is_some_and(prefix::reported);
        let hit = usage.and_then(|usage| prefix::hit_percent(protocol, usage));
        let ceiling = prefix::ceiling_percent(estimate.prefix_tokens, estimate.delta_tokens);

        // A new epoch is cold by definition; its cause is the epoch reason
        // (compaction / model switch / protocol fallback) when there is one.
        let (break_reason, break_detail) = match pending_break {
            Some(reason) => (
                Some(reason),
                Some(format!(
                    "novo epoch {} iniciado ({reason:?})",
                    self.epochs.epoch()
                )),
            ),
            None => match change {
                EpochChange::First => (
                    Some(CacheBreakReason::FirstRequest),
                    Some("primeiro request do epoch".to_string()),
                ),
                EpochChange::Changed(reason) => (
                    Some(reason),
                    Some(format!(
                        "novo epoch {} iniciado ({reason:?})",
                        self.epochs.epoch()
                    )),
                ),
                EpochChange::Continue => match (digest, self.previous.as_ref()) {
                    (Some(current), Some(previous)) => {
                        match prefix::classify_break(current, previous) {
                            Some(detected) => (Some(detected.reason), Some(detected.detail)),
                            None => (None, None),
                        }
                    }
                    _ => (None, None),
                },
            },
        };
        let state = prefix::state(hit, reported, first_request, break_reason.is_some());
        let (eligible, excluded_reason) = eligibility(
            first_request,
            reported,
            &counters,
            estimate.prefix_tokens,
            self.min_cacheable_tokens,
        );
        // The last break survives samples without a break (persisted in
        // `cache_state.last_break_*` for the diagnostics popover).
        let detected_break = break_reason.map(|reason| (reason, break_detail.clone()));

        // The digest of the current request becomes the baseline of the next
        // one. A request without a digest keeps the previous baseline so one
        // failed attempt does not fake a break.
        if started_epoch {
            self.previous = digest.cloned();
        } else if let Some(digest) = digest {
            self.previous = Some(digest.clone());
        }

        let sample = CacheSample {
            turn_id: turn_id.to_string(),
            step,
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            protocol: protocol.to_string(),
            epoch: self.epochs.epoch(),
            input_total: counters.input_total,
            cache_read: counters.cache_read,
            cache_write: counters.cache_write,
            uncached: counters.uncached,
            hit_percent: hit,
            ceiling_percent: ceiling,
            prefix_tokens_est: estimate.prefix_tokens,
            delta_tokens_est: estimate.delta_tokens,
            eligible,
            excluded_reason,
            state,
            break_reason,
            break_detail,
            raw_usage: raw_usage.cloned(),
            at: now_ms(),
        };
        self.totals.add(&counters);
        self.persisted_samples = self.persisted_samples.saturating_add(1);
        if let Some(detected) = detected_break {
            self.last_break = Some(detected);
        }
        self.last_sample = Some(sample.clone());
        sample
    }
}

/// Eligibility of one sample for the hit target (PLAN §2.2/§2.3; contract
/// confirmed with the Lead for F1.1).
///
/// Precedence: `cold` → `not_reported` → `write_only` → `below_min` →
/// `unknown_min`. A low `ceiling` does **not** exclude the request here (the
/// aggregation/benchmark applies the ceiling gate); it stays in
/// `ceiling_percent` for the caller.
fn eligibility(
    first_request: bool,
    reported: bool,
    counters: &CacheCounters,
    prefix_tokens: u32,
    min_cacheable_tokens: Option<u32>,
) -> (bool, Option<String>) {
    if first_request {
        return (false, Some("cold".to_string()));
    }
    if !reported {
        return (false, Some("not_reported".to_string()));
    }
    if counters.cache_read == 0 && counters.cache_write > 0 {
        return (false, Some("write_only".to_string()));
    }
    match min_cacheable_tokens {
        Some(min) if prefix_tokens < min => (false, Some("below_min".to_string())),
        Some(_) => (true, None),
        // Unknown minimum: excluded from the target and counted, never 0.
        None => (false, Some("unknown_min".to_string())),
    }
}

fn segment_kind_tag(kind: SegmentKind) -> u8 {
    match kind {
        SegmentKind::System => 0,
        SegmentKind::Tools => 1,
        SegmentKind::Message => 2,
        SegmentKind::TransientTail => 3,
    }
}

/// Stable hash (hex SHA-256) of the canonical prefix, persisted as
/// `cache_state.prefix_hash` / `cache_samples.prefix_hash`.
///
/// The provider digest already chains the segment hashes; this hash also keeps
/// the protocol and the segment metadata so a changed order/kind/count changes
/// the persisted identity.
pub fn prefix_hash(digest: &PrefixDigest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(digest.protocol.as_bytes());
    for segment in &digest.segments {
        hasher.update([segment_kind_tag(segment.kind)]);
        hasher.update(segment.index.to_le_bytes());
        hasher.update(segment.chars.to_le_bytes());
        hasher.update(segment.sha256);
    }
    let hash = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Rebuilds a digest from persisted segments (the record has no `total_chars`).
fn prefix_digest(protocol: String, segments: Vec<SegmentDigest>) -> PrefixDigest {
    let total_chars = segments
        .iter()
        .map(|segment| segment.chars)
        .fold(0u32, u32::saturating_add);
    PrefixDigest {
        protocol,
        segments,
        total_chars,
        estimated_tokens: total_chars / prefix::CHARS_PER_TOKEN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CacheState, SegmentDigest, SegmentKind};

    fn digest(entries: &[(SegmentKind, u8, u32)]) -> PrefixDigest {
        let segments: Vec<SegmentDigest> = entries
            .iter()
            .enumerate()
            .map(|(index, (kind, hash, chars))| {
                let mut sha = [0u8; 32];
                sha[0] = *hash;
                SegmentDigest {
                    kind: *kind,
                    index: index as u32,
                    sha256: sha,
                    chars: *chars,
                }
            })
            .collect();
        let total = segments
            .iter()
            .map(|segment| segment.chars)
            .fold(0u32, u32::saturating_add);
        PrefixDigest {
            protocol: "openai-chat".to_string(),
            segments,
            total_chars: total,
            estimated_tokens: total / prefix::CHARS_PER_TOKEN,
        }
    }

    fn system(hash: u8, chars: u32) -> (SegmentKind, u8, u32) {
        (SegmentKind::System, hash, chars)
    }

    fn tools(hash: u8, chars: u32) -> (SegmentKind, u8, u32) {
        (SegmentKind::Tools, hash, chars)
    }

    fn message(hash: u8, chars: u32) -> (SegmentKind, u8, u32) {
        (SegmentKind::Message, hash, chars)
    }

    /// OpenAI-style usage: inclusive input with a reported cache read.
    fn openai_usage(input: u32, read: u32) -> UsageInfo {
        UsageInfo {
            input_tokens: Some(input),
            cached_tokens: Some(read),
            cache_reported: true,
            ..Default::default()
        }
    }

    #[test]
    fn first_request_is_cold_and_excluded() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), tools(2, 400), message(3, 400)]);
        let sample = tracker.observe(
            "opencode-go",
            "deepseek-v4.1-flash",
            "",
            Some(&first),
            Some(&openai_usage(1_000, 0)),
            1,
            "turn-1",
        );
        assert_eq!(sample.turn_id, "turn-1");
        assert_eq!(sample.step, 1);
        assert_eq!(sample.protocol, "openai-chat");
        assert_eq!(sample.epoch, 1);
        assert_eq!(sample.state, CacheState::Cold);
        assert_eq!(sample.break_reason, Some(CacheBreakReason::FirstRequest));
        assert_eq!(sample.hit_percent, Some(0.0));
        assert_eq!(sample.ceiling_percent, None);
        assert_eq!(sample.prefix_tokens_est, 0);
        assert_eq!(sample.delta_tokens_est, 400);
        assert!(!sample.eligible);
        assert_eq!(sample.excluded_reason.as_deref(), Some("cold"));
        assert_eq!(sample.cache_read, 0);
        assert_eq!(sample.input_total, 1_000);
    }

    #[test]
    fn plugin_config_change_is_reported_as_its_own_break() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), tools(2, 400)]);
        tracker.observe(
            "opencode-go",
            "deepseek-v4.1-flash",
            "",
            Some(&first),
            Some(&openai_usage(1_000, 0)),
            1,
            "turn-1",
        );
        tracker.trigger_epoch_break(CacheBreakReason::PluginConfigChanged);
        let second = digest(&[system(2, 900), tools(3, 500)]);
        let sample = tracker.observe(
            "opencode-go",
            "deepseek-v4.1-flash",
            "",
            Some(&second),
            Some(&openai_usage(1_400, 0)),
            1,
            "turn-2",
        );
        assert_eq!(
            sample.break_reason,
            Some(CacheBreakReason::PluginConfigChanged)
        );
        assert!(sample
            .break_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("PluginConfigChanged")));
        assert_eq!(sample.state, CacheState::Cold);
    }

    #[test]
    fn second_request_extends_the_prefix_without_breaking() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), tools(2, 400), message(3, 400)]);
        let second = digest(&[
            system(1, 800),
            tools(2, 400),
            message(3, 400),
            message(4, 80),
        ]);
        tracker.observe(
            "opencode-go",
            "deepseek-v4.1-flash",
            "openai-chat",
            Some(&first),
            Some(&openai_usage(1_000, 0)),
            1,
            "turn-1",
        );
        // Catalog minimum known and satisfied: the sample is eligible.
        tracker.set_min_cacheable_tokens(Some(100));
        let sample = tracker.observe(
            "opencode-go",
            "deepseek-v4.1-flash",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 900)),
            2,
            "turn-1",
        );
        assert_eq!(sample.epoch, 1);
        assert_eq!(sample.step, 2);
        assert_eq!(sample.break_reason, None);
        assert_eq!(sample.state, CacheState::Warming);
        assert_eq!(sample.hit_percent, Some(90.0));
        // P = (800 + 400 + 400) / 4, Δ = 80 / 4, ceiling = P/(P+Δ).
        assert_eq!(sample.prefix_tokens_est, 400);
        assert_eq!(sample.delta_tokens_est, 20);
        assert_eq!(sample.ceiling_percent, Some(95.238_1));
        assert!(sample.eligible);
        assert_eq!(sample.excluded_reason, None);
        assert_eq!(tracker.samples(), 2);
    }

    #[test]
    fn high_hit_is_stable() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), tools(2, 400), message(3, 400)]);
        let second = digest(&[
            system(1, 800),
            tools(2, 400),
            message(3, 400),
            message(4, 80),
        ]);
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 970)),
            2,
            "t",
        );
        assert_eq!(sample.state, CacheState::Stable);
        assert_eq!(sample.hit_percent, Some(97.0));
    }

    #[test]
    fn system_rewrite_degrades_with_the_right_cause() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), tools(2, 400), message(3, 400)]);
        let rewritten = digest(&[system(9, 800), tools(2, 400), message(3, 400)]);
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&rewritten),
            Some(&openai_usage(1_000, 500)),
            2,
            "t",
        );
        assert_eq!(sample.epoch, 1);
        assert_eq!(sample.state, CacheState::Degraded);
        assert_eq!(sample.break_reason, Some(CacheBreakReason::SystemPrompt));
        assert!(sample
            .break_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("segmento 0")));
        assert_eq!(sample.prefix_tokens_est, 0);
    }

    #[test]
    fn unreported_cache_is_unsupported_not_stable() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 100), message(2, 100)]);
        let second = digest(&[system(1, 100), message(2, 100), message(3, 100)]);
        tracker.observe("p", "m", "google", Some(&first), None, 1, "t");
        let sample = tracker.observe(
            "p",
            "m",
            "google",
            Some(&second),
            Some(&UsageInfo {
                input_tokens: Some(1_000),
                ..Default::default()
            }),
            2,
            "t",
        );
        assert_eq!(sample.hit_percent, None);
        assert_eq!(sample.state, CacheState::Unsupported);
        assert_eq!(sample.excluded_reason.as_deref(), Some("not_reported"));
        assert!(!sample.eligible);
    }

    #[test]
    fn model_switch_starts_a_new_cold_epoch() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), message(2, 400)]);
        tracker.observe("p", "m1", "openai-chat", Some(&first), None, 1, "t");
        let sample = tracker.observe(
            "p",
            "m2",
            "openai-chat",
            Some(&first),
            Some(&openai_usage(1_000, 0)),
            2,
            "t",
        );
        assert_eq!(sample.epoch, 2);
        assert_eq!(sample.state, CacheState::Cold);
        assert_eq!(sample.break_reason, Some(CacheBreakReason::ModelSwitch));
        assert_eq!(sample.excluded_reason.as_deref(), Some("cold"));
    }

    #[test]
    fn missing_digest_keeps_the_baseline_for_the_next_request() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), message(2, 400)]);
        let third = digest(&[system(1, 800), message(2, 400), message(3, 40)]);
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        // Request 2 failed before the provider emitted a digest: no baseline
        // change, no fake break.
        let failed = tracker.observe(
            "p",
            "m",
            "openai-chat",
            None,
            Some(&UsageInfo::default()),
            2,
            "t",
        );
        assert_eq!(failed.break_reason, None);
        assert_eq!(failed.ceiling_percent, None);
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&third),
            Some(&openai_usage(1_000, 900)),
            3,
            "t",
        );
        assert_eq!(sample.break_reason, None);
        assert_eq!(sample.prefix_tokens_est, 300);
    }

    #[test]
    fn low_ceiling_is_recorded_but_stays_eligible() {
        let mut tracker = CacheTracker::new();
        // Tiny prefix with a large delta: ceiling below the 98% target. The
        // ceiling gate is applied by the aggregation (PLAN §2.3), not here: the
        // baseline must still see the request.
        let first = digest(&[system(1, 40), message(2, 40)]);
        let second = digest(&[system(1, 40), message(2, 40), message(3, 1_600)]);
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        // Known minimum, satisfied: a low ceiling does not exclude the sample.
        tracker.set_min_cacheable_tokens(Some(1));
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 900)),
            2,
            "t",
        );
        assert_eq!(sample.ceiling_percent, Some(4.761_904_6));
        assert!(sample.eligible);
        assert_eq!(sample.excluded_reason, None);
        assert_eq!(sample.state, CacheState::Warming);
    }

    #[test]
    fn write_only_request_is_excluded() {
        let mut tracker = CacheTracker::new();
        let first = digest(&[system(1, 800), message(2, 400)]);
        let second = digest(&[system(1, 800), message(2, 400), message(3, 80)]);
        tracker.observe("p", "m", "anthropic", Some(&first), None, 1, "t");
        // Request 2 writes the prefix (explicit cache) and reads nothing: it
        // pays the write and belongs to the lifecycle aggregate, not the
        // steady-state target.
        let sample = tracker.observe(
            "p",
            "m",
            "anthropic",
            Some(&second),
            Some(&UsageInfo {
                input_tokens: Some(100),
                cache_write_tokens: Some(1_200),
                cache_reported: true,
                ..Default::default()
            }),
            2,
            "t",
        );
        assert_eq!(sample.cache_read, 0);
        assert_eq!(sample.cache_write, 1_200);
        assert_eq!(sample.hit_percent, Some(0.0));
        assert!(!sample.eligible);
        assert_eq!(sample.excluded_reason.as_deref(), Some("write_only"));
        assert_eq!(sample.state, CacheState::Warming);
    }

    /* ------------------------------------------------------------------ */
    /* F1.1: elegibilidade por minTokens + restauração do cache_state       */
    /* ------------------------------------------------------------------ */

    fn sample_pair() -> (PrefixDigest, PrefixDigest) {
        let first = digest(&[system(1, 800), tools(2, 400), message(3, 400)]);
        let second = digest(&[
            system(1, 800),
            tools(2, 400),
            message(3, 400),
            message(4, 80),
        ]);
        (first, second)
    }

    #[test]
    fn unknown_min_excludes_reported_samples() {
        let mut tracker = CacheTracker::new();
        let (first, second) = sample_pair();
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 900)),
            2,
            "t",
        );
        // The catalog did not provide `minTokens`: the sample is measured but
        // excluded from the hit target (`unknown_min`, PLAN §2.2).
        assert!(!sample.eligible);
        assert_eq!(sample.excluded_reason.as_deref(), Some("unknown_min"));
        assert_eq!(sample.hit_percent, Some(90.0));
        assert_eq!(sample.state, CacheState::Warming);
    }

    #[test]
    fn below_min_excludes_short_prefixes() {
        let mut tracker = CacheTracker::new();
        let (first, second) = sample_pair();
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        // P = 400 tokens, catalog minimum = 1.024.
        tracker.set_min_cacheable_tokens(Some(1_024));
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 900)),
            2,
            "t",
        );
        assert!(!sample.eligible);
        assert_eq!(sample.excluded_reason.as_deref(), Some("below_min"));
        assert_eq!(sample.prefix_tokens_est, 400);
    }

    #[test]
    fn known_min_satisfied_is_eligible() {
        let mut tracker = CacheTracker::new();
        let (first, second) = sample_pair();
        tracker.observe("p", "m", "openai-chat", Some(&first), None, 1, "t");
        tracker.set_min_cacheable_tokens(Some(400));
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 900)),
            2,
            "t",
        );
        assert!(sample.eligible);
        assert_eq!(sample.excluded_reason, None);
    }

    #[test]
    fn restored_tracker_continues_the_epoch_without_a_break() {
        let (first, second) = sample_pair();
        let persisted = PersistedCache {
            provider_id: Some("p".to_string()),
            model_id: Some("m".to_string()),
            protocol: Some("openai-chat".to_string()),
            epoch: 3,
            prefix_segments: Some(first.segments.clone()),
            cache_read: 900,
            cache_write: 100,
            uncached: 50,
            samples: 7,
            last_break_reason: Some(CacheBreakReason::HistoryRewrite),
            last_break_detail: Some("quebra anterior".to_string()),
        };
        let mut tracker = CacheTracker::from_persisted(persisted);
        tracker.set_min_cacheable_tokens(Some(100));
        let sample = tracker.observe(
            "p",
            "m",
            "openai-chat",
            Some(&second),
            Some(&openai_usage(1_000, 950)),
            1,
            "turn-2",
        );
        // Same route: no artificial Cold, no break, epoch preserved.
        assert_eq!(sample.epoch, 3);
        assert_eq!(sample.break_reason, None);
        assert_eq!(sample.state, CacheState::Stable);
        assert_eq!(sample.prefix_tokens_est, 400);
        assert!(sample.eligible);
        // Lifecycle totals and the last break survive the restart.
        assert_eq!(tracker.total_samples(), 8);
        assert_eq!(tracker.totals().cache_read, 1_850);
        assert_eq!(tracker.totals().cache_write, 100);
        assert_eq!(tracker.totals().uncached, 100);
        assert_eq!(
            tracker.last_break().map(|(reason, _)| reason),
            Some(CacheBreakReason::HistoryRewrite)
        );
    }

    #[test]
    fn restored_tracker_starts_a_new_epoch_on_model_switch() {
        let (first, _) = sample_pair();
        let persisted = PersistedCache {
            provider_id: Some("p".to_string()),
            model_id: Some("m1".to_string()),
            protocol: Some("openai-chat".to_string()),
            epoch: 5,
            prefix_segments: Some(first.segments.clone()),
            ..Default::default()
        };
        let mut tracker = CacheTracker::from_persisted(persisted);
        let sample = tracker.observe(
            "p",
            "m2",
            "openai-chat",
            Some(&first),
            Some(&openai_usage(1_000, 0)),
            1,
            "turn-2",
        );
        assert_eq!(sample.epoch, 6, "epoch anterior + 1");
        assert_eq!(sample.state, CacheState::Cold);
        assert_eq!(sample.break_reason, Some(CacheBreakReason::ModelSwitch));
        // A different cache domain has no reusable prefix.
        assert_eq!(sample.prefix_tokens_est, 0);
        assert_eq!(sample.ceiling_percent, None);
    }

    #[test]
    fn restored_tracker_starts_a_new_epoch_on_protocol_fallback() {
        let (first, _) = sample_pair();
        let persisted = PersistedCache {
            provider_id: Some("p".to_string()),
            model_id: Some("m".to_string()),
            protocol: Some("openai-chat".to_string()),
            epoch: 2,
            prefix_segments: Some(first.segments.clone()),
            ..Default::default()
        };
        let mut tracker = CacheTracker::from_persisted(persisted);
        let sample = tracker.observe(
            "p",
            "m",
            "anthropic",
            Some(&first),
            Some(&openai_usage(1_000, 0)),
            1,
            "turn-2",
        );
        assert_eq!(sample.epoch, 3);
        assert_eq!(
            sample.break_reason,
            Some(CacheBreakReason::ProtocolFallback)
        );
    }

    #[test]
    fn prefix_hash_is_stable_and_sensitive() {
        let (first, second) = sample_pair();
        assert_eq!(prefix_hash(&first), prefix_hash(&first));
        assert_ne!(prefix_hash(&first), prefix_hash(&second));
        // The hex hash is persisted in a TEXT column.
        assert_eq!(prefix_hash(&first).len(), 64);
        assert!(prefix_hash(&first)
            .chars()
            .all(|char| char.is_ascii_hexdigit()));
    }
}
