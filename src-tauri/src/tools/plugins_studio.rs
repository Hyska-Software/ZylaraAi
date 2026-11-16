//! `plugin_studio`: authoring, validation, packaging and disabled installation
//! for Plugin Creator mode. Works without a workspace (Chat) and inside a
//! trusted Code workspace. Plugin code never runs here.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::domain::{ApprovalDetail, PermissionMode, RiskClass, TurnProfile};
use crate::plugins::authoring;
use crate::plugins::manifest::{
    validate_plugin_id, validate_relative_path, PluginManifest,
};
use crate::plugins::signature;
use crate::plugins::PluginManager;
use crate::providers::ToolDefinition;
use crate::tools::registry::{ParallelClass, ToolCtx, ToolSpec, WorkspaceHandle};
use crate::tools::{ToolOutcome, ToolRuntime};

pub const NAME: &str = "plugin_studio";

pub const GUIDANCE: &str = "Use `plugin_studio` in Plugin Creator mode: init a plugin, write its files, \
validate, pack/sign and install it disabled. Never enable the plugin or grant permissions.";

const DESCRIPTION: &str = "Author, validate, sign, pack and install a Zylara plugin without an open \
workspace. Actions: init, write, read, list, remove, validate, pack, install, status. Files live in \
<app-data>/plugin-studio/<conversation>/<plugin> or, with target=workspace, in \
<workspace>/plugins/<plugin>. Install is always disabled for user review.";

static PROFILES: &[TurnProfile] = &[TurnProfile::Code];

pub static SPEC: ToolSpec = ToolSpec {
    name: NAME,
    description: DESCRIPTION,
    schema: schema_value,
    parallel: ParallelClass::Exclusive,
    risk: RiskClass::Write,
    mutating: true,
    requires_workspace: false,
    profiles: PROFILES,
    guidance: GUIDANCE,
};

const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_BINARY_BYTES: usize = 25 * 1024 * 1024;
const MAX_READ_BYTES: usize = 512 * 1024;
const MAX_LIST_ENTRIES: usize = 400;
const KEY_FILE: &str = "META-INF/publisher.key";
const PUB_FILE: &str = "META-INF/publisher.pub";
const STUDIO_FILE: &str = "META-INF/studio.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TargetKind {
    Studio,
    Workspace,
}

impl TargetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Studio => "studio",
            Self::Workspace => "workspace",
        }
    }
}

struct StudioEnv<'a> {
    data_dir: &'a Path,
    conversation_id: &'a str,
    workspace: Option<&'a WorkspaceHandle>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Args {
    action: String,
    #[serde(default)]
    plugin: Option<String>,
    #[serde(default)]
    plugin_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    template: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    encoding: Option<String>,
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["init", "write", "read", "list", "remove", "validate", "pack", "install", "status"]
            },
            "plugin": {
                "type": "string",
                "description": "Plugin folder slug or manifest id created by init; defaults only when the studio/workspace has exactly one plugin."
            },
            "pluginId": {
                "type": "string",
                "description": "Plugin id for init, e.g. com.acme.notes (required for init)."
            },
            "name": { "type": "string", "description": "Display name for init; defaults to the last id segment." },
            "slug": { "type": "string", "description": "Folder/name slug for init; defaults to the last pluginId segment." },
            "target": { "type": "string", "enum": ["auto", "studio", "workspace"], "default": "auto" },
            "template": { "type": "string", "enum": ["sandbox", "declarative", "trusted"], "default": "sandbox" },
            "path": { "type": "string", "description": "Relative file path for write/read/remove." },
            "content": { "type": "string", "description": "UTF-8 text or base64 bytes for write." },
            "encoding": { "type": "string", "enum": ["utf8", "base64"], "default": "utf8" }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

pub fn schema_value() -> Value {
    schema()
}

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        parameters: schema(),
    }
}

pub async fn run_chat(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    let env = StudioEnv {
        data_dir: &rt.data_dir,
        conversation_id: &rt.conversation_id,
        workspace: None,
    };
    run(&env, args).await
}

pub async fn run_code(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let env = StudioEnv {
        data_dir: &ctx.data_dir,
        conversation_id: &ctx.conversation_id,
        workspace: ctx.workspace.as_ref(),
    };
    if let Err(outcome) = policy_for_code(ctx, &env, args).await {
        return outcome;
    }
    run(&env, args).await
}

async fn run(env: &StudioEnv<'_>, raw: &Value) -> ToolOutcome {
    let args: Args = match serde_json::from_value(raw.clone()) {
        Ok(args) => args,
        Err(error) => return ToolOutcome::error(format!("PLUGIN_STUDIO_ARGS: {error}")),
    };
    let result = match args.action.as_str() {
        "init" => init(env, &args),
        "write" => write_file(env, &args),
        "read" => read_file(env, &args),
        "list" => list_files(env, &args),
        "remove" => remove_file(env, &args),
        "validate" => validate_plugin(env, &args),
        "pack" => pack_plugin(env, &args),
        "install" => install_plugin(env, &args),
        "status" => status(env, &args),
        other => Err(anyhow::anyhow!("PLUGIN_STUDIO_ACTION: unknown action `{other}`")),
    };
    match result {
        Ok(value) => ToolOutcome {
            content: serde_json::to_string_pretty(&value)
                .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}")),
            summary: Some(format!(
                "Plugin Studio · {}",
                value
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("action").and_then(Value::as_str))
                    .unwrap_or(args.action.as_str())
            )),
            ..Default::default()
        },
        Err(error) => ToolOutcome::error(format!("{error:#}")),
    }
}

