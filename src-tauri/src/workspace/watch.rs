//! Filesystem watcher of the Code workspace panel.
//!
//! Contract: `docs/goals/code-harness/HARNESS.md` §7.5. The native backend
//! (`notify`: `ReadDirectoryChangesW` on Windows, FSEvents on macOS, inotify on
//! Linux) feeds a coalescing thread that debounces bursts, drops build/dependency
//! noise and emits at most one event per second. The event is only a "something
//! changed" hint: every state read (tree, `git status`, diff) is redone by the
//! commands when the renderer asks.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;

/// Tauri event emitted to the renderer when the workspace changes.
pub const WORKSPACE_CHANGED_EVENT: &str = "zylara:workspace-changed";
/// Quiet window: raw OS events are drained until they stop for this long.
pub const DEBOUNCE: Duration = Duration::from_millis(400);
/// Floor between two emitted batches (HARNESS §7.5: at most one event/second).
pub const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(1000);
/// Paths cap of one payload; above it the renderer reloads everything.
pub const MAX_BATCH_PATHS: usize = 200;
/// Raw paths accumulated in a single batch before flagging an overflow.
const MAX_RAW_PATHS: usize = 4096;
/// Polling interval of the fallback backend (network shares, inotify limits).
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Directories whose contents never change the Files/Changes panel.
const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
];

/// Files inside `.git` that do change the branch/index status shown by the UI.
const GIT_ALLOWED_FILES: &[&str] = &["HEAD", "MERGE_HEAD", "ORIG_HEAD", "index", "packed-refs"];

/// Coalesced batch of workspace changes handed to the command layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangedEvent {
    pub workspace_id: String,
    /// Workspace-relative paths, always with `/`.
    pub paths: Vec<String>,
    /// The OS buffer was lost or the batch was truncated: reload everything.
    pub overflow: bool,
}

/// `true` when a workspace-relative path (always `/`) must reach the renderer.
pub fn should_report(relative: &str) -> bool {
    if relative.is_empty() || relative == ".git" {
        return false;
    }
    if let Some(rest) = relative.strip_prefix(".git/") {
        return rest.starts_with("refs/")
            || rest.starts_with("worktrees/")
            || GIT_ALLOWED_FILES.contains(&rest);
    }
    !relative.split('/').any(|part| EXCLUDED_DIRS.contains(&part))
}

/// Watchers indexed by workspace id; one workspace is watched at a time in
/// practice (the renderer starts the active one and stops it on unmount).
#[derive(Default)]
pub struct WorkspaceWatchRegistry {
    handles: Mutex<HashMap<String, WatchHandle>>,
}

impl WorkspaceWatchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts the watcher of `workspace_id`, replacing a previous one whose root
    /// differs. Idempotent: the same root returns `Ok(false)`.
    pub fn start<F>(&self, workspace_id: &str, root: &Path, emit: F) -> anyhow::Result<bool>
    where
        F: Fn(WorkspaceChangedEvent) + Send + 'static,
    {
        let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        {
            let handles = self.handles.lock();
            if let Some(existing) = handles.get(workspace_id) {
                if existing.root == root {
                    return Ok(false);
                }
            }
        }
        // Drop the previous watcher outside the lock: dropping joins the
        // coalescer thread, which may wait for one debounce window.
        let previous = self.handles.lock().remove(workspace_id);
        drop(previous);

        let handle = WatchHandle::start(workspace_id, &root, emit)?;
        let replaced = self.handles.lock().insert(workspace_id.to_string(), handle);
        drop(replaced);
        Ok(true)
    }

    /// Stops the watcher of `workspace_id` (no-op when absent).
    pub fn stop(&self, workspace_id: &str) {
        let previous = self.handles.lock().remove(workspace_id);
        drop(previous);
    }
}

struct WatchHandle {
    root: PathBuf,
    backend: Option<Backend>,
    worker: Option<JoinHandle<()>>,
}

enum Backend {
    Native(notify::RecommendedWatcher),
    Poll(notify::PollWatcher),
}

impl WatchHandle {
    fn start<F>(workspace_id: &str, root: &Path, emit: F) -> anyhow::Result<Self>
    where
        F: Fn(WorkspaceChangedEvent) + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let backend = build_backend(root, &tx)?;
        // Only the backend keeps a sender from now on, so dropping the watcher
        // disconnects the channel and lets the coalescer thread exit.
        drop(tx);

