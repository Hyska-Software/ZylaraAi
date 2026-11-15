//! Delegated agent tasks (agent↔agent collaboration).
//!
//! A task is a durable unit of work with one owner, a brief/acceptance
//! contract, budget and a dedicated hidden conversation. The scheduler runs
//! queued tasks in the background under the global concurrency governor. Human
//! tasks and tool-created tasks share the same state machine.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agents::{AgentTask, AgentTaskEvent, AgentTaskInput};
use crate::domain::{ChatMessage, MessageStatus, TurnKind, TurnOptions, TurnPayload, TurnProfile};
use crate::events::TurnEvent;
use crate::harness::{self, EventEmitter, HarnessDeps};
use crate::state::AppState;

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

/// Task turns run in the background but must remain inspectable: persist the
/// turn events and publish them on the global bus so an open task thread shows
/// progress while the task is still running (and can reattach after reload).
struct TaskEventEmitter {
    app: AppHandle,
    db: Arc<crate::db::Db>,
    turn_id: String,
    conversation_id: String,
    seq: AtomicU64,
}

impl EventEmitter for TaskEventEmitter {
    fn emit(&self, event: TurnEvent) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = self.db.append_turn_event(
                &self.turn_id,
                seq,
                &self.conversation_id,
                &json,
                crate::domain::now_ms(),
            );
        }
        let payload = serde_json::json!({
            "turnId": self.turn_id,
            "seq": seq,
            "conversationId": self.conversation_id,
            "event": event,
        });
        let _ = self.app.emit("zylara:turn-event", payload);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskDetail {
    pub task: AgentTask,
    pub events: Vec<AgentTaskEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskUpdatedEvent {
    pub task_id: String,
    pub owner_agent_id: String,
    pub status: String,
    pub title: String,
    pub origin_conversation_id: Option<String>,
}

#[tauri::command]
pub fn list_agent_tasks(
    state: State<'_, AppState>,
    status: Option<String>,
    owner_agent_id: Option<String>,
    channel_id: Option<String>,
) -> Result<Vec<AgentTask>, String> {
    state
        .db
        .list_agent_tasks(
            status.as_deref(),
            owner_agent_id.as_deref(),
            channel_id.as_deref(),
            Some(200),
        )
        .map_err(to_error)
}

#[tauri::command]
pub fn get_agent_task(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<AgentTaskDetail, String> {
    let task = state
        .db
        .get_agent_task(&task_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("tasks.errors.notFound", &[("task_id", &task_id)])
        })?;
    let events = state.db.list_agent_task_events(&task_id).map_err(to_error)?;
    Ok(AgentTaskDetail { task, events })
}

/// User-created task from the task board / channel composer.
#[tauri::command]
pub fn create_agent_task(
    state: State<'_, AppState>,
    input: AgentTaskInput,
) -> Result<AgentTask, String> {
    let mut input = input.normalize()?;
    if input.workspace_id.is_none() {
        input.workspace_id = state
            .db
            .get_agent(&input.to_agent_id)
            .map_err(to_error)?
            .and_then(|agent| agent.workspace_id);
    }
    state
        .db
        .create_agent_task(&input, None, None, true, crate::domain::now_ms())
        .map_err(to_error)
}

#[tauri::command]
pub fn cancel_agent_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<AgentTask, String> {
    let task = state
        .db
        .get_agent_task(&task_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("tasks.errors.notFound", &[("task_id", &task_id)])
        })?;
    if let Some(conversation_id) = task.conversation_id.as_deref() {
        // Stop the actual harness before changing the durable status. The
        // runner checks the status before writing a terminal transition.
        state.cancel_conversation(conversation_id);
        let _ = state
            .db
            .end_computer_session(conversation_id, "stopped", crate::domain::now_ms());
    }
    let updated = state
        .db
        .transition_agent_task(
            &task_id,
            Some(task.version),
            None,
            "cancelled",
            "user",
            serde_json::json!({ "reason": crate::i18n::t("tasks.cancelledByUser") }),
            None,
            None,
            crate::domain::now_ms(),
        )
        .map_err(to_error)?;
    deliver_task_result(
        &app,
        &updated,
        "cancelled",
        &crate::i18n::t("tasks.cancelledByUser"),
    );
    emit_updated(&app, &updated);
    Ok(updated)
}

