//! Client-side capabilities offered to an ACP agent.
//!
//! Inbound agent requests are policy-gated, fail closed, and never carry
//! secrets or raw auth metadata to the renderer. Permission choices are made
//! by `PermissionOption.kind`, never by list position or human-readable name.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

use crate::acp::AcpAgentRow;
use crate::domain::{
    ApprovalDetail, ApprovalRequest, AskOption, AskQuestion, AskUserAnswer, AskUserRequest,
    FileChange, FileChangeKind, RiskClass,
};
use crate::events::TurnEvent;
use crate::harness::EventEmitter;
use crate::mcp::McpServerConfig;
use crate::policy::{CallFacts, PolicyContext, PolicyDecision};
use crate::workspace::exec::{ExecRequest, sanitized_env};
use crate::workspace::safe_path::{Access, resolve};
pub(crate) const METHOD_NOT_FOUND: &str = "ACP_METHOD_NOT_FOUND:";
pub(crate) const INVALID_PARAMS: &str = "ACP_INVALID_PARAMS:";
static CANCELS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Tunnel turn-scoped events (approvals, questions, file changes) through the
/// emitter of the active turn. A synthetic emitter would use a foreign
/// `turnId` and be dropped by the renderer's sequence filter.
static TURN_EMITTERS: LazyLock<Mutex<HashMap<String, Arc<dyn EventEmitter>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static TERMINALS: LazyLock<Mutex<HashMap<String, Value>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Attach the active turn's emitter for the lifetime of one ACP turn.
pub fn bind_turn_emitter(conversation_id: &str, emitter: Arc<dyn EventEmitter>) {
    turn_emitters().lock().insert(conversation_id.to_string(), emitter);
}

/// Detach the active turn's emitter. Probes keep the synthetic fallback below.
pub fn unbind_turn_emitter(conversation_id: &str) {
    turn_emitters().lock().remove(conversation_id);
}

fn turn_emitters() -> &'static Mutex<HashMap<String, Arc<dyn EventEmitter>>> {
    &TURN_EMITTERS
}

fn cancels() -> &'static Mutex<HashMap<String, CancellationToken>> {
    &CANCELS
}

fn terminals() -> &'static Mutex<HashMap<String, Value>> {
    &TERMINALS
}
/// Bind the turn's cancellation token for the lifetime of a live session.
pub(crate) fn bind_cancel(conversation_id: &str, cancel: CancellationToken) {
    cancels().lock().insert(conversation_id.to_string(), cancel);
}

pub(crate) fn clear_cancel(conversation_id: &str) {
    cancels().lock().remove(conversation_id);
}

fn cancel_for(conversation_id: &str) -> CancellationToken {
    cancels()
        .lock()
        .get(conversation_id)
        .cloned()
        .unwrap_or_else(CancellationToken::new)
}

/// Emits live turn events without persisting them: the harness journal is
/// owned by the real turn command, which may not exist for an ACP-only probe.
struct IpcEmitter {
    app: AppHandle,
    conversation_id: String,
    turn_id: String,
    seq: AtomicU64,
}

impl EventEmitter for IpcEmitter {
    fn emit(&self, event: TurnEvent) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let payload = json!({
            "turnId": self.turn_id,
            "seq": seq,
            "conversationId": self.conversation_id,
            "event": event,
        });
        let _ = self.app.emit("zylara:turn-event", payload);
    }
}
fn emitter(app: &AppHandle, conversation_id: &str, agent_id: &str) -> Arc<dyn EventEmitter> {
    if let Some(bound) = turn_emitters().lock().get(conversation_id).cloned() {
        return bound;
    }
    Arc::new(IpcEmitter {
        app: app.clone(),
        conversation_id: conversation_id.to_string(),
        turn_id: format!("acp-{conversation_id}-{agent_id}"),
        seq: AtomicU64::new(0),
    })
}

