//! Comandos do workspace de código (harness): abrir pasta, CRUD, árvore de
//! arquivos, busca e prévia read-only.
//!
//! Contrato: `docs/goals/code-harness/HARNESS.md` §7 e `WORKBENCH.md` §3/§7.1.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::domain::{
    Conversation, GitInfo, ProjectCheckInfo, ProjectInfo, Workspace, WorkspaceContext,
    WorkspaceFileContent, WorkspaceFileEntry, WorkspaceGitStatus,
};
use crate::state::AppState;
use crate::workspace::{project, safe_path, safe_path::Access};

/// Limite de entradas devolvidas por `list_workspace_files` (a UI avisa quando
/// trunca; o usuário refina a busca).
const MAX_TREE_ENTRIES: usize = 6_000;
/// Limite de texto devolvido pela prévia de arquivo.
const MAX_PREVIEW_BYTES: usize = 512 * 1024;
/// Teto do payload base64 inline de imagem/PDF (24 MiB) — o mesmo teto de
/// `commands::artifacts::MAX_INLINE_MEDIA_BYTES` (constante local para manter as
/// áreas independentes). Acima disso a UI recebe `previewOmitted` e mostra um
/// cartão com o tamanho, em vez de trafegar dezenas de MB pelo IPC.
const MAX_INLINE_PREVIEW_BYTES: u64 = 24 * 1024 * 1024;
/// Limite de arquivos varridos em `search_workspace_files`.
const MAX_SEARCH_ENTRIES: usize = 20_000;
/// Tetos de diretórios lazy recarregados por refresh (watcher/manual).
const MAX_WATCH_DIRS: usize = 32;

fn map_err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Caminho absoluto canonicalizado do workspace (validado a cada comando).
pub(crate) fn workspace_path(state: &AppState, workspace_id: &str) -> Result<PathBuf, String> {
    let workspace = state
        .db
        .get_workspace(workspace_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "workspace.errors.notFound",
            &[("workspace_id", &workspace_id)],
        ))?;
    let path = PathBuf::from(&workspace.path);
    if !path.is_dir() {
        return Err(crate::i18n::t_args(
            "workspace.errors.folderGone",
            &[("path", &workspace.path)],
        ));
    }
    Ok(path)
}

/// Converte o perfil detectado para o DTO de IPC.
pub(crate) fn project_info(root: &Path) -> ProjectInfo {
    let profile = project::detect(root);
    ProjectInfo {
        kind: profile.kind,
        name: profile.name,
        checks: profile
            .checks
            .into_iter()
            .map(|check| ProjectCheckInfo {
                id: check.id,
                label: check.label,
                command: check.command,
            })
            .collect(),
        checked_ecosystems: profile.checked_ecosystems,
    }
}

/// Complementa um workspace com git + projeto (sem persistir nada).
pub(crate) async fn enrich_workspace(root: &Path, mut workspace: Workspace) -> Workspace {
    let status = crate::workspace::git::detect(root).await;
    workspace.git = if status.is_repo {
        Some(GitInfo {
            root: status
                .root
                .as_ref()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
            branch: status.branch.unwrap_or_default(),
            ahead: status.ahead,
            behind: status.behind,
            dirty: !status.staged.is_empty()
                || !status.unstaged.is_empty()
                || !status.untracked.is_empty()
                || !status.conflicted.is_empty(),
            staged: status.staged.len() as u32,
            unstaged: status.unstaged.len() as u32,
            untracked: status.untracked.len() as u32,
        })
    } else {
        None
    };
    workspace
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/// Abre o seletor nativo de pasta; devolve o caminho canonicalizado.
#[tauri::command]
pub async fn pick_workspace_folder(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| crate::i18n::t_args(
            "workspace.errors.invalidPath",
            &[("error", &error.to_string())],
        ))?;
    let canonical = dunce::canonicalize(&path).unwrap_or(path);
    Ok(Some(canonical.to_string_lossy().to_string()))
}

/// Registra (ou reabre) uma pasta como workspace.
#[tauri::command]
pub async fn add_workspace(
    state: State<'_, AppState>,
    path: String,
    trusted: bool,
) -> Result<Workspace, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(crate::i18n::t("workspace.errors.emptyPath"));
    }
    let canonical = dunce::canonicalize(raw).map_err(|error| {
        crate::i18n::t_args(
            "workspace.errors.openFolder",
            &[("path", &raw), ("error", &error.to_string())],
        )
    })?;
    if !canonical.is_dir() {
        return Err(crate::i18n::t_args("workspace.errors.notFolder", &[("path", &raw)]));
    }
    let canonical_str = canonical.to_string_lossy().to_string();
    if let Some(existing) = state
        .db
        .find_workspace_by_path(&canonical_str)
        .map_err(map_err)?
    {
        state.db.mark_workspace_opened(&existing.id).map_err(map_err)?;
        if trusted && !existing.trusted {
            state
                .db
                .set_workspace_trusted(&existing.id, true)
                .map_err(map_err)?;
        }
        let workspace = state
            .db
            .get_workspace(&existing.id)
            .map_err(map_err)?
            .ok_or_else(|| "workspace desapareceu ao reabrir".to_string())?;
        return Ok(enrich_workspace(&canonical, workspace).await);
    }
    let name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| canonical_str.clone());
    let workspace = state
        .db
        .create_workspace(&name, &canonical_str)
        .map_err(map_err)?;
    if trusted {
        state
            .db
            .set_workspace_trusted(&workspace.id, true)
            .map_err(map_err)?;
    }
    state
        .db
        .mark_workspace_opened(&workspace.id)
        .map_err(map_err)?;
    let workspace = state
        .db
        .get_workspace(&workspace.id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t("workspace.errors.notFoundAfterCreate"))?;
    Ok(enrich_workspace(&canonical, workspace).await)
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    state.db.list_workspaces().map_err(map_err)
}

