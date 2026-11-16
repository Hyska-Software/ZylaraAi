//! Execução real das tools do perfil Code (F2/F3/F4).
//!
//! Cada braço de [`run`] implementa uma das 14 tools do catálogo (`registry`),
//! usando os módulos de apoio já publicados:
//! - `workspace::safe_path` (confinamento ao workspace),
//! - `workspace::exec` (shell/timeout/cancelamento/env higienizado),
//! - `workspace::git` (status/diff/log read-only),
//! - `workspace::journal` (hashes, line stats, diff unificado, object store),
//! - `harness::code::{observed, session}` (read-before-write e projeções),
//! - `policy` (matriz de permissões + aprovação interativa).
//!
//! Regras de ouro: mensagens do app via `crate::i18n` (en/pt-BR/es), códigos
//! estáveis (`FS_*`, `POLICY_*`, `APPROVAL_*`…), nunca `panic`/`unwrap` em dado
//! do usuário, todo resultado grande vai para spill com caminho de recuperação
//! (`read_tool_output`).

use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::domain::{
    now_ms, ApprovalDetail, ApprovalOption, ApprovalRequest, ApprovalScope, CreateGoalInput,
    FileChange, FileChangeKind, GoalOrigin, GoalView, PermissionMode, RiskClass, TodoItem, TurnKind,
    UpdateGoalInput,
};
use crate::harness::code::{goal, observed::ObservationState, session};
use crate::policy::{decide, CallFacts, PolicyContext, PolicyDecision};
use crate::tools::registry::{ToolCtx, ToolExec};
use crate::tools::ToolOutcome;
use crate::workspace::{exec, git, journal, safe_path};

/// Limite de texto que volta ao modelo antes de ir para spill.
pub const MAX_INLINE_CHARS: usize = 24_000;
const SPILL_HEAD_CHARS: usize = 12_000;
const SPILL_TAIL_CHARS: usize = 4_000;
/// Teto de leitura de arquivo por chamada (TOOLS.md §2.1).
const MAX_READ_BYTES: u64 = 5 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIFF_CHARS: usize = 4_000;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_LIST_ENTRIES: usize = 400;
const MAX_LINE_CHARS: usize = 2_000;
/// Sanity floor for `submit_plan`: a one-line plan cannot guide an
/// implementation. This is not a quality metric, only a guard against
/// degenerate submissions; the prompt contract carries the real quality bar.
const MIN_PLAN_CHARS: usize = 300;

/// Ponto de entrada único das tools de código.
pub async fn run(ctx: &ToolCtx, exec: ToolExec, args: Value) -> ToolOutcome {
    match exec {
        ToolExec::ReadFile => read_file(ctx, &args).await,
        ToolExec::ListDir => list_dir(ctx, &args).await,
        ToolExec::SearchFiles => search_files(ctx, &args).await,
        ToolExec::SearchText => search_text(ctx, &args).await,
        ToolExec::ReadToolOutput => read_tool_output(ctx, &args).await,
        ToolExec::GitStatus => git_status(ctx, &args).await,
        ToolExec::GitDiff => git_diff(ctx, &args).await,
        ToolExec::GitLog => git_log(ctx, &args).await,
        ToolExec::WriteFile => write_file(ctx, &args).await,
        ToolExec::EditFile => edit_file(ctx, &args).await,
        ToolExec::RunCommand => run_command(ctx, &args).await,
        ToolExec::RunChecks => run_checks(ctx, &args).await,
        ToolExec::JobList => job_list(ctx, &args).await,
        ToolExec::JobOutput => job_output(ctx, &args).await,
        ToolExec::JobKill => job_kill(ctx, &args).await,
        ToolExec::TodoWrite => todo_write(ctx, &args).await,
        ToolExec::SubmitPlan => submit_plan(ctx, &args).await,
        ToolExec::AskUser => ask_user(ctx, &args).await,
        ToolExec::Goal => goal_tool(ctx, &args),
        ToolExec::Task => run_task(ctx, &args).await,
        ToolExec::ValidateUi => validate_ui(ctx, &args),
        ToolExec::InstallPlugin => crate::tools::plugins::run_code(ctx, &args).await,
        ToolExec::ValidatePlugin => crate::tools::plugins::run_validate(ctx, &args),
        ToolExec::PluginStudio => crate::tools::plugins_studio::run_code(ctx, &args).await,
        ToolExec::WebSearch | ToolExec::FetchUrl | ToolExec::ListSkills | ToolExec::ReadSkill => {
            bridge_chat_tool(ctx, exec.name(), &args).await
        }
    }
}

/* ------------------------------------------------------------------ */
/* Helpers: erro, args, workspace e spill                              */
/* ------------------------------------------------------------------ */

/// `ask_user`: pergunta com opções (single/multi + texto livre) e aguarda a
/// resposta do usuário pelo card da timeline (`respond_question`).
async fn ask_user(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let Some(registry) = ctx.questions.clone() else {
        return err(
            "ASK_USER_UNAVAILABLE",
            crate::i18n::t("tools.exec.askUser.unavailable"),
        );
    };
    let request = match crate::harness::code::questions::normalize_questions(
        args,
        &ctx.conversation_id,
        &ctx.message_id,
    ) {
        Ok(request) => request,
        Err(message) => return ToolOutcome::error(message),
    };
    let timeout = std::time::Duration::from_secs(ctx.settings.approval_timeout_secs.max(60) as u64);
    let response = crate::harness::code::questions::request_user_answers(
        registry.as_ref(),
        ctx.emit.clone(),
        request,
        timeout,
        &ctx.cancel,
    )
    .await;
    let content = crate::harness::code::questions::response_content(&response);
    ToolOutcome {
        content,
        summary: Some(if response.skipped {
            crate::i18n::t("tools.exec.askUser.skipped")
        } else {
            crate::i18n::t_args(
                "tools.exec.askUser.answered",
                &[("count", &response.answers.len().to_string())],
            )
        }),
        presentation: Some(serde_json::json!({
            "kind": "answers",
            "answers": response.answers,
            "skipped": response.skipped,
        })),
        ..Default::default()
    }
}

fn err(code: &str, message: impl Into<String>) -> ToolOutcome {
    ToolOutcome::error(format!("{code}: {}", message.into()))
}

/// `validate_ui`: local validation of a generative UI block. The response is
/// the same JSON contract used by Chat (`{ ok, summary, errors, warnings,
/// normalized }`); it never touches the workspace and is not an error when the
/// UI has diagnostics. Large normalized trees go to spill like any tool result.
fn validate_ui(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let outcome = crate::tools::genui::run(args);
    if outcome.is_error {
        return outcome;
    }
    finish(ctx, outcome.content, outcome.summary, outcome.presentation)
}

fn arg_str(args: &Value, key: &str) -> Result<String, ToolOutcome> {
    match args.get(key).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        Some(_) => Err(err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t_args("tools.exec.args.cannotBeEmpty", &[("key", key)]),
        )),
        None => Err(err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t_args("tools.exec.args.required", &[("key", key)]),
        )),
    }
}

fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn opt_u32(args: &Value, key: &str) -> Option<u32> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn opt_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn opt_string_array(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn workspace_handle(ctx: &ToolCtx) -> Result<&crate::tools::registry::WorkspaceHandle, ToolOutcome> {
    ctx.workspace.as_ref().ok_or_else(|| {
        err(
            "FS_NO_WORKSPACE",
            crate::i18n::t("tools.exec.workspace.none"),
        )
    })
}

fn workspace_root(ctx: &ToolCtx) -> Result<PathBuf, ToolOutcome> {
    Ok(workspace_handle(ctx)?.root.clone())
}

/// Workspace para operações que mutam o disco: exige pasta confiável.
fn writable_root(ctx: &ToolCtx) -> Result<PathBuf, ToolOutcome> {
    let workspace = workspace_handle(ctx)?;
    if !workspace.trusted {
        return Err(err(
            "FS_UNTRUSTED_WORKSPACE",
            crate::i18n::t("tools.exec.workspace.untrusted"),
        ));
    }
    Ok(workspace.root.clone())
}

fn resolve_path(ctx: &ToolCtx, requested: &str, access: safe_path::Access) -> Result<PathBuf, ToolOutcome> {
    let workspace = workspace_handle(ctx)?;
    let resolved = if workspace.internal && access != safe_path::Access::Write {
        // No project folder selected: agents may read/list/search the machine.
        // Writes stay confined to the internal scratch workspace.
        safe_path::resolve_unconfined(&workspace.root, requested, access)
    } else {
        safe_path::resolve(&workspace.root, requested, access)
    };
    resolved.map_err(|error| {
        if workspace.internal
            && access == safe_path::Access::Write
            && error.code == safe_path::FS_OUTSIDE_WORKSPACE
        {
            return err(
                error.code,
                crate::i18n::t("tools.exec.workspace.internalEdit"),
            );
        }
        err(error.code, error.message)
    })
}

fn relative_path(ctx: &ToolCtx, path: &Path) -> String {
    let Some(root) = ctx.workspace_root() else {
        return path.to_string_lossy().replace('\\', "/");
    };
    let internal = ctx.workspace.as_ref().is_some_and(|workspace| workspace.internal);
    if internal && !safe_path::is_within(root, path) {
        return path.to_string_lossy().replace('\\', "/");
    }
    safe_path::to_relative(root, path)
}

/// Resolve um diretório dentro do workspace (`Access::ReadDir` valida que é
/// pasta e não deixa escapar do workspace).
fn resolve_dir(ctx: &ToolCtx, requested: &str) -> Result<PathBuf, ToolOutcome> {
    let workspace = workspace_handle(ctx)?;
    let resolved = if workspace.internal {
        safe_path::resolve_unconfined(&workspace.root, requested, safe_path::Access::ReadDir)
    } else {
        safe_path::resolve(&workspace.root, requested, safe_path::Access::ReadDir)
    };
    resolved.map_err(|error| err(error.code, error.message))
}

/// Base de uma busca: um diretório ou um arquivo específico. A resolução que
/// falha por "não é arquivo" (diretório) cai para `ReadDir`; erros de path
/// inexistente/fora do workspace continuam sendo erros.
enum SearchRoot {
    File(PathBuf),
    Dir(PathBuf),
}

fn resolve_search_root(ctx: &ToolCtx, requested: &str) -> Result<SearchRoot, ToolOutcome> {
    let workspace = workspace_handle(ctx)?;
    let resolve = |access| {
        if workspace.internal {
            safe_path::resolve_unconfined(&workspace.root, requested, access)
        } else {
            safe_path::resolve(&workspace.root, requested, access)
        }
    };
    match resolve(safe_path::Access::Read) {
        Ok(path) => Ok(SearchRoot::File(path)),
        Err(error) if error.code == safe_path::FS_NOT_A_FILE => {
            resolve(safe_path::Access::ReadDir)
                .map(SearchRoot::Dir)
                .map_err(|error| err(error.code, error.message))
        }
        Err(error) => Err(err(error.code, error.message)),
    }
}

fn dir_skip_name(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".next"
            | ".nuxt"
            | "coverage"
            | ".idea"
            | ".vscode"
    )
}

/// Pasta de spill por sessão (`<app-data>/spill/<conversation>`).
fn spill_dir(ctx: &ToolCtx) -> PathBuf {
    ctx.data_dir.join("spill").join(&ctx.conversation_id)
}

/// Encurta um texto grande para o modelo, gravando o completo em spill.
/// Devolve `(inline, Some((id, path)))` quando houve spill.
fn spill_text(ctx: &ToolCtx, text: &str) -> (String, Option<(String, PathBuf)>) {
    let total = text.chars().count();
    if total <= MAX_INLINE_CHARS {
        return (text.to_string(), None);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = spill_dir(ctx);
    let path = dir.join(format!("{id}.txt"));
    let write = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, text.as_bytes()));
    if write.is_err() {
        // Sem spill disponível: nunca perder o resultado, devolve truncado.
        let head: String = text.chars().take(SPILL_HEAD_CHARS).collect();
        return (
            format!(
                "{head}\n{}\n",
                crate::i18n::t("tools.exec.spill.unavailable")
            ),
            None,
        );
    }
    let head: String = text.chars().take(SPILL_HEAD_CHARS).collect();
    let tail: String = {
        let skip = total.saturating_sub(SPILL_TAIL_CHARS);
        text.chars().skip(skip).collect()
    };
    let inline = format!(
        "{head}\n{}\n{tail}",
        crate::i18n::t_args("tools.exec.spill.complete", &[("id", &id)])
    );
    (inline, Some((id, path)))
}

/// Valida o id de spill (anti path traversal) e lê o arquivo completo.
fn read_spill(ctx: &ToolCtx, id: &str) -> Result<String, ToolOutcome> {
    let valid = (8..=32).contains(&id.len())
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    if !valid {
        return Err(err(
            "SPILL_NOT_FOUND",
            crate::i18n::t_args("tools.exec.spill.invalidId", &[("id", id)]),
        ));
    }
    let path = spill_dir(ctx).join(format!("{id}.txt"));
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(err(
            "SPILL_NOT_FOUND",
            crate::i18n::t_args("tools.exec.spill.gone", &[("id", id)]),
        )),
        Err(error) => Err(err(
            "SPILL_NOT_FOUND",
            crate::i18n::t_args(
                "tools.exec.spill.readFailed",
                &[("id", id), ("error", &error.to_string())],
            ),
        )),
    }
}

fn finish(
    ctx: &ToolCtx,
    content: String,
    summary: Option<String>,
    presentation: Option<Value>,
) -> ToolOutcome {
    let (inline, spill) = spill_text(ctx, &content);
    let presentation = match (presentation, &spill) {
        (Some(Value::Object(mut map)), Some((id, _))) => {
            map.insert("spill".into(), Value::String(id.clone()));
            Some(Value::Object(map))
        }
        (Some(value), _) => Some(value),
        (None, Some((id, _))) => Some(json!({ "kind": "output", "spill": id })),
        (None, None) => None,
    };
    ToolOutcome {
        content: inline,
        summary,
        presentation,
        ..Default::default()
    }
}

/* ------------------------------------------------------------------ */
/* Política e aprovação                                                */
/* ------------------------------------------------------------------ */

const EV_APPROVAL_ASKED: &str = "approval/asked";
const EV_APPROVAL_DECIDED: &str = "approval/decided";

fn audit_append(ctx: &ToolCtx, kind: &str, payload: &Value) {
    // Evento de auditoria: nunca derruba a execução se o log falhar.
    let _ = session::append(&ctx.db, &ctx.conversation_id, Some(&ctx.turn_id), kind, payload);
}

fn approval_options() -> Vec<ApprovalOption> {
    vec![
        ApprovalOption {
            id: "allow".into(),
            label: crate::i18n::t("approvals.allowOnce"),
            scope: None,
        },
        ApprovalOption {
            id: "deny".into(),
            label: crate::i18n::t("approvals.deny"),
            scope: None,
        },
        ApprovalOption {
            id: "allow_session".into(),
            label: crate::i18n::t("approvals.alwaysSession"),
            scope: Some(ApprovalScope::Session),
        },
        ApprovalOption {
            id: "allow_workspace".into(),
            label: crate::i18n::t("approvals.alwaysWorkspace"),
            scope: Some(ApprovalScope::Workspace),
        },
        ApprovalOption {
            id: "allow_global".into(),
            label: crate::i18n::t("approvals.alwaysGlobal"),
            scope: Some(ApprovalScope::Global),
        },
    ]
}


/// Runs a dynamic MCP server tool (`mcp__server__tool`).
///
/// User "always allow/deny" rules win. In interactive modes, without a rule,
/// every call asks for approval; in Autonomous mode it runs directly (explicit
/// deny rules still apply). Turn cancellation aborts; the call times out at 120 s.
pub async fn run_mcp(ctx: &ToolCtx, wire: &str, args: Value) -> ToolOutcome {
    let Some(manager) = ctx.mcp.clone() else {
        return err(
            "MCP_UNAVAILABLE",
            crate::i18n::t("tools.exec.mcp.unavailable"),
        );
    };
    let Some((server, tool)) = crate::mcp::parse_wire_name(wire) else {
        return err(
            "MCP_INVALID",
            crate::i18n::t_args("tools.exec.mcp.invalidName", &[("wire", wire)]),
        );
    };
    let display = format!("{server} · {tool}");

    match mcp_rule_decision(ctx, wire) {
        Some(crate::domain::ApprovalDecision::Denied) => {
            return err(
                "APPROVAL_DENIED",
                crate::i18n::t_args("tools.exec.mcp.ruleDenied", &[("wire", wire)]),
            )
        }
        Some(crate::domain::ApprovalDecision::Approved) => {}
        _ if conversation_permission_mode(ctx) == PermissionMode::Autonomous => {}
        _ => {
            if ctx.approval.is_none() {
                return err(
                    "APPROVAL_UNAVAILABLE",
                    crate::i18n::t("tools.exec.mcp.approvalRequired"),
                );
            }
            let detail = ApprovalDetail::Other {
                text: crate::i18n::t_args(
                    "tools.exec.approvals.mcpDetail",
                    &[
                        ("server", server),
                        ("tool", tool),
                        ("args", &truncate_json(&args, 1_200)),
                    ],
                ),
            };
            let request = ApprovalRequest {
                id: format!("apr-{}", uuid::Uuid::new_v4().simple()),
                conversation_id: ctx.conversation_id.clone(),
                tool_call_id: ctx.tool_call_id.clone(),
                tool: wire.to_string(),
                title: crate::i18n::t("tools.exec.approvals.callMcp"),
                detail,
                risk: RiskClass::Network,
                preview: None,
                options: vec![
                    crate::domain::ApprovalOption {
                        id: "allow".into(),
                        label: crate::i18n::t("approvals.allowOnce"),
                        scope: None,
                    },
                    crate::domain::ApprovalOption {
                        id: "deny".into(),
                        label: crate::i18n::t("approvals.deny"),
                        scope: None,
                    },
                ],
                created_at: now_ms(),
            };
            let approval_id = request.id.clone();
            audit_append(
                ctx,
                EV_APPROVAL_ASKED,
                &json!({ "approvalId": approval_id, "tool": wire, "risk": "network" }),
            );
            let outcome = ctx.request_approval(request).await;
            audit_append(
                ctx,
                EV_APPROVAL_DECIDED,
                &json!({
                    "approvalId": approval_id,
                    "decision": outcome.decision.as_str(),
                    "scope": outcome.scope.map(|scope| scope.as_str()),
                }),
            );
            if !outcome.is_approved() {
                let feedback = outcome
                    .feedback
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!(": {value}"))
                    .unwrap_or_default();
                return match outcome.decision {
                    crate::domain::ApprovalDecision::Denied => err(
                        "APPROVAL_DENIED",
                        crate::i18n::t_args(
                            "tools.exec.mcp.denied",
                            &[("feedback", &feedback)],
                        ),
                    ),
                    crate::domain::ApprovalDecision::Cancelled => {
                        err("APPROVAL_CANCELLED", crate::i18n::t("tools.exec.approval.cancelled"))
                    }
                    _ => err(
                        "APPROVAL_EXPIRED",
                        crate::i18n::t("tools.exec.approval.expired"),
                    ),
                };
            }
        }
    }

    let result = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            return err("MCP_CANCELLED", crate::i18n::t("tools.exec.turn.cancelled"))
        }
        result = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            manager.call(wire, args),
        ) => match result {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return err("MCP_FAILED", error),
            Err(_) => return err("MCP_TIMEOUT", crate::i18n::t("tools.exec.mcp.timeout")),
        },
    };
    let content = mcp_result_text(&result);
    let (inline, _) = spill_text(ctx, &content);
    ToolOutcome {
        content: inline,
        summary: Some(format!("MCP {display}")),
        presentation: Some(json!({ "kind": "output" })),
        ..Default::default()
    }
}

/// Regra "sempre permitir/negar" que casa com a tool MCP (exact/prefix/glob).
fn mcp_rule_decision(ctx: &ToolCtx, wire: &str) -> Option<crate::domain::ApprovalDecision> {
    for rule in ctx.policy_rules() {
        if rule.tool != wire && rule.tool != "mcp" && rule.tool != "mcp__*" {
            continue;
        }
        let matches = match rule.matcher.as_str() {
            "prefix" => wire.starts_with(&rule.pattern),
            "glob" => crate::policy::glob_match(&rule.pattern, wire),
            _ => rule.pattern == wire,
        };
        if matches {
            return Some(rule.decision);
        }
    }
    None
}

fn truncate_json(value: &Value, max: usize) -> String {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    if text.chars().count() <= max {
        return text;
    }
    text.chars().take(max).collect::<String>() + "…"
}

/// Extrai texto de um resultado MCP (`content: [{type:"text",text}]`).
fn mcp_result_text(result: &Value) -> String {
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut parts = Vec::new();
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                parts.push(text.to_string());
            } else {
                parts.push(item.to_string());
            }
        }
    }
    if parts.is_empty() {
        parts.push(serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string()));
    }
    let body = parts.join("\n");
    if is_error {
        format!("MCP_ERROR: {body}")
    } else {
        body
    }
}

/// Aplica a matriz de permissões e, se necessário, pausa o turno pedindo
/// aprovação humana. `Allow` → `Ok`; `Deny`/`Ask` recusado → `Err(erro)`.
pub(crate) async fn policy_check(
    ctx: &ToolCtx,
    tool: &str,
    risk: RiskClass,
    mutating: bool,
    target: Option<&str>,
    secret: bool,
    destructive_reason: Option<String>,
    detail: ApprovalDetail,
    title: &str,
) -> Result<(), ToolOutcome> {
    let Some(workspace) = ctx.workspace.as_ref() else {
        if mutating {
            return Err(err(
                "FS_NO_WORKSPACE",
                crate::i18n::t("tools.exec.policy.noWorkspace"),
            ));
        }
        return Ok(());
    };
    let facts = CallFacts {
        tool,
        risk,
        mutating,
        target,
        inside_workspace: true,
        secret,
        destructive_reason: destructive_reason.as_deref(),
    };
    // Estado **vivo** da sessão (B-02/D6): o modo Plano e o modo de permissão
    // podem mudar no meio do turno (aprovação do plano, chip, `/permissoes`).
    // Ler do banco por chamada garante que o gate vale imediatamente, sem
    // esperar o próximo turno.
    let conversation = ctx
        .db
        .get_conversation(&ctx.conversation_id)
        .ok()
        .flatten();
    let plan_mode = crate::harness::code::session::plan_mode_active(
        &ctx.db,
        &ctx.conversation_id,
    )
    .unwrap_or(true); // leitura falhou ⇒ falha fechada (age como Plano)
    let mode = conversation
        .as_ref()
        .map(|conversation| conversation.permission_mode)
        .unwrap_or(workspace.permission_mode);
    let workspace_id = conversation
        .as_ref()
        .and_then(|conversation| conversation.workspace_id.as_deref());
    let policy_ctx = PolicyContext {
        mode,
        plan_mode,
        trusted: workspace.trusted,
        session_id: ctx.conversation_id.as_str(),
        workspace_id,
        rules: ctx.policy_rules(),
    };
    match decide(&policy_ctx, &facts) {
        PolicyDecision::Allow => Ok(()),
        PolicyDecision::Deny { code, reason } => Err(err(code, reason)),
        PolicyDecision::Ask { risk, reason } => {
            if ctx.approval.is_none() {
                return Err(err(
                    "APPROVAL_UNAVAILABLE",
                    crate::i18n::t_args(
                        "tools.exec.policy.approvalUnavailable",
                        &[("reason", &reason)],
                    ),
                ));
            }
            let request = ApprovalRequest {
                id: format!("apr-{}", uuid::Uuid::new_v4().simple()),
                conversation_id: ctx.conversation_id.clone(),
                tool_call_id: ctx.tool_call_id.clone(),
                tool: tool.to_string(),
                title: title.to_string(),
                detail,
                risk,
                preview: None,
                options: if risk == RiskClass::Computer {
                    vec![
                        ApprovalOption {
                            id: "allow".into(),
                            label: crate::i18n::t("approvals.allowOnce"),
                            scope: None,
                        },
                        ApprovalOption {
                            id: "deny".into(),
                            label: crate::i18n::t("approvals.deny"),
                            scope: None,
                        },
                    ]
                } else {
                    approval_options()
                },
                created_at: now_ms(),
            };
            audit_append(
                ctx,
                EV_APPROVAL_ASKED,
                &json!({
                    "approvalId": request.id,
                    "tool": tool,
                    "risk": risk,
                    "title": title,
                    "reason": reason,
                }),
            );
            let approval_id = request.id.clone();
            let outcome = ctx.request_approval(request).await;
            audit_append(
                ctx,
                EV_APPROVAL_DECIDED,
                &json!({
                    "approvalId": approval_id,
                    "decision": outcome.decision.as_str(),
                    "scope": outcome.scope.map(|scope| scope.as_str()),
                    "feedback": outcome.feedback,
                }),
            );
            if outcome.is_approved() {
                return Ok(());
            }
            let feedback = outcome
                .feedback
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!(": {value}"))
                .unwrap_or_default();
            match outcome.decision {
                crate::domain::ApprovalDecision::Denied => Err(err(
                    "APPROVAL_DENIED",
                    crate::i18n::t_args(
                        "tools.exec.policy.denied",
                        &[("feedback", &feedback)],
                    ),
                )),
                crate::domain::ApprovalDecision::Cancelled => Err(err(
                    "APPROVAL_CANCELLED",
                    crate::i18n::t("tools.exec.policy.cancelled"),
                )),
                _ => Err(err(
                    "APPROVAL_TIMEOUT",
                    crate::i18n::t("tools.exec.policy.timeout"),
                )),
            }
        }
    }
}

