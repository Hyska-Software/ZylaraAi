//! Provider-native context compaction lanes.
//!
//! Two routes expose server-side compaction that this harness can persist and
//! replay:
//!
//! - OpenAI Responses `POST /responses/compact` (API-key profile only) returns a
//!   replacement window whose `compaction` item is opaque and replayable only on
//!   the same provider/model.
//! - Anthropic Messages on-demand compaction (`compact-2026-09-04`) returns a
//!   signed `compaction` block with readable summary text; the text is portable
//!   to another model, the block is not.
//!
//! Gateways (OpenCode Go/Zen) and custom providers stay on the local summarizer:
//! their contract for the provider betas is not documented.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::catalog::{ModelInfo, ProviderInfo, RequestProfile};
use crate::harness::HarnessDeps;
use crate::providers::{
    add_header, endpoint, post_json, CompletionRequest, HistoryMessage, ProviderError, WireProtocol,
};

/// Anthropic beta header for on-demand compaction.
pub const ANTHROPIC_COMPACTION_BETA: &str = "compact-2026-09-04";
/// OpenAI Responses standalone compaction path, appended to `provider.baseUrl`.
pub const OPENAI_COMPACT_PATH: &str = "responses/compact";
/// Server-side compaction may summarize for minutes on large windows.
pub const NATIVE_COMPACTION_TIMEOUT: Duration = Duration::from_secs(300);
/// A native payload larger than this is refused; persistence falls back local.
pub const NATIVE_PAYLOAD_MAX_BYTES: usize = 2_000_000;

/// Anthropic model lines documented for on-demand compaction.
const ANTHROPIC_COMPACTION_MODELS: &[&str] = &[
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeLane {
    OpenAiResponses,
    AnthropicOnDemand,
}

impl NativeLane {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiResponses => "openai-responses",
            Self::AnthropicOnDemand => "anthropic",
        }
    }
}

#[derive(Debug, Clone)]
pub struct NativeCompaction {
    /// OpenAI: `{"output":[...]}`. Anthropic: `{"role":"assistant","content":[block]}`.
    pub payload: Value,
    /// Anthropic summary text; `None` for OpenAI (the item is opaque).
    pub text: Option<String>,
}

/// Whether a model line supports Anthropic on-demand compaction.
pub fn anthropic_model_supports_compaction(model_id: &str) -> bool {
    ANTHROPIC_COMPACTION_MODELS.iter().any(|prefix| {
        model_id == *prefix
            || model_id
                .strip_prefix(prefix)
                .is_some_and(|suffix| suffix.starts_with('-'))
    })
}

/// Pick a native lane for the route, or `None` for the local summarizer.
pub fn native_lane(
    provider: &ProviderInfo,
    model: &ModelInfo,
    protocols: &[WireProtocol],
    profile: RequestProfile,
) -> Option<NativeLane> {
    match (provider.id.as_str(), protocols.first().copied(), profile) {
        (
            "openai",
            Some(WireProtocol::OpenaiResponses),
            RequestProfile::Standard,
        ) => Some(NativeLane::OpenAiResponses),
        ("anthropic", Some(WireProtocol::Anthropic), _)
            if anthropic_model_supports_compaction(&model.id) =>
        {
            Some(NativeLane::AnthropicOnDemand)
        }
        _ => None,
    }
}

/// History head for a native payload. The adapters already replay assistant
/// `provider_state`: `openai_responses::append_assistant` reads `output`, and
/// `anthropic::assistant_blocks` reads `content`.
pub fn head_message(native: &NativeCompaction) -> HistoryMessage {
    let mut head = HistoryMessage::assistant(native.text.clone().unwrap_or_default());
    head.provider_state = Some(native.payload.clone());
    head
}

/// Run the provider-native compaction call for a request whose history is the
/// prefix being summarized (`history[..cut]`).
pub async fn compact(
    deps: &HarnessDeps,
    lane: NativeLane,
    request: &CompletionRequest,
) -> anyhow::Result<NativeCompaction> {
    let native = match lane {
        NativeLane::OpenAiResponses => {
            let url = endpoint(&request.config.base_url, OPENAI_COMPACT_PATH);
            let body = crate::providers::openai_responses::compact_body(request);
            let value = post_json(
                &deps.http,
                &request.config,
                &url,
                &body,
                NATIVE_COMPACTION_TIMEOUT,
                &request.cancel,
            )
            .await?;
            let payload = crate::providers::openai_responses::parse_compact_response(&value)?;
            NativeCompaction {
                payload,
                text: None,
            }
        }
        NativeLane::AnthropicOnDemand => {
            let url = request
                .config
                .endpoint_for(WireProtocol::Anthropic)
                .map_err(|error| anyhow::anyhow!("{error}"))?;
            let mut config = request.config.clone();
            add_header(&mut config, "anthropic-beta", ANTHROPIC_COMPACTION_BETA);
            let mut body = crate::providers::anthropic::compaction_body(request);
            crate::providers::cache::apply(
                WireProtocol::Anthropic,
                request.cache_plan.as_ref(),
                &mut body,
            );
            let value = post_json(
                &deps.http,
                &config,
                &url,
                &body,
                NATIVE_COMPACTION_TIMEOUT,
                &request.cancel,
            )
            .await?;
            let (payload, text) =
                crate::providers::anthropic::parse_compaction_response(&value)?;
            NativeCompaction {
                payload,
                text: Some(text),
            }
        }
    };
    let serialized = serde_json::to_string(&native.payload)?;
    if serialized.len() > NATIVE_PAYLOAD_MAX_BYTES {
        anyhow::bail!(
            "native compaction payload is too large to persist ({} bytes)",
            serialized.len()
        );
    }
    Ok(native)
}