#[tauri::command]
pub fn reassign_agent_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    to_agent_id: String,
) -> Result<AgentTask, String> {
    let task = state
        .db
        .get_agent_task(&task_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("tasks.errors.notFound", &[("task_id", &task_id)])
        })?;
    if let Some(conversation_id) = task.conversation_id.as_deref() {
        state.cancel_conversation(conversation_id);
    }
    let updated = state
        .db
        .handoff_agent_task(
            &task_id,
            &task.owner_agent_id,
            &to_agent_id,
            "user",
            &crate::i18n::t("tasks.reassignedByUser"),
            crate::domain::now_ms(),
        )
        .map_err(to_error)?;
    emit_updated(&app, &updated);
    Ok(updated)
}

#[tauri::command]
pub fn resume_agent_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<AgentTask, String> {
    let task = state
        .db
        .get_agent_task(&task_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("tasks.errors.notFound", &[("task_id", &task_id)])
        })?;
    if !matches!(
        task.status.as_str(),
        "waiting_input" | "waiting_approval" | "review"
    ) {
        return Err(crate::i18n::t_args(
            "tasks.errors.cannotResume",
            &[("status", &task.status)],
        ));
    }
    let resumed = state
        .db
        .transition_agent_task(
            &task_id,
            Some(task.version),
            None,
            "queued",
            "user",
            serde_json::json!({ "resumedBy": "user" }),
            None,
            None,
            crate::domain::now_ms(),
        )
        .map_err(to_error)?;
    emit_updated(&app, &resumed);
    Ok(resumed)
}

#[tauri::command]
pub async fn run_agent_task_now(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<AgentTask, String> {
    let mut task = state
        .db
        .get_agent_task(&task_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("tasks.errors.notFound", &[("task_id", &task_id)])
        })?;
    if matches!(
        task.status.as_str(),
        "waiting_input" | "waiting_approval" | "review"
    ) {
        task = state
            .db
            .transition_agent_task(
                &task.id,
                Some(task.version),
                None,
                "queued",
                "user",
                serde_json::json!({ "resumedBy": "user" }),
                None,
                None,
                crate::domain::now_ms(),
            )
            .map_err(to_error)?;
    }
    let spawned = task.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = execute_task(&app, spawned).await {
            eprintln!("zylara: tarefa iniciada manualmente falhou: {error}");
        }
    });
    Ok(task)
}

/// Tasks delegated by a channel leader stay queued until the leader's channel
/// turn ends, so task result messages never precede the leader's reply.
fn defer_for_channel_leader(
    db: &crate::db::Db,
    task: &AgentTask,
    has_active_turn: impl Fn(&str) -> bool,
) -> bool {
    let Some(origin_id) = task.origin_conversation_id.as_deref() else {
        return false;
    };
    let Ok(Some(conversation)) = db.get_conversation(origin_id) else {
        return false;
    };
    let Some(channel_id) = conversation.channel_id.as_deref() else {
        return false;
    };
    let Ok(Some(channel)) = db.get_agent_channel(channel_id) else {
        return false;
    };
    channel.leader_agent_id.is_some()
        && channel.leader_agent_id.as_deref() == conversation.agent_id.as_deref()
        && has_active_turn(origin_id)
}

