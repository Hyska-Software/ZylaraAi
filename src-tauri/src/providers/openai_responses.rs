//! OpenAI Responses protocol adapter (SSE).
//!
//! Used by GPT, Grok and Muse. Text/reasoning arrive as named events
//! (`response.output_text.delta`, `response.reasoning_summary_text.delta`), tool
//! calls as `response.function_call_arguments.delta` items and the final
//! `response.completed` event carries the full output (used as `provider_state`)
//! plus the usage block.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::catalog::RequestProfile;
use crate::domain::UsageInfo;

use super::sse;
use super::{
    as_u32, cache, emit, image_data_url, make_usage, max_output_tokens, pointer_u32, reasoning,
    system_text, to_provider_error, valid_json_arguments, CompletionRequest, EventSink,
    HistoryMessage, HistoryRole, ProviderError, ProviderEvent, ProviderResult, ReasoningRequest,
    WireProtocol,
};

pub(crate) async fn stream(
    http: &reqwest::Client,
    request: &CompletionRequest,
    sink: &EventSink,
) -> ProviderResult<()> {
    let url = request.config.endpoint_for(WireProtocol::OpenaiResponses)?;
    let mut body = build_body(request);
    // F4b: the harness-owned plan lands on the final wire body before the
    // digest; `digest(apply(body)) == digest(body)` is a contract (cache
    // metadata is outside the hash), so the emitted digest stays valid.
    cache::apply(
        WireProtocol::OpenaiResponses,
        request.cache_plan.as_ref(),
        &mut body,
    );
    super::emit_cache_digest(request, WireProtocol::OpenaiResponses, &body, sink)?;
    let Some(response) =
        super::send_stream_with_cache_fallback(http, request, &url, &body, || build_body(request))
            .await?
    else {
        return Ok(());
    };
    let mut handler = Handler::new(sink, request.config.provider_id.clone());
    let outcome = sse::stream_sse(response, &request.cancel, &request.timeouts, |event, data| {
        handler.on_event(event, data)
    })
    .await;
    if let Err(error) = outcome {
        return Err(to_provider_error(error));
    }
    if request.cancel.is_cancelled() {
        return Ok(());
    }
    if !handler.completed {
        return Err(ProviderError::StreamInterrupted(
            "stream ended without response.completed".to_string(),
        ));
    }
    handler.finish()
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

/// The ChatGPT-plan route replays reasoning only when the items carry their
/// encrypted content: `store: false` resends the whole input every request, so
/// plain reasoning items cannot be round-tripped. Probe G4b validates that the
/// route accepts the field; if it rejects it, flip this to `false` (reasoning
/// items are then dropped from the replay and multi-step continuity of
/// reasoning is lost while the loop keeps working).
const CHATGPT_PLAN_INCLUDE_REASONING: bool = true;

/// Fields the OpenAI plan-route accepts. Everything else is removed from the
/// body (whitelist, not a blocklist), so a future change in the shared body
/// builder cannot silently send a field the preview rejects.
const CHATGPT_PLAN_ALLOWED_FIELDS: &[&str] = &[
    "model",
    "input",
    "stream",
    "store",
    "instructions",
    "tools",
    "include",
    "reasoning",
];

fn build_body(request: &CompletionRequest) -> Value {
    let profile = request.config.request_profile;
    let mut body = json!({
        "model": request.config.model.id,
        "input": build_input(request),
        "stream": true,
    });
    match profile {
        // API-key / gateway path: current behavior preserved.
        RequestProfile::Standard => {
            body["max_output_tokens"] = json!(max_output_tokens(request));
        }
        // ChatGPT-plan path (SIWC): stateless streaming, no output/temperature
        // controls, system prompt only through `instructions`.
        RequestProfile::ChatgptPlan => {
            body["store"] = json!(false);
            if CHATGPT_PLAN_INCLUDE_REASONING {
                body["include"] = json!(["reasoning.encrypted_content"]);
            }
        }
    }
    let system = system_text(request);
    if !system.is_empty() {
        body["instructions"] = json!(system);
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(tools_value(request));
    }
    // Reasoning models reject a custom temperature; only send it when the
    // caller is not explicitly steering reasoning. The plan route rejects it
    // unconditionally, so it is only emitted for the standard profile.
    if matches!(profile, RequestProfile::Standard) {
        if let Some(temperature) = request.temperature {
            if matches!(
                request.reasoning,
                ReasoningRequest::Auto | ReasoningRequest::Off
            ) {
                body["temperature"] = json!(temperature);
            }
        }
    }
    reasoning::apply(
        WireProtocol::OpenaiResponses,
        &request.config.model,
        &request.reasoning,
        &mut body,
    );
    if matches!(profile, RequestProfile::ChatgptPlan) {
        apply_chatgpt_plan_whitelist(&mut body);
    }
    body
}

/// Wire shape of the request tools (`{type, name, description, parameters}`).
/// Shared by the streaming body and the native-compaction body so both send
/// exactly the same tool definitions.
fn tools_value(request: &CompletionRequest) -> Vec<Value> {
    request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        })
        .collect()
}

