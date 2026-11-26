//! ACP session lifecycle: hardened spawn, protocol negotiation, session
//! setup/recovery, prompt streaming and cancellation.
//!
//! One agent process per `(conversation, provider)` is kept alive in
//! [`crate::acp::AcpManager`]; the SDK owns newline-delimited JSON-RPC framing
//! while the app owns process hardening, stderr capture and kill trees.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use agent_client_protocol::{
    Agent, Client, Error as SdkError, UntypedMessage, schema::ProtocolVersion,
    v1::ConnectionTo as V1Connection, v1::schema::InitializeRequest as V1Initialize,
    v2::ConnectionTo as V2Connection, v2::schema::Implementation,
    v2::schema::InitializeRequest as V2Initialize,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use anyhow::{Context, Result, anyhow};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::Manager;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

use crate::acp::{
    AcpAgentCapabilities, AcpAgentRow, AcpAuthMethod, AcpManager, AcpModelRow, AcpSessionRow,
    LiveSession, mapping,
};
use crate::providers::{EventSink, ProviderError, ProviderResult};

/// Global cap on live agent processes.
const MAX_SESSIONS: usize = 8;
/// Idle processes are recycled after this long.
const TTL: Duration = Duration::from_secs(10 * 60);
/// Handshake deadline (also used by `probe`).
const INIT_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// Grace period after `session/cancel` before the process tree is killed.
const CANCEL_GRACE: Duration = Duration::from_secs(3);
/// Cap on the stderr log kept on disk.
const STDERR_LIMIT: usize = 256 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// SDK error code for "agent requires a newer protocol version".
const UNSUPPORTED_VERSION: i64 = -32022;

static LIVE: LazyLock<Mutex<BTreeMap<String, Arc<SessionHandle>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
type Driver = Pin<Box<dyn Future<Output = std::result::Result<(), SdkError>> + Send>>;

/// A live JSON-RPC connection. Typed handles differ between protocol versions;
/// untyped requests keep a single implementation for all session methods.
#[derive(Clone)]
pub(crate) enum Connection {
    V1(V1Connection<Agent>),
    V2(V2Connection<Agent>),
}

impl Connection {
    pub(crate) async fn request(&self, method: &str, params: Value) -> std::result::Result<Value, SdkError> {
        let message = UntypedMessage {
            method: method.to_string(),
            params,
        };
        match self {
            Self::V1(cx) => cx.send_request(message).block_task().await,
            Self::V2(cx) => cx.send_request(message).block_task().await,
        }
    }

    fn notify(&self, method: &str, params: Value) {
        let message = UntypedMessage {
            method: method.to_string(),
            params,
        };
        match self {
            Self::V1(cx) => {
                let _ = cx.send_notification(message);
            }
            Self::V2(cx) => {
                let _ = cx.send_notification(message);
            }
        }
    }
}

/// State shared by the connection's inbound handlers and the active turn.
#[derive(Default)]
pub(crate) struct SharedState {
    pub(crate) turn: Option<TurnState>,
    pub(crate) config_state: BTreeMap<String, Value>,
    pub(crate) cancelled: bool,
}

pub(crate) struct TurnState {
    sink: EventSink,
    updates: UnboundedSender<Value>,
    session_id: String,
    mapping: mapping::MappingState,
}

#[derive(Default)]
pub(crate) struct Shared {
    pub(crate) state: Mutex<SharedState>,
}

/// The discovered `category: "model"` config option, with its allowed values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelConfig {
    pub(crate) id: String,
    pub(crate) allowed: Vec<String>,
}

pub(crate) struct SessionHandle {
    pub(crate) key: String,
    pub(crate) conversation_id: String,
    pub(crate) provider_id: String,
    pub(crate) agent_id: String,
    pub(crate) session_id: String,
    pub(crate) protocol_version: i64,
    pub(crate) cwd: String,
    pub(crate) capabilities: AcpAgentCapabilities,
    pub(crate) conn: Connection,
    pub(crate) shared: Arc<Shared>,
    pub(crate) stop: Mutex<Option<oneshot::Sender<()>>>,
    pub(crate) task: JoinHandle<std::result::Result<(), SdkError>>,
    pub(crate) last_used: Mutex<Instant>,
    pub(crate) model_config: Mutex<Option<ModelConfig>>,
    pub(crate) child: Mutex<Option<Child>>,
    pub(crate) fresh: bool,
}

impl SessionHandle {
    pub(crate) fn touch(&self) {
        *self.last_used.lock() = Instant::now();
    }

    /// Copy config values learned from `config_option_update` back to the
    /// persisted session snapshot before a turn ends.
    pub(crate) fn sync_config_state(&self) -> BTreeMap<String, Value> {
        let state = self.shared.state.lock();
        state.config_state.clone()
    }
}

/// Result of a successful process spawn + `initialize`.
pub(crate) struct Spawned {
    pub(crate) conn: Connection,
    pub(crate) child_pid: Option<u32>,
    pub(crate) init: Value,
    pub(crate) protocol_version: i64,
    pub(crate) capabilities: AcpAgentCapabilities,
    pub(crate) auth_methods: Vec<AcpAuthMethod>,
    pub(crate) shared: Arc<Shared>,
    pub(crate) stop: oneshot::Sender<()>,
    pub(crate) task: JoinHandle<std::result::Result<(), SdkError>>,
    pub(crate) child: Child,
}

