//! Agent↔agent delegation tools.
//!
//! Tools only create/transition durable tasks; the background scheduler in
//! `commands::tasks` runs them under the concurrency governor. A task is always
//! owned by one agent and lives in a channel (or a standalone task thread).

use serde_json::{json, Value};

use crate::agents::AgentTaskInput;
use crate::db::Db;
use crate::i18n;
use crate::providers::ToolDefinition;
use crate::tools::{json_str, ToolOutcome};

const TOOL_NAMES: &[&str] = &[
    "delegate_task",
    "task_list",
    "task_get",
    "task_wait",
    "task_cancel",
    "accept_task",
    "decline_task",
    "handoff_task",
    "update_task",
    "finish_task",
    "send_message",
];

pub fn definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "delegate_task".to_string(),
            description: "Delegate a scoped piece of work to another agent. The target owns \
                          the task in its own hidden thread; the scheduler runs it under the \
                          agent/channel budget. Use small tasks with explicit acceptance criteria."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "toAgentId": { "type": "string" },
                    "title": { "type": "string" },
                    "brief": { "type": "string" },
                    "acceptance": { "type": "string" },
                    "maxTurns": { "type": "integer", "minimum": 1, "maximum": 32 },
                    "maxTokens": { "type": "integer", "minimum": 1000, "maximum": 500000 },
                    "maxCost": { "type": "number", "minimum": 0.01, "maximum": 50 },
                    "deadlineMinutes": { "type": "integer", "minimum": 1, "maximum": 1440 }
                },
                "required": ["toAgentId", "title", "brief"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "task_list".to_string(),
            description: "List delegated tasks in the current channel or owned by an agent."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "status": { "type": "string" },
                    "ownerAgentId": { "type": "string" },
                    "channelId": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                },
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "task_get".to_string(),
            description: "Read one delegated task and its event history.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "taskId": { "type": "string" } },
                "required": ["taskId"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "task_wait".to_string(),
            description: "Wait for a delegated task to reach a stable state (done, failed, \
                          cancelled, declined, review, waiting_input or waiting_approval). \
                          Returns the current task when the timeout expires."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "timeoutSeconds": { "type": "integer", "minimum": 0, "maximum": 300 }
                },
                "required": ["taskId"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "task_cancel".to_string(),
            description: "Cancel a delegated task. The owner or the agent that created it can \
                          cancel; terminal tasks cannot be cancelled. A running turn observes \
                          the new status at its next step."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "reason": { "type": "string", "maxLength": 500 }
                },
                "required": ["taskId"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "accept_task".to_string(),
            description: "Accept a task delegated to this agent (queued → accepted).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "taskId": { "type": "string" } },
                "required": ["taskId"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "decline_task".to_string(),
            description: "Decline a task delegated to this agent with a reason.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "reason": { "type": "string" }
                },
                "required": ["taskId", "reason"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "handoff_task".to_string(),
            description: "Hand a task to another agent. The target must accept it; handoffs are \
                          limited and audited."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "toAgentId": { "type": "string" },
                    "summary": { "type": "string" },
                    "nextSteps": { "type": "string" }
                },
                "required": ["taskId", "toAgentId", "summary"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "update_task".to_string(),
            description: "Report task progress/status as the owner: waiting_input, \
                          waiting_approval, review or running."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "status": { "type": "string" },
                    "progress": { "type": "string" }
                },
                "required": ["taskId", "status"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "finish_task".to_string(),
            description: "Finish a task you own with the result and evidence.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "result": { "type": "string" },
                    "artifactIds": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["taskId", "result"],
                "additionalProperties": false
            }),
        },
        ToolDefinition {
            name: "send_message".to_string(),
            description: "Post a message to a shared channel.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "channelId": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["channelId", "content"],
                "additionalProperties": false
            }),
        },
    ]
}

pub fn is_delegation_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

fn ok_task(db: &Db, task_id: &str) -> ToolOutcome {
    match db.get_agent_task(task_id) {
        Ok(Some(task)) => ToolOutcome {
            content: serde_json::to_string_pretty(&task).unwrap_or_else(|_| "{}".to_string()),
            summary: Some(i18n::t_args(
                "tools.tasks.taskStatusSummary",
                &[("status", task.status.as_str())],
            )),
            ..Default::default()
        },
        Ok(None) => ToolOutcome::error(format!(
            "AGENT_TASK_NOT_FOUND: {}",
            i18n::t_args("tools.tasks.taskNotFound", &[("taskId", task_id)])
        )),
        Err(error) => ToolOutcome::error(format!("{error:#}")),
    }
}

