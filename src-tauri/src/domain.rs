//! Serializable domain types shared by the Tauri commands, the SQLite layer and
//! the React renderer. Every struct here is part of the IPC contract: keep field
//! names in sync with `src/lib/types.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/* ------------------------------------------------------------------ */
/* Conversations & messages                                            */
/* ------------------------------------------------------------------ */

/// Layout onde a sessão nasceu: o Chat ou o Code.
pub const CONVERSATION_MODE_CHAT: &str = "chat";
pub const CONVERSATION_MODE_CODE: &str = "code";
pub const CONVERSATION_MODE_AGENT: &str = "agent";

fn default_conversation_mode() -> String {
    CONVERSATION_MODE_CHAT.to_string()
}

/// Normaliza o `mode` recebido do renderer (IPC/SQLite): só `"code"` é aceito
/// como alternativa; ausente, vazio ou desconhecido cai em `"chat"` — o layout
/// padrão do app e o modo de todas as conversas dos bancos legados.
pub fn conversation_mode_or_default(mode: Option<&str>) -> String {
    match mode.map(str::trim) {
        Some(value) if value == CONVERSATION_MODE_CODE => CONVERSATION_MODE_CODE.to_string(),
        Some(value) if value == CONVERSATION_MODE_AGENT => CONVERSATION_MODE_AGENT.to_string(),
        _ => CONVERSATION_MODE_CHAT.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub pinned: bool,
    /// Manual position inside its sidebar section (0 = recency order).
    #[serde(default)]
    pub sort_order: i64,
    pub provider_id: String,
    pub model_id: String,
    #[serde(default)]
    pub message_count: i64,
    #[serde(default)]
    pub preview: Option<String>,
    /// Layout onde a sessão nasceu (`"chat"` | `"code"`): conversas do Chat só
    /// aparecem no Chat, conversas do Code só no Code.
    #[serde(default = "default_conversation_mode")]
    pub mode: String,
    /// Sessão do Chat explicitamente adicionada ao Code: passa a aparecer nos
    /// dois layouts. Só existe para `mode == "chat"`.
    #[serde(default)]
    pub code_linked: bool,
    /// Workspace de código ao qual a sessão pertence (NULL = sem workspace).
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Motor do agente: `zylara` (nativo). Reservado para `acp:<agente>` no futuro.
    #[serde(default = "default_agent_kind")]
    pub agent_kind: String,
    /// Modo de permissão da sessão de código (Chat ignora).
    #[serde(default)]
    pub permission_mode: PermissionMode,
    /// Parent conversation when this row is a retained subagent transcript.
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    /// `task` tool call that spawned this subagent (audit/deep link).
    #[serde(default)]
    pub subagent_task_call_id: Option<String>,
    /// Subagent kind (`explore`, `review`, `general`).
    #[serde(default)]
    pub subagent_type: Option<String>,
    /// Persona dona desta conversa (`mode == "agent"`); `None` em Chat/Code.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Shared channel that owns this hidden agent thread (`None` = normal thread).
    #[serde(default)]
    pub channel_id: Option<String>,
    /// Delegated task that owns this hidden thread (`None` = normal thread).
    #[serde(default)]
    pub task_id: Option<String>,
    /// One pinned primary conversation per agent (`None`/false for Chat, Code,
    /// channels, tasks and other agent threads).
    #[serde(default)]
    pub is_main: bool,
}

fn default_agent_kind() -> String {
    "zylara".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDetail {
    pub conversation: Conversation,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageStatus {
    Streaming,
    Complete,
    Error,
    Cancelled,
    /// The turn stopped with executable work still open (completion gate cap
    /// or step budget exhausted).
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolCallStatus {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default = "default_tool_status")]
    pub status: ToolCallStatus,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
    /// Apresentação estruturada do resultado (diff, lista de tarefas, plano,
    /// job, aprovação) usada pelos cards do renderer e persistida no DB.
    /// JSON opaco versionado por `kind` — ver `docs/goals/code-harness/TOOLS.md` §1.1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<Value>,
    /// Imagens devolvidas pela tool (screenshot). Só caminhos/metadados entram
    /// no DB; o base64 é lido do disco na hora de montar o replay.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ToolImageRef>,
}

/// Persisted reference to a tool image (never the bytes).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolImageRef {
    pub mime_type: String,
    pub path: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
}

fn default_tool_status() -> ToolCallStatus {
    ToolCallStatus::Running
}

impl ToolCallRecord {
    pub fn running(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments: String::new(),
            result: None,
            status: ToolCallStatus::Running,
            summary: None,
            started_at: Some(now_ms()),
            finished_at: None,
            presentation: None,
            images: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub snippet: Option<String>,
    #[serde(default)]
    pub site_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    /// image | pdf | docx | xlsx | pptx | text | code | csv | json | unknown
    pub kind: String,
    #[serde(default)]
    pub text_preview: Option<String>,
    #[serde(default)]
    pub page_count: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

/// Anexo + payload de visualização, mesma forma de [`ArtifactContent`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentContent {
    pub attachment: AttachmentInfo,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    #[serde(default)]
    pub input_tokens: Option<u32>,
    #[serde(default)]
    pub output_tokens: Option<u32>,
    #[serde(default)]
    pub reasoning_tokens: Option<u32>,
    /// Legacy aggregate: tokens read from the provider cache (subset of input).
    #[serde(default)]
    pub cached_tokens: Option<u32>,
    /// Tokens read from the prompt cache (normalized across protocols).
    #[serde(default)]
    pub cache_read_tokens: Option<u32>,
    /// Tokens written to the prompt cache this request (Anthropic cache_creation,
    /// OpenAI cache_write_tokens, ...).
    #[serde(default)]
    pub cache_write_tokens: Option<u32>,
    /// Input tokens that were neither read from nor written to the cache.
    #[serde(default)]
    pub uncached_input_tokens: Option<u32>,
    /// True when the provider reported cache counters for this request.
    #[serde(default)]
    pub cache_reported: bool,
    #[serde(default)]
    pub total_tokens: Option<u32>,
    #[serde(default)]
    pub cost: Option<f64>,
    /// Wall-clock duration of the turn in milliseconds.
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// Normalized cache usage for one provider request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    #[serde(default)]
    pub cache_read_tokens: Option<u32>,
    #[serde(default)]
    pub cache_write_tokens: Option<u32>,
    #[serde(default)]
    pub uncached_input_tokens: Option<u32>,
    #[serde(default)]
    pub input_total_tokens: Option<u32>,
    #[serde(default)]
    pub reported: bool,
}

impl UsageInfo {
    /// Cache view normalized from the flat usage fields.
    pub fn cache_usage(&self) -> CacheUsage {
        let read = self.cache_read_tokens.or(self.cached_tokens);
        let write = self.cache_write_tokens;
        let uncached = self.uncached_input_tokens;
        let total = match (read, write, uncached) {
            (Some(read), Some(write), Some(uncached)) => {
                Some(read.saturating_add(write).saturating_add(uncached))
            }
            _ => self.input_tokens,
        };
        CacheUsage {
            cache_read_tokens: read,
            cache_write_tokens: write,
            uncached_input_tokens: uncached,
            input_total_tokens: total,
            reported: self.cache_reported,
        }
    }

    /// Fold cache counters from another usage sample (turn aggregation).
    pub fn merge_cache(&mut self, other: &UsageInfo) {
        if other.cache_reported || other.cache_read_tokens.is_some() {
            self.cache_reported = true;
        }
        self.cache_read_tokens = add_optional(self.cache_read_tokens, other.cache_read_tokens);
        self.cache_write_tokens = add_optional(self.cache_write_tokens, other.cache_write_tokens);
        self.uncached_input_tokens =
            add_optional(self.uncached_input_tokens, other.uncached_input_tokens);
    }
}

fn add_optional(left: Option<u32>, right: Option<u32>) -> Option<u32> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.saturating_add(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

/// Cache state shown by the context meter (dashboard/monitor).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheState {
    /// First request of an epoch: nothing to reuse yet.
    #[default]
    Cold,
    /// Requests are still populating the cache.
    Warming,
    /// Steady-state requests are being served from the cache.
    Stable,
    /// A persistent-prefix break happened (or the hit% dropped for a known cause).
    Degraded,
    /// Provider/gateway does not report or support prompt caching.
    Unsupported,
    /// Provider policy prevents reuse for this request (e.g. Gemini 4 <2.050 new tokens).
    ProviderPolicy,
}

/// Why a persistent prefix was broken (or a request could not reuse it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheBreakReason {
    FirstRequest,
    SystemPrompt,
    ToolDefinitions,
    HistoryRewrite,
    HeadTrim,
    Compaction,
    ModelSwitch,
    ProtocolFallback,
    Attachments,
    ConfigChange,
    PluginConfigChanged,
    TtlExpired,
    ProviderPolicy,
}

/// One wire segment covered by the prompt-cache digest, in request order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SegmentKind {
    System,
    Tools,
    Message,
    /// Request-only tail (e.g. forced wrap-up) that is not part of the surface.
    TransientTail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentDigest {
    pub kind: SegmentKind,
    pub index: u32,
    /// SHA-256 of the canonical wire bytes of this segment.
    pub sha256: [u8; 32],
    /// Characters covered by the segment (used for the P/Δ estimate).
    pub chars: u32,
}

/// Canonical digest of a provider request body, used to detect prefix reuse and
/// attribute breaks. Cache metadata (`cache_control`, `prompt_cache_key`, TTL) is
/// intentionally excluded so enabling caching never looks like a break.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixDigest {
    pub protocol: String,
    #[serde(default)]
    pub segments: Vec<SegmentDigest>,
    #[serde(default)]
    pub total_chars: u32,
    #[serde(default)]
    pub estimated_tokens: u32,
}

impl PrefixDigest {
    /// First index where `self` and `previous` diverge (`== len` when one is a
    /// prefix of the other).
    pub fn common_prefix_segments(&self, previous: &PrefixDigest) -> usize {
        let mut index = 0;
        while index < self.segments.len()
            && index < previous.segments.len()
            && self.segments[index].sha256 == previous.segments[index].sha256
        {
            index += 1;
        }
        index
    }

    /// Characters covered by the first `segments` segments.
    pub fn chars_up_to(&self, segments: usize) -> u32 {
        self.segments
            .iter()
            .take(segments)
            .map(|segment| segment.chars)
            .fold(0u32, u32::saturating_add)
    }
}

