//! Projection of ACP `session/update` payloads onto `ProviderEvent`s.
//!
//! Agents own their tools: tool updates are projected for the UI only, never
//! handed back to the harness for local execution. Every string crossing this
//! boundary is treated as untrusted and is neutralised before it reaches the
//! renderer.

use std::collections::{BTreeMap, HashMap};

use anyhow::Result;
use serde_json::Value;

use crate::providers::{
    EventSink, ProviderError, ProviderEvent, ProviderResult, StructuredError,
};

/// Maximum characters kept from one agent-controlled text field.
const MAX_TEXT_CHARS: usize = 65_536;
/// Maximum entries kept from one agent-controlled JSON array.
const MAX_ARRAY_ITEMS: usize = 64;
/// Maximum nesting depth of a projected JSON payload.
const MAX_JSON_DEPTH: usize = 8;

/// Per-session projection state: tool ids to stable stream indexes and the last
/// arguments/output seen for each tool call.
#[derive(Debug, Default)]
pub(crate) struct MappingState {
    ids: Vec<String>,
    args: HashMap<String, String>,
    output: HashMap<String, String>,
}

/// Public single-update projection. Callers that project a whole session should
/// use [`apply_update_with_state`] so tool indexes stay stable across updates.
pub fn apply_update(
    update: &Value,
    sink: &EventSink,
    config_state: &mut BTreeMap<String, Value>,
) -> Result<()> {
    let mut state = MappingState::default();
    apply_update_with_state(update, sink, config_state, &mut state)
}

/// Project one ACP update, updating both the persisted configuration snapshot
/// and the transient tool-call projection state.
pub(crate) fn apply_update_with_state(
    update: &Value,
    sink: &EventSink,
    config_state: &mut BTreeMap<String, Value>,
    state: &mut MappingState,
) -> Result<()> {
    let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return Ok(());
    };
    match kind {
        "agent_message_chunk" => {
            let text = content_text(update.get("content").unwrap_or(update));
            if !text.is_empty() {
                emit(sink, ProviderEvent::TextDelta(text))?;
            }
        }
        "user_message_chunk" => {
            // The user's own words are already in the conversation; echoing them
            // would duplicate the message in the transcript.
        }
        "agent_thought_chunk" => {
            let text = content_text(update.get("content").unwrap_or(update));
            if !text.is_empty() {
                emit(sink, ProviderEvent::ReasoningDelta(text))?;
            }
        }
        // v2 upserts: only the streamed chunks are deltas, snapshots carry the
        // current text and are shown once.
        "agent_message" | "agent_thought" => {
            let text = content_text(update.get("content").unwrap_or(update));
            if !text.is_empty() {
                let event = if kind == "agent_message" {
                    ProviderEvent::TextDelta(text)
                } else {
                    ProviderEvent::ReasoningDelta(text)
                };
                emit(sink, event)?;
            }
        }
        "tool_call" => {
            let id = tool_id(update);
            if id.is_empty() {
                return Ok(());
            }
            let index = tool_index(state, &id);
            let name = clean_text(
                update
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or("tool"),
            );
            emit(
                sink,
                ProviderEvent::ToolCallStart {
                    index,
                    id: id.clone(),
                    name,
                },
            )?;
            if let Some(raw) = update.get("rawInput").filter(|value| !value.is_null()) {
                let args = arguments_json(raw);
                state.args.insert(id, args.clone());
                if !args.is_empty() && args != "{}" {
                    emit(sink, ProviderEvent::ToolCallArgsDelta { index, delta: args })?;
                }
            }
        }
        "tool_call_update" | "tool_call_content_chunk" => {
            let id = tool_id(update);
            if id.is_empty() {
                return Ok(());
            }
            let index = tool_index(state, &id);
            if let Some(raw) = update.get("rawInput").filter(|value| !value.is_null()) {
                let args = arguments_json(raw);
                state.args.insert(id.clone(), args.clone());
                if !args.is_empty() && args != "{}" {
                    emit(sink, ProviderEvent::ToolCallArgsDelta { index, delta: args })?;
                }
            }
            if let Some(content) = update.get("content") {
                let chunk = content_text(content);
                if !chunk.is_empty() {
                    emit(sink, ProviderEvent::ToolCallArgsDelta { index, delta: chunk })?;
                }
            }
            if let Some(status) = finish_status(update) {
                let args = state.args.get(&id).cloned().unwrap_or_default();
                emit(sink, ProviderEvent::ToolCallDone { index, arguments: args })?;
                let result = output_text(update);
                let presentation = presentation(update);
                state.output.insert(id.clone(), result.clone());
                emit(
                    sink,
                    ProviderEvent::ToolCallFinished {
                        id,
                        status,
                        result,
                        presentation,
                    },
                )?;
            }
        }
        "usage_update" => {
            let used = update.get("used").and_then(positive_u32);
            let cost = update
                .get("cost")
                .and_then(|cost| cost.get("amount").or_else(|| cost.get("value")))
                .and_then(Value::as_f64);
            let usage = crate::domain::UsageInfo {
                input_tokens: used,
                output_tokens: None,
                reasoning_tokens: None,
                cached_tokens: None,
                cache_read_tokens: None,
                cache_write_tokens: None,
                uncached_input_tokens: None,
                cache_reported: false,
                total_tokens: used,
                cost,
                duration_ms: None,
            };
            emit(sink, ProviderEvent::Usage(usage))?;
            let raw = safe_json(&serde_json::json!({
                "used": update.get("used"),
                "size": update.get("size"),
                "cost": update.get("cost"),
            }));
            if !raw.is_null() {
                emit(sink, ProviderEvent::UsageRaw(raw))?;
            }
        }
        "plan" | "plan_update" | "plan_removed" => {
            emit(sink, ProviderEvent::Plan(safe_json(update)))?;
        }
        "compaction_update" | "compaction_summary_chunk" => {
            emit(sink, ProviderEvent::Compaction(safe_json(update)))?;
        }
        "notice" => {
            let severity = clean_text(
                update
                    .get("severity")
                    .and_then(Value::as_str)
                    .unwrap_or("info"),
            );
            let title = clean_text(update.get("title").and_then(Value::as_str).unwrap_or(""));
            if title.is_empty() {
                return Ok(());
            }
            let description = update
                .get("description")
                .and_then(Value::as_str)
                .map(clean_text)
                .filter(|text| !text.is_empty());
            emit(
                sink,
                ProviderEvent::Notice {
                    severity,
                    title,
                    description,
                },
            )?;
        }
        "config_option_update" => {
            if let Some(options) = update.get("configOptions").and_then(Value::as_array) {
                for option in options {
                    if let (Some(id), Some(value)) = (
                        option.get("id").and_then(Value::as_str),
                        option.get("currentValue").cloned(),
                    ) {
                        config_state.insert(id.to_string(), value);
                    }
                }
            }
            emit(sink, ProviderEvent::Meta(safe_json(update)))?;
        }
        "available_commands_update"
        | "current_mode_update"
        | "session_info_update"
        | "subagent_update"
        | "session_message"
        | "session_message_chunk"
        | "state_update"
        | "terminal_update"
        | "replay_complete" => {
            emit(sink, ProviderEvent::Meta(safe_json(update)))?;
        }
        _ => {}
    }
    Ok(())
}