        let root_owned = root.to_path_buf();
        let workspace_id = workspace_id.to_string();
        let worker = thread::Builder::new()
            .name(format!("zylara-watch-{workspace_id}"))
            .spawn(move || coalesce(root_owned, workspace_id, rx, emit))?;
        Ok(Self {
            root: root.to_path_buf(),
            backend: Some(backend),
            worker: Some(worker),
        })
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        // Drop the watcher first: its callback owns the channel sender, so the
        // coalescer thread observes a disconnect and exits instead of hanging.
        drop(self.backend.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn build_backend(root: &Path, tx: &Sender<notify::Result<Event>>) -> anyhow::Result<Backend> {
    let native_handler = {
        let tx = tx.clone();
        move |result: notify::Result<Event>| {
            let _ = tx.send(result);
        }
    };
    if let Ok(mut watcher) = notify::recommended_watcher(native_handler) {
        if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
            return Ok(Backend::Native(watcher));
        }
    }

    // Network shares without change notifications and inotify watch limits fall
    // back to polling; slower, but keeps the panel live instead of dead.
    let poll_handler = {
        let tx = tx.clone();
        move |result: notify::Result<Event>| {
            let _ = tx.send(result);
        }
    };
    let config = notify::Config::default().with_poll_interval(POLL_INTERVAL);
    let mut watcher = notify::PollWatcher::new(poll_handler, config)?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(Backend::Poll(watcher))
}

#[derive(Default)]
struct Batch {
    paths: Vec<PathBuf>,
    overflow: bool,
}

impl Batch {
    fn absorb(&mut self, result: notify::Result<Event>) {
        match result {
            Err(_) => self.overflow = true,
            Ok(event) => {
                // Reads never change what the panel shows.
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    if self.paths.len() >= MAX_RAW_PATHS {
                        self.overflow = true;
                        return;
                    }
                    self.paths.push(path);
                }
            }
        }
    }

    fn into_event(
        self,
        workspace_id: &str,
        root: &Path,
        gitignore: &Gitignore,
    ) -> WorkspaceChangedEvent {
        let mut overflow = self.overflow;
        let mut seen = HashSet::new();
        let mut paths = Vec::new();
        for path in &self.paths {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if relative.is_empty() {
                // The watched root itself changed: nothing specific to reload.
                overflow = true;
                continue;
            }
            if !should_report(&relative) {
                continue;
            }
            if gitignore.matched_path_or_any_parents(path, false).is_ignore() {
                continue;
            }
            if !seen.insert(relative.clone()) {
                continue;
            }
            if paths.len() >= MAX_BATCH_PATHS {
                overflow = true;
                break;
            }
            paths.push(relative);
        }
        WorkspaceChangedEvent {
            workspace_id: workspace_id.to_string(),
            paths,
            overflow,
        }
    }
}

/// Reloads the watcher matcher and forces a full panel refresh whenever ignore
/// rules change. A stale matcher could hide the very event that reconciles
/// newly ignored or newly visible files.
fn batch_changes_ignore_rules(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| {
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == ".gitignore")
        {
            return true;
        }
        let parts: Vec<_> = path.components().filter_map(|part| part.as_os_str().to_str()).collect();
        parts.len() >= 3
            && parts[parts.len() - 3] == ".git"
            && parts[parts.len() - 2] == "info"
            && parts[parts.len() - 1] == "exclude"
    })
}

/// Coalescing loop: quiet-window debounce, dedupe/filter and emission rate cap.
fn coalesce<F>(root: PathBuf, workspace_id: String, rx: Receiver<notify::Result<Event>>, emit: F)
where
    F: Fn(WorkspaceChangedEvent),
{
    let mut gitignore = root_gitignore(&root);
    let mut pending = Batch::default();
    let mut last_emit: Option<Instant> = None;

    loop {
        // Block until the first raw event (or the watcher being dropped).
        match rx.recv() {
            Ok(result) => pending.absorb(result),
            Err(_) => break,
        }
        // Drain the burst until it stays quiet for one debounce window.
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(result) => pending.absorb(result),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        if pending.paths.is_empty() && !pending.overflow {
            pending = Batch::default();
            continue;
        }
        if let Some(last) = last_emit {
            let elapsed = last.elapsed();
            if elapsed < MIN_EMIT_INTERVAL {
                thread::sleep(MIN_EMIT_INTERVAL - elapsed);
            }
        }

        let ignore_rules_changed = batch_changes_ignore_rules(&pending.paths);
        if ignore_rules_changed {
            gitignore = root_gitignore(&root);
            pending.overflow = true;
        }
        let event = pending.into_event(&workspace_id, &root, &gitignore);
        pending = Batch::default();
        if event.paths.is_empty() && !event.overflow {
            continue;
        }
        emit(event);
        last_emit = Some(Instant::now());
    }
}

