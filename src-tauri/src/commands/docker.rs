//! Docker inspection/maintenance commands for the production sandbox.
//!
//! Execution itself lives in `workspace::exec`; these commands only surface
//! daemon/image state and let the user pull/validate/clean images explicitly.

use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;
use crate::workspace::docker as daemon;
use crate::workspace::exec::{self, ExecRequest};

/// Bounded wait for Docker Desktop to boot when a command has to start it.
const DAEMON_START_WAIT: Duration = Duration::from_secs(120);

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

/// Localized message for a failed attempt to bring the engine up.
fn daemon_error(error: daemon::EnsureError) -> String {
    match error {
        daemon::EnsureError::Unavailable => crate::i18n::t("docker.errors.daemonUnavailable"),
        daemon::EnsureError::LaunchFailed(detail) => crate::i18n::t_args(
            "docker.errors.daemonLaunchFailed",
            &[("error", &detail)],
        ),
        daemon::EnsureError::Timeout => crate::i18n::t("docker.errors.daemonStartFailed"),
    }
}

/// A CLI failure can come from the engine instead of the command itself (the
/// user started Docker Desktop and it is still booting, or it crashed). Those
/// must not look like an image problem.
fn is_daemon_failure(stderr: &str) -> bool {
    daemon::error_is_daemon_down(stderr)
}

/// Printed by the validator smoke run: a silent success and a stalled container
/// must be distinguishable.
const SMOKE_MARKER: &str = "zylara-smoke-ok";

/// Arguments of the validator smoke run.
///
/// The graphical image boots the desktop in its entrypoint and never exits on
/// its own, so `docker run <image> sh -lc true` blocks until the timeout.
/// Overriding the entrypoint keeps the check generic (any image with `/bin/sh`)
/// and immediate.
fn smoke_args(image: &str) -> Vec<String> {
    vec![
        "run".into(),
        "--rm".into(),
        "--cap-drop".into(),
        "ALL".into(),
        "--security-opt".into(),
        "no-new-privileges".into(),
        "--network".into(),
        "none".into(),
        "--entrypoint".into(),
        "/bin/sh".into(),
        image.to_string(),
        "-lc".into(),
        format!("printf {SMOKE_MARKER}"),
    ]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    pub available: bool,
    pub server_version: Option<String>,
    pub images: Vec<String>,
    pub error: Option<String>,
}

