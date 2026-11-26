//! Operações de git via CLI do usuário.
//!
//! Decisão (docs/research/workspace-runtime-options.md §1): usar o `git` instalado, com
//! argv explícito, env higienizado e saída limitada. Sem libgit2/gix na v1 — hooks,
//! filtros, LFS, worktrees e configuração do usuário só o binário real reproduz.
//! Git ausente ou diretório sem repo **degrada** (`is_repo = false`), sem quebrar o harness.

#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::exec::{self, ExecError, ExecOutput, ExecRequest};
use crate::domain::ChangesSummary;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Network operations (fetch/pull/push) need more slack than local commands.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
const STATUS_CAP: usize = 4 * 1024 * 1024;
const DIFF_CAP: usize = 4 * 1024 * 1024;
const TEXT_CAP: usize = 1024 * 1024;
/// Upper bound of new files whose synthetic diff enters the commit context.
const MAX_UNTRACKED_FILES: usize = 5;
/// Per-file byte budget for a synthetic untracked diff.
const UNTRACKED_FILE_BUDGET: usize = 4_000;

/// Arquivo com status do git (path relativo ao root, com `/`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitFile {
    pub path: String,
    /// Código de status de um caractere (`M`, `A`, `D`, `R`, `C`, `T`, `U`…).
    pub status: String,
}

/// Estado agregado do repositório para o painel Git.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<PathBuf>,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFile>,
    pub unstaged: Vec<GitFile>,
    pub untracked: Vec<String>,
    pub conflicted: Vec<String>,
}

/// Which changes the commit diff context must describe.
#[derive(Debug, Clone, Copy)]
pub enum CommitDiffScope<'a> {
    /// Everything that `git add -A` would commit.
    All,
    /// Only what is already in the index.
    Staged(&'a [String]),
    /// Only the selected paths, staged and unstaged.
    Selection(&'a [String]),
}

/// Entrada de `git log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

/// Detecta repo/estado. Nunca retorna erro: fora de repo devolve `is_repo = false`.
pub async fn detect(root: &Path) -> GitStatus {
    let mut status = GitStatus::default();
    let Ok(toplevel) = run_git_checked(root, &["rev-parse", "--show-toplevel"], TEXT_CAP).await
    else {
        return status;
    };
    let toplevel = toplevel.stdout.trim();
    if toplevel.is_empty() {
        return status;
    }
    status.is_repo = true;
    status.root = Some(PathBuf::from(toplevel));

    let Ok(out) =
        run_git_checked(root, &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], STATUS_CAP)
            .await
    else {
        // Repo detectado mas status falhou (lock/índice): devolve o que sabemos.
        return status;
    };
    parse_status(&out.stdout, &mut status);
    status
}

/// `true` quando `root` está dentro de um repositório git.
pub async fn is_repo(root: &Path) -> bool {
    matches!(
        run_git_capture(root, &["rev-parse", "--show-toplevel"], TEXT_CAP).await,
        Ok(output) if output.exit_code == Some(0)
    )
}

/// `true` quando o repositório já tem um commit (`HEAD` resolvível).
pub async fn has_head(root: &Path) -> bool {
    matches!(
        run_git_capture(root, &["rev-parse", "--verify", "--quiet", "HEAD"], TEXT_CAP).await,
        Ok(output) if output.exit_code == Some(0)
    )
}

/// Workspace-relative paths that Git currently treats as ignored.
///
/// `git check-ignore` is the source of truth for nested ignore files, global
/// excludes, negations and worktrees. It also keeps tracked/indexed paths
/// visible. Any Git or path error fails open so review never disappears just
/// because the optional Git integration is unavailable.
pub async fn ignored_paths(
    workspace_root: &Path,
    repo_root: &Path,
    paths: &[String],
) -> HashSet<String> {
    if paths.is_empty() {
        return HashSet::new();
    }
    let Some(workspace) = lexical_absolute(workspace_root) else {
        return HashSet::new();
    };
    let Some(repo) = lexical_absolute(repo_root) else {
        return HashSet::new();
    };
    let mut candidates: Vec<(String, OsString)> = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        if path.is_empty() || path.contains('\0') {
            continue;
        }
        let raw = Path::new(path);
        if raw.is_absolute() {
            continue;
        }
        let normalized = match normalize_relative(raw) {
            Some(path) => path,
            None => continue,
        };
        let key = normalized.to_string_lossy().replace('\\', "/");
        if !seen.insert(key.clone()) {
            continue;
        }
        let absolute = workspace.join(&normalized);
        let Ok(relative) = absolute.strip_prefix(&repo) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        candidates.push((key, relative.as_os_str().to_os_string()));
    }
    if candidates.is_empty() {
        return HashSet::new();
    }

    let mut stdin = Vec::new();
    for (_, relative) in &candidates {
        stdin.extend_from_slice(relative.as_encoded_bytes());
        stdin.push(0);
    }
    let mut request = git_request(
        &repo,
        &["check-ignore", "-z", "--stdin", "-v", "--"],
        STATUS_CAP,
    );
    request.stdin = Some(stdin);
    let output = match exec::run(request, None).await {
        Ok(output) => output,
        Err(error) => {
            eprintln!("zylara: git check-ignore unavailable: {error}");
            return HashSet::new();
        }
    };
    if output.timed_out || output.cancelled || output.truncated {
        eprintln!("zylara: git check-ignore incomplete; keeping changes visible");
        return HashSet::new();
    }
    if output.exit_code == Some(1) {
        return HashSet::new();
    }
    if output.exit_code != Some(0) {
        eprintln!(
            "zylara: git check-ignore failed; keeping changes visible: {}",
            output.stderr.trim()
        );
        return HashSet::new();
    }

    let tokens: Vec<&str> = output.stdout.split('\0').collect();
    let mut ignored_names: HashSet<OsString> = HashSet::new();
    for fields in tokens.chunks_exact(4) {
        // With `-v`, a last-matching negation (`!pattern`) is printed too, but
        // it means the path is NOT ignored.
        if !fields[2].starts_with('!') && !fields[3].is_empty() {
            ignored_names.insert(OsString::from(fields[3]));
        }
    }
    candidates
        .into_iter()
        .filter(|(_, relative)| ignored_names.contains(relative))
        .map(|(key, _)| key)
        .collect()
}

/// Recomputes summary totals after removing paths hidden by Git ignore rules.
pub async fn filter_changes_summary(
    mut summary: ChangesSummary,
    workspace_root: &Path,
) -> ChangesSummary {
    let paths: Vec<String> = summary.files.iter().map(|file| file.path.clone()).collect();
    let repo_root = detect(workspace_root).await;
    let root = repo_root.root.as_deref().unwrap_or(workspace_root);
    let ignored = ignored_paths(workspace_root, root, &paths).await;
    if ignored.is_empty() {
        return summary;
    }
    summary.files.retain(|file| !ignored.contains(&file.path));
    summary.added = summary.files.iter().map(|file| file.added).sum();
    summary.removed = summary.files.iter().map(|file| file.removed).sum();
    summary
}

fn lexical_absolute(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Some(out)
}

fn normalize_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return None,
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// `true` quando o caminho está no índice (arquivo rastreado pelo git).
pub async fn is_tracked(root: &Path, relative: &str) -> bool {
    match run_git_capture(
        root,
        &["ls-files", "--error-unmatch", "--", relative],
        TEXT_CAP,
    )
    .await
    {
        // Na dúvida (git indisponível/erro), assume rastreado para nunca
        // fabricar um diff de "arquivo novo" em cima de um arquivo existente.
        Ok(output) => output.exit_code == Some(0),
        Err(_) => true,
    }
}

/// Diff sintético de um arquivo **não rastreado** (novo): o `git diff` normal
/// não mostra untracked, então montamos o patch "new file" a partir do conteúdo
/// — é o que a aba Alterações precisa para exibir `A` + diff sem staging.
pub fn untracked_diff(root: &Path, relative: &str, max_bytes: usize) -> Result<String, ExecError> {
    let full = root.join(relative);
    let metadata = std::fs::metadata(&full).map_err(|error| {
        ExecError::failed(
            format!("não foi possível ler `{relative}`: {error}"),
            None,
        )
    })?;
    if !metadata.is_file() {
        return Err(ExecError::failed(
            format!("`{relative}` não é um arquivo"),
            None,
        ));
    }
    let cap = if max_bytes == 0 { DIFF_CAP } else { max_bytes };
    if metadata.len() > cap as u64 {
        return Err(ExecError::failed(
            format!("`{relative}` é grande demais para o diff ({cap} bytes)"),
            None,
        ));
    }
    let bytes = std::fs::read(&full).map_err(|error| {
        ExecError::failed(
            format!("não foi possível abrir `{relative}`: {error}"),
            None,
        )
    })?;
    let path = relative.replace('\\', "/");
    let mut diff = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    if bytes.iter().take(8_000).any(|byte| *byte == 0) {
        diff.push_str(&format!("Binary files /dev/null and b/{path} differ\n"));
        return Ok(diff);
    }
    let text = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
    let ends_with_newline = text.ends_with('\n');
    let mut lines: Vec<&str> = text.split('\n').collect();
    if ends_with_newline {
        lines.pop();
    }
    let total = lines.len();
    if total > 0 {
        diff.push_str(&format!("@@ -0,0 +1,{total} @@\n"));
        for line in &lines {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        if !ends_with_newline {
            diff.push_str("\\ No newline at end of file\n");
        }
    }
    Ok(diff)
}

/// Diff textual do working tree (ou do índice com `staged`), por path.
pub async fn diff(
    root: &Path,
    paths: &[String],
    staged: bool,
    context: u32,
    max_bytes: usize,
) -> Result<String, ExecError> {
    let unified = format!("--unified={context}");
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", &unified];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    for path in paths {
        args.push(path.as_str());
    }
    let cap = if max_bytes == 0 { DIFF_CAP } else { max_bytes };
    let output = run_git_checked(root, &args, cap).await?;
    let mut text = output.stdout;
    if output.truncated {
        text.push_str("\n[diff truncado pelo limite de saída]\n");
    }
    Ok(text)
}

/// Textual diff context for the commit message suggestion.
///
/// `All` mirrors `git add -A` (index + working tree + untracked), `Staged`
/// mirrors the existing index, and `Selection` mirrors staging only the given
/// paths. Never uses `git diff HEAD`, so an unborn HEAD still works.
pub async fn commit_diff(
    root: &Path,
    status: &GitStatus,
    scope: CommitDiffScope<'_>,
    max_bytes: usize,
) -> Result<String, ExecError> {
    let mut sections: Vec<String> = Vec::new();
    match scope {
        CommitDiffScope::All => {
            let staged = diff(root, &[], true, 1, max_bytes).await?;
            if !staged.trim().is_empty() {
                sections.push(format!("Staged changes:\n{staged}"));
            }
            let unstaged = diff(root, &[], false, 1, max_bytes).await?;
            if !unstaged.trim().is_empty() {
                sections.push(format!("Unstaged changes:\n{unstaged}"));
            }
            append_untracked_diffs(root, status.untracked.iter().cloned(), &mut sections);
        }
        CommitDiffScope::Staged(paths) => {
            let staged = diff(root, paths, true, 1, max_bytes).await?;
            if !staged.trim().is_empty() {
                sections.push(format!("Staged changes:\n{staged}"));
            }
        }
        CommitDiffScope::Selection(paths) => {
            let staged = diff(root, paths, true, 1, max_bytes).await?;
            if !staged.trim().is_empty() {
                sections.push(format!("Staged changes:\n{staged}"));
            }
            let unstaged = diff(root, paths, false, 1, max_bytes).await?;
            if !unstaged.trim().is_empty() {
                sections.push(format!("Unstaged changes:\n{unstaged}"));
            }
            let selected: HashSet<&str> = paths.iter().map(String::as_str).collect();
            append_untracked_diffs(
                root,
                status
                    .untracked
                    .iter()
                    .filter(|path| selected.contains(path.as_str()))
                    .cloned(),
                &mut sections,
            );
        }
    }
    let mut text = sections.join("\n\n");
    truncate_utf8(&mut text, max_bytes);
    Ok(text)
}