#[tauri::command]
pub fn reorder_workspaces(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.db.reorder_workspaces(&ids).map_err(map_err)
}

/// Workspace + contexto (git/projeto) para o header do layout Code.
#[tauri::command]
pub async fn get_workspace_context(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<WorkspaceContext>, String> {
    let Some(workspace) = state.db.get_workspace(&id).map_err(map_err)? else {
        return Ok(None);
    };
    let root = PathBuf::from(&workspace.path);
    if !root.is_dir() {
        return Ok(Some(WorkspaceContext {
            workspace,
            project: None,
        }));
    }
    let workspace = enrich_workspace(&root, workspace).await;
    Ok(Some(WorkspaceContext {
        workspace,
        project: Some(project_info(&root)),
    }))
}

#[tauri::command]
pub async fn rename_workspace(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<Workspace, String> {
    let mut workspace = state
        .db
        .get_workspace(&id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args("workspace.errors.notFound", &[("workspace_id", &id)]))?;
    workspace.name = name.trim().to_string();
    state.db.update_workspace(&workspace).map_err(map_err)?;
    let updated = state
        .db
        .get_workspace(&id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args("workspace.errors.notFound", &[("workspace_id", &id)]))?;
    Ok(updated)
}

/// Remove o workspace do Zylara. **Não** apaga a pasta do usuário.
#[tauri::command]
pub async fn remove_workspace(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conversations = state
        .db
        .list_conversations_for_workspace(&id)
        .map_err(map_err)?;
    let removed = state.db.delete_workspace(&id).map_err(map_err)?;
    if !removed {
        return Err(crate::i18n::t_args("workspace.errors.notFound", &[("workspace_id", &id)]));
    }
    for conversation in conversations {
        state.terminals.close_conversation(&conversation.id);
    }
    Ok(())
}

#[tauri::command]
pub async fn set_workspace_trusted(
    state: State<'_, AppState>,
    id: String,
    trusted: bool,
) -> Result<Workspace, String> {
    state
        .db
        .set_workspace_trusted(&id, trusted)
        .map_err(map_err)?;
    state
        .db
        .get_workspace(&id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args("workspace.errors.notFound", &[("workspace_id", &id)]))
}

/// Vincula (ou desvincula) uma sessão a um workspace.
#[tauri::command]
pub async fn set_conversation_workspace(
    state: State<'_, AppState>,
    conversation_id: String,
    workspace_id: Option<String>,
) -> Result<Conversation, String> {
    bind_conversation_workspace(&state.db, &conversation_id, workspace_id.as_deref(), crate::computer::browser::global()).await
}

pub(crate) async fn bind_conversation_workspace(db: &crate::db::Db, conversation_id: &str, workspace_id: Option<&str>, browser: Option<&crate::computer::browser::BrowserManager>) -> Result<Conversation, String> {
    let conversation = db.get_conversation(conversation_id).map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "workspace.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    let gate = crate::agents::workspace_gate(conversation_id);
    let _guard = if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT {
        Some(gate.try_write().map_err(|_| "AGENT_WORKSPACE_BUSY: aguarde o fim do turno".to_string())?)
    } else {
        None
    };
    if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT {
        if let Some(id) = workspace_id {
            let workspace = db.get_workspace(id).map_err(map_err)?
                .ok_or_else(|| crate::i18n::t_args("workspace.errors.notFound", &[("workspace_id", &id)]))?;
            if !workspace.trusted {
                return Err(crate::i18n::t("workspace.errors.untrusted"));
            }
        }
    }
    let control_gate = crate::computer::control::gate(conversation_id);
    let _action_guard = if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT {
        Some(control_gate.action.lock().await)
    } else { None };
    let browser_updated = if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT && conversation.workspace_id.as_deref() != workspace_id {
        if let Some(browser) = browser {
            browser.prepare_workspace_change(db, conversation_id, workspace_id).await?
        } else { false }
    } else { false };
    if let Err(error) = db.set_conversation_workspace(conversation_id, workspace_id) {
        if browser_updated { if let Some(browser) = browser { browser.close(conversation_id); } }
        return Err(map_err(error));
    }
    db
        .get_conversation(conversation_id)
        .map_err(map_err)?
        .ok_or_else(|| crate::i18n::t_args(
            "workspace.errors.conversationNotFound",
            &[("conversation_id", &conversation_id)],
        ))
}

#[tauri::command]
pub async fn open_workspace_in_explorer(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let root = workspace_path(&state, &id)?;
    app.opener()
        .open_path(root.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| crate::i18n::t_args(
            "workspace.errors.openFolderGeneric",
            &[("error", &error.to_string())],
        ))
}

/* ------------------------------------------------------------------ */
/* Árvore, busca e prévia                                              */
/* ------------------------------------------------------------------ */

fn build_tree(entries: &[(String, bool, u64)], root_label: &str) -> Vec<WorkspaceFileEntry> {
    use std::collections::HashMap;
    let base = root_label.trim_matches('/');
    let base = if base == "." || base.is_empty() { "" } else { base };
    let base_depth = if base.is_empty() {
        0
    } else {
        base.matches('/').count() as u32 + 1
    };
    // Passo 1: agrupa filhos por pai (None = raiz da listagem).
    let mut children: HashMap<Option<String>, Vec<String>> = HashMap::new();
    let mut info: HashMap<String, (bool, u64)> = HashMap::new();
    for (path, is_dir, size) in entries {
        let parent = path.rsplit_once('/').map(|(parent, _)| parent.to_string());
        children.entry(parent).or_default().push(path.clone());
        info.insert(path.clone(), (*is_dir, *size));
    }
    // Passo 2: monta recursivamente, diretórios primeiro e nome ordenado.
    fn build(
        path: &str,
        children: &HashMap<Option<String>, Vec<String>>,
        info: &HashMap<String, (bool, u64)>,
        base_depth: u32,
    ) -> WorkspaceFileEntry {
        let (is_dir, size) = info.get(path).copied().unwrap_or((false, 0));
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        // Profundidade relativa à raiz da listagem (0 = primeiro nível).
        let depth = (path.matches('/').count() as u32).saturating_sub(base_depth);
        let mut child_nodes: Vec<WorkspaceFileEntry> = children
            .get(&Some(path.to_string()))
            .map(|paths| {
                paths
                    .iter()
                    .map(|child| build(child, children, info, base_depth))
                    .collect()
            })
            .unwrap_or_default();
        child_nodes.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        WorkspaceFileEntry {
            path: path.to_string(),
            name,
            is_dir,
            depth,
            size: if is_dir { None } else { Some(size) },
            git_status: None,
            children: child_nodes,
        }
    }
    let top_parent = if base.is_empty() {
        None
    } else {
        Some(base.to_string())
    };
    let mut roots: Vec<WorkspaceFileEntry> = children
        .get(&top_parent)
        .map(|paths| {
            paths
                .iter()
                .map(|path| build(path, &children, &info, base_depth))
                .collect()
        })
        .unwrap_or_default();
    roots.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    roots
}

/// Lists the workspace tree from a relative directory.
///
/// The Files tab shows every entry: hidden paths, gitignore/exclude matches and
/// `.ignore` rules are all included. The resolution uses `Access::ReadDir` (the
/// root "." is a valid directory); `Read` is reserved for files. Regression
/// covered by `lists_the_workspace_tree_from_the_root_and_subdirectories` and
/// `lists_hidden_and_ignored_files_in_the_files_tab`.
fn list_tree(
    root: &std::path::Path,
    relative: &str,
    depth: u32,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let base = safe_path::resolve(root, relative, Access::ReadDir).map_err(map_err)?;
    let depth = depth.clamp(1, 6);
    let mut entries: Vec<(String, bool, u64)> = Vec::new();
    // The Files tab never hides entries: disable every filter the walker applies.
    let walker = ignore::WalkBuilder::new(&base)
        .max_depth(Some(depth as usize + 1))
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .parents(false)
        .follow_links(false)
        .build();
    for entry in walker.flatten() {
        if entries.len() >= MAX_TREE_ENTRIES {
            break;
        }
        let entry_path = entry.path();
        if entry_path == base {
            continue;
        }
        let Ok(relative_path) = entry_path.strip_prefix(root) else {
            continue;
        };
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        entries.push((
            relative_path.to_string_lossy().replace('\\', "/"),
            is_dir,
            size,
        ));
    }
    Ok(build_tree(&entries, relative))
}

/// Git badge (`M`/`A`/`D`/`U`/`!`) per workspace-relative path.
///
/// Precedence matches the panel: staged first, then unstaged (without
/// overriding), then untracked (`U`) and conflicts (`!`) last.
fn git_badges(status: &crate::workspace::git::GitStatus) -> HashMap<String, String> {
    let mut badges: HashMap<String, String> = HashMap::new();
    if !status.is_repo {
        return badges;
    }
    for file in &status.staged {
        badges.insert(file.path.clone(), file.status.clone());
    }
    for file in &status.unstaged {
        badges
            .entry(file.path.clone())
            .or_insert_with(|| file.status.clone());
    }
    for path in &status.untracked {
        badges.insert(path.clone(), "U".to_string());
    }
    for path in &status.conflicted {
        badges.insert(path.clone(), "!".to_string());
    }
    badges
}

fn apply_badges(entries: &mut [WorkspaceFileEntry], badges: &HashMap<String, String>) {
    for entry in entries.iter_mut() {
        if let Some(badge) = badges.get(&entry.path) {
            entry.git_status = Some(badge.clone());
        }
        apply_badges(&mut entry.children, badges);
    }
}

#[tauri::command]
pub async fn list_workspace_files(
    state: State<'_, AppState>,
    workspace_id: String,
    path: Option<String>,
    depth: Option<u32>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root = workspace_path(&state, &workspace_id)?;
    let relative = path.unwrap_or_else(|| ".".to_string());
    let mut tree = list_tree(&root, &relative, depth.unwrap_or(2))?;
    // Badges de git para os arquivos visíveis.
    let status = crate::workspace::git::detect(&root).await;
    let badges = git_badges(&status);
    if !badges.is_empty() {
        apply_badges(&mut tree, &badges);
    }
    Ok(tree)
}

/// Root tree (depth 2) plus the fresh children of the directories the panel
/// expanded lazily. A directory removed from disk yields an empty list (the
/// renderer treats it as lazy again), never an error.
fn tree_snapshot(
    root: &Path,
    extra_dirs: &[String],
) -> Result<(Vec<WorkspaceFileEntry>, HashMap<String, Vec<WorkspaceFileEntry>>), String> {
    let files = list_tree(root, ".", 2)?;
    let mut dirs: HashMap<String, Vec<WorkspaceFileEntry>> = HashMap::new();
    for dir in extra_dirs.iter().take(MAX_WATCH_DIRS) {
        if dir.is_empty() || dir == "." || dirs.contains_key(dir) {
            continue;
        }
        dirs.insert(dir.clone(), list_tree(root, dir, 2).unwrap_or_default());
    }
    Ok((files, dirs))
}

/// Single snapshot consumed by the Files/Changes panel: one `git status` feeds
/// the badges of the root tree and of every lazily loaded directory, so a live
/// refresh costs one status call instead of one per directory.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTreeSnapshot {
    pub files: Vec<WorkspaceFileEntry>,
    pub dirs: HashMap<String, Vec<WorkspaceFileEntry>>,
    pub git_status: WorkspaceGitStatus,
}

#[tauri::command]
pub async fn refresh_workspace_tree(
    state: State<'_, AppState>,
    workspace_id: String,
    extra_dirs: Option<Vec<String>>,
) -> Result<WorkspaceTreeSnapshot, String> {
    let root = workspace_path(&state, &workspace_id)?;
    let status = crate::workspace::git::detect(&root).await;
    let badges = git_badges(&status);
    let (mut files, mut dirs) = tree_snapshot(&root, &extra_dirs.unwrap_or_default())?;
    if !badges.is_empty() {
        apply_badges(&mut files, &badges);
        for entries in dirs.values_mut() {
            apply_badges(entries, &badges);
        }
    }
    Ok(WorkspaceTreeSnapshot {
        files,
        dirs,
        git_status: crate::commands::git::to_status(status),
    })
}

/// Starts the native filesystem watcher of a workspace; the renderer receives
/// coalesced `zylara:workspace-changed` events while it is active.
#[tauri::command]
pub async fn watch_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    let root = workspace_path(&state, &workspace_id)?;
    state
        .watches
        .start(&workspace_id, &root, move |event| {
            let _ = app.emit(crate::workspace::watch::WORKSPACE_CHANGED_EVENT, event);
        })
        .map(|_| ())
        .map_err(map_err)
}

