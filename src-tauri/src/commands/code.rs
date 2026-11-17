//! Comandos da sessão de código: snapshot de estado, modo de permissão, modo
//! Plano, aprovações, regras e reversão de alterações.
//!
//! Contrato: `docs/goals/code-harness/HARNESS.md` §6/§7/§11/§12 e
//! `WORKBENCH.md` §5/§7.2.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::domain::{
    ApprovalDecision, ApprovalRequest, ApprovalRule, ApprovalScope, AskUserRequest, ChangesSummary,
    CodeSessionState, Conversation, CreateGoalInput, FileChangeKind, FileChangeSummary, GoalAction,
    GoalContinuation, GoalOrigin, GoalPauseReason, GoalRound, GoalStatus, GoalView, PlanState,
    PlanView, UpdateGoalInput, Workspace,
};
use crate::harness::code::goal;
use crate::state::AppState;

use super::workspace::{enrich_workspace, project_info, workspace_path};

/// Kinds gravados em `code_events` por este módulo. As projeções de plano e
/// tarefas vivem em [`crate::harness::code::session`] (projeção única, D9).
pub const EVENT_APPROVAL_DECIDED: &str = crate::harness::code::session::KIND_APPROVAL_DECIDED;
pub const EVENT_PERMISSION_MODE: &str = crate::harness::code::session::KIND_PERMISSION_MODE;
pub const EVENT_REVERT: &str = crate::harness::code::session::KIND_REVERT;

fn map_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn objects_dir(app_data: &Path) -> PathBuf {
    app_data.join("checkpoints").join("objects")
}

/// Aprovações pendentes visíveis nesta sessão (inclui pedidos sem conversa).
fn pending_approvals_for(state: &AppState, conversation_id: &str) -> Vec<ApprovalRequest> {
    state
        .approvals
        .pending_requests()
        .into_iter()
        .filter(|request| {
            request.conversation_id.is_empty() || request.conversation_id == conversation_id
        })
        .collect()
}

/// Perguntas pendentes (`ask_user`) da sessão.
fn pending_questions_for(state: &AppState, conversation_id: &str) -> Vec<AskUserRequest> {
    state
        .questions
        .pending_requests()
        .into_iter()
        .filter(|request| request.conversation_id == conversation_id)
        .collect()
}

/// Summary of the most recent turn: the running turn when there is one, the
/// last persisted `turn_events` id otherwise, and the journal as a fallback
/// for sessions created before turn events were persisted. A turn without file
/// writes yields an explicit empty summary (never the previous turn's files).
fn latest_turn_changes(state: &AppState, conversation_id: &str) -> Option<ChangesSummary> {
    let active_turn = state
        .active_turns()
        .into_iter()
        .find_map(|(turn_id, conversation)| {
            (conversation == conversation_id).then_some(turn_id)
        });
    let turn_id = active_turn
        .or_else(|| state.db.last_turn_id(conversation_id).ok().flatten())
        .or_else(|| state.db.last_file_journal_turn(conversation_id).ok().flatten())?;
    crate::harness::code::session::turn_changes(&state.db, conversation_id, &turn_id).or_else(|| {
        Some(ChangesSummary {
            turn_id: Some(turn_id),
            files: Vec::new(),
            added: 0,
            removed: 0,
        })
    })
}