/// Spawn an agent and negotiate v1, falling back to v2 when the agent requires
/// it. The child is kept alive by the connection task until `stop` is dropped.
pub(crate) async fn spawn_agent(
    app: &tauri::AppHandle,
    row: &AcpAgentRow,
    conversation_id: &str,
    cwd: &Path,
) -> Result<Spawned> {
    match spawn_version(app, row, conversation_id, cwd, 1).await {
        Ok(spawned) if spawned.protocol_version >= 2 => {
            let _ = spawned.stop.send(());
            let mut child = spawned.child;
            let _ = child.start_kill();
            spawned.task.abort();
            spawn_version(app, row, conversation_id, cwd, 2).await
        }
        Ok(spawned) => Ok(spawned),
        Err(error) if requires_v2(&error) => {
            spawn_version(app, row, conversation_id, cwd, 2).await
        }
        Err(error) => Err(error),
    }
}

async fn spawn_version(
    app: &tauri::AppHandle,
    row: &AcpAgentRow,
    conversation_id: &str,
    cwd: &Path,
    version: i64,
) -> Result<Spawned> {
    let state = app.state::<crate::state::AppState>();
    let mut extra = row.env();
    for name in secret_names(row) {
        if let Some(value) = secret_value(app, row, &name) {
            extra.insert(name, value);
        }
    }
    let extra_refs: Vec<(&str, &str)> = extra
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let env = crate::workspace::exec::sanitized_env(&extra_refs);
    let program = crate::acp::launch_program(row, &env);
    let mut command = Command::new(program);
    command
        .args(row.args())
        .current_dir(cwd)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (name, value) in &env {
        command.env(name, value);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
    .map_err(|error| anyhow::anyhow!("ACP spawn failed for {}: {error:#}", row.name))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("ACP agent stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ACP agent stdout unavailable"))?;
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        let log_path = state.data_dir.join("acp").join("logs").join(safe_log_name(conversation_id));
        tokio::spawn(capture_stderr(stderr, log_path));
    }

    let shared = Arc::new(Shared::default());
    let (ready_tx, ready_rx) = oneshot::channel::<Connection>();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    let driver = if version == 1 {
        v1_driver(
            stdin,
            stdout,
            ready_tx,
            stop_rx,
            shared.clone(),
            app.clone(),
            row.clone(),
            conversation_id.to_string(),
        )
    } else {
        v2_driver(
            stdin,
            stdout,
            ready_tx,
            stop_rx,
            shared.clone(),
            app.clone(),
            row.clone(),
            conversation_id.to_string(),
        )
    };
    let task = tokio::spawn(async move {
        let result = driver.await;
        if let Err(error) = &result {
            eprintln!("ACP connection ended: {error}");
        }
        result
    });
    let conn = match timeout(INIT_TIMEOUT, ready_rx).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(_)) | Err(_) => {
            task.abort();
            let _ = child.start_kill();
            return Err(anyhow!("ACP agent closed the connection during initialize"));
        }
    };

    let init = match initialize(&conn, version).await {
        Ok(init) => init,
        Err(error) => {
            task.abort();
            let _ = child.start_kill();
            return Err(error);
        }
    };
    let protocol_version = init
        .get("protocolVersion")
        .and_then(Value::as_i64)
        .unwrap_or(version);
    Ok(Spawned {
        conn,
        child_pid: pid,
        capabilities: parse_capabilities(&init),
        auth_methods: parse_auth_methods(&init),
        init,
        protocol_version,
        shared,
        stop: stop_tx,
        task,
        child,
    })
}
fn v1_driver(
    stdin: ChildStdin,
    stdout: ChildStdout,
    ready_tx: oneshot::Sender<Connection>,
    stop_rx: oneshot::Receiver<()>,
    shared: Arc<Shared>,
    app: tauri::AppHandle,
    row: AcpAgentRow,
    conversation_id: String,
) -> Driver {
    let notify_app = app.clone();
    let notify_provider = row.id.clone();
    Box::pin(
        Client
            .v1()
            .name("zylara")
            .on_receive_notification(
                async move |message: UntypedMessage, _cx| {
                    on_notification(&notify_app, &notify_provider, &shared, &message).await;
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: UntypedMessage, responder, _cx| {
                    on_request(&app, &conversation_id, &row, request, responder).await
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(
                agent_client_protocol::ByteStreams::new(stdin.compat_write(), stdout.compat()),
                async move |cx: V1Connection<Agent>| {
                    let _ = ready_tx.send(Connection::V1(cx.clone()));
                    let _ = stop_rx.await;
                    Ok(())
                },
            ),
    )
}

fn v2_driver(
    stdin: ChildStdin,
    stdout: ChildStdout,
    ready_tx: oneshot::Sender<Connection>,
    stop_rx: oneshot::Receiver<()>,
    shared: Arc<Shared>,
    app: tauri::AppHandle,
    row: AcpAgentRow,
    conversation_id: String,
) -> Driver {
    let notify_app = app.clone();
    let notify_provider = row.id.clone();
    Box::pin(
        Client
            .v2()
            .name("zylara")
            .on_receive_notification(
                async move |message: UntypedMessage, _cx| {
                    on_notification(&notify_app, &notify_provider, &shared, &message).await;
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: UntypedMessage, responder, _cx| {
                    on_request(&app, &conversation_id, &row, request, responder).await
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(
                agent_client_protocol::ByteStreams::new(stdin.compat_write(), stdout.compat()),
                async move |cx: V2Connection<Agent>| {
                    let _ = ready_tx.send(Connection::V2(cx.clone()));
                    let _ = stop_rx.await;
                    Ok(())
                },
            ),
    )
}

async fn initialize(conn: &Connection, _version: i64) -> Result<Value> {
    let response = match conn {
        Connection::V1(cx) => serde_json::to_value(
            cx.send_request(V1Initialize::new(ProtocolVersion::V1))
                .block_task()
                .await
                .map_err(rpc_failure)?,
        )
        .context("ACP initialize response is not JSON")?,
        Connection::V2(cx) => serde_json::to_value(
            cx.send_request(V2Initialize::new(
                ProtocolVersion::V2,
                Implementation::new("zylara", env!("CARGO_PKG_VERSION")),
            ))
            .block_task()
            .await
            .map_err(rpc_failure)?,
        )
        .context("ACP initialize response is not JSON")?,
    };
    Ok(response)
}

fn rpc_failure(error: SdkError) -> anyhow::Error {
    anyhow!(
        "ACP_RPC_{}: {}",
        i64::from(error.code.value()),
        crate::acp::mapping::clean_text(&error.message)
    )
}

fn requires_v2(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains(&format!("ACP_RPC_{UNSUPPORTED_VERSION}"))
        || text.contains(&UNSUPPORTED_VERSION.to_string())
        || text.contains("requires protocol version 2")
        || text.contains("protocolVersion: 2")
}

async fn on_notification(
    app: &tauri::AppHandle,
    provider_id: &str,
    shared: &Shared,
    message: &UntypedMessage,
) {
    if message.method() != "session/update" && message.method() != "session/info_update" {
        return;
    }
    let session_id = message
        .params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let update = message
        .params
        .get("update")
        .cloned()
        .unwrap_or_else(|| message.params.clone());
    if update.get("sessionUpdate").and_then(Value::as_str) == Some("config_option_update") {
        if let Some(options) = update.get("configOptions").and_then(Value::as_array) {
            persist_thinking_config(app, provider_id, options);
        }
    }
    let mut guard = shared.state.lock();
    let crate::acp::session::SharedState {
        turn, config_state, ..
    } = &mut *guard;
    if let Some(turn) = turn.as_mut() {
        if session_id.is_empty() || session_id == turn.session_id {
            let _ = mapping::apply_update_with_state(&update, &turn.sink, config_state, &mut turn.mapping);
            let _ = turn.updates.send(update);
        }
    }
}


async fn on_request<P: agent_client_protocol::Protocol>(
    app: &tauri::AppHandle,
    conversation_id: &str,
    row: &AcpAgentRow,
    request: UntypedMessage,
    responder: agent_client_protocol::Responder<Value, P>,
) -> std::result::Result<(), SdkError> {
    let payload = json!({ "method": request.method, "params": request.params });
    match crate::acp::host::handle_request(app, &payload, conversation_id, row).await {
        Ok(value) => responder.respond(value),
        Err(error) => {
            let text = error.to_string();
            let base = if text.starts_with(crate::acp::host::METHOD_NOT_FOUND) {
                SdkError::method_not_found()
            } else if text.starts_with(crate::acp::host::INVALID_PARAMS) {
                SdkError::invalid_params()
            } else {
                SdkError::internal_error()
            };
            responder.respond_with_error(base.data(Value::String(text)))
        }
    }
}

fn secret_names(row: &AcpAgentRow) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&row.env_secret_names_json).unwrap_or_default()
}

fn secret_value(app: &tauri::AppHandle, row: &AcpAgentRow, name: &str) -> Option<String> {
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

fn safe_log_name(conversation_id: &str) -> String {
    let stem: String = conversation_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .take(64)
        .collect();
    format!("{stem}.log")
}

async fn capture_stderr(
    stderr: tokio::process::ChildStderr,
    path: PathBuf,
) {
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        let text = format!("{}\n", crate::acp::mapping::clean_text(&line));
        let mut file = match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(_) => continue,
        };
        if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > STDERR_LIMIT as u64 {
            let _ = std::fs::write(&path, b"[stderr log rotated]\n");
            file = match std::fs::OpenOptions::new().append(true).open(&path) {
                Ok(file) => file,
                Err(_) => continue,
            };
        }
        use std::io::Write;
        let _ = file.write_all(text.as_bytes());
    }
}

/// Parse the features advertised by `initialize` into the persisted snapshot.
pub(crate) fn parse_capabilities(init: &Value) -> AcpAgentCapabilities {
    let caps = init.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    let prompt = caps.get("promptCapabilities").cloned().unwrap_or(Value::Null);
    let session = caps.get("sessionCapabilities").cloned().unwrap_or(Value::Null);
    let mcp = caps.get("mcpCapabilities").cloned().unwrap_or(Value::Null);
    let auth = caps.get("auth").cloned().unwrap_or(Value::Null);
    let snapshot = json!({
        "protocolVersion": init.get("protocolVersion").and_then(Value::as_i64).unwrap_or(1),
        "loadSession": caps.get("loadSession").and_then(Value::as_bool).unwrap_or(false),
        "resume": session.get("resume").and_then(Value::as_bool).unwrap_or(false),
        "close": session.get("close").and_then(Value::as_bool).unwrap_or(false)
            || init.get("protocolVersion").and_then(Value::as_i64).unwrap_or(1) == 2,
        "image": prompt.get("image").and_then(Value::as_bool).unwrap_or(false),
        "embeddedContext": prompt.get("embeddedContext").and_then(Value::as_bool).unwrap_or(false),
        "systemPrompt": session.get("systemPrompt").and_then(Value::as_bool).unwrap_or(false),
        "additionalDirectories": session.get("additionalDirectories").and_then(Value::as_bool).unwrap_or(false),
        "terminalAuth": false,
        "mcpHttp": mcp.get("http").and_then(Value::as_bool).unwrap_or(false),
        "authMethods": Vec::<AcpAuthMethod>::new(),
        "supportsLogout": auth.get("logout").and_then(Value::as_bool).unwrap_or(false),
    });
    let mut parsed: AcpAgentCapabilities = serde_json::from_value(snapshot).unwrap_or_default();
    let methods = parse_auth_methods(init);
    parsed.terminal_auth = methods.iter().any(|method| method.kind == "terminal");
    parsed.auth_methods = methods;
    parsed
}

fn parse_auth_methods(init: &Value) -> Vec<AcpAuthMethod> {
    let Some(methods) = init.get("authMethods").and_then(Value::as_array) else {
        return Vec::new();
    };
    methods
        .iter()
        .filter_map(|method| {
            let id = method.get("id").and_then(Value::as_str)?;
            Some(AcpAuthMethod {
                id: crate::acp::mapping::clean_text(id),
                name: crate::acp::mapping::clean_text(
                    method.get("name").and_then(Value::as_str).unwrap_or(id),
                ),
                description: method
                    .get("description")
                    .and_then(Value::as_str)
                    .map(crate::acp::mapping::clean_text),
                kind: if method.get("type").and_then(Value::as_str) == Some("terminal") {
                    "terminal"
                } else {
                    "agent"
                }
                .to_string(),
            })
        })
        .collect()
}

/// Discover models from ACP `configOptions` with `category: "model"`.
pub(crate) fn discover_models(config_options: &[Value]) -> Vec<AcpModelRow> {
    let mut models = Vec::new();
    for option in config_options {
        if option.get("category").and_then(Value::as_str) != Some("model") {
            continue;
        }
        let Some(current) = option.get("currentValue").and_then(Value::as_str) else {
            continue;
        };
        let Some(choices) = option.get("options").and_then(Value::as_array) else {
            continue;
        };
        for choice in choices {
            let Some(value) = choice.get("value").and_then(Value::as_str) else {
                continue;
            };
            if value.is_empty() {
                continue;
            }
            models.push(AcpModelRow {
                model_id: crate::acp::mapping::clean_text(value),
                name: crate::acp::mapping::clean_text(
                    choice
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(value),
                ),
                description: choice
                    .get("description")
                    .and_then(Value::as_str)
                    .map(crate::acp::mapping::clean_text),
                is_default: value == current,
                options_json: choice.to_string(),
            });
        }
    }
    if models.is_empty() {
        models.push(AcpModelRow {
            model_id: "default".to_string(),
            name: crate::i18n::t("acp.defaultModelName"),
            description: None,
            is_default: true,
            options_json: json!({}).to_string(),
        });
    }
    if !models.iter().any(|model| model.is_default) {
        if let Some(first) = models.first_mut() {
            first.is_default = true;
        }
    }
    models
}

pub(crate) fn model_config(config_options: &[Value]) -> Option<ModelConfig> {
    for option in config_options {
        let category = option.get("category").and_then(Value::as_str).unwrap_or("");
        let kind = option.get("type").and_then(Value::as_str).unwrap_or("");
        if (category == "model" || category == "modelConfig") && kind == "select" {
            let id = option.get("id").and_then(Value::as_str)?;
            let allowed = option
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|choice| choice.get("value").and_then(Value::as_str))
                .map(crate::acp::mapping::clean_text)
                .collect();
            return Some(ModelConfig {
                id: crate::acp::mapping::clean_text(id),
                allowed,
            });
        }
    }
    None
}

/// ACP `thought_level` (or equivalently named) config option advertised by an
/// agent. Stored on the agent row so the model picker can expose thinking
/// controls and each turn can apply the user's selection.
pub(crate) fn discover_thinking_config(config_options: &[Value]) -> Option<Value> {
    for option in config_options {
        let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
        let category = option.get("category").and_then(Value::as_str).unwrap_or_default();
        let lower_id = id.to_ascii_lowercase();
        if category != "thought_level"
            && !lower_id.contains("thinking")
            && !lower_id.contains("reason")
        {
            continue;
        }
        let kind = option.get("type").and_then(Value::as_str).unwrap_or("select");
        let values: Vec<String> = if kind == "boolean" {
            vec!["true".to_string(), "false".to_string()]
        } else {
            option
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|choice| choice.get("value").and_then(Value::as_str))
                .map(crate::acp::mapping::clean_text)
                .filter(|value| !value.is_empty())
                .collect()
        };
        if values.is_empty() {
            continue;
        }
        return Some(json!({
            "id": crate::acp::mapping::clean_text(id),
            "type": kind,
            "values": values,
            "currentValue": option.get("currentValue").cloned().unwrap_or(Value::Null),
        }));
    }
    None
}

pub(crate) fn config_options_from(value: &Value) -> Vec<Value> {
    value
        .get("configOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Persist a discovered `thought_level` option on the agent row so the model
/// picker can expose thinking controls before a turn starts.
pub(crate) fn persist_thinking_config(app: &tauri::AppHandle, provider_id: &str, options: &[Value]) {
    let Some(thinking) = discover_thinking_config(options) else {
        return;
    };
    let state = app.state::<crate::state::AppState>();
    if let Ok(Some(mut row)) = state.db.acp_agent(provider_id) {
        row.thinking_config_json =
            serde_json::to_string(&thinking).unwrap_or_else(|_| "{}".to_string());
        row.updated_at = crate::domain::now_ms();
        let _ = state.db.acp_agent_save(&row);
    }
}

/// Acquire (or create) the live session for one conversation/provider pair.
pub(crate) async fn acquire(
    app: &tauri::AppHandle,
    row: &AcpAgentRow,
    conversation_id: &str,
    provider_id: &str,
    system_prompt: &str,
) -> ProviderResult<Arc<SessionHandle>> {
    let key = AcpManager::session_key(conversation_id, provider_id);
    let existing = {
        let live = LIVE.lock();
        live.get(&key).cloned()
    };
    if let Some(handle) = existing {
        if !is_expired(handle.last_used.lock().elapsed()) && !handle.task.is_finished() {
            handle.touch();
            return Ok(handle);
        }
        close(conversation_id, provider_id).await;
    }
    evict_one_if_full().await;

    let state = app.state::<crate::state::AppState>();
    let cwd = workspace_dir(app, conversation_id);
    let _ = tokio::fs::create_dir_all(&cwd).await;
    let spawned = spawn_agent(app, row, conversation_id, &cwd)
        .await
        .map_err(|error| ProviderError::Network(error.to_string()))?;

    let mcp = crate::acp::host::mcp_servers(app, row.trusted, spawned.capabilities.mcp_http);
    let mut params = json!({
        "cwd": cwd.to_string_lossy(),
        "mcpServers": mcp,
    });
    if spawned.capabilities.system_prompt && !system_prompt.is_empty() {
        params["systemPrompt"] = Value::String(crate::acp::mapping::clean_text(system_prompt));
    }
    if spawned.capabilities.additional_directories {
        params["additionalDirectories"] = json!([]);
    }

    let saved = state
        .db
        .acp_session(conversation_id, provider_id)
        .ok()
        .flatten();
    let mut session_id = String::new();
    let mut options = Vec::new();
    if let Some(saved) = saved {
        let resume = if spawned.capabilities.resume {
            Some(("session/resume", json!({ "replayFrom": { "type": "start" } })))
        } else if spawned.capabilities.load_session && spawned.protocol_version == 1 {
            Some(("session/load", json!({})))
        } else {
            None
        };
        if let Some((method, extra)) = resume {
            let mut resume_params = json!({
                "sessionId": saved.session_id,
                "cwd": cwd.to_string_lossy(),
                "mcpServers": mcp.clone(),
            });
            if let Some(extra_fields) = extra.as_object() {
                for (name, value) in extra_fields {
                    resume_params[name.clone()] = value.clone();
                }
            }
            if let Ok(response) = spawned.conn.request(method, resume_params).await {
                session_id = response
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(&saved.session_id)
                    .to_string();
                options = config_options_from(&response);
            }
        }
    }
    if session_id.is_empty() {
        let response = spawned
            .conn
            .request("session/new", params)
            .await
            .map_err(|error| map_sdk_error(&error))?;
        session_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(crate::acp::mapping::clean_text)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ProviderError::BadRequest("ACP agent returned no sessionId".into()))?;
        options = config_options_from(&response);
    }
    let fresh = session_id.is_empty();

    let models = discover_models(&options);
    let _ = state.db.acp_models_replace(provider_id, &models);
    if let Some(thinking) = discover_thinking_config(&options) {
        let mut stored = row.clone();
        stored.thinking_config_json =
            serde_json::to_string(&thinking).unwrap_or_else(|_| "{}".to_string());
        stored.updated_at = crate::domain::now_ms();
        let _ = state.db.acp_agent_save(&stored);
    }
    let mut config_state = BTreeMap::new();
    for option in &options {
        if let (Some(id), Some(value)) = (
            option.get("id").and_then(Value::as_str),
            option.get("currentValue").cloned(),
        ) {
            config_state.insert(id.to_string(), value);
        }
    }
    spawned.shared.state.lock().config_state = config_state.clone();
    let now = crate::domain::now_ms();
    let row = AcpSessionRow {
        conversation_id: conversation_id.to_string(),
        provider_id: provider_id.to_string(),
        session_id: session_id.clone(),
        protocol_version: spawned.protocol_version,
        cwd: cwd.to_string_lossy().to_string(),
        config_state_json: serde_json::to_string(&config_state).unwrap_or_else(|_| "{}".into()),
        capabilities_json: serde_json::to_string(&spawned.capabilities)
            .unwrap_or_else(|_| "{}".into()),
        created_at: now,
        updated_at: now,
    };
    let _ = state.db.acp_session_save(&row);
    let has_manager = crate::acp::manager().is_some();
    let mut child = Some(spawned.child);
    let handle = Arc::new(SessionHandle {
        key: key.clone(),
        conversation_id: conversation_id.to_string(),
        provider_id: provider_id.to_string(),
        agent_id: provider_id.to_string(),
        session_id,
        protocol_version: spawned.protocol_version,
        cwd: row.cwd,
        capabilities: spawned.capabilities,
        conn: spawned.conn,
        shared: spawned.shared,
        stop: Mutex::new(Some(spawned.stop)),
        task: spawned.task,
        last_used: Mutex::new(Instant::now()),
        model_config: Mutex::new(model_config(&options)),
        child: Mutex::new(if has_manager { None } else { child.take() }),
        fresh,
    });
    if let Some(manager) = crate::acp::manager() {
        let mut sessions = manager.sessions.lock().await;
        sessions.insert(
            key,
            LiveSession {
                agent_id: handle.agent_id.clone(),
                conversation_id: conversation_id.to_string(),
                provider_id: provider_id.to_string(),
                session_id: handle.session_id.clone(),
                protocol_version: handle.protocol_version,
                cwd: handle.cwd.clone(),
                capabilities: handle.capabilities.clone(),
                config_state,
                child: child.take(),
            },
        );
    }
    LIVE.lock().insert(handle.key.clone(), handle.clone());
    Ok(handle)
}

/// Reuse the workspace of the conversation when there is one; otherwise use
/// the internal agent scratch directory already used by thread agents.
fn workspace_dir(app: &tauri::AppHandle, conversation_id: &str) -> PathBuf {
    let state = app.state::<crate::state::AppState>();
    state
        .db
        .get_conversation(conversation_id)
        .ok()
        .flatten()
        .and_then(|conversation| conversation.workspace_id)
        .and_then(|id| state.db.get_workspace(&id).ok().flatten())
        .map(|workspace| PathBuf::from(workspace.path))
        .unwrap_or_else(|| {
            state
                .data_dir
                .join("agent-workspaces")
                .join(safe_log_name(conversation_id))
        })
}

async fn evict_one_if_full() {
    let victim = {
        let live = LIVE.lock();
        if live.len() < MAX_SESSIONS {
            None
        } else {
            live.iter()
                .min_by_key(|(_, handle)| handle.last_used.lock().elapsed())
                .map(|(key, handle)| (key.clone(), handle.conversation_id.clone(), handle.provider_id.clone()))
        }
    };
    if let Some((_, conversation_id, provider_id)) = victim {
        close(&conversation_id, &provider_id).await;
    }
}

pub(crate) fn is_expired(elapsed: Duration) -> bool {
    elapsed > TTL
}

/// Apply the selected model through `session/set_config_option`.
pub(crate) async fn apply_model(
    app: &tauri::AppHandle,
    handle: &SessionHandle,
    model_id: &str,
) -> ProviderResult<()> {
    let config = handle.model_config.lock().clone();
    let Some(config) = config else {
        return Ok(());
    };
    if !config.allowed.is_empty() && !config.allowed.iter().any(|value| value == model_id) {
        return Err(ProviderError::UnsupportedCapability(
            crate::providers::StructuredError {
                message: format!("model {model_id} is not offered by this ACP agent"),
                code: Some(config.id.clone()),
                ..crate::providers::StructuredError::default()
            },
        ));
    }
    let current = handle
        .shared
        .state
        .lock()
        .config_state
        .get(&config.id)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if current == model_id {
        return Ok(());
    }
    let response = handle
        .conn
        .request(
            "session/set_config_option",
            json!({
                "sessionId": handle.session_id,
                "configId": config.id,
                "value": model_id,
            }),
        )
        .await
        .map_err(|error| map_sdk_error(&error))?;
    persist_thinking_config(app, &handle.provider_id, &config_options_from(&response));
    handle.shared.state.lock().config_state.insert(
        config.id.clone(),
        Value::String(model_id.to_string()),
    );
    persist_config_state(app, handle).await;
    Ok(())
}

async fn persist_config_state(app: &tauri::AppHandle, handle: &SessionHandle) {
    let state = app.state::<crate::state::AppState>();
    let config = handle.sync_config_state();
    let Ok(Some(mut saved)) = state
        .db
        .acp_session(&handle.conversation_id, &handle.provider_id)
    else {
        return;
    };
    saved.config_state_json = serde_json::to_string(&config).unwrap_or_else(|_| "{}".into());
    saved.updated_at = crate::domain::now_ms();
    let _ = state.db.acp_session_save(&saved);
}

/// Apply the renderer's thinking selection through the agent's own
/// `thought_level` config option. `Auto` leaves the agent default untouched;
/// unsupported values are ignored rather than sent as invalid config.
pub(crate) async fn apply_thinking(
    app: &tauri::AppHandle,
    handle: &SessionHandle,
    row: &crate::acp::AcpAgentRow,
    model: &crate::catalog::ModelInfo,
    reasoning: &crate::providers::ReasoningRequest,
) -> ProviderResult<()> {
    use crate::providers::ReasoningRequest;

    let (id, values) = if row.thinking_config_json != "{}" {
        let Ok(config) = serde_json::from_str::<Value>(&row.thinking_config_json) else {
            return Ok(());
        };
        let Some(id) = config.get("id").and_then(Value::as_str).map(str::to_string) else {
            return Ok(());
        };
        let values: Vec<String> = config
            .get("values")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|value| value.to_ascii_lowercase())
            .collect();
        (id, values)
    } else {
        // Fallback: the bundled catalog already knows this model's effort
        // values; OpenCode uses `effort` for thought_level.
        let values = model
            .reasoning_options
            .iter()
            .find_map(|option| option.efforts())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|value| value.to_ascii_lowercase())
            .collect();
        ("effort".to_string(), values)
    };
    let value = match reasoning {
        ReasoningRequest::Auto => return Ok(()),
        ReasoningRequest::Off => ["off", "none", "false"]
            .iter()
            .find(|candidate| values.iter().any(|v| v == *candidate))
            .map(|candidate| candidate.to_string()),
        ReasoningRequest::Effort(effort) => {
            let effort = effort.to_ascii_lowercase();
            values.contains(&effort).then_some(effort)
        }
        ReasoningRequest::Budget(_) => None,
    };
    let Some(value) = value else {
        return Ok(());
    };
    let current = handle
        .shared
        .state
        .lock()
        .config_state
        .get(&id)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if current == value {
        return Ok(());
    }
    let response = handle
        .conn
        .request(
            "session/set_config_option",
            json!({ "sessionId": handle.session_id, "configId": id.clone(), "value": value }),
        )
        .await
        .map_err(|error| map_sdk_error(&error));
    // Agents that do not advertise this config option must not fail the turn.
    if response.is_err() {
        return Ok(());
    }
    handle.shared.state.lock().config_state.insert(
        id.to_string(),
        Value::String(value.clone()),
    );
    persist_config_state(app, handle).await;
    Ok(())
}
/// Persist config values learned during the turn.
pub(crate) async fn persist(app: &tauri::AppHandle, handle: &SessionHandle) {
    persist_config_state(app, handle).await;
}