/// Stops the watcher of a workspace (no-op when it is not running).
#[tauri::command]
pub async fn unwatch_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    state.watches.stop(&workspace_id);
    Ok(())
}

/// Busca arquivos por nome (substring, case-insensitive) para `@` menções.
#[tauri::command]
pub async fn search_workspace_files(
    state: State<'_, AppState>,
    workspace_id: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let root = workspace_path(&state, &workspace_id)?;
    let needle = query.trim().to_lowercase();
    let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
    let mut matches: Vec<(u8, String)> = Vec::new();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut visited = 0usize;
    let walker = ignore::WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .follow_links(false)
        .build();
    for entry in walker.flatten() {
        if visited >= MAX_SEARCH_ENTRIES || matches.len() >= limit * 4 {
            break;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        visited += 1;
        let Ok(relative_path) = entry.path().strip_prefix(&root) else {
            continue;
        };
        let relative_path = relative_path.to_string_lossy().replace('\\', "/");
        let lower = relative_path.to_lowercase();
        let Some(position) = lower.find(&needle) else {
            continue;
        };
        // Prioriza nome de arquivo, depois path; e prefixo antes de meio.
        let name_start = relative_path.rfind('/').map(|index| index + 1).unwrap_or(0);
        let score = if position == name_start {
            0
        } else if position == 0 {
            1
        } else {
            2
        };
        matches.push((score, relative_path));
    }
    matches.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.len().cmp(&right.1.len()))
            .then_with(|| left.1.cmp(&right.1))
    });
    Ok(matches
        .into_iter()
        .take(limit)
        .map(|(_, path)| path)
        .collect())
}