fn studio_root(env: &StudioEnv<'_>) -> PathBuf {
    let safe: String = env
        .conversation_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    env.data_dir
        .join("plugin-studio")
        .join(if safe.is_empty() { "session" } else { safe.as_str() })
}

fn workspace_plugins(workspace: &WorkspaceHandle) -> PathBuf {
    workspace.root.join("plugins")
}

fn ensure_not_symlink(path: &Path) -> anyhow::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(anyhow::anyhow!(
                "PLUGIN_STUDIO_PATH: refusing to use symlinked root {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn target_roots(env: &StudioEnv<'_>, target: &str) -> anyhow::Result<Vec<(TargetKind, PathBuf)>> {
    match target {
        "studio" => {
            let root = studio_root(env);
            ensure_not_symlink(&root)?;
            Ok(vec![(TargetKind::Studio, root)])
        }
        "workspace" => match env.workspace {
            Some(workspace) if workspace.trusted => {
                let root = workspace_plugins(workspace);
                ensure_not_symlink(&root)?;
                Ok(vec![(TargetKind::Workspace, root)])
            }
            _ => Err(anyhow::anyhow!(
                "PLUGIN_STUDIO_WORKSPACE_UNAVAILABLE: open and trust a Code workspace, or use target=studio"
            )),
        },
        "auto" => {
            let mut roots = Vec::new();
            if let Some(workspace) = env.workspace.filter(|workspace| workspace.trusted) {
                let root = workspace_plugins(workspace);
                ensure_not_symlink(&root)?;
                roots.push((TargetKind::Workspace, root));
            }
            let root = studio_root(env);
            ensure_not_symlink(&root)?;
            roots.push((TargetKind::Studio, root));
            Ok(roots)
        }
        other => Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_TARGET: target must be auto, studio or workspace (got `{other}`)"
        )),
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && !value.ends_with('-')
}

fn plugin_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| path.join("manifest.json").is_file())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

fn manifest_id(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path.join("manifest.json")).ok()?;
    PluginManifest::parse(&bytes).ok().map(|manifest| manifest.id)
}

fn resolve_plugin_dir(
    env: &StudioEnv<'_>,
    args: &Args,
) -> anyhow::Result<(TargetKind, PathBuf, PathBuf)> {
    let target = args.target.as_deref().unwrap_or("auto");
    let roots = target_roots(env, target)?;
    let selector = args.plugin.as_deref();
    for (kind, root) in &roots {
        if let Some(selector) = selector {
            if valid_slug(selector) {
                let direct = root.join(selector);
                ensure_not_symlink(&direct)?;
                if direct.join("manifest.json").is_file() {
                    return Ok((*kind, root.clone(), direct));
                }
            }
            for dir in plugin_dirs(root) {
                if manifest_id(&dir).as_deref() == Some(selector) {
                    return Ok((*kind, root.clone(), dir));
                }
            }
        } else {
            let mut dirs = plugin_dirs(root);
            if dirs.len() == 1 {
                return Ok((*kind, root.clone(), dirs.remove(0)));
            }
            if dirs.len() > 1 {
                return Err(anyhow::anyhow!(
                    "PLUGIN_STUDIO_AMBIGUOUS: choose `plugin` (multiple plugin folders in {})",
                    root.display()
                ));
            }
        }
    }
    Err(anyhow::anyhow!(
        "PLUGIN_STUDIO_NOT_FOUND: plugin not found for {}",
        selector.unwrap_or("<missing plugin>")
    ))
}

fn plugin_slug(args: &Args) -> anyhow::Result<(String, String, String, String)> {
    let id = args
        .plugin_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: init requires pluginId"))?;
    validate_plugin_id(id).map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: {error}"))?;
    let slug = args
        .slug
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| id.rsplit(['.', '-']).next().unwrap_or("plugin"));
    if !valid_slug(slug) {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_ARGS: invalid slug `{slug}` (lowercase letters, digits, hyphen)"
        ));
    }
    let name = args
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(slug);
    if name.chars().count() > 80 {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_ARGS: name must have at most 80 characters"
        ));
    }
    let publisher = id
        .split(['.', '-'])
        .nth(1)
        .filter(|value| !value.is_empty())
        .unwrap_or("studio");
    Ok((id.to_string(), slug.to_string(), name.to_string(), publisher.to_string()))
}

