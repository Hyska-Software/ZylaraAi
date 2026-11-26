//! ACP (Agent Client Protocol) provider support.
//!
//! This module turns an installed ACP agent into an ordinary catalog provider:
//! `ProviderInfo.transport == Acp` routes the turn through `client::stream`,
//! which speaks JSON-RPC over stdio and emits the same `ProviderEvent`s as the
//! four HTTP adapters. The official ACP Registry is the default install source.

pub mod client;
pub mod detect;
pub mod host;
pub mod install;
pub mod mapping;
pub mod registry;
pub mod session;

#[cfg(test)]
#[path = "tests.rs"]
mod integration;

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::catalog::{ModelInfo, ProviderInfo};

/// Resolve the executable used to launch an ACP agent.
///
/// On Windows, package-manager shims such as `npx` exist both as an
/// extensionless shell script and as `npx.cmd`. `Command::new` cannot execute
/// the extensionless shim, so prefer the native variants for npx/uvx agents.
pub fn launch_program(row: &AcpAgentRow, env: &[(String, String)]) -> std::path::PathBuf {
    #[cfg(windows)]
    if matches!(row.kind.as_str(), "npx" | "uvx") {
        for extension in [".cmd", ".exe", ".bat"] {
            let candidate =
                crate::workspace::exec::resolve_program(&format!("{}{extension}", row.command), env);
            if candidate
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(extension)
                && candidate.is_file()
            {
                return candidate;
            }
        }
    }
    crate::workspace::exec::resolve_program(&row.command, env)
}

pub const ID_PREFIX: &str = "acp__";
const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// A manifest fetched from the official ACP Registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryFile {
    pub version: String,
    #[serde(default)]
    pub agents: Vec<registry::RegistryManifest>,
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called from `AppState::init` so the provider adapter can reach the app's
/// registries without changing the neutral `CompletionRequest` contract.
pub fn init_app_handle(app: &tauri::AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

pub fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub icon_url: Option<String>,
    pub distributions: Vec<String>,
    pub platforms: Vec<String>,
    pub installed: bool,
    /// Exact launch command and arguments shown before install consent.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env_names: Vec<String>,
    #[serde(default)]
    pub update_available: bool,
    pub supported: bool,
    pub install_reason: Option<String>,
    /// Validated monochrome SVG from the Registry cache (inline glyph).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_svg: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentView {
    pub id: String,
    pub registry_id: Option<String>,
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: String,
    #[serde(default = "default_agent_source")]
    pub source: String,
    pub command: String,
    pub args: Vec<String>,
    pub env_names: Vec<String>,
    pub trusted: bool,
    pub enabled: bool,
    pub auth_state: String,
    pub auth_hint: Option<String>,
    pub model_count: u32,
    pub supports_fs: bool,
    pub supports_terminal: bool,
    pub supports_elicitation: bool,
    pub last_error: Option<String>,
    /// Validated monochrome SVG from the Registry, rendered inline by the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_svg: Option<String>,
}

pub fn to_view(row: &AcpAgentRow, model_count: u32) -> AcpAgentView {
    AcpAgentView {
        id: row.id.clone(),
        registry_id: row.registry_id.clone(),
        name: row.name.clone(),
        version: row.version.clone(),
        description: row.description.clone(),
        kind: row.kind.clone(),
        source: row.source.clone(),
        command: row.command.clone(),
        args: row.args(),
        env_names: row.env().keys().cloned().collect(),
        trusted: row.trusted,
        enabled: row.enabled,
        auth_state: row.auth_state.clone(),
        auth_hint: row.auth_hint.clone(),
        model_count,
        supports_fs: row.supports_fs,
        supports_terminal: row.supports_terminal,
        supports_elicitation: row.supports_elicitation,
        last_error: row.last_error.clone(),
        icon_svg: load_icon_svg(row),
    }
}

/// Read a previously validated icon from disk. Failures fall back to initials.
pub fn load_icon_svg(row: &AcpAgentRow) -> Option<String> {
    read_validated_svg(std::path::Path::new(row.icon_path.as_deref()?))
}

/// Registry-list variant: the icon file is keyed by the manifest id even when
/// the agent has not been installed yet.
pub fn load_icon_svg_by_id(data_dir: &std::path::Path, id: &str) -> Option<String> {
    read_validated_svg(&data_dir.join("acp").join("icons").join(format!("{id}.svg")))
}

fn read_validated_svg(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read(path).ok()?;
    if raw.len() > 32 * 1024 {
        return None;
    }
    let svg = String::from_utf8(raw).ok()?;
    let lower = svg.to_ascii_lowercase();
    if !lower.contains("<svg")
        || lower.contains("<script")
        || lower.contains("javascript:")
        || lower.contains("foreignobject")
        || svg.contains('#')
    {
        return None;
    }
    Some(svg)
}

