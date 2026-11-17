//! Tools available only inside the Agentes layout.
//!
//! These tools operate on the local agent roster, usage and routines. They are
//! added to the catalog only when the turn resolves to an agent conversation,
//! and routine mutations additionally require the `automation` capability.

use serde_json::{json, Value};

use crate::agents::{Agent, AgentRoutineInput};
use crate::db::Db;
use crate::domain::{ReasoningMode, ReasoningSelection, Settings};
use crate::i18n;
use crate::providers::ToolDefinition;
use crate::tools::{json_str, AgentHooks, ToolOutcome};

const BASE_TOOLS: &[&str] = &[
    "agent_directory",
    "agent_usage",
    "agent_inbox",
    "agent_message",
    "create_agent",
];
const ROUTINE_TOOLS: &[&str] = &[
    "routine_list",
    "routine_create",
    "routine_update",
    "routine_delete",
];

pub fn is_agent_tool(name: &str) -> bool {
    BASE_TOOLS.contains(&name) || ROUTINE_TOOLS.contains(&name)
}

pub fn definitions(agent: &Agent) -> Vec<ToolDefinition> {
    let mut tools = vec![
        ToolDefinition {
            name: "agent_directory".to_string(),
            description: "List the active agents on this machine and the shared channels you \
                          belong to. Use it before delegating or asking another agent for help; \
                          instructions and memories of other agents are not exposed."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "agent_usage".to_string(),
            description: "Show this agent's all-time and local-day token/cost usage and the \
                          remaining daily budget."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "agent_inbox".to_string(),
            description: "Read this agent's durable direct-message inbox. `list` returns queued \
                          and recent deliveries; `read` returns the last messages of one DM channel."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "read"] },
                    "channelId": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "additionalProperties": false
            }),
        },
    ];
    if agent.capabilities.delegation {
        tools.push(ToolDefinition {
            name: "agent_message".to_string(),
            description: "Send a direct message to another active agent. Creates or reuses the \
                          private DM channel and queues one delivery; it does not start the target \
                          turn immediately. Use `agent_inbox` to read the reply."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "toAgentId": { "type": "string" },
                    "content": { "type": "string", "maxLength": 16000 }
                },
                "required": ["toAgentId", "content"],
                "additionalProperties": false
            }),
        });
    }
    if agent.capabilities.create_agents {
        tools.push(ToolDefinition {
            name: "create_agent".to_string(),
            description: "Create a new persistent persona on the team. The caller's provider/model \
                          are used when omitted. The new agent starts with every basic action \
                          enabled, autonomous permissions, the app-internal workspace, the \
                          global computer/Docker defaults and a random mascot avatar; it has its \
                          own memory and appears in the Agentes layout immediately. Only pass \
                          `capabilities` when the user explicitly requested specific capabilities, \
                          and `avatar` only when the user asked for specific avatar traits. The new \
                          agent inherits your current thinking unless `reasoning` overrides it. An \
                          optional routine can be attached when the caller also has `automation`."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "maxLength": 80 },
                    "role": { "type": "string", "maxLength": 120 },
                    "description": { "type": "string", "maxLength": 1000 },
                    "avatar": {
                        "type": "object",
                        "description": "Optional mascot customization for what the user explicitly \
                                        asked. Omit for a random mascot. Never send an emoji or \
                                        an image.",
                        "properties": {
                            "body": {
                                "type": "string",
                                "enum": ["mascot", "circle", "bubble", "rounded", "square",
                                         "drop", "blob", "hex", "diamond", "star"]
                            },
                            "expression": {
                                "type": "string",
                                "enum": ["neutral", "happy", "grin", "wink", "surprised",
                                         "angry", "sad", "sleepy", "smug", "dizzy"]
                            },
                            "color": {
                                "type": "string",
                                "enum": ["green", "blue", "red", "orange", "purple", "teal",
                                         "pink", "yellow", "emerald", "coral", "gray", "silver"]
                            },
                            "face": { "type": "string", "enum": ["white", "black"] }
                        },
                        "additionalProperties": false
                    },
                    "department": { "type": "string", "maxLength": 80 },
                    "providerId": { "type": "string" },
                    "modelId": { "type": "string" },
                    "fallbackProviderId": { "type": "string" },
                    "fallbackModelId": { "type": "string" },
                    "reasoning": {
                        "type": "object",
                        "description": "Thinking configuration for the new agent's model. Omit to \
                                        inherit the caller's current thinking. When overriding \
                                        provider/model, use only modes/efforts the target model \
                                        supports. mode=off disables; mode=effort uses effort (omit \
                                        it for toggle-only models); mode=budget requires budget \
                                        tokens.",
                        "properties": {
                            "mode": { "type": "string", "enum": ["off", "effort", "budget"] },
                            "effort": {
                                "type": "string",
                                "enum": ["minimal", "low", "medium", "high", "xhigh", "max"]
                            },
                            "budget": { "type": "integer", "minimum": 1024, "maximum": 65536 }
                        },
                        "required": ["mode"],
                        "additionalProperties": false
                    },
                    "instructions": { "type": "string", "maxLength": 16000 },
                    "starters": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
                    "capabilities": {
                        "type": "object",
                        "description": "Only pass when the user explicitly asked for specific \
                                        capabilities. Omitted: every basic action stays enabled and \
                                        permission is autonomous with the app-internal workspace. \
                                        Unspecified keys keep the default; only listed camelCase \
                                        keys change."
                    },
                    "memoryEnabled": { "type": "boolean" },
                    "workspaceId": { "type": "string" },
                    "permissionMode": {
                        "type": "string",
                        "enum": ["read_only", "edit", "autonomous", "review"]
                    },
                    "dockerImage": {
                        "type": "string",
                        "description": "Optional image override. Omit to inherit the user's \
                                        global Docker image and environment."
                    },
                    "computerEnvironment": {
                        "type": "string",
                        "enum": ["auto", "private_desktop", "this_computer", "browser", "off"]
                    },
                    "routine": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string", "maxLength": 80 },
                            "prompt": { "type": "string", "maxLength": 8192 },
                            "scheduleKind": { "type": "string", "enum": ["interval", "daily"] },
                            "intervalMinutes": { "type": "integer", "minimum": 5, "maximum": 10080 },
                            "hour": { "type": "integer", "minimum": 0, "maximum": 23 },
                            "minute": { "type": "integer", "minimum": 0, "maximum": 59 },
                            "enabled": { "type": "boolean" }
                        },
                        "required": ["title", "prompt", "scheduleKind"],
                        "additionalProperties": false
                    }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
        });
    }
    if agent.capabilities.automation {
        tools.push(ToolDefinition {
            name: "routine_list".to_string(),
            description: "List the routines owned by this agent.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        });
        tools.push(ToolDefinition {
            name: "routine_create".to_string(),
            description: "Create a recurring routine owned by this agent. Schedules are \
                          `interval` (minutes, minimum 5) or `daily` (local hour/minute). \
                          For `daily`, `daysOfWeek` selects weekdays (Monday=1, Tuesday=2, \
                          Wednesday=4, Thursday=8, Friday=16, Saturday=32, Sunday=64; default 127). \
                          The routine runs unattended in the agent's primary conversation."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "maxLength": 80 },
                    "prompt": { "type": "string", "maxLength": 8192 },
                    "scheduleKind": { "type": "string", "enum": ["interval", "daily"] },
                    "intervalMinutes": { "type": "integer", "minimum": 5, "maximum": 10080 },
                    "hour": { "type": "integer", "minimum": 0, "maximum": 23 },
                    "minute": { "type": "integer", "minimum": 0, "maximum": 59 },
                    "daysOfWeek": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 127,
                        "description": "Bitmask for daily schedules: Monday=1, Tuesday=2, Wednesday=4, Thursday=8, Friday=16, Saturday=32, Sunday=64. Default 127."
                    },
                    "enabled": { "type": "boolean" },
                    "triggerKind": { "type": "string", "enum": ["schedule", "event"] },
                    "eventKind": { "type": "string", "enum": ["channel.message", "task.status"] },
                    "eventFilter": { "type": "string" }
                },
                "required": ["title", "prompt", "scheduleKind"],
                "additionalProperties": false
            }),
        });
        tools.push(ToolDefinition {
            name: "routine_update".to_string(),
            description: "Update a routine owned by this agent. Omitted fields keep their \
                          current value. `daysOfWeek` is a Monday-first bitmask for `daily` \
                          schedules (Monday=1 … Sunday=64)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "routineId": { "type": "string" },
                    "title": { "type": "string", "maxLength": 80 },
                    "prompt": { "type": "string", "maxLength": 8192 },
                    "scheduleKind": { "type": "string", "enum": ["interval", "daily"] },
                    "intervalMinutes": { "type": "integer", "minimum": 5, "maximum": 10080 },
                    "hour": { "type": "integer", "minimum": 0, "maximum": 23 },
                    "minute": { "type": "integer", "minimum": 0, "maximum": 59 },
                    "daysOfWeek": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 127,
                        "description": "Bitmask for daily schedules: Monday=1, Tuesday=2, Wednesday=4, Thursday=8, Friday=16, Saturday=32, Sunday=64. Default 127."
                    },
                    "enabled": { "type": "boolean" },
                    "triggerKind": { "type": "string", "enum": ["schedule", "event"] },
                    "eventKind": { "type": "string", "enum": ["channel.message", "task.status"] },
                    "eventFilter": { "type": "string" }
                },
                "required": ["routineId"],
                "additionalProperties": false
            }),
        });
        tools.push(ToolDefinition {
            name: "routine_delete".to_string(),
            description: "Delete a routine owned by this agent.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "routineId": { "type": "string" } },
                "required": ["routineId"],
                "additionalProperties": false
            }),
        });
    }
    tools
}

