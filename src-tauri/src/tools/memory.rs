//! Durable agent memory tool.
//!
//! Available only for turns of an agent with `memory_enabled`. The tool writes
//! to `agent_memories`, which is shared by every conversation of that persona;
//! the harness injects the stored memories as a volatile `surface_item`, never
//! into the cached system prompt.

use serde_json::{json, Value};

use crate::agents::AgentMemoryInput;
use crate::i18n;
use crate::providers::ToolDefinition;

use super::{json_str, ToolOutcome, ToolRuntime};

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "memory".to_string(),
        description: "Save, list or forget durable notes for this agent (shared by every \
                      conversation). Use it for stable facts, user preferences and procedures; \
                      never store secrets, credentials or transient state."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "save", "update", "forget"],
                    "description": "list stored memories; save/update a note; forget one note."
                },
                "content": {
                    "type": "string",
                    "description": "Required for save. Short, specific, self-contained note."
                },
                "kind": {
                    "type": "string",
                    "enum": ["fact", "preference", "procedure", "note"],
                    "description": "Optional classification for save (default: fact)."
                },
                "scope": {
                    "type": "string",
                    "enum": ["private", "shared"],
                    "description": "private (default) or shared across agents with sharedMemory."
                },
                "pinned": {
                    "type": "boolean",
                    "description": "Optional: pin a saved memory so it is always shown first."
                },
                "id": {
                    "type": "string",
                    "description": "Required for forget: memory id returned by list/save."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        }),
    }
}

pub fn run(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    let Some(agent_id) = rt.options.agent_id.as_deref() else {
        return ToolOutcome::error(i18n::t("tools.memory.requiresAgentTurn"));
    };
    if !rt.options.agent_memory {
        return ToolOutcome::error(i18n::t("tools.memory.disabled"));
    }
    run_with(&rt.db, agent_id, &rt.conversation_id, args)
}