/// Body of `POST /responses/compact`.
///
/// Stateless w.r.t. the streaming endpoint: `stream`, `store`,
/// `max_output_tokens`, `previous_response_id` and `truncation` are never sent —
/// the endpoint only accepts the conversation prefix (`input`) plus the shape
/// controls (`instructions`, `tools`, `prompt_cache_key`, reasoning).
pub(crate) fn compact_body(request: &CompletionRequest) -> Value {
    let mut body = json!({
        "model": request.config.model.id,
        "input": build_input(request),
    });
    let system = system_text(request);
    if !system.is_empty() {
        body["instructions"] = json!(system);
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(tools_value(request));
    }
    if let Some(key) = request
        .cache_plan
        .as_ref()
        .and_then(|plan| plan.prompt_cache_key.as_ref())
    {
        body["prompt_cache_key"] = json!(key);
    }
    reasoning::apply(
        WireProtocol::OpenaiResponses,
        &request.config.model,
        &request.reasoning,
        &mut body,
    );
    body
}

/// Validate and normalize the `/responses/compact` answer.
///
/// The endpoint returns `{"object":"response.compaction","output":[...]}` where
/// `output` carries the opaque (encrypted) compaction item to replay verbatim.
pub(crate) fn parse_compact_response(value: &Value) -> anyhow::Result<Value> {
    if value.get("object").and_then(Value::as_str) != Some("response.compaction") {
        anyhow::bail!("resposta de compactação sem object=response.compaction: {value}");
    }
    let output = value
        .get("output")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| anyhow::anyhow!("resposta de compactação sem output: {value}"))?;
    Ok(json!({"object": "response.compaction", "output": output}))
}

/// Reduce an already built body to the plan-route whitelist and re-assert the
/// two mandatory flags (`store: false`, `stream: true`).
fn apply_chatgpt_plan_whitelist(body: &mut Value) {
    let current = std::mem::take(body);
    let Some(object) = current.as_object() else {
        *body = current;
        return;
    };
    let mut filtered = serde_json::Map::new();
    for (key, value) in object {
        if CHATGPT_PLAN_ALLOWED_FIELDS.contains(&key.as_str()) {
            filtered.insert(key.clone(), value.clone());
        }
    }
    filtered.insert("store".to_string(), json!(false));
    filtered.insert("stream".to_string(), json!(true));
    *body = Value::Object(filtered);
}

fn build_input(request: &CompletionRequest) -> Vec<Value> {
    let mut input: Vec<Value> = Vec::new();
    for message in &request.history {
        match message.role {
            HistoryRole::System => {}
            HistoryRole::User => input.push(user_item(message)),
            HistoryRole::Assistant => append_assistant(message, &mut input),
            HistoryRole::Tool => {
                let output = if message.images.is_empty() {
                    json!(message.text)
                } else {
                    let mut content = vec![json!({
                        "type": "input_text",
                        "text": message.text,
                    })];
                    for image in &message.images {
                        content.push(json!({
                            "type": "input_image",
                            "image_url": image_data_url(image),
                        }));
                    }
                    json!(content)
                };
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": message.tool_call_id.clone().unwrap_or_default(),
                    "output": output,
                }));
            }
        }
    }
    // The plan route rejects `{role: "system"}` input items outright; the system
    // prompt goes through `instructions`. Defensive: never emit one.
    input.retain(|item| item.get("role").and_then(Value::as_str) != Some("system"));
    input
}

fn user_item(message: &HistoryMessage) -> Value {
    if message.images.is_empty() {
        return json!({"role": "user", "content": message.text});
    }
    let mut content: Vec<Value> = Vec::new();
    if !message.text.trim().is_empty() {
        content.push(json!({"type": "input_text", "text": message.text}));
    }
    for image in &message.images {
        content.push(json!({"type": "input_image", "image_url": image_data_url(image)}));
    }
    json!({"role": "user", "content": content})
}

fn append_assistant(message: &HistoryMessage, input: &mut Vec<Value>) {
    if let Some(state) = &message.provider_state {
        let items = match state {
            Value::Array(items) => Some(items.clone()),
            Value::Object(map) => map.get("output").and_then(Value::as_array).cloned(),
            _ => None,
        };
        if let Some(items) = items {
            let replayable: Vec<Value> = items.into_iter().filter(replayable_output_item).collect();
            if !replayable.is_empty() {
                input.extend(replayable);
                return;
            }
        }
    }
    if !message.text.trim().is_empty() {
        input.push(json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": message.text}],
        }));
    }
    for call in &message.tool_calls {
        input.push(json!({
            "type": "function_call",
            "call_id": call.id,
            "name": call.name,
            "arguments": valid_json_arguments(&call.arguments),
        }));
    }
}