/// Reconstrói o estado da sessão a partir do log de eventos + journal + git.
async fn session_state(state: &AppState, conversation_id: &str) -> Result<CodeSessionState, String> {
    let conversation = state
        .db
        .get_conversation(conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;

    let mut workspace: Option<Workspace> = None;
    let mut project = None;
    if let Some(workspace_id) = conversation.workspace_id.as_deref() {
        if let Some(found) = state.db.get_workspace(workspace_id).map_err(map_err)? {
            let root = PathBuf::from(&found.path);
            if root.is_dir() {
                project = Some(project_info(&root));
                workspace = Some(enrich_workspace(&root, found).await);
            } else {
                workspace = Some(found);
            }
        }
    }

    let changes = collect_changes(state, conversation_id, workspace.as_ref()).await;
    let last_turn_changes = latest_turn_changes(state, conversation_id);

    let approvals = pending_approvals_for(state, conversation_id);
    let questions = pending_questions_for(state, conversation_id);

    // Objetivo da sessão: fold de `goal/state` **já degradado** quando a última
    // rodada morreu sem `goal/round` (leitura, nunca grava — PLAN §6.3).
    let goal = project_goal(
        &state.db,
        conversation_id,
        state.has_active_turn_for(conversation_id),
    )?;

    // Projeção **única** (`PLAN.md` D9/B-09): plano, modo e tarefas vêm de
    // `harness::code::session` — este módulo não recalcula nada.
    let plan_mode = crate::harness::code::session::plan_mode_active(&state.db, conversation_id)
        .map_err(map_err)?;
    let creator_mode =
        crate::harness::code::session::creator_mode_active(&state.db, conversation_id)
            .map_err(map_err)?;
    let plan = crate::harness::code::session::plan_view(&state.db, conversation_id)
        .map_err(map_err)?;
    // Uma revisão sem aprovação `submit_plan` pendente não tem gate ativo
    // (timeout/cancel/crash): degrada para planejamento com instrução curta.
    let has_pending_plan_approval = approvals.iter().any(|request| request.tool == "submit_plan");
    let plan = degrade_orphan_review(plan, has_pending_plan_approval);
    let todos = crate::harness::code::session::todos(&state.db, conversation_id)
        .map_err(map_err)?;
    // O `compacted` vem sempre da projeção canônica (`context/compacted`): o
    // `/compact` manual só grava esse evento (D25), então sem o overlay o valor
    // ficaria congelado no último `context/stats` até o próximo passo do turno.
    let compacted = crate::harness::code::session::compacted_messages(&state.db, conversation_id);
    let context = project_context(
        crate::harness::code::session::context_stats(&state.db, conversation_id),
        compacted,
    );

    Ok(CodeSessionState {
        conversation_id: conversation_id.to_string(),
        permission_mode: conversation.permission_mode,
        plan_mode,
        creator_mode,
        plan,
        goal,
        todos,
        workspace,
        project,
        context,
        changes,
        last_turn_changes,
        jobs: state.jobs.list(conversation_id),
        approvals,
        questions,
    })
}

/// Uma revisão órfã (aprovação expirou/cancelou, o app reiniciou ou o turno
/// acabou sem decisão) não tem gate ativo: degrada para `Planning` com
/// instrução curta para reenviar o plano (B-07, espelho do fold do `turn/ended`).
fn degrade_orphan_review(
    plan: Option<PlanView>,
    has_pending_plan_approval: bool,
) -> Option<PlanView> {
    let mut plan = plan?;
    if plan.state == PlanState::Reviewing && !has_pending_plan_approval {
        plan.state = PlanState::Planning;
        plan.feedback = Some(crate::harness::code::session::stale_review_feedback());
    }
    Some(plan)
}

/// Junta journal (alterações da sessão) + git (working tree) por arquivo.
async fn collect_changes(
    state: &AppState,
    conversation_id: &str,
    workspace: Option<&Workspace>,
) -> Option<ChangesSummary> {
    let journal = state
        .db
        .list_file_journal(conversation_id)
        .map_err(|_| ())
        .ok()?;
    let mut files: BTreeMap<String, FileChangeSummary> = BTreeMap::new();
    for entry in &journal {
        files.insert(
            entry.path.clone(),
            FileChangeSummary {
                path: entry.path.clone(),
                kind: entry.change_kind,
                added: entry.added.unwrap_or(0),
                removed: entry.removed.unwrap_or(0),
                origin: Some("session".to_string()),
                staged: false,
            },
        );
    }
    if let Some(workspace) = workspace {
        let root = PathBuf::from(&workspace.path);
        let status = crate::workspace::git::detect(&root).await;
        if status.is_repo {
            // Real per-file counters (`+N −M`). `git diff` on the index only
            // covers staged work; the working-tree diff covers the rest. Sum
            // both when a path appears in each (mixed staged/unstaged edits).
            let mut stats = crate::workspace::git::diff_stats(&root, true)
                .await
                .unwrap_or_default();
            for (path, stat) in crate::workspace::git::diff_stats(&root, false)
                .await
                .unwrap_or_default()
            {
                let entry = stats.entry(path).or_default();
                entry.added = entry.added.saturating_add(stat.added);
                entry.removed = entry.removed.saturating_add(stat.removed);
            }

            for file in &status.staged {
                let entry = files.entry(file.path.clone()).or_insert_with(|| FileChangeSummary {
                    path: file.path.clone(),
                    kind: FileChangeKind::Modified,
                    added: 0,
                    removed: 0,
                    origin: None,
                    staged: false,
                });
                entry.staged = true;
                entry.origin = Some(if entry.origin.as_deref() == Some("session") {
                    "both".to_string()
                } else {
                    "git".to_string()
                });
                if let Some(stat) = stats.get(&file.path) {
                    entry.added = stat.added;
                    entry.removed = stat.removed;
                }
            }
            for file in &status.unstaged {
                let entry = files.entry(file.path.clone()).or_insert_with(|| FileChangeSummary {
                    path: file.path.clone(),
                    kind: FileChangeKind::Modified,
                    added: 0,
                    removed: 0,
                    origin: None,
                    staged: false,
                });
                if entry.origin.is_none() {
                    entry.origin = Some("git".to_string());
                } else if entry.origin.as_deref() == Some("session") {
                    entry.origin = Some("both".to_string());
                }
                if let Some(stat) = stats.get(&file.path) {
                    entry.added = stat.added;
                    entry.removed = stat.removed;
                }
            }
            for path in &status.untracked {
                // New file: `git diff` ignores it, so count the content lines
                // instead (same rule as the synthetic diff patch used by the tab).
                let stat = crate::workspace::git::untracked_stats(&root, path);
                if let Some(entry) = files.get_mut(path) {
                    if entry.origin.as_deref() == Some("session") {
                        entry.origin = Some("both".to_string());
                    }
                    entry.added = stat.added;
                    entry.removed = stat.removed;
                } else {
                    files.insert(
                        path.clone(),
                        FileChangeSummary {
                            path: path.clone(),
                            kind: FileChangeKind::Created,
                            added: stat.added,
                            removed: stat.removed,
                            origin: Some("git".to_string()),
                            staged: false,
                        },
                    );
                }
            }
        }
    }
    if files.is_empty() {
        return None;
    }
    let list: Vec<FileChangeSummary> = files.into_values().collect();
    Some(ChangesSummary {
        turn_id: None,
        added: list.iter().map(|file| file.added).sum(),
        removed: list.iter().map(|file| file.removed).sum(),
        files: list,
    })
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/// Snapshot completo da sessão de código (header, painel, cards).
#[tauri::command]
pub async fn get_code_session_state(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<CodeSessionState, String> {
    session_state(&state, &conversation_id).await
}

/// Troca o modo de permissão da sessão (persistido + auditado).
#[tauri::command]
pub async fn set_permission_mode(
    state: State<'_, AppState>,
    conversation_id: String,
    mode: crate::domain::PermissionMode,
) -> Result<CodeSessionState, String> {
    state
        .db
        .set_conversation_permission_mode(&conversation_id, mode)
        .map_err(map_err)?;
    let payload = serde_json::json!({ "mode": mode.as_str() }).to_string();
    state
        .db
        .append_code_event(&conversation_id, None, EVENT_PERMISSION_MODE, &payload)
        .map_err(map_err)?;
    session_state(&state, &conversation_id).await
}

/// Liga/desliga o modo Plano (somente leitura) da sessão.
#[tauri::command]
pub async fn set_plan_mode(
    state: State<'_, AppState>,
    conversation_id: String,
    plan_mode: bool,
) -> Result<CodeSessionState, String> {
    apply_plan_mode(&state.db, &conversation_id, plan_mode)?;
    session_state(&state, &conversation_id).await
}

/// Lógica testável de `set_plan_mode`: valida a conversa **antes** de gravar o
/// evento (B-16 — ids inválidos não podem deixar linhas órfãs em `code_events`).
fn apply_plan_mode(
    db: &crate::db::Db,
    conversation_id: &str,
    plan_mode: bool,
) -> Result<(), String> {
    ensure_conversation(db, conversation_id)?;
    crate::harness::code::session::set_plan_mode(db, conversation_id, plan_mode).map_err(map_err)
}

/// Explicit plugin-mode state of a conversation (`on`/`off` keys).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginModesView {
    pub on: Vec<String>,
    pub off: Vec<String>,
}

fn plugin_modes_view(
    db: &crate::db::Db,
    conversation_id: &str,
) -> Result<PluginModesView, String> {
    let view = crate::harness::code::session::plugin_mode_state(db, conversation_id)
        .map_err(map_err)?;
    Ok(PluginModesView {
        on: view.on,
        off: view.off,
    })
}

/// Plugin-mode state of a conversation (Chat and Code).
#[tauri::command]
pub fn plugin_modes_state(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<PluginModesView, String> {
    ensure_conversation(&state.db, &conversation_id)?;
    plugin_modes_view(&state.db, &conversation_id)
}

/// Toggles a plugin-contributed harness mode (append-only; the last event wins).
#[tauri::command]
pub fn set_plugin_mode(
    state: State<'_, AppState>,
    conversation_id: String,
    mode: String,
    active: bool,
) -> Result<PluginModesView, String> {
    ensure_conversation(&state.db, &conversation_id)?;
    let known = crate::plugins::global_manager()
        .map(|manager| manager.mode(&mode).is_some())
        .unwrap_or(false);
    if !known {
        return Err("PLUGIN_MODE_UNKNOWN: unknown plugin mode".to_string());
    }
    crate::harness::code::session::set_plugin_mode(
        &state.db,
        &conversation_id,
        &mode,
        active,
    )
    .map_err(map_err)?;
    plugin_modes_view(&state.db, &conversation_id)
}

/// Liga/desliga o modo Plugin Creator (`/creator`) da sessão Code.
#[tauri::command]
pub async fn set_creator_mode(
    state: State<'_, AppState>,
    conversation_id: String,
    creator_mode: bool,
) -> Result<CodeSessionState, String> {
    apply_creator_mode(&state.db, &conversation_id, creator_mode)?;
    session_state(&state, &conversation_id).await
}

fn apply_creator_mode(
    db: &crate::db::Db,
    conversation_id: &str,
    creator_mode: bool,
) -> Result<(), String> {
    ensure_conversation(db, conversation_id)?;
    crate::harness::code::session::set_creator_mode(db, conversation_id, creator_mode)
        .map_err(map_err)
}

fn ensure_conversation(
    db: &crate::db::Db,
    conversation_id: &str,
) -> Result<crate::domain::Conversation, String> {
    db.get_conversation(conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))
}

/// Status dos servidores MCP configurados (`mcp.json`) e tools descobertas.
#[tauri::command]
pub async fn mcp_status(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let tools = state.mcp.refresh_tools().await;
    Ok(serde_json::json!({
        "servers": state.mcp.config().servers,
        "tools": tools,
    }))
}

/// Responde a uma pergunta pendente do agente (`ask_user`).
#[tauri::command]
pub async fn respond_question(
    state: State<'_, AppState>,
    request_id: String,
    answers: Vec<crate::domain::AskUserAnswer>,
    skipped: Option<bool>,
) -> Result<bool, String> {
    let skipped = skipped.unwrap_or(false);
    let response = crate::domain::AskUserResponse {
        request_id: request_id.clone(),
        answers: if skipped { Vec::new() } else { answers },
        skipped,
    };
    if !state.questions.resolve(response) {
        return Err(crate::i18n::t("code.errors.questionResolved"));
    }
    Ok(true)
}

/// Resposta do usuário a uma aprovação pendente (dados do card).
#[derive(Debug, Clone)]
struct ApprovalAnswer {
    decision: ApprovalDecision,
    scope: Option<ApprovalScope>,
    feedback: Option<String>,
    /// Escolha do gate de plano: `approve_run` | `approve_review` | `approve_goal`.
    choice: Option<String>,
    /// Markdown revisado pelo usuário antes de aprovar o plano (D3).
    plan_markdown: Option<String>,
}

impl Default for ApprovalAnswer {
    fn default() -> Self {
        Self {
            decision: ApprovalDecision::Denied,
            scope: None,
            feedback: None,
            choice: None,
            plan_markdown: None,
        }
    }
}

/// Responde a uma aprovação pendente (falha fechada para id desconhecido).
#[tauri::command]
pub async fn respond_approval(
    state: State<'_, AppState>,
    approval_id: String,
    decision: ApprovalDecision,
    scope: Option<ApprovalScope>,
    feedback: Option<String>,
    choice: Option<String>,
    plan_markdown: Option<String>,
) -> Result<bool, String> {
    apply_approval_decision(
        &state.db,
        &state.approvals,
        &approval_id,
        ApprovalAnswer {
            decision,
            scope,
            feedback,
            choice,
            plan_markdown,
        },
    )
}

/// Aplica a decisão de uma aprovação.
///
/// Ordem importa (B-17): **resolve o oneshot primeiro** — se o pedido já morreu
/// (timeout/cancelamento/duplo clique) devolve `APPROVAL_NOT_FOUND` sem criar
/// regra nem auditar uma decisão que nunca existiu. Aprovações de plano **não**
/// criam regra "sempre permitir" (D5).
fn apply_approval_decision(
    db: &crate::db::Db,
    approvals: &crate::policy::approval::ApprovalRegistry,
    approval_id: &str,
    answer: ApprovalAnswer,
) -> Result<bool, String> {
    let request = approvals
        .request(approval_id)
        .ok_or_else(|| crate::i18n::t("code.errors.approvalResolved"))?;
    let is_plan = request.tool == "submit_plan";

    if is_plan {
        if answer.scope.is_some() {
            return Err(
                crate::i18n::t("code.errors.planApprovalNoRule"),
            );
        }
        if answer.decision == ApprovalDecision::Approved {
            validate_plan_choice(answer.choice.as_deref(), answer.plan_markdown.as_deref())?;
        }
    } else if answer.choice.is_some() || answer.plan_markdown.is_some() {
        return Err(
            crate::i18n::t("code.errors.planOnlyFields"),
        );
    }

    let normalized_markdown = answer
        .plan_markdown
        .as_deref()
        .map(str::trim)
        .filter(|markdown| !markdown.is_empty())
        .map(str::to_string);
    let mut outcome = match answer.decision {
        ApprovalDecision::Approved if is_plan => {
            crate::policy::approval::ApprovalOutcome::approved_plan(
                answer.choice.clone(),
                normalized_markdown,
            )
        }
        ApprovalDecision::Approved => {
            crate::policy::approval::ApprovalOutcome::approved(answer.scope)
        }
        ApprovalDecision::Denied => {
            crate::policy::approval::ApprovalOutcome::denied(answer.feedback.clone())
        }
        ApprovalDecision::Cancelled => crate::policy::approval::ApprovalOutcome::cancelled(),
        ApprovalDecision::Expired => crate::policy::approval::ApprovalOutcome::expired(),
    };
    // O feedback também acompanha aprovações (auditoria/card).
    if answer.decision == ApprovalDecision::Approved {
        outcome.feedback = answer.feedback.clone();
    }
    if !approvals.resolve(approval_id, outcome.clone()) {
        return Err(crate::i18n::t("code.errors.approvalResolved"));
    }

    // A partir daqui a tool já destravou: regra/auditoria são efeitos
    // secundários (best effort auditado; regra pode falhar e reportar erro).
    if answer.decision == ApprovalDecision::Approved {
        if let Some(scope) = answer.scope {
            let (matcher, pattern, scope_id) = rule_from_request(db, &request, scope)?;
            state_create_rule(
                db,
                scope,
                scope_id.as_deref(),
                &request.tool,
                &matcher,
                &pattern,
            )?;
        }
    }
    let audit = serde_json::json!({
        "approvalId": approval_id,
        "decision": answer.decision.as_str(),
        "choice": outcome.choice,
        "scope": outcome.scope.map(|scope| scope.as_str()),
        "feedback": outcome.feedback,
    })
    .to_string();
    db.append_code_event(
        &request.conversation_id,
        None,
        EVENT_APPROVAL_DECIDED,
        &audit,
    )
    .map_err(map_err)?;
    Ok(true)
}

/// Cria a regra "sempre permitir" derivada do pedido aprovado.
fn state_create_rule(
    db: &crate::db::Db,
    scope: ApprovalScope,
    scope_id: Option<&str>,
    tool: &str,
    matcher: &str,
    pattern: &str,
) -> Result<(), String> {
    db.create_approval_rule(&crate::db::NewApprovalRule {
        scope,
        scope_id,
        tool,
        matcher,
        pattern,
        decision: ApprovalDecision::Approved,
    })
    .map(|_| ())
    .map_err(|error| crate::i18n::t_args(
        "code.errors.saveRule",
        &[("error", &error.to_string())],
    ))
}

/// Valida a escolha do gate de plano e o markdown revisado (D3/D5).
fn validate_plan_choice(choice: Option<&str>, plan_markdown: Option<&str>) -> Result<(), String> {
    if let Some(choice) = choice {
        match choice {
            "approve_run" | "approve_review" | "approve_goal" => {}
            other => {
                return Err(format!(
                    "APPROVAL_INVALID: escolha de plano desconhecida: `{other}`"
                ))
            }
        }
    }
    if let Some(markdown) = plan_markdown {
        let trimmed = markdown.trim();
        if trimmed.is_empty() {
            return Err(crate::i18n::t("code.errors.revisedPlanEmpty"));
        }
        if trimmed.chars().count() > 20_000 {
            return Err(
                crate::i18n::t("code.errors.revisedPlanTooLong"),
            );
        }
    }
    Ok(())
}

/// Deriva `(matcher, pattern, scope_id)` de um pedido para a regra "sempre".
///
/// Para `scope = Workspace` o `scope_id` vem da conversa; sem workspace a ação
/// falha em vez de gravar uma regra que nunca casaria (B-06).
fn rule_from_request(
    db: &crate::db::Db,
    request: &ApprovalRequest,
    scope: ApprovalScope,
) -> Result<(String, String, Option<String>), String> {
    let scope_id = match scope {
        ApprovalScope::Session => Some(request.conversation_id.clone()),
        ApprovalScope::Workspace => {
            let conversation = ensure_conversation(db, &request.conversation_id)?;
            Some(conversation.workspace_id.ok_or_else(|| {
                crate::i18n::t("code.errors.sessionNoWorkspace")
            })?)
        }
        ApprovalScope::Global => None,
    };
    let (matcher, pattern) = match &request.detail {
        crate::domain::ApprovalDetail::Command { command, .. } => {
            ("prefix".to_string(), command.trim().to_string())
        }
        crate::domain::ApprovalDetail::Paths { paths, .. } => (
            "glob".to_string(),
            paths.first().cloned().unwrap_or_default(),
        ),
        crate::domain::ApprovalDetail::Secret { path }
        | crate::domain::ApprovalDetail::Outside { path } => ("glob".to_string(), path.clone()),
        crate::domain::ApprovalDetail::ComputerAction { target, .. } => {
            ("exact".to_string(), target.clone())
        }
        crate::domain::ApprovalDetail::Other { text } => ("exact".to_string(), text.clone()),
    };
    Ok((matcher, pattern, scope_id))
}

#[tauri::command]
pub async fn list_approval_rules(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<ApprovalRule>, String> {
    let conversation = state
        .db
        .get_conversation(&conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    state
        .db
        .list_approval_rules_for_context(
            Some(&conversation_id),
            conversation.workspace_id.as_deref(),
        )
        .map_err(map_err)
}

/// Dados para criar uma regra de aprovação manualmente (Configurações).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRuleInput {
    pub scope: ApprovalScope,
    #[serde(default)]
    pub scope_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub tool: String,
    pub matcher: String,
    pub pattern: String,
    pub decision: ApprovalDecision,
}

#[tauri::command]
pub async fn save_approval_rule(
    state: State<'_, AppState>,
    input: ApprovalRuleInput,
) -> Result<ApprovalRule, String> {
    let mut scope_id = input.scope_id.clone();
    if scope_id.is_none() {
        if let Some(conversation_id) = input.conversation_id.as_deref() {
            match input.scope {
                ApprovalScope::Session => scope_id = Some(conversation_id.to_string()),
                ApprovalScope::Workspace => {
                    if let Some(conversation) = state
                        .db
                        .get_conversation(conversation_id)
                        .map_err(map_err)?
                    {
                        scope_id = conversation.workspace_id;
                    }
                }
                ApprovalScope::Global => {}
            }
        }
    }
    state
        .db
        .create_approval_rule(&crate::db::NewApprovalRule {
            scope: input.scope,
            scope_id: scope_id.as_deref(),
            tool: &input.tool,
            matcher: &input.matcher,
            pattern: &input.pattern,
            decision: input.decision,
        })
        .map_err(map_err)
}

#[tauri::command]
pub async fn delete_approval_rule(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let removed = state.db.delete_approval_rule(&id).map_err(map_err)?;
    if !removed {
        return Err(crate::i18n::t_args("code.errors.ruleNotFound", &[("rule_id", &id)]));
    }
    Ok(())
}

/// Alterações da sessão (journal + working tree) para o painel.
#[tauri::command]
pub async fn get_workspace_changes(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<crate::domain::FileChange>, String> {
    let conversation = state
        .db
        .get_conversation(&conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    let mut workspace = None;
    if let Some(workspace_id) = conversation.workspace_id.as_deref() {
        workspace = state.db.get_workspace(workspace_id).map_err(map_err)?;
    }
    let summary = collect_changes(&state, &conversation_id, workspace.as_ref())
        .await
        .unwrap_or(ChangesSummary {
            turn_id: None,
            files: Vec::new(),
            added: 0,
            removed: 0,
        });
    Ok(summary
        .files
        .into_iter()
        .map(|file| crate::domain::FileChange {
            path: file.path,
            kind: file.kind,
            added: file.added,
            removed: file.removed,
            diff: None,
        })
        .collect())
}

/// Shared body of the file diff commands: working tree/index (`base = None`)
/// or a ref comparison (`base = Some(merge_base)`).
async fn diff_file(
    state: &AppState,
    workspace_id: &str,
    path: &str,
    staged: bool,
    base: Option<&str>,
) -> Result<String, String> {
    let root = workspace_path(state, workspace_id)?;
    let resolved = crate::workspace::safe_path::resolve(
        &root,
        path,
        crate::workspace::safe_path::Access::Read,
    )
    .map_err(map_err)?;
    let relative = crate::workspace::safe_path::to_relative(&root, &resolved);

    if let Some(base) = base {
        let text = crate::workspace::git::diff_ref(
            &root,
            base,
            std::slice::from_ref(&relative),
            3,
            200_000,
        )
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
        // Untracked não aparece no `git diff` nem contra uma ref.
        if text.trim().is_empty() && !crate::workspace::git::is_tracked(&root, &relative).await {
            return crate::workspace::git::untracked_diff(&root, &relative, 200_000)
                .map_err(|error| format!("{}: {}", error.code, error.message));
        }
        return Ok(text);
    }

    if !staged {
        if let Some(diff) = journal_diff(state, &relative)? {
            return Ok(diff);
        }
    }
    let text =
        crate::workspace::git::diff(&root, std::slice::from_ref(&relative), staged, 3, 200_000)
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
    // Arquivo novo (untracked) não aparece no `git diff`: monta o patch "new
    // file" a partir do conteúdo para a aba Alterações mostrar `A` + diff mesmo
    // sem staging.
    if !staged && text.trim().is_empty() && !crate::workspace::git::is_tracked(&root, &relative).await
    {
        return crate::workspace::git::untracked_diff(&root, &relative, 200_000)
            .map_err(|error| format!("{}: {}", error.code, error.message));
    }
    Ok(text)
}

/// Diff de um arquivo: journal da sessão quando existe, senão git.
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
    staged: bool,
) -> Result<String, String> {
    diff_file(&state, &workspace_id, &path, staged, None).await
}

/// Diff do arquivo no working tree contra HEAD (marcas inline da aba de arquivo).
#[tauri::command]
pub async fn get_file_diff_head(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<String, String> {
    let root = workspace_path(&state, &workspace_id)?;
    let resolved = crate::workspace::safe_path::resolve(
        &root,
        &path,
        crate::workspace::safe_path::Access::Read,
    )
    .map_err(map_err)?;
    let relative = crate::workspace::safe_path::to_relative(&root, &resolved);
    crate::workspace::git::worktree_diff(&root, &relative, 200_000)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))
}

/// Diff de um arquivo contra uma ref (merge-base da branch selecionada).
#[tauri::command]
pub async fn get_file_diff_at(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
    base: String,
) -> Result<String, String> {
    crate::workspace::git::validate_ref(&base)?;
    diff_file(&state, &workspace_id, &path, false, Some(&base)).await
}

/// Diff do journal para um path (usa o object store de checkpoints).
fn journal_diff(state: &AppState, path: &str) -> Result<Option<String>, String> {
    // Procura o journal mais recente que contenha o path em qualquer sessão?
    // Não: o journal é por conversa. Sem conversa no payload, calcula pelo
    // arquivo atual vs. working tree? A UI passa `get_file_diff` com workspace,
    // então usamos git; o journal é usado no revert. Mantido simples e honesto.
    let _ = (state, path);
    Ok(None)
}

/* ------------------------------------------------------------------ */
/* Reversão                                                            */
/* ------------------------------------------------------------------ */

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path sem pai"))?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".zylara-revert-{}-{}",
        std::process::id(),
        crate::domain::now_ms()
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).or_else(|error| {
        let _ = std::fs::remove_file(&tmp);
        Err(error)
    })
}

fn revert_entries(
    state: &AppState,
    conversation_id: &str,
    root: &Path,
    mut entries: Vec<crate::db::FileJournalEntry>,
) -> Result<u32, String> {
    // Reverte do mais recente para o mais antigo; cada path uma vez.
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.id));
    let objects = crate::workspace::journal::ObjectStore::new(objects_dir(&state.data_dir));
    let mut seen = std::collections::HashSet::new();
    let mut reverted = 0u32;
    for entry in entries {
        if !seen.insert(entry.path.clone()) {
            continue;
        }
        let target = crate::workspace::safe_path::resolve(
            root,
            &entry.path,
            crate::workspace::safe_path::Access::Write,
        )
        .map_err(map_err)?;
        // Verificação de corrida: o arquivo precisa estar como o turno deixou.
        let current = std::fs::read(&target).ok();
        if let (Some(after_hash), Some(current_bytes)) = (&entry.after_hash, &current) {
            if &sha256_hex(current_bytes) != after_hash {
                return Err(format!(
                    "FS_STALE_VERSION: `{}` mudou desde o turno; revise o diff antes de reverter",
                    entry.path
                ));
            }
        }
        match &entry.before_hash {
            Some(before_hash) => {
                let bytes = objects
                    .get(before_hash)
                    .map_err(|error| format!("checkpoint ausente para `{}`: {error}", entry.path))?;
                atomic_write(&target, &bytes).map_err(map_err)?;
            }
            None => {
                if target.exists() {
                    std::fs::remove_file(&target).map_err(map_err)?;
                }
            }
        }
        reverted += 1;
    }
    Ok(reverted)
}

