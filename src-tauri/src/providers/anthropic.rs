//! Anthropic Messages protocol adapter (SSE).
//!
//! Used by Claude, MiniMax, Kimi K3/K3.1 and some Qwen models. Streaming events:
//! `message_start` (usage), `content_block_start/delta/stop` (`text_delta`,
//! `thinking_delta`, `signature_delta`, `input_json_delta`), `message_delta`
//! (usage + stop reason) and `message_stop`. The assembled assistant content
//! blocks (including thinking blocks with their signatures) are emitted as
//! `ProviderState` so the next tool-loop step can replay them verbatim.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::sse;
use super::{
    as_u32, cache, emit, image_base64, make_usage, max_output_tokens, normalize_arguments,
    parse_arguments, reasoning, system_text, to_provider_error, CompletionRequest, EventSink,
    HistoryMessage, HistoryRole, ProviderError, ProviderEvent, ProviderResult, WireProtocol,
};

pub(crate) async fn stream(
    http: &reqwest::Client,
    request: &CompletionRequest,
    sink: &EventSink,
) -> ProviderResult<()> {
    let url = request.config.endpoint_for(WireProtocol::Anthropic)?;
    let mut body = build_body(request);
    // F4b: the harness-owned plan lands on the final wire body before the
    // digest; `digest(apply(body)) == digest(body)` is a contract (cache
    // metadata is outside the hash), so the emitted digest stays valid.
    cache::apply(
        WireProtocol::Anthropic,
        request.cache_plan.as_ref(),
        &mut body,
    );
    super::emit_cache_digest(request, WireProtocol::Anthropic, &body, sink)?;
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
            "stream ended without message_stop".to_string(),
        ));
    }
    handler.finish()
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

/// Messages / system / tool definitions shared by every body this adapter
/// builds (streaming and native compaction).
fn request_parts(request: &CompletionRequest) -> (Vec<Value>, String, Vec<Value>) {
    let mut messages: Vec<Value> = Vec::new();
    for message in &request.history {
        match message.role {
            HistoryRole::System => {}
            HistoryRole::User => {
                let blocks = user_blocks(message);
                if !blocks.is_empty() {
                    push_blocks(&mut messages, "user", blocks);
                }
            }
            HistoryRole::Assistant => {
                if let Some(blocks) = assistant_blocks(message) {
                    push_blocks(&mut messages, "assistant", blocks);
                }
            }
            HistoryRole::Tool => push_tool_result(&mut messages, message),
        }
    }
    let system = system_text(request);
    let tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            })
        })
        .collect();
    (messages, system, tools)
}

/// Assemble a Messages body. `stream` and `max_tokens` are the only fields
/// that differ between the streaming endpoint and the on-demand compaction
/// endpoint, so both share this builder.
fn base_body(request: &CompletionRequest, stream: bool, max_tokens: u32) -> Value {
    let model = &request.config.model;
    let (messages, system, tools) = request_parts(request);
    let mut body = json!({
        "model": model.id,
        "max_tokens": max_tokens,
        "messages": messages,
    });
    if stream {
        body["stream"] = json!(true);
    }
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    reasoning::apply(
        WireProtocol::Anthropic,
        model,
        &request.reasoning,
        &mut body,
    );

    // With extended thinking enabled `max_tokens` must exceed `budget_tokens`.
    if let Some(budget) = body.pointer("/thinking/budget_tokens").and_then(as_u32) {
        let required = budget.saturating_add(1_024);
        let current = body.get("max_tokens").and_then(as_u32).unwrap_or(0);
        if current < required {
            body["max_tokens"] = json!(required);
        }
    }
    // Thinking and custom temperature are mutually exclusive on Anthropic.
    if body.get("thinking").is_none() {
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
    }
    body
}

fn build_body(request: &CompletionRequest) -> Value {
    base_body(request, true, max_output_tokens(request))
}

