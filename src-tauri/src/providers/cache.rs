//! Prompt-cache mechanics per wire protocol (single owner — PLAN §4.5).
//!
//! This module owns four things:
//!
//! - [`capabilities`]: what a `(protocol, provider, model)` route can cache
//!   (mode, minimum tokens, TTL options, whether the wire controls exist and
//!   whether the provider reports cache counters).
//! - [`digest`]: the canonical identity of the wire prefix — the body segments
//!   in wire order, SHA-256 chained, with **cache metadata excluded from the
//!   hash** so enabling/retuning the mechanism never looks like a prefix break
//!   (PLAN §4.3).
//! - [`normalize_usage`]: the provider `usage` JSON normalized to
//!   [`CacheUsage`] (`read`/`write`/`uncached`/`total`/`reported`) for the four
//!   protocols plus the DeepSeek/OpenCode fallbacks (PLAN §5.1, `UsageInfo`).
//! - [`plan`]/[`apply`]: the explicit cache lowering — Anthropic
//!   `cache_control` breakpoints (tools → system → tail, TTL 1 h default) and
//!   OpenAI `prompt_cache_key`/retention. F4a implemented and tested; the
//!   adapters do **not** call it yet (wiring only after the prefix is stable in
//!   F2b/F3 — PLAN §2.5: enabling writes before the prefix is stable pays for
//!   cache writes and reads almost nothing).
//!
//! The digest is a consumer contract with `harness::cache`: `protocol` is
//! exactly [`WireProtocol::as_str`], `total_chars` is the sum of every segment's
//! `chars`, and the per-segment `sha256` is a chain hash
//! (`h_i = sha256(h_{i-1} || canonical_bytes_i)`), so
//! `PrefixDigest::common_prefix_segments` already tells which segment broke the
//! prefix.

use std::borrow::Cow;

use once_cell::sync::OnceCell;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::catalog::{CatalogFile, ModelInfo, ProviderInfo, RequestProfile};
use crate::domain::{
    CacheSettings, CacheUsage, PrefixDigest, SegmentDigest, SegmentKind, UsageInfo,
};

use super::{pointer_u32, system_text, CompletionRequest, WireProtocol};

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

/// How the provider caches the prompt prefix.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CacheMode {
    /// The provider caches the rendered prefix automatically (OpenAI, Gemini,
    /// DeepSeek); the client can at most hint at key/retention.
    #[default]
    Auto,
    /// The client must mark cache breakpoints (Anthropic `cache_control`).
    Explicit,
    /// The route does not cache the prompt (or rejects every control).
    None,
}

/// Per-route cache capabilities.
///
/// Mirrors PLAN §5.1 `catalog.cache`; the catalog is the source of truth once
/// F0b.2 generates it, and these are the protocol-level defaults until then.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheCapabilities {
    pub mode: CacheMode,
    /// Minimum cacheable prefix tokens; `None` = unknown (request excluded from
    /// the hit target, never silently classified as "not eligible").
    pub min_tokens: Option<u32>,
    /// Cache bookkeeping granularity in tokens (e.g. OpenAI reports
    /// `cached_tokens` rounded down to multiples of 128 on older models).
    pub block_tokens: u32,
    pub ttl_options: &'static [&'static str],
    pub supports_key: bool,
    pub supports_retention: bool,
    pub supports_explicit_breakpoints: bool,
    pub reports_read: bool,
    pub reports_write: bool,
}

/// Where an explicit cache breakpoint goes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheBreakpointTarget {
    /// End of the tool catalog segment.
    Tools,
    /// End of the system/instructions segment.
    System,
    /// Tail of the request (last stable message/input block).
    Tail,
    /// One specific message/input index (0-based inside the messages array).
    Message(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheBreakpoint {
    pub target: CacheBreakpointTarget,
    pub ttl: Option<String>,
}

/// Explicit cache plan for one request (built in F4 by [`plan`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CachePlan {
    pub mode: CacheMode,
    pub breakpoints: Vec<CacheBreakpoint>,
    /// Stable `prompt_cache_key` (≤64 chars, never user text — PLAN §4.5).
    pub prompt_cache_key: Option<String>,
    /// `prompt_cache_retention` (`in_memory`/`24h`) for older OpenAI models.
    pub retention: Option<String>,
    /// `prompt_cache_options.ttl` (`30m`/`12h`) for GPT-5.6+.
    pub ttl: Option<String>,
}

/// Cache capabilities for a `(protocol, provider, model)` route, using only the
/// protocol/family defaults (F0a). Equivalent to [`capabilities_with`] with no
/// catalog overrides; `provider_id` only feeds the interim gateway heuristic
/// (the catalog is authoritative once F0b.2 generates it).
pub fn capabilities(
    protocol: WireProtocol,
    provider_id: &str,
    model: &ModelInfo,
) -> CacheCapabilities {
    apply_cache_overrides(protocol_defaults(protocol, provider_id, model), None, None)
}

/// Cache capabilities with catalog overrides (F0b.2 entry point).
///
/// `provider_cache` (`catalog.cache` of the provider) overrides the protocol
/// defaults and `model_cache` (`catalog.cache` of the model) overrides the
/// provider block — the model wins. The override blocks are expected to be
/// **complete** (`crate::catalog::CacheInfo` has defaults for every field), so
/// each field of a present block is authoritative: `min_tokens: None` means
/// "unknown" (excluded from the target) and must not be replaced by a guess.
/// `ttl_options` is mapped to the canonical static vocabulary; an unknown
/// vocabulary is ignored rather than invented.
pub fn capabilities_with(
    protocol: WireProtocol,
    model: &ModelInfo,
    provider_cache: Option<&crate::catalog::CacheInfo>,
    model_cache: Option<&crate::catalog::CacheInfo>,
) -> CacheCapabilities {
    // No `provider_id` here: the catalog carries the provider-level truth (e.g.
    // whether an OpenCode gateway reports cache writes for Gemini).
    let defaults = protocol_defaults(protocol, "", model);
    apply_cache_overrides(defaults, provider_cache, model_cache)
}

/// Cache capabilities for a concrete catalog route (F0b.2 entry point used by
/// the harness and by the F4 cache planner).
///
/// Reads `provider.cache` and `model.cache` from the generated catalog and
/// layers them over the protocol defaults: the **model override wins** over the
/// provider override, and both win over the defaults. `minTokens` absent/null in
/// the catalog stays `None` — "minimum unknown" (request excluded from the hit
/// target), never `0`.
pub fn capabilities_for(
    protocol: WireProtocol,
    provider: &crate::catalog::ProviderInfo,
    model: &crate::catalog::ModelInfo,
) -> CacheCapabilities {
    capabilities_with(
        protocol,
        model,
        provider.cache.as_ref(),
        model.cache.as_ref(),
    )
}

/// Protocol/family defaults, before any catalog override.
///
/// TODO(F0b.2): once `data/catalog.json` carries `cache`, [`capabilities`] can
/// be retired in favor of [`capabilities_with`] everywhere.
fn protocol_defaults(
    protocol: WireProtocol,
    provider_id: &str,
    model: &ModelInfo,
) -> CacheCapabilities {
    let opencode_gateway = provider_id.starts_with("opencode");
    match protocol {
        WireProtocol::Anthropic => CacheCapabilities {
            mode: CacheMode::Explicit,
            // Anthropic's minimum is per model (512 / 1.024 / 2.048 / 4.096
            // tokens) and only the catalog knows it.
            min_tokens: None,
            block_tokens: 1,
            ttl_options: &["5m", "1h"],
            supports_key: false,
            supports_retention: false,
            supports_explicit_breakpoints: true,
            reports_read: true,
            reports_write: true,
        },
        WireProtocol::OpenaiChat => {
            let deepseek = is_deepseek(model);
            CacheCapabilities {
                mode: CacheMode::Auto,
                // DeepSeek documents no minimum and its cache is best-effort;
                // OpenAI-family routes need ~1.024 visible tokens (GPT-5.6+).
                min_tokens: if deepseek { None } else { Some(1_024) },
                block_tokens: if deepseek { 1 } else { 128 },
                ttl_options: &[],
                // `prompt_cache_key` is opt-in per model; the gateway clamps it
                // to 64 chars.
                supports_key: true,
                supports_retention: true,
                supports_explicit_breakpoints: false,
                reports_read: true,
                reports_write: true,
            }
        }
        WireProtocol::OpenaiResponses => CacheCapabilities {
            mode: CacheMode::Auto,
            min_tokens: Some(1_024),
            block_tokens: 128,
            ttl_options: &["30m", "12h"],
            supports_key: true,
            supports_retention: true,
            // Explicit mode (`prompt_cache_options.mode="explicit"`) exists on
            // this endpoint for GPT-5.6+; it stays gated by the F4.0 probe.
            supports_explicit_breakpoints: true,
            reports_read: true,
            reports_write: true,
        },
        WireProtocol::Google => CacheCapabilities {
            // Gemini 2.5+ caches implicitly in `generateContent`; there is no
            // client control in the path the adapter uses.
            mode: CacheMode::Auto,
            min_tokens: google_min_tokens(model),
            block_tokens: 1,
            ttl_options: &[],
            supports_key: false,
            supports_retention: false,
            supports_explicit_breakpoints: false,
            reports_read: true,
            // The implicit cache does not bill/document separate writes; the
            // OpenCode gateway may still report its own `cache_write_*`.
            reports_write: opencode_gateway,
        },
        // ACP agents own their context/cache strategy; Zylara never injects
        // wire cache fields into their requests.
        WireProtocol::Acp => CacheCapabilities {
            mode: CacheMode::None,
            min_tokens: None,
            block_tokens: 1,
            ttl_options: &[],
            supports_key: false,
            supports_retention: false,
            supports_explicit_breakpoints: false,
            reports_read: false,
            reports_write: false,
        },
    }
}

fn is_deepseek(model: &ModelInfo) -> bool {
    let family = model.family.to_ascii_lowercase();
    let id = model.id.to_ascii_lowercase();
    family.contains("deepseek") || id.contains("deepseek")
}

/// Provisional Gemini minimum, by model family (research §4.1). Replaced by the
/// catalog in F0b.2; anything unrecognized stays `None` (unknown).
fn google_min_tokens(model: &ModelInfo) -> Option<u32> {
    let id = model.id.to_ascii_lowercase();
    if id.contains("gemini-2.5") {
        Some(2_048)
    } else if id.contains("gemini-4") || id.contains("gemini-3") {
        Some(4_096)
    } else {
        None
    }
}

/// Canonical TTL vocabularies (the catalog carries `Vec<String>`, the plan
/// contract carries `&'static [&'static str]`).
const TTL_EMPTY: &[&str] = &[];
const TTL_5M: &[&str] = &["5m"];
const TTL_1H: &[&str] = &["1h"];
const TTL_5M_1H: &[&str] = &["5m", "1h"];
const TTL_30M: &[&str] = &["30m"];
const TTL_12H: &[&str] = &["12h"];
const TTL_30M_12H: &[&str] = &["30m", "12h"];
const TTL_IN_MEMORY: &[&str] = &["in_memory"];
const TTL_24H: &[&str] = &["24h"];
const TTL_IN_MEMORY_24H: &[&str] = &["in_memory", "24h"];

/// `Some(&[])` = declared "no TTL options"; `None` = vocabulary unrecognized
/// (the caller keeps the protocol default instead of hiding the options).
/// Matching is case/whitespace insensitive because the generated catalog is
/// hand-maintained JSON.
fn canonical_ttl_options(options: &[String]) -> Option<&'static [&'static str]> {
    if options.is_empty() {
        return Some(TTL_EMPTY);
    }
    let normalized: Vec<String> = options
        .iter()
        .map(|option| option.trim().to_ascii_lowercase())
        .collect();
    let values: Vec<&str> = normalized.iter().map(String::as_str).collect();
    let canonical = match values.as_slice() {
        ["5m"] => TTL_5M,
        ["1h"] => TTL_1H,
        ["5m", "1h"] | ["1h", "5m"] => TTL_5M_1H,
        ["30m"] => TTL_30M,
        ["12h"] => TTL_12H,
        ["30m", "12h"] | ["12h", "30m"] => TTL_30M_12H,
        ["in_memory"] => TTL_IN_MEMORY,
        ["24h"] => TTL_24H,
        ["in_memory", "24h"] | ["24h", "in_memory"] => TTL_IN_MEMORY_24H,
        _ => return None,
    };
    Some(canonical)
}

/// Apply the catalog override blocks over the protocol defaults.
///
/// Provider first, model last: the model override wins field by field. Each
/// present block is authoritative for its scalar fields (the generated
/// `CacheInfo` is complete); only an empty/unknown `mode` and an unrecognized
/// TTL vocabulary fall back to the previous layer.
fn apply_cache_overrides(
    base: CacheCapabilities,
    provider_cache: Option<&crate::catalog::CacheInfo>,
    model_cache: Option<&crate::catalog::CacheInfo>,
) -> CacheCapabilities {
    let mut caps = base;
    for cache in [provider_cache, model_cache].into_iter().flatten() {
        caps.mode = match cache.mode.trim().to_ascii_lowercase().as_str() {
            "auto" => CacheMode::Auto,
            "explicit" => CacheMode::Explicit,
            "none" => CacheMode::None,
            // Empty/unknown mode keeps the previous layer.
            _ => caps.mode,
        };
        // Authoritative: `None` means the catalog does not know the minimum.
        caps.min_tokens = cache.min_tokens;
        if let Some(block_tokens) = cache.block_tokens {
            caps.block_tokens = block_tokens;
        }
        if let Some(ttl_options) = canonical_ttl_options(&cache.ttl_options) {
            caps.ttl_options = ttl_options;
        }
        caps.supports_key = cache.supports_key;
        caps.supports_retention = cache.supports_retention;
        caps.supports_explicit_breakpoints = cache.supports_explicit_breakpoints;
        caps.reports_read = cache.reports_read;
        caps.reports_write = cache.reports_write;
    }
    caps
}

/* ------------------------------------------------------------------ */
/* Explicit cache plan (F4a: implemented and tested, not wired yet)    */
/* ------------------------------------------------------------------ */

/// Maximum number of explicit breakpoints Anthropic accepts per request.
pub const MAX_ANTHROPIC_BREAKPOINTS: usize = 4;

/// Capabilities for a route, resolved from the bundled catalog when the
/// provider is there (so provider/model `cache` overrides and the probed
/// `minTokens` are honored) and from the protocol defaults otherwise (live or
/// gateway-discovered providers).
fn route_capabilities(
    protocol: WireProtocol,
    provider_id: &str,
    model: &ModelInfo,
) -> CacheCapabilities {
    match catalog_provider(provider_id) {
        Some(provider) => capabilities_for(protocol, provider, model),
        None => capabilities(protocol, provider_id, model),
    }
}

/// Cached lookup into the bundled catalog (`include_str!` + serde must not run
/// per wire request) with a `'static` lifetime for the capability lookup.
fn catalog_provider(provider_id: &str) -> Option<&'static ProviderInfo> {
    static CATALOG: OnceCell<Option<CatalogFile>> = OnceCell::new();
    CATALOG
        .get_or_init(|| CatalogFile::load().ok())
        .as_ref()
        .and_then(|catalog| catalog.provider(provider_id))
}

/// Explicit cache plan for one wire request.
///
/// Resolves the catalog capabilities for `(protocol, provider_id, model)` and
/// lowers them to the provider mechanism:
///
/// - **Anthropic** (`mode: explicit`): up to three breakpoints, in wire order —
///   end of `tools`, end of the stable `system`, tail of the last message. The
///   TTL default is [`crate::domain::CacheTtl::OneHour`], with
///   [`crate::domain::CacheTtl::FiveMinutes`] as an option. Nothing is planned
///   when the minimum cacheable prefix is unknown (`minTokens: null` — an
///   explicit write below an unknown minimum can be paid and never read) or
///   when the estimated prefix is below the known minimum.
/// - **OpenAI** Chat/Responses (`mode: auto`): `prompt_cache_key` derived from
///   `session_id|provider|model|protocol` (SHA-256 hex, 64 chars, never user
///   text) and `prompt_cache_retention` only when the capability declares it
///   and the settings carry a valid value. No `prompt_cache_options`/explicit
///   breakpoints in v1 (gated by the F4.0 probe).
/// - **Google**: `None` — the `generateContent` path only has the implicit
///   cache, so there is no request field to add.
///
/// The ChatGPT-plan/OAuth profile gets no key until the F4.0 probe validates it
/// (research `prompt-caching.md` §3.6).
///
/// The adapters do **not** call this yet: wiring (and the HTTP 400 fallback)
/// lands in the F4 task, after F2b/F3 stabilize the prefix (PLAN §2.5).
pub fn plan(
    protocol: WireProtocol,
    provider_id: &str,
    model: &ModelInfo,
    request: &CompletionRequest,
) -> Option<CachePlan> {
    let caps = route_capabilities(protocol, provider_id, model);
    plan_with_caps(protocol, &caps, request, &CacheSettings::default())
}