/// Reverte um arquivo ao estado anterior à primeira edição do turno.
#[tauri::command]
pub async fn revert_file(
    state: State<'_, AppState>,
    conversation_id: String,
    path: String,
) -> Result<bool, String> {
    let conversation = state
        .db
        .get_conversation(&conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    let workspace_id = conversation
        .workspace_id
        .ok_or_else(|| crate::i18n::t("code.errors.noWorkspace"))?;
    let root = workspace_path(&state, &workspace_id)?;
    let entries: Vec<_> = state
        .db
        .list_file_journal(&conversation_id)
        .map_err(map_err)?
        .into_iter()
        .filter(|entry| entry.path == path)
        .collect();
    if entries.is_empty() {
        return Err(crate::i18n::t_args("code.errors.noChangeForPath", &[("path", &path)]));
    }
    let reverted = revert_entries(&state, &conversation_id, &root, entries)?;
    let payload = serde_json::json!({ "files": [path], "reverted": reverted }).to_string();
    state
        .db
        .append_code_event(&conversation_id, None, EVENT_REVERT, &payload)
        .map_err(map_err)?;
    Ok(reverted > 0)
}

/// Reverte todas as alterações de um turno (arquivos que ainda estão como o
/// turno deixou; recusa se algum mudou por fora).
#[tauri::command]
pub async fn revert_turn(
    state: State<'_, AppState>,
    conversation_id: String,
    turn_id: String,
) -> Result<bool, String> {
    let conversation = state
        .db
        .get_conversation(&conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    let workspace_id = conversation
        .workspace_id
        .ok_or_else(|| crate::i18n::t("code.errors.noWorkspace"))?;
    let root = workspace_path(&state, &workspace_id)?;
    let entries = state
        .db
        .list_file_journal_for_turn(&conversation_id, &turn_id)
        .map_err(map_err)?;
    if entries.is_empty() {
        return Err(crate::i18n::t("code.errors.noTurnChanges"));
    }
    let paths: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    let reverted = revert_entries(&state, &conversation_id, &root, entries)?;
    let payload = serde_json::json!({ "turnId": turn_id, "files": paths, "reverted": reverted })
        .to_string();
    state
        .db
        .append_code_event(&conversation_id, Some(&turn_id), EVENT_REVERT, &payload)
        .map_err(map_err)?;
    Ok(reverted > 0)
}

/// Aplica o `compacted` da projeção canônica ao último `ContextStats` lido do
/// log. Sem o overlay, o `/compact` manual (que não tem um turno para reescrever
/// `context/stats`) deixaria o medidor com o valor antigo até o próximo passo do
/// harness — bug D25. Sem stats persistido continua `None` (não inventa contexto).
fn project_context(
    context: Option<crate::domain::ContextStats>,
    compacted: u32,
) -> Option<crate::domain::ContextStats> {
    context.map(|mut stats| {
        stats.compacted = compacted;
        stats
    })
}

/// Projeta o `/compact` manual nos eventos canônicos (D25): grava
/// `context/compacted` com o **mesmo payload da compactação automática**
/// (`{messages, tokensFreed}`) via [`compaction::record_compaction`].
///
/// Nunca gravar payload parcial em `context/stats`: o fold daquele kind
/// desserializa um `ContextStats` inteiro e um payload inválido fazia o
/// `context` do `CodeSessionState` voltar a `None` (bug D25).
fn record_manual_compaction(
    db: &crate::db::Db,
    conversation_id: &str,
    covered_messages: u32,
    tokens_freed: u32,
) -> anyhow::Result<()> {
    use crate::harness::code::compaction;
    // O comando manual não roda dentro de um turno: `""` vira `None` no evento.
    compaction::record_compaction(db, conversation_id, "", covered_messages, tokens_freed)
}

/// Compactação manual do contexto (`/compact`): resume o trecho antigo da
/// conversa e o aplica aos próximos turnos do modelo.
///
/// **Cache-safe (F6.2):** o resumo é delegado a
/// [`crate::harness::compaction::summarize_manual_for_conversation`], que monta o
/// **prefixo normal** da sessão (system prompt congelado do snapshot, tools,
/// histórico com replay/surface/resumo aplicado) e anexa `summary_instruction`
/// como última mensagem de user — o provedor lê o prefixo cacheado em vez de
/// pagar o prompt inteiro. O `cache_plan` do request normal também é reusado.
/// (O antigo caminho de prompt próprio (`summary_system_prompt` +
/// `batch::complete_text`) saiu do comando; `summary_system_prompt` pode ser
/// removido do harness quando ninguém mais usar.)
///
/// **Contrato estável (D25):** a fronteira persistida é o ordinal de **mensagens
/// cobertas** (`session_summaries.to_seq`), o mesmo da compactação automática —
/// não o índice do histórico neutro. O evento gravado é `context/compacted`
/// (`{messages, tokensFreed}`), que preserva o `context` do medidor; o
/// `compacted` exibido por `get_code_session_state` vem da projeção
/// ([`project_context`]). O helper não persiste nada: o comando grava
/// resumo/evento só depois do `Some(outcome)`.
#[tauri::command]
pub async fn compact_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<bool, String> {
    let conversation = state
        .db
        .get_conversation(&conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    // Guarda amigável antes de resolver provider/credencial (o harness também
    // devolve `None` para histórico curto/inválido).
    let messages = state
        .db
        .list_messages(&conversation_id)
        .map_err(map_err)?;
    if messages.len() < 8 {
        return Err("conversa curta demais para compactar".to_string());
    }
    let deps = crate::harness::HarnessDeps {
        app: Some(app.clone()),
        db: state.db.clone(),
        http: state.http.clone(),
        search_http: state.search_http.clone(),
        catalog: state.catalog_with_plugins(),
        streamer: None,
        credential_override: None,
        refresh_override: None,
        model_source: None,
        api_key_override: None,
        data_dir: Some(state.data_dir.clone()),
        skills_roots: Some(Vec::new()),
        approvals: Some(state.approvals.clone()),
        observed: Some(state.observed.clone()),
        jobs: Some(state.jobs.clone()),
        questions: Some(state.questions.clone()),
        mcp: Some(state.mcp.clone()),
    };
    let settings = crate::config::load_settings(&app);
    // Prefixo normal + resumo + `cache_plan` montados pelo harness (cache-safe).
    let outcome = crate::harness::compaction::summarize_manual_for_conversation(
        &deps,
        &conversation,
        &settings,
    )
    .await
    .map_err(|error| format!("falha ao compactar: {error:#}"))?
    .ok_or_else(|| crate::i18n::t("code.errors.nothingToCompact"))?;

    // `to_seq` = `outcome.covered` (ordinal estável de mensagens); o hash cobre
    // as mensagens resumidas para invalidar o resumo em edição/revert.
    let covered = usize::try_from(outcome.covered).unwrap_or(usize::MAX);
    let covered_hash = crate::harness::compaction::covered_hash(&messages, covered);
    crate::harness::compaction::persist_compaction(
        &state.db,
        crate::harness::compaction::CompactionRecord {
            conversation_id: &conversation_id,
            covered: outcome.covered,
            summary: &outcome.summary,
            tokens_before: Some(outcome.tokens_before),
            method: outcome.method,
            provider_id: Some(&conversation.provider_id),
            model_id: Some(&conversation.model_id),
            native_payload: outcome.native_payload.as_ref(),
            covered_hash: &covered_hash,
        },
    )
    .map_err(map_err)?;
    // Projeção canônica da UI (D25): `context/compacted`, nunca `context/stats`.
    record_manual_compaction(
        &state.db,
        &conversation_id,
        outcome.covered,
        outcome.tokens_freed,
    )
    .map_err(map_err)?;
    Ok(true)
}

/* ------------------------------------------------------------------ */
/* Objetivo persistente da sessão (Goal) — PLAN.md §6.3/§7.4/§9.1      */
/* ------------------------------------------------------------------ */

/// `outcome` de uma rodada fechada como interrompida (crash/reload no meio).
const ROUND_OUTCOME_INTERRUPTED: &str = "interrupted";

/// Texto do snapshot/card quando a última rodada não fechou (`PLAN.md` §10.9).
pub(crate) fn orphan_round_detail() -> String {
    crate::i18n::t("code.goal.orphanRoundDetail")
}

/// Sessão do layout Code? Nativo (`mode == "code"`) ou sessão do Chat
/// explicitamente adicionada ao Code (`codeLinked`) — PLAN D18.
pub(crate) fn is_code_session(conversation: &Conversation) -> bool {
    conversation.mode == crate::domain::CONVERSATION_MODE_CODE
        || conversation.code_linked
        || (conversation.mode == crate::domain::CONVERSATION_MODE_AGENT
            && conversation.workspace_id.is_some())
}

/// O objetivo só existe no layout Code (PLAN D18); o código estável no prefixo
/// permite a UI/pill traduzir a recusa.
fn validate_goal_session(conversation: &Conversation) -> Result<(), String> {
    if !is_code_session(conversation) {
        return Err(crate::i18n::t("code.errors.goalNotCode"));
    }
    Ok(())
}

/// Pasta do workspace do objetivo, validada **no disco** (PLAN D15/§7.2): uma
/// rodada de código sem arquivos estola. Usar o caminho para checar a existência
/// (o workspace pode ter sido movido/apagado fora do app).
fn goal_workspace_root(
    db: &crate::db::Db,
    conversation: &Conversation,
) -> Result<PathBuf, String> {
    let workspace_id = conversation.workspace_id.as_deref().ok_or_else(|| {
        crate::i18n::t("code.errors.goalNoWorkspace")
    })?;
    let workspace = db
        .get_workspace(workspace_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "code.errors.goalWorkspaceMissing",
            &[("workspace_id", &workspace_id)],
        ))?;
    let root = PathBuf::from(&workspace.path);
    if !root.is_dir() {
        return Err(crate::i18n::t_args(
            "code.errors.goalWorkspaceGone",
            &[("path", &workspace.path)],
        ));
    }
    Ok(root)
}

/// `true` quando o workspace do objetivo existe no disco. Ausência de
/// workspace/pasta é um **fato do preflight** (`false`); erro de banco é erro.
fn goal_has_workspace(
    db: &crate::db::Db,
    conversation: &Conversation,
) -> Result<bool, String> {
    match goal_workspace_root(db, conversation) {
        Ok(_) => Ok(true),
        Err(error) if error.starts_with("GOAL_NO_WORKSPACE") => Ok(false),
        Err(error) => Err(error),
    }
}

/// Degradação **de leitura** de uma rodada órfã (`PLAN.md` §6.3): um objetivo
/// `active` cuja última rodada não tem `goal/round` e não tem turno ativo vira
/// `paused/interrupted` no snapshot — **sem gravar** nada. O próximo
/// `begin_round` reconcilia o log (fecha a órfã) e um `resume` rearma.
pub(crate) fn degrade_orphan_goal(
    goal: Option<GoalView>,
    last_round_interrupted: bool,
    has_active_turn: bool,
) -> Option<GoalView> {
    let mut goal = goal?;
    if goal.status == GoalStatus::Active && last_round_interrupted && !has_active_turn {
        goal.status = GoalStatus::Paused;
        goal.pause_reason = Some(GoalPauseReason::Interrupted);
        goal.pause_detail = Some(orphan_round_detail());
        goal.auto_continue = false;
    }
    Some(goal)
}

/// Objetivo projetado para a UI: fold de `goal/state` + degradação de rodada
/// órfã. Nunca grava — o log continua `active` até a próxima reconciliação.
pub(crate) fn project_goal(
    db: &crate::db::Db,
    conversation_id: &str,
    has_active_turn: bool,
) -> Result<Option<GoalView>, String> {
    let Some(goal) = goal::current(db, conversation_id).map_err(map_err)? else {
        return Ok(None);
    };
    // Só pode haver órfã quando o objetivo segue `active` e nenhum turno o
    // ocupa; nesse caso o fold de rodadas (uma, a mais recente) diz se a última
    // abertura ficou **sem `goal/round`** (a rodada sintetizada como
    // `interrupted` não tem `endedAt`; uma rodada reconciliada tem). Fora daí
    // não há o que degradar.
    let interrupted = goal.status == GoalStatus::Active
        && !has_active_turn
        && goal::rounds(db, conversation_id, 1, has_active_turn)
            .map_err(map_err)?
            .first()
            .is_some_and(|round| {
                let unclosed = round.ended_at.is_none();
                unclosed && round.outcome.as_deref() == Some(ROUND_OUTCOME_INTERRUPTED)
            });
    Ok(degrade_orphan_goal(Some(goal), interrupted, has_active_turn))
}

/// Renomeia o título da conversa para o título do objetivo **apenas** quando
/// ela ainda está com o placeholder (`PLAN` D17/§8.4). Falha é logada e não
/// derruba a criação: o título é cosmético.
fn rename_placeholder_title(db: &crate::db::Db, conversation: &Conversation, goal: &GoalView) {
    if !crate::harness::should_auto_title(&conversation.title) {
        return;
    }
    if let Err(error) = db.rename_conversation(&conversation.id, &goal.title) {
        eprintln!("zylara: falha ao renomear conversa: {error:#}");
    }
}

/// Lógica testável de `create_goal`: valida layout Code + workspace real,
/// cria o objetivo com `origin = user` (default `autoContinue = true`) e renomeia
/// o título placeholder da conversa.
pub(crate) fn create_goal_for_conversation(
    db: &crate::db::Db,
    conversation_id: &str,
    input: &CreateGoalInput,
) -> Result<GoalView, String> {
    let conversation = ensure_conversation(db, conversation_id)?;
    validate_goal_session(&conversation)?;
    goal_workspace_root(db, &conversation)?;
    let goal = goal::create(db, conversation_id, input, GoalOrigin::User)
        .map_err(|error| error.to_string())?;
    rename_placeholder_title(db, &conversation, &goal);
    Ok(goal)
}

/// Lógica testável de `update_goal`: CAS por `expectedRevision`
/// (`GOAL_STALE_REVISION`) + mapeamento [`GoalAction`] → mutação do `goal.rs`
/// (idempotente no estado alvo). `None` = objetivo encerrado (`delete`).
pub(crate) fn apply_goal_action(
    db: &crate::db::Db,
    conversation_id: &str,
    action: GoalAction,
    input: &UpdateGoalInput,
    expected_revision: Option<u64>,
) -> Result<Option<GoalView>, String> {
    goal::update(db, conversation_id, action, input, expected_revision)
        .map_err(|error| error.to_string())
}

/// Limite do histórico de rodadas: default e teto de
/// `GOAL_ROUNDS_LIST_LIMIT` (200), piso 1 (`PLAN.md` §5.3/§9.1).
pub(crate) fn clamp_rounds_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(goal::GOAL_ROUNDS_LIST_LIMIT)
        .clamp(1, goal::GOAL_ROUNDS_LIST_LIMIT)
}

/// Motivos do preflight `goal_can_continue`, na ordem oficial do `PLAN.md`
/// §7.4 (o primeiro que casar vence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GoalContinuationReason {
    NoGoal,
    NotCode,
    Completed,
    Blocked,
    Paused,
    NotArmed,
    MaxRounds,
    PlanMode,
    PendingApproval,
    Busy,
    NoWorkspace,
    Interrupted,
}