fn is_secret_path(relative: &str) -> bool {
    let lower = relative.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    lower.contains("/.aws/credentials")
        || lower.ends_with(".git-credentials")
        || name == ".env"
        || name.starts_with(".env.")
        || name == ".npmrc"
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("secrets.")
        || name.ends_with(".secret")
}

fn write_detail(path: &str) -> ApprovalDetail {
    ApprovalDetail::Paths {
        paths: vec![path.to_string()],
        change: "write".to_string(),
    }
}

/* ------------------------------------------------------------------ */
/* Leitura: read_file, list_dir, search_files, search_text            */
/* ------------------------------------------------------------------ */

fn decode_text(bytes: &[u8]) -> (String, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(&bytes[3..]).into_owned(), "UTF-8 (BOM)".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (text.into_owned(), "UTF-16LE".into());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (text.into_owned(), "UTF-16BE".into());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), "UTF-8".into());
    }
    let mut detector =
        chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
    let (text, _, _) = encoding.decode(bytes);
    (text.into_owned(), encoding.name().to_string())
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|byte| *byte == 0)
}

async fn read_file(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let requested = match arg_str(args, "path") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let path = match resolve_path(ctx, &requested, safe_path::Access::Read) {
        Ok(path) => path,
        Err(outcome) => return outcome,
    };
    let relative = relative_path(ctx, &path);
    // Arquivos de segredo exigem consentimento explícito mesmo na leitura.
    if is_secret_path(&relative) {
        if let Err(outcome) = policy_check(
            ctx,
            "read_file",
            RiskClass::Secret,
            false,
            Some(relative.as_str()),
            true,
            None,
            ApprovalDetail::Secret { path: relative.clone() },
            &crate::i18n::t("tools.exec.approvals.readSecret"),
        )
        .await
        {
            return outcome;
        }
    }
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return err(
                "FS_NOT_FOUND",
                crate::i18n::t_args(
                    "tools.exec.fs.readFailed",
                    &[("relative", &relative), ("error", &error.to_string())],
                ),
            )
        }
    };
    if metadata.len() > MAX_READ_BYTES {
        return err(
            "FS_TOO_LARGE",
            crate::i18n::t_args(
                "tools.exec.fs.tooLargeRead",
                &[
                    ("relative", &relative),
                    ("size", &metadata.len().to_string()),
                    ("max", &MAX_READ_BYTES.to_string()),
                ],
            ),
        );
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return err(
                "FS_NOT_FOUND",
                crate::i18n::t_args(
                    "tools.exec.fs.readFailed",
                    &[("relative", &relative), ("error", &error.to_string())],
                ),
            )
        }
    };
    if looks_binary(&bytes) {
        return err(
            "FS_BINARY",
            crate::i18n::t_args("tools.exec.fs.binaryRead", &[("relative", &relative)]),
        );
    }
    let (text, encoding) = decode_text(&bytes);
    if let Some(observed) = &ctx.observed {
        observed.record(&path, &bytes);
    }

    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let offset = opt_u32(args, "offset").unwrap_or(1).max(1) as usize;
    if total > 0 && offset > total {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t_args(
                "tools.exec.read.offsetOutOfRange",
                &[
                    ("offset", &offset.to_string()),
                    ("relative", &relative),
                    ("total", &total.to_string()),
                ],
            ),
        );
    }
    let limit = opt_u32(args, "limit").unwrap_or(800).clamp(1, 2_000) as usize;
    let start = offset.saturating_sub(1).min(total);
    let end = (start + limit).min(total);
    let mut body = String::new();
    if total == 0 {
        body.push_str(&crate::i18n::t("tools.exec.read.emptyFile"));
    } else {
        for (index, line) in lines[start..end].iter().enumerate() {
            let number = start + index + 1;
            let rendered = if line.chars().count() > MAX_LINE_CHARS {
                format!("{}…", line.chars().take(MAX_LINE_CHARS).collect::<String>())
            } else {
                (*line).to_string()
            };
            body.push_str(&format!("{number:>4}│ {rendered}\n"));
        }
    }
    let next_offset = end + 1;
    let footer = if end >= total {
        crate::i18n::t_args("tools.exec.read.end", &[("total", &total.to_string())])
    } else {
        crate::i18n::t_args(
            "tools.exec.read.next",
            &[
                ("offset", &next_offset.to_string()),
                ("total", &total.to_string()),
            ],
        )
    };
    let size_kb = metadata.len() as f64 / 1024.0;
    let mut content = format!(
        "{relative} · linhas {}-{} de {total} · {size_kb:.1} KB · {encoding}\n{body}{footer}",
        if total == 0 { 0 } else { start + 1 },
        end
    );
    if let Some(observed) = &ctx.observed {
        let hash = observed_hash(content.as_bytes());
        if let Some(count) = observed.note_read_output(&ctx.conversation_id, &path, &hash) {
            content.push_str(&format!(
                "\n\n[Identical output received {count} times. Re-reading `{relative}` will not change it; proceed with the edit or narrow the range.]"
            ));
        }
    }
    let first_line = if total == 0 { 0 } else { start + 1 };
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.read.summary",
            &[
                ("relative", &relative),
                ("start", &first_line.to_string()),
                ("end", &end.to_string()),
            ],
        )),
        Some(json!({ "kind": "output", "path": relative, "lines": end.saturating_sub(start) })),
    )
}

async fn list_dir(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let requested = opt_str(args, "path").unwrap_or_else(|| ".".to_string());
    let base = match resolve_dir(ctx, &requested) {
        Ok(path) => path,
        Err(outcome) => return outcome,
    };
    let depth = opt_u32(args, "depth").unwrap_or(2).clamp(1, 4) as usize;
    let include_hidden = opt_bool(args, "include_hidden").unwrap_or(false);
    let limit = opt_u32(args, "limit").unwrap_or(400).clamp(1, 2_000) as usize;

    let mut entries: Vec<(String, bool)> = Vec::new();
    let walker = ignore::WalkBuilder::new(&base)
        .hidden(!include_hidden)
        .git_ignore(true)
        .max_depth(Some(depth))
        .filter_entry(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| !dir_skip_name(name))
                .unwrap_or(true)
        })
        .build();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(&base)
            .ok()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| relative_path(ctx, path));
        if relative.is_empty() {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        entries.push((relative, is_dir));
        if entries.len() > limit * 4 {
            break;
        }
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let total = entries.len();
    entries.truncate(limit);

    let mut content = String::new();
    let display_path = if requested == "." {
        ".".to_string()
    } else {
        requested.clone()
    };
    let header = if total > limit {
        crate::i18n::t_args(
            "tools.exec.list.headerTruncated",
            &[
                ("path", &display_path),
                ("count", &total.to_string()),
                ("limit", &limit.to_string()),
            ],
        )
    } else {
        crate::i18n::t_args(
            "tools.exec.list.header",
            &[("path", &display_path), ("count", &total.to_string())],
        )
    };
    content.push_str(&format!("{header}\n"));
    for (relative, is_dir) in &entries {
        let depth_marker = relative.matches('/').count();
        content.push_str(&"  ".repeat(depth_marker));
        content.push_str(relative.rsplit('/').next().unwrap_or(relative));
        if *is_dir {
            content.push('/');
        }
        content.push('\n');
    }
    if total > limit {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.list.moreTotal",
            &[("total", &total.to_string())],
        ));
        content.push('\n');
    }
    if entries.is_empty() {
        content.push_str(&crate::i18n::t("tools.exec.list.empty"));
        content.push('\n');
    }
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.list.summary",
            &[("path", &requested), ("count", &total.to_string())],
        )),
        Some(json!({ "kind": "output", "entries": total })),
    )
}

fn build_walker(base: &Path, include_hidden: bool) -> ignore::Walk {
    ignore::WalkBuilder::new(base)
        .hidden(!include_hidden)
        .git_ignore(true)
        .filter_entry(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| !dir_skip_name(name))
                .unwrap_or(true)
        })
        .build()
}

async fn search_files(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let pattern = match arg_str(args, "pattern") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let glob = match globset::Glob::new(&pattern) {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => {
            return err(
                "TOOL_INVALID_ARGS",
                crate::i18n::t_args("tools.exec.search.invalidGlob", &[("error", &error.to_string())]),
            )
        }
    };
    let requested = opt_str(args, "path").unwrap_or_else(|| ".".to_string());
    let root = match resolve_search_root(ctx, &requested) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let cap = opt_u32(args, "max_results").unwrap_or(200).clamp(1, 1_000) as usize;
    let basename_only = !pattern.contains('/');
    let (paths, _file_only): (Box<dyn Iterator<Item = PathBuf>>, bool) = match root {
        SearchRoot::File(path) => (Box::new(std::iter::once(path)), true),
        SearchRoot::Dir(base) => (
            Box::new(build_walker(&base, false).flatten().filter_map(|entry| {
                if entry.depth() == 0
                    || entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                {
                    None
                } else {
                    Some(entry.path().to_path_buf())
                }
            })),
            false,
        ),
    };
    let mut matches: Vec<String> = Vec::new();
    for path in paths {
        let relative = relative_path(ctx, &path);
        let candidate = if basename_only {
            path.file_name().map(|name| name.to_string_lossy().into_owned())
        } else {
            Some(relative.clone())
        };
        if let Some(candidate) = candidate {
            if glob.is_match(candidate.as_str()) || (!basename_only && glob.is_match(&relative)) {
                matches.push(relative);
            }
        }
        if matches.len() > cap * 4 {
            break;
        }
    }
    matches.sort();
    matches.dedup();
    let total = matches.len();
    matches.truncate(cap);
    let mut content = String::new();
    if matches.is_empty() {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.searchFiles.none",
            &[("pattern", &pattern), ("path", &requested)],
        ));
        content.push('\n');
    } else {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.searchFiles.header",
            &[("count", &total.to_string()), ("pattern", &pattern)],
        ));
        content.push('\n');
        for relative in &matches {
            content.push_str(relative);
            content.push('\n');
        }
        if total > cap {
            content.push_str(&crate::i18n::t_args(
                "tools.exec.searchFiles.truncated",
                &[
                    ("shown", &cap.to_string()),
                    ("total", &total.to_string()),
                ],
            ));
            content.push('\n');
        }
    }
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.searchFiles.summary",
            &[("count", &total.to_string())],
        )),
        Some(json!({ "kind": "output", "results": total })),
    )
}

async fn search_text(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let query = match arg_str(args, "query") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let is_regex = opt_bool(args, "is_regex").unwrap_or(false);
    let case_sensitive = opt_bool(args, "case_sensitive").unwrap_or(false);
    let context_lines = opt_u32(args, "context_lines").unwrap_or(0).clamp(0, 5) as usize;
    let cap = opt_u32(args, "max_results").unwrap_or(200).clamp(1, 1_000) as usize;
    let requested = opt_str(args, "path").unwrap_or_else(|| ".".to_string());
    let root = match resolve_search_root(ctx, &requested) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let pattern = if is_regex { query.clone() } else { regex::escape(&query) };
    let matcher = match regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
    {
        Ok(matcher) => matcher,
        Err(error) => {
            return err(
                "TOOL_INVALID_ARGS",
                crate::i18n::t_args(
                    "tools.exec.searchText.invalidRegex",
                    &[("error", &error.to_string())],
                ),
            )
        }
    };
    let glob = opt_str(args, "glob").and_then(|value| match globset::Glob::new(&value) {
        Ok(glob) => Some(glob.compile_matcher()),
        Err(_) => None,
    });

    let mut blocks: Vec<String> = Vec::new();
    let mut total_matches = 0usize;
    let mut displayed_lines = 0usize;
    let (paths, file_only): (Box<dyn Iterator<Item = PathBuf>>, bool) = match root {
        SearchRoot::File(path) => {
            let relative = relative_path(ctx, &path);
            if is_secret_path(&relative) {
                if let Err(outcome) = policy_check(
                    ctx,
                    "search_text",
                    RiskClass::Secret,
                    false,
                    Some(relative.as_str()),
                    true,
                    None,
                    ApprovalDetail::Secret { path: relative.clone() },
                    &crate::i18n::t("tools.exec.approvals.readSecret"),
                )
                .await
                {
                    return outcome;
                }
            }
            (Box::new(std::iter::once(path)), true)
        }
        SearchRoot::Dir(base) => (
            Box::new(build_walker(&base, false).flatten().filter_map(|entry| {
                if entry.depth() == 0
                    || entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                {
                    None
                } else {
                    Some(entry.path().to_path_buf())
                }
            })),
            false,
        ),
    };
    'files: for path in paths {
        let relative = relative_path(ctx, &path);
        if is_secret_path(&relative) && !file_only {
            continue;
        }
        if resolve_path(ctx, &relative, safe_path::Access::Read).is_err() {
            continue;
        }
        if let Some(glob) = &glob {
            if !glob.is_match(relative.as_str()) {
                continue;
            }
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if looks_binary(&bytes) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let mut block = String::new();
        for (index, line) in lines.iter().enumerate() {
            if !matcher.is_match(line) {
                continue;
            }
            total_matches += 1;
            if total_matches > cap {
                break 'files;
            }
            let start = index.saturating_sub(context_lines);
            let end = (index + context_lines + 1).min(lines.len());
            if context_lines > 0 {
                block.push_str(&format!("{relative}\n"));
            }
            for context_index in start..end {
                let prefix = if context_index == index { ':' } else { '-' };
                let rendered = if lines[context_index].chars().count() > MAX_LINE_CHARS {
                    lines[context_index].chars().take(MAX_LINE_CHARS).collect::<String>()
                } else {
                    lines[context_index].to_string()
                };
                block.push_str(&format!(
                    "{relative}:{}{prefix} {rendered}\n",
                    context_index + 1
                ));
                displayed_lines += 1;
            }
            if displayed_lines > 4_000 {
                break 'files;
            }
        }
        if !block.is_empty() {
            blocks.push(block);
        }
        if blocks.len() > 200 {
            break;
        }
    }

    let mut content = String::new();
    if total_matches == 0 {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.searchText.none",
            &[("query", &query), ("path", &requested)],
        ));
        content.push('\n');
    } else {
        for block in &blocks {
            content.push_str(block);
        }
        if total_matches >= cap {
            content.push_str(&crate::i18n::t_args(
                "tools.exec.searchText.truncated",
                &[("cap", &cap.to_string())],
            ));
            content.push('\n');
        }
    }
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.searchText.summary",
            &[("count", &total_matches.to_string())],
        )),
        Some(json!({ "kind": "output", "matches": total_matches })),
    )
}

async fn read_tool_output(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let id = match arg_str(args, "id") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let text = match read_spill(ctx, &id) {
        Ok(text) => text,
        Err(outcome) => return outcome,
    };
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let offset = opt_u32(args, "offset").unwrap_or(0) as usize;
    if offset >= total && total > 0 {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t_args(
                "tools.exec.readOutput.offsetOutOfRange",
                &[
                    ("offset", &offset.to_string()),
                    ("total", &total.to_string()),
                ],
            ),
        );
    }
    let limit = opt_u32(args, "limit").unwrap_or(4_000).clamp(1, 20_000) as usize;
    let end = (offset + limit).min(total);
    let page: String = chars[offset..end].iter().collect();
    let suffix = if end < total {
        crate::i18n::t_args("tools.exec.readOutput.next", &[("offset", &end.to_string())])
    } else {
        crate::i18n::t("tools.exec.readOutput.end")
    };
    let meta = crate::i18n::t_args(
        "tools.exec.readOutput.page",
        &[
            ("id", &id),
            ("start", &offset.to_string()),
            ("end", &end.to_string()),
            ("total", &total.to_string()),
            ("suffix", &suffix),
        ],
    );
    let content = format!("{page}\n{meta}");
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.readOutput.summary",
            &[
                ("id", &id),
                ("start", &offset.to_string()),
                ("end", &end.to_string()),
            ],
        )),
        Some(json!({ "kind": "output", "lines": 0 })),
    )
}

/* ------------------------------------------------------------------ */
/* Escrita: write_file e edit_file                                     */
/* ------------------------------------------------------------------ */

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let temp = path.with_file_name(format!(
        ".{file_name}.zylara-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&temp, bytes)?;
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

fn ensure_observed(ctx: &ToolCtx, path: &Path, relative: &str, current: &[u8]) -> Result<(), ToolOutcome> {
    let Some(observed) = &ctx.observed else {
        return Ok(());
    };
    match observed.check(path, current) {
        ObservationState::Fresh => Ok(()),
        ObservationState::Missing => Err(err(
            "FS_NOT_OBSERVED",
            crate::i18n::t_args("tools.exec.observe.missing", &[("relative", relative)]),
        )),
        ObservationState::Stale => Err(err(
            "FS_STALE_VERSION",
            crate::i18n::t_args("tools.exec.observe.stale", &[("relative", relative)]),
        )),
    }
}

fn normalize_eol(content: &str, before: Option<&[u8]>) -> String {
    let Some(before) = before else {
        return content.to_string();
    };
    let before_text = String::from_utf8_lossy(before);
    if before_text.contains("\r\n") && !content.contains("\r\n") {
        return content.replace('\n', "\r\n");
    }
    if !before_text.contains("\r\n") && content.contains("\r\n") {
        return content.replace("\r\n", "\n");
    }
    content.to_string()
}

/// Collapses CRLF to LF so snippets copied from the LF-normalized `read_file`
/// output match files checked out with CRLF (Windows, `core.autocrlf`).
fn normalize_crlf(text: &str) -> Cow<'_, str> {
    if text.contains("\r\n") {
        Cow::Owned(text.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

fn preserve_bom(content: &str, before: Option<&[u8]>) -> String {
    match before {
        Some(bytes) if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) => {
            if content.starts_with('\u{feff}') {
                content.to_string()
            } else {
                format!("\u{feff}{content}")
            }
        }
        _ => content.to_string(),
    }
}

/// Aplica a mutação já calculada: grava atômico, registra journal/observação,
/// emite `FileChanged` e devolve o conteúdo para o modelo.
fn commit_mutation(
    ctx: &ToolCtx,
    path: &Path,
    relative: &str,
    before: Option<&[u8]>,
    after: &[u8],
    kind: FileChangeKind,
) -> Result<(String, Value), ToolOutcome> {
    if after.len() > MAX_WRITE_BYTES {
        return Err(err(
            "FS_TOO_LARGE",
            crate::i18n::t_args(
                "tools.exec.fs.contentTooLarge",
                &[
                    ("relative", relative),
                    ("max", &MAX_WRITE_BYTES.to_string()),
                ],
            ),
        ));
    }
    let store = journal::ObjectStore::new(ctx.data_dir.join("checkpoints").join("objects"));
    let before_hash = match before {
        Some(bytes) => store.put_bytes(bytes).ok(),
        None => None,
    };
    if let Err(error) = atomic_write(path, after) {
        return Err(err(
            "FS_WRITE_FAILED",
            crate::i18n::t_args(
                "tools.exec.fs.writeFailed",
                &[("relative", relative), ("error", &error.to_string())],
            ),
        ));
    }
    let after_hash = observed_hash(after);
    let before_hash = before_hash.or_else(|| before.map(observed_hash));
    let (added, removed) = journal::line_stats(before, Some(after));
    let before_text = before
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let after_text = String::from_utf8_lossy(after).into_owned();
    let diff = journal::unified_diff(relative, &before_text, &after_text);
    let diff_short: String = diff.chars().take(MAX_DIFF_CHARS).collect();

    let (journal_conversation, journal_turn) = match &ctx.journal_owner {
        Some(owner) => (owner.conversation_id.clone(), owner.turn_id.clone()),
        None => (ctx.conversation_id.clone(), ctx.turn_id.clone()),
    };
    let entry = crate::db::FileJournalEntry::new(
        journal_conversation,
        journal_turn,
        relative.to_string(),
        kind,
    )
    .with_hashes(before_hash.as_deref(), Some(after_hash.as_str()))
    .with_line_counts(added, removed);
    ctx.db.append_file_journal(&entry).map_err(|error| {
        err(
            "JOURNAL_FAILED",
            crate::i18n::t_args("tools.exec.fs.journalFailed", &[("error", &error.to_string())]),
        )
    })?;
    if let Some(observed) = &ctx.observed {
        observed.record(path, after);
    }
    ctx.emit_event(crate::events::TurnEvent::FileChanged {
        change: FileChange {
            path: relative.to_string(),
            kind,
            added,
            removed,
            diff: if diff.is_empty() { None } else { Some(diff.clone()) },
        },
    });

    let header = match kind {
        FileChangeKind::Created => crate::i18n::t_args(
            "tools.exec.file.created",
            &[("path", relative), ("added", &added.to_string())],
        ),
        FileChangeKind::Deleted => crate::i18n::t_args(
            "tools.exec.file.deleted",
            &[("path", relative), ("removed", &removed.to_string())],
        ),
        _ => crate::i18n::t_args(
            "tools.exec.file.updated",
            &[
                ("path", relative),
                ("added", &added.to_string()),
                ("removed", &removed.to_string()),
            ],
        ),
    };
    let content = if diff_short.is_empty() {
        header
    } else {
        format!("{header}\n{diff_short}")
    };
    let presentation = json!({
        "kind": "file_change",
        "path": relative,
        "change": match kind {
            FileChangeKind::Created => "created",
            FileChangeKind::Modified => "modified",
            FileChangeKind::Deleted => "deleted",
            FileChangeKind::Renamed => "renamed",
        },
        "added": added,
        "removed": removed,
        "diff": diff.chars().take(12_000).collect::<String>(),
    });
    Ok((content, presentation))
}

fn observed_hash(bytes: &[u8]) -> String {
    crate::harness::code::observed::hash_bytes(bytes)
}


/// Comandos de hook do projeto (`.zylara/hooks.json`): `postWrite`.
fn project_post_write_hooks(root: &Path) -> Vec<String> {
    let path = root.join(".zylara").join("hooks.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    value
        .get("postWrite")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(command) => Some(command.clone()),
                    Value::Object(map) => map
                        .get("command")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    _ => None,
                })
                .take(4)
                .collect()
        })
        .unwrap_or_default()
}