/// Body of the on-demand compaction request (`POST /v1/messages` with
/// `compaction: {"type": "summarize"}` and the `compact-2026-09-04` beta).
///
/// Same conversation prefix, system and tools as the streaming body; no
/// `stream`, and no output shaping (`output_config`) — the beta only accepts
/// the request shape plus the compaction directive.
pub(crate) fn compaction_body(request: &CompletionRequest) -> Value {
    let max_tokens = max_output_tokens(request).clamp(4_096, 8_192);
    let mut body = base_body(request, false, max_tokens);
    body["compaction"] = json!({"type": "summarize"});
    if let Some(object) = body.as_object_mut() {
        // Effort shaping is meaningless for a summarization call and the beta
        // rejects output shaping; keep only thinking.
        let _ = object.remove("output_config");
    }
    body
}

/// Validate the on-demand compaction answer.
///
/// Shape: `stop_reason == "compaction"` and exactly one `content[]` block of
/// `type == "compaction"`, carrying the readable `content` and its `signature`.
/// Returns the assistant replay state and the readable summary text.
pub(crate) fn parse_compaction_response(value: &Value) -> anyhow::Result<(Value, String)> {
    if value.get("stop_reason").and_then(Value::as_str) != Some("compaction") {
        anyhow::bail!(
            "{}",
            crate::i18n::t_args(
                "providers.errors.compactionUnexpectedStopReason",
                &[("value", &value.to_string())]
            )
        );
    }
    let block = value
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            let mut matches = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("compaction"));
            match (matches.next(), matches.next()) {
                (Some(block), None) => Some(block),
                _ => None,
            }
        })
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{}",
                crate::i18n::t_args(
                    "providers.errors.compactionRequiresOneBlock",
                    &[("value", &value.to_string())]
                )
            )
        })?;
    let text = block
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let signature = block
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if text.trim().is_empty() || signature.trim().is_empty() {
        anyhow::bail!(
            "{}",
            crate::i18n::t_args(
                "providers.errors.compactionMissingContentOrSignature",
                &[("value", &value.to_string())]
            )
        );
    }
    Ok((
        json!({"role": "assistant", "content": [block]}),
        text.to_string(),
    ))
}

fn user_blocks(message: &HistoryMessage) -> Vec<Value> {
    let mut blocks: Vec<Value> = Vec::new();
    if !message.text.trim().is_empty() {
        blocks.push(json!({"type": "text", "text": message.text}));
    }
    for image in &message.images {
        let (media_type, data) = image_base64(image);
        blocks.push(json!({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }));
    }
    blocks
}

fn assistant_blocks(message: &HistoryMessage) -> Option<Vec<Value>> {
    if let Some(state) = &message.provider_state {
        let blocks = match state {
            Value::Array(blocks) => Some(blocks.clone()),
            Value::Object(map) => map.get("content").and_then(Value::as_array).cloned(),
            _ => None,
        };
        if let Some(blocks) = blocks {
            if !blocks.is_empty() {
                return Some(blocks);
            }
        }
    }
    let mut blocks: Vec<Value> = Vec::new();
    if let (Some(reasoning), Some(signature)) = (&message.reasoning, &message.reasoning_signature) {
        if !reasoning.trim().is_empty() && !signature.trim().is_empty() {
            blocks.push(json!({
                "type": "thinking",
                "thinking": reasoning,
                "signature": signature,
            }));
        }
    }
    if !message.text.trim().is_empty() {
        blocks.push(json!({"type": "text", "text": message.text}));
    }
    for call in &message.tool_calls {
        blocks.push(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": parse_arguments(&call.arguments),
        }));
    }
    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

/// Merge consecutive blocks for the same role; the Messages API requires
/// alternating user/assistant turns and groups tool results in one user turn.
fn push_blocks(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({"role": role, "content": blocks}));
}

fn push_tool_result(messages: &mut Vec<Value>, message: &HistoryMessage) {
    let content = if message.images.is_empty() {
        json!(message.text)
    } else {
        let mut blocks = vec![json!({"type": "text", "text": message.text})];
        for image in &message.images {
            let (media_type, data) = image_base64(image);
            blocks.push(json!({
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            }));
        }
        json!(blocks)
    };
    let block = json!({
        "type": "tool_result",
        "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
        "content": content,
    });
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("user") {
            if let Some(content) = last.get_mut("content").and_then(Value::as_array_mut) {
                content.push(block);
                return;
            }
        }
    }
    messages.push(json!({"role": "user", "content": [block]}));
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