/// Reasoning items can only be replayed statelessly when they carry their
/// encrypted content; everything else in `response.output` is round-trippable.
fn replayable_output_item(item: &Value) -> bool {
    if item.get("type").and_then(Value::as_str) == Some("reasoning") {
        return item
            .get("encrypted_content")
            .and_then(Value::as_str)
            .map(|content| !content.is_empty())
            .unwrap_or(false);
    }
    true
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

struct ResponsesTool {
    call_id: String,
    name: String,
    arguments: String,
    done: bool,
}

struct Handler<'a> {
    sink: &'a EventSink,
    /// Route that produced the request (used to gate the OpenCode gateway
    /// `usage.opencode.tokens` fallback).
    provider_id: String,
    text: String,
    /// Texto já emitido por item de mensagem. Evita duplicar no
    /// `output_item.done` o que veio pelos deltas.
    text_items: HashMap<String, String>,
    /// Item de mensagem atual; uma troca de item vira um parágrafo novo.
    current_text_item: Option<String>,
    usage: Option<UsageInfo>,
    /// Verbatim `response.usage` block (safe excerpt is emitted as `UsageRaw`).
    raw_usage: Option<Value>,
    output: Option<Value>,
    tools: Vec<ResponsesTool>,
    item_to_index: HashMap<String, usize>,
    /// `response.completed`/`response.incomplete` arrived.
    completed: bool,
}

impl<'a> Handler<'a> {
    fn new(sink: &'a EventSink, provider_id: String) -> Self {
        Self {
            sink,
            provider_id,
            text: String::new(),
            text_items: HashMap::new(),
            current_text_item: None,
            usage: None,
            raw_usage: None,
            output: None,
            tools: Vec::new(),
            item_to_index: HashMap::new(),
            completed: false,
        }
    }