/// Roda os hooks pós-escrita e anexa o resultado ao retorno da tool. Os hooks
/// são configurados pelo usuário no próprio workspace (`.zylara/hooks.json`) e
/// não mutam a decisão da política: falha vira aviso, nunca erro do turno.
async fn with_post_write_hooks(ctx: &ToolCtx, relative: &str, content: String) -> String {
    if !ctx.settings.shell_enabled
        || ctx
            .workspace
            .as_ref()
            .is_some_and(|workspace| workspace.internal)
    {
        return content;
    }
    let Ok(root) = writable_root(ctx) else {
        return content;
    };
    let commands = project_post_write_hooks(&root);
    if commands.is_empty() {
        return content;
    }
    let mut body = content;
    let mut notes: Vec<String> = Vec::new();
    for command in commands {
        let expanded = command.replace("{path}", relative).replace("{file}", relative);
        let (program, args) = exec::shell_for(&expanded);
        let request = exec::ExecRequest {
            program,
            args,
            cwd: root.clone(),
            env: exec::sanitized_env(&[("ZYLARA_HOOK", "postWrite")]),
            timeout: std::time::Duration::from_secs(120),
            cancel: ctx.cancel.clone(),
            max_output_bytes: 16 * 1024,
        };
        match exec::run(request, None).await {
            Ok(output) => {
                let ok = output.exit_code == Some(0);
                let combined = format!("{}{}", output.stdout, output.stderr);
                let snippet: String = combined.trim().chars().take(600).collect();
                let status = if ok {
                    crate::i18n::t("tools.exec.hooks.ok")
                } else {
                    crate::i18n::t("tools.exec.hooks.failed")
                };
                notes.push(crate::i18n::t_args(
                    "tools.exec.hooks.note",
                    &[
                        ("command", &command),
                        ("status", &status),
                        ("snippet", &snippet),
                    ],
                ));
                audit_append(
                    ctx,
                    "hook/ran",
                    &json!({
                        "hook": "postWrite",
                        "command": command,
                        "exitCode": output.exit_code,
                        "timedOut": output.timed_out,
                    }),
                );
                if !ok {
                    notes.push(crate::i18n::t("tools.exec.hooks.editKept"));
                }
            }
            Err(error) => notes.push(crate::i18n::t_args(
                "tools.exec.hooks.errorNote",
                &[("command", &command), ("error", &error.to_string())],
            )),
        }
    }
    if notes.is_empty() {
        return body;
    }
    body.push_str("\n\n");
    body.push_str(&crate::i18n::t("tools.exec.hooks.header"));
    body.push('\n');
    for note in notes {
        body.push_str(&note);
        body.push('\n');
    }
    body
}

async fn write_file(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let requested = match arg_str(args, "path") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let content = match args.get("content").and_then(Value::as_str) {
        Some(value) => value.to_string(),
        None => {
            return err(
                "TOOL_INVALID_ARGS",
                crate::i18n::t("tools.exec.args.contentRequired"),
            )
        }
    };
    if content.len() > MAX_WRITE_BYTES {
        return err(
            "FS_TOO_LARGE",
            crate::i18n::t_args(
                "tools.exec.write.contentTooLarge",
                &[("max", &MAX_WRITE_BYTES.to_string())],
            ),
        );
    }
    if let Err(outcome) = writable_root(ctx) {
        return outcome;
    }
    let path = match resolve_path(ctx, &requested, safe_path::Access::Write) {
        Ok(path) => path,
        Err(outcome) => return outcome,
    };
    let relative = relative_path(ctx, &path);
    let existing = std::fs::read(&path).ok();
    let kind = if existing.is_some() {
        FileChangeKind::Modified
    } else {
        FileChangeKind::Created
    };
    if let Err(outcome) = policy_check(
        ctx,
        "write_file",
        RiskClass::Write,
        true,
        Some(relative.as_str()),
        is_secret_path(&relative),
        None,
        write_detail(&relative),
        &crate::i18n::t("tools.exec.approvals.writeFile"),
    )
    .await
    {
        return outcome;
    }
    if let Some(before) = &existing {
        if let Err(outcome) = ensure_observed(ctx, &path, &relative, before) {
            return outcome;
        }
    }
    let normalized = preserve_bom(&normalize_eol(&content, existing.as_deref()), existing.as_deref());
    let after = normalized.into_bytes();
    match commit_mutation(ctx, &path, &relative, existing.as_deref(), &after, kind) {
        Ok((content, presentation)) => {
            let content = with_post_write_hooks(ctx, &relative, content).await;
            finish(
                ctx,
                content,
                Some(crate::i18n::t_args(
                    "tools.exec.write.summary",
                    &[("path", &relative)],
                )),
                Some(presentation),
            )
        },
        Err(outcome) => outcome,
    }
}

async fn edit_file(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let requested = match arg_str(args, "path") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let old_string = match args.get("old_string").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => normalize_crlf(value).into_owned(),
        _ => {
            return err(
                "TOOL_INVALID_ARGS",
                crate::i18n::t("tools.exec.args.oldStringRequired"),
            )
        }
    };
    let new_string = match args.get("new_string").and_then(Value::as_str) {
        Some(value) => normalize_crlf(value).into_owned(),
        None => {
            return err(
                "TOOL_INVALID_ARGS",
                crate::i18n::t("tools.exec.args.newStringRequired"),
            )
        }
    };
    // CRLF and LF spellings of the same edit are a no-op once the file EOL is
    // reapplied; reject them like byte-identical strings.
    if old_string == new_string {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t("tools.exec.args.sameStrings"),
        );
    }
    let replace_all = opt_bool(args, "replace_all").unwrap_or(false);
    if let Err(outcome) = writable_root(ctx) {
        return outcome;
    }
    let path = match resolve_path(ctx, &requested, safe_path::Access::Write) {
        Ok(path) => path,
        Err(outcome) => return outcome,
    };
    let relative = relative_path(ctx, &path);
    // A política roda antes do IO: modo Leitura/Plano nega sem tocar no disco.
    if let Err(outcome) = policy_check(
        ctx,
        "edit_file",
        RiskClass::Write,
        true,
        Some(relative.as_str()),
        is_secret_path(&relative),
        None,
        write_detail(&relative),
        &crate::i18n::t("tools.exec.approvals.editFile"),
    )
    .await
    {
        return outcome;
    }
    let before = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return err(
                "FS_NOT_FOUND",
                crate::i18n::t_args("tools.exec.fs.notFound", &[("relative", &relative)]),
            )
        }
        Err(error) => {
            return err(
                "FS_NOT_FOUND",
                crate::i18n::t_args(
                    "tools.exec.fs.readFailed",
                    &[("relative", &relative), ("error", &error.to_string())],
                ),
            )
        }
    };
    if looks_binary(&before) {
        return err(
            "FS_BINARY",
            crate::i18n::t_args("tools.exec.fs.modifyBinary", &[("relative", &relative)]),
        );
    }
    if let Err(outcome) = ensure_observed(ctx, &path, &relative, &before) {
        return outcome;
    }
    let text = match String::from_utf8(before.clone()) {
        Ok(text) => text,
        Err(_) => {
            return err(
                "FS_BINARY",
                crate::i18n::t_args("tools.exec.fs.modifyNotUtf8", &[("relative", &relative)]),
            )
        }
    };
    let normalized = normalize_crlf(&text);
    let occurrences = normalized.matches(old_string.as_str()).count();
    if occurrences == 0 {
        return err(
            "FS_NOT_FOUND",
            crate::i18n::t_args("tools.exec.edit.notFound", &[("relative", &relative)]),
        );
    }
    if occurrences > 1 && !replace_all {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t_args(
                "tools.exec.edit.multiple",
                &[
                    ("count", &occurrences.to_string()),
                    ("relative", &relative),
                ],
            ),
        );
    }
    let after_text = if replace_all {
        normalized.replacen(old_string.as_str(), new_string.as_str(), occurrences)
    } else {
        normalized.replacen(old_string.as_str(), new_string.as_str(), 1)
    };
    let after_text = preserve_bom(&normalize_eol(&after_text, Some(&before)), Some(&before));
    let after = after_text.into_bytes();
    match commit_mutation(ctx, &path, &relative, Some(&before), &after, FileChangeKind::Modified) {
        Ok((content, presentation)) => {
            let content = with_post_write_hooks(ctx, &relative, content).await;
            finish(
                ctx,
                content,
                Some(crate::i18n::t_args(
                    "tools.exec.edit.summary",
                    &[("path", &relative)],
                )),
                Some(presentation),
            )
        },
        Err(outcome) => outcome,
    }
}

/* ------------------------------------------------------------------ */
/* Shell: run_command                                                  */
/* ------------------------------------------------------------------ */

/// Ponte para as tools antigas do Chat (web/skills) reaproveitadas no Code:
/// monta o `ToolRuntime` equivalente e delega para `tools::execute`.
async fn bridge_chat_tool(ctx: &ToolCtx, name: &str, args: &Value) -> ToolOutcome {
    let mut options = crate::domain::TurnOptions::default();
    options.web_search = ctx.settings.web_search_enabled;
    options.create_files = false;
    options.run_code = false;
    options.allowed_skills = ctx.allowed_skills.clone();
    let runtime = crate::tools::ToolRuntime {
        db: ctx.db.clone(),
        http: ctx.http.clone(),
        conversation_id: ctx.conversation_id.clone(),
        message_id: ctx.message_id.clone(),
        options,
        settings: ctx.settings.clone(),
        cancel: ctx.cancel.clone(),
        agent_hooks: ctx.agent_hooks.clone(),
        data_dir: ctx.data_dir.clone(),
        skills_roots: ctx.skills_roots.clone(),
        approval: ctx.approval.clone(),
        emit: ctx.emit.clone(),
    };
    let call = crate::domain::ToolCallRecord {
        id: ctx.tool_call_id.clone(),
        name: name.to_string(),
        arguments: args.to_string(),
        result: None,
        status: crate::domain::ToolCallStatus::Running,
        summary: None,
        started_at: None,
        finished_at: None,
        presentation: None,
        images: Vec::new(),
    };
    crate::tools::execute(&runtime, &call).await
}

fn subagent_failure(error: anyhow::Error) -> ToolOutcome {
    let message = format!("{error:#}");
    for code in [
        "SUBAGENT_MODEL_INVALID",
        "SUBAGENT_REASONING_UNSUPPORTED",
        "SUBAGENT_REASONING_INVALID",
        "DELEGATION_DEPTH",
    ] {
        if message.contains(code) {
            return err(code, message);
        }
    }
    err("SUBAGENT_FAILED", message)
}

/// Autonomous worker children cannot escalate: the parent must be autonomous
/// and outside Plan mode at launch time.
fn ensure_worker_allowed(ctx: &ToolCtx) -> Result<(), ToolOutcome> {
    let mode = ctx
        .db
        .get_conversation(&ctx.conversation_id)
        .ok()
        .flatten()
        .map(|conversation| conversation.permission_mode)
        .or_else(|| ctx.workspace.as_ref().map(|workspace| workspace.permission_mode));
    if mode != Some(PermissionMode::Autonomous) {
        return Err(err(
            "SUBAGENT_MODE_REQUIRED",
            crate::i18n::t("tools.exec.subagent.workerAutonomous"),
        ));
    }
    if crate::harness::code::session::plan_mode_active(&ctx.db, &ctx.conversation_id)
        .unwrap_or(true)
    {
        return Err(err(
            "PLAN_MODE_ACTIVE",
            crate::i18n::t("policy.reasons.planMode"),
        ));
    }
    Ok(())
}

/// `task`: delega exploração/revisão a um subagente somente leitura.
async fn run_task(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    use crate::harness::code::subagent::{
        SubagentKind, SubagentRequest, MAX_DELEGATIONS_PER_TURN, SUBAGENT_CANCEL_GRACE_SECS,
    };

    let Some(runner) = ctx.subagent.clone() else {
        return err(
            "SUBAGENT_UNAVAILABLE",
            crate::i18n::t("tools.exec.subagent.unavailable"),
        );
    };
    if ctx.workspace.is_none() {
        return err(
            "FS_NO_WORKSPACE",
            crate::i18n::t("tools.exec.subagent.noWorkspace"),
        );
    }
    let description = match arg_str(args, "description") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let prompt = match arg_str(args, "prompt") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let kind = match opt_str(args, "subagent_type") {
        None => SubagentKind::Explore,
        Some(value) => match SubagentKind::parse(&value) {
            Some(kind) => kind,
            None => {
                return err(
                    "SUBAGENT_INVALID_TYPE",
                    crate::i18n::t_args("tools.exec.subagent.invalidType", &[("value", &value)]),
                )
            }
        },
    };
    if kind.is_writable() {
        if let Err(outcome) = ensure_worker_allowed(ctx) {
            return outcome;
        }
    }
    let timeout_secs = kind.timeout_secs();
    if !ctx.try_consume_subagent_budget() {
        return err(
            "SUBAGENT_LIMIT",
            crate::i18n::t_args(
                "tools.exec.subagent.limit",
                &[("max", &MAX_DELEGATIONS_PER_TURN.to_string())],
            ),
        );
    }
    let _slot = match ctx.subagent_slots.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return err(
                "SUBAGENT_UNAVAILABLE",
                crate::i18n::t("tools.exec.subagent.slotsUnavailable"),
            )
        }
    };
    let request = SubagentRequest {
        task_call_id: ctx.tool_call_id.clone(),
        description: description.clone(),
        prompt,
        kind,
        model: opt_str(args, "model"),
        effort: opt_str(args, "effort"),
    };
    let child_cancel = ctx.cancel.child_token();
    let run = runner.run(request, child_cancel.clone(), ctx.emit.clone());
    tokio::pin!(run);
    let outcome = tokio::select! {
        _ = ctx.cancel.cancelled() => {
            child_cancel.cancel();
            let _ = tokio::time::timeout(
                Duration::from_secs(SUBAGENT_CANCEL_GRACE_SECS),
                &mut run,
            )
            .await;
            ctx.emit_event(crate::events::TurnEvent::SubagentFinished {
                task_call_id: ctx.tool_call_id.clone(),
                conversation_id: None,
                status: "cancelled".to_string(),
                usage: None,
                duration_ms: 0,
                error: None,
            });
            return err("SUBAGENT_CANCELLED", crate::i18n::t("tools.exec.turn.cancelled"));
        }
        result = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            &mut run,
        ) => match result {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => {
                if ctx.cancel.is_cancelled() {
                    ctx.emit_event(crate::events::TurnEvent::SubagentFinished {
                        task_call_id: ctx.tool_call_id.clone(),
                        conversation_id: None,
                        status: "cancelled".to_string(),
                        usage: None,
                        duration_ms: 0,
                        error: None,
                    });
                    return err("SUBAGENT_CANCELLED", crate::i18n::t("tools.exec.turn.cancelled"));
                }
                return subagent_failure(error);
            }
            Err(_) => {
                child_cancel.cancel();
                let _ = tokio::time::timeout(
                    Duration::from_secs(SUBAGENT_CANCEL_GRACE_SECS),
                    &mut run,
                )
                .await;
                ctx.emit_event(crate::events::TurnEvent::SubagentFinished {
                    task_call_id: ctx.tool_call_id.clone(),
                    conversation_id: None,
                    status: "error".to_string(),
                    usage: None,
                    duration_ms: 0,
                    error: Some(crate::i18n::t_args(
                        "tools.exec.subagent.timeout",
                        &[("minutes", &(timeout_secs / 60).to_string())],
                    )),
                });
                return err(
                    "SUBAGENT_TIMEOUT",
                    crate::i18n::t_args(
                        "tools.exec.subagent.timeout",
                        &[("minutes", &(timeout_secs / 60).to_string())],
                    ),
                );
            }
        },
    };
    let conversation_id = outcome.conversation_id;
    let provider_id = outcome.provider_id;
    let model_id = outcome.model_id;
    let effort = outcome.effort;
    let text = outcome.text;
    let short: String = description.chars().take(60).collect();
    let summary = crate::i18n::t_args(
        "tools.exec.subagent.summary",
        &[
            ("kind", kind.as_str()),
            ("description", &short),
            ("steps", &outcome.steps.to_string()),
            ("duration", &outcome.duration_ms.to_string()),
        ],
    );
    let (inline, _spill) = spill_text(
        ctx,
        &crate::i18n::t_args(
            "tools.exec.subagent.content",
            &[("kind", kind.as_str()), ("text", &text)],
        ),
    );
    let mut presentation = serde_json::json!({
        "kind": "subagent",
        "description": description,
        "subagentType": kind.as_str(),
        "conversationId": conversation_id,
        "providerId": provider_id,
        "modelId": model_id,
        "steps": outcome.steps,
        "durationMs": outcome.duration_ms,
    });
    if let Some(effort) = effort {
        presentation["effort"] = Value::String(effort);
    }
    if let Some(usage) = outcome.usage {
        presentation["usage"] = serde_json::to_value(usage).unwrap_or(Value::Null);
    }
    ToolOutcome {
        content: inline,
        summary: Some(summary),
        presentation: Some(presentation),
        ..Default::default()
    }
}

/// `run_checks`: roda a verificação detectada do projeto (test/lint/build)
/// reutilizando o pipeline (e a aprovação) do `run_command`.
async fn run_checks(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let root = match writable_root(ctx) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let profile = crate::workspace::project::detect(&root);
    if profile.checks.is_empty() {
        return err(
            "NO_CHECKS",
            crate::i18n::t("tools.exec.checks.none"),
        );
    }
    let requested = opt_str(args, "check");
    let selected = match requested.as_deref() {
        Some(requested) => profile
            .checks
            .iter()
            .find(|check| check.id == requested || check.command == requested)
            .cloned(),
        None => profile.checks.first().cloned(),
    };
    let Some(check) = selected else {
        let available: Vec<String> = profile
            .checks
            .iter()
            .map(|check| format!("{} (`{}`)", check.id, check.command))
            .collect();
        return err(
            "CHECK_NOT_FOUND",
            crate::i18n::t_args(
                "tools.exec.checks.unknown",
                &[
                    ("requested", &requested.unwrap_or_default()),
                    ("available", &available.join(", ")),
                ],
            ),
        );
    };
    let timeout = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(600_000)
        .clamp(1_000, 600_000);
    let command_args = json!({
        "command": check.command,
        "description": crate::i18n::t_args(
            "tools.exec.checks.run",
            &[("label", &check.label)],
        ),
        "timeout_ms": timeout,
    });
    let mut outcome = run_command(ctx, &command_args).await;
    if let Some(Value::Object(presentation)) = outcome.presentation.as_mut() {
        presentation.insert("check".into(), Value::String(check.id.clone()));
        presentation.insert("command".into(), Value::String(check.command.clone()));
        if let Some(ecosystem) = crate::workspace::project::ecosystem_for_check_id(&check.id) {
            presentation.insert(
                "ecosystem".into(),
                Value::String(ecosystem.to_string()),
            );
        }
    }
    if !outcome.is_error {
        let label = check.label.clone();
        let head = format!("[check: {label}]\n");
        if outcome.content.chars().count() + head.len() <= MAX_INLINE_CHARS {
            outcome.content = format!("{head}{}", outcome.content);
        }
        if outcome.summary.is_none() {
            outcome.summary = Some(crate::i18n::t_args(
                "tools.exec.checks.summary",
                &[("label", &label)],
            ));
        }
    }
    outcome
}
async fn run_command(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let command = match arg_str(args, "command") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let description = opt_str(args, "description")
        .unwrap_or_else(|| crate::i18n::t("tools.exec.run.defaultDescription"));
    let root = match writable_root(ctx) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let workdir = match opt_str(args, "workdir") {
        Some(requested) => match resolve_dir(ctx, &requested) {
            Ok(path) => path,
            Err(outcome) => return outcome,
        },
        None => root.clone(),
    };
    let workdir_relative = relative_path(ctx, &workdir);
    let destructive = exec::is_destructive_command(&command);
    // Known read-only commands are inspections, not mutations: Plan mode and
    // the Read-only permission mode may run them without approval. The
    // destructive check still wins (policy checks it before the mode default).
    let read_only = destructive.is_none() && exec::is_readonly_command(&command);
    let risk = if read_only {
        RiskClass::Read
    } else {
        RiskClass::Shell
    };
    let detail = ApprovalDetail::Command {
        command: command.clone(),
        workdir: workdir_relative.clone(),
    };
    if let Err(outcome) = policy_check(
        ctx,
        "run_command",
        risk,
        !read_only,
        Some(command.as_str()),
        false,
        destructive,
        detail,
        &crate::i18n::t("tools.exec.approvals.runCommand"),
    )
    .await
    {
        return outcome;
    }

    let timeout_ms = opt_u32(args, "timeout_ms")
        .map(|value| value.clamp(1_000, 600_000))
        .unwrap_or(120_000);
    let background = opt_bool(args, "run_in_background").unwrap_or(false);
    let (program, program_args) =
        if ctx.settings.execution_environment == "docker" && !ctx.settings.docker_image.trim().is_empty()
        {
            exec::docker_shell_for(
                &exec::SandboxConfig {
                    image: ctx.settings.docker_image.clone(),
                    network: ctx.settings.docker_network,
                    memory_mb: ctx.settings.docker_memory_mb,
                    cpus: ctx.settings.docker_cpus,
                    pids_limit: ctx.settings.docker_pids_limit,
                    read_only_root: ctx.settings.docker_read_only_root,
                },
                &root,
                &workdir,
                &command,
            )
        } else {
            exec::shell_for(&command)
        };
    let request = exec::ExecRequest {
        program,
        args: program_args,
        cwd: workdir,
        env: exec::sanitized_env(&[("ZYLARA_AGENT", "1")]),
        timeout: Duration::from_millis(timeout_ms as u64),
        cancel: ctx.cancel.child_token(),
        max_output_bytes: 1024 * 1024,
    };

    let Some(jobs) = ctx.jobs.clone() else {
        if background {
            return err(
                "JOB_UNAVAILABLE",
                crate::i18n::t("tools.exec.jobs.unavailableForeground"),
            );
        }
        return run_command_direct(ctx, request, description, command).await;
    };
    let Some(emit) = ctx.emit.clone() else {
        if background {
            return err(
                "JOB_UNAVAILABLE",
                crate::i18n::t("tools.exec.jobs.noEmitter"),
            );
        }
        return run_command_direct(ctx, request, description, command).await;
    };

    let view = match jobs.start(&ctx.conversation_id, command.clone(), request, emit) {
        Ok(view) => view,
        Err(error) => return err(error.code, error.message),
    };
    if background {
        return finish(
            ctx,
            crate::i18n::t_args(
                "tools.exec.background.started",
                &[
                    ("job_id", &view.id),
                    ("command", &command),
                ],
            ),
            Some(crate::i18n::t_args(
                "tools.exec.jobs.summaryWithDescription",
                &[("job_id", &view.id), ("description", &description)],
            )),
            Some(json!({ "kind": "job", "job": view })),
        );
    }

    // Foreground: espera o término até o timeout; se estourar, promove o job
    // (o processo continua vivo em vez de ser morto).
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms as u64);
    let mut cursor = 0usize;
    loop {
        let (chunk, next_cursor, current) = match jobs.output(&view.id, cursor) {
            Ok(page) => page,
            Err(error) => return err(error.code, error.message),
        };
        cursor = next_cursor;
        if !chunk.is_empty() {
            ctx.emit_event(crate::events::TurnEvent::ToolProgress {
                id: ctx.tool_call_id.clone(),
                stream: None,
                delta: chunk,
            });
        }
        if current.status != crate::domain::JobStatus::Running {
            let (output, _next, settled) = match jobs.output(&view.id, 0) {
                Ok(page) => page,
                Err(error) => return err(error.code, error.message),
            };
            jobs.remove(&view.id);
            return command_result(ctx, output, settled, description);
        }
        if std::time::Instant::now() >= deadline {
            return promoted_to_job(&jobs, &view.id, timeout_ms, description);
        }
        tokio::select! {
            _ = ctx.cancel.cancelled() => {
                return promoted_to_job(&jobs, &view.id, timeout_ms, description);
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

/// Resultado normal de um comando de foreground (exit ≠ 0 continua sendo resultado).
fn command_result(ctx: &ToolCtx, output: String, settled: crate::domain::JobView, description: String) -> ToolOutcome {
    let mut content = String::new();
    match settled.exit_code {
        Some(code) => content.push_str(&format!("[exit code: {code}]\n")),
        None => content.push_str("[exit code: ?]\n"),
    }
    content.push_str(&output);
    if !output.is_empty() && !output.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&crate::i18n::t_args(
        "tools.exec.command.duration",
        &[("ms", &settled.duration_ms.to_string())],
    ));
    content.push('\n');
    finish(
        ctx,
        content,
        Some(description),
        Some(json!({ "kind": "output", "exitCode": settled.exit_code, "durationMs": settled.duration_ms })),
    )
}

/// Mensagem de promoção: o job continua vivo e pode ser acompanhado pelas tools.
fn promoted_to_job(
    jobs: &Arc<crate::jobs::JobRegistry>,
    job_id: &str,
    timeout_ms: u32,
    description: String,
) -> ToolOutcome {
    let view = jobs
        .output(job_id, usize::MAX)
        .map(|(_, _, view)| view)
        .ok();
    let mut outcome = ToolOutcome {
        content: crate::i18n::t_args(
            "tools.exec.background.stillRunning",
            &[
                ("timeout_ms", &timeout_ms.to_string()),
                ("job_id", job_id),
            ],
        ),
        summary: Some(crate::i18n::t_args(
            "tools.exec.jobs.summaryWithDescription",
            &[("job_id", job_id), ("description", &description)],
        )),
        ..Default::default()
    };
    if let Some(view) = view {
        outcome.presentation = Some(json!({ "kind": "job", "job": view }));
    }
    outcome
}

/// Caminho sem `JobRegistry` (composições antigas/testes): executa direto com
/// timeout do executor (comportamento anterior, sem promoção).
async fn run_command_direct(
    ctx: &ToolCtx,
    request: exec::ExecRequest,
    description: String,
    command: String,
) -> ToolOutcome {
    let (sender, mut receiver) =
        tokio::sync::mpsc::unbounded_channel::<(exec::StreamKind, String)>();
    let emit = ctx.emit.clone();
    let event_id = ctx.tool_call_id.clone();
    let progress_task = tokio::spawn(async move {
        while let Some((stream, delta)) = receiver.recv().await {
            if let Some(emit) = &emit {
                emit.emit(crate::events::TurnEvent::ToolProgress {
                    id: event_id.clone(),
                    stream: Some(stream.as_str().to_string()),
                    delta,
                });
            }
        }
    });
    let output = match exec::run(request, Some(sender)).await {
        Ok(output) => output,
        Err(error) => {
            progress_task.abort();
            return err(error.code, error.message);
        }
    };
    progress_task.abort();
    let mut content = String::new();
    match output.exit_code {
        Some(code) => content.push_str(&format!("[exit code: {code}]\n")),
        None => content.push_str("[exit code: ?]\n"),
    }
    if !output.stdout.is_empty() {
        content.push_str(&output.stdout);
        if !output.stdout.ends_with('\n') {
            content.push('\n');
        }
    }
    if !output.stderr.is_empty() {
        content.push_str("[stderr]\n");
        content.push_str(&output.stderr);
        if !output.stderr.ends_with('\n') {
            content.push('\n');
        }
    }
    if output.timed_out {
        content.push_str(&crate::i18n::t("tools.exec.command.timedOut"));
        content.push('\n');
    }
    if output.cancelled {
        content.push_str(&crate::i18n::t("tools.exec.command.stopped"));
        content.push('\n');
    }
    if output.truncated {
        content.push_str(&crate::i18n::t("tools.exec.command.truncated"));
        content.push('\n');
    }
    content.push_str(&crate::i18n::t_args(
        "tools.exec.command.duration",
        &[("ms", &output.duration_ms.to_string())],
    ));
    content.push('\n');
    let _ = command;
    finish(
        ctx,
        content,
        Some(description),
        Some(json!({ "kind": "output", "exitCode": output.exit_code, "durationMs": output.duration_ms })),
    )
}

/* ------------------------------------------------------------------ */
/* Jobs em background: job_list, job_output e job_kill                */
/* ------------------------------------------------------------------ */

fn jobs_registry(ctx: &ToolCtx) -> Result<Arc<crate::jobs::JobRegistry>, ToolOutcome> {
    ctx.jobs.clone().ok_or_else(|| {
        err(
            "JOB_UNAVAILABLE",
            crate::i18n::t("tools.exec.jobs.unavailable"),
        )
    })
}

fn job_line(view: &crate::domain::JobView) -> String {
    let status = match view.status {
        crate::domain::JobStatus::Running => crate::i18n::t("tools.exec.jobs.status.running"),
        crate::domain::JobStatus::Done => crate::i18n::t("tools.exec.jobs.status.done"),
        crate::domain::JobStatus::Failed => crate::i18n::t("tools.exec.jobs.status.failed"),
        crate::domain::JobStatus::Killed => crate::i18n::t("tools.exec.jobs.status.killed"),
    };
    let exit = view
        .exit_code
        .map(|code| {
            crate::i18n::t_args("tools.exec.jobs.exitCode", &[("code", &code.to_string())])
        })
        .unwrap_or_default();
    format!(
        "{} · {status}{exit} · {} ms · {}\n",
        view.id, view.duration_ms, view.command
    )
}

async fn job_list(ctx: &ToolCtx, _args: &Value) -> ToolOutcome {
    let jobs = match jobs_registry(ctx) {
        Ok(jobs) => jobs,
        Err(outcome) => return outcome,
    };
    let views = jobs.list(&ctx.conversation_id);
    let mut content = String::new();
    if views.is_empty() {
        content.push_str(&crate::i18n::t("tools.exec.jobs.empty"));
        content.push('\n');
    } else {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.jobs.count",
            &[("count", &views.len().to_string())],
        ));
        content.push('\n');
        for view in &views {
            content.push_str(&job_line(view));
            if let Some(preview) = view.output_preview.as_deref() {
                let snippet: String = preview.chars().take(160).collect();
                content.push_str(&crate::i18n::t_args(
                    "tools.exec.jobs.output",
                    &[("snippet", &snippet)],
                ));
                content.push('\n');
            }
        }
    }
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.jobs.summary",
            &[("count", &views.len().to_string())],
        )),
        Some(json!({ "kind": "jobs", "count": views.len() })),
    )
}

