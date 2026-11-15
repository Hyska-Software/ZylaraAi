//! `run_code` tool: executes Python/JavaScript scripts in an isolated workspace
//! and turns every file the script creates into an artifact.
//!
//! This is **not** an OS sandbox: the script runs with the user's permissions
//! and network access. Mitigations: opt-in setting, dedicated workspace,
//! timeout, output/artifact caps, sensitive env vars stripped and process-tree
//! kill on cancel.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::domain::{
    CodeEnvironmentStatus, CodePackageStatus, InterpreterInfo, Settings,
};
use crate::i18n::{t, t_args, t_count};
use crate::providers::ToolDefinition;

use super::artifacts::{sanitize_filename, write_artifact};
use super::{json_str, json_u32, truncate_chars, ToolOutcome, ToolRuntime};

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

const MAX_CODE_BYTES: usize = 100 * 1024;
const MAX_INPUT_FILES: usize = 10;
const MAX_INPUT_FILE_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_FILES: usize = 20;
const MAX_OUTPUT_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_OUTPUT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
/// Whole-workspace budget after the run (docs/FILES.md §8.2).
const MAX_WORKSPACE_BYTES: u64 = 128 * 1024 * 1024;
/// Directories deeper than this inside the workspace are ignored.
const MAX_WORKSPACE_DEPTH: usize = 4;
/// Captured stdout/stderr per stream (the rest is drained and discarded).
const MAX_STREAM_BYTES: usize = 64 * 1024;
/// Tail of the capture sent back to the model.
const MAX_REPORT_STREAM_CHARS: usize = 8_000;
const MIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const PACKAGES_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_VERSION_CHARS: usize = 120;
const PYTHON_PACKAGES: &[(&str, &str)] = &[
    ("python-docx", "docx"),
    ("openpyxl", "openpyxl"),
    ("python-pptx", "pptx"),
    ("reportlab", "reportlab"),
    ("Pillow", "PIL"),
];
const INSTALL_PACKAGES: &str =
    "python-docx openpyxl python-pptx reportlab Pillow";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/* ------------------------------------------------------------------ */
/* Language + interpreter resolution                                   */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Language {
    Python,
    JavaScript,
}

impl Language {
    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "python" | "py" => Ok(Self::Python),
            "javascript" | "js" | "node" => Ok(Self::JavaScript),
            other => bail!(
                "{}",
                t_args("tools.code_exec.unsupportedLanguage", &[("other", other)])
            ),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::JavaScript => "javascript",
        }
    }

    fn script_name(self) -> &'static str {
        match self {
            Self::Python => "script.py",
            Self::JavaScript => "script.mjs",
        }
    }

    fn candidates(self) -> &'static [&'static str] {
        match self {
            Self::Python => &["python", "python3", "py"],
            Self::JavaScript => &["node"],
        }
    }

    fn configured_path<'a>(self, settings: &'a Settings) -> &'a str {
        match self {
            Self::Python => settings.code_python_path.as_str(),
            Self::JavaScript => settings.code_node_path.as_str(),
        }
    }

    fn missing_message(self) -> String {
        match self {
            Self::Python => t("tools.code_exec.pythonMissing"),
            Self::JavaScript => t("tools.code_exec.nodeMissing"),
        }
    }
}

#[derive(Debug, Clone)]
struct Interpreter {
    path: PathBuf,
    version: String,
    source: &'static str,
}

impl Interpreter {
    fn info(&self) -> InterpreterInfo {
        InterpreterInfo {
            path: self.path.to_string_lossy().into_owned(),
            version: self.version.clone(),
            source: self.source.to_string(),
        }
    }
}

fn resolve_interpreter(
    language: Language,
    settings: &Settings,
) -> anyhow::Result<Interpreter> {
    let directories = path_directories();
    resolve_interpreter_in(language, settings, &directories)
}

fn resolve_interpreter_in(
    language: Language,
    settings: &Settings,
    directories: &[PathBuf],
) -> anyhow::Result<Interpreter> {
    let configured = language.configured_path(settings).trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_file() {
            if let Some(version) = interpreter_version(&path) {
                if version_looks_valid(language, &version) {
                    return Ok(Interpreter {
                        path,
                        version,
                        source: "settings",
                    });
                }
            }
        }
        bail!(
            "{}",
            t_args(
                "tools.code_exec.configuredInterpreterMissing",
                &[("configured", configured)]
            )
        );
    }

    for candidate in language.candidates() {
        if let Some(path) = find_in_path(candidate, directories) {
            // The Windows Store alias and broken installs answer with an error;
            // only accept interpreters that report a recognizable version.
            if let Some(version) = interpreter_version(&path) {
                if version_looks_valid(language, &version) {
                    return Ok(Interpreter {
                        path,
                        version,
                        source: "path",
                    });
                }
            }
        }
    }
    bail!(language.missing_message())
}

/// Guards against the Windows Store `python.exe` alias and unrelated binaries
/// with the same name: the probe must look like a real version string.
fn version_looks_valid(language: Language, version: &str) -> bool {
    if !version.chars().any(|character| character.is_ascii_digit()) {
        return false;
    }
    let lower = version.to_ascii_lowercase();
    match language {
        Language::Python => lower.contains("python"),
        Language::JavaScript => lower.contains('v') || lower.contains("node"),
    }
}

fn path_directories() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

