//! Docker engine (daemon) health for image pulls and the graphical desktop.
//!
//! The Docker CLI resolves its endpoint from the CLI context — `desktop-linux`
//! on a Docker Desktop install, which is the `npipe:////./pipe/…` named pipe.
//! When the engine is stopped the CLI fails with a *transport* error
//! (`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`),
//! which is not an image problem at all: `docker pull` never ran. This module
//! classifies that failure and starts Docker Desktop, waiting (bounded) for the
//! engine to answer, so a download or a container start can retry instead of
//! dying on the first attempt with the raw pipe path.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use crate::workspace::exec::{self, ExecRequest};

/// CLI stderr fragments meaning "the engine endpoint is not reachable".
///
/// Kept narrow on purpose: registry failures (`pull access denied`,
/// `unauthorized`, `manifest unknown`, `no such image`) must never be treated
/// as a daemon problem.
const DAEMON_DOWN_PATTERNS: &[&str] = &[
    "failed to connect to the docker api",
    "cannot connect to the docker daemon",
    "is the docker daemon running",
    "error during connect",
    "dockerdesktoplinuxengine",
    "pipe/docker_engine",
];

/// Per-probe budget while checking the engine; a missing pipe fails instantly.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_INTERVAL: Duration = Duration::from_secs(2);

/// True when `stderr` is the CLI telling us the daemon is not running.
pub fn error_is_daemon_down(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    DAEMON_DOWN_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// How to launch Docker Desktop on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launcher {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl Launcher {
    fn path(program: PathBuf) -> Self {
        Self {
            program,
            args: Vec::new(),
        }
    }

    /// Starts the desktop without waiting; the caller polls for the engine.
    fn spawn(&self) -> std::io::Result<()> {
        let mut command = std::process::Command::new(&self.program);
        command.args(&self.args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS: the desktop outlives this app and its job objects.
            command.creation_flags(0x0000_0008);
        }
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        command.spawn().map(|_| ())
    }
}

/// Resolves a launcher from an optional user override and ordered candidates.
///
/// Pure on purpose: the platform wiring stays in [`desktop_launcher`].
pub fn launcher_from(override_path: Option<&Path>, candidates: &[PathBuf]) -> Option<Launcher> {
    if let Some(path) = override_path {
        if path.is_file() {
            return Some(Launcher::path(path.to_path_buf()));
        }
    }
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| Launcher::path(candidate.clone()))
}

/// How to start Docker Desktop here, when we know how.
pub fn desktop_launcher() -> Option<Launcher> {
    let override_path = std::env::var_os("ZYLARA_DOCKER_DESKTOP").map(PathBuf::from);
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("Docker")
                    .join("Docker")
                    .join("Docker Desktop.exe"),
            );
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Docker")
                    .join("Docker Desktop.exe"),
            );
        }
        return launcher_from(override_path.as_deref(), &candidates);
    }
    #[cfg(target_os = "macos")]
    {
        if launcher_from(override_path.as_deref(), &[]).is_none()
            && Path::new("/Applications/Docker.app").exists()
        {
            return Some(Launcher {
                program: PathBuf::from("open"),
                args: vec!["-a".to_string(), "Docker".to_string()],
            });
        }
        return launcher_from(override_path.as_deref(), &[]);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // Linux daemons are system services: starting them needs privileges the
        // app must not assume, so callers only report the guidance.
        launcher_from(override_path.as_deref(), &[])
    }
}

async fn probe(data_dir: &Path) -> Option<String> {
    let output = exec::run(
        ExecRequest {
            program: "docker".to_string(),
            args: vec![
                "version".to_string(),
                "--format".to_string(),
                "{{.Server.Version}}".to_string(),
            ],
            cwd: data_dir.to_path_buf(),
            env: exec::sanitized_env(&[]),
            timeout: PROBE_TIMEOUT,
            cancel: CancellationToken::new(),
            max_output_bytes: 64 * 1024,
        },
        None,
    )
    .await
    .ok()?;
    if output.exit_code != Some(0) {
        return None;
    }
    let version = output.stdout.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Server version of the running engine, or `None` when it is not reachable.
pub async fn server_version(data_dir: &Path) -> Option<String> {
    probe(data_dir).await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureOutcome {
    /// The engine was already answering.
    AlreadyRunning,
    /// Docker Desktop was launched and the engine came up within the deadline.
    Started,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsureError {
    /// No Docker Desktop executable was found: the user has to install/start it.
    Unavailable,
    /// The executable exists but could not be spawned (permissions, corrupt install).
    LaunchFailed(String),
    /// Docker Desktop launched but the engine did not answer before the deadline.
    Timeout,
}

impl std::fmt::Display for EnsureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => write!(f, "DOCKER_DAEMON_UNAVAILABLE"),
            Self::LaunchFailed(error) => write!(f, "DOCKER_DAEMON_LAUNCH_FAILED: {error}"),
            Self::Timeout => write!(f, "DOCKER_DAEMON_START_TIMEOUT"),
        }
    }
}