pub fn guidance(agent: &Agent) -> Vec<(&'static str, &'static str)> {
    let mut items = vec![
        (
            "agent_directory",
            "The directory is read-only. Use ids from it for delegation and channel messages; \
             do not assume another agent has access to your workspace or memory.",
        ),
        (
            "agent_usage",
            "Check your own spend before long autonomous work. The daily budget is local-day and \
             shared by every thread of this agent.",
        ),
        (
            "agent_inbox",
            "Direct messages are delivered as a turn by the scheduler. Read the DM history before \
             replying; replies are explicit, not an infinite chat loop.",
        ),
    ];
    if agent.capabilities.delegation {
        items.push((
            "agent_message",
            "Use direct messages for a short, targeted question to one agent. For owned work with \
             acceptance criteria, use `delegate_task` instead.",
        ));
    }
    if agent.capabilities.create_agents {
        items.push((
            "create_agent",
            "Create an agent only when a durable role is missing. Fill instructions and role. \
             Omit `capabilities` unless the user explicitly named what to enable or disable: a \
             new agent inherits every basic action, autonomous permissions, the app-internal \
             workspace and the global Docker/computer defaults. When the user did list \
             capabilities, send only those keys and change nothing else. Configure the avatar: \
             a new agent gets a random mascot by default; when the user asked for a body, \
             expression, colour or eye colour, send only those `avatar` keys. Never use emoji \
             avatars. Thinking: omit `reasoning` to inherit your current thinking; when the user \
             asked for a thinking level, send `{ \"mode\": \"effort\", \"effort\": ... }` or \
             `{ \"mode\": \"budget\", \"budget\": ... }`. If you switch provider/model, choose a \
             mode the target model supports.",
        ));
    }
    if agent.capabilities.automation {
        items.push((
            "routine_create",
            "Create a routine only for recurring work with a clear finish line. Keep the prompt \
             self-contained and include what to do when a source is missing or stale.",
        ));
        items.push((
            "routine_update",
            "Pause a routine with `enabled: false` instead of deleting it when you only need to \
             stop it temporarily.",
        ));
    }
    items
}

fn agent_json(agent: &Agent, channel_ids: &[String]) -> Value {
    json!({
        "id": agent.id,
        "name": agent.name,
        "role": agent.role,
        "description": agent.description,
        "avatar": agent.avatar.summary(),
        "department": agent.department,
        "providerId": agent.provider_id,
        "modelId": agent.model_id,
        "fallbackProviderId": agent.fallback_provider_id,
        "fallbackModelId": agent.fallback_model_id,
        "permissionMode": agent.permission_mode,
        "workspaceId": agent.workspace_id,
        "capabilities": agent.capabilities,
        "threadCount": agent.thread_count,
        "lastActiveAt": agent.last_active_at,
        "channelIds": channel_ids,
    })
}

fn require_automation(agent: &Agent) -> Result<(), ToolOutcome> {
    if agent.capabilities.automation {
        Ok(())
    } else {
        Err(ToolOutcome::error(format!(
            "AGENT_CAPABILITY_DENIED: {}",
            i18n::t("tools.agents.capabilityDeniedAutomation")
        )))
    }
}

fn routine_id(args: &Value) -> Result<String, ToolOutcome> {
    json_str(args, "routineId").ok_or_else(|| {
        ToolOutcome::error(i18n::t("tools.agents.routineIdRequired"))
    })
}