/// One cache sample per provider request (wire request), emitted in real time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSample {
    pub turn_id: String,
    pub step: u32,
    pub provider_id: String,
    pub model_id: String,
    pub protocol: String,
    pub epoch: u32,
    pub input_total: u32,
    pub cache_read: u32,
    pub cache_write: u32,
    pub uncached: u32,
    /// Provider-reported hit percent; `None` when the provider did not report cache.
    #[serde(default)]
    pub hit_percent: Option<f32>,
    /// Theoretical ceiling `P/(P+Δ)` for this request.
    #[serde(default)]
    pub ceiling_percent: Option<f32>,
    #[serde(default)]
    pub prefix_tokens_est: u32,
    #[serde(default)]
    pub delta_tokens_est: u32,
    pub eligible: bool,
    #[serde(default)]
    pub excluded_reason: Option<String>,
    pub state: CacheState,
    #[serde(default)]
    pub break_reason: Option<CacheBreakReason>,
    #[serde(default)]
    pub break_detail: Option<String>,
    /// Raw provider usage block (trimmed) for the diagnostics panel.
    #[serde(default)]
    pub raw_usage: Option<serde_json::Value>,
    pub at: i64,
}

/// Aggregated cache view for a conversation (restored by `get_cache_stats`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    #[serde(default)]
    pub hit_percent: Option<f32>,
    #[serde(default)]
    pub session_hit_percent: Option<f32>,
    #[serde(default)]
    pub steady_hit_percent: Option<f32>,
    #[serde(default)]
    pub ceiling_percent: Option<f32>,
    #[serde(default)]
    pub input_total: u32,
    #[serde(default)]
    pub cache_read: u32,
    #[serde(default)]
    pub cache_write: u32,
    #[serde(default)]
    pub uncached: u32,
    pub eligible: bool,
    #[serde(default)]
    pub excluded_reason: Option<String>,
    pub state: CacheState,
    #[serde(default)]
    pub epoch: u32,
    #[serde(default)]
    pub samples: u32,
    #[serde(default)]
    pub min_cacheable_tokens: Option<u32>,
    #[serde(default)]
    pub ttl_seconds: Option<u32>,
    #[serde(default)]
    pub break_reason: Option<CacheBreakReason>,
    #[serde(default)]
    pub break_detail: Option<String>,
    #[serde(default)]
    pub provider_policy: Option<String>,
    pub at: i64,
    #[serde(default)]
    pub savings_usd: Option<f64>,
}

/// Snapshot returned by `get_cache_stats`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsView {
    pub conversation_id: String,
    #[serde(default)]
    pub current: Option<CacheStats>,
    #[serde(default)]
    pub session: Option<CacheStats>,
    #[serde(default)]
    pub epoch: u32,
    #[serde(default)]
    pub recent: Vec<CacheSample>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceStep {
    /// Visible reasoning emitted by the model in this step.
    #[serde(default)]
    pub reasoning: Option<String>,
    /// Visible narration emitted before this step requested tools. It stays
    /// empty on the final-answer step: that text lives in
    /// `ChatMessage.content`, so the trace never duplicates the answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Duration of this step's provider request (model time; tool execution is
    /// not included).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Tool calls requested by this step; they are stored in `ChatMessage.tool_calls`
    /// in chronological order, so the count is enough to slice them back.
    #[serde(default)]
    pub tool_calls: u32,
}

/// Structured failure persisted on the assistant message.
///
/// It survives reloads so the thread can explain what happened, offer the
/// right next action (retry vs. open providers vs. manage usage) and tell the
/// renderer whether a manual retry can succeed. Retrying itself is decided by
/// the backend; this type only describes the terminal failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// A new request by the user may succeed (transient/network/timeout/auth).
    pub retryable: bool,
    /// The provider asked for an explicit wait (`Retry-After`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// Provider requests made by the failed step (0 = none was attempted).
    pub attempts: u32,
}

/// Why a turn stopped without finishing (and therefore keeps a resume point).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeReason {
    /// The turn is live at this step (used by the per-step snapshot).
    Running,
    /// The provider/stream failed (API error, timeout, quota, auth, upstream).
    ProviderError,
    /// The route never resolved: credential/model/protocol (nothing was sent).
    Route,
    /// The user pressed Stop.
    Cancelled,
    /// The process ended while the turn was streaming.
    AppClosed,
    /// The step budget ran out or the completion gate kept work open.
    Incomplete,
}

/// State of one resumable point: the assistant message already holds the big
/// parts of the turn (content, reasoning, trace, tool calls with their results,
/// citations, usage and the per-step provider replay envelope). This envelope
/// only carries the loop metadata needed to continue **at the same step** with
/// the same options, so the provider sees the exact context it had before.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    /// Envelope version (1). Unknown versions are treated as not resumable.
    #[serde(default)]
    pub version: u32,
    /// Turn that produced the point (`turn_id` of the interrupted run).
    pub turn_id: String,
    /// Last agent-loop step that ran; resume continues at `step + 1`.
    #[serde(default)]
    pub step: u32,
    /// Original turn kind. Goal rounds keep their own pause/resume flow.
    #[serde(default)]
    pub turn_kind: TurnKind,
    #[serde(default)]
    pub profile: TurnProfile,
    pub reason: ResumeReason,
    /// Human readable detail (provider message) for the banner/tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Reasoning selection of the interrupted turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningSelection>,
    /// Effective options of the interrupted turn (public bits only).
    #[serde(default)]
    pub options: TurnOptions,
    /// Completion-gate continuations already consumed by the turn.
    #[serde(default)]
    pub stop_continuations: u32,
    /// Last write.
    #[serde(default)]
    pub updated_at: i64,
}

impl ResumeState {
    pub const VERSION: u32 = 1;

    pub fn new(turn_id: impl Into<String>, reason: ResumeReason) -> Self {
        Self {
            version: Self::VERSION,
            turn_id: turn_id.into(),
            step: 0,
            turn_kind: TurnKind::User,
            profile: TurnProfile::Chat,
            reason,
            detail: None,
            reasoning: None,
            options: TurnOptions::default(),
            stop_continuations: 0,
            updated_at: now_ms(),
        }
    }

    /// A point written by this version can drive a new loop.
    pub fn is_resumable(&self) -> bool {
        self.version == Self::VERSION && self.turn_kind != TurnKind::GoalRound
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: MessageRole,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub reasoning: Option<String>,
    pub status: MessageStatus,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallRecord>,
    #[serde(default)]
    pub citations: Vec<Citation>,
    #[serde(default)]
    pub attachments: Vec<AttachmentInfo>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub usage: Option<UsageInfo>,
    pub created_at: i64,
    /// Opaque, backend-only protocol payload (Anthropic thinking blocks,
    /// Responses items, Google parts) replayed verbatim on the next turn of the
    /// same conversation. It is persisted in SQLite but never serialized to the
    /// renderer: the UI does not use it and, from v2 on, it stores one replay
    /// block per agent-loop step (see harness::build_history), which would only
    /// inflate the IPC payload.
    #[serde(default, skip_serializing)]
    pub provider_state: Option<Value>,
    /// Agent loop trace for the thinking timeline (reasoning + tool counts per step).
    #[serde(default)]
    pub trace: Vec<TraceStep>,
    /// Origem da mensagem: `user` (default) ou `goal_round` (rodada automática
    /// do objetivo). Só tem significado em mensagens de usuário.
    #[serde(default)]
    pub origin: TurnKind,
    /// Terminal failure of the turn that produced this assistant message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MessageError>,
    /// Resume point of a turn that stopped before finishing (provider error,
    /// Stop, app close, completion gate). Cleared when a turn completes or when
    /// a newer turn starts in the same conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_state: Option<ResumeState>,
}

impl ChatMessage {
    pub fn user(conversation_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.into(),
            role: MessageRole::User,
            content: content.into(),
            reasoning: None,
            status: MessageStatus::Complete,
            tool_calls: Vec::new(),
            citations: Vec::new(),
            attachments: Vec::new(),
            model_id: None,
            provider_id: None,
            usage: None,
            created_at: now_ms(),
            provider_state: None,
            trace: Vec::new(),
            origin: TurnKind::User,
            error: None,
            resume_state: None,
        }
    }

    pub fn assistant(conversation_id: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.into(),
            role: MessageRole::Assistant,
            content: String::new(),
            reasoning: None,
            status: MessageStatus::Streaming,
            tool_calls: Vec::new(),
            citations: Vec::new(),
            attachments: Vec::new(),
            model_id: None,
            provider_id: None,
            usage: None,
            created_at: now_ms(),
            provider_state: None,
            trace: Vec::new(),
            origin: TurnKind::User,
            error: None,
            resume_state: None,
        }
    }

    pub fn system(conversation_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            conversation_id: conversation_id.into(),
            role: MessageRole::System,
            content: content.into(),
            reasoning: None,
            status: MessageStatus::Complete,
            tool_calls: Vec::new(),
            citations: Vec::new(),
            attachments: Vec::new(),
            model_id: None,
            provider_id: None,
            usage: None,
            created_at: now_ms(),
            provider_state: None,
            trace: Vec::new(),
            origin: TurnKind::User,
            error: None,
            resume_state: None,
        }
    }
}