/// Dispatch one inbound JSON-RPC request from an agent.
///
/// `req` is `{"method": ..., "params": ...}`; the returned value is the
/// JSON-RPC result. Unsupported or unauthorised capabilities answer with a
/// prefixed error so the transport can map them to stable JSON-RPC codes.
pub async fn handle_request(
    app: &AppHandle,
    req: &Value,
    conversation_id: &str,
    agent_row: &AcpAgentRow,
) -> Result<Value> {
    let Some(method) = req.get("method").and_then(Value::as_str) else {
        bail!("{INVALID_PARAMS}missing method");
    };
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "session/request_permission" => permission(app, conversation_id, agent_row, &params).await,
        "elicitation/create" => elicitation(app, conversation_id, agent_row, &params).await,
        "fs/read_text_file" => read_file(app, conversation_id, agent_row, &params),
        "fs/write_text_file" => write_file(app, conversation_id, agent_row, &params).await,
        "terminal/create" => terminal_create(app, conversation_id, agent_row, &params).await,
        "terminal/output" => terminal_output(&params),
        "terminal/wait_for_exit" => terminal_wait(&params).await,
        "terminal/kill" | "terminal/release" => terminal_release(&params),
        _ => bail!("{METHOD_NOT_FOUND}{method}"),
    }
}

/// Approved app MCP servers offered to the agent in `session/new`.
///
/// Only `trusted` agents receive this list. Secret-shaped environment entries
/// are dropped: the agent is a third party, not an extension of the app.
pub(crate) fn mcp_servers(app: &AppHandle, trusted: bool, http: bool) -> Vec<Value> {
    if !trusted {
        return Vec::new();
    }
    let state = app.state::<crate::state::AppState>();
    let mut servers = Vec::new();
    for server in state.mcp.config().enabled_servers() {
        if let Some(entry) = mcp_server_value(server, http) {
            servers.push(entry);
        }
    }
    servers
}

fn mcp_server_value(server: &McpServerConfig, http: bool) -> Option<Value> {
    let _ = http; // HTTP MCP descriptors are not in the local config format.
    let command = server.command.trim();
    if command.is_empty() {
        return None;
    }
    let env: serde_json::Map<String, Value> = server
        .env
        .iter()
        .filter(|(name, _)| {
            let upper = name.to_ascii_uppercase();
            !["API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
                .iter()
                .any(|needle| upper.contains(needle))
        })
        .map(|(name, value)| (name.clone(), Value::String(crate::acp::mapping::clean_text(value))))
        .collect();
    Some(json!({
        "name": crate::acp::mapping::clean_text(&server.name),
        "command": crate::acp::mapping::clean_text(command),
        "args": server.args.iter().map(|arg| crate::acp::mapping::clean_text(arg)).collect::<Vec<_>>(),
        "env": env,
    }))
}

async fn permission(
    app: &AppHandle,
    conversation_id: &str,
    agent_row: &AcpAgentRow,
    params: &Value,
) -> Result<Value> {
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}permission options missing"))?;
    let picker = PermissionPicker::new(options);
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .map(crate::acp::mapping::clean_text)
        .unwrap_or_else(|| {
            crate::acp::mapping::clean_text(&crate::i18n::t("acp.toolDefaultTitle"))
        });
    let tool_call_id = crate::acp::mapping::clean_text(
        params
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("acp-tool"),
    );

    let state = app.state::<crate::state::AppState>();
    let conversation = state.db.get_conversation(conversation_id).ok().flatten();
    let mode = conversation
        .as_ref()
        .map(|conv| conv.permission_mode)
        .unwrap_or_default();
    let plan_mode = false;
    let rules = Vec::new();
    let decision = crate::policy::decide(
        &PolicyContext {
            mode,
            plan_mode,
            trusted: agent_row.trusted,
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(conversation_id),
            workspace_id: conversation.as_ref().and_then(|conv| conv.workspace_id.as_deref()),
            rules: &rules,
        },
        &CallFacts {
            tool: "acp_tool",
            risk: RiskClass::Ask,
            mutating: false,
            target: Some(&title),
            inside_workspace: true,
            secret: false,
            destructive_reason: None,
        },
    );

    let mut persistent = false;
    let approved = match decision {
        PolicyDecision::Deny { .. } => false,
        PolicyDecision::Allow => true,
        PolicyDecision::Ask { .. } => {
            let request = ApprovalRequest {
                id: format!("acp-{}", uuid::Uuid::new_v4()),
                conversation_id: conversation_id.to_string(),
                tool_call_id: tool_call_id.clone(),
                tool: "acp_tool".to_string(),
                title: title.clone(),
                detail: ApprovalDetail::Other {
                    text: crate::acp::mapping::clean_text(&serde_json::to_string(options).unwrap_or_default()),
                },
                risk: RiskClass::Ask,
                preview: None,
                options: Vec::new(),
                created_at: crate::domain::now_ms(),
            };
            let outcome = crate::policy::approval::request_interactive_until_decided(
                &state.approvals,
                Some(emitter(app, conversation_id, &agent_row.id)),
                request,
                &cancel_for(conversation_id),
            )
            .await;
            persistent = outcome.scope.is_some();
            outcome.is_approved()
        }
    };

    Ok(if approved {
        picker.allowed(persistent)
    } else {
        picker.rejected(persistent)
    })
}