/// Executable extensions tried on Windows (`PATHEXT`), plus the bare name for
/// Unix-like systems.
fn executable_extensions() -> Vec<String> {
    if cfg!(windows) {
        let mut extensions: Vec<String> = std::env::var_os("PATHEXT")
            .map(|value| {
                std::env::split_paths(&value)
                    .map(|path| path.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_else(|| vec![".COM".into(), ".EXE".into(), ".BAT".into(), ".CMD".into()]);
        extensions.push(String::new());
        extensions
    } else {
        vec![String::new()]
    }
}

fn find_in_path(candidate: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    let extensions = executable_extensions();
    for directory in directories {
        for extension in &extensions {
            let path = directory.join(format!("{candidate}{extension}"));
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// Runs `--version` with a short timeout; returns the first non-empty line.
fn interpreter_version(path: &Path) -> Option<String> {
    let output = run_command_sync(path, &["--version"], VERSION_TIMEOUT)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(truncate_chars(line, MAX_VERSION_CHARS))
}

/// Synchronous child process with a polled timeout (version/package probes are
/// called from blocking contexts too).
fn run_command_sync(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
) -> Option<std::process::Output> {
    let mut command = std::process::Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => return None,
        }
    }
    child.wait_with_output().ok()
}

/* ------------------------------------------------------------------ */
/* Environment status                                                  */
/* ------------------------------------------------------------------ */

/// Detects interpreters, optional Python packages and installed skills for the
/// settings screen (Configurações → Ferramentas → Ambiente de código). Skills
/// include the standard external repositories (Codex/Claude/OpenCode/agents).
pub fn environment_status(data_dir: &Path, settings: &Settings) -> CodeEnvironmentStatus {
    environment_status_impl(data_dir, settings, None)
}

/// Same as [`environment_status`] with explicit external skills roots (tests
/// pass `&[]` so they never touch the real home directory). Test-only hook: the
/// production path always uses the standard repositories.
#[allow(dead_code)]
pub fn environment_status_with_roots(
    data_dir: &Path,
    settings: &Settings,
    roots: &[super::skills::ExternalSkillRoot],
) -> CodeEnvironmentStatus {
    environment_status_impl(data_dir, settings, Some(roots))
}

fn environment_status_impl(
    data_dir: &Path,
    settings: &Settings,
    roots: Option<&[super::skills::ExternalSkillRoot]>,
) -> CodeEnvironmentStatus {
    let python = resolve_interpreter(Language::Python, settings).ok();
    let node = resolve_interpreter(Language::JavaScript, settings).ok();

    let packages = match python.as_ref() {
        Some(interpreter) => python_packages(&interpreter.path),
        None => PYTHON_PACKAGES
            .iter()
            .map(|(name, _)| CodePackageStatus {
                name: (*name).to_string(),
                available: false,
            })
            .collect(),
    };

    let install_hint = match python.as_ref() {
        Some(interpreter) => format!(
            "\"{}\" -m pip install {INSTALL_PACKAGES}",
            interpreter.path.display()
        ),
        None => t_args(
            "tools.code_exec.installHint",
            &[("packages", INSTALL_PACKAGES)],
        ),
    };

    let skills = match roots {
        Some(roots) => super::skills::summaries_with_roots(
            data_dir,
            &settings.disabled_skills,
            roots,
        ),
        // Production path: default-roots variant includes the standard external
        // repositories (agents/codex/claude/opencode).
        None => super::skills::summaries(data_dir, &settings.disabled_skills),
    };

    CodeEnvironmentStatus {
        enabled: settings.code_execution_enabled,
        python: python.as_ref().map(Interpreter::info),
        node: node.as_ref().map(Interpreter::info),
        packages,
        install_hint,
        skills,
    }
}

fn python_packages(interpreter: &Path) -> Vec<CodePackageStatus> {
    let modules: Vec<&str> = PYTHON_PACKAGES.iter().map(|(_, module)| *module).collect();
    let script = format!(
        "import importlib.util as u\nfor m in {modules:?}:\n    \
         try:\n        ok = u.find_spec(m) is not None\n    except Exception:\n        ok = False\n    \
         print(m + '=' + ('1' if ok else '0'))\n"
    );
    let found = run_command_sync(interpreter, &["-c", &script], PACKAGES_TIMEOUT)
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();
    PYTHON_PACKAGES
        .iter()
        .map(|(name, module)| CodePackageStatus {
            name: (*name).to_string(),
            available: found
                .lines()
                .any(|line| line.trim() == format!("{module}=1")),
        })
        .collect()
}

/* ------------------------------------------------------------------ */
/* Tool definition                                                     */
/* ------------------------------------------------------------------ */

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: "run_code".to_string(),
        description: "Execute Python or JavaScript code in an isolated workspace to produce files. \
                      Every regular file the script creates in the workspace (up to depth 4) becomes \
                      an artifact automatically, even when the exit code is not 0. Use it for binary \
                      formats (PDF, DOCX, XLSX, PPTX, images) and to run skill helper scripts — read \
                      the skill first with `read_skill`. For plain text/Markdown/HTML/CSV/JSON/SVG \
                      prefer `create_file`. Returns exit code, duration, captured stdout/stderr and \
                      the created artifacts."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "language": {
                    "type": "string",
                    "enum": ["python", "javascript"],
                    "description": "Runtime used to execute the script."
                },
                "code": {
                    "type": "string",
                    "description": "Full script source code (max 100 KB). Files are created relative to the workspace working directory."
                },
                "timeoutMs": {
                    "type": "integer",
                    "minimum": 5000,
                    "maximum": 600000,
                    "description": "Optional timeout in milliseconds (5 s to 10 min). Defaults to the app setting."
                },
                "inputFiles": {
                    "type": "array",
                    "description": "Optional UTF-8 files written into the workspace before running (max 10, 1 MB each). Names are sanitized to a basename.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "File name, e.g. \"spec.json\"."},
                            "content": {"type": "string", "description": "UTF-8 file content."}
                        },
                        "required": ["name", "content"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["language", "code"],
            "additionalProperties": false
        }),
    }
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

struct InputFile {
    name: String,
    content: String,
}

/// Parses and validates the tool arguments, then executes the script.
pub async fn run(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    match run_checked(rt, args).await {
        Ok(outcome) => outcome,
        Err(error) => ToolOutcome::error(format!("{error:#}")),
    }
}

async fn run_checked(rt: &ToolRuntime, args: &Value) -> anyhow::Result<ToolOutcome> {
    if !rt.settings.code_execution_enabled {
        bail!("{}", t("tools.code_exec.disabled"));
    }
    let language = Language::parse(json_str(args, "language").unwrap_or_default().as_str())?;
    let code = match args.get("code") {
        Some(Value::String(code)) if !code.trim().is_empty() => code.clone(),
        Some(Value::String(_)) => bail!("{}", t("tools.code_exec.codeEmpty")),
        Some(Value::Null) | None => bail!("{}", t("tools.code_exec.codeRequired")),
        Some(_) => bail!("{}", t("tools.code_exec.codeNotString")),
    };
    if code.len() > MAX_CODE_BYTES {
        let bytes = code.len().to_string();
        bail!(
            "{}",
            t_args("tools.code_exec.codeTooLarge", &[("bytes", &bytes)])
        );
    }
    let timeout = resolve_timeout(args, &rt.settings);
    let input_files = parse_input_files(args)?;
    run_script(rt, language, &code, timeout, input_files).await
}

fn resolve_timeout(args: &Value, settings: &Settings) -> Duration {
    let default = Duration::from_secs(u64::from(settings.code_timeout_secs));
    let requested = json_u32(args, "timeoutMs")
        .map(|millis| Duration::from_millis(u64::from(millis)))
        .unwrap_or(default);
    requested.clamp(MIN_TIMEOUT, MAX_TIMEOUT)
}

fn parse_input_files(args: &Value) -> anyhow::Result<Vec<InputFile>> {
    let Some(raw) = args.get("inputFiles") else {
        return Ok(Vec::new());
    };
    let items = match raw {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => bail!("{}", t("tools.code_exec.inputFilesNotList")),
    };
    if items.len() > MAX_INPUT_FILES {
        let count = items.len().to_string();
        let max = MAX_INPUT_FILES.to_string();
        bail!(
            "{}",
            t_args(
                "tools.code_exec.tooManyInputFiles",
                &[("count", &count), ("max", &max)]
            )
        );
    }

    // Deduplicate by sanitized name (last one wins).
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    for item in items {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| anyhow!(t("tools.code_exec.inputFileMissingName")))?;
        let content = match item.get("content") {
            Some(Value::String(content)) => content.clone(),
            Some(Value::Null) | None => {
                bail!(
                    "{}",
                    t_args("tools.code_exec.inputFileMissingContent", &[("name", name)])
                )
            }
            Some(_) => bail!(
                "{}",
                t_args(
                    "tools.code_exec.inputFileContentNotString",
                    &[("name", name)]
                )
            ),
        };
        if content.len() > MAX_INPUT_FILE_BYTES {
            let bytes = content.len().to_string();
            bail!(
                "{}",
                t_args(
                    "tools.code_exec.inputFileTooLarge",
                    &[("name", name), ("bytes", &bytes)]
                )
            );
        }
        files.insert(sanitize_filename(name), content);
    }
    Ok(files
        .into_iter()
        .map(|(name, content)| InputFile { name, content })
        .collect())
}