/// One scheduler pass. Called by the background loop and safe to invoke from a
/// command. Tasks run in parallel up to the concurrency governor; a task that
/// cannot claim a slot stays queued for the next tick.
pub async fn scheduler_tick(app: AppHandle) {
    let state = app.state::<AppState>();
    let now = crate::domain::now_ms();
    if let Ok(swept) = state.db.sweep_agent_tasks(now) {
        for task in swept {
            if task.status == "failed" {
                deliver_task_result(&app, &task, "failed", task.result.as_deref().unwrap_or(""));
                if let Some(channel_id) = task.channel_id.as_deref() {
                    let state = app.state::<AppState>();
                    let _ = state.db.append_agent_channel_message(
                        channel_id,
                        "system",
                        None,
                        &crate::i18n::t_args(
                            "tasks.failedWithResult",
                            &[
                                ("title", &task.title),
                                (
                                    "result",
                                    task.result.as_deref().unwrap_or(
                                        "AGENT_TASK_DEADLINE",
                                    ),
                                ),
                            ],
                        ),
                        &[],
                        crate::domain::now_ms(),
                    );
                    let _ = app.emit(
                        "zylara:agent-channel-updated",
                        crate::commands::channels::AgentChannelUpdatedEvent {
                            channel_id: channel_id.to_string(),
                        },
                    );
                }
            }
            emit_updated(&app, &task);
        }
    }
    let due = match state.db.list_queued_agent_tasks(now, 12) {
        Ok(tasks) => tasks,
        Err(error) => {
            eprintln!("zylara: falha ao listar tarefas: {error:#}");
            return;
        }
    };
    let due: Vec<AgentTask> = due
        .into_iter()
        .filter(|task| {
            !defer_for_channel_leader(&state.db, task, |id| state.has_active_turn_for(id))
        })
        .collect();
    drop(state);
    for task in due {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = execute_task(&app, task).await {
                eprintln!("zylara: tarefa falhou: {error}");
            }
        });
    }
}

/// Publishes a completed task result to its shared channel. Returns the
/// channel id so the caller can emit the update event. Used both when the
/// runner concludes the task and when the owner finishes it via `finish_task`
/// inside the turn (in that case the runner loop just observes `done`).
fn publish_task_result_to_channel(
    db: &crate::db::Db,
    task: &AgentTask,
    text: &str,
) -> Option<String> {
    let channel_id = task.channel_id.as_deref()?;
    let message = if text.trim().is_empty() {
        crate::i18n::t_args(
            "tasks.completedWithoutResult",
            &[("title", &task.title)],
        )
    } else {
        crate::i18n::t_args(
            "tasks.completedWithResult",
            &[("title", &task.title), ("result", text)],
        )
    };
    db.append_agent_channel_message(
        channel_id,
        "agent",
        Some(&task.owner_agent_id),
        &message,
        &[],
        crate::domain::now_ms(),
    )
    .ok()?;
    Some(channel_id.to_string())
}