/// Selects a permission option by its protocol `kind` only.
struct PermissionPicker {
    allow_once: Option<String>,
    allow_always: Option<String>,
    reject_once: Option<String>,
    reject_always: Option<String>,
}

impl PermissionPicker {
    fn new(options: &[Value]) -> Self {
        let mut picker = Self {
            allow_once: None,
            allow_always: None,
            reject_once: None,
            reject_always: None,
        };
        for option in options {
            let Some(id) = option.get("optionId").and_then(Value::as_str) else {
                continue;
            };
            let id = crate::acp::mapping::clean_text(id);
            match option.get("kind").and_then(Value::as_str).unwrap_or("") {
                "allow_once" => picker.allow_once.get_or_insert(id),
                "allow_always" => picker.allow_always.get_or_insert(id),
                "reject_once" => picker.reject_once.get_or_insert(id),
                "reject_always" => picker.reject_always.get_or_insert(id),
                _ => continue,
            };
        }
        picker
    }

    /// Prefer the narrowest grant, or the persistent one when the user chose
    /// "always" in the approval card.
    fn allowed(&self, persistent: bool) -> Value {
        let selected = if persistent {
            self.allow_always.as_ref().or(self.allow_once.as_ref())
        } else {
            self.allow_once.as_ref().or(self.allow_always.as_ref())
        };
        match selected {
            Some(id) => json!({ "outcome": { "selected": { "optionId": id } } }),
            None => json!({ "outcome": "cancelled" }),
        }
    }

    fn rejected(&self, persistent: bool) -> Value {
        let selected = if persistent {
            self.reject_always.as_ref().or(self.reject_once.as_ref())
        } else {
            self.reject_once.as_ref().or(self.reject_always.as_ref())
        };
        match selected {
            Some(id) => json!({ "outcome": { "selected": { "optionId": id } } }),
            None => json!({ "outcome": "cancelled" }),
        }
    }
}

async fn elicitation(
    app: &AppHandle,
    conversation_id: &str,
    agent_row: &AcpAgentRow,
    params: &Value,
) -> Result<Value> {
    if !agent_row.trusted || !agent_row.supports_elicitation {
        return Ok(json!({ "action": "decline" }));
    }
    let message = crate::acp::mapping::clean_text(
        params.get("message").and_then(Value::as_str).unwrap_or(""),
    );
    if message.is_empty() {
        bail!("{INVALID_PARAMS}elicitation message missing");
    }
    if params.get("mode").and_then(Value::as_str) == Some("url")
        || params.get("url").is_some()
    {
        let host = params
            .get("url")
            .and_then(Value::as_str)
            .and_then(|url| url::Url::parse(url).ok())
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| crate::i18n::t("acp.unknownDomain"));
        let emit = emitter(app, conversation_id, &agent_row.id);
        emit.emit(TurnEvent::Notice {
            severity: "info".to_string(),
            title: crate::acp::mapping::clean_text(&message),
            description: Some(crate::i18n::t_args("acp.urlNotice", &[("host", host.as_str())])),
        });
        return Ok(json!({ "action": "decline" }));
    }

    let Some(fields) = params
        .get("schema")
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
    else {
        return Ok(json!({ "action": "decline" }));
    };
    if fields.is_empty() || fields.len() > 4 {
        return Ok(json!({ "action": "decline" }));
    }
    let mut questions = Vec::with_capacity(fields.len());
    let mut option_values: HashMap<String, HashMap<String, Value>> = HashMap::new();
    for (name, field) in fields {
        let mut options = Vec::new();
        let mut values_by_label = HashMap::new();
        if let Some(enum_values) = field.get("enum").and_then(Value::as_array) {
            for value in enum_values.iter().take(6) {
                let label = match value {
                    Value::String(text) => crate::acp::mapping::clean_text(text),
                    other => crate::acp::mapping::clean_text(&other.to_string()),
                };
                if !label.is_empty() {
                    values_by_label.insert(label.clone(), value.clone());
                    options.push(AskOption {
                        label,
                        description: None,
                    });
                }
            }
        }
        let question_id = crate::acp::mapping::clean_text(name);
        questions.push(AskQuestion {
            id: question_id.clone(),
            question: crate::acp::mapping::clean_text(
                field
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&message),
            ),
            header: None,
            options,
            multi_select: false,
        });
        option_values.insert(question_id, values_by_label);
    }
    let request = AskUserRequest {
        id: format!("acp-elicitation-{}", uuid::Uuid::new_v4()),
        conversation_id: conversation_id.to_string(),
        tool_call_id: "acp-elicitation".to_string(),
        questions,
        created_at: crate::domain::now_ms(),
    };
    let state = app.state::<crate::state::AppState>();
    let response = crate::harness::code::questions::request_user_answers(
        &state.questions,
        Some(emitter(app, conversation_id, &agent_row.id)),
        request,
        Duration::from_secs(300),
        &cancel_for(conversation_id),
    )
    .await;
    if response.skipped {
        return Ok(json!({ "action": "cancel" }));
    }
    let content = elicitation_content(&option_values, response.answers);
    Ok(json!({ "action": "accept", "content": content }))
}