/// [`plan`] with already-resolved capabilities and persisted settings.
///
/// This is the seam for the F4 wiring: the call site passes
/// [`capabilities_for`]`(protocol, provider, model)` (so provider-level
/// overrides and the probed `minTokens` are honored) plus the user
/// [`CacheSettings`] (Anthropic TTL, OpenAI retention).
pub fn plan_with_caps(
    protocol: WireProtocol,
    caps: &CacheCapabilities,
    request: &CompletionRequest,
    settings: &CacheSettings,
) -> Option<CachePlan> {
    if caps.mode == CacheMode::None {
        return None;
    }
    match protocol {
        WireProtocol::Anthropic => plan_anthropic(caps, request, settings),
        WireProtocol::OpenaiChat | WireProtocol::OpenaiResponses => {
            plan_openai(protocol, caps, request, settings)
        }
        // Gemini has only the implicit cache in the `generateContent` path.
        WireProtocol::Google => None,
        WireProtocol::Acp => None,
    }
}

fn plan_anthropic(
    caps: &CacheCapabilities,
    request: &CompletionRequest,
    settings: &CacheSettings,
) -> Option<CachePlan> {
    if caps.mode != CacheMode::Explicit || !caps.supports_explicit_breakpoints {
        return None;
    }
    // Unknown minimum → no explicit write (it could be paid and never reused).
    let min_tokens = caps.min_tokens?;
    if estimated_prefix_tokens(request) < min_tokens {
        return None;
    }

    let ttl = settings.anthropic_ttl.as_str();
    let mut breakpoints: Vec<CacheBreakpoint> = Vec::new();
    if !request.tools.is_empty() {
        breakpoints.push(CacheBreakpoint {
            target: CacheBreakpointTarget::Tools,
            ttl: None,
        });
    }
    if !system_text(request).trim().is_empty() {
        breakpoints.push(CacheBreakpoint {
            target: CacheBreakpointTarget::System,
            ttl: None,
        });
    }
    if !request.history.is_empty() {
        breakpoints.push(CacheBreakpoint {
            target: CacheBreakpointTarget::Tail,
            ttl: None,
        });
    }
    // The plan never exceeds the Anthropic slot limit; the automatic top-level
    // breakpoint is intentionally not used (it would consume one slot).
    breakpoints.truncate(MAX_ANTHROPIC_BREAKPOINTS);
    if breakpoints.is_empty() {
        return None;
    }
    Some(CachePlan {
        mode: CacheMode::Explicit,
        breakpoints,
        prompt_cache_key: None,
        retention: None,
        ttl: Some(ttl.to_string()),
    })
}

fn plan_openai(
    protocol: WireProtocol,
    caps: &CacheCapabilities,
    request: &CompletionRequest,
    settings: &CacheSettings,
) -> Option<CachePlan> {
    if caps.mode != CacheMode::Auto {
        return None;
    }
    // ChatGPT-plan/OAuth route: `prompt_cache_key` is not documented there; only
    // send it if the F4.0 probe proves acceptance (research §3.6).
    if matches!(request.config.request_profile, RequestProfile::ChatgptPlan) {
        return None;
    }
    if !caps.supports_key {
        return None;
    }
    let prompt_cache_key = prompt_cache_key(protocol, request)?;
    // `prompt_cache_retention` only takes `in_memory`/`24h` (older models); the
    // setting is opt-in and stays `None` until the probe validates it.
    let retention = settings
        .openai_retention
        .as_deref()
        .map(str::trim)
        .filter(|value| matches!(*value, "in_memory" | "24h"))
        .filter(|_| caps.supports_retention)
        .map(str::to_string);
    Some(CachePlan {
        mode: CacheMode::Auto,
        breakpoints: Vec::new(),
        prompt_cache_key: Some(prompt_cache_key),
        retention,
        ttl: None,
    })
}

/// Stable routing/accounting key: SHA-256 hex (64 chars) of
/// `session_id|provider|model|protocol`. Never derived from user text, so it is
/// safe for gateways that clamp the key at 64 characters.
fn prompt_cache_key(protocol: WireProtocol, request: &CompletionRequest) -> Option<String> {
    let session_id = request.config.session_id.trim();
    let provider_id = request.config.provider_id.trim();
    let model_id = request.config.model.id.trim();
    if session_id.is_empty() || provider_id.is_empty() || model_id.is_empty() {
        return None;
    }
    let material = format!(
        "{session_id}|{provider_id}|{model_id}|{}",
        protocol.as_str()
    );
    let digest = Sha256::digest(material.as_bytes());
    let mut key = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(key, "{byte:02x}");
    }
    Some(key)
}

/// Prefix size estimate (char/4 heuristic) used only to decide whether the
/// prefix reaches the known provider minimum. It mirrors the neutral request,
/// not the protocol body (the plan runs before `build_body`).
fn estimated_prefix_tokens(request: &CompletionRequest) -> u32 {
    let mut chars: usize = system_text(request).chars().count();
    for tool in &request.tools {
        chars += tool.name.chars().count();
        chars += tool.description.chars().count();
        chars += tool.parameters.to_string().chars().count();
    }
    for message in &request.history {
        chars += message.text.chars().count();
        if let Some(reasoning) = &message.reasoning {
            chars += reasoning.chars().count();
        }
        for image in &message.images {
            chars += image.data_base64.chars().count();
        }
        for call in &message.tool_calls {
            chars += call.name.chars().count();
            chars += call.arguments.chars().count();
        }
    }
    u32::try_from(chars / 4).unwrap_or(u32::MAX)
}

/// Apply an explicit cache plan to the **wire body** (before it is sent).
///
/// F4a implements the lowering but the adapters do not call it yet: wiring lands
/// in the F4 task, after F2b/F3 stabilize the prefix (PLAN §2.5). Cache metadata
/// is excluded from [`digest`], so the metadata added here never looks like a
/// prefix break. Idempotent and never changes prompt text.
pub fn apply(protocol: WireProtocol, plan: Option<&CachePlan>, body: &mut Value) {
    let Some(plan) = plan else {
        return;
    };
    match protocol {
        WireProtocol::Anthropic => apply_anthropic(plan, body),
        WireProtocol::OpenaiChat | WireProtocol::OpenaiResponses => apply_openai(plan, body),
        // Gemini implicit cache: no request field to add.
        WireProtocol::Google => {}
        WireProtocol::Acp => {}
    }
}

fn apply_anthropic(plan: &CachePlan, body: &mut Value) {
    let ttl = plan.ttl.as_deref();
    let mut applied = 0usize;
    for breakpoint in &plan.breakpoints {
        if applied >= MAX_ANTHROPIC_BREAKPOINTS {
            break;
        }
        let breakpoint_ttl = breakpoint.ttl.as_deref().or(ttl);
        let placed = match breakpoint.target {
            CacheBreakpointTarget::Tools => apply_anthropic_tools(body, breakpoint_ttl),
            CacheBreakpointTarget::System => apply_anthropic_system(body, breakpoint_ttl),
            CacheBreakpointTarget::Tail => apply_anthropic_tail(body, breakpoint_ttl),
            CacheBreakpointTarget::Message(index) => {
                apply_anthropic_message(body, index, breakpoint_ttl)
            }
        };
        if placed {
            applied += 1;
        }
    }
}

/// `cache_control` block for a breakpoint. `ttl` is optional: a gateway that
/// rejects `ttl` makes the wiring retry with a plan/TTL-less breakpoint.
fn cache_control(ttl: Option<&str>) -> Value {
    match ttl {
        Some(ttl) if !ttl.is_empty() => json!({"type": "ephemeral", "ttl": ttl}),
        _ => json!({"type": "ephemeral"}),
    }
}

/// Breakpoint at the end of the tool catalog (caches `tools` up to that tool).
fn apply_anthropic_tools(body: &mut Value, ttl: Option<&str>) -> bool {
    let Some(tool) = body
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .and_then(|tools| tools.last_mut())
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    tool.insert("cache_control".to_string(), cache_control(ttl));
    true
}

/// Breakpoint at the end of the stable `system`. The adapter sends `system` as
/// a string; the documented breakpoint shape is a text block, and the text is
/// preserved byte-for-byte (a second call only re-tags the existing block).
fn apply_anthropic_system(body: &mut Value, ttl: Option<&str>) -> bool {
    let control = cache_control(ttl);
    let Some(system) = body.get_mut("system") else {
        return false;
    };
    if system.is_string() {
        let text = match std::mem::replace(system, Value::Null) {
            Value::String(text) => text,
            _ => String::new(),
        };
        *system = json!([{"type": "text", "text": text, "cache_control": control}]);
        return true;
    }
    match system {
        Value::Array(blocks) => {
            let Some(block) = blocks.last_mut().and_then(Value::as_object_mut) else {
                return false;
            };
            block.insert("cache_control".to_string(), control);
            true
        }
        Value::Object(block) => {
            block.insert("cache_control".to_string(), control);
            true
        }
        _ => false,
    }
}

/// Breakpoint at the tail of the turn: last message / last tool result.
fn apply_anthropic_tail(body: &mut Value, ttl: Option<&str>) -> bool {
    let Some(index) = body
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::len)
        .and_then(|len| len.checked_sub(1))
    else {
        return false;
    };
    apply_anthropic_message(body, index, ttl)
}

fn apply_anthropic_message(body: &mut Value, index: usize, ttl: Option<&str>) -> bool {
    let control = cache_control(ttl);
    let Some(content) = body
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|messages| messages.get_mut(index))
        .and_then(|message| message.get_mut("content"))
    else {
        return false;
    };
    if content.is_string() {
        let text = match std::mem::replace(content, Value::Null) {
            Value::String(text) => text,
            _ => String::new(),
        };
        *content = json!([{"type": "text", "text": text, "cache_control": control}]);
        return true;
    }
    let Some(blocks) = content.as_array_mut() else {
        return false;
    };
    // Walk backwards to the last cacheable block: Anthropic rejects
    // `cache_control` on thinking blocks (they are cached when replayed, but
    // cannot carry the marker themselves).
    for block in blocks.iter_mut().rev() {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        let block_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(block_type, "thinking" | "redacted_thinking") {
            continue;
        }
        object.insert("cache_control".to_string(), control);
        return true;
    }
    false
}

/// OpenAI: `prompt_cache_key` (and `prompt_cache_retention` when planned) at the
/// top of the body; nothing else changes.
fn apply_openai(plan: &CachePlan, body: &mut Value) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if let Some(key) = &plan.prompt_cache_key {
        object.insert("prompt_cache_key".to_string(), json!(key));
    }
    if let Some(retention) = &plan.retention {
        object.insert("prompt_cache_retention".to_string(), json!(retention));
    }
}

/* ------------------------------------------------------------------ */
/* Usage normalization                                                 */
/* ------------------------------------------------------------------ */

/// Normalize the provider `usage` JSON block to [`CacheUsage`].
///
/// `raw` may be the usage object itself (`usage`/`usageMetadata` payload) or a
/// wrapper carrying it. Fields per protocol (research `prompt-caching.md` §9.9):
///
/// - **Anthropic**: `cache_read_input_tokens` (read) +
///   `cache_creation_input_tokens` (write); `input_tokens` is only the tail
///   after the last breakpoint, so `total = input + read + write`.
/// - **OpenAI Chat/Responses**: `prompt_tokens_details.cached_tokens` /
///   `input_tokens_details.cached_tokens` (read) and `cache_write_tokens`
///   (write); `prompt_tokens`/`input_tokens` are inclusive.
/// - **Google**: `cachedContentTokenCount` (read) inside `promptTokenCount`
///   (inclusive); the implicit cache reports no writes.
/// - **DeepSeek (openai-chat)**: `prompt_cache_hit_tokens` (read) /
///   `prompt_cache_miss_tokens` (uncached).
/// - **OpenCode gateway**: `usage.opencode.tokens.{cache_read,cache_write_5m,
///   cache_write_1h}` when the native counters are absent; the gateway's
///   `tokens.input` **excludes** cache, so the accounting is additive.
///
/// `reported` is true when the provider/gateway actually sent a cache counter
/// (including `0`); without any counter the caller must show "não reportado"
/// instead of deriving a hit percentage.
pub fn normalize_usage(protocol: WireProtocol, provider_id: &str, raw: &Value) -> CacheUsage {
    let usage = usage_object(raw);
    let gateway = if provider_id.starts_with("opencode") {
        let from_usage = GatewayTokens::parse(usage);
        if from_usage.has_counters() {
            from_usage
        } else {
            // Defensive: some gateway paths put the block next to `usage`.
            GatewayTokens::parse(raw)
        }
    } else {
        GatewayTokens::default()
    };

    match protocol {
        WireProtocol::Anthropic => normalize_anthropic(usage, gateway),
        WireProtocol::OpenaiChat | WireProtocol::OpenaiResponses => {
            normalize_openai(protocol, usage, gateway)
        }
        WireProtocol::Google => normalize_google(usage, gateway),
        WireProtocol::Acp => normalize_openai(protocol, usage, gateway),
    }
}

/// Copy the normalized cache counters into a [`UsageInfo`] (adapters call this
/// on their parsed usage; `cached_tokens` stays as the legacy alias).
pub fn apply_usage(info: &mut UsageInfo, cache_usage: &CacheUsage) {
    info.cache_read_tokens = cache_usage.cache_read_tokens;
    info.cache_write_tokens = cache_usage.cache_write_tokens;
    info.uncached_input_tokens = cache_usage.uncached_input_tokens;
    info.cache_reported = cache_usage.reported;
    if info.cached_tokens.is_none() {
        info.cached_tokens = cache_usage.cache_read_tokens;
    }
}

/// The `usage` object, unwrapping the common envelopes.
fn usage_object(raw: &Value) -> &Value {
    raw.get("usage")
        .filter(|value| value.is_object())
        .or_else(|| raw.get("usageMetadata").filter(|value| value.is_object()))
        .unwrap_or(raw)
}

/* ------------------------------------------------------------------ */
/* Safe raw usage excerpt (diagnostics)                                */
/* ------------------------------------------------------------------ */

/// Hard cap for the raw usage excerpt handed to the diagnostics UI ("Copiar
/// usage bruto"). The provider block itself (especially through gateways) can
/// carry more metadata than the panel needs.
pub const USAGE_RAW_MAX_BYTES: usize = 4 * 1024;

/// Top-level numeric counters kept from any protocol usage block.
const USAGE_RAW_COUNTERS: &[&str] = &[
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cached_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_read",
    "cache_creation",
    "cache_write_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens",
    "promptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "totalTokenCount",
    "toolUsePromptTokenCount",
    "cachedContentTokenCount",
    "cost",
    "list_cost",
    "allowance",
];

/// Nested usage objects copied with numeric-only recursion.
const USAGE_RAW_NESTED: &[&str] = &[
    "input_tokens_details",
    "output_tokens_details",
    "prompt_tokens_details",
    "completion_tokens_details",
    "cache_write_tokens_details",
    "cache_creation",
    "cache_read",
    "server_tool_use",
];

/// Non-secret strings useful in the diagnostics panel.
const USAGE_RAW_STRINGS: &[&str] = &["service_tier", "billing_source"];

/// Numeric fields kept from the OpenCode gateway accounting block.
const OPENCODE_RAW_COUNTERS: &[&str] = &["list_cost", "allowance", "cost"];