fn init(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (id, slug, name, publisher) = plugin_slug(args)?;
    let template = args.template.as_deref().unwrap_or("sandbox");
    if !matches!(template, "sandbox" | "declarative" | "trusted") {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_ARGS: template must be sandbox, declarative or trusted"
        ));
    }
    let target = args.target.as_deref().unwrap_or("auto");
    let roots = target_roots(env, target)?;
    let (kind, root) = roots
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_TARGET: no target root"))?;
    let plugin_dir = root.join(&slug);
    ensure_not_symlink(&plugin_dir)?;
    if plugin_dir.exists() {
        let non_empty = std::fs::read_dir(&plugin_dir)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(true);
        if non_empty {
            return Err(anyhow::anyhow!(
                "PLUGIN_STUDIO_EXISTS: {} already exists",
                plugin_dir.display()
            ));
        }
    }
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed)
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_KEY: random source failed: {error}"))?;
    let key = SigningKey::from_bytes(&seed);
    let key_id = format!("studio-{slug}");
    let publisher_id = publisher;
    std::fs::create_dir_all(plugin_dir.join("META-INF"))?;
    std::fs::create_dir_all(plugin_dir.join("locales"))?;
    std::fs::create_dir_all(plugin_dir.join("skills").join("example"))?;
    if template == "sandbox" {
        std::fs::create_dir_all(plugin_dir.join("ui"))?;
        std::fs::create_dir_all(plugin_dir.join("backend"))?;
    }
    write_key_files(&plugin_dir, &key, &publisher_id, &key_id)?;
    let manifest = match template {
        "declarative" => declarative_manifest(&id, &slug, &name, &publisher_id, &key_id),
        "trusted" => trusted_manifest(&id, &slug, &name, &publisher_id, &key_id),
        _ => sandbox_manifest(&id, &slug, &name, &publisher_id, &key_id),
    };
    std::fs::write(
        plugin_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    write_locales(&plugin_dir, &name)?;
    std::fs::write(
        plugin_dir.join("README.md"),
        format!("# {name}\n\nCreated by Plugin Studio. Use the `plugin_studio` tool to validate, pack and install.\n"),
    )?;
    std::fs::write(
        plugin_dir.join("skills").join("example").join("SKILL.md"),
        "---\nname: example\ndescription: Example skill shipped by this plugin.\n---\n\n# Example skill\n\nReplace this text with instructions the agent can use.\n",
    )?;
    match template {
        "sandbox" => write_sandbox_files(&plugin_dir, &slug, &name)?,
        "trusted" => write_trusted_files(&plugin_dir, &slug, &name)?,
        _ => {}
    }
    let files = authoring::collect_authoring_files(&plugin_dir)?;
    let package_path = authoring::package_path_for(&plugin_dir)?;
    Ok(json!({
        "ok": true,
        "action": "init",
        "target": kind.as_str(),
        "studioRoot": studio_root(env).display().to_string(),
        "pluginDir": plugin_dir.display().to_string(),
        "pluginId": manifest["id"],
        "version": manifest["version"],
        "template": template,
        "files": files.keys().collect::<Vec<_>>(),
        "packagePath": package_path.display().to_string(),
        "next": "read plugin-manifest/plugin-ui/plugin-agent, write the manifest and files, then validate/pack/install"
    }))
}

fn write_key_files(
    plugin_dir: &Path,
    key: &SigningKey,
    publisher_id: &str,
    key_id: &str,
) -> anyhow::Result<()> {
    let encoding = base64::engine::general_purpose::STANDARD;
    let public = key.verifying_key().to_bytes();
    std::fs::write(plugin_dir.join(KEY_FILE), encoding.encode(key.to_bytes()))?;
    std::fs::write(plugin_dir.join(PUB_FILE), encoding.encode(public))?;
    std::fs::write(
        plugin_dir.join(STUDIO_FILE),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "publisherId": publisher_id,
            "keyId": key_id,
            "publicKey": encoding.encode(public),
        }))?,
    )?;
    Ok(())
}

fn sandbox_manifest(id: &str, slug: &str, name: &str, publisher: &str, key_id: &str) -> Value {
    json!({
        "schemaVersion": 2,
        "id": id,
        "name": name,
        "version": "1.0.0",
        "description": format!("{name} plugin."),
        "author": name,
        "apiVersion": 2,
        "engines": { "zylara": ">=0.10.0 <1.0.0" },
        "publisher": { "id": publisher, "name": name, "keyId": key_id },
        "permissions": [
            "ui.view", "ui.nav", "ui.panel",
            "ui.slot:chat.composer.toolbar", "storage"
        ],
        "contributes": {
            "ui": {
                "views": [{ "id": slug, "title": name, "entry": "ui/page.html", "layouts": ["chat", "code"] }],
                "nav": [{ "id": slug, "title": name, "icon": "Sparkles", "page": slug, "layouts": ["chat", "code"] }],
                "panels": [{ "id": format!("{slug}-panel"), "title": name, "entry": "ui/panel.html", "tab": true, "layouts": ["chat", "code"] }],
                "slots": [{ "slot": "chat.composer.toolbar", "id": format!("{slug}-toolbar"), "title": name, "entry": "ui/toolbar.html" }]
            },
            "locales": ["locales"]
        },
        "runtime": { "ui": "sandbox", "backend": { "kind": "js", "entry": "backend/index.html" } }
    })
}

