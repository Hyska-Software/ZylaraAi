//! Terminal PTY do harness de código (F7 do `docs/goals/code-harness/PLAN.md`).
//!
//! Terminal iniciado **pelo usuário** no painel/centro do layout Code
//! (`WORKBENCH.md` §7.3). Backend com `portable-pty` (ConPTY no Windows):
//! entrada/saída em streaming por `tauri::ipc::Channel<TerminalEvent>`, resize,
//! kill de processo e cwd no workspace da conversa que o abriu. Contrato:
//! `HARNESS.md` §8.3.
//!
//! Segurança: o terminal herda o ambiente do app (é um shell do usuário), mas
//! remove variáveis com cara de segredo; o agente **não** recebe essas tools —
//! quem digita é o usuário.
//!
//! Ciclo de vida: o registry é process-wide e a UI mantém uma lista **global**
//! de terminais — trocar de sessão/workspace ou fechar a aba da sessão não
//! encerra o PTY. A sessão continua no registry após o processo terminar (para
//! a UI mostrar o exit code e permitir fechar/reiniciar) e só deixa de contar
//! no limite enquanto estiver rodando. Fechar a aba do terminal remove a
//! sessão, apagar a conversa encerra as sessões dela e fechar o app encerra
//! todas as árvores de processo.

mod env;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{
    native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize,
};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::db::Db;
use crate::domain::Settings;
use crate::events::TerminalEvent;

/// Limite de terminais **rodando** (global, somando todas as sessões). Abas já
/// encerradas não contam (a UI mantém o histórico até o usuário fechar a aba).
const MAX_TERMINALS: usize = 4;

struct TerminalSession {
    conversation_id: String,
    title: String,
    cwd: String,
    cols: u16,
    rows: u16,
    pid: Option<u32>,
    /// Container created for this terminal when Docker execution is enabled.
    container: Option<String>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    running: Arc<AtomicBool>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl TerminalSession {
    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn cleanup_container(&self) {
        let Some(name) = self.container.as_deref() else {
            return;
        };
        let mut command = std::process::Command::new("docker");
        command
            .args(["rm", "-f", name])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.status();
    }

    fn terminate(&mut self) {
        if !self.is_running() {
            return;
        }
        kill_process_tree(self.pid, self.killer.as_mut());
        self.cleanup_container();
    }
}

/// Registro process-wide de terminais abertos.
#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, TerminalSession>>,
    /// Serializa a checagem do limite + spawn + inserção (evita ultrapassar o
    /// máximo com dois `open_terminal` concorrentes).
    open_lock: Mutex<()>,
}

/// DTO devolvido ao renderer ao abrir/listar terminais.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub conversation_id: String,
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub running: bool,
    pub exit_code: Option<i32>,
}

fn terminal_command(cwd: &std::path::Path, settings: &Settings) -> (CommandBuilder, Option<String>) {
    let docker_image = (settings
        .execution_environment
        .trim()
        .eq_ignore_ascii_case("docker")
        && !settings.docker_image.trim().is_empty())
    .then(|| settings.docker_image.trim().to_string());
    let mut container = None;
    let shell = env::shell_program();
    let mut builder = if let Some(image) = docker_image.as_deref() {
        let name = format!("zylara-term-{}", uuid::Uuid::new_v4());
        let mut builder = CommandBuilder::new("docker");
        builder.arg("run");
        builder.arg("--rm");
        builder.arg("-it");
        builder.arg("--name");
        builder.arg(&name);
        builder.arg("--network");
        builder.arg("none");
        builder.arg("--cap-drop");
        builder.arg("ALL");
        builder.arg("--security-opt");
        builder.arg("no-new-privileges");
        builder.arg("--label");
        builder.arg("zylara.owner=zylara");
        builder.arg("--pids-limit");
        builder.arg(settings.docker_pids_limit.max(32).to_string());
        builder.arg("--memory");
        builder.arg(format!("{}m", settings.docker_memory_mb.max(256)));
        builder.arg("--cpus");
        builder.arg(format!("{:.1}", settings.docker_cpus.max(0.25)));
        if settings.docker_read_only_root {
            builder.arg("--read-only");
            builder.arg("--tmpfs");
            builder.arg("/tmp:rw,exec,nosuid,size=512m");
        }
        builder.arg("-e");
        builder.arg("TERM=xterm-256color");
        builder.arg("-v");
        builder.arg(format!("{}:/workspace", cwd.to_string_lossy()));
        builder.arg("-w");
        builder.arg("/workspace");
        builder.arg(image);
        builder.arg("sh");
        builder.arg("-lc");
        builder.arg("if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi");
        container = Some(name);
        builder
    } else {
        CommandBuilder::new(&shell)
    };
    builder.cwd(cwd);
    #[cfg(target_os = "macos")]
    if container.is_none() {
        for arg in env::login_args(&shell) {
            builder.arg(*arg);
        }
    }

    // A PTY is a user terminal: it must not inherit the runtime environment of
    // whatever launched the app (conda/mamba, Nix dev shells, AppImage/`LD_*`
    // overrides). Otherwise the shell can load a mismatched library and die
    // before the first prompt (e.g. `undefined symbol:
    // rl_trim_arg_from_keyseq`). On Windows the loader does not use these
    // variables, so the existing secret scrubbing is kept as-is.
    #[cfg(unix)]
    {
        builder.env_clear();
        let appdir = crate::process_env::appdir();
        for (key, value) in env::sanitized_env(std::env::vars_os(), appdir.as_deref()) {
            builder.env(key, value);
        }
        // portable-pty fills SHELL from the passwd database; keep it in sync
        // with the shell actually spawned (including the fallback path).
        builder.env("SHELL", shell.as_os_str());
    }
    #[cfg(windows)]
    {
        for (key, _) in std::env::vars_os() {
            if env::is_secret_or_internal(&key)
                || crate::process_env::is_launcher_context_var(&key)
            {
                builder.env_remove(&key);
            }
        }
    }

    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("ZYLARA_AGENT", "1");
    (builder, container)
}

