//! Tauri commands for the Agentes layout.
//!
//! The command layer validates catalog references (provider/model) and maps
//! domain errors to the stable `AGENT_*` codes consumed by the renderer.

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::agents::{
    Agent, AgentAvatar, AgentExportDocument, AgentInput, AgentMemory, AgentMemoryInput,
    AgentRevision, AgentSharedMemory, AgentThreadCursor, AgentThreadPage, AgentUsage, UsageStats,
};
use crate::harness::{self, HarnessDeps};
use crate::state::AppState;
use serde_json::Value;

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

fn validate_workspace(state: &AppState, input: &AgentInput) -> Result<(), String> {
    let Some(workspace_id) = input.workspace_id.as_deref() else {
        return Ok(());
    };
    let workspace = state
        .db
        .get_workspace(workspace_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args(
                "agents.commands.workspaceMissing",
                &[("workspace_id", &workspace_id)],
            )
        })?;
    if !workspace.trusted {
        return Err(crate::i18n::t_args(
            "agents.commands.workspaceUntrusted",
            &[("path", &workspace.path)],
        ));
    }
    Ok(())
}

fn validate_fallback(state: &AppState, input: &AgentInput) -> Result<(), String> {
    match (
        input.fallback_provider_id.as_deref(),
        input.fallback_model_id.as_deref(),
    ) {
        (None, None) => Ok(()),
        (Some(provider_id), Some(model_id)) => {
            if provider_id == input.provider_id && model_id == input.model_id {
                return Ok(());
            }
            let known_provider = state.provider(provider_id).is_some()
                || state.dynamic_models_for(provider_id).is_some();
            if !known_provider {
                return Err(crate::i18n::t_args(
                    "agents.commands.fallbackProviderMissing",
                    &[("provider_id", &provider_id)],
                ));
            }
            if state.model(provider_id, model_id).is_none() {
                return Err(crate::i18n::t_args(
                    "agents.commands.fallbackModelMismatch",
                    &[("model_id", &model_id), ("provider_id", &provider_id)],
                ));
            }
            Ok(())
        }
        _ => Err(
            crate::i18n::t("agents.errors.fallbackPairRequired").to_string(),
        ),
    }
}

/// A plugin template is a gallery starting point, never an authority: the agent
/// must keep every capability the template disabled, and the origin is recorded
/// in `plugin_audit` so the store UI can explain where the persona came from.
/// `true` when the agent enables something the template disabled. Capabilities
/// are deny-only, so a `false` in the template must stay `false` and a narrowed
/// list must stay a subset (`null` means "all", which is wider).
fn template_capability_widened(allowed: &Value, current: &Value) -> bool {
    match allowed {
        Value::Bool(false) => current.as_bool() == Some(true),
        Value::Array(list) => match current {
            Value::Null => true,
            Value::Array(chosen) => !chosen.iter().all(|item| list.contains(item)),
            _ => true,
        },
        _ => false,
    }
}

fn validate_template(state: &AppState, input: &AgentInput) -> Result<(), String> {
    let Some(reference) = input.template.as_ref() else {
        return Ok(());
    };
    let manager = crate::plugins::global_manager()
        .ok_or_else(|| crate::i18n::t("agents.commands.templateUnknown").to_string())?;
    let template = manager
        .agent_templates()
        .into_iter()
        .find(|entry| entry.plugin_id == reference.plugin_id && entry.id == reference.template_id)
        .ok_or_else(|| {
            crate::i18n::t_args(
                "agents.commands.templateUnknown",
                &[
                    ("plugin_id", &reference.plugin_id),
                    ("template_id", &reference.template_id),
                ],
            )
        })?;
    let narrowed = template
        .capabilities
        .as_object()
        .ok_or_else(|| crate::i18n::t("agents.commands.templateInvalid").to_string())?;
    let input_capabilities = serde_json::to_value(&input.capabilities)
        .map_err(|error| format!("AGENT_TEMPLATE_INVALID: {error}"))?;
    for (key, value) in narrowed {
        let current = input_capabilities.get(key).cloned().unwrap_or(Value::Null);
        if template_capability_widened(value, &current) {
            return Err(crate::i18n::t_args(
                "agents.commands.templateWidened",
                &[("capability", key)],
            ));
        }
    }
    let digest = format!("{}:{}", reference.plugin_id, reference.template_id);
    // Audit is evidence, not a gate: a write failure must not block the creation.
    if let Err(error) = state
        .db
        .plugin_audit(&reference.plugin_id, "agent.template", Some(&digest), "applied")
    {
        eprintln!("[agents] template audit failed: {error}");
    }
    Ok(())
}