impl GoalContinuationReason {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::NoGoal => "no_goal",
            Self::NotCode => "not_code",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
            Self::Paused => "paused",
            Self::NotArmed => "not_armed",
            Self::MaxRounds => "max_rounds",
            Self::PlanMode => "plan_mode",
            Self::PendingApproval => "pending_approval",
            Self::Busy => "busy",
            Self::NoWorkspace => "no_workspace",
            Self::Interrupted => "interrupted",
        }
    }
}

/// Fatos do preflight já resolvidos pelo comando (a decisão em si é pura e
/// testável). `goal` é o snapshot **já degradado** por [`project_goal`].
pub(crate) struct ContinuationFacts<'a> {
    pub is_code: bool,
    pub goal: Option<&'a GoalView>,
    pub plan_mode: bool,
    pub pending_approval: bool,
    pub has_active_turn: bool,
    pub has_workspace: bool,
}

/// Decisão pura do preflight (§7.4). `auto = true` é a continuação automática
/// (exige `autoContinue`); `auto = false` é "Nova rodada" (basta `active` +
/// orçamento + sem plano/aprovação/busy).
pub(crate) fn continuation_reason(
    facts: &ContinuationFacts<'_>,
    auto: bool,
) -> Option<GoalContinuationReason> {
    let Some(goal) = facts.goal else {
        return Some(GoalContinuationReason::NoGoal);
    };
    if !facts.is_code {
        return Some(GoalContinuationReason::NotCode);
    }
    match goal.status {
        GoalStatus::Completed => return Some(GoalContinuationReason::Completed),
        GoalStatus::Blocked => return Some(GoalContinuationReason::Blocked),
        GoalStatus::Paused => {
            // `paused(interrupted)` é reportado como o código específico
            // `interrupted` (o último da lista oficial), não como `paused`.
            if goal.pause_reason != Some(GoalPauseReason::Interrupted) {
                return Some(GoalContinuationReason::Paused);
            }
        }
        GoalStatus::Active => {}
    }
    if auto && !goal.auto_continue {
        return Some(GoalContinuationReason::NotArmed);
    }
    if goal.rounds >= goal.max_rounds {
        return Some(GoalContinuationReason::MaxRounds);
    }
    if facts.plan_mode {
        return Some(GoalContinuationReason::PlanMode);
    }
    if facts.pending_approval {
        return Some(GoalContinuationReason::PendingApproval);
    }
    if facts.has_active_turn {
        return Some(GoalContinuationReason::Busy);
    }
    if !facts.has_workspace {
        return Some(GoalContinuationReason::NoWorkspace);
    }
    if goal.status == GoalStatus::Paused {
        return Some(GoalContinuationReason::Interrupted);
    }
    None
}