/// Workspace removed when dropped (success, error, timeout or cancellation).
struct Workspace {
    path: PathBuf,
}

impl Workspace {
    fn create(data_dir: &Path) -> anyhow::Result<Self> {
        let path = data_dir.join("code-runs").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).with_context(|| {
            let path = path.display().to_string();
            t_args("tools.code_exec.workspaceCreateFailed", &[("path", &path)])
        })?;
        Ok(Self { path })
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

enum RunEnd {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

async fn run_script(
    rt: &ToolRuntime,
    language: Language,
    code: &str,
    timeout: Duration,
    input_files: Vec<InputFile>,
) -> anyhow::Result<ToolOutcome> {
    let docker_image = (rt.settings.execution_environment.trim().eq_ignore_ascii_case("docker")
        && !rt.settings.docker_image.trim().is_empty())
    .then(|| rt.settings.docker_image.trim().to_string());
    let interpreter = match &docker_image {
        Some(_) => None,
        None => Some(resolve_interpreter(language, &rt.settings)?),
    };
    let workspace = Workspace::create(&rt.data_dir)?;
    let mut protected: BTreeSet<PathBuf> = BTreeSet::new();

    for input in &input_files {
        // Defense in depth: `parse_input_files` already sanitizes names, but the
        // internal runner is also called directly (tests) and must never write
        // outside the workspace.
        let name = sanitize_filename(&input.name);
        let path = workspace.path.join(&name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                let parent = parent.display().to_string();
                t_args("tools.code_exec.inputDirCreateFailed", &[("path", &parent)])
            })?;
        }
        std::fs::write(&path, input.content.as_bytes()).with_context(|| {
            t_args("tools.code_exec.inputFileWriteFailed", &[("name", &name)])
        })?;
        protected.insert(path);
    }

    let script_path = workspace.path.join(language.script_name());
    std::fs::write(&script_path, code.as_bytes()).with_context(|| {
        let path = script_path.display().to_string();
        t_args("tools.code_exec.scriptWriteFailed", &[("path", &path)])
    })?;
    protected.insert(script_path.clone());

    if rt.cancel.is_cancelled() {
        return Ok(cancelled_outcome(language));
    }

    let mut container_name: Option<String> = None;
    let mut command = if let Some(image) = docker_image.as_deref() {
        // Docker execution: the workspace is the only host path visible; the
        // rootfs is read-only, there is no network and the container is
        // removed with the run (including on cancellation).
        let name = format!("zylara-code-{}", uuid::Uuid::new_v4());
        container_name = Some(name.clone());
        let binary = match language {
            Language::Python => "python",
            Language::JavaScript => "node",
        };
        let mut command = Command::new("docker");
        command.args(["run", "--rm", "--name"]);
        command.arg(&name);
        command.args([
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--label",
            "zylara.owner=zylara",
        ]);
        command
            .arg("--pids-limit")
            .arg(rt.settings.docker_pids_limit.max(32).to_string());
        command
            .arg("--memory")
            .arg(format!("{}m", rt.settings.docker_memory_mb.max(256)));
        command
            .arg("--cpus")
            .arg(format!("{:.1}", rt.settings.docker_cpus.max(0.25)));
        if rt.settings.docker_read_only_root {
            command.args(["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m"]);
        }
        command.arg("-v");
        command.arg(format!("{}:/workspace", workspace.path.to_string_lossy()));
        command.args(["-w", "/workspace"]);
        command.arg(image);
        if language == Language::Python {
            // Unbuffered stdout/stderr so the captured streams reflect the run.
            command.arg("-u");
        }
        command.arg(binary).arg(language.script_name());
        command
    } else {
        let interpreter = interpreter.as_ref().expect("interpreter resolved");
        let mut command = Command::new(&interpreter.path);
        if language == Language::Python {
            // Unbuffered stdout/stderr so the captured streams reflect the run.
            command.arg("-u");
        }
        command.arg(language.script_name());
        command
    };
    command
        .current_dir(&workspace.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_environment(&mut command);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let spawn_label = match docker_image.as_deref() {
        Some(image) => format!("container `{image}`"),
        None => interpreter
            .as_ref()
            .map(|interpreter| interpreter.path.display().to_string())
            .unwrap_or_else(|| language.as_str().to_string()),
    };
    let mut child = command.spawn().with_context(|| {
        t_args(
            "tools.code_exec.spawnFailed",
            &[("target", &spawn_label)],
        )
    })?;
    let pid = child.id();
    let stdout_task = tokio::spawn(read_capped(child.stdout.take()));
    let stderr_task = tokio::spawn(read_capped(child.stderr.take()));

    let started = Instant::now();
    let end = tokio::select! {
        _ = rt.cancel.cancelled() => RunEnd::Cancelled,
        result = tokio::time::timeout(timeout, child.wait()) => match result {
            Ok(Ok(status)) => RunEnd::Exited(status),
            Ok(Err(error)) => {
                kill_process_tree(pid).await;
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(anyhow!(t_args(
                    "tools.code_exec.waitFailed",
                    &[("error", &error.to_string())]
                )));
            }
            Err(_) => RunEnd::TimedOut,
        },
    };
    if matches!(end, RunEnd::TimedOut | RunEnd::Cancelled) {
        kill_process_tree(pid).await;
        let _ = child.start_kill();
        let _ = child.wait().await;
        if let Some(name) = container_name.as_deref() {
            docker_remove(name).await;
        }
    }
    let duration = started.elapsed();

    let (stdout, stdout_total) = match stdout_task.await {
        Ok(result) => result,
        Err(_) => (Vec::new(), 0),
    };
    let (stderr, stderr_total) = match stderr_task.await {
        Ok(result) => result,
        Err(_) => (Vec::new(), 0),
    };

    // Files are collected even when the exit code is not 0 (or on timeout), so
    // a partially written deliverable is never lost.
    let (artifacts, notes) = collect_artifacts(rt, &workspace.path, &protected);

    let (exit_code, exit_success) = match &end {
        RunEnd::Exited(status) => (status.code(), status.success()),
        RunEnd::TimedOut | RunEnd::Cancelled => (None, false),
    };
    let is_error = !exit_success;
    let summary = summary_for(language, &end, exit_success, exit_code, duration, artifacts.len());

    let mut content = String::new();
    let duration_text = format_duration(duration);
    let headline = match &end {
        RunEnd::Exited(_) if exit_success => t_args(
            "tools.code_exec.headlineSuccess",
            &[
                ("language", language.as_str()),
                ("duration", &duration_text),
            ],
        ),
        RunEnd::Exited(_) => {
            let code = exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| t("tools.code_exec.exitCodeUnknown"));
            t_args(
                "tools.code_exec.headlineFailed",
                &[
                    ("language", language.as_str()),
                    ("code", &code),
                    ("duration", &duration_text),
                ],
            )
        }
        RunEnd::TimedOut => t_args(
            "tools.code_exec.headlineTimeout",
            &[
                ("language", language.as_str()),
                ("duration", &duration_text),
            ],
        ),
        RunEnd::Cancelled => t_args(
            "tools.code_exec.headlineCancelled",
            &[
                ("language", language.as_str()),
                ("duration", &duration_text),
            ],
        ),
    };
    if is_error {
        content.push_str("ERROR: ");
    }
    content.push_str(&headline);
    content.push('\n');