/// Safe, small excerpt of the provider usage JSON (owned `Value`, emitted as
/// [`super::ProviderEvent::UsageRaw`] and persisted as `CacheSample.raw_usage`).
///
/// Only an **allowlist** is copied: token counters, `*_tokens_details` (numeric
/// values only), cache blocks and the OpenCode gateway accounting. Prompts,
/// message content, headers, request/session ids and credentials can never leak
/// because unknown keys and all non-allowlisted strings are dropped. The
/// serialized excerpt is capped at [`USAGE_RAW_MAX_BYTES`]; when nothing
/// recognized is present the result is `Value::Null` (the adapters then skip
/// the event entirely).
pub fn usage_excerpt(raw: &Value) -> Value {
    let usage = usage_object(raw);
    let Some(usage) = usage.as_object() else {
        return Value::Null;
    };
    let mut excerpt = Map::new();
    for key in USAGE_RAW_COUNTERS {
        if let Some(value) = usage.get(*key).filter(|value| value.is_number()) {
            excerpt.insert((*key).to_string(), value.clone());
        }
    }
    for key in USAGE_RAW_STRINGS {
        if let Some(value) = usage.get(*key).filter(|value| value.is_string()) {
            excerpt.insert((*key).to_string(), value.clone());
        }
    }
    for key in USAGE_RAW_NESTED {
        if let Some(value) = usage.get(*key) {
            let nested = numeric_usage_excerpt(value, 2);
            if nested.as_object().is_some_and(|object| !object.is_empty()) {
                excerpt.insert((*key).to_string(), nested);
            }
        }
    }
    if let Some(opencode) = usage.get("opencode").and_then(opencode_usage_excerpt) {
        excerpt.insert("opencode".to_string(), opencode);
    }
    if excerpt.is_empty() {
        // Nothing recognized: the contract is `Value::Null` (adapters skip it).
        return Value::Null;
    }
    fit_usage_excerpt(Value::Object(excerpt))
}

/// Numeric-only copy of a nested usage object. Provider field names are safe;
/// values are copied only when numeric/boolean (never strings/content).
fn numeric_usage_excerpt(value: &Value, depth: u8) -> Value {
    let Some(object) = value.as_object() else {
        return Value::Null;
    };
    let mut excerpt = Map::new();
    for (key, child) in object {
        if child.is_number() || child.is_boolean() {
            excerpt.insert(key.clone(), child.clone());
        } else if depth > 0 && child.is_object() {
            let nested = numeric_usage_excerpt(child, depth - 1);
            if nested.as_object().is_some_and(|object| !object.is_empty()) {
                excerpt.insert(key.clone(), nested);
            }
        }
    }
    Value::Object(excerpt)
}

/// OpenCode gateway block: keep the token counters and billing numbers, drop
/// every other gateway field (session/request ids, routing metadata, ...).
fn opencode_usage_excerpt(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut excerpt = Map::new();
    if let Some(tokens) = object.get("tokens") {
        let tokens = numeric_usage_excerpt(tokens, 1);
        if tokens.as_object().is_some_and(|tokens| !tokens.is_empty()) {
            excerpt.insert("tokens".to_string(), tokens);
        }
    }
    for key in OPENCODE_RAW_COUNTERS {
        if let Some(value) = object.get(*key).filter(|value| value.is_number()) {
            excerpt.insert((*key).to_string(), value.clone());
        }
    }
    if let Some(source) = object
        .get("billing_source")
        .filter(|value| value.is_string())
    {
        excerpt.insert("billing_source".to_string(), source.clone());
    }
    if excerpt.is_empty() {
        None
    } else {
        Some(Value::Object(excerpt))
    }
}

/// Enforce the size cap by dropping optional blocks; the numeric core is bounded
/// by the allowlist, so this never truncates JSON mid-value.
fn fit_usage_excerpt(mut excerpt: Value) -> Value {
    if serialized_len(&excerpt) <= USAGE_RAW_MAX_BYTES {
        return excerpt;
    }
    if let Some(object) = excerpt.as_object_mut() {
        object.remove("opencode");
    }
    if serialized_len(&excerpt) <= USAGE_RAW_MAX_BYTES {
        return excerpt;
    }
    if let Some(object) = excerpt.as_object_mut() {
        for key in USAGE_RAW_NESTED {
            object.remove(*key);
        }
    }
    if serialized_len(&excerpt) <= USAGE_RAW_MAX_BYTES {
        return excerpt;
    }
    // Last resort: top-level scalar counters only.
    let mut core = Map::new();
    if let Some(object) = excerpt.as_object() {
        for (key, value) in object {
            if value.is_number() || value.is_string() {
                core.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(core)
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|text| text.len())
        .unwrap_or(usize::MAX)
}

/// Cache counters reported by the OpenCode gateway (`usage.opencode.tokens`).
#[derive(Debug, Clone, Copy, Default)]
struct GatewayTokens {
    /// Input tokens **excluding** cache reads/writes.
    input: Option<u32>,
    read: Option<u32>,
    write: Option<u32>,
}

impl GatewayTokens {
    fn parse(value: &Value) -> Self {
        let five_minutes = pointer_u32(value, "/opencode/tokens/cache_write_5m");
        let one_hour = pointer_u32(value, "/opencode/tokens/cache_write_1h");
        let write = match (five_minutes, one_hour) {
            (None, None) => None,
            (five_minutes, one_hour) => Some(
                five_minutes
                    .unwrap_or(0)
                    .saturating_add(one_hour.unwrap_or(0)),
            ),
        };
        Self {
            input: pointer_u32(value, "/opencode/tokens/input"),
            read: pointer_u32(value, "/opencode/tokens/cache_read"),
            write,
        }
    }

    fn has_counters(&self) -> bool {
        self.read.is_some() || self.write.is_some()
    }
}

fn normalize_anthropic(usage: &Value, gateway: GatewayTokens) -> CacheUsage {
    let native_read = pointer_u32(usage, "/cache_read_input_tokens");
    let native_write = pointer_u32(usage, "/cache_creation_input_tokens");
    let read = native_read.or(gateway.read);
    let write = native_write.or(gateway.write);
    let reported = native_read.is_some() || native_write.is_some() || gateway.has_counters();
    // Anthropic `input_tokens` is only the tail after the last breakpoint.
    let input = pointer_u32(usage, "/input_tokens").or(gateway.input);
    let input_total_tokens = if reported {
        input
            .map(|input| {
                input
                    .saturating_add(read.unwrap_or(0))
                    .saturating_add(write.unwrap_or(0))
            })
            .or_else(|| sum_counters(read, write))
    } else {
        input
    };
    CacheUsage {
        cache_read_tokens: read,
        cache_write_tokens: write,
        uncached_input_tokens: input,
        input_total_tokens,
        reported,
    }
}

fn normalize_openai(protocol: WireProtocol, usage: &Value, gateway: GatewayTokens) -> CacheUsage {
    let input_pointer = match protocol {
        WireProtocol::OpenaiResponses => "/input_tokens",
        _ => "/prompt_tokens",
    };
    let input = pointer_u32(usage, input_pointer);
    let native_read = match protocol {
        WireProtocol::OpenaiResponses => pointer_u32(usage, "/input_tokens_details/cached_tokens"),
        _ => pointer_u32(usage, "/prompt_tokens_details/cached_tokens"),
    }
    .or_else(|| pointer_u32(usage, "/prompt_tokens_details/cached_tokens"))
    .or_else(|| pointer_u32(usage, "/input_tokens_details/cached_tokens"))
    // DeepSeek native cache accounting.
    .or_else(|| pointer_u32(usage, "/prompt_cache_hit_tokens"))
    // Zai/DigitalOcean style OpenAI-compatible providers.
    .or_else(|| pointer_u32(usage, "/cached_tokens"))
    .or_else(|| pointer_u32(usage, "/cache_read_input_tokens"));
    let native_write = pointer_u32(usage, "/prompt_tokens_details/cache_write_tokens")
        .or_else(|| pointer_u32(usage, "/input_tokens_details/cache_write_tokens"))
        .or_else(|| pointer_u32(usage, "/cache_write_tokens"))
        .or_else(|| pointer_u32(usage, "/cache_created_input_tokens"));
    let miss = pointer_u32(usage, "/prompt_cache_miss_tokens");
    let native = native_read.is_some() || native_write.is_some();
    let read = native_read.or(gateway.read);
    let write = native_write.or(gateway.write);
    let reported = native || gateway.has_counters();

    let (input_total_tokens, uncached_input_tokens) = if gateway.has_counters() {
        // Gateway `tokens.input` excludes cache; prefer its additive accounting
        // even when the native block is present (gateway billing is the truth).
        gateway_accounting(input, gateway, read, write)
    } else if native {
        // Native OpenAI-compatible usage is inclusive.
        let uncached = miss.or_else(|| {
            input.map(|input| {
                input
                    .saturating_sub(read.unwrap_or(0))
                    .saturating_sub(write.unwrap_or(0))
            })
        });
        (input.or_else(|| sum_counters(read, write)), uncached)
    } else {
        (input, input)
    };

    CacheUsage {
        cache_read_tokens: read,
        cache_write_tokens: write,
        uncached_input_tokens,
        input_total_tokens,
        reported,
    }
}

fn normalize_google(usage: &Value, gateway: GatewayTokens) -> CacheUsage {
    let prompt = pointer_u32(usage, "/promptTokenCount");
    let native_read = pointer_u32(usage, "/cachedContentTokenCount");
    let read = native_read.or(gateway.read);
    let write = gateway.write;
    let reported = native_read.is_some() || gateway.has_counters();

    let (input_total_tokens, uncached_input_tokens) = if gateway.has_counters() {
        gateway_accounting(prompt, gateway, read, write)
    } else if native_read.is_some() {
        // `promptTokenCount` is inclusive of `cachedContentTokenCount`.
        let uncached = prompt.map(|prompt| prompt.saturating_sub(read.unwrap_or(0)));
        (prompt, uncached)
    } else {
        (prompt, prompt)
    };

    CacheUsage {
        cache_read_tokens: read,
        cache_write_tokens: write,
        uncached_input_tokens,
        input_total_tokens,
        reported,
    }
}

/// Additive accounting used by the OpenCode gateway (its `input` excludes
/// cache): `total = input + read + write`, `uncached = input`.
fn gateway_accounting(
    fallback_input: Option<u32>,
    gateway: GatewayTokens,
    read: Option<u32>,
    write: Option<u32>,
) -> (Option<u32>, Option<u32>) {
    let input = gateway.input.or(fallback_input);
    let total = input
        .map(|input| {
            input
                .saturating_add(read.unwrap_or(0))
                .saturating_add(write.unwrap_or(0))
        })
        .or_else(|| sum_counters(read, write));
    (total, input)
}

fn sum_counters(read: Option<u32>, write: Option<u32>) -> Option<u32> {
    match (read, write) {
        (None, None) => None,
        (read, write) => Some(read.unwrap_or(0).saturating_add(write.unwrap_or(0))),
    }
}

/* ------------------------------------------------------------------ */
/* Canonical prefix digest                                             */
/* ------------------------------------------------------------------ */

/// Cache metadata removed from the prefix hash (PLAN §4.3): turning the
/// mechanism on/off, changing breakpoints, TTL, retention or the routing key
/// must never look like a prompt change. `ttl` is stripped when it is a TTL
/// string (cache plan shapes); a tool schema that declares a `ttl` **property**
/// keeps affecting the hash.
const CACHE_METADATA_KEYS: &[&str] = &[
    "cache_control",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "prompt_cache_breakpoint",
    "cachedContent",
];

/// Canonical digest of the wire prefix of one request body.
///
/// Segments are extracted in wire order per protocol and hashed as a chain:
/// `h_i = sha256(h_{i-1} || canonical_bytes_i)`, where the canonical bytes have
/// object keys sorted (cross-source stability) and cache metadata removed. The
/// chain seed includes protocol and provider id: different cache domains (model
/// route/provider) never compare equal even with the same rendered text.
pub fn digest(protocol: WireProtocol, provider_id: &str, body: &Value) -> PrefixDigest {
    let mut seed = {
        let mut hasher = Sha256::new();
        hasher.update(protocol.as_str().as_bytes());
        hasher.update([0_u8]);
        hasher.update(provider_id.as_bytes());
        let digest = hasher.finalize();
        let mut seed = [0_u8; 32];
        for (slot, byte) in seed.iter_mut().zip(digest.iter()) {
            *slot = *byte;
        }
        seed
    };

    let mut segments: Vec<SegmentDigest> = Vec::new();
    let mut total_chars: u32 = 0;
    for (index, (kind, value)) in wire_segments(protocol, body).into_iter().enumerate() {
        let canonical = canonical_wire_value(value.as_ref());
        let bytes =
            serde_json::to_vec(&canonical).unwrap_or_else(|_| canonical.to_string().into_bytes());
        let hash = {
            let mut hasher = Sha256::new();
            hasher.update(seed);
            hasher.update(&bytes);
            hasher.finalize()
        };
        let mut sha256 = [0_u8; 32];
        for (slot, byte) in sha256.iter_mut().zip(hash.iter()) {
            *slot = *byte;
        }
        seed = sha256;
        let chars = std::str::from_utf8(&bytes)
            .map(|text| text.chars().count())
            .unwrap_or(bytes.len());
        let chars = u32::try_from(chars).unwrap_or(u32::MAX);
        total_chars = total_chars.saturating_add(chars);
        segments.push(SegmentDigest {
            kind,
            index: u32::try_from(index).unwrap_or(u32::MAX),
            sha256,
            chars,
        });
    }

    PrefixDigest {
        protocol: protocol.as_str().to_string(),
        segments,
        total_chars,
        estimated_tokens: total_chars / 4,
    }
}

/// Canonical wire segments: `(kind, value)` in the order the provider renders
/// them (system/instructions → tools → messages/input/contents).
///
/// Most segments borrow the body; the Anthropic system is canonicalized into
/// the block shape (`Cow::Owned`) so `digest(apply(body)) == digest(body)` — the
/// plan may restructure `system` into one text block but must not change the
/// prefix identity (PLAN §4.3).
fn wire_segments<'a>(
    protocol: WireProtocol,
    body: &'a Value,
) -> Vec<(SegmentKind, Cow<'a, Value>)> {
    let mut segments: Vec<(SegmentKind, Cow<'a, Value>)> = Vec::new();
    match protocol {
        WireProtocol::OpenaiChat => {
            let messages = body.get("messages").and_then(Value::as_array);
            if let Some(messages) = messages {
                for message in messages {
                    if is_instruction_role(message) {
                        segments.push((SegmentKind::System, Cow::Borrowed(message)));
                    }
                }
            }
            push_optional(&mut segments, SegmentKind::Tools, body.get("tools"));
            if let Some(messages) = messages {
                for message in messages {
                    if !is_instruction_role(message) {
                        segments.push((SegmentKind::Message, Cow::Borrowed(message)));
                    }
                }
            }
        }
        WireProtocol::Anthropic => {
            // Anthropic renders `tools`, then `system`, then `messages`.
            push_optional(&mut segments, SegmentKind::Tools, body.get("tools"));
            if let Some(system) = anthropic_system_segment(body) {
                segments.push((SegmentKind::System, Cow::Owned(system)));
            }
            if let Some(messages) = body.get("messages").and_then(Value::as_array) {
                for message in messages {
                    segments.push((SegmentKind::Message, Cow::Borrowed(message)));
                }
            }
        }
        WireProtocol::OpenaiResponses => {
            push_optional(&mut segments, SegmentKind::System, body.get("instructions"));
            push_optional(&mut segments, SegmentKind::Tools, body.get("tools"));
            if let Some(input) = body.get("input").and_then(Value::as_array) {
                for item in input {
                    segments.push((SegmentKind::Message, Cow::Borrowed(item)));
                }
            }
        }
        WireProtocol::Google => {
            push_optional(
                &mut segments,
                SegmentKind::System,
                body.get("systemInstruction"),
            );
            push_optional(&mut segments, SegmentKind::Tools, body.get("tools"));
            if let Some(contents) = body.get("contents").and_then(Value::as_array) {
                for content in contents {
                    segments.push((SegmentKind::Message, Cow::Borrowed(content)));
                }
            }
        }
        WireProtocol::Acp => {
            // ACP agents do not expose a neutral wire body; no cache segments.
        }
    }
    segments
}

/// Canonical Anthropic system segment: a string is equivalent to a single text
/// block (the shape `cache::apply` produces), so enabling breakpoints never
/// changes the digest. Cache metadata is stripped later by
/// [`canonical_wire_value`].
fn anthropic_system_segment(body: &Value) -> Option<Value> {
    let system = body.get("system")?;
    if is_empty_wire_value(system) {
        return None;
    }
    match system {
        Value::String(text) => Some(json!([{"type": "text", "text": text}])),
        Value::Array(blocks) => Some(Value::Array(blocks.clone())),
        other => Some(Value::Array(vec![other.clone()])),
    }
}

fn push_optional<'a>(
    segments: &mut Vec<(SegmentKind, Cow<'a, Value>)>,
    kind: SegmentKind,
    value: Option<&'a Value>,
) {
    if let Some(value) = value {
        if !is_empty_wire_value(value) {
            segments.push((kind, Cow::Borrowed(value)));
        }
    }
}

fn is_instruction_role(message: &Value) -> bool {
    matches!(
        message.get("role").and_then(Value::as_str),
        Some("system") | Some("developer")
    )
}

fn is_empty_wire_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

/// Recursively rebuild a JSON value with sorted object keys and cache metadata
/// removed, so two requests that render the same prompt hash the same bytes
/// regardless of `serde_json` map ordering or where `apply` placed the cache
/// markers.
fn canonical_wire_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_unstable();
            let mut sorted = Map::new();
            for key in keys {
                let Some(child) = object.get(key) else {
                    continue;
                };
                if is_cache_metadata(key, child) {
                    continue;
                }
                sorted.insert(key.clone(), canonical_wire_value(child));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical_wire_value).collect()),
        other => other.clone(),
    }
}