async fn execute_task(app: &AppHandle, task: AgentTask) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = crate::config::load_settings(app);
    let limits = crate::concurrency::TurnLimits {
        global: settings.max_concurrent_turns.max(1) as usize,
        per_agent: settings.max_concurrent_turns_per_agent.max(1) as usize,
    };
    let task = match state
        .db
        .claim_agent_task(&task.id, crate::domain::now_ms())
    {
        Ok(task) => task,
        Err(error) => {
            eprintln!("zylara: tarefa não reivindicada: {error:#}");
            return Ok(());
        }
    };
    emit_updated(app, &task);
    let agent = match state.db.get_agent(&task.owner_agent_id).map_err(to_error)? {
        Some(agent) if !agent.is_archived() => agent,
        Some(_) => {
            return finish_failure(
                app,
                &task,
                &crate::i18n::t("tasks.errors.ownerArchived"),
            );
        }
        None => {
            return finish_failure(app, &task, &crate::i18n::t("tasks.errors.ownerMissing"));
        }
    };

    let conversation = match task.conversation_id.as_deref() {
        Some(id) => match state.db.get_conversation(id).map_err(to_error)? {
            Some(conversation)
                if conversation.agent_id.as_deref() == Some(agent.id.as_str()) =>
            {
                conversation
            }
            _ => {
                let conversation = state
                    .db
                    .create_agent_conversation(
                    &agent.id,
                    &crate::i18n::t_args(
                        "tasks.threadTitle",
                        &[("title", &task.title)],
                    ),
                )
                    .map_err(to_error)?;
                state
                    .db
                    .set_agent_task_conversation(
                        &task.id,
                        &conversation.id,
                        crate::domain::now_ms(),
                    )
                    .map_err(to_error)?;
                conversation
            }
        },
        None => {
            let conversation = state
                .db
                .create_agent_conversation(
                    &agent.id,
                    &crate::i18n::t_args(
                        "tasks.threadTitle",
                        &[("title", &task.title)],
                    ),
                )
                .map_err(to_error)?;
            state
                .db
                .set_agent_task_conversation(
                    &task.id,
                    &conversation.id,
                    crate::domain::now_ms(),
                )
                .map_err(to_error)?;
            conversation
        }
    };

    if let Some(workspace_id) = task.workspace_id.as_deref() {
        if let Err(error) =
            state
                .db
                .set_conversation_workspace(&conversation.id, Some(workspace_id))
        {
            return finish_failure(
                app,
                &task,
                &format!("AGENT_TASK_WORKSPACE_UNAVAILABLE: {error:#}"),
            );
        }
    } else if let Err(error) = state.db.set_conversation_workspace(&conversation.id, None) {
        return finish_failure(
            app,
            &task,
            &format!("AGENT_TASK_WORKSPACE_UNAVAILABLE: {error:#}"),
        );
    }

    let turn_id = uuid::Uuid::new_v4().to_string();
    let Some(cancel) = state.register_turn_if_idle(&turn_id, &conversation.id) else {
        // The thread has another turn. Give the task back to the scheduler so
        // it is not stuck in `running` with a lease nobody owns.
        let _ = state.db.transition_agent_task(
            &task.id,
            Some(task.version),
            Some(&task.owner_agent_id),
            "queued",
            "system",
            serde_json::json!({ "reason": "conversation busy" }),
            None,
            None,
            crate::domain::now_ms(),
        );
        return Ok(());
    };
    let _turn_guard = state.turn_guard(&turn_id);
    let heartbeat = {
        let db = state.db.clone();
        let task_id = task.id.clone();
        let owner_agent_id = task.owner_agent_id.clone();
        let lease_cancel = cancel.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                match db.renew_agent_task_lease(
                    &task_id,
                    &owner_agent_id,
                    crate::domain::now_ms(),
                ) {
                    Ok(true) => {}
                    _ => {
                        // Another runner took over, the owner changed or the
                        // task was cancelled: stop the harness.
                        lease_cancel.cancel();
                        break;
                    }
                }
            }
        })
    };

    let channel_line = match task.channel_id.as_deref() {
        Some(channel_id) => state
            .db
            .get_agent_channel(channel_id)
            .ok()
            .flatten()
            .map(|channel| format!("\nCanal compartilhado: #{} (`{}`).", channel.name, channel.id))
            .unwrap_or_default(),
        None => String::new(),
    };
    let prompt = format!(
        "Você é {name} e é o dono da tarefa `{task_id}`.\n\n\
         Título: {title}\n\nBrief:\n{brief}\n\nCritério de aceite:\n{acceptance}\n\n\
         Orçamento: até {turns} turnos, {tokens} tokens e US$ {cost:.2}.{channel_line}\n\n\
         Trabalhe até concluir a tarefa. Registre o resultado com evidência real; \
         se precisar de outro agente, use `delegate_task` com escopo pequeno. \
         Se não puder assumir a tarefa, chame `decline_task`. \
         Se estiver bloqueado, explique o bloqueio em vez de inventar resultado.",
        name = agent.name,
        task_id = task.id,
        title = task.title,
        brief = task.brief,
        acceptance = if task.acceptance.trim().is_empty() {
            "(não informado)"
        } else {
            task.acceptance.as_str()
        },
        turns = task.max_turns,
        tokens = task.max_tokens,
        cost = task.max_cost,
        channel_line = channel_line,
    );
    let deps = HarnessDeps {
        app: Some(app.clone()),
        db: state.db.clone(),
        http: state.http.clone(),
        search_http: state.search_http.clone(),
        catalog: state.catalog_with_plugins(),
        data_dir: None,
        skills_roots: None,
        // Unattended task work cannot answer approval/question cards.
        approvals: None,
        observed: Some(state.observed.clone()),
        jobs: Some(state.jobs.clone()),
        questions: None,
        mcp: Some(state.mcp.clone()),
        streamer: None,
        api_key_override: None,
        credential_override: None,
        refresh_override: None,
        model_source: None,
    };
    let max_turns = task.max_turns.clamp(1, 32) as u32;
    let mut total_cost = 0.0f64;
    let mut total_tokens = 0i64;
    let mut last_text = String::new();
    let mut budget_error: Option<String> = None;
    let mut worker_error: Option<String> = None;
    let mut interrupted = false;
    let mut turns_run = 0u32;
    for index in 0..max_turns {
        if cancel.is_cancelled() {
            break;
        }
        let current = match state.db.get_agent_task(&task.id).map_err(to_error)? {
            Some(value) => value,
            None => {
                worker_error = Some(crate::i18n::t("tasks.errors.vanished"));
                break;
            }
        };
        if current.owner_agent_id != task.owner_agent_id {
            break;
        }
        if matches!(
            current.status.as_str(),
            "done" | "cancelled" | "declined" | "failed" | "handoff_pending"
        ) {
            break;
        }
        if matches!(
            current.status.as_str(),
            "waiting_input" | "waiting_approval" | "review"
        ) {
            break;
        }
        if current
            .deadline_at
            .is_some_and(|deadline| deadline <= crate::domain::now_ms())
        {
            budget_error = Some(crate::i18n::t("tasks.errors.deadlineExpired"));
            break;
        }
        let _permit = match state
            .governor
            .acquire(Some(agent.id.clone()), limits, &cancel)
            .await
        {
            Ok(permit) => permit,
            Err(_) => break,
        };
        let content = if index == 0 {
            prompt.clone()
        } else {
            format!(
                "Continuação {}/{} da tarefa `{}`.\n\nO trabalho ainda não foi concluído. \
                 Continue de onde parou, verifique o resultado com evidência real e chame \
                 `finish_task` quando o critério de aceite estiver cumprido. Não repita o que \
                 já está pronto e respeite o orçamento.",
                index + 1,
                max_turns,
                task.title
            )
        };
        let task_turn_id = format!("{turn_id}-{}", index + 1);
        let payload = TurnPayload {
            conversation_id: conversation.id.clone(),
            content,
            attachment_ids: Vec::new(),
            provider_id: agent.provider_id.clone(),
            model_id: agent.model_id.clone(),
            reasoning: agent.reasoning.clone(),
            options: TurnOptions {
                max_steps: Some(16),
                ..TurnOptions::default()
            },
            profile: TurnProfile::Code,
            turn_kind: TurnKind::User,
            goal_request: false,
            turn_id: Some(task_turn_id.clone()),
            resume_assistant_message_id: None,
        };
        let emitter = Arc::new(TaskEventEmitter {
            app: app.clone(),
            db: state.db.clone(),
            turn_id: task_turn_id,
            conversation_id: conversation.id.clone(),
            seq: AtomicU64::new(0),
        });
        match harness::run_turn(
            deps.clone(),
            payload,
            settings.clone(),
            emitter,
            cancel.clone(),
        )
        .await
        {
            Ok(result) => {
                if result.assistant_message.status == MessageStatus::Cancelled {
                    // Leave a task interrupted by shutdown/global Stop in
                    // `running`; the existing lease sweep requeues it after the
                    // lease expires. A user-cancelled task keeps its own path
                    // below (status is already cancelled/declined).
                    if state
                        .db
                        .get_agent_task(&task.id)
                        .ok()
                        .flatten()
                        .is_some_and(|task| task.status == "running")
                    {
                        interrupted = true;
                    }
                    break;
                }
                if result.error.is_some() || result.assistant_message.status == MessageStatus::Error
                {
                    worker_error = result
                        .error
                        .map(|error| error.hint.unwrap_or(error.message))
                        .or_else(|| {
                            Some(crate::i18n::t("tasks.errors.turnFailed"))
                        });
                    break;
                }
                turns_run += 1;
                total_cost += result.usage.as_ref().and_then(|usage| usage.cost).unwrap_or(0.0);
                total_tokens += i64::from(
                    result
                        .usage
                        .as_ref()
                        .and_then(|usage| usage.total_tokens)
                        .unwrap_or(0),
                );
                last_text = result.assistant_message.content.trim().to_string();
                let latest = state.db.get_agent_task(&task.id).ok().flatten();
                let Some(latest) = latest else {
                    worker_error = Some(crate::i18n::t("tasks.errors.vanished"));
                    break;
                };
                if latest.owner_agent_id != task.owner_agent_id {
                    break;
                }
                if matches!(
                    latest.status.as_str(),
                    "done" | "cancelled" | "declined" | "failed" | "handoff_pending"
                ) {
                    break;
                }
                if matches!(
                    latest.status.as_str(),
                    "waiting_input" | "waiting_approval" | "review"
                ) {
                    break;
                }
                if latest.status != "done" {
                    if total_cost > task.max_cost {
                        budget_error = Some(format!(
                            "AGENT_TASK_BUDGET: custo US$ {total_cost:.2} passou do limite US$ {:.2}",
                            task.max_cost
                        ));
                        break;
                    }
                    if total_tokens > task.max_tokens {
                        budget_error = Some(format!(
                            "AGENT_TASK_BUDGET: {} tokens passaram do limite {}",
                            total_tokens, task.max_tokens
                        ));
                        break;
                    }
                }
            }
            Err(error) => {
                worker_error = Some(format!("{error:#}"));
                break;
            }
        }
    }
    heartbeat.abort();

    if interrupted {
        if let Ok(Some(latest)) = state.db.get_agent_task(&task.id) {
            emit_updated(app, &latest);
        }
        return Ok(());
    }

    let latest = state.db.get_agent_task(&task.id).ok().flatten();
    let Some(mut current) = latest else {
        return finish_failure(app, &task, &crate::i18n::t("tasks.errors.vanished"));
    };
    if current.status == "cancelled" || current.status == "declined" {
        deliver_task_result(
            app,
            &current,
            &current.status.clone(),
            current.result.as_deref().unwrap_or(""),
        );
        emit_updated(app, &current);
        return Ok(());
    }
    if current.owner_agent_id != task.owner_agent_id {
        emit_updated(app, &current);
        return Ok(());
    }
    if matches!(
        current.status.as_str(),
        "waiting_input" | "waiting_approval" | "review"
    ) {
        emit_updated(app, &current);
        return Ok(());
    }
    if current.status == "done" {
        let text = current.result.as_deref().unwrap_or("");
        if let Some(channel_id) = publish_task_result_to_channel(&state.db, &current, text) {
            let _ = app.emit(
                "zylara:agent-channel-updated",
                crate::commands::channels::AgentChannelUpdatedEvent { channel_id },
            );
        }
    }
    if current.status == "failed" || current.status == "done" {
        deliver_task_result(
            app,
            &current,
            &current.status.clone(),
            current.result.as_deref().unwrap_or(""),
        );
        emit_updated(app, &current);
        return Ok(());
    }
    if current.status == "handoff_pending" {
        emit_updated(app, &current);
        return Ok(());
    }
    if cancel.is_cancelled() {
        let cancelled = state
            .db
            .transition_agent_task(
                &task.id,
                Some(current.version),
                Some(&task.owner_agent_id),
                "cancelled",
                "system",
                serde_json::json!({ "reason": "runner interrompido" }),
                None,
                None,
                crate::domain::now_ms(),
            )
            .ok();
        if let Some(cancelled) = cancelled {
            deliver_task_result(app, &cancelled, "cancelled", "runner interrompido");
            emit_updated(app, &cancelled);
        }
        return Ok(());
    }
    if let Some(error) = budget_error {
        return finish_failure(app, &task, &error);
    }
    if let Some(error) = worker_error {
        if let Ok(Some(latest)) = state.db.get_agent_task(&task.id) {
            if latest.retry_count == 0
                && latest.owner_agent_id == task.owner_agent_id
                && state
                    .db
                    .retry_agent_task_once(
                        &task.id,
                        &task.owner_agent_id,
                        latest.version,
                        crate::domain::now_ms(),
                    )
                    .unwrap_or(false)
            {
                if let Ok(Some(retried)) = state.db.get_agent_task(&task.id) {
                    emit_updated(app, &retried);
                }
                return Ok(());
            }
        }
        return finish_failure(app, &task, &error);
    }
    if last_text.trim().is_empty() {
        return finish_failure(
            app,
            &task,
            &format!(
                "AGENT_TASK_INCOMPLETE: a tarefa não foi concluída em {max_turns} turno(s) \
                 e não devolveu resultado"
            ),
        );
    }
    current = state
        .db
        .transition_agent_task(
            &task.id,
            Some(current.version),
            Some(&task.owner_agent_id),
            "done",
            "agent",
            serde_json::json!({
                "turns": turns_run,
                "tokens": total_tokens,
                "cost": total_cost,
            }),
            Some(&last_text),
            None,
            crate::domain::now_ms(),
        )
        .map_err(to_error)?;
    let text = current
        .result
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(last_text.as_str())
        .to_string();
    if let Some(channel_id) = publish_task_result_to_channel(&state.db, &task, &text) {
        let _ = app.emit(
            "zylara:agent-channel-updated",
            crate::commands::channels::AgentChannelUpdatedEvent { channel_id },
        );
    }
    deliver_task_result(app, &current, "done", &text);
    emit_updated(app, &current);
    Ok(())
}