fn validate_model(state: &AppState, input: &AgentInput) -> Result<(), String> {
    let known_provider = state.provider(&input.provider_id).is_some()
        || state.dynamic_models_for(&input.provider_id).is_some();
    if !known_provider {
        return Err(crate::i18n::t_args(
            "agents.commands.providerMissing",
            &[("provider_id", &input.provider_id)],
        ));
    }
    // Account-only models (ChatGPT plan / Anthropic account list) are valid
    // routes too: resolve through the same merged view as the harness.
    if state
        .model(&input.provider_id, &input.model_id)
        .is_none()
    {
        return Err(crate::i18n::t_args(
            "agents.commands.modelMismatch",
            &[
                ("model_id", &input.model_id),
                ("provider_id", &input.provider_id),
            ],
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn list_agents(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> Result<Vec<Agent>, String> {
    state
        .db
        .list_agents(include_archived.unwrap_or(false))
        .map_err(to_error)
}

#[tauri::command]
pub fn get_agent(state: State<'_, AppState>, agent_id: String) -> Result<Agent, String> {
    state
        .db
        .get_agent(&agent_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("agents.commands.notFound", &[("agent_id", &agent_id)])
        })
}

#[tauri::command]
pub fn create_agent(state: State<'_, AppState>, input: AgentInput) -> Result<Agent, String> {
    create_agent_validated(&state, input)
}

/// Shared by the Tauri command and the `create_agent` tool.
pub(crate) fn create_agent_validated(
    state: &AppState,
    input: AgentInput,
) -> Result<Agent, String> {
    let input = crate::agents::normalize_input(input).map_err(to_error)?;
    validate_model(state, &input)?;
    validate_fallback(state, &input)?;
    validate_workspace(state, &input)?;
    validate_template(state, &input)?;
    state.db.create_agent(&input).map_err(to_error)
}

#[tauri::command]
pub fn update_agent(
    state: State<'_, AppState>,
    agent_id: String,
    input: AgentInput,
) -> Result<Agent, String> {
    let input = crate::agents::normalize_input(input).map_err(to_error)?;
    validate_model(&state, &input)?;
    validate_fallback(&state, &input)?;
    validate_workspace(&state, &input)?;
    validate_template(&state, &input)?;
    state.db.update_agent(&agent_id, &input).map_err(to_error)
}

#[tauri::command]
pub fn set_agent_pinned(
    state: State<'_, AppState>,
    agent_id: String,
    pinned: bool,
) -> Result<Agent, String> {
    state
        .db
        .set_agent_pinned(&agent_id, pinned)
        .map_err(to_error)
}

#[tauri::command]
pub fn reorder_agents(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.reorder_agents(&ids).map_err(to_error)
}

#[tauri::command]
pub fn archive_agent(state: State<'_, AppState>, agent_id: String) -> Result<Agent, String> {
    state.db.archive_agent(&agent_id).map_err(to_error)
}

#[tauri::command]
pub fn restore_agent(state: State<'_, AppState>, agent_id: String) -> Result<Agent, String> {
    state.db.restore_agent(&agent_id).map_err(to_error)
}

#[tauri::command]
pub fn delete_agent(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    let conversations = state
        .db
        .list_conversations_for_agent(&agent_id)
        .map_err(to_error)?;
    for conversation in &conversations {
        state.cancel_conversation(&conversation.id);
    }
    state.db.delete_agent(&agent_id).map_err(to_error)?;
    for conversation in conversations {
        state.terminals.close_conversation(&conversation.id);
        if let Some(browser) = crate::computer::browser::global() {
            browser.close(&conversation.id);
        }
        let _ = state
            .db
            .end_computer_session(&conversation.id, "stopped", crate::domain::now_ms());
        if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT
            && conversation.workspace_id.is_none()
        {
            let dir = crate::harness::agent_workspace::path(&state.data_dir, &conversation.id);
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_agent_threads(
    state: State<'_, AppState>,
    agent_id: String,
    cursor: Option<AgentThreadCursor>,
    limit: Option<u32>,
) -> Result<AgentThreadPage, String> {
    state
        .db
        .list_agent_threads(&agent_id, cursor.as_ref(), limit)
        .map_err(to_error)
}

#[tauri::command]
pub fn list_agent_memories(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<Vec<AgentMemory>, String> {
    state.db.list_agent_memories(&agent_id).map_err(to_error)
}

#[tauri::command]
pub fn create_agent_memory(
    state: State<'_, AppState>,
    agent_id: String,
    input: AgentMemoryInput,
) -> Result<AgentMemory, String> {
    let input = input.normalize()?;
    state
        .db
        .create_agent_memory(&agent_id, &input)
        .map_err(to_error)
}

#[tauri::command]
pub fn update_agent_memory(
    state: State<'_, AppState>,
    agent_id: String,
    memory_id: String,
    input: AgentMemoryInput,
) -> Result<AgentMemory, String> {
    let input = input.normalize()?;
    state
        .db
        .update_agent_memory(&agent_id, &memory_id, &input)
        .map_err(to_error)
}

#[tauri::command]
pub fn delete_agent_memory(
    state: State<'_, AppState>,
    agent_id: String,
    memory_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_agent_memory(&agent_id, &memory_id)
        .map_err(to_error)
}

#[tauri::command]
pub fn list_shared_agent_memories(
    state: State<'_, AppState>,
) -> Result<Vec<AgentSharedMemory>, String> {
    state.db.list_agent_shared_memories().map_err(to_error)
}

#[tauri::command]
pub fn delete_shared_agent_memory(
    state: State<'_, AppState>,
    memory_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_shared_memory(&memory_id)
        .map_err(to_error)
}

#[tauri::command]
pub fn clear_agent_memories(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<u64, String> {
    state.db.clear_agent_memories(&agent_id).map_err(to_error)
}

#[tauri::command]
pub fn get_agent_usage(
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<AgentUsage, String> {
    state.db.get_agent_usage(&agent_id).map_err(to_error)
}

#[tauri::command]
pub fn list_agent_usage(state: State<'_, AppState>) -> Result<Vec<AgentUsage>, String> {
    state.db.list_agent_usage().map_err(to_error)
}

#[tauri::command]
pub fn get_usage_stats(
    state: State<'_, AppState>,
    since: Option<i64>,
) -> Result<UsageStats, String> {
    state.db.usage_stats(since).map_err(to_error)
}

#[tauri::command]
pub fn duplicate_agent(state: State<'_, AppState>, agent_id: String) -> Result<Agent, String> {
    let current = state
        .db
        .get_agent(&agent_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("agents.commands.notFound", &[("agent_id", &agent_id)])
        })?;
    let name = crate::i18n::t_args(
        "agents.commands.duplicateName",
        &[("name", &current.name)],
    );
    let name: String = name.chars().take(40).collect();
    let input = AgentInput {
        name,
        role: current.role,
        description: current.description,
        avatar: current.avatar,
        department: current.department,
        provider_id: current.provider_id,
        model_id: current.model_id,
        fallback_provider_id: current.fallback_provider_id,
        fallback_model_id: current.fallback_model_id,
        reasoning: current.reasoning,
        instructions: current.instructions,
        starters: current.starters,
        capabilities: current.capabilities,
        memory_enabled: current.memory_enabled,
        workspace_id: current.workspace_id,
        permission_mode: current.permission_mode,
        docker_image: current.docker_image,
        computer_environment: current.computer_environment,
        template: None,
    };
    let input = crate::agents::normalize_input(input).map_err(to_error)?;
    validate_model(&state, &input)?;
    validate_fallback(&state, &input)?;
    validate_workspace(&state, &input)?;
    state.db.create_agent(&input).map_err(to_error)
}

#[tauri::command]
pub fn set_agent_avatar(
    state: State<'_, AppState>,
    agent_id: String,
    avatar: AgentAvatar,
) -> Result<Agent, String> {
    let avatar = crate::agents::normalize_avatar(avatar).map_err(to_error)?;
    state
        .db
        .update_agent_avatar(&agent_id, &avatar)
        .map_err(to_error)
}

#[tauri::command]
pub fn import_agent_avatar_image(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("falha ao ler a imagem: {error}"))?;
    if !metadata.is_file() {
        return Err(crate::i18n::t("agents.commands.avatarNotFile"));
    }
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("AGENT_AVATAR_TOO_LARGE: a imagem passa de 10 MB.".to_string());
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("falha ao ler a imagem: {error}"))?;
    crate::agents::normalize_avatar_image(&bytes).map_err(to_error)
}

fn safe_file_stem(value: &str) -> String {
    let stem: String = value
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let stem = stem.trim_matches('-').to_lowercase();
    if stem.is_empty() {
        crate::i18n::t("agents.commands.defaultFileStem")
    } else {
        stem.chars().take(60).collect()
    }
}

/// Writes a portable `zylara-agent` JSON document through the native save dialog.
#[tauri::command]
pub fn export_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<Option<String>, String> {
    let agent = state
        .db
        .get_agent(&agent_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("agents.commands.notFound", &[("agent_id", &agent_id)])
        })?;
    let memories = state.db.list_agent_memories(&agent_id).map_err(to_error)?;
    let document = AgentExportDocument::from_agent(&agent, &memories);
    let json = serde_json::to_string_pretty(&document)
        .map_err(|error| crate::i18n::t_args(
        "agents.commands.serializeFailed",
        &[("error", &error.to_string())],
    ))?;
    let file_name = crate::i18n::t_args(
        "agents.commands.exportFileName",
        &[("name", &safe_file_stem(&agent.name))],
    );
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter(&crate::i18n::t("agents.commands.importType"), &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| {
            crate::i18n::t_args(
                "agents.commands.invalidDestination",
                &[("error", &error.to_string())],
            )
        })?;
    std::fs::write(&path, json)
        .map_err(|error| format!("falha ao gravar {}: {error}", path.display()))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Turns a natural-language brief into a validated agent draft. The renderer
/// opens the editor with this draft; nothing is persisted until the user saves.
#[tauri::command]
pub async fn suggest_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    provider_id: String,
    model_id: String,
) -> Result<AgentInput, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(crate::i18n::t("agents.commands.briefRequired"));
    }
    if prompt.chars().count() > 4_000 {
        return Err(crate::i18n::t("agents.errors.briefTooLong"));
    }
    let known_provider = state.provider(&provider_id).is_some()
        || state.dynamic_models_for(&provider_id).is_some();
    if !known_provider {
        return Err(crate::i18n::t_args(
            "agents.commands.providerMissing",
            &[("provider_id", &provider_id)],
        ));
    }
    if state.model(&provider_id, &model_id).is_none() {
        return Err(crate::i18n::t_args(
            "agents.commands.modelMismatch",
            &[("model_id", &model_id), ("provider_id", &provider_id)],
        ));
    }
    // Clone the state pieces before awaiting; the command does not hold the
    // Tauri state guard across the provider call.
    let deps = HarnessDeps {
        app: Some(app.clone()),
        db: state.db.clone(),
        http: state.http.clone(),
        search_http: state.search_http.clone(),
        catalog: state.catalog_with_plugins(),
        data_dir: None,
        skills_roots: Some(Vec::new()),
        approvals: None,
        observed: None,
        jobs: None,
        questions: None,
        mcp: None,
        streamer: None,
        api_key_override: None,
        credential_override: None,
        refresh_override: None,
        model_source: None,
    };
    let system = format!(
        "You design AI agent personas for Zylara, a desktop AI workspace. \
         Reply with ONLY one JSON object, no markdown fences and no commentary. \
         Keys: name (<=40 chars), role (<=80), description (<=500, one sentence), \
         emoji (one emoji), department (<=40), instructions (3-8 short sentences in \
         {language}: identity, priorities, tone and working method), and \
         starters (array of 1-3 short prompts in {language}). \
         Never claim permissions or tools; the app controls those.",
        language = crate::i18n::prompt_name(),
    );
    let user = format!(
        "Create an agent for this brief:\n\n{prompt}\n\n\
         The agent will run on Zylara. Keep the instructions concrete, safe and useful."
    );
    let text = harness::batch::complete_text(
        &deps,
        harness::batch::BatchRequest {
            provider_id: &provider_id,
            model_id: &model_id,
            timeouts: crate::providers::StreamTimeouts::from_settings(
                &crate::config::load_settings(&app),
            ),
            system_prompt: &system,
            user_text: &user,
            max_output_tokens: 2_048,
            temperature: Some(0.4),
            reasoning: crate::providers::ReasoningRequest::Auto,
        },
    )
    .await
    .map_err(|error| format!("AGENT_SUGGEST_FAILED: {error:#}"))?;
    let json = extract_json_object(&text)
        .ok_or_else(|| crate::i18n::t("agents.commands.suggestNoJson"))?;
    let value: serde_json::Value = serde_json::from_str(&json)
        .map_err(|error| {
            crate::i18n::t_args(
                "agents.commands.suggestInvalidJson",
                &[("error", &error.to_string())],
            )
        })?;
    let name = value
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let role = value
        .get("role")
        .and_then(|value| value.as_str())
        .unwrap_or("Assistente")
        .trim()
        .to_string();
    let description = value
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let emoji = value
        .get("emoji")
        .and_then(|value| value.as_str())
        .unwrap_or("🤖")
        .trim()
        .to_string();
    let department = value
        .get("department")
        .and_then(|value| value.as_str())
        .unwrap_or("Geral")
        .trim()
        .to_string();
    let instructions = value
        .get("instructions")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let starters = value
        .get("starters")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .take(3)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let input = AgentInput {
        name,
        role,
        description,
        avatar: crate::agents::AgentAvatar::emoji(emoji),
        department,
        provider_id,
        model_id,
        fallback_provider_id: None,
        fallback_model_id: None,
        reasoning: None,
        instructions,
        starters,
        capabilities: crate::agents::AgentCapabilities::default(),
        memory_enabled: false,
        workspace_id: None,
        permission_mode: crate::domain::PermissionMode::Autonomous,
        docker_image: None,
        computer_environment: "auto".to_string(),
        template: None,
    };
    crate::agents::normalize_input(input).map_err(to_error)
}

/// Proposes a conversational edit to an existing agent. Nothing is saved: the
/// renderer shows the field-level diff and the user applies (or discards) it.
#[tauri::command]
pub async fn revise_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    prompt: String,
    provider_id: String,
    model_id: String,
) -> Result<AgentRevision, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("AGENT_REVISION_INVALID: descreva o que deve mudar.".to_string());
    }
    if prompt.chars().count() > 4_000 {
        return Err("AGENT_REVISION_INVALID: o pedido passa de 4.000 caracteres.".to_string());
    }
    let agent = state
        .db
        .get_agent(&agent_id)
        .map_err(to_error)?
        .ok_or_else(|| {
            crate::i18n::t_args("agents.commands.notFound", &[("agent_id", &agent_id)])
        })?;
    let known_provider = state.provider(&provider_id).is_some()
        || state.dynamic_models_for(&provider_id).is_some();
    if !known_provider || state.model(&provider_id, &model_id).is_none() {
        return Err(crate::i18n::t_args(
            "agents.commands.routeUnavailable",
            &[("provider_id", &provider_id), ("model_id", &model_id)],
        ));
    }
    let before = AgentInput::from(&agent);
    let mut context = serde_json::to_value(&before)
        .map_err(|error| format!("AGENT_REVISION_FAILED: {error}"))?;
    if let Some(object) = context.as_object_mut() {
        object.remove("avatar");
    }
    let current = serde_json::to_string_pretty(&context)
        .map_err(|error| format!("AGENT_REVISION_FAILED: {error}"))?;
    let deps = HarnessDeps {
        app: Some(app.clone()),
        db: state.db.clone(),
        http: state.http.clone(),
        search_http: state.search_http.clone(),
        catalog: state.catalog_with_plugins(),
        data_dir: None,
        skills_roots: Some(Vec::new()),
        approvals: None,
        observed: None,
        jobs: None,
        questions: None,
        mcp: None,
        streamer: None,
        api_key_override: None,
        credential_override: None,
        refresh_override: None,
        model_source: None,
    };
    let system = format!(
        "You revise an existing AI agent for Zylara, a desktop AI workspace. \
         The current configuration is JSON. Reply with ONLY one JSON object containing \
         only the fields you changed. Allowed keys: name, role, description, \
         department, instructions, starters (array of 1-3 strings), memoryEnabled. \
         Keep the identity unless the user explicitly asks to change it. Write in \
         {language}. Never add tools, permissions, model routes or claims \
         about what the app allows. Do not wrap the JSON in markdown fences.",
        language = crate::i18n::prompt_name(),
    );
    let user = format!(
        "Current agent:\n{current}\n\nUser request:\n{prompt}\n\n\
         Return the minimal JSON patch that satisfies the request."
    );
    let text = harness::batch::complete_text(
        &deps,
        harness::batch::BatchRequest {
            provider_id: &provider_id,
            model_id: &model_id,
            timeouts: crate::providers::StreamTimeouts::from_settings(
                &crate::config::load_settings(&app),
            ),
            system_prompt: &system,
            user_text: &user,
            max_output_tokens: 2_048,
            temperature: Some(0.3),
            reasoning: crate::providers::ReasoningRequest::Auto,
        },
    )
    .await
    .map_err(|error| format!("AGENT_REVISION_FAILED: {error:#}"))?;
    let json = extract_json_object(&text).ok_or_else(|| {
        crate::i18n::t("agents.commands.revisionNoJson").to_string()
    })?;
    let partial: serde_json::Value = serde_json::from_str(&json)
        .map_err(|error| {
            crate::i18n::t_args(
                "agents.commands.revisionInvalidJson",
                &[("error", &error.to_string())],
            )
        })?;
    let after = crate::agents::apply_agent_revision(before.clone(), &partial)?;
    validate_model(&state, &after)?;
    validate_fallback(&state, &after)?;
    validate_workspace(&state, &after)?;
    let changes = crate::agents::agent_changes(&before, &after)
        .map_err(|error| format!("AGENT_REVISION_FAILED: {error}"))?;
    Ok(AgentRevision {
        agent_id,
        before,
        after,
        changes,
    })
}

fn extract_json_object(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(trimmed[start..=end].to_string())
}

/// Imports a `zylara-agent` JSON document selected through the native dialog.
#[tauri::command]
pub fn import_agent(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Agent>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter(&crate::i18n::t("agents.commands.importType"), &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| {
            crate::i18n::t_args(
                "agents.commands.invalidPath",
                &[("error", &error.to_string())],
            )
        })?;
    let raw = std::fs::read_to_string(&path).map_err(|error| {
        crate::i18n::t_args(
            "agents.commands.readExportFailed",
            &[("path", &path.display().to_string()), ("error", &error.to_string())],
        )
    })?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| crate::i18n::t_args(
        "agents.errors.importInvalidJson",
        &[("error", &error.to_string())],
    ))?;
    if value.get("version").and_then(|version| version.as_u64()) == Some(1) {
        crate::agents::upgrade_agent_export_v1(&mut value)?;
    }
    let document: AgentExportDocument = serde_json::from_value(value)
        .map_err(|error| crate::i18n::t_args(
        "agents.errors.importInvalidJson",
        &[("error", &error.to_string())],
    ))?;
    let document = document.normalize()?;
    validate_model(&state, &document.agent)?;
    validate_fallback(&state, &document.agent)?;
    validate_workspace(&state, &document.agent)?;
    let agent = state.db.create_agent(&document.agent).map_err(to_error)?;
    for memory in document.memories {
        state
            .db
            .create_agent_memory(&agent.id, &memory)
            .map_err(to_error)?;
    }
    Ok(Some(agent))
}

#[cfg(test)]
mod template_tests {
    use super::template_capability_widened;
    use serde_json::json;

    #[test]
    fn a_disabled_capability_cannot_be_re_enabled() {
        assert!(template_capability_widened(&json!(false), &json!(true)));
        assert!(!template_capability_widened(&json!(false), &json!(false)));
        // Absent (`null`) keeps the backend default, which is not a widening of
        // an explicit `false` only when the default is also off.
        assert!(!template_capability_widened(&json!(false), &json!(null)));
    }

    #[test]
    fn narrowed_lists_must_stay_subsets() {
        assert!(!template_capability_widened(
            &json!(["fs_read"]),
            &json!(["fs_read"])
        ));
        assert!(!template_capability_widened(&json!(["fs_read"]), &json!([])));
        assert!(template_capability_widened(
            &json!(["fs_read"]),
            &json!(["fs_read", "run_command"])
        ));
        // `null` means "every item", which is wider than any list.
        assert!(template_capability_widened(&json!(["fs_read"]), &json!(null)));
    }

    #[test]
    fn enabled_capabilities_are_ignored() {
        assert!(!template_capability_widened(&json!(true), &json!(true)));
        assert!(!template_capability_widened(&json!(true), &json!(false)));
    }
}
