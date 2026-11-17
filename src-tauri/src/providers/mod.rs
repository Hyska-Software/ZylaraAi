//! Provider layer: one neutral request model, four wire protocols.
//!
//! Adapters (`openai_chat`, `openai_responses`, `anthropic`, `google`) translate
//! the neutral request below into the provider wire format, stream SSE events
//! and emit `ProviderEvent`s. `stream_completion` is responsible for protocol
//! fallback (the OpenCode gateway answers `ModelProtocolUnsupported` when a
//! model does not accept the requested protocol).

pub mod anthropic;
pub mod cache;
pub mod custom;
pub mod google;
pub mod openai_chat;
pub mod openai_responses;
pub mod reasoning;
pub mod retry;
pub mod sse;

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::catalog::{ModelInfo, ProviderAuth, RequestProfile};
use crate::domain::UsageInfo;

pub use retry::RetryClass;

/* ------------------------------------------------------------------ */
/* Protocol                                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WireProtocol {
    OpenaiChat,
    OpenaiResponses,
    Anthropic,
    Google,
}

impl WireProtocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenaiChat => "openai-chat",
            Self::OpenaiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
            Self::Google => "google",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "openai-chat" => Some(Self::OpenaiChat),
            "openai-responses" => Some(Self::OpenaiResponses),
            "anthropic" => Some(Self::Anthropic),
            "google" => Some(Self::Google),
            _ => None,
        }
    }
}

/* ------------------------------------------------------------------ */
/* Neutral conversation model                                          */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone)]
pub struct ImagePart {
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Debug, Clone)]
pub struct HistoryToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct HistoryMessage {
    pub role: HistoryRole,
    pub text: String,
    pub images: Vec<ImagePart>,
    pub reasoning: Option<String>,
    /// Anthropic thinking signature (replayed to keep extended thinking valid).
    pub reasoning_signature: Option<String>,
    pub tool_calls: Vec<HistoryToolCall>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    /// Verbatim provider payload from the previous assistant turn.
    pub provider_state: Option<Value>,
}

impl HistoryMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: HistoryRole::System,
            text: text.into(),
            images: Vec::new(),
            reasoning: None,
            reasoning_signature: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            provider_state: None,
        }
    }

    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: HistoryRole::User,
            text: text.into(),
            images: Vec::new(),
            reasoning: None,
            reasoning_signature: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            provider_state: None,
        }
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: HistoryRole::Assistant,
            text: text.into(),
            images: Vec::new(),
            reasoning: None,
            reasoning_signature: None,
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
            provider_state: None,
        }
    }

    pub fn tool_result(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            role: HistoryRole::Tool,
            text: content.into(),
            images: Vec::new(),
            reasoning: None,
            reasoning_signature: None,
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            tool_name: Some(tool_name.into()),
            provider_state: None,
        }
    }
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub provider_id: String,
    pub provider_name: String,
    /// Base URL from the catalog (`provider.baseUrl`) — endpoints are paths.
    pub base_url: String,
    /// Bearer credential: API key **or** OAuth access token for the plan path.
    pub api_key: String,
    /// Header that carries the credential (`authorization` by default).
    pub auth_header: String,
    /// Prefix before the credential in that header (`Bearer ` by default).
    pub auth_prefix: String,
    pub model: ModelInfo,
    /// Stable id sent as `x-opencode-session` for routing / prompt caching.
    /// Only OpenCode gateway providers receive it.
    pub session_id: String,
    pub user_agent: String,
    /// Catalog `provider.endpoints`: wire protocol id -> path template. It is
    /// authoritative for every protocol (`google` carries a `{model}`
    /// placeholder); there are no hardcoded protocol paths in the adapters.
    pub endpoints: HashMap<String, String>,
    /// Group of request-shape constraints used for the body (`standard` keeps
    /// the full neutral request, `chatgpt-plan` applies the OpenAI plan rules).
    pub request_profile: RequestProfile,
    /// Credential mode the request is being built with (`api-key` or `oauth`).
    pub auth_mode: ProviderAuth,
    /// Provider-specific extra headers appended to the transport headers.
    pub extra_headers: Vec<(String, String)>,
}

impl ProviderConfig {
    /// True for providers hosted on the OpenCode gateway (Go/Zen).
    pub fn is_opencode(&self) -> bool {
        self.provider_id.starts_with("opencode")
    }

    /// Resolve the full URL of a wire protocol from the catalog `endpoints`.
    ///
    /// The Google endpoint declares a `{model}` placeholder and needs the
    /// `:streamGenerateContent?alt=sse` suffix; the other protocols are plain
    /// paths appended to `base_url`.
    pub fn endpoint_for(&self, protocol: WireProtocol) -> ProviderResult<String> {
        let template = self.endpoints.get(protocol.as_str()).ok_or_else(|| {
            ProviderError::Other(format!(
                "provedor {} não declara endpoint para o protocolo {}",
                self.provider_id,
                protocol.as_str()
            ))
        })?;
        let mut path = template.clone();
        if matches!(protocol, WireProtocol::Google) {
            path = path.replace("{model}", &self.model.id);
            path.push_str(":streamGenerateContent?alt=sse");
        }
        Ok(endpoint(&self.base_url, &path))
    }

    /// Transport headers shared by every wire adapter.
    ///
    /// `x-opencode-session` is only sent to OpenCode gateway providers: direct
    /// providers (OpenAI) must not receive gateway-internal routing headers.
    pub(crate) fn headers(&self) -> Vec<(String, String)> {
        let mut headers: Vec<(String, String)> = Vec::new();
        if !self.api_key.is_empty() {
            let name = if self.auth_header.trim().is_empty() {
                "authorization"
            } else {
                self.auth_header.trim()
            };
            headers.push((
                name.to_ascii_lowercase(),
                format!("{}{}", self.auth_prefix, self.api_key),
            ));
        }
        if self.is_opencode() && !self.session_id.is_empty() {
            headers.push(("x-opencode-session".to_string(), self.session_id.clone()));
        }
        if !self.user_agent.is_empty() {
            headers.push(("user-agent".to_string(), self.user_agent.clone()));
        }
        for (name, value) in &self.extra_headers {
            headers.push((name.clone(), value.clone()));
        }
        headers
    }
}

#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub enum ReasoningRequest {
    /// Let the provider default decide (no explicit parameter).
    Auto,
    Off,
    Effort(String),
    Budget(u32),
}

impl ReasoningRequest {
    pub fn is_auto(&self) -> bool {
        matches!(self, Self::Auto)
    }

    /// Thinking explicitly disabled for this request.
    pub fn is_off(&self) -> bool {
        matches!(self, Self::Off)
    }
}

/// Deadline that expired while waiting for one provider request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutPhase {
    /// Connection opened but the response headers never arrived.
    Headers,
    /// Headers arrived but the first SSE event with data never did.
    FirstEvent,
    /// The stream went silent after it started.
    Idle,
    /// The absolute stream deadline configured for the request expired.
    Total,
}

impl TimeoutPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Headers => "headers",
            Self::FirstEvent => "first event",
            Self::Idle => "idle",
            Self::Total => "total",
        }
    }
}

/// Per-request deadlines applied to every provider protocol.
///
/// `connect_timeout` stays on the shared HTTP client (20 s): the client is also
/// used by web tools, and reqwest only accepts a connect timeout when the
/// client is built. Everything else is enforced per request here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamTimeouts {
    pub headers: Duration,
    pub first_event: Duration,
    pub idle: Duration,
    /// `None` disables the absolute stream cap.
    pub total: Option<Duration>,
}

impl Default for StreamTimeouts {
    fn default() -> Self {
        Self {
            headers: Duration::from_secs(120),
            first_event: Duration::from_secs(180),
            idle: Duration::from_secs(120),
            total: Some(Duration::from_secs(1_800)),
        }
    }
}

impl StreamTimeouts {
    pub fn from_settings(settings: &crate::domain::Settings) -> Self {
        Self {
            headers: Duration::from_secs(u64::from(settings.provider_headers_timeout_secs)),
            first_event: Duration::from_secs(u64::from(
                settings.provider_first_event_timeout_secs,
            )),
            idle: Duration::from_secs(u64::from(settings.provider_idle_timeout_secs)),
            total: (settings.provider_total_timeout_secs > 0)
                .then(|| Duration::from_secs(u64::from(settings.provider_total_timeout_secs))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub config: ProviderConfig,
    /// Protocols to try, in order.
    pub protocols: Vec<WireProtocol>,
    pub history: Vec<HistoryMessage>,
    pub system_prompt: String,
    pub tools: Vec<ToolDefinition>,
    pub reasoning: ReasoningRequest,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    /// Explicit cache plan chosen by the harness (`providers::cache::plan`).
    ///
    /// The adapters apply it to the final wire body (`cache::apply`) right after
    /// `build_body` and before the prefix digest. `None` keeps the body exactly
    /// as it was before F4; the harness owns the decision (capabilities +
    /// settings + request index), the provider layer only lowers it.
    pub cache_plan: Option<cache::CachePlan>,
    /// Deadlines for the HTTP handshake and the SSE stream.
    pub timeouts: StreamTimeouts,
    pub cancel: CancellationToken,
}

/* ------------------------------------------------------------------ */
/* Streaming events                                                    */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub enum ProviderEvent {
    ReasoningDelta(String),
    TextDelta(String),
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    ToolCallArgsDelta {
        index: usize,
        delta: String,
    },
    ToolCallDone {
        index: usize,
        arguments: String,
    },
    Usage(UsageInfo),
    /// Safe, capped excerpt of the provider `usage` JSON — numeric counters,
    /// `*_tokens_details`, cache blocks and the OpenCode gateway accounting
    /// (`cache::usage_excerpt`). Emitted once per request right after `Usage`
    /// and before `Done`; feeds `CacheSample.raw_usage` and the diagnostics
    /// "Copiar usage bruto". Never carries prompts, content, headers or ids,
    /// and is skipped when the provider sent no usage block.
    UsageRaw(Value),
    /// Canonical digest of the wire prefix of this request, emitted once per
    /// attempt right after the body is built (before the HTTP stream). The
    /// harness compares it with the previous request to detect prefix reuse and
    /// attribute breaks; only the provider layer computes it (`cache::digest`).
    CacheDigest(crate::domain::PrefixDigest),
    /// Raw assistant payload used for stateless replay in the next step.
    ProviderState(Value),
    /// End of the provider stream.
    Done,
}

pub type EventSink = tokio::sync::mpsc::UnboundedSender<ProviderEvent>;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/// Structured error payload returned by a provider.
///
/// The ChatGPT-plan route mixes two error shapes: `{"detail": "..."}`
/// (admission errors, which may arrive without an `error` object at all) and
/// `{"error": {"code": "...", "param": "...", "message": "..."}}` (structured
/// errors). Both are parsed here so classification is independent of the shape.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StructuredError {
    /// Human-readable message (the raw body when nothing structured was found).
    pub message: String,
    /// Provider `error.code` (`subscription_sharing_usage_limit_exceeded`, ...).
    pub code: Option<String>,
    /// Provider `error.param` — the request field a capability error refers to.
    pub param: Option<String>,
}

impl std::fmt::Display for StructuredError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)?;
        if let Some(code) = &self.code {
            write!(formatter, " [{code}]")?;
        }
        Ok(())
    }
}

