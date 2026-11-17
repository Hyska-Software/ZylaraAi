//! Local Chromium/Edge browser session driven over the DevTools Protocol.
//!
//! The agent never talks to the user's personal browser profile: each
//! conversation gets an isolated profile under `<app-data>/browser/`, a random
//! loopback debugging port, and a dedicated Chromium process. The panel mirrors
//! the active page with CDP screenshots; the agent uses accessibility refs for
//! click/type, not coordinates or arbitrary JS.

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const CDP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SNAPSHOT_ELEMENTS: usize = 200;
const MAX_EXTRACT_CHARS: usize = 30_000;

/// Launch flags for the controlled browser.
///
/// The process is intentionally headless: the page is rendered inside the
/// Agentes panel through CDP screencast and must never open a second app window.
/// Background-throttling flags keep frames and timers alive while the panel is
/// not focused.
fn launch_arguments(port: u16, profile: &Path) -> Vec<String> {
    vec![
        "--headless=new".to_string(),
        format!("--remote-debugging-port={port}"),
        "--remote-debugging-address=127.0.0.1".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-background-timer-throttling".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-component-update".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-extensions".to_string(),
        "--disable-sync".to_string(),
        "--disable-features=Translate,MediaRouter".to_string(),
        "--window-size=1280,820".to_string(),
        "--force-device-scale-factor=1".to_string(),
        "about:blank".to_string(),
    ]
}

static GLOBAL: OnceLock<BrowserManager> = OnceLock::new();

pub fn init_global(data_dir: &Path) {
    let _ = GLOBAL.set(BrowserManager::new(data_dir.to_path_buf()));
}

pub fn global() -> Option<&'static BrowserManager> {
    GLOBAL.get()
}

/// Resolves the same conversation-owned download directory for UI and tools.
pub(crate) fn conversation_download_dir(
    db: &crate::db::Db,
    data_dir: &Path,
    conversation_id: &str,
) -> Result<Option<PathBuf>, String> {
    let conversation = db.get_conversation(conversation_id)
        .map_err(|error| format!("{error:#}"))?
        .ok_or_else(|| format!("BROWSER_CONVERSATION_NOT_FOUND: `{conversation_id}`"))?;
    download_dir_for_binding(db, data_dir, conversation_id, conversation.mode == crate::domain::CONVERSATION_MODE_AGENT, conversation.workspace_id.as_deref())
}

fn download_dir_for_binding(db: &crate::db::Db, data_dir: &Path, conversation_id: &str, is_agent: bool, workspace_id: Option<&str>) -> Result<Option<PathBuf>, String> {
    if let Some(id) = workspace_id {
        let workspace = db.get_workspace(id).map_err(|error| format!("{error:#}"))?
            .ok_or_else(|| format!("BROWSER_WORKSPACE_NOT_FOUND: `{id}`"))?;
        return Ok(Some(PathBuf::from(workspace.path).join("downloads")));
    }
    if is_agent {
        let root = crate::harness::agent_workspace::prepare(data_dir, conversation_id)
            .map_err(|error| format!("{error:#}"))?;
        return Ok(Some(root.join("downloads")));
    }
    Ok(None)
}