async fn job_output(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let jobs = match jobs_registry(ctx) {
        Ok(jobs) => jobs,
        Err(outcome) => return outcome,
    };
    let job_id = match arg_str(args, "job_id") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let cursor = opt_u32(args, "cursor").unwrap_or(0) as usize;
    let wait = opt_bool(args, "wait").unwrap_or(false);
    let timeout_ms = opt_u32(args, "timeout_ms")
        .unwrap_or(30_000)
        .clamp(1_000, 600_000);
    if wait {
        if let Err(error) = jobs.wait(&job_id, Duration::from_millis(timeout_ms as u64)).await {
            return err(error.code, error.message);
        }
    }
    let (output, next_cursor, view) = match jobs.output(&job_id, cursor) {
        Ok(page) => page,
        Err(error) => return err(error.code, error.message),
    };
    let status = job_line(&view);
    let mut content = format!("[status: {}]\n", status.trim_end());
    if output.is_empty() {
        content.push_str(&crate::i18n::t("tools.exec.jobs.noNewOutput"));
        content.push('\n');
    } else {
        content.push_str(&output);
        if !output.ends_with('\n') {
            content.push('\n');
        }
    }
    content.push_str(&crate::i18n::t_args(
        "tools.exec.jobs.nextCursor",
        &[("cursor", &next_cursor.to_string())],
    ));
    content.push('\n');
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.jobs.cursorSummary",
            &[
                ("id", &view.id),
                ("from", &cursor.to_string()),
                ("to", &next_cursor.to_string()),
            ],
        )),
        Some(json!({ "kind": "job", "job": view })),
    )
}

async fn job_kill(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let jobs = match jobs_registry(ctx) {
        Ok(jobs) => jobs,
        Err(outcome) => return outcome,
    };
    let job_id = match arg_str(args, "job_id") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    let reason = opt_str(args, "reason")
        .unwrap_or_else(|| crate::i18n::t("tools.exec.approvals.endedByAgent"));
    if let Err(outcome) = policy_check(
        ctx,
        "job_kill",
        RiskClass::Shell,
        true,
        Some(job_id.as_str()),
        false,
        None,
        ApprovalDetail::Other {
            text: crate::i18n::t_args(
                "tools.exec.approvals.killJobDetail",
                &[("job_id", &job_id), ("reason", &reason)],
            ),
        },
        &crate::i18n::t("tools.exec.approvals.killJob"),
    )
    .await
    {
        return outcome;
    }
    if let Err(error) = jobs.kill(&job_id) {
        return err(error.code, error.message);
    }
    // Dá ao runner a chance de fechar o processo e reportar o estado terminal.
    let view = jobs
        .wait(&job_id, Duration::from_millis(1_500))
        .await
        .unwrap_or_else(|_| crate::domain::JobView {
            id: job_id.clone(),
            command: String::new(),
            status: crate::domain::JobStatus::Killed,
            started_at: 0,
            duration_ms: 0,
            exit_code: None,
            output_preview: None,
        });
    finish(
        ctx,
        crate::i18n::t_args(
            "tools.exec.jobs.killed",
            &[
                ("job_id", &job_id),
                ("status", job_line(&view).trim_end()),
            ],
        ),
        Some(crate::i18n::t_args(
            "tools.exec.jobs.killSummary",
            &[("job_id", &job_id)],
        )),
        Some(json!({ "kind": "job", "job": view })),
    )
}

/* ------------------------------------------------------------------ */
/* Git somente leitura                                                 */
/* ------------------------------------------------------------------ */

fn status_code_label(code: &str) -> String {
    match code {
        "M" => crate::i18n::t("tools.exec.git.status.modified"),
        "A" => crate::i18n::t("tools.exec.git.status.added"),
        "D" => crate::i18n::t("tools.exec.git.status.deleted"),
        "R" => crate::i18n::t("tools.exec.git.status.renamed"),
        "C" => crate::i18n::t("tools.exec.git.status.copied"),
        "U" => crate::i18n::t("tools.exec.git.status.conflict"),
        _ => crate::i18n::t("tools.exec.git.status.changed"),
    }
}

async fn git_status(ctx: &ToolCtx, _args: &Value) -> ToolOutcome {
    let root = match workspace_root(ctx) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let status = git::detect(&root).await;
    if !status.is_repo {
        return err("GIT_NOT_A_REPO", crate::i18n::t("tools.exec.git.notRepo"));
    }
    let mut content = String::new();
    content.push_str(&crate::i18n::t_args(
        "tools.exec.git.branch",
        &[
            (
                "branch",
                status.branch.as_deref().unwrap_or("(detached)"),
            ),
            ("ahead", &status.ahead.to_string()),
            ("behind", &status.behind.to_string()),
        ],
    ));
    content.push('\n');
    for file in &status.staged {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.git.stagedLine",
            &[
                ("status", &file.status),
                ("path", &file.path),
                ("label", &status_code_label(&file.status)),
            ],
        ));
        content.push('\n');
    }
    for file in &status.unstaged {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.git.unstagedLine",
            &[
                ("status", &file.status),
                ("path", &file.path),
                ("label", &status_code_label(&file.status)),
            ],
        ));
        content.push('\n');
    }
    for path in &status.untracked {
        content.push_str(&format!("?? {path}\n"));
    }
    for path in &status.conflicted {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.git.conflicted",
            &[("path", path)],
        ));
        content.push('\n');
    }
    if status.staged.is_empty()
        && status.unstaged.is_empty()
        && status.untracked.is_empty()
        && status.conflicted.is_empty()
    {
        content.push_str(&crate::i18n::t("tools.exec.git.clean"));
        content.push('\n');
    }
    let total = status.staged.len() + status.unstaged.len() + status.untracked.len() + status.conflicted.len();
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.git.statusSummary",
            &[("count", &total.to_string())],
        )),
        Some(json!({ "kind": "output", "files": total })),
    )
}

fn redact_secret_diff(diff: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest
                .split_whitespace()
                .last()
                .unwrap_or("")
                .trim_start_matches("b/");
            skipping = is_secret_path(path);
            if skipping {
                out.push_str(&crate::i18n::t_args(
                    "tools.exec.git.secretOmitted",
                    &[("path", path)],
                ));
                out.push('\n');
                continue;
            }
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

async fn git_diff(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let root = match workspace_root(ctx) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let status = git::detect(&root).await;
    if !status.is_repo {
        return err("GIT_NOT_A_REPO", crate::i18n::t("tools.exec.git.notRepo"));
    }
    let mut paths = Vec::new();
    for requested in opt_string_array(args, "paths") {
        match resolve_path(ctx, &requested, safe_path::Access::Write) {
            Ok(path) => paths.push(safe_path::to_relative(&root, &path)),
            Err(_) => {
                // Paths que não existem (arquivos removidos) são aceitos relativos.
                let candidate = requested.replace('\\', "/");
                if !candidate.contains("..") {
                    paths.push(candidate);
                }
            }
        }
    }
    let staged = opt_bool(args, "staged").unwrap_or(false);
    let context = opt_u32(args, "context").unwrap_or(3).clamp(0, 10);
    let diff = match git::diff(&root, &paths, staged, context, 40_000).await {
        Ok(diff) => diff,
        Err(error) => return err(error.code, error.message),
    };
    let content = if diff.trim().is_empty() {
        let mut text = crate::i18n::t("tools.exec.git.noChanges");
        text.push('\n');
        text
    } else {
        redact_secret_diff(&diff)
    };
    finish(
        ctx,
        content,
        Some("git diff".to_string()),
        Some(json!({ "kind": "output", "staged": staged })),
    )
}

async fn git_log(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let root = match workspace_root(ctx) {
        Ok(root) => root,
        Err(outcome) => return outcome,
    };
    let status = git::detect(&root).await;
    if !status.is_repo {
        return err("GIT_NOT_A_REPO", crate::i18n::t("tools.exec.git.notRepo"));
    }
    let limit = opt_u32(args, "limit").unwrap_or(20).clamp(1, 50);
    let commits = match git::log(&root, limit).await {
        Ok(commits) => commits,
        Err(error) => return err(error.code, error.message),
    };
    let mut content = String::new();
    for commit in &commits {
        content.push_str(&format!(
            "{} {} — {} ({})\n",
            &commit.hash[..commit.hash.len().min(8)],
            commit.date,
            commit.subject,
            commit.author
        ));
    }
    if content.is_empty() {
        content.push_str(&crate::i18n::t("tools.exec.git.noCommits"));
        content.push('\n');
    }
    if let Some(path) = opt_str(args, "path") {
        content.push_str(&crate::i18n::t_args(
            "tools.exec.git.pathFilter",
            &[("path", &path)],
        ));
        content.push('\n');
    }
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.git.logSummary",
            &[("count", &commits.len().to_string())],
        )),
        Some(json!({ "kind": "output", "commits": commits.len() })),
    )
}

/* ------------------------------------------------------------------ */
/* Planejamento e interação                                            */
/* ------------------------------------------------------------------ */

/// Perfil emitido em `TurnEvent::ProfileChanged` (o harness de código).
const CODE_PROFILE: &str = "code";

/// Opções do gate de plano (`PLAN.md` D5): aprovar um plano **não** cria regra
/// de permissão, então não há "sempre permitir" aqui.
fn plan_approval_options() -> Vec<ApprovalOption> {
    vec![
        ApprovalOption {
            id: "approve_run".into(),
            label: crate::i18n::t("tools.exec.approvals.planApproveRun"),
            scope: None,
        },
        ApprovalOption {
            id: "approve_review".into(),
            label: crate::i18n::t("tools.exec.approvals.planApproveReview"),
            scope: None,
        },
        ApprovalOption {
            id: "approve_goal".into(),
            label: crate::i18n::t("tools.exec.approvals.planApproveGoal"),
            scope: None,
        },
        ApprovalOption {
            id: "keep_planning".into(),
            label: crate::i18n::t("tools.exec.approvals.planKeepPlanning"),
            scope: None,
        },
    ]
}

/// Título e objetivo do Goal criado pelo gate "Executar como Objetivo".
///
/// O plano completo já vive na sessão e entra no contexto volátil da rodada;
/// repetir seus 20k no objetivo só gastaria contexto. O objetivo referencia o
/// plano aprovado e a rodada o carrega integralmente.
fn goal_input_for_approved_plan() -> CreateGoalInput {
    CreateGoalInput {
        title: Some(crate::i18n::t("tools.exec.goal.approvedPlanTitle")),
        objective: crate::i18n::t("tools.exec.goal.approvedPlanObjective"),
        max_rounds: None,
        auto_continue: Some(true),
    }
}

/// Modo de permissão corrente da conversa (o gate Goal o preserva).
fn conversation_permission_mode(ctx: &ToolCtx) -> PermissionMode {
    ctx.db
        .get_conversation(&ctx.conversation_id)
        .ok()
        .flatten()
        .map(|conversation| conversation.permission_mode)
        .unwrap_or(PermissionMode::Edit)
}

/// Presentation canônica do plano (`PLAN.md` D1): **flat**, com o `PlanView`
/// achatado + `kind` (`{kind, state, markdown?, feedback?, updatedAt}`).
fn plan_presentation(plan: &crate::domain::PlanView) -> Value {
    let mut value = serde_json::to_value(plan).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut value {
        map.insert("kind".to_string(), Value::String("plan".to_string()));
    }
    value
}

/// Recalcula o plano pela projeção única e emite `PlanUpdated` quando há algo
/// para mostrar. Devolve o `PlanView` emitido (para o card da tool).
fn emit_plan_updated(ctx: &ToolCtx) -> Option<crate::domain::PlanView> {
    let plan = session::plan_view(&ctx.db, &ctx.conversation_id).ok().flatten()?;
    ctx.emit_event(crate::events::TurnEvent::PlanUpdated { plan: plan.clone() });
    Some(plan)
}

/// Erro de tool carregando a presentation do plano (o card da timeline continua
/// coerente mesmo quando a revisão falha/cancela).
fn plan_error(code: &str, message: impl Into<String>, plan: Option<&crate::domain::PlanView>) -> ToolOutcome {
    let mut outcome = err(code, message);
    if let Some(plan) = plan {
        outcome.presentation = Some(plan_presentation(plan));
    }
    outcome
}

/* ------------------------------------------------------------------ */
/* Objetivo persistente (`goal`, docs/goals/code-goals/PLAN.md §8.3)   */
/* ------------------------------------------------------------------ */

/// `presentation` canônica **flat** do card do objetivo (`{kind:"goal", ...}`).
fn goal_presentation(view: &GoalView) -> Value {
    match serde_json::to_value(view) {
        Ok(Value::Object(mut map)) => {
            map.insert("kind".to_string(), Value::String("goal".to_string()));
            Value::Object(map)
        }
        // Defensivo: nunca aninha o card (payload malformado cai no card mínimo).
        _ => json!({ "kind": "goal" }),
    }
}

/// Emite o snapshot autoritativo (`GoalUpdated`) e devolve a saída curta da
/// tool com o card da timeline.
fn finish_goal(ctx: &ToolCtx, view: GoalView, content: String, summary: String) -> ToolOutcome {
    ctx.emit_event(crate::events::TurnEvent::GoalUpdated {
        goal: view.clone(),
    });
    finish(
        ctx,
        content,
        Some(summary),
        Some(goal_presentation(&view)),
    )
}

fn goal_error(error: goal::GoalError) -> ToolOutcome {
    err(error.code, error.message)
}

/// Tool `goal`: `create|edit` só em turno humano; `progress|complete|blocked`
/// em qualquer turno. O objetivo é da sessão; o modelo nunca arma/pausa.
fn goal_tool(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let action = match arg_str(args, "action") {
        Ok(action) => action,
        Err(outcome) => return outcome,
    };
    match action.as_str() {
        "create" => goal_create(ctx, args),
        "edit" => goal_edit(ctx, args),
        "progress" => goal_progress(ctx, args),
        "complete" => goal_complete(ctx, args),
        "blocked" => goal_blocked(ctx, args),
        other => err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t_args("tools.exec.goal.unknownAction", &[("action", other)]),
        ),
    }
}

fn goal_create(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    if ctx.turn_kind != TurnKind::User {
        return goal_error(goal::GoalError::requires_user_turn());
    }
    let objective = match arg_str(args, "objective") {
        Ok(objective) => objective,
        Err(outcome) => return outcome,
    };
    // Fluxo `/goal` + mensagem: o humano pediu o objetivo, então a continuidade
    // automática nasce ligada (o modelo pode desligar explicitamente). A UI tem
    // "Pausar"/"Desarmar" para reverter depois.
    let auto_continue = opt_bool(args, "auto_continue").unwrap_or(true);
    let input = CreateGoalInput {
        objective,
        title: opt_str(args, "title"),
        max_rounds: opt_u32(args, "max_rounds"),
        auto_continue: Some(auto_continue),
    };
    match goal::create(&ctx.db, &ctx.conversation_id, &input, GoalOrigin::Agent) {
        Ok(view) => {
            let continuity = if view.auto_continue {
                crate::i18n::t("tools.exec.goal.continuityOn")
            } else {
                crate::i18n::t("tools.exec.goal.continuityOff")
            };
            let content = crate::i18n::t_args(
                "tools.exec.goal.created",
                &[
                    ("title", &view.title),
                    ("rounds", &view.max_rounds.to_string()),
                    ("continuity", &continuity),
                ],
            );
            finish_goal(
                ctx,
                view.clone(),
                content,
                crate::i18n::t_args("tools.exec.goal.summary", &[("title", &view.title)]),
            )
        }
        Err(error) => goal_error(error),
    }
}

fn goal_edit(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    if ctx.turn_kind != TurnKind::User {
        return goal_error(goal::GoalError::requires_user_turn());
    }
    let title = opt_str(args, "title");
    let objective = opt_str(args, "objective");
    let max_rounds = opt_u32(args, "max_rounds");
    if title.is_none() && objective.is_none() && max_rounds.is_none() {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t("tools.exec.goal.editRequires"),
        );
    }
    let input = UpdateGoalInput {
        title,
        objective,
        max_rounds,
        summary: None,
        reason: None,
    };
    match goal::edit(&ctx.db, &ctx.conversation_id, &input) {
        Ok(view) => {
            let content = crate::i18n::t_args(
                "tools.exec.goal.updated",
                &[
                    ("title", &view.title),
                    ("rounds", &view.max_rounds.to_string()),
                ],
            );
            finish_goal(
                ctx,
                view.clone(),
                content,
                crate::i18n::t_args("tools.exec.goal.summary", &[("title", &view.title)]),
            )
        }
        Err(error) => goal_error(error),
    }
}

fn goal_progress(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let note = match arg_str(args, "note") {
        Ok(note) => note,
        Err(outcome) => return outcome,
    };
    match goal::note_progress(&ctx.db, &ctx.conversation_id, &note) {
        Ok(view) => {
            let content = crate::i18n::t_args(
                "tools.exec.goal.progress",
                &[
                    ("round", &view.rounds.to_string()),
                    ("max", &view.max_rounds.to_string()),
                    ("note", &truncate_for_tool_output(&note, 300)),
                ],
            );
            finish_goal(
                ctx,
                view.clone(),
                content,
                crate::i18n::t_args(
                    "tools.exec.goal.progressSummary",
                    &[
                        ("round", &view.rounds.to_string()),
                        ("max", &view.max_rounds.to_string()),
                    ],
                ),
            )
        }
        Err(error) => goal_error(error),
    }
}

