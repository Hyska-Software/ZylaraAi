//! Chat prompt/tool snapshot identity helpers (F2a, PLAN §4.2/§4.3).
//!
//! The Chat request must reuse the **exact** same system prompt and tool catalog
//! across the turns of a session (cacheable prefix). These pure helpers build
//! the persisted identity used by `prompt_snapshots`:
//!
//! - [`config_hash`] covers every input that can change the prompt text
//!   (model display name, turn gates, user instructions, code timeout, skills
//!   catalog) plus the canonical tool catalog ([`tools_hash`]);
//! - [`snapshot_key`] concatenates provider/model/profile/workspace,
//!   `PROMPT_VERSION` and that hash;
//! - [`canonical_tools`]/[`tools_json`]/[`parse_tools`] give the tool catalog a
//!   fixed order and a stable JSON representation, so two turns serialize
//!   byte-for-byte and a restart can deserialize the frozen catalog.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::catalog::ModelInfo;
use crate::domain::{Settings, TurnOptions};
use crate::providers::ToolDefinition;
use crate::tools::skills::Skill;

/// Profile string used in the Chat snapshot key.
pub const PROFILE_CHAT: &str = "chat";
/// Profile string used in the Code snapshot key.
pub const PROFILE_CODE: &str = "code";

/// SHA-256 of `bytes` as lowercase hex (64 chars).
fn sha256_hex(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// SHA-256 hex of an arbitrary text (used for `stable_hash`/`config_hash`).
pub fn stable_hash(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

/// Canonical tool catalog: fixed order (sorted by wire name) regardless of the
/// registry iteration order.
pub fn canonical_tools(tools: &[ToolDefinition]) -> Vec<ToolDefinition> {
    let mut canonical = tools.to_vec();
    canonical.sort_by(|left, right| left.name.cmp(&right.name));
    canonical
}

fn tools_array(tools: &[ToolDefinition]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                })
            })
            .collect(),
    )
}

/// Stable JSON of the canonical tool catalog (persisted as
/// `prompt_snapshots.tools_json`). `serde_json` serializes object keys in a
/// deterministic (sorted) order because the crate does not enable
/// `preserve_order`.
pub fn tools_json(tools: &[ToolDefinition]) -> String {
    let canonical = canonical_tools(tools);
    serde_json::to_string(&tools_array(&canonical)).unwrap_or_else(|_| "[]".to_string())
}

/// Hash of the canonical tool catalog, persisted as
/// `prompt_snapshots.tools_hash`.
pub fn tools_hash(tools: &[ToolDefinition]) -> String {
    stable_hash(&tools_json(tools))
}

/// Deserializes a persisted `tools_json` back into the frozen catalog.
///
/// `None` when the stored value is not the canonical array shape (the caller
/// rebuilds the snapshot instead of failing the turn).
pub fn parse_tools(tools_json: &str) -> Option<Vec<ToolDefinition>> {
    let value: Value = serde_json::from_str(tools_json).ok()?;
    let items = value.as_array()?;
    let mut tools = Vec::with_capacity(items.len());
    for item in items {
        let object = item.as_object()?;
        let name = object.get("name")?.as_str()?.to_string();
        let description = object
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let parameters = object.get("parameters").cloned().unwrap_or(Value::Null);
        tools.push(ToolDefinition {
            name,
            description,
            parameters,
        });
    }
    Some(canonical_tools(&tools))
}

/// Hash of every Chat prompt input that can change the frozen text.
///
/// Includes the model display name (it appears in the prompt), the effective
/// turn gates, the user instructions/override, the code timeout, the skills
/// catalog (name/source/description — the body/path do not reach the prompt)
/// and the canonical tool catalog.
pub fn config_hash(
    model: &ModelInfo,
    options: &TurnOptions,
    settings: &Settings,
    skills: &[Skill],
    tools: &[ToolDefinition],
) -> String {
    let mut disabled = settings.disabled_skills.clone();
    disabled.sort();
    disabled.dedup();
    let mut skills: Vec<&Skill> = skills.iter().collect();
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    let skills: Vec<Value> = skills
        .iter()
        .map(|skill| {
            json!({
                "name": skill.name,
                "source": skill.source_label(),
                "description": skill.description,
            })
        })
        .collect();
    let canonical = json!({
        "version": 1,
        "model": { "id": model.id, "name": model.name },
        "options": {
            "webSearch": options.web_search,
            "createFiles": options.create_files,
            "runCode": options.run_code,
            "systemPromptOverride": options.system_prompt_override.as_deref().unwrap_or(""),
            "pluginFingerprint": options.plugin_fingerprint,
        },
        "settings": {
            "locale": settings.locale,
            "systemPrompt": settings.system_prompt,
            "codeTimeoutSecs": settings.code_timeout_secs,
            "webSearchEnabled": settings.web_search_enabled,
            "fileCreationEnabled": settings.file_creation_enabled,
            "codeExecutionEnabled": settings.code_execution_enabled,
            "disabledSkills": disabled,
        },
        "skills": skills,
        "toolsHash": tools_hash(tools),
    });
    // `Value` maps are BTreeMap (no `preserve_order`), so this is stable.
    stable_hash(&canonical.to_string())
}