/// Cria o objetivo da sessão de código (`PLAN.md` §9.1).
///
/// Valida layout Code + workspace real + limites, persiste `goal/state` com
/// `origin = user` e renomeia um título placeholder para o título do objetivo.
/// Devolve o snapshot completo (a UI aplica sem depender de evento).
#[tauri::command]
pub async fn create_goal(
    state: State<'_, AppState>,
    conversation_id: String,
    input: CreateGoalInput,
) -> Result<CodeSessionState, String> {
    create_goal_for_conversation(&state.db, &conversation_id, &input)?;
    session_state(&state, &conversation_id).await
}

/// Aplica uma ação da UI sobre o objetivo com CAS por `expectedRevision`
/// (`GOAL_STALE_REVISION: ...`), idempotente no estado alvo (`PLAN.md` §9.1).
#[tauri::command]
pub async fn update_goal(
    state: State<'_, AppState>,
    conversation_id: String,
    action: GoalAction,
    input: Option<UpdateGoalInput>,
    expected_revision: Option<u64>,
) -> Result<CodeSessionState, String> {
    ensure_conversation(&state.db, &conversation_id)?;
    // Crash/reinício pode ter deixado uma rodada aberta: fecha como `interrupted`
    // antes da ação (sem isso o snapshot degradado em `paused/interrupted` não
    // destrava, porque o estado persistido continua `active` e `resume` é no-op
    // — QA F4, achado ALTO). Nunca reconcilia com turno vivo nesta conversa.
    if !state.has_active_turn_for(&conversation_id) {
        crate::harness::code::goal::reconcile_interrupted_rounds(
            &state.db,
            &conversation_id,
        )
        .map_err(map_err)?;
    }
    let input = input.unwrap_or_default();
    apply_goal_action(
        &state.db,
        &conversation_id,
        action,
        &input,
        expected_revision,
    )?;
    session_state(&state, &conversation_id).await
}

/// Histórico de rodadas do objetivo, **mais recentes primeiro**; limite 1..=200
/// (o turno ativo distingue "em andamento" de "interrompida").
#[tauri::command]
pub async fn list_goal_rounds(
    state: State<'_, AppState>,
    conversation_id: String,
    limit: Option<u32>,
) -> Result<Vec<GoalRound>, String> {
    ensure_conversation(&state.db, &conversation_id)?;
    let has_active_turn = state.has_active_turn_for(&conversation_id);
    goal::rounds(
        &state.db,
        &conversation_id,
        clamp_rounds_limit(limit),
        has_active_turn,
    )
    .map_err(map_err)
}

/// Preflight oficial de continuidade (`PLAN.md` §7.4): devolve
/// `{ ok, reason, goal }` com os códigos estáveis na ordem documentada.
/// `auto = false` ("Nova rodada agora") não exige `autoContinue`.
#[tauri::command]
pub async fn goal_can_continue(
    state: State<'_, AppState>,
    conversation_id: String,
    auto: Option<bool>,
) -> Result<GoalContinuation, String> {
    let conversation = ensure_conversation(&state.db, &conversation_id)?;
    let has_active_turn = state.has_active_turn_for(&conversation_id);
    let goal = project_goal(&state.db, &conversation_id, has_active_turn)?;
    let plan_mode = crate::harness::code::session::plan_mode_active(&state.db, &conversation_id)
        .map_err(map_err)?;
    let pending_approval = !pending_approvals_for(&state, &conversation_id).is_empty()
        || !pending_questions_for(&state, &conversation_id).is_empty();
    let facts = ContinuationFacts {
        is_code: is_code_session(&conversation),
        goal: goal.as_ref(),
        plan_mode,
        pending_approval,
        has_active_turn,
        has_workspace: goal_has_workspace(&state.db, &conversation)?,
    };
    let reason = continuation_reason(&facts, auto.unwrap_or(true));
    Ok(GoalContinuation {
        ok: reason.is_none(),
        reason: reason.map(|reason| reason.code().to_string()),
        goal,
    })
}

/* ------------------------------------------------------------------ */
/* Jobs em background (F4)                                             */
/* ------------------------------------------------------------------ */

/// PÃ¡gina de saÃ­da de um job em background (`get_job_output`).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputPage {
    pub output: String,
    pub next_cursor: usize,
    pub job: crate::domain::JobView,
}