fn owner_check(
    db: &Db,
    task_id: &str,
    agent_id: &str,
) -> Result<crate::agents::AgentTask, ToolOutcome> {
    let task = db
        .get_agent_task(task_id)
        .map_err(|error| ToolOutcome::error(format!("{error:#}")))?
        .ok_or_else(|| {
            ToolOutcome::error(format!(
                "AGENT_TASK_NOT_FOUND: {}",
                i18n::t_args("tools.tasks.taskNotFound", &[("taskId", task_id)])
            ))
        })?;
    if task.owner_agent_id != agent_id {
        return Err(ToolOutcome::error(format!(
            "AGENT_TASK_FORBIDDEN: {}",
            i18n::t("tools.tasks.taskForbiddenOwner")
        )));
    }
    Ok(task)
}

fn task_visible(
    task: &crate::agents::AgentTask,
    agent_id: &str,
    conversation: &crate::domain::Conversation,
) -> bool {
    task.owner_agent_id == agent_id
        || task.created_by_agent_id.as_deref() == Some(agent_id)
        || (task.channel_id.is_some() && task.channel_id == conversation.channel_id)
}

fn notify_task(db: &Db, task_id: &str, hooks: Option<&dyn crate::tools::AgentHooks>) {
    if let Some(hooks) = hooks {
        if let Ok(Some(task)) = db.get_agent_task(task_id) {
            hooks.task_updated(&task);
        }
    }
}

pub fn run(
    db: &Db,
    agent_id: &str,
    conversation_id: &str,
    tool: &str,
    args: &Value,
) -> ToolOutcome {
    run_with_hooks(db, agent_id, conversation_id, tool, args, None)
}