/// Translate an ACP `stopReason` into the provider error taxonomy.
///
/// `max_tokens`, `max_turn_requests` and `refusal` are terminal answers with a
/// warning in the UI, not failures: the agent already produced its output.
pub fn stop_reason(reason: &str) -> ProviderResult<()> {
    match reason {
        "cancelled" | "cancelled_by_user" => Err(ProviderError::Cancelled),
        "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "" => Ok(()),
        _ => Ok(()),
    }
}

/// Build the provider error for a JSON-RPC error returned by an agent.
pub fn acp_error(code: i64, message: &str) -> ProviderError {
    let structured = StructuredError {
        message: message.to_string(),
        code: Some(code.to_string()),
        ..StructuredError::default()
    };
    match code {
        -32000 => ProviderError::AuthRequired(structured),
        -32800 => ProviderError::Cancelled,
        -32601 | -32022 => ProviderError::UnsupportedCapability(structured),
        -32602 | -32002 => ProviderError::BadRequest(message.to_string()),
        _ => ProviderError::Other(message.to_string()),
    }
}

fn emit(sink: &EventSink, event: ProviderEvent) -> Result<()> {
    sink.send(event)
        .map_err(|_| anyhow::anyhow!("ACP event sink closed"))
}

fn tool_id(update: &Value) -> String {
    update
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(clean_text)
        .unwrap_or_default()
}

fn tool_index(state: &mut MappingState, id: &str) -> usize {
    if let Some(index) = state.ids.iter().position(|known| known == id) {
        return index;
    }
    state.ids.push(id.to_string());
    state.ids.len() - 1
}