fn finish_failure(app: &AppHandle, task: &AgentTask, message: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(latest) = state.db.get_agent_task(&task.id).map_err(to_error)? else {
        return Ok(());
    };
    if latest.owner_agent_id != task.owner_agent_id {
        return Ok(());
    }
    if matches!(
        latest.status.as_str(),
        "done" | "cancelled" | "declined" | "failed"
    ) {
        return Ok(());
    }
    let updated = match state.db.transition_agent_task(
        &task.id,
        Some(latest.version),
        Some(&latest.owner_agent_id),
        "failed",
        "system",
        serde_json::json!({ "error": message }),
        Some(message),
        None,
        crate::domain::now_ms(),
    ) {
        Ok(task) => task,
        Err(error) if format!("{error:#}").contains("AGENT_TASK_STALE") => return Ok(()),
        Err(error) => return Err(to_error(error)),
    };
    deliver_task_result(app, &updated, "failed", message);
    if let Some(channel_id) = task.channel_id.as_deref() {
        let _ = state.db.append_agent_channel_message(
            channel_id,
            "system",
            None,
            &crate::i18n::t_args(
                "tasks.failedWithResult",
                &[("title", &task.title), ("result", &message)],
            ),
            &[],
            crate::domain::now_ms(),
        );
        let _ = app.emit(
            "zylara:agent-channel-updated",
            crate::commands::channels::AgentChannelUpdatedEvent {
                channel_id: channel_id.to_string(),
            },
        );
    }
    emit_updated(app, &updated);
    Err(message.to_string())
}