    fn on_event(&mut self, event: Option<&str>, data: &str) -> anyhow::Result<()> {
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return Ok(());
        };
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .or(event)
            .unwrap_or_default();
        match event_type {
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        let key = text_item_key(&value);
                        self.append_text(&key, delta)?;
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        emit(self.sink, ProviderEvent::ReasoningDelta(delta.to_string()))?;
                    }
                }
            }
            "response.output_item.added" => self.on_item_added(&value)?,
            "response.function_call_arguments.delta" => self.on_arguments_delta(&value)?,
            "response.function_call_arguments.done" => self.on_arguments_done(&value)?,
            "response.output_item.done" => self.on_item_done(&value)?,
            "response.completed" | "response.incomplete" => {
                self.completed = true;
                self.on_completed(&value)?;
            }
            "response.failed" => {
                let detail = value
                    .pointer("/response/error")
                    .or_else(|| value.get("error"))
                    .cloned()
                    .unwrap_or(value.clone());
                return Err(anyhow::Error::new(ProviderError::from_stream_error(
                    &detail,
                )));
            }
            "error" => {
                let detail = value.get("error").cloned().unwrap_or_else(|| value.clone());
                return Err(anyhow::Error::new(ProviderError::from_stream_error(
                    &detail,
                )));
            }
            _ => {}
        }
        Ok(())
    }

    fn on_item_added(&mut self, value: &Value) -> anyhow::Result<()> {
        let Some(item) = value.get("item") else {
            return Ok(());
        };
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return Ok(());
        }
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let call_id = item
            .get("call_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| item_id.clone());
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let index = self.tools.len();
        if !item_id.is_empty() {
            self.item_to_index.insert(item_id, index);
        }
        emit(
            self.sink,
            ProviderEvent::ToolCallStart {
                index,
                id: call_id.clone(),
                name: name.clone(),
            },
        )?;
        self.tools.push(ResponsesTool {
            call_id,
            name,
            arguments: String::new(),
            done: false,
        });
        Ok(())
    }

    fn on_arguments_delta(&mut self, value: &Value) -> anyhow::Result<()> {
        let item_id = value
            .get("item_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let delta = value
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let index = match self.item_to_index.get(&item_id) {
            Some(index) => *index,
            None => self.ensure_tool(&item_id)?,
        };
        if let Some(tool) = self.tools.get_mut(index) {
            tool.arguments.push_str(delta);
        }
        if !delta.is_empty() {
            emit(
                self.sink,
                ProviderEvent::ToolCallArgsDelta {
                    index,
                    delta: delta.to_string(),
                },
            )?;
        }
        Ok(())
    }

    fn on_arguments_done(&mut self, value: &Value) -> anyhow::Result<()> {
        let item_id = value
            .get("item_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let index = match self.item_to_index.get(&item_id) {
            Some(index) => *index,
            None => self.ensure_tool(&item_id)?,
        };
        if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
            if !arguments.is_empty() {
                if let Some(tool) = self.tools.get_mut(index) {
                    tool.arguments = arguments.to_string();
                }
            }
        }
        self.finish_tool(index)
    }

    fn on_item_done(&mut self, value: &Value) -> anyhow::Result<()> {
        let Some(item) = value.get("item") else {
            return Ok(());
        };
        match item.get("type").and_then(Value::as_str) {
            Some("function_call") => {
                let item_id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let index = match self.item_to_index.get(&item_id) {
                    Some(index) => *index,
                    None => self.ensure_tool(&item_id)?,
                };
                if let Some(tool) = self.tools.get_mut(index) {
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        if !arguments.is_empty() {
                            tool.arguments = arguments.to_string();
                        }
                    }
                    if tool.name.is_empty() {
                        if let Some(name) = item.get("name").and_then(Value::as_str) {
                            tool.name = name.to_string();
                        }
                    }
                }
                self.finish_tool(index)
            }
            Some("message") => {
                // Some gateways skip the incremental deltas; recover the text
                // from the finished output item. If this item already streamed,
                // only a missing suffix is appended (never the prefix twice). A
                // different item starts a new paragraph, never glued to the
                // previous one.
                let key = text_item_key(value);
                let mut recovered = String::new();
                if let Some(content) = item.get("content").and_then(Value::as_array) {
                    for part in content {
                        if part.get("type").and_then(Value::as_str) == Some("output_text") {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                recovered.push_str(text);
                            }
                        }
                    }
                }
                if recovered.is_empty() {
                    return Ok(());
                }
                if let Some(streamed) = self.text_items.get(&key).cloned() {
                    if recovered.starts_with(&streamed) {
                        let suffix = &recovered[streamed.len()..];
                        if !suffix.is_empty() {
                            self.text.push_str(suffix);
                            if let Some(buffer) = self.text_items.get_mut(&key) {
                                buffer.push_str(suffix);
                            }
                            emit(self.sink, ProviderEvent::TextDelta(suffix.to_string()))?;
                        }
                    }
                    return Ok(());
                }
                self.append_text(&key, &recovered)?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn on_completed(&mut self, value: &Value) -> anyhow::Result<()> {
        let Some(response) = value.get("response") else {
            return Ok(());
        };
        if let Some(output) = response.get("output") {
            if output.is_array() {
                self.output = Some(output.clone());
            }
        }
        if let Some(usage) = response.get("usage").filter(|usage| !usage.is_null()) {
            self.raw_usage = Some(usage.clone());
            self.usage = Some(parse_usage(usage, &self.provider_id));
        }
        if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
            return Err(anyhow::Error::new(ProviderError::from_stream_error(error)));
        }
        Ok(())
    }

    /// Anexa texto ao item de mensagem `key`. Um item diferente do anterior
    /// começa um novo parágrafo; item vazio não deixa separador.
    fn append_text(&mut self, key: &str, text: &str) -> anyhow::Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        if self.current_text_item.as_deref() != Some(key) {
            if !self.text.is_empty() {
                self.text.push_str("\n\n");
                emit(self.sink, ProviderEvent::TextDelta("\n\n".to_string()))?;
            }
            self.current_text_item = Some(key.to_string());
        }
        self.text.push_str(text);
        self.text_items
            .entry(key.to_string())
            .or_default()
            .push_str(text);
        emit(self.sink, ProviderEvent::TextDelta(text.to_string()))
    }

    fn ensure_tool(&mut self, item_id: &str) -> anyhow::Result<usize> {
        let index = self.tools.len();
        let call_id = if item_id.is_empty() {
            format!("call_{index}")
        } else {
            item_id.to_string()
        };
        if !item_id.is_empty() {
            self.item_to_index.insert(item_id.to_string(), index);
        }
        emit(
            self.sink,
            ProviderEvent::ToolCallStart {
                index,
                id: call_id.clone(),
                name: String::new(),
            },
        )?;
        self.tools.push(ResponsesTool {
            call_id,
            name: String::new(),
            arguments: String::new(),
            done: false,
        });
        Ok(index)
    }

    fn finish_tool(&mut self, index: usize) -> anyhow::Result<()> {
        let Some(tool) = self.tools.get_mut(index) else {
            return Ok(());
        };
        if tool.done {
            return Ok(());
        }
        tool.done = true;
        let arguments = super::normalize_arguments(&tool.arguments);
        emit(self.sink, ProviderEvent::ToolCallDone { index, arguments })?;
        Ok(())
    }

    fn finish(mut self) -> ProviderResult<()> {
        for index in 0..self.tools.len() {
            self.finish_tool(index).map_err(to_provider_error)?;
        }

        let state = match self.output.take() {
            Some(output) => output,
            None => self.build_fallback_output(),
        };
        if let Some(usage) = self.usage.take() {
            emit(self.sink, ProviderEvent::Usage(usage)).map_err(to_provider_error)?;
        }
        // Safe raw usage excerpt for the diagnostics panel, before the state/Done.
        super::emit_usage_raw(self.sink, self.raw_usage.as_ref())?;
        emit(self.sink, ProviderEvent::ProviderState(state)).map_err(to_provider_error)?;
        emit(self.sink, ProviderEvent::Done).map_err(to_provider_error)?;
        Ok(())
    }

    fn build_fallback_output(&self) -> Value {
        let mut output: Vec<Value> = Vec::new();
        if !self.text.is_empty() {
            output.push(json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": self.text}],
            }));
        }
        for tool in &self.tools {
            output.push(json!({
                "type": "function_call",
                "call_id": tool.call_id,
                "name": tool.name,
                "arguments": valid_json_arguments(&tool.arguments),
            }));
        }
        Value::Array(output)
    }
}