pub(crate) async fn ensure_for_conversation(
    manager: &BrowserManager,
    db: &crate::db::Db,
    data_dir: &Path,
    conversation_id: &str,
) -> Result<BrowserStatus, String> {
    let downloads = conversation_download_dir(db, data_dir, conversation_id)?;
    manager.ensure(conversation_id, downloads).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub executable: Option<String>,
    pub profile_dir: Option<String>,
    pub download_dir: Option<String>,
    pub tabs: Vec<BrowserTab>,
    pub active_tab: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrame {
    pub data_url: String,
    pub url: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElement {
    #[serde(rename = "ref")]
    pub reference: String,
    pub role: String,
    pub name: String,
    pub value: String,
    pub disabled: bool,
    pub backend_node_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub url: String,
    pub title: String,
    pub elements: Vec<BrowserElement>,
    pub screenshot: Option<String>,
    pub width: u32,
    pub height: u32,
    pub captured_at: i64,
}

struct BrowserSession {
    child: Child,
    port: u16,
    executable: String,
    profile_dir: PathBuf,
    download_dir: PathBuf,
    active_tab: Mutex<Option<String>>,
    refs: Mutex<HashMap<String, Vec<BrowserElement>>>,
    held_input: Mutex<HashMap<String, HeldInput>>,
}

/// Inputs are recorded before dispatch: a lost CDP reply must not be mistaken
/// for proof that the browser did not receive a press.
#[derive(Default, Clone)]
struct HeldInput {
    keys: HashMap<String, Value>,
    buttons: HashMap<String, Value>,
}

impl HeldInput {
    fn identity(kind: &str, params: &Value) -> Option<String> {
        let field = |name| params.get(name).and_then(Value::as_str).filter(|s| !s.is_empty());
        match kind {
            "key" => field("code").or_else(|| field("key")).map(str::to_string),
            "mouse" => field("button").filter(|s| matches!(*s, "left" | "middle" | "right" | "back" | "forward")).map(str::to_string),
            _ => None,
        }
    }

    fn before_dispatch(&mut self, kind: &str, params: &Value) -> Result<(), String> {
        let event = params.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(event, "keyDown" | "rawKeyDown" | "keyUp" | "mousePressed" | "mouseReleased") {
            let id = Self::identity(kind, params).ok_or(crate::i18n::t("computer.browser.inputMissing"))?;
            if matches!(event, "keyDown" | "rawKeyDown" | "mousePressed") {
                if kind == "key" && !self.keys.contains_key(&id) && self.keys.len() >= 32 {
                    return Err("BROWSER_INPUT_INVALID: teclas pressionadas demais".into());
                }
                let mut release = params.clone();
                let object = release.as_object_mut().ok_or("BROWSER_INPUT_INVALID")?;
                object.insert("type".into(), json!(if kind == "key" { "keyUp" } else { "mouseReleased" }));
                object.remove("text");
                object.remove("unmodifiedText");
                object.remove("autoRepeat");
                object.insert("modifiers".into(), json!(0));
                if kind == "mouse" {
                    object.insert("buttons".into(), json!(0));
                    self.buttons.insert(id, release);
                } else {
                    self.keys.insert(id, release);
                }
            }
        } else if event == "mouseMoved" {
            for release in self.buttons.values_mut() {
                release["x"] = params["x"].clone();
                release["y"] = params["y"].clone();
            }
        }
        Ok(())
    }

    fn after_dispatch(&mut self, kind: &str, params: &Value) {
        let event = params.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(id) = Self::identity(kind, params) {
            match event {
                "keyUp" => { self.keys.remove(&id); },
                "mouseReleased" => { self.buttons.remove(&id); },
                _ => {},
            }
        }
    }

    fn is_empty(&self) -> bool { self.keys.is_empty() && self.buttons.is_empty() }
}

impl BrowserSession {
    fn pid(&self) -> u32 {
        self.child.id()
    }
}

/// Process-wide manager; the app has one browser process per conversation.
pub struct BrowserManager {
    data_dir: PathBuf,
    sessions: Mutex<HashMap<String, BrowserSession>>,
    start_lock: tokio::sync::Mutex<()>,
    http: reqwest::Client,
    #[cfg(test)]
    test_start_port: Option<u16>,
}

impl BrowserManager {
    /// Update a live browser before committing a workspace change.
    /// A lost CDP reply is ambiguous, so terminate the session on any failure.
    pub(crate) async fn prepare_workspace_change(&self, db: &crate::db::Db, conversation_id: &str, workspace_id: Option<&str>) -> Result<bool, String> {
        if !self.is_active(conversation_id) { return Ok(false); }
        let downloads = match download_dir_for_binding(db, &self.data_dir, conversation_id, true, workspace_id) {
            Ok(path) => path,
            Err(error) => { self.close(conversation_id); return Err(error); }
        };
        match self.ensure(conversation_id, downloads).await {
            Ok(_) => Ok(true),
            Err(error) => { self.close(conversation_id); Err(error) }
        }
    }
    /// Streams CDP screencast frames until the subscriber cancels or disconnects.
    pub async fn stream_frames(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        cancel: tokio_util::sync::CancellationToken,
        channel: tauri::ipc::Channel<BrowserFrame>,
    ) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        client.call("Page.enable", json!({})).await?;
        client.call("Page.startScreencast", json!({ "format": "jpeg", "quality": 75, "everyNthFrame": 1 })).await?;
        let (url, title) = self.page_meta(&ws).await.unwrap_or_default();
        let mut ack_id = 1000u64;
        let mut last_frame = Instant::now() - Duration::from_secs(1);
        loop {
            let item = tokio::select! {
                _ = cancel.cancelled() => break,
                item = client.socket.next() => item,
            };
            let Some(Ok(Message::Text(text))) = item else { break };
            let Ok(event) = serde_json::from_str::<Value>(&text) else { continue };
            if event.get("method").and_then(Value::as_str) != Some("Page.screencastFrame") { continue; }
            let params = &event["params"];
            let Some(data) = params.get("data").and_then(Value::as_str) else { continue; };
            let Some(session_id) = params.get("sessionId").and_then(Value::as_u64) else { continue; };
            if last_frame.elapsed() >= Duration::from_millis(60) {
                use base64::Engine;
                let dimensions = base64::engine::general_purpose::STANDARD.decode(data).ok()
                    .and_then(|bytes| image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok())
                    .and_then(|reader| reader.into_dimensions().ok())
                    .unwrap_or((1280, 820));
                if channel.send(BrowserFrame {
                    data_url: format!("data:image/jpeg;base64,{data}"), url: url.clone(), title: title.clone(),
                    width: dimensions.0, height: dimensions.1, captured_at: crate::domain::now_ms(),
                }).is_err() { break; }
                last_frame = Instant::now();
            }
            ack_id += 1;
            let ack = json!({ "id": ack_id, "method": "Page.screencastFrameAck", "params": { "sessionId": session_id } });
            if client.socket.send(Message::Text(ack.to_string().into())).await.is_err() { break; }
        }
        Ok(())
    }
    fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            sessions: Mutex::new(HashMap::new()),
            start_lock: tokio::sync::Mutex::new(()),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            #[cfg(test)]
            test_start_port: None,
        }
    }

    fn safe_id(value: &str) -> String {
        value
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
            .collect()
    }

    fn profile_dir(&self, conversation_id: &str) -> PathBuf {
        self.data_dir
            .join("browser")
            .join(Self::safe_id(conversation_id))
    }

    fn default_download_dir(&self, conversation_id: &str) -> PathBuf {
        self.data_dir
            .join("browser-downloads")
            .join(Self::safe_id(conversation_id))
    }

    fn is_running(session: &mut BrowserSession) -> bool {
        matches!(session.child.try_wait(), Ok(None))
    }

    /// True when a live browser is attached to this conversation.
    pub fn is_active(&self, conversation_id: &str) -> bool {
        let mut sessions = self.sessions.lock();
        let Some(session) = sessions.get_mut(conversation_id) else {
            return false;
        };
        if Self::is_running(session) {
            return true;
        }
        sessions.remove(conversation_id);
        false
    }

    async fn endpoint_json(&self, port: u16, path: &str) -> Result<Value, String> {
        let url = format!("http://127.0.0.1:{port}{path}");
        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|error| format!("BROWSER_CDP_UNREACHABLE: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "BROWSER_CDP_HTTP: {} em {url}",
                response.status()
            ));
        }
        response
            .json()
            .await
            .map_err(|error| format!("BROWSER_CDP_INVALID: {error}"))
    }

    async fn tabs_of(&self, port: u16, active: Option<&str>) -> Result<Vec<BrowserTab>, String> {
        let value = self.endpoint_json(port, "/json/list").await?;
        let items = value.as_array().cloned().unwrap_or_default();
        let mut tabs = Vec::new();
        for item in items {
            if item.get("type").and_then(Value::as_str) != Some("page") {
                continue;
            }
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let url = item.get("url").and_then(Value::as_str).unwrap_or("about:blank");
            // DevTools internal targets are not part of the user's browser.
            if url.starts_with("devtools://") {
                continue;
            }
            tabs.push(BrowserTab {
                id: id.to_string(),
                title: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Nova aba")
                    .to_string(),
                url: url.to_string(),
                active: active == Some(id),
            });
        }
        if !tabs.is_empty() && !tabs.iter().any(|tab| tab.active) {
            if let Some(first) = tabs.first_mut() {
                first.active = true;
            }
        }
        Ok(tabs)
    }

    pub async fn status(&self, conversation_id: &str) -> BrowserStatus {
        let info = {
            let mut sessions = self.sessions.lock();
            let info = if let Some(session) = sessions.get_mut(conversation_id) {
                if Self::is_running(session) {
                    Some((
                        session.port,
                        session.executable.clone(),
                        session.profile_dir.to_string_lossy().to_string(),
                        session.download_dir.to_string_lossy().to_string(),
                        session.active_tab.lock().clone(),
                    ))
                } else {
                    None
                }
            } else {
                None
            };
            if info.is_none() {
                sessions.remove(conversation_id);
            }
            info
        };
        let Some((port, executable, profile_dir, download_dir, active)) = info else {
            return BrowserStatus {
                running: false,
                port: None,
                executable: None,
                profile_dir: None,
                download_dir: None,
                tabs: Vec::new(),
                active_tab: None,
            };
        };
        let tabs = self.tabs_of(port, active.as_deref()).await.unwrap_or_default();
        let active_tab = active
            .filter(|id| tabs.iter().any(|tab| &tab.id == id))
            .or_else(|| tabs.first().map(|tab| tab.id.clone()));
        BrowserStatus {
            running: true,
            port: Some(port),
            executable: Some(executable),
            profile_dir: Some(profile_dir),
            download_dir: Some(download_dir),
            tabs,
            active_tab,
        }
    }

    async fn configure_download_dir(&self, port: u16, downloads: &std::path::Path) -> Result<(), String> {
        std::fs::create_dir_all(downloads)
            .map_err(|error| format!("BROWSER_DOWNLOAD_DIR: {error}"))?;
        let version = self.endpoint_json(port, "/json/version").await?;
        let ws = version.get("webSocketDebuggerUrl").and_then(Value::as_str)
            .ok_or_else(|| "BROWSER_CDP_INVALID: browser websocket ausente".to_string())?;
        cdp_call(ws, "Browser.setDownloadBehavior", json!({
            "behavior": "allow", "downloadPath": downloads.to_string_lossy()
        })).await.map(|_| ())
    }

    /// Starts the isolated browser if needed and returns its current status.
    pub async fn ensure(
        &self,
        conversation_id: &str,
        download_dir: Option<PathBuf>,
    ) -> Result<BrowserStatus, String> {
        let _guard = self.start_lock.lock().await;
        let downloads = download_dir
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| self.default_download_dir(conversation_id));
        if self.is_active(conversation_id) {
            let (port, previous) = {
                let sessions = self.sessions.lock();
                let session = sessions.get(conversation_id)
                    .ok_or_else(|| "BROWSER_NOT_RUNNING".to_string())?;
                (session.port, session.download_dir.clone())
            };
            if previous != downloads {
                self.configure_download_dir(port, &downloads).await?;
                let mut sessions = self.sessions.lock();
                let session = sessions.get_mut(conversation_id)
                    .filter(|session| session.port == port)
                    .ok_or_else(|| "BROWSER_NOT_RUNNING".to_string())?;
                session.download_dir = downloads;
            }
            return Ok(self.status(conversation_id).await);
        }
        #[cfg(test)]
        if let Some(port) = self.test_start_port {
            let child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .args(["--exact", "computer::browser::tests::cdp_stub_lifetime_child"])
                .env("ZYLARA_CDP_STUB_CHILD", "1")
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|e| e.to_string())?;
            self.sessions.lock().insert(conversation_id.to_owned(), BrowserSession {
                child, port, executable: "cdp-protocol-stub".into(), profile_dir: self.profile_dir(conversation_id),
                download_dir: downloads.clone(), active_tab: Mutex::new(None), refs: Mutex::new(HashMap::new()),
                held_input: Mutex::new(HashMap::new()),
            });
            if let Err(error) = self.configure_download_dir(port, &downloads).await {
                self.close(conversation_id);
                return Err(error);
            }
            return Ok(self.status(conversation_id).await);
        }
        let executable = find_browser_executable()
            .ok_or_else(|| crate::i18n::t("computer.browser.notFound").to_string())?;
        let profile = self.profile_dir(conversation_id);
        std::fs::create_dir_all(&profile)
            .map_err(|error| format!("BROWSER_PROFILE: {error}"))?;
        std::fs::create_dir_all(&downloads)
            .map_err(|error| format!("BROWSER_DOWNLOAD_DIR: {error}"))?;
        let port = free_port()?;
        let mut command = Command::new(&executable);
        command
            .args(launch_arguments(port, &profile))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            // Keep the child attached to this process but never open a console.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("BROWSER_SPAWN: {error}"))?;
        let pid = child.id();
        let session = BrowserSession {
            child,
            port,
            executable: executable.to_string_lossy().to_string(),
            profile_dir: profile,
            download_dir: downloads.clone(),
            active_tab: Mutex::new(None),
            refs: Mutex::new(HashMap::new()),
            held_input: Mutex::new(HashMap::new()),
        };
        self.sessions
            .lock()
            .insert(conversation_id.to_string(), session);

        // Wait for the DevTools endpoint. A broken browser must not linger.
        let started = Instant::now();
        loop {
            if let Ok(value) = self.endpoint_json(port, "/json/version").await {
                let _ = value;
                break;
            }
            if started.elapsed() > START_TIMEOUT {
                self.close(conversation_id);
                return Err(crate::i18n::t("computer.browser.startTimeout").to_string());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        if let Err(error) = self.configure_download_dir(port, &downloads).await {
            self.close(conversation_id);
            return Err(error);
        }
        let _ = pid;
        Ok(self.status(conversation_id).await)
    }

    pub fn close(&self, conversation_id: &str) -> bool {
        let Some(mut session) = self.sessions.lock().remove(conversation_id) else {
            return false;
        };
        let _ = session.child.kill();
        let _ = session.child.wait();
        true
    }

    pub fn close_all(&self) {
        let mut sessions = self.sessions.lock();
        for (_, mut session) in sessions.drain() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }

    async fn session_port(&self, conversation_id: &str) -> Result<(u16, String), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(conversation_id)
            .ok_or_else(|| "BROWSER_NOT_RUNNING: abra o navegador primeiro".to_string())?;
        if !Self::is_running(session) {
            sessions.remove(conversation_id);
            return Err("BROWSER_NOT_RUNNING: o navegador foi encerrado".to_string());
        }
        Ok((session.port, session.executable.clone()))
    }

    async fn tab_ws(&self, port: u16, tab_id: Option<&str>) -> Result<String, String> {
        let value = self.endpoint_json(port, "/json/list").await?;
        let items = value.as_array().cloned().unwrap_or_default();
        let target = match tab_id {
            Some(id) => items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id)),
            None => items
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("page")),
        }
        .ok_or_else(|| crate::i18n::t("computer.browser.tabNotFound").to_string())?;
        target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "BROWSER_CDP_INVALID: aba sem WebSocket de debug".to_string())
    }

    async fn active_tab_id(&self, conversation_id: &str, port: u16) -> Result<String, String> {
        let active = self
            .sessions
            .lock()
            .get(conversation_id)
            .and_then(|session| session.active_tab.lock().clone());
        if let Some(active) = active {
            return Ok(active);
        }
        let tabs = self.tabs_of(port, None).await?;
        tabs.first()
            .map(|tab| tab.id.clone())
            .ok_or_else(|| crate::i18n::t("computer.browser.tabNoneOpen").to_string())
    }

    pub async fn tabs(&self, conversation_id: &str) -> Result<Vec<BrowserTab>, String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let active = self
            .sessions
            .lock()
            .get(conversation_id)
            .and_then(|session| session.active_tab.lock().clone());
        self.tabs_of(port, active.as_deref()).await
    }

    pub async fn new_tab(
        &self,
        conversation_id: &str,
        url: Option<&str>,
    ) -> Result<BrowserTab, String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let target = normalize_navigation(url.unwrap_or("about:blank"))?;
        let encoded: String = url::form_urlencoded::byte_serialize(target.as_bytes()).collect();
        let request = self
            .http
            .put(format!("http://127.0.0.1:{port}/json/new?{encoded}"))
            .send()
            .await
            .map_err(|error| format!("BROWSER_TAB_FAILED: {error}"))?;
        let value: Value = request
            .json()
            .await
            .map_err(|error| format!("BROWSER_TAB_INVALID: {error}"))?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "BROWSER_TAB_INVALID: resposta sem id".to_string())?
            .to_string();
        if let Some(session) = self.sessions.lock().get(conversation_id) {
            *session.active_tab.lock() = Some(id.clone());
        }
        Ok(BrowserTab {
            id,
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Nova aba")
                .to_string(),
            url: value
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("about:blank")
                .to_string(),
            active: true,
        })
    }

    pub async fn close_tab(&self, conversation_id: &str, tab_id: &str) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let _ = self
            .http
            .get(format!("http://127.0.0.1:{port}/json/close/{tab_id}"))
            .send()
            .await
            .map_err(|error| format!("BROWSER_TAB_CLOSE: {error}"))?;
        if let Some(session) = self.sessions.lock().get(conversation_id) {
            let mut active = session.active_tab.lock();
            if active.as_deref() == Some(tab_id) {
                *active = None;
            }
            session.refs.lock().remove(tab_id);
        }
        Ok(())
    }

    pub async fn activate_tab(&self, conversation_id: &str, tab_id: &str) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let _ = self
            .http
            .get(format!("http://127.0.0.1:{port}/json/activate/{tab_id}"))
            .send()
            .await
            .map_err(|error| format!("BROWSER_TAB_ACTIVATE: {error}"))?;
        if let Some(session) = self.sessions.lock().get(conversation_id) {
            *session.active_tab.lock() = Some(tab_id.to_string());
        }
        Ok(())
    }

    pub async fn navigate(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        url: &str,
    ) -> Result<String, String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let target = normalize_navigation(url)?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        cdp_call(&ws, "Page.enable", json!({})).await?;
        cdp_call(&ws, "Page.navigate", json!({ "url": target })).await?;
        self.activate_tab(conversation_id, &tab).await?;
        self.wait_ready(&ws).await;
        Ok(target)
    }

    async fn wait_ready(&self, ws: &str) {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(8) {
            if let Ok(result) = cdp_call(
                ws,
                "Runtime.evaluate",
                json!({ "expression": "document.readyState", "returnByValue": true }),
            )
            .await
            {
                if result
                    .get("result")
                    .and_then(|value| value.get("value"))
                    .and_then(Value::as_str)
                    == Some("complete")
                {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub async fn history(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        action: &str,
    ) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        match action {
            "reload" => {
                cdp_call(&ws, "Page.reload", json!({ "ignoreCache": true })).await?;
            }
            "back" | "forward" => {
                cdp_call(&ws, "Page.enable", json!({})).await?;
                let history = cdp_call(&ws, "Page.getNavigationHistory", json!({})).await?;
                let index = history
                    .get("currentIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let entries = history
                    .get("entries")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let next = if action == "back" { index - 1 } else { index + 1 };
                if next < 0 || next as usize >= entries.len() {
                    return Ok(());
                }
                let entry_id = entries[next as usize]
                    .get("id")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "BROWSER_HISTORY_INVALID".to_string())?;
                cdp_call(
                    &ws,
                    "Page.navigateToHistoryEntry",
                    json!({ "entryId": entry_id }),
                )
                .await?;
            }
            other => return Err(crate::i18n::t_args("computer.browser.historyInvalid", &[("action", &other.to_string())])),
        }
        Ok(())
    }

    pub async fn frame(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
    ) -> Result<BrowserFrame, String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        cdp_call(&ws, "Page.enable", json!({})).await?;
        let shot = cdp_call(
            &ws,
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 70, "captureBeyondViewport": false }),
        )
        .await?;
        let data = shot
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "BROWSER_FRAME_EMPTY".to_string())?;
        use base64::Engine;
        let (width, height) = base64::engine::general_purpose::STANDARD.decode(data).ok()
            .and_then(|bytes| image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok())
            .and_then(|reader| reader.into_dimensions().ok())
            .unwrap_or((1280, 820));
        let meta = self.page_meta(&ws).await.unwrap_or_default();
        Ok(BrowserFrame {
            data_url: format!("data:image/jpeg;base64,{data}"),
            url: meta.0,
            title: meta.1,
            width,
            height,
            captured_at: crate::domain::now_ms(),
        })
    }

    async fn page_meta(&self, ws: &str) -> Result<(String, String), String> {
        let value = cdp_call(
            ws,
            "Runtime.evaluate",
            json!({
                "expression": "({url: location.href, title: document.title})",
                "returnByValue": true,
            }),
        )
        .await?;
        let result = value.get("result").and_then(|value| value.get("value"));
        Ok((
            result
                .and_then(|value| value.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("about:blank")
                .to_string(),
            result
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("Nova aba")
                .to_string(),
        ))
    }

    pub async fn snapshot(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
    ) -> Result<BrowserSnapshot, String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        cdp_call(&ws, "Accessibility.enable", json!({})).await?;
        let tree = cdp_call(&ws, "Accessibility.getFullAXTree", json!({})).await?;
        let nodes = tree
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut elements = Vec::new();
        for node in nodes {
            if elements.len() >= MAX_SNAPSHOT_ELEMENTS {
                break;
            }
            if node.get("ignored").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let role = node
                .get("role")
                .and_then(|value| value.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let name = node
                .get("name")
                .and_then(|value| value.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if name.trim().is_empty() && role.trim().is_empty() {
                continue;
            }
            let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) else {
                continue;
            };
            let interactive = matches!(
                role,
                "button"
                    | "link"
                    | "textbox"
                    | "searchbox"
                    | "checkbox"
                    | "radio"
                    | "combobox"
                    | "menuitem"
                    | "tab"
                    | "switch"
                    | "slider"
                    | "spinbutton"
            );
            if !interactive && name.trim().is_empty() {
                continue;
            }
            let value = node
                .get("value")
                .and_then(|value| value.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let disabled = node
                .get("properties")
                .and_then(Value::as_array)
                .is_some_and(|properties| {
                    properties.iter().any(|property| {
                        property.get("name").and_then(Value::as_str) == Some("disabled")
                            && property
                                .get("value")
                                .and_then(|value| value.get("value"))
                                .and_then(Value::as_bool)
                                == Some(true)
                    })
                });
            elements.push(BrowserElement {
                reference: format!("e{}", elements.len() + 1),
                role: role.to_string(),
                name: name.chars().take(300).collect(),
                value: value.chars().take(300).collect(),
                disabled,
                backend_node_id: backend,
            });
        }
        if let Some(session) = self.sessions.lock().get(conversation_id) {
            session.refs.lock().insert(tab.clone(), elements.clone());
        }
        let meta = self.page_meta(&ws).await.unwrap_or_default();
        let shot = cdp_call(
            &ws,
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 65, "captureBeyondViewport": false }),
        )
        .await
        .ok()
        .and_then(|value| value.get("data").and_then(Value::as_str).map(str::to_string));
        Ok(BrowserSnapshot {
            url: meta.0,
            title: meta.1,
            elements,
            screenshot: shot,
            width: 1280,
            height: 820,
            captured_at: crate::domain::now_ms(),
        })
    }

    fn lookup_ref(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
    ) -> Result<BrowserElement, String> {
        let sessions = self.sessions.lock();
        let session = sessions
            .get(conversation_id)
            .ok_or_else(|| "BROWSER_NOT_RUNNING".to_string())?;
        let refs = session.refs.lock();
        let tab = tab_id
            .map(str::to_string)
            .or_else(|| session.active_tab.lock().clone())
            .ok_or_else(|| "BROWSER_TAB_NOT_FOUND".to_string())?;
        refs.get(&tab)
            .and_then(|items| items.iter().find(|item| item.reference == reference))
            .cloned()
            .ok_or_else(|| {
                format!("BROWSER_REF_NOT_FOUND: `{reference}`; chame browser_snapshot primeiro")
            })
    }

    pub async fn click(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
    ) -> Result<BrowserElement, String> {
        let element = self.lookup_ref(conversation_id, tab_id, reference)?;
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        let center = element_center(&mut client, element.backend_node_id).await;
        if let Some((x, y)) = center {
            client
                .call(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mouseMoved",
                        "x": x,
                        "y": y,
                    }),
                )
                .await?;
            client
                .call(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mousePressed",
                        "x": x,
                        "y": y,
                        "button": "left",
                        "clickCount": 1,
                        "buttons": 1,
                    }),
                )
                .await?;
            client
                .call(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mouseReleased",
                        "x": x,
                        "y": y,
                        "button": "left",
                        "clickCount": 1,
                        "buttons": 0,
                    }),
                )
                .await?;
        } else {
            // Some AX nodes have no layout box (e.g. an element inside a
            // closed shadow root); the DOM click fallback is still useful and
            // is explicit in the result.
            let object = client
                .call(
                    "DOM.resolveNode",
                    json!({ "backendNodeId": element.backend_node_id }),
                )
                .await?;
            let object_id = object
                .get("object")
                .and_then(|value| value.get("objectId"))
                .and_then(Value::as_str)
                .ok_or_else(|| crate::i18n::t("computer.browser.refWithoutObject").to_string())?;
            client
                .call(
                    "Runtime.callFunctionOn",
                    json!({
                        "objectId": object_id,
                        "functionDeclaration": "function(){ this.click(); }",
                        "returnByValue": true,
                    }),
                )
                .await?;
        }
        Ok(element)
    }

    pub async fn type_text(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
        text: &str,
    ) -> Result<BrowserElement, String> {
        if text.chars().count() > 4_000 {
            return Err("BROWSER_INPUT_TOO_LARGE: o texto passa de 4.000 caracteres".to_string());
        }
        let element = self.lookup_ref(conversation_id, tab_id, reference)?;
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        let object = client
            .call(
                "DOM.resolveNode",
                json!({ "backendNodeId": element.backend_node_id }),
            )
            .await?;
        let object_id = object
            .get("object")
            .and_then(|value| value.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| crate::i18n::t("computer.browser.refWithoutObject").to_string())?;
        client
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "functionDeclaration": "function(){ this.focus(); }",
                    "returnByValue": true,
                }),
            )
            .await?;
        client
            .call(
                "Input.insertText",
                json!({ "text": text }),
            )
            .await?;
        // React/controlled inputs usually listen to input/change; the native
        // insertText already emits input, this keeps change listeners useful.
        client
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "functionDeclaration": "function(){ this.dispatchEvent(new Event('change', {bubbles:true})); }",
                    "returnByValue": true,
                }),
            )
            .await?;
        Ok(element)
    }

    pub async fn click_at(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        x: f64,
        y: f64,
    ) -> Result<(), String> {        if !(0.0..=10_000.0).contains(&x) || !(0.0..=10_000.0).contains(&y) {
            return Err(crate::i18n::t("computer.browser.pointOutOfPage").to_string());
        }
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        client
            .call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": x, "y": y }),
            )
            .await?;
        client
            .call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mousePressed",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1,
                    "buttons": 1,
                }),
            )
            .await?;
        client
            .call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseReleased",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1,
                    "buttons": 0,
                }),
            )
            .await?;
        Ok(())
    }

    /// Dispatches a validated human input event to the isolated browser.
    pub async fn human_input(&self, conversation_id: &str, tab_id: Option<&str>, kind: &str, params: Value) -> Result<(), String> {
        let (method, allowed) = match kind {
            "mouse" => ("Input.dispatchMouseEvent", &["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"][..]),
            "key" => ("Input.dispatchKeyEvent", &["keyDown", "keyUp", "rawKeyDown"][..]),
            _ => return Err(crate::i18n::t("computer.browser.inputTypeInvalid").into()),
        };
        let event_type = params.get("type").and_then(Value::as_str).unwrap_or("");
        if !allowed.contains(&event_type) { return Err(crate::i18n::t("computer.browser.eventInvalid").into()); }
        if kind == "mouse" {
            for key in ["x", "y"] {
                let value = params.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
                if !(0.0..=10000.0).contains(&value) { return Err("BROWSER_POINT_INVALID".into()); }
            }
        }
        if params.to_string().len() > 4096 { return Err("BROWSER_INPUT_TOO_LARGE".into()); }
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id { Some(id) => id.to_string(), None => self.active_tab_id(conversation_id, port).await? };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        {
            let sessions = self.sessions.lock();
            let session = sessions.get(conversation_id).ok_or("BROWSER_NOT_RUNNING")?;
            session.held_input.lock().entry(tab.clone()).or_default().before_dispatch(kind, &params)?;
        }
        tokio::time::timeout(CDP_TIMEOUT, cdp_call(&ws, method, params.clone())).await
            .map_err(|_| "BROWSER_CDP_TIMEOUT: entrada".to_string())??;
        {
            let sessions = self.sessions.lock();
            if let Some(session) = sessions.get(conversation_id) {
                let mut inputs = session.held_input.lock();
                if let Some(held) = inputs.get_mut(&tab) {
                    held.after_dispatch(kind, &params);
                    if held.is_empty() { inputs.remove(&tab); }
                }
            }
        }
        Ok(())
    }

    /// Caller must hold the conversation action gate until control is returned.
    pub async fn release_human_input(&self, conversation_id: &str) -> Result<(), String> {
        let (port, pending) = {
            let sessions = self.sessions.lock();
            let Some(session) = sessions.get(conversation_id) else { return Ok(()) };
            let held = session.held_input.lock().clone();
            (session.port, held)
        };
        for (tab, held) in pending {
            if held.is_empty() { continue; }
            let ws = self.tab_ws(port, Some(&tab)).await
                .map_err(|e| format!("BROWSER_INPUT_CLEANUP_FAILED: {e}"))?;
            tokio::time::timeout(Duration::from_secs(30), release_held_input(&held, |method, params| cdp_call(&ws, method, params)))
                .await.map_err(|_| "BROWSER_INPUT_CLEANUP_FAILED: tempo esgotado".to_string())??;
            let sessions = self.sessions.lock();
            if let Some(session) = sessions.get(conversation_id) {
                session.held_input.lock().remove(&tab);
            }
        }
        Ok(())
    }

    pub async fn scroll(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        delta: i32,
    ) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        client
            .call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": 640,
                    "y": 410,
                    "deltaX": 0,
                    "deltaY": delta,
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn hover(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
    ) -> Result<BrowserElement, String> {
        let element = self.lookup_ref(conversation_id, tab_id, reference)?;
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        if let Some((x, y)) = element_center(&mut client, element.backend_node_id).await {
            client
                .call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseMoved", "x": x, "y": y }),
                )
                .await?;
        }
        Ok(element)
    }

    pub async fn select(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
        value: &str,
    ) -> Result<BrowserElement, String> {
        let element = self.lookup_ref(conversation_id, tab_id, reference)?;
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        let object = client
            .call(
                "DOM.resolveNode",
                json!({ "backendNodeId": element.backend_node_id }),
            )
            .await?;
        let object_id = object
            .get("object")
            .and_then(|value| value.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| crate::i18n::t("computer.browser.refWithoutObject").to_string())?;
        client
            .call(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "functionDeclaration": "function(value){ this.value = value; this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); }",
                    "arguments": [{ "value": value }],
                    "returnByValue": true,
                }),
            )
            .await?;
        Ok(element)
    }

    pub async fn upload(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
        path: &str,
    ) -> Result<BrowserElement, String> {
        let element = self.lookup_ref(conversation_id, tab_id, reference)?;
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        client
            .call(
                "DOM.setFileInputFiles",
                json!({ "files": [path], "backendNodeId": element.backend_node_id }),
            )
            .await?;
        Ok(element)
    }

    pub async fn insert_text(        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        text: &str,
    ) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let mut client = CdpClient::connect(&ws).await?;
        client
            .call("Input.insertText", json!({ "text": text }))
            .await?;
        Ok(())
    }

    pub async fn press(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        key: &str,
    ) -> Result<(), String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let (code, vk) = match key {
            "Enter" | "Return" => ("Enter", 13),
            "Tab" => ("Tab", 9),
            "Escape" | "Esc" => ("Escape", 27),
            "Backspace" => ("Backspace", 8),
            "ArrowUp" => ("ArrowUp", 38),
            "ArrowDown" => ("ArrowDown", 40),
            "ArrowLeft" => ("ArrowLeft", 37),
            "ArrowRight" => ("ArrowRight", 39),
            "Space" => ("Space", 32),
            other => {
                return Err(crate::i18n::t_args(
                    "computer.browser.keyUnsupported",
                    &[("key", other)],
                ));
            }
        };
        cdp_call(
            &ws,
            "Input.dispatchKeyEvent",
            json!({
                "type": "keyDown",
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
            }),
        )
        .await?;
        cdp_call(
            &ws,
            "Input.dispatchKeyEvent",
            json!({
                "type": "keyUp",
                "key": key,
                "code": code,
                "windowsVirtualKeyCode": vk,
                "nativeVirtualKeyCode": vk,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn extract(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
    ) -> Result<Value, String> {
        let (port, _) = self.session_port(conversation_id).await?;
        let tab = match tab_id {
            Some(id) => id.to_string(),
            None => self.active_tab_id(conversation_id, port).await?,
        };
        let ws = self.tab_ws(port, Some(&tab)).await?;
        let value = cdp_call(
            &ws,
            "Runtime.evaluate",
            json!({
                "expression": "({url: location.href, title: document.title, text: document.body ? document.body.innerText : ''})",
                "returnByValue": true,
            }),
        )
        .await?;
        let mut result = value
            .get("result")
            .and_then(|value| value.get("value"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(text) = result.get("text").and_then(Value::as_str) {
            let truncated: String = text.chars().take(MAX_EXTRACT_CHARS).collect();
            result["text"] = json!(truncated);
        }
        Ok(result)
    }

    pub async fn wait_download(
        &self,
        conversation_id: &str,
        tab_id: Option<&str>,
        reference: &str,
    ) -> Result<Value, String> {
        let dir = self
            .sessions
            .lock()
            .get(conversation_id)
            .map(|session| session.download_dir.clone())
            .ok_or_else(|| "BROWSER_NOT_RUNNING".to_string())?;
        let before: std::collections::HashSet<PathBuf> = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        self.click(conversation_id, tab_id, reference).await?;
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(20) {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if before.contains(&path) || !path.is_file() {
                        continue;
                    }
                    let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                    if size > 0 {
                        return Ok(json!({
                            "path": path.to_string_lossy(),
                            "name": path.file_name().map(|name| name.to_string_lossy().to_string()),
                            "size": size,
                        }));
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err(crate::i18n::t("computer.browser.downloadTimeout").to_string())
    }

    pub async fn take_control(&self, conversation_id: &str, paused: bool) -> Result<(), String> {
        let pid = {
            let sessions = self.sessions.lock();
            sessions
                .get(conversation_id)
                .map(|session| session.pid())
                .ok_or_else(|| "BROWSER_NOT_RUNNING".to_string())?
        };
        if paused {
            focus_process(pid).await;
        }
        Ok(())
    }
}

pub fn validate_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(crate::i18n::t("computer.browser.urlEmpty"));
    }
    if trimmed == "about:blank" {
        return Ok(trimmed.to_string());
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|error| format!("BROWSER_URL_INVALID: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(crate::i18n::t("computer.browser.urlScheme").to_string());
    }
    if parsed.host_str().is_none() {
        return Err(crate::i18n::t("computer.browser.urlNoHost"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(crate::i18n::t("computer.browser.urlCredentials").to_string());
    }
    Ok(parsed.to_string())
}

/// Address-bar input: full http(s) URLs pass through; bare domains get https,
/// and plain text becomes a DuckDuckGo search.
pub fn normalize_navigation(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(crate::i18n::t("computer.browser.urlEmpty"));
    }
    if trimmed.eq_ignore_ascii_case("about:blank") {
        return Ok("about:blank".to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return validate_url(trimmed);
    }
    // Explicit scheme-like input is never treated as a search term; it goes
    // through the allowlist and gets rejected (file/chrome/javascript/...).
    if let Some((scheme, _)) = trimmed.split_once(':') {
        if !scheme.is_empty()
            && scheme
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '-' || ch == '.')
        {
            return validate_url(trimmed);
        }
    }
    let looks_like_host = trimmed.contains('.') && !trimmed.contains(char::is_whitespace);
    if looks_like_host {
        return validate_url(&format!("https://{trimmed}"));
    }
    let query: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
    Ok(format!("https://duckduckgo.com/?q={query}"))
}

async fn element_center(client: &mut CdpClient, backend_node_id: i64) -> Option<(f64, f64)> {
    let _ = client
        .call(
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await;
    let model = client
        .call(
            "DOM.getBoxModel",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await
        .ok()?;
    let content = model
        .get("model")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)?;
    let numbers: Vec<f64> = content.iter().filter_map(Value::as_f64).collect();
    if numbers.len() < 8 {
        return None;
    }
    let xs = [numbers[0], numbers[2], numbers[4], numbers[6]];
    let ys = [numbers[1], numbers[3], numbers[5], numbers[7]];
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Some(((min_x + max_x) / 2.0, (min_y + max_y) / 2.0))
}

/// Applies the deployment browser policy after URL normalization. Deny wins;
/// an empty allowlist means "public hosts only" subject to the private-host
/// switch. Cloud metadata is always refused.
pub fn validate_with_policy(
    settings: &crate::domain::Settings,
    raw: &str,
) -> Result<String, String> {
    let target = normalize_navigation(raw)?;
    if target == "about:blank" {
        return Ok(target);
    }
    let parsed = url::Url::parse(&target)
        .map_err(|error| format!("BROWSER_URL_INVALID: {error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| crate::i18n::t("computer.browser.urlNoHost"))?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "169.254.169.254" || host == "metadata.google.internal" {
        return Err(crate::i18n::t("computer.browser.urlMetadata"));
    }
    if is_private_host(&host) && !settings.browser_allow_private_hosts {
        return Err(crate::i18n::t_args(
            "computer.browser.urlPrivateHost",
            &[("host", &host)],
        ));
    }
    if settings
        .browser_blocked_domains
        .iter()
        .any(|rule| domain_matches(&host, rule))
    {
        return Err(crate::i18n::t_args("computer.browser.urlDenylist", &[("host", &host)]));
    }
    if !settings.browser_allowed_domains.is_empty()
        && !settings
            .browser_allowed_domains
            .iter()
            .any(|rule| domain_matches(&host, rule))
    {
        return Err(crate::i18n::t_args(
            "computer.browser.urlAllowlist",
            &[("host", &host)],
        ));
    }
    Ok(target)
}

fn domain_matches(host: &str, rule: &str) -> bool {
    let rule = rule.trim().trim_start_matches('.').to_ascii_lowercase();
    !rule.is_empty() && (host == rule || host.ends_with(&format!(".{rule}")))
}

fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
            }
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local()
            }
        };
    }
    false
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("BROWSER_PORT: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("BROWSER_PORT: {error}"))
}

fn find_browser_executable() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("ZYLARA_BROWSER_PATH") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(key) {
                let base = PathBuf::from(base);
                candidates.push(base.join("Google/Chrome/Application/chrome.exe"));
                candidates.push(base.join("Microsoft/Edge/Application/msedge.exe"));
                candidates.push(base.join("Chromium/Application/chrome.exe"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
        candidates.push(PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"));
        candidates.push(PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"));
    }
    #[cfg(not(windows))]
    {
        for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"] {
            if let Some(path) = crate::workspace::exec::find_executable(name) {
                candidates.push(path);
            }
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct CdpClient {
    socket: WsStream,
    next_id: u64,
}

impl CdpClient {
    async fn connect(ws_url: &str) -> Result<Self, String> {
        let (socket, _) = tokio::time::timeout(CDP_TIMEOUT, connect_async(ws_url))
            .await
            .map_err(|_| crate::i18n::t("computer.browser.cdpTimeout").to_string())?
            .map_err(|error| format!("BROWSER_CDP_CONNECT: {error}"))?;
        Ok(Self {
            socket,
            next_id: 1,
        })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::Text(request.to_string().into()))
            .await
            .map_err(|error| format!("BROWSER_CDP_SEND: {error}"))?;
        let started = Instant::now();
        loop {
            if started.elapsed() > CDP_TIMEOUT {
                return Err(format!("BROWSER_CDP_TIMEOUT: {method}"));
            }
            let next = tokio::time::timeout(CDP_TIMEOUT, self.socket.next())
                .await
                .map_err(|_| format!("BROWSER_CDP_TIMEOUT: {method}"))?;
            match next {
                Some(Ok(Message::Text(text))) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if value.get("id").and_then(Value::as_i64) != Some(id as i64) {
                        continue;
                    }
                    if let Some(error) = value.get("error") {
                        return Err(format!("BROWSER_CDP_ERROR: {error}"));
                    }
                    return Ok(value.get("result").cloned().unwrap_or_else(|| json!({})));
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err(format!("BROWSER_CDP_CLOSED: {method}"));
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(format!("BROWSER_CDP_READ: {error}")),
            }
        }
    }
}

async fn cdp_call(ws_url: &str, method: &str, params: Value) -> Result<Value, String> {
    let mut client = CdpClient::connect(ws_url).await?;
    client.call(method, params).await
}

async fn release_held_input<F, Fut>(held: &HeldInput, mut dispatch: F) -> Result<(), String>
where
    F: FnMut(&'static str, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    for params in held.keys.values() {
        dispatch("Input.dispatchKeyEvent", params.clone()).await
            .map_err(|error| format!("BROWSER_INPUT_CLEANUP_FAILED: {error}"))?;
    }
    for params in held.buttons.values() {
        dispatch("Input.dispatchMouseEvent", params.clone()).await
            .map_err(|error| format!("BROWSER_INPUT_CLEANUP_FAILED: {error}"))?;
    }
    Ok(())
}

async fn focus_process(pid: u32) {
    #[cfg(windows)]
    {
        let script = format!(
            "$ws = New-Object -ComObject WScript.Shell; [void]$ws.AppActivate({pid})"
        );
        let mut command = tokio::process::Command::new("powershell");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        let _ = command.status().await;
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controlled_browser_launches_headless_without_an_external_window() {
        let arguments = launch_arguments(9222, Path::new("C:/profile"));
        assert_eq!(arguments.first().map(String::as_str), Some("--headless=new"));
        assert!(arguments.iter().any(|argument| argument == "--remote-debugging-port=9222"));
        assert!(arguments.iter().any(|argument| argument.starts_with("--user-data-dir=")));
        assert!(arguments.iter().any(|argument| argument == "--window-size=1280,820"));
        assert_eq!(arguments.last().map(String::as_str), Some("about:blank"));
        assert!(!arguments.iter().any(|argument| argument == "--app"));
    }

    #[tokio::test]
    async fn conversation_download_directory_is_shared_across_opening_orders_and_rebinding() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let temp = tempfile::tempdir().expect("temporary directory");
        let db = Arc::new(crate::db::Db::open_in_memory().expect("database"));
        let input = crate::agents::normalize_input(crate::agents::AgentInput {
            name: "Agent".into(), role: "Assistant".into(), description: String::new(), avatar: crate::agents::AgentAvatar::emoji(""),
            department: "General".into(), provider_id: "provider".into(), model_id: "model".into(),
            fallback_provider_id: None, fallback_model_id: None, reasoning: None, instructions: String::new(),
            starters: Vec::new(), capabilities: crate::agents::AgentCapabilities { browser_use: true, ..Default::default() }, memory_enabled: false, workspace_id: None,
            permission_mode: crate::domain::PermissionMode::Edit, docker_image: None, computer_environment: "auto".into(),
            template: None,
        }).expect("input");
        let agent = db.create_agent(&input).expect("agent");
        let recorded = Arc::new(Mutex::new(Vec::<String>::new()));
        let fail_next = Arc::new(AtomicBool::new(false));
        let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("CDP listener");
        let ws_address = ws_listener.local_addr().expect("CDP address");
        let ws_recorded = recorded.clone();
        let ws_fail = fail_next.clone();
        let ws_server = tokio::spawn(async move {
            while let Ok((socket, _)) = ws_listener.accept().await {
                let recorded = ws_recorded.clone();
                let fail = ws_fail.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(socket).await else { return };
                    let Some(Ok(Message::Text(text))) = ws.next().await else { return };
                    let request: Value = serde_json::from_str(&text).expect("request");
                    let method = request["method"].as_str().unwrap_or("");
                    if method == "Browser.setDownloadBehavior" {
                        recorded.lock().push(request["params"]["downloadPath"].as_str().expect("download path").to_string());
                    }
                    let response = if method == "Browser.setDownloadBehavior" && fail.swap(false, Ordering::SeqCst) {
                        json!({"id":request["id"],"error":{"message":"rejected"}})
                    } else if method == "Runtime.evaluate" {
                        json!({"id":request["id"],"result":{"result":{"value":"complete"}}})
                    } else { json!({"id":request["id"],"result":{}}) };
                    let _ = ws.send(Message::Text(response.to_string().into())).await;
                });
            }
        });
        let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("HTTP listener");
        let port = http_listener.local_addr().expect("HTTP address").port();
        let http_server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = http_listener.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let Ok(count) = socket.read(&mut request).await else { return };
                    let request = String::from_utf8_lossy(&request[..count]);
                    let body = if request.contains("/json/version") {
                        json!({"webSocketDebuggerUrl":format!("ws://{ws_address}")}).to_string()
                    } else if request.contains("/json/list") {
                        json!([{"id":"tab-1","type":"page","url":"about:blank", "webSocketDebuggerUrl":format!("ws://{ws_address}")}]).to_string()
                    } else { "{}".to_string() };
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        let mut manager = BrowserManager::new(temp.path().to_path_buf());
        manager.test_start_port = Some(port);
        let settings = crate::domain::Settings { computer_allow_unattended_browser: true, ..Default::default() };
        for order in ["panel-first", "agent-first"] {
            let conversation = db.create_agent_conversation(&agent.id, order).expect("conversation");
            let internal = conversation_download_dir(&db, temp.path(), &conversation.id).expect("resolve").expect("directory");
            let ctx = crate::tools::registry::ToolCtx {
                db: db.clone(), http: reqwest::Client::new(), conversation_id: conversation.id.clone(),
                message_id: "message".into(), tool_call_id: "call".into(), turn_id: "turn".into(),
                workspace: None, settings: settings.clone(), cancel: tokio_util::sync::CancellationToken::new(), agent_hooks: None,
                data_dir: temp.path().to_path_buf(), approval: None, observed: None, journal_owner: None, emit: None, rules: Vec::new(),
                jobs: None, questions: None, turn_kind: crate::domain::TurnKind::User, mcp: None, subagent: None,
                enabled_tools: Arc::new(Default::default()), subagent_budget: Arc::new(std::sync::atomic::AtomicU32::new(0)),
                subagent_slots: Arc::new(tokio::sync::Semaphore::new(1)), skills_roots: Vec::new(), allowed_skills: None,
            };
            for entry in if order == "panel-first" { ["panel", "agent"] } else { ["agent", "panel"] } {
                if entry == "panel" {
                    crate::commands::browser::open_browser_session(&db, &settings, temp.path(), &manager, &conversation.id, None, || {}).await.expect("panel open");
                } else {
                    let outcome = crate::tools::code::computer::run_with_browser_manager(&ctx, "browser_open", &json!({"url":"https://example.com"}), Some(&manager)).await;
                    assert!(!outcome.is_error, "{}", outcome.content);
                }
                let status = manager.status(&conversation.id).await;
                assert_eq!(status.download_dir.as_deref(), Some(internal.to_string_lossy().as_ref()), "{order}: {entry}");
            }
            let folder = temp.path().join(order);
            std::fs::create_dir(&folder).expect("folder");
            let workspace = db.create_workspace(order, &folder.to_string_lossy()).expect("workspace");
            db.set_workspace_trusted(&workspace.id, true).expect("trust");
            if order == "panel-first" {
                let control = crate::computer::control::gate(&conversation.id);
                let action = control.action.lock().await;
                let bind = crate::commands::workspace::bind_conversation_workspace(&db, &conversation.id, Some(&workspace.id), Some(&manager));
                tokio::pin!(bind);
                assert!(tokio::time::timeout(Duration::from_millis(50), &mut bind).await.is_err());
                assert!(db.get_conversation(&conversation.id).expect("lookup").expect("conversation").workspace_id.is_none());
                drop(action);
                bind.await.expect("bind after input completes");
            } else {
                crate::commands::workspace::bind_conversation_workspace(&db, &conversation.id, Some(&workspace.id), Some(&manager)).await.expect("bind");
            }
            let status = manager.status(&conversation.id).await;
            assert_eq!(status.download_dir.as_deref(), Some(folder.join("downloads").to_string_lossy().as_ref()));
            let configured = recorded.lock().last().cloned().expect("configured download path");
            assert_eq!(PathBuf::from(&configured), folder.join("downloads"));
            // Simulate an independent human download using the destination the
            // protocol server accepted, without opening a panel or agent tool.
            std::fs::write(PathBuf::from(&configured).join("manual.txt"), b"download").expect("manual download");
            assert!(folder.join("downloads/manual.txt").is_file());
            assert!(!internal.join("manual.txt").exists());
            crate::commands::workspace::bind_conversation_workspace(&db, &conversation.id, None, Some(&manager)).await.expect("reset");
            let status = manager.status(&conversation.id).await;
            assert_eq!(status.download_dir.as_deref(), Some(internal.to_string_lossy().as_ref()));
            if order == "panel-first" {
                fail_next.store(true, Ordering::SeqCst);
                assert!(crate::commands::workspace::bind_conversation_workspace(&db, &conversation.id, Some(&workspace.id), Some(&manager)).await.is_err());
                assert!(!manager.is_active(&conversation.id), "ambiguous reconfiguration closes the browser");
                assert!(db.get_conversation(&conversation.id).expect("lookup").expect("conversation").workspace_id.is_none());
            }
            manager.close(&conversation.id);
        }
        assert_eq!(recorded.lock().len(), 7, "one initial configuration per session, plus changes and one rejected change");
        ws_server.abort();
        http_server.abort();
    }

    // The integration fixture needs a harmless live child owned by BrowserManager.
    #[test]
    fn cdp_stub_lifetime_child() {
        if std::env::var_os("ZYLARA_CDP_STUB_CHILD").is_some() {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    #[tokio::test]
    async fn cdp_handoff_handles_lost_replies_and_serializes_agent_actions() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::sync::Notify;

        #[derive(Default)]
        struct ProtocolState {
            key: AtomicBool,
            button: AtomicBool,
            fail_down: AtomicBool,
            fail_up: AtomicBool,
            pause_up: AtomicBool,
            release_started: Notify,
            resume_release: Notify,
        }
        let protocol = Arc::new(ProtocolState::default());
        protocol.fail_down.store(true, Ordering::SeqCst);
        protocol.fail_up.store(true, Ordering::SeqCst);
        protocol.pause_up.store(true, Ordering::SeqCst);

        let ws_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("CDP listener");
        let ws_address = ws_listener.local_addr().expect("CDP address");
        let ws_state = protocol.clone();
        let ws_server = tokio::spawn(async move {
            while let Ok((socket, _)) = ws_listener.accept().await {
                let state = ws_state.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(socket).await else { return };
                    let Some(Ok(Message::Text(text))) = ws.next().await else { return };
                    let Ok(request) = serde_json::from_str::<Value>(&text) else { return };
                    let event = request["params"]["type"].as_str().unwrap_or("");
                    let method = request["method"].as_str().unwrap_or("");
                    let valid = match event {
                        "keyDown" | "keyUp" => method == "Input.dispatchKeyEvent",
                        "mousePressed" | "mouseReleased" => method == "Input.dispatchMouseEvent",
                        _ => false,
                    } && !(event == "keyUp" && request["params"].get("text").is_some());
                    if !valid {
                        let _ = ws.send(Message::Text(json!({ "id": request["id"], "error": { "message": "invalid input event" } }).to_string().into())).await;
                        return;
                    }
                    match event {
                        "keyDown" => {
                            state.key.store(true, Ordering::SeqCst);
                            if state.fail_down.swap(false, Ordering::SeqCst) { return; }
                        }
                        "keyUp" => {
                            if state.fail_up.swap(false, Ordering::SeqCst) {
                                state.key.store(false, Ordering::SeqCst);
                                return;
                            }
                            if state.pause_up.swap(false, Ordering::SeqCst) {
                                state.release_started.notify_one();
                                state.resume_release.notified().await;
                            }
                            state.key.store(false, Ordering::SeqCst);
                        }
                        "mousePressed" => state.button.store(true, Ordering::SeqCst),
                        "mouseReleased" => state.button.store(false, Ordering::SeqCst),
                        _ => {},
                    }
                    let _ = ws.send(Message::Text(json!({ "id": request["id"], "result": {} }).to_string().into())).await;
                });
            }
        });
        let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("HTTP listener");
        let http_port = http_listener.local_addr().expect("HTTP address").port();
        let http_server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = http_listener.accept().await {
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    if socket.read(&mut request).await.is_err() { return; }
                    let body = json!([{ "id": "tab-1", "type": "page", "webSocketDebuggerUrl": format!("ws://{ws_address}/devtools/page/tab-1") }]).to_string();
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });

        let temp = tempfile::tempdir().expect("temporary directory");
        let db = Arc::new(crate::db::Db::open(&temp.path().join("cdp.db")).expect("database"));
        let conversation = db.create_conversation("CDP integration", "test", "test").expect("conversation").id;
        let manager = Arc::new(BrowserManager::new(temp.path().to_path_buf()));
        let child = Command::new(std::env::current_exe().expect("test binary"))
            .args(["--exact", "computer::browser::tests::cdp_stub_lifetime_child"])
            .env("ZYLARA_CDP_STUB_CHILD", "1")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().expect("stub process");
        manager.sessions.lock().insert(conversation.clone(), BrowserSession {
            child, port: http_port, executable: "cdp-protocol-stub".into(),
            profile_dir: temp.path().to_path_buf(), download_dir: temp.path().to_path_buf(),
            active_tab: Mutex::new(Some("tab-1".into())), refs: Mutex::new(HashMap::new()),
            held_input: Mutex::new(HashMap::new()),
        });
        struct Cleanup { manager: Arc<BrowserManager>, conversation: String, ws: tokio::task::JoinHandle<()>, http: tokio::task::JoinHandle<()> }
        impl Drop for Cleanup {
            fn drop(&mut self) { self.manager.close(&self.conversation); self.ws.abort(); self.http.abort(); }
        }
        let _cleanup = Cleanup { manager: manager.clone(), conversation: conversation.clone(), ws: ws_server, http: http_server };
        db.set_computer_control(&conversation, Some(true), Some(true), 1).expect("takeover");
        db.set_computer_control_target(&conversation, "browser").expect("target");
        let gate = crate::computer::control::gate(&conversation);
        let generation = gate.start_browser_generation();

        {
            let _action = gate.action.lock().await;
            let result = manager.human_input(&conversation, Some("tab-1"), "key", json!({
                "type":"keyDown", "key":"a", "code":"KeyA", "text":"a", "windowsVirtualKeyCode":65
            })).await;
            assert!(result.is_err(), "lost CDP reply must be reported");
            manager.human_input(&conversation, Some("tab-1"), "mouse", json!({
                "type":"mousePressed", "x":100, "y":120, "button":"left", "buttons":1, "clickCount":1
            })).await.expect("mouse press");
        }
        assert!(protocol.key.load(Ordering::SeqCst) && protocol.button.load(Ordering::SeqCst));
        println!("CDP stub: key and button pressed; keyDown response deliberately lost");

        let failure = crate::commands::computer::release_computer_control_with_browser(
            &db, &conversation, "browser", Some(&generation), Some(manager.as_ref()),
        ).await.expect_err("lost keyUp acknowledgement must fail closed");
        assert!(failure.contains("BROWSER_INPUT_CLEANUP_FAILED"));
        assert_eq!(db.computer_control(&conversation).expect("state"), (true, true));
        assert!(gate.require_browser_generation(&generation).is_ok());
        assert!(protocol.button.load(Ordering::SeqCst));
        println!("CDP stub: lost keyUp response keeps human control and pending cleanup");

        let release_db = db.clone();
        let release_manager = manager.clone();
        let release_conversation = conversation.clone();
        let release_generation = generation.clone();
        let release = tokio::spawn(async move {
            crate::commands::computer::release_computer_control_with_browser(
                &release_db, &release_conversation, "browser", Some(&release_generation), Some(release_manager.as_ref()),
            ).await
        });
        tokio::time::timeout(Duration::from_secs(5), protocol.release_started.notified()).await.expect("cleanup started");
        assert!(!release.is_finished());
        assert!(gate.action.try_lock().is_err());
        let ctx = crate::tools::registry::ToolCtx {
            db: db.clone(), http: reqwest::Client::new(), conversation_id: conversation.clone(),
            message_id: "cdp-message".into(), tool_call_id: "cdp-call".into(), turn_id: "cdp-turn".into(),
            workspace: None, settings: crate::domain::Settings { execution_environment: "docker".into(), ..Default::default() },
            cancel: tokio_util::sync::CancellationToken::new(), agent_hooks: None, data_dir: temp.path().to_path_buf(),
            approval: None, observed: None, journal_owner: None, emit: None, rules: Vec::new(), jobs: None, questions: None,
            turn_kind: crate::domain::TurnKind::User, mcp: None, subagent: None,
            enabled_tools: Arc::new(Default::default()), subagent_budget: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            subagent_slots: Arc::new(tokio::sync::Semaphore::new(1)), skills_roots: Vec::new(), allowed_skills: None,
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let agent = tokio::spawn(async move {
            let _ = started.send(());
            crate::tools::code::computer::run(&ctx, "computer_windows", &json!({})).await
        });
        ready.await.expect("agent started");
        tokio::task::yield_now().await;
        assert!(!agent.is_finished(), "agent cannot pass the handoff while cleanup is blocked");
        assert_eq!(db.computer_control(&conversation).expect("state"), (true, true));
        protocol.resume_release.notify_one();
        tokio::time::timeout(Duration::from_secs(10), release).await.expect("release timeout").expect("release task").expect("cleanup");
        let outcome = tokio::time::timeout(Duration::from_secs(5), agent).await.expect("agent timeout").expect("agent task");
        assert!(outcome.is_error && outcome.content.contains("COMPUTER_OBSERVATION_REQUIRED"));
        assert!(!protocol.key.load(Ordering::SeqCst) && !protocol.button.load(Ordering::SeqCst));
        assert_eq!(db.computer_control(&conversation).expect("state"), (false, false));
        assert!(db.computer_needs_observation(&conversation).expect("observation"));
        assert!(gate.require_browser_generation(&generation).is_err());
        println!("CDP stub: key and button released before agent proceeds; fresh observation required");

        let _action = gate.action.lock().await;
        db.set_computer_control(&conversation, Some(true), Some(true), 2).expect("retake");
        db.set_computer_control_target(&conversation, "browser").expect("target");
        let next = gate.start_browser_generation();
        assert_ne!(generation, next);
        assert!(gate.require_browser_generation(&generation).is_err());
        assert!(gate.require_browser_generation(&next).is_ok());
        println!("CDP stub: stale generation rejected after retake");
    }

    #[tokio::test]
    async fn cleanup_releases_held_keys_and_multiple_buttons_without_text() {
        let mut held = HeldInput::default();
        held.before_dispatch("key", &json!({"type":"keyDown","code":"KeyA","key":"a","text":"a","modifiers":2})).expect("key");
        held.before_dispatch("mouse", &json!({"type":"mousePressed","button":"left","x":10,"y":20})).expect("left");
        held.before_dispatch("mouse", &json!({"type":"mousePressed","button":"right","x":10,"y":20})).expect("right");
        held.before_dispatch("mouse", &json!({"type":"mouseMoved","x":40,"y":50})).expect("move");
        let events = std::sync::Mutex::new(Vec::new());
        release_held_input(&held, |method, params| {
            events.lock().expect("events").push((method, params));
            async { Ok(json!({})) }
        }).await.expect("cleanup");
        let events = events.lock().expect("events");
        assert_eq!(events.len(), 3);
        let key = events.iter().find(|event| event.0 == "Input.dispatchKeyEvent").expect("key");
        assert_eq!(key.1["type"], "keyUp");
        assert_eq!(key.1["modifiers"], 0);
        assert!(key.1.get("text").is_none());
        for (_, event) in events.iter().filter(|event| event.0 == "Input.dispatchMouseEvent") {
            assert_eq!(event["type"], "mouseReleased");
            assert_eq!(event["x"], 40);
            assert_eq!(event["y"], 50);
        }
    }

    #[tokio::test]
    async fn disconnected_cdp_during_keydown_keeps_input_for_cleanup() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let mut socket = tokio_tungstenite::accept_async(socket).await.expect("upgrade");
            let request = socket.next().await.expect("request").expect("message");
            assert!(request.into_text().expect("text").contains("keyDown"));
            drop(socket);
        });
        let mut held = HeldInput::default();
        let press = json!({"type":"keyDown","code":"ShiftLeft","key":"Shift"});
        held.before_dispatch("key", &press).expect("track before send");
        assert!(cdp_call(&format!("ws://{address}"), "Input.dispatchKeyEvent", press).await.is_err());
        server.await.expect("server");
        assert_eq!(held.keys.len(), 1);
        assert!(release_held_input(&held, |_, _| async { Err("disconnected".to_string()) }).await.is_err());
        assert_eq!(held.keys.len(), 1, "failure must preserve the pending release");
        release_held_input(&held, |_, params| async move {
            assert_eq!(params["type"], "keyUp");
            Ok(json!({}))
        }).await.expect("retry");
    }

    #[tokio::test]
    async fn browser_handoff_waits_for_inflight_input_and_cleans_before_unlocking() {
        let gate = std::sync::Arc::new(crate::computer::control::ControlGate::default());
        let input = gate.action.lock().await;
        let held = std::sync::Arc::new(Mutex::new(HeldInput::default()));
        let other_gate = gate.clone();
        let other_held = held.clone();
        let handoff = tokio::spawn(async move {
            let _action = other_gate.action.lock().await;
            let snapshot = other_held.lock().clone();
            release_held_input(&snapshot, |_, params| async move {
                assert_eq!(params["type"], "keyUp");
                Ok(json!({}))
            }).await
        });
        tokio::task::yield_now().await;
        assert!(!handoff.is_finished());
        held.lock().before_dispatch("key", &json!({"type":"keyDown","code":"KeyA","key":"a"})).expect("press");
        drop(input);
        handoff.await.expect("task").expect("cleaned");
    }

    #[test]
    fn only_http_and_https_urls_are_allowed() {
        assert_eq!(validate_url("https://example.com/a").expect("https"), "https://example.com/a");
        assert_eq!(validate_url("about:blank").expect("blank"), "about:blank");
        for forbidden in [
            "file:///etc/passwd",
            "chrome://settings",
            "devtools://devtools/bundled/inspector.html",
            "javascript:alert(1)",
            "https://user:pass@example.com",
        ] {
            assert!(validate_url(forbidden).is_err(), "{forbidden} deveria falhar");
        }
    }

    #[test]
    fn address_bar_accepts_bare_hosts_and_searches_text() {
        assert_eq!(
            normalize_navigation("example.com").expect("host"),
            "https://example.com/"
        );
        assert!(normalize_navigation("zylara agentes")
            .expect("search")
            .starts_with("https://duckduckgo.com/?q=zylara+agentes"));
        assert!(normalize_navigation("file:///etc/passwd").is_err());
    }

    #[test]
    fn browser_policy_denies_before_allows_and_blocks_metadata() {
        let mut settings = crate::domain::Settings::default();
        settings.browser_blocked_domains = vec!["evil.test".to_string()];
        settings.browser_allowed_domains = vec!["example.com".to_string()];
        assert!(validate_with_policy(&settings, "https://example.com/a").is_ok());
        assert!(validate_with_policy(&settings, "https://sub.example.com/a").is_ok());
        assert!(validate_with_policy(&settings, "https://other.test/a").is_err());
        assert!(validate_with_policy(&settings, "https://evil.test/a").is_err());
        assert!(validate_with_policy(&settings, "http://169.254.169.254/latest").is_err());
        settings.browser_allow_private_hosts = false;
        assert!(validate_with_policy(&settings, "http://127.0.0.1:3000").is_err());
    }

    #[test]
    fn profile_ids_are_sanitized() {
        assert_eq!(BrowserManager::safe_id("conv/../x y"), "conv----x-y");
    }

    #[tokio::test]
    #[ignore = "starts the real local Chromium/Edge engine"]
    async fn local_cdp_browser_navigates_snapshots_and_types() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = socket.read(&mut buffer).await;
                    let body = "<!doctype html><html><head><title>Zylara CDP</title></head><body><h1>Olá</h1><button id=\"go\">Enviar</button><input aria-label=\"Nome\" /></body></html>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });

        let dir = std::env::temp_dir().join(format!(
            "zylara-browser-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temp");
        let manager = BrowserManager::new(dir.clone());
        let status = manager
            .ensure("conv-test", None)
            .await
            .expect("browser starts");
        assert!(status.running);
        manager
            .navigate("conv-test", None, &format!("http://127.0.0.1:{port}/"))
            .await
            .expect("navigate");
        let snapshot = manager
            .snapshot("conv-test", None)
            .await
            .expect("snapshot");
        assert!(snapshot.title.contains("Zylara") || snapshot.url.contains(&port.to_string()));
        assert!(!snapshot.elements.is_empty());
        let button = snapshot
            .elements
            .iter()
            .find(|element| element.role == "button")
            .expect("button ref");
        manager
            .click("conv-test", None, &button.reference)
            .await
            .expect("click");
        let input = snapshot
            .elements
            .iter()
            .find(|element| element.role == "textbox")
            .expect("textbox ref");
        manager
            .type_text("conv-test", None, &input.reference, "Zylara")
            .await
            .expect("type");
        let frame = manager.frame("conv-test", None).await.expect("frame");
        assert!(frame.data_url.starts_with("data:image/jpeg;base64,"));
        manager.close("conv-test");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