fn deliver_task_result(app: &AppHandle, task: &AgentTask, status: &str, text: &str) {
    let state = app.state::<AppState>();
    let Some(origin_id) = task.origin_conversation_id.as_deref() else {
        return;
    };
    if state
        .db
        .get_conversation(origin_id)
        .ok()
        .flatten()
        .is_none()
    {
        return;
    }
    if state
        .db
        .task_result_message_exists(origin_id, &task.id)
        .unwrap_or(false)
    {
        return;
    }
    let result: String = {
        let mut body = text.trim().to_string();
        if !task.result_artifact_ids.is_empty() {
            body.push_str("\n\nArtefatos:");
            for artifact_id in &task.result_artifact_ids {
                if let Ok(Some(stored)) = state.db.get_artifact(artifact_id) {
                    body.push_str(&format!("\n- {} (`{}`)", stored.artifact.name, artifact_id));
                }
            }
        }
        body.chars().take(8 * 1024).collect()
    };
    let body = if result.is_empty() {
        crate::i18n::t_args(
            "tasks.resultWithoutText",
            &[("title", &task.title), ("task_id", &task.id), ("status", &status)],
        )
    } else {
        crate::i18n::t_args(
            "tasks.resultWithText",
            &[
                ("title", &task.title),
                ("task_id", &task.id),
                ("status", &status),
                ("result", &result),
            ],
        )
    };
    let message = ChatMessage::system(origin_id, body);
    let _ = state.db.insert_message(&message);
}