/* ------------------------------------------------------------------ */
/* Prévia binária (imagem/PDF)                                         */
/* ------------------------------------------------------------------ */

/// MIME que o WebView2 desenha inline e que a prévia entrega em base64.
///
/// O match é explícito (e não `mime_guess`) para o conjunto ficar restrito ao
/// que o renderer sabe exibir: SVG continua no caminho de texto (não é payload
/// binário) e TIFF/HEIC não são inline (o `<img>` não os abre; viram `binary`
/// com `mimeType` e sem payload).
fn preview_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "pdf" => Some("application/pdf"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" | "jpe" | "jfif" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

/// MIME inferido pela extensão para binários **sem** prévia inline (zip, exe,
/// tiff…). `mime_guess` devolve `&'static str` da tabela embutida.
fn mime_for_path(path: &Path) -> Option<&'static str> {
    mime_guess::from_path(path).first_raw()
}

/// Decisão do payload de uma prévia binária, separada do IO para o limite de
/// 24 MiB ser testável sem criar um fixture desse tamanho.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreviewPayload {
    /// Bytes embutidos em base64 neste IPC.
    Inline,
    /// Acima do teto: só metadados (`previewOmitted`), sem ler o arquivo.
    Omitted,
}

fn preview_payload_for_size(size: u64) -> PreviewPayload {
    if size <= MAX_INLINE_PREVIEW_BYTES {
        PreviewPayload::Inline
    } else {
        PreviewPayload::Omitted
    }
}

