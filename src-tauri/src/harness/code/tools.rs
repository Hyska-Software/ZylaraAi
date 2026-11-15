//! Execução das tools do perfil Code no loop de turno.
//!
//! O loop do harness (Lead) chama [`execute`] para cada `ToolCallRecord` quando
//! o perfil é `Code`. A implementação de cada tool vive em
//! [`crate::tools::code::exec`] (execução) e os metadados/schemas em
//! [`crate::tools::registry`] — este módulo só faz a ponte e o parsing de
//! argumentos, mantendo o loop independente das tools.

use serde_json::Value;

use crate::domain::ToolCallRecord;
use crate::tools::registry::{ToolCtx, ToolExec};
use crate::tools::ToolOutcome;

/// Parseia os argumentos JSON da chamada (objeto raiz).
pub fn parse_arguments(raw: &str) -> Result<Value, ToolOutcome> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::json!({}));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(map)) => Ok(Value::Object(map)),
        Ok(Value::Null) => Ok(serde_json::json!({})),
        Ok(_) => Err(ToolOutcome::error(
            "TOOL_INVALID_ARGS: os argumentos da ferramenta devem ser um objeto JSON",
        )),
        Err(error) => Err(ToolOutcome::error(format!(
            "TOOL_INVALID_ARGS: argumentos da ferramenta não são JSON válido: {error}"
        ))),
    }
}

/// Timeout padrão por tool (o shell tem timeout próprio vindo dos argumentos).
fn default_timeout_ms(name: &str) -> Option<u64> {
    match name {
        "read_file" | "list_dir" | "search_files" | "search_text" | "read_tool_output"
        | "git_status" | "git_diff" | "git_log" => Some(30_000),
        "write_file" | "edit_file" => Some(30_000),
        "validate_ui" => Some(10_000),
        "todo_write" => Some(60_000),
        // `submit_plan` waits for the plan review without a deadline (only turn
        // cancellation); `ask_user` uses `settings.approval_timeout_secs`,
        // never a short runtime cap (B-03; `TOOLS.md` §4).
        // `run_command` aplica o `timeout_ms` dos argumentos dentro da tool.
        _ => None,
    }
}