impl StructuredError {
    /// Parse an HTTP error body: JSON when possible, raw text otherwise.
    pub fn from_body(body: &str) -> Self {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Self::default();
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => Self::from_value(&value),
            Err(_) => Self {
                message: trimmed.to_string(),
                code: None,
                param: None,
            },
        }
    }

    /// Parse an already-decoded JSON error payload. Accepts the plain
    /// `{"error": {...}}` / `{"detail": "..."}` shapes and the Responses API
    /// `{"response": {"error": {...}}}` stream wrapper.
    pub fn from_value(value: &Value) -> Self {
        let unwrapped = value
            .pointer("/response/error")
            .or_else(|| value.get("error"))
            .unwrap_or(value);
        let mut structured = Self::default();

        // `{"error": "boom"}` — the error is a plain string.
        if let Some(text) = unwrapped.as_str() {
            structured.message = text.to_string();
            return structured;
        }
        if let Some(object) = unwrapped.as_object() {
            if let Some(code) = object.get("code").and_then(Value::as_str) {
                if !code.trim().is_empty() {
                    structured.code = Some(code.to_string());
                }
            }
            if let Some(param) = object.get("param").and_then(Value::as_str) {
                if !param.trim().is_empty() {
                    structured.param = Some(param.to_string());
                }
            }
            for key in ["message", "detail"] {
                if let Some(message) = object.get(key).and_then(Value::as_str) {
                    if !message.trim().is_empty() {
                        structured.message = message.to_string();
                        break;
                    }
                }
            }
            // FastAPI-style validation errors: `detail` is an array of objects.
            if structured.message.is_empty() {
                if let Some(detail) = object.get("detail").filter(|detail| detail.is_array()) {
                    structured.message = detail.to_string();
                }
            }
            if structured.message.is_empty() {
                if let Some(kind) = object.get("type").and_then(Value::as_str) {
                    structured.message = kind.to_string();
                }
            }
        } else if let Some(detail) = value.get("detail") {
            if let Some(text) = detail.as_str() {
                structured.message = text.to_string();
            } else {
                structured.message = detail.to_string();
            }
        }
        if structured.message.is_empty() {
            structured.message = value.to_string();
        }
        structured
    }
}

/// Lowercased body fragments that mean "the input did not fit the context
/// window". Only 400/422 responses are classified: a 413 is a byte-size
/// rejection (images, payload), not a token-window overflow.
pub const CONTEXT_OVERFLOW_PATTERNS: &[&str] = &[
    "context_length_exceeded",
    "context length",
    "context window",
    "prompt is too long",
    "input is too long",
    "input token count",
    "too many tokens",
    "maximum context",
    "reduce the length",
];

/// Raw provider code for a 401 that explicitly rejects the account identity.
const CODE_INVALID_USER: &str = "subscription_sharing_invalid_user";
/// Raw provider code for "this account cannot use ChatGPT-plan usage".
const CODE_USER_NOT_ELIGIBLE: &str = "subscription_sharing_user_not_eligible";
/// Raw provider code for "the account used up the ChatGPT-plan allowance".
const CODE_USAGE_LIMIT_EXCEEDED: &str = "subscription_sharing_usage_limit_exceeded";
/// Raw provider code for "this route/method is not supported".
const CODE_ROUTE_NOT_SUPPORTED: &str = "subscription_sharing_route_not_supported";
/// Raw provider code for a request field the preview route rejects.
const CODE_UNSUPPORTED_CAPABILITY: &str = "subscription_sharing_unsupported_capability";

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("model does not support this protocol")]
    UnsupportedProtocol(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("rate limited: {message}")]
    RateLimited {
        message: String,
        retry_after: Option<Duration>,
    },
    #[error("bad request: {0}")]
    BadRequest(String),
    /// The request exceeded the model context window (400/422 with a
    /// window-overflow body). Recoverable only by compacting the history.
    #[error("context window exceeded: {0}")]
    ContextOverflow(StructuredError),
    #[error("insufficient credit: {0}")]
    InsufficientCredit(String),
    #[error("network error: {0}")]
    Network(String),
    /// A deadline expired before/while the provider responded.
    #[error("request timed out ({}): {detail}", .phase.as_str())]
    Timeout {
        phase: TimeoutPhase,
        detail: String,
    },
    /// The SSE body ended (or failed) before the protocol's terminal signal.
    #[error("stream interrupted: {0}")]
    StreamInterrupted(String),
    /// The SSE stream produced no model event before the first-event/idle
    /// deadline. Retryable when the attempt has no partial output.
    #[error("stream stalled: {0}")]
    StreamStalled(String),
    /// Provider-side failure that is safe to retry (5xx, 408, 409, 425, 429
    /// without a plan/quota code, transient in-stream error).
    #[error("upstream error: {message}")]
    Transient {
        status: Option<u16>,
        code: Option<String>,
        message: String,
        retry_after: Option<Duration>,
    },
    #[error("provider error: {0}")]
    Other(String),
    /// The harness dropped the event channel because the turn was cancelled.
    #[error("turn cancelled")]
    Cancelled,
    /// The ChatGPT-plan allowance is exhausted (429
    /// `subscription_sharing_usage_limit_exceeded`): pause plan requests and
    /// offer the "Gerenciar uso" action — never auto-retry/log in a loop.
    #[error("plan usage limit reached: {0}")]
    PlanLimit(StructuredError),
    /// The account may not use ChatGPT-plan usage (403
    /// `subscription_sharing_user_not_eligible` or `chatpass_v2_*` grants).
    #[error("plan usage is not eligible: {0}")]
    PlanNotEligible(StructuredError),
    /// The request used a field/tool/model the plan route rejects (400
    /// `subscription_sharing_unsupported_capability`) — a preview-contract
    /// change, actionable by dropping the offending field/tool.
    #[error("unsupported capability: {0}")]
    UnsupportedCapability(StructuredError),
    /// The credential was rejected by the plan route (401
    /// `subscription_sharing_invalid_user`): refresh once, then ask for login.
    #[error("authentication required: {0}")]
    AuthRequired(StructuredError),
    /// The route/method is not supported (403
    /// `subscription_sharing_route_not_supported`): use `POST
    /// /v1/responses`, not a bug in the model/tools.
    #[error("route not supported: {0}")]
    RouteNotSupported(StructuredError),
}

pub type ProviderResult<T> = Result<T, ProviderError>;

impl ProviderError {
    /// Build a typed error from an HTTP status + response body (no headers).
    pub fn from_http(status: u16, body: &str) -> Self {
        Self::from_http_with_retry_after(status, body, None)
    }

    /// Build a typed error from an HTTP status, response body and the
    /// server-requested wait (`Retry-After` family of headers).
    pub fn from_http_with_retry_after(
        status: u16,
        body: &str,
        retry_after: Option<Duration>,
    ) -> Self {
        let lower = body.to_lowercase();
        if lower.contains("modelprotocolunsupported")
            || lower.contains("does not support this protocol")
        {
            return Self::UnsupportedProtocol(body.to_string());
        }
        let structured = StructuredError::from_body(body);
        // Context-window overflow arrives as a 400/422 with a body describing
        // the input length; it needs compaction, not a generic bad-request
        // terminal failure. Checked before the status match so the specific
        // classification wins over `BadRequest`/`Other`.
        if matches!(status, 400 | 422)
            && CONTEXT_OVERFLOW_PATTERNS
                .iter()
                .any(|pattern| lower.contains(*pattern))
        {
            return Self::ContextOverflow(structured);
        }
        let code = structured.code.as_deref();
        let excerpt = error_excerpt(body);
        match status {
            // Only the known preview-contract code is a capability error. A
            // generic 400 with a structured `code` is still a bad request:
            // misclassifying it hides the real provider message and blocks the
            // cache/plan fallbacks that key off `BadRequest`.
            400 => {
                if code == Some(CODE_UNSUPPORTED_CAPABILITY) {
                    Self::UnsupportedCapability(structured)
                } else {
                    Self::BadRequest(excerpt)
                }
            }
            401 => {
                if code == Some(CODE_INVALID_USER) {
                    Self::AuthRequired(structured)
                } else {
                    Self::Unauthorized(excerpt)
                }
            }
            402 => Self::InsufficientCredit(format!("saldo/créditos insuficientes: {excerpt}")),
            403 => match code {
                Some(CODE_USER_NOT_ELIGIBLE) => Self::PlanNotEligible(structured),
                Some(CODE_ROUTE_NOT_SUPPORTED) => Self::RouteNotSupported(structured),
                // Grant/scope problems (`chatpass_v2_scope_not_authorized`,
                // `chatpass_v2_invalid_authorization_context`): the account has
                // no usable plan grant; do not silently switch billing.
                Some(code) if code.starts_with("chatpass_v2_") => Self::PlanNotEligible(structured),
                _ => Self::Unauthorized(excerpt),
            },
            429 => {
                if code == Some(CODE_USAGE_LIMIT_EXCEEDED) {
                    Self::PlanLimit(structured)
                } else {
                    Self::RateLimited {
                        message: excerpt,
                        retry_after,
                    }
                }
            }
            408 | 409 | 425 | 500..=599 => Self::Transient {
                status: Some(status),
                code: Some(code.unwrap_or_default().to_string()).filter(|code| !code.is_empty()),
                message: excerpt,
                retry_after,
            },
            _ => Self::Other(excerpt),
        }
    }

    /// Classify an error object that arrived **inside** a provider stream
    /// (`response.failed` / `error` events), where no HTTP status is available.
    /// The ChatGPT-plan route can report quota failures after the stream has
    /// started, so these must map exactly like their HTTP counterparts.
    pub(crate) fn from_stream_error(value: &Value) -> Self {
        let structured = StructuredError::from_value(value);
        // Google reports the machine code in `error.status`
        // (`RESOURCE_EXHAUSTED`, `UNAVAILABLE`, …); other providers use
        // `error.code`.
        let stream_code = structured.code.as_deref().or_else(|| {
            value
                .pointer("/error/status")
                .or_else(|| value.get("status"))
                .and_then(Value::as_str)
                .filter(|status| !status.trim().is_empty())
        });
        match stream_code {
            Some(CODE_USAGE_LIMIT_EXCEEDED) | Some("insufficient_quota") => {
                Self::PlanLimit(structured)
            }
            Some(CODE_USER_NOT_ELIGIBLE) => Self::PlanNotEligible(structured),
            Some(CODE_INVALID_USER) => Self::AuthRequired(structured),
            Some(CODE_UNSUPPORTED_CAPABILITY) => Self::UnsupportedCapability(structured),
            Some(CODE_ROUTE_NOT_SUPPORTED) => Self::RouteNotSupported(structured),
            Some(code) if is_transient_stream_code(code) => Self::Transient {
                status: None,
                code: Some(code.to_string()),
                message: structured.message.clone(),
                retry_after: None,
            },
            _ => Self::Other(format!("resposta falhou: {value}")),
        }
    }