fn emit_updated(app: &AppHandle, task: &AgentTask) {
    let _ = app.emit(
        "zylara:agent-task-updated",
        AgentTaskUpdatedEvent {
            task_id: task.id.clone(),
            owner_agent_id: task.owner_agent_id.clone(),
            status: task.status.clone(),
            title: task.title.clone(),
            origin_conversation_id: task.origin_conversation_id.clone(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{Agent, AgentCapabilities, AgentInput};
    use crate::domain::PermissionMode;

    fn agent(db: &crate::db::Db, name: &str) -> Agent {
        db.create_agent(&AgentInput {
            name: name.to_string(),
            role: "Engenheiro".to_string(),
            description: String::new(),
            avatar: crate::agents::AgentAvatar::emoji("🛠️"),
            department: "Geral".to_string(),
            provider_id: "opencode-go".to_string(),
            model_id: "deepseek-v4.1-flash".to_string(),
            fallback_provider_id: None,
            fallback_model_id: None,
            reasoning: None,
            instructions: String::new(),
            starters: Vec::new(),
            capabilities: AgentCapabilities::default(),
            memory_enabled: false,
            workspace_id: None,
            permission_mode: PermissionMode::Edit,
            docker_image: None,
            computer_environment: "auto".to_string(),
        })
        .expect("agent")
    }

    fn task_input(channel_id: &str, to_agent_id: &str) -> AgentTaskInput {
        AgentTaskInput {
            to_agent_id: to_agent_id.to_string(),
            title: "Revisar".to_string(),
            brief: "Revise o material.".to_string(),
            acceptance: String::new(),
            channel_id: Some(channel_id.to_string()),
            parent_task_id: None,
            workspace_id: None,
            max_turns: None,
            max_tokens: None,
            max_cost: None,
            deadline_minutes: None,
        }
    }

    #[test]
    fn completed_task_publishes_its_result_to_the_channel() {
        let db = crate::db::Db::open_in_memory().expect("db");
        let owner = agent(&db, "Bia");
        let now = crate::domain::now_ms();
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Lançamento".to_string(),
                    member_ids: vec![owner.id.clone()],
                    leader_agent_id: None,
                },
                now,
            )
            .expect("channel");
        let task = db
            .create_agent_task(
                &task_input(&channel.id, &owner.id),
                Some(&owner.id),
                None,
                false,
                now,
            )
            .expect("task");

        let published = publish_task_result_to_channel(&db, &task, "Resumo pronto.");
        assert_eq!(published.as_deref(), Some(channel.id.as_str()));

        let messages = db
            .list_agent_channel_messages(&channel.id, Some(10))
            .expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "agent");
        assert_eq!(messages[0].agent_id.as_deref(), Some(owner.id.as_str()));
        assert!(messages[0].content.contains("Tarefa `Revisar` concluída"));
        assert!(messages[0].content.contains("Resumo pronto."));
    }

    #[test]
    fn channel_leader_tasks_wait_for_the_leader_turn() {
        let db = crate::db::Db::open_in_memory().expect("db");
        let leader = agent(&db, "Ana");
        let member = agent(&db, "Bia");
        let now = crate::domain::now_ms();
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Lançamento".to_string(),
                    member_ids: vec![leader.id.clone(), member.id.clone()],
                    leader_agent_id: Some(leader.id.clone()),
                },
                now,
            )
            .expect("channel");
        let leader_thread = db
            .get_or_create_channel_conversation(&channel.id, &leader.id, "#Lançamento · Ana")
            .expect("leader thread");
        let member_thread = db
            .get_or_create_channel_conversation(&channel.id, &member.id, "#Lançamento · Bia")
            .expect("member thread");

        let leader_task = db
            .create_agent_task(
                &task_input(&channel.id, &member.id),
                Some(&leader.id),
                Some(&leader_thread.id),
                false,
                now,
            )
            .expect("leader task");
        assert!(defer_for_channel_leader(&db, &leader_task, |id| {
            id == leader_thread.id
        }));
        assert!(!defer_for_channel_leader(&db, &leader_task, |_| false));

        let member_task = db
            .create_agent_task(
                &task_input(&channel.id, &leader.id),
                Some(&member.id),
                Some(&member_thread.id),
                false,
                now,
            )
            .expect("member task");
        assert!(!defer_for_channel_leader(&db, &member_task, |id| {
            id == member_thread.id
        }));
    }
}