enum BlockState {
    Text(String),
    Thinking {
        text: String,
        signature: String,
    },
    ToolUse {
        id: String,
        name: String,
        json: String,
        done: bool,
    },
    Redacted(Value),
    Other,
}

struct Handler<'a> {
    sink: &'a EventSink,
    /// Route that produced the request (used to gate the OpenCode gateway
    /// `usage.opencode.tokens` fallback).
    provider_id: String,
    blocks: BTreeMap<usize, BlockState>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    reasoning_tokens: Option<u32>,
    cached_tokens: Option<u32>,
    /// Cache counters merged across `message_start` and `message_delta`
    /// (`input_tokens` arrives in the first, `output_tokens` is cumulative in
    /// the latter; the cache fields may arrive in either).
    raw_usage: Value,
    has_usage: bool,
    /// Já houve texto emitido neste request. Usado para separar blocos de
    /// texto distintos com um parágrafo (defensivo: o mesmo turno pode ter
    /// mais de um bloco `text` na mesma resposta).
    has_text: bool,
    /// Um novo bloco de texto começou depois de outro texto; o separador entra
    /// no primeiro delta para não sobrar quando o bloco vier vazio.
    pending_text_break: bool,
    /// `message_stop` arrived; the Messages API reached its end.
    completed: bool,
}