/* ------------------------------------------------------------------ */
/* Turn input / output                                                 */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningMode {
    Off,
    Effort,
    Budget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningSelection {
    pub mode: ReasoningMode,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub budget: Option<u32>,
}

/// Parent conversation/turn that owns a writable subagent's journal rows.
///
/// A `worker` child executes in its own conversation; attributing its file
/// mutations to the parent turn is what makes the Changes panel, diff and
/// revert see them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalOwner {
    pub conversation_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnOptions {
    pub web_search: bool,
    pub create_files: bool,
    /// Execução de código (`run_code`); o harness ainda aplica o gate global
    /// `Settings::code_execution_enabled`.
    pub run_code: bool,
    /// Internal step budget for background/child turns. `None` = unbounded.
    /// Never accepted from the renderer.
    #[serde(skip)]
    pub max_steps: Option<u32>,
    /// Internal subagent instructions. Never accepted from the renderer.
    #[serde(skip)]
    pub system_prompt_override: Option<String>,
    /// Volatile shared-channel history injected as a `surface_item`, never as
    /// a persisted user message. Internal: only the channel runner sets it.
    #[serde(skip)]
    pub channel_context: Option<String>,
    /// Channel leader turn. Internal: only the channel runner sets this.
    #[serde(skip)]
    pub channel_leader: bool,
    /// Internal event payload for event-triggered routines; injected as a
    /// `surface_item kind="event"`, never trusted as instructions.
    #[serde(skip)]
    pub event_context: Option<String>,
    /// Regenerate the last assistant answer (drops it before running).
    pub regenerate: bool,
    /// Profundidade de delegação (0 = sessão do usuário; 1 = subagente).
    /// Subagentes nao recebem a tool `task` (max. 1 nivel).
    #[serde(default)]
    pub delegation_depth: u32,
    /// Writable subagent: its file mutations are journaled under the parent
    /// turn so the Changes panel and revert include them. Internal only.
    #[serde(skip)]
    pub subagent_write: bool,
    /// Parent conversation/turn that owns a writable subagent's journal rows.
    #[serde(skip)]
    pub journal_owner: Option<JournalOwner>,
    /// Stable id sent as `x-opencode-session` for gateway affinity/cache.
    /// Internal field: never accepted from the renderer; the subagent runner
    /// fills it with the parent conversation id. `None` uses the turn's
    /// `conversation_id`.
    #[serde(skip)]
    pub wire_session_id: Option<String>,
    /// Agent capability allowlists. Internal: the harness resolves them from
    /// the persona bound to the conversation, never from the renderer.
    #[serde(skip)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip)]
    pub allowed_skills: Option<Vec<String>>,
    #[serde(skip)]
    pub allowed_mcp_servers: Option<Vec<String>>,
    /// Plugin prompt sections resolved for this turn (internal). The text and
    /// fingerprint are part of the prompt snapshot/config hash.
    #[serde(skip)]
    pub plugin_prompt: String,
    #[serde(skip)]
    pub plugin_fingerprint: String,
    /// Plugin Creator mode for this turn (read from the session store, never
    /// from the renderer). It gates the `plugin_studio` tool and prompt section.
    #[serde(skip)]
    pub plugin_creator: bool,
    /// Tool catalog delta requested by active plugin modes (internal).
    #[serde(skip)]
    pub plugin_mode_tools_add: Vec<String>,
    #[serde(skip)]
    pub plugin_mode_tools_remove: Vec<String>,
    /// An active mode with `writes: "blocked"` hides mutating tools.
    #[serde(skip)]
    pub plugin_mode_writes_blocked: bool,
    /// Agent turn with durable memory enabled (`memory` tool available).
    #[serde(skip)]
    pub agent_memory: bool,
    /// Persona bound to the turn (internal, used by the `memory` tool).
    #[serde(skip)]
    pub agent_id: Option<String>,
    /// Agent capability gates for delegation/computer/browser/docker tools.
    /// Internal: resolved from the persona, never accepted from the renderer.
    #[serde(skip)]
    pub agent_delegation: bool,
    #[serde(skip)]
    pub agent_computer: bool,
    #[serde(skip)]
    pub agent_browser: bool,
    #[serde(skip)]
    pub agent_docker: bool,
}

impl Default for TurnOptions {
    fn default() -> Self {
        Self {
            web_search: true,
            create_files: true,
            run_code: true,
            max_steps: None,
            system_prompt_override: None,
            channel_context: None,
            channel_leader: false,
            event_context: None,
            regenerate: false,
            delegation_depth: 0,
            subagent_write: false,
            journal_owner: None,
            wire_session_id: None,
            allowed_tools: None,
            allowed_skills: None,
            allowed_mcp_servers: None,
            plugin_prompt: String::new(),
            plugin_fingerprint: String::new(),
            plugin_creator: false,
            plugin_mode_tools_add: Vec::new(),
            plugin_mode_tools_remove: Vec::new(),
            plugin_mode_writes_blocked: false,
            agent_memory: false,
            agent_id: None,
            agent_delegation: false,
            agent_computer: false,
            agent_browser: false,
            agent_docker: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnPayload {
    pub conversation_id: String,
    pub content: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    pub provider_id: String,
    pub model_id: String,
    #[serde(default)]
    pub reasoning: Option<ReasoningSelection>,
    #[serde(default)]
    pub options: TurnOptions,
    /// Perfil do turno: `chat` (default, retrocompatível) ou `code`.
    #[serde(default)]
    pub profile: TurnProfile,
    /// Tipo do turno: `user` (default) ou `goal_round` (rodada automática de um
    /// objetivo; exige perfil `code` e sessão do layout Code).
    #[serde(default)]
    pub turn_kind: TurnKind,
    /// O usuário pediu um objetivo pelo fluxo `/goal` (chip no composer). O
    /// turno continua humano; o runtime context instrui o agente a chamar a
    /// tool `goal` (action `create`) com os parâmetros do pedido. Não persiste
    /// em `messages` — é intenção do turno, não conteúdo da mensagem.
    #[serde(default)]
    pub goal_request: bool,
    /// Client generated id used to cancel the stream.
    #[serde(default)]
    pub turn_id: Option<String>,
    /// Continue an interrupted turn instead of starting a new one: the id of
    /// the assistant message that owns the resume point. The turn reuses that
    /// row (same tool-call cards) and restarts the loop at `step + 1`.
    #[serde(default)]
    pub resume_assistant_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub user_message: ChatMessage,
    pub assistant_message: ChatMessage,
    #[serde(default)]
    pub usage: Option<UsageInfo>,
    #[serde(default)]
    pub error: Option<MessageError>,
    #[serde(default)]
    pub conversation: Option<Conversation>,
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Markdown,
    Code,
    Text,
    Html,
    Csv,
    Json,
    Svg,
    Image,
    Pdf,
    Docx,
    Xlsx,
    Pptx,
    /// Áudio (mp3, wav, ogg, m4a, flac, …): player nativo no renderer.
    Audio,
    /// Vídeo (mp4, webm, ogv, mov, …): player nativo no renderer.
    Video,
    /// Arquivo compactado (zip; outros contêineres caem no cartão binário).
    Archive,
    Binary,
}

impl ArtifactKind {
    pub fn from_mime_and_name(mime: &str, name: &str) -> Self {
        let lower = name.to_lowercase();
        let ext = lower.rsplit('.').next().unwrap_or("");
        match ext {
            "md" | "markdown" | "mdx" => return Self::Markdown,
            "html" | "htm" => return Self::Html,
            "csv" | "tsv" => return Self::Csv,
            "json" | "jsonl" => return Self::Json,
            "svg" => return Self::Svg,
            "pdf" => return Self::Pdf,
            "docx" => return Self::Docx,
            "xlsx" | "xls" | "ods" => return Self::Xlsx,
            "pptx" | "ppt" | "odp" => return Self::Pptx,
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" | "tif" | "tiff" | "ico"
            | "jfif" | "apng" => return Self::Image,
            "mp3" | "wav" | "ogg" | "oga" | "opus" | "m4a" | "aac" | "flac" | "weba" | "mid"
            | "midi" | "amr" => return Self::Audio,
            "mp4" | "m4v" | "webm" | "ogv" | "mov" | "mkv" | "avi" | "wmv" | "flv" => {
                return Self::Video
            }
            "zip" | "zipx" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "jar"
            | "epub" | "cbz" => return Self::Archive,
            _ => {}
        }
        if mime.starts_with("image/") {
            return Self::Image;
        }
        if mime.starts_with("audio/") {
            return Self::Audio;
        }
        if mime.starts_with("video/") {
            return Self::Video;
        }
        if mime.contains("zip")
            || mime.contains("tar")
            || mime.contains("gzip")
            || mime.contains("compress")
        {
            return Self::Archive;
        }
        if mime.starts_with("text/") {
            if mime.contains("html") {
                return Self::Html;
            }
            if mime.contains("csv") {
                return Self::Csv;
            }
            if mime.contains("json") {
                return Self::Json;
            }
            return Self::Text;
        }
        if mime.contains("json") {
            return Self::Json;
        }
        Self::Binary
    }

    pub fn is_textual(&self) -> bool {
        matches!(
            self,
            Self::Markdown | Self::Code | Self::Text | Self::Html | Self::Csv | Self::Json | Self::Svg
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    /// `None` = arquivo enviado pelo usuário direto à Biblioteca (sem conversa).
    /// Os artefatos criados pelo agente continuam sempre associados a uma
    /// conversa.
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    pub name: String,
    pub mime_type: String,
    pub kind: ArtifactKind,
    #[serde(default)]
    pub language: Option<String>,
    pub size: i64,
    pub created_at: i64,
    /// Marcado pelo usuário na Biblioteca; não influencia o agente.
    #[serde(default)]
    pub favorite: bool,
}

/// Artefato + título da conversa de origem, usado pela página Biblioteca.
///
/// `conversation_title == None` identifica os arquivos enviados direto à
/// biblioteca (sem conversa). `#[serde(flatten)]` mantém o JSON achatado: os
/// campos de [`Artifact`] aparecem no topo, seguidos de `conversationTitle`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryArtifact {
    #[serde(flatten)]
    pub artifact: Artifact,
    #[serde(default)]
    pub conversation_title: Option<String>,
}

/// Miniatura PNG gerada no backend para os cards de imagem da Biblioteca.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactThumbnail {
    /// Sempre `image/png` (a miniatura é reencodada).
    pub mime: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub artifact: Artifact,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub data_base64: Option<String>,
}

/* ------------------------------------------------------------------ */
/* Code execution / skills / previews                                  */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InterpreterInfo {
    pub path: String,
    pub version: String,
    /// settings | path
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodePackageStatus {
    pub name: String,
    pub available: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    /// bundled | user | agents | codex | claude | opencode
    pub source: String,
    /// Desativada em Configurações → Skills; o agente não a vê no prompt nem
    /// nas ferramentas `list_skills`/`read_skill`.
    pub enabled: bool,
    /// Apenas skills do Zylara (`source == user`) podem ser excluídas pela
    /// interface; skills de repositórios externos são somente leitura.
    pub deletable: bool,
}

/// Conteúdo de uma skill para a pré-visualização em Markdown na interface de
/// gestão: o corpo do `SKILL.md` (Markdown após o frontmatter) e os metadados do
/// cabeçalho. `dir` é o diretório absoluto da skill, só para exibição.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SkillContent {
    pub name: String,
    pub description: String,
    /// bundled | user | agents | codex | claude | opencode
    pub source: String,
    /// Diretório absoluto da skill (contém o `SKILL.md`).
    pub dir: String,
    /// Corpo do `SKILL.md` (Markdown sem o frontmatter).
    pub content: String,
}

/// Status do ambiente de código exibido em Configurações → Ferramentas.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeEnvironmentStatus {
    pub enabled: bool,
    pub python: Option<InterpreterInfo>,
    pub node: Option<InterpreterInfo>,
    pub packages: Vec<CodePackageStatus>,
    /// Comando sugerido para instalar os pacotes opcionais.
    pub install_hint: String,
    pub skills: Vec<SkillSummary>,
}

/// Prévia estruturada de um artefato binário (docx/xlsx/pptx/imagem/zip/binário).
///
/// O PDF não aparece aqui: o renderer o desenha com pdf.js a partir do
/// conteúdo base64 (`get_artifact_content`). Áudio e vídeo também usam o
/// payload base64 direto no player nativo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ArtifactPreview {
    Docx {
        html: String,
    },
    Xlsx {
        sheets: Vec<SheetPreview>,
    },
    Pptx {
        slides: Vec<SlidePreview>,
    },
    /// Imagem com metadados; `data_base64` só vem preenchido quando o formato
    /// original não abre no WebView e foi convertido para PNG (ex.: TIFF).
    Image {
        /// MIME do payload exibido (o original ou `image/png` após conversão).
        mime: String,
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        height: Option<u32>,
        #[serde(default)]
        data_base64: Option<String>,
    },
    /// Listagem de arquivo compactado (ZIP). Outros contêineres → Unsupported.
    Archive {
        format: String,
        entries: Vec<ArchiveEntryPreview>,
        total_entries: u32,
        truncated: bool,
    },
    /// Binário sem prévia: mime detectado + primeiros bytes em base64 (hexdump).
    Binary {
        format: String,
        preview_base64: String,
        preview_bytes: u32,
    },
    Unsupported {
        reason: String,
    },
}

/// Entrada de um arquivo compactado exibida na prévia de ZIP.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveEntryPreview {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SheetPreview {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SlidePreview {
    pub index: u32,
    pub texts: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
}


/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/// TTL accepted by the Anthropic prompt cache strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum CacheTtl {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[default]
    #[serde(rename = "1h")]
    OneHour,
}