fn goal_complete(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let summary = opt_str(args, "note");
    match goal::complete(&ctx.db, &ctx.conversation_id, summary.as_deref()) {
        Ok(view) => {
            let content = crate::i18n::t_args(
                "tools.exec.goal.completed",
                &[
                    ("title", &view.title),
                    ("rounds", &view.rounds.to_string()),
                ],
            );
            finish_goal(
                ctx,
                view.clone(),
                content,
                crate::i18n::t_args(
                    "tools.exec.goal.completedSummary",
                    &[("title", &view.title)],
                ),
            )
        }
        Err(error) => goal_error(error),
    }
}

fn goal_blocked(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let note = match arg_str(args, "note") {
        Ok(note) => note,
        Err(outcome) => return outcome,
    };
    match goal::report_blocker(&ctx.db, &ctx.conversation_id, &note) {
        Ok(report) => {
            let content = if report.blocked {
                crate::i18n::t_args(
                    "tools.exec.goal.blocked",
                    &[("streak", &goal::GOAL_BLOCKED_STREAK.to_string())],
                )
            } else {
                crate::i18n::t_args(
                    "tools.exec.goal.blocker",
                    &[
                        ("streak", &report.goal.blocker_streak.to_string()),
                        ("max", &goal::GOAL_BLOCKED_STREAK.to_string()),
                        ("reason", &truncate_for_tool_output(&note, 300)),
                    ],
                )
            };
            let summary = if report.blocked {
                crate::i18n::t("tools.exec.goal.blockedSummary")
            } else {
                crate::i18n::t_args(
                    "tools.exec.goal.blockerSummary",
                    &[
                        ("streak", &report.goal.blocker_streak.to_string()),
                        ("max", &goal::GOAL_BLOCKED_STREAK.to_string()),
                    ],
                )
            };
            finish_goal(ctx, report.goal, content, summary)
        }
        Err(error) => goal_error(error),
    }
}

/// Limita um texto narrativo devolvido ao modelo (mensagem curta, sem spill).
fn truncate_for_tool_output(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{truncated}…")
}

async fn todo_write(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let Some(raw) = args.get("todos") else {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t("tools.exec.todo.required"),
        );
    };
    let items: Vec<TodoItem> = match serde_json::from_value(raw.clone()) {
        Ok(items) => items,
        Err(error) => {
            return err(
                "TOOL_INVALID_ARGS",
                crate::i18n::t_args(
                    "tools.exec.todo.invalid",
                    &[("error", &error.to_string())],
                ),
            )
        }
    };
    // Lista vazia é válida e limpa a lista (`PLAN.md` D8/B-12); no máximo um
    // `in_progress` no agente principal.
    if let Err(message) = session::validate_todos(&items) {
        return err("TOOL_INVALID_ARGS", message);
    }
    if let Err(error) = session::save_todos(&ctx.db, &ctx.conversation_id, &ctx.turn_id, &items) {
        return err(
            "SESSION_LOG_FAILED",
            crate::i18n::t_args(
                "tools.exec.todo.saveFailed",
                &[("error", &error.to_string())],
            ),
        );
    }
    ctx.emit_event(crate::events::TurnEvent::TodosUpdated { todos: items.clone() });
    let count = |status: crate::domain::TodoStatus| {
        items.iter().filter(|item| item.status == status).count()
    };
    let content = if items.is_empty() {
        crate::i18n::t("tools.exec.todo.cleared")
    } else {
        crate::i18n::t_args(
            "tools.exec.todo.list",
            &[
                (
                    "pending",
                    &count(crate::domain::TodoStatus::Pending).to_string(),
                ),
                (
                    "in_progress",
                    &count(crate::domain::TodoStatus::InProgress).to_string(),
                ),
                (
                    "completed",
                    &count(crate::domain::TodoStatus::Completed).to_string(),
                ),
            ],
        )
    };
    finish(
        ctx,
        content,
        Some(crate::i18n::t_args(
            "tools.exec.todo.summary",
            &[("count", &items.len().to_string())],
        )),
        Some(json!({ "kind": "todos", "items": items })),
    )
}