/// Executa uma tool do perfil Code. Nunca entra em pânico: falhas viram
/// `ToolOutcome` de erro com código estável.
///
/// Tools dinâmicas de servidores MCP (`mcp__servidor__tool`) não estão no
/// registry estático; elas são executadas pelo mesmo caminho (aprovação,
/// timeout) através de [`crate::tools::code::exec::run_mcp`].
pub async fn execute(ctx: &ToolCtx, call: &ToolCallRecord) -> ToolOutcome {
    // The turn catalog is the execution boundary. Without this check, a
    // hallucinated tool (or one filtered out by workspace/shell/depth) would be
    // dispatched by the static registry — in a subagent that would open
    // `ask_user`, plan, `goal` and MCP in a turn whose events are discarded.
    if !ctx.is_tool_enabled(&call.name) {
        let known = call.name.starts_with("mcp__") || ToolExec::for_tool(&call.name).is_some();
        return if known {
            ToolOutcome::error(format!(
                "TOOL_NOT_ENABLED: a ferramenta `{}` não está habilitada neste turno",
                call.name
            ))
        } else {
            ToolOutcome::error(format!(
                "TOOL_UNKNOWN: ferramenta desconhecida: {}",
                call.name
            ))
        };
    }
    let args = match parse_arguments(&call.arguments) {
        Ok(args) => args,
        Err(outcome) => return outcome,
    };
    // Contexto por chamada: o id da tool call é usado por progresso, aprovação e
    // apresentação (`presentation`) do card correto.
    let mut call_ctx = ctx.clone();
    call_ctx.tool_call_id = call.id.clone();
    if let Some(manager) = crate::plugins::global_manager() {
        if let Some((plugin_id, tool)) = manager.tool_owner(&call.name) {
            use crate::domain::RiskClass;
            let risk = match tool.risk.as_str() {
                "write" => RiskClass::Write,
                "shell" => RiskClass::Shell,
                "network" => RiskClass::Network,
                _ => RiskClass::Read,
            };
            if matches!(risk, RiskClass::Write | RiskClass::Shell)
                && call_ctx.workspace.is_some()
            {
                let detail = crate::domain::ApprovalDetail::Other {
                    text: format!(
                        "Plugin `{plugin_id}` tool `{}` requested this action.",
                        tool.name
                    ),
                };
                if let Err(outcome) = crate::tools::code::exec::policy_check(
                    &call_ctx,
                    &call.name,
                    risk,
                    true,
                    None,
                    false,
                    None,
                    detail,
                    "Plugin tool",
                )
                .await
                {
                    let _ = manager.db().plugin_audit(
                        &plugin_id,
                        &format!("approval:{}", tool.name),
                        None,
                        "denied",
                    );
                    return outcome;
                }
                let _ = manager.db().plugin_audit(
                    &plugin_id,
                    &format!("approval:{}", tool.name),
                    None,
                    "allowed",
                );
            }
            return manager
                .execute_tool(
                    &plugin_id,
                    &tool,
                    args,
                    &call_ctx.conversation_id,
                    &call_ctx.turn_id,
                    &call_ctx.cancel,
                )
                .await;
        }
    }
    if call.name.starts_with("mcp__") {
        return crate::tools::code::exec::run_mcp(&call_ctx, &call.name, args).await;
    }
    if call.name == "memory" {
        return run_memory(&call_ctx, args);
    }
    if call.name == "skill_save" {
        return crate::tools::skills::run_save_with(&call_ctx.data_dir, &args);
    }
    if crate::tools::agents::is_agent_tool(&call.name) {
        return run_agent_tool(&call_ctx, &call.name, args);
    }
    if call.name == "task_wait" {
        return run_task_wait(&call_ctx, args).await;
    }
    if crate::tools::tasks::is_delegation_tool(&call.name) {
        return run_delegation(&call_ctx, &call.name, args);
    }
    if crate::tools::code::computer::is_computer_tool(&call.name) {
        return crate::tools::code::computer::run(&call_ctx, &call.name, &args).await;
    }
    let Some(exec) = ToolExec::for_tool(&call.name) else {
        return ToolOutcome::error(format!(
            "TOOL_UNKNOWN: ferramenta desconhecida: {}",
            call.name
        ));
    };
    // Timeout do contrato aplicado pelo runtime (nunca "decorativo").
    match default_timeout_ms(&call.name) {
        Some(timeout) => {
            match tokio::time::timeout(
                std::time::Duration::from_millis(timeout),
                exec.execute(&call_ctx, args),
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(_) => ToolOutcome::error(format!(
                    "TOOL_TIMEOUT: a ferramenta `{}` excedeu {timeout} ms",
                    call.name
                )),
            }
        }
        None => exec.execute(&call_ctx, args).await,
    }
}

/// Durable memory tool for Code-profile agent turns. The conversation is the
/// authority for the persona; a normal Code session has no `agent_id` and the
/// tool is not exposed to the model.
fn run_memory(ctx: &ToolCtx, args: Value) -> ToolOutcome {
    let conversation = match ctx.db.get_conversation(&ctx.conversation_id) {
        Ok(Some(conversation)) => conversation,
        Ok(None) => return ToolOutcome::error("MEMORY_NO_CONVERSATION: conversa não encontrada"),
        Err(error) => {
            return ToolOutcome::error(format!("MEMORY_DB_ERROR: {error:#}"));
        }
    };
    let Some(agent_id) = conversation.agent_id.as_deref() else {
        return ToolOutcome::error("a memória durável só existe em conversas de um agente");
    };
    let agent = match ctx.db.get_agent(agent_id) {
        Ok(Some(agent)) => agent,
        Ok(None) => return ToolOutcome::error("MEMORY_NO_AGENT: agente não encontrado"),
        Err(error) => {
            return ToolOutcome::error(format!("MEMORY_DB_ERROR: {error:#}"));
        }
    };
    if !agent.memory_enabled {
        return ToolOutcome::error("a memória deste agente está desativada");
    }
    crate::tools::memory::run_with(&ctx.db, agent_id, &ctx.conversation_id, &args)
}

