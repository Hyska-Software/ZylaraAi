//! Plugin manifest (`manifest.json`) parsing and validation.
//!
//! Validation is deliberately strict and happens before anything is extracted
//! or registered. Errors name the field and the offending value so the store UI
//! and the installer can explain a refusal without guessing.

use std::collections::{BTreeMap, HashSet};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::contract;

pub const MAX_MANIFEST_BYTES: usize = 512 * 1024;
pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_DESCRIPTION_CHARS: usize = 4_000;
pub const MAX_TOOLS: usize = 64;
pub const MAX_VIEWS: usize = 32;
pub const MAX_SLOTS: usize = 64;
pub const MAX_COMMANDS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Package-relative image used by the store and the installed list.
    #[serde(default)]
    pub icon: Option<String>,
    pub api_version: u32,
    #[serde(default)]
    pub engines: PluginEngines,
    pub publisher: PluginPublisher,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: PluginContributions,
    #[serde(default)]
    pub runtime: PluginRuntime,
    /// Redundant with `runtime.ui = "trusted"`; both must agree.
    #[serde(default)]
    pub trusted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginEngines {
    /// Semver range accepted by the plugin (`>=0.11.0 <1.0.0`). `*`/empty means
    /// any app version.
    pub zylara: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPublisher {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default)]
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginRuntime {
    /// `none` | `declarative` | `sandbox` | `trusted`
    pub ui: String,
    /// JavaScript module evaluated by the trusted loader.
    pub entry: Option<String>,
    pub backend: Option<PluginBackend>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBackend {
    /// `js` is the only v1 backend; native sidecars stay trusted-only.
    pub kind: String,
    pub entry: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginContributions {
    pub ui: PluginUiContributions,
    pub tools: Option<ToolSource>,
    pub prompt_sections: Vec<PromptSection>,
    pub skills: Vec<String>,
    pub locales: Vec<String>,
    pub providers: Vec<ProviderContribution>,
    pub artifact_viewers: Vec<ArtifactViewerContribution>,
}

/// `tools` may be an inline array or the package-relative path to a JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolSource {
    File(String),
    Inline(Vec<ToolContribution>),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginUiContributions {
    pub slots: Vec<SlotContribution>,
    pub views: Vec<ViewContribution>,
    pub panels: Vec<PanelContribution>,
    pub commands: Vec<CommandContribution>,
    pub settings_tabs: Vec<SettingsTabContribution>,
    pub themes: Vec<ThemeContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotContribution {
    pub slot: String,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub title_key: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub action: Option<PluginAction>,
    /// Declarative slots render a host button; defaults to true when there is
    /// no entry.
    #[serde(default)]
    pub declarative: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub title_key: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub description_key: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// `chat` | `code` | `agent` | `global`
    #[serde(default = "default_surface")]
    pub surface: String,
    /// `main` | `sidebar`
    #[serde(default = "default_location")]
    pub location: String,
    #[serde(default)]
    pub entry: Option<String>,
    /// Trusted component export registered by `main.js`.
    #[serde(default)]
    pub component: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub title_key: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    /// `right` is the only supported dock in v1.
    #[serde(default = "default_right")]
    pub dock: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub title_key: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub description_key: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub keywords: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// Optional global shortcut (`mod+shift+n`, `alt+1`). Requires `hotkeys`.
    #[serde(default)]
    pub hotkey: Option<String>,
    pub action: PluginAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PluginAction {
    OpenView {
        target: String,
    },
    OpenPanel {
        target: String,
    },
    InsertDraft {
        text: String,
    },
    OpenExternal {
        url: String,
    },
    Execute {
        method: String,
        #[serde(default)]
        params: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTabContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub title_key: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeContribution {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub light: BTreeMap<String, String>,
    #[serde(default)]
    pub dark: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSection {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolContribution {
    pub name: String,
    pub description: String,
    #[serde(default = "default_tool_schema")]
    pub parameters: Value,
    /// `read` | `network` | `write` | `shell`
    #[serde(default = "default_tool_risk")]
    pub risk: String,
    /// Profiles the tool is visible in (`chat`, `code`).
    #[serde(default = "default_tool_profiles")]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

fn default_tool_schema() -> Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

fn default_tool_risk() -> String {
    "read".to_string()
}

fn default_tool_profiles() -> Vec<String> {
    vec!["chat".to_string(), "code".to_string()]
}

fn default_surface() -> String {
    "chat".to_string()
}

fn default_location() -> String {
    "main".to_string()
}

fn default_right() -> String {
    "right".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactViewerContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub title_key: Option<String>,
    pub mime_types: Vec<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default = "default_priority")]
    pub priority: u32,
}

fn default_priority() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderContribution {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub description: String,
    pub base_url: String,
    #[serde(default)]
    pub console_url: String,
    #[serde(default)]
    pub endpoints: BTreeMap<String, String>,
    pub models: Vec<ProviderModelContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelContribution {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub protocols: Vec<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output: Option<u64>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub attachment: bool,
}

impl PluginManifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            bail!(
                "manifest.json exceeds {} bytes (got {})",
                MAX_MANIFEST_BYTES,
                bytes.len()
            );
        }
        let manifest: Self =
            serde_json::from_slice(bytes).map_err(|error| anyhow::anyhow!("manifest.json: {error}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != contract::contract().manifest_schema_version {
            bail!(
                "schemaVersion {} is not supported (expected {})",
                self.schema_version,
                contract::contract().manifest_schema_version
            );
        }
        if self.api_version != contract::contract().api_version {
            bail!(
                "apiVersion {} is not supported (expected {})",
                self.api_version,
                contract::contract().api_version
            );
        }
        validate_plugin_id(&self.id)?;
        validate_publisher_id(&self.publisher.id)?;
        if self.name.trim().is_empty() || self.name.chars().count() > MAX_NAME_CHARS {
            bail!("name must have 1..={MAX_NAME_CHARS} characters");
        }
        if self.description.chars().count() > MAX_DESCRIPTION_CHARS {
            bail!("description exceeds {MAX_DESCRIPTION_CHARS} characters");
        }
        parse_semver(&self.version)
            .map_err(|error| anyhow::anyhow!("version `{}`: {error}", self.version))?;
        if !self.engines.zylara.trim().is_empty() && self.engines.zylara != "*" {
            validate_engine_range(&self.engines.zylara)
                .map_err(|error| anyhow::anyhow!("engines.zylara `{}`: {error}", self.engines.zylara))?;
        }
        if self.publisher.key_id.chars().count() > 120 {
            bail!("publisher.keyId exceeds 120 characters");
        }

        let trusted_ui = self.runtime.ui == "trusted";
        if self.trusted != trusted_ui {
            bail!(
                "trusted={} conflicts with runtime.ui `{}`",
                self.trusted,
                self.runtime.ui
            );
        }
        if !matches!(
            self.runtime.ui.as_str(),
            "none" | "declarative" | "sandbox" | "trusted"
        ) {
            bail!("runtime.ui `{}` is not supported", self.runtime.ui);
        }
        if trusted_ui {
            if !self.has_permission("unsafe.renderer") {
                bail!("trusted plugins must declare the `unsafe.renderer` permission");
            }
            let entry = self
                .runtime
                .entry
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("runtime.entry is required for trusted plugins"))?;
            validate_relative_path(entry)?;
        }
        if let Some(backend) = &self.runtime.backend {
            if backend.kind != "js" {
                bail!("runtime.backend.kind `{}` is not supported", backend.kind);
            }
            validate_relative_path(&backend.entry)?;
        }

        let mut seen = HashSet::new();
        for permission in &self.permissions {
            if !seen.insert(permission.as_str()) {
                bail!("duplicate permission `{permission}`");
            }
            if !contract::permission_known(permission) {
                bail!("unknown permission `{permission}`");
            }
            if contract::permission_scoped(contract::permission_base(permission))
                && permission == contract::permission_base(permission)
            {
                bail!("scoped permission `{permission}` requires a scope (`{permission}:...`)");
            }
        }

        for slot in &self.contributes.ui.slots {
            let spec = contract::slot_spec(&slot.slot)
                .ok_or_else(|| anyhow::anyhow!("unknown slot `{}`", slot.slot))?;
            let mode = if trusted_ui {
                "trusted"
            } else if self.runtime.ui == "sandbox" {
                "sandbox"
            } else {
                "declarative"
            };
            if !spec.modes.iter().any(|allowed| allowed == mode) {
                bail!("slot `{}` does not accept `{mode}` contributions", slot.slot);
            }
            if !self.has_permission(&format!("ui.slot:{}", slot.slot)) {
                bail!(
                    "slot `{}` requires permission `ui.slot:{}`",
                    slot.slot,
                    slot.slot
                );
            }
            if slot.entry.is_none() && slot.action.is_none() {
                bail!("slot `{}` needs `entry` or `action`", slot.slot);
            }
            if let Some(entry) = &slot.entry {
                validate_relative_path(entry)?;
            }
        }
        if self.contributes.ui.slots.len() > MAX_SLOTS {
            bail!("too many slot contributions");
        }
        if !self.contributes.ui.views.is_empty() && !self.has_permission("ui.view") {
            bail!("ui.views requires the `ui.view` permission");
        }
        if self.contributes.ui.views.len() > MAX_VIEWS {
            bail!("too many view contributions");
        }
        let mut view_ids = HashSet::new();
        for view in &self.contributes.ui.views {
            validate_contribution_id(&view.id, "view")?;
            if !view_ids.insert(view.id.as_str()) {
                bail!("duplicate view id `{}`", view.id);
            }
            if !matches!(view.surface.as_str(), "chat" | "code" | "agent" | "global") {
                bail!("view `{}` has an invalid surface", view.id);
            }
            if !matches!(view.location.as_str(), "main" | "sidebar") {
                bail!("view `{}` has an invalid location", view.id);
            }
            if let Some(entry) = &view.entry {
                validate_relative_path(entry)?;
            }
            if view.entry.is_none() && view.component.is_none() {
                bail!("view `{}` needs `entry` or `component`", view.id);
            }
        }
        if !self.contributes.ui.panels.is_empty() && !self.has_permission("ui.panel") {
            bail!("ui.panels requires the `ui.panel` permission");
        }
        for panel in &self.contributes.ui.panels {
            validate_contribution_id(&panel.id, "panel")?;
            if panel.dock != "right" {
                bail!("panel `{}` has unsupported dock `{}`", panel.id, panel.dock);
            }
            if let Some(entry) = &panel.entry {
                validate_relative_path(entry)?;
            }
            if panel.entry.is_none() && panel.component.is_none() {
                bail!("panel `{}` needs `entry` or `component`", panel.id);
            }
        }
        if !self.contributes.ui.commands.is_empty() && !self.has_permission("ui.command") {
            bail!("ui.commands requires the `ui.command` permission");
        }
        if self.contributes.ui.commands.len() > MAX_COMMANDS {
            bail!("too many command contributions");
        }
        let mut command_ids = HashSet::new();
        for command in &self.contributes.ui.commands {
            validate_contribution_id(&command.id, "command")?;
            if !command_ids.insert(command.id.as_str()) {
                bail!("duplicate command id `{}`", command.id);
            }
            validate_action(&command.action)?;
            if let Some(hotkey) = &command.hotkey {
                if !self.has_permission("hotkeys") {
                    bail!("command `{}` declares a hotkey without the `hotkeys` permission", command.id);
                }
                validate_hotkey(hotkey).with_context(|| {
                    format!("command `{}` hotkey `{hotkey}`", command.id)
                })?;
            }
        }
        if !self.contributes.ui.settings_tabs.is_empty() && !self.has_permission("ui.settings") {
            bail!("ui.settingsTabs requires the `ui.settings` permission");
        }
        for tab in &self.contributes.ui.settings_tabs {
            validate_contribution_id(&tab.id, "settings tab")?;
            if let Some(entry) = &tab.entry {
                validate_relative_path(entry)?;
            }
            if tab.entry.is_none() && tab.component.is_none() {
                bail!("settings tab `{}` needs `entry` or `component`", tab.id);
            }
        }
        if !self.contributes.ui.themes.is_empty() && !self.has_permission("ui.theme") {
            bail!("ui.themes requires the `ui.theme` permission");
        }
        for theme in &self.contributes.ui.themes {
            validate_contribution_id(&theme.id, "theme")?;
            if theme.name.trim().is_empty() {
                bail!("theme `{}` needs a name", theme.id);
            }
            for (key, value) in theme.light.iter().chain(theme.dark.iter()) {
                if !key.starts_with("--") || key.chars().count() > 80 {
                    bail!("theme `{}` has invalid token `{key}`", theme.id);
                }
                if value.chars().count() > 300 || value.contains([';', '{', '}']) {
                    bail!("theme `{}` has invalid value for `{key}`", theme.id);
                }
            }
        }
        if self.contributes.tools.is_some() && !self.has_permission("agent.tools") {
            bail!("tools require the `agent.tools` permission");
        }
        if !self.contributes.prompt_sections.is_empty() && !self.has_permission("agent.prompt") {
            bail!("promptSections require the `agent.prompt` permission");
        }
        if !self.contributes.skills.is_empty() && !self.has_permission("agent.skills") {
            bail!("skills require the `agent.skills` permission");
        }
        for section in &self.contributes.prompt_sections {
            validate_relative_path(&section.file)?;
        }
        for skill in &self.contributes.skills {
            validate_relative_path(skill)?;
        }
        for locale in &self.contributes.locales {
            validate_relative_path(locale)?;
        }
        if !self.contributes.providers.is_empty() && !self.has_permission("providers") {
            bail!("providers require the `providers` permission");
        }
        for provider in &self.contributes.providers {
            validate_contribution_id(&provider.id, "provider")?;
            if !provider.base_url.starts_with("https://") {
                bail!("provider `{}` baseUrl must use https", provider.id);
            }
            if provider.models.is_empty() {
                bail!("provider `{}` needs at least one model", provider.id);
            }
            for model in &provider.models {
                if model.id.trim().is_empty() || model.name.trim().is_empty() {
                    bail!("provider `{}` has an empty model id/name", provider.id);
                }
                if model
                    .protocols
                    .iter()
                    .any(|protocol| protocol != "openai-chat")
                {
                    bail!(
                        "provider `{}` model `{}` uses an unsupported protocol; only openai-chat is declarative in v1",
                        provider.id,
                        model.id
                    );
                }
            }
        }
        if !self.contributes.artifact_viewers.is_empty() && !self.has_permission("ui.artifact") {
            bail!("artifactViewers require the `ui.artifact` permission");
        }
        for viewer in &self.contributes.artifact_viewers {
            validate_contribution_id(&viewer.id, "artifact viewer")?;
            if viewer.mime_types.is_empty() {
                bail!("artifact viewer `{}` needs mimeTypes", viewer.id);
            }
            for mime in &viewer.mime_types {
                if !mime.contains('/') || mime.chars().any(char::is_whitespace) {
                    bail!("artifact viewer `{}` has invalid MIME `{mime}`", viewer.id);
                }
            }
            if let Some(entry) = &viewer.entry {
                validate_relative_path(entry)?;
            }
            if viewer.entry.is_none() && viewer.component.is_none() {
                bail!("artifact viewer `{}` needs `entry` or `component`", viewer.id);
            }
        }

        if let Some(icon) = &self.icon {
            validate_relative_path(icon)?;
        }
        Ok(())
    }

    pub fn permission_granted(&self, grants: &[String], required: &str) -> bool {
        grants
            .iter()
            .any(|granted| contract::permission_matches(granted, required))
    }

    pub fn has_permission(&self, required: &str) -> bool {
        self.permission_granted(&self.permissions, required)
    }

    pub fn is_trusted(&self) -> bool {
        self.trusted && self.runtime.ui == "trusted"
    }

    pub fn is_sandboxed(&self) -> bool {
        self.runtime.ui == "sandbox"
    }

    /// Version of the app used for engine checks (the running binary).
    pub fn supports_current_app(&self) -> bool {
        let range = self.engines.zylara.trim();
        if range.is_empty() || range == "*" {
            return true;
        }
        engine_matches(range, env!("CARGO_PKG_VERSION"))
    }
}

fn validate_hotkey(hotkey: &str) -> Result<()> {
    let hotkey = hotkey.trim();
    if hotkey.is_empty() || hotkey.chars().count() > 64 {
        bail!("hotkey must have 1..=64 characters");
    }
    let parts: Vec<&str> = hotkey.split('+').map(str::trim).collect();
    if parts.len() < 2 {
        bail!("hotkey needs at least one modifier and one key");
    }
    for modifier in &parts[..parts.len() - 1] {
        if !matches!(
            modifier.to_ascii_lowercase().as_str(),
            "mod" | "ctrl" | "control" | "alt" | "shift" | "meta" | "cmd"
        ) {
            bail!("unknown hotkey modifier `{modifier}`");
        }
    }
    let key = parts[parts.len() - 1].to_ascii_lowercase();
    if key.is_empty()
        || key.chars().count() > 16
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, 'f' | 'F'))
    {
        bail!("unsupported hotkey key `{key}`");
    }
    Ok(())
}

fn validate_action(action: &PluginAction) -> Result<()> {
    match action {
        PluginAction::OpenView { target } | PluginAction::OpenPanel { target } => {
            validate_contribution_id(target, "action target")?;
        }
        PluginAction::InsertDraft { text } => {
            if text.chars().count() > 20_000 {
                bail!("action text exceeds 20000 characters");
            }
        }
        PluginAction::OpenExternal { url } => {
            let parsed = url::Url::parse(url)
                .map_err(|_| anyhow::anyhow!("action url `{url}` is invalid"))?;
            if !matches!(parsed.scheme(), "https" | "http") {
                bail!("action url `{url}` must use http(s)");
            }
        }
        PluginAction::Execute { method, params } => {
            if method.trim().is_empty() || method.chars().count() > 120 {
                bail!("action method must have 1..=120 characters");
            }
            if let Some(params) = params {
                if serde_json::to_vec(params).map(|bytes| bytes.len()).unwrap_or(0) > 64 * 1024 {
                    bail!("action params exceed 64 KiB");
                }
            }
        }
    }
    Ok(())
}

pub fn validate_plugin_id(id: &str) -> Result<()> {
    if id.chars().count() > 128 {
        bail!("plugin id is longer than 128 characters");
    }
    if id.split(['.', '-']).count() < 2 {
        bail!("plugin id `{id}` must have at least two segments (reverse-domain or publisher.name)");
    }
    if !id
        .chars()
        .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '-' | '_'))
    {
        bail!("plugin id `{id}` must be lowercase ASCII (letters, digits, `.`, `-`, `_`)");
    }
    if id.starts_with(['.', '-', '_']) || id.ends_with(['.', '-', '_']) || id.contains("..") {
        bail!("plugin id `{id}` has an invalid separator");
    }
    let reserved = [
        "zylara",
        "core",
        "app",
        "system",
        "builtin",
        "official",
        "tauri",
        "com.zylara",
        "app.zylara",
    ];
    if reserved
        .iter()
        .any(|prefix| id == *prefix || id.starts_with(&format!("{prefix}.")))
    {
        bail!("plugin id `{id}` uses a reserved namespace");
    }
    Ok(())
}

fn validate_publisher_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.chars().count() > 64
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        bail!("publisher.id `{id}` is invalid");
    }
    Ok(())
}