fn declarative_manifest(id: &str, slug: &str, name: &str, publisher: &str, key_id: &str) -> Value {
    json!({
        "schemaVersion": 2,
        "id": id,
        "name": name,
        "version": "1.0.0",
        "description": format!("{name} plugin."),
        "author": name,
        "apiVersion": 2,
        "engines": { "zylara": ">=0.10.0 <1.0.0" },
        "publisher": { "id": publisher, "name": name, "keyId": key_id },
        "permissions": [
            "ui.slot:chat.composer.toolbar", "ui.command", "chat.write"
        ],
        "contributes": {
            "ui": {
                "slots": [{
                    "slot": "chat.composer.toolbar",
                    "id": format!("{slug}-action"),
                    "title": name,
                    "icon": "Sparkles",
                    "action": { "kind": "insertDraft", "text": format!("[{name}] ") }
                }],
                "commands": [{
                    "id": slug,
                    "title": name,
                    "command": slug,
                    "action": { "kind": "insertDraft", "text": format!("[{name}] ") }
                }]
            },
            "locales": ["locales"]
        },
        "runtime": { "ui": "declarative" }
    })
}

fn trusted_manifest(id: &str, slug: &str, name: &str, publisher: &str, key_id: &str) -> Value {
    json!({
        "schemaVersion": 2,
        "id": id,
        "name": name,
        "version": "1.0.0",
        "description": format!("{name} trusted plugin."),
        "author": name,
        "apiVersion": 2,
        "trusted": true,
        "engines": { "zylara": ">=0.10.0 <1.0.0" },
        "publisher": { "id": publisher, "name": name, "keyId": key_id },
        "permissions": ["unsafe.renderer", "ui.view"],
        "contributes": {
            "ui": {
                "views": [{ "id": slug, "title": name, "component": "Lab", "layouts": ["chat", "code"] }]
            },
            "locales": ["locales"]
        },
        "runtime": { "ui": "trusted", "entry": "main.js" }
    })
}

fn write_locales(plugin_dir: &Path, name: &str) -> anyhow::Result<()> {
    for (locale, label) in [("en", "Open"), ("pt-BR", "Abrir"), ("es", "Abrir")] {
        std::fs::write(
            plugin_dir.join("locales").join(format!("{locale}.json")),
            serde_json::to_vec_pretty(&json!({
                "plugin": { "name": name, "open": label }
            }))?,
        )?;
    }
    Ok(())
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn write_sandbox_files(plugin_dir: &Path, slug: &str, name: &str) -> anyhow::Result<()> {
    let name = html_escape(name);
    std::fs::write(
        plugin_dir.join("ui").join("page.html"),
        format!(
            "<!doctype html><meta charset=\"utf-8\"><style>body{{font:14px system-ui;color:var(--foreground);background:var(--background);padding:16px}}</style><body><h1>{name}</h1><p id=\"status\">Connecting…</p><script src=\"/@zylara/sdk.js\"></script><script>ZylaraPlugin.on('init',()=>{{document.getElementById('status').textContent='Connected';ZylaraPlugin.resize()}})</script></body>\n"
        ),
    )?;
    std::fs::write(
        plugin_dir.join("ui").join("panel.html"),
        format!(
            "<!doctype html><meta charset=\"utf-8\"><style>body{{font:13px system-ui;color:var(--foreground);background:var(--surface-raised);padding:12px}}</style><body><strong>{name}</strong><p id=\"status\">Panel</p><script src=\"/@zylara/sdk.js\"></script><script>ZylaraPlugin.resize()</script></body>\n"
        ),
    )?;
    std::fs::write(
        plugin_dir.join("ui").join("toolbar.html"),
        format!(
            "<!doctype html><meta charset=\"utf-8\"><style>body{{margin:0;font:12px system-ui;color:var(--foreground);background:transparent}}button{{height:26px;border:0;border-radius:8px;background:var(--surface-raised);color:var(--foreground);padding:0 8px}}</style><body><button id=\"open\">{name}</button><script src=\"/@zylara/sdk.js\"></script><script>document.getElementById('open').onclick=()=>ZylaraPlugin.openView('{slug}')</script></body>\n"
        ),
    )?;
    std::fs::write(
        plugin_dir.join("backend").join("index.html"),
        "<!doctype html><meta charset=\"utf-8\"><script src=\"/@zylara/sdk.js\"></script><script>ZylaraPlugin.onTool(async ({tool})=>({content:`backend received ${tool}`,summary:'ok'}))</script>\n",
    )?;
    Ok(())
}

fn write_trusted_files(plugin_dir: &Path, slug: &str, name: &str) -> anyhow::Result<()> {
    std::fs::write(
        plugin_dir.join("main.js"),
        format!(
            "host.registerPlugin({{\n  activate(host) {{\n    function Lab() {{\n      return host.react.createElement('div', {{ style: {{ padding: 24 }} }}, {name:?});\n    }}\n    host.registerView({slug:?}, Lab);\n    host.registerComponent('Lab', Lab);\n  }},\n  deactivate() {{}},\n}});\n"
        ),
    )?;
    Ok(())
}

fn plugin_file_path(plugin_dir: &Path, raw: &str) -> anyhow::Result<PathBuf> {
    let path = raw.trim();
    if path.is_empty() {
        return Err(anyhow::anyhow!("PLUGIN_STUDIO_ARGS: path is required"));
    }
    validate_relative_path(path)
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_PATH: {error}"))?;
    if path == "META-INF" || path.starts_with("META-INF/") {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_PATH: META-INF is studio-managed and cannot be read, written or removed"
        ));
    }
    let components: Vec<&str> = path.split('/').collect();
    if components
        .iter()
        .any(|component| component.starts_with('.') && *component != ".gitignore")
    {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_PATH: hidden files are not packaged; use a visible path"
        ));
    }
    let mut current = plugin_dir.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        if let Ok(metadata) = std::fs::symlink_metadata(&current) {
            if metadata.file_type().is_symlink() {
                return Err(anyhow::anyhow!(
                    "PLUGIN_STUDIO_PATH: refusing to follow a symlink at {}",
                    current.display()
                ));
            }
            if !metadata.is_dir() && index + 1 < components.len() {
                return Err(anyhow::anyhow!(
                    "PLUGIN_STUDIO_PATH: {} is not a directory",
                    current.display()
                ));
            }
        }
    }
    let target = plugin_dir.join(path);
    let root = std::fs::canonicalize(plugin_dir)
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_PATH: {}: {error}", plugin_dir.display()))?;
    let mut probe = if target.exists() {
        target.clone()
    } else {
        target.parent().unwrap_or(plugin_dir).to_path_buf()
    };
    while !probe.exists() {
        let Some(parent) = probe.parent() else {
            return Err(anyhow::anyhow!(
                "PLUGIN_STUDIO_PATH: {} has no existing ancestor",
                target.display()
            ));
        };
        probe = parent.to_path_buf();
    }
    let resolved = std::fs::canonicalize(&probe)
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_PATH: {}: {error}", probe.display()))?;
    if !resolved.starts_with(&root) {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_PATH: {} escapes the plugin folder",
            target.display()
        ));
    }
    Ok(target)
}