pub fn run_with_hooks(
    db: &Db,
    agent_id: &str,
    conversation_id: &str,
    tool: &str,
    args: &Value,
    hooks: Option<&dyn crate::tools::AgentHooks>,
) -> ToolOutcome {
    let agent = match db.get_agent(agent_id) {
        Ok(Some(agent)) => agent,
        Ok(None) => {
            return ToolOutcome::error(format!(
                "AGENT_NOT_FOUND: {}",
                i18n::t("tools.tasks.agentNotFound")
            ));
        }
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let conversation = match db.get_conversation(conversation_id) {
        Ok(Some(conversation)) => conversation,
        Ok(None) => {
            return ToolOutcome::error(format!(
                "AGENT_TASK_INVALID: {}",
                i18n::t("tools.tasks.conversationNotFound")
            ));
        }
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let channel_leader = conversation
        .channel_id
        .as_deref()
        .and_then(|channel_id| db.get_agent_channel(channel_id).ok().flatten())
        .is_some_and(|channel| channel.leader_agent_id.as_deref() == Some(agent_id));
    let delegation = agent.capabilities.delegation;
    let can_delegate = delegation || channel_leader;
    let now = crate::domain::now_ms();
    match tool {
        "delegate_task" => {
            if !can_delegate {
                return ToolOutcome::error(format!(
                    "AGENT_CAPABILITY_DENIED: {}",
                    i18n::t("tools.tasks.capabilityDeniedDelegation")
                ));
            }
            let Some(to_agent) = json_str(args, "toAgentId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.toAgentIdRequired"));
            };
            if to_agent == agent_id {
                return ToolOutcome::error(format!(
                    "AGENT_TASK_INVALID: {}",
                    i18n::t("tools.tasks.taskSelfTarget")
                ));
            }
            let Some(title) = json_str(args, "title") else {
                return ToolOutcome::error(i18n::t("tools.tasks.titleRequired"));
            };
            let Some(brief) = json_str(args, "brief") else {
                return ToolOutcome::error(i18n::t("tools.tasks.briefRequired"));
            };
            let inherited_channel = conversation.channel_id.clone().or_else(|| {
                conversation
                    .task_id
                    .as_deref()
                    .and_then(|task_id| db.get_agent_task(task_id).ok().flatten())
                    .and_then(|task| task.channel_id)
            });
            let input = AgentTaskInput {
                to_agent_id: to_agent,
                title,
                brief,
                acceptance: json_str(args, "acceptance").unwrap_or_default(),
                channel_id: inherited_channel,
                parent_task_id: conversation.task_id.clone(),
                workspace_id: conversation.workspace_id.clone().or_else(|| {
                    conversation
                        .task_id
                        .as_deref()
                        .and_then(|task_id| db.get_agent_task(task_id).ok().flatten())
                        .and_then(|task| task.workspace_id)
                }),
                max_turns: args.get("maxTurns").and_then(Value::as_u64).map(|v| v as u32),
                max_tokens: args.get("maxTokens").and_then(Value::as_u64).map(|v| v as u32),
                max_cost: args.get("maxCost").and_then(Value::as_f64),
                deadline_minutes: args
                    .get("deadlineMinutes")
                    .and_then(Value::as_u64)
                    .map(|v| v as u32),
            };
            let input = match input.normalize() {
                Ok(input) => input,
                Err(error) => return ToolOutcome::error(error),
            };
            match db.create_agent_task(&input, Some(agent_id), Some(conversation_id), false, now) {
                Ok(task) => {
                    let task_id = task.id.clone();
                    notify_task(db, &task_id, hooks);
                    ToolOutcome {
                        content: serde_json::to_string_pretty(&task)
                            .unwrap_or_else(|_| "{}".to_string()),
                        summary: Some(i18n::t_args(
                            "tools.tasks.delegatedSummary",
                            &[("agent", task.owner_agent_id.as_str())],
                        )),
                        ..Default::default()
                    }
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "task_list" => {
            let status = json_str(args, "status");
            let channel = conversation.channel_id.as_deref();
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .clamp(1, 100) as u32;
            match db.list_agent_tasks_visible(agent_id, channel, status.as_deref(), limit) {
                Ok(tasks) => ToolOutcome {
                    content: serde_json::to_string_pretty(&tasks)
                        .unwrap_or_else(|_| "[]".to_string()),
                    summary: Some(i18n::t_count(
                        "tools.tasks.tasksSummary",
                        tasks.len(),
                        &[("count", &tasks.len().to_string())],
                    )),
                    ..Default::default()
                },
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "task_get" => {
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            match db.get_agent_task(&task_id) {
                Ok(Some(task)) => {
                    if !task_visible(&task, agent_id, &conversation) {
                        return ToolOutcome::error(
                            format!("AGENT_TASK_FORBIDDEN: {}", i18n::t("tools.tasks.taskForbiddenScope")),
                        );
                    }
                    match db.list_agent_task_events(&task_id) {
                        Ok(events) => ToolOutcome {
                            content: serde_json::to_string_pretty(&json!({
                                "task": task,
                                "events": events,
                            }))
                            .unwrap_or_else(|_| "{}".to_string()),
                            summary: Some(i18n::t_args(
                                "tools.tasks.taskStatusSummary",
                                &[("status", task.status.as_str())],
                            )),
                            ..Default::default()
                        },
                        Err(error) => ToolOutcome::error(format!("{error:#}")),
                    }
                }
                Ok(None) => ToolOutcome::error(format!(
                    "AGENT_TASK_NOT_FOUND: {}",
                    i18n::t_args("tools.tasks.taskNotFound", &[("taskId", task_id.as_str())])
                )),
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "task_cancel" => {
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            let task = match db.get_agent_task(&task_id) {
                Ok(Some(task)) => task,
                Ok(None) => {
                    return ToolOutcome::error(format!(
                        "AGENT_TASK_NOT_FOUND: {}",
                        i18n::t_args("tools.tasks.taskNotFound", &[("taskId", task_id.as_str())])
                    ));
                }
                Err(error) => return ToolOutcome::error(format!("{error:#}")),
            };
            if !task_visible(&task, agent_id, &conversation) {
                return ToolOutcome::error(
                    format!("AGENT_TASK_FORBIDDEN: {}", i18n::t("tools.tasks.taskForbiddenScope")),
                );
            }
            if task.owner_agent_id != agent_id
                && task.created_by_agent_id.as_deref() != Some(agent_id)
            {
                return ToolOutcome::error(format!(
                    "AGENT_TASK_FORBIDDEN: {}",
                    i18n::t("tools.tasks.taskForbiddenCancel")
                ));
            }
            if matches!(task.status.as_str(), "done" | "cancelled" | "failed" | "declined") {
                return ToolOutcome::error(format!(
                    "AGENT_TASK_INVALID: {}",
                    i18n::t("tools.tasks.taskAlreadyFinished")
                ));
            }
            let reason = json_str(args, "reason")
                .map(|reason| reason.trim().chars().take(500).collect::<String>())
                .filter(|reason| !reason.is_empty());
            let result = reason
                .as_deref()
                .map(|reason| {
                    i18n::t_args("tools.tasks.cancelledWithReason", &[("reason", reason)])
                })
                .unwrap_or_else(|| i18n::t("tools.tasks.cancelledNoReason"));
            if let (Some(hooks), Some(conversation_id)) = (hooks, task.conversation_id.as_deref()) {
                hooks.cancel_conversation(conversation_id);
            }
            match db.transition_agent_task(
                &task_id,
                Some(task.version),
                None,
                "cancelled",
                "agent",
                json!({ "cancelledBy": agent_id, "reason": reason }),
                Some(&result),
                None,
                now,
            ) {
                Ok(task) => {
                    let task_id = task.id.clone();
                    notify_task(db, &task_id, hooks);
                    ToolOutcome {
                        content: serde_json::to_string_pretty(&task)
                            .unwrap_or_else(|_| "{}".to_string()),
                        summary: Some(i18n::t("tools.tasks.cancelledSummary")),
                        ..Default::default()
                    }
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "accept_task" => {
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            let task = match owner_check(db, &task_id, agent_id) {
                Ok(task) => task,
                Err(outcome) => return outcome,
            };
            match db.transition_agent_task(
                &task_id,
                Some(task.version),
                Some(agent_id),
                "accepted",
                "agent",
                json!({ "acceptedBy": agent_id }),
                None,
                None,
                now,
            ) {
                Ok(_) => {
                    notify_task(db, &task_id, hooks);
                    ok_task(db, &task_id)
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "decline_task" => {
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            let task = match owner_check(db, &task_id, agent_id) {
                Ok(task) => task,
                Err(outcome) => return outcome,
            };
            let reason =
                json_str(args, "reason").unwrap_or_else(|| i18n::t("tools.tasks.declineNoReason"));
            match db.transition_agent_task(
                &task_id,
                Some(task.version),
                Some(agent_id),
                "declined",
                "agent",
                json!({ "reason": reason }),
                Some(&reason),
                None,
                now,
            ) {
                Ok(_) => {
                    notify_task(db, &task_id, hooks);
                    ok_task(db, &task_id)
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "handoff_task" => {
            if !delegation {
                return ToolOutcome::error(format!(
                    "AGENT_CAPABILITY_DENIED: {}",
                    i18n::t("tools.tasks.capabilityDeniedDelegation")
                ));
            }
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            if let Err(outcome) = owner_check(db, &task_id, agent_id) {
                return outcome;
            }
            let Some(to_agent) = json_str(args, "toAgentId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.toAgentIdRequired"));
            };
            let summary = json_str(args, "summary").unwrap_or_default();
            let next_steps = json_str(args, "nextSteps").unwrap_or_default();
            let combined = i18n::t_args(
                "tools.tasks.handoffCombined",
                &[("summary", &summary), ("nextSteps", &next_steps)],
            );
            match db.handoff_agent_task(&task_id, agent_id, &to_agent, "agent", &combined, now) {
                Ok(_) => {
                    notify_task(db, &task_id, hooks);
                    ok_task(db, &task_id)
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "update_task" => {
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            let task = match owner_check(db, &task_id, agent_id) {
                Ok(task) => task,
                Err(outcome) => return outcome,
            };
            let Some(status) = json_str(args, "status") else {
                return ToolOutcome::error(i18n::t("tools.tasks.statusRequired"));
            };
            if !matches!(
                status.as_str(),
                "running" | "waiting_input" | "waiting_approval" | "review"
            ) {
                return ToolOutcome::error(i18n::t("tools.tasks.invalidStatus"));
            }
            let progress = json_str(args, "progress").unwrap_or_default();
            match db.transition_agent_task(
                &task_id,
                Some(task.version),
                Some(agent_id),
                &status,
                "agent",
                json!({ "progress": progress }),
                None,
                None,
                now,
            ) {
                Ok(_) => {
                    notify_task(db, &task_id, hooks);
                    ok_task(db, &task_id)
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "finish_task" => {
            let Some(task_id) = json_str(args, "taskId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
            };
            let task = match owner_check(db, &task_id, agent_id) {
                Ok(task) => task,
                Err(outcome) => return outcome,
            };
            let Some(result) = json_str(args, "result") else {
                return ToolOutcome::error(i18n::t("tools.tasks.resultRequired"));
            };
            if result.trim().is_empty() {
                return ToolOutcome::error(i18n::t("tools.tasks.emptyResult"));
            }
            let artifacts: Vec<String> = args
                .get("artifactIds")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            for artifact_id in &artifacts {
                let stored = match db.get_artifact(artifact_id) {
                    Ok(Some(stored)) => stored,
                    Ok(None) => {
                        return ToolOutcome::error(format!(
                            "AGENT_TASK_INVALID: {}",
                            i18n::t_args(
                                "tools.tasks.artifactNotFound",
                                &[("artifact", artifact_id.as_str())],
                            )
                        ));
                    }
                    Err(error) => return ToolOutcome::error(format!("{error:#}")),
                };
                let belongs = db
                    .artifact_belongs_to_task(artifact_id, &task.id)
                    .unwrap_or(false);
                let _ = stored;
                if !belongs {
                    return ToolOutcome::error(format!(
                        "ARTIFACT_NOT_IN_TASK: {}",
                        i18n::t_args(
                            "tools.tasks.artifactNotInTask",
                            &[("artifact", artifact_id.as_str())],
                        )
                    ));
                }
            }
            match db.transition_agent_task(
                &task_id,
                Some(task.version),
                Some(agent_id),
                "done",
                "agent",
                json!({ "result": result }),
                Some(&result),
                Some(&artifacts),
                now,
            ) {
                Ok(_) => {
                    notify_task(db, &task_id, hooks);
                    ok_task(db, &task_id)
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        "send_message" => {
            if !delegation {
                return ToolOutcome::error(format!(
                    "AGENT_CAPABILITY_DENIED: {}",
                    i18n::t("tools.tasks.capabilityDeniedDelegation")
                ));
            }
            let Some(channel_id) = json_str(args, "channelId") else {
                return ToolOutcome::error(i18n::t("tools.tasks.channelIdRequired"));
            };
            let Some(content) = json_str(args, "content") else {
                return ToolOutcome::error(i18n::t("tools.tasks.contentRequired"));
            };
            if content.trim().is_empty() {
                return ToolOutcome::error(i18n::t("tools.tasks.emptyMessage"));
            }
            if content.chars().count() > 16_000 {
                return ToolOutcome::error(format!(
                    "AGENT_CHANNEL_INVALID: {}",
                    i18n::t("tools.tasks.channelMessageTooLong")
                ));
            }
            match db.get_agent_channel(&channel_id) {
                Ok(Some(channel)) => {
                    if channel.kind == "dm" {
                        return ToolOutcome::error(format!(
                            "AGENT_CHANNEL_DM_READONLY: {}",
                            i18n::t("tools.tasks.channelDmReadonly")
                        ));
                    }
                    if !channel.member_ids.iter().any(|id| id == agent_id) {
                        return ToolOutcome::error(format!(
                            "AGENT_TASK_FORBIDDEN: {}",
                            i18n::t("tools.tasks.channelNotMember")
                        ));
                    }
                }
                Ok(None) => {
                    return ToolOutcome::error(format!(
                        "AGENT_TASK_INVALID: {}",
                        i18n::t("tools.tasks.channelNotFound")
                    ));
                }
                Err(error) => return ToolOutcome::error(format!("{error:#}")),
            }
            match db.append_agent_channel_message(
                &channel_id,
                "agent",
                Some(agent_id),
                content.trim(),
                &[],
                now,
            ) {
                Ok(message) => {
                    if let Some(hooks) = hooks {
                        hooks.channel_updated(&channel_id);
                    }
                    ToolOutcome {
                        content: serde_json::to_string_pretty(&message)
                            .unwrap_or_else(|_| "{}".to_string()),
                        summary: Some(i18n::t("tools.tasks.messagePublished")),
                        ..Default::default()
                    }
                }
                Err(error) => ToolOutcome::error(format!("{error:#}")),
            }
        }
        other => ToolOutcome::error(i18n::t_args(
            "tools.tasks.unknownTool",
            &[("tool", other)],
        )),
    }
}

/// Waits for a visible task to reach a stable state. Used by both the Agent
/// and Code harnesses; the model sets the timeout, capped at five minutes.
pub async fn wait_for_task(
    db: &Db,
    agent_id: &str,
    conversation_id: &str,
    args: &Value,
    cancel: &tokio_util::sync::CancellationToken,
) -> ToolOutcome {
    let Some(task_id) = json_str(args, "taskId") else {
        return ToolOutcome::error(i18n::t("tools.tasks.taskIdRequired"));
    };
    let conversation = match db.get_conversation(conversation_id) {
        Ok(Some(conversation)) => conversation,
        Ok(None) => {
            return ToolOutcome::error(format!(
                "AGENT_TASK_INVALID: {}",
                i18n::t("tools.tasks.conversationNotFound")
            ));
        }
        Err(error) => return ToolOutcome::error(format!("{error:#}")),
    };
    let timeout_seconds = args
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .min(300);
    let started = std::time::Instant::now();
    let deadline = started + std::time::Duration::from_secs(timeout_seconds);
    loop {
        let task = match db.get_agent_task(&task_id) {
            Ok(Some(task)) => task,
            Ok(None) => {
                return ToolOutcome::error(format!(
                    "AGENT_TASK_NOT_FOUND: {}",
                    i18n::t_args("tools.tasks.taskNotFound", &[("taskId", task_id.as_str())])
                ));
            }
            Err(error) => return ToolOutcome::error(format!("{error:#}")),
        };
        if !task_visible(&task, agent_id, &conversation) {
            return ToolOutcome::error(
                format!("AGENT_TASK_FORBIDDEN: {}", i18n::t("tools.tasks.taskForbiddenScope")),
            );
        }
        let stable = matches!(
            task.status.as_str(),
            "done"
                | "failed"
                | "cancelled"
                | "declined"
                | "review"
                | "waiting_input"
                | "waiting_approval"
        );
        let timed_out = !stable && std::time::Instant::now() >= deadline;
        if stable || timed_out {
            let status = task.status.clone();
            return ToolOutcome {
                content: serde_json::to_string_pretty(&json!({
                    "task": task,
                    "waitTimedOut": timed_out,
                    "waitedMs": started.elapsed().as_millis() as u64,
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                summary: Some(if timed_out {
                    i18n::t_args(
                        "tools.tasks.waitTimedOutSummary",
                        &[("status", status.as_str())],
                    )
                } else {
                    i18n::t_args("tools.tasks.taskStatusSummary", &[("status", status.as_str())])
                }),
                ..Default::default()
            };
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let sleep_for = remaining.min(std::time::Duration::from_millis(500));
        tokio::select! {
            _ = cancel.cancelled() => {
                return ToolOutcome::error(format!(
                    "AGENT_TASK_CANCELLED: {}",
                    i18n::t("tools.tasks.waitCancelled")
                ));
            }
            _ = tokio::time::sleep(sleep_for) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AgentCapabilities, AgentInput};
    use crate::domain::PermissionMode;

    fn agent(db: &Db, name: &str, delegation: bool) -> crate::agents::Agent {
        db.create_agent(&AgentInput {
            name: name.to_string(),
            role: "Engenheiro".to_string(),
            description: String::new(),
            avatar: crate::agents::AgentAvatar::emoji("🛠️"),
            department: "Geral".to_string(),
            provider_id: "opencode-go".to_string(),
            model_id: "deepseek-v4.1-flash".to_string(),
            fallback_provider_id: None,
            fallback_model_id: None,
            reasoning: None,
            instructions: String::new(),
            starters: Vec::new(),
            capabilities: AgentCapabilities {
                delegation,
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

    fn task_status(db: &Db, id: &str) -> String {
        db.get_agent_task(id).expect("task").expect("exists").status
    }

    struct RecordingHooks {
        cancelled: std::sync::Mutex<Vec<String>>,
        updated: std::sync::Mutex<Vec<String>>,
    }

    impl crate::tools::AgentHooks for RecordingHooks {
        fn task_updated(&self, task: &crate::agents::AgentTask) {
            self.updated.lock().unwrap().push(task.id.clone());
        }
        fn channel_updated(&self, _channel_id: &str) {}
        fn cancel_conversation(&self, conversation_id: &str) {
            self.cancelled
                .lock()
                .unwrap()
                .push(conversation_id.to_string());
        }
    }

    #[test]
    fn task_cancel_is_allowed_for_the_creator_and_rejects_terminal_tasks() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", true);
        let second = agent(&db, "Bia", true);
        let conversation = db
            .create_agent_conversation(&first.id, "Cancelamento")
            .expect("conversation");
        let delegated = run(
            &db,
            &first.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Trabalho longo",
                "brief": "Faça o trabalho.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();

        let cancelled = run(
            &db,
            &first.id,
            &conversation.id,
            "task_cancel",
            &serde_json::json!({ "taskId": task_id, "reason": "mudou a prioridade" }),
        );
        assert!(!cancelled.is_error, "{}", cancelled.content);
        assert_eq!(task_status(&db, &task_id), "cancelled");

        let again = run(
            &db,
            &first.id,
            &conversation.id,
            "task_cancel",
            &serde_json::json!({ "taskId": task_id }),
        );
        assert!(again.is_error);
        assert!(again.content.contains("AGENT_TASK_INVALID"));
    }

    #[tokio::test]
    async fn task_wait_times_out_without_transitioning_the_task() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", true);
        let second = agent(&db, "Bia", true);
        let conversation = db
            .create_agent_conversation(&first.id, "Espera")
            .expect("conversation");
        let delegated = run(
            &db,
            &first.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Tarefa em fila",
                "brief": "Ainda não começou.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();

        let waited = wait_for_task(
            &db,
            &first.id,
            &conversation.id,
            &serde_json::json!({ "taskId": task_id, "timeoutSeconds": 0 }),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await;
        assert!(!waited.is_error, "{}", waited.content);
        assert!(waited.content.contains("\"waitTimedOut\": true"));
        assert!(waited.content.contains("\"status\": \"queued\""));
        assert_eq!(task_status(&db, &task_id), "queued");
    }

    #[test]
    fn task_cancel_cancels_the_owner_thread_and_notifies() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", true);
        let second = agent(&db, "Bia", true);
        let conversation = db
            .create_agent_conversation(&first.id, "Coordenação")
            .expect("conversation");
        let delegated = run(
            &db,
            &first.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Cancelar",
                "brief": "Faça algo.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();
        let task = db.get_agent_task(&task_id).expect("task").expect("exists");
        let owner_thread = db
            .create_agent_conversation(&second.id, "Tarefa: Cancelar")
            .expect("owner thread");
        db.set_agent_task_conversation(&task.id, &owner_thread.id, crate::domain::now_ms())
            .expect("bind");
        let hooks = RecordingHooks {
            cancelled: std::sync::Mutex::new(Vec::new()),
            updated: std::sync::Mutex::new(Vec::new()),
        };
        let cancelled = run_with_hooks(
            &db,
            &first.id,
            &conversation.id,
            "task_cancel",
            &serde_json::json!({ "taskId": task_id }),
            Some(&hooks),
        );
        assert!(!cancelled.is_error, "{}", cancelled.content);
        assert_eq!(
            hooks.cancelled.lock().unwrap().as_slice(),
            &[owner_thread.id.clone()]
        );
        assert!(hooks.updated.lock().unwrap().iter().any(|id| id == &task_id));
    }

    #[test]
    fn delegate_accept_finish_round_trip() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", true);
        let second = agent(&db, "Bia", true);
        let conversation = db
            .create_agent_conversation(&first.id, "Coordenação")
            .expect("conversation");
        let delegated = run(
            &db,
            &first.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Revisar o relatório",
                "brief": "Leia e liste riscos.",
                "acceptance": "Lista com páginas.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();
        assert_eq!(task_status(&db, &task_id), "queued");

        let accepted = run(
            &db,
            &second.id,
            &conversation.id,
            "accept_task",
            &serde_json::json!({ "taskId": task_id }),
        );
        assert!(!accepted.is_error, "{}", accepted.content);
        assert_eq!(task_status(&db, &task_id), "accepted");

        let finished = run(
            &db,
            &second.id,
            &conversation.id,
            "finish_task",
            &serde_json::json!({
                "taskId": task_id,
                "result": "Três riscos encontrados com referência.",
            }),
        );
        assert!(!finished.is_error, "{}", finished.content);
        assert_eq!(task_status(&db, &task_id), "done");
    }

    #[test]
    fn handoff_transfers_immediately_and_requires_a_new_owner_thread() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", true);
        let second = agent(&db, "Bia", true);
        let third = agent(&db, "Caio", true);
        let conversation = db
            .create_agent_conversation(&first.id, "Handoff")
            .expect("conversation");
        let delegated = run(
            &db,
            &first.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Preparar entrega",
                "brief": "Prepare o pacote.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();
        let accepted = run(
            &db,
            &second.id,
            &conversation.id,
            "accept_task",
            &serde_json::json!({ "taskId": task_id }),
        );
        assert!(!accepted.is_error, "{}", accepted.content);

        let handoff = run(
            &db,
            &second.id,
            &conversation.id,
            "handoff_task",
            &serde_json::json!({
                "taskId": task_id,
                "toAgentId": third.id,
                "summary": "Precisa da revisão final.",
                "nextSteps": "Revisar e publicar.",
            }),
        );
        assert!(!handoff.is_error, "{}", handoff.content);
        assert_eq!(task_status(&db, &task_id), "accepted");
        assert!(db
            .list_queued_agent_tasks(crate::domain::now_ms(), 10)
            .expect("queued")
            .iter()
            .any(|entry| entry.id == task_id));
        let wrong_owner = run(
            &db,
            &second.id,
            &conversation.id,
            "accept_task",
            &serde_json::json!({ "taskId": task_id }),
        );
        assert!(wrong_owner.is_error);
        assert!(wrong_owner.content.contains("AGENT_TASK_FORBIDDEN"));

        let accepted = run(
            &db,
            &third.id,
            &conversation.id,
            "accept_task",
            &serde_json::json!({ "taskId": task_id }),
        );
        assert!(!accepted.is_error, "{}", accepted.content);
        assert_eq!(task_status(&db, &task_id), "accepted");

        let second_handoff = run(
            &db,
            &third.id,
            &conversation.id,
            "handoff_task",
            &serde_json::json!({
                "taskId": task_id,
                "toAgentId": second.id,
                "summary": "Devolvendo com dúvida.",
            }),
        );
        assert!(!second_handoff.is_error, "{}", second_handoff.content);
        assert_eq!(task_status(&db, &task_id), "accepted");
        let declined = run(
            &db,
            &second.id,
            &conversation.id,
            "decline_task",
            &serde_json::json!({ "taskId": task_id, "reason": "sem contexto" }),
        );
        assert!(!declined.is_error, "{}", declined.content);
        assert_eq!(task_status(&db, &task_id), "declined");
    }

    #[test]
    fn channel_leader_can_delegate_without_the_persona_capability() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", false);
        let second = agent(&db, "Bia", false);
        let channel = db
            .create_agent_channel(
                &crate::agents::AgentChannelInput {
                    name: "Lançamento".to_string(),
                    member_ids: vec![first.id.clone(), second.id.clone()],
                    leader_agent_id: Some(first.id.clone()),
                },
                crate::domain::now_ms(),
            )
            .expect("channel");
        let leader_thread = db
            .get_or_create_channel_conversation(&channel.id, &first.id, "#Lançamento · Ana")
            .expect("leader thread");
        let member_thread = db
            .get_or_create_channel_conversation(&channel.id, &second.id, "#Lançamento · Bia")
            .expect("member thread");

        let delegated = run(
            &db,
            &first.id,
            &leader_thread.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Resumo",
                "brief": "Resuma a conversa.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        assert_eq!(
            value["channelId"].as_str(),
            Some(channel.id.as_str())
        );
        assert_eq!(
            value["originConversationId"].as_str(),
            Some(leader_thread.id.as_str())
        );

        let denied = run(
            &db,
            &second.id,
            &member_thread.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": first.id,
                "title": "Sem capability",
                "brief": "Não deveria criar.",
            }),
        );
        assert!(denied.is_error);
        assert!(denied.content.contains("AGENT_CAPABILITY_DENIED"));
    }

    #[test]
    fn delegation_requires_the_capability_and_ownership() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", false);
        let second = agent(&db, "Bia", true);
        let third = agent(&db, "Caio", true);
        let conversation = db
            .create_agent_conversation(&first.id, "Sem capability")
            .expect("conversation");
        let denied = run(
            &db,
            &first.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Tarefa",
                "brief": "Faça.",
            }),
        );
        assert!(denied.is_error);
        assert!(denied.content.contains("AGENT_CAPABILITY_DENIED"));

        let delegated = run(
            &db,
            &second.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": third.id,
                "title": "De terceiros",
                "brief": "Faça.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();
        let self_delegation = run(
            &db,
            &second.id,
            &conversation.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Própria",
                "brief": "Faça.",
            }),
        );
        assert!(self_delegation.is_error);
        assert!(self_delegation.content.contains("AGENT_TASK_INVALID"));
        let forbidden = run(
            &db,
            &first.id,
            &conversation.id,
            "finish_task",
            &serde_json::json!({ "taskId": task_id, "result": "não sou o dono" }),
        );
        assert!(forbidden.is_error);
        assert!(forbidden.content.contains("AGENT_TASK_FORBIDDEN"));
    }

    #[test]
    fn task_get_and_list_do_not_leak_other_agents_work() {
        let db = Db::open_in_memory().expect("db");
        let first = agent(&db, "Ana", true);
        let second = agent(&db, "Bia", true);
        let third = agent(&db, "Caio", true);
        let origin = db
            .create_agent_conversation(&first.id, "Origem")
            .expect("origin");
        let outsider = db
            .create_agent_conversation(&third.id, "Fora")
            .expect("outsider");
        let delegated = run(
            &db,
            &first.id,
            &origin.id,
            "delegate_task",
            &serde_json::json!({
                "toAgentId": second.id,
                "title": "Confidencial",
                "brief": "Só para Bia.",
            }),
        );
        assert!(!delegated.is_error, "{}", delegated.content);
        let value: serde_json::Value = serde_json::from_str(&delegated.content).expect("json");
        let task_id = value["id"].as_str().expect("id").to_string();
        assert_eq!(
            db.get_agent_task(&task_id)
                .expect("task")
                .expect("exists")
                .origin_conversation_id
                .as_deref(),
            Some(origin.id.as_str())
        );
        let forbidden = run(
            &db,
            &third.id,
            &outsider.id,
            "task_get",
            &serde_json::json!({ "taskId": task_id }),
        );
        assert!(forbidden.is_error);
        assert!(forbidden.content.contains("AGENT_TASK_FORBIDDEN"));
        let list = run(
            &db,
            &third.id,
            &outsider.id,
            "task_list",
            &serde_json::json!({}),
        );
        assert!(!list.is_error, "{}", list.content);
        assert_eq!(list.content.trim(), "[]");
    }
}