    /// Transport-neutral app code for `TurnEvent::Error.code` / `MessageError`.
    /// The raw provider code is available through [`Self::provider_code`] when
    /// the UI needs the exact `subscription_sharing_*` value.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Unauthorized(_) | Self::AuthRequired(_) => Some("auth_required"),
            Self::RateLimited { .. } => Some("rate_limited"),
            Self::PlanLimit(_) => Some("plan_limit"),
            Self::PlanNotEligible(_) => Some("plan_not_eligible"),
            Self::UnsupportedCapability(_) => Some("unsupported_capability"),
            Self::RouteNotSupported(_) => Some("route_not_supported"),
            Self::BadRequest(_) => Some("bad_request"),
            Self::ContextOverflow(_) => Some("context_overflow"),
            Self::InsufficientCredit(_) => Some("insufficient_credit"),
            Self::Network(_) => Some("network"),
            Self::Timeout { .. } | Self::StreamStalled(_) => Some("timeout"),
            Self::StreamInterrupted(_) => Some("stream_interrupted"),
            Self::Transient { .. } => Some("upstream_error"),
            Self::UnsupportedProtocol(_) | Self::Other(_) | Self::Cancelled => None,
        }
    }

    /// Raw `error.code` from the provider body, when present.
    pub fn provider_code(&self) -> Option<&str> {
        match self {
            Self::PlanLimit(error)
            | Self::PlanNotEligible(error)
            | Self::UnsupportedCapability(error)
            | Self::AuthRequired(error)
            | Self::RouteNotSupported(error) => error.code.as_deref(),
            Self::Transient { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    /// `error.param` of a capability error: the request field to drop.
    pub fn param(&self) -> Option<&str> {
        match self {
            Self::UnsupportedCapability(error) => error.param.as_deref(),
            _ => None,
        }
    }

    /// Retry category of this failure.
    pub fn retry_class(&self) -> RetryClass {
        match self {
            Self::Unauthorized(_) | Self::AuthRequired(_) => RetryClass::AuthRefresh,
            Self::RateLimited { .. }
            | Self::Network(_)
            | Self::Timeout { .. }
            | Self::StreamInterrupted(_)
            | Self::StreamStalled(_)
            | Self::Transient { .. } => RetryClass::Transient,
            Self::UnsupportedProtocol(_)
            | Self::BadRequest(_)
            | Self::ContextOverflow(_)
            | Self::InsufficientCredit(_)
            | Self::Other(_)
            | Self::Cancelled
            | Self::PlanLimit(_)
            | Self::PlanNotEligible(_)
            | Self::UnsupportedCapability(_)
            | Self::RouteNotSupported(_) => RetryClass::Permanent,
        }
    }

    /// Server-requested wait carried by the failure, when any.
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::RateLimited { retry_after, .. } | Self::Transient { retry_after, .. } => {
                *retry_after
            }
            _ => None,
        }
    }

    pub fn is_transient(&self) -> bool {
        self.retry_class() == RetryClass::Transient
    }

    /// 401-class failure: the harness may refresh an OAuth bearer and retry
    /// exactly once before asking for a new login.
    pub fn is_auth_failure(&self) -> bool {
        matches!(self, Self::Unauthorized(_) | Self::AuthRequired(_))
    }

    /// The stream watchdog aborted the attempt before the model produced any
    /// output. The harness retries when the attempt is still empty.
    pub fn is_stream_stall(&self) -> bool {
        matches!(self, Self::StreamStalled(_))
    }

    /// Plan allowance exhausted: do not auto-retry; surface the "Gerenciar
    /// uso" CTA instead (the limit may be the plan's or this app's).
    pub fn is_plan_limit(&self) -> bool {
        matches!(self, Self::PlanLimit(_))
    }

    /// The input exceeded the model context window: the only recovery is to
    /// compact the history and retry the same step.
    pub fn is_context_overflow(&self) -> bool {
        matches!(self, Self::ContextOverflow(_))
    }

    pub fn is_unsupported_protocol(&self) -> bool {
        matches!(self, Self::UnsupportedProtocol(_))
    }
}

/// Cap and clean an HTTP error body before it reaches the UI/database.
///
/// HTML error pages (proxies, CDNs) are reduced to their text content; JSON and
/// plain text are only truncated. The provider message never dumps a full page
/// into the chat.
pub(crate) fn error_excerpt(body: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let trimmed = body.trim();
    let looks_html = trimmed.starts_with('<')
        && (trimmed.to_ascii_lowercase().contains("<html")
            || trimmed.to_ascii_lowercase().contains("<!doctype"));
    let mut out = String::with_capacity(trimmed.len().min(MAX_CHARS));
    if looks_html {
        let mut inside_tag = false;
        for ch in trimmed.chars() {
            match ch {
                '<' => inside_tag = true,
                '>' => {
                    inside_tag = false;
                    out.push(' ');
                }
                _ if !inside_tag => out.push(ch),
                _ => {}
            }
        }
    } else {
        out.push_str(trimmed);
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(MAX_CHARS).collect()
}

/// Provider codes that mean "try again" when they arrive inside a stream.
fn is_transient_stream_code(code: &str) -> bool {
    matches!(
        code,
        "server_error"
            | "internal_error"
            | "api_error"
            | "overloaded_error"
            | "rate_limit_error"
            | "rate_limit_exceeded"
            | "timeout"
            | "unavailable"
            | "UNAVAILABLE"
            | "INTERNAL"
            | "DEADLINE_EXCEEDED"
            | "RESOURCE_EXHAUSTED"
    )
}

/* ------------------------------------------------------------------ */
/* Shared plumbing for the protocol adapters                           */
/* ------------------------------------------------------------------ */

pub(crate) fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

/// Send one provider event, failing when the harness dropped the receiver
/// (turn cancelled / aborted).
pub(crate) fn emit(sink: &EventSink, event: ProviderEvent) -> anyhow::Result<()> {
    sink.send(event)
        .map_err(|_| anyhow::Error::new(ProviderError::Cancelled))
}

/// Emit the canonical prefix digest of one wire request.
///
/// Every adapter calls this right after `build_body` and before the HTTP/SSE
/// stream, so the harness can classify prefix reuse (and attribute a break)
/// even when the request fails. The digest is computed on the **final** body
/// (`cache::apply` already ran, if F4 has plans); cache metadata is excluded
/// from the hash by [`cache::digest`].
pub(crate) fn emit_cache_digest(
    request: &CompletionRequest,
    protocol: WireProtocol,
    body: &Value,
    sink: &EventSink,
) -> ProviderResult<()> {
    let digest = cache::digest(protocol, &request.config.provider_id, body);
    emit(sink, ProviderEvent::CacheDigest(digest)).map_err(to_provider_error)
}

/// Emit the safe raw usage excerpt for diagnostics, once per request, right
/// after the normalized [`ProviderEvent::Usage`] and before `Done`.
///
/// `raw` is the provider usage object (`usage`, `usageMetadata` or the merged
/// Anthropic usage); `cache::usage_excerpt` allowlists the meaningful counters
/// and caps the size, and the event is skipped when nothing safe remains.
pub(crate) fn emit_usage_raw(sink: &EventSink, raw: Option<&Value>) -> ProviderResult<()> {
    let Some(raw) = raw else {
        return Ok(());
    };
    let excerpt = cache::usage_excerpt(raw);
    let Some(object) = excerpt.as_object() else {
        return Ok(());
    };
    if object.is_empty() {
        return Ok(());
    }
    emit(sink, ProviderEvent::UsageRaw(excerpt)).map_err(to_provider_error)
}

/// Recover the typed provider error from a failure raised inside the SSE
/// callback (which is `anyhow` based).
pub(crate) fn to_provider_error(error: anyhow::Error) -> ProviderError {
    match error.downcast::<ProviderError>() {
        Ok(provider_error) => provider_error,
        Err(other) => ProviderError::Network(format!("{other:#}")),
    }
}

/// POST a JSON body and return the streaming response, or `None` when the turn
/// was cancelled before the response headers arrived.
pub(crate) async fn send_stream(
    http: &reqwest::Client,
    request: &CompletionRequest,
    url: &str,
    body: &Value,
) -> ProviderResult<Option<reqwest::Response>> {
    use reqwest::header::{ACCEPT, CONTENT_TYPE};

    if request.cancel.is_cancelled() {
        return Ok(None);
    }
    let mut builder = http
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "text/event-stream");
    for (name, value) in request.config.headers() {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = tokio::select! {
        _ = request.cancel.cancelled() => return Ok(None),
        result = tokio::time::timeout(request.timeouts.headers, builder.json(body).send()) => match result {
            Err(_) => {
                return Err(ProviderError::Timeout {
                    phase: TimeoutPhase::Headers,
                    detail: format!(
                        "sem resposta de {} em {} s",
                        request.config.provider_name,
                        request.timeouts.headers.as_secs()
                    ),
                });
            }
            Ok(Err(error)) => return Err(classify_transport_error(error)),
            Ok(Ok(response)) => response,
        },
    };
    let status = response.status();
    if !status.is_success() {
        let retry_after = retry::retry_after_from_headers(response.headers());
        let body_text = tokio::select! {
            _ = request.cancel.cancelled() => return Ok(None),
            text = tokio::time::timeout(Duration::from_secs(15), response.text()) => match text {
                Ok(text) => text.unwrap_or_default(),
                Err(_) => String::new(),
            },
        };
        return Err(ProviderError::from_http_with_retry_after(
            status.as_u16(),
            &body_text,
            retry_after,
        ));
    }
    Ok(Some(response))
}

/// Append one header to `config.extra_headers`, merging by case-insensitive
/// name with a comma (the convention for multi-value headers such as
/// `anthropic-beta`).
pub(crate) fn add_header(config: &mut ProviderConfig, name: &str, value: &str) {
    if let Some(existing) = config
        .extra_headers
        .iter_mut()
        .find(|(current, _)| current.eq_ignore_ascii_case(name))
    {
        if existing.1.trim().is_empty() {
            existing.1 = value.to_string();
        } else if !existing.1.split(',').any(|entry| entry.trim() == value) {
            existing.1.push(',');
            existing.1.push_str(value);
        }
        return;
    }
    config
        .extra_headers
        .push((name.to_string(), value.to_string()));
}

/// POST a JSON body and return the decoded JSON response (non-streaming).
///
/// Used by the native-compaction endpoints, which answer with a single JSON
/// object instead of an SSE stream.
pub(crate) async fn post_json(
    http: &reqwest::Client,
    config: &ProviderConfig,
    url: &str,
    body: &Value,
    timeout: Duration,
    cancel: &CancellationToken,
) -> ProviderResult<Value> {
    use reqwest::header::CONTENT_TYPE;

    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    let mut builder = http.post(url).header(CONTENT_TYPE, "application/json");
    for (name, value) in config.headers() {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
        result = tokio::time::timeout(timeout, builder.json(body).send()) => match result {
            Err(_) => {
                return Err(ProviderError::Timeout {
                    phase: TimeoutPhase::Headers,
                    detail: format!(
                        "sem resposta de {} em {} s",
                        config.provider_name,
                        timeout.as_secs()
                    ),
                });
            }
            Ok(Err(error)) => return Err(classify_transport_error(error)),
            Ok(Ok(response)) => response,
        },
    };
    let status = response.status();
    let retry_after = retry::retry_after_from_headers(response.headers());
    let text = tokio::select! {
        _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
        text = tokio::time::timeout(Duration::from_secs(15), response.text()) => match text {
            Ok(text) => text.unwrap_or_default(),
            Err(_) => String::new(),
        },
    };
    if !status.is_success() {
        return Err(ProviderError::from_http_with_retry_after(
            status.as_u16(),
            &text,
            retry_after,
        ));
    }
    serde_json::from_str::<Value>(&text).map_err(|error| {
        ProviderError::Other(format!(
            "resposta não-JSON de {}: {error}",
            config.provider_name
        ))
    })
}

/// Classify a transport failure: timeouts are retryable timeouts, everything
/// else is a network failure (also retryable, but keeps the underlying detail).
fn classify_transport_error(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        return ProviderError::Timeout {
            phase: TimeoutPhase::Headers,
            detail: format!("falha ao conectar no provedor: {error}"),
        };
    }
    if error.is_connect() {
        return ProviderError::Network(format!("falha ao conectar no provedor: {error}"));
    }
    ProviderError::Network(format!("falha na conexão com o provedor: {error}"))
}

/// Wire fields added by the explicit cache mechanisms. A request-shape
/// rejection naming one of them means the route does not support the field
/// (PLAN §4.5 fallback: retry once without the plan, never loop).
const CACHE_WIRE_FIELDS: &[&str] = &[
    "cache_control",
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
    "cachedcontent",
    "ttl",
];