/// Agent-only tools (directory/usage/routines). The persona comes from the
/// conversation, never from the model.
fn run_agent_tool(ctx: &ToolCtx, tool: &str, args: Value) -> ToolOutcome {
    let conversation = match ctx.db.get_conversation(&ctx.conversation_id) {
        Ok(Some(conversation)) => conversation,
        Ok(None) => return ToolOutcome::error("AGENT_TOOL_INVALID: conversa não encontrada"),
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let Some(agent_id) = conversation.agent_id.as_deref() else {
        return ToolOutcome::error("as ferramentas de agente só existem em conversas de um agente");
    };
    crate::tools::agents::run_with_hooks(&ctx.db, agent_id, tool, &args, &ctx.settings, ctx.agent_hooks.as_deref())
}

/// `task_wait` is async and must not go through the synchronous delegation
/// dispatcher.
async fn run_task_wait(ctx: &ToolCtx, args: Value) -> ToolOutcome {
    let conversation = match ctx.db.get_conversation(&ctx.conversation_id) {
        Ok(Some(conversation)) => conversation,
        Ok(None) => return ToolOutcome::error("AGENT_TASK_INVALID: conversa não encontrada"),
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let Some(agent_id) = conversation.agent_id.as_deref() else {
        return ToolOutcome::error("as ferramentas de tarefa só existem em conversas de um agente");
    };
    crate::tools::tasks::wait_for_task(
        &ctx.db,
        agent_id,
        &ctx.conversation_id,
        &args,
        &ctx.cancel,
    )
    .await
}

/// Delegation tools for the Code profile. The conversation resolves the
/// persona; a normal Code session has no agent and the tools are not exposed.
fn run_delegation(ctx: &ToolCtx, tool: &str, args: Value) -> ToolOutcome {
    let conversation = match ctx.db.get_conversation(&ctx.conversation_id) {
        Ok(Some(conversation)) => conversation,
        Ok(None) => return ToolOutcome::error("AGENT_TASK_INVALID: conversa não encontrada"),
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let Some(agent_id) = conversation.agent_id.as_deref() else {
        return ToolOutcome::error("a delegação só existe em conversas de um agente");
    };
    crate::tools::tasks::run_with_hooks(&ctx.db, agent_id, &ctx.conversation_id, tool, &args, ctx.agent_hooks.as_deref())
}

/// Executa um lote de chamadas respeitando o scheduler do registry
/// (`Safe` em paralelo, `PathLocked` por arquivo, `Exclusive` como barreira) e
/// devolve os resultados na ordem original das chamadas.
pub async fn execute_batch(ctx: &ToolCtx, calls: &[ToolCallRecord]) -> Vec<ToolOutcome> {
    use crate::domain::TurnProfile;
    use crate::tools::pipeline::{plan, plan_with_limit, ToolCallRequest};
    use crate::tools::registry::find_spec;

    let mut indexed: Vec<(usize, ToolCallRequest)> = Vec::new();
    for (index, call) in calls.iter().enumerate() {
        if let Some(spec) = find_spec(TurnProfile::Code, &call.name) {
            indexed.push((index, ToolCallRequest::new(call.clone(), spec)));
        }
    }
    let mut outcomes: Vec<Option<ToolOutcome>> = vec![None; calls.len()];
    let requests: Vec<ToolCallRequest> =
        indexed.iter().map(|(_, request)| request.clone()).collect();
    // A worker edits files and runs commands (which can bypass the journal), so
    // it must not overlap another read, write, command or worker in the step.
    let serial = calls.iter().any(|call| {
        call.name == "task" && crate::harness::code::subagent::is_worker_call(&call.arguments)
    });
    let batches = if serial {
        plan_with_limit(&requests, 1)
    } else {
        plan(&requests)
    };
    for batch in batches {
        let batch_futures = batch.iter().map(|&request_index| {
            let call = indexed[request_index].1.call.clone();
            async move { (request_index, execute(ctx, &call).await) }
        });
        for (request_index, outcome) in futures_util::future::join_all(batch_futures).await {
            let (call_index, _) = &indexed[request_index];
            outcomes[*call_index] = Some(outcome);
        }
    }
    // Tools MCP/plugin são dinâmicas (não estão no registry estático) e rodam
    // depois do lote, em ordem: aprovação e RPC podem depender do usuário.
    let plugin_manager = crate::plugins::global_manager();
    for (index, call) in calls.iter().enumerate() {
        if outcomes[index].is_some() {
            continue;
        }
        let is_plugin = plugin_manager
            .as_ref()
            .is_some_and(|manager| manager.tool_owner(&call.name).is_some());
        if call.name.starts_with("mcp__") || is_plugin {
            outcomes[index] = Some(execute(ctx, call).await);
        }
    }
    outcomes
        .into_iter()
        .enumerate()
        .map(|(index, outcome)| {
            outcome.unwrap_or_else(|| {
                ToolOutcome::error(format!(
                    "TOOL_UNKNOWN: ferramenta `{}` não está disponível no perfil Code",
                    calls[index].name
                ))
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arguments_objects_only() {
        assert!(parse_arguments("").expect("vazio").is_object());
        assert!(parse_arguments("{\"a\":1}").expect("objeto").is_object());
        assert!(parse_arguments("[]").is_err());
        assert!(parse_arguments("{oops").is_err());
    }

    #[test]
    fn human_review_tools_have_no_runtime_timeout() {
        // A revisão humana não pode morrer no teto curto do runtime (B-03).
        assert_eq!(default_timeout_ms("submit_plan"), None);
        assert_eq!(default_timeout_ms("ask_user"), None);
        // Ferramentas rápidas continuam protegidas.
        assert_eq!(default_timeout_ms("todo_write"), Some(60_000));
        assert_eq!(default_timeout_ms("write_file"), Some(30_000));
        assert_eq!(default_timeout_ms("validate_ui"), Some(10_000));
    }

    #[tokio::test]
    async fn validate_ui_is_dispatched_through_the_code_executor() {
        let ctx = test_ctx();
        let mut call = ToolCallRecord::running("call-validate", "validate_ui");
        call.arguments = serde_json::json!({
            "block": "{\"components\":[{\"type\":\"card\",\"props\":{\"title\":\"Resumo\"}}]}"
        })
        .to_string();
        let outcome = execute(&ctx, &call).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("\"ok\":true"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn unknown_tool_is_an_actionable_error() {
        let ctx = test_ctx();
        let mut call = ToolCallRecord::running("call-1", "nope");
        call.arguments = "{}".to_string();
        let outcome = execute(&ctx, &call).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("TOOL_UNKNOWN"));
    }

    #[tokio::test]
    async fn tool_outside_the_turn_catalog_is_rejected_before_execution() {
        let mut ctx = test_ctx();
        ctx.enabled_tools = std::sync::Arc::new(
            ["read_file".to_string()].into_iter().collect(),
        );
        for name in ["write_file", "ask_user", "mcp__fake__echo", "task"] {
            let call = ToolCallRecord::running(format!("call-{name}"), name);
            let outcome = execute(&ctx, &call).await;
            assert!(outcome.is_error, "{name} deveria falhar");
            assert!(
                outcome.content.contains("TOOL_NOT_ENABLED"),
                "{name}: {}",
                outcome.content
            );
        }
    }

    fn test_ctx() -> ToolCtx {
        ToolCtx {
            db: std::sync::Arc::new(crate::db::Db::open_in_memory().expect("db")),
            http: reqwest::Client::new(),
            conversation_id: "conv-1".into(),
            message_id: "msg-1".into(),
            tool_call_id: "call-1".into(),
            turn_id: "turn-1".into(),
            workspace: None,
            settings: crate::domain::Settings::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
            agent_hooks: None,
            data_dir: std::env::temp_dir().join("zylara-code-tools-test"),
            approval: None,
            observed: None,
            journal_owner: None,
            jobs: None,
            questions: None,
            turn_kind: crate::domain::TurnKind::User,
            mcp: None,
            subagent: None,
            enabled_tools: std::sync::Arc::new(
                crate::tools::registry::code_spec_refs()
                    .into_iter()
                    .map(|spec| spec.name.to_string())
                    .collect(),
            ),
            subagent_budget: std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0)),
            subagent_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(
                crate::harness::code::subagent::MAX_CONCURRENT_SUBAGENTS,
            )),
            skills_roots: Vec::new(),
            allowed_skills: None,
            emit: None,
            rules: Vec::new(),
        }
    }
}