/// Terminal statuses finish the UI tool card. Everything else is progress.
fn finish_status(update: &Value) -> Option<String> {
    let status = update.get("status")?.as_str()?;
    match status {
        "completed" | "failed" | "cancelled" | "rejected" => Some(status.to_string()),
        _ => None,
    }
}

fn arguments_json(raw: &Value) -> String {
    match raw {
        Value::String(text) => clean_text(text),
        Value::Null => String::new(),
        other => serde_json::to_string(&safe_json(other)).unwrap_or_default(),
    }
}

fn output_text(update: &Value) -> String {
    if let Some(raw) = update.get("rawOutput").filter(|value| !value.is_null()) {
        return match raw {
            Value::String(text) => clean_text(text),
            other => serde_json::to_string(&safe_json(other)).unwrap_or_default(),
        };
    }
    let mut parts = Vec::new();
    if let Some(content) = update.get("content") {
        let text = content_text(content);
        if !text.is_empty() {
            parts.push(text);
        }
    }
    if let Some(error) = update.get("error").and_then(Value::as_str) {
        parts.push(clean_text(error));
    }
    parts.join("\n")
}

fn presentation(update: &Value) -> Option<Value> {
    let content = update.get("content")?;
    let safe = safe_json(content);
    if safe.is_null() {
        None
    } else {
        Some(safe)
    }
}

/// Extract plain text from an ACP content block or a list of them. Images,
/// audio and resources are deliberately not fetched or rendered here.
fn content_text(value: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                let text = content_text(item);
                if !text.is_empty() {
                    parts.push(text);
                }
            }
        }
        Value::Object(map) => {
            if matches!(map.get("type").and_then(Value::as_str), Some("text") | None) {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    parts.push(clean_text(text));
                }
            }
            if let Some(nested) = map.get("content") {
                let text = content_text(nested);
                if !text.is_empty() {
                    parts.push(text);
                }
            }
        }
        Value::String(text) => parts.push(clean_text(text)),
        _ => {}
    }
    parts.join("")
}

/// Remove control and bidirectional override characters, cap length and drop
/// `_meta`/credential-shaped keys before an agent payload reaches the UI.
pub(crate) fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(256));
    let mut kept = 0usize;
    for ch in raw.chars() {
        let code = ch as u32;
        let bidi = matches!(code, 0x202A..=0x202E | 0x2066..=0x2069 | 0x200E | 0x200F | 0xFEFF);
        if ch == '\n' || ch == '\t' || (!bidi && !ch.is_control()) {
            out.push(ch);
            kept += 1;
            if kept >= MAX_TEXT_CHARS {
                break;
            }
        }
    }
    out
}

fn safe_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    !key.starts_with('_')
        && !["API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
            .iter()
            .any(|needle| upper.contains(needle))
}

fn safe_json(value: &Value) -> Value {
    fn walk(value: &Value, depth: usize) -> Value {
        if depth > MAX_JSON_DEPTH {
            return Value::Null;
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(text) => Value::String(clean_text(text)),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .take(MAX_ARRAY_ITEMS)
                    .map(|item| walk(item, depth + 1))
                    .collect(),
            ),
            Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (key, item) in map {
                    if safe_key(key) {
                        out.insert(key.clone(), walk(item, depth + 1));
                    }
                }
                Value::Object(out)
            }
        }
    }
    walk(value, 0)
}