fn routine_input(args: &Value, current: Option<&crate::agents::AgentRoutine>) -> Result<AgentRoutineInput, String> {
    let title = json_str(args, "title")
        .or_else(|| current.map(|routine| routine.title.clone()))
        .unwrap_or_default();
    let prompt = json_str(args, "prompt")
        .or_else(|| current.map(|routine| routine.prompt.clone()))
        .unwrap_or_default();
    let schedule_kind = json_str(args, "scheduleKind")
        .or_else(|| current.map(|routine| routine.schedule_kind.clone()))
        .unwrap_or_else(|| "interval".to_string());
    let interval_minutes = args
        .get("intervalMinutes")
        .and_then(Value::as_i64)
        .or_else(|| current.map(|routine| routine.interval_minutes))
        .unwrap_or(60);
    let hour = args
        .get("hour")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .or_else(|| current.map(|routine| routine.hour))
        .unwrap_or(9);
    let minute = args
        .get("minute")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .or_else(|| current.map(|routine| routine.minute))
        .unwrap_or(0);
    let days_of_week = args
        .get("daysOfWeek")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .or_else(|| current.map(|routine| routine.days_of_week))
        .unwrap_or(crate::agents::AGENT_ROUTINE_ALL_DAYS);
    let enabled = args
        .get("enabled")
        .and_then(Value::as_bool)
        .or_else(|| current.map(|routine| routine.enabled))
        .unwrap_or(true);
    let trigger_kind = json_str(args, "triggerKind")
        .or_else(|| current.map(|routine| routine.trigger_kind.clone()))
        .unwrap_or_else(|| "schedule".to_string());
    let event_kind = json_str(args, "eventKind")
        .or_else(|| current.map(|routine| routine.event_kind.clone()))
        .unwrap_or_default();
    let event_filter_json = json_str(args, "eventFilter")
        .or_else(|| current.map(|routine| routine.event_filter_json.clone()))
        .unwrap_or_else(|| "{}".to_string());
    AgentRoutineInput {
        title,
        prompt,
        schedule_kind,
        interval_minutes,
        hour,
        minute,
        days_of_week,
        enabled,
        trigger_kind,
        event_kind,
        event_filter_json,
    }
    .normalize()
}

fn routine_json(routine: &crate::agents::AgentRoutine) -> Value {
    json!({
        "id": routine.id,
        "agentId": routine.agent_id,
        "title": routine.title,
        "prompt": routine.prompt,
        "scheduleKind": routine.schedule_kind,
        "intervalMinutes": routine.interval_minutes,
        "hour": routine.hour,
        "minute": routine.minute,
        "daysOfWeek": routine.days_of_week,
        "enabled": routine.enabled,
        "conversationId": routine.conversation_id,
        "nextRunAt": routine.next_run_at,
        "lastRunAt": routine.last_run_at,
        "lastStatus": routine.last_status,
        "lastError": routine.last_error,
    })
}

