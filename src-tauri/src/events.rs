//! Streaming events emitted by the harness to the React renderer.
//!
//! Serialised as `{ "type": "...", ...camelCaseFields }` and delivered on the
//! `zylara:turn-event` bus envelope `{ turnId, seq, conversationId, event }`.

use serde::Serialize;

use crate::domain::{
    Artifact, CacheSample, ChatMessage, Citation, ToolCallRecord, TurnResult, UsageInfo,
};

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TurnEvent {
    /// The turn was accepted (registered) and may still be waiting for a
    /// concurrency slot or the workspace lock. Emitted before any wait.
    Queued,
    /// The user message was persisted and the assistant placeholder created.
    TurnStarted {
        turn_id: String,
        user_message_id: String,
        assistant_message_id: String,
    },
    /// A new model round started (step 1 = first completion, 2+ = after tools).
    StepStarted { step: u32 },
    /// The step is being retried after a transient provider failure (or after
    /// an OAuth refresh). No new timeline step is created; the renderer shows
    /// the wait in the live status.
    Retrying {
        /// Attempt about to start (1-based).
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        /// `transient` | `auth_refresh`
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Reasoning / thinking stream delta.
    ReasoningDelta { delta: String },
    ReasoningDone,
    /// Final answer text delta.
    TextDelta { delta: String },
    /// A tool call started streaming its arguments.
    ToolCallStarted { tool_call: ToolCallRecord },
    /// The step's batch reached execution. `started_at` is authoritative for
    /// the live duration (the stream start above is not execution time).
    ToolCallExecuting { id: String, started_at: i64 },
    /// JSON arguments delta for a streaming tool call.
    ToolCallArgs { id: String, delta: String },
    /// Tool execution finished.
    ToolCallFinished {
        id: String,
        status: String,
        result: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default)]
        citations: Vec<Citation>,
        /// Apresentação estruturada (diff/todo/plano/job) para o card ao vivo.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        presentation: Option<serde_json::Value>,
        /// Authoritative execution end, paired with `ToolCallExecuting`.
        finished_at: i64,
    },
    /// A file artifact was created by the agent.
    ArtifactCreated { artifact: Artifact },
    /// Token usage for the turn (may be emitted once at the end).
    Usage { usage: UsageInfo },
    /// Cache telemetry for one provider request (wire request), emitted per step
    /// in both profiles so the context meter can show cache hit in real time.
    CacheStats { sample: CacheSample },
    /// A persisted message snapshot (used for resync / title updates).
    MessageUpdated { message: ChatMessage },
    /// Conversation title was auto-generated.
    TitleUpdated {
        conversation_id: String,
        title: String,
    },
    /// The turn finished successfully.
    Done { result: TurnResult },
    /// The user cancelled the turn.
    Cancelled,
    /// Something went wrong; the assistant message keeps partial content.
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        /// Actionable hint for the renderer (e.g. "Entre novamente para usar
        /// seu plano ChatGPT"), separate from the raw provider message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        /// A manual retry may succeed (transient/network/timeout/auth).
        #[serde(default)]
        retryable: bool,
        /// Provider requests made by the failed step (0 = none attempted).
        #[serde(default)]
        attempts: u32,
    },

    /* ------------------------------------------------------------------ */
    /* Harness de código (docs/goals/code-harness/HARNESS.md §12)          */
    /* ------------------------------------------------------------------ */
    /// Uma tool pausou o turno pedindo permissão ao usuário.
    ApprovalRequested {
        approval: crate::domain::ApprovalRequest,
    },
    /// A aprovação pendente foi resolvida (pelo usuário, regra, timeout ou cancelamento).
    ApprovalResolved {
        approval_id: String,
        decision: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    /// Saída incremental de uma tool (shell/job) para o card ao vivo.
    ToolProgress {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream: Option<String>,
        delta: String,
    },
    /// Um arquivo foi criado/alterado/removido pelo agente neste turno.
    FileChanged {
        change: crate::domain::FileChange,
    },
    /// Resumo das alterações do turno (journal + working tree), emitido no fecho.
    WorkspaceChanges {
        summary: crate::domain::ChangesSummary,
    },
    /// Lista de tarefas do agente mudou (substituição integral).
    TodosUpdated {
        todos: Vec<crate::domain::TodoItem>,
    },
    /// Estado do modo Plano mudou (entrou, plano submetido, aprovado, saiu).
    PlanUpdated {
        plan: crate::domain::PlanView,
    },
    /// Estado do objetivo persistente da sessão mudou (criação, rodada,
    /// progresso, pausa, conclusão, bloqueio ou encerramento).
    GoalUpdated {
        goal: crate::domain::GoalView,
    },
    /// Medidor de contexto do turno (tokens estimados/janela).
    ContextStats {
        stats: crate::domain::ContextStats,
    },
    /// O contexto foi compactado (resumo aplicado à janela do modelo).
    Compacted {
        messages: u32,
        tokens_freed: u32,
    },
    /// Um job de processo em background mudou de estado.
    JobUpdated {
        job: crate::domain::JobView,
    },
    /// Perfil/modo da sessão mudou (permission mode, plan mode, profile).
    ProfileChanged {
        profile: String,
        permission_mode: String,
        plan_mode: bool,
    },
    /// O agente pediu uma decisão/resposta ao usuário (`ask_user`).
    QuestionRequested {
        request: crate::domain::AskUserRequest,
    },
    /// A pergunta pendente foi respondida (ou pulada).
    QuestionResolved {
        request_id: String,
        answers: Vec<crate::domain::AskUserAnswer>,
        skipped: bool,
    },

    /* ------------------------------------------------------------------ */
    /* Subagent live transcript (retained child conversation)              */
    /* ------------------------------------------------------------------ */
    /// A child agent started; the UI opens a live entry under the `task` call.
    SubagentStarted {
        task_call_id: String,
        conversation_id: String,
        subagent_type: String,
        description: String,
        prompt: String,
        provider_id: String,
        model_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    /// One filtered child event (reasoning/text/tool/usage/error) for the live card.
    SubagentEvent {
        task_call_id: String,
        event: Box<TurnEvent>,
    },
    /// The child finished (done/error/cancelled); transcript id is retained.
    SubagentFinished {
        task_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<UsageInfo>,
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_event_serializes_as_a_bare_tag() {
        let value = serde_json::to_value(TurnEvent::Queued).expect("serialize queued");
        assert_eq!(value, serde_json::json!({ "type": "queued" }));
    }

    #[test]
    fn subagent_events_serialize_with_camel_case_and_nested_payload() {
        let value = serde_json::to_value(TurnEvent::SubagentEvent {
            task_call_id: "task-1".to_string(),
            event: Box::new(TurnEvent::TextDelta {
                delta: "hello".to_string(),
            }),
        })
        .expect("serialize subagent event");
        assert_eq!(value["type"], "subagent_event");
        assert_eq!(value["taskCallId"], "task-1");
        assert_eq!(value["event"]["type"], "text_delta");
        assert_eq!(value["event"]["delta"], "hello");
    }

    #[test]
    fn tool_execution_timestamps_serialize_in_camel_case() {
        let executing = serde_json::to_value(TurnEvent::ToolCallExecuting {
            id: "tool-1".to_string(),
            started_at: 1_000,
        })
        .expect("serialize executing");
        assert_eq!(executing["type"], "tool_call_executing");
        assert_eq!(executing["id"], "tool-1");
        assert_eq!(executing["startedAt"], 1_000);

        let finished = serde_json::to_value(TurnEvent::ToolCallFinished {
            id: "tool-1".to_string(),
            status: "done".to_string(),
            result: "ok".to_string(),
            summary: None,
            citations: Vec::new(),
            presentation: None,
            finished_at: 2_500,
        })
        .expect("serialize finished");
        assert_eq!(finished["type"], "tool_call_finished");
        assert_eq!(finished["finishedAt"], 2_500);
    }
}

/// Eventos de streaming de um terminal PTY (layout Code).
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    /// Bytes decodificados (UTF-8 lossy) do terminal.
    Data { data: String },
    /// O shell do terminal terminou.
    Exit { code: Option<i32> },
}