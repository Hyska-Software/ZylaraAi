//! Comandos do terminal PTY do layout Code (F7).
//!
//! O terminal é uma superfície do **usuário** (ele digita e vê a saída); o
//! agente usa `run_command`/jobs. Contrato: `docs/goals/code-harness/HARNESS.md`
//! §8.3 e `WORKBENCH.md` §7.3.

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::events::TerminalEvent;
use crate::state::AppState;
use crate::terminal::TerminalInfo;

fn map_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Opens a terminal PTY and streams its output through the channel.
///
/// `conversation_id` runs the shell in the session workspace; `workspace_id`
/// does the same straight from a project (sidebar menu), with no session.
#[tauri::command]
pub async fn open_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    conversation_id: Option<String>,
    workspace_id: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalInfo, String> {
    let settings = crate::config::load_settings(&app);
    state
        .terminals
        .open(
            &state.db,
            &settings,
            conversation_id.as_deref(),
            workspace_id.as_deref(),
            cols,
            rows,
            on_event,
        )
        .map_err(map_err)
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.terminals.write(&id, &data).map_err(map_err)
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminals.resize(&id, cols, rows).map_err(map_err)
}

/// Encerra o processo (árvore) mantendo a aba aberta para mostrar o exit code.
#[tauri::command]
pub async fn kill_terminal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.terminals.kill(&id).map_err(map_err)
}

#[tauri::command]
pub async fn close_terminal(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    Ok(state.terminals.close(&id))
}

/// Lista os terminais abertos; `conversation_id` filtra por sessão e `None`
/// devolve todos (a UI mantém uma lista global de terminais).
#[tauri::command]
pub async fn list_terminals(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
) -> Result<Vec<TerminalInfo>, String> {
    Ok(state.terminals.list(conversation_id.as_deref()))
}