fn append_untracked_diffs(
    root: &Path,
    paths: impl IntoIterator<Item = String>,
    sections: &mut Vec<String>,
) {
    let mut paths: Vec<String> = paths.into_iter().collect();
    paths.sort();
    paths.dedup();
    for path in paths.into_iter().take(MAX_UNTRACKED_FILES) {
        let section = match untracked_diff(root, &path, UNTRACKED_FILE_BUDGET) {
            Ok(text) if !text.trim().is_empty() => format!("New file: {path}\n{text}"),
            Ok(_) => continue,
            Err(error) => format!("New file: {path} (content unavailable: {})", error.message),
        };
        sections.push(section);
    }
}

fn truncate_utf8(text: &mut String, max_bytes: usize) {
    if max_bytes == 0 || text.len() <= max_bytes {
        return;
    }
    let mut boundary = max_bytes;
    while boundary > 0 && !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    text.truncate(boundary);
    text.push_str("\n[diff truncated]\n");
}

/// Added/removed lines for one file in the working tree (or the index when
/// `staged`), as shown by the `+N −M` counters of the Changes panel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GitLineStat {
    pub added: u32,
    pub removed: u32,
}

/// Per-file stats of the current diff (`git diff --numstat -z`).
///
/// Renames/copies are keyed by the **new path** (the same one
/// `status --porcelain=v2` exposes); binaries map to `0/0`.
pub async fn diff_stats(
    root: &Path,
    staged: bool,
) -> Result<HashMap<String, GitLineStat>, ExecError> {
    let mut args: Vec<&str> = vec!["diff", "--numstat", "-z", "--no-color", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    let output = run_git_checked(root, &args, DIFF_CAP).await?;
    Ok(parse_numstat_z(&output.stdout))
}

/// Parses `git diff --numstat -z`.
///
/// Normal record: `added\tremoved\tpath\0`. Rename/copy: `added\tremoved\t\0`
/// followed by `old_path\0new_path\0`. `-` (binary) becomes `0`.
fn parse_numstat_z(raw: &str) -> HashMap<String, GitLineStat> {
    let tokens: Vec<&str> = raw.split('\0').collect();
    let mut stats = HashMap::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token.is_empty() {
            continue;
        }
        let mut fields = token.splitn(3, '\t');
        let Some(added) = fields.next() else { continue };
        let Some(removed) = fields.next() else {
            continue;
        };
        let Some(path) = fields.next() else { continue };
        let stat = GitLineStat {
            added: parse_numstat_count(added),
            removed: parse_numstat_count(removed),
        };
        if path.is_empty() {
            // Rename/copy: both paths come in separate tokens.
            let Some(_old_path) = tokens.get(index) else {
                break;
            };
            index += 1;
            let Some(new_path) = tokens.get(index) else {
                break;
            };
            index += 1;
            if !new_path.is_empty() {
                stats.insert((*new_path).to_string(), stat);
            }
        } else {
            stats.insert(path.to_string(), stat);
        }
    }
    stats
}

fn parse_numstat_count(raw: &str) -> u32 {
    raw.trim().parse().unwrap_or(0)
}

/// Um arquivo alterado entre uma branch (merge-base) e a working tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCompareFile {
    pub path: String,
    /// Código de status (`M`, `A`, `D`, `R`, `C`, `T`).
    pub status: String,
    pub added: u32,
    pub removed: u32,
}

/// Rejects refs that could be parsed as git options or span multiple argv
/// entries. Branch/hash names never contain whitespace, so this is strict.
pub fn validate_ref(reference: &str) -> Result<(), String> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return Err("referência git vazia".to_string());
    }
    if trimmed.len() > 200 {
        return Err("referência git longa demais".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("referência git inválida".to_string());
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("referência git inválida".to_string());
    }
    Ok(())
}

/// Common ancestor between `base` and `HEAD` (`git merge-base <base> HEAD`).
pub async fn merge_base(root: &Path, base: &str) -> Result<String, ExecError> {
    let output = run_git_checked(root, &["merge-base", base, "HEAD"], TEXT_CAP).await?;
    let hash = output.stdout.trim().to_string();
    if hash.is_empty() {
        return Err(ExecError::failed(
            "não foi possível calcular a base comum com a branch",
            None,
        ));
    }
    Ok(hash)
}

/// Parses `git diff --name-status -z`.
///
/// Normal record: `status\0path\0`. Rename/copy with `-z`:
/// `R100\0old_path\0new_path\0`; the new path is the one the UI shows.
fn parse_name_status_z(raw: &str) -> Vec<GitFile> {
    let tokens: Vec<&str> = raw.split('\0').collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let status = tokens[index].trim();
        index += 1;
        if status.is_empty() {
            continue;
        }
        let Some(path) = tokens.get(index) else {
            break;
        };
        index += 1;
        if path.is_empty() {
            continue;
        }
        let letter = status
            .chars()
            .next()
            .unwrap_or('M')
            .to_string();
        let path = if matches!(letter.as_str(), "R" | "C") {
            let Some(new_path) = tokens.get(index) else {
                break;
            };
            index += 1;
            (*new_path).to_string()
        } else {
            (*path).to_string()
        };
        if !path.is_empty() {
            files.push(GitFile { path, status: letter });
        }
    }
    files
}

/// Arquivos alterados entre `base` e a working tree (por status).
pub async fn diff_ref_name_status(root: &Path, base: &str) -> Result<Vec<GitFile>, ExecError> {
    let output = run_git_checked(
        root,
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-color",
            "--no-ext-diff",
            base,
            "--",
        ],
        STATUS_CAP,
    )
    .await?;
    Ok(parse_name_status_z(&output.stdout))
}

/// Per-file stats between `base` and the working tree.
pub async fn diff_ref_stats(
    root: &Path,
    base: &str,
) -> Result<HashMap<String, GitLineStat>, ExecError> {
    let output = run_git_checked(
        root,
        &[
            "diff",
            "--numstat",
            "-z",
            "--no-color",
            "--no-ext-diff",
            base,
            "--",
        ],
        DIFF_CAP,
    )
    .await?;
    Ok(parse_numstat_z(&output.stdout))
}

/// Unified diff between `base` and the working tree, optionally limited to
/// `paths`. Mirrors [`diff`]'s cap/truncation contract.
pub async fn diff_ref(
    root: &Path,
    base: &str,
    paths: &[String],
    context: u32,
    max_bytes: usize,
) -> Result<String, ExecError> {
    let unified = format!("--unified={context}");
    let mut args: Vec<&str> = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        &unified,
        base,
        "--",
    ];
    for path in paths {
        args.push(path.as_str());
    }
    let cap = if max_bytes == 0 { DIFF_CAP } else { max_bytes };
    let output = run_git_checked(root, &args, cap).await?;
    let mut text = output.stdout;
    if output.truncated {
        text.push_str("\n[diff truncado pelo limite de saída]\n");
    }
    Ok(text)
}

/// Unified diff of one path against `HEAD` (index + working tree), including
/// untracked files as synthetic additions. Returns an empty string outside a
/// git repository or when the file has no changes.
///
/// The new side of the patch is always the **working tree**, so its line
/// numbers match the content returned by `read_workspace_file`; this is what
/// the inline decorations of the file tab rely on.
pub async fn worktree_diff(
    root: &Path,
    relative: &str,
    max_bytes: usize,
) -> Result<String, ExecError> {
    if !is_repo(root).await {
        return Ok(String::new());
    }

    // No commit yet: every file is new relative to the empty tree. A file that
    // no longer exists has no content to show; treat it as "no diff".
    if !has_head(root).await {
        return Ok(untracked_diff(root, relative, max_bytes).unwrap_or_default());
    }

    let paths = [relative.to_string()];
    let text = diff_ref(root, "HEAD", &paths, 3, max_bytes).await?;

    // `git diff HEAD` ignores untracked files; synthesize the new-file patch
    // exactly like `diff_file` does for the Changes tab.
    if text.trim().is_empty() && !is_tracked(root, relative).await {
        return untracked_diff(root, relative, max_bytes);
    }

    Ok(text)
}

/// Files changed between the merge-base of `base`/`HEAD` and the working tree,
/// including untracked files (which `git diff` never shows).
pub async fn compare(
    root: &Path,
    base: &str,
    untracked: &[String],
) -> Result<(String, Vec<GitCompareFile>), ExecError> {
    let merge_base = merge_base(root, base).await?;
    let statuses = diff_ref_name_status(root, &merge_base).await?;
    let stats = diff_ref_stats(root, &merge_base).await?;
    let mut files: BTreeMap<String, GitCompareFile> = BTreeMap::new();
    for file in statuses {
        let stat = stats.get(&file.path).copied().unwrap_or_default();
        files.insert(
            file.path.clone(),
            GitCompareFile {
                path: file.path,
                status: file.status,
                added: stat.added,
                removed: stat.removed,
            },
        );
    }
    for path in untracked {
        let stat = untracked_stats(root, path);
        files.insert(
            path.clone(),
            GitCompareFile {
                path: path.clone(),
                status: "A".to_string(),
                added: stat.added,
                removed: stat.removed,
            },
        );
    }
    Ok((merge_base, files.into_values().collect()))
}

/// Added lines of an **untracked** file (`git diff` ignores it). Reads at most
/// [`TEXT_CAP`] bytes; binary/large files degrade to `0/0`, mirroring the
/// synthetic `untracked_diff` patch.
pub fn untracked_stats(root: &Path, relative: &str) -> GitLineStat {
    let full = root.join(relative);
    let Ok(metadata) = std::fs::metadata(&full) else {
        return GitLineStat::default();
    };
    if !metadata.is_file() || metadata.len() > TEXT_CAP as u64 {
        return GitLineStat::default();
    }
    let Ok(bytes) = std::fs::read(&full) else {
        return GitLineStat::default();
    };
    if bytes.iter().take(8_000).any(|byte| *byte == 0) {
        return GitLineStat::default();
    }
    let text = String::from_utf8_lossy(&bytes);
    GitLineStat {
        added: u32::try_from(text.lines().count()).unwrap_or(u32::MAX),
        removed: 0,
    }
}

/// Últimos commits (mais novo primeiro).
pub async fn log(root: &Path, limit: u32) -> Result<Vec<GitCommit>, ExecError> {
    let limit = limit.clamp(1, 500);
    let count = format!("-n{limit}");
    // Campos separados por \x1f (não aparece em assunto/autor de commit realista).
    // `%aI` keeps date, time and offset (ISO 8601). The renderer uses `new Date(...)`:
    // a date-only string is parsed as UTC midnight and shows up as the previous
    // day at 21:00 in UTC-3 timezones.
    let output = run_git_checked(
        root,
        &[
            "log",
            &count,
            "--pretty=format:%H\x1f%s\x1f%an\x1f%aI",
        ],
        TEXT_CAP,
    )
    .await?;
    let mut commits = Vec::new();
    for line in output.stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split('\x1f');
        let Some(hash) = fields.next() else { continue };
        let Some(subject) = fields.next() else {
            continue;
        };
        let Some(author) = fields.next() else {
            continue;
        };
        let date = fields.next().unwrap_or_default();
        commits.push(GitCommit {
            hash: hash.to_string(),
            subject: subject.to_string(),
            author: author.to_string(),
            date: date.to_string(),
        });
    }
    Ok(commits)
}

/// `git add -- <paths>`.
pub async fn stage(root: &Path, paths: &[String]) -> Result<(), ExecError> {
    let mut args: Vec<&str> = vec!["add", "--"];
    for path in paths {
        args.push(path.as_str());
    }
    run_git_checked(root, &args, TEXT_CAP).await?;
    Ok(())
}

/// `git add -A`: stages every pending change, including new and deleted files.
pub async fn stage_all(root: &Path) -> Result<(), ExecError> {
    run_git_checked(root, &["add", "-A"], TEXT_CAP).await?;
    Ok(())
}