    if let Some(section) = render_stream("stdout", &stdout, stdout_total) {
        content.push('\n');
        content.push_str(&section);
    }
    if let Some(section) = render_stream("stderr", &stderr, stderr_total) {
        content.push('\n');
        content.push_str(&section);
    }
    if !artifacts.is_empty() {
        let count = artifacts.len().to_string();
        content.push_str(&format!(
            "\n{}\n",
            t_args("tools.code_exec.artifactsHeader", &[("count", &count)])
        ));
        for artifact in &artifacts {
            content.push_str(&format!(
                "- {} ({} bytes) — id: {}\n",
                artifact.name, artifact.size, artifact.id
            ));
        }
    }
    if !notes.is_empty() {
        content.push_str(&format!("\n{}\n", t("tools.code_exec.warningsHeader")));
        for note in &notes {
            content.push_str(&format!("- {note}\n"));
        }
    }

    Ok(ToolOutcome {
        content,
        summary: Some(summary),
        artifacts,
        is_error,
        ..Default::default()
    })
}

fn cancelled_outcome(language: Language) -> ToolOutcome {
    ToolOutcome {
        content: format!(
            "ERROR: {}",
            t_args(
                "tools.code_exec.cancelledBeforeStart",
                &[("language", language.as_str())]
            )
        ),
        summary: Some(t_args(
            "tools.code_exec.cancelledSummary",
            &[("language", language.as_str())],
        )),
        is_error: true,
        ..Default::default()
    }
}

fn apply_environment(command: &mut Command) {
    command.env_clear();
    let appdir = crate::process_env::appdir();
    for (key, value) in std::env::vars_os() {
        if is_sensitive_env(&key) || key.to_string_lossy().to_ascii_uppercase().starts_with("ZYLARA_")
        {
            continue;
        }
        if let Some(value) = crate::process_env::clean_value(&key, value, appdir.as_deref()) {
            command.env(key, value);
        }
    }
    if std::env::var_os("PATH").is_none() {
        command.env("PATH", crate::process_env::default_path());
    }
    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("NODE_NO_WARNINGS", "1");
}

/// Removes credentials from the inherited environment (`*API_KEY*`, `*TOKEN*`,
/// `*SECRET*`); the app never injects its own keys.
fn is_sensitive_env(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key.contains("API_KEY") || key.contains("TOKEN") || key.contains("SECRET")
}

/// Kills the whole process tree on Windows (`taskkill /T /F`); the direct child
/// is killed separately by the caller.
async fn kill_process_tree(pid: Option<u32>) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = command.status().await;
    }
    #[cfg(not(windows))]
    let _ = pid;
}

/// Removes a container left behind when the Docker CLI was killed. `--rm`
/// handles the normal path; this is the timeout/cancel fail-safe.
async fn docker_remove(name: &str) {
    let mut command = Command::new("docker");
    command
        .args(["rm", "-f", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let _ = command.status().await;
}

/// Reads a stream keeping the last [`MAX_STREAM_BYTES`] while draining the rest
/// (a script that prints forever must not block on a full pipe). The tail is
/// what matters for the model: the error/output usually comes last.
async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>) -> (Vec<u8>, u64) {
    let Some(mut reader) = reader else {
        return (Vec::new(), 0);
    };
    let mut captured: std::collections::VecDeque<u8> =
        std::collections::VecDeque::with_capacity(MAX_STREAM_BYTES);
    let mut total: u64 = 0;
    let mut buffer = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                total += read as u64;
                captured.extend(&buffer[..read]);
                if captured.len() > MAX_STREAM_BYTES {
                    let excess = captured.len() - MAX_STREAM_BYTES;
                    captured.drain(..excess);
                }
            }
            Err(_) => break,
        }
    }
    (captured.into_iter().collect(), total)
}

fn render_stream(label: &str, captured: &[u8], total: u64) -> Option<String> {
    let text = String::from_utf8_lossy(captured);
    let text = text.trim_end();
    if text.is_empty() {
        return None;
    }
    let mut section = format!("{label}:\n{}", tail_chars(text, MAX_REPORT_STREAM_CHARS));
    let captured_truncated = total > captured.len() as u64;
    let chars_truncated = text.chars().count() > MAX_REPORT_STREAM_CHARS;
    if captured_truncated || chars_truncated {
        let total = total.to_string();
        section.push_str(&format!(
            "\n{}",
            t_args(
                "tools.code_exec.streamTruncated",
                &[("label", label), ("total", &total)]
            )
        ));
    }
    section.push('\n');
    Some(section)
}

fn tail_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    text.chars().skip(count - max).collect()
}