impl<'a> Handler<'a> {
    fn new(sink: &'a EventSink, provider_id: String) -> Self {
        Self {
            sink,
            provider_id,
            blocks: BTreeMap::new(),
            input_tokens: None,
            output_tokens: None,
            reasoning_tokens: None,
            cached_tokens: None,
            raw_usage: json!({}),
            has_usage: false,
            has_text: false,
            pending_text_break: false,
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
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.merge_usage(usage);
                }
            }
            "content_block_start" => {
                let index = value.get("index").and_then(as_u32).unwrap_or(0) as usize;
                let Some(block) = value.get("content_block") else {
                    return Ok(());
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        // Blocos de texto consecutivos são parágrafos
                        // distintos; o separador só entra no primeiro delta do
                        // novo bloco (bloco vazio não deixa separador).
                        self.pending_text_break = self.has_text;
                        self.blocks.insert(index, BlockState::Text(text));
                    }
                    Some("thinking") => {
                        let text = block
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let signature = block
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        self.blocks
                            .insert(index, BlockState::Thinking { text, signature });
                    }
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        emit(
                            self.sink,
                            ProviderEvent::ToolCallStart {
                                index,
                                id: id.clone(),
                                name: name.clone(),
                            },
                        )?;
                        self.blocks.insert(
                            index,
                            BlockState::ToolUse {
                                id,
                                name,
                                json: String::new(),
                                done: false,
                            },
                        );
                    }
                    Some("redacted_thinking") => {
                        self.blocks
                            .insert(index, BlockState::Redacted(block.clone()));
                    }
                    _ => {
                        self.blocks.insert(index, BlockState::Other);
                    }
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(as_u32).unwrap_or(0) as usize;
                let Some(delta) = value.get("delta") else {
                    return Ok(());
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !text.is_empty() {
                            if self.pending_text_break {
                                self.pending_text_break = false;
                                emit(
                                    self.sink,
                                    ProviderEvent::TextDelta("\n\n".to_string()),
                                )?;
                            }
                            if let Some(BlockState::Text(buffer)) = self.blocks.get_mut(&index) {
                                buffer.push_str(text);
                            }
                            self.has_text = true;
                            emit(self.sink, ProviderEvent::TextDelta(text.to_string()))?;
                        }
                    }
                    Some("thinking_delta") => {
                        let thinking = delta
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !thinking.is_empty() {
                            if let Some(BlockState::Thinking { text, .. }) =
                                self.blocks.get_mut(&index)
                            {
                                text.push_str(thinking);
                            }
                            emit(
                                self.sink,
                                ProviderEvent::ReasoningDelta(thinking.to_string()),
                            )?;
                        }
                    }
                    Some("signature_delta") => {
                        let signature = delta
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if let Some(BlockState::Thinking {
                            signature: store, ..
                        }) = self.blocks.get_mut(&index)
                        {
                            store.push_str(signature);
                        }
                    }
                    Some("input_json_delta") => {
                        let partial = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if let Some(BlockState::ToolUse { json: buffer, .. }) =
                            self.blocks.get_mut(&index)
                        {
                            buffer.push_str(partial);
                        }
                        if !partial.is_empty() {
                            emit(
                                self.sink,
                                ProviderEvent::ToolCallArgsDelta {
                                    index,
                                    delta: partial.to_string(),
                                },
                            )?;
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let index = value.get("index").and_then(as_u32).unwrap_or(0) as usize;
                self.finish_tool(index)?;
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage") {
                    self.merge_usage(usage);
                }
            }
            "message_stop" => self.completed = true,
            "ping" => {}
            "error" => {
                let detail = value.get("error").cloned().unwrap_or_else(|| value.clone());
                return Err(anyhow::Error::new(ProviderError::from_stream_error(&detail)));
            }
            _ => {}
        }
        Ok(())
    }

    fn merge_usage(&mut self, usage: &Value) {
        self.has_usage = true;
        if let Some(value) = super::pointer_u32(usage, "/input_tokens") {
            self.input_tokens = Some(value);
        }
        if let Some(value) = super::pointer_u32(usage, "/output_tokens") {
            self.output_tokens = Some(value);
        }
        if let Some(value) = super::pointer_u32(usage, "/output_tokens_details/thinking_tokens") {
            self.reasoning_tokens = Some(value);
        }
        if let Some(value) = super::pointer_u32(usage, "/cache_read_input_tokens") {
            self.cached_tokens = Some(value);
        }
        // Keep every cache counter seen (message_start and message_delta carry
        // partial usage); `normalize_usage` runs on the merged object at the end.
        if let (Some(target), Some(source)) = (self.raw_usage.as_object_mut(), usage.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
    }

    fn finish_tool(&mut self, index: usize) -> anyhow::Result<()> {
        let Some(BlockState::ToolUse {
            json: buffer, done, ..
        }) = self.blocks.get_mut(&index)
        else {
            return Ok(());
        };
        if *done {
            return Ok(());
        }
        *done = true;
        let arguments = normalize_arguments(buffer);
        emit(self.sink, ProviderEvent::ToolCallDone { index, arguments })?;
        Ok(())
    }

    fn finish(mut self) -> ProviderResult<()> {
        for index in self.blocks.keys().copied().collect::<Vec<_>>() {
            self.finish_tool(index).map_err(to_provider_error)?;
        }

        let mut state_blocks: Vec<Value> = Vec::new();
        for block in std::mem::take(&mut self.blocks).into_values() {
            match block {
                BlockState::Text(text) => {
                    if !text.is_empty() {
                        state_blocks.push(json!({"type": "text", "text": text}));
                    }
                }
                BlockState::Thinking { text, signature } => {
                    // Replaying a thinking block without a signature is rejected
                    // by the gateway; other models do not return signatures.
                    if !text.is_empty() && !signature.is_empty() {
                        state_blocks.push(json!({
                            "type": "thinking",
                            "thinking": text,
                            "signature": signature,
                        }));
                    }
                }
                BlockState::ToolUse { id, name, json, .. } => {
                    state_blocks.push(json!({
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": parse_arguments(&json),
                    }));
                }
                BlockState::Redacted(value) => state_blocks.push(value),
                BlockState::Other => {}
            }
        }

        if self.has_usage {
            let mut usage = make_usage(
                self.input_tokens,
                self.output_tokens,
                self.reasoning_tokens,
                self.cached_tokens,
                None,
            );
            // Read + creation normalized (input total includes both; on
            // Anthropic `input_tokens` is only the tail after the breakpoint).
            cache::apply_usage(
                &mut usage,
                &cache::normalize_usage(
                    WireProtocol::Anthropic,
                    &self.provider_id,
                    &self.raw_usage,
                ),
            );
            emit(self.sink, ProviderEvent::Usage(usage)).map_err(to_provider_error)?;
            // Safe raw usage excerpt for the diagnostics panel (the merged
            // message_start/message_delta counters), before the state/Done.
            super::emit_usage_raw(self.sink, Some(&self.raw_usage))?;
        }
        emit(
            self.sink,
            ProviderEvent::ProviderState(Value::Array(state_blocks)),
        )
        .map_err(to_provider_error)?;
        emit(self.sink, ProviderEvent::Done).map_err(to_provider_error)?;
        Ok(())
    }
}