/// `git restore --staged -- <paths>` (desfaz o staging, mantém o working tree).
pub async fn unstage(root: &Path, paths: &[String]) -> Result<(), ExecError> {
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for path in paths {
        args.push(path.as_str());
    }
    run_git_checked(root, &args, TEXT_CAP).await?;
    Ok(())
}

/// Builds the argv for a commit. `amend` rewrites the current HEAD instead of
/// creating a new commit; the caller must verify that HEAD exists.
fn commit_args(message: &str, amend: bool) -> Vec<&str> {
    if amend {
        vec!["commit", "--amend", "-m", message]
    } else {
        vec!["commit", "-m", message]
    }
}

/// `git commit -m <message>`, optionally with `--amend` (user hooks run; empty
/// commits are rejected).
pub async fn commit(root: &Path, message: &str, amend: bool) -> Result<(), ExecError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(ExecError::failed("mensagem de commit obrigatória", None));
    }
    run_git_checked(root, &commit_args(message, amend), TEXT_CAP).await?;
    Ok(())
}

/// `git restore --staged -- :/` (desfaz todo o staging, mantém o working tree).
///
/// Usa o pathspec `:/` (raiz do repositório) em vez de listar caminhos: assim
/// renames/cópias preparados são desfeitos por completo, sem deixar a remoção
/// do caminho antigo presa no índice.
pub async fn unstage_all(root: &Path) -> Result<(), ExecError> {
    run_git_checked(root, &["restore", "--staged", "--", ":/"], TEXT_CAP).await?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Rede: fetch / pull / push (ações explícitas do usuário)             */
/* ------------------------------------------------------------------ */

/// Requisição de rede: sem prompt de terminal (o app não tem TTY interativo),
/// sem editor aberto por merge e com timeout maior.
fn network_request(root: &Path, args: &[&str]) -> ExecRequest {
    let mut full_args: Vec<String> = vec![
        "-C".to_string(),
        root.to_string_lossy().into_owned(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
    ];
    full_args.extend(args.iter().map(|arg| (*arg).to_string()));
    ExecRequest {
        program: "git".to_string(),
        args: full_args,
        cwd: root.to_path_buf(),
        env: exec::sanitized_env(&[
            ("LC_ALL", "C"),
            ("LANG", "C"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_EDITOR", ":"),
            ("GIT_SEQUENCE_EDITOR", ":"),
            ("GIT_MERGE_AUTOEDIT", "no"),
        ]),
        timeout: NETWORK_TIMEOUT,
        cancel: CancellationToken::new(),
        max_output_bytes: TEXT_CAP,
        stdin: None,
    }
}

async fn run_git_network(root: &Path, args: &[&str]) -> Result<ExecOutput, ExecError> {
    let output = exec::run(network_request(root, args), None).await?;
    if output.timed_out {
        return Err(ExecError::failed(
            "git demorou demais para responder (operação de rede)",
            None,
        ));
    }
    if output.cancelled {
        return Err(ExecError::failed("git cancelado", None));
    }
    if output.exit_code != Some(0) {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        return Err(ExecError::failed(
            format!("git {}: {}", args.first().copied().unwrap_or("?"), detail),
            output.exit_code,
        ));
    }
    Ok(output)
}

/// Explica falhas de autenticação comuns, que sem um terminal parecem opacas.
fn with_network_hint(mut error: ExecError) -> ExecError {
    let lower = error.message.to_lowercase();
    if lower.contains("terminal prompts disabled")
        || lower.contains("could not read username")
        || lower.contains("authentication failed")
    {
        error.message.push_str(
            " — configure um credential helper do git (ou use uma URL SSH) para autenticar",
        );
    }
    error
}

/// Branch atual; `None` em HEAD destacado.
async fn current_branch(root: &Path) -> Option<String> {
    let output = run_git_capture(root, &["symbolic-ref", "--short", "-q", "HEAD"], TEXT_CAP)
        .await
        .ok()?;
    let branch = output.stdout.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

/// `git fetch --all --prune`: atualiza as referências remotas sem tocar no
/// working tree. Repositório sem remoto é um no-op (exit 0).
pub async fn fetch(root: &Path) -> Result<(), ExecError> {
    run_git_network(root, &["fetch", "--all", "--prune"])
        .await
        .map_err(with_network_hint)?;
    Ok(())
}

/// URL of the remote used by the GitHub surfaces: `origin` first, then the
/// first configured remote. `None` outside a repo or without remotes.
pub async fn remote_url(root: &Path) -> Option<String> {
    if let Ok(output) = run_git_checked(root, &["remote", "get-url", "origin"], TEXT_CAP).await {
        let value = output.stdout.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    let output = run_git_checked(root, &["remote"], TEXT_CAP).await.ok()?;
    let name = output
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .to_string();
    let output = run_git_checked(root, &["remote", "get-url", &name], TEXT_CAP)
        .await
        .ok()?;
    let value = output.stdout.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Remote used to fetch pull request refs (`origin` by default).
pub async fn default_remote(root: &Path) -> String {
    let output = run_git_capture(root, &["remote"], TEXT_CAP).await;
    if let Ok(output) = output {
        let names: Vec<&str> = output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        if names.iter().any(|name| *name == "origin") {
            return "origin".to_string();
        }
        if let Some(first) = names.first() {
            return (*first).to_string();
        }
    }
    "origin".to_string()
}

/// Local branch checked out for a pull request (`pr-<number>`).
pub fn pull_request_branch(number: u32) -> String {
    format!("pr-{number}")
}

/// Fetches `refs/pull/<number>/head` and switches the working tree to a local
/// `pr-<number>` branch (created on first use).
///
/// The PR ref is used instead of the author's branch: forks and deleted
/// branches keep working, and no force-push history is rewritten.
pub async fn fetch_pull_request(
    root: &Path,
    remote: &str,
    number: u32,
) -> Result<String, ExecError> {
    let remote = remote.trim();
    let valid = !remote.is_empty()
        && remote
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'));
    if !valid {
        return Err(branch_error(crate::i18n::t("git.errors.invalidRemote")));
    }
    let remote_ref = format!("refs/pull/{number}/head");
    run_git_network(root, &["fetch", "--no-tags", remote, &remote_ref])
        .await
        .map_err(with_network_hint)?;
    let branch = pull_request_branch(number);
    if ref_exists(root, &format!("refs/heads/{branch}")).await {
        checkout_local(root, &branch).await?;
        // The local branch may be behind the PR head; bring it forward without
        // rewriting local commits or creating a merge commit.
        run_git_checked(root, &["merge", "--ff-only", "FETCH_HEAD"], TEXT_CAP)
            .await
            .map(|_| ())
    } else {
        run_git_checked(
            root,
            &["switch", "--create", &branch, "FETCH_HEAD"],
            TEXT_CAP,
        )
        .await
        .map(|_| ())
    }?;
    Ok(branch)
}

/// `git pull --no-edit`: respeita a configuração do usuário (merge/rebase) e
/// nunca abre editor para a mensagem do merge.
pub async fn pull(root: &Path) -> Result<(), ExecError> {
    run_git_network(root, &["pull", "--no-edit"])
        .await
        .map_err(with_network_hint)?;
    Ok(())
}

/// `git push`. Quando a branch ainda não tem upstream, publica em `origin` com
/// `--set-upstream` — o caso mais comum do primeiro push de uma branch nova.
pub async fn push(root: &Path) -> Result<(), ExecError> {
    match run_git_network(root, &["push"]).await {
        Ok(_) => Ok(()),
        Err(error) => {
            let lower = error.message.to_lowercase();
            let missing_upstream = lower.contains("has no upstream branch")
                || lower.contains("no upstream branch")
                || lower.contains("no configured push destination");
            if !missing_upstream {
                return Err(with_network_hint(error));
            }
            let Some(branch) = current_branch(root).await else {
                return Err(with_network_hint(error));
            };
            run_git_network(root, &["push", "--set-upstream", "origin", &branch])
                .await
                .map_err(with_network_hint)?;
            Ok(())
        }
    }
}

/// Branches locais (`git for-each-ref refs/heads`), em ordem alfabética.
pub async fn branches(root: &Path) -> Result<Vec<String>, ExecError> {
    let output = run_git_checked(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=refname",
            "refs/heads",
        ],
        TEXT_CAP,
    )
    .await?;
    Ok(output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/* ------------------------------------------------------------------ */
/* Branches: listing, creation and checkout (explicit user gestures)   */
/* ------------------------------------------------------------------ */

/// Separator between `for-each-ref` fields (never appears in ref names).
const BRANCH_FIELD_SEP: char = '\u{1f}';

/// `for-each-ref` template: one line per branch with everything the picker shows.
const BRANCH_FORMAT: &str = "--format=%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(symref)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(subject)%1f%(authorname)";

/// Upper bound for a branch name (git itself has no hard limit).
const BRANCH_NAME_MAX: usize = 200;

/// One local or remote-tracking branch of the repository.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitBranch {
    /// `main` for a local branch, `origin/main` for a remote-tracking one.
    pub name: String,
    /// `true` for `refs/heads/*`.
    pub local: bool,
    /// Remote name (e.g. `origin`) when the ref lives in `refs/remotes/*`.
    pub remote: Option<String>,
    /// `true` for the branch checked out in this working tree.
    pub current: bool,
    /// Upstream short name (`origin/main`), when configured.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// `true` when the configured upstream no longer exists upstream.
    pub gone: bool,
    /// Subject of the tip commit.
    pub subject: String,
    pub author: String,
    /// Committer date of the tip commit, in seconds since the Unix epoch.
    pub committed_at: i64,
}

/// Parses `%(upstream:track,nobracket)` into `(ahead, behind, gone)`.
///
/// Output is empty when the branch is level with its upstream, otherwise
/// `ahead N`, `behind N`, `ahead N, behind M` or `gone`.
fn parse_upstream_track(raw: &str) -> (u32, u32, bool) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (0, 0, false);
    }
    if raw.eq_ignore_ascii_case("gone") {
        return (0, 0, true);
    }
    let mut ahead = 0;
    let mut behind = 0;
    let tokens: Vec<&str> = raw
        .split(|ch: char| ch == ',' || ch.is_whitespace())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();
    let mut index = 0;
    while index + 1 < tokens.len() {
        let value = tokens[index + 1].parse::<u32>().unwrap_or(0);
        if tokens[index].eq_ignore_ascii_case("ahead") {
            ahead = value;
        } else if tokens[index].eq_ignore_ascii_case("behind") {
            behind = value;
        }
        index += 2;
    }
    (ahead, behind, false)
}

/// Parses one `for-each-ref` line of [`BRANCH_FORMAT`]. `None` for refs the
/// picker must hide (the `refs/remotes/<remote>/HEAD` symref and anything that
/// is neither a branch nor a remote-tracking branch).
fn parse_branch_line(line: &str) -> Option<GitBranch> {
    if line.trim().is_empty() {
        return None;
    }
    let fields: Vec<&str> = line.split(BRANCH_FIELD_SEP).collect();
    if fields.len() < 9 {
        return None;
    }
    let head = fields[0].trim();
    let refname = fields[1].trim();
    let short = fields[2].trim();
    let symref = fields[3].trim();
    let upstream = fields[4].trim();
    let track = fields[5];
    let committed_at = fields[6].trim().parse::<i64>().unwrap_or(0);
    let subject = fields[7].trim();
    let author = fields[8].trim();

    if short.is_empty() || !symref.is_empty() {
        return None;
    }
    let local = refname.starts_with("refs/heads/");
    let remote_ref = refname.starts_with("refs/remotes/");
    if !local && !remote_ref {
        return None;
    }
    let (ahead, behind, gone) = parse_upstream_track(track);
    Some(GitBranch {
        name: short.to_string(),
        local,
        remote: if local {
            None
        } else {
            short.split_once('/').map(|(remote, _)| remote.to_string())
        },
        current: local && head == "*",
        upstream: if upstream.is_empty() {
            None
        } else {
            Some(upstream.to_string())
        },
        ahead,
        behind,
        gone,
        subject: subject.to_string(),
        author: author.to_string(),
        committed_at,
    })
}

/// Local and remote-tracking branches of the repository, sorted by refname.
///
/// Remote branches are listed even when a local branch shares the short name:
/// the picker decides how to present them, and the branch-comparison filter
/// needs the remote refs to reach commits that were never checked out here.
pub async fn branch_entries(root: &Path) -> Result<Vec<GitBranch>, ExecError> {
    let output = run_git_checked(
        root,
        &[
            "for-each-ref",
            BRANCH_FORMAT,
            "--sort=refname",
            "refs/heads",
            "refs/remotes",
        ],
        TEXT_CAP,
    )
    .await?;
    Ok(output
        .stdout
        .lines()
        .filter_map(parse_branch_line)
        .collect())
}

/// `origin/feat/x` → `feat/x`: the local name created when a remote-tracking
/// branch is checked out. `None` for names without a remote prefix.
pub fn local_name_for_remote(name: &str) -> Option<String> {
    name.split_once('/')
        .map(|(_, rest)| rest.trim().to_string())
        .filter(|rest| !rest.is_empty())
}

/// Trims and rejects branch names that could reach git as an option or as
/// multiple argv entries. `git check-ref-format` remains the authoritative
/// check (see [`create_branch`]); this one keeps obvious garbage out early.
pub fn validate_branch_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(crate::i18n::t("git.errors.emptyBranch"));
    }
    if trimmed.chars().count() > BRANCH_NAME_MAX {
        return Err(crate::i18n::t("git.errors.branchNameTooLong"));
    }
    if trimmed.starts_with('-')
        || trimmed
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(crate::i18n::t_args(
            "git.errors.invalidBranchName",
            &[("name", trimmed)],
        ));
    }
    Ok(trimmed.to_string())
}

fn branch_error(message: String) -> ExecError {
    ExecError::failed(message, None)
}

/// `true` when `reference` resolves to a commit in this repository.
async fn ref_exists(root: &Path, reference: &str) -> bool {
    matches!(
        run_git_capture(
            root,
            &["rev-parse", "--verify", "--quiet", reference],
            TEXT_CAP
        )
        .await,
        Ok(output) if output.exit_code == Some(0)
    )
}

/// Runs `git check-ref-format --branch`, which is what git itself uses to
/// accept or reject a new branch name.
async fn check_branch_format(root: &Path, name: &str) -> Result<(), ExecError> {
    let output = run_git_capture(root, &["check-ref-format", "--branch", name], TEXT_CAP).await?;
    if output.exit_code == Some(0) {
        Ok(())
    } else {
        Err(branch_error(crate::i18n::t_args(
            "git.errors.invalidBranchName",
            &[("name", name)],
        )))
    }
}

/// Checks out an existing local branch by name (`git switch -- <name>`).
///
/// The `--` separator keeps a crafted name from ever being parsed as an option.
async fn checkout_local(root: &Path, name: &str) -> Result<(), ExecError> {
    run_git_checked(root, &["switch", "--", name], TEXT_CAP)
        .await
        .map(|_| ())
}

/// Creates a local branch that tracks `remote_ref` and checks it out.
async fn checkout_remote(
    root: &Path,
    local: &str,
    remote_ref: &str,
) -> Result<(), ExecError> {
    if ref_exists(root, &format!("refs/heads/{local}")).await {
        return checkout_local(root, local).await;
    }
    match run_git_checked(
        root,
        &["switch", "--create", local, "--track", remote_ref],
        TEXT_CAP,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(error) => {
            // The local branch may have appeared between the check and the
            // switch (another terminal, another worktree): retry as a switch.
            if ref_exists(root, &format!("refs/heads/{local}")).await {
                checkout_local(root, local).await
            } else {
                Err(error)
            }
        }
    }
}

/// Switches the working tree to `branch`.
///
/// Accepts a local branch (`main`, `feat/x`) or a remote-tracking branch
/// (`origin/main`): the latter creates the local tracking branch, which is
/// what `git switch` refuses to do on its own.
pub async fn switch_branch(root: &Path, branch: &str) -> Result<(), ExecError> {
    let target = validate_branch_name(branch).map_err(branch_error)?;
    if ref_exists(root, &format!("refs/heads/{target}")).await {
        return checkout_local(root, &target).await;
    }
    if ref_exists(root, &format!("refs/remotes/{target}")).await {
        let Some(local) = local_name_for_remote(&target) else {
            return Err(branch_error(crate::i18n::t_args(
                "git.errors.unknownBranch",
                &[("name", &target)],
            )));
        };
        return checkout_remote(root, &local, &target).await;
    }
    Err(branch_error(crate::i18n::t_args(
        "git.errors.unknownBranch",
        &[("name", &target)],
    )))
}

/// Creates `name` and checks it out, optionally starting at `start_point`
/// (a branch, a remote-tracking branch, a tag or a commit hash).
pub async fn create_branch(
    root: &Path,
    name: &str,
    start_point: Option<&str>,
) -> Result<(), ExecError> {
    let target = validate_branch_name(name).map_err(branch_error)?;
    check_branch_format(root, &target).await?;
    if ref_exists(root, &format!("refs/heads/{target}")).await {
        return Err(branch_error(crate::i18n::t_args(
            "git.errors.branchExists",
            &[("name", &target)],
        )));
    }
    let start = start_point.map(str::trim).filter(|value| !value.is_empty());
    let Some(start) = start else {
        run_git_checked(root, &["switch", "--create", &target], TEXT_CAP)
            .await
            .map(|_| ())?;
        return Ok(());
    };
    validate_ref(start).map_err(branch_error)?;
    if !ref_exists(root, start).await {
        return Err(branch_error(crate::i18n::t_args(
            "git.errors.unknownStartPoint",
            &[("name", start)],
        )));
    }
    run_git_checked(root, &["switch", "--create", &target, start], TEXT_CAP)
        .await
        .map(|_| ())
}
/* ------------------------------------------------------------------ */
/* Histórico: um commit completo (metadados + arquivos + patch)        */
/* ------------------------------------------------------------------ */

/// Arquivo alterado por um commit (patch completo por arquivo).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitCommitFile {
    pub path: String,
    /// Caminho anterior quando o commit renomeia/copia.
    pub old_path: Option<String>,
    /// `A` | `M` | `D` | `R` | `C` | `T`.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
    pub diff: String,
}