pub fn validate_contribution_id(id: &str, what: &str) -> Result<()> {
    if id.is_empty()
        || id.chars().count() > 80
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
        || id.starts_with(['.', '-', '_'])
        || id.ends_with(['.', '-', '_'])
    {
        bail!("{what} id `{id}` is invalid");
    }
    Ok(())
}

/// Validates a package-relative, cross-platform-safe path.
pub fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty() || path.chars().count() > 240 {
        bail!("path `{path}` must have 1..=240 characters");
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\0') {
        bail!("path `{path}` must be relative");
    }
    if path.contains('\\') {
        bail!("path `{path}` must use `/` separators");
    }
    if path.contains(':') {
        bail!("path `{path}` must not contain a drive or alternate stream");
    }
    let mut saw_component = false;
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            bail!("path `{path}` contains an invalid component");
        }
        if component.ends_with(['.', ' ']) {
            bail!("path `{path}` has a Windows-unsafe trailing dot/space");
        }
        if component.chars().any(|character| character.is_control()) {
            bail!("path `{path}` contains control characters");
        }
        validate_windows_name(component)
            .map_err(|error| anyhow::anyhow!("path `{path}`: {error}"))?;
        saw_component = true;
    }
    if !saw_component {
        bail!("path `{path}` is empty");
    }
    Ok(())
}