fn write_file(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (kind, _root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let path = args
        .path
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: write requires path"))?;
    let target = plugin_file_path(&plugin_dir, path)?;
    let content = args
        .content
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: write requires content"))?;
    let bytes = match args.encoding.as_deref().unwrap_or("utf8") {
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(content.trim())
            .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: invalid base64: {error}"))?,
        "utf8" => content.as_bytes().to_vec(),
        other => {
            return Err(anyhow::anyhow!(
                "PLUGIN_STUDIO_ARGS: encoding must be utf8 or base64 (got `{other}`)"
            ))
        }
    };
    let max = if args.encoding.as_deref() == Some("base64") {
        MAX_BINARY_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    if bytes.len() > max {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_QUOTA: file exceeds {max} bytes"
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, &bytes)?;
    // Editing may leave the manifest temporarily invalid (the next call fixes
    // it); `validate` is the gate, so writing a file only enforces the folder
    // boundary/quotas here.
    let files = authoring::collect_authoring_files(&plugin_dir)?;
    Ok(json!({
        "ok": true,
        "action": "write",
        "target": kind.as_str(),
        "pluginDir": plugin_dir.display().to_string(),
        "path": path,
        "bytes": bytes.len(),
        "files": files.keys().collect::<Vec<_>>(),
    }))
}

fn read_file(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (_kind, _root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let path = args
        .path
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: read requires path"))?;
    let target = plugin_file_path(&plugin_dir, path)?;
    let bytes = std::fs::read(&target)
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_NOT_FOUND: {}: {error}", target.display()))?;
    if bytes.len() > MAX_READ_BYTES {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_QUOTA: file exceeds {MAX_READ_BYTES} bytes"
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("PLUGIN_STUDIO_BINARY_READ: file is not UTF-8"))?;
    Ok(json!({
        "ok": true,
        "action": "read",
        "pluginDir": plugin_dir.display().to_string(),
        "path": path,
        "content": content,
    }))
}

fn list_files(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (kind, root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let files = authoring::collect_authoring_files(&plugin_dir)?;
    let entries = files
        .iter()
        .take(MAX_LIST_ENTRIES)
        .map(|(path, bytes)| json!({ "path": path, "bytes": bytes.len() }))
        .collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "action": "list",
        "target": kind.as_str(),
        "studioRoot": studio_root(env).display().to_string(),
        "pluginDir": plugin_dir.display().to_string(),
        "root": root.display().to_string(),
        "files": entries,
        "truncated": files.len() > MAX_LIST_ENTRIES,
    }))
}

fn remove_file(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (_kind, _root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let path = args
        .path
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_ARGS: remove requires path"))?;
    let target = plugin_file_path(&plugin_dir, path)?;
    std::fs::remove_file(&target)
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_NOT_FOUND: {}: {error}", target.display()))?;
    Ok(json!({
        "ok": true,
        "action": "remove",
        "pluginDir": plugin_dir.display().to_string(),
        "path": path,
    }))
}

fn validate_plugin(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (kind, _root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let Some(manager) = crate::plugins::global_manager() else {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_UNAVAILABLE: plugin manager is unavailable"
        ));
    };
    let inspection = manager
        .inspect_authoring_folder(&plugin_dir)
        .map_err(|error| anyhow::anyhow!("PLUGIN_INVALID: {error:#}"))?;
    Ok(json!({
        "ok": true,
        "action": "validate",
        "target": kind.as_str(),
        "pluginDir": plugin_dir.display().to_string(),
        "inspection": inspection,
        "next": "fix every warning/error, then pack"
    }))
}

fn studio_key(plugin_dir: &Path) -> anyhow::Result<(SigningKey, String, String)> {
    let metadata = std::fs::read(plugin_dir.join(STUDIO_FILE))
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_KEY: missing studio.json: {error}"))?;
    let value: Value = serde_json::from_slice(&metadata)?;
    let publisher_id = value
        .get("publisherId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_KEY: studio.json has no publisherId"))?
        .to_string();
    let key_id = value
        .get("keyId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_KEY: studio.json has no keyId"))?
        .to_string();
    let encoded = std::fs::read_to_string(plugin_dir.join(KEY_FILE))
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_KEY: missing publisher.key: {error}"))?;
    let seed = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| anyhow::anyhow!("PLUGIN_STUDIO_KEY: invalid publisher.key: {error}"))?;
    let bytes: [u8; 32] = seed
        .try_into()
        .map_err(|_| anyhow::anyhow!("PLUGIN_STUDIO_KEY: publisher.key must be 32 bytes"))?;
    Ok((SigningKey::from_bytes(&bytes), publisher_id, key_id))
}