/// Commit completo para a aba de histórico do Code (estilo Zed).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitCommitDetail {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub files: Vec<GitCommitFile>,
    /// `true` quando o patch passou do teto de saída (a UI avisa).
    pub truncated: bool,
}

/// Aceita apenas hashes hexadecimais curtos/completos (7..=40) — nunca flags.
fn valid_revision(rev: &str) -> bool {
    let rev = rev.trim();
    (7..=40).contains(&rev.len()) && rev.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Remove aspas de caminhos git (`"a/b\tc"`).
fn unquote_path(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(stripped) = raw.strip_prefix('"').and_then(|value| value.strip_suffix('"')) {
        let mut out = String::with_capacity(stripped.len());
        let mut chars = stripped.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('r') => out.push('\r'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => out.push(other),
                    None => break,
                }
            } else {
                out.push(ch);
            }
        }
        return out;
    }
    raw.to_string()
}

/// Divide o patch de um commit em seções por arquivo e extrai status/contagens.
fn parse_commit_patch(patch: &str, truncated: bool) -> Vec<GitCommitFile> {
    let mut files: Vec<GitCommitFile> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut flush = |section: &Vec<&str>, out: &mut Vec<GitCommitFile>| {
        if section.is_empty() {
            return;
        }
        let mut path = String::new();
        let mut old_path = None;
        let mut status = "M".to_string();
        let mut binary = false;
        for line in section {
            if line.starts_with("+++ b/") {
                path = unquote_path(&line["+++ b/".len()..]);
            } else if line.starts_with("+++ \"b/") {
                path = unquote_path(&line["+++ ".len()..]);
                path = path.strip_prefix("b/").unwrap_or(&path).to_string();
            } else if line.starts_with("--- a/") && path.is_empty() {
                path = unquote_path(&line["--- a/".len()..]);
            } else if line.starts_with("rename to ") {
                path = unquote_path(&line["rename to ".len()..]);
                status = "R".to_string();
            } else if line.starts_with("rename from ") {
                old_path = Some(unquote_path(&line["rename from ".len()..]));
                status = "R".to_string();
            } else if line.starts_with("copy to ") {
                path = unquote_path(&line["copy to ".len()..]);
                status = "C".to_string();
            } else if line.starts_with("new file mode") {
                status = "A".to_string();
            } else if line.starts_with("deleted file mode") {
                status = "D".to_string();
            } else if line.starts_with("Binary files ") || *line == "GIT binary patch" {
                binary = true;
            }
        }
        // `+++ /dev/null` em arquivo removido: mantém o caminho de `--- a/`.
        if path == "/dev/null" || path.is_empty() {
            for line in section {
                if let Some(rest) = line.strip_prefix("--- a/") {
                    path = unquote_path(rest);
                    break;
                }
            }
        }
        if path.is_empty() || path == "/dev/null" {
            return;
        }
        let mut added = 0u32;
        let mut removed = 0u32;
        for line in section {
            if line.starts_with("+") && !line.starts_with("+++") {
                added = added.saturating_add(1);
            } else if line.starts_with("-") && !line.starts_with("---") {
                removed = removed.saturating_add(1);
            }
        }
        out.push(GitCommitFile {
            path,
            old_path,
            status,
            added,
            removed,
            binary,
            diff: section.join("\n"),
        });
    };
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            flush(&current, &mut files);
            current = vec![line];
        } else if !current.is_empty() {
            current.push(line);
        }
    }
    flush(&current, &mut files);
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if truncated && !files.is_empty() {
        if let Some(last) = files.last_mut() {
            last.diff.push_str("\n[commit truncado pelo limite de saída]\n");
        }
    }
    files
}

/// Metadados + arquivos + patch completo de um commit (aba de histórico).
pub async fn commit_detail(
    root: &Path,
    revision: &str,
    max_bytes: usize,
) -> Result<GitCommitDetail, ExecError> {
    if !valid_revision(revision) {
        return Err(ExecError::failed(
            "revisão inválida (esperado hash hexadecimal de 7 a 40 caracteres)",
            None,
        ));
    }
    let rev = revision.trim();
    let meta = run_git_checked(
        root,
        &[
            "show",
            "-s",
            "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
            rev,
        ],
        TEXT_CAP,
    )
    .await?;
    let meta = meta.stdout.trim_end_matches(['\n', '\r']);
    let mut fields = meta.split('\x1f');
    let hash = fields.next().unwrap_or_default().to_string();
    let author = fields.next().unwrap_or_default().to_string();
    let email = fields.next().unwrap_or_default().to_string();
    let date = fields.next().unwrap_or_default().to_string();
    let subject = fields.next().unwrap_or_default().to_string();
    let body = fields.next().unwrap_or_default().trim().to_string();

    let cap = if max_bytes == 0 { DIFF_CAP } else { max_bytes };
    let patch = run_git_checked(
        root,
        &[
            "show",
            "--format=",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            "--unified=3",
            rev,
        ],
        cap,
    )
    .await?;
    let files = parse_commit_patch(&patch.stdout, patch.truncated);
    Ok(GitCommitDetail {
        hash,
        author,
        email,
        date,
        subject,
        body,
        files,
        truncated: patch.truncated,
    })
}


/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