fn directory(db: &Db, agent_id: &str) -> Result<ToolOutcome, ToolOutcome> {
    let agents = db
        .list_agents(false)
        .map_err(|error| ToolOutcome::error(format!("{error:#}")))?;
    let channels = db
        .list_agent_channels()
        .map_err(|error| ToolOutcome::error(format!("{error:#}")))?;
    let caller_channels: std::collections::HashSet<&str> = channels
        .iter()
        .filter(|channel| channel.member_ids.iter().any(|id| id == agent_id))
        .map(|channel| channel.id.as_str())
        .collect();
    let mut channel_ids: std::collections::HashMap<&str, Vec<String>> =
        std::collections::HashMap::new();
    for channel in &channels {
        if !caller_channels.contains(channel.id.as_str()) {
            continue;
        }
        for member in &channel.member_ids {
            channel_ids
                .entry(member.as_str())
                .or_default()
                .push(channel.id.clone());
        }
    }
    let agents_json: Vec<Value> = agents
        .iter()
        .map(|agent| {
            agent_json(
                agent,
                channel_ids
                    .get(agent.id.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            )
        })
        .collect();
    let channels_json: Vec<Value> = channels
        .iter()
        .filter(|channel| caller_channels.contains(channel.id.as_str()))
        .map(|channel| {
            json!({
                "id": channel.id,
                "name": channel.name,
                "kind": channel.kind,
                "memberIds": channel.member_ids,
            })
        })
        .collect();
    Ok(ToolOutcome {
        content: serde_json::to_string_pretty(&json!({
            "agents": agents_json,
            "channels": channels_json,
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        summary: Some(i18n::t_args(
            "tools.agents.directorySummary",
            &[
                ("agents", &agents.len().to_string()),
                ("channels", &channels_json.len().to_string()),
            ],
        )),
        ..Default::default()
    })
}

fn usage(db: &Db, agent_id: &str, settings: &Settings) -> ToolOutcome {
    let all = match db.get_agent_usage(agent_id) {
        Ok(usage) => usage,
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let today = match db.agent_usage_since(
        agent_id,
        crate::domain::local_day_start_ms(crate::domain::now_ms()),
    ) {
        Ok(usage) => usage,
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let limit = settings.agent_daily_cost_limit_usd;
    ToolOutcome {
        content: serde_json::to_string_pretty(&json!({
            "agentId": agent_id,
            "allTime": all,
            "today": today,
            "dailyLimitUsd": limit,
            "remainingTodayUsd": limit.map(|limit| (limit - today.cost).max(0.0)),
        }))
        .unwrap_or_else(|_| "{}".to_string()),
        summary: Some(i18n::t_args(
            "tools.agents.usageSummary",
            &[("cost", &format!("{:.2}", today.cost))],
        )),
        ..Default::default()
    }
}

fn agent_message(
    db: &Db,
    agent_id: &str,
    target_id: &str,
    content: &str,
    hooks: Option<&dyn AgentHooks>,
) -> ToolOutcome {
    let target_id = target_id.trim();
    if target_id.is_empty() {
        return ToolOutcome::error(i18n::t("tools.agents.toAgentIdRequired"));
    }
    if target_id == agent_id {
        return ToolOutcome::error(format!(
            "AGENT_DM_SELF: {}",
            i18n::t("tools.agents.dmSelf")
        ));
    }
    let content = content.trim();
    if content.is_empty() {
        return ToolOutcome::error(i18n::t("tools.agents.contentRequired"));
    }
    if content.chars().count() > 16_000 {
        return ToolOutcome::error(format!(
            "AGENT_DM_INVALID: {}",
            i18n::t("tools.agents.dmTooLong")
        ));
    }
    let target = match db.get_agent(target_id) {
        Ok(Some(target)) if !target.is_archived() => target,
        Ok(Some(_)) => {
            return ToolOutcome::error(format!(
                "AGENT_DM_TARGET_ARCHIVED: {}",
                i18n::t("tools.agents.dmTargetArchived")
            ));
        }
        Ok(None) => {
            return ToolOutcome::error(format!(
                "AGENT_DM_INVALID: {}",
                i18n::t("tools.agents.dmTargetNotFound")
            ));
        }
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let channel = match db.get_or_create_dm_channel(agent_id, &target.id, crate::domain::now_ms()) {
        Ok(channel) => channel,
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let message = match db.append_agent_channel_message(
        &channel.id,
        "agent",
        Some(agent_id),
        content,
        &[],
        crate::domain::now_ms(),
    ) {
        Ok(message) => message,
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    if let Err(error) =
        db.enqueue_agent_inbox(&target.id, Some(agent_id), &channel.id, &message.id, crate::domain::now_ms())
    {
        return ToolOutcome::error(format!("{error:#}"));
    }
    if let Some(hooks) = hooks {
        hooks.channel_updated(&channel.id);
    }
    ToolOutcome {
        content: json!({
            "queued": true,
            "channelId": channel.id,
            "messageId": message.id,
            "toAgentId": target.id,
            "toAgentName": target.name,
        })
        .to_string(),
        summary: Some(i18n::t_args(
            "tools.agents.directMessageSummary",
            &[("name", target.name.as_str())],
        )),
        ..Default::default()
    }
}

fn agent_inbox(db: &Db, agent_id: &str, args: &Value) -> ToolOutcome {
    let action = json_str(args, "action")
        .unwrap_or_else(|| "list".to_string())
        .trim()
        .to_ascii_lowercase();
    match action.as_str() {
        "list" => {
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 50) as u32;
            match db.list_agent_inbox(agent_id, limit) {
                Ok(items) => ToolOutcome {
                    content: serde_json::to_string_pretty(&items)
                        .unwrap_or_else(|_| "[]".to_string()),
                    summary: Some(i18n::t_count(
                        "tools.agents.inboxListSummary",
                        items.len(),
                        &[("count", &items.len().to_string())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "read" => {
            let Some(channel_id) = json_str(args, "channelId") else {
                return ToolOutcome::error(i18n::t("tools.agents.channelIdRequiredRead"));
            };
            let channel = match db.get_agent_channel(&channel_id) {
                Ok(Some(channel)) => channel,
                Ok(None) => {
                    return ToolOutcome::error(format!(
                        "AGENT_INBOX_NOT_FOUND: {}",
                        i18n::t("tools.agents.inboxChannelNotFound")
                    ));
                }
                Err(error) => return ToolOutcome::error(format!("{error:#}")),
            };
            if channel.kind != "dm" {
                return ToolOutcome::error(format!(
                    "AGENT_INBOX_INVALID: {}",
                    i18n::t("tools.agents.inboxNotDm")
                ));
            }
            if !channel.member_ids.iter().any(|id| id == agent_id) {
                return ToolOutcome::error(format!(
                    "AGENT_INBOX_NOT_FOUND: {}",
                    i18n::t("tools.agents.inboxNotMember")
                ));
            }
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 50) as u32;
            match db.list_agent_channel_messages(&channel.id, Some(limit)) {
                Ok(messages) => ToolOutcome {
                    content: serde_json::to_string_pretty(&messages)
                        .unwrap_or_else(|_| "[]".to_string()),
                    summary: Some(i18n::t_count(
                        "tools.agents.messagesSummary",
                        messages.len(),
                        &[("count", &messages.len().to_string())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        _ => ToolOutcome::error(i18n::t("tools.agents.invalidInboxAction")),
    }
}

fn agent_avatar_from_args(args: &Value) -> Result<crate::agents::AgentAvatar, String> {
    let avatar = crate::agents::AgentAvatar::random_mascot();
    let Some(value) = args.get("avatar").filter(|value| !value.is_null()) else {
        return Ok(avatar);
    };
    let mut merged = match serde_json::to_value(&avatar) {
        Ok(Value::Object(map)) => map,
        _ => {
            return Err(format!(
                "AGENT_AVATAR_INVALID: {}",
                i18n::t("tools.agents.avatarDefaultFailed")
            ))
        }
    };
    let Some(overrides) = value.as_object() else {
        return Err(format!(
            "AGENT_AVATAR_INVALID: {}",
            i18n::t("tools.agents.avatarNotObject")
        ));
    };
    for (key, override_value) in overrides {
        if !matches!(key.as_str(), "body" | "expression" | "color" | "face") {
            return Err(format!(
                "AGENT_AVATAR_INVALID: {}",
                i18n::t_args("tools.agents.avatarUnknownKey", &[("key", key.as_str())])
            ));
        }
        merged.insert(key.clone(), override_value.clone());
    }
    serde_json::from_value(Value::Object(merged)).map_err(|_| {
        format!(
            "AGENT_AVATAR_INVALID: {}",
            i18n::t("tools.agents.avatarInvalidValues")
        )
    })
}

fn agent_reasoning_from_args(args: &Value) -> Result<Option<ReasoningSelection>, String> {
    const EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
    let Some(value) = args.get("reasoning").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let selection: ReasoningSelection = serde_json::from_value(value.clone()).map_err(|_| {
        format!(
            "AGENT_REASONING_INVALID: {}",
            i18n::t("tools.agents.reasoningShape")
        )
    })?;
    match selection.mode {
        ReasoningMode::Off => Ok(Some(ReasoningSelection {
            mode: ReasoningMode::Off,
            effort: None,
            budget: None,
        })),
        ReasoningMode::Effort => {
            if selection.budget.is_some() {
                return Err(format!(
                    "AGENT_REASONING_INVALID: {}",
                    i18n::t("tools.agents.reasoningBudgetOnly")
                ));
            }
            let effort = selection
                .effort
                .map(|effort| effort.trim().to_ascii_lowercase())
                .filter(|effort| !effort.is_empty());
            if let Some(effort) = effort.as_deref() {
                if !EFFORTS.contains(&effort) {
                    return Err(format!(
                        "AGENT_REASONING_INVALID: {}",
                        i18n::t_args(
                            "tools.agents.reasoningUnknownEffort",
                            &[("effort", effort), ("efforts", &EFFORTS.join(", "))],
                        )
                    ));
                }
            }
            Ok(Some(ReasoningSelection {
                mode: ReasoningMode::Effort,
                effort,
                budget: None,
            }))
        }
        ReasoningMode::Budget => {
            let budget = selection.budget.unwrap_or(0);
            if !(1_024..=65_536).contains(&budget) {
                return Err(format!(
                    "AGENT_REASONING_INVALID: {}",
                    i18n::t("tools.agents.reasoningBudgetRange")
                ));
            }
            Ok(Some(ReasoningSelection {
                mode: ReasoningMode::Budget,
                effort: None,
                budget: Some(budget),
            }))
        }
    }
}

fn create_agent_tool(
    db: &Db,
    caller: &Agent,
    args: &Value,
    hooks: Option<&dyn AgentHooks>,
) -> ToolOutcome {
    let Some(hooks) = hooks else {
        return ToolOutcome::error(format!(
            "AGENT_CREATE_UNAVAILABLE: {}",
            i18n::t("tools.agents.createUnavailable")
        ));
    };
    let Some(name) = json_str(args, "name") else {
        return ToolOutcome::error(i18n::t("tools.agents.nameRequired"));
    };
    if args.get("routine").is_some() && !caller.capabilities.automation {
        return ToolOutcome::error(format!(
            "AGENT_CAPABILITY_DENIED: {}",
            i18n::t("tools.agents.capabilityDeniedCreateRoutine")
        ));
    }
    let provider_id = json_str(args, "providerId")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| caller.provider_id.clone());
    let model_id = json_str(args, "modelId")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| caller.model_id.clone());
    let capabilities = match args.get("capabilities") {
        None | Some(Value::Null) => crate::agents::AgentCapabilities::default(),
        Some(value) => {
            let mut merged =
                match serde_json::to_value(crate::agents::AgentCapabilities::default()) {
                    Ok(Value::Object(map)) => map,
                    _ => {
                        return ToolOutcome::error(format!(
                            "AGENT_CAPABILITIES_INVALID: {}",
                            i18n::t("tools.agents.capabilitiesDefaultFailed")
                        ))
                    }
                };
            let Some(overrides) = value.as_object() else {
                return ToolOutcome::error(format!(
                    "AGENT_CAPABILITIES_INVALID: {}",
                    i18n::t("tools.agents.capabilitiesNotObject")
                ));
            };
            for (key, override_value) in overrides {
                if !merged.contains_key(key) {
                    return ToolOutcome::error(format!(
                        "AGENT_CAPABILITIES_INVALID: {}",
                        i18n::t_args(
                            "tools.agents.capabilitiesUnknownKey",
                            &[
                                ("key", key.as_str()),
                                ("keys", &merged.keys().cloned().collect::<Vec<_>>().join(", ")),
                            ],
                        )
                    ));
                }
                merged.insert(key.clone(), override_value.clone());
            }
            match serde_json::from_value(Value::Object(merged)) {
                Ok(parsed) => parsed,
                Err(_) => {
                    return ToolOutcome::error(format!(
                        "AGENT_CAPABILITIES_INVALID: {}",
                        i18n::t("tools.agents.capabilitiesInvalidValues")
                    ))
                }
            }
        }
    };
    let avatar = match agent_avatar_from_args(args) {
        Ok(avatar) => avatar,
        Err(error) => return ToolOutcome::error(error),
    };
    let reasoning = match agent_reasoning_from_args(args) {
        Ok(Some(reasoning)) => Some(reasoning),
        Ok(None) => caller.reasoning.clone(),
        Err(error) => return ToolOutcome::error(error),
    };
    let starters = args
        .get("starters")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|starter| !starter.is_empty())
                .take(8)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let permission_mode = args
        .get("permissionMode")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or(crate::domain::PermissionMode::Autonomous);
    let input = crate::agents::AgentInput {
        name,
        role: json_str(args, "role").unwrap_or_default(),
        description: json_str(args, "description").unwrap_or_default(),
        avatar,
        department: json_str(args, "department")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Geral".to_string()),
        provider_id,
        model_id,
        fallback_provider_id: json_str(args, "fallbackProviderId").filter(|value| !value.trim().is_empty()),
        fallback_model_id: json_str(args, "fallbackModelId").filter(|value| !value.trim().is_empty()),
        reasoning,
        instructions: json_str(args, "instructions").unwrap_or_default(),
        starters,
        capabilities,
        memory_enabled: args
            .get("memoryEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        workspace_id: json_str(args, "workspaceId").filter(|value| !value.trim().is_empty()),
        permission_mode,
        docker_image: json_str(args, "dockerImage").filter(|value| !value.trim().is_empty()),
        computer_environment: json_str(args, "computerEnvironment")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "auto".to_string()),
        template: None,
    };
    match hooks.create_agent(&input) {
        Ok(agent) => {
            hooks.agent_created(&agent);
            let routine = args.get("routine").and_then(|routine_args| {
                routine_input(routine_args, None)
                    .ok()
                    .and_then(|input| db.create_agent_routine(&agent.id, &input, crate::domain::now_ms()).ok())
            });
            let routine_warning = args.get("routine").is_some() && routine.is_none();
            ToolOutcome {
                content: serde_json::to_string_pretty(&json!({
                    "created": true,
                    "agent": agent_json(&agent, &[]),
                    "routine": routine,
                    "routineWarning": routine_warning.then_some(i18n::t("tools.agents.routineWarning")),
                }))
                .unwrap_or_else(|_| "{\"created\":true}".to_string()),
                summary: Some(i18n::t_args(
                    "tools.agents.createdSummary",
                    &[("name", agent.name.as_str())],
                )),
                ..Default::default()
            }
        }
        Err(error) => ToolOutcome::error(error),
    }
}

pub fn run(
    db: &Db,
    agent_id: &str,
    tool: &str,
    args: &Value,
    settings: &Settings,
) -> ToolOutcome {
    run_with_hooks(db, agent_id, tool, args, settings, None)
}

pub fn run_with_hooks(
    db: &Db,
    agent_id: &str,
    tool: &str,
    args: &Value,
    settings: &Settings,
    hooks: Option<&dyn AgentHooks>,
) -> ToolOutcome {
    let agent = match db.get_agent(agent_id) {
        Ok(Some(agent)) => agent,
        Ok(None) => {
            return ToolOutcome::error(format!(
                "AGENT_NOT_FOUND: {}",
                i18n::t("tools.agents.agentNotFound")
            ));
        }
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    match tool {
        "agent_directory" => directory(db, agent_id).unwrap_or_else(|outcome| outcome),
        "agent_usage" => usage(db, agent_id, settings),
        "agent_inbox" => agent_inbox(db, agent_id, args),
        "create_agent" => {
            if !agent.capabilities.create_agents {
                return ToolOutcome::error(format!(
                    "AGENT_CAPABILITY_DENIED: {}",
                    i18n::t("tools.agents.capabilityDeniedCreateAgents")
                ));
            }
            create_agent_tool(db, &agent, args, hooks)
        }
        "agent_message" => {
            if !agent.capabilities.delegation {
                return ToolOutcome::error(format!(
                    "AGENT_CAPABILITY_DENIED: {}",
                    i18n::t("tools.agents.capabilityDeniedDelegation")
                ));
            }
            let Some(target) = json_str(args, "toAgentId") else {
                return ToolOutcome::error(i18n::t("tools.agents.toAgentIdRequired"));
            };
            let Some(content) = json_str(args, "content") else {
                return ToolOutcome::error(i18n::t("tools.agents.contentRequired"));
            };
            agent_message(db, agent_id, &target, &content, hooks)
        }
        "routine_list" => {
            if let Err(outcome) = require_automation(&agent) {
                return outcome;
            }
            match db.list_agent_routines(agent_id) {
                Ok(routines) => ToolOutcome {
                    content: serde_json::to_string_pretty(
                        &routines.iter().map(routine_json).collect::<Vec<_>>(),
                    )
                    .unwrap_or_else(|_| "[]".to_string()),
                    summary: Some(i18n::t_count(
                        "tools.agents.routinesSummary",
                        routines.len(),
                        &[("count", &routines.len().to_string())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "routine_create" => {
            if let Err(outcome) = require_automation(&agent) {
                return outcome;
            }
            let input = match routine_input(args, None) {
                Ok(input) => input,
                Err(error) => return ToolOutcome::error(error),
            };
            match db.create_agent_routine(agent_id, &input, crate::domain::now_ms()) {
                Ok(routine) => ToolOutcome {
                    content: serde_json::to_string_pretty(&routine_json(&routine))
                        .unwrap_or_else(|_| "{}".to_string()),
                    summary: Some(i18n::t_args(
                        "tools.agents.routineCreatedSummary",
                        &[("title", routine.title.as_str())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "routine_update" => {
            if let Err(outcome) = require_automation(&agent) {
                return outcome;
            }
            let routine_id = match routine_id(args) {
                Ok(id) => id,
                Err(outcome) => return outcome,
            };
            let current = match db.get_agent_routine(&routine_id) {
                Ok(Some(routine)) if routine.agent_id == agent_id => routine,
                Ok(Some(_)) => {
                    return ToolOutcome::error(format!(
                        "AGENT_ROUTINE_FORBIDDEN: {}",
                        i18n::t("tools.agents.routineForbidden")
                    ));
                }
                Ok(None) => {
                    return ToolOutcome::error(format!(
                        "AGENT_ROUTINE_NOT_FOUND: {}",
                        i18n::t("tools.agents.routineNotFound")
                    ));
                }
                Err(error) => return ToolOutcome::error(format!("{error:#}")),
            };
            let input = match routine_input(args, Some(&current)) {
                Ok(input) => input,
                Err(error) => return ToolOutcome::error(error),
            };
            match db.update_agent_routine(&routine_id, &input, crate::domain::now_ms()) {
                Ok(routine) => ToolOutcome {
                    content: serde_json::to_string_pretty(&routine_json(&routine))
                        .unwrap_or_else(|_| "{}".to_string()),
                    summary: Some(i18n::t_args(
                        "tools.agents.routineUpdatedSummary",
                        &[("title", routine.title.as_str())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "routine_delete" => {
            if let Err(outcome) = require_automation(&agent) {
                return outcome;
            }
            let routine_id = match routine_id(args) {
                Ok(id) => id,
                Err(outcome) => return outcome,
            };
            match db.get_agent_routine(&routine_id) {
                Ok(Some(routine)) if routine.agent_id == agent_id => {}
                Ok(Some(_)) => {
                    return ToolOutcome::error(format!(
                        "AGENT_ROUTINE_FORBIDDEN: {}",
                        i18n::t("tools.agents.routineForbidden")
                    ));
                }
                Ok(None) => {
                    return ToolOutcome::error(format!(
                        "AGENT_ROUTINE_NOT_FOUND: {}",
                        i18n::t("tools.agents.routineNotFound")
                    ));
                }
                Err(error) => return ToolOutcome::error(format!("{error:#}")),
            }
            match db.delete_agent_routine(&routine_id) {
                Ok(()) => ToolOutcome {
                    content: json!({ "deleted": true, "routineId": routine_id }).to_string(),
                    summary: Some(i18n::t("tools.agents.routineRemoved")),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        other => ToolOutcome::error(i18n::t_args(
            "tools.agents.unknownTool",
            &[("tool", other)],
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AgentCapabilities, AgentInput};
    use crate::domain::{PermissionMode, ReasoningMode, ReasoningSelection};

    fn agent(db: &Db, name: &str, automation: bool) -> Agent {
        db.create_agent(&AgentInput {
            name: name.to_string(),
            role: "Assistente".to_string(),
            description: String::new(),
            avatar: crate::agents::AgentAvatar::emoji("🤖"),
            department: "Geral".to_string(),
            provider_id: "opencode-go".to_string(),
            model_id: "deepseek-v4.1-flash".to_string(),
            fallback_provider_id: None,
            fallback_model_id: None,
            reasoning: None,
            instructions: String::new(),
            starters: Vec::new(),
            capabilities: AgentCapabilities {
                automation,
                delegation: true,
                create_agents: true,
                ..AgentCapabilities::default()
            },
            memory_enabled: false,
            workspace_id: None,
            permission_mode: PermissionMode::Edit,
            docker_image: None,
            computer_environment: "auto".to_string(),
            template: None,
        })
        .expect("agent")
    }

    #[test]
    fn agent_json_never_exposes_image_data_urls() {
        let db = Db::open_in_memory().expect("db");
        let created = agent(&db, "Ana", false);
        let avatar = crate::agents::AgentAvatar::image("data:image/png;base64,AAAA");
        let updated = db
            .update_agent_avatar(&created.id, &avatar)
            .expect("avatar");
        let json = agent_json(&updated, &[]).to_string();
        assert!(json.contains("\"kind\":\"image\""));
        assert!(!json.contains("data:"));
    }

    #[test]
    fn definitions_gate_routines_by_automation() {
        let db = Db::open_in_memory().expect("db");
        let plain = agent(&db, "Ana", false);
        let names: Vec<String> = definitions(&plain).into_iter().map(|tool| tool.name).collect();
        assert!(names.contains(&"agent_directory".to_string()));
        assert!(names.contains(&"agent_usage".to_string()));
        assert!(!names.contains(&"routine_list".to_string()));

        let automation = agent(&db, "Bia", true);
        let names: Vec<String> = definitions(&automation)
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert!(names.contains(&"routine_create".to_string()));
        assert!(names.contains(&"routine_delete".to_string()));
    }

    struct CreatingHooks {
        db: std::sync::Arc<Db>,
    }

    impl AgentHooks for CreatingHooks {
        fn task_updated(&self, _task: &crate::agents::AgentTask) {}
        fn channel_updated(&self, _channel_id: &str) {}
        fn cancel_conversation(&self, _conversation_id: &str) {}
        fn create_agent(
            &self,
            input: &crate::agents::AgentInput,
        ) -> Result<crate::agents::Agent, String> {
            self.db.create_agent(input).map_err(|error| error.to_string())
        }
    }

    #[test]
    fn create_agent_accepts_the_full_profile() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", true);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({
                "name": "Garimpeiro",
                "role": "Prospecção",
                "description": "Encontra clientes e personaliza contato.",
                "avatar": { "color": "teal" },
                "department": "Vendas",
                "instructions": "Pesquise o cliente antes de escrever.",
                "starters": ["Encontre 5 clientes."],
                "memoryEnabled": true,
                "capabilities": { "webSearch": true, "fileAccess": true, "codeExecution": false },
                "routine": {
                    "title": "Prospecção diária",
                    "prompt": "Encontre 5 clientes e prepare o contato.",
                    "scheduleKind": "daily",
                    "hour": 9,
                    "minute": 0
                }
            }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents.iter().find(|agent| agent.name == "Garimpeiro").expect("created");
        assert_eq!(created.department, "Vendas");
        assert_eq!(created.provider_id, creator.provider_id);
        assert_eq!(created.permission_mode, crate::domain::PermissionMode::Autonomous);
        assert!(!created.capabilities.code_execution);
        assert!(created.capabilities.delegation);
        assert!(created.capabilities.computer_use);
        assert_eq!(db.list_agent_routines(&created.id).expect("routines").len(), 1);
    }

    #[test]
    fn create_agent_uses_a_random_mascot_avatar_by_default() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({ "name": "Mascote" }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents
            .iter()
            .find(|agent| agent.name == "Mascote")
            .expect("created");
        assert_eq!(created.avatar.shape, crate::agents::AgentAvatarShape::Mascot);
        assert!(matches!(
            created.avatar.source,
            crate::agents::AgentAvatarSource::Mascot { .. }
        ));
    }

    #[test]
    fn create_agent_avatar_follows_explicit_user_request() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({
                "name": "Roxo",
                "avatar": {
                    "body": "star",
                    "expression": "grin",
                    "color": "purple",
                    "face": "black"
                }
            }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents.iter().find(|agent| agent.name == "Roxo").expect("created");
        assert_eq!(created.avatar.shape, crate::agents::AgentAvatarShape::Mascot);
        match &created.avatar.source {
            crate::agents::AgentAvatarSource::Mascot {
                body,
                expression,
                color,
                face,
            } => {
                assert_eq!(*body, crate::agents::avatar::AgentAvatarBody::Star);
                assert_eq!(*expression, crate::agents::avatar::AgentAvatarExpression::Grin);
                assert_eq!(*color, crate::agents::avatar::AgentAvatarColor::Purple);
                assert_eq!(*face, crate::agents::avatar::AgentAvatarFace::Black);
            }
            other => panic!("unexpected avatar: {other:?}"),
        }
    }

    #[test]
    fn create_agent_rejects_invalid_avatar_overrides() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({ "name": "Inválido", "avatar": { "emoji": "🚀" } }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(created.is_error);
        assert!(created.content.contains("AGENT_AVATAR_INVALID"));
        let agents = db.list_agents(false).expect("agents");
        assert!(!agents.iter().any(|agent| agent.name == "Inválido"));
    }

    #[test]
    fn create_agent_inherits_the_callers_reasoning_when_omitted() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let mut creator_input = AgentInput::from(&creator);
        creator_input.reasoning = Some(ReasoningSelection {
            mode: ReasoningMode::Effort,
            effort: Some("max".to_string()),
            budget: None,
        });
        let creator = db
            .update_agent(&creator.id, &creator_input)
            .expect("creator reasoning");
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({ "name": "Herdeiro" }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents
            .iter()
            .find(|agent| agent.name == "Herdeiro")
            .expect("created");
        let reasoning = created.reasoning.as_ref().expect("inherited reasoning");
        assert_eq!(reasoning.mode, ReasoningMode::Effort);
        assert_eq!(reasoning.effort.as_deref(), Some("max"));
        assert_eq!(reasoning.budget, None);
    }

    #[test]
    fn create_agent_accepts_an_explicit_budget_reasoning() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({
                "name": "Orçado",
                "reasoning": { "mode": "budget", "budget": 16_384 }
            }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents.iter().find(|agent| agent.name == "Orçado").expect("created");
        let reasoning = created.reasoning.as_ref().expect("explicit reasoning");
        assert_eq!(reasoning.mode, ReasoningMode::Budget);
        assert_eq!(reasoning.effort, None);
        assert_eq!(reasoning.budget, Some(16_384));
    }

    #[test]
    fn create_agent_rejects_invalid_reasoning() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let missing_budget = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({ "name": "SemOrçamento", "reasoning": { "mode": "budget" } }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(missing_budget.is_error);
        assert!(missing_budget.content.contains("AGENT_REASONING_INVALID"));
        let bad_effort = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({
                "name": "EsforçoInvalido",
                "reasoning": { "mode": "effort", "effort": "turbo" }
            }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(bad_effort.is_error);
        assert!(bad_effort.content.contains("AGENT_REASONING_INVALID"));
        let agents = db.list_agents(false).expect("agents");
        assert!(!agents.iter().any(|agent| agent.name == "SemOrçamento"));
        assert!(!agents.iter().any(|agent| agent.name == "EsforçoInvalido"));
    }

    #[test]
    fn create_agent_without_capabilities_enables_every_basic_action() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({ "name": "Analista" }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents
            .iter()
            .find(|agent| agent.name == "Analista")
            .expect("created");
        let capabilities = &created.capabilities;
        assert!(capabilities.web_search);
        assert!(capabilities.file_access);
        assert!(capabilities.code_execution);
        assert!(capabilities.delegation);
        assert!(capabilities.automation);
        assert!(capabilities.shared_memory);
        assert!(capabilities.skills_write);
        assert!(capabilities.create_agents);
        assert!(capabilities.computer_use);
        assert!(capabilities.screen_capture);
        assert!(capabilities.browser_use);
        assert!(capabilities.docker_execution);
        assert_eq!(capabilities.skills, None);
        assert_eq!(capabilities.tools, None);
        assert_eq!(capabilities.mcp_servers, None);
        assert_eq!(created.permission_mode, PermissionMode::Autonomous);
        assert!(created.workspace_id.is_none());
        assert!(created.docker_image.is_none());
        assert_eq!(created.computer_environment, "auto");
    }

    #[test]
    fn create_agent_capability_overrides_change_only_the_named_keys() {
        let db = std::sync::Arc::new(Db::open_in_memory().expect("db"));
        let creator = agent(&db, "Recrutador", false);
        let hooks = CreatingHooks { db: db.clone() };
        let created = run_with_hooks(
            &db,
            &creator.id,
            "create_agent",
            &json!({
                "name": "Focado",
                "capabilities": { "computerUse": false, "browserUse": false }
            }),
            &Settings::default(),
            Some(&hooks),
        );
        assert!(!created.is_error, "{}", created.content);
        let agents = db.list_agents(false).expect("agents");
        let created = agents
            .iter()
            .find(|agent| agent.name == "Focado")
            .expect("created");
        let capabilities = &created.capabilities;
        assert!(!capabilities.computer_use);
        assert!(!capabilities.browser_use);
        assert!(capabilities.web_search);
        assert!(capabilities.file_access);
        assert!(capabilities.code_execution);
        assert!(capabilities.delegation);
        assert!(capabilities.automation);
        assert!(capabilities.shared_memory);
        assert!(capabilities.skills_write);
        assert!(capabilities.create_agents);
        assert!(capabilities.screen_capture);
        assert!(capabilities.docker_execution);
        assert_eq!(capabilities.skills, None);
        assert_eq!(capabilities.tools, None);
        assert_eq!(capabilities.mcp_servers, None);
    }

    #[test]
    fn agent_message_queues_and_inbox_reads_the_dm() {
        let db = Db::open_in_memory().expect("db");
        let sender = agent(&db, "Ana", false);
        let recipient = agent(&db, "Bia", false);
        let sent = run(
            &db,
            &sender.id,
            "agent_message",
            &json!({ "toAgentId": recipient.id, "content": "Revise o rascunho?" }),
            &Settings::default(),
        );
        assert!(!sent.is_error, "{}", sent.content);
        let value: serde_json::Value = serde_json::from_str(&sent.content).expect("json");
        let channel_id = value["channelId"].as_str().expect("channel").to_string();
        assert_eq!(
            db.list_pending_agent_inbox(10).expect("pending").len(),
            1
        );
        let inbox = run(
            &db,
            &recipient.id,
            "agent_inbox",
            &json!({ "action": "list" }),
            &Settings::default(),
        );
        assert!(!inbox.is_error, "{}", inbox.content);
        assert!(inbox.content.contains("Revise o rascunho?"));
        let pending = db.list_pending_agent_inbox(10).expect("pending");
        assert!(db
            .claim_agent_inbox(&pending[0].id, crate::domain::now_ms())
            .expect("claim"));
        db.finish_agent_inbox(
            &pending[0].id,
            "delivered",
            None,
            crate::domain::now_ms(),
        )
        .expect("finish");
        assert_eq!(
            db.list_agent_inbox(&recipient.id, 10)
                .expect("inbox")
                .first()
                .expect("inbox item")
                .status,
            "delivered"
        );
        let read = run(
            &db,
            &recipient.id,
            "agent_inbox",
            &json!({ "action": "read", "channelId": channel_id }),
            &Settings::default(),
        );
        assert!(!read.is_error, "{}", read.content);
        assert!(read.content.contains("Revise o rascunho?"));
        let self_message = run(
            &db,
            &sender.id,
            "agent_message",
            &json!({ "toAgentId": sender.id, "content": "oi" }),
            &Settings::default(),
        );
        assert!(self_message.is_error);
        assert!(self_message.content.contains("AGENT_DM_SELF"));
    }

    #[test]
    fn directory_lists_agents_and_shared_channels_without_instructions() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", false);
        let second = agent(&db, "Bia", false);
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Entrega".to_string(),
                    member_ids: vec![first.id.clone(), second.id.clone()],
                    leader_agent_id: None,
                },
                crate::domain::now_ms(),
            )
            .expect("channel");
        let outcome = run(
            &db,
            &first.id,
            "agent_directory",
            &json!({}),
            &Settings::default(),
        );
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("Ana"));
        assert!(outcome.content.contains("Bia"));
        assert!(outcome.content.contains("Entrega"));
        assert!(outcome.content.contains(&channel.id));
        assert!(!outcome.content.contains("instructions"));
    }

    #[test]
    fn routine_tools_require_automation_and_only_own_routines() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", false);
        let second = agent(&db, "Bia", true);
        let denied = run(
            &db,
            &first.id,
            "routine_list",
            &json!({}),
            &Settings::default(),
        );
        assert!(denied.is_error);
        assert!(denied.content.contains("AGENT_CAPABILITY_DENIED"));

        let created = run(
            &db,
            &second.id,
            "routine_create",
            &json!({
                "title": "Resumo diário",
                "prompt": "Resuma as novidades.",
                "scheduleKind": "daily",
                "hour": 9,
                "minute": 0,
                "daysOfWeek": 31,
                "enabled": true,
            }),
            &Settings::default(),
        );
        assert!(!created.is_error, "{}", created.content);
        let value: serde_json::Value = serde_json::from_str(&created.content).expect("json");
        let routine_id = value["id"].as_str().expect("id").to_string();
        assert_eq!(value["scheduleKind"], "daily");
        assert_eq!(value["daysOfWeek"], 31);

        let listed = run(
            &db,
            &second.id,
            "routine_list",
            &json!({}),
            &Settings::default(),
        );
        assert!(!listed.is_error, "{}", listed.content);
        assert!(listed.content.contains(&routine_id));

        let forbidden = run(
            &db,
            &first.id,
            "routine_delete",
            &json!({ "routineId": routine_id }),
            &Settings::default(),
        );
        assert!(forbidden.is_error);
        assert!(forbidden.content.contains("AGENT_CAPABILITY_DENIED"));

        let deleted = run(
            &db,
            &second.id,
            "routine_delete",
            &json!({ "routineId": routine_id }),
            &Settings::default(),
        );
        assert!(!deleted.is_error, "{}", deleted.content);
        assert!(db
            .list_agent_routines(&second.id)
            .expect("routines")
            .is_empty());
    }

    #[test]
    fn routine_tools_accept_days_of_week() {
        let db = Db::open_in_memory().expect("db");
        let owner = agent(&db, "Bia", true);
        let created = run(
            &db,
            &owner.id,
            "routine_create",
            &json!({
                "title": "Sexta",
                "prompt": "Resuma a semana.",
                "scheduleKind": "daily",
                "hour": 18,
                "minute": 0,
                "daysOfWeek": 16,
            }),
            &Settings::default(),
        );
        assert!(!created.is_error, "{}", created.content);
        let value: serde_json::Value = serde_json::from_str(&created.content).expect("json");
        assert_eq!(value["daysOfWeek"], 16);
        let routine_id = value["id"].as_str().expect("id").to_string();

        let updated = run(
            &db,
            &owner.id,
            "routine_update",
            &json!({ "routineId": routine_id, "daysOfWeek": 96 }),
            &Settings::default(),
        );
        assert!(!updated.is_error, "{}", updated.content);
        let value: serde_json::Value = serde_json::from_str(&updated.content).expect("json");
        assert_eq!(value["daysOfWeek"], 96);

        let listed = run(
            &db,
            &owner.id,
            "routine_list",
            &json!({}),
            &Settings::default(),
        );
        assert!(!listed.is_error, "{}", listed.content);
        let routines: Vec<serde_json::Value> =
            serde_json::from_str(&listed.content).expect("list json");
        assert_eq!(
            routines
                .iter()
                .find(|routine| routine["id"] == routine_id)
                .expect("routine")["daysOfWeek"],
            96
        );
    }

    #[test]
    fn usage_reports_all_time_today_and_remaining_budget() {
        let db = Db::open_in_memory().expect("db");
        let current = agent(&db, "Ana", false);
        let conversation = db
            .create_agent_conversation(&current.id, "Uso")
            .expect("conversation");
        db.record_usage(
            &conversation.id,
            "m1",
            "opencode-go",
            "deepseek-v4.1-flash",
            &crate::domain::UsageInfo {
                total_tokens: Some(100),
                cost: Some(0.25),
                ..crate::domain::UsageInfo::default()
            },
        )
        .expect("usage");
        let outcome = run(
            &db,
            &current.id,
            "agent_usage",
            &json!({}),
            &Settings {
                agent_daily_cost_limit_usd: Some(1.0),
                ..Settings::default()
            },
        );
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("\"allTime\""));
        assert!(outcome.content.contains("\"today\""));
        assert!(outcome.content.contains("\"remainingTodayUsd\": 0.75"));
    }
}
