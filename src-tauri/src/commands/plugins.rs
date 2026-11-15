//! Tauri command surface for the plugin platform (`docs/PLUGINS.md`).

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::plugins::{
    InstallOptions, PluginLocaleBundle, PluginManager, PluginPackageInspection, PluginRecord,
    PluginSnapshot, PluginStoreView, PluginToolResult, PluginUpdateInfo,
};
use crate::state::AppState;

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

fn manager<'a>(state: &'a State<'_, AppState>) -> &'a PluginManager {
    &state.plugins
}

fn active_turn_error(operation: &str) -> String {
    format!(
        "PLUGIN_TURN_ACTIVE: finish or cancel active turns before {operation}"
    )
}

#[tauri::command]
pub fn list_plugins(state: State<'_, AppState>) -> PluginSnapshot {
    manager(&state).snapshot()
}

#[tauri::command]
pub fn inspect_plugin_package(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginPackageInspection, String> {
    manager(&state)
        .inspect(std::path::Path::new(&path))
        .map_err(to_error)
}

#[tauri::command]
pub fn inspect_plugin_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<PluginPackageInspection, String> {
    manager(&state)
        .inspect_dev_folder(std::path::Path::new(&path))
        .map_err(to_error)
}

#[tauri::command]
pub async fn inspect_plugin_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<PluginPackageInspection, String> {
    let parsed = url::Url::parse(&url).map_err(to_error)?;
    if parsed.scheme() != "https" {
        return Err("PLUGIN_PACKAGE_URL: package URL must use https".to_string());
    }
    let mut response = state
        .http
        .get(parsed)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(to_error)?;
    if !response.status().is_success() {
        return Err(format!("PLUGIN_PACKAGE_HTTP: status {}", response.status()));
    }
    let limit = crate::plugins::contract::limits().trusted_package_bytes as usize;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(to_error)? {
        if bytes.len() + chunk.len() > limit {
            return Err("PLUGIN_PACKAGE_TOO_LARGE: package exceeds the limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    manager(&state).inspect_bytes(&bytes).map_err(to_error)
}

#[tauri::command]
pub fn install_plugin(
    state: State<'_, AppState>,
    path: String,
    granted_permissions: Option<Vec<String>>,
    allow_unsigned: Option<bool>,
    allow_key_rotation: Option<bool>,
) -> Result<PluginRecord, String> {
    let path = std::path::Path::new(&path);
    let existing = manager(&state)
        .inspect(path)
        .ok()
        .map(|inspection| inspection.manifest.id)
        .and_then(|id| manager(&state).record(&id))
        .is_some();
    if existing && !state.active_turns().is_empty() {
        return Err(active_turn_error("updating a plugin"));
    }
    manager(&state)
        .install_with_rotation(
            path,
            InstallOptions {
                source: "file".to_string(),
                allow_unsigned: allow_unsigned.unwrap_or(false),
                granted_permissions,
            },
            allow_key_rotation.unwrap_or(false),
        )
        .map_err(to_error)
}

#[tauri::command]
pub fn install_plugin_folder(
    state: State<'_, AppState>,
    path: String,
    granted_permissions: Option<Vec<String>>,
) -> Result<PluginRecord, String> {
    manager(&state)
        .install_dev_folder(std::path::Path::new(&path), granted_permissions)
        .map_err(to_error)
}

#[tauri::command]
pub async fn install_plugin_url(
    state: State<'_, AppState>,
    url: String,
    granted_permissions: Option<Vec<String>>,
    allow_unsigned: Option<bool>,
    allow_key_rotation: Option<bool>,
) -> Result<PluginRecord, String> {
    let parsed = url::Url::parse(&url).map_err(to_error)?;
    if parsed.scheme() != "https" {
        return Err("PLUGIN_PACKAGE_URL: package URL must use https".to_string());
    }
    let mut response = state
        .http
        .get(parsed)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(to_error)?;
    if !response.status().is_success() {
        return Err(format!("PLUGIN_PACKAGE_HTTP: status {}", response.status()));
    }
    let limit = crate::plugins::contract::limits().trusted_package_bytes as usize;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(to_error)? {
        if bytes.len() + chunk.len() > limit {
            return Err("PLUGIN_PACKAGE_TOO_LARGE: package exceeds the limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Ok(inspection) = manager(&state).inspect_bytes(&bytes) {
        if manager(&state).record(&inspection.manifest.id).is_some()
            && !state.active_turns().is_empty()
        {
            return Err(active_turn_error("updating a plugin"));
        }
    }
    manager(&state)
        .install_bytes_with_rotation(
            &bytes,
            InstallOptions {
                source: "url".to_string(),
                allow_unsigned: allow_unsigned.unwrap_or(false),
                granted_permissions,
            },
            allow_key_rotation.unwrap_or(false),
        )
        .map_err(to_error)
}

#[tauri::command]
pub fn uninstall_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
    keep_data: Option<bool>,
) -> Result<(), String> {
    if !state.active_turns().is_empty() {
        return Err(active_turn_error("uninstalling a plugin"));
    }
    manager(&state)
        .uninstall(&plugin_id, keep_data.unwrap_or(false))
        .map_err(to_error)
}

#[tauri::command]
pub fn set_plugin_enabled(
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginRecord, String> {
    manager(&state)
        .set_enabled(&plugin_id, enabled)
        .map_err(to_error)
}

#[tauri::command]
pub fn set_plugin_permissions(
    state: State<'_, AppState>,
    plugin_id: String,
    permissions: Vec<String>,
) -> Result<PluginRecord, String> {
    manager(&state)
        .set_permissions(&plugin_id, permissions)
        .map_err(to_error)
}

#[tauri::command]
pub async fn plugin_rpc(
    state: State<'_, AppState>,
    plugin_id: String,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    manager(&state)
        .rpc(&plugin_id, &method, params.unwrap_or(serde_json::json!({})))
        .await
        .map_err(to_error)
}

#[tauri::command]
pub fn plugin_call_result(
    state: State<'_, AppState>,
    result: PluginToolResult,
) -> Result<(), String> {
    manager(&state).complete_tool_call(result).map_err(to_error)
}

#[tauri::command]
pub fn list_plugin_logs(
    state: State<'_, AppState>,
    plugin_id: Option<String>,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<Vec<crate::plugins::PluginLogRow>, String> {
    manager(&state)
        .list_logs(plugin_id.as_deref(), limit.unwrap_or(100), before_id)
        .map_err(to_error)
}

#[tauri::command]
pub fn list_plugin_audit(
    state: State<'_, AppState>,
    plugin_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<crate::plugins::PluginAuditRow>, String> {
    manager(&state)
        .list_audit(plugin_id.as_deref(), limit.unwrap_or(100))
        .map_err(to_error)
}

#[tauri::command]
pub fn list_plugin_tool_calls(
    state: State<'_, AppState>,
    plugin_id: String,
    limit: Option<u32>,
) -> Result<Vec<crate::plugins::PluginToolCallRow>, String> {
    manager(&state)
        .list_tool_calls(&plugin_id, limit.unwrap_or(100))
        .map_err(to_error)
}

#[tauri::command]
pub fn open_plugin_dir(app: AppHandle, state: State<'_, AppState>, plugin_id: String) -> Result<(), String> {
    let root = manager(&state).plugin_root(&plugin_id).map_err(to_error)?;
    if !root.is_dir() {
        return Err("PLUGIN_FILES_MISSING: plugin folder does not exist".to_string());
    }
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(to_error)
}

#[tauri::command]
pub fn open_plugins_dir(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let root = manager(&state).plugins_dir();
    std::fs::create_dir_all(&root).map_err(to_error)?;
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(to_error)
}

#[tauri::command]
pub fn plugin_dev_reload(
    state: State<'_, AppState>,
    plugin_id: Option<String>,
) -> Result<(), String> {
    manager(&state)
        .dev_reload(plugin_id.as_deref())
        .map_err(to_error)
}

#[tauri::command]
pub fn plugin_runtime_ready(state: State<'_, AppState>) -> Result<(), String> {
    manager(&state).mark_boot_complete().map_err(to_error)
}

#[tauri::command]
pub fn plugin_leave_safe_mode(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let settings = crate::config::load_settings(&app);
    manager(&state)
        .recover_from_safe_mode(&settings)
        .map_err(to_error)
}

#[tauri::command]
pub fn take_plugin_deep_link() -> Option<String> {
    crate::plugins::take_pending_deep_link()
}

#[tauri::command]
pub fn get_plugin_locales(state: State<'_, AppState>) -> PluginLocaleBundle {
    manager(&state).locale_bundle()
}

#[tauri::command]
pub fn get_plugin_themes(
    state: State<'_, AppState>,
) -> Vec<serde_json::Value> {
    manager(&state)
        .theme_contributions()
        .into_iter()
        .map(|(plugin_id, theme)| serde_json::json!({ "pluginId": plugin_id, "theme": theme }))
        .collect()
}

#[tauri::command]
pub fn plugin_asset_text(
    state: State<'_, AppState>,
    plugin_id: String,
    path: String,
) -> Result<String, String> {
    let path = manager(&state)
        .asset_path(&plugin_id, &path)
        .ok_or_else(|| "PLUGIN_ASSET_NOT_FOUND: asset is unavailable".to_string())?;
    let metadata = std::fs::metadata(&path).map_err(to_error)?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("PLUGIN_ASSET_TOO_LARGE: asset exceeds 10 MiB".to_string());
    }
    std::fs::read_to_string(&path).map_err(to_error)
}

#[tauri::command]
pub async fn store_refresh(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    force: Option<bool>,
) -> Result<PluginStoreView, String> {
    let settings = crate::config::load_settings(&app);
    let url = url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(settings.plugin_registry_url);
    manager(&state)
        .store_view(&url, force.unwrap_or(false))
        .await
        .map_err(to_error)
}

#[tauri::command]
pub async fn check_plugin_updates(
    app: AppHandle,
    state: State<'_, AppState>,
    url: Option<String>,
    force: Option<bool>,
) -> Result<Vec<PluginUpdateInfo>, String> {
    let settings = crate::config::load_settings(&app);
    let url = url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(settings.plugin_registry_url);
    manager(&state)
        .check_updates(&url, force.unwrap_or(false))
        .await
        .map_err(to_error)
}

#[tauri::command]
pub async fn update_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    url: Option<String>,
    granted_permissions: Option<Vec<String>>,
    allow_key_rotation: Option<bool>,
) -> Result<PluginRecord, String> {
    if !state.active_turns().is_empty() {
        return Err(active_turn_error("updating a plugin"));
    }
    let settings = crate::config::load_settings(&app);
    let url = url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(settings.plugin_registry_url);
    manager(&state)
        .update_from_registry_with_rotation(
            &url,
            &plugin_id,
            granted_permissions,
            allow_key_rotation.unwrap_or(false),
        )
        .await
        .map_err(to_error)
}

#[tauri::command]
pub async fn install_plugin_store(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    url: Option<String>,
    granted_permissions: Option<Vec<String>>,
    allow_key_rotation: Option<bool>,
) -> Result<PluginRecord, String> {
    let settings = crate::config::load_settings(&app);
    let url = url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(settings.plugin_registry_url);
    if manager(&state).record(&plugin_id).is_some() && !state.active_turns().is_empty() {
        return Err(active_turn_error("updating a plugin"));
    }
    manager(&state)
        .install_from_registry_with_rotation(
            &url,
            &plugin_id,
            granted_permissions,
            allow_key_rotation.unwrap_or(false),
        )
        .await
        .map_err(to_error)
}

#[tauri::command]
pub fn rollback_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginRecord, String> {
    if !state.active_turns().is_empty() {
        return Err(active_turn_error("rolling back a plugin"));
    }
    manager(&state).rollback(&plugin_id).map_err(to_error)
}

#[tauri::command]
pub fn set_plugin_auto_update(
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    manager(&state)
        .set_auto_update(&plugin_id, enabled)
        .map_err(to_error)
}

#[tauri::command]
pub fn set_plugin_secret(
    app: AppHandle,
    plugin_id: String,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    crate::config::set_plugin_secret(&app, &plugin_id, &key, value.as_deref())
        .map_err(to_error)
}

#[tauri::command]
pub fn list_plugin_secrets(app: AppHandle, plugin_id: String) -> Vec<String> {
    crate::config::plugin_secret_names(&app, &plugin_id)
}
