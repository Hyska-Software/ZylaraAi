//! Contexto do turno do perfil Code: workspace, git, projeto, instruções
//! (`AGENTS.md`/`CLAUDE.md`), árvore resumida e estado da sessão (plano/tarefas).
//!
//! É montado **uma vez por turno** (o loop reusa) e alimenta o system prompt e
//! a política de permissões (`docs/goals/code-harness/HARNESS.md` §10.4).

use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::domain::{
    Conversation, GitInfo, GoalView, PermissionMode, PlanView, ProjectCheckInfo, ProjectInfo,
    TodoItem, TurnKind, Workspace,
};

use super::{goal, prompt, session};

/// Limite do bloco de instruções do projeto injetado no prompt (mesmo
/// racional do Codex).
const MAX_AGENTS_CHARS: usize = 32_768;
/// Arquivos de instrução do projeto, na ordem de leitura: o padrão
/// multiagente (`AGENTS.md`), o do Claude Code (`CLAUDE.md`) e o específico do
/// app (`.zylara/instructions.md`).
const INSTRUCTION_FILES: &[(&str, &str)] = &[
    ("AGENTS.md", "AGENTS.md"),
    ("CLAUDE.md", "CLAUDE.md"),
    (".zylara/instructions.md", ".zylara/instructions.md"),
];
/// Limite da árvore resumida.
const MAX_TREE_CHARS: usize = 4_000;
/// Nomes de diretórios que nunca entram na árvore/prompt.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
    ".turbo",
    ".cache",
    "coverage",
];

/// Diretório de trabalho efetivo do turno (workspace + projeto + instruções).
#[derive(Debug, Clone, Default)]
pub struct CodeTurnContext {
    pub workspace: Option<Workspace>,
    pub root: Option<PathBuf>,
    pub trusted: bool,
    /// App-owned per-conversation folder created for an agent without an
    /// explicit workspace. It is a real tool root but not a visible workspace.
    pub internal: bool,
    pub permission_mode: PermissionMode,
    pub git: Option<GitInfo>,
    pub project: Option<crate::workspace::project::ProjectProfile>,
    pub agents_md: Option<String>,
    pub tree: Option<String>,
    pub todos: Vec<TodoItem>,
    pub plan: Option<PlanView>,
    pub plan_mode: bool,
    /// Plugin Creator mode (`/creator`): adds the plugin workflow and the
    /// `validate_plugin` tool without changing Plan/permission modes.
    pub creator_mode: bool,
    /// Objetivo persistente da sessão (`docs/goals/code-goals/PLAN.md`).
    pub goal: Option<GoalView>,
    /// Tipo do turno: `goal_round` (rodada automática) muda o texto da seção
    /// `## Objective` do contexto volátil.
    pub turn_kind: TurnKind,
    /// O usuário pediu um objetivo pelo `/goal` neste turno (ver `TurnPayload`).
    pub goal_request: bool,
    /// Read-only subagent turn (`delegation_depth > 0`): switches the base
    /// prompt to an investigator identity without editing/`ask_user` sections.
    pub subagent: bool,
    /// Autonomous worker subagent: keeps the editing/verification rules and
    /// the write+shell catalog.
    pub subagent_writable: bool,
    /// Plugin mode catalog delta for this turn (`contributes.modes[].tools`).
    /// A mode can hide tools or re-expose catalog tools; `mode_writes_blocked`
    /// hides mutating tools while the mode is active.
    pub mode_tools_add: Vec<String>,
    pub mode_tools_remove: Vec<String>,
    pub mode_writes_blocked: bool,
}

impl CodeTurnContext {
    /// Contexto de prompt (tipos do módulo `prompt`).
    pub fn prompt_context(&self) -> prompt::CodeContext {
        prompt::CodeContext {
            internal: self.internal,
            workspace_name: self
                .workspace
                .as_ref()
                .map(|workspace| workspace.name.clone())
                .or_else(|| self.internal.then(|| "Pasta do agente".to_string())),
            workspace_path: self
                .root
                .as_ref()
                .map(|root| root.to_string_lossy().to_string()),
            git: self.git.clone(),
            project: self.project.as_ref().map(project_info),
            agents_md: self.agents_md.clone(),
            tree: self.tree.clone(),
            todos: self.todos.clone(),
            plan: self.plan.clone(),
            plan_mode: self.plan_mode,
            creator_mode: self.creator_mode,
            permission_mode: self.permission_mode,
            goal: self.goal.clone(),
            turn_kind: self.turn_kind,
            goal_request: self.goal_request,
            subagent: self.subagent,
            subagent_writable: self.subagent_writable,
        }
    }