/* ------------------------------------------------------------------ */
/* Direct-provider request tests (official Anthropic API)              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{CatalogFile, ProviderAuth, RequestProfile};
    use crate::providers::{ProviderConfig, ReasoningRequest, ToolDefinition};
    use tokio_util::sync::CancellationToken;

    fn direct_request_for(
        reasoning: ReasoningRequest,
        model_id: Option<&str>,
    ) -> CompletionRequest {
        let catalog = CatalogFile::load().expect("catalog.json carrega");
        let provider = catalog
            .provider("anthropic")
            .expect("provider anthropic no catálogo");
        let model_id = model_id.unwrap_or(provider.default_model_id.as_str());
        let model = catalog
            .model("anthropic", model_id)
            .unwrap_or_else(|| panic!("modelo {model_id} no provider anthropic"))
            .clone();
        // Shape the harness uses for the direct provider: catalog base/endpoints,
        // Bearer API key and the static catalog headers (`anthropic-version`).
        let config = ProviderConfig {
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            base_url: provider.base_url.clone(),
            api_key: "sk-ant-test".to_string(),
            auth_header: provider.auth_header.clone(),
            auth_prefix: provider.auth_prefix.clone(),
            model,
            session_id: "session-1".to_string(),
            user_agent: "Zylara/test".to_string(),
            endpoints: provider.endpoints.clone(),
            request_profile: RequestProfile::Standard,
            auth_mode: ProviderAuth::ApiKey,
            extra_headers: provider.static_headers(),
        };
        CompletionRequest {
            config,
            protocols: vec![WireProtocol::Anthropic],
            history: vec![HistoryMessage::user("diga olá")],
            system_prompt: "Você é o Zylara.".to_string(),
            tools: vec![ToolDefinition {
                name: "echo".to_string(),
                description: "Devolve o texto recebido.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                }),
            }],
            reasoning,
            max_output_tokens: Some(64),
            temperature: Some(0.5),
            cache_plan: None,
            timeouts: crate::providers::StreamTimeouts::default(),
            cancel: CancellationToken::new(),
        }
    }

    fn direct_request(reasoning: ReasoningRequest) -> CompletionRequest {
        direct_request_for(reasoning, None)
    }

    #[test]
    fn tool_result_with_image_uses_anthropic_content_blocks() {
        let mut message = HistoryMessage::tool_result("call-1", "computer_screenshot", "ok");
        message.images.push(crate::providers::ImagePart {
            mime_type: "image/jpeg".to_string(),
            data_base64: "abc".to_string(),
        });
        let mut messages = Vec::new();
        push_tool_result(&mut messages, &message);
        assert_eq!(messages[0]["content"][0]["type"], json!("tool_result"));
        assert_eq!(messages[0]["content"][0]["content"][0]["type"], json!("text"));
        assert_eq!(messages[0]["content"][0]["content"][1]["type"], json!("image"));
        assert_eq!(
            messages[0]["content"][0]["content"][1]["source"]["media_type"],
            json!("image/jpeg")
        );
    }

    #[test]
    fn direct_provider_body_uses_the_messages_shape() {
        let request = direct_request(ReasoningRequest::Effort("high".to_string()));
        let body = build_body(&request);
        let catalog = CatalogFile::load().expect("catalog");
        let provider = catalog.provider("anthropic").expect("provider anthropic");

        assert_eq!(body["model"], json!(provider.default_model_id.as_str()));
        assert_eq!(body["stream"], json!(true));
        assert!(
            body["max_tokens"].as_u64().unwrap_or(0) > 0,
            "max_tokens ausente: {body}"
        );
        assert_eq!(body["system"], json!("Você é o Zylara."));
        assert_eq!(
            body["messages"],
            json!([{
                "role": "user",
                "content": [{"type": "text", "text": "diga olá"}],
            }])
        );

        // Anthropic tool shape: `{name, description, input_schema}`, never the
        // OpenAI `{type:"function", function:{parameters}}` wrapper.
        assert_eq!(body["tools"][0]["name"], json!("echo"));
        assert_eq!(
            body["tools"][0]["description"],
            json!("Devolve o texto recebido.")
        );
        assert!(
            body["tools"][0]["input_schema"].is_object(),
            "input_schema: {}",
            body["tools"][0]
        );
        assert!(body["tools"][0].get("parameters").is_none());
        assert!(body["tools"][0].get("function").is_none());

        // Thinking is enabled, and Anthropic rejects temperature alongside it:
        // the requested 0.5 must not reach the body.
        assert_eq!(body["thinking"], json!({"type": "adaptive"}));
        assert_eq!(body["output_config"], json!({"effort": "high"}));
        assert!(
            body.get("temperature").is_none(),
            "temperature não deve ir junto de thinking: {body}"
        );
    }

    /// On-demand compaction reuses the conversation prefix, system and tools
    /// but drops `stream` and the output shaping.
    #[test]
    fn anthropic_compaction_body_adds_summarize_and_keeps_system_tools() {
        let request = direct_request(ReasoningRequest::Effort("high".to_string()));
        let body = compaction_body(&request);

        assert_eq!(body["compaction"], json!({"type": "summarize"}));
        assert_eq!(body["system"], json!("Você é o Zylara."));
        assert_eq!(body["tools"][0]["name"], json!("echo"));
        assert_eq!(body["messages"], build_body(&request)["messages"]);
        assert!(
            body.get("stream").is_none(),
            "compactação não é streaming: {body}"
        );
        for forbidden in [
            "context_management",
            "stop_sequences",
            "tool_choice",
            "output_config",
        ] {
            assert!(
                body.get(forbidden).is_none(),
                "{forbidden} não pode ir no corpo de compactação: {body}"
            );
        }
        let max_tokens = body["max_tokens"].as_u64().unwrap_or(0);
        assert!(
            (4_096..=8_192).contains(&max_tokens),
            "max_tokens fora da faixa de compactação: {body}"
        );
        // The requested effort still enables adaptive thinking.
        assert_eq!(body["thinking"], json!({"type": "adaptive"}));
    }

    #[test]
    fn anthropic_compaction_response_requires_signature() {
        let block = json!({
            "type": "compaction",
            "content": "Resumo da conversa.",
            "signature": "sig-123",
        });
        let (state, text) = parse_compaction_response(&json!({
            "stop_reason": "compaction",
            "content": [block.clone()],
        }))
        .expect("resposta de compactação válida");
        assert_eq!(text, "Resumo da conversa.");
        assert_eq!(
            state,
            json!({"role": "assistant", "content": [block.clone()]})
        );

        // Any other stop reason is not a compaction answer.
        assert!(parse_compaction_response(&json!({
            "stop_reason": "end_turn",
            "content": [block.clone()],
        }))
        .is_err());
        // Missing/empty signature or content is a contract violation.
        assert!(parse_compaction_response(&json!({
            "stop_reason": "compaction",
            "content": [{"type": "compaction", "content": "texto", "signature": ""}],
        }))
        .is_err());
        assert!(parse_compaction_response(&json!({
            "stop_reason": "compaction",
            "content": [{"type": "compaction", "content": "  ", "signature": "sig"}],
        }))
        .is_err());
        assert!(parse_compaction_response(&json!({
            "stop_reason": "compaction",
            "content": [{"type": "text", "text": "sem bloco"}],
        }))
        .is_err());
    }

    #[test]
    fn budget_maps_to_enabled_thinking_and_raises_max_tokens() {
        // The default model only exposes `effort`; a budget needs a model that
        // declares `budget_tokens` (Claude 4.5/4.6 entries do).
        let request = direct_request_for(ReasoningRequest::Budget(8_192), Some("claude-opus-4-5"));
        let body = build_body(&request);

        assert_eq!(
            body["thinking"],
            json!({"type": "enabled", "budget_tokens": 8_192})
        );
        assert!(body.get("output_config").is_none());
        let max_tokens = body["max_tokens"].as_u64().unwrap_or(0);
        assert!(
            max_tokens > 8_192,
            "max_tokens ({max_tokens}) precisa exceder o budget de 8192: {body}"
        );
        assert!(
            body.get("temperature").is_none(),
            "temperature não deve ir junto de thinking: {body}"
        );
    }

    /// Dois blocos de texto na mesma resposta são parágrafos distintos: o
    /// primeiro não ganha separador e o segundo ganha exatamente um `\n\n`.
    #[tokio::test]
    async fn handler_separates_distinct_text_blocks() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut handler = Handler::new(&sink, "anthropic".to_string());
            handler
                .on_event(
                    Some("content_block_start"),
                    r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
                )
                .expect("bloco 1");
            handler
                .on_event(
                    Some("content_block_delta"),
                    r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Primeiro."}}"#,
                )
                .expect("texto 1");
            handler
                .on_event(
                    Some("content_block_stop"),
                    r#"{"type":"content_block_stop","index":0}"#,
                )
                .expect("fim 1");
            handler
                .on_event(
                    Some("content_block_start"),
                    r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
                )
                .expect("bloco 2");
            handler
                .on_event(
                    Some("content_block_delta"),
                    r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Segundo."}}"#,
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

    /// The usage arrives split across `message_start` (cache + input) and
    /// `message_delta` (cumulative output): the handler must merge both before
    /// normalizing read/creation/uncached.
    #[tokio::test]
    async fn handler_normalizes_cache_usage_across_message_events() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut handler = Handler::new(&sink, "anthropic".to_string());
            handler
                .on_event(
                    Some("message_start"),
                    r#"{"type":"message_start","message":{"usage":{"input_tokens":50,"cache_creation_input_tokens":1000,"cache_read_input_tokens":0,"output_tokens":1}}}"#,
                )
                .expect("message_start");
            handler
                .on_event(
                    Some("message_delta"),
                    r#"{"type":"message_delta","usage":{"output_tokens":120}}"#,
                )
                .expect("message_delta");
            handler.finish().expect("finish");
        }

        let usage = loop {
            match events.recv().await {
                Some(ProviderEvent::Usage(usage)) => break usage,
                Some(_) => continue,
                None => panic!("evento Usage não emitido"),
            }
        };
        assert!(usage.cache_reported);
        assert_eq!(usage.cache_read_tokens, Some(0));
        assert_eq!(usage.cache_write_tokens, Some(1_000));
        assert_eq!(usage.uncached_input_tokens, Some(50));
        assert_eq!(usage.cached_tokens, Some(0), "alias legado");
        // `input_total = input + read + creation`, per the Anthropic contract.
        assert_eq!(usage.cache_usage().input_total_tokens, Some(1_050));
        assert_eq!(usage.output_tokens, Some(120));
    }

    /// F4b: the adapter lowers the harness plan onto the final body before the
    /// digest. No plan → body byte-for-byte unchanged; with a plan, the cache
    /// markers appear and the prefix digest stays identical.
    #[test]
    fn cache_plan_is_applied_before_the_digest() {
        let mut request = direct_request(ReasoningRequest::Auto);
        let plain = build_body(&request);

        let mut without_plan = build_body(&request);
        cache::apply(WireProtocol::Anthropic, None, &mut without_plan);
        assert_eq!(without_plan, plain, "sem plano o body não muda");

        request.cache_plan = Some(cache::CachePlan {
            mode: cache::CacheMode::Explicit,
            breakpoints: vec![
                cache::CacheBreakpoint {
                    target: cache::CacheBreakpointTarget::Tools,
                    ttl: None,
                },
                cache::CacheBreakpoint {
                    target: cache::CacheBreakpointTarget::System,
                    ttl: None,
                },
                cache::CacheBreakpoint {
                    target: cache::CacheBreakpointTarget::Tail,
                    ttl: None,
                },
            ],
            prompt_cache_key: None,
            retention: None,
            ttl: Some("1h".to_string()),
        });

        let mut planned = build_body(&request);
        cache::apply(
            WireProtocol::Anthropic,
            request.cache_plan.as_ref(),
            &mut planned,
        );
        assert!(planned["system"].is_array(), "system virou blocos");
        assert_eq!(
            planned["tools"][0]["cache_control"],
            json!({"type": "ephemeral", "ttl": "1h"})
        );

        let digest_plain = cache::digest(WireProtocol::Anthropic, "anthropic", &plain);
        let digest_planned = cache::digest(WireProtocol::Anthropic, "anthropic", &planned);
        assert_eq!(digest_plain.segments, digest_planned.segments);
        assert_eq!(digest_plain.total_chars, digest_planned.total_chars);
    }

    /// B2: `UsageRaw` carries the safe excerpt of the merged Anthropic usage
    /// (message_start + message_delta), emitted once after `Usage`.
    #[tokio::test]
    async fn usage_raw_is_emitted_after_usage_with_a_safe_excerpt() {
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel();
        {
            let mut handler = Handler::new(&sink, "opencode-go".to_string());
            handler
                .on_event(
                    Some("message_start"),
                    r#"{"type":"message_start","message":{"usage":{
                        "input_tokens":50,"output_tokens":1,
                        "cache_creation_input_tokens":2127,"cache_read_input_tokens":0,
                        "cache_creation":{"ephemeral_1h_input_tokens":2127,"ephemeral_5m_input_tokens":0},
                        "prompt":"SEGREDO","authorization":"Bearer sk-secret"}}}"#,
                )
                .expect("message_start");
            handler
                .on_event(
                    Some("message_delta"),
                    r#"{"type":"message_delta","usage":{"output_tokens":120}}"#,
                )
                .expect("message_delta");
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
        assert_eq!(raw["cache_creation_input_tokens"], json!(2_127));
        assert_eq!(
            raw["cache_creation"]["ephemeral_1h_input_tokens"],
            json!(2_127)
        );
        assert_eq!(raw["output_tokens"], json!(120), "merge do message_delta");
        let serialized = raw.to_string();
        assert!(!serialized.contains("SEGREDO"), "{serialized}");
        assert!(!serialized.contains("sk-secret"), "{serialized}");
        assert!(!serialized.contains("authorization"), "{serialized}");
    }

    /// Live smoke of on-demand compaction. Skipped without a key.
    #[tokio::test]
    #[ignore = "live: requires ANTHROPIC_API_KEY"]
    async fn live_anthropic_compaction_returns_a_signed_block() {
        let Ok(key) = std::env::var("ANTHROPIC_API_KEY") else {
            return;
        };
        let response = reqwest::Client::new()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2026-10-21")
            .header("anthropic-beta", "compact-2026-09-04")
            .json(&json!({
                "model": "claude-haiku-5-5",
                "max_tokens": 4096,
                "messages": [
                    {"role": "user", "content": "We are building a small CLI."},
                    {"role": "assistant", "content": "Use a single command with subcommands."},
                    {"role": "user", "content": "Now add a config file."}
                ],
                "compaction": {"type": "summarize"}
            }))
            .send()
            .await
            .expect("compaction request");
        assert!(
            response.status().is_success(),
            "compaction status: {}",
            response.status()
        );
        let value: Value = response.json().await.expect("compaction json");
        let (payload, text) = parse_compaction_response(&value).expect("signed block");
        assert!(!text.trim().is_empty());
        assert!(payload["content"][0]["signature"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
    }
}