/// Matcher of the repository root `.gitignore` (nested ignore files are not
/// matched; worst case is one harmless extra refresh).
fn root_gitignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    let _ = builder.add(root.join(".gitignore"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn ignore_rule_changes_force_a_full_refresh() {
        let temp = tempfile::tempdir().expect("tempdir");
        assert!(batch_changes_ignore_rules(&[
            temp.path().join(".gitignore"),
            temp.path().join("src/.gitignore"),
            temp.path().join(".git/info/exclude"),
        ]));
        assert!(!batch_changes_ignore_rules(&[temp.path().join("src/main.rs")]));
    }

    #[test]
    fn filter_excludes_build_and_dependency_dirs() {
        assert!(!should_report("node_modules/x.js"));
        assert!(!should_report("target/debug/app.exe"));
        assert!(!should_report("dist/a.js"));
        assert!(!should_report("src/__pycache__/a.pyc"));
        assert!(!should_report("apps/web/.next/page.js"));
        assert!(should_report("src/main.rs"));
        assert!(should_report("README.md"));
        assert!(should_report(".gitignore"));
    }

    #[test]
    fn filter_allows_only_git_state_files() {
        assert!(should_report(".git/HEAD"));
        assert!(should_report(".git/index"));
        assert!(should_report(".git/refs/heads/main"));
        assert!(!should_report(".git/objects/ab/cd"));
        assert!(!should_report(".git"));
        assert!(!should_report("src/.git/config"));
    }

    #[test]
    fn event_serializes_camel_case() {
        let value = serde_json::to_value(WorkspaceChangedEvent {
            workspace_id: "ws-1".to_string(),
            paths: vec!["src/main.rs".to_string()],
            overflow: false,
        })
        .expect("serialize event");
        assert_eq!(value["workspaceId"], "ws-1");
        assert_eq!(value["paths"][0], "src/main.rs");
        assert_eq!(value["overflow"], false);
    }

    #[test]
    fn registry_start_is_idempotent_and_stop_releases() {
        let temp = tempfile::tempdir().expect("tempdir");
        let registry = WorkspaceWatchRegistry::new();

        assert!(registry
            .start("ws", temp.path(), |_| {})
            .expect("start watcher"));
        assert!(!registry
            .start("ws", temp.path(), |_| {})
            .expect("second start"));
        registry.stop("ws");
        assert!(registry
            .start("ws", temp.path(), |_| {})
            .expect("restart after stop"));
        registry.stop("ws");
    }

    #[test]
    fn ignore_rule_edit_delivers_an_overflow_batch() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (tx, rx) = mpsc::channel();
        let registry = WorkspaceWatchRegistry::new();
        registry
            .start("ws", temp.path(), move |event| {
                let _ = tx.send(event);
            })
            .expect("start watcher");
        std::fs::write(temp.path().join(".gitignore"), "ignored.txt\n").expect("gitignore");
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("workspace-changed event");
        assert!(event.overflow, "{event:?}");
        registry.stop("ws");
    }

    #[test]
    fn delivers_a_batch_for_created_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let (tx, rx) = mpsc::channel();
        let registry = WorkspaceWatchRegistry::new();
        registry
            .start("ws", temp.path(), move |event| {
                let _ = tx.send(event);
            })
            .expect("start watcher");

        std::fs::write(temp.path().join("novo.txt"), "x").expect("write file");
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("workspace-changed event");

        assert_eq!(event.workspace_id, "ws");
        // macOS FSEvents may report only the directory (batch flagged as
        // overflow); either way the renderer is told something changed.
        assert!(!event.paths.is_empty() || event.overflow, "{event:?}");
        registry.stop("ws");
    }
}
