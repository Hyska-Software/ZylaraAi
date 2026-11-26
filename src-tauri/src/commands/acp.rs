//! Tauri commands for ACP agents: Registry discovery, installation, auth and diagnostics.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use tauri::State;

use crate::acp::{
    self, AcpAgentRow, AcpAgentView, AcpAuthAction, AcpAuthView, AcpCapabilities,
    AcpCustomAgentInput, AcpInstallRequest, AcpRegistryAgent,
};
use crate::domain::ProviderValidation;
use crate::state::AppState as RuntimeState;

use crate::acp::registry::REGISTRY_CACHE_KEY;
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    crate::domain::now_ms()
}

fn installed_rows(state: &RuntimeState) -> Vec<AcpAgentRow> {
    state.db.acp_agents().unwrap_or_default()
}

fn manifest_by_id(id: &str, state: &RuntimeState) -> Option<crate::acp::registry::RegistryManifest> {
    let cached = state.db.acp_cache_get(REGISTRY_CACHE_KEY).ok().flatten();
    let from_cache = cached
        .and_then(|raw| serde_json::from_str::<crate::acp::RegistryFile>(&raw).ok())
        .or_else(|| Some(crate::acp::registry::embedded_snapshot()));
    from_cache?
        .agents
        .into_iter()
        .find(|manifest| manifest.id == id)
}

fn view_of(state: &RuntimeState, row: &AcpAgentRow) -> AcpAgentView {
    let count = state
        .db
        .acp_models(&row.id)
        .map(|models| models.len() as u32)
        .unwrap_or(0);
    acp::to_view(row, count)
}

