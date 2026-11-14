//! One conversational turn: streaming harness execution + cancellation.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::domain::{TurnKind, TurnPayload, TurnResult};
use crate::events::TurnEvent;
use crate::harness::{self, EventEmitter, HarnessDeps};
use crate::state::AppState;

/// Persists every turn event and mirrors it on the global event bus. The bus
/// is the only live transport: a reloaded renderer reattaches from the same
/// journal, and the renderer watchdog can replay it whenever a message is lost.
struct PersistingEmitter {
    db: Arc<crate::db::Db>,
    app: AppHandle,
    turn_id: String,
    conversation_id: String,
    seq: AtomicU64,
}

impl EventEmitter for PersistingEmitter {
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

#[tauri::command]
pub async fn run_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: TurnPayload,
) -> Result<TurnResult, String> {
    // Rodada de objetivo: uma por conversa. O preflight (`goal_can_continue`)
    // também checa isso; aqui é a barreira final contra dois clientes/duplo
    // invoke. Turnos normais mantêm o comportamento anterior.
    if payload.turn_kind == TurnKind::GoalRound
        && state.has_active_turn_for(&payload.conversation_id)
    {
        return Err(
            crate::i18n::t("turn.errors.goalBusy"),
        );
    }
    let turn_id = payload
        .turn_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let Some(cancel) = state.register_turn_if_idle(&turn_id, &payload.conversation_id) else {
        return Err(
            crate::i18n::t("turn.errors.turnBusy")
                .to_string(),
        );
    };
    let _turn_guard = state.turn_guard(&turn_id);
    // The renderer paints the optimistic placeholder before invoking; this
    // event proves the turn was accepted even if it still waits for a slot.
    let emitter = Arc::new(PersistingEmitter {
        db: state.db.clone(),
        app: app.clone(),
        turn_id: turn_id.clone(),
        conversation_id: payload.conversation_id.clone(),
        seq: AtomicU64::new(0),
    });
    EventEmitter::emit(emitter.as_ref(), TurnEvent::Queued);
    let settings = crate::config::load_settings(&app);
    let conversation = state
        .db
        .get_conversation(&payload.conversation_id)
        .map_err(|error| format!("{error:#}"))?
        .ok_or_else(|| {
            crate::i18n::t_args(
                "turn.errors.conversationNotFound",
                &[("conversation_id", &payload.conversation_id)],
            )
        })?;
    let agent_key = conversation.agent_id.clone();
    let limits = crate::concurrency::TurnLimits {
        global: settings.max_concurrent_turns.max(1) as usize,
        per_agent: settings.max_concurrent_turns_per_agent.max(1) as usize,
    };
    let _permit = match state
        .governor
        .acquire(agent_key, limits, &cancel)
        .await
    {
        Ok(permit) => permit,
        Err(_) => {
            state.finish_turn(&turn_id);
            return Err(crate::i18n::t("turn.errors.cancelledBeforeStart"));
        }
    };
    let deps = HarnessDeps {
        app: Some(app.clone()),
        db: state.db.clone(),
        http: state.http.clone(),
        search_http: state.search_http.clone(),
        catalog: state.catalog.clone(),
        // Produção resolve o data dir pelo AppHandle; o campo existe para os
        // testes do harness (sem Tauri) apontarem para um diretório temporário.
        data_dir: None,
        // `None` = repositórios padrão de skills (Agent Skills/Codex/Claude/
        // OpenCode) resolvidos a partir do home do usuário.
        skills_roots: None,
        approvals: Some(state.approvals.clone()),
        observed: Some(state.observed.clone()),
        jobs: Some(state.jobs.clone()),
        questions: Some(state.questions.clone()),
        mcp: Some(state.mcp.clone()),
        streamer: None,
        api_key_override: None,
        // Produção resolve credencial/modelos pelo `AppState` (OAuth refresh,
        // lista de modelos da conta); os overrides existem só para testes.
        credential_override: None,
        refresh_override: None,
        model_source: None,
    };
    let result = harness::run_turn(deps, payload.clone(), settings, emitter, cancel).await;
    state.finish_turn(&turn_id);
    // `run_turn` returns `Ok` for failures that were already persisted (with a
    // structured `MessageError`); `Err` is reserved for preflight refusals that
    // must not create a transcript row.
    let completed = result
        .as_ref()
        .map(|turn| turn.assistant_message.error.is_none())
        .unwrap_or(false);
    let _ = state.db.end_computer_session(
        &payload.conversation_id,
        if completed { "completed" } else { "failed" },
        crate::domain::now_ms(),
    );
    // Keep the reattach table bounded; terminal turns older than 24h are not
    // needed by the renderer anymore.
    let _ = state
        .db
        .prune_turn_events(crate::domain::now_ms() - 24 * 60 * 60 * 1000);
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(format!("{error:#}")),
    }
}

#[tauri::command]
pub fn cancel_turn(state: State<'_, AppState>, turn_id: String) -> bool {
    state.cancel_turn(&turn_id)
}

/// Cancels every active turn of one conversation (background-thread Stop).
#[tauri::command]
pub fn cancel_all_turns(state: State<'_, AppState>) -> usize {
    state.cancel_all()
}

#[tauri::command]
pub fn cancel_conversation(state: State<'_, AppState>, conversation_id: String) -> usize {
    state.cancel_conversation(&conversation_id)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTurnInfo {
    pub turn_id: String,
    pub conversation_id: String,
    pub started_at: i64,
}

#[tauri::command]
pub fn list_active_turns(state: State<'_, AppState>) -> Vec<ActiveTurnInfo> {
    state
        .active_turn_details()
        .into_iter()
        .map(|(turn_id, conversation_id, started_at)| ActiveTurnInfo {
            turn_id,
            conversation_id,
            started_at,
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEventRecord {
    pub turn_id: String,
    pub seq: u64,
    pub event: serde_json::Value,
}

#[tauri::command]
pub fn list_turn_events(
    state: State<'_, AppState>,
    turn_id: String,
    after_seq: Option<u64>,
) -> Result<Vec<TurnEventRecord>, String> {
    let events = state
        .db
        .list_turn_events(&turn_id, after_seq)
        .map_err(|error| format!("{error:#}"))?;
    Ok(events
        .into_iter()
        .map(|(seq, event)| TurnEventRecord {
            turn_id: turn_id.clone(),
            seq,
            event,
        })
        .collect())
}