fn terminal_cwd(db: &Db, conversation_id: &str) -> Result<PathBuf, String> {
    let conversation = db
        .get_conversation(conversation_id)
        .map_err(|error| format!("TERMINAL_CONVERSATION: {error}"))?
        .ok_or_else(|| {
            crate::i18n::t_args(
                "terminal.errors.conversationNotFound",
                &[("conversation_id", conversation_id)],
            )
        })?;
    let workspace_id = conversation
        .workspace_id
        .ok_or_else(|| crate::i18n::t("terminal.errors.noWorkspace"))?;
    let workspace = db
        .get_workspace(&workspace_id)
        .map_err(|error| format!("TERMINAL_CONVERSATION: {error}"))?
        .ok_or_else(|| {
            crate::i18n::t_args(
                "terminal.errors.workspaceMissing",
                &[("workspace_id", &workspace_id)],
            )
        })?;
    let path = PathBuf::from(workspace.path);
    if !path.is_dir() {
        return Err(crate::i18n::t_args(
            "terminal.errors.folderUnavailable",
            &[("path", &path.display().to_string())],
        ));
    }
    Ok(path)
}

/// Kills the shell **and its descendants**. portable-pty only knows the direct
/// child (`TerminateProcess` on Windows), so `taskkill /T /F` is used first;
/// the direct killer remains as a fallback for Unix/odd failures.
fn kill_process_tree(pid: Option<u32>, killer: &mut dyn ChildKiller) {
    #[cfg(windows)]
    {
        if let Some(pid) = pid {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut command = std::process::Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T", "/F"]);
            command.stdout(std::process::Stdio::null());
            command.stderr(std::process::Stdio::null());
            command.creation_flags(CREATE_NO_WINDOW);
            if command.status().map(|status| status.success()).unwrap_or(false) {
                return;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
    let _ = killer.kill();
}

/// Stateful UTF-8 decoder: an UTF-8 code point can be split across two ConPTY
/// reads (accented text, emoji, CJK). `from_utf8_lossy` per chunk would insert
/// `�`; `encoding_rs` keeps the incomplete tail until the next read.
struct Utf8StreamDecoder {
    decoder: encoding_rs::Decoder,
}

impl Utf8StreamDecoder {
    fn new() -> Self {
        Self {
            decoder: encoding_rs::UTF_8.new_decoder_without_bom_handling(),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        // `decode_to_string` writes into the String's existing capacity; it
        // does not grow it. Reserve worst-case UTF-8 (3 bytes per unit).
        let mut output = String::with_capacity(bytes.len() * 3 + 4);
        let _ = self.decoder.decode_to_string(bytes, &mut output, false);
        output
    }

    fn finish(&mut self) -> String {
        let mut output = String::with_capacity(4);
        let _ = self.decoder.decode_to_string(&[], &mut output, true);
        output
    }
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre um terminal novo e começa a transmitir a saída pelo `channel`.
    pub fn open(
        &self,
        db: &Db,
        settings: &Settings,
        conversation_id: &str,
        cols: u16,
        rows: u16,
        channel: Channel<TerminalEvent>,
    ) -> Result<TerminalInfo, String> {
        // Held until the session is inserted, so two concurrent opens cannot
        // both observe a free slot and exceed the global limit.
        let _open_guard = self.open_lock.lock();
        let running_count = self
            .sessions
            .lock()
            .values()
            .filter(|session| session.is_running())
            .count();
        if running_count >= MAX_TERMINALS {
            return Err(crate::i18n::t_args(
                "terminal.errors.limit",
                &[("limit", &MAX_TERMINALS.to_string())],
            ));
        }

        let cols = cols.clamp(20, 500);
        let rows = rows.clamp(5, 200);
        let cwd = terminal_cwd(db, conversation_id)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("TERMINAL_SPAWN: {error}"))?;

        let (builder, container) = terminal_command(&cwd, settings);

        let mut child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| format!("TERMINAL_SPAWN: {error}"))?;
        drop(pair.slave);
        let master = pair.master;
        let pid = child.process_id();
        let mut cleanup_killer = child.clone_killer();
        let mut reader = match master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                kill_process_tree(pid, cleanup_killer.as_mut());
                return Err(format!("TERMINAL_READ: {error}"));
            }
        };
        let writer = match master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                kill_process_tree(pid, cleanup_killer.as_mut());
                return Err(format!("TERMINAL_WRITE: {error}"));
            }
        };
        let killer = child.clone_killer();
        let mut reader_killer = child.clone_killer();
        let running = Arc::new(AtomicBool::new(true));
        let exit_code = Arc::new(Mutex::new(None));
        let thread_running = running.clone();
        let thread_exit = exit_code.clone();
        let id = format!("term-{}", uuid::Uuid::new_v4());
        let title = cwd
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Terminal".to_string());
        let cwd_display = cwd.to_string_lossy().to_string();
        let info = TerminalInfo {
            id: id.clone(),
            conversation_id: conversation_id.to_string(),
            title: title.clone(),
            cwd: cwd_display.clone(),
            cols,
            rows,
            running: true,
            exit_code: None,
        };

        // Leitor: bytes do ConPTY → UTF-8 stateful → evento `data`.
        let child_wait = std::thread::spawn(move || {
            let mut decoder = Utf8StreamDecoder::new();
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let tail = decoder.finish();
                        if !tail.is_empty() {
                            let _ = channel.send(TerminalEvent::Data { data: tail });
                        }
                        break;
                    }
                    Ok(read) => {
                        let text = decoder.push(&buffer[..read]);
                        if text.is_empty() {
                            continue;
                        }
                        if channel.send(TerminalEvent::Data { data: text }).is_err() {
                            // The webview/channel is gone: do not leave an
                            // invisible shell consuming a slot.
                            kill_process_tree(pid, reader_killer.as_mut());
                            break;
                        }
                    }
                    Err(_) => {
                        kill_process_tree(pid, reader_killer.as_mut());
                        break;
                    }
                }
            }
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            thread_running.store(false, Ordering::SeqCst);
            *thread_exit.lock() = code;
            let _ = channel.send(TerminalEvent::Exit { code });
        });
        // The thread owns the PTY reader and the child handle; dropping the
        // JoinHandle only detaches it.
        drop(child_wait);

        self.sessions.lock().insert(
            id,
            TerminalSession {
                conversation_id: conversation_id.to_string(),
                title,
                cwd: cwd_display,
                cols,
                rows,
                pid,
                container,
                master,
                writer,
                killer,
                running,
                exit_code,
            },
        );
        Ok(info)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("TERMINAL_NOT_FOUND: {id}"))?;
        if !session.is_running() {
            return Err(format!("TERMINAL_EXITED: {id}"));
        }
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("TERMINAL_WRITE: {error}"))?;
        let _ = session.writer.flush();
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.clamp(20, 500);
        let rows = rows.clamp(5, 200);
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("TERMINAL_NOT_FOUND: {id}"))?;
        if !session.is_running() {
            return Ok(());
        }
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("TERMINAL_RESIZE: {error}"))?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    }

    /// Kills the process but keeps the session/tab so the UI can show the exit
    /// code and offer "Reiniciar".
    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("TERMINAL_NOT_FOUND: {id}"))?;
        if session.is_running() {
            session.terminate();
        }
        Ok(())
    }

    pub fn close(&self, id: &str) -> bool {
        let mut sessions = self.sessions.lock();
        if let Some(mut session) = sessions.remove(id) {
            session.terminate();
            true
        } else {
            false
        }
    }

    /// Closes every terminal of a conversation (session deletion).
    pub fn close_conversation(&self, conversation_id: &str) -> usize {
        let _open_guard = self.open_lock.lock();
        let mut sessions = self.sessions.lock();
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| session.conversation_id == conversation_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut closed = 0;
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                session.terminate();
                closed += 1;
            }
        }
        closed
    }

    /// Lists live sessions; `None` returns the whole registry (the renderer keeps
    /// one global terminal list, so its orphan reconcile needs every session).
    pub fn list(&self, conversation_id: Option<&str>) -> Vec<TerminalInfo> {
        self.sessions
            .lock()
            .iter()
            .filter(|(_, session)| match conversation_id {
                Some(id) => session.conversation_id == id,
                None => true,
            })
            .map(|(id, session)| TerminalInfo {
                id: id.clone(),
                conversation_id: session.conversation_id.clone(),
                title: session.title.clone(),
                cwd: session.cwd.clone(),
                cols: session.cols,
                rows: session.rows,
                running: session.is_running(),
                exit_code: *session.exit_code.lock(),
            })
            .collect()
    }

    /// Encerra todos os terminais (shutdown do app).
    pub fn close_all(&self) -> usize {
        let _open_guard = self.open_lock.lock();
        let mut sessions = self.sessions.lock();
        let count = sessions.len();
        for (_, mut session) in sessions.drain() {
            session.terminate();
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_builder_gets_the_pty_markers() {
        let settings = Settings::default();
        let (builder, _) = terminal_command(&std::env::temp_dir(), &settings);
        let value = |key: &str| {
            builder
                .get_env(key)
                .map(|value| value.to_string_lossy().into_owned())
        };
        assert_eq!(value("TERM").as_deref(), Some("xterm-256color"));
        assert_eq!(value("COLORTERM").as_deref(), Some("truecolor"));
        assert_eq!(value("ZYLARA_AGENT").as_deref(), Some("1"));
        #[cfg(unix)]
        assert!(value("SHELL").is_some());
    }

    #[test]
    fn docker_terminal_uses_hardened_container_flags() {
        let mut settings = Settings::default();
        settings.execution_environment = "docker".to_string();
        settings.docker_image = "node:24-bookworm-slim".to_string();
        let cwd = std::env::temp_dir();
        let (builder, container) = terminal_command(&cwd, &settings);
        assert!(container.is_some());
        let argv: Vec<String> = builder
            .get_argv()
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        let joined = argv.join(" ");
        assert!(joined.contains("docker"));
        assert!(joined.contains("--network none"));
        assert!(joined.contains("--cap-drop ALL"));
        assert!(joined.contains("no-new-privileges"));
        assert!(joined.contains("node:24-bookworm-slim"));
        assert!(joined.contains(":/workspace"));
        assert!(joined.contains("bash"));
    }

    #[test]
    fn local_terminal_has_no_container() {
        let settings = Settings::default();
        let (_builder, container) = terminal_command(&std::env::temp_dir(), &settings);
        assert!(container.is_none());
    }

    #[test]
    fn utf8_decoder_keeps_split_sequences_intact() {
        let mut decoder = Utf8StreamDecoder::new();
        // "ção" split in the middle of both two-byte sequences.
        let bytes = "ção".as_bytes();
        assert!(bytes.len() >= 4);
        let first = decoder.push(&bytes[..1]);
        let rest = decoder.push(&bytes[1..]);
        let tail = decoder.finish();
        assert_eq!(format!("{first}{rest}{tail}"), "ção");
        assert!(!format!("{first}{rest}{tail}").contains('\u{FFFD}'));
    }

    #[test]
    fn utf8_decoder_replaces_invalid_bytes_once() {
        let mut decoder = Utf8StreamDecoder::new();
        let output = format!("{}a{}", decoder.push(&[0xff]), decoder.finish());
        assert_eq!(output, "\u{FFFD}a");
    }

    #[test]
    fn registry_lifecycle_is_honest_without_a_channel() {
        let registry = TerminalRegistry::new();
        assert!(!registry.close("term-missing"));
        assert!(registry.list(Some("conv-1")).is_empty());
        assert!(registry.list(None).is_empty());
        assert!(registry.write("term-missing", "ls\n").is_err());
        assert!(registry.resize("term-missing", 80, 24).is_err());
        assert!(registry.kill("term-missing").is_err());
        assert_eq!(registry.close_conversation("conv-1"), 0);
        assert_eq!(registry.close_all(), 0);
    }
}