/// Send one prompt and wait for the agent's terminal signal.
///
/// Updates are projected to `ProviderEvent`s by the inbound notification
/// handler; this function only decides when the turn is finished.
pub(crate) async fn send_prompt(
    handle: &SessionHandle,
    prompt: Vec<Value>,
    sink: &EventSink,
    cancel: &CancellationToken,
) -> ProviderResult<()> {
    let (updates_tx, mut updates_rx) = unbounded_channel::<Value>();
    {
        let mut guard = handle.shared.state.lock();
        guard.cancelled = false;
        guard.turn = Some(TurnState {
            sink: sink.clone(),
            updates: updates_tx,
            session_id: handle.session_id.clone(),
            mapping: mapping::MappingState::default(),
        });
    }
    crate::acp::host::bind_cancel(&handle.conversation_id, cancel.clone());
    handle.touch();

    let mut response = Box::pin(handle.conn.request(
        "session/prompt",
        json!({ "sessionId": handle.session_id, "prompt": prompt }),
    ));
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            handle.conn.notify("session/cancel", json!({ "sessionId": handle.session_id }));
            match tokio::time::timeout(CANCEL_GRACE, &mut response).await {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => {
                    clear_turn(handle).await;
                    return Err(map_sdk_error(&error));
                }
                Err(_) => {
                    terminate_process(handle).await;
                    clear_turn(handle).await;
                    return Err(ProviderError::Cancelled);
                }
            }
        }
        result = &mut response => result.map_err(|error| map_sdk_error(&error))?,
    };
    if handle.protocol_version >= 2 {
        let idle = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                handle.conn.notify("session/cancel", json!({ "sessionId": handle.session_id }));
                terminate_process(handle).await;
                clear_turn(handle).await;
                return Err(ProviderError::Cancelled);
            }
            idle = wait_for_idle(&mut updates_rx, &handle.session_id) => idle,
        };
        clear_turn(handle).await;
        return mapping::stop_reason(&idle.unwrap_or_default());
    }
    let reason = outcome
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("end_turn")
        .to_string();
    clear_turn(handle).await;
    mapping::stop_reason(&reason)
}

