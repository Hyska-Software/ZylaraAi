//! Local and Docker computer-use backends.
//!
//! The model-facing tools live in `tools::code::computer`; this module only
//! implements the operating-system/Docker side. Screenshots are saved under
//! `<app-data>/computer/<conversation>/` and the agent receives dimensions and
//! a path; input actions are approved by the policy layer before reaching here.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::domain::Settings;
use crate::workspace::exec::{self, ExecRequest};

pub mod browser;
pub mod control;
pub mod stream;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSession {
    pub id: String,
    pub agent_id: Option<String>,
    pub conversation_id: String,
    pub backend: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActionRecord {
    pub id: String,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub conversation_id: String,
    pub turn_id: String,
    pub tool: String,
    pub action: String,
    pub target: serde_json::Value,
    pub approval_scope: Option<String>,
    pub decision: Option<String>,
    pub result: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub redacted_text_len: Option<i64>,
    pub policy_rule: Option<String>,
    pub initiator: Option<String>,
    pub created_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshot {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub display: String,
    pub captured_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindow {
    pub id: String,
    pub title: String,
    pub app: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerBackend {
    Local,
    Docker,
}

pub fn backend(settings: &Settings) -> ComputerBackend {
    match settings.computer_environment.trim() {
        "this_computer" => ComputerBackend::Local,
        "private_desktop" => ComputerBackend::Docker,
        // `browser`/`off` have no desktop backend; tools are not injected in
        // those modes. Keep Local as a safe default for direct callers.
        "browser" | "off" => ComputerBackend::Local,
        _ => {
            if settings.execution_environment == "docker" {
                ComputerBackend::Docker
            } else {
                ComputerBackend::Local
            }
        }
    }
}

/// Desktop computer use is available in `auto`, `this_computer` and
/// `private_desktop`; the browser/off modes deliberately disable it.
pub fn desktop_enabled(settings: &Settings) -> bool {
    !matches!(
        settings.computer_environment.trim(),
        "browser" | "off"
    )
}

/// Per-conversation graphical container. The configured base name is kept as a
/// prefix so users can still find it, but two threads never share a desktop.
pub fn container_for(settings: &Settings, conversation_id: &str) -> String {
    let base = settings.computer_docker_container.trim();
    let base = if base.is_empty() { "zylara-computer" } else { base };
    let safe: String = conversation_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect();
    format!("{base}-{safe}")
}

pub fn prune_old_screenshots(root: &Path, cutoff_ms: i64) -> u64 {
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            removed += prune_old_screenshots(&path, cutoff_ms);
            if std::fs::read_dir(&path)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
            {
                let _ = std::fs::remove_dir(&path);
            }
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if modified < cutoff_ms && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn free_host_port() -> anyhow::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| anyhow::anyhow!("COMPUTER_PORT: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| anyhow::anyhow!("COMPUTER_PORT: {error}"))
}

fn screenshot_dir(data_dir: &Path, conversation_id: &str) -> PathBuf {
    let safe: String = conversation_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' })
        .collect();
    data_dir.join("computer").join(safe)
}

async fn sh(
    data_dir: &Path,
    program: &str,
    args: Vec<String>,
    timeout: Duration,
) -> anyhow::Result<exec::ExecOutput> {
    exec::run(
        ExecRequest {
            program: program.to_string(),
            args,
            cwd: data_dir.to_path_buf(),
            env: exec::sanitized_env(&[]),
            timeout,
            cancel: CancellationToken::new(),
            max_output_bytes: 2 * 1024 * 1024,
        },
        None,
    )
    .await
    .map_err(|error| anyhow::anyhow!("{error}"))
}

fn powershell(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        script.to_string(),
    ]
}

fn ps_quote(value: &str) -> String {
    value.replace('\'', "''")
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Screenshot the primary virtual screen (Windows) or the Docker X display.
pub async fn screenshot(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<ComputerScreenshot> {
    let dir = screenshot_dir(data_dir, conversation_id);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("shot-{}.png", uuid::Uuid::new_v4()));
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = format!(
                    "Add-Type -AssemblyName System.Windows.Forms; \
                     Add-Type -AssemblyName System.Drawing; \
                     $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; \
                     $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); \
                     $g=[System.Drawing.Graphics]::FromImage($bmp); \
                     $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); \
                     $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png); \
                     $g.Dispose(); $bmp.Dispose();",
                    ps_quote(&path.to_string_lossy())
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(20),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!(
                        "COMPUTER_SCREENSHOT_FAILED: {}",
                        output.stderr.trim()
                    );
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!(
                    "COMPUTER_UNSUPPORTED: captura local implementada no Windows; use Docker"
                );
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let docker_path = format!("/tmp/zylara-shot-{}.png", uuid::Uuid::new_v4());
            let shot = sh(
                data_dir,
                "docker",
                vec![
                    "exec".into(),
                    container_for(settings, conversation_id),
                    "sh".into(),
                    "-lc".into(),
                    format!("DISPLAY=:99 scrot -o {}", sh_quote(&docker_path)),
                ],
                Duration::from_secs(20),
            )
            .await?;
            if shot.exit_code != Some(0) {
                anyhow::bail!(
                    "COMPUTER_SCREENSHOT_FAILED: {}",
                    shot.stderr.trim()
                );
            }
            let copy = sh(
                data_dir,
                "docker",
                vec![
                    "cp".into(),
                    format!(
                        "{}:{}",
                        container_for(settings, conversation_id),
                        docker_path
                    ),
                    path.to_string_lossy().to_string(),
                ],
                Duration::from_secs(20),
            )
            .await?;
            let _ = docker_exec(settings, data_dir, conversation_id, &format!("rm -f {}", sh_quote(&docker_path))).await;
            if copy.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_SCREENSHOT_FAILED: {}", copy.stderr.trim());
            }
        }
    }
    let (width, height) = image::image_dimensions(&path)
        .map_err(|error| anyhow::anyhow!("COMPUTER_SCREENSHOT_INVALID: {error}"))?;
    Ok(ComputerScreenshot {
        path: path.to_string_lossy().to_string(),
        width,
        height,
        display: if backend(settings) == ComputerBackend::Docker {
            ":99".to_string()
        } else {
            "primary".to_string()
        },
        captured_at: crate::domain::now_ms(),
    })
}

/// Windows titles that must never receive automated input (best effort). This
/// is intentionally conservative; the user still sees every approval.
pub fn is_sensitive_title(title: &str) -> bool {
    let title = title.to_lowercase();
    [
        "1password",
        "bitwarden",
        "keepass",
        "lastpass",
        "dashlane",
        "password",
        "senha",
        "credential",
        "windows security",
        "segurança do windows",
        "user account control",
        "paypal",
        "bank",
        "banco",
        "itau",
        "bradesco",
        "nubank",
    ]
    .iter()
    .any(|needle| title.contains(needle))
}

pub async fn active_window_title(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<String> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = "Add-Type @'\nusing System; using System.Runtime.InteropServices; using System.Text;\npublic class ZylaraFg { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }\n'@; \
                              $s=New-Object System.Text.StringBuilder 512; [void][ZylaraFg]::GetWindowText([ZylaraFg]::GetForegroundWindow(),$s,512); $s.ToString()";
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(script),
                    Duration::from_secs(10),
                )
                .await?;
                Ok(output.stdout.trim().to_string())
            }
            #[cfg(not(windows))]
            {
                Ok(String::new())
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                "DISPLAY=:99 xdotool getactivewindow getwindowname",
            )
            .await?;
            Ok(output.stdout.trim().to_string())
        }
    }
}