fn git_request(root: &Path, args: &[&str], cap: usize) -> ExecRequest {
    let mut full_args: Vec<String> = vec![
        "-C".to_string(),
        root.to_string_lossy().into_owned(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
    ];
    full_args.extend(args.iter().map(|arg| (*arg).to_string()));
    ExecRequest {
        program: "git".to_string(),
        args: full_args,
        cwd: root.to_path_buf(),
        env: exec::sanitized_env(&[
            ("LC_ALL", "C"),
            ("LANG", "C"),
            // Read-only calls (status/diff/log) must not rewrite `.git/index`:
            // the workspace watcher reports index writes and would otherwise
            // refresh -> status -> write -> refresh in a loop.
            ("GIT_OPTIONAL_LOCKS", "0"),
        ]),
        timeout: GIT_TIMEOUT,
        cancel: CancellationToken::new(),
        max_output_bytes: cap,
        stdin: None,
    }
}

/// Roda o git e devolve a saída crua (sem exigir exit code 0).
async fn run_git_capture(
    root: &Path,
    args: &[&str],
    cap: usize,
) -> Result<ExecOutput, ExecError> {
    exec::run(git_request(root, args, cap), None).await
}

/// Roda o git exigindo exit code 0; em falha devolve `EXEC_FAILED` com stderr.
async fn run_git_checked(
    root: &Path,
    args: &[&str],
    cap: usize,
) -> Result<ExecOutput, ExecError> {
    let output = run_git_capture(root, args, cap).await?;
    if output.timed_out {
        return Err(ExecError::failed("git excedeu o tempo limite", None));
    }
    if output.cancelled {
        return Err(ExecError::failed("git cancelado", None));
    }
    if output.exit_code != Some(0) {
        let detail = output.stderr.trim();
        let detail = if detail.is_empty() {
            output.stdout.trim()
        } else {
            detail
        };
        return Err(ExecError::failed(
            format!("git {}: {}", args.first().copied().unwrap_or("?"), detail),
            output.exit_code,
        ));
    }
    Ok(output)
}

fn parse_status(raw: &str, status: &mut GitStatus) {
    let tokens: Vec<&str> = raw.split('\0').collect();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token.is_empty() {
            continue;
        }
        // Cabeçalhos `# ...` podem vir como um token só, com várias linhas separadas
        // por LF, ou um token por linha dependendo da versão do git — tratamos os dois.
        if token.starts_with('#') {
            for line in token.lines() {
                parse_header_line(line, status);
            }
            continue;
        }
        if let Some(rest) = token.strip_prefix("1 ") {
            if let Some((xy, path)) = parse_entry(rest, 7) {
                push_changed(status, &xy, path);
            }
            continue;
        }
        if let Some(rest) = token.strip_prefix("2 ") {
            // Rename/copy: o token seguinte (NUL-delimitado) é o path de origem.
            if let Some((xy, path)) = parse_entry(rest, 8) {
                let orig = tokens.get(index).copied().unwrap_or_default();
                index += 1;
                let file = GitFile {
                    path: path.to_string(),
                    status: rename_status(&xy, orig),
                };
                push_changed_file(status, &xy, file);
            }
            continue;
        }
        if let Some(rest) = token.strip_prefix("u ") {
            if let Some((_, path)) = parse_entry(rest, 9) {
                status.conflicted.push(path.to_string());
            }
            continue;
        }
        if let Some(path) = token.strip_prefix("? ") {
            status.untracked.push(path.to_string());
            continue;
        }
        // `! path` (ignorado) não interessa ao painel.
    }
}

fn parse_header_line(line: &str, status: &mut GitStatus) {
    let line = line.trim_end_matches('\r');
    if let Some(branch) = line.strip_prefix("# branch.head ") {
        status.branch = Some(branch.trim().to_string());
        return;
    }
    if let Some(ab) = line.strip_prefix("# branch.ab ") {
        for part in ab.split_whitespace() {
            if let Some(value) = part.strip_prefix('+') {
                status.ahead = value.parse().unwrap_or(0);
            } else if let Some(value) = part.strip_prefix('-') {
                status.behind = value.parse().unwrap_or(0);
            }
        }
    }
}

/// Extrai `(<XY>, <path>)` de uma entrada porcelain v2.
/// `fields_before_path` varia por tipo: `1` = 7, `2` = 8 (inclui score), `u` = 9.
fn parse_entry(rest: &str, fields_before_path: usize) -> Option<(String, &str)> {
    let mut fields = rest.splitn(fields_before_path + 1, ' ');
    let xy = fields.next()?;
    for _ in 1..fields_before_path {
        fields.next()?;
    }
    let path = fields.next()?;
    Some((xy.to_string(), path))
}

fn push_changed(status: &mut GitStatus, xy: &str, path: &str) {
    let file = GitFile {
        path: path.to_string(),
        status: String::new(),
    };
    push_changed_file(status, xy, file);
}

fn push_changed_file(status: &mut GitStatus, xy: &str, mut file: GitFile) {
    let mut chars = xy.chars();
    let staged = chars.next().unwrap_or('.');
    let unstaged = chars.next().unwrap_or('.');
    if staged != '.' && staged != ' ' {
        if file.status.is_empty() {
            file.status = staged.to_string();
        }
        status.staged.push(file.clone());
    }
    if unstaged != '.' && unstaged != ' ' {
        if file.status.is_empty() {
            file.status = unstaged.to_string();
        }
        status.unstaged.push(file);
    }
}

fn rename_status(xy: &str, _orig: &str) -> String {
    // XY de rename preserva R/C; expõe o caractere de maior prioridade.
    xy.chars()
        .find(|c| *c != '.' && *c != ' ')
        .map(|c| c.to_string())
        .unwrap_or_else(|| "R".to_string())
}