impl CacheTtl {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FiveMinutes => "5m",
            Self::OneHour => "1h",
        }
    }

    pub fn seconds(self) -> u32 {
        match self {
            Self::FiveMinutes => 300,
            Self::OneHour => 3_600,
        }
    }
}

/// Prompt-cache preferences (docs/goals/prompt-cache/PLAN.md §5.4). There is no
/// product "enabled" flag: rollback is a release rollback; `show_indicator` only
/// hides the UI chip and never disables measurement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CacheSettings {
    pub show_indicator: bool,
    pub anthropic_ttl: CacheTtl,
    /// `None` = adapter decides (probe-driven); e.g. `in_memory`/`24h`.
    pub openai_retention: Option<String>,
}

impl Default for CacheSettings {
    fn default() -> Self {
        Self {
            show_indicator: true,
            anthropic_ttl: CacheTtl::OneHour,
            openai_retention: None,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Default compaction trigger: 85% of the model window (the historical value).
fn default_compact_threshold_percent() -> u32 {
    85
}

fn default_execution_environment() -> String {
    "local".to_string()
}

fn default_docker_image() -> String {
    "node:22-bookworm".to_string()
}

/// Published graphical image used by the Docker computer-use backend.
///
/// Kept here (and mirrored by `src/lib/computerDocker.ts`) so the settings
/// default, the error guidance and the release workflow agree on one tag.
pub const DEFAULT_COMPUTER_DOCKER_IMAGE: &str = "ghcr.io/hyska-software/zylara-computer:latest";

fn default_computer_environment_setting() -> String {
    "auto".to_string()
}

fn default_terminal_font_size() -> u32 {
    12
}

fn default_docker_memory_mb() -> u32 {
    2_048
}

fn default_docker_cpus() -> f32 {
    2.0
}

fn default_docker_pids_limit() -> u32 {
    256
}

fn default_docker_read_only_root() -> bool {
    true
}

fn default_max_concurrent_turns() -> u32 {
    10
}

fn default_max_concurrent_turns_per_agent() -> u32 {
    1
}

fn default_max_queue_length() -> u32 {
    20
}

fn default_computer_docker_image() -> String {
    crate::domain::DEFAULT_COMPUTER_DOCKER_IMAGE.to_string()
}

fn default_computer_docker_container() -> String {
    "zylara-computer".to_string()
}

fn default_computer_max_actions_per_turn() -> u32 {
    20
}

fn default_computer_max_actions_per_hour() -> u32 {
    120
}

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */

/// One palette variant of an installed theme.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeVariant {
    /// CSS custom-property suffix (without `--`) -> validated value.
    pub tokens: BTreeMap<String, String>,
    /// Relative asset path inside the theme directory, when it has a wallpaper.
    #[serde(default)]
    pub wallpaper: Option<String>,
}

/// Bundled font files (relative to the theme directory).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFontPaths {
    #[serde(default)]
    pub sans: Option<String>,
    #[serde(default)]
    pub mono: Option<String>,
}

/// Theme surfaced to the renderer by `list_themes`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub built_in: bool,
    pub light: ThemeVariant,
    pub dark: ThemeVariant,
    pub fonts: ThemeFontPaths,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInstallResult {
    pub theme: ThemeInfo,
    pub replaced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    /// Installed/built-in theme id; independent of the light/dark/system mode.
    pub theme_id: String,
    /// When false, every corner is square regardless of the active theme radii.
    pub border_radius_enabled: bool,
    pub locale: String,
    pub default_provider: String,
    pub default_model: String,
    pub reasoning_default: String,
    pub system_prompt: String,
    pub web_search_enabled: bool,
    pub file_creation_enabled: bool,
    pub send_key: String,
    pub show_token_usage: bool,
    pub reduce_motion: bool,
    /// Mantém o bloco de raciocínio/passos do assistente recolhido por padrão
    /// (não abre sozinho durante o streaming; o usuário pode expandir).
    pub thinking_collapsed_by_default: bool,
    /// Opt-in: replaces the reasoning selector with a sliding level control.
    pub reasoning_slider_enabled: bool,
    pub font_scale: f32,
    /// Custom font stack for the integrated terminal (CSS font-family list).
    /// Empty means the bundled JetBrains Mono stack.
    pub terminal_font_family: String,
    /// Integrated terminal font size in px (TERMINAL_FONT_SIZE_MIN..=MAX).
    pub terminal_font_size: u32,
    pub include_attachments: bool,
    pub auto_title: bool,
    /// Opt-in: permite ao agente executar código (`run_code`) no computador.
    pub code_execution_enabled: bool,
    /// Tempo máximo de uma execução de código (segundos).
    pub code_timeout_secs: u32,
    /// Interpretador Python explícito; vazio = auto-detecção no PATH.
    pub code_python_path: String,
    /// Interpretador Node explícito; vazio = auto-detecção no PATH.
    pub code_node_path: String,
    /// Mostra o item "Skills" na barra lateral (o diálogo continua acessível
    /// por Configurações → Ferramentas).
    pub skills_panel_enabled: bool,
    /// Nomes de skills desativadas; o agente as ignora no prompt e nas tools.
    pub disabled_skills: Vec<String>,
    /* ---- harness de código (docs/goals/code-harness/PLAN.md §7) ---- */
    /// Permite ao agente executar comandos de shell (`run_command`).
    pub shell_enabled: bool,
    /// Onde os comandos do perfil Code rodam: `local` (máquina do usuário) ou
    /// `docker` (contêiner com o workspace montado em `/workspace`).
    #[serde(default = "default_execution_environment")]
    pub execution_environment: String,
    /// Imagem usada quando `execution_environment == "docker"`.
    #[serde(default = "default_docker_image")]
    pub docker_image: String,
    /// Where computer use runs: `auto`, `private_desktop`, `this_computer`,
    /// `browser` or `off`. Agent turns override this from the persona.
    #[serde(default = "default_computer_environment_setting")]
    pub computer_environment: String,
    /// Browser origin allowlist (host or suffix). Empty means all public hosts.
    #[serde(default)]
    pub browser_allowed_domains: Vec<String>,
    /// Browser origin denylist (host or suffix), evaluated before allow.
    #[serde(default)]
    pub browser_blocked_domains: Vec<String>,
    /// Allowlist of desktop apps (process/window class). Empty means all apps
    /// except the denylist.
    #[serde(default)]
    pub computer_allowed_apps: Vec<String>,
    /// Apps always denied before the allowlist.
    #[serde(default)]
    pub computer_blocked_apps: Vec<String>,
    /// Allow localhost/RFC1918/link-local browser targets (local dev).
    #[serde(default = "default_true")]
    pub browser_allow_private_hosts: bool,
    /// Allow browser actions in unattended routines/tasks when no approval
    /// channel exists. Domain policy still applies. Default false.
    #[serde(default)]
    pub computer_allow_unattended_browser: bool,
    /// Permite rede no contêiner Docker (desligado = `--network none`).
    #[serde(default)]
    pub docker_network: bool,
    /// Memory cap for Docker sandboxes (MB).
    #[serde(default = "default_docker_memory_mb")]
    pub docker_memory_mb: u32,
    /// CPU cap for Docker sandboxes.
    #[serde(default = "default_docker_cpus")]
    pub docker_cpus: f32,
    /// PID cap for Docker sandboxes.
    #[serde(default = "default_docker_pids_limit")]
    pub docker_pids_limit: u32,
    /// Mount the container root filesystem read-only (workspace stays writable).
    #[serde(default = "default_docker_read_only_root")]
    pub docker_read_only_root: bool,
    /// Maximum simultaneous turns across the whole app.
    #[serde(default = "default_max_concurrent_turns")]
    pub max_concurrent_turns: u32,
    /// Maximum simultaneous turns for one agent.
    #[serde(default = "default_max_concurrent_turns_per_agent")]
    pub max_concurrent_turns_per_agent: u32,
    /// Maximum queued messages per agent thread.
    #[serde(default = "default_max_queue_length")]
    pub max_queue_length_per_thread: u32,
    /// Optional daily cost cap per agent (USD). `None` disables the cap.
    #[serde(default)]
    pub agent_daily_cost_limit_usd: Option<f64>,
    /// Docker image used by the graphical computer-use backend.
    #[serde(default = "default_computer_docker_image")]
    pub computer_docker_image: String,
    /// Container name used by the graphical computer-use backend.
    #[serde(default = "default_computer_docker_container")]
    pub computer_docker_container: String,
    /// Max computer-use actions in one turn.
    #[serde(default = "default_computer_max_actions_per_turn")]
    pub computer_max_actions_per_turn: u32,
    /// Max computer-use actions per agent in a rolling hour.
    #[serde(default = "default_computer_max_actions_per_hour")]
    pub computer_max_actions_per_hour: u32,
    /// Compacta o contexto automaticamente quando a janela aperta.
    pub auto_compact: bool,
    /// Gatilho percentual da compactação automática (50..=90; padrão 85).
    /// `compaction_threshold` mantém ao menos 16k tokens livres para a resposta.
    #[serde(default = "default_compact_threshold_percent")]
    pub compact_threshold_percent: u32,
    /// Retenção dos arquivos de spill (saída completa de tools), em dias.
    pub spill_retention_days: u32,
    /// Tempo máximo para o usuário responder uma aprovação (segundos).
    pub approval_timeout_secs: u32,
    /// Notificações do sistema no fim de turnos em segundo plano.
    pub notifications_enabled: bool,
    /// Notify approvals requested by background threads.
    #[serde(default = "default_true")]
    pub notifications_approvals: bool,
    /// Notify structured questions asked by background threads.
    #[serde(default = "default_true")]
    pub notifications_questions: bool,
    /// Notify completed background agent turns.
    #[serde(default = "default_true")]
    pub notifications_completions: bool,
    /// Notify task state changes that need a human.
    #[serde(default = "default_true")]
    pub notifications_tasks: bool,
    /// Do not disturb: keep notifications in the in-app list only.
    #[serde(default)]
    pub notifications_dnd: bool,
    /// Keep the process alive with the window hidden when the user closes it.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// False until the renderer's first-run prompt has been answered.
    #[serde(default)]
    pub close_to_tray_prompted: bool,
    /// Modo de permissão inicial de novas sessões do Code (padrão: Autônomo),
    /// configurável em Configurações → Ferramentas. O Chat ignora os modos.
    pub code_default_permission_mode: PermissionMode,
    /// Confia automaticamente em workspaces já abertos antes (o usuário pode
    /// revogar por workspace); quando falso, cada pasta nova pede confirmação.
    pub trust_workspaces_by_default: bool,
    /// Onde o diff de um arquivo abre ao clicar em Alterações: `tab` (aba do
    /// chat, padrão) ou `panel` (inline no painel direito). Ver WORKBENCH §7.2.
    pub diff_open_mode: String,
    /// Preferências de cache de prompt (medidor/indicador e parâmetros por provedor).
    pub cache: CacheSettings,
    /* ---- resiliência de requests aos provedores ---- */
    /// Deadline between connection open and response headers, in seconds.
    pub provider_headers_timeout_secs: u32,
    /// Deadline for the first SSE event carrying model output, in seconds.
    pub provider_first_event_timeout_secs: u32,
    /// Maximum gap between two SSE events with data, in seconds.
    pub provider_idle_timeout_secs: u32,
    /// Absolute stream deadline in seconds (0 disables the cap).
    pub provider_total_timeout_secs: u32,
    /// Extra attempts after the first one (0 disables automatic retries).
    pub provider_max_retries: u32,
    pub provider_retry_base_delay_ms: u32,
    pub provider_retry_max_delay_ms: u32,
    /// Wall-clock budget for retry sleeps of one step (0 = unlimited).
    pub provider_retry_max_elapsed_ms: u32,
    /// Longest server-requested wait (`Retry-After`) accepted before surfacing.
    pub provider_retry_after_cap_ms: u32,
    /* ---- plugin platform (docs/PLUGINS.md) ---- */
    /// Third-party plugins are enabled. Disabling keeps installed data but
    /// unloads every contribution and tool.
    pub plugins_enabled: bool,
    /// Signed store registry URL; empty uses the bundled/local development
    /// registry only.
    pub plugin_registry_url: String,
    /// Check and stage plugin updates automatically in the background.
    pub plugin_auto_update: bool,
    /// Allow trusted plugins (main-webview JavaScript). Off by default.
    pub plugin_allow_trusted: bool,
    /// Skip loading third-party plugins until the user explicitly recovers.
    pub plugin_safe_mode: bool,
    /// Developer mode: load unpacked folders and unsigned packages.
    pub plugin_dev_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            theme_id: crate::themes::BUILTIN_THEME_ID.into(),
            border_radius_enabled: true,
            locale: "en".into(),
            default_provider: "opencode-go".into(),
            default_model: "deepseek-v4.1-flash".into(),
            reasoning_default: "max".into(),
            system_prompt: String::new(),
            web_search_enabled: true,
            file_creation_enabled: true,
            send_key: "enter".into(),
            show_token_usage: true,
            reduce_motion: false,
            thinking_collapsed_by_default: false,
            reasoning_slider_enabled: false,
            font_scale: 1.0,
            terminal_font_family: String::new(),
            terminal_font_size: default_terminal_font_size(),
            include_attachments: true,
            auto_title: true,
            code_execution_enabled: false,
            code_timeout_secs: 120,
            code_python_path: String::new(),
            code_node_path: String::new(),
            skills_panel_enabled: true,
            disabled_skills: Vec::new(),
            shell_enabled: true,
            execution_environment: default_execution_environment(),
            docker_image: default_docker_image(),
            computer_environment: default_computer_environment_setting(),
            browser_allowed_domains: Vec::new(),
            browser_blocked_domains: Vec::new(),
            browser_allow_private_hosts: true,
            computer_allowed_apps: Vec::new(),
            computer_blocked_apps: Vec::new(),
            computer_allow_unattended_browser: false,
            docker_network: false,
            docker_memory_mb: default_docker_memory_mb(),
            docker_cpus: default_docker_cpus(),
            docker_pids_limit: default_docker_pids_limit(),
            docker_read_only_root: default_docker_read_only_root(),
            max_concurrent_turns: default_max_concurrent_turns(),
            max_concurrent_turns_per_agent: default_max_concurrent_turns_per_agent(),
            max_queue_length_per_thread: default_max_queue_length(),
            agent_daily_cost_limit_usd: None,
            computer_docker_image: default_computer_docker_image(),
            computer_docker_container: default_computer_docker_container(),
            computer_max_actions_per_turn: default_computer_max_actions_per_turn(),
            computer_max_actions_per_hour: default_computer_max_actions_per_hour(),
            auto_compact: true,
            compact_threshold_percent: default_compact_threshold_percent(),
            spill_retention_days: 30,
            approval_timeout_secs: 600,
            notifications_enabled: true,
            notifications_approvals: true,
            notifications_questions: true,
            notifications_completions: true,
            notifications_tasks: true,
            notifications_dnd: false,
            close_to_tray: true,
            close_to_tray_prompted: false,
            // Padrão do produto: o Code nasce Autônomo (o usuário troca em
            // Configurações → Ferramentas e por sessão no chip do composer).
            code_default_permission_mode: PermissionMode::Autonomous,
            trust_workspaces_by_default: false,
            diff_open_mode: "tab".into(),
            cache: CacheSettings::default(),
            provider_headers_timeout_secs: 120,
            provider_first_event_timeout_secs: 180,
            provider_idle_timeout_secs: 120,
            provider_total_timeout_secs: 1_800,
            provider_max_retries: 3,
            provider_retry_base_delay_ms: 800,
            provider_retry_max_delay_ms: 20_000,
            provider_retry_max_elapsed_ms: 90_000,
            provider_retry_after_cap_ms: 60_000,
            plugins_enabled: true,
            plugin_registry_url: String::new(),
            plugin_auto_update: false,
            plugin_allow_trusted: false,
            plugin_safe_mode: false,
            plugin_dev_mode: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider_id: String,
    pub has_key: bool,
    #[serde(default)]
    pub masked: Option<String>,
    /// settings | env | opencode-cli | chatgpt | none
    pub source: String,
    /// api-key | oauth
    #[serde(default)]
    pub mode: String,
}

/// Two-phase login attempt handle returned by `openai_login_start`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChallenge {
    pub attempt_id: String,
    pub auth_url: String,
    pub expires_at: i64,
    /// Whether the backend handed the URL to the system browser. A `false`
    /// value means the UI must offer the link for manual copy/paste.
    #[serde(default)]
    pub browser_opened: bool,
    /// Sanitized opener failure; never contains the authorization URL (it can
    /// carry `id_token_hint`).
    #[serde(default)]
    pub browser_error: Option<String>,
}