/// Map the approval UI's answers back to the ACP schema values advertised by
/// the agent. A custom answer wins; selected enum values keep their original
/// JSON type (important for boolean/number enums).
fn elicitation_content(
    option_values: &HashMap<String, HashMap<String, Value>>,
    answers: Vec<AskUserAnswer>,
) -> serde_json::Map<String, Value> {
    let mut content = serde_json::Map::new();
    for answer in answers {
        let mapped: Vec<Value> = answer
            .selected
            .iter()
            .map(|label| {
                option_values
                    .get(&answer.question_id)
                    .and_then(|values| values.get(label))
                    .cloned()
                    .unwrap_or_else(|| Value::String(label.clone()))
            })
            .collect();
        let value = if let Some(custom) = answer.custom.filter(|text| !text.trim().is_empty()) {
            Value::String(crate::acp::mapping::clean_text(&custom))
        } else {
            match mapped.len() {
                0 => Value::Null,
                1 => mapped.into_iter().next().unwrap_or(Value::Null),
                _ => Value::Array(mapped),
            }
        };
        content.insert(answer.question_id, value);
    }
    content
}

fn session_cwd(app: &AppHandle, conversation_id: &str, row: &AcpAgentRow) -> std::path::PathBuf {
    let state = app.state::<crate::state::AppState>();
    state
        .db
        .acp_session(conversation_id, &row.id)
        .ok()
        .flatten()
        .map(|session| std::path::PathBuf::from(session.cwd))
        .unwrap_or_else(|| state.data_dir.join("agent-workspaces").join("acp"))
}

fn read_file(
    app: &AppHandle,
    conversation_id: &str,
    row: &AcpAgentRow,
    params: &Value,
) -> Result<Value> {
    if !row.trusted || !row.supports_fs {
        bail!("{METHOD_NOT_FOUND}fs/read_text_file");
    }
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}path missing"))?;
    let path = resolve(&session_cwd(app, conversation_id, row), requested, Access::Read)
        .with_context(|| format!("{INVALID_PARAMS}path outside workspace"))?;
    let bytes = std::fs::read(&path).with_context(|| format!("{INVALID_PARAMS}unreadable file"))?;
    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(65_536) as usize;
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().skip(offset).take(limit.min(2_048)).collect();
    Ok(json!({ "content": crate::acp::mapping::clean_text(&lines.join("\n")) }))
}

