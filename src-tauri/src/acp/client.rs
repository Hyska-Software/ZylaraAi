//! ACP provider adapter entry points called by the harness and ACP commands.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::acp::{
    AcpAgentCapabilities, AcpAgentRow, AcpAuthAction, AcpAuthMethod, AcpAuthView, AcpModelRow,
    session,
};
use crate::providers::{CompletionRequest, EventSink, ProviderError, ProviderEvent, ProviderResult};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const TERMINAL_AUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CONTEXT_LIMIT: usize = 8 * 1024;

/// Run one harness step against an installed ACP agent.
pub async fn stream(
    app: &AppHandle,
    request: &CompletionRequest,
    sink: &EventSink,
) -> ProviderResult<()> {
    let provider_id = request.config.provider_id.as_str();
    if !crate::acp::is_acp_id(provider_id) {
        return Err(ProviderError::BadRequest(
            "not an ACP provider route".to_string(),
        ));
    }
    let state = app.state::<crate::state::AppState>();
    let row = state
        .db
        .acp_agent(provider_id)
        .ok()
        .flatten()
        .ok_or_else(|| ProviderError::BadRequest(format!("ACP agent {provider_id} not installed")))?;
    let conversation_id = if request.config.session_id.is_empty() {
        provider_id.to_string()
    } else {
        request.config.session_id.clone()
    };

    let handle = session::acquire(
        app,
        &row,
        &conversation_id,
        provider_id,
        &request.system_prompt,
    )
    .await?;
    session::apply_model(app, &handle, &request.config.model.id).await?;
    session::apply_thinking(app, &handle, &row, &request.config.model, &request.reasoning).await?;
    let prompt = prompt_blocks(request, &handle.capabilities, handle.fresh);
    if prompt.is_empty() {
        return Err(ProviderError::BadRequest(
            "ACP turn has no user message".to_string(),
        ));
    }
    let result = session::send_prompt(&handle, prompt, sink, &request.cancel).await;
    session::persist(app, &handle).await;
    if result.is_err() && matches!(result, Err(ProviderError::AuthRequired(_))) {
        mark_auth(app, &row, "auth_required", None);
    }
    if result.is_ok() {
        crate::providers::emit(sink, ProviderEvent::Done).map_err(|error| ProviderError::Other(error.to_string()))?;
    }
    result
}

/// Build the ACP prompt: only the newest user message goes to the agent; an
/// older-history summary is prepended when a fresh session cannot replay it.
pub(crate) fn prompt_blocks(
    request: &CompletionRequest,
    caps: &AcpAgentCapabilities,
    fresh: bool,
) -> Vec<Value> {
    let last_user = request
        .history
        .iter()
        .rev()
        .find(|message| message.role == crate::providers::HistoryRole::User);
    let mut blocks = Vec::new();
    if fresh {
        let earlier: Vec<&str> = request
            .history
            .iter()
            .take_while(|message| {
                last_user
                    .map(|last| !std::ptr::eq(*message, last))
                    .unwrap_or(true)
            })
            .filter(|message| message.role == crate::providers::HistoryRole::User)
            .filter_map(|message| {
                let text = message.text.trim();
                (!text.is_empty()).then_some(text)
            })
            .collect();
        if !earlier.is_empty() {
            let label = crate::i18n::t("acp.priorContextLabel");
            let joined = earlier.join("\n");
            let mut budget = CONTEXT_LIMIT;
            let mut summary = String::new();
            for line in joined.lines() {
                if budget == 0 {
                    break;
                }
                let take = budget.min(line.len());
                summary.push_str(&line[..take]);
                summary.push('\n');
                budget = budget.saturating_sub(take + 1);
            }
            blocks.push(json!({
                "type": "text",
                "text": format!("{label}:\n{summary}"),
            }));
        }
    }
    let Some(user) = last_user else {
        return blocks;
    };
    if !user.text.is_empty() {
        blocks.push(json!({ "type": "text", "text": user.text }));
    }
    if caps.image {
        for image in &user.images {
            blocks.push(json!({
                "type": "image",
                "mimeType": image.mime_type,
                "data": image.data_base64,
            }));
        }
    }
    if caps.embedded_context && blocks.is_empty() {
        blocks.push(json!({ "type": "text", "text": "" }));
    }
    blocks
}