/// Auth state of one provider, derived from stored credentials (no network).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthStatus {
    pub provider_id: String,
    /// "oauth" | "api-key"
    pub mode: String,
    /// "signed-in" | "signed-out" | "reauth-required" | "plan-disabled"
    pub state: String,
    #[serde(default)]
    pub account_label: Option<String>,
    #[serde(default)]
    pub plan_usage: bool,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub client_id_masked: Option<String>,
    #[serde(default)]
    pub host_id_masked: Option<String>,
    #[serde(default)]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: Settings,
    pub keys: Vec<ProviderKeyStatus>,
    #[serde(default)]
    pub auth: Vec<ProviderAuthStatus>,
    /// Present when the app secrets file could not be parsed; the UI surfaces it
    /// and never overwrites the file automatically.
    #[serde(default)]
    pub secrets_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub tauri_version: String,
    pub platform: String,
    pub started_at: i64,
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderValidation {
    pub provider_id: String,
    pub ok: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub models: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    pub catalog: crate::catalog::CatalogFile,
    pub keys: Vec<ProviderKeyStatus>,
    #[serde(default)]
    pub auth: Vec<ProviderAuthStatus>,
    #[serde(default)]
    pub remote_refreshed_at: Option<i64>,
}

/* ------------------------------------------------------------------ */
/* Harness de código — contratos de sessão, workspace e permissões      */
/* (docs/goals/code-harness/HARNESS.md §4–§12)                          */
/* ------------------------------------------------------------------ */

/// Perfil de um turno do agente: conversa (Chat) ou trabalho de código (Code).
///
/// O perfil muda prompt, catálogo de tools, política e orçamentos do mesmo
/// loop (`harness::run_turn`); nunca cria um segundo loop.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnProfile {
    #[default]
    Chat,
    Code,
}

impl TurnProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Code => "code",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "code" => Self::Code,
            _ => Self::Chat,
        }
    }
}

/// Modo de permissão da sessão de código (chip no header; `HARNESS.md` §6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Só leitura: nenhuma mutação de arquivo, sem shell.
    ReadOnly,
    /// Padrão: edita dentro do workspace; shell pede aprovação.
    #[default]
    Edit,
    /// No confirmation prompts: edits, commands and computer use run directly;
    /// explicit deny rules and Plan mode still apply.
    Autonomous,
    /// Saída do modo Plano: edita o workspace, mas **cada escrita pede
    /// aprovação** (`WORKBENCH.md` §5.4, "Aprovar e revisar cada edição").
    Review,
}

impl PermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Edit => "edit",
            Self::Autonomous => "autonomous",
            Self::Review => "review",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "read_only" | "readonly" | "leitura" => Self::ReadOnly,
            "autonomous" | "autonomo" | "autônomo" => Self::Autonomous,
            "review" | "revisar" | "revisão" => Self::Review,
            _ => Self::Edit,
        }
    }
}

/// Classe de risco de uma tool/chamada — insumo da política de permissões.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskClass {
    /// Leitura local (arquivos, busca, git read).
    Read,
    /// Escrita/edição dentro do workspace.
    Write,
    /// Execução de comando de shell.
    Shell,
    /// Alvo fora do workspace.
    Outside,
    /// Arquivo que casa com padrões de segredo (`.env`, `*.pem`, …).
    Secret,
    /// Operação destrutiva (rm -rf, git reset --hard, force-push, …).
    Destroy,
    /// Tráfego de rede (busca/fetch).
    Network,
    /// Computer use visual (screenshot/clique/teclado).
    Computer,
    /// Pausa explícita para o usuário (plano/pergunta).
    Ask,
}

/// Escopo de uma regra "sempre permitir/negar".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalScope {
    Session,
    Workspace,
    Global,
}

impl ApprovalScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Workspace => "workspace",
            Self::Global => "global",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "session" | "sessao" | "sessão" => Self::Session,
            "workspace" => Self::Workspace,
            _ => Self::Global,
        }
    }
}

/// Decisão de uma aprovação (ou de uma regra persistida).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Approved,
    Denied,
    Cancelled,
    Expired,
}

impl ApprovalDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }
}

/// Rótulo de uma opção do card de aprovação.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    /// `allow` | `deny` | `allow_session` | `allow_workspace` | `allow_global`
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub scope: Option<ApprovalScope>,
}

/// O que a aprovação está autorizando (mostrado no card).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApprovalDetail {
    Command {
        command: String,
        workdir: String,
    },
    Paths {
        paths: Vec<String>,
        change: String,
    },
    Secret {
        path: String,
    },
    Outside {
        path: String,
    },
    ComputerAction {
        action: String,
        target: String,
        #[serde(default)]
        screenshot_path: Option<String>,
        #[serde(default)]
        text_length: Option<u32>,
        #[serde(default)]
        sensitive: bool,
    },
    Other {
        text: String,
    },
}