/// True when an error looks like "this route rejects the cache field I sent".
///
/// Only request-shape errors are considered (auth/quota/network are never
/// caused by a cache field and must not be retried here).
pub(crate) fn is_cache_capability_error(error: &ProviderError) -> bool {
    if !matches!(
        error,
        ProviderError::BadRequest(_)
            | ProviderError::UnsupportedCapability(_)
            | ProviderError::Other(_)
    ) {
        return false;
    }
    if let Some(param) = error.param() {
        let param = param.to_ascii_lowercase();
        if CACHE_WIRE_FIELDS.iter().any(|field| param.contains(field)) {
            return true;
        }
    }
    let text = error.to_string().to_ascii_lowercase();
    CACHE_WIRE_FIELDS.iter().any(|field| text.contains(field))
}

/// POST a body that may carry the explicit cache plan, with the plan's single
/// fallback: when the provider rejects a cache field (HTTP 400 naming it), rebuild
/// the body **without the plan** and retry exactly once.
///
/// The retried body has the same prefix digest as the first one (cache metadata
/// is outside the hash), so the digest already emitted stays valid. Degradation
/// is observable through `usage` (no cache read/write reported); the harness owns
/// marking the epoch/route as degraded.
pub(crate) async fn send_stream_with_cache_fallback<F>(
    http: &reqwest::Client,
    request: &CompletionRequest,
    url: &str,
    body: &Value,
    without_plan: F,
) -> ProviderResult<Option<reqwest::Response>>
where
    F: FnOnce() -> Value,
{
    match send_stream(http, request, url, body).await {
        Ok(response) => Ok(response),
        Err(error) if request.cache_plan.is_some() && is_cache_capability_error(&error) => {
            eprintln!(
                "[providers] {} rejeitou o cache explícito ({}); repetindo uma vez sem o plano",
                request.config.provider_id, error
            );
            let clean = without_plan();
            send_stream(http, request, url, &clean).await
        }
        Err(error) => Err(error),
    }
}

/// System prompt plus any system message embedded in the neutral history.
pub(crate) fn system_text(request: &CompletionRequest) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let base = request.system_prompt.trim();
    if !base.is_empty() {
        parts.push(base);
    }
    for message in &request.history {
        if matches!(message.role, HistoryRole::System) {
            let text = message.text.trim();
            if !text.is_empty() {
                parts.push(text);
            }
        }
    }
    parts.join("\n\n")
}

/// Splits an image part into `(mime_type, raw_base64)`, tolerating both raw
/// base64 and pre-built `data:` URLs.
pub(crate) fn image_base64(image: &ImagePart) -> (String, String) {
    let raw = image.data_base64.trim();
    if let Some(rest) = raw.strip_prefix("data:") {
        if let Some((header, data)) = rest.split_once(',') {
            let mime = header
                .split(';')
                .next()
                .filter(|mime| !mime.is_empty())
                .unwrap_or(image.mime_type.as_str());
            return (mime.to_string(), data.to_string());
        }
    }
    (image.mime_type.clone(), raw.to_string())
}

/// `data:<mime>;base64,<data>` URL used by the OpenAI protocols.
pub(crate) fn image_data_url(image: &ImagePart) -> String {
    let raw = image.data_base64.trim();
    if raw.starts_with("data:") {
        raw.to_string()
    } else {
        format!("data:{};base64,{}", image.mime_type, raw)
    }
}

pub(crate) fn max_output_tokens(request: &CompletionRequest) -> u32 {
    request
        .max_output_tokens
        .unwrap_or(request.config.model.max_output)
        .max(1)
}

pub(crate) fn as_u32(value: &Value) -> Option<u32> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

pub(crate) fn pointer_u32(value: &Value, pointer: &str) -> Option<u32> {
    value.pointer(pointer).and_then(as_u32)
}