async fn write_file(
    app: &AppHandle,
    conversation_id: &str,
    row: &AcpAgentRow,
    params: &Value,
) -> Result<Value> {
    if !row.trusted || !row.supports_fs {
        bail!("{METHOD_NOT_FOUND}fs/write_text_file");
    }
    let requested = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}path missing"))?;
    let root = session_cwd(app, conversation_id, row);
    let path = resolve(&root, requested, Access::Write)
        .with_context(|| format!("{INVALID_PARAMS}path outside workspace"))?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}content missing"))?;
    let state = app.state::<crate::state::AppState>();
    let decision = crate::policy::decide(
        &PolicyContext {
            mode: state
                .db
                .get_conversation(conversation_id)
                .ok()
                .flatten()
                .map(|conv| conv.permission_mode)
                .unwrap_or_default(),
            plan_mode: false,
            trusted: row.trusted,
            session_id: conversation_id,
            workspace_id: None,
            rules: &[],
        },
        &CallFacts {
            tool: "acp_write_file",
            risk: RiskClass::Write,
            mutating: true,
            target: Some(requested),
            inside_workspace: true,
            secret: is_secret_path(requested),
            destructive_reason: None,
        },
    );
    if let PolicyDecision::Deny { reason, .. } = decision {
        bail!("{INVALID_PARAMS}{}", crate::acp::mapping::clean_text(&reason));
    }
    if matches!(decision, PolicyDecision::Ask { .. }) {
        let outcome = crate::policy::approval::request_interactive_until_decided(
            &state.approvals,
            Some(emitter(app, conversation_id, &row.id)),
            ApprovalRequest {
                id: format!("acp-{}", uuid::Uuid::new_v4()),
                conversation_id: conversation_id.to_string(),
                tool_call_id: "acp-write".to_string(),
                tool: "acp_write_file".to_string(),
                title: crate::i18n::t_args("acp.writeApproval", &[("path", requested)]),
                detail: ApprovalDetail::Paths {
                    paths: vec![requested.to_string()],
                    change: "write".to_string(),
                },
                risk: RiskClass::Write,
                preview: None,
                options: Vec::new(),
                created_at: crate::domain::now_ms(),
            },
            &cancel_for(conversation_id),
        )
        .await;
        if !outcome.is_approved() {
            bail!("{INVALID_PARAMS}write denied");
        }
    }
    let existed = path.exists();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("{INVALID_PARAMS}cannot create parent"))?;
    }
    tokio::fs::write(&path, content.as_bytes())
        .await
        .with_context(|| format!("{INVALID_PARAMS}write failed"))?;
    let relative = crate::acp::mapping::clean_text(
        &path.strip_prefix(&root).unwrap_or(&path).to_string_lossy(),
    )
    .replace('\\', "/");
    let repo = crate::workspace::git::detect(&root).await;
    let repo_root = repo.root.as_deref().unwrap_or(&root);
    let ignored = crate::workspace::git::ignored_paths(&root, repo_root, &[relative.clone()]).await;
    if !ignored.contains(&relative) {
        emitter(app, conversation_id, &row.id).emit(TurnEvent::FileChanged {
            change: FileChange {
                path: relative,
                kind: if existed {
                    FileChangeKind::Modified
                } else {
                    FileChangeKind::Created
                },
                added: content.lines().count() as u32,
                removed: 0,
                diff: None,
            },
        });
    }
    Ok(json!({}))
}

fn is_secret_path(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_uppercase())
        .unwrap_or_default();
    name.contains(".ENV") || name.contains("SECRET") || name.contains("CREDENTIAL")
        || name.ends_with(".PEM") || name.ends_with(".KEY")
}