/// Makes sure the engine answers, starting Docker Desktop when needed.
///
/// `wait` bounds the whole boot (probe interval included); it is ignored when
/// the engine is already up. Callers must only use this from explicit user
/// actions — never from the app boot.
pub async fn ensure(data_dir: &Path, wait: Duration) -> Result<EnsureOutcome, EnsureError> {
    if probe(data_dir).await.is_some() {
        return Ok(EnsureOutcome::AlreadyRunning);
    }
    let launcher = desktop_launcher().ok_or(EnsureError::Unavailable)?;
    launcher
        .spawn()
        .map_err(|error| EnsureError::LaunchFailed(error.to_string()))?;
    let deadline = Instant::now() + wait;
    loop {
        if probe(data_dir).await.is_some() {
            return Ok(EnsureOutcome::Started);
        }
        if Instant::now() >= deadline {
            return Err(EnsureError::Timeout);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        tokio::time::sleep(PROBE_INTERVAL.min(remaining)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_unreachable_engine_messages() {
        let cases = [
            // Exact Windows wording from the download failure report (pt-BR OS).
            "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: O sistema não pode encontrar o arquivo especificado.",
            "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            "error during connect: Get \"http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.45/images/json\": open //./pipe/docker_engine: The system cannot find the file specified.",
        ];
        for case in cases {
            assert!(error_is_daemon_down(case), "não classificou: {case}");
        }
    }

    #[test]
    fn does_not_classify_registry_or_image_errors() {
        let cases = [
            "Error response from daemon: pull access denied for zylara-computer, repository does not exist or may require 'docker login'",
            "Error response from daemon: unauthorized: authentication required",
            "manifest unknown: manifest unknown",
            "Error: No such image: ghcr.io/hyska-software/zylara-computer:latest",
            "Error response from daemon: Get \"https://ghcr.io/v2/\": dial tcp 140.82.112.34:443: i/o timeout",
        ];
        for case in cases {
            assert!(!error_is_daemon_down(case), "falso positivo: {case}");
        }
    }

    #[test]
    fn launcher_prefers_the_existing_override() {
        let temp = std::env::temp_dir().join(format!(
            "zylara-docker-launcher-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&temp).expect("tempdir");
        let override_path = temp.join("custom-desktop.exe");
        std::fs::write(&override_path, b"").expect("write override");
        let missing = temp.join("missing.exe");
        let launcher = launcher_from(Some(&override_path), std::slice::from_ref(&missing))
            .expect("launcher");
        assert_eq!(launcher.program, override_path);
        assert!(launcher.args.is_empty());
        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn launcher_falls_back_to_the_first_existing_candidate() {
        let temp = std::env::temp_dir().join(format!(
            "zylara-docker-candidates-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&temp).expect("tempdir");
        let missing = temp.join("docker-desktop.exe");
        let existing = temp.join("docker-desktop-alt.exe");
        std::fs::write(&existing, b"").expect("write candidate");
        let launcher = launcher_from(None, &[missing, existing.clone()]).expect("launcher");
        assert_eq!(launcher.program, existing);
        std::fs::remove_dir_all(&temp).ok();
    }

    #[test]
    fn launcher_is_none_without_a_desktop_install() {
        let missing = PathBuf::from("zylara-definitely-missing-docker-desktop.exe");
        assert!(launcher_from(None, std::slice::from_ref(&missing)).is_none());
        assert!(launcher_from(Some(&missing), &[]).is_none());
    }

    #[test]
    fn ensure_errors_keep_stable_codes() {
        assert!(
            EnsureError::Unavailable
                .to_string()
                .starts_with("DOCKER_DAEMON_UNAVAILABLE")
        );
        assert!(
            EnsureError::LaunchFailed("access denied".into())
                .to_string()
                .contains("access denied")
        );
        assert!(
            EnsureError::Timeout
                .to_string()
                .starts_with("DOCKER_DAEMON_START_TIMEOUT")
        );
    }
}