async fn docker(
    state: &AppState,
    args: Vec<String>,
    timeout: Duration,
) -> anyhow::Result<exec::ExecOutput> {
    exec::run(
        ExecRequest {
            program: "docker".to_string(),
            args,
            cwd: state.data_dir.clone(),
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

#[tauri::command]
pub async fn docker_status(state: State<'_, AppState>) -> Result<DockerStatus, String> {
    let version = docker(
        &state,
        vec!["version".into(), "--format".into(), "{{.Server.Version}}".into()],
        Duration::from_secs(10),
    )
    .await;
    match version {
        Ok(output) if output.exit_code == Some(0) => {
            let images = docker(
                &state,
                vec![
                    "images".into(),
                    "--format".into(),
                    "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}".into(),
                ],
                Duration::from_secs(10),
            )
            .await
            .ok()
            .map(|value| {
                value
                    .stdout
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
            Ok(DockerStatus {
                available: true,
                server_version: Some(output.stdout.trim().to_string()),
                images,
                error: None,
            })
        }
        Ok(output) => Ok(DockerStatus {
            available: false,
            server_version: None,
            images: Vec::new(),
            error: Some(output.stderr.trim().to_string()),
        }),
        Err(error) => Ok(DockerStatus {
            available: false,
            server_version: None,
            images: Vec::new(),
            error: Some(format!("{error:#}")),
        }),
    }
}

#[tauri::command]
pub async fn docker_pull_image(
    state: State<'_, AppState>,
    image: String,
) -> Result<String, String> {
    let image = image.trim();
    if image.is_empty() || image.chars().count() > 200 {
        return Err(crate::i18n::t("docker.errors.invalidImage"));
    }
    // The engine not running is the most common cause of a failed download, and
    // the CLI reports it as a transport error. Start Docker Desktop and wait so
    // the pull below can actually run.
    daemon::ensure(&state.data_dir, DAEMON_START_WAIT)
        .await
        .map_err(daemon_error)?;
    let output = docker(
        &state,
        vec!["pull".into(), image.to_string()],
        Duration::from_secs(600),
    )
    .await
    .map_err(to_error)?;
    if output.exit_code != Some(0) {
        if is_daemon_failure(&output.stderr) {
            return Err(crate::i18n::t("docker.errors.daemonUnavailable"));
        }
        return Err(format!(
            "DOCKER_PULL_FAILED: {}",
            output.stderr.trim()
        ));
    }
    Ok(output.stdout.lines().last().unwrap_or_default().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerDaemonStatus {
    /// The engine answers on the current CLI context.
    pub running: bool,
    /// This call had to launch Docker Desktop to get there.
    pub started: bool,
    pub server_version: Option<String>,
}

/// Brings the engine up (launching Docker Desktop when needed) for the UI's
/// explicit "start Docker" action.
#[tauri::command]
pub async fn docker_start_daemon(state: State<'_, AppState>) -> Result<DockerDaemonStatus, String> {
    let outcome = daemon::ensure(&state.data_dir, DAEMON_START_WAIT)
        .await
        .map_err(daemon_error)?;
    let server_version = daemon::server_version(&state.data_dir).await;
    Ok(DockerDaemonStatus {
        running: server_version.is_some(),
        started: outcome == daemon::EnsureOutcome::Started,
        server_version,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageInfo {
    pub image: String,
    pub id: String,
    pub architecture: String,
}

#[tauri::command]
pub async fn docker_validate_image(
    state: State<'_, AppState>,
    image: String,
) -> Result<DockerImageInfo, String> {
    let image = image.trim();
    if image.is_empty() || image.chars().count() > 200 {
        return Err(crate::i18n::t("docker.errors.invalidImage"));
    }
    daemon::ensure(&state.data_dir, DAEMON_START_WAIT)
        .await
        .map_err(daemon_error)?;
    let inspect = docker(
        &state,
        vec![
            "image".into(),
            "inspect".into(),
            image.to_string(),
            "--format".into(),
            "{{.Id}}|{{.Architecture}}".into(),
        ],
        Duration::from_secs(20),
    )
    .await
    .map_err(to_error)?;
    if inspect.exit_code != Some(0) {
        if is_daemon_failure(&inspect.stderr) {
            return Err(crate::i18n::t("docker.errors.daemonUnavailable"));
        }
        return Err(crate::i18n::t_args(
            "docker.errors.imageMissing",
            &[("error", inspect.stderr.trim())],
        ));
    }
    let mut parts = inspect.stdout.trim().split('|');
    let id = parts.next().unwrap_or_default().to_string();
    let architecture = parts.next().unwrap_or_default().to_string();
    // A real smoke run catches a broken image before the agent does.
    let smoke = docker(&state, smoke_args(image), Duration::from_secs(60))
        .await
        .map_err(to_error)?;
    if smoke.exit_code != Some(0) || !smoke.stdout.contains(SMOKE_MARKER) {
        if is_daemon_failure(&smoke.stderr) {
            return Err(crate::i18n::t("docker.errors.daemonUnavailable"));
        }
        return Err(format!(
            "DOCKER_IMAGE_UNHEALTHY: {}",
            smoke.stderr.trim()
        ));
    }
    Ok(DockerImageInfo {
        image: image.to_string(),
        id,
        architecture,
    })
}

/// Removes every container labeled `zylara.owner=zylara`. Used by the
/// command and by the boot cleanup; active containers are only removed at boot.
pub async fn cleanup_containers(state: &AppState) -> Result<u32, String> {
    let listed = docker(
        state,
        vec![
            "ps".into(),
            "-aq".into(),
            "--filter".into(),
            "label=zylara.owner=zylara".into(),
        ],
        Duration::from_secs(10),
    )
    .await
    .map_err(to_error)?;
    let ids: Vec<String> = listed
        .stdout
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if !ids.is_empty() {
        let mut args = vec!["rm".into(), "-f".into()];
        args.extend(ids.iter().cloned());
        let removed = docker(state, args, Duration::from_secs(30))
            .await
            .map_err(to_error)?;
        if removed.exit_code != Some(0) {
            return Err(format!(
                "DOCKER_CLEANUP_FAILED: {}",
                removed.stderr.trim()
            ));
        }
    }
    Ok(ids.len() as u32)
}

#[tauri::command]
pub async fn docker_cleanup(state: State<'_, AppState>) -> Result<u32, String> {
    cleanup_containers(state.inner()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_run_bypasses_the_image_entrypoint() {
        let args = smoke_args("ghcr.io/hyska-software/zylara-computer:latest");
        let flag = args
            .iter()
            .position(|arg| arg == "--entrypoint")
            .expect("--entrypoint flag");
        assert_eq!(args[flag + 1], "/bin/sh");
        // Hardening stays in place on the smoke run.
        for required in ["--rm", "--cap-drop", "--security-opt", "--network"] {
            assert!(args.iter().any(|arg| arg == required), "missing {required}");
        }
        assert!(args.iter().any(|arg| arg == "no-new-privileges"));
        assert!(args.iter().any(|arg| arg == "none"));
    }

    #[test]
    fn smoke_run_keeps_the_image_before_the_command() {
        let args = smoke_args("zylara/computer:test");
        let image = args
            .iter()
            .position(|arg| arg == "zylara/computer:test")
            .expect("image reference");
        assert!(args[image + 1] == "-lc");
        assert!(args[image + 2].contains(SMOKE_MARKER));
        // The command must be last: anything after it would be a container arg.
        assert_eq!(args.len(), image + 3);
    }
}