/// Process-local negative cache: a route that rejected the lane once does not pay
/// another failed request at every threshold crossing.
static DISABLED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn disabled() -> &'static Mutex<HashSet<String>> {
    &DISABLED
}

fn key(lane: NativeLane, provider_id: &str, model_id: &str) -> String {
    format!("{}:{provider_id}:{model_id}", lane.as_str())
}

pub fn is_disabled(lane: NativeLane, provider_id: &str, model_id: &str) -> bool {
    disabled()
        .lock()
        .map(|set| set.contains(&key(lane, provider_id, model_id)))
        .unwrap_or(false)
}

pub fn mark_disabled(lane: NativeLane, provider_id: &str, model_id: &str) {
    if let Ok(mut set) = disabled().lock() {
        set.insert(key(lane, provider_id, model_id));
    }
}

/// Only capability/route failures disable the lane; an oversized conversation or
/// a transient failure must still be retried next time.
pub fn should_disable_after(error: &ProviderError) -> bool {
    match error {
        ProviderError::RouteNotSupported(_) | ProviderError::UnsupportedProtocol(_) => true,
        ProviderError::BadRequest(message) | ProviderError::Other(message) => {
            let lower = message.to_lowercase();
            ["not found", "unsupported", "unknown beta", "invalid beta", "404", "405"]
                .iter()
                .any(|pattern| lower.contains(pattern))
        }
        _ => false,
    }
}

#[cfg(test)]
pub fn reset_capability_cache() {
    if let Ok(mut set) = disabled().lock() {
        set.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> crate::catalog::CatalogFile {
        crate::catalog::CatalogFile::load().expect("embedded catalog")
    }

    #[test]
    fn native_lane_is_gated_to_direct_provider_routes() {
        let catalog = catalog();
        let openai = catalog.provider("openai").expect("openai");
        let anthropic = catalog.provider("anthropic").expect("anthropic");
        let gateway = catalog.provider("opencode-go").expect("gateway");
        let responses = [WireProtocol::OpenaiResponses];
        let gpt = catalog.model("openai", "gpt-6-luna").expect("gpt model");
        assert_eq!(
            native_lane(openai, gpt, &responses, RequestProfile::Standard),
            Some(NativeLane::OpenAiResponses)
        );
        assert_eq!(
            native_lane(openai, gpt, &responses, RequestProfile::ChatgptPlan),
            None
        );
        let haiku = catalog
            .model("anthropic", "claude-haiku-5-5")
            .expect("haiku 5.5");
        assert_eq!(
            native_lane(
                anthropic,
                haiku,
                &[WireProtocol::Anthropic],
                RequestProfile::Standard
            ),
            Some(NativeLane::AnthropicOnDemand)
        );
        let old_opus = catalog
            .model("anthropic", "claude-opus-4-5")
            .expect("opus 4.5");
        assert_eq!(
            native_lane(
                anthropic,
                old_opus,
                &[WireProtocol::Anthropic],
                RequestProfile::Standard
            ),
            None
        );
        assert_eq!(
            native_lane(
                gateway,
                haiku,
                &[WireProtocol::Anthropic],
                RequestProfile::Standard
            ),
            None
        );
    }

    #[test]
    fn anthropic_allowlist_matches_the_documented_lines() {
        for id in [
            "claude-haiku-5-5",
            "claude-opus-4-6",
            "claude-opus-5-5",
            "claude-sonnet-4-6",
            "claude-fable-5-2",
        ] {
            assert!(anthropic_model_supports_compaction(id), "{id}");
        }
        for id in ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"] {
            assert!(!anthropic_model_supports_compaction(id), "{id}");
        }
    }

    #[test]
    fn capability_failures_disable_the_lane_only_once() {
        reset_capability_cache();
        assert!(!is_disabled(
            NativeLane::AnthropicOnDemand,
            "anthropic",
            "claude-haiku-5-5"
        ));
        assert!(should_disable_after(&ProviderError::BadRequest(
            "404 not found: unknown beta flag".to_string()
        )));
        mark_disabled(
            NativeLane::AnthropicOnDemand,
            "anthropic",
            "claude-haiku-5-5",
        );
        assert!(is_disabled(
            NativeLane::AnthropicOnDemand,
            "anthropic",
            "claude-haiku-5-5"
        ));
        assert!(!should_disable_after(&ProviderError::RateLimited {
            message: "slow down".to_string(),
            retry_after: None,
        }));
        reset_capability_cache();
    }
}