    /// Handle entregue às tools que exigem workspace.
    pub fn workspace_handle(&self) -> Option<crate::tools::registry::WorkspaceHandle> {
        let root = self.root.clone()?;
        Some(crate::tools::registry::WorkspaceHandle {
            root,
            trusted: self.trusted,
            internal: self.internal,
            permission_mode: self.permission_mode,
        })
    }
}

fn project_info(profile: &crate::workspace::project::ProjectProfile) -> ProjectInfo {
    ProjectInfo {
        kind: profile.kind.clone(),
        name: profile.name.clone(),
        checks: profile
            .checks
            .iter()
            .map(|check| ProjectCheckInfo {
                id: check.id.clone(),
                label: check.label.clone(),
                command: check.command.clone(),
            })
            .collect(),
        checked_ecosystems: profile.checked_ecosystems.clone(),
    }
}

/// Monta o contexto do turno a partir do banco e do disco (turno humano).
pub async fn build(db: &Db, conversation: &Conversation) -> CodeTurnContext {
    build_for_turn(db, conversation, TurnKind::User).await
}

/// Idem, informando o tipo do turno: o `run_turn` passa o `turnKind` do payload
/// (o tipo não é persistido na conversa). A rodada lê o objetivo **já aberto**
/// (`begin_round` roda antes da montagem do contexto).
pub async fn build_for_turn(
    db: &Db,
    conversation: &Conversation,
    turn_kind: TurnKind,
) -> CodeTurnContext {
    let mut context = CodeTurnContext {
        permission_mode: conversation.permission_mode,
        todos: session::todos(db, &conversation.id).unwrap_or_default(),
        plan: session::plan_view(db, &conversation.id).ok().flatten(),
        plan_mode: session::plan_mode_active(db, &conversation.id).unwrap_or(false),
        creator_mode: session::creator_mode_active(db, &conversation.id).unwrap_or(false),
        goal: goal::current(db, &conversation.id).ok().flatten(),
        turn_kind,
        ..Default::default()
    };

    let Some(workspace_id) = conversation.workspace_id.as_deref() else {
        return context;
    };
    let Ok(Some(workspace)) = db.get_workspace(workspace_id) else {
        return context;
    };
    let root = PathBuf::from(&workspace.path);
    context.trusted = workspace.trusted;
    if !root.is_dir() {
        context.workspace = Some(workspace);
        return context;
    }
    context.git = git_info(&root).await;
    context.project = Some(crate::workspace::project::detect(&root));
    // Untrusted workspaces are read-only until the user trusts them: their
    // instruction files must not steer the agent before that decision.
    if context.trusted {
        context.agents_md = read_instructions(&root);
    }
    context.tree = tree_summary(&root);
    context.workspace = Some(workspace);
    context.root = Some(root);
    context
}

async fn git_info(root: &Path) -> Option<GitInfo> {
    let status = crate::workspace::git::detect(root).await;
    if !status.is_repo {
        return None;
    }
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
}