/// Application/process of the foreground window. Used for app allow/deny
/// policy before any input action.
pub async fn active_window_app(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<String> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = "Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class ZylaraApp { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }\n'@; \
                              $h=[ZylaraApp]::GetForegroundWindow(); $pid=0; [void][ZylaraApp]::GetWindowThreadProcessId($h,[ref]$pid); (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName";
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(script),
                    Duration::from_secs(10),
                )
                .await?;
                Ok(output.stdout.trim().to_string())
            }
            #[cfg(not(windows))]
            {
                let _ = (data_dir, conversation_id);
                Ok(String::new())
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                "id=$(DISPLAY=:99 xdotool getactivewindow); DISPLAY=:99 xprop -id $id WM_CLASS 2>/dev/null | sed 's/.*= //'",
            )
            .await?;
            Ok(output.stdout.trim().replace('"', ""))
        }
    }
}

/// Opens an http(s) URL in the local default browser or in Chromium inside the
/// Docker desktop. The browser is then driven by the computer tools; this is
/// deliberately not an embedded WebView (remote content never shares the app
/// origin).
pub async fn open_url(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    raw_url: &str,
) -> anyhow::Result<()> {
    let parsed = url::Url::parse(raw_url.trim())
        .map_err(|error| anyhow::anyhow!("COMPUTER_URL_INVALID: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!(crate::i18n::t("computer.errors.urlScheme"));
    }
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let output = sh(
                    data_dir,
                    "cmd",
                    vec![
                        "/C".to_string(),
                        "start".to_string(),
                        String::new(),
                        parsed.to_string(),
                    ],
                    Duration::from_secs(15),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_BROWSER_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
                let output = sh(
                    data_dir,
                    opener,
                    vec![parsed.to_string()],
                    Duration::from_secs(15),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_BROWSER_FAILED: {}", output.stderr.trim());
                }
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                &format!(
                    "DISPLAY=:99 chromium --no-sandbox --no-first-run --user-data-dir=/tmp/chrome {} >/tmp/chrome.log 2>&1 &",
                    sh_quote(parsed.as_str())
                ),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_BROWSER_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn click(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    x: i32,
    y: i32,
    button: &str,
    clicks: u8,
) -> anyhow::Result<()> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let down = if button == "right" { 0x0008 } else { 0x0002 };
                let up = if button == "right" { 0x0010 } else { 0x0004 };
                let repeat = clicks.clamp(1, 3);
                let script = format!(
                    "Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class ZylaraMouse {{ [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e); }}\n'@; \
                     [ZylaraMouse]::SetCursorPos({x},{y}); \
                     1..{repeat} | ForEach-Object {{ [ZylaraMouse]::mouse_event({down},0,0,0,[IntPtr]::Zero); [ZylaraMouse]::mouse_event({up},0,0,0,[IntPtr]::Zero) }}"
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_CLICK_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let button = match button {
                "right" => "3",
                "middle" => "2",
                _ => "1",
            };
            let output = docker_exec(                settings,                data_dir,                conversation_id,
                &format!(
                    "DISPLAY=:99 xdotool mousemove {x} {y} click --repeat {} {button}",
                    clicks.clamp(1, 3)
                ),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_CLICK_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn type_text(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    text: &str,
) -> anyhow::Result<()> {
    if text.chars().count() > 4_000 {
        anyhow::bail!("COMPUTER_INPUT_TOO_LARGE: o texto passa de 4.000 caracteres");
    }
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let escaped = sendkeys_escape(text);
                let script = format!(
                    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{}')",
                    ps_quote(&escaped)
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(30),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_TYPE_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(                settings,                data_dir,                conversation_id,
                &format!(
                    "DISPLAY=:99 xdotool type --clearmodifiers --delay 20 -- {}",
                    sh_quote(text)
                ),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_TYPE_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn key(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    combo: &str,
) -> anyhow::Result<()> {
    let combo = combo.trim();
    if combo.is_empty() || combo.chars().count() > 80 {
        anyhow::bail!(crate::i18n::t("computer.errors.keyCombo"));
    }
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let keys = sendkeys_combo(combo);
                let script = format!(
                    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{}')",
                    ps_quote(&keys)
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_KEY_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(                settings,                data_dir,                conversation_id,
                &format!("DISPLAY=:99 xdotool key --clearmodifiers {}", sh_quote(combo)),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_KEY_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn windows(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<Vec<ComputerWindow>> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = "Get-Process | Where-Object { $_.MainWindowTitle } | \
                              Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(script),
                    Duration::from_secs(15),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_WINDOWS_FAILED: {}", output.stderr.trim());
                }
                let value: serde_json::Value =
                    serde_json::from_str(output.stdout.trim()).unwrap_or(serde_json::Value::Null);
                let items = value
                    .as_array()
                    .cloned()
                    .or_else(|| value.is_object().then(|| vec![value]))
                    .unwrap_or_default();
                Ok(items
                    .into_iter()
                    .filter_map(|item| {
                        Some(ComputerWindow {
                            id: item.get("Id")?.to_string(),
                            title: item.get("MainWindowTitle")?.as_str()?.to_string(),
                            app: item.get("ProcessName")?.as_str()?.to_string(),
                        })
                    })
                    .collect())
            }
            #[cfg(not(windows))]
            {
                Ok(Vec::new())
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(settings, data_dir, conversation_id, "DISPLAY=:99 wmctrl -l").await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_WINDOWS_FAILED: {}", output.stderr.trim());
            }
            Ok(output
                .stdout
                .lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(4, char::is_whitespace);
                    let id = parts.next()?.to_string();
                    let _desktop = parts.next()?;
                    let app = parts.next()?.to_string();
                    let title = parts.next()?.trim().to_string();
                    (!title.is_empty()).then_some(ComputerWindow { id, title, app })
                })
                .collect())
        }
    }
}

/// Read-only accessibility tree. This is the text fallback for models without
/// vision: name/type/bounds/id of actionable elements on the Windows desktop.
pub async fn ui_tree(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<serde_json::Value> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = "Add-Type -AssemblyName UIAutomationClient; \
                              Add-Type -AssemblyName UIAutomationTypes; \
                              $root=[System.Windows.Automation.AutomationElement]::RootElement; \
                              $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition); \
                              $list=@(); foreach ($e in $all) { try { $r=$e.Current.BoundingRectangle; if ($r.Width -gt 0 -and $r.Height -gt 0) { $list += [pscustomobject]@{ name=$e.Current.Name; type=$e.Current.ControlType.ProgrammaticName; x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height; id=$e.Current.AutomationId } } } catch {} if ($list.Count -ge 250) { break } }; \
                              $list | ConvertTo-Json -Compress";
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(script),
                    Duration::from_secs(30),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_TREE_FAILED: {}", output.stderr.trim());
                }
                let value: serde_json::Value =
                    serde_json::from_str(output.stdout.trim()).unwrap_or(serde_json::Value::Null);
                Ok(value)
            }
            #[cfg(not(windows))]
            {
                Ok(serde_json::Value::Array(Vec::new()))
            }
        }
        ComputerBackend::Docker => Ok(serde_json::to_value(
            windows(settings, data_dir, conversation_id).await?,
        )?),
    }
}

pub async fn drag(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    button: &str,
) -> anyhow::Result<()> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let (down, up) = if button == "right" {
                    (0x0008, 0x0010)
                } else {
                    (0x0002, 0x0004)
                };
                let script = format!(
                    "Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class ZylaraDrag {{ [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e); }}\n'@; \
                     [ZylaraDrag]::SetCursorPos({from_x},{from_y}); [ZylaraDrag]::mouse_event({down},0,0,0,[IntPtr]::Zero); \
                     [ZylaraDrag]::SetCursorPos({to_x},{to_y}); [ZylaraDrag]::mouse_event({up},0,0,0,[IntPtr]::Zero)"
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_DRAG_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let button = if button == "right" { "3" } else { "1" };
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                &format!(
                    "DISPLAY=:99 xdotool mousemove {from_x} {from_y} mousedown {button} mousemove {to_x} {to_y} mouseup {button}"
                ),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_DRAG_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn scroll(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    x: i32,
    y: i32,
    delta: i32,
) -> anyhow::Result<()> {
    let delta = delta.clamp(-2_400, 2_400);
    if delta == 0 {
        return Ok(());
    }
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = format!(
                    "Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class ZylaraScroll {{ [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,IntPtr e); }}\n'@; \
                     [ZylaraScroll]::SetCursorPos({x},{y}); [ZylaraScroll]::mouse_event(0x0800,0,0,{delta},[IntPtr]::Zero)"
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_SCROLL_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let button = if delta > 0 { "4" } else { "5" };
            let clicks = (delta.unsigned_abs() / 120).max(1).min(20);
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                &format!(
                    "DISPLAY=:99 xdotool mousemove {x} {y} click --repeat {clicks} {button}"
                ),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_SCROLL_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn move_pointer(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    x: i32,
    y: i32,
) -> anyhow::Result<()> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = format!(
                    "Add-Type @'\nusing System; using System.Runtime.InteropServices;\npublic class ZylaraMove {{ [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X,int Y); }}\n'@; [ZylaraMove]::SetCursorPos({x},{y})"
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_MOVE_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                &format!("DISPLAY=:99 xdotool mousemove {x} {y}"),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_MOVE_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

pub async fn clipboard_read(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<String> {
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell("Get-Clipboard -Raw"),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_CLIPBOARD_FAILED: {}", output.stderr.trim());
                }
                Ok(output.stdout)
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: clipboard local implementado no Windows");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(settings, data_dir, conversation_id, "xclip -selection clipboard -o")
                .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!(
                    "COMPUTER_CLIPBOARD_FAILED: {}",
                    output.stderr.trim()
                );
            }
            Ok(output.stdout)
        }
    }
}

pub async fn clipboard_write(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    text: &str,
) -> anyhow::Result<()> {
    if text.chars().count() > 20_000 {
        anyhow::bail!("COMPUTER_CLIPBOARD_TOO_LARGE: o texto passa de 20.000 caracteres");
    }
    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let script = format!("Set-Clipboard -Value '{}'", ps_quote(text));
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_CLIPBOARD_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: clipboard local implementado no Windows");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(
                settings,
                data_dir,
                conversation_id,
                &format!("printf '%s' {} | xclip -selection clipboard", sh_quote(text)),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!(
                    "COMPUTER_CLIPBOARD_FAILED: {}",
                    output.stderr.trim()
                );
            }
        }
    }
    Ok(())
}