/// Pedido de aprovação enviado ao renderer (`TurnEvent::ApprovalRequested`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub id: String,
    /// Sessão que pediu a aprovação (o snapshot da sessão filtra por ela).
    #[serde(default)]
    pub conversation_id: String,
    pub tool_call_id: String,
    pub tool: String,
    pub title: String,
    pub detail: ApprovalDetail,
    pub risk: RiskClass,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub options: Vec<ApprovalOption>,
    pub created_at: i64,
}

/// Regra persistida em `approval_rules` (`HARNESS.md` §6.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRule {
    pub id: String,
    pub scope: ApprovalScope,
    #[serde(default)]
    pub scope_id: Option<String>,
    pub tool: String,
    /// `exact` | `prefix` | `glob`
    pub matcher: String,
    pub pattern: String,
    pub decision: ApprovalDecision,
    pub created_at: i64,
}

/// Opção de uma pergunta ao usuário (`ask_user`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Uma pergunta ao usuário (até 4 por chamada).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    pub id: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<AskOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// Pedido de resposta ao usuário (evento `question_requested`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserRequest {
    pub id: String,
    pub conversation_id: String,
    pub tool_call_id: String,
    pub questions: Vec<AskQuestion>,
    pub created_at: i64,
}

/// Resposta a uma pergunta.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserAnswer {
    pub question_id: String,
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub custom: Option<String>,
}

/// Resposta completa a um pedido (`respond_question`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserResponse {
    pub request_id: String,
    #[serde(default)]
    pub answers: Vec<AskUserAnswer>,
    #[serde(default)]
    pub skipped: bool,
}

/// Workspace = pasta do usuário (git opcional) que agrupa sessões de código.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Caminho absoluto canonicalizado; o renderer só exibe.
    pub path: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub last_opened_at: Option<i64>,
    #[serde(default)]
    pub pinned: bool,
    /// Manual position inside the sidebar (0 = recency order).
    #[serde(default)]
    pub sort_order: i64,
    /// Aprovado pelo usuário na primeira abertura ("Confiar nesta pasta").
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub git: Option<GitInfo>,
}

/// Resumo do estado git do workspace (branch/upstream/dirty).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub root: String,
    pub branch: String,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default)]
    pub staged: u32,
    #[serde(default)]
    pub unstaged: u32,
    #[serde(default)]
    pub untracked: u32,
}

/// Comando de verificação detectado do projeto (test/lint/build).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheckInfo {
    pub id: String,
    pub label: String,
    pub command: String,
}

/// Perfil detectado do projeto do workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// `node` | `rust` | `python` | `go` | `dotnet` | `unknown`
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub checks: Vec<ProjectCheckInfo>,
    /// Ecosystems with at least one detected check, including nested manifests
    /// (e.g. `src-tauri/Cargo.toml` in a Tauri workspace). The completion gate
    /// requires a passing check for each changed ecosystem.
    #[serde(default)]
    pub checked_ecosystems: Vec<String>,
}

/// Estado do workspace para o header/painel (`get_workspace_context`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub workspace: Workspace,
    #[serde(default)]
    pub project: Option<ProjectInfo>,
}

/// Item de tarefa mantida pelo agente (`todo_write`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

/// Estado do modo Plano (`HARNESS.md` §6; `WORKBENCH.md` §5.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanState {
    Inactive,
    Planning,
    Reviewing,
    Approved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub state: PlanState,
    #[serde(default)]
    pub markdown: Option<String>,
    /// Feedback do usuário quando "Continuar planejando" foi escolhido
    /// (persistido em `plan/feedback`; usado pelo card e pelo prompt).
    #[serde(default)]
    pub feedback: Option<String>,
    pub updated_at: i64,
}

/* ------------------------------------------------------------------ */
/* Objetivos (Goal) do layout Code (docs/goals/code-goals/PLAN.md)     */
/* ------------------------------------------------------------------ */

/// Origem de um turno e de uma mensagem de usuário. O default `user` mantém
/// payloads antigos e testes existentes retrocompatíveis.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnKind {
    #[default]
    User,
    /// Rodada automática/manual de um objetivo, gerada pelo driver do renderer.
    GoalRound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Completed,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalPauseReason {
    User,
    Error,
    MaxRounds,
    Stalled,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalOrigin {
    User,
    Agent,
}

/// Estado completo de um objetivo (projeção de `code_events`; o último
/// `goal/state` vence e a `revision` é o CAS das ações da UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalView {
    pub title: String,
    pub objective: String,
    pub status: GoalStatus,
    /// Continuar sozinho após cada turno bem-sucedido.
    pub auto_continue: bool,
    pub rounds: u32,
    pub max_rounds: u32,
    pub revision: u64,
    pub origin: GoalOrigin,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub last_round_at: Option<i64>,
    #[serde(default)]
    pub last_note: Option<String>,
    #[serde(default)]
    pub pause_reason: Option<GoalPauseReason>,
    #[serde(default)]
    pub pause_detail: Option<String>,
    #[serde(default)]
    pub blocker_reason: Option<String>,
    #[serde(default)]
    pub blocker_streak: u32,
    #[serde(default)]
    pub stalled_rounds: u32,
    #[serde(default)]
    pub tokens: u64,
    #[serde(default)]
    pub cost: f64,
}

/// Uma rodada do objetivo (registro do histórico/painel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalRound {
    pub index: u32,
    pub turn_id: String,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    /// `done` | `cancelled` | `error` | `interrupted` (None = em andamento).
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub tokens: Option<u32>,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub files_changed: u32,
    #[serde(default)]
    pub note: Option<String>,
}

/// Resposta do preflight `goal_can_continue` (códigos estáveis em `reason`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalContinuation {
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub goal: Option<GoalView>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGoalInput {
    pub objective: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    #[serde(default)]
    pub auto_continue: Option<bool>,
}

/// Ações da UI sobre o objetivo (`update_goal`). A tool do modelo tem um
/// contrato próprio (`create|edit|progress|complete|blocked`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalAction {
    Edit,
    Arm,
    Disarm,
    Pause,
    Resume,
    Complete,
    Reopen,
    Block,
    Delete,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateGoalInput {
    pub title: Option<String>,
    pub objective: Option<String>,
    pub max_rounds: Option<u32>,
    pub summary: Option<String>,
    pub reason: Option<String>,
}

/// Tipo de alteração de um arquivo (journal/presentation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed,
}

/// Alteração de um arquivo (card de tool / evento `FileChanged`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: FileChangeKind,
    #[serde(default)]
    pub added: u32,
    #[serde(default)]
    pub removed: u32,
    #[serde(default)]
    pub diff: Option<String>,
}

/// Resumo compacto por arquivo (painel Alterações / evento `WorkspaceChanges`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    pub path: String,
    pub kind: FileChangeKind,
    #[serde(default)]
    pub added: u32,
    #[serde(default)]
    pub removed: u32,
    /// `session` (journal do agente), `git` (working tree) ou `both`.
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub staged: bool,
}

/// Alterações de um turno (evento `WorkspaceChanges` / painel).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesSummary {
    #[serde(default)]
    pub turn_id: Option<String>,
    pub files: Vec<FileChangeSummary>,
    #[serde(default)]
    pub added: u32,
    #[serde(default)]
    pub removed: u32,
}

/// Quebra estimada do contexto consumido, em tokens, para o medidor/popover
/// (`WORKBENCH.md` §4/§9, `HARNESS.md` §10.1). A soma deve acompanhar `used`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    /// System prompt (identidade, política, projeto, skills…).
    #[serde(default)]
    pub system_prompt: u32,
    /// Definições wire das tools (nome + descrição + JSON Schema).
    #[serde(default)]
    pub tool_definitions: u32,
    /// Histórico (mensagens, reasoning, argumentos de tool calls e resultados).
    #[serde(default)]
    pub messages: u32,
}

/// Uso de contexto estimado (medidor do header).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextStats {
    pub used: u32,
    pub window: u32,
    pub output_cap: u32,
    pub percent: f32,
    #[serde(default)]
    pub compacted: u32,
    #[serde(default)]
    pub messages: u32,
    /// Payloads antigos persistidos antes do breakdown não têm este campo.
    #[serde(default)]
    pub breakdown: ContextBreakdown,
}

/// Estado de um job de processo em background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Running,
    Done,
    Failed,
    Killed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub command: String,
    pub status: JobStatus,
    pub started_at: i64,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub output_preview: Option<String>,
}

/// Snapshot completo da sessão de código (`get_code_session_state`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSessionState {
    pub conversation_id: String,
    pub permission_mode: PermissionMode,
    pub plan_mode: bool,
    #[serde(default)]
    pub creator_mode: bool,
    #[serde(default)]
    pub plan: Option<PlanView>,
    /// Objetivo persistente da sessão (`docs/goals/code-goals/PLAN.md`).
    #[serde(default)]
    pub goal: Option<GoalView>,
    #[serde(default)]
    pub todos: Vec<TodoItem>,
    #[serde(default)]
    pub workspace: Option<Workspace>,
    #[serde(default)]
    pub project: Option<ProjectInfo>,
    #[serde(default)]
    pub context: Option<ContextStats>,
    #[serde(default)]
    pub changes: Option<ChangesSummary>,
    /// Alterações do turno mais recente (subconjunto de `changes`).
    #[serde(default)]
    pub last_turn_changes: Option<ChangesSummary>,
    #[serde(default)]
    pub jobs: Vec<JobView>,
    #[serde(default)]
    pub approvals: Vec<ApprovalRequest>,
    #[serde(default)]
    pub questions: Vec<AskUserRequest>,
}

/// Entrada da árvore de arquivos do workspace (`list_workspace_files`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    /// Path relativo ao workspace, sempre com `/`.
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// Profundidade relativa ao diretório pedido (0 = raiz da listagem).
    pub depth: u32,
    #[serde(default)]
    pub size: Option<u64>,
    /// Estado no git (`M`, `A`, `D`, `U`, `?`) quando disponível.
    #[serde(default)]
    pub git_status: Option<String>,
    #[serde(default)]
    pub children: Vec<WorkspaceFileEntry>,
}

/// Conteúdo de um arquivo do workspace para prévia read-only (aba central).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub path: String,
    pub text: String,
    /// O backend truncou o conteúdo textual (arquivo maior que o limite de prévia).
    pub truncated: bool,
    /// Tamanho total em bytes.
    pub size: u64,
    #[serde(default)]
    pub binary: bool,
    /// Encoding detectado quando o conteúdo não era UTF-8.
    #[serde(default)]
    pub encoding: Option<String>,
    /// MIME inferido pela extensão para prévias binárias suportadas
    /// (imagem/PDF). `None` para texto e binários sem prévia.
    #[serde(default)]
    pub mime_type: Option<String>,
    /// Payload base64 (sem prefixo `data:`) de imagens/PDF até o limite inline.
    #[serde(default)]
    pub data_base64: Option<String>,
    /// Payload binário omitido por exceder o limite de prévia inline.
    #[serde(default)]
    pub preview_omitted: bool,
}