async fn submit_plan(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    // Modo **vivo**: uma aprovação anterior, o chip ou `/plan off` podem ter
    // desligado o Plano no meio do turno (B-02).
    let plan_mode = match session::plan_mode_active(&ctx.db, &ctx.conversation_id) {
        Ok(active) => active,
        Err(error) => {
            return err(
                "SESSION_LOG_FAILED",
                crate::i18n::t_args(
                    "tools.exec.plan.readModeFailed",
                    &[("error", &error.to_string())],
                ),
            )
        }
    };
    if !plan_mode {
        return err(
            "PLAN_MODE_INACTIVE",
            crate::i18n::t("tools.exec.plan.inactive"),
        );
    }
    let markdown = match arg_str(args, "plan") {
        Ok(value) => value,
        Err(outcome) => return outcome,
    };
    if markdown.chars().count() > 20_000 {
        return err(
            "TOOL_INVALID_ARGS",
            crate::i18n::t("tools.exec.plan.tooLong"),
        );
    }
    if markdown.chars().count() < MIN_PLAN_CHARS {
        return err(
            "PLAN_TOO_BRIEF",
            crate::i18n::t_args(
                "tools.exec.plan.tooBrief",
                &[
                    ("count", &markdown.chars().count().to_string()),
                    ("min", &MIN_PLAN_CHARS.to_string()),
                ],
            ),
        );
    }
    if ctx.approval.is_none() {
        return err(
            "APPROVAL_UNAVAILABLE",
            crate::i18n::t("tools.exec.plan.noChannel"),
        );
    }

    // Persiste o draft **antes** de esperar a revisão: o plano sobrevive a
    // negação, timeout, crash e reabertura da sessão (B-07/D4). Falha de
    // persistência não pode ser mascarada como sucesso (B-13).
    if let Err(error) = session::submit_plan(&ctx.db, &ctx.conversation_id, &ctx.turn_id, &markdown) {
        return err(
            "SESSION_LOG_FAILED",
            crate::i18n::t_args(
                "tools.exec.plan.saveDraftFailed",
                &[("error", &error.to_string())],
            ),
        );
    }
    let Some(reviewing) = emit_plan_updated(ctx) else {
        return err(
            "SESSION_LOG_FAILED",
            crate::i18n::t("tools.exec.plan.projectionMissing"),
        );
    };

    let summary_text: String = markdown.chars().take(600).collect();
    let request = ApprovalRequest {
        id: format!("apr-{}", uuid::Uuid::new_v4().simple()),
        conversation_id: ctx.conversation_id.clone(),
        tool_call_id: ctx.tool_call_id.clone(),
        tool: "submit_plan".to_string(),
        title: crate::i18n::t("tools.exec.approvals.approvePlan"),
        detail: ApprovalDetail::Other { text: summary_text },
        risk: RiskClass::Ask,
        preview: Some(markdown.clone()),
        options: plan_approval_options(),
        created_at: now_ms(),
    };
    audit_append(
        ctx,
        EV_APPROVAL_ASKED,
        &json!({ "approvalId": request.id, "tool": "submit_plan", "risk": RiskClass::Ask }),
    );
    let approval_id = request.id.clone();
    let outcome = ctx.request_approval_until_decided(request).await;
    audit_append(
        ctx,
        EV_APPROVAL_DECIDED,
        &json!({
            "approvalId": approval_id,
            "decision": outcome.decision.as_str(),
            "choice": outcome.choice,
            "scope": outcome.scope.map(|scope| scope.as_str()),
            "feedback": outcome.feedback,
        }),
    );

    match outcome.decision {
        crate::domain::ApprovalDecision::Approved => {
            let execute_as_goal = outcome.execute_as_goal();
            // Aprovar o plano não troca o modo de permissão escolhido pelo
            // usuário: o Plano é um overlay e só `approve_review` pede
            // explicitamente o modo Revisar. `approve_run`/`approve_goal`
            // mantêm o modo vivo da sessão (antes, `approve_run` forçava
            // `Edit` e derrubava Leitura/Revisar/Autônomo).
            let current_mode = conversation_permission_mode(ctx);
            let mode = if outcome.review_each_edit() {
                PermissionMode::Review
            } else {
                current_mode
            };
            let review_each_edit = mode == PermissionMode::Review;
            // O markdown revisado na aprovação é o plano persistido (D3).
            let approved_markdown = outcome
                .plan_markdown
                .as_deref()
                .map(str::trim)
                .filter(|markdown| !markdown.is_empty())
                .unwrap_or(markdown.as_str());
            // O Goal é criado antes da aprovação: se a sessão já tiver um
            // objetivo ativo/pausado/bloqueado, o plano continua em revisão e
            // nada é sobrescrito (`goal::create` devolve GOAL_ALREADY_EXISTS).
            let goal_created = if execute_as_goal {
                if ctx.turn_kind != TurnKind::User {
                    return plan_error(
                        "GOAL_REQUIRES_USER_TURN",
                        crate::i18n::t("tools.exec.plan.goalRequiresUser"),
                        Some(&reviewing),
                    );
                }
                if ctx.workspace.is_none() {
                    return plan_error(
                        "GOAL_NO_WORKSPACE",
                        crate::i18n::t("tools.exec.plan.goalNoWorkspace"),
                        Some(&reviewing),
                    );
                }
                match goal::create(
                    &ctx.db,
                    &ctx.conversation_id,
                    &goal_input_for_approved_plan(),
                    GoalOrigin::User,
                ) {
                    Ok(goal) => Some(goal),
                    Err(error) => {
                        return plan_error(error.code, error.message, Some(&reviewing));
                    }
                }
            } else {
                None
            };
            if let Err(error) = session::approve_plan(
                &ctx.db,
                &ctx.conversation_id,
                &ctx.turn_id,
                Some(approved_markdown),
                review_each_edit,
            ) {
                // O objetivo foi criado, mas o plano não foi persistido:
                // desfaz o objetivo para não deixar execução sem plano.
                if goal_created.is_some() {
                    let _ = goal::delete(&ctx.db, &ctx.conversation_id);
                }
                return plan_error(
                    "SESSION_LOG_FAILED",
                    crate::i18n::t_args(
                        "tools.exec.plan.saveApprovalFailed",
                        &[("error", &error.to_string())],
                    ),
                    Some(&reviewing),
                );
            }
            // `approve_review` → modo Revisar (cada escrita pede aprovação);
            // as demais escolhas preservam o modo corrente da sessão.
            if mode != current_mode {
                if let Err(error) = ctx
                    .db
                    .set_conversation_permission_mode(&ctx.conversation_id, mode)
                {
                    return plan_error(
                        "SESSION_LOG_FAILED",
                        crate::i18n::t_args(
                            "tools.exec.plan.modeUpdateFailed",
                            &[("error", &error.to_string())],
                        ),
                        Some(&reviewing),
                    );
                }
            }
            let approved = emit_plan_updated(ctx);
            if let Some(goal) = goal_created {
                ctx.emit_event(crate::events::TurnEvent::GoalUpdated { goal });
            }
            ctx.emit_event(crate::events::TurnEvent::ProfileChanged {
                profile: CODE_PROFILE.to_string(),
                permission_mode: mode.as_str().to_string(),
                plan_mode: false,
            });
            let (content, summary) = if execute_as_goal {
                (
                    crate::i18n::t("tools.exec.plan.approvedGoal"),
                    crate::i18n::t("tools.exec.plan.approvedGoalSummary"),
                )
            } else {
                let next_step = match mode {
                    PermissionMode::ReadOnly => {
                        crate::i18n::t("tools.exec.plan.nextReadOnly")
                    }
                    PermissionMode::Edit => crate::i18n::t("tools.exec.plan.nextEdit"),
                    PermissionMode::Review => crate::i18n::t("tools.exec.plan.nextReview"),
                    PermissionMode::Autonomous => {
                        crate::i18n::t("tools.exec.plan.nextAutonomous")
                    }
                };
                (
                    crate::i18n::t_args(
                        "tools.exec.plan.approved",
                        &[("next", &next_step)],
                    ),
                    crate::i18n::t("tools.exec.plan.approvedSummary"),
                )
            };
            finish(
                ctx,
                content,
                Some(summary.to_string()),
                Some(
                    approved
                        .as_ref()
                        .map(plan_presentation)
                        .unwrap_or_else(|| plan_presentation(&reviewing)),
                ),
            )
        }
        crate::domain::ApprovalDecision::Denied => {
            let feedback = outcome
                .feedback
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| crate::i18n::t("tools.exec.plan.defaultFeedback"));
            if let Err(error) = session::plan_feedback(
                &ctx.db,
                &ctx.conversation_id,
                &ctx.turn_id,
                &feedback,
            ) {
                return plan_error(
                    "SESSION_LOG_FAILED",
                    crate::i18n::t_args(
                        "tools.exec.plan.saveFeedbackFailed",
                        &[("error", &error.to_string())],
                    ),
                    Some(&reviewing),
                );
            }
            let planning = emit_plan_updated(ctx);
            finish(
                ctx,
                crate::i18n::t_args(
                    "tools.exec.plan.denied",
                    &[("feedback", &feedback)],
                ),
                Some(crate::i18n::t("tools.exec.plan.reviewedSummary")),
                Some(planning.as_ref().map(plan_presentation).unwrap_or_else(|| {
                    json!({
                        "kind": "plan",
                        "state": "planning",
                        "feedback": feedback,
                        "updatedAt": reviewing.updated_at,
                    })
                })),
            )
        }
        crate::domain::ApprovalDecision::Cancelled => {
            let feedback = crate::i18n::t("tools.exec.plan.cancelledFeedback");
            if let Err(error) =
                session::plan_feedback(&ctx.db, &ctx.conversation_id, &ctx.turn_id, &feedback)
            {
                return plan_error(
                    "SESSION_LOG_FAILED",
                    crate::i18n::t_args(
                        "tools.exec.plan.saveFeedbackFailed",
                        &[("error", &error.to_string())],
                    ),
                    Some(&reviewing),
                );
            }
            let planning = emit_plan_updated(ctx);
            plan_error(
                "APPROVAL_CANCELLED",
                crate::i18n::t("tools.exec.plan.cancelled"),
                planning.as_ref().or(Some(&reviewing)),
            )
        }
        crate::domain::ApprovalDecision::Expired => {
            let feedback = crate::i18n::t("tools.exec.plan.expiredFeedback");
            if let Err(error) =
                session::plan_feedback(&ctx.db, &ctx.conversation_id, &ctx.turn_id, &feedback)
            {
                return plan_error(
                    "SESSION_LOG_FAILED",
                    crate::i18n::t_args(
                        "tools.exec.plan.saveFeedbackFailed",
                        &[("error", &error.to_string())],
                    ),
                    Some(&reviewing),
                );
            }
            let planning = emit_plan_updated(ctx);
            plan_error(
                "APPROVAL_TIMEOUT",
                crate::i18n::t("tools.exec.plan.expired"),
                planning.as_ref().or(Some(&reviewing)),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use serde_json::json;

    use crate::db::Db;
    use crate::domain::{PermissionMode, Settings, TodoStatus};
    use crate::harness::code::observed::ObservedFiles;
    use crate::policy::approval::{ApprovalOutcome, ApprovalRegistry};
    use crate::tools::registry::{ToolCtx, ToolExec, WorkspaceHandle};

    #[derive(Default)]
    struct Recorder {
        events: parking_lot::Mutex<Vec<Value>>,
    }

    impl crate::harness::EventEmitter for Recorder {
        fn emit(&self, event: crate::events::TurnEvent) {
            if let Ok(value) = serde_json::to_value(&event) {
                self.events.lock().push(value);
            }
        }
    }

    impl Recorder {
        fn events(&self) -> Vec<Value> {
            self.events.lock().clone()
        }
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        data_dir: PathBuf,
        db: Arc<Db>,
        /// Id da conversa criada no DB (a política lê o estado dela).
        conversation_id: String,
        observed: Arc<ObservedFiles>,
        approvals: Arc<ApprovalRegistry>,
        jobs: Arc<crate::jobs::JobRegistry>,
        recorder: Arc<Recorder>,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("tempdir");
            let root = temp.path().join("ws");
            std::fs::create_dir_all(&root).expect("workspace");
            let data_dir = temp.path().join("data");
            std::fs::create_dir_all(&data_dir).expect("data dir");
            let db = Arc::new(Db::open_in_memory().expect("db em memória"));
            // A política lê o modo de permissão e o workspace da conversa (B-02/B-06).
            let conversation = db
                .create_conversation_with_mode(
                    "Sessão de teste",
                    "opencode-go",
                    "deepseek-v4.1-flash",
                    crate::domain::CONVERSATION_MODE_CODE,
                )
                .expect("conversa de teste");
            Self {
                _temp: temp,
                root,
                data_dir,
                db,
                conversation_id: conversation.id,
                observed: Arc::new(ObservedFiles::new()),
                approvals: Arc::new(ApprovalRegistry::new()),
                jobs: Arc::new(crate::jobs::JobRegistry::new()),
                recorder: Arc::new(Recorder::default()),
            }
        }

        fn conv(&self) -> &str {
            &self.conversation_id
        }

        /// Troca o modo de permissão da conversa de teste (a política relê do DB).
        fn set_permission_mode(&self, mode: PermissionMode) {
            self.db
                .set_conversation_permission_mode(&self.conversation_id, mode)
                .expect("modo de permissão");
        }

        fn set_plan_mode(&self, active: bool) {
            session::set_plan_mode(&self.db, &self.conversation_id, active).expect("modo plano");
        }

        fn permission_mode(&self) -> PermissionMode {
            self.db
                .get_conversation(&self.conversation_id)
                .expect("conversa")
                .expect("conversa existente")
                .permission_mode
        }

        /// Registra um workspace no DB e vincula a conversa de teste (B-06).
        fn attach_workspace(&self) -> String {
            let workspace = self
                .db
                .create_workspace("demo", &self.root.to_string_lossy())
                .expect("workspace");
            self.db
                .set_conversation_workspace(&self.conversation_id, Some(&workspace.id))
                .expect("vincular workspace");
            workspace.id
        }

        fn ctx(&self) -> ToolCtx {
            self.ctx_for_turn(crate::domain::TurnKind::User)
        }

        /// Contexto com o tipo de turno (a tool `goal` distingue turno humano de
        /// rodada automática).
        fn ctx_for_turn(&self, turn_kind: crate::domain::TurnKind) -> ToolCtx {
            let emit: Arc<dyn crate::harness::EventEmitter> = self.recorder.clone();
            ToolCtx {
                turn_kind,
                db: self.db.clone(),
                http: reqwest::Client::new(),
                conversation_id: self.conversation_id.clone(),
                message_id: "msg-1".into(),
                tool_call_id: "call-1".into(),
                turn_id: "turn-1".into(),
                workspace: Some(WorkspaceHandle {
                    root: self.root.clone(),
                    trusted: true,
                    internal: false,
                    permission_mode: PermissionMode::Edit,
                }),
                settings: Settings::default(),
                cancel: tokio_util::sync::CancellationToken::new(),
                agent_hooks: None,
                data_dir: self.data_dir.clone(),
                approval: Some(self.approvals.clone()),
                observed: Some(self.observed.clone()),
                journal_owner: None,
                emit: Some(emit),
                rules: Vec::new(),
                jobs: Some(self.jobs.clone()),
                questions: None,
                mcp: None,
                subagent: None,
                enabled_tools: Arc::new(
                    crate::tools::registry::code_spec_refs()
                        .into_iter()
                        .map(|spec| spec.name.to_string())
                        .collect(),
                ),
                subagent_budget: Arc::new(std::sync::atomic::AtomicU32::new(0)),
                subagent_slots: Arc::new(tokio::sync::Semaphore::new(
                    crate::harness::code::subagent::MAX_CONCURRENT_SUBAGENTS,
                )),
                skills_roots: Vec::new(),
                allowed_skills: None,
            }
        }

        fn write(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.root.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("criar pai");
            }
            std::fs::write(&path, content).expect("escrever fixture");
            path
        }
    }

    async fn call(ctx: &ToolCtx, name: &str, args: Value) -> ToolOutcome {
        if name.starts_with("mcp__") {
            return super::run_mcp(ctx, name, args).await;
        }
        let exec = ToolExec::for_tool(name).expect("tool do catálogo");
        super::run(ctx, exec, args).await
    }

    fn error_code(outcome: &ToolOutcome) -> String {
        outcome
            .content
            .trim_start_matches("ERROR: ")
            .split(':')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    fn event_types(recorder: &Recorder) -> Vec<String> {
        recorder
            .events()
            .iter()
            .filter_map(|event| event.get("type").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    #[tokio::test]
    async fn internal_workspace_reads_files_outside_but_keeps_writes_confined() {
        let fixture = Fixture::new();
        let outside_dir = fixture.root.parent().expect("temp root").join("fora");
        std::fs::create_dir_all(&outside_dir).expect("outside dir");
        let outside_file = outside_dir.join("nota.txt");
        std::fs::write(&outside_file, "conteudo externo").expect("outside file");

        let mut ctx = fixture.ctx();
        ctx.workspace.as_mut().expect("workspace").internal = true;
        let outside = outside_file.to_string_lossy().to_string();

        let read = call(&ctx, "read_file", json!({ "path": outside })).await;
        assert!(!read.is_error, "{}", read.content);
        assert!(read.content.contains("conteudo externo"));

        let listed = call(
            &ctx,
            "list_dir",
            json!({ "path": outside_dir.to_string_lossy() }),
        )
        .await;
        assert!(!listed.is_error, "{}", listed.content);
        assert!(listed.content.contains("nota.txt"));

        let write = call(
            &ctx,
            "write_file",
            json!({ "path": outside, "content": "alterado" }),
        )
        .await;
        assert_eq!(error_code(&write), "FS_OUTSIDE_WORKSPACE");
    }

    #[tokio::test]
    async fn read_file_reads_a_range_and_records_observation() {
        let fixture = Fixture::new();
        let content: Vec<String> = (1..=120).map(|index| format!("linha {index}")).collect();
        let path = fixture.write("a.txt", &content.join("\n"));
        let ctx = fixture.ctx();

        let outcome = call(&ctx, "read_file", json!({ "path": "a.txt", "offset": 10, "limit": 5 })).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("linhas 10-14 de 120"), "{}", outcome.content);
        assert!(outcome.content.contains("10│ linha 10"), "{}", outcome.content);
        assert_eq!(outcome.summary.as_deref(), Some("Ler a.txt:10-14"));
        assert_eq!(
            fixture.observed.check(&path, &std::fs::read(&path).expect("ler")),
            ObservationState::Fresh
        );
    }

    #[tokio::test]
    async fn read_file_third_identical_read_appends_a_hint() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "conteudo\n");
        let ctx = fixture.ctx();

        let first = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        let second = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        assert!(!first.content.contains("Identical output"), "{}", first.content);
        assert!(!second.content.contains("Identical output"), "{}", second.content);

        let third = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        assert!(
            third.content.contains("Identical output received 3 times"),
            "{}",
            third.content
        );
        assert!(third.content.contains("Re-reading `a.txt`"), "{}", third.content);

        fixture.write("a.txt", "outro\n");
        let fourth = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        assert!(!fourth.content.contains("Identical output"), "{}", fourth.content);
    }

    #[tokio::test]
    async fn read_file_rejects_binary_and_missing_files() {
        let fixture = Fixture::new();
        fixture.write("bin.dat", "abc\0def");
        let ctx = fixture.ctx();
        let binary = call(&ctx, "read_file", json!({ "path": "bin.dat" })).await;
        assert_eq!(error_code(&binary), "FS_BINARY");
        let missing = call(&ctx, "read_file", json!({ "path": "nao-existe.txt" })).await;
        assert_eq!(error_code(&missing), "FS_NOT_FOUND");
        let out_of_range = call(&ctx, "read_file", json!({ "path": "bin.dat", "offset": 9 })).await;
        assert!(out_of_range.is_error);
    }

    #[tokio::test]
    async fn validate_ui_accepts_valid_blocks_and_reports_diagnostics() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        // The tool is local and must work even without an open workspace.
        ctx.workspace = None;

        let valid = call(
            &ctx,
            "validate_ui",
            json!({ "block": crate::tools::genui::contract::EXAMPLE_JSON }),
        )
        .await;
        assert!(!valid.is_error, "{}", valid.content);
        assert!(valid.content.contains("\"ok\":true"), "{}", valid.content);

        let invalid = call(&ctx, "validate_ui", json!({ "block": "{\"components\":[]}" })).await;
        assert!(!invalid.is_error, "a validação com erros não é falha da tool");
        assert!(invalid.content.contains("\"ok\":false"), "{}", invalid.content);
        assert!(invalid.content.contains("ui.empty"), "{}", invalid.content);

        let missing = call(&ctx, "validate_ui", json!({})).await;
        assert!(missing.is_error);
        assert!(missing.content.contains("`block`"));
    }

    #[tokio::test]
    async fn secret_files_require_approval_even_for_reads() {
        let fixture = Fixture::new();
        fixture.write(".env", "API_KEY=segredo");
        let mut ctx = fixture.ctx();
        ctx.approval = None;
        let outcome = call(&ctx, "read_file", json!({ "path": ".env" })).await;
        assert_eq!(error_code(&outcome), "APPROVAL_UNAVAILABLE");
    }

    #[tokio::test]
    async fn list_dir_skips_ignored_dirs_and_renders_dirs_with_slash() {
        let fixture = Fixture::new();
        fixture.write("src/a.ts", "x");
        fixture.write("src/b.rs", "y");
        fixture.write("node_modules/pkg/index.js", "z");
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "list_dir", json!({ "path": ".", "depth": 3 })).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("src/"), "{}", outcome.content);
        assert!(outcome.content.contains("a.ts"), "{}", outcome.content);
        assert!(!outcome.content.contains("node_modules"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn search_files_matches_globs() {
        let fixture = Fixture::new();
        fixture.write("src/a.ts", "x");
        fixture.write("src/b.rs", "y");
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "search_files", json!({ "pattern": "**/*.ts" })).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("src/a.ts"), "{}", outcome.content);
        assert!(!outcome.content.contains("b.rs"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn search_text_supports_regex_and_context() {
        let fixture = Fixture::new();
        fixture.write("src/a.ts", "const x = 1;\nfn foo() {\n  return x;\n}\n");
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "search_text",
            json!({ "query": "fn\\s+foo", "is_regex": true, "context_lines": 1 }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("src/a.ts:2: fn foo()"), "{}", outcome.content);
        assert!(outcome.content.contains("src/a.ts:1- const x"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn search_text_skips_secret_files() {
        let fixture = Fixture::new();
        fixture.write("id_rsa", "SECRET KEY MATERIAL\n");
        fixture.write("src/a.ts", "export const a = 1;\n");
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "search_text", json!({ "query": "SECRET" })).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(!outcome.content.contains("SECRET KEY MATERIAL"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn search_files_accepts_a_specific_file() {
        let fixture = Fixture::new();
        fixture.write("src/a.ts", "needle\n");
        fixture.write("src/b.ts", "needle\n");
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "search_files",
            json!({ "pattern": "a.ts", "path": "src/a.ts" }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("src/a.ts"), "{}", outcome.content);
        assert!(!outcome.content.contains("src/b.ts"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn search_text_accepts_a_specific_file() {
        let fixture = Fixture::new();
        fixture.write("src/a.ts", "needle\n");
        fixture.write("src/b.ts", "needle\n");
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "search_text",
            json!({ "query": "needle", "path": "src/a.ts" }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("src/a.ts:1: needle"), "{}", outcome.content);
        assert!(!outcome.content.contains("src/b.ts"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn search_text_missing_path_reports_not_found() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "search_text",
            json!({ "query": "needle", "path": "nao-existe.ts" }),
        )
        .await;
        assert_eq!(error_code(&outcome), "FS_NOT_FOUND");
    }

    #[tokio::test]
    async fn write_file_creates_records_journal_and_emits_event() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "write_file",
            json!({ "path": "src/novo.ts", "content": "export const a = 1;\n" }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(
            outcome.content.starts_with(&crate::i18n::t_args(
                "tools.exec.file.created",
                &[("path", "src/novo.ts"), ("added", "1")],
            )),
            "{}",
            outcome.content
        );
        assert_eq!(outcome.presentation.as_ref().expect("presentation")["kind"], "file_change");
        let journal = fixture
            .db
            .list_file_journal_for_turn(fixture.conv(), "turn-1")
            .expect("journal");
        assert_eq!(journal.len(), 1);
        assert_eq!(journal[0].path, "src/novo.ts");
        assert!(event_types(&fixture.recorder).contains(&"file_changed".to_string()));
        assert!(fixture.root.join("src/novo.ts").exists());
    }

    #[tokio::test]
    async fn write_file_requires_observation_and_rejects_stale_files() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "original\n");
        let ctx = fixture.ctx();
        let unobserved = call(&ctx, "write_file", json!({ "path": "a.txt", "content": "novo\n" })).await;
        assert_eq!(error_code(&unobserved), "FS_NOT_OBSERVED");

        let _ = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        fixture.write("a.txt", "mudou por fora\n");
        let stale = call(&ctx, "write_file", json!({ "path": "a.txt", "content": "novo\n" })).await;
        assert_eq!(error_code(&stale), "FS_STALE_VERSION");

        let _ = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        let ok = call(&ctx, "write_file", json!({ "path": "a.txt", "content": "novo\n" })).await;
        assert!(!ok.is_error, "{}", ok.content);
        assert!(ok
            .content
            .starts_with(&crate::i18n::t_args(
                "tools.exec.file.updated",
                &[("path", "a.txt"), ("added", "1"), ("removed", "1")],
            )));
    }

    #[tokio::test]
    async fn edit_file_replaces_unique_snippet_and_is_ambiguous_otherwise() {
        let fixture = Fixture::new();
        fixture.write("a.ts", "const value = 1;\n");
        let ctx = fixture.ctx();
        let _ = call(&ctx, "read_file", json!({ "path": "a.ts" })).await;
        let outcome = call(
            &ctx,
            "edit_file",
            json!({ "path": "a.ts", "old_string": "value = 1", "new_string": "value = 2" }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(
            outcome.content.starts_with(&crate::i18n::t_args(
                "tools.exec.file.updated",
                &[("path", "a.ts"), ("added", "1"), ("removed", "1")],
            )),
            "{}",
            outcome.content
        );
        assert!(std::fs::read_to_string(fixture.root.join("a.ts")).expect("ler").contains("value = 2"));

        fixture.write("b.ts", "x x\n");
        let _ = call(&ctx, "read_file", json!({ "path": "b.ts" })).await;
        let ambiguous = call(
            &ctx,
            "edit_file",
            json!({ "path": "b.ts", "old_string": "x", "new_string": "y" }),
        )
        .await;
        assert_eq!(error_code(&ambiguous), "TOOL_INVALID_ARGS");
        assert!(ambiguous.content.contains("2 vezes"), "{}", ambiguous.content);
        let all = call(
            &ctx,
            "edit_file",
            json!({ "path": "b.ts", "old_string": "x", "new_string": "y", "replace_all": true }),
        )
        .await;
        assert!(!all.is_error, "{}", all.content);
        assert_eq!(std::fs::read_to_string(fixture.root.join("b.ts")).expect("ler"), "y y\n");

        let missing = call(
            &ctx,
            "edit_file",
            json!({ "path": "a.ts", "old_string": "zzz", "new_string": "y" }),
        )
        .await;
        assert_eq!(error_code(&missing), "FS_NOT_FOUND");
    }

    #[tokio::test]
    async fn edit_file_matches_lf_snippets_in_crlf_files() {
        let fixture = Fixture::new();
        fixture.write("a.rs", "pub struct A {\r\n    pub x: u8,\r\n}\r\n");
        let ctx = fixture.ctx();
        let _ = call(&ctx, "read_file", json!({ "path": "a.rs" })).await;
        let outcome = call(
            &ctx,
            "edit_file",
            json!({
                "path": "a.rs",
                "old_string": "pub struct A {\n    pub x: u8,\n}",
                "new_string": "pub struct A {\n    pub x: u16,\n    pub y: u8,\n}"
            }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        let bytes = std::fs::read(fixture.root.join("a.rs")).expect("ler");
        assert_eq!(
            String::from_utf8(bytes).expect("utf8"),
            "pub struct A {\r\n    pub x: u16,\r\n    pub y: u8,\r\n}\r\n"
        );
    }

    #[tokio::test]
    async fn edit_file_normalizes_crlf_snippets_and_rejects_eol_only_changes() {
        let fixture = Fixture::new();
        fixture.write("b.txt", "alpha\nbeta\n");
        let ctx = fixture.ctx();
        let _ = call(&ctx, "read_file", json!({ "path": "b.txt" })).await;
        let noop = call(
            &ctx,
            "edit_file",
            json!({ "path": "b.txt", "old_string": "alpha\nbeta", "new_string": "alpha\r\nbeta" }),
        )
        .await;
        assert_eq!(error_code(&noop), "TOOL_INVALID_ARGS");
        let ok = call(
            &ctx,
            "edit_file",
            json!({ "path": "b.txt", "old_string": "alpha\r\nbeta", "new_string": "alpha\r\ngamma" }),
        )
        .await;
        assert!(!ok.is_error, "{}", ok.content);
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("b.txt")).expect("ler"),
            "alpha\ngamma\n"
        );
    }

    #[tokio::test]
    async fn large_results_spill_and_read_tool_output_pages_them() {
        let fixture = Fixture::new();
        let lines: Vec<String> = (0..700)
            .map(|index| format!("linha {index:03} {}", "x".repeat(80)))
            .collect();
        fixture.write("grande.txt", &lines.join("\n"));
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "read_file", json!({ "path": "grande.txt" })).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("spill"), "{}", outcome.content);
        let id = outcome
            .presentation
            .as_ref()
            .and_then(|value| value.get("spill"))
            .and_then(Value::as_str)
            .expect("id do spill")
            .to_string();
        let page = call(
            &ctx,
            "read_tool_output",
            json!({ "id": id, "offset": 10, "limit": 50 }),
        )
        .await;
        assert!(!page.is_error, "{}", page.content);
        assert!(page.content.contains("(spill"), "{}", page.content);

        let invalid = call(&ctx, "read_tool_output", json!({ "id": "curto" })).await;
        assert_eq!(error_code(&invalid), "SPILL_NOT_FOUND");
    }

    #[tokio::test]
    async fn run_command_returns_output_and_exit_codes_without_erroring() {
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let ctx = fixture.ctx();

        let ok = call(&ctx, "run_command", json!({ "command": "echo ola", "description": "testar echo" })).await;
        if error_code(&ok) == "EXEC_SPAWN" || error_code(&ok) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste pulado");
            return;
        }
        assert!(!ok.is_error, "{}", ok.content);
        assert!(ok.content.contains("exit code: 0"), "{}", ok.content);
        assert!(ok.content.contains("ola"), "{}", ok.content);

        let failed = call(&ctx, "run_command", json!({ "command": "exit 3", "description": "sair com 3" })).await;
        assert!(!failed.is_error, "{}", failed.content);
        assert!(failed.content.contains("exit code: 3"), "{}", failed.content);

        let background = call(
            &ctx,
            "run_command",
            json!({ "command": "echo x", "description": "bg", "run_in_background": true }),
        )
        .await;
        assert!(!background.is_error, "{}", background.content);
        assert_eq!(background.presentation.as_ref().expect("presentation")["kind"], "job");
        if let Some(job_id) = background
            .presentation
            .as_ref()
            .and_then(|value| value.get("job"))
            .and_then(|job| job.get("id"))
            .and_then(Value::as_str)
        {
            let _ = fixture.jobs.kill(job_id);
        }
    }

    #[tokio::test]
    async fn run_command_respects_plan_mode_read_only_and_missing_approval() {
        let fixture = Fixture::new();
        // Modo Plano agora é lido do banco a cada chamada (B-02): ligar o modo
        // depois de o `ToolCtx` existir já basta para negar a mutação.
        let ctx = fixture.ctx();
        fixture.set_plan_mode(true);
        let plan = call(&ctx, "run_command", json!({ "command": "echo x", "description": "x" })).await;
        assert_eq!(error_code(&plan), "PLAN_MODE_ACTIVE");

        fixture.set_plan_mode(false);
        fixture.set_permission_mode(PermissionMode::ReadOnly);
        let readonly = fixture.ctx();
        let denied = call(&readonly, "run_command", json!({ "command": "echo x", "description": "x" })).await;
        assert_eq!(error_code(&denied), "POLICY_DENIED");

        fixture.set_permission_mode(PermissionMode::Edit);
        let mut no_approval = fixture.ctx();
        no_approval.approval = None;
        let ask = call(&no_approval, "run_command", json!({ "command": "echo x", "description": "x" })).await;
        assert_eq!(error_code(&ask), "APPROVAL_UNAVAILABLE");
    }

    #[tokio::test]
    async fn plan_mode_runs_read_only_commands_and_file_scoped_searches() {
        let fixture = Fixture::new();
        fixture.write("nota.txt", "conteudo\n");
        fixture.set_permission_mode(PermissionMode::Autonomous);
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();

        let read = call(&ctx, "read_file", json!({ "path": "nota.txt" })).await;
        assert!(!read.is_error, "{}", read.content);
        assert!(read.content.contains("conteudo"), "{}", read.content);

        let search = call(
            &ctx,
            "search_text",
            json!({ "query": "conteudo", "path": "nota.txt" }),
        )
        .await;
        assert!(!search.is_error, "{}", search.content);
        assert!(search.content.contains("nota.txt:1"), "{}", search.content);

        let command = call(
            &ctx,
            "run_command",
            json!({ "command": "cat nota.txt", "description": "ler nota" }),
        )
        .await;
        if error_code(&command) == "EXEC_SPAWN" || error_code(&command) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: comando de leitura pulado");
        } else {
            assert!(!command.is_error, "{}", command.content);
            assert!(
                !command.content.contains("PLAN_MODE_ACTIVE"),
                "{}",
                command.content
            );
            assert!(command.content.contains("conteudo"), "{}", command.content);
        }

        let write = call(
            &ctx,
            "write_file",
            json!({ "path": "x.txt", "content": "x" }),
        )
        .await;
        assert_eq!(error_code(&write), "PLAN_MODE_ACTIVE");
    }

    #[tokio::test]
    async fn plan_mode_activated_mid_turn_blocks_writes_immediately() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        // Antes: Editar permite escrita.
        let allowed = call(&ctx, "write_file", json!({ "path": "a.txt", "content": "1" })).await;
        assert!(!allowed.is_error, "{}", allowed.content);

        // Chip/`/plan` liga o modo no meio do turno: o gate vale na hora.
        fixture.set_plan_mode(true);
        let blocked = call(&ctx, "write_file", json!({ "path": "b.txt", "content": "2" })).await;
        assert_eq!(error_code(&blocked), "PLAN_MODE_ACTIVE");
    }

    #[tokio::test]
    async fn readonly_and_untrusted_workspaces_block_writes_but_allow_reads() {
        let fixture = Fixture::new();
        fixture.write("a.txt", "conteudo\n");
        fixture.set_permission_mode(PermissionMode::ReadOnly);
        let readonly = fixture.ctx();
        let denied = call(&readonly, "write_file", json!({ "path": "b.txt", "content": "x" })).await;
        assert_eq!(error_code(&denied), "POLICY_DENIED");

        let mut untrusted = fixture.ctx();
        untrusted.workspace.as_mut().expect("ws").trusted = false;
        let blocked = call(&untrusted, "write_file", json!({ "path": "b.txt", "content": "x" })).await;
        assert_eq!(error_code(&blocked), "FS_UNTRUSTED_WORKSPACE");
        let read = call(&untrusted, "read_file", json!({ "path": "a.txt" })).await;
        assert!(!read.is_error, "{}", read.content);
    }

    #[tokio::test]
    async fn workspace_tools_fail_cleanly_without_a_workspace() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.workspace = None;
        let calls = [
            ("read_file", json!({ "path": "a.txt" })),
            ("list_dir", json!({})),
            ("search_files", json!({ "pattern": "*" })),
            ("search_text", json!({ "query": "x" })),
            ("git_status", json!({})),
            ("git_diff", json!({})),
            ("git_log", json!({})),
            ("write_file", json!({ "path": "a.txt", "content": "x" })),
            ("edit_file", json!({ "path": "a.txt", "old_string": "a", "new_string": "b" })),
            ("run_command", json!({ "command": "echo x", "description": "x" })),
        ];
        for (name, args) in calls {
            let outcome = call(&ctx, name, args).await;
            assert_eq!(error_code(&outcome), "FS_NO_WORKSPACE", "{name}: {}", outcome.content);
        }
    }

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn git(root: &Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn git_tools_report_status_diff_and_log_in_a_temp_repo() {
        if !git_available() {
            eprintln!("git indisponível: teste pulado");
            return;
        }
        let fixture = Fixture::new();
        if !git(&fixture.root, &["init", "-q"]) {
            eprintln!("git init indisponível: teste pulado");
            return;
        }
        let ctx = fixture.ctx();
        fixture.write("a.txt", "um\n");
        let status = call(&ctx, "git_status", json!({})).await;
        assert!(!status.is_error, "{}", status.content);
        assert!(status.content.contains("?? a.txt"), "{}", status.content);

        assert!(git(&fixture.root, &["add", "a.txt"]));
        assert!(git(
            &fixture.root,
            &["-c", "user.email=t@t.local", "-c", "user.name=teste", "commit", "-q", "-m", "init"]
        ));
        fixture.write("a.txt", "dois\n");
        let diff = call(&ctx, "git_diff", json!({ "paths": ["a.txt"] })).await;
        assert!(!diff.is_error, "{}", diff.content);
        assert!(diff.content.contains("dois"), "{}", diff.content);
        assert!(diff.content.contains("um"), "{}", diff.content);

        let log = call(&ctx, "git_log", json!({ "limit": 5 })).await;
        assert!(!log.is_error, "{}", log.content);
        assert!(log.content.contains("init"), "{}", log.content);
    }

    #[tokio::test]
    async fn git_tools_require_a_repository() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        for name in ["git_status", "git_diff", "git_log"] {
            let outcome = call(&ctx, name, json!({})).await;
            assert_eq!(error_code(&outcome), "GIT_NOT_A_REPO", "{name}");
        }
    }

    #[tokio::test]
    async fn todo_write_validates_saves_clears_and_emits() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "todo_write",
            json!({ "todos": [
                { "content": "Ler o módulo", "status": "completed" },
                { "content": "Corrigir o bug", "status": "in_progress" },
            ]}),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("1 concluída(s)"), "{}", outcome.content);
        assert_eq!(outcome.presentation.as_ref().expect("presentation")["kind"], "todos");
        assert_eq!(session::todos(&fixture.db, fixture.conv()).expect("tarefas").len(), 2);
        assert!(event_types(&fixture.recorder).contains(&"todos_updated".to_string()));

        // `[]` limpa a lista (B-12/D8) e o card recebe a lista vazia.
        let empty = call(&ctx, "todo_write", json!({ "todos": [] })).await;
        assert!(!empty.is_error, "{}", empty.content);
        assert!(empty.content.contains("limpa"), "{}", empty.content);
        assert_eq!(empty.presentation.as_ref().expect("presentation")["items"], json!([]));
        assert!(session::todos(&fixture.db, fixture.conv()).expect("tarefas").is_empty());

        let duplicate = call(
            &ctx,
            "todo_write",
            json!({ "todos": [
                { "content": "A", "status": "pending" },
                { "content": "a", "status": "pending" },
            ]}),
        )
        .await;
        assert_eq!(error_code(&duplicate), "TOOL_INVALID_ARGS");

        // Um único `in_progress` no agente principal (TOOLS §2.5 / D8).
        let parallel = call(
            &ctx,
            "todo_write",
            json!({ "todos": [
                { "content": "A", "status": "in_progress" },
                { "content": "B", "status": "in_progress" },
            ]}),
        )
        .await;
        assert_eq!(error_code(&parallel), "TOOL_INVALID_ARGS");
        assert!(parallel.content.contains("in_progress"), "{}", parallel.content);

        // Cap de 50 itens.
        let overflow: Vec<serde_json::Value> = (0..51)
            .map(|index| json!({ "content": format!("item {index}"), "status": "pending" }))
            .collect();
        let overflow = call(&ctx, "todo_write", json!({ "todos": overflow })).await;
        assert_eq!(error_code(&overflow), "TOOL_INVALID_ARGS");
        assert!(overflow.content.contains("50"), "{}", overflow.content);
    }

    async fn answer_next_approval(registry: Arc<ApprovalRegistry>, outcome: ApprovalOutcome) {
        for _ in 0..800 {
            if let Some(request) = registry.pending_requests().first() {
                registry.resolve(&request.id, outcome);
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn plan_state(fixture: &Fixture) -> crate::domain::PlanView {
        session::plan_view(&fixture.db, fixture.conv())
            .expect("projeção do plano")
            .expect("plano visível")
    }

    fn implementation_plan() -> String {
        "# Plano de teste\n\n\
         **Objetivo:** implementar a mudança de teste.\n\n\
         ## Contexto\n\
         O comportamento atual está em `src/a.ts`; a mudança preserva o contrato público.\n\n\
         ## Escopo\n\
         Dentro: `src/a.ts` e testes. Fora: migrations.\n\n\
         ## Mudanças por arquivo\n\
         | Arquivo | Símbolo/área | Mudança | Motivo |\n\
         | --- | --- | --- | --- |\n\
         | `src/a.ts` | `run` | validar entrada | evitar erro |\n\n\
         ## Passos\n\
         1. Alterar `run` em `src/a.ts` — pronto quando a entrada inválida retorna erro.\n\n\
         ## Testes e verificação\n\
         - `cargo test` — caso de entrada inválida verde.\n\n\
         ## Riscos e rollback\n\
         Risco: regressão; rollback: reverter `src/a.ts`.\n\n\
         ## Critérios de aceite\n\
         - [ ] Entrada inválida retorna erro.\n"
            .to_string()
    }

    fn current_goal(fixture: &Fixture) -> Option<GoalView> {
        goal::current(&fixture.db, fixture.conv()).expect("projeção do objetivo")
    }

    #[tokio::test]
    async fn submit_plan_requires_live_plan_mode() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let inactive = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        assert_eq!(error_code(&inactive), "PLAN_MODE_INACTIVE");
        assert!(session::plan_view(&fixture.db, fixture.conv()).expect("plano").is_none());

        // Ligar o modo depois de o ctx existir já destrava a tool (B-02).
        fixture.set_plan_mode(true);
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_run".to_string()), None),
        ));
        let approved = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);
    }

    #[tokio::test]
    async fn plan_review_waits_until_the_user_decides() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        let submit_ctx = ctx.clone();
        let submit = tokio::spawn(async move {
            call(
                &submit_ctx,
                "submit_plan",
                json!({ "plan": implementation_plan() }),
            )
            .await
        });

        let request_id = loop {
            if let Some(request) = fixture
                .approvals
                .pending_requests()
                .into_iter()
                .find(|request| request.tool == "submit_plan")
            {
                break request.id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(fixture.approvals.has_pending(&request_id));
        assert_eq!(
            session::plan_view(&fixture.db, fixture.conv())
                .expect("projeção")
                .expect("plano")
                .state,
            crate::domain::PlanState::Reviewing
        );

        assert!(fixture.approvals.resolve(
            &request_id,
            ApprovalOutcome::approved_plan(Some("approve_run".to_string()), None),
        ));
        let outcome = submit.await.expect("submit_plan task");
        assert!(!outcome.is_error, "{}", outcome.content);
    }

    #[tokio::test]
    async fn approved_plan_unlocks_mutations_in_the_same_turn_and_is_flat_in_the_card() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_run".to_string()), None),
        ));
        let plan = implementation_plan();
        let approved = call(&ctx, "submit_plan", json!({ "plan": &plan })).await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);

        // Presentation canônica **flat** (B-01): `{kind, state, markdown, updatedAt}`.
        let presentation = approved.presentation.expect("presentation do plano");
        assert_eq!(presentation["kind"], "plan");
        assert_eq!(presentation["state"], "approved");
        assert!(presentation.get("plan").is_none(), "não deve ser aninhado: {presentation}");
        assert_eq!(presentation["markdown"].as_str(), Some(plan.trim()));
        assert!(presentation["updatedAt"].is_number());

        // Projeção/flags de sessão.
        assert_eq!(plan_state(&fixture).state, crate::domain::PlanState::Approved);
        assert!(!session::plan_mode_active(&fixture.db, fixture.conv()).expect("modo"));
        assert_eq!(fixture.permission_mode(), PermissionMode::Edit);
        assert!(event_types(&fixture.recorder).contains(&"plan_updated".to_string()));
        assert!(event_types(&fixture.recorder).contains(&"profile_changed".to_string()));

        // O MESMO `ToolCtx` (sem refresh) já pode mutar: a política relê o DB.
        let write = call(&ctx, "write_file", json!({ "path": "src/a.ts", "content": "x" })).await;
        assert!(!write.is_error, "{}", write.content);
        assert!(fixture.root.join("src/a.ts").exists());
    }

    #[tokio::test]
    async fn approve_run_preserves_the_current_permission_mode() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        // Autônomo é o padrão das sessões novas; aprovar o plano não pode
        // rebaixar o usuário para Editar.
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_run".to_string()), None),
        ));
        let approved = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);
        assert_eq!(fixture.permission_mode(), PermissionMode::Autonomous);
        assert!(
            approved.content.contains("Modo Autônomo ativo"),
            "o modelo precisa saber o modo efetivo: {}",
            approved.content
        );

        // O mesmo `ToolCtx` segue autônomo: a escrita não pede aprovação.
        let write = call(&ctx, "write_file", json!({ "path": "src/a.ts", "content": "x" })).await;
        assert!(!write.is_error, "{}", write.content);
        assert!(fixture.root.join("src/a.ts").exists());
    }

    #[tokio::test]
    async fn approve_run_in_review_keeps_review_and_writes_still_ask() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        fixture.set_permission_mode(PermissionMode::Review);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_run".to_string()), None),
        ));
        let approved = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);
        assert_eq!(fixture.permission_mode(), PermissionMode::Review);
        assert!(
            approved.content.contains("Modo Revisar ativo"),
            "{}",
            approved.content
        );

        let mut no_channel = fixture.ctx();
        no_channel.approval = None;
        let write = call(&no_channel, "write_file", json!({ "path": "b.txt", "content": "x" })).await;
        assert_eq!(error_code(&write), "APPROVAL_UNAVAILABLE");
    }

    #[tokio::test]
    async fn approve_review_switches_to_review_and_writes_ask_approval() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_review".to_string()), None),
        ));
        let approved = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);
        assert_eq!(fixture.permission_mode(), PermissionMode::Review);

        // Leitura continua livre...
        fixture.write("a.txt", "conteudo\n");
        let read = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        assert!(!read.is_error, "{}", read.content);

        // ...e a escrita pede aprovação (sem canal = falha fechada, prova o Ask).
        let mut no_channel = fixture.ctx();
        no_channel.approval = None;
        let write = call(&no_channel, "write_file", json!({ "path": "b.txt", "content": "x" })).await;
        assert_eq!(error_code(&write), "APPROVAL_UNAVAILABLE");
    }

    #[tokio::test]
    async fn revised_plan_markdown_is_the_persisted_plan() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(
                Some("approve_run".to_string()),
                Some("# Plano revisado pelo usuário".to_string()),
            ),
        ));
        let approved = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);
        assert_eq!(plan_state(&fixture).markdown.as_deref(), Some("# Plano revisado pelo usuário"));
        assert_eq!(
            approved.presentation.expect("presentation")["markdown"],
            "# Plano revisado pelo usuário"
        );
    }

    #[tokio::test]
    async fn approve_goal_persists_the_plan_and_creates_a_goal_without_changing_permission() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        fixture.set_permission_mode(PermissionMode::Review);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_goal".to_string()), None),
        ));
        let approved = call(
            &ctx,
            "submit_plan",
            json!({ "plan": implementation_plan() }),
        )
        .await;
        responder.await.expect("responder");
        assert!(!approved.is_error, "{}", approved.content);
        assert!(approved.content.contains("Encerre este turno"), "{}", approved.content);
        assert_eq!(approved.presentation.expect("presentation")["state"], "approved");

        // Plano persistido e modo Plano encerrado; permissão preservada.
        assert_eq!(plan_state(&fixture).state, crate::domain::PlanState::Approved);
        assert!(!session::plan_mode_active(&fixture.db, fixture.conv()).expect("modo"));
        assert_eq!(fixture.permission_mode(), PermissionMode::Review);

        // Goal criado com continuidade automática e referência ao plano.
        let goal = current_goal(&fixture).expect("objetivo criado");
        assert_eq!(goal.status, crate::domain::GoalStatus::Active);
        assert!(goal.auto_continue);
        assert_eq!(goal.title, "Executar plano aprovado");
        assert!(goal.objective.contains("plano aprovado"), "{}", goal.objective);

        let events = event_types(&fixture.recorder);
        assert!(events.contains(&"plan_updated".to_string()), "{events:?}");
        assert!(events.contains(&"goal_updated".to_string()), "{events:?}");
        assert!(events.contains(&"profile_changed".to_string()), "{events:?}");
    }

    #[tokio::test]
    async fn approve_goal_does_not_overwrite_an_existing_goal() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let existing = goal::create(
            &fixture.db,
            fixture.conv(),
            &goal_input_for_approved_plan(),
            GoalOrigin::User,
        )
        .expect("objetivo existente");
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_goal".to_string()), None),
        ));
        let outcome = call(
            &ctx,
            "submit_plan",
            json!({ "plan": implementation_plan() }),
        )
        .await;
        responder.await.expect("responder");

        assert_eq!(error_code(&outcome), "GOAL_ALREADY_EXISTS");
        // O plano continua em revisão e o objetivo anterior permanece intacto.
        assert_eq!(plan_state(&fixture).state, crate::domain::PlanState::Reviewing);
        let goal = current_goal(&fixture).expect("objetivo existente");
        assert_eq!(goal.revision, existing.revision);
        assert_eq!(goal.created_at, existing.created_at);
    }

    #[tokio::test]
    async fn approve_goal_requires_a_workspace() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let mut ctx = fixture.ctx();
        ctx.workspace = None;
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::approved_plan(Some("approve_goal".to_string()), None),
        ));
        let outcome = call(
            &ctx,
            "submit_plan",
            json!({ "plan": implementation_plan() }),
        )
        .await;
        responder.await.expect("responder");

        assert_eq!(error_code(&outcome), "GOAL_NO_WORKSPACE");
        assert_eq!(plan_state(&fixture).state, crate::domain::PlanState::Reviewing);
        assert!(current_goal(&fixture).is_none());
    }

    #[tokio::test]
    async fn denied_plan_persists_feedback_and_returns_to_planning() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        let responder = tokio::spawn(answer_next_approval(
            fixture.approvals.clone(),
            ApprovalOutcome::denied(Some("faltou contexto".to_string())),
        ));
        let plan = implementation_plan();
        let denied = call(&ctx, "submit_plan", json!({ "plan": &plan })).await;
        responder.await.expect("responder");
        assert!(!denied.is_error, "{}", denied.content);
        assert!(denied.content.contains("Plano não aprovado"), "{}", denied.content);
        assert!(denied.content.contains("faltou contexto"), "{}", denied.content);
        assert!(
            denied.content.contains("critérios de aceite"),
            "{}",
            denied.content
        );

        let view = plan_state(&fixture);
        assert_eq!(view.state, crate::domain::PlanState::Planning);
        assert_eq!(view.markdown.as_deref(), Some(plan.trim()));
        assert_eq!(view.feedback.as_deref(), Some("faltou contexto"));
        // O draft foi persistido ANTES da revisão (B-07) e o modo continua ativo.
        assert!(session::plan_mode_active(&fixture.db, fixture.conv()).expect("modo"));
        let presentation = denied.presentation.expect("presentation do plano");
        assert_eq!(presentation["kind"], "plan");
        assert_eq!(presentation["state"], "planning");
        assert_eq!(presentation["feedback"], "faltou contexto");
        assert!(presentation.get("plan").is_none(), "não deve ser aninhado: {presentation}");
    }

    #[tokio::test]
    async fn too_brief_plan_is_rejected_before_persisting_or_asking() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "submit_plan", json!({ "plan": "### Plano\n1. Fazer" })).await;

        assert_eq!(error_code(&outcome), "PLAN_TOO_BRIEF");
        assert!(
            outcome.content.contains("arquivos/símbolos"),
            "{}",
            outcome.content
        );
        let view = plan_state(&fixture);
        assert_eq!(view.state, crate::domain::PlanState::Planning);
        assert!(view.markdown.is_none(), "plano curto não pode ser persistido");
        assert!(!event_types(&fixture.recorder).contains(&"plan_updated".to_string()));
        assert!(fixture.approvals.pending_requests().is_empty());
    }

    #[tokio::test]
    async fn cancelled_plan_review_persists_feedback_and_errors() {
        let fixture = Fixture::new();
        fixture.set_plan_mode(true);
        let ctx = fixture.ctx();
        ctx.cancel.cancel();
        let outcome = call(&ctx, "submit_plan", json!({ "plan": implementation_plan() })).await;
        assert_eq!(error_code(&outcome), "APPROVAL_CANCELLED");
        let view = plan_state(&fixture);
        assert_eq!(view.state, crate::domain::PlanState::Planning);
        assert!(view.feedback.is_some());
    }

    #[tokio::test]
    async fn workspace_scoped_rule_matches_through_the_live_policy() {
        let fixture = Fixture::new();
        let workspace_id = fixture.attach_workspace();
        let mut ctx = fixture.ctx();
        ctx.approval = None;
        ctx.rules = vec![crate::domain::ApprovalRule {
            id: "rule-ws".to_string(),
            scope: crate::domain::ApprovalScope::Workspace,
            scope_id: Some(workspace_id),
            tool: "run_command".to_string(),
            matcher: "prefix".to_string(),
            pattern: "git status".to_string(),
            decision: crate::domain::ApprovalDecision::Approved,
            created_at: 1,
        }];
        let allowed = call(
            &ctx,
            "run_command",
            json!({ "command": "git status", "description": "ver status" }),
        )
        .await;
        // A regra de workspace venceu o "ASK" do modo Editar: se a política
        // tivesse ignorado `workspace_id`, cairia em APPROVAL_UNAVAILABLE.
        assert_ne!(error_code(&allowed), "APPROVAL_UNAVAILABLE", "{}", allowed.content);
        assert_ne!(error_code(&allowed), "POLICY_DENIED", "{}", allowed.content);
    }



    #[test]
    fn project_hooks_parse_strings_and_objects() {
        let fixture = Fixture::new();
        fixture.write(
            ".zylara/hooks.json",
            r#"{"postWrite":["echo um",{"command":"echo dois"},"  ","echo tres"]}"#,
        );
        let hooks = super::project_post_write_hooks(&fixture.root);
        assert_eq!(hooks, vec!["echo um", "echo dois", "  ", "echo tres"]);
    }

    #[tokio::test]
    async fn write_file_runs_project_post_write_hooks() {
        let fixture = Fixture::new();
        fixture.write(
            ".zylara/hooks.json",
            r#"{"postWrite":["echo hook-run >> hook.log"]}"#,
        );
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "write_file",
            json!({ "path": "src/novo.ts", "content": "export const a = 1;\n" }),
        )
        .await;
        if error_code(&outcome) == "EXEC_SPAWN" || error_code(&outcome) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste de hook pulado");
            return;
        }
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("Hooks do projeto"), "{}", outcome.content);
        assert!(fixture.root.join("hook.log").exists(), "hook não escreveu o arquivo");
    }



    #[tokio::test]
    async fn internal_agent_workspace_never_runs_project_hooks() {
        let fixture = Fixture::new();
        fixture.write(
            ".zylara/hooks.json",
            r#"{"postWrite":["echo hook-run >> hook.log"]}"#,
        );
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let mut ctx = fixture.ctx();
        ctx.workspace.as_mut().expect("workspace").internal = true;
        let outcome = call(
            &ctx,
            "write_file",
            json!({ "path": "src/novo.ts", "content": "export const a = 1;\n" }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(!outcome.content.contains("Hooks do projeto"), "{}", outcome.content);
        assert!(!fixture.root.join("hook.log").exists());
    }

    #[tokio::test]
    async fn code_profile_reuses_chat_skills_catalog() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "list_skills", json!({})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(!outcome.content.contains("TOOL_UNKNOWN"), "{}", outcome.content);
    }

    #[tokio::test]
    async fn readonly_shell_command_does_not_need_approval_in_edit_mode() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.approval = None;
        let outcome = call(
            &ctx,
            "run_command",
            json!({ "command": "git status", "description": "ver status" }),
        )
        .await;
        if error_code(&outcome) == "EXEC_SPAWN" || error_code(&outcome) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste pulado");
            return;
        }
        assert_ne!(error_code(&outcome), "APPROVAL_UNAVAILABLE", "{}", outcome.content);
        assert_ne!(error_code(&outcome), "APPROVAL_DENIED", "{}", outcome.content);
    }

    #[tokio::test]
    async fn autonomous_runs_commands_without_an_approval_channel() {
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let mut ctx = fixture.ctx();
        ctx.approval = None;
        let outcome = call(
            &ctx,
            "run_command",
            json!({ "command": "echo autonomous-ok", "description": "teste autônomo" }),
        )
        .await;
        if error_code(&outcome) == "EXEC_SPAWN" || error_code(&outcome) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste pulado");
            return;
        }
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("autonomous-ok"), "{}", outcome.content);
        assert!(
            !event_types(&fixture.recorder).contains(&"approval_requested".to_string()),
            "approval_requested não pode existir no modo Autônomo"
        );
    }

    #[tokio::test]
    async fn autonomous_runs_destructive_commands_without_an_approval_channel() {
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let mut ctx = fixture.ctx();
        ctx.approval = None;
        let outcome = call(
            &ctx,
            "run_command",
            json!({ "command": "rm -rf build", "description": "limpar build" }),
        )
        .await;
        assert_ne!(error_code(&outcome), "APPROVAL_UNAVAILABLE", "{}", outcome.content);
        assert_ne!(error_code(&outcome), "APPROVAL_DENIED", "{}", outcome.content);
        assert!(
            !event_types(&fixture.recorder).contains(&"approval_requested".to_string()),
            "approval_requested não pode existir no modo Autônomo"
        );
    }

    #[tokio::test]
    async fn autonomous_reads_secret_files_without_an_approval_channel() {
        let fixture = Fixture::new();
        fixture.write(".env", "TOKEN=secret\n");
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let mut ctx = fixture.ctx();
        ctx.approval = None;

        let outcome = call(&ctx, "read_file", json!({ "path": ".env" })).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("TOKEN=secret"), "{}", outcome.content);

        fixture.set_permission_mode(PermissionMode::Edit);
        let edit = call(&ctx, "read_file", json!({ "path": ".env" })).await;
        assert_eq!(error_code(&edit), "APPROVAL_UNAVAILABLE");
    }

    #[tokio::test]
    async fn mcp_call_in_autonomous_mode_skips_approval() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.approval = None;
        ctx.mcp = Some(Arc::new(crate::mcp::McpManager::empty()));

        let edit = call(&ctx, "mcp__fs__read", json!({ "path": "x" })).await;
        assert_eq!(error_code(&edit), "APPROVAL_UNAVAILABLE");

        fixture.set_permission_mode(PermissionMode::Autonomous);
        let auto = call(&ctx, "mcp__fs__read", json!({ "path": "x" })).await;
        assert_eq!(error_code(&auto), "MCP_FAILED");
        assert!(auto.content.contains("MCP_UNKNOWN_SERVER"), "{}", auto.content);
    }

    #[tokio::test]
    async fn mcp_tool_without_manager_fails_closed_with_a_hint() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "mcp__fs__read", json!({ "path": "x" })).await;
        assert_eq!(error_code(&outcome), "MCP_UNAVAILABLE");
        assert!(outcome.content.contains("mcp.json"), "{}", outcome.content);
    }

    #[test]
    fn mcp_result_text_extracts_content_and_flags_errors() {
        let ok = serde_json::json!({
            "content": [{ "type": "text", "text": "linha 1" }, { "type": "text", "text": "linha 2" }]
        });
        assert_eq!(super::mcp_result_text(&ok), "linha 1\nlinha 2");
        let err = serde_json::json!({
            "isError": true,
            "content": [{ "type": "text", "text": "falhou" }]
        });
        assert!(super::mcp_result_text(&err).starts_with("MCP_ERROR"));
        let raw = serde_json::json!({ "foo": "bar" });
        assert!(super::mcp_result_text(&raw).contains("foo"));
        assert!(super::truncate_json(&raw, 100).contains("foo"));
        assert!(super::truncate_json(&raw, 3).ends_with('…'));
    }

    #[test]
    fn mcp_rules_match_exact_prefix_and_glob() {
        use crate::domain::{ApprovalDecision, ApprovalRule, ApprovalScope};
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        let rule = |id: &str, matcher: &str, pattern: &str, decision: ApprovalDecision| ApprovalRule {
            id: id.to_string(),
            scope: ApprovalScope::Session,
            scope_id: None,
            tool: "mcp".to_string(),
            matcher: matcher.to_string(),
            pattern: pattern.to_string(),
            decision,
            created_at: 1,
        };
        ctx.rules = vec![rule("r1", "prefix", "mcp__fs__", ApprovalDecision::Approved)];
        assert_eq!(
            super::mcp_rule_decision(&ctx, "mcp__fs__read"),
            Some(ApprovalDecision::Approved)
        );
        ctx.rules = vec![rule("r2", "glob", "mcp__*__write", ApprovalDecision::Denied)];
        assert_eq!(
            super::mcp_rule_decision(&ctx, "mcp__fs__write"),
            Some(ApprovalDecision::Denied)
        );
        ctx.rules = vec![rule("r3", "exact", "mcp__fs__read", ApprovalDecision::Approved)];
        assert_eq!(super::mcp_rule_decision(&ctx, "mcp__fs__other"), None);
    }
    #[tokio::test]
    async fn run_checks_reports_missing_project_checks_and_plan_mode() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let missing = call(&ctx, "run_checks", json!({})).await;
        assert_eq!(error_code(&missing), "NO_CHECKS");

        fixture.write("package.json", r#"{"name":"demo","scripts":{"test":"node -e \"console.log('ok')\""}}"#);
        fixture.set_plan_mode(true);
        let denied = call(&ctx, "run_checks", json!({})).await;
        assert_eq!(error_code(&denied), "PLAN_MODE_ACTIVE");
    }

    #[tokio::test]
    async fn run_checks_runs_the_detected_command_when_shell_is_available() {
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let ctx = fixture.ctx();
        fixture.write(
            "package.json",
            r#"{"name":"demo","scripts":{"test":"node -e \"console.log('checks-ok')\""}}"#,
        );
        let outcome = call(&ctx, "run_checks", json!({})).await;
        if error_code(&outcome) == "EXEC_SPAWN" || error_code(&outcome) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste pulado");
            return;
        }
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("[check:"), "{}", outcome.content);
        assert!(outcome.content.contains("exit code: 0"), "{}", outcome.content);
        let presentation = outcome.presentation.expect("presentation do check");
        assert_eq!(presentation["check"], "npm:test");
        assert_eq!(presentation["command"], "npm run test");
        assert_eq!(presentation["ecosystem"], "node");
    }
    #[tokio::test]
    async fn task_without_runner_is_an_actionable_error() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "task",
            json!({ "description": "Explorar", "prompt": "Mapeie src/" }),
        )
        .await;
        assert_eq!(error_code(&outcome), "SUBAGENT_UNAVAILABLE");
    }

    #[tokio::test]
    async fn worker_requires_the_parent_autonomous_mode() {
        let fixture = Fixture::new();
        fixture.attach_workspace();
        fixture.set_permission_mode(PermissionMode::Edit);
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(std::sync::Arc::new(NoopRunner));
        let outcome = call(
            &ctx,
            "task",
            json!({ "description": "Implementar", "prompt": "Crie a.txt", "subagent_type": "worker" }),
        )
        .await;
        assert_eq!(error_code(&outcome), "SUBAGENT_MODE_REQUIRED");

        fixture.set_permission_mode(PermissionMode::Autonomous);
        let outcome = call(
            &ctx,
            "task",
            json!({ "description": "Implementar", "prompt": "Crie a.txt", "subagent_type": "worker" }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
    }

    #[tokio::test]
    async fn worker_is_blocked_in_plan_mode() {
        let fixture = Fixture::new();
        fixture.attach_workspace();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        fixture.set_plan_mode(true);
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(std::sync::Arc::new(NoopRunner));
        let outcome = call(
            &ctx,
            "task",
            json!({ "description": "Implementar", "prompt": "Crie a.txt", "subagent_type": "worker" }),
        )
        .await;
        assert_eq!(error_code(&outcome), "PLAN_MODE_ACTIVE");
    }

    #[tokio::test]
    async fn worker_task_calls_do_not_overlap() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct OverlapRunner {
            active: Arc<AtomicUsize>,
            max_active: Arc<AtomicUsize>,
        }
        impl crate::harness::code::subagent::SubagentRunner for OverlapRunner {
            fn run(
                &self,
                _request: crate::harness::code::subagent::SubagentRequest,
                _cancel: tokio_util::sync::CancellationToken,
                _progress: Option<std::sync::Arc<dyn crate::harness::EventEmitter>>,
            ) -> futures_util::future::BoxFuture<
                'static,
                anyhow::Result<crate::harness::code::subagent::SubagentOutcome>,
            > {
                let active = self.active.clone();
                let max_active = self.max_active.clone();
                Box::pin(async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    max_active.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(crate::harness::code::subagent::SubagentOutcome {
                        conversation_id: "child-conv".to_string(),
                        provider_id: "opencode-go".to_string(),
                        model_id: "deepseek-v4.1-flash".to_string(),
                        effort: None,
                        text: "ok".to_string(),
                        usage: None,
                        steps: 1,
                        duration_ms: 1,
                    })
                })
            }
        }

        let fixture = Fixture::new();
        fixture.attach_workspace();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(Arc::new(OverlapRunner {
            active: active.clone(),
            max_active: max_active.clone(),
        }));
        let mut first = crate::domain::ToolCallRecord::running("task-1", "task");
        first.arguments =
            json!({ "description": "A", "prompt": "A", "subagent_type": "worker" }).to_string();
        let mut second = crate::domain::ToolCallRecord::running("task-2", "task");
        second.arguments =
            json!({ "description": "B", "prompt": "B", "subagent_type": "worker" }).to_string();
        let outcomes = crate::harness::code::tools::execute_batch(&ctx, &[first, second]).await;
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.iter().all(|outcome| !outcome.is_error), "{outcomes:?}");
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn write_file_journals_under_the_owner_turn() {
        let fixture = Fixture::new();
        fixture.attach_workspace();
        fixture.write("a.txt", "original\n");
        let mut ctx = fixture.ctx();
        ctx.journal_owner = Some(crate::domain::JournalOwner {
            conversation_id: "parent-conv".to_string(),
            turn_id: "parent-turn".to_string(),
        });
        let read = call(&ctx, "read_file", json!({ "path": "a.txt" })).await;
        assert!(!read.is_error, "{}", read.content);
        let write = call(
            &ctx,
            "write_file",
            json!({ "path": "a.txt", "content": "novo\n" }),
        )
        .await;
        assert!(!write.is_error, "{}", write.content);
        let parent = fixture
            .db
            .list_file_journal_for_turn("parent-conv", "parent-turn")
            .expect("journal do pai");
        assert!(parent.iter().any(|entry| entry.path == "a.txt"), "{parent:?}");
        let child = fixture
            .db
            .list_file_journal_for_turn(fixture.conv(), "turn-1")
            .expect("journal do filho");
        assert!(child.is_empty(), "{child:?}");
    }

    #[tokio::test]
    async fn task_returns_the_child_summary_and_presentation() {
        struct FakeRunner;
        impl crate::harness::code::subagent::SubagentRunner for FakeRunner {
            fn run(
                &self,
                request: crate::harness::code::subagent::SubagentRequest,
                _cancel: tokio_util::sync::CancellationToken,
                _progress: Option<std::sync::Arc<dyn crate::harness::EventEmitter>>,
            ) -> futures_util::future::BoxFuture<
                'static,
                anyhow::Result<crate::harness::code::subagent::SubagentOutcome>,
            > {
                Box::pin(async move {
                    Ok(crate::harness::code::subagent::SubagentOutcome {
                        conversation_id: "child-conv".to_string(),
                        provider_id: "opencode-go".to_string(),
                        model_id: "deepseek-v4.1-flash".to_string(),
                        effort: None,
                        text: format!("resumo de `{}`", request.description),
                        usage: Some(crate::domain::UsageInfo {
                            input_tokens: Some(10),
                            output_tokens: Some(5),
                            total_tokens: Some(15),
                            ..Default::default()
                        }),
                        steps: 2,
                        duration_ms: 5,
                    })
                })
            }
        }
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(std::sync::Arc::new(FakeRunner));
        let outcome = call(
            &ctx,
            "task",
            json!({
                "description": "Explorar o módulo de pagamentos",
                "prompt": "Liste os arquivos e responda",
                "subagent_type": "explore"
            }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("resumo de `Explorar o módulo de pagamentos`"));
        let presentation = outcome.presentation.expect("presentation");
        assert_eq!(presentation["kind"], "subagent");
        assert_eq!(presentation["subagentType"], "explore");
        assert_eq!(presentation["steps"], 2);
        assert_eq!(presentation["durationMs"], 5);
        assert_eq!(presentation["usage"]["totalTokens"], 15);
    }

    #[tokio::test]
    async fn task_forwards_model_and_effort_to_the_runner() {
        struct CapturingRunner {
            seen: Arc<std::sync::Mutex<Option<crate::harness::code::subagent::SubagentRequest>>>,
        }
        impl crate::harness::code::subagent::SubagentRunner for CapturingRunner {
            fn run(
                &self,
                request: crate::harness::code::subagent::SubagentRequest,
                _cancel: tokio_util::sync::CancellationToken,
                _progress: Option<Arc<dyn crate::harness::EventEmitter>>,
            ) -> futures_util::future::BoxFuture<
                'static,
                anyhow::Result<crate::harness::code::subagent::SubagentOutcome>,
            > {
                *self.seen.lock().expect("lock") = Some(request.clone());
                Box::pin(async move {
                    Ok(crate::harness::code::subagent::SubagentOutcome {
                        conversation_id: "child-conv".to_string(),
                        provider_id: "openai".to_string(),
                        model_id: "gpt-6-luna".to_string(),
                        effort: Some("high".to_string()),
                        text: "ok".to_string(),
                        usage: None,
                        steps: 1,
                        duration_ms: 1,
                    })
                })
            }
        }

        let fixture = Fixture::new();
        let seen = Arc::new(std::sync::Mutex::new(None));
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(Arc::new(CapturingRunner { seen: seen.clone() }));
        let outcome = call(
            &ctx,
            "task",
            json!({
                "description": "Revisar",
                "prompt": "Aponte bugs",
                "subagent_type": "review",
                "model": "openai/gpt-6-luna",
                "effort": "high"
            }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        let request = seen.lock().expect("lock").clone().expect("request");
        assert_eq!(request.task_call_id, "call-1");
        assert_eq!(request.model.as_deref(), Some("openai/gpt-6-luna"));
        assert_eq!(request.effort.as_deref(), Some("high"));
        let presentation = outcome.presentation.expect("presentation");
        assert_eq!(presentation["providerId"], "openai");
        assert_eq!(presentation["modelId"], "gpt-6-luna");
        assert_eq!(presentation["effort"], "high");
    }

    #[tokio::test]
    async fn independent_task_calls_run_in_parallel() {
        struct BarrierRunner {
            barrier: Arc<tokio::sync::Barrier>,
        }
        impl crate::harness::code::subagent::SubagentRunner for BarrierRunner {
            fn run(
                &self,
                _request: crate::harness::code::subagent::SubagentRequest,
                _cancel: tokio_util::sync::CancellationToken,
                _progress: Option<Arc<dyn crate::harness::EventEmitter>>,
            ) -> futures_util::future::BoxFuture<
                'static,
                anyhow::Result<crate::harness::code::subagent::SubagentOutcome>,
            > {
                let barrier = self.barrier.clone();
                Box::pin(async move {
                    barrier.wait().await;
                    Ok(crate::harness::code::subagent::SubagentOutcome {
                        conversation_id: "child-conv".to_string(),
                        provider_id: "opencode-go".to_string(),
                        model_id: "deepseek-v4.1-flash".to_string(),
                        effort: None,
                        text: "ok".to_string(),
                        usage: None,
                        steps: 1,
                        duration_ms: 1,
                    })
                })
            }
        }

        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(Arc::new(BarrierRunner {
            barrier: Arc::new(tokio::sync::Barrier::new(2)),
        }));
        let mut first = crate::domain::ToolCallRecord::running("task-1", "task");
        first.arguments =
            json!({ "description": "Explorar A", "prompt": "Mapeie A" }).to_string();
        let mut second = crate::domain::ToolCallRecord::running("task-2", "task");
        second.arguments =
            json!({ "description": "Explorar B", "prompt": "Mapeie B" }).to_string();
        let outcomes = tokio::time::timeout(
            Duration::from_secs(3),
            crate::harness::code::tools::execute_batch(&ctx, &[first, second]),
        )
        .await
        .expect("as duas tasks devem rodar em paralelo");
        assert_eq!(outcomes.len(), 2);
        assert!(outcomes.iter().all(|outcome| !outcome.is_error), "{outcomes:?}");
    }

    #[tokio::test]
    async fn task_enforces_the_per_turn_delegation_budget() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(std::sync::Arc::new(NoopRunner));
        for _ in 0..crate::harness::code::subagent::MAX_DELEGATIONS_PER_TURN {
            let outcome = call(
                &ctx,
                "task",
                json!({ "description": "Explorar", "prompt": "Mapeie src/" }),
            )
            .await;
            assert!(!outcome.is_error, "{}", outcome.content);
        }
        let outcome = call(
            &ctx,
            "task",
            json!({ "description": "Explorar", "prompt": "Mapeie src/" }),
        )
        .await;
        assert_eq!(error_code(&outcome), "SUBAGENT_LIMIT");
    }

    #[tokio::test]
    async fn task_cancelled_by_the_parent_returns_immediately() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(std::sync::Arc::new(PendingRunner));
        ctx.cancel.cancel();
        let outcome = call(
            &ctx,
            "task",
            json!({ "description": "Explorar", "prompt": "Mapeie src/" }),
        )
        .await;
        assert_eq!(error_code(&outcome), "SUBAGENT_CANCELLED");
    }

    struct PendingRunner;

    impl crate::harness::code::subagent::SubagentRunner for PendingRunner {
        fn run(
            &self,
            _request: crate::harness::code::subagent::SubagentRequest,
            _cancel: tokio_util::sync::CancellationToken,
            _progress: Option<std::sync::Arc<dyn crate::harness::EventEmitter>>,
        ) -> futures_util::future::BoxFuture<
            'static,
            anyhow::Result<crate::harness::code::subagent::SubagentOutcome>,
        > {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn task_rejects_unknown_subagent_type() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.subagent = Some(std::sync::Arc::new(NoopRunner));
        let outcome = call(
            &ctx,
            "task",
            json!({
                "description": "Explorar",
                "prompt": "Mapeie src/",
                "subagent_type": "revisor-typo"
            }),
        )
        .await;
        assert_eq!(error_code(&outcome), "SUBAGENT_INVALID_TYPE");
    }

    struct NoopRunner;

    impl crate::harness::code::subagent::SubagentRunner for NoopRunner {
        fn run(
            &self,
            _request: crate::harness::code::subagent::SubagentRequest,
            _cancel: tokio_util::sync::CancellationToken,
            _progress: Option<std::sync::Arc<dyn crate::harness::EventEmitter>>,
        ) -> futures_util::future::BoxFuture<
            'static,
            anyhow::Result<crate::harness::code::subagent::SubagentOutcome>,
        > {
            Box::pin(async move {
                Ok(crate::harness::code::subagent::SubagentOutcome {
                    conversation_id: "child-conv".to_string(),
                    provider_id: "opencode-go".to_string(),
                    model_id: "deepseek-v4.1-flash".to_string(),
                    effort: None,
                    text: "ok".to_string(),
                    usage: None,
                    steps: 1,
                    duration_ms: 1,
                })
            })
        }
    }
    #[tokio::test]
    async fn ask_user_without_a_channel_is_an_actionable_error() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(&ctx, "ask_user", json!({ "questions": [] })).await;
        assert_eq!(error_code(&outcome), "ASK_USER_UNAVAILABLE");
    }

    #[tokio::test]
    async fn ask_user_waits_for_the_user_card_even_in_autonomous_mode() {
        use crate::harness::code::questions::QuestionRegistry;
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let registry = std::sync::Arc::new(QuestionRegistry::new());
        let mut ctx = fixture.ctx();
        ctx.questions = Some(registry.clone());

        let registry_for_answer = registry.clone();
        let answer_handle = tokio::spawn(async move {
            for _ in 0..200 {
                let pending = registry_for_answer.pending_requests();
                if let Some(request) = pending.first() {
                    let question_id = request.questions[0].id.clone();
                    let _ = registry_for_answer.resolve(crate::domain::AskUserResponse {
                        request_id: request.id.clone(),
                        answers: vec![crate::domain::AskUserAnswer {
                            question_id,
                            selected: vec!["SQLite".to_string()],
                            custom: None,
                        }],
                        skipped: false,
                    });
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            panic!("a pergunta nunca foi registrada");
        });

        let outcome = call(
            &ctx,
            "ask_user",
            json!({
                "questions": [{
                    "id": "db",
                    "question": "Qual banco devo usar?",
                    "options": [{ "label": "SQLite" }, { "label": "Postgres" }]
                }]
            }),
        )
        .await;
        let _ = answer_handle.await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("SQLite"), "{}", outcome.content);
        let presentation = outcome.presentation.expect("presentation");
        assert_eq!(presentation["kind"], "answers");
        assert_eq!(presentation["skipped"], false);
    }

    #[tokio::test]
    async fn todos_and_todo_status_roundtrip_through_the_projection() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "todo_write",
            json!({ "todos": [{ "content": "Um item", "status": "pending" }] }),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        let todos = session::todos(&fixture.db, fixture.conv()).expect("tarefas");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].status, TodoStatus::Pending);
    }
    #[tokio::test]
    async fn background_jobs_can_be_listed_read_and_killed() {
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let ctx = fixture.ctx();
        let started = call(
            &ctx,
            "run_command",
            json!({ "command": "echo job-ok", "description": "bg", "run_in_background": true }),
        )
        .await;
        if error_code(&started) == "EXEC_SPAWN" || error_code(&started) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste pulado");
            return;
        }
        assert!(!started.is_error, "{}", started.content);
        assert_eq!(started.presentation.as_ref().expect("presentation")["kind"], "job");
        let job_id = started
            .presentation
            .as_ref()
            .and_then(|value| value.get("job"))
            .and_then(|job| job.get("id"))
            .and_then(Value::as_str)
            .expect("id do job no presentation")
            .to_string();
        assert!(started.content.contains(&job_id), "{}", started.content);

        // Espera o job assentar (echo termina rápido).
        for _ in 0..200 {
            let settled = fixture
                .jobs
                .list(fixture.conv())
                .into_iter()
                .find(|view| view.id == job_id)
                .map(|view| view.status != crate::domain::JobStatus::Running)
                .unwrap_or(false);
            if settled {
                break;
            }
            let _ = fixture.jobs.wait(&job_id, Duration::from_millis(25)).await;
        }

        let listed = call(&ctx, "job_list", json!({})).await;
        assert!(!listed.is_error, "{}", listed.content);
        assert!(listed.content.contains(&job_id), "{}", listed.content);

        let output = call(&ctx, "job_output", json!({ "job_id": job_id })).await;
        assert!(!output.is_error, "{}", output.content);
        assert!(output.content.contains("job-ok"), "{}", output.content);
        assert!(output.content.contains("next_cursor"), "{}", output.content);

        let killed = call(&ctx, "job_kill", json!({ "job_id": job_id })).await;
        assert!(!killed.is_error, "{}", killed.content);
        fixture.jobs.remove(&job_id);
    }

    #[tokio::test]
    async fn foreground_timeout_promotes_the_job_instead_of_killing_it() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 20";
        #[cfg(not(windows))]
        let script = "sleep 20";
        let fixture = Fixture::new();
        fixture.set_permission_mode(PermissionMode::Autonomous);
        let ctx = fixture.ctx();
        let outcome = call(
            &ctx,
            "run_command",
            json!({ "command": script, "description": "longo", "timeout_ms": 1_000 }),
        )
        .await;
        if error_code(&outcome) == "EXEC_SPAWN" || error_code(&outcome) == "EXEC_FAILED" {
            eprintln!("shell indisponível neste ambiente: teste pulado");
            return;
        }
        assert!(!outcome.is_error, "{}", outcome.content);
        let presentation = outcome.presentation.as_ref().expect("presentation");
        assert_eq!(presentation["kind"], "job");
        let job_id = presentation["job"]["id"]
            .as_str()
            .expect("id do job")
            .to_string();
        assert!(outcome.content.contains(&job_id), "{}", outcome.content);
        let _ = fixture.jobs.kill(&job_id);
        let _ = fixture.jobs.wait(&job_id, Duration::from_millis(2_000)).await;
        fixture.jobs.remove(&job_id);
    }

    #[tokio::test]
    async fn job_tools_require_a_registry_and_kill_asks_without_approval() {
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx();
        ctx.jobs = None;
        let unavailable = call(&ctx, "job_list", json!({})).await;
        assert_eq!(error_code(&unavailable), "JOB_UNAVAILABLE");
        let missing = call(&ctx, "job_kill", json!({ "job_id": "job-nope" })).await;
        assert_eq!(error_code(&missing), "JOB_UNAVAILABLE");

        // Em modo Editar, job_kill é Shell → pede aprovação; sem canal = falha fechada.
        let mut no_approval = fixture.ctx();
        no_approval.approval = None;
        let ask = call(&no_approval, "job_kill", json!({ "job_id": "job-nope" })).await;
        assert_eq!(error_code(&ask), "APPROVAL_UNAVAILABLE");
    }

    /* ---------------- tool `goal` ---------------- */

    #[tokio::test]
    async fn goal_create_only_in_human_turn_and_com_apresentacao_flat() {
        let fixture = Fixture::new();
        let human = fixture.ctx_for_turn(crate::domain::TurnKind::User);
        let created = call(
            &human,
            "goal",
            json!({
                "action": "create",
                "objective": "Migrar o módulo de pagamentos para o novo SDK",
                "title": "Migrar pagamentos",
                "max_rounds": 10
            }),
        )
        .await;
        assert!(!created.is_error, "{}", created.content);
        assert!(created.content.contains("Objetivo criado"), "{}", created.content);
        let presentation = created.presentation.as_ref().expect("presentation");
        assert_eq!(presentation["kind"], "goal", "card flat: {presentation}");
        assert!(presentation.get("goal").is_none(), "não aninha: {presentation}");
        assert_eq!(presentation["status"], "active");
        assert_eq!(presentation["origin"], "agent");
        assert_eq!(
            presentation["autoContinue"], true,
            "fluxo /goal arma a continuidade por default"
        );
        assert_eq!(presentation["maxRounds"], 10);
        assert!(event_types(&fixture.recorder).contains(&"goal_updated".to_string()));

        // Segundo create recusa: já existe objetivo ativo.
        let again = call(
            &human,
            "goal",
            json!({ "action": "create", "objective": "Outro" }),
        )
        .await;
        assert_eq!(error_code(&again), "GOAL_ALREADY_EXISTS");

        // Em rodada de objetivo, create/edit exigem turno humano.
        let round = fixture.ctx_for_turn(crate::domain::TurnKind::GoalRound);
        let refused = call(
            &round,
            "goal",
            json!({ "action": "create", "objective": "Outro" }),
        )
        .await;
        assert_eq!(error_code(&refused), "GOAL_REQUIRES_USER_TURN");
        let edit_refused = call(
            &round,
            "goal",
            json!({ "action": "edit", "objective": "Outro" }),
        )
        .await;
        assert_eq!(error_code(&edit_refused), "GOAL_REQUIRES_USER_TURN");
    }

    #[tokio::test]
    async fn goal_create_can_explicitly_disable_auto_continue() {
        let fixture = Fixture::new();
        let human = fixture.ctx_for_turn(crate::domain::TurnKind::User);
        let created = call(
            &human,
            "goal",
            json!({
                "action": "create",
                "objective": "Objetivo manual",
                "auto_continue": false
            }),
        )
        .await;
        assert!(!created.is_error, "{}", created.content);
        let presentation = created.presentation.as_ref().expect("presentation");
        assert_eq!(presentation["autoContinue"], false);
        assert!(created
            .content
            .contains("continuidade automática desligada"), "{}", created.content);
    }

    #[tokio::test]
    async fn goal_edit_progress_complete_and_blocked_flow() {
        let fixture = Fixture::new();
        let human = fixture.ctx_for_turn(crate::domain::TurnKind::User);
        let created = call(
            &human,
            "goal",
            json!({ "action": "create", "objective": "Objetivo do fluxo" }),
        )
        .await;
        assert!(!created.is_error, "{}", created.content);

        // `edit` só em turno humano e exige ao menos um campo.
        let empty_edit = call(&human, "goal", json!({ "action": "edit" })).await;
        assert_eq!(error_code(&empty_edit), "TOOL_INVALID_ARGS");
        let edited = call(
            &human,
            "goal",
            json!({ "action": "edit", "max_rounds": 7, "title": "Título novo" }),
        )
        .await;
        assert!(!edited.is_error, "{}", edited.content);
        assert_eq!(edited.presentation.as_ref().expect("presentation")["maxRounds"], 7);

        // Progress/completar/bloquear valem em rodada.
        let round = fixture.ctx_for_turn(crate::domain::TurnKind::GoalRound);
        let progress = call(
            &round,
            "goal",
            json!({ "action": "progress", "note": "implementei a migração" }),
        )
        .await;
        assert!(!progress.is_error, "{}", progress.content);
        assert!(progress.content.contains("Progresso registrado"), "{}", progress.content);
        assert!(event_types(&fixture.recorder).contains(&"goal_updated".to_string()));

        let missing_note = call(&round, "goal", json!({ "action": "progress" })).await;
        assert_eq!(error_code(&missing_note), "TOOL_INVALID_ARGS");

        let completed = call(
            &round,
            "goal",
            json!({ "action": "complete", "note": "42 testes verdes" }),
        )
        .await;
        assert!(!completed.is_error, "{}", completed.content);
        assert_eq!(completed.presentation.as_ref().expect("presentation")["status"], "completed");

        // Progresso depois de concluído é recusado (sem ressuscitar o objetivo).
        let after = call(
            &round,
            "goal",
            json!({ "action": "progress", "note": "mais um" }),
        )
        .await;
        assert_eq!(error_code(&after), "GOAL_NOT_ACTIVE");
    }

    #[tokio::test]
    async fn goal_blocked_requires_note_and_blocks_on_the_third_same_reason() {
        let fixture = Fixture::new();
        let human = fixture.ctx_for_turn(crate::domain::TurnKind::User);
        call(&human, "goal", json!({ "action": "create", "objective": "Objetivo bloqueável" }))
            .await;
        let round = fixture.ctx_for_turn(crate::domain::TurnKind::GoalRound);

        let no_note = call(&round, "goal", json!({ "action": "blocked" })).await;
        assert_eq!(error_code(&no_note), "TOOL_INVALID_ARGS");

        let first = call(
            &round,
            "goal",
            json!({ "action": "blocked", "note": "dependência externa fora do ar" }),
        )
        .await;
        assert!(!first.is_error, "{}", first.content);
        assert!(first.content.contains("(1/3)"), "{}", first.content);
        let second = call(
            &round,
            "goal",
            json!({ "action": "blocked", "note": "Dependência externa fora do ar" }),
        )
        .await;
        assert!(second.content.contains("(2/3)"), "{}", second.content);

        let third = call(
            &round,
            "goal",
            json!({ "action": "blocked", "note": "dependência externa fora do ar" }),
        )
        .await;
        assert!(!third.is_error, "{}", third.content);
        assert!(third.content.contains("Objetivo bloqueado"), "{}", third.content);
        assert_eq!(third.presentation.as_ref().expect("presentation")["status"], "blocked");

        // Novo progresso em objetivo bloqueado: recusado.
        let progress = call(&round, "goal", json!({ "action": "progress", "note": "x" })).await;
        assert_eq!(error_code(&progress), "GOAL_NOT_ACTIVE");
    }

    #[tokio::test]
    async fn goal_validates_limits_and_requires_an_existing_goal() {
        let fixture = Fixture::new();
        let human = fixture.ctx_for_turn(crate::domain::TurnKind::User);
        let without_goal = call(&human, "goal", json!({ "action": "complete" })).await;
        assert_eq!(error_code(&without_goal), "GOAL_NOT_FOUND");

        let long_objective = "x".repeat(goal::GOAL_MAX_OBJECTIVE_CHARS + 1);
        let oversized = call(
            &human,
            "goal",
            json!({ "action": "create", "objective": long_objective }),
        )
        .await;
        assert_eq!(error_code(&oversized), "GOAL_INVALID_ARGS");

        let invalid_action = call(&human, "goal", json!({ "action": "delete" })).await;
        assert_eq!(error_code(&invalid_action), "TOOL_INVALID_ARGS");

        // Limites da nota também são validados pela tool.
        call(&human, "goal", json!({ "action": "create", "objective": "Objetivo" })).await;
        let long_note = "n".repeat(goal::GOAL_MAX_NOTE_CHARS + 1);
        let note = call(
            &human,
            "goal",
            json!({ "action": "progress", "note": long_note }),
        )
        .await;
        assert_eq!(error_code(&note), "GOAL_INVALID_ARGS");

        // `max_rounds` é clampado pelo núcleo (1..=100).
        let edited = call(
            &human,
            "goal",
            json!({ "action": "edit", "max_rounds": 500 }),
        )
        .await;
        assert!(!edited.is_error, "{}", edited.content);
        assert_eq!(
            edited.presentation.as_ref().expect("presentation")["maxRounds"],
            goal::GOAL_MAX_ROUNDS_HARD_CAP
        );
    }

}