/// Shared implementation for the Chat and Code profiles.
pub fn run_with(
    db: &crate::db::Db,
    agent_id: &str,
    conversation_id: &str,
    args: &Value,
) -> ToolOutcome {
    let action = json_str(args, "action")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let scope = json_str(args, "scope")
        .unwrap_or_else(|| "private".to_string())
        .trim()
        .to_ascii_lowercase();
    if !matches!(scope.as_str(), "private" | "shared") {
        return ToolOutcome::error(i18n::t("tools.memory.invalidScope"));
    }
    let shared_allowed = || -> Result<(), ToolOutcome> {
        match db.get_agent(agent_id) {
            Ok(Some(agent))
                if agent.memory_enabled && agent.capabilities.shared_memory =>
            {
                Ok(())
            }
            Ok(Some(_)) => Err(ToolOutcome::error(format!(
                "AGENT_CAPABILITY_DENIED: {}",
                i18n::t("tools.memory.sharedDenied")
            ))),
            Ok(None) => Err(ToolOutcome::error(format!(
                "AGENT_NOT_FOUND: {}",
                i18n::t("tools.memory.agentNotFound")
            ))),
            Err(error) => Err(ToolOutcome::error(format!("{error:#}"))),
        }
    };
    match action.as_str() {
        "list" => {
            if scope == "shared" {
                if let Err(outcome) = shared_allowed() {
                    return outcome;
                }
                return match db.list_agent_shared_memories() {
                    Ok(memories) => ToolOutcome {
                        content: serde_json::to_string_pretty(&memories)
                            .unwrap_or_else(|_| "[]".to_string()),
                        summary: Some(i18n::t_count(
                            "tools.memory.sharedSummary",
                            memories.len(),
                            &[("count", &memories.len().to_string())],
                        )),
                        ..Default::default()
                    },
                    Err(error) => ToolOutcome::error(i18n::t_args(
                        "tools.memory.listFailed",
                        &[("error", &format!("{error:#}"))],
                    )),
                };
            }
            match db.list_agent_memories(agent_id) {
                Ok(memories) => ToolOutcome {
                    content: serde_json::to_string_pretty(&memories)
                        .unwrap_or_else(|_| "[]".to_string()),
                    summary: Some(i18n::t_count(
                        "tools.memory.privateSummary",
                        memories.len(),
                        &[("count", &memories.len().to_string())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(i18n::t_args(
                    "tools.memory.listFailed",
                    &[("error", &format!("{error:#}"))],
                )),
            }
        }
        "save" => {
            let Some(content) = json_str(args, "content") else {
                return ToolOutcome::error(i18n::t("tools.memory.contentRequiredSave"));
            };
            let input = AgentMemoryInput {
                kind: json_str(args, "kind").unwrap_or_else(|| "fact".to_string()),
                content,
                source_conversation_id: Some(conversation_id.to_string()),
                pinned: args.get("pinned").and_then(Value::as_bool).unwrap_or(false),
            };
            let input = match input.normalize() {
                Ok(input) => input,
                Err(error) => return ToolOutcome::error(error),
            };
            if scope == "shared" {
                if let Err(outcome) = shared_allowed() {
                    return outcome;
                }
                return match db.create_agent_shared_memory(agent_id, &input) {
                    Ok(memory) => ToolOutcome {
                        content: serde_json::to_string_pretty(&json!({
                            "saved": true,
                            "scope": "shared",
                            "id": memory.id,
                            "kind": memory.kind,
                        }))
                        .unwrap_or_else(|_| "{\"saved\":true}".to_string()),
                        summary: Some(i18n::t("tools.memory.sharedSaved")),
                        ..Default::default()
                    },
                    Err(error) => ToolOutcome::error(i18n::t_args(
                        "tools.memory.saveFailed",
                        &[("error", &format!("{error:#}"))],
                    )),
                };
            }
            match db.create_agent_memory(agent_id, &input) {
                Ok(memory) => ToolOutcome {
                    content: serde_json::to_string_pretty(&json!({
                        "saved": true,
                        "scope": "private",
                        "id": memory.id,
                        "kind": memory.kind,
                    }))
                    .unwrap_or_else(|_| "{\"saved\":true}".to_string()),
                    summary: Some(i18n::t("tools.memory.saved")),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(i18n::t_args(
                    "tools.memory.saveFailed",
                    &[("error", &format!("{error:#}"))],
                )),
            }
        }
        "update" => {
            let Some(id) = json_str(args, "id") else {
                return ToolOutcome::error(i18n::t("tools.memory.idRequiredUpdate"));
            };
            let Some(content) = json_str(args, "content") else {
                return ToolOutcome::error(i18n::t("tools.memory.contentRequiredUpdate"));
            };
            if scope == "shared" {
                if let Err(outcome) = shared_allowed() {
                    return outcome;
                }
                let existing = match db.get_agent_shared_memory(id.trim()) {
                    Ok(Some(memory)) if memory.source_agent_id.as_deref() == Some(agent_id) => {
                        memory
                    }
                    Ok(Some(_)) => {
                        return ToolOutcome::error(format!(
                            "AGENT_MEMORY_FORBIDDEN: {}",
                            i18n::t("tools.memory.forbiddenOtherAgent")
                        ));
                    }
                    Ok(None) => {
                        return ToolOutcome::error(i18n::t("tools.memory.sharedNotFound"));
                    }
                    Err(error) => {
                        return ToolOutcome::error(i18n::t_args(
                            "tools.memory.readFailed",
                            &[("error", &format!("{error:#}"))],
                        ));
                    }
                };
                let input = AgentMemoryInput {
                    kind: json_str(args, "kind").unwrap_or(existing.kind),
                    content,
                    source_conversation_id: Some(conversation_id.to_string()),
                    pinned: args
                        .get("pinned")
                        .and_then(Value::as_bool)
                        .unwrap_or(existing.pinned),
                };
                let input = match input.normalize() {
                    Ok(input) => input,
                    Err(error) => return ToolOutcome::error(error),
                };
                return match db.update_agent_shared_memory(id.trim(), agent_id, &input) {
                    Ok(memory) => ToolOutcome {
                        content: serde_json::to_string_pretty(&json!({
                            "updated": true,
                            "scope": "shared",
                            "id": memory.id,
                            "kind": memory.kind,
                        }))
                        .unwrap_or_else(|_| "{\"updated\":true}".to_string()),
                        summary: Some(i18n::t("tools.memory.sharedUpdated")),
                        ..Default::default()
                    },
                    Err(error) => ToolOutcome::error(i18n::t_args(
                        "tools.memory.updateFailed",
                        &[("error", &format!("{error:#}"))],
                    )),
                };
            }
            let existing = match db.get_agent_memory(agent_id, id.trim()) {
                Ok(Some(memory)) => memory,
                Ok(None) => {
                    return ToolOutcome::error(i18n::t("tools.memory.notFound"));
                }
                Err(error) => {
                    return ToolOutcome::error(i18n::t_args(
                        "tools.memory.readFailed",
                        &[("error", &format!("{error:#}"))],
                    ));
                }
            };
            let input = AgentMemoryInput {
                kind: json_str(args, "kind").unwrap_or(existing.kind),
                content,
                source_conversation_id: Some(conversation_id.to_string()),
                pinned: args
                    .get("pinned")
                    .and_then(Value::as_bool)
                    .unwrap_or(existing.pinned),
            };
            let input = match input.normalize() {
                Ok(input) => input,
                Err(error) => return ToolOutcome::error(error),
            };
            match db.update_agent_memory(agent_id, id.trim(), &input) {
                Ok(memory) => ToolOutcome {
                    content: serde_json::to_string_pretty(&json!({
                        "updated": true,
                        "scope": "private",
                        "id": memory.id,
                        "kind": memory.kind,
                    }))
                    .unwrap_or_else(|_| "{\"updated\":true}".to_string()),
                    summary: Some(i18n::t("tools.memory.updated")),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(i18n::t_args(
                    "tools.memory.updateFailed",
                    &[("error", &format!("{error:#}"))],
                )),
            }
        }
        "forget" => {
            let Some(id) = json_str(args, "id") else {
                return ToolOutcome::error(i18n::t("tools.memory.idRequiredForget"));
            };
            if scope == "shared" {
                if let Err(outcome) = shared_allowed() {
                    return outcome;
                }
                return match db.delete_agent_shared_memory(id.trim(), agent_id) {
                    Ok(()) => ToolOutcome {
                        content: json!({
                            "forgotten": true,
                            "scope": "shared",
                            "id": id.trim()
                        })
                        .to_string(),
                        summary: Some(i18n::t("tools.memory.sharedRemoved")),
                        ..Default::default()
                    },
                    Err(error) => ToolOutcome::error(i18n::t_args(
                        "tools.memory.removeFailed",
                        &[("error", &format!("{error:#}"))],
                    )),
                };
            }
            match db.delete_agent_memory(agent_id, id.trim()) {
                Ok(()) => ToolOutcome {
                    content: json!({
                        "forgotten": true,
                        "scope": "private",
                        "id": id.trim()
                    })
                    .to_string(),
                    summary: Some(i18n::t("tools.memory.removed")),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(i18n::t_args(
                    "tools.memory.removeFailed",
                    &[("error", &format!("{error:#}"))],
                )),
            }
        }
        _ => ToolOutcome::error(i18n::t("tools.memory.invalidAction")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Settings, TurnOptions};
    use crate::tools::skills::ExternalSkillRoot;
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;

    fn runtime(agent_id: Option<&str>, memory: bool) -> ToolRuntime {
        let db = crate::db::Db::open_in_memory().expect("db");
        let mut options = TurnOptions::default();
        options.agent_id = agent_id.map(str::to_string);
        options.agent_memory = memory;
        ToolRuntime {
            db: std::sync::Arc::new(db),
            http: reqwest::Client::new(),
            conversation_id: "conversation-1".to_string(),
            message_id: "message-1".to_string(),
            options,
            settings: Settings::default(),
            cancel: CancellationToken::new(),
            agent_hooks: None,
            data_dir: PathBuf::new(),
            skills_roots: Vec::<ExternalSkillRoot>::new(),
            approval: None,
            emit: None,
        }
    }

    #[test]
    fn memory_requires_an_agent_turn() {
        let rt = runtime(None, true);
        let outcome = run(&rt, &json!({ "action": "list" }));
        assert!(outcome.is_error);
        assert!(outcome.content.contains("conversas de um agente"));
    }

    #[test]
    fn memory_saves_lists_and_forgets() {
        let rt = runtime(Some("agent-1"), true);
        let input = AgentMemoryInput {
            kind: "fact".to_string(),
            content: "Prefere respostas curtas.".to_string(),
            source_conversation_id: None,
            pinned: false,
        };
        // The DB method validates the agent exists; create it through the same
        // schema used by production.
        let agent = crate::agents::AgentInput {
            name: "Irineu".to_string(),
            role: "Engenheiro".to_string(),
            description: String::new(),
            avatar: crate::agents::AgentAvatar::emoji("🤖"),
            department: "Geral".to_string(),
            provider_id: "opencode-go".to_string(),
            model_id: "glm-5.3-flash".to_string(),
            fallback_provider_id: None,
            fallback_model_id: None,
            reasoning: None,
            instructions: String::new(),
            starters: Vec::new(),
            capabilities: crate::agents::AgentCapabilities::default(),
            memory_enabled: true,
            workspace_id: None,
            permission_mode: crate::domain::PermissionMode::Edit,
            docker_image: None,
            computer_environment: "auto".to_string(),
            template: None,
        };
        let agent = rt.db.create_agent(&agent).expect("agent");
        let rt = ToolRuntime {
            options: {
                let mut options = rt.options.clone();
                options.agent_id = Some(agent.id.clone());
                options
            },
            ..rt
        };
        let saved = run(&rt, &json!({ "action": "save", "content": input.content }));
        assert!(!saved.is_error, "{}", saved.content);
        let listed = run(&rt, &json!({ "action": "list" }));
        assert!(listed.content.contains("Prefere respostas curtas."));
        let id = serde_json::from_str::<Value>(&saved.content)
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
            .expect("id");
        let updated = run(
            &rt,
            &json!({
                "action": "update",
                "id": id,
                "content": "Prefere respostas curtas e cita fontes."
            }),
        );
        assert!(!updated.is_error, "{}", updated.content);
        assert!(run(&rt, &json!({ "action": "list" }))
            .content
            .contains("cita fontes"));
        let forgotten = run(&rt, &json!({ "action": "forget", "id": id }));
        assert!(!forgotten.is_error, "{}", forgotten.content);
        assert!(run(&rt, &json!({ "action": "list" }))
            .content
            .contains("[]"));
    }
}