fn is_cache_metadata(key: &str, value: &Value) -> bool {
    CACHE_METADATA_KEYS.contains(&key) || (key == "ttl" && value.is_string())
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogFile;
    use crate::domain::CacheTtl;
    use serde_json::json;

    /* ------------------------- usage fixtures ------------------------- */

    #[test]
    fn anthropic_usage_normalizes_read_creation_and_tail() {
        // Real Messages API shape: `input_tokens` is the tail after the last
        // breakpoint, not the request total.
        let usage = json!({
            "input_tokens": 250,
            "cache_creation_input_tokens": 1_200,
            "cache_read_input_tokens": 8_000,
            "output_tokens": 120,
        });
        let cache = normalize_usage(WireProtocol::Anthropic, "anthropic", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(8_000));
        assert_eq!(cache.cache_write_tokens, Some(1_200));
        assert_eq!(cache.uncached_input_tokens, Some(250));
        assert_eq!(cache.input_total_tokens, Some(9_450));
    }

    #[test]
    fn anthropic_zero_counters_still_count_as_reported() {
        // Below the model minimum Anthropic returns zeros; the provider did
        // report, so the UI must show 0% (warming), not "não reportado".
        let usage = json!({
            "input_tokens": 400,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        });
        let cache = normalize_usage(WireProtocol::Anthropic, "opencode-go", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(0));
        assert_eq!(cache.cache_write_tokens, Some(0));
        assert_eq!(cache.input_total_tokens, Some(400));
    }

    #[test]
    fn anthropic_usage_without_counters_is_not_reported() {
        let usage = json!({"input_tokens": 500, "output_tokens": 10});
        let cache = normalize_usage(WireProtocol::Anthropic, "anthropic", &usage);
        assert!(!cache.reported);
        assert_eq!(cache.cache_read_tokens, None);
        assert_eq!(cache.cache_write_tokens, None);
        assert_eq!(cache.input_total_tokens, Some(500));
    }

    #[test]
    fn openai_chat_usage_normalizes_cached_and_write() {
        // GPT-5.6+ Chat Completions: `prompt_tokens` is inclusive.
        let usage = json!({
            "prompt_tokens": 12_000,
            "completion_tokens": 300,
            "prompt_tokens_details": {
                "cached_tokens": 4_000,
                "cache_write_tokens": 7_000,
            },
            "total_tokens": 12_300,
        });
        let cache = normalize_usage(WireProtocol::OpenaiChat, "openai", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(4_000));
        assert_eq!(cache.cache_write_tokens, Some(7_000));
        assert_eq!(cache.uncached_input_tokens, Some(1_000));
        assert_eq!(cache.input_total_tokens, Some(12_000));
    }

    #[test]
    fn deepseek_usage_reads_prompt_cache_hit_and_miss() {
        let usage = json!({
            "prompt_tokens": 10_000,
            "completion_tokens": 500,
            "prompt_cache_hit_tokens": 9_000,
            "prompt_cache_miss_tokens": 1_000,
        });
        let cache = normalize_usage(WireProtocol::OpenaiChat, "opencode-go", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(9_000));
        assert_eq!(cache.cache_write_tokens, None);
        assert_eq!(cache.uncached_input_tokens, Some(1_000));
        assert_eq!(cache.input_total_tokens, Some(10_000));
    }

    #[test]
    fn openai_responses_usage_normalizes_cached_and_write() {
        let usage = json!({
            "input_tokens": 20_000,
            "output_tokens": 100,
            "input_tokens_details": {
                "cached_tokens": 16_000,
                "cache_write_tokens": 2_000,
            },
        });
        let cache = normalize_usage(WireProtocol::OpenaiResponses, "openai", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(16_000));
        assert_eq!(cache.cache_write_tokens, Some(2_000));
        assert_eq!(cache.uncached_input_tokens, Some(2_000));
        assert_eq!(cache.input_total_tokens, Some(20_000));
    }

    #[test]
    fn google_usage_normalizes_cached_content_count() {
        let usage = json!({
            "promptTokenCount": 20_000,
            "candidatesTokenCount": 500,
            "cachedContentTokenCount": 18_000,
            "totalTokenCount": 20_500,
        });
        let cache = normalize_usage(WireProtocol::Google, "opencode-go", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(18_000));
        assert_eq!(cache.cache_write_tokens, None);
        assert_eq!(cache.uncached_input_tokens, Some(2_000));
        assert_eq!(cache.input_total_tokens, Some(20_000));
    }

    #[test]
    fn google_usage_without_cached_content_is_not_reported() {
        let usage = json!({"promptTokenCount": 1_200, "candidatesTokenCount": 10});
        let cache = normalize_usage(WireProtocol::Google, "opencode-go", &usage);
        assert!(!cache.reported);
        assert_eq!(cache.cache_read_tokens, None);
        assert_eq!(cache.input_total_tokens, Some(1_200));
    }

    #[test]
    fn opencode_gateway_block_is_used_when_native_counters_are_absent() {
        // Gateway shape from the research doc: `tokens.input` excludes cache and
        // `cache_read` can be larger than `prompt_tokens`.
        let usage = json!({
            "prompt_tokens": 1_200,
            "completion_tokens": 300,
            "opencode": {
                "billing_source": "balance",
                "tokens": {
                    "input": 1_200,
                    "output": 300,
                    "reasoning": 120,
                    "cache_read": 8_000,
                    "cache_write_5m": 0,
                    "cache_write_1h": 2_000,
                }
            }
        });
        let cache = normalize_usage(WireProtocol::OpenaiChat, "opencode-go", &usage);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(8_000));
        assert_eq!(cache.cache_write_tokens, Some(2_000));
        assert_eq!(cache.uncached_input_tokens, Some(1_200));
        assert_eq!(cache.input_total_tokens, Some(11_200));
    }

    #[test]
    fn opencode_gateway_block_is_ignored_for_direct_providers() {
        let usage = json!({
            "prompt_tokens": 1_000,
            "opencode": {"tokens": {"input": 1_000, "cache_read": 900}},
        });
        let cache = normalize_usage(WireProtocol::OpenaiChat, "openai", &usage);
        assert!(!cache.reported);
        assert_eq!(cache.cache_read_tokens, None);
        assert_eq!(cache.input_total_tokens, Some(1_000));
    }

    #[test]
    fn usage_wrappers_are_accepted() {
        let raw = json!({
            "usage": {
                "input_tokens": 10_000,
                "input_tokens_details": {"cached_tokens": 8_000},
            }
        });
        let cache = normalize_usage(WireProtocol::OpenaiResponses, "openai", &raw);
        assert!(cache.reported);
        assert_eq!(cache.cache_read_tokens, Some(8_000));
        assert_eq!(cache.input_total_tokens, Some(10_000));

        let raw = json!({
            "usageMetadata": {
                "promptTokenCount": 5_000,
                "cachedContentTokenCount": 4_000,
            }
        });
        let cache = normalize_usage(WireProtocol::Google, "opencode-go", &raw);
        assert_eq!(cache.cache_read_tokens, Some(4_000));
        assert_eq!(cache.input_total_tokens, Some(5_000));
    }

    #[test]
    fn apply_usage_fills_usage_info_and_legacy_alias() {
        let cache = normalize_usage(
            WireProtocol::Anthropic,
            "anthropic",
            &json!({
                "input_tokens": 100,
                "cache_creation_input_tokens": 50,
                "cache_read_input_tokens": 400,
            }),
        );
        let mut info = super::super::make_usage(Some(100), Some(10), None, None, None);
        apply_usage(&mut info, &cache);
        assert_eq!(info.cache_read_tokens, Some(400));
        assert_eq!(info.cache_write_tokens, Some(50));
        assert_eq!(info.uncached_input_tokens, Some(100));
        assert!(info.cache_reported);
        assert_eq!(info.cached_tokens, Some(400));
        assert_eq!(info.cache_usage().input_total_tokens, Some(550));
    }

    /* ------------------- safe raw usage excerpt (B2) ------------------ */

    #[test]
    fn usage_excerpt_keeps_only_safe_usage_counters() {
        let raw = json!({
            "input_tokens": 250,
            "output_tokens": 120,
            "cache_read_input_tokens": 8_000,
            "cache_creation_input_tokens": 1_200,
            // Sensitive/irrelevant fields that must never reach the excerpt.
            "prompt": "SEGREDO do usuário",
            "content": [{"type": "text", "text": "SEGREDO"}],
            "authorization": "Bearer sk-secret",
            "request_id": "req_123",
            "session_id": "sess-abc",
            "metadata": {"user_id": "u-1"},
            "prompt_tokens_details": {
                "cached_tokens": 4_000,
                "cache_write_tokens": 7_000,
                "audio_tokens": 0,
                "raw_text": "SEGREDO",
            },
            "cache_creation": {
                "ephemeral_1h_input_tokens": 1_200,
                "ephemeral_5m_input_tokens": 0,
            },
            "opencode": {
                "billing_source": "go",
                "list_cost": 0.0042,
                "allowance": 0.001,
                "tokens": {
                    "input": 15,
                    "cache_read": 8_000,
                    "cache_write_5m": 0,
                    "cache_write_1h": 1_200,
                },
                // Gateway routing/session metadata must be dropped.
                "session_id": "opencode-session-secret",
                "request_id": "req-gateway",
            },
        });
        let excerpt = usage_excerpt(&raw);
        assert_eq!(excerpt["input_tokens"], json!(250));
        assert_eq!(excerpt["cache_read_input_tokens"], json!(8_000));
        assert_eq!(excerpt["cache_creation_input_tokens"], json!(1_200));
        assert_eq!(
            excerpt["prompt_tokens_details"]["cached_tokens"],
            json!(4_000)
        );
        assert_eq!(
            excerpt["prompt_tokens_details"]["cache_write_tokens"],
            json!(7_000)
        );
        assert_eq!(
            excerpt["cache_creation"]["ephemeral_1h_input_tokens"],
            json!(1_200)
        );
        assert_eq!(excerpt["opencode"]["tokens"]["cache_read"], json!(8_000));
        assert_eq!(
            excerpt["opencode"]["tokens"]["cache_write_1h"],
            json!(1_200)
        );
        assert_eq!(excerpt["opencode"]["billing_source"], json!("go"));

        // Nothing sensitive/unknown survives anywhere in the excerpt.
        let serialized = excerpt.to_string();
        for forbidden in [
            "SEGREDO",
            "sk-secret",
            "Bearer",
            "req_123",
            "sess-abc",
            "u-1",
            "raw_text",
            "session_id",
            "request_id",
            "metadata",
            "authorization",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "campo proibido {forbidden} vazou no excerpt: {serialized}"
            );
        }
        // Provider-content keys are not present at all (the excerpt has
        // `prompt_tokens_details`, so check the keys, not a substring).
        assert!(excerpt.get("prompt").is_none());
        assert!(excerpt.get("content").is_none());
        assert!(excerpt.get("authorization").is_none());
    }

    #[test]
    fn usage_excerpt_supports_google_and_openai_details() {
        let google = usage_excerpt(&json!({
            "promptTokenCount": 20_000,
            "candidatesTokenCount": 500,
            "cachedContentTokenCount": 18_000,
            "thoughtsTokenCount": 12,
            "totalTokenCount": 20_512,
        }));
        assert_eq!(google["cachedContentTokenCount"], json!(18_000));
        assert_eq!(google["promptTokenCount"], json!(20_000));

        let responses = usage_excerpt(&json!({
            "input_tokens": 20_000,
            "output_tokens": 100,
            "input_tokens_details": {"cached_tokens": 16_000, "cache_write_tokens": 2_000},
            "output_tokens_details": {"reasoning_tokens": 40},
            "service_tier": "default",
        }));
        assert_eq!(
            responses["input_tokens_details"]["cached_tokens"],
            json!(16_000)
        );
        assert_eq!(
            responses["output_tokens_details"]["reasoning_tokens"],
            json!(40)
        );
        assert_eq!(responses["service_tier"], json!("default"));
    }

    #[test]
    fn usage_excerpt_is_capped_at_four_kilobytes() {
        // A pathological details object would blow the cap without the fitting
        // step; the excerpt must stay ≤ 4 KB and keep the core counters.
        let mut details = serde_json::Map::new();
        for index in 0..2_000 {
            details.insert(format!("counter_{index}"), json!(index));
        }
        let raw = json!({
            "input_tokens": 10_000,
            "cache_read_input_tokens": 9_000,
            "prompt_tokens_details": Value::Object(details),
        });
        let excerpt = usage_excerpt(&raw);
        let size = serde_json::to_string(&excerpt)
            .expect("excerpt serializa")
            .len();
        assert!(
            size <= USAGE_RAW_MAX_BYTES,
            "excerpt {size} bytes > {USAGE_RAW_MAX_BYTES} ({excerpt})"
        );
        assert_eq!(excerpt["input_tokens"], json!(10_000));
    }

    #[test]
    fn usage_excerpt_is_null_without_known_counters() {
        assert_eq!(
            usage_excerpt(&json!({"unexpected": "value", "prompt": "SEGREDO"})),
            Value::Null
        );
        assert_eq!(usage_excerpt(&Value::Null), Value::Null);
    }

    /* ------------------------- digest fixtures ------------------------ */

    /// OpenAI Chat body: system message, tools, user + assistant replay.
    fn openai_chat_body() -> Value {
        json!({
            "model": "deepseek-v4.1-flash",
            "stream": true,
            "stream_options": {"include_usage": true},
            "max_tokens": 1_024,
            "messages": [
                {"role": "system", "content": "Você é o Zylara."},
                {"role": "user", "content": "Liste os arquivos."},
                {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "list_dir", "arguments": "{\"path\":\".\"}"},
                    }],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "[\"a.rs\"]"},
            ],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "list_dir",
                    "description": "Lista um diretório.",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                },
            }],
        })
    }

    /// Anthropic body: tools, system, messages (wire order).
    fn anthropic_body() -> Value {
        json!({
            "model": "claude-haiku-5-5",
            "stream": true,
            "max_tokens": 1_024,
            "system": "Você é o Zylara.",
            "tools": [{
                "name": "list_dir",
                "description": "Lista um diretório.",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
            }],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "Liste os arquivos."}]},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Vou listar."},
                        {"type": "tool_use", "id": "toolu_1", "name": "list_dir", "input": {"path": "."}},
                    ],
                },
                {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "[\"a.rs\"]"}],
                },
            ],
        })
    }

    /// OpenAI Responses body: instructions, tools, input items.
    fn openai_responses_body() -> Value {
        json!({
            "model": "gpt-6.1-sol",
            "stream": true,
            "instructions": "Você é o Zylara.",
            "tools": [{
                "type": "function",
                "name": "list_dir",
                "description": "Lista um diretório.",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
            }],
            "input": [
                {"role": "user", "content": "Liste os arquivos."},
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "list_dir",
                    "arguments": "{\"path\":\".\"}",
                },
                {"type": "function_call_output", "call_id": "call_1", "output": "[\"a.rs\"]"},
            ],
        })
    }

    /// Google body: systemInstruction, tools, contents.
    fn google_body() -> Value {
        json!({
            "systemInstruction": {"parts": [{"text": "Você é o Zylara."}]},
            "tools": [{
                "functionDeclarations": [{
                    "name": "list_dir",
                    "description": "Lista um diretório.",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                }],
            }],
            "contents": [
                {"role": "user", "parts": [{"text": "Liste os arquivos."}]},
                {
                    "role": "model",
                    "parts": [{"functionCall": {"name": "list_dir", "args": {"path": "."}}}],
                },
                {"role": "user", "parts": [{"functionResponse": {"name": "list_dir", "response": {"result": "a.rs"}}}]},
            ],
            "generationConfig": {"maxOutputTokens": 1_024},
        })
    }

    fn kinds(digest: &PrefixDigest) -> Vec<SegmentKind> {
        digest.segments.iter().map(|segment| segment.kind).collect()
    }

    #[test]
    fn digest_openai_chat_segments_follow_wire_order() {
        let body = openai_chat_body();
        let digest = digest(WireProtocol::OpenaiChat, "opencode-go", &body);
        assert_eq!(digest.protocol, "openai-chat");
        assert_eq!(
            kinds(&digest),
            vec![
                SegmentKind::System,
                SegmentKind::Tools,
                SegmentKind::Message,
                SegmentKind::Message,
                SegmentKind::Message,
            ]
        );
        assert_eq!(
            digest.segments.iter().map(|s| s.index).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
        let chars: u32 = digest.segments.iter().map(|segment| segment.chars).sum();
        assert_eq!(digest.total_chars, chars);
        assert_eq!(digest.estimated_tokens, digest.total_chars / 4);
        assert!(digest.segments.iter().all(|segment| segment.chars > 0));
    }

    #[test]
    fn digest_anthropic_order_is_tools_system_messages() {
        let body = anthropic_body();
        let digest = digest(WireProtocol::Anthropic, "opencode-go", &body);
        assert_eq!(
            kinds(&digest),
            vec![
                SegmentKind::Tools,
                SegmentKind::System,
                SegmentKind::Message,
                SegmentKind::Message,
                SegmentKind::Message,
            ]
        );
    }

    #[test]
    fn digest_openai_responses_order_is_instructions_tools_input() {
        let body = openai_responses_body();
        let digest = digest(WireProtocol::OpenaiResponses, "openai", &body);
        assert_eq!(
            kinds(&digest),
            vec![
                SegmentKind::System,
                SegmentKind::Tools,
                SegmentKind::Message,
                SegmentKind::Message,
                SegmentKind::Message,
            ]
        );
    }

    #[test]
    fn digest_google_order_is_system_instruction_tools_contents() {
        let body = google_body();
        let digest = digest(WireProtocol::Google, "opencode-go", &body);
        assert_eq!(
            kinds(&digest),
            vec![
                SegmentKind::System,
                SegmentKind::Tools,
                SegmentKind::Message,
                SegmentKind::Message,
                SegmentKind::Message,
            ]
        );
    }

    #[test]
    fn digest_is_stable_when_cache_metadata_changes() {
        // Anthropic: enabling breakpoints / changing TTL must not look like a
        // prefix break. Cache markers live inside tools, system and messages.
        let mut first = anthropic_body();
        first["system"] = json!([
            {"type": "text", "text": "Você é o Zylara."},
            {"type": "text", "text": "Contexto estável."},
        ]);
        let reference = digest(WireProtocol::Anthropic, "anthropic", &first);

        let mut with_metadata = first.clone();
        with_metadata["system"][1]["cache_control"] = json!({"type": "ephemeral", "ttl": "1h"});
        with_metadata["tools"][0]["cache_control"] = json!({"type": "ephemeral"});
        with_metadata["messages"][0]["content"][0]["cache_control"] =
            json!({"type": "ephemeral", "ttl": "5m"});
        let cached = digest(WireProtocol::Anthropic, "anthropic", &with_metadata);

        assert_eq!(
            reference.segments, cached.segments,
            "metadados de cache não podem mudar o digest"
        );
        assert_eq!(reference.total_chars, cached.total_chars);
    }

    #[test]
    fn digest_ignores_openai_cache_key_and_options() {
        let base = openai_chat_body();
        let reference = digest(WireProtocol::OpenaiChat, "openai", &base);

        let mut cached = base.clone();
        cached["prompt_cache_key"] = json!("conversation-123");
        cached["prompt_cache_retention"] = json!("24h");
        cached["prompt_cache_options"] = json!({"ttl": "30m"});
        // A hypothetical per-block breakpoint (GPT-5.6 explicit mode): it is
        // metadata on the message, the message bytes stay the same.
        cached["messages"][3]["prompt_cache_breakpoint"] =
            json!({"mode": "explicit", "ttl": "12h"});
        let with_metadata = digest(WireProtocol::OpenaiChat, "openai", &cached);
        assert_eq!(reference.segments, with_metadata.segments);
    }

    #[test]
    fn digest_ignores_google_cached_content_pointer() {
        let base = google_body();
        let reference = digest(WireProtocol::Google, "opencode-go", &base);
        let mut cached = base.clone();
        cached["cachedContent"] = json!("projects/p/locations/l/cachedContents/c-1");
        let with_pointer = digest(WireProtocol::Google, "opencode-go", &cached);
        assert_eq!(reference.segments, with_pointer.segments);
    }

    #[test]
    fn digest_changes_when_any_prefix_byte_changes() {
        let base = openai_chat_body();
        let reference = digest(WireProtocol::OpenaiChat, "openai", &base);

        let mut text_changed = base.clone();
        text_changed["messages"][1]["content"] = json!("Liste os arquivos do src.");
        let changed = digest(WireProtocol::OpenaiChat, "openai", &text_changed);
        assert_eq!(
            changed.common_prefix_segments(&reference),
            2,
            "system + tools sobrevivem; a primeira mensagem (índice 2) muda"
        );

        let mut tool_changed = base.clone();
        tool_changed["tools"][0]["function"]["description"] =
            json!("Lista um diretório do workspace.");
        let changed = digest(WireProtocol::OpenaiChat, "openai", &tool_changed);
        assert_eq!(
            changed.common_prefix_segments(&reference),
            1,
            "system sobrevive, tools (índice 1) muda"
        );

        let mut system_changed = base.clone();
        system_changed["messages"][0]["content"] = json!("Você é o Zylara. Responda em pt-BR.");
        let changed = digest(WireProtocol::OpenaiChat, "openai", &system_changed);
        assert_eq!(changed.common_prefix_segments(&reference), 0);
    }

    #[test]
    fn digest_is_append_only_for_new_messages() {
        let base = openai_chat_body();
        let previous = digest(WireProtocol::OpenaiChat, "openai", &base);

        let mut grown = base.clone();
        grown["messages"]
            .as_array_mut()
            .expect("messages array")
            .push(json!({"role": "user", "content": "Agora abra o a.rs."}));
        let next = digest(WireProtocol::OpenaiChat, "openai", &grown);

        // The N+1 request is an extension of N: every previous segment hash is
        // identical and only one new segment exists at the tail.
        assert_eq!(next.segments.len(), previous.segments.len() + 1);
        assert_eq!(
            next.common_prefix_segments(&previous),
            previous.segments.len(),
            "prefixo do request anterior precisa continuar idêntico"
        );
        assert_eq!(
            next.chars_up_to(previous.segments.len()),
            previous.total_chars
        );
    }

    #[test]
    fn digest_depends_on_protocol_and_provider_domain() {
        let body = openai_chat_body();
        let reference = digest(WireProtocol::OpenaiChat, "opencode-go", &body);
        let other_provider = digest(WireProtocol::OpenaiChat, "openai", &body);
        assert_eq!(
            reference.common_prefix_segments(&other_provider),
            0,
            "domínios de cache diferentes nunca comparam iguais"
        );

        let other_protocol = digest(WireProtocol::OpenaiResponses, "opencode-go", &body);
        assert_eq!(reference.common_prefix_segments(&other_protocol), 0);
        assert_eq!(other_protocol.protocol, "openai-responses");
    }

    #[test]
    fn digest_is_insensitive_to_object_key_order() {
        // Same rendered message written with a different key order.
        let body_a = json!({
            "messages": [{"role": "user", "content": "oi"}],
            "tools": [{"name": "echo", "description": "Ecoa."}],
        });
        let body_b = json!({
            "tools": [{"description": "Ecoa.", "name": "echo"}],
            "messages": [{"content": "oi", "role": "user"}],
        });
        let a = digest(WireProtocol::OpenaiChat, "openai", &body_a);
        let b = digest(WireProtocol::OpenaiChat, "openai", &body_b);
        assert_eq!(a.segments, b.segments);
        assert_eq!(a.total_chars, b.total_chars);
    }

    #[test]
    fn digest_of_empty_body_has_no_segments() {
        let digest = digest(WireProtocol::OpenaiChat, "openai", &json!({}));
        assert!(digest.segments.is_empty());
        assert_eq!(digest.total_chars, 0);
        assert_eq!(digest.estimated_tokens, 0);
        assert_eq!(digest.protocol, "openai-chat");
    }

    #[test]
    fn digest_skips_empty_optional_segments() {
        let body = json!({
            "messages": [{"role": "user", "content": "oi"}],
            "tools": [],
            "system": "",
        });
        let digest = digest(WireProtocol::Anthropic, "anthropic", &body);
        // Empty tools/system are not wire bytes; only the user block remains.
        assert_eq!(kinds(&digest), vec![SegmentKind::Message]);
    }

    /// `domain::PrefixDigest` intentionally has no `PartialEq` (it is a wire
    /// contract, not a value to compare casually); the tests compare field by
    /// field instead.
    fn assert_digest_equal(left: &PrefixDigest, right: &PrefixDigest, context: &str) {
        assert_eq!(left.protocol, right.protocol, "{context}: protocolo");
        assert_eq!(left.segments, right.segments, "{context}: segmentos");
        assert_eq!(left.total_chars, right.total_chars, "{context}: chars");
        assert_eq!(
            left.estimated_tokens, right.estimated_tokens,
            "{context}: estimated_tokens"
        );
    }

    /// The F4b invariant: applying the explicit plan must not change the prefix
    /// digest (cache metadata is outside the hash and the Anthropic system is
    /// canonicalized into blocks), so the harness never sees a false break when
    /// the wiring turns the mechanism on.
    #[test]
    fn digest_is_stable_across_apply_for_every_protocol() {
        // Anthropic: system string → one text block + markers in tools/messages.
        let anthropic_before = anthropic_body();
        let before = digest(WireProtocol::Anthropic, "anthropic", &anthropic_before);
        let mut anthropic_after = anthropic_before.clone();
        apply(
            WireProtocol::Anthropic,
            Some(&anthropic_plan(Some("1h"))),
            &mut anthropic_after,
        );
        assert_ne!(
            anthropic_before, anthropic_after,
            "o plano precisa ter efeito"
        );
        assert_digest_equal(
            &digest(WireProtocol::Anthropic, "anthropic", &anthropic_after),
            &before,
            "anthropic",
        );

        // OpenAI Chat/Responses: key/retention are body-level cache metadata.
        let openai_plan = CachePlan {
            mode: CacheMode::Auto,
            breakpoints: Vec::new(),
            prompt_cache_key: Some("a".repeat(64)),
            retention: Some("24h".to_string()),
            ttl: None,
        };
        let chat_before = openai_chat_body();
        let mut chat_after = chat_before.clone();
        apply(
            WireProtocol::OpenaiChat,
            Some(&openai_plan),
            &mut chat_after,
        );
        assert_digest_equal(
            &digest(WireProtocol::OpenaiChat, "openai", &chat_after),
            &digest(WireProtocol::OpenaiChat, "openai", &chat_before),
            "openai-chat",
        );
        let responses_before = openai_responses_body();
        let mut responses_after = responses_before.clone();
        apply(
            WireProtocol::OpenaiResponses,
            Some(&openai_plan),
            &mut responses_after,
        );
        assert_digest_equal(
            &digest(WireProtocol::OpenaiResponses, "openai", &responses_after),
            &digest(WireProtocol::OpenaiResponses, "openai", &responses_before),
            "openai-responses",
        );

        // Google: no request field, the plan is a no-op.
        let google_before = google_body();
        let mut google_after = google_before.clone();
        apply(
            WireProtocol::Google,
            Some(&anthropic_plan(Some("1h"))),
            &mut google_after,
        );
        assert_eq!(google_after, google_before, "Google é no-op");
        assert_digest_equal(
            &digest(WireProtocol::Google, "opencode-go", &google_after),
            &digest(WireProtocol::Google, "opencode-go", &google_before),
            "google",
        );
    }

    /* --------------------------- capabilities ------------------------- */

    fn catalog_model(provider_id: &str, model_id: &str) -> ModelInfo {
        CatalogFile::load()
            .expect("catalog.json carrega")
            .model(provider_id, model_id)
            .unwrap_or_else(|| panic!("modelo {model_id} do provider {provider_id}"))
            .clone()
    }

    /// Minimal deserialized `ModelInfo` (only `id`/`name` are required) for
    /// model ids the bundled catalog does not carry.
    fn synthetic_model(model_id: &str) -> ModelInfo {
        serde_json::from_value(json!({"id": model_id, "name": model_id}))
            .expect("ModelInfo mínimo deserializa")
    }

    fn catalog_provider(provider_id: &str) -> crate::catalog::ProviderInfo {
        CatalogFile::load()
            .expect("catalog.json carrega")
            .provider(provider_id)
            .unwrap_or_else(|| panic!("provider {provider_id} no catálogo"))
            .clone()
    }

    /// Catalog `CacheInfo` fixture: the override blocks are complete, like the
    /// ones generated into `data/catalog.json`.
    fn cache_info(
        mode: &str,
        min_tokens: Option<u32>,
        ttl_options: &[&str],
    ) -> crate::catalog::CacheInfo {
        crate::catalog::CacheInfo {
            mode: mode.to_string(),
            min_tokens,
            block_tokens: Some(1),
            ttl_options: ttl_options.iter().map(|ttl| ttl.to_string()).collect(),
            supports_key: false,
            supports_retention: false,
            supports_explicit_breakpoints: true,
            reports_read: true,
            reports_write: true,
            source: Some("probe".to_string()),
        }
    }

    #[test]
    fn capabilities_follow_protocol_mechanisms() {
        let anthropic = capabilities(
            WireProtocol::Anthropic,
            "anthropic",
            &catalog_model("anthropic", "claude-haiku-5-5"),
        );
        assert_eq!(anthropic.mode, CacheMode::Explicit);
        assert!(anthropic.supports_explicit_breakpoints);
        assert!(anthropic.reports_read);
        assert!(anthropic.reports_write);
        assert_eq!(anthropic.ttl_options, &["5m", "1h"]);
        assert_eq!(anthropic.min_tokens, None, "mínimo é por modelo (F0b.2)");

        let chat = capabilities(
            WireProtocol::OpenaiChat,
            "openai",
            &catalog_model("openai", "gpt-6.1-sol"),
        );
        assert_eq!(chat.mode, CacheMode::Auto);
        assert_eq!(chat.min_tokens, Some(1_024));
        assert!(chat.supports_key);
        assert!(!chat.supports_explicit_breakpoints);
        assert_eq!(chat.block_tokens, 128);

        let responses = capabilities(
            WireProtocol::OpenaiResponses,
            "openai",
            &catalog_model("openai", "gpt-6.1-sol"),
        );
        assert_eq!(responses.mode, CacheMode::Auto);
        assert_eq!(responses.ttl_options, &["30m", "12h"]);
        assert!(responses.supports_explicit_breakpoints);

        let google = capabilities(
            WireProtocol::Google,
            "opencode-go",
            &catalog_model("opencode-go", "gemini-4-argon-contributor"),
        );
        assert_eq!(google.mode, CacheMode::Auto);
        assert_eq!(google.min_tokens, Some(4_096));
        assert!(!google.supports_explicit_breakpoints);
        // The implicit cache does not document writes per se, but the OpenCode
        // gateway may report its own cache_write counters.
        assert!(google.reports_write);
    }

    #[test]
    fn capabilities_deepseek_has_unknown_minimum_and_google_2_5_uses_2_048() {
        let deepseek = capabilities(
            WireProtocol::OpenaiChat,
            "opencode-go",
            &catalog_model("opencode-go", "deepseek-v4.1-flash"),
        );
        assert_eq!(deepseek.mode, CacheMode::Auto);
        assert_eq!(deepseek.min_tokens, None, "DeepSeek não documenta mínimo");

        // The bundled catalog has no Gemini 2.5 entry; the family default still
        // has to pick the 2.048 minimum (research §4.1).
        let gemini_25 = capabilities(
            WireProtocol::Google,
            "opencode-zen",
            &synthetic_model("gemini-2.5-pro"),
        );
        assert_eq!(gemini_25.min_tokens, Some(2_048));
        assert_eq!(
            capabilities(
                WireProtocol::Google,
                "opencode-zen",
                &synthetic_model("some-future-model")
            )
            .min_tokens,
            None,
            "modelo desconhecido = mínimo desconhecido, nunca um palpite"
        );
    }

    #[test]
    fn capabilities_with_applies_catalog_overrides() {
        let model = catalog_model("anthropic", "claude-haiku-5-5");
        let provider_cache = crate::catalog::CacheInfo {
            mode: "explicit".to_string(),
            min_tokens: Some(4_096),
            block_tokens: Some(1),
            ttl_options: vec!["1h".to_string(), "5m".to_string()],
            supports_key: false,
            supports_retention: false,
            supports_explicit_breakpoints: true,
            reports_read: true,
            reports_write: true,
            source: Some("probe".to_string()),
        };
        let caps = capabilities_with(WireProtocol::Anthropic, &model, Some(&provider_cache), None);
        assert_eq!(caps.mode, CacheMode::Explicit);
        assert_eq!(caps.min_tokens, Some(4_096));
        assert_eq!(caps.ttl_options, &["5m", "1h"], "ordem canônica");
        assert!(!caps.supports_key);

        // The model block wins over the provider block; `minTokens: null` is
        // unknown and must stay unknown (excluded from the target).
        let model_cache = crate::catalog::CacheInfo {
            mode: "auto".to_string(),
            min_tokens: None,
            block_tokens: None,
            ttl_options: Vec::new(),
            supports_key: true,
            supports_retention: false,
            supports_explicit_breakpoints: false,
            reports_read: true,
            reports_write: false,
            source: Some("family-default".to_string()),
        };
        let caps = capabilities_with(
            WireProtocol::Anthropic,
            &model,
            Some(&provider_cache),
            Some(&model_cache),
        );
        assert_eq!(caps.mode, CacheMode::Auto);
        assert_eq!(caps.min_tokens, None);
        assert!(caps.ttl_options.is_empty());
        assert!(caps.supports_key);
        assert!(!caps.reports_write);

        // Unknown TTL vocabulary keeps the protocol default instead of guessing.
        let odd_ttls = crate::catalog::CacheInfo {
            ttl_options: vec!["7m".to_string()],
            ..Default::default()
        };
        let caps = capabilities_with(WireProtocol::Anthropic, &model, Some(&odd_ttls), None);
        assert_eq!(caps.ttl_options, &["5m", "1h"]);
        // The block is authoritative for `min_tokens` (None = unknown).
        assert_eq!(caps.min_tokens, None);
    }

    /* --------------------- capabilities_for (F0b.2) ------------------- */

    #[test]
    fn capabilities_for_uses_protocol_defaults_without_catalog_cache() {
        let mut provider = catalog_provider("anthropic");
        provider.cache = None;
        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        model.cache = None;
        let caps = capabilities_for(WireProtocol::Anthropic, &provider, &model);
        assert_eq!(caps.mode, CacheMode::Explicit);
        assert_eq!(
            caps.min_tokens, None,
            "mínimo por modelo continua desconhecido"
        );
        assert_eq!(caps.ttl_options, &["5m", "1h"]);
        assert!(caps.supports_explicit_breakpoints);
        assert!(caps.reports_read && caps.reports_write);

        let mut openai = catalog_provider("openai");
        openai.cache = None;
        let mut gpt = catalog_model("openai", "gpt-6.1-sol");
        gpt.cache = None;
        let caps = capabilities_for(WireProtocol::OpenaiChat, &openai, &gpt);
        assert_eq!(caps.mode, CacheMode::Auto);
        assert_eq!(caps.min_tokens, Some(1_024));
    }

    #[test]
    fn capabilities_for_applies_the_provider_cache_override() {
        let mut provider = catalog_provider("anthropic");
        let mut cache = cache_info("explicit", Some(1_024), &["1h", "5m"]);
        // Catalog TTLs are mapped to the canonical static order.
        cache.reports_write = false;
        cache.supports_key = true;
        provider.cache = Some(cache);

        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        model.cache = None;
        let caps = capabilities_for(WireProtocol::Anthropic, &provider, &model);
        assert_eq!(caps.mode, CacheMode::Explicit);
        assert_eq!(caps.min_tokens, Some(1_024));
        assert_eq!(caps.ttl_options, &["5m", "1h"], "ordem canônica");
        assert!(!caps.reports_write);
        assert!(caps.supports_key);

        // An override with an empty `mode` keeps the protocol default, and an
        // unknown TTL vocabulary is ignored (never invented).
        provider.cache = Some(crate::catalog::CacheInfo {
            mode: String::new(),
            ttl_options: vec!["7m".to_string()],
            ..cache_info("", Some(2_048), &[])
        });
        let caps = capabilities_for(WireProtocol::Anthropic, &provider, &model);
        assert_eq!(caps.mode, CacheMode::Explicit, "modo vazio não sobrescreve");
        assert_eq!(caps.ttl_options, &["5m", "1h"]);
        assert_eq!(caps.min_tokens, Some(2_048));
    }

    #[test]
    fn capabilities_for_model_override_wins_over_provider() {
        let mut provider = catalog_provider("anthropic");
        provider.cache = Some(cache_info("explicit", Some(4_096), &["5m", "1h"]));

        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        let mut model_cache = cache_info("auto", None, &["30m", "12h"]);
        model_cache.block_tokens = Some(128);
        model_cache.reports_write = false;
        model.cache = Some(model_cache);

        let caps = capabilities_for(WireProtocol::Anthropic, &provider, &model);
        assert_eq!(caps.mode, CacheMode::Auto, "modelo vence provedor");
        assert_eq!(
            caps.min_tokens, None,
            "null do modelo vence 4096 do provider"
        );
        assert_eq!(caps.ttl_options, &["30m", "12h"]);
        assert_eq!(caps.block_tokens, 128);
        assert!(!caps.reports_write);
        assert!(caps.reports_read);
    }

    #[test]
    fn capabilities_for_treats_absent_or_null_min_tokens_as_unknown() {
        // `CacheInfo` is `#[serde(default)]`: an absent field and an explicit
        // `null` both deserialize to `None` — unknown, never `0`.
        let absent: crate::catalog::CacheInfo =
            serde_json::from_value(json!({"mode": "explicit"})).expect("CacheInfo sem minTokens");
        assert_eq!(absent.min_tokens, None);
        let explicit_null: crate::catalog::CacheInfo =
            serde_json::from_value(json!({"mode": "explicit", "minTokens": null}))
                .expect("CacheInfo com minTokens null");
        assert_eq!(explicit_null.min_tokens, None);

        let mut provider = catalog_provider("anthropic");
        provider.cache = Some(absent);
        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        model.cache = None;
        let caps = capabilities_for(WireProtocol::Anthropic, &provider, &model);
        assert_eq!(caps.min_tokens, None);
        assert_ne!(caps.min_tokens, Some(0), "desconhecido não pode virar 0");
    }

    #[test]
    fn capabilities_for_anthropic_direct_explicit_with_one_hour_ttl() {
        // The direct Anthropic route is the F4 reference: explicit breakpoints
        // with a 1 h TTL option on a large model minimum.
        let mut provider = catalog_provider("anthropic");
        let mut cache = cache_info("explicit", Some(1_024), &["5m", "1h"]);
        cache.supports_explicit_breakpoints = true;
        cache.reports_read = true;
        cache.reports_write = true;
        provider.cache = Some(cache);

        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        model.cache = None;
        let caps = capabilities_for(WireProtocol::Anthropic, &provider, &model);
        assert_eq!(caps.mode, CacheMode::Explicit);
        assert_eq!(caps.min_tokens, Some(1_024));
        assert!(caps.ttl_options.contains(&"1h"));
        assert!(caps.supports_explicit_breakpoints);
        assert!(caps.reports_read && caps.reports_write);
    }

    /* ---------------- plan/apply (F4a: body tests) ------------------- */

    fn catalog_request(
        protocol: WireProtocol,
        provider_id: &str,
        model_id: &str,
    ) -> CompletionRequest {
        let catalog = CatalogFile::load().expect("catalog.json carrega");
        let provider = catalog
            .provider(provider_id)
            .unwrap_or_else(|| panic!("provider {provider_id} no catálogo"));
        let model = catalog
            .model(provider_id, model_id)
            .unwrap_or_else(|| panic!("modelo {model_id} em {provider_id}"))
            .clone();
        CompletionRequest {
            config: super::super::ProviderConfig {
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                api_key: "sk-test".to_string(),
                auth_header: provider.auth_header.clone(),
                auth_prefix: provider.auth_prefix.clone(),
                model,
                session_id: "session-1".to_string(),
                user_agent: "Zylara/test".to_string(),
                endpoints: provider.endpoints.clone(),
                request_profile: crate::catalog::RequestProfile::Standard,
                auth_mode: crate::catalog::ProviderAuth::ApiKey,
                extra_headers: Vec::new(),
            },
            protocols: vec![protocol],
            history: vec![super::super::HistoryMessage::user(
                "Liste os arquivos do src.",
            )],
            system_prompt: "Você é o Zylara.".to_string(),
            tools: vec![super::super::ToolDefinition {
                name: "list_dir".to_string(),
                description: "Lista um diretório.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                }),
            }],
            reasoning: super::super::ReasoningRequest::Auto,
            max_output_tokens: Some(2_048),
            temperature: None,
            cache_plan: None,
            timeouts: crate::providers::StreamTimeouts::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
        }
    }

    fn caps_fixture(
        mode: CacheMode,
        min_tokens: Option<u32>,
        supports_key: bool,
        supports_retention: bool,
        supports_explicit_breakpoints: bool,
    ) -> CacheCapabilities {
        CacheCapabilities {
            mode,
            min_tokens,
            block_tokens: 1,
            ttl_options: &["5m", "1h"],
            supports_key,
            supports_retention,
            supports_explicit_breakpoints,
            reports_read: true,
            reports_write: true,
        }
    }

    fn anthropic_plan(ttl: Option<&str>) -> CachePlan {
        CachePlan {
            mode: CacheMode::Explicit,
            breakpoints: vec![
                CacheBreakpoint {
                    target: CacheBreakpointTarget::Tools,
                    ttl: None,
                },
                CacheBreakpoint {
                    target: CacheBreakpointTarget::System,
                    ttl: None,
                },
                CacheBreakpoint {
                    target: CacheBreakpointTarget::Tail,
                    ttl: None,
                },
            ],
            prompt_cache_key: None,
            retention: None,
            ttl: ttl.map(str::to_string),
        }
    }

    fn count_cache_controls(value: &Value) -> usize {
        match value {
            Value::Object(map) => map
                .iter()
                .map(|(key, value)| {
                    let own = if key == "cache_control" { 1 } else { 0 };
                    own + count_cache_controls(value)
                })
                .sum(),
            Value::Array(items) => items.iter().map(count_cache_controls).sum(),
            _ => 0,
        }
    }

    fn strip_cache_control(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("cache_control");
                for child in map.values_mut() {
                    strip_cache_control(child);
                }
            }
            Value::Array(items) => {
                for item in items {
                    strip_cache_control(item);
                }
            }
            _ => {}
        }
    }

    /// Remove the F4a metadata and the system string→block restructuring, so a
    /// body can be compared against the pre-`apply` shape.
    fn strip_anthropic_plan(body: &Value) -> Value {
        let mut body = body.clone();
        let single_system_text = body
            .get("system")
            .and_then(Value::as_array)
            .filter(|blocks| blocks.len() == 1)
            .and_then(|blocks| blocks[0].get("text"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(text) = single_system_text {
            body["system"] = json!(text);
        }
        strip_cache_control(&mut body);
        body
    }

    #[test]
    fn plan_anthropic_needs_a_known_minimum() {
        let request = catalog_request(WireProtocol::Anthropic, "anthropic", "claude-haiku-5-5");
        // The bundled catalog declares Anthropic `minTokens: null` (per model,
        // unknown): no explicit write is planned for an unknown minimum.
        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        model.cache = None;
        assert!(
            plan(WireProtocol::Anthropic, "anthropic", &model, &request).is_none(),
            "mínimo desconhecido não pode pagar write explícito"
        );

        // A probed minimum makes the plan appear (F4.0 fills this in).
        model.cache = Some(cache_info("explicit", Some(1), &["5m", "1h"]));
        assert!(plan(WireProtocol::Anthropic, "anthropic", &model, &request).is_some());
    }

    #[test]
    fn plan_anthropic_has_three_breakpoints_and_one_hour_ttl() {
        let request = catalog_request(WireProtocol::Anthropic, "anthropic", "claude-haiku-5-5");
        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        model.cache = Some(cache_info("explicit", Some(1), &["5m", "1h"]));
        let plan = plan(WireProtocol::Anthropic, "anthropic", &model, &request)
            .expect("plano Anthropic com mínimo conhecido");

        assert_eq!(plan.mode, CacheMode::Explicit);
        assert_eq!(plan.ttl.as_deref(), Some("1h"), "TTL default 1h");
        assert_eq!(
            plan.breakpoints
                .iter()
                .map(|breakpoint| breakpoint.target)
                .collect::<Vec<_>>(),
            vec![
                CacheBreakpointTarget::Tools,
                CacheBreakpointTarget::System,
                CacheBreakpointTarget::Tail,
            ],
            "breakpoints na ordem do wire: tools → system → cauda"
        );
        assert!(plan.breakpoints.len() <= MAX_ANTHROPIC_BREAKPOINTS);
        assert_eq!(plan.prompt_cache_key, None);
        assert_eq!(plan.retention, None);
    }

    #[test]
    fn plan_anthropic_accepts_five_minutes_and_skips_absent_segments() {
        let mut request = catalog_request(WireProtocol::Anthropic, "anthropic", "claude-haiku-5-5");
        request.tools.clear();
        request.system_prompt.clear();
        let caps = caps_fixture(CacheMode::Explicit, Some(0), false, false, true);
        let mut settings = CacheSettings::default();
        settings.anthropic_ttl = CacheTtl::FiveMinutes;
        let plan = plan_with_caps(WireProtocol::Anthropic, &caps, &request, &settings)
            .expect("só a cauda estável resta");
        assert_eq!(
            plan.breakpoints
                .iter()
                .map(|breakpoint| breakpoint.target)
                .collect::<Vec<_>>(),
            vec![CacheBreakpointTarget::Tail]
        );
        assert_eq!(plan.ttl.as_deref(), Some("5m"));
    }

    #[test]
    fn plan_anthropic_respects_the_prefix_estimate() {
        let mut model = catalog_model("anthropic", "claude-haiku-5-5");
        let mut request = catalog_request(WireProtocol::Anthropic, "anthropic", "claude-haiku-5-5");
        // ~2.000 estimated tokens (8.000 chars + tools/history/system).
        request.system_prompt = "x".repeat(8_000);
        model.cache = Some(cache_info("explicit", Some(1_000), &[]));
        assert!(plan(WireProtocol::Anthropic, "anthropic", &model, &request).is_some());

        model.cache = Some(cache_info("explicit", Some(1_000_000), &[]));
        assert!(
            plan(WireProtocol::Anthropic, "anthropic", &model, &request).is_none(),
            "prefixo estimado abaixo do min_tokens conhecido não planeja"
        );
    }

    #[test]
    fn plan_anthropic_honors_mode_none() {
        let request = catalog_request(WireProtocol::Anthropic, "anthropic", "claude-haiku-5-5");
        let caps = caps_fixture(CacheMode::None, Some(1), false, false, false);
        assert!(plan_with_caps(
            WireProtocol::Anthropic,
            &caps,
            &request,
            &CacheSettings::default()
        )
        .is_none());
    }

    #[test]
    fn plan_openai_key_is_a_stable_64_char_hex_of_the_route() {
        let model = catalog_model("openai", "gpt-6.1-sol");
        let request = catalog_request(WireProtocol::OpenaiResponses, "openai", "gpt-6.1-sol");
        let planned =
            plan(WireProtocol::OpenaiResponses, "openai", &model, &request).expect("plano OpenAI");
        let key = planned.prompt_cache_key.clone().expect("prompt_cache_key");
        assert_eq!(key.len(), 64, "sha256 hex");
        assert!(key.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(planned.retention, None, "retention é opt-in até o probe");
        assert!(planned.breakpoints.is_empty());
        assert_eq!(planned.mode, CacheMode::Auto);

        // Stable for the same route, independent of user text.
        let mut other = request.clone();
        other
            .history
            .push(super::super::HistoryMessage::user("segredo do usuário"));
        assert_eq!(
            plan(WireProtocol::OpenaiResponses, "openai", &model, &other)
                .and_then(|plan| plan.prompt_cache_key),
            Some(key.clone()),
            "texto do usuário nunca entra na chave"
        );

        // A different session/protocol is a different cache domain.
        other = request.clone();
        other.config.session_id = "session-2".to_string();
        assert_ne!(
            plan(WireProtocol::OpenaiResponses, "openai", &model, &other)
                .and_then(|plan| plan.prompt_cache_key),
            Some(key.clone())
        );
        let chat =
            plan(WireProtocol::OpenaiChat, "openai", &model, &request).expect("plano openai-chat");
        assert_ne!(chat.prompt_cache_key, Some(key));
    }

    #[test]
    fn plan_openai_skips_chatgpt_plan_and_disabled_routes() {
        let model = catalog_model("openai", "gpt-6.1-sol");
        let mut request = catalog_request(WireProtocol::OpenaiResponses, "openai", "gpt-6.1-sol");
        request.config.request_profile = crate::catalog::RequestProfile::ChatgptPlan;
        assert!(
            plan(WireProtocol::OpenaiResponses, "openai", &model, &request).is_none(),
            "prompt_cache_key não é documentado no plano OAuth (probe F4.0)"
        );

        request.config.request_profile = crate::catalog::RequestProfile::Standard;
        let no_key = caps_fixture(CacheMode::Auto, Some(1_024), false, true, false);
        assert!(plan_with_caps(
            WireProtocol::OpenaiResponses,
            &no_key,
            &request,
            &CacheSettings::default()
        )
        .is_none());
        let disabled = caps_fixture(CacheMode::None, Some(1_024), true, true, false);
        assert!(plan_with_caps(
            WireProtocol::OpenaiResponses,
            &disabled,
            &request,
            &CacheSettings::default()
        )
        .is_none());
    }

    #[test]
    fn plan_openai_retention_requires_capability_and_valid_value() {
        let request = catalog_request(WireProtocol::OpenaiResponses, "openai", "gpt-6.1-sol");
        let caps = caps_fixture(CacheMode::Auto, Some(1_024), true, true, false);
        let mut settings = CacheSettings::default();
        settings.openai_retention = Some("24h".to_string());
        let plan = plan_with_caps(WireProtocol::OpenaiResponses, &caps, &request, &settings)
            .expect("plano com key");
        assert_eq!(plan.retention.as_deref(), Some("24h"));

        // `prompt_cache_retention` only accepts `in_memory`/`24h`.
        settings.openai_retention = Some("12h".to_string());
        let plan = plan_with_caps(WireProtocol::OpenaiResponses, &caps, &request, &settings)
            .expect("plano com key");
        assert_eq!(plan.retention, None, "valor inválido não é enviado");

        // Capability gate: no retention even when the setting is set.
        settings.openai_retention = Some("24h".to_string());
        let caps_no_retention = caps_fixture(CacheMode::Auto, Some(1_024), true, false, false);
        let plan = plan_with_caps(
            WireProtocol::OpenaiResponses,
            &caps_no_retention,
            &request,
            &settings,
        )
        .expect("plano com key");
        assert_eq!(plan.retention, None);
    }

    #[test]
    fn apply_anthropic_places_three_breakpoints_and_preserves_text() {
        let mut before = anthropic_body();
        before["tools"]
            .as_array_mut()
            .expect("tools array")
            .push(json!({
                "name": "read_file",
                "description": "Lê um arquivo.",
                "input_schema": {"type": "object"},
            }));
        let plan = anthropic_plan(Some("1h"));
        let mut body = before.clone();
        apply(WireProtocol::Anthropic, Some(&plan), &mut body);

        assert_eq!(count_cache_controls(&body), 3);
        assert!(count_cache_controls(&body) <= MAX_ANTHROPIC_BREAKPOINTS);

        // System: string → one text block, text preserved, 1h TTL.
        let system = body["system"].as_array().expect("system virou array");
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["type"], json!("text"));
        assert_eq!(system[0]["text"], json!("Você é o Zylara."));
        assert_eq!(
            system[0]["cache_control"],
            json!({"type": "ephemeral", "ttl": "1h"})
        );

        // Tools: only the last tool carries the breakpoint.
        let tools = body["tools"].as_array().expect("tools array");
        assert!(
            tools[0].get("cache_control").is_none(),
            "tools[0] sem marker"
        );
        assert_eq!(
            tools[1]["cache_control"],
            json!({"type": "ephemeral", "ttl": "1h"})
        );

        // Tail: last block of the last message (the tool result).
        let last_message = body["messages"]
            .as_array()
            .expect("messages array")
            .last()
            .expect("última mensagem");
        let last_block = last_message["content"]
            .as_array()
            .expect("content blocks")
            .last()
            .expect("último bloco");
        assert_eq!(last_block["type"], json!("tool_result"));
        assert_eq!(
            last_block["cache_control"],
            json!({"type": "ephemeral", "ttl": "1h"})
        );

        // Only cache metadata changed: stripping it (and the documented
        // system string→block shape) gives the exact pre-apply body.
        assert_eq!(
            strip_anthropic_plan(&body),
            before,
            "apply não pode alterar texto/ordem do prompt"
        );
    }

    #[test]
    fn apply_anthropic_is_idempotent() {
        let plan = anthropic_plan(Some("1h"));
        let mut body = anthropic_body();
        apply(WireProtocol::Anthropic, Some(&plan), &mut body);
        let once = body.clone();
        apply(WireProtocol::Anthropic, Some(&plan), &mut body);
        assert_eq!(body, once, "segunda aplicação não muda o body");
        assert_eq!(count_cache_controls(&body), 3, "sem slots duplicados");
    }

    #[test]
    fn apply_anthropic_uses_the_planned_ttl_or_omits_it() {
        // 5m option.
        let mut five_minutes = anthropic_body();
        apply(
            WireProtocol::Anthropic,
            Some(&anthropic_plan(Some("5m"))),
            &mut five_minutes,
        );
        assert_eq!(
            five_minutes["system"][0]["cache_control"]["ttl"],
            json!("5m")
        );

        // Gateway fallback: plan without TTL → `{"type":"ephemeral"}` only.
        let mut no_ttl = anthropic_body();
        apply(
            WireProtocol::Anthropic,
            Some(&anthropic_plan(None)),
            &mut no_ttl,
        );
        assert_eq!(
            no_ttl["system"][0]["cache_control"],
            json!({"type": "ephemeral"}),
            "TTL é opcional (fallback de gateway)"
        );
        assert!(no_ttl["system"][0]["cache_control"].get("ttl").is_none());
        assert!(no_ttl["tools"][0]["cache_control"].get("ttl").is_none());
    }

    #[test]
    fn apply_anthropic_never_exceeds_four_breakpoints() {
        let mut plan = anthropic_plan(Some("1h"));
        plan.breakpoints.push(CacheBreakpoint {
            target: CacheBreakpointTarget::Message(0),
            ttl: None,
        });
        plan.breakpoints.push(CacheBreakpoint {
            target: CacheBreakpointTarget::Message(1),
            ttl: None,
        });
        let mut body = anthropic_body();
        apply(WireProtocol::Anthropic, Some(&plan), &mut body);
        assert_eq!(count_cache_controls(&body), MAX_ANTHROPIC_BREAKPOINTS);
    }

    #[test]
    fn apply_anthropic_skips_thinking_blocks_on_the_tail() {
        let mut body = anthropic_body();
        body["messages"] = json!([{
            "role": "assistant",
            "content": [
                {"type": "text", "text": "resposta"},
                {"type": "thinking", "thinking": "…", "signature": "sig"},
            ],
        }]);
        apply(
            WireProtocol::Anthropic,
            Some(&anthropic_plan(None)),
            &mut body,
        );
        // The tail breakpoint goes to the text block, never to thinking.
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert!(body["messages"][0]["content"][1]
            .get("cache_control")
            .is_none());
    }

    #[test]
    fn apply_openai_inserts_key_and_retention_without_touching_the_prompt() {
        let before = openai_chat_body();
        let digest_before = digest(WireProtocol::OpenaiChat, "openai", &before);
        let key = "a".repeat(64);
        let plan = CachePlan {
            mode: CacheMode::Auto,
            breakpoints: Vec::new(),
            prompt_cache_key: Some(key.clone()),
            retention: Some("24h".to_string()),
            ttl: None,
        };
        let mut body = before.clone();
        apply(WireProtocol::OpenaiChat, Some(&plan), &mut body);

        assert_eq!(body["prompt_cache_key"], json!(key));
        assert_eq!(body["prompt_cache_retention"], json!("24h"));

        // The prompt bytes are untouched: removing the two new top-level keys
        // restores the pre-apply body...
        let mut stripped = body.clone();
        let object = stripped.as_object_mut().expect("objeto");
        object.remove("prompt_cache_key");
        object.remove("prompt_cache_retention");
        assert_eq!(stripped, before);

        // ...and the digest ignores cache metadata by contract.
        let digest_after = digest(WireProtocol::OpenaiChat, "openai", &body);
        assert_eq!(digest_after.segments, digest_before.segments);
        assert_eq!(digest_after.total_chars, digest_before.total_chars);
    }

    #[test]
    fn apply_google_is_a_noop_and_has_no_plan() {
        let model = catalog_model("opencode-go", "gemini-4-argon-contributor");
        let request = catalog_request(
            WireProtocol::Google,
            "opencode-go",
            "gemini-4-argon-contributor",
        );
        assert!(
            plan(WireProtocol::Google, "opencode-go", &model, &request).is_none(),
            "Gemini no caminho generateContent só tem cache implícito"
        );

        let before = google_body();
        let plan = anthropic_plan(Some("1h"));
        let mut body = before.clone();
        apply(WireProtocol::Google, Some(&plan), &mut body);
        assert_eq!(body, before);
    }

    #[test]
    fn apply_without_a_plan_is_a_noop_for_every_protocol() {
        for (protocol, mut body) in [
            (WireProtocol::Anthropic, anthropic_body()),
            (WireProtocol::OpenaiChat, openai_chat_body()),
            (WireProtocol::OpenaiResponses, openai_responses_body()),
            (WireProtocol::Google, google_body()),
        ] {
            let before = body.clone();
            apply(protocol, None, &mut body);
            assert_eq!(body, before, "{}", protocol.as_str());
        }
    }

    #[test]
    fn normalize_covers_every_protocol_dispatch() {
        // Regression guard: a new WireProtocol variant must not silently fall
        // into the OpenAI normalization.
        for (protocol, usage) in [
            (
                WireProtocol::Anthropic,
                json!({"input_tokens": 1, "cache_read_input_tokens": 2}),
            ),
            (
                WireProtocol::OpenaiChat,
                json!({"prompt_tokens": 1, "prompt_tokens_details": {"cached_tokens": 2}}),
            ),
            (
                WireProtocol::OpenaiResponses,
                json!({"input_tokens": 1, "input_tokens_details": {"cached_tokens": 2}}),
            ),
            (
                WireProtocol::Google,
                json!({"promptTokenCount": 1, "cachedContentTokenCount": 2}),
            ),
        ] {
            let cache = normalize_usage(protocol, "provider", &usage);
            assert!(
                cache.reported,
                "{} deveria reportar cache",
                protocol.as_str()
            );
            assert_eq!(
                cache.cache_read_tokens,
                Some(2),
                "{} normalização divergente",
                protocol.as_str()
            );
        }
    }

    /* ---------------- live gateway probe (F4.0) --------------------- */

    /// Deterministic filler for the stable prefix (~chars/4 estimated tokens).
    fn stable_filler(chars: usize) -> String {
        const BASE: &str = "Contexto estavel do workspace: os arquivos src/lib.rs e src/main.rs \
             descrevem utilitarios, testes deterministicos e convencoes do projeto Zylara. ";
        let mut text = String::with_capacity(chars);
        while text.chars().count() < chars {
            text.push_str(BASE);
        }
        text
    }

    /// OpenCode gateway credential: `OPENCODE_API_KEY` first, then the local
    /// `~/.local/share/opencode/auth.json` (`opencode-go`/`opencode-zen`, api
    /// entries). Never logged.
    fn opencode_live_key() -> Option<String> {
        if let Ok(key) = std::env::var("OPENCODE_API_KEY") {
            if !key.trim().is_empty() {
                return Some(key.trim().to_string());
            }
        }
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok()?;
        let path = std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json");
        let raw = std::fs::read_to_string(path).ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;
        for provider_id in ["opencode-go", "opencode-zen"] {
            let Some(entry) = parsed.get(provider_id) else {
                continue;
            };
            // OAuth entries carry tokens, not a `key`; only api entries are used.
            if entry
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "api")
            {
                continue;
            }
            if let Some(key) = entry.get("key").and_then(Value::as_str) {
                if !key.trim().is_empty() {
                    return Some(key.trim().to_string());
                }
            }
        }
        None
    }

    /// Neutral request shaped exactly like the harness sends it: stable session
    /// id, catalog config, big stable system prefix, no tools (as per F4.0).
    fn live_request(
        provider: &ProviderInfo,
        model: &ModelInfo,
        api_key: &str,
        filler: &str,
    ) -> CompletionRequest {
        CompletionRequest {
            config: super::super::ProviderConfig {
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                api_key: api_key.to_string(),
                auth_header: provider.auth_header.clone(),
                auth_prefix: provider.auth_prefix.clone(),
                model: model.clone(),
                session_id: format!("zylara-live-cache-{}", uuid::Uuid::new_v4()),
                user_agent: concat!("Zylara/", env!("CARGO_PKG_VERSION")).to_string(),
                endpoints: provider.endpoints.clone(),
                request_profile: provider.request_profile(crate::catalog::ProviderAuth::ApiKey),
                auth_mode: crate::catalog::ProviderAuth::ApiKey,
                extra_headers: provider.static_headers(),
            },
            protocols: vec![WireProtocol::Anthropic],
            history: vec![super::super::HistoryMessage::user("Responda apenas: ok")],
            system_prompt: format!("Você é o Zylara, um agente de código. {filler}"),
            tools: Vec::new(),
            reasoning: super::super::ReasoningRequest::Auto,
            max_output_tokens: Some(64),
            temperature: None,
            cache_plan: None,
            timeouts: crate::providers::StreamTimeouts::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
        }
    }

    /// Drive the **real adapter path** (stream_completion → build_body →
    /// cache::apply → HTTP/SSE) and return `(usage, assistant_text, digest)`.
    async fn collect_live_stream(
        request: CompletionRequest,
    ) -> anyhow::Result<(UsageInfo, String, Option<PrefixDigest>)> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(180))
            .build()?;
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        let task =
            tokio::spawn(
                async move { super::super::stream_completion(&http, request, sink).await },
            );
        let mut usage: Option<UsageInfo> = None;
        let mut text = String::new();
        let mut digest: Option<PrefixDigest> = None;
        while let Some(event) = events.recv().await {
            match event {
                super::super::ProviderEvent::Usage(value) => usage = Some(value),
                super::super::ProviderEvent::TextDelta(delta) => text.push_str(&delta),
                super::super::ProviderEvent::CacheDigest(value) => digest = Some(value),
                _ => {}
            }
        }
        let outcome = task.await.expect("stream task panicked");
        outcome?;
        let usage = usage.ok_or_else(|| anyhow::anyhow!("provedor não reportou usage"))?;
        Ok((usage, text, digest))
    }

    /// Usage-only convenience wrapper (single-request probes).
    async fn collect_live_usage(request: CompletionRequest) -> anyhow::Result<UsageInfo> {
        Ok(collect_live_stream(request).await?.0)
    }

    /// Catalog-only check (no network): the probed OpenCode gateway declares
    /// `explicit`, `minTokens: 2048`, `ttlOptions: ["1h"]`, and the Zylara path
    /// (`capabilities_for` → `plan_with_caps`) produces a plan for Anthropic.
    #[test]
    fn catalog_gateway_anthropic_plans_explicit_cache_with_one_hour_ttl() {
        let catalog = CatalogFile::load().expect("catalog.json carrega");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "claude-haiku-5-5")
            .expect("claude-haiku-5-5");
        assert!(
            model
                .protocols
                .iter()
                .any(|protocol| protocol == "anthropic"),
            "claude-haiku-5-5 deve falar anthropic"
        );

        let caps = capabilities_for(WireProtocol::Anthropic, provider, model);
        assert_eq!(caps.mode, CacheMode::Explicit);
        assert_eq!(caps.min_tokens, Some(2_048), "minTokens do probe");
        assert!(caps.ttl_options.contains(&"1h"), "TTL do probe");
        assert!(caps.supports_explicit_breakpoints);
        assert!(caps.reports_read && caps.reports_write);

        // ~3.000 estimated tokens: comfortably above the 2.048 minimum.
        let request = live_request(provider, model, "test-key", &stable_filler(12_000));
        let plan = plan_with_caps(
            WireProtocol::Anthropic,
            &caps,
            &request,
            &CacheSettings::default(),
        )
        .expect("gateway anthropic deve planejar (mínimo satisfeito)");
        assert_eq!(plan.mode, CacheMode::Explicit);
        assert_eq!(plan.ttl.as_deref(), Some("1h"), "TTL default 1h");
        assert!(plan.breakpoints.len() <= MAX_ANTHROPIC_BREAKPOINTS);
        assert!(plan
            .breakpoints
            .iter()
            .any(|breakpoint| breakpoint.target == CacheBreakpointTarget::System));
        assert!(plan
            .breakpoints
            .iter()
            .any(|breakpoint| breakpoint.target == CacheBreakpointTarget::Tail));
        assert!(plan.prompt_cache_key.is_none());
    }

    /// The gateway catalog is `explicit` for every route, but the OpenAI
    /// lowering only plans `auto` routes: no key is invented for openai-chat.
    #[test]
    fn catalog_gateway_openai_chat_does_not_plan_a_key() {
        let catalog = CatalogFile::load().expect("catalog.json carrega");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "deepseek-v4-pro")
            .expect("deepseek-v4-pro");
        assert!(model
            .protocols
            .iter()
            .any(|protocol| protocol == "openai-chat"));

        let caps = capabilities_for(WireProtocol::OpenaiChat, provider, model);
        assert_eq!(
            caps.mode,
            CacheMode::Explicit,
            "catálogo do gateway é explicit (probe)"
        );
        let request = live_request(provider, model, "test-key", &stable_filler(12_000));
        assert!(
            plan_with_caps(
                WireProtocol::OpenaiChat,
                &caps,
                &request,
                &CacheSettings::default()
            )
            .is_none(),
            "modo explicit não planeja prompt_cache_key"
        );
    }

    /// Live proof of the full Zylara path against the OpenCode gateway:
    /// `capabilities_for` → `plan_with_caps` → `CompletionRequest.cache_plan` →
    /// adapter `cache::apply` → 1st request writes, 2nd request reads.
    ///
    /// Needs the local OpenCode credential (`OPENCODE_API_KEY` or
    /// `~/.local/share/opencode/auth.json`); skips otherwise. Run with:
    ///
    /// ```text
    /// cd src-tauri
    /// cargo test --lib live_cache_gateway -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "live OpenCode gateway cache probe (needs OPENCODE_API_KEY or ~/.local/share/opencode/auth.json)"]
    async fn live_cache_gateway_anthropic_roundtrip() {
        let Some(api_key) = opencode_live_key() else {
            eprintln!(
                "SKIP live_cache_gateway_anthropic_roundtrip: sem credencial OpenCode \
                 (OPENCODE_API_KEY ou ~/.local/share/opencode/auth.json)"
            );
            return;
        };
        let catalog = CatalogFile::load().expect("catalog.json carrega");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "claude-haiku-5-5")
            .expect("claude-haiku-5-5");

        // Unique stable prefix for this run: a previous probe cannot be reused,
        // but both requests below share the exact same bytes.
        let nonce = uuid::Uuid::new_v4().to_string();
        let filler = format!("Sessão de probe {nonce}. {}", stable_filler(12_000));
        let mut request = live_request(provider, model, &api_key, &filler);

        let caps = capabilities_for(WireProtocol::Anthropic, provider, model);
        let plan = plan_with_caps(
            WireProtocol::Anthropic,
            &caps,
            &request,
            &CacheSettings::default(),
        )
        .expect("gateway anthropic deve planejar (min 2048/TTL 1h)");
        eprintln!(
            "[live_cache_gateway] caps mode={:?} min={:?} ttl={:?} plan ttl={:?} breakpoints={}",
            caps.mode,
            caps.min_tokens,
            caps.ttl_options,
            plan.ttl,
            plan.breakpoints.len()
        );
        request.cache_plan = Some(plan);

        let first = collect_live_usage(request.clone())
            .await
            .expect("1ª request ao gateway");
        let second = collect_live_usage(request)
            .await
            .expect("2ª request ao gateway");
        eprintln!(
            "[live_cache_gateway] 1ª: reported={} read={:?} write={:?} input={:?}",
            first.cache_reported,
            first.cache_read_tokens,
            first.cache_write_tokens,
            first.input_tokens
        );
        eprintln!(
            "[live_cache_gateway] 2ª: reported={} read={:?} write={:?} input={:?}",
            second.cache_reported,
            second.cache_read_tokens,
            second.cache_write_tokens,
            second.input_tokens
        );
        let first_cache = first.cache_usage();
        let second_cache = second.cache_usage();
        eprintln!(
            "[live_cache_gateway] totais: 1ª input_total={:?}; 2ª input_total={:?}",
            first_cache.input_total_tokens, second_cache.input_total_tokens
        );
        if let (Some(read), Some(total)) = (
            second_cache.cache_read_tokens,
            second_cache.input_total_tokens,
        ) {
            if total > 0 {
                eprintln!(
                    "[live_cache_gateway] 2ª hit = {:.2}% ({read}/{total})",
                    read as f64 / total as f64 * 100.0
                );
            }
        }

        assert!(first.cache_reported, "1ª request sem report de cache");
        let written = first.cache_write_tokens.unwrap_or(0);
        assert!(
            written > 0,
            "1ª request deveria escrever cache (cache_write_tokens={written})"
        );
        assert!(second.cache_reported, "2ª request sem report de cache");
        let read = second.cache_read_tokens.unwrap_or(0);
        assert!(
            read > 0,
            "2ª request deveria ler cache (cache_read_tokens={read})"
        );
    }

    /* ------------------ live 10-request bench (F6.1) ----------------- */

    #[derive(Debug)]
    struct BenchTurn {
        turn: usize,
        input_total: u32,
        read: u32,
        reported: bool,
        hit_percent: Option<f64>,
        ceiling_percent: f64,
    }

    /// ~100 estimated tokens of new user content (chars/4), asking for a very
    /// short answer so `Δ` stays small and the P/(P+Δ) ceiling reaches the 98%
    /// band.
    fn bench_user_message(turn: usize, nonce: &str) -> String {
        let mut text = format!("Turno {turn} do bench {nonce}. ");
        while text.chars().count() < 400 {
            text.push_str(
                "Mantenha o contexto do workspace estável e explique em uma frase curta. ",
            );
        }
        text.push_str("Ao final, responda apenas: ok.");
        text
    }

    /// F6.1 live bench: **10 requests** on the same `session_id` with a growing
    /// history, through the real Zylara path (`capabilities_for` →
    /// `plan_with_caps` → `CompletionRequest.cache_plan` → adapter
    /// `cache::apply` → gateway).
    ///
    /// `P` is the previous request's estimated prefix (`digest.estimated_tokens`)
    /// and `Δ` is what the new turn appended; `ceiling = P/(P+Δ)`. Acceptance is
    /// tolerant: a request with `ceiling ≥ 98%` must hit ≥ 90% (target ≥ 95%,
    /// reported as WARN), and the provider may not stop reporting cache.
    ///
    /// Needs the local OpenCode credential (`OPENCODE_API_KEY` or
    /// `~/.local/share/opencode/auth.json`); skips otherwise. Run with:
    ///
    /// ```text
    /// cd src-tauri
    /// cargo test --lib live_cache_gateway_anthropic_bench -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "live OpenCode gateway cache bench (needs OPENCODE_API_KEY or ~/.local/share/opencode/auth.json)"]
    async fn live_cache_gateway_anthropic_bench() {
        const TURNS: usize = 10;
        // The stable prefix has to be large for two independent reasons:
        // (1) the plan gate uses the known minimum 2.048 *estimated* tokens
        // (chars/4), so a ~6k-char filler would produce no plan at all;
        // (2) with ~100-estimated-token turns, the estimated `P/(P+Δ)` only
        // reaches ≥98% when the stable prefix dominates (P ≳ 9k estimated
        // tokens). 36k chars ≈ 9k estimated / ~15k real tokens puts all turns
        // 3..10 inside the acceptance band. The measured (provider-reported)
        // ceiling is printed next to the estimate because chars/4 under-scales
        // Portuguese text.
        const FILLER_CHARS: usize = 36_000;

        let Some(api_key) = opencode_live_key() else {
            eprintln!(
                "SKIP live_cache_gateway_anthropic_bench: sem credencial OpenCode \
                 (OPENCODE_API_KEY ou ~/.local/share/opencode/auth.json)"
            );
            return;
        };
        let catalog = CatalogFile::load().expect("catalog.json carrega");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "claude-haiku-5-5")
            .expect("claude-haiku-5-5");
        let caps = capabilities_for(WireProtocol::Anthropic, provider, model);
        assert_eq!(caps.mode, CacheMode::Explicit);
        assert_eq!(caps.min_tokens, Some(2_048));

        let nonce = uuid::Uuid::new_v4().to_string();
        let filler = format!("Bench de cache {nonce}. {}", stable_filler(FILLER_CHARS));
        let session_id = format!("zylara-live-bench-{nonce}");

        let mut history = vec![super::super::HistoryMessage::user("Responda apenas: ok")];
        let mut turns: Vec<BenchTurn> = Vec::with_capacity(TURNS);
        let mut previous_total_est: Option<u32> = None;
        let mut previous_input_total: Option<u32> = None;
        let mut consecutive_unreported = 0usize;
        let mut max_consecutive_unreported = 0usize;

        for turn in 0..TURNS {
            let mut request = live_request(provider, model, &api_key, &filler);
            request.config.session_id = session_id.clone();
            request.history = history.clone();
            let plan = plan_with_caps(
                WireProtocol::Anthropic,
                &caps,
                &request,
                &CacheSettings::default(),
            )
            .unwrap_or_else(|| panic!("turno {}: sem plano (fixture abaixo do mínimo?)", turn + 1));
            request.cache_plan = Some(plan);

            let (usage, text, digest) = collect_live_stream(request)
                .await
                .unwrap_or_else(|error| panic!("turno {}: request falhou: {error:#}", turn + 1));
            let digest = digest.expect("digest emitido antes do HTTP");
            let total_est = digest.estimated_tokens;
            let (p_est, delta_est) = match previous_total_est {
                Some(previous) => (previous, total_est.saturating_sub(previous)),
                None => (0, total_est),
            };

            let cache = usage.cache_usage();
            let read = cache.cache_read_tokens.unwrap_or(0);
            let write = cache.cache_write_tokens.unwrap_or(0);
            let uncached = cache.uncached_input_tokens.unwrap_or(0);
            let input_total = cache
                .input_total_tokens
                .unwrap_or(read.saturating_add(write).saturating_add(uncached));
            let hit_percent = if usage.cache_reported && input_total > 0 {
                Some(read as f64 / input_total as f64 * 100.0)
            } else {
                None
            };
            let ceiling_percent = if p_est > 0 {
                p_est as f64 / (p_est + delta_est) as f64 * 100.0
            } else {
                0.0
            };
            // Secondary ceiling from provider-reported prompt sizes: the char/4
            // estimate under-scales Portuguese text, so this is the number that
            // actually bounds the measured hit%.
            let ceiling_measured = match previous_input_total {
                Some(previous) if previous > 0 => {
                    previous as f64 / input_total.max(previous) as f64 * 100.0
                }
                _ => 0.0,
            };

            eprintln!(
                "[live_cache_gateway_anthropic_bench] #{:02} P_est={:5} d_est={:4} input={:5} read={:5} write={:4} uncached={:4} hit={} ceiling_est={:6.2}% ceiling_measured={:6.2}%",
                turn + 1,
                p_est,
                delta_est,
                input_total,
                read,
                write,
                uncached,
                hit_percent.map_or_else(|| "—".to_string(), |value| format!("{value:6.2}%")),
                ceiling_percent,
                ceiling_measured
            );

            if usage.cache_reported {
                consecutive_unreported = 0;
            } else {
                consecutive_unreported += 1;
                max_consecutive_unreported = max_consecutive_unreported.max(consecutive_unreported);
            }
            turns.push(BenchTurn {
                turn: turn + 1,
                input_total,
                read,
                reported: usage.cache_reported,
                hit_percent,
                ceiling_percent,
            });
            previous_total_est = Some(total_est);
            previous_input_total = Some(input_total);

            if turn + 1 < TURNS {
                let assistant_text = if text.trim().is_empty() {
                    "ok".to_string()
                } else {
                    text.trim().to_string()
                };
                history.push(super::super::HistoryMessage::assistant(assistant_text));
                history.push(super::super::HistoryMessage::user(bench_user_message(
                    turn + 2,
                    &nonce,
                )));
            }
        }

        // ---- aggregates -------------------------------------------------
        let session_input: u64 = turns.iter().map(|turn| u64::from(turn.input_total)).sum();
        let session_read: u64 = turns.iter().map(|turn| u64::from(turn.read)).sum();
        let session_hit = if session_input > 0 {
            session_read as f64 / session_input as f64 * 100.0
        } else {
            0.0
        };
        let steady: Vec<&BenchTurn> = turns
            .iter()
            .filter(|turn| turn.turn >= 3 && turn.ceiling_percent >= 98.0 && turn.reported)
            .collect();
        let steady_input: u64 = steady.iter().map(|turn| u64::from(turn.input_total)).sum();
        let steady_read: u64 = steady.iter().map(|turn| u64::from(turn.read)).sum();
        let steady_hit = if steady_input > 0 {
            steady_read as f64 / steady_input as f64 * 100.0
        } else {
            0.0
        };
        eprintln!(
            "[live_cache_gateway_anthropic_bench] session: read={session_read} input={session_input} hit={session_hit:.2}%"
        );
        eprintln!(
            "[live_cache_gateway_anthropic_bench] steady (turn>=3 & ceiling>=98%): requests={} read={steady_read} input={steady_input} hit={steady_hit:.2}%",
            steady.len()
        );
        if steady.is_empty() {
            eprintln!(
                "[live_cache_gateway_anthropic_bench] nota: nenhum request na faixa ceiling>=98% (Δ alto vs P); números reais publicados, sem forçar"
            );
        }

        // ---- tolerant acceptance (no flaky hard assert) -----------------
        assert_eq!(
            turns.len(),
            TURNS,
            "bench precisa completar os {TURNS} requests"
        );
        assert!(
            max_consecutive_unreported < 2,
            "gateway parou de reportar cache em {max_consecutive_unreported} requests consecutivos"
        );
        for turn in turns
            .iter()
            .filter(|turn| turn.turn >= 3 && turn.ceiling_percent >= 98.0)
        {
            let Some(hit) = turn.hit_percent else {
                continue;
            };
            assert!(
                hit >= 90.0,
                "turno {}: ceiling {:.2}% mas hit {:.2}% < 90%",
                turn.turn,
                turn.ceiling_percent,
                hit
            );
            if hit < 95.0 {
                eprintln!(
                    "[live_cache_gateway_anthropic_bench] WARN turno {}: hit {:.2}% >= 90% mas abaixo da meta 95% (ceiling {:.2}%)",
                    turn.turn, hit, turn.ceiling_percent
                );
            }
        }
    }
}