/* ------------------------------------------------------------------ */
/* Testes                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;
    use std::process::Command;

    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn git_available() -> bool {
        let mut command = Command::new("git");
        command.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        matches!(command.output(), Ok(out) if out.status.success())
    }

    pub fn run_git(dir: &Path, args: &[&str]) -> bool {
        let mut command = Command::new("git");
        command.args(args).current_dir(dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        matches!(command.output(), Ok(out) if out.status.success())
    }

    pub fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
        let mut command = Command::new("git");
        command.args(args).current_dir(dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        match command.output() {
            Ok(out) if out.status.success() => {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
            _ => None,
        }
    }

    /// Cria repo com um commit inicial. `None` quando git não está disponível.
    pub fn setup_repo(dir: &Path) -> Option<()> {
        if !git_available() {
            eprintln!("git ausente no PATH: teste ignorado");
            return None;
        }
        let initialized = run_git(dir, &["init", "-b", "main"]) || run_git(dir, &["init"]);
        if !initialized {
            eprintln!("git init falhou: teste ignorado");
            return None;
        }
        let _ = run_git(dir, &["config", "user.email", "teste@zylara.local"]);
        let _ = run_git(dir, &["config", "user.name", "Teste Zylara"]);
        std::fs::write(dir.join("a.txt"), "linha1\n").expect("escrever a.txt");
        if !run_git(dir, &["add", "."]) || !run_git(dir, &["commit", "-m", "initial commit"]) {
            eprintln!("commit inicial falhou: teste ignorado");
            return None;
        }
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{git_available, git_stdout, run_git, setup_repo};
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn check_ignore_batch_keeps_dotfiles_and_tracked_paths_visible() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(
            temp.path().join(".gitignore"),
            ".env\n.env.*\n!.env.example\n*.log\n!keep.log\nignored/\n",
        )
        .expect("gitignore");
        fs::create_dir_all(temp.path().join("ignored")).expect("ignored dir");
        for path in [
            ".env",
            ".env.local",
            ".env.example",
            "debug.log",
            "keep.log",
            "ignored/a.txt",
            "visible.txt",
            ".github/workflows/ci.yml",
        ] {
            let full = temp.path().join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).expect("parent");
            }
            fs::write(full, "content\n").expect("file");
        }
        // Tracked/indexed paths remain visible even when a later rule matches.
        fs::write(
            temp.path().join(".gitignore"),
            "a.txt\n.env\n.env.local\n*.log\n!keep.log\n",
        )
        .expect("tracked ignore rule");

        let paths = vec![
            ".env".to_string(),
            ".env.local".to_string(),
            ".env.example".to_string(),
            "debug.log".to_string(),
            "keep.log".to_string(),
            "a.txt".to_string(),
            "visible.txt".to_string(),
            ".github/workflows/ci.yml".to_string(),
        ];
        let ignored = ignored_paths(temp.path(), temp.path(), &paths).await;
        assert_eq!(
            ignored,
            HashSet::from([
                ".env".to_string(),
                ".env.local".to_string(),
                "debug.log".to_string(),
            ])
        );

        // Force-staged ignored paths are part of the index and stay visible.
        assert!(run_git(temp.path(), &["add", "-f", ".env.local"]));
        assert!(!ignored_paths(temp.path(), temp.path(), &[".env.local".to_string()])
            .await
            .contains(".env.local"));
    }

    #[tokio::test]
    async fn check_ignore_supports_nested_rules_deleted_paths_and_subdirectory_workspaces() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::create_dir_all(temp.path().join("apps/web")).expect("web dir");
        fs::write(temp.path().join("apps/web/.gitignore"), "generated/\n").expect("nested ignore");
        let deleted = "apps/web/generated/deleted.txt";
        let visible = "apps/web/visible.txt";
        let ignored = ignored_paths(
            &temp.path().join("apps/web"),
            temp.path(),
            &[deleted.to_string(), visible.to_string(), "../outside.txt".to_string()],
        )
        .await;
        assert_eq!(ignored, HashSet::from([deleted.to_string()]));
        assert!(ignored_paths(temp.path(), temp.path(), &["../outside.txt".to_string()])
            .await
            .is_empty());
        let non_repo = tempfile::tempdir().expect("non repo");
        assert!(ignored_paths(non_repo.path(), non_repo.path(), &[".env".to_string()])
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn filter_changes_summary_removes_ignored_paths_and_recomputes_totals() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join(".gitignore"), ".env\n!.env.example\n").expect("gitignore");
        let file = |path: &str, added: u32| crate::domain::FileChangeSummary {
            path: path.to_string(),
            kind: crate::domain::FileChangeKind::Created,
            added,
            removed: 1,
            origin: Some("session".to_string()),
            staged: false,
        };
        let summary = crate::domain::ChangesSummary {
            turn_id: Some("turn-1".to_string()),
            files: vec![file(".env", 9), file(".env.example", 2)],
            added: 11,
            removed: 2,
        };
        let visible = filter_changes_summary(summary, temp.path()).await;
        assert_eq!(visible.files.len(), 1);
        assert_eq!(visible.files[0].path, ".env.example");
        assert_eq!(visible.added, 2);
        assert_eq!(visible.removed, 1);
        assert_eq!(visible.turn_id.as_deref(), Some("turn-1"));
    }

    #[tokio::test]
    async fn detects_status_and_untracked() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("b.txt"), "novo\n").expect("criar b");

        let status = detect(temp.path()).await;
        assert!(status.is_repo);
        assert!(status.root.is_some());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(
            status
                .unstaged
                .iter()
                .any(|file| file.path == "a.txt" && file.status == "M"),
            "unstaged: {:?}",
            status.unstaged
        );
        assert!(
            status.untracked.iter().any(|path| path == "b.txt"),
            "untracked: {:?}",
            status.untracked
        );
        assert!(status.staged.is_empty());
        assert!(status.conflicted.is_empty());
    }

    #[tokio::test]
    async fn worktree_diff_compares_head_and_handles_staged_and_untracked() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }

        assert!(
            worktree_diff(temp.path(), "a.txt", 0)
                .await
                .expect("diff")
                .is_empty()
        );

        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        let unstaged = worktree_diff(temp.path(), "a.txt", 0)
            .await
            .expect("diff unstaged");
        assert!(unstaged.contains("+linha2"), "unstaged: {unstaged}");

        // `git diff HEAD` includes staged changes as well.
        stage(temp.path(), &["a.txt".to_string()])
            .await
            .expect("stage");
        let staged = worktree_diff(temp.path(), "a.txt", 0)
            .await
            .expect("diff staged");
        assert!(staged.contains("+linha2"), "staged: {staged}");

        fs::write(temp.path().join("novo.txt"), "novo\n").expect("criar novo");
        let untracked = worktree_diff(temp.path(), "novo.txt", 0)
            .await
            .expect("diff untracked");
        assert!(untracked.contains("@@ -0,0 +1,1 @@"), "untracked: {untracked}");
        assert!(untracked.contains("+novo"), "untracked: {untracked}");

        let plain = tempfile::tempdir().expect("tempdir");
        fs::write(plain.path().join("a.txt"), "x\n").expect("criar a");
        assert!(
            worktree_diff(plain.path(), "a.txt", 0)
                .await
                .expect("diff fora de repo")
                .is_empty()
        );

        if !git_available() {
            return;
        }
        let unborn = tempfile::tempdir().expect("tempdir");
        assert!(
            run_git(unborn.path(), &["init", "-b", "main"])
                || run_git(unborn.path(), &["init"])
        );
        fs::write(unborn.path().join("a.txt"), "x\n").expect("criar a");
        let unborn_diff = worktree_diff(unborn.path(), "a.txt", 0)
            .await
            .expect("diff unborn");
        assert!(unborn_diff.contains("@@ -0,0 +1,1 @@"), "unborn: {unborn_diff}");
        assert!(unborn_diff.contains("+x"), "unborn: {unborn_diff}");
    }

    #[tokio::test]
    async fn diff_log_stage_commit_and_branches() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("b.txt"), "novo\n").expect("criar b");

        let diff_text = diff(temp.path(), &["a.txt".to_string()], false, 3, 0)
            .await
            .expect("diff");
        assert!(diff_text.contains("+linha2"), "diff: {diff_text}");
        assert!(diff_text.contains("--- a/a.txt") || diff_text.contains("a/a.txt"));

        let commits = log(temp.path(), 10).await.expect("log");
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "initial commit");
        assert_eq!(commits[0].hash.len(), 40);

        stage(temp.path(), &["a.txt".to_string(), "b.txt".to_string()])
            .await
            .expect("stage");
        let status = detect(temp.path()).await;
        assert!(
            status.staged.iter().any(|file| file.path == "a.txt"),
            "staged: {:?}",
            status.staged
        );
        assert!(status.staged.iter().any(|file| file.path == "b.txt"));

        unstage(temp.path(), &["b.txt".to_string()])
            .await
            .expect("unstage");
        let status = detect(temp.path()).await;
        assert!(status.staged.iter().any(|file| file.path == "a.txt"));
        assert!(status.untracked.iter().any(|path| path == "b.txt"));

        commit(temp.path(), "test: altera a", false)
            .await
            .expect("commit");
        let commits = log(temp.path(), 10).await.expect("log");
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "test: altera a");

        let branches = branches(temp.path()).await.expect("branches");
        assert!(branches.contains(&"main".to_string()), "branches: {branches:?}");
    }

    #[tokio::test]
    async fn log_returns_full_iso_dates() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }

        let commits = log(temp.path(), 10).await.expect("log");
        let date = &commits[0].date;
        // `YYYY-MM-DDTHH:MM:SS+HH:MM`. A date-only value is parsed as UTC
        // midnight by the renderer, showing the previous day at 21:00 in UTC-3.
        assert_eq!(date.len(), 25, "date: {date}");
        assert_eq!(date.as_bytes().get(10), Some(&b'T'), "date: {date}");
        assert!(
            matches!(date.as_bytes().get(19), Some(b'+' | b'-')),
            "date: {date}"
        );
    }

    #[tokio::test]
    async fn stage_all_includes_modified_and_untracked_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("b.txt"), "novo\n").expect("criar b");

        stage_all(temp.path()).await.expect("stage all");

        let status = detect(temp.path()).await;
        assert!(status.staged.iter().any(|file| file.path == "a.txt"));
        assert!(status.staged.iter().any(|file| file.path == "b.txt"));
        assert!(status.unstaged.is_empty(), "unstaged: {:?}", status.unstaged);
        assert!(status.untracked.is_empty(), "untracked: {:?}", status.untracked);
    }

    #[tokio::test]
    async fn unstage_all_clears_the_index_including_renames() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        assert!(run_git(temp.path(), &["mv", "a.txt", "renomeado.txt"]));
        let status = detect(temp.path()).await;
        assert!(status.staged.iter().any(|file| file.path == "renomeado.txt"));

        unstage_all(temp.path()).await.expect("unstage all");

        let status = detect(temp.path()).await;
        assert!(status.staged.is_empty(), "staged: {:?}", status.staged);
        assert!(
            status.untracked.iter().any(|path| path == "renomeado.txt"),
            "untracked: {:?}",
            status.untracked
        );
        assert!(
            status.unstaged.iter().any(|file| file.path == "a.txt" && file.status == "D"),
            "unstaged: {:?}",
            status.unstaged
        );
    }

    #[tokio::test]
    async fn fetch_without_remote_is_a_noop() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fetch(temp.path()).await.expect("fetch sem remoto");
    }

    #[tokio::test]
    async fn push_publishes_a_branch_without_upstream() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("work");
        fs::create_dir_all(&root).expect("criar work");
        if setup_repo(&root).is_none() {
            return;
        }
        let Some(branch) = git_stdout(&root, &["symbolic-ref", "--short", "HEAD"]) else {
            return;
        };
        let origin = temp.path().join("origin.git");
        assert!(run_git(
            temp.path(),
            &["init", "--bare", origin.to_string_lossy().as_ref()]
        ));
        assert!(run_git(&root, &["remote", "add", "origin", origin.to_string_lossy().as_ref()]));

        push(&root).await.expect("push com upstream automático");

        assert_eq!(
            git_stdout(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
                .as_deref(),
            Some(format!("origin/{branch}").as_str())
        );
        assert!(
            git_stdout(&origin, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).is_some(),
            "origin deveria ter a branch {branch}"
        );
    }

    #[tokio::test]
    async fn fetch_and_pull_bring_remote_commits_into_the_working_tree() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("work");
        fs::create_dir_all(&root).expect("criar work");
        if setup_repo(&root).is_none() {
            return;
        }
        let Some(branch) = git_stdout(&root, &["symbolic-ref", "--short", "HEAD"]) else {
            return;
        };
        let origin = temp.path().join("origin.git");
        let origin_str = origin.to_string_lossy().to_string();
        assert!(run_git(temp.path(), &["init", "--bare", origin_str.as_str()]));
        assert!(run_git(
            &origin,
            &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")]
        ));
        assert!(run_git(&root, &["remote", "add", "origin", origin_str.as_str()]));
        assert!(run_git(&root, &["push", "-u", "origin", branch.as_str()]));

        let other = temp.path().join("other");
        assert!(run_git(
            temp.path(),
            &["clone", origin_str.as_str(), other.to_string_lossy().as_ref()]
        ));
        assert!(run_git(&other, &["config", "user.email", "outro@zylara.local"]));
        assert!(run_git(&other, &["config", "user.name", "Outro"]));
        fs::write(other.join("a.txt"), "linha1\nremoto\n").expect("modificar a");
        assert!(run_git(&other, &["commit", "-am", "alteração remota"]));
        assert!(run_git(&other, &["push"]));

        fetch(&root).await.expect("fetch");
        pull(&root).await.expect("pull");

        let content = fs::read_to_string(root.join("a.txt")).expect("ler a.txt");
        assert!(content.contains("remoto"), "conteúdo: {content}");
        assert_eq!(log(&root, 10).await.expect("log").len(), 2);
    }

    #[test]
    fn commit_args_include_amend_only_when_requested() {
        assert_eq!(commit_args("subject", false), vec!["commit", "-m", "subject"]);
        assert_eq!(
            commit_args("subject", true),
            vec!["commit", "--amend", "-m", "subject"]
        );
    }

    #[tokio::test]
    async fn amend_replaces_the_tip_without_adding_a_commit() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modify a");
        stage(temp.path(), &["a.txt".to_string()])
            .await
            .expect("stage");
        commit(temp.path(), "amended subject", true)
            .await
            .expect("amend");

        let commits = log(temp.path(), 10).await.expect("log");
        assert_eq!(commits.len(), 1, "amend must not create a second commit");
        assert_eq!(commits[0].subject, "amended subject");
    }

    #[tokio::test]
    async fn empty_message_is_rejected() {
        let temp = tempfile::tempdir().expect("tempdir");
        let error = commit(temp.path(), "   ", false).await.expect_err("deve falhar");
        assert!(error.message.contains("mensagem"));
    }

    #[tokio::test]
    async fn non_repo_is_degraded() {
        let temp = tempfile::tempdir().expect("tempdir");
        let status = detect(temp.path()).await;
        assert!(!status.is_repo);
        assert!(status.root.is_none());
        assert!(status.branch.is_none());
        assert!(status.staged.is_empty() && status.unstaged.is_empty());
    }

    #[test]
    fn untracked_diff_synthesizes_new_file_patch() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join("novo.txt"), "linha1\nlinha2\n").expect("escrever");
        let diff = untracked_diff(temp.path(), "novo.txt", 0).expect("diff");
        assert!(diff.starts_with("diff --git a/novo.txt b/novo.txt"), "{diff}");
        assert!(diff.contains("new file mode 100644"));
        assert!(diff.contains("--- /dev/null"));
        assert!(diff.contains("@@ -0,0 +1,2 @@"));
        assert!(diff.contains("+linha1"));
        assert!(diff.contains("+linha2"));
        assert!(!diff.contains("\\ No newline"), "arquivo termina com newline");

        fs::write(temp.path().join("sem-newline.txt"), "unica").expect("escrever");
        let diff = untracked_diff(temp.path(), "sem-newline.txt", 0).expect("diff");
        assert!(diff.contains("+unica"));
        assert!(diff.contains("\\ No newline at end of file"), "{diff}");
    }

    #[test]
    fn untracked_diff_flags_binary_and_large_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join("bin.dat"), [0u8, 1, 2, 3]).expect("escrever");
        let diff = untracked_diff(temp.path(), "bin.dat", 0).expect("diff");
        assert!(diff.contains("Binary files /dev/null and b/bin.dat differ"), "{diff}");

        fs::write(temp.path().join("grande.txt"), "x".repeat(64)).expect("escrever");
        assert!(untracked_diff(temp.path(), "grande.txt", 16).is_err());
    }

    #[test]
    fn parses_numstat_z_with_renames_and_binaries() {
        let raw = concat!(
            "2\t1\ta.txt\0",
            "1\t0\t\0antes.txt\0depois.txt\0",
            "0\t3\tremovido.txt\0",
            "-\t-\tbin.dat\0",
        );
        let stats = parse_numstat_z(raw);
        assert_eq!(
            stats.get("a.txt"),
            Some(&GitLineStat {
                added: 2,
                removed: 1
            })
        );
        assert_eq!(
            stats.get("depois.txt"),
            Some(&GitLineStat {
                added: 1,
                removed: 0
            })
        );
        assert_eq!(
            stats.get("removido.txt"),
            Some(&GitLineStat {
                added: 0,
                removed: 3
            })
        );
        assert_eq!(stats.get("bin.dat"), Some(&GitLineStat::default()));
        assert!(!stats.contains_key("antes.txt"));
    }

    #[test]
    fn parses_name_status_z_with_renames() {
        let raw = concat!(
            "M\0a.txt\0",
            "R100\0antes.txt\0depois.txt\0",
            "D\0removido.txt\0",
            "C75\0origem.txt\0copia.txt\0",
        );
        let files = parse_name_status_z(raw);
        assert_eq!(
            files,
            vec![
                GitFile {
                    path: "a.txt".to_string(),
                    status: "M".to_string(),
                },
                GitFile {
                    path: "depois.txt".to_string(),
                    status: "R".to_string(),
                },
                GitFile {
                    path: "removido.txt".to_string(),
                    status: "D".to_string(),
                },
                GitFile {
                    path: "copia.txt".to_string(),
                    status: "C".to_string(),
                },
            ]
        );
    }

    #[test]
    fn validate_ref_rejects_options_and_whitespace() {
        assert!(validate_ref("").is_err());
        assert!(validate_ref("--cached").is_err());
        assert!(validate_ref("a b").is_err());
        assert!(validate_ref(&"a".repeat(201)).is_err());
        assert!(validate_ref("main").is_ok());
        assert!(validate_ref("origin/main").is_ok());
        assert!(validate_ref("feature/nova").is_ok());
        assert!(validate_ref("0123456789abcdef0123456789abcdef01234567").is_ok());
    }

    #[tokio::test]
    async fn compare_uses_merge_base_and_includes_untracked() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        assert!(run_git(temp.path(), &["checkout", "-b", "feature"]));
        fs::write(temp.path().join("a.txt"), "linha1\nfeature\n").expect("escrever");
        assert!(run_git(temp.path(), &["add", "a.txt"]));
        assert!(run_git(temp.path(), &["commit", "-m", "feature change"]));

        assert!(run_git(temp.path(), &["checkout", "main"]));
        fs::write(temp.path().join("main-only.txt"), "só na main\n").expect("escrever");
        assert!(run_git(temp.path(), &["add", "."]));
        assert!(run_git(temp.path(), &["commit", "-m", "main only"]));

        assert!(run_git(temp.path(), &["checkout", "feature"]));
        fs::write(temp.path().join("a.txt"), "linha1\nfeature\nunstaged\n").expect("escrever");
        fs::write(temp.path().join("novo.txt"), "novo\n").expect("escrever");

        let status = detect(temp.path()).await;
        assert!(status.untracked.iter().any(|path| path == "novo.txt"));

        let (merge_base, files) = compare(temp.path(), "main", &status.untracked)
            .await
            .expect("compare");

        let initial = git_stdout(temp.path(), &["rev-list", "--max-parents=0", "HEAD"])
            .expect("initial hash");
        assert_eq!(merge_base, initial);

        let a = files.iter().find(|file| file.path == "a.txt").expect("a.txt");
        assert_eq!(a.status, "M");
        assert_eq!((a.added, a.removed), (2, 0));
        let novo = files
            .iter()
            .find(|file| file.path == "novo.txt")
            .expect("novo.txt");
        assert_eq!(novo.status, "A");
        assert_eq!((novo.added, novo.removed), (1, 0));
        assert!(
            !files.iter().any(|file| file.path == "main-only.txt"),
            "commit exclusivo da main não pode entrar no diff da branch: {files:?}"
        );
    }

    #[tokio::test]
    async fn diff_ref_compares_against_the_merge_base() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        let text = diff_ref(temp.path(), "main", &["a.txt".to_string()], 3, 0)
            .await
            .expect("diff ref");
        assert!(text.contains("+linha2"), "diff: {text}");
        assert!(text.contains("a/a.txt"));
        let empty = diff_ref(temp.path(), "main", &["ausente.txt".to_string()], 3, 0)
            .await
            .expect("diff ref vazio");
        assert!(empty.trim().is_empty());
    }

    #[tokio::test]
    async fn compare_reports_renamed_file_under_new_path() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        assert!(run_git(temp.path(), &["mv", "a.txt", "b.txt"]));

        let (_, files) = compare(temp.path(), "main", &[])
            .await
            .expect("compare");
        let renamed = files
            .iter()
            .find(|file| file.path == "b.txt")
            .expect("b.txt");
        assert_eq!(renamed.status, "R");
        assert!(!files.iter().any(|file| file.path == "a.txt"));
    }

    #[test]
    fn untracked_stats_count_lines_and_skip_binaries() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join("novo.txt"), "linha1\nlinha2\n").expect("escrever");
        assert_eq!(
            untracked_stats(temp.path(), "novo.txt"),
            GitLineStat {
                added: 2,
                removed: 0
            }
        );

        fs::write(temp.path().join("sem-newline.txt"), "unica").expect("escrever");
        assert_eq!(
            untracked_stats(temp.path(), "sem-newline.txt"),
            GitLineStat {
                added: 1,
                removed: 0
            }
        );

        fs::write(temp.path().join("bin.dat"), [0u8, 1, 2]).expect("escrever");
        assert_eq!(
            untracked_stats(temp.path(), "bin.dat"),
            GitLineStat::default()
        );
        assert_eq!(
            untracked_stats(temp.path(), "ausente.txt"),
            GitLineStat::default()
        );
    }

    #[tokio::test]
    async fn diff_stats_reads_working_tree_and_index() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("novo.txt"), "ola\nmundo\n").expect("criar novo");

        let unstaged = diff_stats(temp.path(), false)
            .await
            .expect("stats unstaged");
        assert_eq!(
            unstaged.get("a.txt"),
            Some(&GitLineStat {
                added: 1,
                removed: 0
            })
        );
        assert!(!unstaged.contains_key("novo.txt"), "untracked fica de fora");

        stage_all(temp.path()).await.expect("stage all");
        let staged = diff_stats(temp.path(), true).await.expect("stats staged");
        assert_eq!(
            staged.get("a.txt"),
            Some(&GitLineStat {
                added: 1,
                removed: 0
            })
        );
        assert_eq!(
            staged.get("novo.txt"),
            Some(&GitLineStat {
                added: 2,
                removed: 0
            })
        );
    }

    #[tokio::test]
    async fn is_tracked_distinguishes_new_files_and_git_diff_ignores_them() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("novo.txt"), "conteudo novo\n").expect("escrever");
        assert!(!is_tracked(temp.path(), "novo.txt").await);
        assert!(is_tracked(temp.path(), "a.txt").await);

        // O `git diff` normal fica vazio para untracked (a UI precisa do fallback).
        let normal = diff(temp.path(), &["novo.txt".to_string()], false, 3, 0)
            .await
            .expect("diff");
        assert!(normal.trim().is_empty(), "diff inesperado: {normal}");

        let synthetic = untracked_diff(temp.path(), "novo.txt", 0).expect("diff novo");
        assert!(synthetic.contains("+conteudo novo"), "{synthetic}");
        assert!(synthetic.contains("new file mode"));
    }

    #[test]
    fn parses_commit_patch_into_files_with_counts_and_status() {
        let patch = concat!(
            "diff --git a/a.txt b/a.txt\n",
            "index 1111111..2222222 100644\n",
            "--- a/a.txt\n",
            "+++ b/a.txt\n",
            "@@ -1 +1,2 @@\n",
            " linha1\n",
            "+linha2\n",
            "diff --git a/novo.txt b/novo.txt\n",
            "new file mode 100644\n",
            "--- /dev/null\n",
            "+++ b/novo.txt\n",
            "@@ -0,0 +1 @@\n",
            "+ola\n",
            "diff --git a/velho.txt b/velho.txt\n",
            "deleted file mode 100644\n",
            "--- a/velho.txt\n",
            "+++ /dev/null\n",
            "@@ -1 +0,0 @@\n",
            "-tchau\n",
            "diff --git a/antes.txt b/depois.txt\n",
            "similarity index 100%\n",
            "rename from antes.txt\n",
            "rename to depois.txt\n"
        );
        let files = parse_commit_patch(patch, false);
        assert_eq!(files.len(), 4);
        let modified = files.iter().find(|file| file.path == "a.txt").expect("a.txt");
        assert_eq!(modified.status, "M");
        assert_eq!(modified.added, 1);
        assert_eq!(modified.removed, 0);
        let created = files.iter().find(|file| file.path == "novo.txt").expect("novo");
        assert_eq!(created.status, "A");
        assert_eq!(created.added, 1);
        let deleted = files.iter().find(|file| file.path == "velho.txt").expect("velho");
        assert_eq!(deleted.status, "D");
        assert_eq!(deleted.removed, 1);
        let renamed = files.iter().find(|file| file.path == "depois.txt").expect("depois");
        assert_eq!(renamed.status, "R");
        assert_eq!(renamed.old_path.as_deref(), Some("antes.txt"));
    }

    #[test]
    fn commit_revision_must_be_a_hex_hash() {
        assert!(valid_revision("abcdef0"));
        assert!(valid_revision(&"a".repeat(40)));
        assert!(!valid_revision("HEAD"));
        assert!(!valid_revision("--help"));
        assert!(!valid_revision("main; rm -rf /"));
        assert!(!valid_revision("abc"));
    }

    #[tokio::test]
    async fn commit_detail_returns_metadata_files_and_patch() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("novo.txt"), "ola\n").expect("criar novo");
        assert!(run_git(temp.path(), &["add", "."]));
        assert!(run_git(temp.path(), &["commit", "-m", "altera a e cria novo"]));

        let commits = log(temp.path(), 1).await.expect("log");
        let head = commits[0].hash.clone();
        let detail = commit_detail(temp.path(), &head, 0).await.expect("detalhe");
        assert_eq!(detail.hash, head);
        assert_eq!(detail.subject, "altera a e cria novo");
        assert_eq!(detail.author, "Teste Zylara");
        assert_eq!(detail.email, "teste@zylara.local");
        assert!(!detail.date.is_empty());
        assert_eq!(detail.files.len(), 2);

        let modified = detail.files.iter().find(|file| file.path == "a.txt").expect("a.txt");
        assert_eq!(modified.status, "M");
        assert!(modified.diff.contains("+linha2"), "diff: {}", modified.diff);
        assert_eq!(modified.added, 1);
        let created = detail.files.iter().find(|file| file.path == "novo.txt").expect("novo");
        assert_eq!(created.status, "A");
        assert!(created.diff.contains("+ola"), "diff: {}", created.diff);

        assert!(!detail.truncated);
        assert!(commit_detail(temp.path(), "HEAD", 0).await.is_err());
    }
    #[test]
    fn parses_porcelain_v2_fixture() {
        let raw = concat!(
            "# branch.oid abc\n",
            "# branch.head main\n",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 hash hash a.txt\0",
            "1 M. N... 100644 100644 100644 hash hash b.txt\0",
            "2 R. N... 100644 100644 100644 hash hash R100 novo.txt\0",
            "antigo.txt\0",
            "u UU N... 100644 100644 100644 100644 hash hash hash conflito.txt\0",
            "? sem-track.txt\0",
            "! ignorado.txt\0"
        );
        let mut status = GitStatus::default();
        parse_status(raw, &mut status);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert!(status
            .unstaged
            .iter()
            .any(|file| file.path == "a.txt" && file.status == "M"));
        assert!(status
            .staged
            .iter()
            .any(|file| file.path == "b.txt" && file.status == "M"));
        assert!(status
            .staged
            .iter()
            .any(|file| file.path == "novo.txt" && file.status == "R"));
        assert!(status.conflicted.iter().any(|path| path == "conflito.txt"));
        assert!(status.untracked.iter().any(|path| path == "sem-track.txt"));
    }

    #[tokio::test]
    async fn commit_diff_staged_only_includes_cached_changes() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        assert!(run_git(temp.path(), &["add", "a.txt"]));
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\nlinha3\n")
            .expect("modificar a de novo");

        let status = detect(temp.path()).await;
        let paths = vec!["a.txt".to_string()];
        let diff = commit_diff(temp.path(), &status, CommitDiffScope::Staged(&paths), 12_000)
            .await
            .expect("diff");
        assert!(diff.contains("+linha2"), "{diff}");
        assert!(!diff.contains("+linha3"), "{diff}");
        assert!(!diff.contains("Unstaged changes:"), "{diff}");
    }

    #[tokio::test]
    async fn commit_diff_all_includes_unstaged_and_untracked() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("b.txt"), "conteudo novo\n").expect("criar b");

        let status = detect(temp.path()).await;
        let diff = commit_diff(temp.path(), &status, CommitDiffScope::All, 12_000)
            .await
            .expect("diff");
        assert!(diff.contains("Unstaged changes:"), "{diff}");
        assert!(diff.contains("+linha2"), "{diff}");
        assert!(diff.contains("New file: b.txt"), "{diff}");
        assert!(diff.contains("+conteudo novo"), "{diff}");
    }

    #[tokio::test]
    async fn commit_diff_selection_limits_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("a.txt"), "linha1\nlinha2\n").expect("modificar a");
        fs::write(temp.path().join("b.txt"), "outra\n").expect("modificar b");

        let status = detect(temp.path()).await;
        let paths = vec!["a.txt".to_string()];
        let diff = commit_diff(temp.path(), &status, CommitDiffScope::Selection(&paths), 12_000)
            .await
            .expect("diff");
        assert!(diff.contains("a.txt"), "{diff}");
        assert!(diff.contains("+linha2"), "{diff}");
        assert!(!diff.contains("b.txt"), "{diff}");
    }

    #[tokio::test]
    async fn commit_diff_staged_ignores_untracked() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        fs::write(temp.path().join("b.txt"), "novo\n").expect("criar b");

        let status = detect(temp.path()).await;
        let paths = vec!["a.txt".to_string()];
        let diff = commit_diff(temp.path(), &status, CommitDiffScope::Staged(&paths), 12_000)
            .await
            .expect("diff");
        assert!(!diff.contains("b.txt"), "{diff}");
    }

    #[test]
    fn truncate_utf8_keeps_a_char_boundary() {
        let mut text = "áéíóú".to_string();
        truncate_utf8(&mut text, 3);
        assert!(text.starts_with('á'), "{text:?}");
        assert!(text.contains("[diff truncated]"), "{text:?}");
        assert!(!text.contains('\u{FFFD}'), "{text:?}");
    }

    /* -------- branches: parsing -------- */

    #[test]
    fn parses_upstream_track_variants() {
        assert_eq!(parse_upstream_track(""), (0, 0, false));
        assert_eq!(parse_upstream_track("ahead 2"), (2, 0, false));
        assert_eq!(parse_upstream_track("behind 3"), (0, 3, false));
        assert_eq!(parse_upstream_track("ahead 2, behind 1"), (2, 1, false));
        assert_eq!(parse_upstream_track("gone"), (0, 0, true));
    }

    #[test]
    fn parses_local_and_remote_branch_lines() {
        let local = format!(
            "*{sep}refs/heads/main{sep}main{sep}{sep}origin/main{sep}ahead 1, behind 2{sep}1700000000{sep}feat: subject{sep}Dev",
            sep = BRANCH_FIELD_SEP
        );
        let branch = parse_branch_line(&local).expect("local branch");
        assert_eq!(branch.name, "main");
        assert!(branch.local);
        assert!(branch.current);
        assert_eq!(branch.remote, None);
        assert_eq!(branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!((branch.ahead, branch.behind), (1, 2));
        assert!(!branch.gone);
        assert_eq!(branch.subject, "feat: subject");
        assert_eq!(branch.committed_at, 1_700_000_000);

        let remote = format!(
            "{sep}refs/remotes/origin/feat/x{sep}origin/feat/x{sep}{sep}{sep}{sep}1700000001{sep}tip{sep}Dev",
            sep = BRANCH_FIELD_SEP
        );
        let branch = parse_branch_line(&remote).expect("remote branch");
        assert_eq!(branch.name, "origin/feat/x");
        assert!(!branch.local);
        assert!(!branch.current);
        assert_eq!(branch.remote.as_deref(), Some("origin"));
        assert_eq!(branch.upstream, None);
    }

    #[test]
    fn hides_symrefs_and_foreign_refs() {
        // `refs/remotes/origin/HEAD` is a symref: the picker must not list it.
        let symref = format!(
            "{sep}refs/remotes/origin/HEAD{sep}origin{sep}refs/remotes/origin/main{sep}{sep}{sep}0{sep}{sep}",
            sep = BRANCH_FIELD_SEP
        );
        assert!(parse_branch_line(&symref).is_none());
        let tag = format!(
            "{sep}refs/tags/v1{sep}v1{sep}{sep}{sep}{sep}0{sep}{sep}",
            sep = BRANCH_FIELD_SEP
        );
        assert!(parse_branch_line(&tag).is_none());
        assert!(parse_branch_line("").is_none());
    }

    #[test]
    fn derives_local_name_from_remote_ref() {
        assert_eq!(local_name_for_remote("origin/main").as_deref(), Some("main"));
        assert_eq!(
            local_name_for_remote("origin/feat/login").as_deref(),
            Some("feat/login")
        );
        assert_eq!(local_name_for_remote("main"), None);
        assert_eq!(local_name_for_remote("origin/"), None);
    }

    #[test]
    fn rejects_invalid_branch_names_early() {
        assert!(validate_branch_name("  ").is_err());
        assert!(validate_branch_name("-rf").is_err());
        assert!(validate_branch_name("two words").is_err());
        assert!(validate_branch_name(&"x".repeat(BRANCH_NAME_MAX + 1)).is_err());
        assert_eq!(
            validate_branch_name(" feat/login ").ok().as_deref(),
            Some("feat/login")
        );
    }

    /* -------- branches: real repositories -------- */

    #[tokio::test]
    async fn lists_local_and_remote_branches_with_upstream_state() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("work");
        fs::create_dir_all(&root).expect("criar work");
        if setup_repo(&root).is_none() {
            return;
        }
        let origin = temp.path().join("origin.git");
        let origin_str = origin.to_string_lossy().to_string();
        assert!(run_git(temp.path(), &["init", "--bare", "-b", "main", &origin_str]));
        assert!(run_git(
            &root,
            &["remote", "add", "origin", origin_str.as_str()]
        ));
        // `-u` is what makes `main` track `origin/main`; a bare push leaves it
        // without an upstream and the assertion below would be meaningless.
        assert!(run_git(&root, &["push", "-q", "-u", "origin", "main"]));
        assert!(run_git(&root, &["branch", "feat/remote"]));
        assert!(run_git(&root, &["push", "-q", "origin", "feat/remote"]));
        assert!(run_git(&root, &["remote", "set-head", "origin", "main"]));
        assert!(run_git(&root, &["fetch", "-q", "origin"]));

        let entries = branch_entries(&root).await.expect("branches");
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"main"), "{names:?}");
        assert!(names.contains(&"feat/remote"), "{names:?}");
        assert!(names.contains(&"origin/main"), "{names:?}");
        assert!(names.contains(&"origin/feat/remote"), "{names:?}");
        // The remote HEAD symref must never show up as a branch.
        assert!(!names.contains(&"origin"), "{names:?}");

        let main = entries
            .iter()
            .find(|entry| entry.name == "main")
            .expect("main");
        assert!(main.current);
        assert!(main.local);
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert_eq!(main.subject, "initial commit");

        let remote = entries
            .iter()
            .find(|entry| entry.name == "origin/feat/remote")
            .expect("remote branch");
        assert!(!remote.local);
        assert_eq!(remote.remote.as_deref(), Some("origin"));
        assert!(!remote.current);
    }

    #[tokio::test]
    async fn switches_between_local_branches() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        assert!(run_git(temp.path(), &["branch", "feat/other"]));

        switch_branch(temp.path(), "feat/other")
            .await
            .expect("switch local");
        assert_eq!(
            git_stdout(temp.path(), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("feat/other")
        );

        switch_branch(temp.path(), " main ").await.expect("switch main");
        assert_eq!(
            git_stdout(temp.path(), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("main")
        );
    }

    #[tokio::test]
    async fn switching_a_remote_branch_creates_the_tracking_local() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("work");
        fs::create_dir_all(&root).expect("criar work");
        if setup_repo(&root).is_none() {
            return;
        }
        let origin = temp.path().join("origin.git");
        let origin_str = origin.to_string_lossy().to_string();
        assert!(run_git(temp.path(), &["init", "--bare", "-b", "main", &origin_str]));
        assert!(run_git(
            &root,
            &["remote", "add", "origin", origin_str.as_str()]
        ));
        assert!(run_git(&root, &["push", "-q", "origin", "main"]));
        assert!(run_git(&root, &["branch", "feat/published"]));
        assert!(run_git(&root, &["push", "-q", "origin", "feat/published"]));
        assert!(run_git(&root, &["fetch", "-q", "origin"]));
        // Drop the local branch so only the remote-tracking ref remains.
        assert!(run_git(&root, &["branch", "-D", "feat/published"]));

        switch_branch(&root, "origin/feat/published")
            .await
            .expect("switch remote");

        assert_eq!(
            git_stdout(&root, &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("feat/published")
        );
        assert_eq!(
            git_stdout(
                &root,
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]
            )
            .as_deref(),
            Some("origin/feat/published")
        );
        assert!(
            git_stdout(&root, &["rev-parse", "--verify", "refs/heads/feat/published"]).is_some(),
            "local tracking branch should exist"
        );
    }

    #[tokio::test]
    async fn switching_an_unknown_branch_reports_a_translated_error() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        let error = switch_branch(temp.path(), "nope/missing")
            .await
            .expect_err("missing branch");
        assert!(error.message.contains("nope/missing"), "{}", error.message);
        assert_eq!(
            git_stdout(temp.path(), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("main"),
            "a failed switch must not move HEAD"
        );
    }

    #[tokio::test]
    async fn creates_branches_from_head_and_from_a_start_point() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        create_branch(temp.path(), "feat/new", None)
            .await
            .expect("create from HEAD");
        assert_eq!(
            git_stdout(temp.path(), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("feat/new")
        );

        create_branch(temp.path(), "feat/from-main", Some("main"))
            .await
            .expect("create from main");
        assert_eq!(
            git_stdout(temp.path(), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("feat/from-main")
        );
        assert_eq!(
            git_stdout(temp.path(), &["rev-parse", "feat/from-main"]),
            git_stdout(temp.path(), &["rev-parse", "main"])
        );
    }

    #[tokio::test]
    async fn create_branch_rejects_duplicates_and_bad_names() {
        let temp = tempfile::tempdir().expect("tempdir");
        if setup_repo(temp.path()).is_none() {
            return;
        }
        assert!(run_git(temp.path(), &["branch", "taken"]));
        let duplicate = create_branch(temp.path(), "taken", None)
            .await
            .expect_err("duplicate name");
        assert!(duplicate.message.contains("taken"), "{}", duplicate.message);

        let invalid = create_branch(temp.path(), "bad name", None)
            .await
            .expect_err("invalid name");
        assert!(!invalid.message.is_empty());

        // git itself rejects names like `foo..bar` / `foo~1`.
        let dotted = create_branch(temp.path(), "foo..bar", None)
            .await
            .expect_err("git-invalid name");
        assert!(dotted.message.contains("foo..bar"), "{}", dotted.message);

        let unknown_start = create_branch(temp.path(), "ok-name", Some("nope/rev"))
            .await
            .expect_err("unknown start point");
        assert!(
            unknown_start.message.contains("nope/rev"),
            "{}",
            unknown_start.message
        );
        assert!(
            git_stdout(temp.path(), &["rev-parse", "--verify", "refs/heads/ok-name"]).is_none(),
            "a rejected creation must not leave a branch behind"
        );
    }

    #[tokio::test]
    async fn creates_a_branch_tracking_a_remote_start_point() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("work");
        fs::create_dir_all(&root).expect("criar work");
        if setup_repo(&root).is_none() {
            return;
        }
        let origin = temp.path().join("origin.git");
        let origin_str = origin.to_string_lossy().to_string();
        assert!(run_git(temp.path(), &["init", "--bare", "-b", "main", &origin_str]));
        assert!(run_git(
            &root,
            &["remote", "add", "origin", origin_str.as_str()]
        ));
        assert!(run_git(&root, &["push", "-q", "origin", "main"]));
        assert!(run_git(&root, &["branch", "shared"]));
        assert!(run_git(&root, &["push", "-q", "origin", "shared"]));
        assert!(run_git(&root, &["fetch", "-q", "origin"]));
        assert!(run_git(&root, &["branch", "-D", "shared"]));

        create_branch(&root, "shared", Some("origin/shared"))
            .await
            .expect("create from remote");

        assert_eq!(
            git_stdout(&root, &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("shared")
        );
        assert_eq!(
            git_stdout(
                &root,
                &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]
            )
            .as_deref(),
            Some("origin/shared"),
            "a branch created from a remote ref must track it"
        );
    }
}