/// Chave estável do item de texto: `item.id` no `output_item.done`, `item_id`
/// nos deltas e `output_index` como fallback quando o gateway omite o id.
fn text_item_key(value: &Value) -> String {
    value
        .get("item")
        .and_then(|item| item.get("id"))
        .or_else(|| value.get("item_id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("output_index")
                .and_then(as_u32)
                .map(|index| format!("output:{index}"))
        })
        .unwrap_or_else(|| "default".to_string())
}

fn parse_usage(usage: &Value, provider_id: &str) -> UsageInfo {
    let input = pointer_u32(usage, "/input_tokens");
    let output = pointer_u32(usage, "/output_tokens");
    let reasoning = pointer_u32(usage, "/output_tokens_details/reasoning_tokens");
    let cached = pointer_u32(usage, "/input_tokens_details/cached_tokens");
    let total = pointer_u32(usage, "/total_tokens");
    let mut info = make_usage(input, output, reasoning, cached, total);
    // Normalized cache counters (read/write/uncached) for the responses route.
    cache::apply_usage(
        &mut info,
        &cache::normalize_usage(WireProtocol::OpenaiResponses, provider_id, usage),
    );
    info
}

/* ------------------------------------------------------------------ */
/* Request-profile tests                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogFile, ProviderAuth};
    use crate::providers::{ProviderConfig, ToolDefinition};
    use tokio_util::sync::CancellationToken;

    #[test]
    fn tool_image_is_sent_in_function_call_output_content() {
        let mut request = test_request(RequestProfile::Standard, ReasoningRequest::Auto);
        let mut message = HistoryMessage::tool_result("call_1", "computer_screenshot", "ok");
        message.images.push(crate::providers::ImagePart {
            mime_type: "image/jpeg".to_string(),
            data_base64: "abc".to_string(),
        });
        request.history = vec![message];
        let input = build_input(&request);
        assert_eq!(input[0]["type"], json!("function_call_output"));
        assert_eq!(input[0]["output"][1]["type"], json!("input_image"));
    }

    fn test_request(profile: RequestProfile, reasoning: ReasoningRequest) -> CompletionRequest {
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog.provider("openai").expect("provedor openai");
        let model = catalog
            .model("openai", "gpt-6.1-sol")
            .expect("modelo gpt-6.1-sol")
            .clone();
        CompletionRequest {
            config: ProviderConfig {
                provider_id: provider.id.clone(),
                provider_name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                api_key: "sk-test".to_string(),
                auth_header: provider.auth_header.clone(),
                auth_prefix: provider.auth_prefix.clone(),
                model,
                session_id: "session".to_string(),
                user_agent: "Zylara/test".to_string(),
                endpoints: provider.endpoints.clone(),
                request_profile: profile,
                auth_mode: if matches!(profile, RequestProfile::ChatgptPlan) {
                    ProviderAuth::Oauth
                } else {
                    ProviderAuth::ApiKey
                },
                extra_headers: Vec::new(),
            },
            protocols: vec![WireProtocol::OpenaiResponses],
            history: vec![
                HistoryMessage::system("system from history"),
                HistoryMessage::user("hello"),
                HistoryMessage::assistant("hi there"),
                HistoryMessage::tool_result("call_1", "echo", r#"{"ok":true}"#),
            ],
            system_prompt: "You are Zylara.".to_string(),
            tools: vec![ToolDefinition {
                name: "echo".to_string(),
                description: "Echo text back.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                }),
            }],
            reasoning,
            max_output_tokens: Some(2_048),
            temperature: Some(0.3),
            cache_plan: None,
            timeouts: crate::providers::StreamTimeouts::default(),
            cancel: CancellationToken::new(),
        }
    }

    fn plan_request() -> CompletionRequest {
        test_request(
            RequestProfile::ChatgptPlan,
            ReasoningRequest::Effort("high".to_string()),
        )
    }

    #[test]
    fn standard_profile_keeps_the_current_body() {
        let request = test_request(RequestProfile::Standard, ReasoningRequest::Auto);
        let body = build_body(&request);

        assert_eq!(body["model"], json!("gpt-6.1-sol"));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["max_output_tokens"], json!(2_048));
        assert!(body.get("store").is_none(), "padrão não envia store");
        assert!(
            body.get("include").is_none(),
            "include é só do perfil do plano"
        );
        assert_eq!(
            body["instructions"],
            json!("You are Zylara.\n\nsystem from history")
        );
        assert_eq!(body["tools"][0]["type"], json!("function"));
        assert_eq!(body["tools"][0]["name"], json!("echo"));
        assert!(body.get("temperature").is_some(), "temperatura preservada");

        // system message from the history never becomes an input item.
        for item in body["input"].as_array().expect("input array") {
            assert_ne!(item["role"], json!("system"));
        }
    }

    /// `/responses/compact` receives the conversation prefix plus the shape
    /// controls, never the streaming-only fields.
    #[test]
    fn openai_compact_body_omits_stream_and_carries_input_instructions_tools() {
        let mut request = test_request(RequestProfile::Standard, ReasoningRequest::Auto);
        request.cache_plan = Some(cache::CachePlan {
            mode: cache::CacheMode::Auto,
            breakpoints: Vec::new(),
            prompt_cache_key: Some("k".repeat(64)),
            retention: None,
            ttl: None,
        });
        let body = compact_body(&request);

        assert_eq!(body["model"], json!("gpt-6.1-sol"));
        assert_eq!(body["input"], json!(build_input(&request)));
        assert_eq!(
            body["instructions"],
            json!("You are Zylara.\n\nsystem from history")
        );
        assert_eq!(body["tools"][0]["type"], json!("function"));
        assert_eq!(body["tools"][0]["name"], json!("echo"));
        assert_eq!(body["prompt_cache_key"], json!("k".repeat(64)));

        for forbidden in [
            "stream",
            "store",
            "max_output_tokens",
            "previous_response_id",
            "truncation",
        ] {
            assert!(
                body.get(forbidden).is_none(),
                "{forbidden} não pode ir no corpo de compactação: {body}"
            );
        }
    }

    #[test]
    fn openai_compact_response_requires_response_compaction_object() {
        let item = json!({
            "type": "compaction",
            "id": "cmp_1",
            "encrypted_content": "opaque",
        });
        let parsed = parse_compact_response(&json!({
            "object": "response.compaction",
            "output": [item],
        }))
        .expect("resposta de compactação válida");
        assert_eq!(parsed["object"], json!("response.compaction"));
        assert_eq!(parsed["output"], json!([item]));

        // Wrong object / missing or empty output are contract violations.
        assert!(
            parse_compact_response(&json!({"object": "response", "output": [item]})).is_err()
        );
        assert!(parse_compact_response(
            &json!({"object": "response.compaction", "output": []})
        )
        .is_err());
        assert!(parse_compact_response(&json!({"object": "response.compaction"})).is_err());
    }

    #[test]
    fn chatgpt_plan_profile_only_sends_whitelisted_fields() {
        let request = plan_request();
        let body = build_body(&request);

        // Mandatory flags.
        assert_eq!(body["store"], json!(false));
        assert_eq!(body["stream"], json!(true));

        // Every field PLAN §1.4 says to omit.
        for forbidden in [
            "max_output_tokens",
            "max_tool_calls",
            "max_output_tokens",
            "temperature",
            "top_p",
            "top_logprobs",
            "metadata",
            "moderation",
            "multi_agent",
            "prompt",
            "prompt_cache_retention",
            "previous_response_id",
            "safety_identifier",
            "truncation",
            "user",
            "background",
            "conversation",
        ] {
            assert!(
                body.get(forbidden).is_none(),
                "campo proibido no perfil chatgpt-plan: {forbidden} ({body})"
            );
        }
        // The body is literally the whitelist.
        for key in body.as_object().expect("objeto").keys() {
            assert!(
                CHATGPT_PLAN_ALLOWED_FIELDS.contains(&key.as_str()),
                "campo fora da whitelist do plano: {key}"
            );
        }

        // Preserved: instructions, client function tools, reasoning.
        assert_eq!(
            body["instructions"],
            json!("You are Zylara.\n\nsystem from history")
        );
        assert_eq!(body["tools"][0]["type"], json!("function"));
        assert_eq!(body["tools"][0]["name"], json!("echo"));
        assert_eq!(body["reasoning"]["effort"], json!("high"));

        // Reasoning replay is opt-in behind the probe (G4b).
        if CHATGPT_PLAN_INCLUDE_REASONING {
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        } else {
            assert!(body.get("include").is_none());
        }

        // Never a `{role:"system"}` input item: system goes to `instructions`.
        for item in body["input"].as_array().expect("input array") {
            assert_ne!(
                item["role"],
                json!("system"),
                "item de sistema no input: {item}"
            );
        }
    }

    #[test]
    fn chatgpt_plan_replay_keeps_only_encrypted_reasoning() {
        let mut request = plan_request();
        request.history = vec![
            HistoryMessage::user("pergunta"),
            HistoryMessage {
                role: HistoryRole::Assistant,
                text: "resposta".to_string(),
                images: Vec::new(),
                reasoning: Some("thinking".to_string()),
                reasoning_signature: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
                tool_name: None,
                provider_state: Some(json!([
                    {"type": "reasoning", "encrypted_content": "enc-1"},
                    {"type": "reasoning"},
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "resposta"}]
                    }
                ])),
            },
        ];
        let body = build_body(&request);
        let items = body["input"].as_array().expect("input array");
        assert_eq!(
            items.len(),
            3,
            "user + reasoning cifrado + mensagem: {body}"
        );
        assert_eq!(items[1]["type"], json!("reasoning"));
        assert_eq!(items[1]["encrypted_content"], json!("enc-1"));
        assert_eq!(items[2]["type"], json!("message"));
    }

    #[test]
    fn response_failed_with_quota_code_maps_to_plan_limit() {
        let (sink, _events) = tokio::sync::mpsc::unbounded_channel();
        let mut handler = Handler::new(&sink, "openai".to_string());
        let error = handler
            .on_event(
                None,
                r#"{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"quota"}}}"#,
            )
            .expect_err("response.failed deveria virar erro");
        let error = error
            .downcast::<ProviderError>()
            .expect("erro tipado de provedor");
        assert!(matches!(error, ProviderError::PlanLimit(_)), "{error:?}");
        assert_eq!(
            error.provider_code(),
            Some("subscription_sharing_usage_limit_exceeded")
        );
    }

    #[test]
    fn parse_usage_fills_cached_and_write_tokens() {
        let usage = parse_usage(
            &json!({
                "input_tokens": 20_000,
                "output_tokens": 100,
                "output_tokens_details": {"reasoning_tokens": 40},
                "input_tokens_details": {
                    "cached_tokens": 16_000,
                    "cache_write_tokens": 2_000,
                },
            }),
            "openai",
        );
        assert!(usage.cache_reported);
        assert_eq!(usage.cached_tokens, Some(16_000), "alias legado");
        assert_eq!(usage.cache_read_tokens, Some(16_000));
        assert_eq!(usage.cache_write_tokens, Some(2_000));
        assert_eq!(usage.uncached_input_tokens, Some(2_000));
        assert_eq!(usage.input_tokens, Some(20_000));
        assert_eq!(usage.reasoning_tokens, Some(40));
    }

    #[test]
    fn parse_usage_without_cache_counters_is_not_reported() {
        let usage = parse_usage(&json!({"input_tokens": 800, "output_tokens": 20}), "openai");
        assert!(!usage.cache_reported);
        assert_eq!(usage.cache_read_tokens, None);
        assert_eq!(usage.uncached_input_tokens, Some(800));
    }

    /// F4b: the adapter lowers the plan onto the final body before the digest.
    /// No plan → byte-for-byte identical body; with a plan, key/retention are
    /// added and the prefix digest does not change.
    #[test]
    fn cache_plan_is_applied_before_the_digest() {
        let mut request = test_request(RequestProfile::Standard, ReasoningRequest::Auto);
        let plain = build_body(&request);
        let mut without_plan = build_body(&request);
        cache::apply(WireProtocol::OpenaiResponses, None, &mut without_plan);
        assert_eq!(without_plan, plain, "sem plano o body não muda");

        request.cache_plan = Some(cache::CachePlan {
            mode: cache::CacheMode::Auto,
            breakpoints: Vec::new(),
            prompt_cache_key: Some("a".repeat(64)),
            retention: Some("24h".to_string()),
            ttl: None,
        });
        let mut planned = build_body(&request);
        cache::apply(
            WireProtocol::OpenaiResponses,
            request.cache_plan.as_ref(),
            &mut planned,
        );
        assert_eq!(planned["prompt_cache_key"], json!("a".repeat(64)));
        assert_eq!(planned["prompt_cache_retention"], json!("24h"));

        let digest_plain = cache::digest(WireProtocol::OpenaiResponses, "openai", &plain);
        let digest_planned = cache::digest(WireProtocol::OpenaiResponses, "openai", &planned);
        assert_eq!(digest_plain.segments, digest_planned.segments);
        assert_eq!(digest_plain.total_chars, digest_planned.total_chars);
    }

    /// Itens `message` distintos na mesma resposta são parágrafos distintos.
    #[tokio::test]
    async fn handler_separates_distinct_message_items() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut handler = Handler::new(&sink, "openai".to_string());
            handler
                .on_event(
                    None,
                    r#"{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"Primeiro."}"#,
                )
                .expect("texto 1");
            handler
                .on_event(
                    None,
                    r#"{"type":"response.output_text.delta","item_id":"msg_2","output_index":1,"delta":"Segundo."}"#,
                )
                .expect("texto 2");
            handler.finish().expect("finish");
        }

        let mut deltas = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let ProviderEvent::TextDelta(delta) = event {
                deltas.push(delta);
            }
        }
        assert_eq!(deltas, vec!["Primeiro.", "\n\n", "Segundo."]);
    }

    /// A recuperação de `output_item.done` respeita a fronteira e não duplica
    /// o texto que já chegou por delta no mesmo item.
    #[tokio::test]
    async fn handler_recovers_finished_items_without_duplicating_deltas() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut handler = Handler::new(&sink, "openai".to_string());
            handler
                .on_event(
                    None,
                    r#"{"type":"response.output_text.delta","item_id":"msg_1","delta":"A"}"#,
                )
                .expect("delta");
            handler
                .on_event(
                    None,
                    r#"{"type":"response.output_item.done","item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"AB"}]}}"#,
                )
                .expect("item 1 completa o sufixo sem duplicar");
            handler
                .on_event(
                    None,
                    r#"{"type":"response.output_item.done","item":{"id":"msg_2","type":"message","content":[{"type":"output_text","text":"C"}]}}"#,
                )
                .expect("item 2 recuperado");
            handler.finish().expect("finish");
        }

        let mut deltas = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let ProviderEvent::TextDelta(delta) = event {
                deltas.push(delta);
            }
        }
        assert_eq!(deltas, vec!["A", "B", "\n\n", "C"]);
    }

    /// B2: `UsageRaw` carries the safe `response.usage` excerpt after `Usage`.
    #[test]
    fn usage_raw_is_emitted_after_usage_with_a_safe_excerpt() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut handler = Handler::new(&sink, "openai".to_string());
            handler
                .on_event(
                    None,
                    r#"{"type":"response.completed","response":{
                        "output":[],
                        "usage":{"input_tokens":20000,"output_tokens":100,
                            "input_tokens_details":{"cached_tokens":16000,"cache_write_tokens":2000},
                            "output_tokens_details":{"reasoning_tokens":40},
                            "service_tier":"default",
                            "prompt":"SEGREDO","authorization":"Bearer sk-secret"}}}"#,
                )
                .expect("response.completed");
            handler.finish().expect("finish");
        }

        let mut order: Vec<&'static str> = Vec::new();
        let mut raw = None;
        while let Ok(event) = events.try_recv() {
            match event {
                ProviderEvent::Usage(_) => order.push("usage"),
                ProviderEvent::UsageRaw(value) => {
                    order.push("usage_raw");
                    raw = Some(value);
                }
                ProviderEvent::Done => order.push("done"),
                _ => {}
            }
        }
        assert_eq!(order, vec!["usage", "usage_raw", "done"]);
        let raw = raw.expect("UsageRaw emitido");
        assert_eq!(raw["input_tokens_details"]["cached_tokens"], json!(16_000));
        assert_eq!(raw["output_tokens_details"]["reasoning_tokens"], json!(40));
        assert_eq!(raw["service_tier"], json!("default"));
        let serialized = raw.to_string();
        assert!(!serialized.contains("SEGREDO"), "{serialized}");
        assert!(!serialized.contains("sk-secret"), "{serialized}");
        assert!(!serialized.contains("authorization"), "{serialized}");
    }

    /// Live smoke of the standalone compaction endpoint. Skipped without a key.
    #[tokio::test]
    #[ignore = "live: requires OPENAI_API_KEY"]
    async fn live_openai_responses_compact_returns_a_compaction_item() {
        let Ok(key) = std::env::var("OPENAI_API_KEY") else {
            return;
        };
        let response = reqwest::Client::new()
            .post("https://api.openai.com/v1/responses/compact")
            .bearer_auth(key)
            .json(&json!({
                "model": "gpt-6-luna",
                "instructions": "You are a coding assistant.",
                "input": [
                    {"role": "user", "content": "We are building a small CLI."},
                    {"role": "assistant", "content": "Use a single command with subcommands."},
                    {"role": "user", "content": "Now add a config file."}
                ]
            }))
            .send()
            .await
            .expect("compact request");
        assert!(
            response.status().is_success(),
            "compact status: {}",
            response.status()
        );
        let value: Value = response.json().await.expect("compact json");
        let parsed = parse_compact_response(&value).expect("compacted response");
        assert!(parsed["output"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["type"] == "compaction"
                    && item["encrypted_content"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty())
            })
        }));
    }
}