fn validate_windows_name(component: &str) -> Result<()> {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = component.split('.').next().unwrap_or(component);
    if RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        bail!("`{component}` is a reserved Windows name");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Semver {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

pub fn parse_semver(value: &str) -> Result<Semver> {
    let value = value.trim().trim_start_matches(['v', 'V']);
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
        || value.contains("..")
        || value.contains("++")
    {
        bail!("invalid semantic version");
    }
    let core = value.split(['-', '+']).next().unwrap_or(value);
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        bail!("expected MAJOR.MINOR.PATCH");
    }
    let mut numbers = [0u64; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.chars().all(|character| character.is_ascii_digit()) {
            bail!("`{part}` is not a number");
        }
        numbers[index] = part.parse().map_err(|_| anyhow::anyhow!("`{part}` is too large"))?;
    }
    Ok(Semver {
        major: numbers[0],
        minor: numbers[1],
        patch: numbers[2],
    })
}

fn validate_engine_range(range: &str) -> Result<()> {
    for token in range.split_whitespace() {
        let constraint = token.trim_start_matches(['>', '<', '=', '^', '~']);
        if constraint.is_empty() {
            bail!("empty constraint in `{range}`");
        }
        if constraint != "*" && parse_semver(constraint).is_err() {
            bail!("`{token}` is not a valid constraint");
        }
    }
    Ok(())
}

/// Handles the common range operators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~`)
/// and space-separated conjunctions. A bare version means `>=`.
pub fn engine_matches(range: &str, current: &str) -> bool {
    let Ok(current) = parse_semver(current) else {
        return false;
    };
    for token in range.split_whitespace() {
        let token = token.trim();
        if token.is_empty() || token == "*" {
            continue;
        }
        let (operator, version) = if let Some(rest) = token.strip_prefix(">=") {
            (">=", rest)
        } else if let Some(rest) = token.strip_prefix("<=") {
            ("<=", rest)
        } else if let Some(rest) = token.strip_prefix('>') {
            (">", rest)
        } else if let Some(rest) = token.strip_prefix('<') {
            ("<", rest)
        } else if let Some(rest) = token.strip_prefix('^') {
            ("^", rest)
        } else if let Some(rest) = token.strip_prefix('~') {
            ("~", rest)
        } else {
            (">=", token)
        };
        let Ok(target) = parse_semver(version) else {
            return false;
        };
        let satisfied = match operator {
            ">=" => current >= target,
            ">" => current > target,
            "<=" => current <= target,
            "<" => current < target,
            "^" => {
                current >= target
                    && if target.major > 0 {
                        current.major == target.major
                    } else {
                        current.major == 0 && current.minor == target.minor
                    }
            }
            "~" => {
                current >= target
                    && current.major == target.major
                    && current.minor == target.minor
            }
            _ => false,
        };
        if !satisfied {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json() -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "com.acme.github",
            "name": "GitHub",
            "version": "1.4.0",
            "apiVersion": 1,
            "engines": { "zylara": ">=0.11.0 <1.0.0" },
            "publisher": { "id": "acme", "name": "Acme", "keyId": "acme-2026" },
            "permissions": [
                "ui.slot:chat.composer.toolbar",
                "ui.view",
                "ui.command",
                "storage",
                "agent.tools"
            ],
            "contributes": {
                "ui": {
                    "slots": [{ "slot": "chat.composer.toolbar", "entry": "ui/toolbar.html" }],
                    "views": [{ "id": "github", "title": "GitHub", "surface": "chat", "location": "sidebar", "entry": "ui/page.html" }],
                    "commands": [{ "id": "open", "title": "Open GitHub", "action": { "kind": "openView", "target": "github" } }]
                },
                "tools": [{ "name": "lookup", "description": "Look up a repository.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } } } }]
            },
            "runtime": { "ui": "sandbox", "backend": { "kind": "js", "entry": "backend/index.html" } }
        })
    }

    fn parse(value: Value) -> Result<PluginManifest> {
        PluginManifest::parse(serde_json::to_vec(&value).unwrap().as_slice())
    }

    #[test]
    fn accepts_the_canonical_manifest() {
        let manifest = parse(manifest_json()).expect("canonical manifest");
        assert_eq!(manifest.id, "com.acme.github");
        assert!(manifest.is_sandboxed());
        assert!(manifest.supports_current_app());
        let tools = match manifest.contributes.tools {
            Some(ToolSource::Inline(tools)) => tools,
            _ => panic!("inline tools"),
        };
        assert_eq!(tools[0].name, "lookup");
    }

    #[test]
    fn rejects_unknown_or_unscoped_permissions() {
        let mut value = manifest_json();
        value["permissions"] = serde_json::json!(["net:evil.example"]);
        assert!(parse(value).is_err());
        let mut value = manifest_json();
        // Removing the slot permission while keeping the contribution fails.
        value["permissions"] = serde_json::json!(["ui.view", "ui.command", "storage"]);
        value["contributes"]["ui"]["slots"] = serde_json::json!([]);
        value["contributes"]["ui"]["views"] = serde_json::json!([]);
        value["contributes"]["ui"]["commands"] = serde_json::json!([]);
        value["contributes"]["tools"] = Value::Null;
        assert!(parse(value).is_ok());
        let mut value = manifest_json();
        value["permissions"] = serde_json::json!(["net"]);
        assert!(parse(value).is_err());
    }

    #[test]
    fn rejects_path_traversal_and_windows_reserved_names() {
        for path in ["../evil", "/etc/passwd", "C:/x", "a\\b", "CON", "dir/NUL.txt", "a/./b"] {
            assert!(
                validate_relative_path(path).is_err(),
                "{path} should be rejected"
            );
        }
        assert!(validate_relative_path("ui/page.html").is_ok());
    }

    #[test]
    fn rejects_trusted_inconsistencies() {
        let mut value = manifest_json();
        value["trusted"] = serde_json::json!(true);
        assert!(parse(value).is_err());
        let mut value = manifest_json();
        value["runtime"]["ui"] = serde_json::json!("trusted");
        value["trusted"] = serde_json::json!(true);
        assert!(parse(value.clone()).is_err(), "unsafe.renderer is required");
        value["permissions"] = serde_json::json!([]);
        value["contributes"] = serde_json::json!({});
        value["runtime"]["entry"] = serde_json::json!("main.js");
        value["permissions"] = serde_json::json!(["unsafe.renderer"]);
        assert!(parse(value).is_ok());
    }

    #[test]
    fn command_hotkeys_require_the_hotkeys_permission() {
        let mut value = manifest_json();
        value["contributes"]["ui"]["commands"][0]["hotkey"] = serde_json::json!("mod+shift+n");
        assert!(parse(value.clone()).is_err());
        value["permissions"]
            .as_array_mut()
            .expect("permissions")
            .push(serde_json::json!("hotkeys"));
        assert!(parse(value.clone()).is_ok());
        value["contributes"]["ui"]["commands"][0]["hotkey"] = serde_json::json!("hyper+x");
        assert!(parse(value).is_err());
    }

    #[test]
    fn engine_ranges_use_semver_ordering() {
        assert!(engine_matches(">=0.11.0 <1.0.0", "0.11.1"));
        assert!(!engine_matches(">=0.11.0 <1.0.0", "1.0.0"));
        assert!(engine_matches("^0.11.0", "0.11.9"));
        assert!(!engine_matches("^0.11.0", "0.12.0"));
        assert!(engine_matches("~0.11.0", "0.11.9"));
        assert!(!engine_matches("~0.11.0", "0.12.0"));
    }

    #[test]
    fn rejects_reserved_ids_and_invalid_semver() {
        for id in ["zylara.github", "com.zylara.foo", "github", "Com.Acme", "a..b"] {
            assert!(validate_plugin_id(id).is_err(), "{id}");
        }
        assert!(validate_plugin_id("com.acme.github").is_ok());
        assert!(parse_semver("1.4.0").is_ok());
        assert!(parse_semver("1.4").is_err());
        assert!(parse_semver("1.4.0-beta.1").is_ok());
    }
}