/// Arquivo no status do git (painel Alterações).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitFile {
    pub path: String,
    pub status: String,
}

/// Status do git de um workspace (working tree + staged).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    pub is_repo: bool,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    #[serde(default)]
    pub staged: Vec<WorkspaceGitFile>,
    #[serde(default)]
    pub unstaged: Vec<WorkspaceGitFile>,
    #[serde(default)]
    pub untracked: Vec<String>,
    #[serde(default)]
    pub conflicted: Vec<String>,
}

/// Arquivo alterado entre uma branch (merge-base) e a working tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCompareFile {
    pub path: String,
    /// `A` | `M` | `D` | `R` | `C` | `T`.
    pub status: String,
    #[serde(default)]
    pub added: u32,
    #[serde(default)]
    pub removed: u32,
}

/// Resultado de `git_compare`: branch escolhida, merge-base usado no diff e
/// os arquivos alterados.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCompare {
    pub base: String,
    pub merge_base: String,
    pub files: Vec<WorkspaceGitCompareFile>,
}

/// Commit recente para o painel (git log).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

/// One branch of the repository (local or remote-tracking) as listed by the
/// branch picker of the Changes tab.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranch {
    /// `main` for a local branch, `origin/main` for a remote-tracking one.
    pub name: String,
    /// `true` for `refs/heads/*`.
    pub local: bool,
    /// Remote name (e.g. `origin`) when `local` is `false`.
    #[serde(default)]
    pub remote: Option<String>,
    /// `true` for the branch checked out in this working tree.
    #[serde(default)]
    pub current: bool,
    /// Upstream short name (`origin/main`), when configured.
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    /// `true` when the configured upstream no longer exists.
    #[serde(default)]
    pub gone: bool,
    /// Subject of the tip commit.
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub author: String,
    /// Committer date of the tip commit, in seconds since the Unix epoch.
    #[serde(default)]
    pub committed_at: i64,
}

/// Branch list of a workspace: the legacy local-name list plus full entries.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitBranches {
    #[serde(default)]
    pub current: Option<String>,
    /// Local branch names (kept for the branch-comparison filter).
    #[serde(default)]
    pub branches: Vec<String>,
    /// Local and remote-tracking branches with commit metadata.
    #[serde(default)]
    pub all: Vec<WorkspaceGitBranch>,
}

/// Um arquivo alterado por um commit (patch completo por arquivo).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommitFile {
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    /// `A` | `M` | `D` | `R` | `C` | `T`.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    #[serde(default)]
    pub binary: bool,
    pub diff: String,
}

/// Commit completo para a aba de histórico do Code (metadados + arquivos).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommitDetail {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    #[serde(default)]
    pub body: String,
    pub files: Vec<WorkspaceCommitFile>,
    #[serde(default)]
    pub truncated: bool,
}

impl ToolCallRecord {
    /// Constrói o record com apresentação estruturada (diff/todo/plano/job).
    pub fn with_presentation(mut self, presentation: Option<Value>) -> Self {
        self.presentation = presentation;
        self
    }
}

/* ------------------------------------------------------------------ */
/* GitHub (pull requests and issues)                                   */
/* ------------------------------------------------------------------ */

/// Account exposed to the renderer: login/scopes only, never the token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccount {
    pub authenticated: bool,
    pub login: Option<String>,
    /// `settings`, `env`, `gh-cli` or `none`.
    pub source: String,
    pub scopes: Vec<String>,
}

/// Repository resolved from the workspace remote.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepoInfo {
    pub host: String,
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub html_url: String,
    pub default_branch: Option<String>,
    /// `true` when the token can push/create branches in this repository.
    pub can_push: bool,
    /// GraphQL actions (draft ↔ ready) are only offered on github.com.
    pub graphql: bool,
}