fn pack(plugin_dir: &Path, env: &StudioEnv<'_>) -> anyhow::Result<Value> {
    let (key, publisher_id, key_id) = studio_key(plugin_dir)?;
    let out = authoring::package_path_for(plugin_dir)?;
    let files = authoring::write_signed_package(&plugin_dir, &out, &key, &publisher_id, &key_id)?;
    let package = authoring::read_package(&out)?;
    let file_sha256 = authoring::file_sha256(&out)?;
    Ok(json!({
        "ok": true,
        "action": "pack",
        "target": if env.workspace.is_some() && out.starts_with(env.workspace.unwrap().root.as_path()) { "workspace" } else { "studio" },
        "pluginDir": plugin_dir.display().to_string(),
        "packagePath": out.display().to_string(),
        "packageHash": package.package_hash,
        "packageFileSha256": file_sha256,
        "verified": package.verified,
        "permissions": package.permissions,
        "files": files.keys().collect::<Vec<_>>(),
    }))
}

fn pack_plugin(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (_kind, _root, plugin_dir) = resolve_plugin_dir(env, args)?;
    pack(&plugin_dir, env)
}

fn install_plugin(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (_kind, _root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let out = authoring::package_path_for(&plugin_dir)?;
    pack(&plugin_dir, env)?;
    let Some(manager) = crate::plugins::global_manager() else {
        return Err(anyhow::anyhow!(
            "PLUGIN_STUDIO_UNAVAILABLE: plugin manager is unavailable"
        ));
    };
    let record = manager
        .install_for_activation(&out)
        .map_err(|error| anyhow::anyhow!("{error:#}"))?;
    Ok(json!({
        "ok": true,
        "action": "install",
        "pluginDir": plugin_dir.display().to_string(),
        "packagePath": out.display().to_string(),
        "pluginId": record.id,
        "version": record.version,
        "permissions": record.permissions.iter().map(|permission| &permission.id).collect::<Vec<_>>(),
        "active": false,
        "disabledReason": record.disabled_reason,
        "next": crate::i18n::t_args(
            "tools.pluginStudio.installNext",
            &[("plugin", record.id.as_str())],
        )
    }))
}

fn status(env: &StudioEnv<'_>, args: &Args) -> anyhow::Result<Value> {
    let (kind, root, plugin_dir) = resolve_plugin_dir(env, args)?;
    let files = authoring::collect_authoring_files(&plugin_dir)?;
    let manifest = authoring::parse_authoring_manifest(&files)?;
    let package_path = authoring::package_path_for(&plugin_dir)?;
    let package = package_path
        .is_file()
        .then(|| authoring::read_package(&package_path).ok())
        .flatten();
    let key_fingerprint = std::fs::read(plugin_dir.join(PUB_FILE))
        .ok()
        .and_then(|bytes| {
            base64::engine::general_purpose::STANDARD
                .decode(String::from_utf8_lossy(&bytes).trim())
                .ok()
        })
        .map(|bytes| signature::key_fingerprint(&bytes));
    Ok(json!({
        "ok": true,
        "action": "status",
        "target": kind.as_str(),
        "studioRoot": studio_root(env).display().to_string(),
        "pluginDir": plugin_dir.display().to_string(),
        "root": root.display().to_string(),
        "pluginId": manifest.id,
        "version": manifest.version,
        "template": if manifest.is_trusted() {
            "trusted"
        } else if manifest.runtime.ui == "declarative" {
            "declarative"
        } else {
            "sandbox"
        },
        "files": files.keys().collect::<Vec<_>>(),
        "packagePath": package_path.is_file().then(|| package_path.display().to_string()),
        "packageFileSha256": package_path.is_file().then(|| authoring::file_sha256(&package_path).ok()).flatten(),
        "packageHash": package.as_ref().map(|package| package.package_hash.clone()),
        "keyFingerprint": key_fingerprint,
        "signed": package.as_ref().is_some_and(|package| package.verified),
    }))
}

async fn policy_for_code(
    ctx: &ToolCtx,
    env: &StudioEnv<'_>,
    raw: &Value,
) -> Result<(), ToolOutcome> {
    let Ok(args) = serde_json::from_value::<Args>(raw.clone()) else {
        return Ok(());
    };
    if !matches!(
        args.action.as_str(),
        "init" | "write" | "remove" | "pack" | "install"
    ) {
        return Ok(());
    }
    let mode = ctx
        .db
        .get_conversation(&ctx.conversation_id)
        .ok()
        .flatten()
        .map(|conversation| conversation.permission_mode)
        .or_else(|| ctx.workspace.as_ref().map(|workspace| workspace.permission_mode));
    if mode == Some(PermissionMode::ReadOnly) {
        return Err(ToolOutcome::error(
            "POLICY_READ_ONLY: Plugin Studio writes require a writable permission mode",
        ));
    }
    if crate::harness::code::session::plan_mode_active(&ctx.db, &ctx.conversation_id)
        .unwrap_or(true)
    {
        return Err(ToolOutcome::error(
            "PLAN_MODE_ACTIVE: Plugin Studio writes are disabled while Plan mode is active",
        ));
    }
    let target = args.target.as_deref().unwrap_or("auto");
    let roots = match target_roots(env, target) {
        Ok(roots) => roots,
        Err(error) => return Err(ToolOutcome::error(format!("{error:#}"))),
    };
    let Some((kind, root)) = roots.first() else {
        return Ok(());
    };
    if *kind != TargetKind::Workspace {
        return Ok(());
    }
    let path = if args.action == "init" {
        let slug = plugin_slug(&args)
            .map(|(_, slug, _, _)| slug)
            .unwrap_or_else(|_| "plugin".to_string());
        root.join(slug)
    } else {
        match resolve_plugin_dir(env, &args) {
            Ok((actual, _, plugin_dir)) => {
                if actual != TargetKind::Workspace {
                    return Ok(());
                }
                plugin_dir
            }
            Err(_) => root.to_path_buf(),
        }
    };
    let path_text = path.to_string_lossy().to_string();
    crate::tools::code::exec::policy_check(
        ctx,
        NAME,
        RiskClass::Write,
        true,
        Some(path_text.as_str()),
        false,
        None,
        ApprovalDetail::Other {
            text: format!("Write the plugin authoring folder {}", path.display()),
        },
        "Plugin Studio",
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::db::Db;
    use crate::domain::Settings;
    use crate::plugins::PluginManager;

    fn env<'a>(dir: &'a Path, conversation: &'a str) -> StudioEnv<'a> {
        StudioEnv {
            data_dir: dir,
            conversation_id: conversation,
            workspace: None,
        }
    }

    fn args(action: &str, plugin_id: &str) -> Args {
        Args {
            action: action.to_string(),
            plugin: None,
            plugin_id: Some(plugin_id.to_string()),
            name: None,
            slug: None,
            target: Some("studio".to_string()),
            template: Some("sandbox".to_string()),
            path: None,
            content: None,
            encoding: None,
        }
    }

    #[tokio::test]
    async fn chat_run_dispatches_init_without_a_workspace() {
        let temp = tempfile::tempdir().expect("temp");
        let runtime = ToolRuntime {
            db: Arc::new(Db::open_in_memory().expect("db")),
            http: reqwest::Client::new(),
            conversation_id: "conv-chat".to_string(),
            message_id: "msg-1".to_string(),
            options: crate::domain::TurnOptions {
                plugin_creator: true,
                ..Default::default()
            },
            settings: Settings::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
            agent_hooks: None,
            data_dir: temp.path().to_path_buf(),
            skills_roots: Vec::new(),
            approval: None,
            emit: None,
        };
        let outcome = run_chat(
            &runtime,
            &json!({"action":"init","pluginId":"com.acme.notes","target":"studio"}),
        )
        .await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("conv-chat"));
        assert!(temp.path().join("plugin-studio").join("conv-chat").is_dir());
    }

    #[test]
    fn init_write_pack_and_inspect_roundtrip() {
        let temp = tempfile::tempdir().expect("temp");
        let studio = env(temp.path(), "conv-1");
        let init = init(&studio, &args("init", "com.acme.notes")).expect("init");
        let plugin_dir = PathBuf::from(init["pluginDir"].as_str().expect("dir"));
        assert!(plugin_dir.join("manifest.json").is_file());
        assert!(plugin_dir.join(KEY_FILE).is_file());
        assert!(plugin_dir.join("ui/page.html").is_file());

        let mut write = args("write", "com.acme.notes");
        write.plugin = Some("com.acme.notes".to_string());
        write.path = Some("ui/extra.html".to_string());
        write.content = Some("<p>extra</p>".to_string());
        write_file(&studio, &write).expect("write");
        let mut read = args("read", "com.acme.notes");
        read.plugin = Some("com.acme.notes".to_string());
        read.path = Some("ui/extra.html".to_string());
        let contents = read_file(&studio, &read).expect("read");
        assert_eq!(contents["content"], "<p>extra</p>");

        let mut traversal = args("write", "com.acme.notes");
        traversal.plugin = Some("com.acme.notes".to_string());
        traversal.path = Some("../escape.html".to_string());
        traversal.content = Some("x".to_string());
        assert!(write_file(&studio, &traversal).is_err());

        let pack = pack(&plugin_dir, &studio).expect("pack");
        let package_path = PathBuf::from(pack["packagePath"].as_str().expect("package"));
        assert!(package_path.is_file());
        let package = authoring::read_package(&package_path).expect("read package");
        assert!(package.verified);
        assert_eq!(package.id, "com.acme.notes");
        let zip_files = authoring::read_package_files(&package_path).expect("zip");
        assert!(!zip_files.contains_key(KEY_FILE));
        assert!(!zip_files.contains_key(PUB_FILE));
        assert!(!zip_files.contains_key(STUDIO_FILE));
    }

    #[test]
    fn inspect_and_install_keep_the_plugin_disabled() {
        let temp = tempfile::tempdir().expect("temp");
        let studio = env(temp.path(), "conv-1");
        let init = init(&studio, &args("init", "com.acme.notes")).expect("init");
        let plugin_dir = PathBuf::from(init["pluginDir"].as_str().expect("dir"));
        let manager = PluginManager::load_for_test(
            temp.path(),
            Arc::new(Db::open_in_memory().expect("db")),
            &Settings::default(),
            false,
        )
        .expect("manager");
        let inspection = manager
            .inspect_authoring_folder(&plugin_dir)
            .expect("inspection");
        assert_eq!(inspection.manifest.id, "com.acme.notes");
        let pack = pack(&plugin_dir, &studio).expect("pack");
        let package_path = PathBuf::from(pack["packagePath"].as_str().expect("package"));
        let record = manager
            .install_for_activation(&package_path)
            .expect("install disabled");
        assert_eq!(record.id, "com.acme.notes");
        assert!(!record.active);
        assert_eq!(record.disabled_reason.as_deref(), Some("activation_required"));
    }

    #[test]
    fn workspace_target_requires_trust_and_stays_under_the_workspace() {
        let temp = tempfile::tempdir().expect("temp");
        let workspace_root = temp.path().join("project");
        std::fs::create_dir_all(&workspace_root).expect("workspace");
        let trusted = WorkspaceHandle {
            root: workspace_root.clone(),
            trusted: true,
            internal: false,
            permission_mode: crate::domain::PermissionMode::Autonomous,
        };
        let studio = StudioEnv {
            data_dir: temp.path(),
            conversation_id: "conv-1",
            workspace: Some(&trusted),
        };
        let mut args = args("init", "com.acme.notes");
        args.target = Some("workspace".to_string());
        let init_result = init(&studio, &args).expect("workspace init");
        let plugin_dir = PathBuf::from(init_result["pluginDir"].as_str().expect("dir"));
        assert!(plugin_dir.starts_with(workspace_root.join("plugins")));

        let untrusted = WorkspaceHandle {
            trusted: false,
            ..trusted.clone()
        };
        let rejected = StudioEnv {
            data_dir: temp.path(),
            conversation_id: "conv-1",
            workspace: Some(&untrusted),
        };
        assert!(init(&rejected, &args).is_err());
    }

    #[test]
    fn signing_material_cannot_be_read_or_written() {
        let temp = tempfile::tempdir().expect("temp");
        let studio = env(temp.path(), "conv-1");
        init(&studio, &args("init", "com.acme.notes")).expect("init");
        let mut read = args("read", "com.acme.notes");
        read.plugin = Some("com.acme.notes".to_string());
        read.path = Some(KEY_FILE.to_string());
        assert!(read_file(&studio, &read).is_err());
        let mut write = args("write", "com.acme.notes");
        write.plugin = Some("com.acme.notes".to_string());
        write.path = Some(STUDIO_FILE.to_string());
        write.content = Some("{}".to_string());
        assert!(write_file(&studio, &write).is_err());
    }

    #[test]
    fn declarative_and_trusted_templates_validate() {
        for template in ["declarative", "trusted"] {
            let temp = tempfile::tempdir().expect("temp");
            let studio = env(temp.path(), "conv-1");
            let mut args = args("init", "com.acme.notes");
            args.template = Some(template.to_string());
            let init = init(&studio, &args).expect("init");
            let plugin_dir = PathBuf::from(init["pluginDir"].as_str().expect("dir"));
            let package = authoring::inspect_authoring_folder(&plugin_dir).expect("valid template");
            assert_eq!(package.manifest.id, "com.acme.notes");
        }
    }
}