/// Translate an agent-advertised `thought_level` config option into the
/// renderer's reasoning controls. Agents that do not advertise one (e.g.
/// OpenCode) expose no control: Zylara cannot inject reasoning parameters into
/// a request the agent owns internally.
pub fn reasoning_options_for_row(row: &AcpAgentRow) -> Vec<crate::catalog::ReasoningOption> {
    use crate::catalog::ReasoningOption;

    let Ok(config) = serde_json::from_str::<serde_json::Value>(&row.thinking_config_json) else {
        return Vec::new();
    };
    if config.get("type").and_then(serde_json::Value::as_str) == Some("boolean") {
        return vec![ReasoningOption::Toggle];
    }
    let Some(values) = config.get("values").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut efforts: Vec<String> = values
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(|value| match value {
            "off" => "none".to_string(),
            other => other.to_ascii_lowercase(),
        })
        .filter(|value| !value.is_empty())
        .collect();
    const ORDER: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"];
    efforts.sort_by_key(|value| ORDER.iter().position(|known| *known == value).unwrap_or(99));
    efforts.dedup();
    efforts.truncate(12);
    if efforts.is_empty() {
        Vec::new()
    } else {
        vec![ReasoningOption::Effort { values: efforts }]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpInstallRequest {
    pub registry_id: String,
    pub accept_command: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCustomAgentInput {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthMethod {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `agent` (protocol-driven login) or `terminal` (interactive relaunch).
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAuthView {
    pub agent_id: String,
    pub state: String,
    pub methods: Vec<AcpAuthMethod>,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AcpAuthAction {
    Login { method_id: String },
    TerminalLogin { method_id: String },
    Logout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpCapabilities {
    #[serde(default)]
    pub fs: bool,
    #[serde(default)]
    pub terminal: bool,
    #[serde(default)]
    pub elicitation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionView {
    pub conversation_id: String,
    pub provider_id: String,
    pub session_id: String,
    pub protocol_version: i64,
}


fn default_agent_source() -> String {
    "registry".to_string()
}
/// Direct mirror of the `acp_agents` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentRow {
    pub id: String,
    pub registry_id: Option<String>,
    pub name: String,
    pub version: String,
    pub description: String,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    pub icon_path: Option<String>,
    pub kind: String,
    /// registry | manual | detected — where this agent entry came from.
    #[serde(default = "default_agent_source")]
    pub source: String,
    /// Serialized thought_level config option advertised by the agent.
    pub thinking_config_json: String,
    pub command: String,
    pub args_json: String,
    pub env_json: String,
    pub env_secret_names_json: String,
    pub install_dir: Option<String>,
    pub sha256: Option<String>,
    pub trusted: bool,
    pub enabled: bool,
    pub supports_fs: bool,
    pub supports_terminal: bool,
    pub supports_elicitation: bool,
    pub auth_state: String,
    pub auth_hint: Option<String>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AcpAgentRow {
    pub fn args(&self) -> Vec<String> {
        serde_json::from_str(&self.args_json).unwrap_or_default()
    }

    pub fn env(&self) -> BTreeMap<String, String> {
        serde_json::from_str(&self.env_json).unwrap_or_default()
    }
}

/// Persisted session identity. The session id is opaque and belongs to the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionRow {
    pub conversation_id: String,
    pub provider_id: String,
    pub session_id: String,
    pub protocol_version: i64,
    pub cwd: String,
    pub config_state_json: String,
    pub capabilities_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelRow {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub options_json: String,
}

/// Provider metadata carried in the merged catalog. Only ACP providers set it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProviderInfo {
    pub agent_id: String,
    pub registry_id: Option<String>,
    pub version: String,
    pub kind: String,
    pub auth_state: String,
    pub trusted: bool,
    pub installed: bool,
    /// Whether the user activated this agent; disabled detections stay out of
    /// the model selector.
    pub enabled: bool,
}

/// ACP capabilities reported by `initialize`, retained per session so a later
/// reconnect never sends a method the agent did not advertise.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AcpAgentCapabilities {
    pub protocol_version: i64,
    pub load_session: bool,
    pub resume: bool,
    pub close: bool,
    pub image: bool,
    pub embedded_context: bool,
    pub system_prompt: bool,
    pub additional_directories: bool,
    pub terminal_auth: bool,
    pub mcp_http: bool,
    pub auth_methods: Vec<AcpAuthMethod>,
    pub supports_logout: bool,
}

/// Runtime state for one live agent process/session.
#[derive(Debug)]
pub struct LiveSession {
    pub agent_id: String,
    pub conversation_id: String,
    pub provider_id: String,
    pub session_id: String,
    pub protocol_version: i64,
    pub cwd: String,
    pub capabilities: AcpAgentCapabilities,
    pub config_state: BTreeMap<String, serde_json::Value>,
    pub child: Option<tokio::process::Child>,
}

/// Process/session registry shared by commands and the provider adapter.
#[derive(Debug, Default)]
pub struct AcpManager {
    pub(crate) sessions: Mutex<BTreeMap<String, LiveSession>>,
}

impl AcpManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn session_key(conversation_id: &str, provider_id: &str) -> String {
        format!("{conversation_id}\u{1f}{provider_id}")
    }

    pub async fn list_sessions(&self) -> Vec<AcpSessionView> {
        self.sessions
            .lock()
            .await
            .values()
            .map(|session| AcpSessionView {
                conversation_id: session.conversation_id.clone(),
                provider_id: session.provider_id.clone(),
                session_id: session.session_id.clone(),
                protocol_version: session.protocol_version,
            })
            .collect()
    }

}

static MANAGER: OnceLock<Arc<AcpManager>> = OnceLock::new();

/// Process-wide manager, initialised once from `AppState::init`.
pub fn manager() -> Option<&'static Arc<AcpManager>> {
    MANAGER.get()
}

pub fn init_manager() -> Arc<AcpManager> {
    MANAGER
        .get_or_init(|| Arc::new(AcpManager::new()))
        .clone()
}

pub fn provider_id(registry_id: &str) -> String {
    format!("{ID_PREFIX}{registry_id}")
}

pub fn is_acp_id(provider_id: &str) -> bool {
    provider_id.starts_with(ID_PREFIX)
}

/// Build a `ProviderInfo` from a stored agent row plus its discovered models.
pub fn to_provider(row: &AcpAgentRow, models: Vec<ModelInfo>) -> ProviderInfo {
    ProviderInfo {
        id: row.id.clone(),
        name: row.name.clone(),
        short_name: row.name.chars().take(18).collect(),
        description: row.description.clone(),
        base_url: String::new(),
        console_url: row.homepage.clone().unwrap_or_default(),
        endpoints: Default::default(),
        headers: Default::default(),
        auth_env: String::new(),
        auth_header: "authorization".to_string(),
        auth_prefix: "Bearer ".to_string(),
        default_model_id: models.first().map(|m| m.id.clone()).unwrap_or_default(),
        auth: crate::catalog::ProviderAuth::Acp,
        request_profiles: Default::default(),
        oauth: None,
        models,
        notes: Vec::new(),
        cache: None,
        icon: row.icon_path.clone(),
        category: None,
        origin: Some("acp".to_string()),
        origin_label: Some(row.name.clone()),
        transport: crate::catalog::ProviderTransport::Acp,
        acp: Some(AcpProviderInfo {
            agent_id: row.id.clone(),
            registry_id: row.registry_id.clone(),
            version: row.version.clone(),
            kind: row.kind.clone(),
            auth_state: row.auth_state.clone(),
            trusted: row.trusted,
            installed: true,
            enabled: row.enabled,
        }),
        icon_svg: load_icon_svg(row),
    }
}

pub fn registry_url() -> &'static str {
    REGISTRY_URL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaces_are_disjoint() {
        assert!(is_acp_id("acp__gemini-cli"));
        assert!(!is_acp_id("custom__gemini-cli"));
        assert!(!is_acp_id("opencode-go"));
        assert_eq!(provider_id("gemini-cli"), "acp__gemini-cli");
    }

    #[test]
    fn row_helpers_tolerate_bad_json() {
        let row = AcpAgentRow {
            id: "acp__x".into(),
            registry_id: None,
            name: "X".into(),
            version: "1.0.0".into(),
            description: String::new(),
            homepage: None,
            repository: None,
            license: None,
            icon_path: None,
            kind: "manual".into(),
            source: "manual".into(),
            thinking_config_json: "{}".into(),
            command: "x".into(),
            args_json: "not-json".into(),
            env_json: "not-json".into(),
            env_secret_names_json: "[]".into(),
            install_dir: None,
            sha256: None,
            trusted: false,
            enabled: true,
            supports_fs: false,
            supports_terminal: false,
            supports_elicitation: false,
            auth_state: "unknown".into(),
            auth_hint: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        assert!(row.args().is_empty());
        assert!(row.env().is_empty());
    }

    #[test]
    fn package_agents_prefer_native_shims_on_windows() {
        let mut row = AcpAgentRow {
            id: "acp__npx".into(),
            registry_id: Some("npx".into()),
            name: "Npx".into(),
            version: "1.0.0".into(),
            description: String::new(),
            homepage: None,
            repository: None,
            license: None,
            icon_path: None,
            kind: "npx".into(),
            source: "registry".into(),
            thinking_config_json: "{}".into(),
            command: "npx".into(),
            args_json: "[]".into(),
            env_json: "{}".into(),
            env_secret_names_json: "[]".into(),
            install_dir: None,
            sha256: None,
            trusted: false,
            enabled: true,
            supports_fs: false,
            supports_terminal: false,
            supports_elicitation: false,
            auth_state: "unknown".into(),
            auth_hint: None,
            last_error: None,
            created_at: 0,
            updated_at: 0,
        };
        let env = crate::workspace::exec::sanitized_env(&[]);
        let program = launch_program(&row, &env);
        #[cfg(windows)]
        {
            let lower = program.to_string_lossy().to_ascii_lowercase();
            assert!(
                lower.ends_with(".cmd") || lower.ends_with(".exe") || lower.ends_with(".bat"),
                "Windows must launch a native shim, got {lower}"
            );
        }
        row.kind = "manual".into();
        let _ = launch_program(&row, &env);
    }
}