/// Everything the PR/Issue tabs need before rendering a list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnectionView {
    pub account: GitHubAccount,
    pub repo: Option<GitHubRepoInfo>,
    /// Localized reason when the repository cannot be used (no remote, 404…).
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubUser {
    pub login: String,
    pub avatar_url: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubLabel {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubMilestone {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub open_issues: u32,
    pub closed_issues: u32,
    pub due_on: Option<String>,
}

/// Aggregated state of the commit statuses + check runs of the PR head.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubChecksSummary {
    /// `success`, `failure`, `pending`, `neutral` or `none`.
    pub state: String,
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

/// Row of the PR list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestSummary {
    pub number: u64,
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub author: GitHubUser,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub created_at: String,
    pub updated_at: String,
    pub comments: u32,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub labels: Vec<GitHubLabel>,
    pub html_url: String,
    /// `true` when the head branch lives in a fork.
    pub cross_repository: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestList {
    pub items: Vec<GitHubPullRequestSummary>,
    pub page: u32,
    pub per_page: u32,
    pub has_next: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubComment {
    pub id: u64,
    pub author: GitHubUser,
    pub body: String,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub html_url: Option<String>,
    pub author_association: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubReview {
    pub id: u64,
    pub author: GitHubUser,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`.
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestDetail {
    pub summary: GitHubPullRequestSummary,
    pub body: String,
    pub mergeable: Option<bool>,
    pub mergeable_state: Option<String>,
    pub merged_at: Option<String>,
    pub merged_by: Option<GitHubUser>,
    pub requested_reviewers: Vec<GitHubUser>,
    pub assignees: Vec<GitHubUser>,
    pub milestone: Option<GitHubMilestone>,
    /// GraphQL node id (draft ↔ ready for review).
    pub node_id: Option<String>,
    pub checks: GitHubChecksSummary,
    pub reviews: Vec<GitHubReview>,
    pub comments: Vec<GitHubComment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestFile {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub changes: u32,
    pub patch: Option<String>,
    /// Patch omitted by the API (binary or too large) or clipped by the budget.
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestFiles {
    pub files: Vec<GitHubPullRequestFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullRequestCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub author_login: Option<String>,
    pub avatar_url: Option<String>,
    pub date: Option<String>,
}

/// Row of the Issue list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueSummary {
    pub number: u64,
    pub title: String,
    /// `open` or `closed`.
    pub state: String,
    /// `completed`, `not_planned` or `null`.
    pub state_reason: Option<String>,
    pub author: GitHubUser,
    pub created_at: String,
    pub updated_at: String,
    pub comments: u32,
    pub labels: Vec<GitHubLabel>,
    pub assignees: Vec<GitHubUser>,
    pub milestone: Option<String>,
    pub html_url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueList {
    pub items: Vec<GitHubIssueSummary>,
    pub page: u32,
    pub per_page: u32,
    pub has_next: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssueDetail {
    pub summary: GitHubIssueSummary,
    pub body: String,
    pub locked: bool,
    pub closed_at: Option<String>,
    pub milestone: Option<GitHubMilestone>,
    pub comments: Vec<GitHubComment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubMergeResult {
    pub merged: bool,
    pub message: String,
    pub sha: Option<String>,
}

/// List filters of the PR tab (all optional; the backend clamps/normalizes).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitHubPullRequestFilter {
    pub state: Option<String>,
    pub search: Option<String>,
    pub label: Option<String>,
    pub author: Option<String>,
    pub assignee: Option<String>,
    /// `owner:branch` for the REST `head` parameter; search receives the bare
    /// branch (the qualifier has no owner form).
    pub head: Option<String>,
    pub base: Option<String>,
    pub sort: Option<String>,
    pub direction: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

/// List filters of the Issue tab.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitHubIssueFilter {
    pub state: Option<String>,
    pub search: Option<String>,
    pub label: Option<String>,
    pub assignee: Option<String>,
    pub author: Option<String>,
    pub milestone: Option<String>,
    /// Milestone title used by the search qualifier (the API takes the name).
    pub milestone_title: Option<String>,
    pub sort: Option<String>,
    pub direction: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Start of the current local day in unix milliseconds. Used by the per-agent
/// daily budget. Resolves DST gaps by taking the earliest valid instant and
/// falls back to a 24 h window if the platform cannot resolve midnight.
pub fn local_day_start_ms(now: i64) -> i64 {
    use chrono::{Local, TimeZone};
    let Some(now_dt) = Local.timestamp_millis_opt(now).single() else {
        return now - 86_400_000;
    };
    let Some(naive) = now_dt.date_naive().and_hms_opt(0, 0, 0) else {
        return now - 86_400_000;
    };
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|value| value.timestamp_millis())
        .unwrap_or(now - 86_400_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_session_id_is_internal_and_never_accepted_from_ipc() {
        let options: TurnOptions =
            serde_json::from_str("{}").expect("TurnOptions com defaults");
        assert_eq!(options.wire_session_id, None);
        let json = serde_json::to_string(&options).expect("serialize TurnOptions");
        assert!(!json.contains("wireSessionId"), "{json}");
        assert!(!json.contains("wire_session_id"), "{json}");
    }

    #[test]
    fn settings_border_radius_enabled_defaults_to_true_and_uses_camel_case() {
        let settings: Settings = serde_json::from_str("{}").expect("Settings com defaults");
        assert!(settings.border_radius_enabled);

        let disabled: Settings =
            serde_json::from_str(r#"{"borderRadiusEnabled":false}"#).expect("disable radius");
        assert!(!disabled.border_radius_enabled);

        let json = serde_json::to_value(&disabled).expect("serialize settings");
        assert_eq!(json["borderRadiusEnabled"], false);
    }

    /// Auth-status DTOs are renderer-facing: they may carry account labels and
    /// masked ids, but never any credential material.
    #[test]
    fn auth_status_never_serializes_tokens() {
        let status = ProviderAuthStatus {
            provider_id: "openai".into(),
            mode: "oauth".into(),
            state: "signed-in".into(),
            account_label: Some("user@example.com".into()),
            plan_usage: true,
            expires_at: Some(1_700_000_000_000),
            scopes: vec!["openid".into(), "chatgpt.tokens.use.direct".into()],
            client_id_masked: Some("oaiapp…1234".into()),
            host_id_masked: Some("urn:uuid:…".into()),
            hint: None,
        };
        let json = serde_json::to_string(&status).expect("serialize auth status");
        for forbidden in ["access_token", "refresh_token", "id_token", "accessToken", "refreshToken"] {
            assert!(!json.contains(forbidden), "{forbidden} vazou no status: {json}");
        }
        assert!(json.contains("\"planUsage\":true"));
        assert!(json.contains("\"clientIdMasked\""));

        let view = SettingsView {
            settings: Settings::default(),
            keys: Vec::new(),
            auth: vec![status],
            secrets_error: None,
        };
        let json = serde_json::to_string(&view).expect("serialize settings view");
        assert!(json.contains("\"auth\""));
        assert!(json.contains("\"secretsError\":null"));
    }

    #[test]
    fn login_challenge_uses_camel_case() {
        let challenge = LoginChallenge {
            attempt_id: "a1".into(),
            auth_url: "https://auth.openai.com/api/accounts/authorize?x=1".into(),
            expires_at: 123,
            browser_opened: false,
            browser_error: Some("xdg-open ausente".into()),
        };
        let json = serde_json::to_value(&challenge).expect("serialize challenge");
        assert_eq!(json["attemptId"], "a1");
        assert_eq!(json["authUrl"], "https://auth.openai.com/api/accounts/authorize?x=1");
        assert_eq!(json["expiresAt"], 123);
        assert_eq!(json["browserOpened"], false);
        assert_eq!(json["browserError"], "xdg-open ausente");
    }

    /// O replay opaco do provedor fica só no backend (SQLite): o renderer nunca
    /// usou o campo e, a partir do formato v2, ele carrega o estado de todos os
    /// passos do loop — mandá-lo no IPC só inflaria as mensagens.
    #[test]
    fn provider_state_is_not_serialized_to_the_renderer() {
        let mut message = ChatMessage::assistant("conv-1");
        message.provider_state = Some(serde_json::json!({
            "version": 2,
            "steps": [{"state": {"output": []}, "text": "ok", "toolCallIds": []}],
        }));

        let json = serde_json::to_value(&message).expect("serialize assistant message");
        assert!(
            json.get("providerState").is_none(),
            "provider_state não deve cruzar o IPC: {json}"
        );

        // Desserialização continua tolerante (não quebra payloads antigos).
        let parsed: ChatMessage = serde_json::from_value(json).expect("deserialize message");
        assert!(parsed.provider_state.is_none());
    }

    #[test]
    fn detects_media_and_archive_kinds_by_extension_and_mime() {
        for (mime, name, expected) in [
            ("audio/mpeg", "trilha.mp3", ArtifactKind::Audio),
            ("audio/wav", "voz.wav", ArtifactKind::Audio),
            ("", "sem-extensao.ogg", ArtifactKind::Audio),
            ("audio/ogg", "audio", ArtifactKind::Audio),
            ("video/mp4", "demo.mp4", ArtifactKind::Video),
            ("video/webm", "captura.webm", ArtifactKind::Video),
            ("application/octet-stream", "clipe.mov", ArtifactKind::Video),
            ("video/mp4", "video", ArtifactKind::Video),
            ("application/zip", "pacote.zip", ArtifactKind::Archive),
            ("application/octet-stream", "backup.7z", ArtifactKind::Archive),
            ("application/x-tar", "fontes.tar", ArtifactKind::Archive),
            ("application/gzip", "dados.gz", ArtifactKind::Archive),
            ("image/tiff", "scan.tif", ArtifactKind::Image),
            ("image/x-icon", "icone.ico", ArtifactKind::Image),
        ] {
            assert_eq!(
                ArtifactKind::from_mime_and_name(mime, name),
                expected,
                "{name} ({mime})"
            );
        }
        // Tipos textuais continuam com a classificação anterior.
        assert_eq!(
            ArtifactKind::from_mime_and_name("text/markdown", "notas.md"),
            ArtifactKind::Markdown
        );
        assert_eq!(
            ArtifactKind::from_mime_and_name("text/plain", "LEIAME"),
            ArtifactKind::Text
        );
    }

    #[test]
    fn media_kinds_are_not_textual() {
        for kind in [ArtifactKind::Audio, ArtifactKind::Video, ArtifactKind::Archive] {
            assert!(!kind.is_textual(), "{kind:?} não é textual");
        }
        assert_eq!(
            serde_json::to_string(&ArtifactKind::Audio).expect("serialize"),
            "\"audio\""
        );
        assert_eq!(
            serde_json::to_string(&ArtifactKind::Archive).expect("serialize"),
            "\"archive\""
        );
    }

    #[test]
    fn new_preview_variants_serialize_with_the_ipc_kind_tag() {
        let image = serde_json::to_value(ArtifactPreview::Image {
            mime: "image/tiff".into(),
            width: Some(640),
            height: Some(480),
            data_base64: Some("iVBOR".into()),
        })
        .expect("serialize image preview");
        assert_eq!(image["kind"], "image");
        assert_eq!(image["width"], 640);
        assert_eq!(image["dataBase64"], "iVBOR");

        let archive = serde_json::to_value(ArtifactPreview::Archive {
            format: "zip".into(),
            entries: vec![ArchiveEntryPreview {
                name: "src/main.rs".into(),
                size: 120,
                compressed_size: 80,
                is_dir: false,
            }],
            total_entries: 1,
            truncated: false,
        })
        .expect("serialize archive preview");
        assert_eq!(archive["kind"], "archive");
        assert_eq!(archive["entries"][0]["isDir"], false);
        assert_eq!(archive["totalEntries"], 1);

        let binary = serde_json::to_value(ArtifactPreview::Binary {
            format: "application/octet-stream".into(),
            preview_base64: "AAEC".into(),
            preview_bytes: 3,
        })
        .expect("serialize binary preview");
        assert_eq!(binary["kind"], "binary");
        assert_eq!(binary["previewBytes"], 3);
    }

    /// Contrato da página Biblioteca (`list_library_artifacts`): o
    /// `serde(flatten)` precisa manter os campos de `Artifact` no topo, em
    /// camelCase, junto de `conversationTitle` — o renderer tipa o retorno como
    /// `LibraryArtifact extends Artifact`.
    #[test]
    fn library_artifact_serializes_flattened_with_camel_case() {
        let generated = LibraryArtifact {
            artifact: Artifact {
                id: "art-1".into(),
                conversation_id: Some("conv-1".into()),
                message_id: Some("msg-1".into()),
                name: "relatorio.md".into(),
                mime_type: "text/markdown".into(),
                kind: ArtifactKind::Markdown,
                language: Some("markdown".into()),
                size: 42,
                created_at: 1_700_000_000_000,
                favorite: true,
            },
            conversation_title: Some("Planejamento".into()),
        };
        let json = serde_json::to_value(&generated).expect("serialize library artifact");
        assert_eq!(json["id"], "art-1");
        assert_eq!(json["conversationId"], "conv-1");
        assert_eq!(json["messageId"], "msg-1");
        assert_eq!(json["mimeType"], "text/markdown");
        assert_eq!(json["createdAt"], 1_700_000_000_000_i64);
        assert_eq!(json["favorite"], true);
        assert_eq!(json["conversationTitle"], "Planejamento");
        // Achatado: nada de subobjeto `artifact` vazando no IPC.
        assert!(json.get("artifact").is_none());

        let upload = LibraryArtifact {
            artifact: Artifact {
                conversation_id: None,
                message_id: None,
                favorite: false,
                ..generated.artifact
            },
            conversation_title: None,
        };
        let json = serde_json::to_value(&upload).expect("serialize upload");
        assert!(json["conversationId"].is_null(), "upload não tem conversa");
        assert!(json["conversationTitle"].is_null());
        assert_eq!(json["favorite"], false);
    }

    #[test]
    fn artifact_thumbnail_uses_camel_case_for_the_ipc_payload() {
        let thumbnail = ArtifactThumbnail {
            mime: "image/png".into(),
            data_base64: "iVBOR".into(),
            width: 512,
            height: 288,
        };
        let json = serde_json::to_value(&thumbnail).expect("serialize thumbnail");
        assert_eq!(json["mime"], "image/png");
        assert_eq!(json["dataBase64"], "iVBOR");
        assert_eq!(json["width"], 512);
        assert_eq!(json["height"], 288);
    }

    /// Contrato da separação Chat/Code: o renderer lê `mode` e `codeLinked` no
    /// IPC (camelCase) e precisa receber `mode` mesmo em conversas antigas.
    #[test]
    fn conversation_serializes_mode_and_code_linked_in_camel_case() {
        let conversation = Conversation {
            id: "conv-1".into(),
            title: "Projeto Aurora".into(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_001_000,
            pinned: false,
            sort_order: 0,
            provider_id: "opencode-go".into(),
            model_id: "glm-5.3-flash".into(),
            message_count: 3,
            preview: Some("primeira pergunta".into()),
            mode: CONVERSATION_MODE_CODE.to_string(),
            code_linked: true,
            workspace_id: Some("ws-1".into()),
            agent_kind: "zylara".into(),
            permission_mode: PermissionMode::Edit,
            parent_conversation_id: None,
            subagent_task_call_id: None,
            subagent_type: None,
            agent_id: None,
            channel_id: None,
            task_id: None,
            is_main: false,
        };
        let json = serde_json::to_value(&conversation).expect("serialize conversation");
        assert_eq!(json["mode"], "code");
        assert_eq!(json["codeLinked"], true);
        assert!(
            json.get("code_linked").is_none(),
            "o IPC usa camelCase: {json}"
        );
        // Sessão criada no Code nunca nasce compartilhada; o campo é lido como
        // enviado (a regra de vínculo é do `Db`).
        assert_eq!(conversation.mode, CONVERSATION_MODE_CODE);
        assert!(conversation.code_linked);

        // Payloads antigos (sem os campos novos) continuam desserializáveis e
        // caem no modo Chat, sem vínculo.
        let legacy = serde_json::json!({
            "id": "conv-2",
            "title": "Conversa antiga",
            "createdAt": 10,
            "updatedAt": 20,
            "pinned": false,
            "providerId": "opencode-go",
            "modelId": "glm-5.3-flash",
            "messageCount": 0,
            "preview": null,
        });
        let parsed: Conversation =
            serde_json::from_value(legacy).expect("deserialize legacy conversation");
        assert_eq!(parsed.mode, CONVERSATION_MODE_CHAT);
        assert!(!parsed.code_linked);
    }

    #[test]
    fn normalizes_unknown_conversation_modes_to_chat() {
        assert_eq!(conversation_mode_or_default(None), CONVERSATION_MODE_CHAT);
        assert_eq!(
            conversation_mode_or_default(Some("")),
            CONVERSATION_MODE_CHAT
        );
        assert_eq!(
            conversation_mode_or_default(Some("   ")),
            CONVERSATION_MODE_CHAT
        );
        assert_eq!(
            conversation_mode_or_default(Some("chat")),
            CONVERSATION_MODE_CHAT
        );
        assert_eq!(
            conversation_mode_or_default(Some("code")),
            CONVERSATION_MODE_CODE
        );
        assert_eq!(
            conversation_mode_or_default(Some(" code ")),
            CONVERSATION_MODE_CODE,
            "espaços em volta do modo são tolerados"
        );
        assert_eq!(
            conversation_mode_or_default(Some("agent")),
            CONVERSATION_MODE_AGENT
        );
        for invalid in ["Chat", "CODE", "codex", "workspace", "projeto"] {
            assert_eq!(
                conversation_mode_or_default(Some(invalid)),
                CONVERSATION_MODE_CHAT,
                "{invalid:?} não é um modo válido"
            );
        }
    }
}