fn positive_u32(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|number| u32::try_from(number).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn project(
        update: Value,
        config: &mut BTreeMap<String, Value>,
        state: &mut MappingState,
    ) -> Vec<ProviderEvent> {
        let (tx, mut rx) = unbounded_channel();
        apply_update_with_state(&update, &tx, config, state).expect("project update");
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    fn events(update: Value) -> Vec<ProviderEvent> {
        let mut config = BTreeMap::new();
        project(update, &mut config, &mut MappingState::default())
    }

    #[test]
    fn text_and_thought_chunks_map_to_deltas() {
        let text = events(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "hello" }
        }));
        assert_eq!(text.len(), 1);
        assert!(matches!(&text[0], ProviderEvent::TextDelta(delta) if delta == "hello"));

        let thought = events(serde_json::json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": { "type": "text", "text": "thinking" }
        }));
        assert!(matches!(&thought[0], ProviderEvent::ReasoningDelta(delta) if delta == "thinking"));
    }

    #[test]
    fn tool_call_lifecycle_is_stable_and_never_executed_locally() {
        let mut config = BTreeMap::new();
        let mut state = MappingState::default();
        let start = project(
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "name": "read_file",
                "rawInput": { "path": "a.txt" }
            }),
            &mut config,
            &mut state,
        );
        assert!(matches!(
            &start[0],
            ProviderEvent::ToolCallStart { index: 0, id, name }
                if id == "call-1" && name == "read_file"
        ));
        assert!(start.iter().any(|event| matches!(
            event,
            ProviderEvent::ToolCallArgsDelta { index: 0, .. }
        )));

        let finish = project(
            serde_json::json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "rawOutput": "ok"
            }),
            &mut config,
            &mut state,
        );
        assert!(finish.iter().any(|event| matches!(
            event,
            ProviderEvent::ToolCallDone { index: 0, .. }
        )));
        assert!(finish.iter().any(|event| matches!(
            event,
            ProviderEvent::ToolCallFinished { id, status, result, .. }
                if id == "call-1" && status == "completed" && result == "ok"
        )));

        let second = project(
            serde_json::json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-2",
                "title": "second"
            }),
            &mut config,
            &mut state,
        );
        assert!(matches!(
            &second[0],
            ProviderEvent::ToolCallStart { index: 1, .. }
        ));
    }

    #[test]
    fn usage_plan_compaction_and_notice_map_to_events() {
        let usage = events(serde_json::json!({
            "sessionUpdate": "usage_update", "used": 120, "size": 1000,
            "cost": { "amount": 0.5, "currency": "USD" }
        }));
        assert!(usage.iter().any(|event| matches!(
            event,
            ProviderEvent::Usage(value) if value.total_tokens == Some(120) && value.cost == Some(0.5)
        )));
        assert!(usage
            .iter()
            .any(|event| matches!(event, ProviderEvent::UsageRaw(_))));

        let plan = events(serde_json::json!({
            "sessionUpdate": "plan", "entries": [{ "content": "step", "status": "pending" }]
        }));
        assert!(matches!(&plan[0], ProviderEvent::Plan(_)));

        let compaction = events(serde_json::json!({
            "sessionUpdate": "compaction_update", "compactionId": "c1", "status": "started"
        }));
        assert!(matches!(&compaction[0], ProviderEvent::Compaction(_)));

        let notice = events(serde_json::json!({
            "sessionUpdate": "notice", "severity": "warning", "title": "quota", "description": "low"
        }));
        assert!(matches!(
            &notice[0],
            ProviderEvent::Notice { severity, title, description: Some(description) }
                if severity == "warning" && title == "quota" && description == "low"
        ));
    }

    #[test]
    fn config_option_update_updates_state_and_emits_meta() {
        let mut config = BTreeMap::new();
        let mut state = MappingState::default();
        let projected = project(
            serde_json::json!({
                "sessionUpdate": "config_option_update",
                "configOptions": [
                    { "id": "model", "currentValue": "sonnet", "name": "Model", "type": "select" }
                ]
            }),
            &mut config,
            &mut state,
        );
        assert_eq!(config.get("model"), Some(&Value::String("sonnet".into())));
        assert!(matches!(&projected[0], ProviderEvent::Meta(_)));
    }

    #[test]
    fn every_other_variant_is_meta_without_secrets_or_control_characters() {
        for kind in [
            "available_commands_update",
            "current_mode_update",
            "session_info_update",
            "subagent_update",
            "state_update",
            "terminal_update",
            "replay_complete",
        ] {
            let projected = events(serde_json::json!({
                "sessionUpdate": kind,
                "title": "safe\u{202e}text",
                "_meta": { "api_key": "leak" }
            }));
            assert!(matches!(&projected[0], ProviderEvent::Meta(value)
                if value.get("title").and_then(Value::as_str) == Some("safetext")
                    && value.get("_meta").is_none()
                    && value.get("apiKey").is_none()));
        }
    }

    #[test]
    fn stop_reasons_and_rpc_errors_use_the_existing_taxonomy() {
        assert!(stop_reason("end_turn").is_ok());
        assert!(stop_reason("max_tokens").is_ok());
        assert!(matches!(stop_reason("cancelled"), Err(ProviderError::Cancelled)));
        assert!(matches!(
            acp_error(-32000, "login"),
            ProviderError::AuthRequired(_)
        ));
        assert!(matches!(
            acp_error(-32800, "cancelled"),
            ProviderError::Cancelled
        ));
        assert!(matches!(
            acp_error(-32601, "unknown"),
            ProviderError::UnsupportedCapability(_)
        ));
    }


    #[test]
    fn closed_sink_is_an_error() {
        let (tx, rx) = unbounded_channel();
        drop(rx);
        assert!(apply_update(
            &serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "x" }
            }),
            &tx,
            &mut BTreeMap::new(),
        )
        .is_err());
    }

}