/// Spawn, handshake and discover models/auth state for an installed agent.
pub async fn probe(app: &AppHandle, agent_id: &str) -> Result<(AcpAuthView, Vec<AcpModelRow>)> {
    tokio::time::timeout(PROBE_TIMEOUT, probe_inner(app, agent_id))
        .await
        .context("ACP probe timed out")?
}

async fn probe_inner(app: &AppHandle, agent_id: &str) -> Result<(AcpAuthView, Vec<AcpModelRow>)> {
    let state = app.state::<crate::state::AppState>();
    let row = state
        .db
        .acp_agent(agent_id)?
        .ok_or_else(|| anyhow!("ACP agent {agent_id} not installed"))?;
    let temp = std::env::temp_dir().join(format!("zylara-acp-probe-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&temp).await?;
    let result = try_probe(app, &row, &temp).await;
    let _ = tokio::fs::remove_dir_all(&temp).await;
    result
}

async fn try_probe(
    app: &AppHandle,
    row: &AcpAgentRow,
    cwd: &std::path::Path,
) -> Result<(AcpAuthView, Vec<AcpModelRow>)> {
    let mut spawned = session::spawn_agent(app, row, "acp-probe", cwd).await?;
    let methods = spawned.auth_methods.clone();
    let mut response = spawned
        .conn
        .request(
            "session/new",
            json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
        )
        .await;
    if is_auth_required(&response) && has_agent_login(&methods) {
        let method_id = methods
            .iter()
            .find(|method| method.kind == "agent")
            .map(|method| method.id.clone());
        shutdown_spawned(spawned);
        match method_id {
            Some(id) => {
                let _ = authenticate(app, &row.id, AcpAuthAction::Login { method_id: id }).await?;
            }
            None => bail!("ACP agent requires login but offers no agent method"),
        }
        spawned = session::spawn_agent(app, row, "acp-probe", cwd).await?;
        response = spawned
            .conn
            .request(
                "session/new",
                json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
            )
            .await;
    }
    let result = match response {
        Ok(value) => {
            let options = value
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let models = session::discover_models(&options);
            let probe_session_id = value
                .get("result")
                .and_then(|result| result.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let state = app.state::<crate::state::AppState>();
            if session::discover_thinking_config(&options).is_some() {
                session::persist_thinking_config(app, &row.id, &options);
            } else {
                // OpenCode advertises `effort` only after selecting a model
                // that has variants; the default model often has none.
                let mut candidates: Vec<String> = models
                    .iter()
                    .filter(|model| model.is_default)
                    .map(|model| model.model_id.clone())
                    .collect();
                candidates.extend(models.iter().map(|model| model.model_id.clone()));
                for model_id in candidates.into_iter().take(8) {
                    if state
                        .db
                        .acp_agent(&row.id)
                        .ok()
                        .flatten()
                        .is_some_and(|stored| stored.thinking_config_json != "{}")
                    {
                        break;
                    }
                    let Ok(response) = spawned
                        .conn
                        .request(
                            "session/set_config_option",
                            json!({
                                "sessionId": probe_session_id,
                                "configId": "model",
                                "value": model_id,
                            }),
                        )
                        .await
                    else {
                        continue;
                    };
                    session::persist_thinking_config(
                        app,
                        &row.id,
                        &session::config_options_from(&response),
                    );
                }
            }
            match state.db.acp_models_replace(&row.id, &models) {
                Ok(()) => {
                    mark_auth(app, row, "ready", None);
                    Ok((auth_view(row, "ready", &methods, "")?, models))
                }
                Err(error) => Err(anyhow!(error)),
            }
        }
        Err(error) => {
            let mapped = session::map_sdk_error(&error);
            mark_auth(app, row, "auth_required", Some(&mapped.to_string()));
            Err(anyhow!(mapped.to_string()))
        }
    };
    shutdown_spawned(spawned);
    result
}

/// Authenticate with an ACP agent: protocol login, terminal relaunch or logout.
pub async fn authenticate(
    app: &AppHandle,
    agent_id: &str,
    action: AcpAuthAction,
) -> Result<AcpAuthView> {
    let state = app.state::<crate::state::AppState>();
    let row = state
        .db
        .acp_agent(agent_id)?
        .ok_or_else(|| anyhow!("ACP agent {agent_id} not installed"))?;
    let temp = std::env::temp_dir().join(format!("zylara-acp-auth-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&temp).await?;
    let result = authenticate_inner(app, &row, &temp, action).await;
    let _ = tokio::fs::remove_dir_all(&temp).await;
    result
}

async fn authenticate_inner(
    app: &AppHandle,
    row: &AcpAgentRow,
    cwd: &std::path::Path,
    action: AcpAuthAction,
) -> Result<AcpAuthView> {
    let spawned = session::spawn_agent(app, row, "acp-auth", cwd).await?;
    let methods = spawned.auth_methods.clone();
    let result = match action {
        AcpAuthAction::Login { method_id } => {
            if !methods.iter().any(|method| {
                method.id == method_id && method.kind == "agent"
            }) {
                bail!("ACP agent login method {method_id} is not available")
            }
            let response = spawned
                .conn
                .request("authenticate", json!({ "methodId": method_id }))
                .await;
            match response {
                Ok(_) => {
                    mark_auth(app, row, "ready", None);
                    auth_view(row, "ready", &methods, "")
                }
                Err(error) => {
                    let mapped = session::map_sdk_error(&error);
                    mark_auth(app, row, "auth_required", Some(&mapped.to_string()));
                    Err(anyhow!(mapped.to_string()))
                }
            }
        }
        AcpAuthAction::Logout => {
            if !spawned.capabilities.supports_logout {
                bail!("ACP agent does not support logout")
            }
            let response = spawned.conn.request("logout", json!({})).await;
            match response {
                Ok(_) => {
                    mark_auth(app, row, "unknown", None);
                    auth_view(row, "unknown", &methods, "")
                }
                Err(error) => Err(anyhow!(session::map_sdk_error(&error).to_string())),
            }
        }
        AcpAuthAction::TerminalLogin { method_id } => {
            let method = methods
                .iter()
                .find(|method| method.id == method_id && method.kind == "terminal")
                .ok_or_else(|| anyhow!("ACP terminal login method {method_id} is not available"))?
                .clone();
            let raw_method = spawned
                .init
                .get("authMethods")
                .and_then(Value::as_array)
                .and_then(|methods| {
                    methods.iter().find(|entry| {
                        entry.get("id").and_then(Value::as_str) == Some(method_id.as_str())
                    })
                })
                .cloned()
                .unwrap_or(Value::Null);
            let extra_args: Vec<String> = raw_method
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args
                        .iter()
                        .filter_map(Value::as_str)
                        .map(crate::acp::mapping::clean_text)
                        .collect()
                })
                .unwrap_or_default();
            let method_env: std::collections::HashMap<String, String> = raw_method
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .filter_map(|(name, value)| {
                            value
                                .as_str()
                                .map(|value| (name.clone(), value.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            terminal_login(app, row, &method, cwd, extra_args, method_env).await?;
            mark_auth(app, row, "ready", None);
            auth_view(row, "ready", &methods, "")
        }
    };
    shutdown_spawned(spawned);
    result
}

/// Relaunch the agent with the method's extra args/env inside a real PTY.
/// Dangerous loader/proxy variables from the agent are discarded.
async fn terminal_login(
    app: &AppHandle,
    row: &AcpAgentRow,
    _method: &AcpAuthMethod,
    cwd: &std::path::Path,
    extra_args: Vec<String>,
    method_env: std::collections::HashMap<String, String>,
) -> Result<()> {
    let mut extra = row.env();
    for name in secret_names(row) {
        if let Some(value) = secret_value(app, row, &name) {
            extra.insert(name, value);
        }
    }
    // Method-provided env may only add harmless values: it never overrides
    // app secrets or loader/proxy variables.
    for (name, value) in method_env {
        if is_unsafe_env(&name) || extra.contains_key(&name) {
            continue;
        }
        extra.insert(name, crate::acp::mapping::clean_text(&value));
    }
    let env = crate::workspace::exec::sanitized_env(
        &extra
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect::<Vec<_>>(),
    );
    let program = crate::acp::launch_program(row, &env);
    let mut args = row.args();
    args.extend(extra_args.into_iter().map(|arg| crate::acp::mapping::clean_text(&arg)));
    let builder = {
        use portable_pty::CommandBuilder;
        let mut builder = CommandBuilder::new(program);
        for arg in args {
            builder.arg(arg);
        }
        builder.cwd(cwd);
        for (name, value) in &env {
            builder.env(name, value);
        }
        builder
    };
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("cannot open PTY for ACP terminal login")?;
    let mut child = pair
        .slave
        .spawn_command(builder)
        .context("cannot launch ACP terminal login")?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().context("cannot read PTY")?;
    let status = tokio::time::timeout(TERMINAL_AUTH_TIMEOUT, async {
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            let _ = std::io::Read::read_to_end(&mut reader, &mut output);
            child.wait()
        })
        .await
    })
    .await
    .context("ACP terminal login timed out")???;
    if !status.success() {
        bail!("ACP terminal login exited with {status}");
    }
    Ok(())
}
fn is_unsafe_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "PATH",
        "NODE_OPTIONS",
        "NODE_PATH",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "SSL_CERT_FILE",
        "API_KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
}

fn is_auth_required(response: &std::result::Result<Value, agent_client_protocol::Error>) -> bool {
    match response {
        Ok(_) => false,
        Err(error) => i64::from(error.code.value()) == -32000,
    }
}

fn has_agent_login(methods: &[AcpAuthMethod]) -> bool {
    methods.iter().any(|method| method.kind == "agent")
}

fn auth_view(
    row: &AcpAgentRow,
    state: &str,
    methods: &[AcpAuthMethod],
    hint: &str,
) -> Result<AcpAuthView> {
    Ok(AcpAuthView {
        agent_id: row.id.clone(),
        state: state.to_string(),
        methods: methods.to_vec(),
        hint: if hint.is_empty() {
            row.auth_hint.clone()
        } else {
            Some(crate::acp::mapping::clean_text(hint))
        },
    })
}

fn mark_auth(app: &AppHandle, row: &AcpAgentRow, state: &str, hint: Option<&str>) {
    let state_manager = app.state::<crate::state::AppState>();
    let mut updated = row.clone();
    updated.auth_state = state.to_string();
    updated.auth_hint = hint.map(crate::acp::mapping::clean_text).or_else(|| row.auth_hint.clone());
    updated.updated_at = crate::domain::now_ms();
    let _ = state_manager.db.acp_agent_save(&updated);
}

fn secret_names(row: &AcpAgentRow) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&row.env_secret_names_json).unwrap_or_default()
}

fn secret_value(app: &AppHandle, row: &AcpAgentRow, name: &str) -> Option<String> {
    let path = crate::config::secrets_path(app);
    let raw = std::fs::read_to_string(path).ok()?;
    let secrets: Value = serde_json::from_str(&raw).ok()?;
    let key = format!("acp:{}:{name}", row.id);
    secrets
        .get("acp")
        .and_then(|acp| acp.get(&key))
        .or_else(|| secrets.get(&key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn shutdown_spawned(spawned: session::Spawned) {
    let _ = spawned.stop.send(());
    let mut child = spawned.child;
    let _ = child.start_kill();
    spawned.task.abort();
}

/// Cancel a live turn without blocking on the agent.
pub async fn cancel(conversation_id: &str, provider_id: &str) {
    session::cancel(conversation_id, provider_id).await;
}

/// Close a live session and its process tree.
pub async fn close(conversation_id: &str, provider_id: &str) {
    session::close(conversation_id, provider_id).await;
}

/// Close every live session on app shutdown.
pub async fn close_all() {
    session::close_all().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::ID_PREFIX;
    use tokio_util::sync::CancellationToken;
    use crate::providers::{
        HistoryMessage, ImagePart, ProviderConfig, ReasoningRequest, StreamTimeouts,
    };

    fn completion_request(history: Vec<HistoryMessage>) -> CompletionRequest {
        CompletionRequest {
            config: ProviderConfig {
                provider_id: "acp__test".into(),
                provider_name: "test".into(),
                base_url: String::new(),
                api_key: String::new(),
                auth_header: "authorization".into(),
                auth_prefix: "Bearer ".into(),
                model: serde_json::from_value::<crate::catalog::ModelInfo>(json!({
                    "id": "default", "name": "Default"
                }))
                .expect("valid test model"),
                session_id: "conv".into(),
                user_agent: String::new(),
                endpoints: Default::default(),
                request_profile: crate::catalog::RequestProfile::Standard,
                auth_mode: crate::catalog::ProviderAuth::Acp,
                extra_headers: Vec::new(),
            },
            protocols: Vec::new(),
            history,
            system_prompt: String::new(),
            tools: Vec::new(),
            reasoning: ReasoningRequest::Auto,
            max_output_tokens: None,
            temperature: None,
            cache_plan: None,
            timeouts: StreamTimeouts::default(),
            cancel: CancellationToken::new(),
        }
    }

    fn request(history: Vec<HistoryMessage>, caps: AcpAgentCapabilities) -> Vec<Value> {
        let req = completion_request(history);
        prompt_blocks(&req, &caps, true)
    }


    #[test]
    fn only_the_last_user_message_is_prompted() {
        let history = vec![
            HistoryMessage::user("older"),
            HistoryMessage::assistant("answer"),
            HistoryMessage::user("newest"),
        ];
        // An existing session owns its history: only the new turn is prompted.
        let existing = completion_request(history.clone());
        let blocks = prompt_blocks(&existing, &AcpAgentCapabilities::default(), false);
        let texts: Vec<&str> = blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        assert!(texts.iter().any(|text| text.contains("newest")));
        assert!(!texts.iter().any(|text| text.contains("older")));

        // A fresh session without replay support gets an explicitly labelled
        // bounded context block; the latest message remains a separate block.
        let fresh_request = completion_request(history);
        let fresh = prompt_blocks(&fresh_request, &AcpAgentCapabilities::default(), true);
        let label = crate::i18n::t("acp.priorContextLabel");
        assert!(fresh.iter().any(|block| {
            block
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("older") && text.starts_with(&label))
        }));
        assert!(fresh.iter().any(|block| {
            block.get("text").and_then(Value::as_str) == Some("newest")
        }));
    }

    #[test]
    fn images_are_only_sent_when_advertised() {
        let mut history = vec![HistoryMessage::user("look")];
        history[0].images.push(ImagePart {
            mime_type: "image/png".into(),
            data_base64: "AAAA".into(),
        });
        let without = request(history.clone(), AcpAgentCapabilities::default());
        assert!(!without.iter().any(|block| block["type"] == "image"));
        let caps = AcpAgentCapabilities {
            image: true,
            ..AcpAgentCapabilities::default()
        };
        let with_image = request(history, caps);
        assert!(with_image.iter().any(|block| block["type"] == "image"));
    }

    #[test]
    fn fresh_sessions_get_a_bounded_context_block() {
        let history = vec![HistoryMessage::user("previous"), HistoryMessage::user("current")];
        let blocks = request(history, AcpAgentCapabilities::default());
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0]["text"].as_str().is_some_and(|text| text.len() <= CONTEXT_LIMIT + 128));
    }

    #[test]
    fn acp_namespace_is_disjoint_from_custom_providers() {
        let provider_id = format!("{ID_PREFIX}agent");
        assert!(crate::acp::is_acp_id(&provider_id));
        assert!(!crate::acp::is_acp_id("custom__agent"));
    }
}