/// DTO de prévia binária suportada (imagem/PDF).
///
/// `payload == None` significa "omitido pelo limite", nunca "arquivo vazio":
/// bytes reais vazios entram como `Some(&[])`.
fn build_preview_content(
    path: String,
    size: u64,
    mime_type: &str,
    payload: Option<&[u8]>,
) -> WorkspaceFileContent {
    WorkspaceFileContent {
        path,
        text: String::new(),
        truncated: false,
        size,
        binary: true,
        encoding: None,
        mime_type: Some(mime_type.to_string()),
        data_base64: payload.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)),
        preview_omitted: payload.is_none(),
    }
}

/// DTO de binário sem prévia inline: mantém o comportamento anterior (sem
/// texto) e só enriquece o MIME quando a extensão diz algo.
fn build_binary_content(
    path: String,
    size: u64,
    truncated: bool,
    mime_type: Option<&str>,
) -> WorkspaceFileContent {
    WorkspaceFileContent {
        path,
        text: String::new(),
        truncated,
        size,
        binary: true,
        encoding: None,
        mime_type: mime_type.map(str::to_string),
        data_base64: None,
        preview_omitted: false,
    }
}

/// Lê e monta a prévia read-only de um arquivo do workspace.
///
/// Fica fora do comando (que só resolve o workspace) para os testes exercitarem
/// leitura, limites e confinamento sem `AppState`/Tauri.
fn read_file_content(root: &Path, requested: &str) -> Result<WorkspaceFileContent, String> {
    let file_path = safe_path::resolve(root, requested, Access::Read).map_err(map_err)?;
    let metadata = std::fs::metadata(&file_path)
        .map_err(|error| crate::i18n::t_args(
            "workspace.errors.readFile",
            &[("path", &requested), ("error", &error.to_string())],
        ))?;
    if !metadata.is_file() {
        return Err(crate::i18n::t_args("workspace.errors.notFile", &[("path", &requested)]));
    }
    let size = metadata.len();
    let relative = safe_path::to_relative(root, &file_path);

    // 1) Imagem/PDF: a prévia binária decide antes dos limites de texto — uma
    // foto JPEG real costuma passar de 4 MiB e ainda cabe no teto inline.
    if let Some(mime) = preview_mime(&file_path) {
        if preview_payload_for_size(size) == PreviewPayload::Omitted {
            // Acima do teto: não lê o arquivo (pode ter centenas de MB).
            return Ok(build_preview_content(relative, size, mime, None));
        }
        let bytes = std::fs::read(&file_path)
            .map_err(|error| crate::i18n::t_args(
            "workspace.errors.openFile",
            &[("path", &requested), ("error", &error.to_string())],
        ))?;
        return Ok(build_preview_content(relative, size, mime, Some(&bytes)));
    }

    // 2) Grande demais para qualquer prévia (e sem preview inline): metadados.
    // Sem MIME aqui porque o conteúdo não foi inspecionado (um `.txt` enorme
    // também cai neste ramo e a UI o trata como binário sem prévia).
    if size > MAX_PREVIEW_BYTES as u64 * 8 {
        return Ok(build_binary_content(relative, size, true, None));
    }
    let bytes = std::fs::read(&file_path)
        .map_err(|error| crate::i18n::t_args(
            "workspace.errors.openFile",
            &[("path", &requested), ("error", &error.to_string())],
        ))?;
    // 3) Binário sem prévia inline: o MIME da extensão ajuda a UI a ser honesta.
    if bytes.iter().take(8_000).any(|byte| *byte == 0) {
        return Ok(build_binary_content(
            relative,
            size,
            false,
            mime_for_path(&file_path),
        ));
    }
    // 4) Texto: caminho inalterado (truncamento + detecção de encoding).
    let (text, encoding) = match std::str::from_utf8(&bytes) {
        Ok(text) => (text.to_string(), None),
        Err(_) => {
            let mut detector =
                chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
            detector.feed(&bytes, true);
            let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
            let (decoded, _, _) = encoding.decode(&bytes);
            (decoded.to_string(), Some(encoding.name().to_string()))
        }
    };
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    let text = if truncated {
        let mut boundary = MAX_PREVIEW_BYTES.min(text.len());
        while boundary > 0 && !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text[..boundary].to_string()
    } else {
        text
    };
    Ok(WorkspaceFileContent {
        path: relative,
        text,
        truncated,
        size,
        binary: false,
        encoding,
        mime_type: None,
        data_base64: None,
        preview_omitted: false,
    })
}