/// Collects the files created by the script and registers them as artifacts.
/// Returns `(artifacts, warnings)`.
fn collect_artifacts(
    rt: &ToolRuntime,
    workspace: &Path,
    protected: &BTreeSet<PathBuf>,
) -> (Vec<crate::domain::Artifact>, Vec<String>) {
    let mut candidates: Vec<(String, PathBuf, u64)> = Vec::new();
    walk_workspace(workspace, workspace, 0, protected, &mut candidates);
    candidates.sort_by(|left, right| left.0.cmp(&right.0));

    let mut artifacts = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut workspace_bytes: u64 = 0;
    for (relative, path, size) in candidates {
        workspace_bytes += size;
        if workspace_bytes > MAX_WORKSPACE_BYTES {
            warnings.push(t_args(
                "tools.code_exec.workspaceTooLarge",
                &[("path", &relative)],
            ));
            break;
        }
        if artifacts.len() >= MAX_OUTPUT_FILES {
            let max = MAX_OUTPUT_FILES.to_string();
            warnings.push(t_args(
                "tools.code_exec.tooManyArtifacts",
                &[("max", &max)],
            ));
            break;
        }
        if size > MAX_OUTPUT_FILE_BYTES {
            let bytes = size.to_string();
            warnings.push(t_args(
                "tools.code_exec.outputFileTooLarge",
                &[("path", &relative), ("bytes", &bytes)],
            ));
            continue;
        }
        if total_bytes + size > MAX_OUTPUT_TOTAL_BYTES {
            warnings.push(t_args(
                "tools.code_exec.outputTotalTooLarge",
                &[("path", &relative)],
            ));
            break;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                warnings.push(t_args(
                    "tools.code_exec.outputReadFailed",
                    &[("path", &relative), ("error", &error.to_string())],
                ));
                continue;
            }
        };
        total_bytes += bytes.len() as u64;
        match write_artifact(
            &rt.db,
            &rt.data_dir,
            Some(&rt.conversation_id),
            Some(&rt.message_id),
            &relative,
            &bytes,
            None,
        ) {
            Ok(artifact) => artifacts.push(artifact),
            Err(error) => {
                let error = format!("{error:#}");
                warnings.push(t_args(
                    "tools.code_exec.artifactFailed",
                    &[("path", &relative), ("error", &error)],
                ));
            }
        }
    }
    (artifacts, warnings)
}

fn walk_workspace(
    root: &Path,
    directory: &Path,
    depth: usize,
    protected: &BTreeSet<PathBuf>,
    out: &mut Vec<(String, PathBuf, u64)>,
) {
    if depth > MAX_WORKSPACE_DEPTH {
        return;
    }
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_workspace(root, &path, depth + 1, protected, out);
            continue;
        }
        if !file_type.is_file() || protected.contains(&path) {
            continue;
        }
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        out.push((relative, path, size));
    }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

fn format_duration(duration: Duration) -> String {
    if duration.as_secs() < 1 {
        return format!("{} ms", duration.as_millis());
    }
    format!("{:.2} s", duration.as_secs_f64()).replace('.', ",")
}