/// Tool call arguments as a JSON string, defaulting to `{}` when the provider
/// streamed nothing (or an empty payload).
pub(crate) fn normalize_arguments(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "{}".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Arguments guaranteed to be valid JSON, suitable for `provider_state`.
pub(crate) fn valid_json_arguments(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || serde_json::from_str::<Value>(trimmed).is_err() {
        "{}".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn parse_arguments(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw.trim()).unwrap_or_else(|_| Value::Object(Default::default()))
}

pub(crate) fn make_usage(
    input: Option<u32>,
    output: Option<u32>,
    reasoning: Option<u32>,
    cached: Option<u32>,
    total: Option<u32>,
) -> UsageInfo {
    let total = total.or_else(|| match (input, output) {
        (Some(input), Some(output)) => Some(input.saturating_add(output)),
        _ => None,
    });
    UsageInfo {
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: reasoning,
        cached_tokens: cached,
        // Cache counters are normalized from the raw provider JSON by
        // `cache::normalize_usage` inside each adapter (`cache::apply_usage`).
        cache_read_tokens: None,
        cache_write_tokens: None,
        uncached_input_tokens: None,
        cache_reported: false,
        total_tokens: total,
        cost: None,
        duration_ms: None,
    }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/// Stream a completion, trying every protocol in `request.protocols` until one
/// succeeds. Emits into `sink`; returns after the stream ends.
///
/// Only [`ProviderError::UnsupportedProtocol`] moves on to the next protocol
/// (the gateway answers it when a model does not accept the requested wire
/// protocol); every other error is returned to the caller.
pub async fn stream_completion(
    http: &reqwest::Client,
    request: CompletionRequest,
    sink: EventSink,
) -> anyhow::Result<()> {
    if request.cancel.is_cancelled() {
        return Ok(());
    }
    let mut protocols = request.protocols.clone();
    if protocols.is_empty() {
        protocols = request
            .config
            .model
            .protocols
            .iter()
            .filter_map(|protocol| WireProtocol::parse(protocol))
            .collect();
    }
    if protocols.is_empty() {
        anyhow::bail!(
            "modelo {} não declara nenhum protocolo de wire utilizável",
            request.config.model.id
        );
    }

    let mut last_error: Option<ProviderError> = None;
    let mut attempted: Vec<&str> = Vec::new();
    for protocol in protocols {
        if request.cancel.is_cancelled() {
            return Ok(());
        }
        attempted.push(protocol.as_str());
        match stream_one(http, &request, protocol, &sink).await {
            Ok(()) => return Ok(()),
            Err(error) if error.is_unsupported_protocol() => {
                eprintln!(
                    "[providers] protocolo {} não suportado pelo modelo {}: {}",
                    protocol.as_str(),
                    request.config.model.id,
                    error
                );
                last_error = Some(error);
            }
            Err(error) => return Err(anyhow::Error::new(error)),
        }
    }

    let last = last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "nenhum protocolo tentado".to_string());
    anyhow::bail!(
        "nenhum protocolo aceito pelo provedor {} ({}) para o modelo {} (tentados: {}; última falha: {})",
        request.config.provider_name,
        request.config.provider_id,
        request.config.model.id,
        attempted.join(", "),
        last
    )
}

/// Dispatch to a single protocol adapter.
pub(crate) async fn stream_one(
    http: &reqwest::Client,
    request: &CompletionRequest,
    protocol: WireProtocol,
    sink: &EventSink,
) -> ProviderResult<()> {
    match protocol {
        WireProtocol::OpenaiChat => openai_chat::stream(http, request, sink).await,
        WireProtocol::OpenaiResponses => openai_responses::stream(http, request, sink).await,
        WireProtocol::Anthropic => anthropic::stream(http, request, sink).await,
        WireProtocol::Google => google::stream(http, request, sink).await,
    }
}

/* ------------------------------------------------------------------ */
/* Real gateway smoke tests                                            */
/* ------------------------------------------------------------------ */

/// These tests hit the real OpenCode Go gateway with the local OpenCode CLI
/// credentials (`%USERPROFILE%\.local\share\opencode\auth.json`). They are
/// ignored by default so a normal `cargo test` / `cargo check` never touches
/// the network:
///
/// ```text
/// cd src-tauri
/// cargo test --lib providers::smoke -- --ignored --nocapture --test-threads=1
/// ```
#[cfg(test)]
mod smoke {
    use std::collections::HashMap;

    use serde_json::{json, Value};

    use super::*;
    use crate::catalog::{CatalogFile, ProviderInfo};

    #[derive(Debug, Default)]
    struct Call {
        id: String,
        name: String,
        arguments: String,
    }

    #[derive(Debug, Default)]
    struct StreamResult {
        text: String,
        reasoning: String,
        calls: Vec<Call>,
        state: Option<Value>,
        usage: Option<UsageInfo>,
        trace: Vec<String>,
    }

    fn auth_key() -> Option<String> {
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
        parsed
            .get("opencode-go")?
            .get("key")?
            .as_str()
            .map(str::to_string)
    }

    fn provider_config(provider: &ProviderInfo, model: &ModelInfo, key: &str) -> ProviderConfig {
        ProviderConfig {
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            base_url: provider.base_url.clone(),
            api_key: key.to_string(),
            auth_header: provider.auth_header.clone(),
            auth_prefix: provider.auth_prefix.clone(),
            model: model.clone(),
            session_id: format!("zylara-smoke-{}", uuid::Uuid::new_v4()),
            user_agent: concat!("Zylara/", env!("CARGO_PKG_VERSION")).to_string(),
            endpoints: provider.endpoints.clone(),
            request_profile: provider.request_profile(ProviderAuth::ApiKey),
            auth_mode: ProviderAuth::ApiKey,
            extra_headers: Vec::new(),
        }
    }

    fn echo_tool() -> ToolDefinition {
        ToolDefinition {
            name: "echo".to_string(),
            description: "Echo text back to the user. Use it when asked to call echo.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {"text": {"type": "string", "description": "Text to echo"}},
                "required": ["text"],
            }),
        }
    }

    fn tool_call_instructions() -> &'static str {
        "Chame a ferramenta echo exatamente uma vez com o argumento {\"text\":\"ping\"}. \
         Depois de receber o resultado da ferramenta, responda apenas com o texto recebido."
    }

    async fn collect(
        config: ProviderConfig,
        protocols: Vec<WireProtocol>,
        history: Vec<HistoryMessage>,
        tools: Vec<ToolDefinition>,
        reasoning: ReasoningRequest,
    ) -> anyhow::Result<StreamResult> {
        collect_with_cancel(
            config,
            protocols,
            history,
            tools,
            reasoning,
            CancellationToken::new(),
        )
        .await
    }

    async fn collect_with_cancel(
        config: ProviderConfig,
        protocols: Vec<WireProtocol>,
        history: Vec<HistoryMessage>,
        tools: Vec<ToolDefinition>,
        reasoning: ReasoningRequest,
        cancel: CancellationToken,
    ) -> anyhow::Result<StreamResult> {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        let request = CompletionRequest {
            config,
            protocols,
            history,
            system_prompt: String::new(),
            tools,
            reasoning,
            max_output_tokens: Some(4_096),
            temperature: None,
            cache_plan: None,
            timeouts: StreamTimeouts::default(),
            cancel,
        };
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("smoke HTTP client");
        let task = tokio::spawn(async move { stream_completion(&http, request, sink).await });

        let mut result = StreamResult::default();
        let mut open: HashMap<usize, Call> = HashMap::new();
        let mut completed: std::collections::BTreeMap<usize, Call> = Default::default();
        while let Some(event) = events.recv().await {
            match event {
                ProviderEvent::TextDelta(delta) => {
                    result
                        .trace
                        .push(format!("text({})", delta.chars().count()));
                    result.text.push_str(&delta);
                }
                ProviderEvent::ReasoningDelta(delta) => {
                    result
                        .trace
                        .push(format!("reasoning({})", delta.chars().count()));
                    result.reasoning.push_str(&delta);
                }
                ProviderEvent::ToolCallStart { index, id, name } => {
                    result.trace.push(format!("tool_start({name})"));
                    open.insert(
                        index,
                        Call {
                            id,
                            name,
                            arguments: String::new(),
                        },
                    );
                }
                ProviderEvent::ToolCallArgsDelta { index, delta } => {
                    result
                        .trace
                        .push(format!("tool_args({})", delta.chars().count()));
                    if let Some(call) = open.get_mut(&index) {
                        call.arguments.push_str(&delta);
                    }
                }
                ProviderEvent::ToolCallDone { index, arguments } => {
                    result.trace.push("tool_done".to_string());
                    if let Some(mut call) = open.remove(&index) {
                        call.arguments = arguments;
                        completed.insert(index, call);
                    }
                }
                ProviderEvent::ProviderState(state) => {
                    result.trace.push("state".to_string());
                    result.state = Some(state);
                }
                ProviderEvent::Usage(usage) => {
                    result.trace.push("usage".to_string());
                    result.usage = Some(usage);
                }
                ProviderEvent::UsageRaw(raw) => {
                    result
                        .trace
                        .push(format!("usage_raw({})", raw.to_string().len()));
                }
                ProviderEvent::CacheDigest(digest) => {
                    result.trace.push(format!(
                        "cache_digest({} seg, {} chars)",
                        digest.segments.len(),
                        digest.total_chars
                    ));
                }
                ProviderEvent::Done => {
                    result.trace.push("done".to_string());
                }
            }
        }
        let outcome = task.await.expect("stream task panicked");
        outcome?;
        // Keep tool calls in provider order even if some `Done` event was lost.
        for (index, call) in open {
            completed.entry(index).or_insert(call);
        }
        result.calls = completed.into_values().collect();
        Ok(result)
    }

    async fn run_once(
        config: ProviderConfig,
        protocol: WireProtocol,
        history: Vec<HistoryMessage>,
        tools: Vec<ToolDefinition>,
        reasoning: ReasoningRequest,
    ) -> StreamResult {
        collect(config, vec![protocol], history, tools, reasoning)
            .await
            .unwrap_or_else(|error| panic!("stream falhou: {error:#}"))
    }

    fn assistant_replay(first: &StreamResult) -> HistoryMessage {
        HistoryMessage {
            role: HistoryRole::Assistant,
            text: first.text.clone(),
            images: Vec::new(),
            reasoning: Some(first.reasoning.clone()),
            reasoning_signature: first
                .state
                .as_ref()
                .and_then(|state| state.get(0))
                .and_then(|block| block.get("signature"))
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_calls: first
                .calls
                .iter()
                .map(|call| HistoryToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                })
                .collect(),
            tool_call_id: None,
            tool_name: None,
            provider_state: first.state.clone(),
        }
    }

    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_text_streaming_all_protocols() {
        let Some(key) = auth_key() else {
            eprintln!("SKIP smoke_text_streaming_all_protocols: auth.json sem chave opencode-go");
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let cases = [
            ("glm-5.3-flash", WireProtocol::OpenaiChat, "low"),
            ("deepseek-v4.1-flash", WireProtocol::OpenaiChat, "low"),
            ("kimi-k2.6", WireProtocol::OpenaiChat, "high"),
            ("qwen3.8-flash", WireProtocol::OpenaiChat, "high"),
            ("gpt-6-luna", WireProtocol::OpenaiResponses, "low"),
            ("grok-4.7", WireProtocol::OpenaiResponses, "low"),
            ("claude-haiku-5-5", WireProtocol::Anthropic, "high"),
            ("minimax-m3", WireProtocol::Anthropic, "high"),
            ("gemini-4-argon-contributor", WireProtocol::Google, "low"),
        ];
        for (model_id, protocol, effort) in cases {
            let model = catalog
                .model("opencode-go", model_id)
                .expect("model in catalog");
            let config = provider_config(provider, model, &key);
            let result = run_once(
                config,
                protocol,
                vec![HistoryMessage::user("Responda apenas: ok")],
                Vec::new(),
                ReasoningRequest::Effort(effort.to_string()),
            )
            .await;
            eprintln!(
                "[{}] protocolo={} texto={:?} reasoning_chars={} usage={:?}",
                model_id,
                protocol.as_str(),
                result.text.trim(),
                result.reasoning.chars().count(),
                result.usage
            );
            assert!(
                !result.text.trim().is_empty(),
                "{}: stream de texto vazio",
                model_id
            );
        }
    }

    /// Product requirement: every automated integration check uses
    /// `deepseek-v4.1-flash` from OpenCode Go with the maximum reasoning effort.
    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_deepseek_v4_1_flash_max_effort() {
        let Some(key) = auth_key() else {
            eprintln!("SKIP smoke_deepseek_v4_1_flash_max_effort: auth.json sem chave opencode-go");
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "deepseek-v4.1-flash")
            .expect("deepseek-v4.1-flash no catálogo");
        assert!(
            model
                .protocols
                .iter()
                .any(|protocol| protocol == "openai-chat"),
            "deepseek-v4.1-flash deve falar openai-chat"
        );

        let first = run_once(
            provider_config(provider, model, &key),
            WireProtocol::OpenaiChat,
            vec![
                HistoryMessage::system("Pense com cuidado antes de responder, em português."),
                HistoryMessage::user("Explique em duas frases por que o céu é azul."),
            ],
            Vec::new(),
            ReasoningRequest::Effort("max".to_string()),
        )
        .await;

        eprintln!(
            "[deepseek-v4.1-flash max] texto={:?} reasoning_chars={} usage={:?}",
            first.text.trim(),
            first.reasoning.chars().count(),
            first.usage
        );
        assert!(!first.text.trim().is_empty(), "resposta final vazia");
        assert!(
            !first.reasoning.trim().is_empty(),
            "com esforço máximo o DeepSeek deve expor raciocínio"
        );
        assert!(
            first
                .usage
                .as_ref()
                .and_then(|usage| usage.output_tokens)
                .unwrap_or(0)
                > 0,
            "usage de tokens de saída ausente"
        );

        // Second step reuses the provider state (multi-turn replay) and must answer.
        let follow_up = run_once(
            provider_config(provider, model, &key),
            WireProtocol::OpenaiChat,
            vec![
                HistoryMessage::system("Pense com cuidado antes de responder, em português."),
                HistoryMessage::user("Explique em duas frases por que o céu é azul."),
                assistant_replay(&first),
                HistoryMessage::user("Agora resuma em exatamente 3 palavras."),
            ],
            Vec::new(),
            ReasoningRequest::Effort("max".to_string()),
        )
        .await;
        eprintln!(
            "[deepseek-v4.1-flash max replay] texto={:?}",
            follow_up.text.trim()
        );
        assert!(
            !follow_up.text.trim().is_empty(),
            "resposta de continuação vazia (replay do provider_state falhou)"
        );
    }

    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_tool_call_and_provider_state_replay() {
        let Some(key) = auth_key() else {
            eprintln!(
                "SKIP smoke_tool_call_and_provider_state_replay: auth.json sem chave opencode-go"
            );
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let cases = [
            ("glm-5.3-flash", WireProtocol::OpenaiChat),
            ("gpt-6-luna", WireProtocol::OpenaiResponses),
            ("claude-haiku-5-5", WireProtocol::Anthropic),
            ("gemini-4-argon-contributor", WireProtocol::Google),
        ];
        for (model_id, protocol) in cases {
            let model = catalog
                .model("opencode-go", model_id)
                .expect("model in catalog");
            let tool = echo_tool();
            let first = run_once(
                provider_config(provider, model, &key),
                protocol,
                vec![HistoryMessage::user(tool_call_instructions())],
                vec![tool.clone()],
                ReasoningRequest::Auto,
            )
            .await;
            eprintln!(
                "[{}] tool_calls={:?} state={}",
                model_id,
                first
                    .calls
                    .iter()
                    .map(|call| call.name.as_str())
                    .collect::<Vec<_>>(),
                first
                    .state
                    .as_ref()
                    .map(|state| state.to_string().chars().take(160).collect::<String>())
                    .unwrap_or_else(|| "<none>".to_string())
            );
            assert!(
                !first.calls.is_empty(),
                "{}: o modelo não chamou a ferramenta",
                model_id
            );
            assert!(first.state.is_some(), "{}: sem provider_state", model_id);

            let mut history = vec![
                HistoryMessage::user(tool_call_instructions()),
                assistant_replay(&first),
            ];
            for call in &first.calls {
                history.push(HistoryMessage::tool_result(
                    call.id.clone(),
                    call.name.clone(),
                    json!({"ok": true, "echo": "ping"}).to_string(),
                ));
            }
            let second = run_once(
                provider_config(provider, model, &key),
                protocol,
                history,
                vec![tool.clone()],
                ReasoningRequest::Auto,
            )
            .await;
            eprintln!(
                "[{}] replay texto={:?} calls={:?} trace={:?} state={}",
                model_id,
                second.text.trim(),
                second
                    .calls
                    .iter()
                    .map(|call| call.name.as_str())
                    .collect::<Vec<_>>(),
                second.trace,
                second
                    .state
                    .as_ref()
                    .map(|state| state.to_string().chars().take(800).collect::<String>())
                    .unwrap_or_else(|| "<none>".to_string())
            );
            assert!(
                !second.text.trim().is_empty() || !second.calls.is_empty(),
                "{}: replay do tool loop não produziu resposta",
                model_id
            );
        }
    }

    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_protocol_fallback() {
        let Some(key) = auth_key() else {
            eprintln!("SKIP smoke_protocol_fallback: auth.json sem chave opencode-go");
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let claude = catalog
            .model("opencode-go", "claude-haiku-5-5")
            .expect("claude-haiku-5-5 in catalog");

        // The gateway answers `Model does not support this protocol` for the
        // chat protocol; `stream_completion` must fall back to anthropic.
        let result = collect(
            provider_config(provider, claude, &key),
            vec![WireProtocol::OpenaiChat, WireProtocol::Anthropic],
            vec![HistoryMessage::user("Responda apenas: ok")],
            Vec::new(),
            ReasoningRequest::Auto,
        )
        .await
        .unwrap_or_else(|error| panic!("fallback deveria ter sucesso: {error:#}"));
        eprintln!("fallback chat->anthropic texto={:?}", result.text.trim());
        assert!(!result.text.trim().is_empty());

        // When every declared protocol is rejected the error must be explicit.
        let error = collect(
            provider_config(provider, claude, &key),
            vec![WireProtocol::OpenaiChat, WireProtocol::OpenaiResponses],
            vec![HistoryMessage::user("Responda apenas: ok")],
            Vec::new(),
            ReasoningRequest::Auto,
        )
        .await
        .expect_err("todos os protocolos deveriam falhar");
        let message = format!("{error:#}");
        eprintln!("erro final: {message}");
        assert!(
            message.contains("nenhum protocolo aceito"),
            "mensagem de erro inesperada: {message}"
        );
    }

    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_http_error_mapping() {
        let Some(key) = auth_key() else {
            eprintln!("SKIP smoke_http_error_mapping: auth.json sem chave opencode-go");
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "glm-5.3-flash")
            .expect("glm-5.3-flash in catalog");
        let mut config = provider_config(provider, model, &key);
        config.api_key = "chave-invalida-zylara".to_string();
        let error = collect(
            config,
            vec![WireProtocol::OpenaiChat],
            vec![HistoryMessage::user("oi")],
            Vec::new(),
            ReasoningRequest::Auto,
        )
        .await
        .expect_err("chave inválida deveria falhar");
        let message = format!("{error:#}");
        eprintln!("erro mapeado: {message}");
        assert!(
            message.contains("unauthorized"),
            "esperava ProviderError::Unauthorized: {message}"
        );
    }

    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_cancellation_stops_without_done() {
        let Some(key) = auth_key() else {
            eprintln!(
                "SKIP smoke_cancellation_stops_without_done: auth.json sem chave opencode-go"
            );
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let model = catalog
            .model("opencode-go", "glm-5.3-flash")
            .expect("glm-5.3-flash in catalog");
        let cancel = CancellationToken::new();
        let request = CompletionRequest {
            config: provider_config(provider, model, &key),
            protocols: vec![WireProtocol::OpenaiChat],
            history: vec![HistoryMessage::user(
                "Conte de 1 a 200, um número por linha, sem nenhum texto extra.",
            )],
            system_prompt: String::new(),
            tools: Vec::new(),
            reasoning: ReasoningRequest::Auto,
            max_output_tokens: Some(1_024),
            temperature: None,
            cache_plan: None,
            timeouts: StreamTimeouts::default(),
            cancel: cancel.clone(),
        };
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("smoke HTTP client");
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move { stream_completion(&http, request, sink).await });

        let mut deltas = 0usize;
        let mut saw_done = false;
        while let Some(event) = events.recv().await {
            match event {
                ProviderEvent::TextDelta(delta) => {
                    deltas += 1;
                    if deltas == 3 {
                        cancel.cancel();
                    }
                    eprintln!("delta#{deltas}: {delta:?}");
                }
                ProviderEvent::Done => saw_done = true,
                _ => {}
            }
        }
        let outcome = task.await.expect("stream task panicked");
        eprintln!("cancel: deltas={deltas} done={saw_done} resultado={outcome:?}");
        assert!(outcome.is_ok(), "cancelamento deveria retornar Ok");
        assert!(
            deltas >= 3,
            "esperava pelo menos 3 deltas antes de cancelar"
        );
        assert!(!saw_done, "cancelamento não deve emitir Done");
    }

    /// JSON object returned by the fake `echo` tool during the multi-step replay.
    fn fake_echo_result() -> String {
        json!({"ok": true, "echo": "ping"}).to_string()
    }

    /// Appends one agent-loop step exactly like the corrected `build_history`
    /// does on the next turn: the assistant message carries that step's
    /// `provider_state` (and its own tool calls), immediately followed by the
    /// tool results for the calls it requested.
    fn push_step_replay(history: &mut Vec<HistoryMessage>, step: &StreamResult) {
        history.push(assistant_replay(step));
        for call in &step.calls {
            history.push(HistoryMessage::tool_result(
                call.id.clone(),
                call.name.clone(),
                fake_echo_result(),
            ));
        }
    }

    fn call_names(result: &StreamResult) -> Vec<&str> {
        result.calls.iter().map(|call| call.name.as_str()).collect()
    }

    /// Modelo vivo do protocolo Google. O catálogo ainda lista
    /// `gemini-4-argon-contributor`, mas o gateway respondeu `ModelDeprecated`
    /// para ele; o id vivo do mesmo modelo é `gemini-4-argon` (confirmado em
    /// `/v1/models` no gateway Go). Preferimos o id quando o catálogo já o
    /// tiver e, enquanto não tiver, herdamos o metadata do entry antigo
    /// (protocolo `google`, limites e opções de raciocínio).
    fn google_smoke_model(catalog: &CatalogFile) -> crate::catalog::ModelInfo {
        if let Some(model) = catalog.model("opencode-go", "gemini-4-argon") {
            return model.clone();
        }
        let mut model = catalog
            .model("opencode-go", "gemini-4-argon-contributor")
            .expect("nenhum modelo do protocolo Google no catálogo opencode-go")
            .clone();
        model.id = "gemini-4-argon".to_string();
        model
    }

    /// Regression smoke for the replay-shape bug found live: a tool-using turn
    /// used to persist only the LAST step's `provider_state` while keeping every
    /// step's `tool_calls`. On the next user turn, `openai-responses`,
    /// `anthropic` and `google` replayed that final state (no
    /// function_call/tool_use/functionCall item) and ignored
    /// `message.tool_calls`, so the tool outputs were orphaned and the gateway
    /// answered HTTP 400 (`No function call found for function call output with
    /// call_id …`). The fix persists one state per step; `build_history`
    /// reconstructs one assistant per step with interleaved tool results — the
    /// exact shape exercised here on the four wire protocols.
    #[tokio::test]
    #[ignore = "real gateway smoke test (needs ~/.local/share/opencode/auth.json)"]
    async fn smoke_multi_step_turn_replay_all_protocols() {
        let Some(key) = auth_key() else {
            eprintln!(
                "SKIP smoke_multi_step_turn_replay_all_protocols: auth.json sem chave opencode-go"
            );
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("opencode-go")
            .expect("provider opencode-go");
        let cases = [
            ("deepseek-v4.1-flash", WireProtocol::OpenaiChat),
            ("muse-spark-1.3-contributor", WireProtocol::OpenaiResponses),
            ("gpt-6-luna", WireProtocol::OpenaiResponses),
            ("claude-haiku-5-5", WireProtocol::Anthropic),
            // `gemini-4-argon-contributor` foi descontinuado no gateway; o
            // helper resolve para o id vivo (`gemini-4-argon`).
            ("gemini-4-argon", WireProtocol::Google),
        ];

        for (model_id, protocol) in cases {
            let model = if matches!(protocol, WireProtocol::Google) {
                google_smoke_model(&catalog)
            } else {
                catalog
                    .model("opencode-go", model_id)
                    .unwrap_or_else(|| panic!("{model_id} ausente do catálogo opencode-go"))
                    .clone()
            };
            let tool = echo_tool();
            let label = format!("{model_id} [{}]", protocol.as_str());

            // Passo 1 (dentro do turno): o modelo pede a ferramenta e devolve o
            // estado bruto daquele passo.
            let first = run_once(
                provider_config(provider, &model, &key),
                protocol,
                vec![HistoryMessage::user(tool_call_instructions())],
                vec![tool.clone()],
                ReasoningRequest::Auto,
            )
            .await;
            eprintln!(
                "[{label}] passo 1: calls={:?} state_chars={}",
                call_names(&first),
                first
                    .state
                    .as_ref()
                    .map(|state| state.to_string().chars().count())
                    .unwrap_or(0)
            );
            assert!(
                !first.calls.is_empty(),
                "{label}: o modelo não chamou a ferramenta no passo 1"
            );
            assert!(first.state.is_some(), "{label}: passo 1 sem provider_state");

            // Passo 2 (ainda no turno): replay do passo 1 — assistant daquele
            // passo + os tool results — e nova chamada do provedor.
            let mut history = vec![HistoryMessage::user(tool_call_instructions())];
            push_step_replay(&mut history, &first);
            let second = run_once(
                provider_config(provider, &model, &key),
                protocol,
                history,
                vec![tool.clone()],
                ReasoningRequest::Auto,
            )
            .await;
            eprintln!(
                "[{label}] passo 2: texto={:?} calls={:?} state={}",
                second.text.trim(),
                call_names(&second),
                second.state.is_some()
            );
            assert!(
                !second.text.trim().is_empty() || !second.calls.is_empty(),
                "{label}: replay do passo 1 não produziu resposta"
            );

            // Passo 3 (PRÓXIMO turno do usuário): histórico persistido com um
            // assistant por passo + tool results intercalados. O shape antigo
            // (só o estado do último passo + todos os tool results) devolvia 400
            // justamente aqui, nos protocolos que fazem replay do estado.
            let mut history = vec![HistoryMessage::user(tool_call_instructions())];
            push_step_replay(&mut history, &first);
            push_step_replay(&mut history, &second);
            history.push(HistoryMessage::user("Responda apenas: ok"));
            let mut third = run_once(
                provider_config(provider, &model, &key),
                protocol,
                history.clone(),
                vec![tool.clone()],
                ReasoningRequest::Auto,
            )
            .await;
            eprintln!(
                "[{label}] passo 3: texto={:?} calls={:?}",
                third.text.trim(),
                call_names(&third)
            );
            // Se o modelo insistir em chamar a ferramenta, responde as calls e
            // repete a pergunta final sem ferramentas — o histórico multi-step
            // rejeitado pelo gateway seria o mesmo, então o teste continua
            // cobrindo o replay.
            if third.text.trim().is_empty() && !third.calls.is_empty() {
                push_step_replay(&mut history, &third);
                history.push(HistoryMessage::user("Sem ferramentas: responda apenas: ok"));
                third = run_once(
                    provider_config(provider, &model, &key),
                    protocol,
                    history,
                    Vec::new(),
                    ReasoningRequest::Auto,
                )
                .await;
                eprintln!("[{label}] passo 3b: texto={:?}", third.text.trim());
            }
            assert!(
                !third.text.trim().is_empty(),
                "{label}: o próximo turno não devolveu texto — replay multi-step rejeitado"
            );
            eprintln!("[{label}] OK");
        }
    }

    /// Provedor oficial da Anthropic (API key, Bearer + header estático
    /// `anthropic-version` do catálogo): lista os modelos da conta em
    /// `GET {base_url}/models` e faz um stream real em `POST {base_url}/messages`.
    ///
    /// Rodar manualmente (fora do CI; precisa de `ANTHROPIC_API_KEY`):
    ///
    /// ```text
    /// cd src-tauri
    /// cargo test --lib providers::smoke::anthropic_direct -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "real Anthropic API smoke test (needs ANTHROPIC_API_KEY)"]
    async fn anthropic_direct_lists_models_and_streams() {
        let api_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
        if api_key.trim().is_empty() {
            eprintln!("SKIP anthropic_direct_lists_models_and_streams: ANTHROPIC_API_KEY ausente");
            return;
        }
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog
            .provider("anthropic")
            .expect("provider anthropic no catálogo");
        let model = catalog
            .model("anthropic", &provider.default_model_id)
            .expect("modelo default do provider anthropic")
            .clone();
        let static_headers = provider.static_headers();
        assert!(
            static_headers
                .iter()
                .any(|(name, _)| name == "anthropic-version"),
            "catalog deve declarar anthropic-version"
        );
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("smoke HTTP client");

        // 1) Lista da conta: GET {base}/models com Bearer + headers estáticos.
        let models_path = provider
            .endpoints
            .get("models")
            .expect("endpoints.models do provider anthropic");
        let models_url = endpoint(&provider.base_url, models_path);
        let mut list_request = http
            .get(&models_url)
            .header("authorization", format!("Bearer {api_key}"));
        for (name, value) in &static_headers {
            list_request = list_request.header(name.as_str(), value.as_str());
        }
        let response = list_request.send().await.expect("GET /models");
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        assert!(
            status.is_success(),
            "GET {models_url} respondeu {status}: {body}"
        );
        let parsed: Value = serde_json::from_str(&body).expect("GET /models devolve JSON");
        let ids: Vec<String> = parsed
            .get("data")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        assert!(!ids.is_empty(), "GET /models não devolveu nenhum modelo");
        assert!(
            ids.iter().any(|id| id.starts_with("claude-")),
            "GET /models sem ids claude-*: {ids:?}"
        );
        eprintln!(
            "[anthropic] GET /models → {} modelos, primeiros: {:?}",
            ids.len(),
            &ids[..ids.len().min(8)]
        );

        // 2) Stream real: o adaptador monta `stream:true`, `max_tokens:64`,
        //    messages=[{role:"user",content:"diga olá"}] no modelo default.
        let mut config = provider_config(provider, &model, &api_key);
        config.extra_headers = static_headers;
        let request = CompletionRequest {
            config,
            protocols: vec![WireProtocol::Anthropic],
            history: vec![HistoryMessage::user("diga olá")],
            system_prompt: String::new(),
            tools: Vec::new(),
            reasoning: ReasoningRequest::Auto,
            max_output_tokens: Some(64),
            temperature: None,
            cache_plan: None,
            timeouts: StreamTimeouts::default(),
            cancel: CancellationToken::new(),
        };
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move { stream_completion(&http, request, sink).await });
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut usage = None;
        while let Some(event) = events.recv().await {
            match event {
                ProviderEvent::TextDelta(delta) => text.push_str(&delta),
                ProviderEvent::ReasoningDelta(delta) => reasoning.push_str(&delta),
                ProviderEvent::Usage(value) => usage = Some(value),
                _ => {}
            }
        }
        let outcome = task.await.expect("stream task panicked");
        outcome.expect("POST /messages falhou");
        eprintln!(
            "[anthropic] POST /messages stream: modelo={} texto={:?} reasoning_chars={} usage={:?}",
            model.id,
            text.trim(),
            reasoning.chars().count(),
            usage
        );
        assert!(
            !text.trim().is_empty(),
            "stream do provedor direto não produziu texto"
        );
    }

    #[tokio::test]
    #[ignore = "real Gemini API smoke test (needs GEMINI_API_KEY)"]
    async fn gemini_direct_streams_text_and_usage() {
        let Some(key) = std::env::var("GEMINI_API_KEY")
            .ok()
            .or_else(|| std::env::var("GOOGLE_API_KEY").ok())
        else {
            eprintln!("SKIP gemini_direct_streams_text_and_usage: GEMINI_API_KEY ausente");
            return;
        };
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog.provider("gemini").expect("provider gemini");
        let model = catalog
            .model("gemini", "gemini-3.8-flash")
            .expect("gemini-3.8-flash")
            .clone();
        let result = collect(
            provider_config(provider, &model, &key),
            vec![WireProtocol::Google],
            vec![HistoryMessage::user(
                "Reply with the single word: pong",
            )],
            Vec::new(),
            ReasoningRequest::Effort("low".into()),
        )
        .await
        .expect("POST :streamGenerateContent falhou");
        eprintln!(
            "[gemini] texto={:?} reasoning_chars={} usage={:?} state_chars={}",
            result.text.trim(),
            result.reasoning.chars().count(),
            result.usage,
            result
                .state
                .as_ref()
                .map(|state| state.to_string().chars().count())
                .unwrap_or(0)
        );
        assert!(
            result.text.to_ascii_lowercase().contains("pong"),
            "{:?}",
            result.text
        );
        assert!(result.state.is_some(), "sem provider_state");
        assert!(
            result
                .usage
                .as_ref()
                .and_then(|usage| usage.input_tokens)
                .unwrap_or(0)
                > 0,
            "usage sem promptTokenCount: {:?}",
            result.usage
        );
    }
}

/* ------------------------------------------------------------------ */
/* Unit tests (deterministic, no network)                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::catalog::CatalogFile;

    fn catalog() -> CatalogFile {
        CatalogFile::load().expect("catalog.json carrega")
    }

    fn test_config(provider_id: &str, model_id: &str) -> ProviderConfig {
        let catalog = catalog();
        let provider = catalog
            .provider(provider_id)
            .unwrap_or_else(|| panic!("provedor {provider_id} no catálogo"));
        let model = catalog
            .model(provider_id, model_id)
            .unwrap_or_else(|| panic!("modelo {model_id} em {provider_id}"))
            .clone();
        ProviderConfig {
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
            request_profile: provider.request_profile(ProviderAuth::ApiKey),
            auth_mode: ProviderAuth::ApiKey,
            extra_headers: Vec::new(),
        }
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /* ------------- cache plan rejection (F4b fallback) --------------- */

    /// The single fallback only kicks in for request-shape errors that name a
    /// cache field; auth/quota/network errors are never retried here.
    #[test]
    fn detects_cache_field_rejections_for_the_single_fallback() {
        assert!(is_cache_capability_error(&ProviderError::BadRequest(
            "unknown field `cache_control`".to_string()
        )));
        assert!(is_cache_capability_error(&ProviderError::Other(
            "400: prompt_cache_retention is not supported for this model".to_string()
        )));
        assert!(is_cache_capability_error(
            &ProviderError::UnsupportedCapability(StructuredError {
                message: "unsupported capability".to_string(),
                code: Some("subscription_sharing_unsupported_capability".to_string()),
                param: Some("prompt_cache_key".to_string()),
            })
        ));
        assert!(is_cache_capability_error(&ProviderError::BadRequest(
            "invalid ttl for cache_control".to_string()
        )));

        assert!(!is_cache_capability_error(&ProviderError::BadRequest(
            "model not found".to_string()
        )));
        assert!(
            !is_cache_capability_error(&ProviderError::Unauthorized(
                "cache_control in an auth message".to_string()
            )),
            "erro de auth nunca vira fallback de cache"
        );
        assert!(
            !is_cache_capability_error(&ProviderError::Network(
                "timeout while sending cache_control".to_string()
            )),
            "erro de rede nunca vira fallback de cache"
        );
        assert!(!is_cache_capability_error(&ProviderError::RateLimited {
            message: "slow down".to_string(),
            retry_after: None,
        }));
    }

    /* ------------------ cache digest emission (F0a) ------------------ */

    /// Every adapter emits `ProviderEvent::CacheDigest` **before** the HTTP/SSE
    /// stream and with the protocol of the wire body it just built. The turn is
    /// pre-cancelled so the digest is the only event and no network is touched.
    #[tokio::test]
    async fn adapters_emit_the_cache_digest_before_streaming() {
        use crate::domain::SegmentKind;

        let http = reqwest::Client::new();
        let cases = [
            (
                WireProtocol::OpenaiChat,
                "glm-5.3-flash",
                SegmentKind::System,
            ),
            (
                WireProtocol::OpenaiResponses,
                "gpt-6-luna",
                SegmentKind::System,
            ),
            // Anthropic renders `tools` before `system`.
            (
                WireProtocol::Anthropic,
                "claude-haiku-5-5",
                SegmentKind::Tools,
            ),
            (
                WireProtocol::Google,
                "gemini-4-argon-contributor",
                SegmentKind::System,
            ),
        ];
        for (protocol, model_id, first_kind) in cases {
            let request = CompletionRequest {
                config: test_config("opencode-go", model_id),
                protocols: vec![protocol],
                history: vec![HistoryMessage::user("diga olá")],
                system_prompt: "Você é o Zylara.".to_string(),
                tools: vec![ToolDefinition {
                    name: "echo".to_string(),
                    description: "Devolve o texto recebido.".to_string(),
                    parameters: json!({
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                    }),
                }],
                reasoning: ReasoningRequest::Auto,
                max_output_tokens: Some(64),
                temperature: None,
                cache_plan: None,
                timeouts: StreamTimeouts::default(),
                cancel: CancellationToken::new(),
            };
            request.cancel.cancel();
            let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
            stream_one(&http, &request, protocol, &sink)
                .await
                .unwrap_or_else(|error| {
                    panic!(
                        "{}: turno cancelado antes do HTTP deveria terminar Ok: {error}",
                        protocol.as_str()
                    )
                });
            let event = events
                .recv()
                .await
                .unwrap_or_else(|| panic!("{}: nenhum evento emitido", protocol.as_str()));
            let digest = match event {
                ProviderEvent::CacheDigest(digest) => digest,
                other => panic!(
                    "{}: primeiro evento deveria ser CacheDigest, veio {other:?}",
                    protocol.as_str()
                ),
            };
            assert_eq!(digest.protocol, protocol.as_str());
            assert!(
                !digest.segments.is_empty(),
                "{}: digest sem segmentos",
                protocol.as_str()
            );
            assert_eq!(
                digest.segments[0].kind,
                first_kind,
                "{}: ordem dos segmentos fora do wire",
                protocol.as_str()
            );
            assert!(digest.total_chars > 0);
        }
    }

    /* -------------------- catalog-driven endpoints ------------------- */

    #[test]
    fn endpoint_for_reads_catalog_paths_and_any_base_url() {
        let mut config = test_config("opencode-go", "glm-5.3-flash");
        config.base_url = "https://proxy.example.test/gateway/".to_string();
        assert_eq!(
            config.endpoint_for(WireProtocol::OpenaiChat).expect("chat"),
            "https://proxy.example.test/gateway/openai/v1/chat/completions"
        );
        assert_eq!(
            config
                .endpoint_for(WireProtocol::OpenaiResponses)
                .expect("responses"),
            "https://proxy.example.test/gateway/openai/v1/responses"
        );
        assert_eq!(
            config
                .endpoint_for(WireProtocol::Anthropic)
                .expect("anthropic"),
            "https://proxy.example.test/gateway/anthropic/v1/messages"
        );
    }

    #[test]
    fn openai_provider_uses_its_own_endpoints() {
        let config = test_config("openai", "gpt-6.1-sol");
        assert_eq!(
            config
                .endpoint_for(WireProtocol::OpenaiResponses)
                .expect("responses"),
            "https://api.openai.com/v1/responses"
        );
        // The OpenAI catalog entry does not declare gateway protocols.
        assert!(config.endpoint_for(WireProtocol::OpenaiChat).is_err());
        assert!(config.endpoint_for(WireProtocol::Anthropic).is_err());
        assert!(config.endpoint_for(WireProtocol::Google).is_err());
    }

    /// Regression for the Google cutover: the catalog endpoint is
    /// `/google/v1beta/models/{model}` and must keep the SSE suffix. Every
    /// Google-protocol model in the bundled catalog must build the same URL,
    /// and both gateway providers must expose at least one.
    #[test]
    fn google_endpoint_substitutes_model_and_keeps_sse_suffix() {
        let catalog = catalog();
        let mut checked = 0usize;
        let mut has_go_google = false;
        let mut has_zen_google = false;
        let mut has_direct_google = false;
        for provider in &catalog.providers {
            for model in &provider.models {
                if !model.protocols.iter().any(|protocol| protocol == "google") {
                    continue;
                }
                checked += 1;
                match provider.id.as_str() {
                    "opencode-go" => has_go_google = true,
                    "opencode-zen" => has_zen_google = true,
                    "gemini" => has_direct_google = true,
                    _ => {}
                }
                let mut config = ProviderConfig {
                    provider_id: provider.id.clone(),
                    provider_name: provider.name.clone(),
                    base_url: provider.base_url.clone(),
                    api_key: "sk-test".to_string(),
                    auth_header: provider.auth_header.clone(),
                    auth_prefix: provider.auth_prefix.clone(),
                    model: model.clone(),
                    session_id: String::new(),
                    user_agent: "Zylara/test".to_string(),
                    endpoints: provider.endpoints.clone(),
                    request_profile: provider.request_profile(ProviderAuth::ApiKey),
                    auth_mode: ProviderAuth::ApiKey,
                    extra_headers: Vec::new(),
                };
                // A live id that is not in the catalog must still build.
                config.model.id = "gemini-live-test".to_string();
                let url = config.endpoint_for(WireProtocol::Google).expect("google");
                let template = provider
                    .endpoints
                    .get("google")
                    .expect("provedor google declara endpoint");
                let expected_path = format!(
                    "{}:streamGenerateContent?alt=sse",
                    template.replace("{model}", "gemini-live-test")
                );
                assert_eq!(
                    url,
                    format!(
                        "{}{}",
                        provider.base_url.trim_end_matches('/'),
                        expected_path
                    ),
                    "{} / {}",
                    provider.id,
                    model.id
                );
                assert!(
                    !url.contains("{model}"),
                    "placeholder não substituído: {url}"
                );
            }
        }
        assert!(checked > 0, "catálogo deve declarar modelos google");
        assert!(
            has_go_google && has_zen_google && has_direct_google,
            "Go, Zen e Gemini devem expor ao menos um modelo google"
        );
    }

    /* ---------------------- transport headers ----------------------- */

    #[test]
    fn headers_send_opencode_session_only_to_gateway_providers() {
        let go = test_config("opencode-go", "glm-5.3-flash");
        let headers = go.headers();
        assert_eq!(header(&headers, "authorization"), Some("Bearer sk-test"));
        assert_eq!(header(&headers, "x-opencode-session"), Some("session-1"));
        assert_eq!(header(&headers, "user-agent"), Some("Zylara/test"));

        let zen = test_config("opencode-zen", "gpt-6-luna");
        assert_eq!(
            header(&zen.headers(), "x-opencode-session"),
            Some("session-1")
        );

        // Direct providers never receive gateway-internal headers.
        let openai = test_config("openai", "gpt-6.1-sol");
        let headers = openai.headers();
        assert_eq!(header(&headers, "authorization"), Some("Bearer sk-test"));
        assert!(header(&headers, "x-opencode-session").is_none());
        for forbidden in [
            "originator",
            "chatgpt-account-id",
            "openai-beta",
            "x-codex-turn-metadata",
        ] {
            assert!(
                header(&headers, forbidden).is_none(),
                "header interno vazou: {forbidden}"
            );
        }

        // Gemini uses the dedicated API-key header and no bearer/session.
        let gemini = test_config("gemini", "gemini-3.8-flash");
        let headers = gemini.headers();
        assert_eq!(header(&headers, "x-goog-api-key"), Some("sk-test"));
        assert!(header(&headers, "authorization").is_none());
        assert!(header(&headers, "x-opencode-session").is_none());
    }

    #[test]
    fn extra_headers_are_appended_and_empty_credentials_are_skipped() {
        let mut config = test_config("openai", "gpt-6.1-sol");
        config.api_key.clear();
        config.extra_headers = vec![
            ("x-zylara-test".to_string(), "1".to_string()),
            ("x-zylara-extra".to_string(), "dois".to_string()),
        ];
        let headers = config.headers();
        assert!(header(&headers, "authorization").is_none());
        assert_eq!(header(&headers, "x-zylara-test"), Some("1"));
        assert_eq!(header(&headers, "x-zylara-extra"), Some("dois"));
    }

    /* --------------------- structured errors ------------------------ */

    #[test]
    fn parses_both_error_shapes() {
        let structured = StructuredError::from_body(
            r#"{"error":{"code":"subscription_sharing_usage_limit_exceeded","param":"temperature","message":"limite atingido"}}"#,
        );
        assert_eq!(
            structured.code.as_deref(),
            Some("subscription_sharing_usage_limit_exceeded")
        );
        assert_eq!(structured.param.as_deref(), Some("temperature"));
        assert_eq!(structured.message, "limite atingido");

        // Admission errors may come without an `error` object at all.
        let structured = StructuredError::from_body(r#"{"detail":"not authorized"}"#);
        assert_eq!(structured.message, "not authorized");
        assert!(structured.code.is_none());

        // Plain `{"error": "..."}` and non-JSON bodies keep the text.
        let structured = StructuredError::from_body(r#"{"error":"boom"}"#);
        assert_eq!(structured.message, "boom");
        let structured = StructuredError::from_body("upstream connect error");
        assert_eq!(structured.message, "upstream connect error");
        assert_eq!(
            StructuredError::from_body("   "),
            StructuredError::default()
        );
    }

    #[test]
    fn maps_plan_usage_limit_429() {
        let error = ProviderError::from_http(
            429,
            r#"{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"usage limit exceeded"}}"#,
        );
        assert!(matches!(error, ProviderError::PlanLimit(_)), "{error:?}");
        assert!(error.is_plan_limit());
        assert_eq!(error.code(), Some("plan_limit"));
        assert_eq!(
            error.provider_code(),
            Some("subscription_sharing_usage_limit_exceeded")
        );
        assert!(error.to_string().contains("usage limit exceeded"));

        // A plain 429 stays a transport-level rate limit.
        let error = ProviderError::from_http(429, r#"{"detail":"slow down"}"#);
        assert!(matches!(error, ProviderError::RateLimited { .. }), "{error:?}");
        assert!(!error.is_plan_limit());
        assert_eq!(error.code(), Some("rate_limited"));
        assert_eq!(error.provider_code(), None);
        assert!(error.is_transient());
    }

    #[test]
    fn maps_plan_not_eligible_and_route_errors_403() {
        let error = ProviderError::from_http(
            403,
            r#"{"error":{"code":"subscription_sharing_user_not_eligible","message":"not eligible"}}"#,
        );
        assert!(matches!(error, ProviderError::PlanNotEligible(_)));
        assert_eq!(error.code(), Some("plan_not_eligible"));

        let error = ProviderError::from_http(
            403,
            r#"{"error":{"code":"subscription_sharing_route_not_supported","message":"route"}}"#,
        );
        assert!(matches!(error, ProviderError::RouteNotSupported(_)));
        assert_eq!(error.code(), Some("route_not_supported"));

        // Grant/scope failures are plan-eligibility problems, not billing ones.
        let error = ProviderError::from_http(
            403,
            r#"{"error":{"code":"chatpass_v2_scope_not_authorized","message":"scope"}}"#,
        );
        assert!(matches!(error, ProviderError::PlanNotEligible(_)));

        // A 403 without a known code keeps the legacy unauthorized mapping.
        let error = ProviderError::from_http(403, r#"{"detail":"region blocked"}"#);
        assert!(matches!(error, ProviderError::Unauthorized(_)));
        assert_eq!(error.code(), Some("auth_required"));
    }

    #[test]
    fn maps_unsupported_capability_400_with_param() {
        let error = ProviderError::from_http(
            400,
            r#"{"error":{"code":"subscription_sharing_unsupported_capability","param":"max_output_tokens","message":"field not allowed"}}"#,
        );
        assert!(matches!(error, ProviderError::UnsupportedCapability(_)));
        assert_eq!(error.param(), Some("max_output_tokens"));
        assert_eq!(error.code(), Some("unsupported_capability"));
        assert_eq!(
            error.provider_code(),
            Some("subscription_sharing_unsupported_capability")
        );

        // Validation errors without a code are still plain bad requests.
        let error = ProviderError::from_http(
            400,
            r#"{"detail":[{"loc":["body","model"],"msg":"invalid"}]}"#,
        );
        assert!(matches!(error, ProviderError::BadRequest(_)));
        assert!(error.to_string().contains("invalid"));
    }

    #[test]
    fn maps_401_auth_required_only_for_the_invalid_user_code() {
        let error = ProviderError::from_http(
            401,
            r#"{"error":{"code":"subscription_sharing_invalid_user","message":"invalid user"}}"#,
        );
        assert!(matches!(error, ProviderError::AuthRequired(_)));
        assert!(error.is_auth_failure());
        assert_eq!(error.code(), Some("auth_required"));
        assert_eq!(
            error.provider_code(),
            Some("subscription_sharing_invalid_user")
        );

        let error = ProviderError::from_http(401, r#"{"error":{"message":"bad api key"}}"#);
        assert!(matches!(error, ProviderError::Unauthorized(_)));
        assert!(error.is_auth_failure());
        assert_eq!(error.code(), Some("auth_required"));
        assert_eq!(error.provider_code(), None);
    }

    #[test]
    fn keeps_unsupported_protocol_and_5xx_detection() {
        let error = ProviderError::from_http(
            400,
            r#"{"error":{"code":"ModelProtocolUnsupported","message":"Model does not support this protocol"}}"#,
        );
        assert!(error.is_unsupported_protocol());

        let error = ProviderError::from_http(
            503,
            r#"{"error":{"code":"subscription_sharing_usage_unavailable","message":"try later"}}"#,
        );
        assert!(matches!(error, ProviderError::Transient { .. }));
        assert!(error.is_transient());
        assert_eq!(error.code(), Some("upstream_error"));
        assert!(error
            .to_string()
            .contains("subscription_sharing_usage_unavailable"));

        let error = ProviderError::from_http(402, "sem saldo");
        assert!(matches!(error, ProviderError::InsufficientCredit(_)));
        assert_eq!(error.code(), Some("insufficient_credit"));
        assert!(error.to_string().contains("saldo/créditos insuficientes"));

        // A generic 400 with a structured code is not a capability error.
        let error = ProviderError::from_http(
            400,
            r#"{"error":{"code":"invalid_request_error","message":"bad field"}}"#,
        );
        assert!(matches!(error, ProviderError::BadRequest(_)));
        assert_eq!(error.code(), Some("bad_request"));
        assert!(!error.is_transient());
    }

    #[test]
    fn context_overflow_is_classified_for_openai_anthropic_and_google_bodies() {
        // OpenAI Responses / Chat both use `context_length_exceeded`.
        let error = ProviderError::from_http(
            400,
            r#"{"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}"#,
        );
        assert!(matches!(error, ProviderError::ContextOverflow(_)), "{error:?}");
        assert!(error.is_context_overflow());
        assert_eq!(error.code(), Some("context_overflow"));
        assert_eq!(error.retry_class(), RetryClass::Permanent);
        assert!(!error.is_transient());
        assert!(!error.is_auth_failure());
        assert!(!error.is_plan_limit());
        assert!(error.to_string().contains("context window"));

        // Anthropic: "prompt is too long: N tokens > M maximum".
        let error = ProviderError::from_http(
            422,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}"#,
        );
        assert!(error.is_context_overflow(), "{error:?}");
        assert_eq!(error.code(), Some("context_overflow"));

        // Google: "The input token count (N) exceeds the maximum number of tokens".
        let error = ProviderError::from_http(
            400,
            r#"{"error":{"code":400,"message":"The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}"#,
        );
        assert!(error.is_context_overflow(), "{error:?}");

        // A 413 is a payload-size rejection, never a token-window overflow.
        let error = ProviderError::from_http(413, r#"{"message":"payload too large"}"#);
        assert!(!error.is_context_overflow(), "{error:?}");
        assert!(matches!(error, ProviderError::Other(_)));
    }

    #[test]
    fn generic_400_stays_bad_request() {
        let error = ProviderError::from_http(
            400,
            r#"{"error":{"code":"invalid_request_error","message":"missing field: model"}}"#,
        );
        assert!(matches!(error, ProviderError::BadRequest(_)), "{error:?}");
        assert!(!error.is_context_overflow());
        assert_eq!(error.code(), Some("bad_request"));
        assert_eq!(error.retry_class(), RetryClass::Permanent);
    }

    #[test]
    fn classifies_structured_errors_that_arrive_inside_the_stream() {
        let error = ProviderError::from_stream_error(&json!({
            "type": "response.failed",
            "response": {
                "error": {
                    "code": "subscription_sharing_usage_limit_exceeded",
                    "message": "quota"
                }
            }
        }));
        assert!(matches!(error, ProviderError::PlanLimit(_)), "{error:?}");
        assert_eq!(
            error.provider_code(),
            Some("subscription_sharing_usage_limit_exceeded")
        );

        let error = ProviderError::from_stream_error(&json!({
            "error": {"code": "insufficient_quota", "message": "no credits"}
        }));
        assert!(matches!(error, ProviderError::PlanLimit(_)));

        let error = ProviderError::from_stream_error(&json!({
            "type": "response.failed",
            "response": {"error": {"message": "boom"}}
        }));
        assert!(matches!(error, ProviderError::Other(_)));
        assert!(error.to_string().contains("resposta falhou"));
    }
}