/// Hash of every **stable** Code prompt input that can change the frozen text.
///
/// Includes the model/environment, workspace name/path, repository instruction
/// content (`AGENTS.md`/`CLAUDE.md`/`.zylara/instructions.md`),
/// detected project (kind/name/checks), platform, shell/delegation gates and the
/// canonical tool catalog. The volatile session state (git, tree, todos, plan,
/// permission mode) is intentionally **absent**: it goes to `surface_items`,
/// never to the frozen system prompt (F3a).
#[allow(clippy::too_many_arguments)]
pub fn code_config_hash(
    model: &ModelInfo,
    workspace_name: Option<&str>,
    workspace_path: Option<&str>,
    agents_md: Option<&str>,
    project: Option<&crate::domain::ProjectInfo>,
    platform: &str,
    shell_enabled: bool,
    delegation_depth: u32,
    system_prompt_override: Option<&str>,
    locale: &str,
    plugin_fingerprint: &str,
    tools: &[ToolDefinition],
) -> String {
    let project = project.map(|project| {
        json!({
            "kind": project.kind,
            "name": project.name,
            "checks": project
                .checks
                .iter()
                .map(|check| json!({
                    "id": check.id,
                    "label": check.label,
                    "command": check.command,
                }))
                .collect::<Vec<_>>(),
            "checkedEcosystems": project.checked_ecosystems,
        })
    });
    let canonical = json!({
        "version": 1,
        "kind": "code-prompt-config",
        "model": { "id": model.id },
        "workspace": { "name": workspace_name, "path": workspace_path },
        "agentsMdHash": agents_md.map(stable_hash),
        "project": project,
        "platform": platform,
        "shellEnabled": shell_enabled,
        "delegationDepth": delegation_depth,
        "systemPromptOverride": system_prompt_override.unwrap_or(""),
        "locale": locale,
        "pluginFingerprint": plugin_fingerprint,
        "toolsHash": tools_hash(tools),
    });
    stable_hash(&canonical.to_string())
}