async fn terminal_create(
    app: &AppHandle,
    conversation_id: &str,
    row: &AcpAgentRow,
    params: &Value,
) -> Result<Value> {
    if !row.trusted || !row.supports_terminal {
        bail!("{METHOD_NOT_FOUND}terminal/create");
    }
    let program = params
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}command missing"))?;
    let args: Vec<String> = params
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(crate::acp::mapping::clean_text)
                .collect()
        })
        .unwrap_or_default();
    let requested_cwd = params.get("cwd").and_then(Value::as_str);
    let root = session_cwd(app, conversation_id, row);
    let cwd = if let Some(requested) = requested_cwd {
        resolve(&root, requested, Access::ReadDir)
            .with_context(|| format!("{INVALID_PARAMS}cwd outside workspace"))?
    } else {
        root
    };
    let extra: Vec<(String, String)> = params
        .get("env")
        .and_then(Value::as_object)
        .map(|env| {
            env.iter()
                .filter(|(name, _)| {
                    let upper = name.to_ascii_uppercase();
                    !["PATH", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "HTTPS_PROXY",
                        "SSL_CERT_FILE", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
                        .iter()
                        .any(|needle| upper.contains(needle))
                })
                .filter_map(|(name, value)| {
                    value.as_str().map(|value| {
                        (name.clone(), crate::acp::mapping::clean_text(value))
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let output = crate::workspace::exec::run(
        ExecRequest {
            program: crate::acp::mapping::clean_text(program),
            args,
            cwd,
            env: sanitized_env(&extra.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>()),
            timeout: Duration::from_secs(600),
            cancel: cancel_for(conversation_id),
            max_output_bytes: params
                .get("outputByteLimit")
                .and_then(Value::as_u64)
                .unwrap_or(1_048_576)
                .min(16 * 1024 * 1024) as usize,
            stdin: None,
        },
        None,
    )
    .await
    .with_context(|| format!("{INVALID_PARAMS}terminal failed"))?;
    let terminal_id = uuid::Uuid::new_v4().to_string();
    let combined = format!("{}{}", output.stdout, output.stderr);
    terminals().lock().insert(
        terminal_id.clone(),
        json!({
            "output": crate::acp::mapping::clean_text(&combined),
            "exitCode": output.exit_code,
        }),
    );
    Ok(json!({ "terminalId": terminal_id, "exitCode": output.exit_code }))
}

fn terminal_output(params: &Value) -> Result<Value> {
    let id = params
        .get("terminalId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}terminalId missing"))?;
    let record = terminals().lock().get(id).cloned().unwrap_or_default();
    let output = record.get("output").and_then(Value::as_str).unwrap_or("");
    Ok(json!({ "output": output, "truncated": false }))
}

async fn terminal_wait(params: &Value) -> Result<Value> {
    // `terminal/create` waits for the process before it answers, so this is a
    // lookup of the already-known exit status rather than a second spawn.
    let id = params
        .get("terminalId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}terminalId missing"))?;
    let record = terminals().lock().get(id).cloned();
    let Some(record) = record else {
        bail!("{INVALID_PARAMS}unknown terminal");
    };
    tokio::task::yield_now().await;
    Ok(json!({ "exitCode": record.get("exitCode").cloned().unwrap_or(Value::Null) }))
}

fn terminal_release(params: &Value) -> Result<Value> {
    let id = params
        .get("terminalId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{INVALID_PARAMS}terminalId missing"))?;
    terminals().lock().remove(id);
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_choices_are_selected_by_kind_not_position() {
        let options = json!([
            { "optionId": "yes-always", "name": "Allow", "kind": "allow_always" },
            { "optionId": "no", "name": "Looks safe - yes", "kind": "reject_once" },
            { "optionId": "yes-once", "name": "No", "kind": "allow_once" }
        ]);
        let values = options.as_array().expect("options array");
        let picker = PermissionPicker::new(values);
        assert_eq!(picker.allowed(false)["outcome"]["selected"]["optionId"], "yes-once");
        assert_eq!(picker.allowed(true)["outcome"]["selected"]["optionId"], "yes-always");
        assert_eq!(picker.rejected(false)["outcome"]["selected"]["optionId"], "no");
    }

    #[test]
    fn secret_env_entries_never_reach_the_agent() {
        let config = McpServerConfig {
            name: "tools".into(),
            command: "node".into(),
            args: vec!["server.js".into()],
            env: [("API_KEY".to_string(), "secret".to_string())]
                .into_iter()
                .collect(),
            enabled: true,
            cwd: None,
        };
        let value = mcp_server_value(&config, true).expect("stdio server");
        assert_eq!(value["env"], json!({}));
    }

    #[test]
    fn elicitation_preserves_selected_enum_values_and_custom_text() {
        let mut option_values = HashMap::new();
        option_values.insert(
            "q1".to_string(),
            [("yes".to_string(), Value::Bool(true))]
                .into_iter()
                .collect(),
        );
        let answers = vec![
            AskUserAnswer {
                question_id: "q1".into(),
                selected: vec!["yes".into()],
                custom: None,
            },
            AskUserAnswer {
                question_id: "q2".into(),
                selected: vec!["first".into()],
                custom: Some("typed answer".into()),
            },
        ];
        let content = elicitation_content(&option_values, answers);
        assert_eq!(content["q1"], json!(true));
        assert_eq!(content["q2"], json!("typed answer"));
    }
}