pub async fn focus(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    window_id: &str,
) -> anyhow::Result<()> {    match backend(settings) {
        ComputerBackend::Local => {
            #[cfg(windows)]
            {
                let pid = window_id
                    .parse::<u32>()
                    .map_err(|_| anyhow::anyhow!(crate::i18n::t(
                        "computer.errors.windowId"
                    )))?;
                let script = format!(
                    "(New-Object -ComObject WScript.Shell).AppActivate({pid}) | Out-Null"
                );
                let output = sh(
                    data_dir,
                    "powershell",
                    powershell(&script),
                    Duration::from_secs(10),
                )
                .await?;
                if output.exit_code != Some(0) {
                    anyhow::bail!("COMPUTER_FOCUS_FAILED: {}", output.stderr.trim());
                }
            }
            #[cfg(not(windows))]
            {
                anyhow::bail!("COMPUTER_UNSUPPORTED: use Docker neste sistema");
            }
        }
        ComputerBackend::Docker => {
            ensure_container(settings, data_dir, conversation_id).await?;
            let output = docker_exec(                settings,                data_dir,                conversation_id,
                &format!("DISPLAY=:99 wmctrl -ia {}", sh_quote(window_id)),
            )
            .await?;
            if output.exit_code != Some(0) {
                anyhow::bail!("COMPUTER_FOCUS_FAILED: {}", output.stderr.trim());
            }
        }
    }
    Ok(())
}