fn summary_for(
    language: Language,
    end: &RunEnd,
    success: bool,
    exit_code: Option<i32>,
    duration: Duration,
    artifacts: usize,
) -> String {
    let seconds = format_duration(duration);
    let count = artifacts.to_string();
    let language = language.as_str();
    match end {
        RunEnd::Exited(_) if success => t_count(
            "tools.code_exec.summarySuccess",
            artifacts,
            &[
                ("language", language),
                ("count", &count),
                ("duration", &seconds),
            ],
        ),
        RunEnd::Exited(_) => {
            let code = exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| t("tools.code_exec.exitCodeUnknownShort"));
            t_args(
                "tools.code_exec.summaryFailed",
                &[("language", language), ("code", &code), ("duration", &seconds)],
            )
        }
        RunEnd::TimedOut => t_args(
            "tools.code_exec.summaryTimeout",
            &[("language", language), ("duration", &seconds)],
        ),
        RunEnd::Cancelled => t_args(
            "tools.code_exec.summaryCancelled",
            &[("language", language), ("duration", &seconds)],
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use crate::db::Db;
    use crate::domain::Settings;

    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zylara-code-exec-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("criar diretório temporário");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn runtime(temp: &TempDir) -> ToolRuntime {
        let mut settings = Settings::default();
        settings.code_execution_enabled = true;
        ToolRuntime {
            db: std::sync::Arc::new(Db::open_in_memory().expect("banco em memória")),
            http: reqwest::Client::new(),
            conversation_id: "conv-1".to_string(),
            message_id: "msg-1".to_string(),
            options: Default::default(),
            settings,
            cancel: CancellationToken::new(),
            agent_hooks: None,
            data_dir: temp.path.clone(),
            // Tests never read the developer's real skill repositories.
            skills_roots: Vec::new(),
            approval: None,
            emit: None,
        }
    }

    fn python_available() -> Option<PathBuf> {
        resolve_interpreter_in(Language::Python, &Settings::default(), &path_directories())
            .ok()
            .map(|interpreter| interpreter.path)
    }

    fn node_available() -> Option<PathBuf> {
        resolve_interpreter_in(
            Language::JavaScript,
            &Settings::default(),
            &path_directories(),
        )
        .ok()
        .map(|interpreter| interpreter.path)
    }

    fn read_artifact_bytes(rt: &ToolRuntime, artifact: &crate::domain::Artifact) -> Vec<u8> {
        std::fs::read(
            rt.data_dir
                .join("artifacts")
                .join(&artifact.id)
                .join(&artifact.name),
        )
        .expect("ler bytes do artefato")
    }

    #[test]
    fn definition_documents_the_arguments() {
        let definition = definition();
        assert_eq!(definition.name, "run_code");
        assert_eq!(
            definition.parameters["required"],
            json!(["language", "code"])
        );
        assert_eq!(
            definition.parameters["properties"]["language"]["enum"],
            json!(["python", "javascript"])
        );
    }

    #[test]
    fn parses_supported_languages() {
        assert_eq!(Language::parse("python").expect("python"), Language::Python);
        assert_eq!(Language::parse(" PYTHON ").expect("python"), Language::Python);
        assert_eq!(Language::parse("py").expect("py"), Language::Python);
        assert_eq!(
            Language::parse("javascript").expect("javascript"),
            Language::JavaScript
        );
        assert_eq!(Language::parse("node").expect("node"), Language::JavaScript);
        assert!(Language::parse("ruby").is_err());
        assert!(Language::parse("").is_err());
    }

    #[test]
    fn clamps_the_timeout() {
        let mut settings = Settings::default();
        settings.code_timeout_secs = 120;
        assert_eq!(resolve_timeout(&json!({}), &settings), Duration::from_secs(120));
        assert_eq!(
            resolve_timeout(&json!({"timeoutMs": 1}), &settings),
            MIN_TIMEOUT
        );
        assert_eq!(
            resolve_timeout(&json!({"timeoutMs": 1000}), &settings),
            MIN_TIMEOUT
        );
        assert_eq!(
            resolve_timeout(&json!({"timeoutMs": 60_000}), &settings),
            Duration::from_secs(60)
        );
        assert_eq!(
            resolve_timeout(&json!({"timeoutMs": 3_600_000}), &settings),
            MAX_TIMEOUT
        );
        settings.code_timeout_secs = 10_000;
        assert_eq!(resolve_timeout(&json!({}), &settings), MAX_TIMEOUT);
        settings.code_timeout_secs = 1;
        assert_eq!(resolve_timeout(&json!({}), &settings), MIN_TIMEOUT);
    }

    #[test]
    fn parses_and_sanitizes_input_files() {
        let files = parse_input_files(&json!({
            "inputFiles": [
                {"name": "../../fora.txt", "content": "x"},
                {"name": "ok.json", "content": "{}"}
            ]
        }))
        .expect("inputFiles válidos");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "fora.txt");
        assert_eq!(files[1].name, "ok.json");

        let deduplicated = parse_input_files(&json!({
            "inputFiles": [
                {"name": "a.txt", "content": "1"},
                {"name": "a.txt", "content": "2"}
            ]
        }))
        .expect("deduplicado");
        assert_eq!(deduplicated.len(), 1);
        assert_eq!(deduplicated[0].content, "2");

        assert!(parse_input_files(&json!({"inputFiles": [{"content": "x"}]})).is_err());
        assert!(parse_input_files(&json!({"inputFiles": "x"})).is_err());
        assert!(parse_input_files(&json!({"inputFiles": [{"name": "a", "content": 1}]})).is_err());

        let too_many: Vec<Value> = (0..MAX_INPUT_FILES + 1)
            .map(|index| json!({"name": format!("f{index}.txt"), "content": "x"}))
            .collect();
        assert!(parse_input_files(&json!({"inputFiles": too_many})).is_err());

        let big = "a".repeat(MAX_INPUT_FILE_BYTES + 1);
        assert!(parse_input_files(&json!({
            "inputFiles": [{"name": "big.txt", "content": big}]
        }))
        .is_err());
    }

    #[test]
    fn strips_sensitive_environment_variables() {
        for key in [
            "OPENCODE_API_KEY",
            "MY_TOKEN",
            "APP_SECRET",
            "api_key",
            "GITHUB_TOKEN",
        ] {
            assert!(
                is_sensitive_env(OsStr::new(key)),
                "`{key}` deveria ser removida do ambiente"
            );
        }
        for key in ["PATH", "HOME", "PYTHONUTF8", "GIT_AUTHOR_NAME"] {
            assert!(
                !is_sensitive_env(OsStr::new(key)),
                "`{key}` não é sensível"
            );
        }
    }

    #[test]
    fn finds_commands_in_the_given_directories() {
        let temp = TempDir::new();
        let executable = temp
            .path
            .join(if cfg!(windows) { "python.exe" } else { "python" });
        std::fs::write(&executable, b"fake").expect("criar executável falso");
        let found = find_in_path("python", &[temp.path.clone()]).expect("executável encontrado");
        // Windows matches the name case-insensitively (PATHEXT is uppercase).
        assert_eq!(
            found
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase),
            executable
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase)
        );
        assert!(find_in_path("python3", &[temp.path.clone()]).is_none());
    }

    #[test]
    fn reports_a_friendly_error_when_the_interpreter_is_missing() {
        let settings = Settings::default();
        let python = resolve_interpreter_in(Language::Python, &settings, &[])
            .expect_err("python ausente")
            .to_string();
        assert!(python.contains("Python"));
        assert!(python.contains("Configurações"));

        let node = resolve_interpreter_in(Language::JavaScript, &settings, &[])
            .expect_err("node ausente")
            .to_string();
        assert!(node.contains("Node.js"));
        assert!(node.contains("Configurações"));
    }

    #[test]
    fn uses_the_configured_interpreter_path() {
        let Some(python) = python_available() else {
            eprintln!("Python ausente no PATH: teste de interpretador configurado ignorado");
            return;
        };
        let mut settings = Settings::default();
        settings.code_python_path = python.to_string_lossy().into_owned();
        let resolved =
            resolve_interpreter_in(Language::Python, &settings, &[]).expect("caminho explícito");
        assert_eq!(resolved.source, "settings");
        assert_eq!(resolved.path, python);
        assert!(resolved
            .version
            .to_ascii_lowercase()
            .contains("python"));

        settings.code_python_path = "C:/caminho/que/nao/existe/python.exe".to_string();
        assert!(resolve_interpreter_in(Language::Python, &settings, &[]).is_err());
    }

    #[test]
    fn detects_the_code_environment_status() {
        let temp = TempDir::new();
        let skill_dir = temp.path.join("skills").join("minha-skill");
        std::fs::create_dir_all(&skill_dir).expect("criar skill");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: minha-skill\ndescription: Skill de teste.\n---\ncorpo\n",
        )
        .expect("escrever SKILL.md");

        let mut settings = Settings::default();
        settings.code_execution_enabled = true;
        let status = environment_status_with_roots(&temp.path, &settings, &[]);
        assert!(status.enabled);
        assert_eq!(status.packages.len(), PYTHON_PACKAGES.len());
        assert!(status.packages.iter().any(|package| package.name == "python-docx"));
        assert!(!status.install_hint.is_empty());
        let user_skill = status
            .skills
            .iter()
            .find(|skill| skill.name == "minha-skill")
            .expect("skill do usuário no status");
        assert_eq!(user_skill.source, "user");
        assert!(user_skill.enabled);
        assert!(user_skill.deletable);
        let bundled = status
            .skills
            .iter()
            .find(|skill| skill.source == "bundled")
            .expect("skill embutida no status");
        assert!(!bundled.deletable);

        // `disabled_skills` chega à UI como `enabled: false`, sem sumir da lista.
        settings.disabled_skills = vec!["minha-skill".to_string()];
        let disabled_status = environment_status_with_roots(&temp.path, &settings, &[]);
        let user_skill = disabled_status
            .skills
            .iter()
            .find(|skill| skill.name == "minha-skill")
            .expect("skill desativada continua listada");
        assert!(!user_skill.enabled);
        assert!(user_skill.deletable);

        if python_available().is_some() {
            let python = status.python.expect("Python detectado");
            assert!(!python.version.is_empty());
            assert_eq!(python.source, "path");
            assert!(status.install_hint.contains("pip install"));
        }
    }

    #[test]
    fn code_environment_status_includes_external_skill_roots() {
        let temp = TempDir::new();
        let data_dir = temp.path.join("data");
        std::fs::create_dir_all(&data_dir).expect("criar app-data");
        let agents_root = temp.path.join("agents");
        let skill_dir = agents_root.join("minha-externa");
        std::fs::create_dir_all(&skill_dir).expect("criar skill externa");
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: minha-externa\ndescription: Skill externa de testes.\n---\ncorpo\n",
        )
        .expect("escrever SKILL.md");
        let roots = vec![crate::tools::skills::ExternalSkillRoot {
            source: crate::tools::skills::SkillSource::Agents,
            dir: agents_root,
            plugin_id: None,
        }];

        let status = environment_status_with_roots(&data_dir, &Settings::default(), &roots);
        let external = status
            .skills
            .iter()
            .find(|skill| skill.name == "minha-externa")
            .expect("skill externa no status");
        assert_eq!(external.source, "agents");
        assert!(external.enabled);
        assert!(!external.deletable, "skills externas são somente leitura");
        // As embutidas continuam no status.
        assert!(status.skills.iter().any(|skill| skill.source == "bundled"));
    }

    #[tokio::test]
    async fn environment_is_prepared_for_the_script() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de ambiente ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let code = "import os\n\
                    print(os.environ.get('PYTHONUTF8'), os.environ.get('PYTHONIOENCODING'), \
                    os.environ.get('PYTHONDONTWRITEBYTECODE'), os.environ.get('NODE_NO_WARNINGS'))\n";
        let outcome = run_script(
            &rt,
            Language::Python,
            code,
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(
            outcome.content.contains("1 utf-8 1 1"),
            "ambiente não preparado: {}",
            outcome.content
        );
    }

    #[tokio::test]
    async fn runs_python_and_collects_generated_artifacts() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de execução Python ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let code = r#"