/// Jobs de processo da sessÃ£o (painel e cards).
#[tauri::command]
pub async fn list_jobs(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<crate::domain::JobView>, String> {
    Ok(state.jobs.list(&conversation_id))
}

/// SaÃ­da incremental de um job a partir de um cursor absoluto.
#[tauri::command]
pub async fn get_job_output(
    state: State<'_, AppState>,
    job_id: String,
    cursor: Option<usize>,
) -> Result<JobOutputPage, String> {
    let (output, next_cursor, job) = state
        .jobs
        .output(&job_id, cursor.unwrap_or(0))
        .map_err(map_err)?;
    Ok(JobOutputPage {
        output,
        next_cursor,
        job,
    })
}

/// Encerra um job (processo + Ã¡rvore) e devolve o estado final.
#[tauri::command]
pub async fn kill_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<crate::domain::JobView, String> {
    state.jobs.kill(&job_id).map_err(map_err)?;
    state
        .jobs
        .wait(&job_id, std::time::Duration::from_millis(1_500))
        .await
        .map_err(map_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ApprovalDetail, GoalOrigin, RiskClass, UsageInfo};
    use crate::harness::code::session;
    use crate::policy::approval::{ApprovalOutcome, ApprovalRegistry};

    fn db_with_conversation() -> (crate::db::Db, String) {
        let db = crate::db::Db::open_in_memory().expect("banco em memória");
        let conversation = db
            .create_conversation_with_mode(
                "Sessão",
                "opencode-go",
                "deepseek-v4.1-flash",
                crate::domain::CONVERSATION_MODE_CODE,
            )
            .expect("conversa");
        (db, conversation.id)
    }

    fn approval_request(conversation_id: &str, tool: &str) -> ApprovalRequest {
        ApprovalRequest {
            id: "apr-1".to_string(),
            conversation_id: conversation_id.to_string(),
            tool_call_id: "call-1".to_string(),
            tool: tool.to_string(),
            title: "Ação?".to_string(),
            detail: ApprovalDetail::Command {
                command: "npm test".to_string(),
                workdir: ".".to_string(),
            },
            risk: RiskClass::Shell,
            preview: None,
            options: Vec::new(),
            created_at: 1,
        }
    }

    fn answer(decision: ApprovalDecision) -> ApprovalAnswer {
        ApprovalAnswer {
            decision,
            ..Default::default()
        }
    }

    #[test]
    fn set_plan_mode_validates_the_conversation_before_writing() {
        let (db, conversation_id) = db_with_conversation();
        assert!(apply_plan_mode(&db, "nao-existe", true).is_err());
        assert!(
            db.latest_code_event("nao-existe", session::KIND_PLAN_MODE)
                .expect("ler")
                .is_none(),
            "id inválido não pode gravar evento"
        );

        apply_plan_mode(&db, &conversation_id, true).expect("ligar plano");
        assert!(session::plan_mode_active(&db, &conversation_id).expect("modo"));
    }

    #[test]
    fn set_creator_mode_validates_the_conversation_before_writing() {
        let (db, conversation_id) = db_with_conversation();
        assert!(apply_creator_mode(&db, "nao-existe", true).is_err());
        assert!(
            db.latest_code_event("nao-existe", session::KIND_CREATOR_MODE)
                .expect("ler")
                .is_none(),
            "id inválido não pode gravar evento"
        );

        apply_creator_mode(&db, &conversation_id, true).expect("ligar creator");
        assert!(session::creator_mode_active(&db, &conversation_id).expect("modo"));
        apply_creator_mode(&db, &conversation_id, false).expect("desligar creator");
        assert!(!session::creator_mode_active(&db, &conversation_id).expect("modo"));
    }

    #[test]
    fn rule_from_request_resolves_the_workspace_scope_id() {
        let (db, conversation_id) = db_with_conversation();
        let request = approval_request(&conversation_id, "run_command");

        // Sessão sem workspace: erro em vez de regra morta (B-06).
        let error = rule_from_request(&db, &request, ApprovalScope::Workspace)
            .expect_err("sem workspace deve falhar");
        assert!(error.contains("workspace"), "{error}");

        let workspace = db
            .create_workspace("demo", "C:/dev/demo")
            .expect("workspace");
        db.set_conversation_workspace(&conversation_id, Some(&workspace.id))
            .expect("vincular");
        let (matcher, pattern, scope_id) =
            rule_from_request(&db, &request, ApprovalScope::Workspace).expect("regra");
        assert_eq!(matcher, "prefix");
        assert_eq!(pattern, "npm test");
        assert_eq!(scope_id.as_deref(), Some(workspace.id.as_str()));

        let (_, _, session_scope) =
            rule_from_request(&db, &request, ApprovalScope::Session).expect("sessão");
        assert_eq!(session_scope.as_deref(), Some(conversation_id.as_str()));
        let (_, _, global_scope) =
            rule_from_request(&db, &request, ApprovalScope::Global).expect("global");
        assert!(global_scope.is_none());
    }

    #[test]
    fn validate_plan_choice_rejects_invalid_choice_and_bad_markdown() {
        assert!(validate_plan_choice(None, None).is_ok());
        assert!(validate_plan_choice(Some("approve_run"), None).is_ok());
        assert!(validate_plan_choice(Some("approve_review"), Some("# Plano")).is_ok());
        assert!(validate_plan_choice(Some("approve_goal"), Some("# Plano")).is_ok());
        assert!(validate_plan_choice(Some("keep_planning"), None).is_err());
        assert!(validate_plan_choice(Some("qualquer"), None).is_err());
        assert!(validate_plan_choice(None, Some("   ")).is_err());
        assert!(validate_plan_choice(None, Some(&"x".repeat(20_001))).is_err());
    }

    #[test]
    fn orphan_review_degrades_to_planning_only_without_a_pending_approval() {
        let reviewing = |state: PlanState| PlanView {
            state,
            markdown: Some("# Draft".into()),
            feedback: None,
            updated_at: 10,
        };

        // Gate pendente: mantém a revisão (o card ainda pode aprovar).
        let kept = degrade_orphan_review(Some(reviewing(PlanState::Reviewing)), true)
            .expect("plano");
        assert_eq!(kept.state, PlanState::Reviewing);
        assert!(kept.feedback.is_none());

        // Sem aprovação pendente: volta para planejamento com o aviso.
        let degraded = degrade_orphan_review(Some(reviewing(PlanState::Reviewing)), false)
            .expect("plano");
        assert_eq!(degraded.state, PlanState::Planning);
        assert_eq!(
            degraded.feedback,
            Some(session::stale_review_feedback())
        );
        assert_eq!(degraded.markdown.as_deref(), Some("# Draft"));

        // Aprovado/planejando não são tocados.
        let approved = degrade_orphan_review(Some(reviewing(PlanState::Approved)), false)
            .expect("plano");
        assert_eq!(approved.state, PlanState::Approved);
        assert!(degrade_orphan_review(None, false).is_none());
    }

    #[test]
    fn dead_approval_is_rejected_without_rule_or_audit() {
        let (db, conversation_id) = db_with_conversation();
        let registry = ApprovalRegistry::new();
        let error = apply_approval_decision(&db, &registry, "apr-morto", answer(ApprovalDecision::Approved))
            .expect_err("aprovação inexistente");
        assert!(error.starts_with("APPROVAL_NOT_FOUND"), "{error}");
        assert!(
            db.latest_code_event(&conversation_id, session::KIND_APPROVAL_DECIDED)
                .expect("ler")
                .is_none()
        );
        assert!(db.list_approval_rules().expect("regras").is_empty());
    }

    #[test]
    fn approval_is_resolved_once_and_plan_scope_is_rejected() {
        let (db, conversation_id) = db_with_conversation();
        let registry = ApprovalRegistry::new();

        // Gate de plano: escopo é inválido (não cria regra — D5).
        let mut request = approval_request(&conversation_id, "submit_plan");
        request.id = "apr-plan".to_string();
        let _rx = registry.register_request(request);
        let error = apply_approval_decision(
            &db,
            &registry,
            "apr-plan",
            ApprovalAnswer {
                decision: ApprovalDecision::Approved,
                scope: Some(ApprovalScope::Session),
                ..Default::default()
            },
        )
        .expect_err("escopo em plano é inválido");
        assert!(error.starts_with("APPROVAL_INVALID"), "{error}");
        assert!(registry.has_pending("apr-plan"), "pedido continua pendente");

        // Aprovação normal: o oneshot resolve e o segundo clique falha.
        let mut rx = registry.register_request(approval_request(&conversation_id, "run_command"));
        let first = apply_approval_decision(
            &db,
            &registry,
            "apr-1",
            answer(ApprovalDecision::Approved),
        )
        .expect("primeira decisão");
        assert!(first);
        let outcome = rx.try_recv().expect("outcome entregue");
        assert!(outcome.is_approved());
        assert!(outcome.choice.is_none());
        assert!(
            db.latest_code_event(&conversation_id, session::KIND_APPROVAL_DECIDED)
                .expect("ler")
                .is_some(),
            "auditoria registrada"
        );

        let second = apply_approval_decision(
            &db,
            &registry,
            "apr-1",
            answer(ApprovalDecision::Approved),
        )
        .expect_err("segundo clique não pode resolver");
        assert!(second.starts_with("APPROVAL_NOT_FOUND"), "{second}");
    }

    #[test]
    fn workspace_scope_rule_is_created_with_the_conversation_workspace() {
        let (db, conversation_id) = db_with_conversation();
        let workspace = db
            .create_workspace("demo", "C:/dev/demo")
            .expect("workspace");
        db.set_conversation_workspace(&conversation_id, Some(&workspace.id))
            .expect("vincular");

        let registry = ApprovalRegistry::new();
        let _rx = registry.register_request(approval_request(&conversation_id, "run_command"));
        let resolved = apply_approval_decision(
            &db,
            &registry,
            "apr-1",
            ApprovalAnswer {
                decision: ApprovalDecision::Approved,
                scope: Some(ApprovalScope::Workspace),
                ..Default::default()
            },
        )
        .expect("aprovar com regra workspace");
        assert!(resolved);

        let rules = db.list_approval_rules().expect("regras");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].scope, ApprovalScope::Workspace);
        assert_eq!(rules[0].scope_id.as_deref(), Some(workspace.id.as_str()));
        assert_eq!(rules[0].tool, "run_command");
        assert_eq!(rules[0].pattern, "npm test");
    }

    #[test]
    fn plan_choice_and_revised_markdown_reach_the_approval_outcome() {
        let (db, conversation_id) = db_with_conversation();
        let registry = ApprovalRegistry::new();
        let mut request = approval_request(&conversation_id, "submit_plan");
        request.id = "apr-plan".to_string();
        let mut rx = registry.register_request(request);
        let resolved = apply_approval_decision(
            &db,
            &registry,
            "apr-plan",
            ApprovalAnswer {
                decision: ApprovalDecision::Approved,
                choice: Some("approve_review".to_string()),
                plan_markdown: Some("  # Plano revisado  ".to_string()),
                ..Default::default()
            },
        )
        .expect("aprovar plano");
        assert!(resolved);
        let outcome: ApprovalOutcome = rx.try_recv().expect("outcome");
        assert!(outcome.is_approved());
        assert!(outcome.review_each_edit());
        assert_eq!(outcome.plan_markdown.as_deref(), Some("# Plano revisado"));
        assert!(
            db.list_approval_rules().expect("regras").is_empty(),
            "aprovação de plano não cria regra"
        );
    }

    #[test]
    fn goal_plan_choice_reaches_the_approval_outcome_without_a_rule() {
        let (db, conversation_id) = db_with_conversation();
        let registry = ApprovalRegistry::new();
        let mut request = approval_request(&conversation_id, "submit_plan");
        request.id = "apr-goal".to_string();
        let mut rx = registry.register_request(request);
        let resolved = apply_approval_decision(
            &db,
            &registry,
            "apr-goal",
            ApprovalAnswer {
                decision: ApprovalDecision::Approved,
                choice: Some("approve_goal".to_string()),
                ..Default::default()
            },
        )
        .expect("aprovar plano como objetivo");
        assert!(resolved);
        let outcome: ApprovalOutcome = rx.try_recv().expect("outcome");
        assert!(outcome.is_approved());
        assert!(outcome.execute_as_goal());
        assert!(!outcome.review_each_edit());
        assert!(
            db.list_approval_rules().expect("regras").is_empty(),
            "aprovação de plano não cria regra"
        );
    }

    /* -------------------------------------------------------------- */
    /* /compact manual: cache-safe (F6.2) + projeção D25               */
    /* -------------------------------------------------------------- */

    /// O `/compact` manual agora delega ao helper cache-safe do harness; não pode
    /// voltar a montar um request de resumo próprio (caminho não cache-safe).
    /// O uso real é provado em compile-time pela chamada no comando; este teste
    /// protege contra regressão textual (needles partidos para não casarem com o
    /// próprio literal do teste).
    #[test]
    fn manual_compact_uses_the_harness_cache_safe_helper() {
        let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/commands/code.rs"));
        assert!(
            source.contains(concat!("summarize_manual", "_for_conversation")),
            "o /compact manual deve delegar ao helper cache-safe do harness"
        );
        assert!(
            !source.contains(concat!("summary_system", "_prompt()")),
            "o manual não deve voltar a montar prompt próprio de sumarização"
        );
        assert!(
            !source.contains(concat!("complete", "_text(")),
            "o manual não deve voltar ao caminho de texto do batch (não cache-safe)"
        );
        // `to_seq`/projeção seguem vindo do outcome do helper, persistidos pelo
        // helper único de compactação.
        assert!(source.contains(concat!("persist", "_compaction(")));
        assert!(source.contains(concat!("outcome", ".covered")));
        assert!(source.contains(concat!("outcome", ".tokens_freed")));
    }

    #[test]
    fn manual_compact_projection_keeps_context_and_updates_compacted() {
        let (db, conversation_id) = db_with_conversation();
        assert!(session::context_stats(&db, &conversation_id).is_none());

        let stats = session::estimate_context(4_000, 8_000, 2_000, 200_000, 8_192, 10, 2, 0);
        session::save_context_stats(&db, &conversation_id, "turn-1", &stats).expect("stats");
        let before = session::context_stats(&db, &conversation_id).expect("contexto antes");
        assert_eq!(before.compacted, 0);

        // `/compact` manual grava só a projeção canônica (`context/compacted`).
        record_manual_compaction(&db, &conversation_id, 7, 900).expect("compactação manual");

        // D25: o fold do medidor continua lendo o `ContextStats` completo; antes
        // do fix o payload parcial em `context/stats` zerava o `context`.
        let after = session::context_stats(&db, &conversation_id).expect("contexto depois");
        assert_eq!(after.used, stats.used);
        assert_eq!(
            after.compacted, 0,
            "o manual não reescreve context/stats (payload exige ContextStats inteiro)"
        );
        assert_eq!(session::compacted_messages(&db, &conversation_id), 7);
        // `get_code_session_state` projeta o compacted atualizado via overlay.
        let projected = project_context(
            Some(after),
            session::compacted_messages(&db, &conversation_id),
        )
        .expect("contexto projetado");
        assert_eq!(projected.compacted, 7);
        assert_eq!(projected.used, stats.used);
        assert!(
            project_context(None, 7).is_none(),
            "sem stats persistido não inventa contexto"
        );

        // Um segundo `/compact` atualiza a projeção (último evento vence).
        record_manual_compaction(&db, &conversation_id, 9, 500).expect("segunda compactação");
        assert_eq!(session::compacted_messages(&db, &conversation_id), 9);

        // Resumo da compactação manual: `to_seq` = mensagens cobertas.
        db.insert_session_summary(crate::db::NewSessionSummary {
            conversation_id: &conversation_id,
            from_seq: 1,
            to_seq: 9,
            content: "resumo manual",
            tokens: None,
            kind: crate::harness::compaction::SUMMARY_KIND_LOCAL,
            provider_id: None,
            model_id: None,
            payload: None,
            covered_hash: None,
        })
        .expect("resumo");
        let latest = db
            .latest_session_summary(&conversation_id)
            .expect("ler resumo")
            .expect("resumo persistido");
        assert_eq!(latest.to_seq, 9);
    }

    /* -------------------------------------------------------------- */
    /* Objetivo (Goal) — F1c: comandos IPC/preflight/degradação        */
    /* -------------------------------------------------------------- */

    fn goal_input(objective: &str) -> CreateGoalInput {
        CreateGoalInput {
            objective: objective.to_string(),
            title: None,
            max_rounds: Some(5),
            auto_continue: Some(true),
        }
    }

    /// Banco em memória + conversa do Code com um workspace real em disco
    /// (o `TempDir` precisa viver enquanto o teste usa o workspace).
    fn code_workspace() -> (crate::db::Db, String, tempfile::TempDir) {
        let db = crate::db::Db::open_in_memory().expect("banco em memória");
        let conversation = db
            .create_conversation_with_mode(
                "Nova conversa",
                "opencode-go",
                "deepseek-v4.1-flash",
                crate::domain::CONVERSATION_MODE_CODE,
            )
            .expect("conversa");
        let dir = tempfile::tempdir().expect("diretório temporário");
        let workspace = db
            .create_workspace("demo", dir.path().to_str().expect("caminho utf-8"))
            .expect("workspace");
        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("vincular workspace");
        (db, conversation.id, dir)
    }

    fn goal_view(
        status: GoalStatus,
        auto_continue: bool,
        rounds: u32,
        max_rounds: u32,
        pause_reason: Option<GoalPauseReason>,
    ) -> GoalView {
        GoalView {
            title: "Objetivo".to_string(),
            objective: "Concluir a migração".to_string(),
            status,
            auto_continue,
            rounds,
            max_rounds,
            revision: 1,
            origin: GoalOrigin::User,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            last_round_at: None,
            last_note: None,
            pause_reason,
            pause_detail: None,
            blocker_reason: None,
            blocker_streak: 0,
            stalled_rounds: 0,
            tokens: 0,
            cost: 0.0,
        }
    }

    fn continuation_facts(goal: Option<&GoalView>) -> ContinuationFacts<'_> {
        ContinuationFacts {
            is_code: true,
            goal,
            plan_mode: false,
            pending_approval: false,
            has_active_turn: false,
            has_workspace: true,
        }
    }

    fn reason_code(
        facts: &ContinuationFacts<'_>,
        auto: bool,
    ) -> Option<&'static str> {
        continuation_reason(facts, auto).map(|reason| reason.code())
    }

    #[test]
    fn only_code_sessions_can_own_a_goal() {
        let (db, conversation_id) = db_with_conversation();
        let code = db
            .get_conversation(&conversation_id)
            .expect("ler")
            .expect("conversa do Code");
        assert!(is_code_session(&code));
        assert!(validate_goal_session(&code).is_ok());

        // Chat não tem objetivo (PLAN D18).
        let chat = db
            .create_conversation("Chat", "opencode-go", "deepseek-v4.1-flash")
            .expect("conversa do Chat");
        assert!(!is_code_session(&chat));
        let error = validate_goal_session(&chat).expect_err("Chat não tem objetivo");
        assert!(error.starts_with("GOAL_NOT_CODE"), "{error}");

        // Sessão do Chat adicionada ao Code (`codeLinked`) pode ter objetivo.
        let linked = db
            .set_conversation_code_linked(&chat.id, true)
            .expect("vincular ao Code");
        assert!(is_code_session(&linked));
        assert!(validate_goal_session(&linked).is_ok());
    }

    #[test]
    fn create_goal_requires_a_workspace_that_exists_on_disk() {
        let db = crate::db::Db::open_in_memory().expect("banco em memória");
        let conversation = db
            .create_conversation_with_mode(
                "Nova conversa",
                "opencode-go",
                "deepseek-v4.1-flash",
                crate::domain::CONVERSATION_MODE_CODE,
            )
            .expect("conversa");

        // Sem workspace: recusa e não grava nada (PLAN D15).
        let error = create_goal_for_conversation(&db, &conversation.id, &goal_input("Migrar"))
            .expect_err("sem workspace não cria");
        assert!(error.starts_with("GOAL_NO_WORKSPACE"), "{error}");
        assert!(goal::current(&db, &conversation.id).expect("fold").is_none());
        let stored = db
            .get_conversation(&conversation.id)
            .expect("ler")
            .expect("conversa");
        assert!(!goal_has_workspace(&db, &stored).expect("checar workspace"));

        // Workspace cadastrado, pasta removida do disco: recusa honesta.
        let parent = tempfile::tempdir().expect("diretório temporário");
        let gone = parent.path().join("nao-existe");
        let workspace = db
            .create_workspace("removido", gone.to_str().expect("caminho utf-8"))
            .expect("workspace");
        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("vincular");
        let error = create_goal_for_conversation(&db, &conversation.id, &goal_input("Migrar"))
            .expect_err("pasta ausente");
        assert!(error.starts_with("GOAL_NO_WORKSPACE"), "{error}");
        let stored = db
            .get_conversation(&conversation.id)
            .expect("ler")
            .expect("conversa");
        assert!(
            !goal_has_workspace(&db, &stored).expect("checar workspace"),
            "pasta ausente no disco"
        );

        // Workspace real: cria com os defaults da UI (origin user, armado).
        let dir = tempfile::tempdir().expect("diretório temporário");
        let workspace = db
            .create_workspace("demo", dir.path().to_str().expect("caminho utf-8"))
            .expect("workspace");
        db.set_conversation_workspace(&conversation.id, Some(&workspace.id))
            .expect("vincular");
        let stored = db
            .get_conversation(&conversation.id)
            .expect("ler")
            .expect("conversa");
        assert!(goal_has_workspace(&db, &stored).expect("checar workspace"));
        let goal = create_goal_for_conversation(&db, &conversation.id, &goal_input("Migrar"))
            .expect("criar objetivo");
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(goal.origin, GoalOrigin::User);
        assert!(goal.auto_continue);
        assert_eq!(goal.max_rounds, 5);
    }

    #[test]
    fn create_goal_renames_only_a_placeholder_conversation_title() {
        let (db, conversation_id, _dir) = code_workspace();
        let goal = create_goal_for_conversation(
            &db,
            &conversation_id,
            &CreateGoalInput {
                objective: "Migrar o módulo de pagamentos".to_string(),
                title: Some("Migração de pagamentos".to_string()),
                max_rounds: Some(10),
                auto_continue: Some(false),
            },
        )
        .expect("criar objetivo");
        assert!(!goal.auto_continue);
        let renamed = db
            .get_conversation(&conversation_id)
            .expect("ler")
            .expect("conversa");
        assert_eq!(
            renamed.title, "Migração de pagamentos",
            "título placeholder vira o título do objetivo"
        );

        // Título real nunca é sobrescrito (PLAN D17).
        let (db2, conversation2, _dir2) = code_workspace();
        db2.rename_conversation(&conversation2, "Planejamento financeiro")
            .expect("renomear");
        create_goal_for_conversation(&db2, &conversation2, &goal_input("Outro objetivo"))
            .expect("criar objetivo");
        let kept = db2
            .get_conversation(&conversation2)
            .expect("ler")
            .expect("conversa");
        assert_eq!(kept.title, "Planejamento financeiro");
    }

    #[test]
    fn create_goal_rejects_invalid_input_before_touching_the_title() {
        let (db, conversation_id, _dir) = code_workspace();
        let error = create_goal_for_conversation(&db, &conversation_id, &goal_input("   "))
            .expect_err("objetivo vazio");
        assert!(error.starts_with("GOAL_INVALID_ARGS"), "{error}");
        assert!(goal::current(&db, &conversation_id).expect("fold").is_none());
        let conversation = db
            .get_conversation(&conversation_id)
            .expect("ler")
            .expect("conversa");
        assert_eq!(conversation.title, "Nova conversa", "falha não renomeia");
    }

    #[test]
    fn update_goal_applies_cas_and_is_idempotent_on_the_target_state() {
        let (db, conversation_id, _dir) = code_workspace();
        let created = create_goal_for_conversation(&db, &conversation_id, &goal_input("Migrar"))
            .expect("criar objetivo");
        assert_eq!(created.revision, 1);
        assert!(created.auto_continue);
        let edit = UpdateGoalInput {
            title: Some("Migração".to_string()),
            ..Default::default()
        };

        // CAS: revisão esperada correta edita e incrementa uma vez.
        let edited = apply_goal_action(&db, &conversation_id, GoalAction::Edit, &edit, Some(1))
            .expect("editar")
            .expect("ativo");
        assert_eq!(edited.title, "Migração");
        assert_eq!(edited.revision, 2);

        // CAS: revisão velha ⇒ GOAL_STALE_REVISION (nada muda).
        let stale = apply_goal_action(&db, &conversation_id, GoalAction::Edit, &edit, Some(1))
            .expect_err("revisão desatualizada");
        assert!(stale.starts_with("GOAL_STALE_REVISION"), "{stale}");

        // Idempotência: armar um objetivo já armado não incrementa a revisão.
        let armed = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Arm,
            &UpdateGoalInput::default(),
            Some(2),
        )
        .expect("armar")
        .expect("ativo");
        assert_eq!(armed.revision, 2);
        assert!(armed.auto_continue);

        let disarmed = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Disarm,
            &UpdateGoalInput::default(),
            Some(2),
        )
        .expect("desarmar")
        .expect("ativo");
        assert!(!disarmed.auto_continue);
        assert_eq!(disarmed.revision, 3);
        let rearmed = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Arm,
            &UpdateGoalInput::default(),
            Some(3),
        )
        .expect("armar")
        .expect("ativo");
        assert!(rearmed.auto_continue);
        assert_eq!(rearmed.revision, 4);

        // Pausar/retomar (pausar um pausado é no-op).
        let pause = UpdateGoalInput {
            reason: Some("Revisando o escopo".to_string()),
            ..Default::default()
        };
        let paused = apply_goal_action(&db, &conversation_id, GoalAction::Pause, &pause, Some(4))
            .expect("pausar")
            .expect("ativo");
        assert_eq!(paused.status, GoalStatus::Paused);
        assert_eq!(paused.pause_reason, Some(GoalPauseReason::User));
        assert_eq!(paused.pause_detail.as_deref(), Some("Revisando o escopo"));
        let paused_again = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Pause,
            &UpdateGoalInput::default(),
            Some(5),
        )
        .expect("pausar de novo")
        .expect("pausado");
        assert_eq!(paused_again.revision, 5, "pausar um pausado é no-op");
        let resumed = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Resume,
            &UpdateGoalInput::default(),
            Some(5),
        )
        .expect("retomar")
        .expect("ativo");
        assert_eq!(resumed.status, GoalStatus::Active);
        assert!(resumed.auto_continue);
        assert_eq!(resumed.revision, 6);

        // Concluir + idempotência; reabrir volta manual.
        let complete = UpdateGoalInput {
            summary: Some("Feito com testes".to_string()),
            ..Default::default()
        };
        let completed = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Complete,
            &complete,
            Some(6),
        )
        .expect("concluir")
        .expect("ativo");
        assert_eq!(completed.status, GoalStatus::Completed);
        assert!(!completed.auto_continue);
        assert_eq!(completed.last_note.as_deref(), Some("Feito com testes"));
        let completed_again = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Complete,
            &UpdateGoalInput::default(),
            Some(7),
        )
        .expect("concluir de novo")
        .expect("ativo");
        assert_eq!(completed_again.revision, 7, "concluir um concluído é no-op");
        let reopened = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Reopen,
            &UpdateGoalInput::default(),
            Some(7),
        )
        .expect("reabrir")
        .expect("ativo");
        assert_eq!(reopened.status, GoalStatus::Active);
        assert!(!reopened.auto_continue, "reabrir volta manual");

        // Bloquear exige motivo; sem motivo não muda o estado.
        let invalid_block = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Block,
            &UpdateGoalInput::default(),
            Some(8),
        )
        .expect_err("motivo obrigatório");
        assert!(invalid_block.starts_with("GOAL_INVALID_ARGS"), "{invalid_block}");
        let block = UpdateGoalInput {
            reason: Some("Falta acesso ao gateway".to_string()),
            ..Default::default()
        };
        let blocked = apply_goal_action(&db, &conversation_id, GoalAction::Block, &block, Some(8))
            .expect("bloquear")
            .expect("ativo");
        assert_eq!(blocked.status, GoalStatus::Blocked);
        assert_eq!(
            blocked.blocker_reason.as_deref(),
            Some("Falta acesso ao gateway")
        );
        let resumed = apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Resume,
            &UpdateGoalInput::default(),
            Some(9),
        )
        .expect("retomar")
        .expect("ativo");
        assert_eq!(resumed.status, GoalStatus::Active);
        assert_eq!(resumed.revision, 10);

        // Encerrar: tombstone; ações posteriores recusam.
        assert!(apply_goal_action(
            &db,
            &conversation_id,
            GoalAction::Delete,
            &UpdateGoalInput::default(),
            Some(10),
        )
        .expect("encerrar")
        .is_none());
        assert!(goal::current(&db, &conversation_id).expect("fold").is_none());
        let missing =
            apply_goal_action(&db, &conversation_id, GoalAction::Edit, &edit, None)
                .expect_err("sem objetivo");
        assert!(missing.starts_with("GOAL_NOT_FOUND"), "{missing}");
    }

    #[test]
    fn project_goal_degrades_an_orphan_round_without_writing() {
        let (db, conversation_id, _dir) = code_workspace();
        let created = create_goal_for_conversation(&db, &conversation_id, &goal_input("Migrar"))
            .expect("criar objetivo");
        let begun = goal::begin_round(&db, &conversation_id, "turn-1").expect("abrir rodada");
        assert_eq!(begun.rounds, 1);
        assert_eq!(begun.revision, created.revision + 1);

        // Turno morto (crash/reload): o snapshot degrada, o log não muda.
        let projected = project_goal(&db, &conversation_id, false)
            .expect("projetar")
            .expect("objetivo");
        assert_eq!(projected.status, GoalStatus::Paused);
        assert_eq!(
            projected.pause_reason,
            Some(GoalPauseReason::Interrupted)
        );
        assert_eq!(
            projected.pause_detail,
            Some(orphan_round_detail())
        );
        assert!(!projected.auto_continue);
        let persisted = goal::current(&db, &conversation_id)
            .expect("fold")
            .expect("objetivo");
        assert_eq!(
            persisted.status,
            GoalStatus::Active,
            "degradação de leitura não grava"
        );
        assert_eq!(persisted.revision, begun.revision);

        // Turno vivo: rodada em andamento, nada degradado.
        let running = project_goal(&db, &conversation_id, true)
            .expect("projetar")
            .expect("objetivo");
        assert_eq!(running.status, GoalStatus::Active);
        assert!(running.auto_continue);

        // Fecho normal da rodada também não deixa o snapshot degradado.
        goal::finish_round(
            &db,
            &conversation_id,
            "turn-1",
            "done",
            &UsageInfo::default(),
            1,
        )
        .expect("fechar rodada");
        let closed = project_goal(&db, &conversation_id, false)
            .expect("projetar")
            .expect("objetivo");
        assert_eq!(closed.status, GoalStatus::Active);

        // Rodada já fechada como `interrupted` (existe `goal/round`): não é
        // órfã, então o snapshot não degrada de novo — um `resume` do usuário
        // continua de pé até a próxima rodada.
        goal::begin_round(&db, &conversation_id, "turn-2").expect("abrir rodada 2");
        goal::finish_round(
            &db,
            &conversation_id,
            "turn-2",
            "interrupted",
            &UsageInfo::default(),
            0,
        )
        .expect("fechar rodada interrompida");
        let reconciled = project_goal(&db, &conversation_id, false)
            .expect("projetar")
            .expect("objetivo");
        assert_eq!(
            reconciled.status,
            GoalStatus::Active,
            "rodada com `goal/round` fechado não é órfã"
        );

        // Objetivo inexistente continua `None`.
        let (other_db, other_id) = db_with_conversation();
        assert!(project_goal(&other_db, &other_id, false).expect("projetar").is_none());
    }

    #[test]
    fn orphan_degradation_only_touches_an_active_goal_without_a_live_turn() {
        let active = goal_view(GoalStatus::Active, true, 0, 5, None);
        let degraded = degrade_orphan_goal(Some(active.clone()), true, false).expect("objetivo");
        assert_eq!(degraded.status, GoalStatus::Paused);
        assert_eq!(degraded.pause_reason, Some(GoalPauseReason::Interrupted));
        assert_eq!(degraded.pause_detail, Some(orphan_round_detail()));
        assert!(!degraded.auto_continue);

        // Rodada em andamento (turno ativo): nada a degradar.
        let live = degrade_orphan_goal(Some(active.clone()), true, true).expect("objetivo");
        assert_eq!(live.status, GoalStatus::Active);
        assert!(live.auto_continue);

        // Rodada fechada: nada a degradar.
        let closed = degrade_orphan_goal(Some(active), false, false).expect("objetivo");
        assert_eq!(closed.status, GoalStatus::Active);

        // Concluído pelo usuário vence a leitura (não "ressuscita" pausa).
        let completed = goal_view(GoalStatus::Completed, false, 2, 5, None);
        let kept = degrade_orphan_goal(Some(completed), true, false).expect("objetivo");
        assert_eq!(kept.status, GoalStatus::Completed);

        assert!(degrade_orphan_goal(None, true, false).is_none());
    }

    #[test]
    fn goal_can_continue_reasons_follow_the_documented_order() {
        let active = goal_view(GoalStatus::Active, true, 0, 5, None);

        assert_eq!(
            reason_code(&continuation_facts(None), true),
            Some("no_goal")
        );

        let mut facts = continuation_facts(Some(&active));
        facts.is_code = false;
        assert_eq!(reason_code(&facts, true), Some("not_code"));

        // `completed`/`blocked` vencem os demais gates.
        let completed = goal_view(GoalStatus::Completed, false, 5, 5, None);
        let mut facts = continuation_facts(Some(&completed));
        facts.plan_mode = true;
        assert_eq!(reason_code(&facts, true), Some("completed"));
        let blocked = goal_view(GoalStatus::Blocked, false, 2, 5, None);
        let mut facts = continuation_facts(Some(&blocked));
        facts.has_active_turn = true;
        assert_eq!(reason_code(&facts, true), Some("blocked"));

        let paused = goal_view(GoalStatus::Paused, true, 2, 5, Some(GoalPauseReason::User));
        assert_eq!(
            reason_code(&continuation_facts(Some(&paused)), true),
            Some("paused")
        );

        // `autoContinue=false` só bloqueia a continuação automática (`auto=true`).
        let manual = goal_view(GoalStatus::Active, false, 0, 5, None);
        assert_eq!(
            reason_code(&continuation_facts(Some(&manual)), true),
            Some("not_armed")
        );
        assert_eq!(
            reason_code(&continuation_facts(Some(&manual)), false),
            None,
            "nova rodada manual não exige continuidade armada"
        );

        let exhausted = goal_view(GoalStatus::Active, true, 5, 5, None);
        assert_eq!(
            reason_code(&continuation_facts(Some(&exhausted)), true),
            Some("max_rounds")
        );

        let mut facts = continuation_facts(Some(&active));
        facts.plan_mode = true;
        assert_eq!(reason_code(&facts, true), Some("plan_mode"));

        let mut facts = continuation_facts(Some(&active));
        facts.pending_approval = true;
        assert_eq!(reason_code(&facts, true), Some("pending_approval"));

        let mut facts = continuation_facts(Some(&active));
        facts.has_active_turn = true;
        assert_eq!(reason_code(&facts, true), Some("busy"));

        let mut facts = continuation_facts(Some(&active));
        facts.has_workspace = false;
        assert_eq!(reason_code(&facts, true), Some("no_workspace"));

        // `paused(interrupted)` é reportado como `interrupted` (último código).
        // A degradação de rodada órfã desarma o objetivo (`autoContinue=false`,
        // PLAN §6.3), então na ordem oficial `not_armed` vence na continuação
        // automática; "Nova rodada" (`auto=false`) chega ao código específico.
        let interrupted = goal_view(
            GoalStatus::Paused,
            false,
            3,
            5,
            Some(GoalPauseReason::Interrupted),
        );
        assert_eq!(
            reason_code(&continuation_facts(Some(&interrupted)), true),
            Some("not_armed")
        );
        assert_eq!(
            reason_code(&continuation_facts(Some(&interrupted)), false),
            Some("interrupted")
        );
        // Objetivo ainda armado com pausa `interrupted` (snapshot antigo/pausa
        // manual do motivo): o código específico é alcançado no fim da ordem.
        let armed_interrupted = goal_view(
            GoalStatus::Paused,
            true,
            3,
            5,
            Some(GoalPauseReason::Interrupted),
        );
        assert_eq!(
            reason_code(&continuation_facts(Some(&armed_interrupted)), true),
            Some("interrupted")
        );
        // ...mas os gates anteriores continuam na frente na ordem oficial.
        let mut facts = continuation_facts(Some(&armed_interrupted));
        facts.has_workspace = false;
        assert_eq!(
            reason_code(&facts, true),
            Some("no_workspace"),
            "no_workspace vem antes de interrupted"
        );

        assert_eq!(reason_code(&continuation_facts(Some(&active)), true), None);
        assert_eq!(reason_code(&continuation_facts(Some(&active)), false), None);
    }

    #[test]
    fn goal_rounds_limit_is_clamped_to_one_through_two_hundred() {
        assert_eq!(clamp_rounds_limit(None), goal::GOAL_ROUNDS_LIST_LIMIT);
        assert_eq!(clamp_rounds_limit(Some(0)), 1);
        assert_eq!(clamp_rounds_limit(Some(1)), 1);
        assert_eq!(clamp_rounds_limit(Some(100)), 100);
        assert_eq!(clamp_rounds_limit(Some(200)), 200);
        assert_eq!(
            clamp_rounds_limit(Some(10_000)),
            goal::GOAL_ROUNDS_LIST_LIMIT
        );
    }
}