/// Persisted snapshot identity:
/// `provider_id|model_id|profile|workspace_id|prompt_version|config_hash`.
pub fn snapshot_key(
    provider_id: &str,
    model_id: &str,
    profile: &str,
    workspace_id: Option<&str>,
    prompt_version: u32,
    config_hash: &str,
) -> String {
    format!(
        "{provider_id}|{model_id}|{profile}|{}|{prompt_version}|{config_hash}",
        workspace_id.unwrap_or("-")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Modalities;
    use crate::domain::{Settings, TurnOptions};
    use crate::tools::skills::{Skill, SkillSource};
    use std::path::PathBuf;

    fn model() -> ModelInfo {
        ModelInfo {
            id: "deepseek-v4.1-flash".to_string(),
            name: "DeepSeek V4.1 Flash".to_string(),
            family: "deepseek".to_string(),
            protocols: vec!["openai-chat".to_string()],
            reasoning: false,
            reasoning_options: Vec::new(),
            attachment: false,
            modalities: Modalities::default(),
            context_window: 100_000,
            max_output: 8_000,
            cost: None,
            release_date: None,
            knowledge: None,
            open_weights: true,
            description: None,
            tags: Vec::new(),
            status: "stable".to_string(),
            estimated: false,
            cache: None,
        }
    }

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("descrição de {name}"),
            parameters: json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
            }),
        }
    }

    fn skills() -> Vec<Skill> {
        vec![
            Skill {
                name: "zeta".to_string(),
                description: "Skill Z".to_string(),
                body: "# Z".to_string(),
                dir: PathBuf::from("/data/skills/zeta"),
                source: SkillSource::User,
                plugin_id: None,
            },
            Skill {
                name: "alpha".to_string(),
                description: "Skill A".to_string(),
                body: "# A".to_string(),
                dir: PathBuf::from("/data/skills-bundled/alpha"),
                source: SkillSource::Bundled,
                plugin_id: None,
            },
        ]
    }

    fn config_inputs() -> (
        ModelInfo,
        TurnOptions,
        Settings,
        Vec<Skill>,
        Vec<ToolDefinition>,
    ) {
        (
            model(),
            TurnOptions::default(),
            Settings::default(),
            skills(),
            vec![tool("fetch_url"), tool("web_search")],
        )
    }

    #[test]
    fn canonical_tools_are_sorted_and_stable() {
        let tools = vec![tool("web_search"), tool("fetch_url")];
        let canonical = canonical_tools(&tools);
        assert_eq!(
            canonical
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            vec!["fetch_url", "web_search"]
        );
        // Two builds of the same catalog serialize identically.
        assert_eq!(tools_json(&tools), tools_json(&canonical));
        assert_eq!(tools_hash(&tools), tools_hash(&canonical));
    }

    #[test]
    fn tools_json_roundtrips() {
        let tools = vec![tool("fetch_url"), tool("web_search")];
        let json = tools_json(&tools);
        let parsed = parse_tools(&json).expect("tools_json canônico");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "fetch_url");
        assert_eq!(parsed[1].name, "web_search");
        assert_eq!(parsed[0].parameters, tool("fetch_url").parameters);
        assert_eq!(tools_json(&parsed), json, "roundtrip byte-a-byte");
        assert!(parse_tools("not-json").is_none());
        let empty = parse_tools("[]").expect("array vazio é canônico");
        assert!(empty.is_empty());
    }

    #[test]
    fn config_hash_is_stable_for_the_same_inputs() {
        let (model, options, settings, skills, tools) = config_inputs();
        let first = config_hash(&model, &options, &settings, &skills, &tools);
        let second = config_hash(&model, &options, &settings, &skills, &tools);
        assert_eq!(first, second);
        assert_eq!(first.len(), 64, "sha256 hex");
        // A ordem recebida das skills/tools não muda o hash.
        let reversed_skills: Vec<Skill> = skills.into_iter().rev().collect();
        let reversed_tools: Vec<ToolDefinition> = tools.into_iter().rev().collect();
        assert_eq!(
            first,
            config_hash(
                &model,
                &options,
                &settings,
                &reversed_skills,
                &reversed_tools
            )
        );
    }

    #[test]
    fn config_hash_includes_the_plugin_fingerprint() {
        let (model, options, settings, skills, tools) = config_inputs();
        let base = config_hash(&model, &options, &settings, &skills, &tools);
        let mut changed = options.clone();
        changed.plugin_fingerprint = "plugins:com.acme.notes:1.2.0".to_string();
        assert_ne!(
            base,
            config_hash(&model, &changed, &settings, &skills, &tools)
        );
    }

    #[test]
    fn config_hash_changes_with_prompt_inputs() {
        let (model, options, settings, skills, tools) = config_inputs();
        let base = config_hash(&model, &options, &settings, &skills, &tools);

        // system prompt do usuário
        let mut changed = settings.clone();
        changed.system_prompt = "Sempre responda de forma poética.".to_string();
        assert_ne!(
            base,
            config_hash(&model, &options, &changed, &skills, &tools)
        );

        // gate do turno
        let mut changed = options.clone();
        changed.run_code = false;
        assert_ne!(
            base,
            config_hash(&model, &changed, &settings, &skills, &tools)
        );

        // timeout de execução
        let mut changed = settings.clone();
        changed.code_timeout_secs = 300;
        assert_ne!(
            base,
            config_hash(&model, &options, &changed, &skills, &tools)
        );

        // catálogo de skills (nome/descrição)
        let mut changed = skills.clone();
        changed[0].description = "outra".to_string();
        assert_ne!(
            base,
            config_hash(&model, &options, &settings, &changed, &tools)
        );

        // catálogo de tools
        let changed = vec![tool("fetch_url")];
        assert_ne!(
            base,
            config_hash(&model, &options, &settings, &skills, &changed)
        );

        // modelo (nome aparece no prompt)
        let mut changed = model.clone();
        changed.name = "Outro nome".to_string();
        assert_ne!(
            base,
            config_hash(&changed, &options, &settings, &skills, &tools)
        );
    }

    #[test]
    fn snapshot_key_carries_every_identity_part() {
        let key = snapshot_key(
            "opencode-go",
            "deepseek-v4.1-flash",
            PROFILE_CHAT,
            None,
            7,
            "abc123",
        );
        assert_eq!(key, "opencode-go|deepseek-v4.1-flash|chat|-|7|abc123");
        let with_workspace = snapshot_key("p", "m", PROFILE_CHAT, Some("ws-1"), 7, "abc123");
        assert!(with_workspace.contains("|ws-1|7|"));
        assert_ne!(key, with_workspace);
        // PROMPT_VERSION participa da identidade: bump = snapshot novo.
        let bumped = snapshot_key(
            "opencode-go",
            "deepseek-v4.1-flash",
            PROFILE_CHAT,
            None,
            8,
            "abc123",
        );
        assert_ne!(key, bumped);
    }

    #[test]
    fn code_config_hash_covers_the_stable_prompt_inputs() {
        let tools = vec![tool("read_file"), tool("edit_file")];
        let project = crate::domain::ProjectInfo {
            kind: "node".to_string(),
            name: Some("zylara".to_string()),
            checks: vec![crate::domain::ProjectCheckInfo {
                id: "test".to_string(),
                label: "Testes".to_string(),
                command: "pnpm test".to_string(),
            }],
            checked_ecosystems: vec!["node".to_string()],
        };
        let base = code_config_hash(
            &model(),
            Some("demo"),
            Some("C:/dev/zylara"),
            Some("# Regras do projeto"),
            Some(&project),
            "Windows",
            true,
            0,
            None,
            "pt-BR",
            "",
            &tools,
        );
        // Estável com os mesmos inputs.
        assert_eq!(
            base,
            code_config_hash(
                &model(),
                Some("demo"),
                Some("C:/dev/zylara"),
                Some("# Regras do projeto"),
                Some(&project),
                "Windows",
                true,
                0,
                None,
                "pt-BR",
                "",
                &tools,
            )
        );
        assert_eq!(base.len(), 64);

        // AGENTS.md/CLAUDE.md, projeto, workspace, platform, shell, delegation, override
        // e catálogo de tools mudam a identidade do snapshot.
        assert_ne!(
            base,
            code_config_hash(
                &model(),
                Some("demo"),
                Some("C:/dev/zylara"),
                Some("# Outras regras"),
                Some(&project),
                "Windows",
                true,
                0,
                None,
                "pt-BR",
                "",
                &tools
            )
        );
        let other_project = crate::domain::ProjectInfo {
            kind: "rust".to_string(),
            name: None,
            checks: Vec::new(),
            checked_ecosystems: Vec::new(),
        };
        assert_ne!(
            base,
            code_config_hash(
                &model(),
                Some("demo"),
                Some("C:/dev/zylara"),
                Some("# Regras do projeto"),
                Some(&other_project),
                "Windows",
                true,
                0,
                None,
                "pt-BR",
                "",
                &tools
            )
        );
        assert_ne!(
            base,
            code_config_hash(
                &model(),
                Some("demo"),
                Some("C:/dev/zylara"),
                Some("# Regras do projeto"),
                Some(&project),
                "Linux",
                false,
                1,
                Some("foco em testes"),
                "pt-BR",
                "",
                &tools
            )
        );
        assert_ne!(
            base,
            code_config_hash(
                &model(),
                Some("demo"),
                Some("C:/dev/zylara"),
                Some("# Regras do projeto"),
                Some(&project),
                "Windows",
                true,
                0,
                None,
                "pt-BR",
                "",
                &[tool("read_file")]
            )
        );
        // The UI language is part of the prompt, so it invalidates the snapshot.
        assert_ne!(
            base,
            code_config_hash(
                &model(),
                Some("demo"),
                Some("C:/dev/zylara"),
                Some("# Regras do projeto"),
                Some(&project),
                "Windows",
                true,
                0,
                None,
                "en",
                "",
                &tools
            )
        );
    }
}