async fn wait_for_idle(updates: &mut UnboundedReceiver<Value>, session_id: &str) -> Option<String> {
    loop {
        let update = updates.recv().await?;
        if update.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            continue;
        }
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
        if kind == "state_update" {
            let state = update
                .get("state")
                .and_then(|state| state.get("type").or_else(|| state.get("state")))
                .and_then(Value::as_str)
                .or_else(|| update.get("state").and_then(Value::as_str))
                .unwrap_or("");
            if state == "idle" {
                return update
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
    }
}

async fn clear_turn(handle: &SessionHandle) {
    {
        let mut guard = handle.shared.state.lock();
        guard.turn = None;
        guard.cancelled = false;
    }
    crate::acp::host::clear_cancel(&handle.conversation_id);
}

/// Ask the agent to stop and kill its process tree if it does not comply.
pub(crate) async fn cancel(conversation_id: &str, provider_id: &str) {
    let handle = {
        let live = LIVE.lock();
        let key = AcpManager::session_key(conversation_id, provider_id);
        live.get(&key).cloned()
    };
    let Some(handle) = handle else {
        return;
    };
    handle.shared.state.lock().cancelled = true;
    handle
        .conn
        .notify("session/cancel", json!({ "sessionId": handle.session_id }));
}

/// Close one session and terminate its process tree.
pub(crate) async fn close(conversation_id: &str, provider_id: &str) {
    let key = AcpManager::session_key(conversation_id, provider_id);
    let handle = LIVE.lock().remove(&key);
    let Some(handle) = handle else {
        return;
    };
    if handle.capabilities.close || handle.protocol_version >= 2 {
        let request = handle.conn.request(
            "session/close",
            json!({ "sessionId": handle.session_id }),
        );
        let _ = timeout(Duration::from_secs(2), request).await;
    }
    if let Some(stop) = handle.stop.lock().take() {
        let _ = stop.send(());
    }
    terminate_process(&handle).await;
    handle.task.abort();
    crate::acp::host::clear_cancel(conversation_id);
    if let Some(manager) = crate::acp::manager() {
        let _ = manager.sessions.lock().await.remove(&key);
    }
}

/// Terminate the child and its descendants. `exec::kill_process_tree` is
/// private to the workspace module, so the process-tree barriers live here.
pub(crate) async fn terminate_process(handle: &SessionHandle) {
    let mut pid = None;
    if let Some(mut child) = handle.child.lock().take() {
        let _ = child.start_kill();
        pid = child.id();
    }
    if let Some(manager) = crate::acp::manager() {
        let mut sessions = manager.sessions.lock().await;
        let key = AcpManager::session_key(&handle.conversation_id, &handle.provider_id);
        if let Some(child) = sessions.get_mut(&key).and_then(|session| session.child.as_mut()) {
            let _ = child.start_kill();
            pid = pid.or_else(|| child.id());
        }
    }
    let Some(pid) = pid.filter(|pid| *pid > 0) else {
        return;
    };
    kill_tree(pid).await;
}

async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut killer = Command::new("taskkill");
        killer
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .env_clear()
            .creation_flags(CREATE_NO_WINDOW);
        let _ = killer.output().await;
    }
    #[cfg(unix)]
    {
        // `process_group(0)` at spawn makes the agent's group leader its pid.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

/// Shutdown hook used by the app's exit path.
pub(crate) async fn close_all() {
    let keys: Vec<(String, String)> = LIVE
        .lock()
        .values()
        .map(|handle| (handle.conversation_id.clone(), handle.provider_id.clone()))
        .collect();
    for (conversation_id, provider_id) in keys {
        close(&conversation_id, &provider_id).await;
    }
}

/// True when a model change must be sent to the agent.
pub(crate) fn should_set_model(config_state: &BTreeMap<String, Value>, id: &str, model: &str) -> bool {
    config_state
        .get(id)
        .and_then(Value::as_str)
        .map(|current| current != model)
        .unwrap_or(true)
}

pub(crate) fn sdk_error_code(error: &SdkError) -> i64 {
    i64::from(error.code.value())
}

pub(crate) fn map_sdk_error(error: &SdkError) -> ProviderError {
    mapping::acp_error(i64::from(error.code.value()), &error.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select_option(value: &str, current: &str) -> Value {
        json!({
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": current,
            "options": [
                { "value": value, "name": value.to_uppercase() },
                { "value": current, "name": current.to_uppercase() }
            ]
        })
    }

    #[test]
    fn discovers_models_and_a_default_when_options_are_absent() {
        let models = discover_models(&[select_option("sonnet", "haiku")]);
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|model| model.is_default && model.model_id == "haiku"));
        let default = discover_models(&[]);
        assert_eq!(default.len(), 1);
        assert_eq!(default[0].model_id, "default");
    }

    #[test]
    fn model_config_tracks_valid_values_only() {
        let config = model_config(&[select_option("sonnet", "haiku")]).expect("model config");
        assert_eq!(config.id, "model");
        assert_eq!(config.allowed, vec!["sonnet", "haiku"]);
        assert!(model_config(&[json!({ "id": "thinking", "type": "boolean" })]).is_none());
    }

    #[test]
    fn model_change_is_only_sent_when_value_differs() {
        let mut state = BTreeMap::new();
        state.insert("model".to_string(), Value::String("haiku".into()));
        assert!(should_set_model(&state, "model", "sonnet"));
        assert!(!should_set_model(&state, "model", "haiku"));
    }

    #[test]
    fn ttl_and_log_names_are_bounded() {
        assert!(!is_expired(Duration::from_secs(60)));
        assert!(is_expired(Duration::from_secs(601)));
        let name = safe_log_name("conv/with\\odd:chars");
        assert!(name.ends_with(".log"));
        assert!(name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.'));
    }

    #[test]
    fn capabilities_and_auth_methods_come_from_initialize() {
        let init = json!({
            "protocolVersion": 2,
            "authMethods": [{ "id": "login", "name": "Login", "type": "terminal" }],
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "embeddedContext": true },
                "sessionCapabilities": { "resume": true, "close": true, "systemPrompt": true },
                "mcpCapabilities": { "http": true },
                "auth": { "logout": true }
            }
        });
        let caps = parse_capabilities(&init);
        assert_eq!(caps.protocol_version, 2);
        assert!(caps.image && caps.embedded_context && caps.resume && caps.close);
        assert!(caps.terminal_auth && caps.mcp_http && caps.supports_logout);
        assert_eq!(caps.auth_methods[0].kind, "terminal");
    }
}