async fn docker_exec(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
    command: &str,
) -> anyhow::Result<exec::ExecOutput> {
    sh(
        data_dir,
        "docker",
        vec![
            "exec".into(),
            container_for(settings, conversation_id),
            "sh".into(),
            "-lc".into(),
            command.to_string(),
        ],
        Duration::from_secs(30),
    )
    .await
}

pub async fn remove_container(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<()> {
    let output = sh(
        data_dir,
        "docker",
        vec![
            "rm".into(),
            "-f".into(),
            container_for(settings, conversation_id),
        ],
        Duration::from_secs(30),
    )
    .await?;
    if output.exit_code != Some(0) && !output.stderr.contains("No such container") {
        anyhow::bail!("COMPUTER_CONTAINER_REMOVE_FAILED: {}", output.stderr.trim());
    }
    Ok(())
}

pub async fn verify_stream_support(settings: &Settings, data_dir: &Path, conversation_id: &str) -> anyhow::Result<()> {
    let result = docker_exec(settings, data_dir, conversation_id, "command -v socat >/dev/null && test -x /usr/local/bin/zylara-clear-input && test -f /tmp/x11vnc-view.log && test -f /tmp/x11vnc-control.log").await?;
    if result.exit_code != Some(0) {
        anyhow::bail!(crate::i18n::t("computer.errors.imageOutdated"));
    }
    Ok(())
}

/// Resolves the loopback noVNC URL of a conversation's container.
pub async fn vnc_url(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<String> {
    let output = sh(
        data_dir,
        "docker",
        vec![
            "port".into(),
            container_for(settings, conversation_id),
            "6080/tcp".into(),
        ],
        Duration::from_secs(10),
    )
    .await?;
    if output.exit_code != Some(0) {
        anyhow::bail!(crate::i18n::t_args(
            "computer.errors.noVncUnpublished",
            &[("error", output.stderr.trim())],
        ));
    }
    let port = output
        .stdout
        .lines()
        .next()
        .and_then(|line| line.rsplit(':').next())
        .and_then(|value| value.trim().parse::<u16>().ok())
        .ok_or_else(|| anyhow::anyhow!(crate::i18n::t("computer.errors.noVncPort")))?;
    Ok(format!("http://127.0.0.1:{port}/vnc.html"))
}

pub async fn ensure_container(
    settings: &Settings,
    data_dir: &Path,
    conversation_id: &str,
) -> anyhow::Result<()> {
    let gate = control::gate(conversation_id);
    let _startup = gate.startup.lock().await;
    let name = container_for(settings, conversation_id);
    let inspect = sh(
        data_dir,
        "docker",
        vec![
            "inspect".into(),
            "-f".into(),
            "{{.State.Running}}".into(),
            name.clone(),
        ],
        Duration::from_secs(10),
    )
    .await?;
    if inspect.exit_code == Some(0) && inspect.stdout.trim() == "true" {
        return Ok(());
    }
    if inspect.exit_code == Some(0) {
        let start = sh(
            data_dir,
            "docker",
            vec!["start".into(), name.clone()],
            Duration::from_secs(30),
        )
        .await?;
        if start.exit_code == Some(0) {
            return Ok(());
        }
    }
    // A stopped engine looks like a container problem here: bring Docker
    // Desktop up (bounded) so the start below has a chance instead of failing
    // with the raw named-pipe error.
    if crate::workspace::docker::error_is_daemon_down(&inspect.stderr) {
        crate::workspace::docker::ensure(data_dir, Duration::from_secs(120))
            .await
            .map_err(|_| anyhow::anyhow!(crate::i18n::t("computer.errors.dockerDaemon")))?;
    }
    let mut args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        name.clone(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "--label".to_string(),
        "zylara.owner=zylara".to_string(),
        "--pids-limit".to_string(),
        "256".to_string(),
        "--memory".to_string(),
        "2g".to_string(),
        "--cpus".to_string(),
        "2".to_string(),
        "--network".to_string(),
        if settings.docker_network {
            "bridge".to_string()
        } else {
            "none".to_string()
        },
    ];
    args.push(settings.computer_docker_image.clone());
    let run = sh(data_dir, "docker", args, Duration::from_secs(120)).await?;
    if run.exit_code != Some(0) {
        anyhow::bail!(crate::i18n::t_args(
            "computer.errors.dockerStart",
            &[
                ("image", &settings.computer_docker_image),
                ("error", run.stderr.trim()),
            ],
        ));
    }
    // Give Xvfb/the desktop a brief moment to come up.
    tokio::time::sleep(Duration::from_millis(700)).await;
    Ok(())
}

#[cfg(windows)]
fn sendkeys_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '+' | '^' | '%' | '~' | '(' | ')' | '{' | '}' | '[' | ']' => {
                out.push('{');
                out.push(ch);
                out.push('}');
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(windows)]
fn sendkeys_combo(combo: &str) -> String {
    let mut prefix = String::new();
    let mut key = String::new();
    for part in combo.split('+') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if part.eq_ignore_ascii_case("ctrl") || part.eq_ignore_ascii_case("control") {
            prefix.push('^');
        } else if part.eq_ignore_ascii_case("alt") {
            prefix.push('%');
        } else if part.eq_ignore_ascii_case("shift") {
            prefix.push('+');
        } else {
            key = part.to_string();
        }
    }
    let key = match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => "{ENTER}".to_string(),
        "tab" => "{TAB}".to_string(),
        "esc" | "escape" => "{ESC}".to_string(),
        "space" => " ".to_string(),
        "backspace" => "{BACKSPACE}".to_string(),
        "delete" => "{DELETE}".to_string(),
        "up" => "{UP}".to_string(),
        "down" => "{DOWN}".to_string(),
        "left" => "{LEFT}".to_string(),
        "right" => "{RIGHT}".to_string(),
        "home" => "{HOME}".to_string(),
        "end" => "{END}".to_string(),
        other if other.len() == 1 => other.to_uppercase(),
        other => format!("{{{}}}", other.to_uppercase()),
    };
    format!("{prefix}{key}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_retention_removes_old_files_and_empty_dirs() {
        let root = std::env::temp_dir().join(format!(
            "zylara-screenshot-prune-{}",
            uuid::Uuid::new_v4()
        ));
        let nested = root.join("conv-1");
        std::fs::create_dir_all(&nested).expect("dir");
        let file = nested.join("old.png");
        std::fs::write(&file, b"x").expect("file");
        let removed = prune_old_screenshots(&root, crate::domain::now_ms() + 60_000);
        assert_eq!(removed, 1);
        assert!(!file.exists());
        assert!(!nested.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn graphical_container_is_isolated_per_conversation() {
        let settings = Settings::default();
        let first = container_for(&settings, "conv-1");
        let second = container_for(&settings, "conv-2");
        assert_ne!(first, second);
        assert!(first.starts_with(&settings.computer_docker_container));
        assert!(first.ends_with("conv-1"));
    }

    #[test]
    fn backend_follows_execution_environment() {
        let mut settings = Settings::default();
        assert_eq!(backend(&settings), ComputerBackend::Local);
        settings.execution_environment = "docker".into();
        assert_eq!(backend(&settings), ComputerBackend::Docker);
    }

    #[test]
    fn per_agent_environment_overrides_the_global_execution_environment() {
        let mut settings = Settings::default();
        settings.execution_environment = "docker".into();
        settings.computer_environment = "this_computer".into();
        assert_eq!(backend(&settings), ComputerBackend::Local);
        settings.computer_environment = "private_desktop".into();
        assert_eq!(backend(&settings), ComputerBackend::Docker);
        settings.computer_environment = "auto".into();
        assert_eq!(backend(&settings), ComputerBackend::Docker);
        settings.computer_environment = "browser".into();
        assert!(!desktop_enabled(&settings));
        settings.computer_environment = "off".into();
        assert!(!desktop_enabled(&settings));
        settings.computer_environment = "this_computer".into();
        assert!(desktop_enabled(&settings));
    }

    #[test]
    fn sensitive_titles_are_blocked() {
        assert!(is_sensitive_title("1Password — Vault"));
        assert!(is_sensitive_title("Banco do Brasil"));
        assert!(is_sensitive_title("Windows Security"));
        assert!(!is_sensitive_title("Visual Studio Code — src/main.rs"));
        assert!(!is_sensitive_title("Notepad"));
    }

    #[cfg(windows)]
    #[test]
    fn sendkeys_escapes_special_characters() {
        assert_eq!(sendkeys_escape("a+b"), "a{+}b");
        assert_eq!(sendkeys_combo("CTRL+SHIFT+S"), "^+S");
        assert_eq!(sendkeys_combo("ENTER"), "{ENTER}");
    }

    #[tokio::test]
    #[ignore = "requires Docker and the zylara/computer:test image"]
    async fn docker_graphical_backend_screenshot_and_click() {
        let temp = tempfile::tempdir().expect("tempdir");
        let container = format!("zylara-computer-it-{}", uuid::Uuid::new_v4().simple());
        let settings = Settings {
            execution_environment: "docker".to_string(),
            computer_docker_image: "zylara/computer:test".to_string(),
            computer_docker_container: container.clone(),
            ..Settings::default()
        };
        ensure_container(&settings, temp.path(), "it")
            .await
            .expect("start graphical container");
        let shot = screenshot(&settings, temp.path(), "it")
            .await
            .expect("screenshot");
        assert!(shot.width >= 1024 && shot.height >= 700);
        click(&settings, temp.path(), "it", 20, 20, "left", 1)
            .await
            .expect("click");
        let windows = windows(&settings, temp.path(), "it").await.expect("windows");
        let _ = windows;
        let _ = sh(
            temp.path(),
            "docker",
            vec![
                "rm".into(),
                "-f".into(),
                crate::computer::container_for(&settings, "it"),
            ],
            Duration::from_secs(30),
        )
        .await;
    }
}