with open('saida.txt', 'w', encoding='utf-8') as handle:
    handle.write('olá mundo')
with open('dados.csv', 'w', encoding='utf-8') as handle:
    handle.write('a,b\n1,2\n')
print('concluído')
"#;
        let outcome = run_script(
            &rt,
            Language::Python,
            code,
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(outcome.content.contains("exit code 0"));
        assert!(outcome.content.contains("concluído"));
        assert_eq!(outcome.artifacts.len(), 2);
        let names: Vec<&str> = outcome
            .artifacts
            .iter()
            .map(|artifact| artifact.name.as_str())
            .collect();
        assert!(names.contains(&"saida.txt"));
        assert!(names.contains(&"dados.csv"));
        assert_eq!(rt.db.list_artifacts("conv-1").expect("db").len(), 2);
        let summary = outcome.summary.clone().unwrap_or_default();
        assert!(summary.starts_with("python"), "summary inesperado: {summary}");

        // The workspace is removed after the run (artifacts are copied first).
        let leftover = std::fs::read_dir(temp.path.join("code-runs"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(leftover, 0);
    }

    #[tokio::test]
    async fn exit_error_keeps_artifacts_and_sets_is_error() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de exit code ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let code = "open('parcial.txt', 'w', encoding='utf-8').write('parcial')\nraise SystemExit(3)\n";
        let outcome = run_script(
            &rt,
            Language::Python,
            code,
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(outcome.is_error);
        assert!(outcome.content.starts_with("ERROR:"));
        assert!(outcome.content.contains("exit code 3"));
        assert_eq!(outcome.artifacts.len(), 1);
        assert_eq!(outcome.artifacts[0].name, "parcial.txt");
        assert!(outcome
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("falhou"));
    }

    #[tokio::test]
    #[ignore = "requires Docker and the node:24-bookworm-slim image"]
    async fn docker_mode_runs_node_and_collects_artifacts() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        rt.settings.execution_environment = "docker".to_string();
        rt.settings.docker_image = "node:24-bookworm-slim".to_string();
        let outcome = run_script(
            &rt,
            Language::JavaScript,
            "import fs from 'node:fs';\n\
             fs.writeFileSync('saida-docker.txt', 'ok');\n\
             console.log('docker-ok');\n",
            Duration::from_secs(90),
            Vec::new(),
        )
        .await
        .expect("executar node no Docker");
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("docker-ok"));
        assert_eq!(outcome.artifacts.len(), 1);
        assert_eq!(outcome.artifacts[0].name, "saida-docker.txt");
    }

    #[tokio::test]
    async fn timeout_kills_the_run() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de timeout ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let started = Instant::now();
        let outcome = run_script(
            &rt,
            Language::Python,
            "import time\nprint('inicio', flush=True)\ntime.sleep(30)\n",
            Duration::from_millis(300),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(outcome.is_error);
        assert!(outcome.content.contains("tempo limite"));
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "o timeout deveria matar o processo rapidamente"
        );
    }

    #[tokio::test]
    async fn cancellation_kills_the_run() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de cancelamento ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let cancel = rt.cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.cancel();
        });
        let started = Instant::now();
        let outcome = run_script(
            &rt,
            Language::Python,
            "import time\ntime.sleep(30)\n",
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(outcome.is_error);
        assert!(outcome.content.contains("cancelad"));
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[tokio::test]
    async fn input_files_are_written_for_the_script() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de inputFiles ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let input_files = vec![InputFile {
            name: "entrada.txt".to_string(),
            content: "olá".to_string(),
        }];
        let code = "texto = open('entrada.txt', encoding='utf-8').read()\n\
                    open('resultado.txt', 'w', encoding='utf-8').write(texto.upper())\n";
        let outcome = run_script(
            &rt,
            Language::Python,
            code,
            Duration::from_secs(60),
            input_files,
        )
        .await
        .expect("executar python");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert_eq!(outcome.artifacts.len(), 1);
        assert_eq!(outcome.artifacts[0].name, "resultado.txt");
        let bytes = read_artifact_bytes(&rt, &outcome.artifacts[0]);
        assert_eq!(String::from_utf8_lossy(&bytes), "OLÁ");
    }

    #[tokio::test]
    async fn dangerous_input_names_stay_inside_the_workspace() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de nome perigoso ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let input_files = vec![InputFile {
            name: "../../fora.txt".to_string(),
            content: "ok".to_string(),
        }];
        let outcome = run_script(
            &rt,
            Language::Python,
            "print(open('fora.txt', encoding='utf-8').read())\n",
            Duration::from_secs(60),
            input_files,
        )
        .await
        .expect("executar python");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(outcome.content.contains("stdout:\nok"));
        assert!(outcome.artifacts.is_empty());
    }

    #[tokio::test]
    async fn output_is_capped_and_keeps_the_tail() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de teto de saída ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let code = "import sys\nsys.stdout.write('A' * 100000)\nsys.stdout.write('\\nFIM\\n')\n";
        let outcome = run_script(
            &rt,
            Language::Python,
            code,
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(outcome.content.contains("FIM"));
        assert!(outcome.content.contains("stdout truncado"));
        assert!(
            outcome.content.chars().count() < 60_000,
            "o resultado precisa ser limitado, veio com {} chars",
            outcome.content.chars().count()
        );
    }

    #[tokio::test]
    async fn integration_script_generates_a_docx() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de integração DOCX ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let code = r#"
import zipfile

document = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Relatório de teste</w:t></w:r></w:p></w:body></w:document>'''
content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
with zipfile.ZipFile('relatorio.docx', 'w', zipfile.ZIP_DEFLATED) as package:
    package.writestr('[Content_Types].xml', content_types)
    package.writestr('_rels/.rels', rels)
    package.writestr('word/document.xml', document)
print('docx ok')
"#;
        let outcome = run_script(
            &rt,
            Language::Python,
            code,
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar python");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert_eq!(outcome.artifacts.len(), 1);
        let artifact = &outcome.artifacts[0];
        assert_eq!(artifact.name, "relatorio.docx");
        assert_eq!(artifact.kind, crate::domain::ArtifactKind::Docx);
        let bytes = read_artifact_bytes(&rt, artifact);
        assert!(
            bytes.starts_with(b"PK\x03\x04"),
            "a saída deve ser um container ZIP/OOXML válido"
        );
        // Integração criação→preview: o parser de DOCX do app lê o arquivo.
        let html = crate::documents::preview::docx_html(&bytes)
            .expect("o preview de DOCX deve ler o arquivo gerado");
        assert!(
            html.contains("Relatório de teste"),
            "HTML do preview inesperado: {html}"
        );
    }

    #[tokio::test]
    async fn integration_skill_helper_generates_a_docx_readable_by_preview() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste de integração com skill ignorado");
            return;
        }
        let temp = TempDir::new();
        let skill = match crate::tools::skills::read(&temp.path, "office-docx") {
            Ok(Some(skill)) => skill,
            Ok(None) => {
                eprintln!("skill `office-docx` ausente no build: teste de integração ignorado");
                return;
            }
            Err(error) => {
                eprintln!("catálogo de skills indisponível ({error:#}): teste ignorado");
                return;
            }
        };
        let helper = skill.dir.join("scripts").join("make_docx.py");
        if !helper.is_file() {
            eprintln!(
                "helper `{}` ausente: teste de integração ignorado",
                helper.display()
            );
            return;
        }

        let rt = runtime(&temp);
        let spec = json!({
            "title": "Relatório da skill",
            "subtitle": "Gerado por run_code",
            "blocks": [
                {"type": "heading", "level": 1, "text": "Visão geral"},
                {"type": "paragraph", "text": "Conteúdo gerado pelo helper stdlib."}
            ]
        });
        let input_files = vec![InputFile {
            name: "spec.json".to_string(),
            content: serde_json::to_string_pretty(&spec).expect("serializar spec"),
        }];
        let helper = helper.to_string_lossy().replace('\\', "/");
        let code = format!(
            "import subprocess, sys\n\
             result = subprocess.run([sys.executable, \"{helper}\", '--spec', 'spec.json', '--out', 'relatorio.docx'])\n\
             print('helper exit', result.returncode)\n\
             sys.exit(result.returncode)\n"
        );
        let outcome = run_script(
            &rt,
            Language::Python,
            &code,
            Duration::from_secs(120),
            input_files,
        )
        .await
        .expect("executar helper da skill");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        let artifact = outcome
            .artifacts
            .iter()
            .find(|artifact| artifact.name == "relatorio.docx")
            .expect("artefato relatorio.docx");
        assert_eq!(artifact.kind, crate::domain::ArtifactKind::Docx);
        let bytes = read_artifact_bytes(&rt, artifact);
        let html = crate::documents::preview::docx_html(&bytes)
            .expect("o preview de DOCX deve ler o arquivo do helper");
        assert!(
            html.contains("Relatório da skill"),
            "HTML do preview inesperado: {html}"
        );
        assert!(html.contains("Visão geral"), "HTML do preview inesperado: {html}");
    }

    #[tokio::test]
    async fn runs_javascript_when_node_is_available() {
        if node_available().is_none() {
            eprintln!("Node.js ausente no PATH: teste de execução JavaScript ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let code = "import { writeFileSync } from 'node:fs';\n\
                    writeFileSync('saida.json', JSON.stringify({ ok: true }));\n\
                    console.log('js ok');\n";
        let outcome = run_script(
            &rt,
            Language::JavaScript,
            code,
            Duration::from_secs(60),
            Vec::new(),
        )
        .await
        .expect("executar node");

        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(outcome.content.contains("js ok"));
        assert_eq!(outcome.artifacts.len(), 1);
        assert_eq!(outcome.artifacts[0].name, "saida.json");
        assert_eq!(outcome.artifacts[0].kind, crate::domain::ArtifactKind::Json);
    }

    #[tokio::test]
    async fn public_run_executes_and_collects_artifacts() {
        if python_available().is_none() {
            eprintln!("Python ausente no PATH: teste público de run_code ignorado");
            return;
        }
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let outcome = run(
            &rt,
            &json!({
                "language": "python",
                "code": "open('publico.txt', 'w', encoding='utf-8').write('ok')",
                "timeoutMs": 30_000,
                "inputFiles": [{"name": "spec.json", "content": "{\"ok\": true}"}]
            }),
        )
        .await;
        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert_eq!(outcome.artifacts.len(), 1);
        assert_eq!(outcome.artifacts[0].name, "publico.txt");
        assert!(outcome.content.contains("exit code 0"));
    }

    #[tokio::test]
    async fn public_run_requires_the_setting_and_validates_arguments() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);

        rt.settings.code_execution_enabled = false;
        let disabled = run(&rt, &json!({"language": "python", "code": "print(1)"})).await;
        assert!(disabled.is_error);
        assert!(disabled.content.contains("desativada"));

        rt.settings.code_execution_enabled = true;
        let bad_language = run(&rt, &json!({"language": "ruby", "code": "x"})).await;
        assert!(bad_language.is_error);
        assert!(bad_language.content.contains("não suportada"));

        let missing_code = run(&rt, &json!({"language": "python"})).await;
        assert!(missing_code.is_error);
        assert!(missing_code.content.contains("`code`"));

        let big_code = "x".repeat(MAX_CODE_BYTES + 1);
        let too_big = run(&rt, &json!({"language": "python", "code": big_code})).await;
        assert!(too_big.is_error);
        assert!(too_big.content.contains("100 KB"));
    }

    #[test]
    fn formats_durations_and_plurals() {
        assert_eq!(format_duration(Duration::from_millis(250)), "250 ms");
        assert_eq!(format_duration(Duration::from_millis(1_234)), "1,23 s");
        assert_eq!(
            t_count(
                "tools.code_exec.summarySuccess",
                1,
                &[("language", "py"), ("count", "1"), ("duration", "0 ms")],
            ),
            "py · 1 arquivo · 0 ms"
        );
        assert_eq!(
            t_count(
                "tools.code_exec.summarySuccess",
                3,
                &[("language", "py"), ("count", "3"), ("duration", "0 ms")],
            ),
            "py · 3 arquivos · 0 ms"
        );
    }
}