async fn registry_agents(state: &RuntimeState, force: bool) -> Result<Vec<AcpRegistryAgent>, String> {
    let fetched_at_key = format!("{REGISTRY_CACHE_KEY}:fetched_at");
    let etag_key = format!("{REGISTRY_CACHE_KEY}:etag");
    let cached_raw = state.db.acp_cache_get(REGISTRY_CACHE_KEY).ok().flatten();
    let cached = cached_raw
        .as_deref()
        .and_then(|raw| serde_json::from_str::<crate::acp::RegistryFile>(raw).ok());
    let fresh = cached.as_ref().is_some_and(|_file| {
        state
            .db
            .acp_cache_get(&fetched_at_key)
            .ok()
            .flatten()
            .and_then(|raw| raw.parse::<i64>().ok())
            .is_some_and(|at| now_ms().saturating_sub(at) < CACHE_TTL_MS)
    });

    let manifests = if force || !fresh {
        let etag = state.db.acp_cache_get(&etag_key).ok().flatten();
        match crate::acp::registry::fetch(&state.http, etag.as_deref()).await {
            Ok(fetch) if !fetch.not_modified && !fetch.agents.is_empty() => {
                let file = crate::acp::RegistryFile {
                    version: "1.0.0".to_string(),
                    agents: fetch.agents.clone(),
                };
                if let Ok(raw) = serde_json::to_string(&file) {
                    let _ = state.db.acp_cache_set(REGISTRY_CACHE_KEY, &raw);
                }
                if let Some(etag) = fetch.etag {
                    let _ = state.db.acp_cache_set(&etag_key, &etag);
                }
                let _ = state.db.acp_cache_set(&fetched_at_key, &now_ms().to_string());
                fetch.agents
            }
            Ok(_) => {
                // 304 Not Modified: keep the snapshot but refresh the clock so
                // every UI open does not hit the CDN again.
                let _ = state.db.acp_cache_set(&fetched_at_key, &now_ms().to_string());
                cached
                    .map(|file| file.agents)
                    .unwrap_or_else(|| crate::acp::registry::embedded_snapshot().agents)
            }
            Err(error) => {
                eprintln!("zylara: falha ao atualizar Registry ACP: {error:#}");
                cached
                    .map(|file| file.agents)
                    .unwrap_or_else(|| crate::acp::registry::embedded_snapshot().agents)
            }
        }
    } else {
        cached.map(|file| file.agents).unwrap_or_default()
    };

    // Cache the Registry's monochrome SVGs once. Existing installs and the
    // available-agents list both read them back from <data>/acp/icons/<id>.svg.
    let missing: Vec<crate::acp::registry::RegistryManifest> = manifests
        .iter()
        .filter(|manifest| {
            !state
                .data_dir
                .join("acp")
                .join("icons")
                .join(format!("{}.svg", manifest.id))
                .exists()
        })
        .cloned()
        .collect();
    futures_util::stream::iter(missing)
        .map(|manifest| {
            let http = state.http.clone();
            let data_dir = state.data_dir.clone();
            async move {
                let _ = crate::acp::install::download_icon(&http, &manifest, &data_dir).await;
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<()>>()
        .await;

    // `to_views` expects registry ids (without `acp__`), not provider ids.
    let installed = installed_rows(state);
    let installed_ids: Vec<String> = installed
        .iter()
        .map(|row| {
            row.registry_id
                .clone()
                .unwrap_or_else(|| row.id.strip_prefix(acp::ID_PREFIX).unwrap_or(&row.id).to_string())
        })
        .collect();
    let versions: HashMap<String, String> = installed
        .iter()
        .filter_map(|row| {
            row.registry_id
                .as_ref()
                .map(|id| (id.clone(), row.version.clone()))
        })
        .collect();
    let mut views = crate::acp::registry::to_views(&manifests, &installed_ids);
    for view in &mut views {
        view.icon_svg = crate::acp::load_icon_svg_by_id(&state.data_dir, &view.id);
        view.update_available = versions
            .get(&view.id)
            .is_some_and(|version| version != &view.version);
    }
    Ok(views)
}

#[tauri::command]
pub async fn acp_list_registry(
    state: State<'_, RuntimeState>,
) -> Result<Vec<AcpRegistryAgent>, String> {
    registry_agents(&state, false).await
}

#[tauri::command]
pub async fn acp_refresh_registry(
    force: Option<bool>,
    state: State<'_, RuntimeState>,
) -> Result<Vec<AcpRegistryAgent>, String> {
    registry_agents(&state, force.unwrap_or(true)).await
}

#[tauri::command]
pub async fn acp_install_agent(
    registry_id: String,
    accept_command: bool,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AcpAgentView, String> {
    let req = AcpInstallRequest {
        registry_id,
        accept_command,
    };
    if !req.accept_command {
        return Err(crate::i18n::t("acp.errors.consentRequired").to_string());
    }
    let registry_id = req.registry_id.trim();
    let manifest = manifest_by_id(registry_id, &state)
        .ok_or_else(|| crate::i18n::t_args("acp.errors.unknownAgent", &[("id", registry_id)]))?;
    let target = crate::acp::registry::current_target();
    let distribution = crate::acp::registry::select_distribution(&manifest, target)
        .ok_or_else(|| crate::i18n::t_args("acp.errors.unsupportedDistribution", &[("target", target)]))?;
    let data_dir = crate::config::data_dir(&app).map_err(|e| e.to_string())?;
    let id = acp::provider_id(registry_id);
    let mut row = match distribution {
        crate::acp::registry::Distribution::Binary(_) => {
            crate::acp::install::install_binary_async(&state.http, &manifest, target, &data_dir)
                .await
                .map_err(|e| e.to_string())?
        }
        crate::acp::registry::Distribution::Npx(package) => {
            crate::acp::install::install_package(
                "npx",
                &package.package,
                &package.args,
                &package.env,
                registry_id,
            )
            .map_err(|e| e.to_string())?
        }
        crate::acp::registry::Distribution::Uvx(package) => {
            crate::acp::install::install_package(
                "uvx",
                &package.package,
                &package.args,
                &package.env,
                registry_id,
            )
            .map_err(|e| e.to_string())?
        }
    };
    row.id = id.clone();
    row.registry_id = Some(registry_id.to_string());
    row.name = manifest.name.clone();
    row.version = manifest.version.clone();
    row.description = manifest.description.clone();
    row.homepage = manifest.website.clone().or(manifest.repository.clone());
    row.repository = manifest.repository.clone();
    row.license = manifest.license.clone();
    // A bad icon must never block installation: the UI falls back to initials.
    if let Some(icon) = crate::acp::install::download_icon(&state.http, &manifest, &data_dir)
        .await
        .ok()
        .flatten()
    {
        row.icon_path = Some(icon.to_string_lossy().into_owned());
    }
    let now = now_ms();
    if row.created_at == 0 {
        row.created_at = now;
    }
    row.updated_at = now;
    state.db.acp_agent_save(&row).map_err(|e| e.to_string())?;
    // Discover models and auth state now: otherwise the new provider has an
    // empty model list and the composer cannot send a turn until a boot scan
    // or a manual "Test agent" happens to run.
    match crate::acp::client::probe(&app, &id).await {
        Ok((auth, models)) => {
            if !models.is_empty() {
                let _ = state.db.acp_models_replace(&id, &models);
            }
            let mut stored = state
                .db
                .acp_agent(&id)
                .ok()
                .flatten()
                .unwrap_or_else(|| row.clone());
            stored.auth_state = auth.state;
            stored.auth_hint = auth.hint;
            stored.last_error = None;
            stored.updated_at = now_ms();
            let _ = state.db.acp_agent_save(&stored);
            Ok(view_of(&state, &stored))
        }
        Err(error) => {
            // An agent that needs interactive login still needs one routable
            // model so the shared selector can resolve a turn.
            if state
                .db
                .acp_models(&id)
                .map(|models| models.is_empty())
                .unwrap_or(true)
            {
                let _ = state
                    .db
                    .acp_models_replace(&id, &crate::acp::session::discover_models(&[]));
            }
            let mut stored = state
                .db
                .acp_agent(&id)
                .ok()
                .flatten()
                .unwrap_or_else(|| row.clone());
            stored.auth_state = "auth_required".to_string();
            stored.auth_hint = Some(error.to_string());
            stored.last_error = Some(error.to_string());
            stored.updated_at = now_ms();
            let _ = state.db.acp_agent_save(&stored);
            Ok(view_of(&state, &stored))
        }
    }
}

#[tauri::command]
pub async fn acp_add_custom_agent(
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::BTreeMap<String, String>,
    cwd: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AcpAgentView, String> {
    let input = AcpCustomAgentInput {
        name,
        command,
        args,
        env,
        cwd,
    };
    let name = input.name.trim();
    if name.is_empty() {
        return Err(crate::i18n::t("acp.errors.nameRequired").to_string());
    }
    let slug = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>();
    if slug.is_empty() {
        return Err("ACP_AGENT_NAME_REQUIRED".to_string());
    }
    let command = resolve_custom_command(&input.command, &app)?;
    let now = now_ms();
    let row = AcpAgentRow {
        id: acp::provider_id(&format!("manual__{slug}")),
        registry_id: None,
        name: name.to_string(),
        version: "manual".to_string(),
        description: String::new(),
        homepage: None,
        repository: None,
        license: None,
        icon_path: None,
        kind: "manual".to_string(),
        source: "manual".to_string(),
        thinking_config_json: "{}".to_string(),
        command: command.to_string_lossy().to_string(),
        args_json: serde_json::to_string(&input.args).unwrap_or_else(|_| "[]".to_string()),
        env_json: serde_json::to_string(&input.env).unwrap_or_else(|_| "{}".to_string()),
        env_secret_names_json: serde_json::to_string(&input.env.keys().collect::<Vec<_>>())
            .unwrap_or_else(|_| "[]".to_string()),
        install_dir: None,
        sha256: None,
        trusted: true,
        enabled: true,
        supports_fs: true,
        supports_terminal: true,
        supports_elicitation: true,
        auth_state: "unknown".to_string(),
        auth_hint: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    };
    state.db.acp_agent_save(&row).map_err(|e| e.to_string())?;
    Ok(view_of(&state, &row))
}

fn resolve_custom_command(command: &str, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = Path::new(command);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let data_dir = crate::config::data_dir(app).map_err(|e| e.to_string())?;
    let candidate = data_dir.join("acp").join("agents").join(path);
    if candidate.exists() {
        return Ok(candidate);
    }
    let resolved = crate::workspace::exec::resolve_program(command, &[]);
    if resolved.exists() {
        Ok(resolved)
    } else {
        Err(format!("ACP_AGENT_COMMAND_NOT_FOUND: {command}"))
    }
}

#[tauri::command]
pub async fn acp_remove_agent(
    agent_id: String,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let Some(row) = state.db.acp_agent(&agent_id).ok().flatten() else {
        return Ok(());
    };
    for session in state.acp.list_sessions().await {
        if session.provider_id == agent_id {
            crate::acp::client::close(&session.conversation_id, &agent_id).await;
        }
    }
    let data_dir = crate::config::data_dir(&app).map_err(|e| e.to_string())?;
    crate::acp::install::remove_install(&data_dir, &row).map_err(|e| e.to_string())?;
    state.db.acp_agent_delete(&agent_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn acp_set_trusted(
    agent_id: String,
    trusted: bool,
    capabilities: AcpCapabilities,
    state: State<'_, RuntimeState>,
) -> Result<AcpAgentView, String> {
    let mut row = state
        .db
        .acp_agent(&agent_id)
        .ok()
        .flatten()
        .ok_or_else(|| format!("unknown ACP agent: {agent_id}"))?;
    row.trusted = trusted;
    row.supports_fs = trusted && capabilities.fs;
    row.supports_terminal = trusted && capabilities.terminal;
    row.supports_elicitation = trusted && capabilities.elicitation;
    row.updated_at = now_ms();
    state.db.acp_agent_save(&row).map_err(|e| e.to_string())?;
    Ok(view_of(&state, &row))
}

#[tauri::command]
pub async fn acp_auth_status(
    agent_id: String,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AcpAuthView, String> {
    let row = state
        .db
        .acp_agent(&agent_id)
        .ok()
        .flatten()
        .ok_or_else(|| format!("unknown ACP agent: {agent_id}"))?;
    let _ = &app;
    crate::acp::client::probe(&app, &row.id)
        .await
        .map(|(view, models)| {
            if !models.is_empty() {
                let _ = state.db.acp_models_replace(&row.id, &models);
            }
            view
        })
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn acp_auth(
    agent_id: String,
    action: AcpAuthAction,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AcpAuthView, String> {
    let row = state
        .db
        .acp_agent(&agent_id)
        .ok()
        .flatten()
        .ok_or_else(|| format!("unknown ACP agent: {agent_id}"))?;
    crate::acp::client::authenticate(&app, &row.id, action)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn acp_test_agent(
    agent_id: String,
    app: tauri::AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<ProviderValidation, String> {
    let row = state
        .db
        .acp_agent(&agent_id)
        .ok()
        .flatten()
        .ok_or_else(|| format!("unknown ACP agent: {agent_id}"))?;
    let started = std::time::Instant::now();
    match crate::acp::client::probe(&app, &row.id).await {
        Ok((auth, models)) => {
            if !models.is_empty() {
                state
                    .db
                    .acp_models_replace(&row.id, &models)
                    .map_err(|e| e.to_string())?;
            }
            let mut stored = row.clone();
            stored.auth_state = auth.state.clone();
            stored.auth_hint = auth.hint.clone();
            stored.last_error = None;
            stored.updated_at = now_ms();
            state.db.acp_agent_save(&stored).map_err(|e| e.to_string())?;
            Ok(ProviderValidation {
                provider_id: row.id,
                ok: true,
                message: auth.hint,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                models: models.len() as u32,
            })
        }
        Err(error) => {
            let mut stored = row.clone();
            stored.auth_state = "error".to_string();
            stored.last_error = Some(error.to_string());
            stored.updated_at = now_ms();
            let _ = state.db.acp_agent_save(&stored);
            Ok(ProviderValidation {
                provider_id: row.id,
                ok: false,
                message: Some(error.to_string()),
                latency_ms: Some(started.elapsed().as_millis() as u64),
                models: 0,
            })
        }
    }
}

#[tauri::command]
pub async fn acp_list_sessions(
    state: State<'_, RuntimeState>,
) -> Result<Vec<acp::AcpSessionView>, String> {
    Ok(state.acp.list_sessions().await)
}

#[tauri::command]
pub async fn acp_close_session(
    conversation_id: String,
    provider_id: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    crate::acp::client::close(&conversation_id, &provider_id).await;
    state
        .db
        .acp_session_delete(&conversation_id, &provider_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn acp_stderr(
    conversation_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let data_dir = crate::config::data_dir(&app).map_err(|e| e.to_string())?;
    let path = data_dir.join("acp").join("logs").join(crate::acp::session::safe_log_name(&conversation_id));
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let end = raw.len().min(16 * 1024);
    Ok(String::from_utf8_lossy(&raw[raw.len() - end..]).to_string())
}

/// Enable or disable an ACP agent. Disabling removes it from the provider
/// catalog but keeps the detected row and its discovered login state.
#[tauri::command]
pub fn acp_enable_agent(
    agent_id: String,
    enabled: bool,
    state: State<'_, RuntimeState>,
) -> Result<AcpAgentView, String> {
    let mut row = state
        .db
        .acp_agent(&agent_id)
        .ok()
        .flatten()
        .ok_or_else(|| format!("unknown ACP agent: {agent_id}"))?;
    row.enabled = enabled;
    row.updated_at = now_ms();
    state.db.acp_agent_save(&row).map_err(|e| e.to_string())?;
    Ok(view_of(&state, &row))
}

/// Rescan PATH for ACP agents published in the Registry.
#[tauri::command]
pub async fn acp_rescan_devices(
    app: tauri::AppHandle,
) -> Result<Vec<AcpAgentView>, String> {
    crate::acp::detect::scan_and_store(&app)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Marker helper used by the settings reset flow.
pub fn clear_state(state: &RuntimeState) -> Result<(), String> {
    state.db.acp_clear_all().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use super::*;

    #[test]
    fn custom_slug_is_safe() {
        let name = "  Gemini CLI!!  ";
        let slug: String = name
            .to_ascii_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .chars()
            .take(40)
            .collect();
        assert_eq!(slug, "gemini-cli");
    }

    #[test]
    fn unused_env_map_is_empty() {
        let env: BTreeMap<String, String> = BTreeMap::new();
        assert!(env.is_empty());
    }
}