/// Reads the repository instruction files that exist at the workspace root,
/// concatenating them with source markers. Identical contents (for example a
/// `CLAUDE.md` that mirrors `AGENTS.md`) are included once.
pub fn read_instructions(root: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for &(relative, label) in INSTRUCTION_FILES {
        let path = root.join(relative);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() || seen.iter().any(|previous| previous == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
        parts.push(format!("<!-- {label} -->\n{}", trimmed));
    }
    if parts.is_empty() {
        return None;
    }
    let joined = parts.join("\n\n");
    if joined.chars().count() > MAX_AGENTS_CHARS {
        return Some(
            joined.chars().take(MAX_AGENTS_CHARS).collect::<String>() + "\n…[instruções truncadas]",
        );
    }
    Some(joined)
}

/// Resumo da árvore (2 níveis, diretórios com contagens) para o prompt.
pub fn tree_summary(root: &Path) -> Option<String> {
    fn walk(dir: &Path, depth: u32, max_depth: u32, out: &mut String, budget: &mut usize) {
        if *budget == 0 || depth > max_depth {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut items: Vec<(String, bool)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') && name != ".github" && name != ".zylara" {
                    return None;
                }
                if IGNORED_DIRS.contains(&name.as_str()) {
                    return None;
                }
                let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
                Some((name, is_dir))
            })
            .collect();
        items.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        for (name, is_dir) in items {
            if *budget == 0 {
                return;
            }
            let indent = "  ".repeat(depth as usize);
            if is_dir {
                let child = dir.join(&name);
                let (files, dirs) = count_children(&child);
                let line = format!("{indent}{name}/ ({files} arquivos, {dirs} dirs)\n");
                *budget = budget.saturating_sub(line.len());
                out.push_str(&line);
                walk(&child, depth + 1, max_depth, out, budget);
            } else {
                let line = format!("{indent}{name}\n");
                *budget = budget.saturating_sub(line.len());
                out.push_str(&line);
            }
        }
    }

    fn count_children(dir: &Path) -> (usize, usize) {
        let mut files = 0;
        let mut dirs = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => dirs += 1,
                    Ok(_) => files += 1,
                    Err(_) => {}
                }
            }
        }
        (files, dirs)
    }

    let mut out = String::new();
    let mut budget = MAX_TREE_CHARS;
    walk(root, 0, 1, &mut out, &mut budget);
    if out.trim().is_empty() {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::CONVERSATION_MODE_CODE;

    fn conversation(workspace_id: Option<String>) -> Conversation {
        Conversation {
            id: "conv-1".to_string(),
            title: "Sessão".to_string(),
            created_at: 0,
            updated_at: 0,
            pinned: false,
            sort_order: 0,
            provider_id: "opencode-go".to_string(),
            model_id: "deepseek-v4.1-flash".to_string(),
            message_count: 0,
            preview: None,
            mode: CONVERSATION_MODE_CODE.to_string(),
            code_linked: false,
            workspace_id,
            agent_kind: "zylara".to_string(),
            permission_mode: PermissionMode::Edit,
            parent_conversation_id: None,
            subagent_task_call_id: None,
            subagent_type: None,
            agent_id: None,
            channel_id: None,
            task_id: None,
            is_main: false,
        }
    }

    #[tokio::test]
    async fn builds_context_without_workspace() {
        let db = Db::open_in_memory().expect("db");
        let context = build(&db, &conversation(None)).await;
        assert!(context.workspace.is_none());
        assert!(context.prompt_context().workspace_path.is_none());
        assert!(!context.plan_mode);
        assert!(context.goal.is_none());
        assert_eq!(context.turn_kind, crate::domain::TurnKind::User);
    }

    #[tokio::test]
    async fn context_carries_the_goal_and_the_turn_kind() {
        let db = Db::open_in_memory().expect("db");
        let conv = conversation(None);
        let goal = goal::create(
            &db,
            &conv.id,
            &crate::domain::CreateGoalInput {
                objective: "Migrar pagamentos".into(),
                title: None,
                max_rounds: Some(10),
                auto_continue: Some(true),
            },
            crate::domain::GoalOrigin::User,
        )
        .expect("objetivo");
        let context = build_for_turn(&db, &conv, crate::domain::TurnKind::GoalRound).await;
        assert_eq!(context.turn_kind, crate::domain::TurnKind::GoalRound);
        assert_eq!(
            context.goal.as_ref().map(|goal| goal.revision),
            Some(goal.revision)
        );
        let prompt_context = context.prompt_context();
        assert_eq!(
            prompt_context.turn_kind,
            crate::domain::TurnKind::GoalRound
        );
        assert!(prompt_context.goal.is_some());
        // O turno humano não recebe o texto de continuação, mas o objetivo
        // continua visível como contexto.
        let human = build(&db, &conv).await;
        assert_eq!(human.turn_kind, crate::domain::TurnKind::User);
        assert!(human.goal.is_some());
    }

    #[tokio::test]
    async fn reads_agents_md_and_tree_from_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("AGENTS.md"), "# Regras\n\nUse pnpm.\n").expect("agents");
        std::fs::create_dir_all(dir.path().join("src")).expect("src");
        std::fs::write(dir.path().join("src/app.ts"), "export const a = 1;\n").expect("file");
        std::fs::create_dir_all(dir.path().join("node_modules/x")).expect("node_modules");
        let db = Db::open_in_memory().expect("db");
        let workspace = db
            .create_workspace("demo", &dir.path().to_string_lossy())
            .expect("workspace");
        db.set_workspace_trusted(&workspace.id, true)
            .expect("trust");
        let mut conv = conversation(Some(workspace.id.clone()));
        conv.mode = CONVERSATION_MODE_CODE.to_string();
        let context = build(&db, &conv).await;
        assert!(context.trusted);
        assert_eq!(context.permission_mode, PermissionMode::Edit);
        assert!(context.agents_md.as_deref().unwrap().contains("Use pnpm"));
        let tree = context.tree.as_deref().unwrap();
        assert!(tree.contains("src/"));
        assert!(!tree.contains("node_modules"));
        assert!(context.workspace.is_some());
    }

    #[test]
    fn reads_agents_md_and_claude_md_with_source_markers() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("AGENTS.md"), "# Agents\n\nUse pnpm.\n").expect("agents");
        std::fs::write(dir.path().join("CLAUDE.md"), "# Claude\n\nUse pnpm too.\n").expect("claude");
        std::fs::create_dir_all(dir.path().join(".zylara")).expect(".zylara");
        std::fs::write(
            dir.path().join(".zylara/instructions.md"),
            "# App\n\nPrefer the app tools.\n",
        )
        .expect("instructions");
        let block = read_instructions(dir.path()).expect("instructions");
        let agents = block.find("<!-- AGENTS.md -->").expect("agents marker");
        let claude = block.find("<!-- CLAUDE.md -->").expect("claude marker");
        let app = block
            .find("<!-- .zylara/instructions.md -->")
            .expect("app marker");
        assert!(agents < claude && claude < app, "ordem: {block}");
        assert!(block.contains("Use pnpm."));
        assert!(block.contains("Use pnpm too."));
        assert!(block.contains("Prefer the app tools."));
    }

    #[test]
    fn ignores_duplicate_instruction_contents() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("AGENTS.md"), "# Shared rules\n").expect("agents");
        std::fs::write(dir.path().join("CLAUDE.md"), "  # Shared rules\n\n").expect("claude");
        let block = read_instructions(dir.path()).expect("instructions");
        assert_eq!(block.matches("Shared rules").count(), 1, "{block}");
        assert!(!block.contains("<!-- CLAUDE.md -->"), "{block}");
    }

    #[tokio::test]
    async fn untrusted_workspace_does_not_load_instruction_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("AGENTS.md"), "# Regras\n\nUse pnpm.\n").expect("agents");
        let db = Db::open_in_memory().expect("db");
        let workspace = db
            .create_workspace("demo", &dir.path().to_string_lossy())
            .expect("workspace");
        let mut conv = conversation(Some(workspace.id.clone()));
        conv.mode = CONVERSATION_MODE_CODE.to_string();

        let untrusted = build(&db, &conv).await;
        assert!(!untrusted.trusted);
        assert!(
            untrusted.agents_md.is_none(),
            "workspace não confiável não injeta instruções"
        );

        db.set_workspace_trusted(&workspace.id, true)
            .expect("trust");
        let trusted = build(&db, &conv).await;
        assert!(trusted.trusted);
        assert!(trusted.agents_md.as_deref().unwrap().contains("Use pnpm"));
    }

    #[test]
    fn internal_workspace_is_named_for_the_prompt() {
        let context = CodeTurnContext {
            internal: true,
            root: Some(std::path::PathBuf::from("C:/zylara/agent-workspaces/abc")),
            ..CodeTurnContext::default()
        };
        let prompt = context.prompt_context();
        assert_eq!(prompt.workspace_name.as_deref(), Some("Pasta do agente"));
        assert_eq!(
            prompt.workspace_path.as_deref(),
            Some("C:/zylara/agent-workspaces/abc")
        );
    }
}