/// Prévia read-only de um arquivo do workspace (para a aba central).
#[tauri::command]
pub async fn read_workspace_file(
    state: State<'_, AppState>,
    workspace_id: String,
    path: String,
) -> Result<WorkspaceFileContent, String> {
    let root = workspace_path(&state, &workspace_id)?;
    read_file_content(&root, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[tokio::test]
    async fn agent_workspace_binding_requires_trust_and_an_idle_conversation() {
        let db = crate::db::Db::open_in_memory().expect("database");
        let input = crate::agents::normalize_input(crate::agents::AgentInput {
            name: "Agent".into(), role: "Assistant".into(), description: String::new(), avatar: crate::agents::AgentAvatar::emoji(""),
            department: "General".into(), provider_id: "provider".into(), model_id: "model".into(),
            fallback_provider_id: None, fallback_model_id: None, reasoning: None, instructions: String::new(),
            starters: Vec::new(), capabilities: Default::default(), memory_enabled: false, workspace_id: None,
            permission_mode: crate::domain::PermissionMode::Edit, docker_image: None, computer_environment: "auto".into(),
            template: None,
        }).expect("agent input");
        let agent = db.create_agent(&input).expect("agent");
        let conversation = db.create_agent_conversation(&agent.id, "Thread").expect("conversation");
        let workspace = db.create_workspace("Project", "test-workspace").expect("workspace");
        let error = bind_conversation_workspace(&db, &conversation.id, Some(&workspace.id), None).await.expect_err("untrusted");
        assert!(error.contains("AGENT_WORKSPACE_UNTRUSTED"));
        db.set_workspace_trusted(&workspace.id, true).expect("trust");
        let gate = crate::agents::workspace_gate(&conversation.id);
        let turn = gate.read().await;
        let error = bind_conversation_workspace(&db, &conversation.id, Some(&workspace.id), None).await.expect_err("busy");
        assert!(error.contains("AGENT_WORKSPACE_BUSY"));
        assert_eq!(db.get_conversation(&conversation.id).expect("lookup").expect("conversation").workspace_id, None);
        drop(turn);
        let bound = bind_conversation_workspace(&db, &conversation.id, Some(&workspace.id), None).await.expect("bind");
        assert_eq!(bound.workspace_id.as_deref(), Some(workspace.id.as_str()));
        let reset = bind_conversation_workspace(&db, &conversation.id, None, None).await.expect("reset");
        assert!(reset.workspace_id.is_none());
    }

    /// PNG 1x1 real (RGBA transparente, 70 bytes) usado para provar o
    /// round-trip do payload base64 (o backend não decodifica imagem).
    const TINY_PNG_BASE64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";

    fn tiny_png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(TINY_PNG_BASE64)
            .expect("fixture PNG")
    }

    fn temp_workspace() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        std::fs::create_dir_all(&root).expect("criar workspace");
        (temp, root)
    }

    #[test]
    fn tree_builder_nests_and_sorts_dirs_first() {
        let entries = vec![
            ("src".to_string(), true, 0),
            ("src/app.ts".to_string(), false, 12),
            ("src/lib".to_string(), true, 0),
            ("src/lib/util.ts".to_string(), false, 4),
            ("README.md".to_string(), false, 8),
        ];
        let tree = build_tree(&entries, ".");
        assert_eq!(tree[0].name, "src");
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children.len(), 2);
        assert_eq!(tree[1].name, "README.md");
    }

    #[test]
    fn lists_the_workspace_tree_from_the_root_and_subdirectories() {
        // Regressão da aba Arquivos: `list_workspace_files(".", …)` quebrava com
        // `FS_NOT_A_FILE: '.' é um diretório` porque a resolução de leitura
        // recusava diretórios.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("src").join("lib")).expect("dirs");
        std::fs::write(dir.path().join("README.md"), "ok").expect("readme");
        std::fs::write(dir.path().join("src").join("app.ts"), "export {}").expect("app");
        std::fs::write(dir.path().join("src").join("lib").join("util.ts"), "x").expect("util");

        let root = list_tree(dir.path(), ".", 2).expect("listar root");
        assert!(root.iter().any(|entry| entry.name == "src" && entry.is_dir));
        assert!(root.iter().any(|entry| entry.name == "README.md"));
        let src = root.iter().find(|entry| entry.name == "src").expect("src");
        assert!(src.children.iter().any(|child| child.name == "app.ts"));

        let sub = list_tree(dir.path(), "src", 1).expect("listar src");
        assert!(sub.iter().any(|entry| entry.name == "app.ts"));

        // Arquivo não é diretório; fora do workspace não escapa.
        let file_as_dir = list_tree(dir.path(), "README.md", 1).expect_err("arquivo");
        assert!(file_as_dir.contains("FS_NOT_A_FILE"), "{file_as_dir}");
        let outside = list_tree(dir.path(), "../", 1).expect_err("fora");
        assert!(outside.contains("FS_OUTSIDE_WORKSPACE"), "{outside}");
    }

    #[test]
    fn lists_hidden_and_ignored_files_in_the_files_tab() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("README.md"), "ok").expect("readme");
        std::fs::write(dir.path().join(".env"), "SECRET=1").expect("hidden env");
        std::fs::write(dir.path().join(".gitignore"), "dist/\nsecret.log\n").expect("gitignore");
        std::fs::create_dir(dir.path().join("dist")).expect("dist dir");
        std::fs::write(dir.path().join("dist").join("bundle.js"), "x").expect("bundle");
        std::fs::write(dir.path().join("secret.log"), "x").expect("ignored log");
        std::fs::write(dir.path().join(".ignore"), "cache.txt\n").expect("ignore file");
        std::fs::write(dir.path().join("cache.txt"), "x").expect("ignore-crate entry");
        std::fs::create_dir(dir.path().join(".git")).expect("git dir");
        std::fs::write(dir.path().join(".git").join("HEAD"), "ref: refs/heads/main\n")
            .expect("git HEAD");

        fn paths_of(entries: &[WorkspaceFileEntry], out: &mut Vec<String>) {
            for entry in entries {
                out.push(entry.path.clone());
                paths_of(&entry.children, out);
            }
        }

        let tree = list_tree(dir.path(), ".", 2).expect("list tree");
        let mut paths = Vec::new();
        paths_of(&tree, &mut paths);
        for expected in [
            "README.md",
            ".env",
            ".gitignore",
            "dist/bundle.js",
            "secret.log",
            ".ignore",
            "cache.txt",
            ".git/HEAD",
        ] {
            assert!(paths.contains(&expected.to_string()), "missing {expected} in {paths:?}");
        }
    }

    #[test]
    fn project_info_maps_checks() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        )
        .expect("write");
        let info = project_info(dir.path());
        assert_eq!(info.kind, "rust");
        assert!(!info.checks.is_empty());
        assert!(info.checks.iter().any(|check| check.command.contains("cargo")));
        assert_eq!(info.checked_ecosystems, vec!["rust"]);
    }

    #[test]
    fn preview_mime_supports_pdf_and_webview_images_only() {
        for (name, expected) in [
            ("arquivo.pdf", "application/pdf"),
            ("foto.png", "image/png"),
            ("foto.JPG", "image/jpeg"),
            ("foto.jpeg", "image/jpeg"),
            ("foto.jfif", "image/jpeg"),
            ("foto.webp", "image/webp"),
            ("foto.gif", "image/gif"),
            ("foto.avif", "image/avif"),
            ("foto.bmp", "image/bmp"),
            ("icone.ico", "image/x-icon"),
        ] {
            assert_eq!(preview_mime(Path::new(name)), Some(expected), "{name}");
        }
        // SVG é texto; TIFF/HEIC o WebView não abre; código, arquivo sem
        // extensão e arquivos compactados continuam no caminho antigo.
        for name in [
            "vetor.svg",
            "scan.tiff",
            "scan.tif",
            "foto.heic",
            "main.rs",
            "notas.txt",
            "pacote.zip",
            "sem_extensao",
        ] {
            assert_eq!(preview_mime(Path::new(name)), None, "{name}");
        }
    }

    #[test]
    fn inline_payload_limit_is_24_mib() {
        assert_eq!(MAX_INLINE_PREVIEW_BYTES, 24 * 1024 * 1024);
        assert_eq!(preview_payload_for_size(0), PreviewPayload::Inline);
        assert_eq!(
            preview_payload_for_size(MAX_INLINE_PREVIEW_BYTES),
            PreviewPayload::Inline
        );
        assert_eq!(
            preview_payload_for_size(MAX_INLINE_PREVIEW_BYTES + 1),
            PreviewPayload::Omitted
        );
        assert_eq!(
            preview_payload_for_size(MAX_INLINE_PREVIEW_BYTES * 4),
            PreviewPayload::Omitted
        );
    }

    #[test]
    fn omitted_preview_keeps_metadata_without_payload() {
        let content =
            build_preview_content("scan.pdf".to_string(), 30_000_000, "application/pdf", None);
        assert!(content.binary);
        assert!(content.text.is_empty());
        assert!(!content.truncated);
        assert!(content.preview_omitted);
        assert!(content.data_base64.is_none());
        assert!(content.encoding.is_none());
        assert_eq!(content.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(content.size, 30_000_000);
    }

    #[test]
    fn png_preview_ships_inline_base64() {
        let (_temp, root) = temp_workspace();
        let png = tiny_png();
        std::fs::write(root.join("pixel.png"), &png).expect("criar png");
        let content = read_file_content(&root, "pixel.png").expect("prévia png");
        assert_eq!(content.path, "pixel.png");
        assert!(content.binary);
        assert!(content.text.is_empty());
        assert!(!content.truncated);
        assert!(!content.preview_omitted);
        assert!(content.encoding.is_none());
        assert_eq!(content.size, png.len() as u64);
        assert_eq!(content.mime_type.as_deref(), Some("image/png"));
        let payload = content.data_base64.expect("payload inline");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .expect("base64 deve decodificar");
        assert_eq!(decoded, png);
    }

    #[test]
    fn pdf_preview_ships_inline_base64() {
        let (_temp, root) = temp_workspace();
        let pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
        std::fs::write(root.join("manual.PDF"), pdf).expect("criar pdf");
        let content = read_file_content(&root, "manual.PDF").expect("prévia pdf");
        assert_eq!(content.path, "manual.PDF");
        assert!(content.binary);
        assert!(!content.preview_omitted);
        assert_eq!(content.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(content.size, pdf.len() as u64);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(content.data_base64.expect("payload inline"))
            .expect("base64 deve decodificar");
        assert_eq!(decoded, pdf);
    }

    #[test]
    fn text_preview_keeps_text_path_without_payload() {
        let (_temp, root) = temp_workspace();
        std::fs::create_dir_all(root.join("src")).expect("criar src");
        std::fs::write(root.join("src").join("main.rs"), "fn main() {}\n").expect("criar rs");
        std::fs::write(root.join("notas.txt"), "olá\n").expect("criar txt");
        for (relative, expected) in [("src/main.rs", "fn main() {}\n"), ("notas.txt", "olá\n")] {
            let content = read_file_content(&root, relative).expect("prévia texto");
            assert_eq!(content.path, relative);
            assert!(!content.binary);
            assert_eq!(content.text, expected);
            assert!(!content.truncated);
            assert!(content.mime_type.is_none());
            assert!(content.data_base64.is_none());
            assert!(!content.preview_omitted);
            assert!(content.encoding.is_none());
        }
    }

    #[test]
    fn unsupported_binary_preview_reports_mime_without_payload() {
        let (_temp, root) = temp_workspace();
        let zip = b"PK\x03\x04\x14\x00\x00\x00\x00\x00".to_vec();
        std::fs::write(root.join("pacote.zip"), &zip).expect("criar zip");
        let content = read_file_content(&root, "pacote.zip").expect("prévia zip");
        assert!(content.binary);
        assert!(content.text.is_empty());
        assert!(!content.truncated);
        assert!(!content.preview_omitted);
        assert_eq!(content.mime_type.as_deref(), Some("application/zip"));
        assert!(content.data_base64.is_none());
        assert_eq!(content.size, zip.len() as u64);
    }

    #[test]
    fn tiff_preview_is_binary_without_inline_payload() {
        let (_temp, root) = temp_workspace();
        // Cabeçalho TIFF little-endian válido (`II*\0` + offset do primeiro IFD).
        let tiff = b"II*\x00\x08\x00\x00\x00".to_vec();
        std::fs::write(root.join("scan.tiff"), &tiff).expect("criar tiff");
        let content = read_file_content(&root, "scan.tiff").expect("prévia tiff");
        assert!(content.binary);
        assert!(content.text.is_empty());
        assert_eq!(content.mime_type.as_deref(), Some("image/tiff"));
        assert!(content.data_base64.is_none());
        assert!(!content.preview_omitted);
        assert_eq!(content.size, tiff.len() as u64);
    }

    #[test]
    fn svg_stays_in_the_text_path() {
        let (_temp, root) = temp_workspace();
        std::fs::write(
            root.join("vetor.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .expect("criar svg");
        let content = read_file_content(&root, "vetor.svg").expect("prévia svg");
        assert!(!content.binary);
        assert!(content.text.contains("<svg"));
        assert!(content.mime_type.is_none());
        assert!(content.data_base64.is_none());
        assert!(!content.preview_omitted);
    }

    #[test]
    fn supported_image_above_text_cutoff_is_still_read_inline() {
        // Regressão do contrato: a prévia de imagem/PDF decide ANTES do corte
        // textual de 4 MiB (fotos reais passam de 4 MiB e continuam inline).
        let (_temp, root) = temp_workspace();
        let mut png = tiny_png();
        png.resize(MAX_PREVIEW_BYTES * 8 + 1, 0);
        std::fs::write(root.join("foto.png"), &png).expect("criar png grande");
        let content = read_file_content(&root, "foto.png").expect("prévia png grande");
        assert!(content.binary);
        assert!(!content.truncated);
        assert!(!content.preview_omitted);
        assert_eq!(content.mime_type.as_deref(), Some("image/png"));
        assert_eq!(content.size, png.len() as u64);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(content.data_base64.expect("payload inline"))
            .expect("base64 deve decodificar");
        assert_eq!(decoded, png);
    }

    #[test]
    fn read_file_content_keeps_confinement_errors() {
        let (temp, root) = temp_workspace();
        let outside = temp.path().join("fora.txt");
        std::fs::write(&outside, "x").expect("criar fora");
        let escaped =
            read_file_content(&root, &outside.to_string_lossy()).expect_err("fora do workspace");
        assert!(escaped.contains("FS_OUTSIDE_WORKSPACE"), "{escaped}");
        std::fs::create_dir_all(root.join("dir")).expect("criar dir");
        let directory = read_file_content(&root, "dir").expect_err("diretório");
        assert!(directory.contains("FS_NOT_A_FILE"), "{directory}");
    }

    #[test]
    fn tree_snapshot_lists_root_and_extra_dirs() {
        let (_temp, root) = temp_workspace();
        std::fs::create_dir_all(root.join("src")).expect("criar src");
        std::fs::create_dir_all(root.join("deep").join("inner")).expect("criar deep");
        std::fs::write(root.join("src").join("app.ts"), "export {}").expect("criar app");
        std::fs::write(root.join("deep").join("inner").join("view.ts"), "x").expect("criar view");

        let (files, dirs) =
            tree_snapshot(&root, &["deep".to_string(), "nao-existe".to_string()])
                .expect("snapshot da árvore");
        let src = files.iter().find(|entry| entry.path == "src").expect("src na raiz");
        assert!(src.children.iter().any(|child| child.path == "src/app.ts"));
        let deep = dirs.get("deep").expect("deep recarregado");
        assert!(deep.iter().any(|entry| entry.path == "deep/inner" && entry.is_dir));
        assert!(dirs.get("nao-existe").expect("entrada pedida").is_empty());
    }
}
