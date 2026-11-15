//! Local skills (Markdown instructions) available to the agent.
//!
//! Two sources are merged, user first by name:
//! * bundled: `src-tauri/skills/` embedded with [`include_dir!`] and materialized
//!   into `<app-data>/skills-bundled/` on every read (the app version wins);
//! * user: `<app-data>/skills/<name>/SKILL.md`, re-read on every turn.
//!
//! A skill directory may contain `scripts/`, `references/`, etc.; every file
//! except `SKILL.md` is listed by `read_skill` as an absolute path so the model
//! can execute helpers with `run_code`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domain::SkillSummary;
use crate::i18n::{t, t_args};
use crate::providers::ToolDefinition;

use super::{json_str, ToolOutcome, ToolRuntime};

/// Embedded skills, compiled into the binary.
static BUNDLED_SKILLS: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/skills");

const SKILL_FILE: &str = "SKILL.md";
const BUNDLED_DIR: &str = "skills-bundled";
const USER_DIR: &str = "skills";
/// `[a-z0-9][a-z0-9-]{0,63}` → at most 64 characters.
const MAX_NAME_CHARS: usize = 64;
/// Real repositories (Agent Skills/Codex) ship descriptions well above 200
/// chars (the largest seen is ~900); the prompt truncates them for the model.
const MAX_DESCRIPTION_CHARS: usize = 1024;
/// Instructions may be large in real repositories (some are ~100 KB).
const MAX_BODY_BYTES: usize = 512 * 1024;
/// Defensive cap for the file list returned to the model.
const MAX_SKILL_FILES: usize = 200;
/// Files nested deeper than this are ignored by the listing.
const MAX_FILE_DEPTH: usize = 4;

/// Serially materializes the bundled skills (the same app-data dir may be read
/// by the harness and by the settings screen at the same time).
static MATERIALIZE_LOCK: once_cell::sync::Lazy<parking_lot::Mutex<()>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillSource {
    /// `<app-data>/skills-bundled/` (materialized from `src-tauri/skills/`).
    Bundled,
    /// `<app-data>/skills/` (managed by the user through the Zylara UI).
    User,
    /// `~/.agents/skills/` (shared Agent Skills repository).
    Agents,
    /// Codex CLI: `$CODEX_HOME/skills` or `~/.codex/skills`.
    Codex,
    /// Claude Code: `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`.
    Claude,
    /// OpenCode: `$XDG_CONFIG_HOME/opencode/skills`, `~/.config/opencode/skills`
    /// or `%APPDATA%\opencode\skills` on Windows.
    OpenCode,
    /// Packaged by an enabled plugin; the id is in `plugin_id`.
    Plugin,
}

impl SkillSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::User => "user",
            Self::Agents => "agents",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::OpenCode => "opencode",
            Self::Plugin => "plugin",
        }
    }

    /// External repositories are used by other agents (Codex/OpenCode/Claude);
    /// Zylara only reads them.
    pub fn is_external(self) -> bool {
        matches!(
            self,
            Self::Agents | Self::Codex | Self::Claude | Self::OpenCode
        )
    }
}

/// A standard skills repository of another agent (Codex/OpenCode/Claude/Agent
/// Skills). Read-only: Zylara never writes to these directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalSkillRoot {
    pub source: SkillSource,
    pub dir: PathBuf,
    /// Owning plugin for `SkillSource::Plugin`.
    pub plugin_id: Option<String>,
}

/// Standard skills repositories of the current user, in precedence order
/// (`agents` > `codex` > `claude` > `opencode`). Only paths that exist are
/// returned, so callers can scan them without extra checks.
pub fn standard_external_roots() -> Vec<ExternalSkillRoot> {
    let home = home_directory();
    let codex_home = environment_path("CODEX_HOME");
    let claude_config = environment_path("CLAUDE_CONFIG_DIR");
    let xdg_config = environment_path("XDG_CONFIG_HOME");
    let appdata = environment_path("APPDATA");
    external_roots_from(
        home.as_deref().unwrap_or_else(|| Path::new("")),
        codex_home.as_deref(),
        claude_config.as_deref(),
        xdg_config.as_deref(),
        appdata.as_deref(),
    )
}

/// Pure helper for [`standard_external_roots`] (testable without touching the
/// real environment).
///
/// Candidates: `~/.agents/skills`; `$CODEX_HOME/skills` or `~/.codex/skills`;
/// `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`; `$XDG_CONFIG_HOME/opencode/skills`
/// (fallback `~/.config/opencode/skills`) plus `%APPDATA%/opencode/skills`.
/// Missing directories are skipped and duplicated paths are emitted once.
pub fn external_roots_from(
    home: &Path,
    codex_home: Option<&Path>,
    claude_config: Option<&Path>,
    xdg_config: Option<&Path>,
    appdata: Option<&Path>,
) -> Vec<ExternalSkillRoot> {
    let has_home = !home.as_os_str().is_empty();
    let mut candidates: Vec<(SkillSource, PathBuf)> = Vec::new();

    if has_home {
        push_root_candidate(
            &mut candidates,
            SkillSource::Agents,
            home.join(".agents").join("skills"),
        );
    }
    match codex_home.filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => push_root_candidate(
            &mut candidates,
            SkillSource::Codex,
            dir.join("skills"),
        ),
        None if has_home => push_root_candidate(
            &mut candidates,
            SkillSource::Codex,
            home.join(".codex").join("skills"),
        ),
        None => {}
    }
    match claude_config.filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => push_root_candidate(
            &mut candidates,
            SkillSource::Claude,
            dir.join("skills"),
        ),
        None if has_home => push_root_candidate(
            &mut candidates,
            SkillSource::Claude,
            home.join(".claude").join("skills"),
        ),
        None => {}
    }
    let mut opencode_roots: Vec<PathBuf> = Vec::new();
    match xdg_config.filter(|dir| !dir.as_os_str().is_empty()) {
        Some(dir) => opencode_roots.push(dir.join("opencode").join("skills")),
        None if has_home => {
            opencode_roots.push(home.join(".config").join("opencode").join("skills"))
        }
        None => {}
    }
    if let Some(dir) = appdata.filter(|dir| !dir.as_os_str().is_empty()) {
        opencode_roots.push(dir.join("opencode").join("skills"));
    }
    for dir in opencode_roots {
        push_root_candidate(&mut candidates, SkillSource::OpenCode, dir);
    }

    candidates
        .into_iter()
        .map(|(source, dir)| ExternalSkillRoot {
            source,
            dir,
            plugin_id: None,
        })
        .filter(|root| root.dir.is_dir())
        .collect()
}

fn push_root_candidate(
    candidates: &mut Vec<(SkillSource, PathBuf)>,
    source: SkillSource,
    dir: PathBuf,
) {
    if !candidates.iter().any(|(_, existing)| existing == &dir) {
        candidates.push((source, dir));
    }
}

fn environment_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn home_directory() -> Option<PathBuf> {
    environment_path("USERPROFILE")
        .or_else(|| environment_path("HOME"))
        .or_else(|| {
            // Windows fallbacks: HOMEDRIVE + HOMEPATH (e.g. `C:` + `\Users\me`).
            let drive = environment_path("HOMEDRIVE")?;
            let path = environment_path("HOMEPATH")?;
            let mut combined = drive.into_os_string();
            let path = path.into_os_string();
            if !path.to_string_lossy().starts_with(['\\', '/']) {
                combined.push("\\");
            }
            combined.push(path);
            Some(PathBuf::from(combined))
        })
        .filter(|dir| !dir.as_os_str().is_empty())
}

#[derive(Debug, Clone)]
pub struct Skill {
    /// Canonical name from the frontmatter (validated slug).
    pub name: String,
    pub description: String,
    /// Instructions body (Markdown after the frontmatter).
    pub body: String,
    /// Absolute directory that contains `SKILL.md`.
    pub dir: PathBuf,
    pub source: SkillSource,
    /// Plugin id when `source == SkillSource::Plugin`.
    pub plugin_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDraft {
    pub name: String,
    pub description: String,
    pub content: String,
    pub overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersion {
    pub file: String,
    pub saved_at: i64,
}

impl Skill {
    pub fn source_str(&self) -> &'static str {
        self.source.as_str()
    }

    /// Store/UI label: `plugin:<id>` for packaged skills, plain source id
    /// otherwise. The prompt and config hash use this label.
    pub fn source_label(&self) -> String {
        match (&self.source, &self.plugin_id) {
            (SkillSource::Plugin, Some(id)) => format!("plugin:{id}"),
            _ => self.source_str().to_string(),
        }
    }

    /// Summary flags for the settings/management UI: `enabled` reflects the
    /// persisted `disabled_skills` list (activation is by name) and `deletable`
    /// is only true for user skills (the bundled ones can be disabled instead).
    pub fn summary(&self, disabled: &[String]) -> SkillSummary {
        SkillSummary {
            name: self.name.clone(),
            description: self.description.clone(),
            source: self.source_label(),
            enabled: is_enabled(&self.name, disabled),
            deletable: self.source == SkillSource::User,
        }
    }

    /// Absolute paths of every file of the skill except `SKILL.md`, sorted.
    pub fn files(&self) -> anyhow::Result<Vec<String>> {
        let mut files = Vec::new();
        collect_files(&self.dir, &mut files, 0)?;
        files.sort();
        Ok(files)
    }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/// Rewrites `<data_dir>/skills-bundled/` from the embedded directory and
/// returns its path. Also creates the (empty) user skills directory so the
/// settings screen can open it.
pub fn materialize_bundled(data_dir: &Path) -> anyhow::Result<PathBuf> {
    let _guard = MATERIALIZE_LOCK.lock();
    let target = data_dir.join(BUNDLED_DIR);
    if target.exists() {
        std::fs::remove_dir_all(&target).with_context(|| {
            let path = target.display().to_string();
            t_args("tools.skills.materializeCleanFailed", &[("path", &path)])
        })?;
    }
    std::fs::create_dir_all(&target).with_context(|| {
        let path = target.display().to_string();
        t_args("tools.skills.materializeCreateFailed", &[("path", &path)])
    })?;
    extract_embedded(&BUNDLED_SKILLS, &target)?;
    Ok(target)
}

fn extract_embedded(dir: &Dir<'_>, target: &Path) -> anyhow::Result<()> {
    for file in dir.files() {
        let path = target.join(file.path());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                let parent = parent.display().to_string();
                t_args("tools.skills.extractCreateFailed", &[("path", &parent)])
            })?;
        }
        std::fs::write(&path, file.contents()).with_context(|| {
            let path = path.display().to_string();
            t_args("tools.skills.extractWriteFailed", &[("path", &path)])
        })?;
    }
    for sub in dir.dirs() {
        extract_embedded(sub, target)?;
    }
    Ok(())
}

/// A skill is disabled when its (canonical) name is in `settings.disabled_skills`.
pub fn is_enabled(name: &str, disabled: &[String]) -> bool {
    !disabled.iter().any(|disabled_name| disabled_name == name)
}

/// Deterministic catalog using the standard external repositories
/// (`~/.agents/skills`, Codex, Claude Code, OpenCode). Precedence: Zylara user >
/// agents > codex > claude > opencode > bundled, dedupe by name (first source
/// wins), sorted alphabetically.
pub fn catalog(data_dir: &Path) -> anyhow::Result<Vec<Skill>> {
    catalog_with_roots(data_dir, &standard_external_roots())
}

/// Catalog with explicit external roots (testable / injectable). Bundled
/// skills are materialized first; user and external repositories are read-only.
pub fn catalog_with_roots(
    data_dir: &Path,
    external: &[ExternalSkillRoot],
) -> anyhow::Result<Vec<Skill>> {
    materialize_bundled(data_dir)?;
    let mut sources: Vec<Vec<Skill>> = Vec::with_capacity(external.len() + 2);
    sources.push(scan_skills(
        &data_dir.join(USER_DIR),
        SkillSource::User,
        None,
    ));
    for root in external {
        sources.push(scan_skills(
            &root.dir,
            root.source,
            root.plugin_id.clone(),
        ));
    }
    sources.push(scan_skills(
        &data_dir.join(BUNDLED_DIR),
        SkillSource::Bundled,
        None,
    ));
    Ok(merge_by_precedence(sources))
}

/// Catalog filtered by `settings.disabled_skills` (order preserved). This is
/// what the agent sees: prompt, `list_skills` and `read_skill`.
pub fn catalog_enabled(data_dir: &Path, disabled: &[String]) -> anyhow::Result<Vec<Skill>> {
    catalog_enabled_with_roots(data_dir, disabled, &standard_external_roots())
}

pub fn catalog_enabled_with_roots(
    data_dir: &Path,
    disabled: &[String],
    external: &[ExternalSkillRoot],
) -> anyhow::Result<Vec<Skill>> {
    Ok(catalog_with_roots(data_dir, external)?
        .into_iter()
        .filter(|skill| is_enabled(&skill.name, disabled))
        .collect())
}

/// Summaries of **all** installed skills (including disabled ones) with the
/// `enabled`/`deletable` flags. Used by the code environment status and by the
/// skills management UI (never fails: falls back to an empty list).
pub fn summaries(data_dir: &Path, disabled: &[String]) -> Vec<SkillSummary> {
    summaries_with_roots(data_dir, disabled, &standard_external_roots())
}

pub fn summaries_with_roots(
    data_dir: &Path,
    disabled: &[String],
    external: &[ExternalSkillRoot],
) -> Vec<SkillSummary> {
    catalog_with_roots(data_dir, external)
        .map(|skills| {
            skills
                .iter()
                .map(|skill| skill.summary(disabled))
                .collect()
        })
        .unwrap_or_default()
}

pub fn read(data_dir: &Path, name: &str) -> anyhow::Result<Option<Skill>> {
    read_with_roots(data_dir, name, &standard_external_roots())
}

pub fn read_with_roots(
    data_dir: &Path,
    name: &str,
    external: &[ExternalSkillRoot],
) -> anyhow::Result<Option<Skill>> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    Ok(catalog_with_roots(data_dir, external)?
        .into_iter()
        .find(|skill| skill.name == name))
}

/// Merges scans in precedence order; the first occurrence of a name wins.
fn merge_by_precedence(sources: Vec<Vec<Skill>>) -> Vec<Skill> {
    let mut by_name: BTreeMap<String, Skill> = BTreeMap::new();
    for skills in sources {
        for skill in skills {
            by_name.entry(skill.name.clone()).or_insert(skill);
        }
    }
    by_name.into_values().collect()
}

/// Shallow (one level) scan of `<root>/<skill>/SKILL.md`; hidden directories
/// (`.system`, …) and invalid skills are skipped so a broken repository never
/// breaks the whole turn.
fn scan_skills(root: &Path, source: SkillSource, plugin_id: Option<String>) -> Vec<Skill> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        // Hidden entries are tool-managed (e.g. `~/.codex/skills/.system`).
        let hidden = dir
            .file_name()
            .map(|name| name.to_string_lossy().starts_with('.'))
            .unwrap_or(false);
        if hidden || !dir.join(SKILL_FILE).is_file() {
            continue;
        }
        if let Ok(skill) = load_skill_with_plugin(&dir, source, plugin_id.clone()) {
            skills.push(skill);
        }
    }
    skills
}

fn load_skill(dir: &Path, source: SkillSource) -> anyhow::Result<Skill> {
    load_skill_with_plugin(dir, source, None)
}

fn load_skill_with_plugin(
    dir: &Path,
    source: SkillSource,
    plugin_id: Option<String>,
) -> anyhow::Result<Skill> {
    let path = dir.join(SKILL_FILE);
    let raw = std::fs::read_to_string(&path).with_context(|| {
        let path = path.display().to_string();
        t_args("tools.skills.loadReadFailed", &[("path", &path)])
    })?;
    let (name, description, body) = parse_frontmatter(&raw)?;
    if !is_valid_skill_name(&name) {
        let max = MAX_NAME_CHARS.to_string();
        bail!(
            "{}",
            t_args(
                "tools.skills.invalidName",
                &[("name", name.as_str()), ("max", &max)]
            )
        );
    }
    if description.is_empty() {
        bail!(
            "{}",
            t_args("tools.skills.missingDescription", &[("name", name.as_str())])
        );
    }
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        let max = MAX_DESCRIPTION_CHARS.to_string();
        bail!(
            "{}",
            t_args(
                "tools.skills.descriptionTooLong",
                &[("name", name.as_str()), ("max", &max)]
            )
        );
    }
    if body.len() > MAX_BODY_BYTES {
        bail!(
            "{}",
            t_args("tools.skills.bodyTooLarge", &[("name", name.as_str())])
        );
    }
    Ok(Skill {
        name,
        description,
        body,
        dir: dir.to_path_buf(),
        source,
        plugin_id,
    })
}

/// Parses the simple frontmatter used by skills (no YAML dependency):
///
/// ```text
/// ---
/// name: office-docx
/// description: Criar documentos Word (.docx) com script Python stdlib.
/// ---
/// # Instruções...
/// ```
///
/// Block scalars are supported because real Agent Skills repositories use them:
/// `description: >` / `>-` / `>+` (folded) and `|` / `|-` / `|+` (literal), with
/// indented continuation lines until the next top-level key or the closing
/// `---`. The description is normalized to a single line (prompt/UI friendly).
fn parse_frontmatter(raw: &str) -> anyhow::Result<(String, String, String)> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<&str> = raw.lines().collect();
    match lines.first() {
        Some(line) if line.trim() == "---" => {}
        _ => bail!("{}", t("tools.skills.frontmatterMissing")),
    }
    let mut index = 1usize;

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut closed = false;
    while index < lines.len() {
        let line = lines[index];
        if line.trim() == "---" {
            closed = true;
            index += 1;
            break;
        }
        if line.trim().is_empty() {
            index += 1;
            continue;
        }
        // Indented lines belong to `metadata:`-style nested mappings; they are
        // ignored (block scalar continuation is consumed with the key below).
        if line.starts_with(' ') || line.starts_with('\t') {
            index += 1;
            continue;
        }
        let Some((key, raw_value)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        let raw_value = raw_value.trim();
        index += 1;
        let value = match block_scalar_style(raw_value) {
            Some((style, chomp)) => {
                let (text, consumed) = read_block_scalar(&lines[index..], style, chomp);
                index += consumed;
                text
            }
            None => unquote(raw_value),
        };
        match key {
            "name" => name = Some(collapse_whitespace(&value)),
            "description" => description = Some(collapse_whitespace(&value)),
            // Forward-compatible: unknown metadata is ignored.
            _ => {}
        }
    }
    if !closed {
        bail!("{}", t("tools.skills.frontmatterUnclosed"));
    }

    let body = lines[index..].join("\n").trim().to_string();

    let name = name.ok_or_else(|| anyhow!(t("tools.skills.frontmatterNoName")))?;
    let description =
        description.ok_or_else(|| anyhow!(t("tools.skills.frontmatterNoDescription")))?;
    Ok((name, description, body))
}

/// Collapses all whitespace runs (including folded newlines) into single spaces.
fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockScalarStyle {
    Folded,
    Literal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockChomp {
    /// Default (clip): keep a single trailing newline.
    Clip,
    /// `-`: strip trailing newlines.
    Strip,
    /// `+`: keep trailing newlines.
    Keep,
}

/// `>` / `>-` / `>+` / `|` / `|-` / `|+` (with optional trailing comment).
fn block_scalar_style(value: &str) -> Option<(BlockScalarStyle, BlockChomp)> {
    let mut rest = value.trim();
    if let Some((head, _comment)) = rest.split_once(" #") {
        rest = head.trim_end();
    }
    let mut chars = rest.chars();
    let style = match chars.next()? {
        '>' => BlockScalarStyle::Folded,
        '|' => BlockScalarStyle::Literal,
        _ => return None,
    };
    let chomp = match rest[1..].trim() {
        "" => BlockChomp::Clip,
        "-" => BlockChomp::Strip,
        "+" => BlockChomp::Keep,
        // Explicit indentation indicators (`>2`) are not used by the skills we
        // read; treat them as the plain style instead of failing the skill.
        other if other.chars().all(|ch| ch.is_ascii_digit()) => BlockChomp::Clip,
        _ => return None,
    };
    Some((style, chomp))
}

/// Reads the indented continuation lines of a block scalar.
///
/// Returns the scalar text and how many lines were consumed. The block ends at
/// the closing `---`, at a non-empty line indented less than the block content,
/// or at the end of the frontmatter lines.
fn read_block_scalar(
    lines: &[&str],
    style: BlockScalarStyle,
    chomp: BlockChomp,
) -> (String, usize) {
    // Indentation of the first non-empty content line (YAML requires it to be
    // greater than the key's indentation; in practice it is 2 spaces).
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .find_map(|line| {
            let leading = line.len() - line.trim_start().len();
            (leading > 0 && line.trim() != "---").then_some(leading)
        })
        .unwrap_or(0);

    let mut content: Vec<String> = Vec::new();
    let mut consumed = 0usize;
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if line.trim().is_empty() {
            content.push(String::new());
            consumed += 1;
            continue;
        }
        let leading = line.len() - line.trim_start().len();
        if leading < indent || indent == 0 {
            break;
        }
        content.push(line[leading..].to_string());
        consumed += 1;
    }

    let mut text = match style {
        BlockScalarStyle::Literal => content.join("\n"),
        BlockScalarStyle::Folded => {
            let mut folded = String::new();
            let mut pending_breaks = 0usize;
            for line in &content {
                if line.trim().is_empty() {
                    pending_breaks += 1;
                    continue;
                }
                if !folded.is_empty() {
                    if pending_breaks == 0 {
                        folded.push(' ');
                    } else {
                        for _ in 0..pending_breaks {
                            folded.push('\n');
                        }
                    }
                }
                folded.push_str(line);
                pending_breaks = 0;
            }
            folded
        }
    };
    match chomp {
        BlockChomp::Strip => {
            while text.ends_with('\n') {
                text.pop();
            }
        }
        BlockChomp::Clip => {
            let trimmed = text.trim_end_matches('\n');
            text.truncate(trimmed.len());
            if !text.is_empty() {
                text.push('\n');
            }
        }
        BlockChomp::Keep => {}
    }
    (text, consumed)
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let first = value.chars().next();
        if first == Some('"') || first == Some('\'') {
            if value.ends_with(first.unwrap_or('"')) {
                return value[1..value.len() - 1].to_string();
            }
        }
    }
    value.to_string()
}

/// `[a-z0-9][a-z0-9-]{0,63}`.
pub fn is_valid_skill_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    if name.len() > MAX_NAME_CHARS {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn collect_files(dir: &Path, out: &mut Vec<String>, depth: usize) -> anyhow::Result<()> {
    if depth > MAX_FILE_DEPTH || out.len() >= MAX_SKILL_FILES {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).with_context(|| {
        let dir = dir.display().to_string();
        t_args("tools.skills.listDirFailed", &[("path", &dir)])
    })?;
    for entry in entries {
        if out.len() >= MAX_SKILL_FILES {
            break;
        }
        let entry = entry.with_context(|| {
            let dir = dir.display().to_string();
            t_args("tools.skills.readDirEntryFailed", &[("path", &dir)])
        })?;
        let path = entry.path();
        let file_type = entry.file_type().with_context(|| {
            let path = path.display().to_string();
            t_args("tools.skills.inspectEntryFailed", &[("path", &path)])
        })?;
        if file_type.is_dir() {
            collect_files(&path, out, depth + 1)?;
        } else if file_type.is_file() {
            if path.file_name().and_then(|name| name.to_str()) == Some(SKILL_FILE) {
                continue;
            }
            out.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/// Writes a user skill atomically. Existing content is preserved under
/// `<data>/skill-history/<name>/` before an overwrite.
pub fn save_user_skill(data_dir: &Path, draft: &SkillDraft, now: i64) -> anyhow::Result<Skill> {
    let name = draft.name.trim().to_string();
    let description = draft.description.trim().to_string();
    let content = draft.content.trim_end().to_string();
    if !is_valid_skill_name(&name) {
        let max = MAX_NAME_CHARS.to_string();
        bail!(
            "SKILL_INVALID: {}",
            t_args("tools.skills.saveInvalidName", &[("max", &max)])
        );
    }
    if description.is_empty() || description.chars().count() > MAX_DESCRIPTION_CHARS {
        let max = MAX_DESCRIPTION_CHARS.to_string();
        bail!(
            "SKILL_INVALID: {}",
            t_args("tools.skills.saveInvalidDescriptionLength", &[("max", &max)])
        );
    }
    if description.contains('\n') || description.contains('\r') {
        bail!(
            "SKILL_INVALID: {}",
            t("tools.skills.saveDescriptionSingleLine")
        );
    }
    if content.is_empty() || content.len() > MAX_BODY_BYTES {
        bail!("SKILL_INVALID: {}", t("tools.skills.saveContentLength"));
    }
    let root = data_dir.join(USER_DIR);
    let history_root = data_dir.join("skill-history").join(&name);
    std::fs::create_dir_all(&root).context(t("tools.skills.createUserDirFailed"))?;
    std::fs::create_dir_all(&history_root).context(t("tools.skills.createHistoryDirFailed"))?;
    let root = root.canonicalize().context(t("tools.skills.resolveRootFailed"))?;
    let target = root.join(&name);
    let raw = format!("---\nname: {name}\ndescription: {description}\n---\n{content}\n");
    if target.exists() {
        if !draft.overwrite {
            bail!(
                "SKILL_EXISTS: {}",
                t_args("tools.skills.exists", &[("name", name.as_str())])
            );
        }
        let metadata = std::fs::symlink_metadata(&target)
            .context(t("tools.skills.inspectExistingFailed"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("SKILL_UNSAFE: {}", t("tools.skills.unsafeNotDirectory"));
        }
        let canonical_target = target
            .canonicalize()
            .context(t("tools.skills.resolveExistingFailed"))?;
        if canonical_target.parent() != Some(root.as_path()) {
            bail!("SKILL_UNSAFE: {}", t("tools.skills.unsafeEscapes"));
        }
        let current = canonical_target.join(SKILL_FILE);
        if current.is_file() {
            let history_file = history_root.join(format!(
                "{now}-{}.md",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::copy(&current, &history_file).context(t("tools.skills.archiveFailed"))?;
        }
        let tmp = canonical_target.join(format!(".SKILL.md.{}.tmp", uuid::Uuid::new_v4().simple()));
        {
            let mut file =
                std::fs::File::create(&tmp).context(t("tools.skills.createTempFileFailed"))?;
            std::io::Write::write_all(&mut file, raw.as_bytes())
                .context(t("tools.skills.writeTempFailed"))?;
            file.sync_all().context(t("tools.skills.syncTempFailed"))?;
        }
        if current.exists() {
            std::fs::remove_file(&current).context(t("tools.skills.removeOldFailed"))?;
        }
        std::fs::rename(&tmp, &current).context(t("tools.skills.installUpdateFailed"))?;
        return load_skill(&canonical_target, SkillSource::User);
    }
    let tmp = root.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&tmp).context(t("tools.skills.createTempDirFailed"))?;
    let tmp_file = tmp.join(SKILL_FILE);
    {
        let mut file =
            std::fs::File::create(&tmp_file).context(t("tools.skills.createTempSkillFileFailed"))?;
        std::io::Write::write_all(&mut file, raw.as_bytes())
            .context(t("tools.skills.writeTempSkillFileFailed"))?;
        file.sync_all()
            .context(t("tools.skills.syncTempSkillFileFailed"))?;
    }
    std::fs::rename(&tmp, &target).context(t("tools.skills.installNewFailed"))?;
    load_skill(&target, SkillSource::User)
}

/// Lists archived versions of one user skill, newest first.
pub fn list_skill_versions(data_dir: &Path, name: &str) -> anyhow::Result<Vec<SkillVersion>> {
    if !is_valid_skill_name(name) {
        bail!("SKILL_INVALID: {}", t("tools.skills.invalidNameShort"));
    }
    let dir = data_dir.join("skill-history").join(name);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context(t("tools.skills.readHistoryFailed")),
    };
    let mut versions = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let file = entry.file_name().to_string_lossy().to_string();
        if !file.ends_with(".md") {
            continue;
        }
        let saved_at = file
            .split('-')
            .next()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        versions.push(SkillVersion { file, saved_at });
    }
    versions.sort_by(|left, right| {
        right
            .saved_at
            .cmp(&left.saved_at)
            .then_with(|| right.file.cmp(&left.file))
    });
    Ok(versions)
}

/// Tool definition for agent-authored skills.
pub fn save_definition() -> ToolDefinition {
    ToolDefinition {
        name: "skill_save".to_string(),
        description: "Create or replace a reusable user skill. Writes only SKILL.md under \
                      <app-data>/skills/<name>/ and archives the previous version."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "maxLength": 64 },
                "description": { "type": "string", "maxLength": 1024 },
                "content": { "type": "string", "maxLength": 524288 },
                "overwrite": { "type": "boolean" }
            },
            "required": ["name", "description", "content"],
            "additionalProperties": false
        }),
    }
}

pub fn run_save(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    run_save_with(&rt.data_dir, args)
}

/// Shared implementation for Chat (ToolRuntime) and Code (ToolCtx).
pub fn run_save_with(data_dir: &Path, args: &Value) -> ToolOutcome {
    let Some(name) = json_str(args, "name") else {
        return ToolOutcome::error(t("tools.skills.argNameRequired"));
    };
    let Some(description) = json_str(args, "description") else {
        return ToolOutcome::error(t("tools.skills.argDescriptionRequired"));
    };
    let Some(content) = json_str(args, "content") else {
        return ToolOutcome::error(t("tools.skills.argContentRequired"));
    };
    let draft = SkillDraft {
        name,
        description,
        content,
        overwrite: args
            .get("overwrite")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    match save_user_skill(data_dir, &draft, crate::domain::now_ms()) {
        Ok(skill) => ToolOutcome {
            content: json!({
                "saved": true,
                "name": skill.name,
                "path": skill.dir.display().to_string(),
                "overwritten": draft.overwrite,
            })
            .to_string(),
            summary: Some(t_args("tools.skills.savedSummary", &[("name", &skill.name)])),
            ..Default::default()
        },
        Err(error) => ToolOutcome::error(format!("{error:#}")),
    }
}

pub fn list_definition() -> ToolDefinition {
    ToolDefinition {
        name: "list_skills".to_string(),
        description: "List the installed skills (local instruction packages that teach how to \
                      produce specific file formats). Returns a JSON array of \
                      {name, description, source}. Always available; does not count towards the \
                      data-tool budget."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    }
}

pub fn read_definition() -> ToolDefinition {
    ToolDefinition {
        name: "read_skill".to_string(),
        description: "Read a skill: returns its full instructions plus the absolute paths of its \
                      helper files (baseDir/files). Call this before generating PDF/DOCX/XLSX/PPTX \
                      or running helper scripts. Always available; does not count towards the \
                      data-tool budget."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Skill name as returned by `list_skills`, e.g. \"office-docx\"."
                }
            },
            "required": ["name"],
            "additionalProperties": false
        }),
    }
}

pub fn run_list(rt: &ToolRuntime) -> ToolOutcome {
    match catalog_with_roots(&rt.data_dir, &rt.skills_roots) {
        Ok(skills) => {
            let disabled = rt.settings.disabled_skills.as_slice();
            let allowed = rt.options.allowed_skills.as_deref();
            let active: Vec<&Skill> = skills
                .iter()
                .filter(|skill| is_enabled(&skill.name, disabled))
                .filter(|skill| {
                    allowed.map_or(true, |names| names.iter().any(|name| name == &skill.name))
                })
                .collect();
            let hidden = skills.len() - active.len();
            let items: Vec<Value> = active
                .iter()
                .map(|skill| {
                    json!({
                        "name": skill.name,
                        "description": skill.description,
                        "source": skill.source_label(),
                    })
                })
                .collect();
            let content = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
            ToolOutcome {
                content,
                summary: Some(list_summary(active.len(), hidden)),
                ..Default::default()
            }
        }
        Err(error) => {
            let error = format!("{error:#}");
            ToolOutcome::error(t_args("tools.skills.loadFailed", &[("error", &error)]))
        }
    }
}

/// Short tool-card summary that makes clear the agent does not see disabled
/// skills (`2 skills ativas · 1 desativada`).
fn list_summary(active: usize, hidden: usize) -> String {
    let active_text = active.to_string();
    let hidden_text = hidden.to_string();
    let key = match (active == 1, hidden) {
        (true, 0) => "tools.skills.listSummaryActiveOne",
        (false, 0) => "tools.skills.listSummaryActiveMany",
        (true, 1) => "tools.skills.listSummaryActiveOneHiddenOne",
        (false, 1) => "tools.skills.listSummaryActiveManyHiddenOne",
        (true, _) => "tools.skills.listSummaryActiveOneHiddenMany",
        (false, _) => "tools.skills.listSummaryActiveManyHiddenMany",
    };
    t_args(
        key,
        &[("active", &active_text), ("hidden", &hidden_text)],
    )
}

pub fn run_read(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    let name = match json_str(args, "name") {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => return ToolOutcome::error(t("tools.skills.argNameRequired")),
    };

    let skill = match read_with_roots(&rt.data_dir, &name, &rt.skills_roots) {
        Ok(Some(skill)) => skill,
        Ok(None) => {
            let available =
                catalog_enabled_with_roots(
                    &rt.data_dir,
                    &rt.settings.disabled_skills,
                    &rt.skills_roots,
                )
                .map(|skills| {
                    let allowed = rt.options.allowed_skills.as_deref();
                    skills
                        .iter()
                        .filter(|skill| {
                            allowed.map_or(true, |names| names.iter().any(|name| name == &skill.name))
                        })
                        .map(|skill| skill.name.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let available = if available.is_empty() {
                t("tools.skills.noneActive")
            } else {
                available
            };
            return ToolOutcome::error(t_args(
                "tools.skills.notFound",
                &[("name", &name), ("available", &available)],
            ));
        }
        Err(error) => {
            let error = format!("{error:#}");
            return ToolOutcome::error(t_args(
                "tools.skills.readFailed",
                &[("name", &name), ("error", &error)],
            ));
        }
    };

    // Disabled skills are invisible to the agent: reading one is an error with
    // the exact place to enable it (the catalog stays the same file on disk).
    if !is_enabled(&skill.name, &rt.settings.disabled_skills) {
        return ToolOutcome::error(t_args(
            "tools.skills.disabled",
            &[("name", &skill.name)],
        ));
    }
    if let Some(allowed) = rt.options.allowed_skills.as_deref() {
        if !allowed.iter().any(|name| name == &skill.name) {
            return ToolOutcome::error(t_args(
                "tools.skills.unauthorized",
                &[("name", &skill.name)],
            ));
        }
    }

    let files = match skill.files() {
        Ok(files) => files,
        Err(error) => {
            let error = format!("{error:#}");
            return ToolOutcome::error(t_args(
                "tools.skills.listFilesFailed",
                &[("name", &name), ("error", &error)],
            ));
        }
    };
    let payload = json!({
        "name": skill.name,
        "description": skill.description,
        "baseDir": skill.dir.to_string_lossy(),
        "files": files,
        "instructions": skill.body,
    });
    let content = serde_json::to_string_pretty(&payload)
        .unwrap_or_else(|_| String::from("{}"));
    let count = files.len().to_string();
    ToolOutcome {
        summary: Some(t_args(
            "tools.skills.readSummary",
            &[("name", &skill.name), ("count", &count)],
        )),
        content,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::db::Db;
    use crate::domain::Settings;

    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zylara-skills-test-{}",
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

    fn write_skill(root: &Path, name: &str, description: &str, body: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("criar diretório da skill");
        std::fs::write(
            dir.join(SKILL_FILE),
            format!("---\nname: {name}\ndescription: {description}\n---\n{body}\n"),
        )
        .expect("escrever SKILL.md");
        dir
    }

    fn runtime(temp: &TempDir) -> ToolRuntime {
        ToolRuntime {
            db: std::sync::Arc::new(Db::open_in_memory().expect("banco em memória")),
            http: reqwest::Client::new(),
            conversation_id: "conv-1".to_string(),
            message_id: "msg-1".to_string(),
            options: Default::default(),
            settings: Settings::default(),
            cancel: tokio_util::sync::CancellationToken::new(),
            agent_hooks: None,
            data_dir: temp.path.clone(),
            // Tests never read the developer's real skill repositories.
            skills_roots: Vec::new(),
            approval: None,
            emit: None,
        }
    }

    #[test]
    fn parses_a_valid_frontmatter() {
        let raw = "---\nname: office-docx\ndescription: Criar documentos Word (.docx) com script Python stdlib.\n---\n# Instruções\nUse o script.\n";
        let (name, description, body) = parse_frontmatter(raw).expect("frontmatter válido");
        assert_eq!(name, "office-docx");
        assert!(description.starts_with("Criar documentos Word"));
        assert!(body.starts_with("# Instruções"));
        assert!(!body.contains("name: office-docx"));
    }

    #[test]
    fn accepts_quoted_values_and_a_bom() {
        let raw = "\u{feff}---\nname: 'pdf'\ndescription: \"Gerar PDFs\"\n---\nCorpo\n";
        let (name, description, body) = parse_frontmatter(raw).expect("frontmatter válido");
        assert_eq!(name, "pdf");
        assert_eq!(description, "Gerar PDFs");
        assert_eq!(body, "Corpo");
    }

    #[test]
    fn parses_block_scalar_descriptions_from_real_repositories() {
        // Folded (`>`) — formato usado por ~/.agents/skills.
        let folded = "---\nname: motion-graphics\ndescription: >\n  A short, motion-led graphic\n  where motion is the message.\n  Longer / narrated → another skill.\n---\ncorpo";
        let (name, description, body) = parse_frontmatter(folded).expect("folded");
        assert_eq!(name, "motion-graphics");
        assert_eq!(
            description,
            "A short, motion-led graphic where motion is the message. Longer / narrated → another skill."
        );
        assert!(!description.contains('\n'), "description deve virar uma linha");
        assert_eq!(body, "corpo");

        // Folded strip (`>-`) e literal (`|` / `|-`) também são aceitos.
        let folded_strip = "---\nname: x\ndescription: >-\n  Linha um.\n  Linha dois.\n---\n";
        let (_, description, _) = parse_frontmatter(folded_strip).expect("folded strip");
        assert_eq!(description, "Linha um. Linha dois.");

        let literal = "---\nname: x\ndescription: |\n  Linha um.\n  Linha dois.\n---\n";
        let (_, description, _) = parse_frontmatter(literal).expect("literal");
        assert_eq!(description, "Linha um. Linha dois.");

        let literal_strip = "---\nname: x\ndescription: |-\n  Um.\n  Dois.\n---\ncorpo";
        let (_, description, body) = parse_frontmatter(literal_strip).expect("literal strip");
        assert_eq!(description, "Um. Dois.");
        assert_eq!(body, "corpo");

        // O bloco termina na próxima chave de topo (ex.: `license:`).
        let with_more_keys = "---\nname: x\ndescription: >\n  Descrição\n  em duas linhas.\nlicense: MIT\n---\ncorpo";
        let (_, description, body) = parse_frontmatter(with_more_keys).expect("chave após bloco");
        assert_eq!(description, "Descrição em duas linhas.");
        assert_eq!(body, "corpo");

        // `metadata:` indentado depois da description (caso do `impeccable`).
        let with_metadata = "---\nname: impeccable\ndescription: >\n  Use when the user wants\n  to improve a frontend interface.\nmetadata:\n  version: 4.5.2\n---\n# corpo";
        let (name, description, body) = parse_frontmatter(with_metadata).expect("metadata");
        assert_eq!(name, "impeccable");
        assert_eq!(
            description,
            "Use when the user wants to improve a frontend interface."
        );
        assert_eq!(body, "# corpo");
    }

    #[test]
    fn accepts_long_descriptions_and_bodies_from_real_repositories() {
        let temp = TempDir::new();
        let dir = temp.path.join(USER_DIR).join("revisao-grande");
        std::fs::create_dir_all(&dir).expect("criar skill");
        // > 200 chars (limite antigo) e <= 1024 (limite novo).
        let description = format!("Descrição longa: {}", "detalhe ".repeat(110))
            .trim()
            .to_string();
        assert!(description.chars().count() > 200);
        assert!(description.chars().count() <= MAX_DESCRIPTION_CHARS);
        // Corpo ~120 KB (acima do antigo limite de 64 KB).
        let body = format!("# Instruções\n{}\n", "corpo de teste ".repeat(8_500));
        assert!(body.len() > 100 * 1024);
        assert!(body.len() <= MAX_BODY_BYTES);
        std::fs::write(
            dir.join(SKILL_FILE),
            format!(
                "---\nname: revisao-grande\ndescription: {description}\nmetadata:\n  version: 1.0.0\n---\n{body}\n"
            ),
        )
        .expect("escrever SKILL.md");

        let skill = load_skill(&dir, SkillSource::User).expect("skill longa precisa carregar");
        assert_eq!(skill.name, "revisao-grande");
        assert_eq!(skill.description, description);
        assert!(skill.body.len() > 100 * 1024);

        let catalog = catalog_with_roots(&temp.path, &[]).expect("catálogo");
        let listed = catalog
            .iter()
            .find(|skill| skill.name == "revisao-grande")
            .expect("skill longa no catálogo");
        assert_eq!(listed.source, SkillSource::User);
    }

    #[test]
    fn rejects_descriptions_and_bodies_above_the_new_limits() {
        let temp = TempDir::new();
        let long_description = temp.path.join(USER_DIR).join("descricao-longa");
        std::fs::create_dir_all(&long_description).expect("criar skill");
        std::fs::write(
            long_description.join(SKILL_FILE),
            format!(
                "---\nname: descricao-longa\ndescription: {}\n---\ncorpo\n",
                "d".repeat(MAX_DESCRIPTION_CHARS + 1)
            ),
        )
        .expect("escrever SKILL.md");
        assert!(load_skill(&long_description, SkillSource::User).is_err());

        let long_body = temp.path.join(USER_DIR).join("corpo-grande");
        std::fs::create_dir_all(&long_body).expect("criar skill");
        std::fs::write(
            long_body.join(SKILL_FILE),
            format!(
                "---\nname: corpo-grande\ndescription: Corpo grande.\n---\n{}",
                "b".repeat(MAX_BODY_BYTES + 1)
            ),
        )
        .expect("escrever SKILL.md");
        assert!(load_skill(&long_body, SkillSource::User).is_err());
    }

    #[test]
    fn rejects_invalid_frontmatter() {
        // Sem `---` inicial.
        assert!(parse_frontmatter("# Título\n").is_err());
        // Sem fechamento.
        assert!(parse_frontmatter("---\nname: pdf\ndescription: x\n").is_err());
        // Sem name/description.
        assert!(parse_frontmatter("---\ndescription: x\n---\ncorpo").is_err());
        assert!(parse_frontmatter("---\nname: pdf\n---\ncorpo").is_err());
    }

    #[test]
    fn validates_skill_names() {
        assert!(is_valid_skill_name("pdf"));
        assert!(is_valid_skill_name("office-docx"));
        assert!(is_valid_skill_name("imagens2"));
        assert!(!is_valid_skill_name(""));
        assert!(!is_valid_skill_name("Office-docx"));
        assert!(!is_valid_skill_name("office_docx"));
        assert!(!is_valid_skill_name("-pdf"));
        assert!(!is_valid_skill_name(&"a".repeat(MAX_NAME_CHARS + 1)));
    }

    #[test]
    fn loads_a_user_skill_and_reports_its_files() {
        let temp = TempDir::new();
        let skills_root = temp.path.join(USER_DIR);
        let dir = write_skill(
            &skills_root,
            "office-docx",
            "Criar documentos Word (.docx) com script Python stdlib.",
            "# Instruções\nRode `scripts/make_docx.py`.",
        );
        std::fs::create_dir_all(dir.join("scripts")).expect("criar scripts");
        let script = dir.join("scripts").join("make_docx.py");
        std::fs::write(&script, "print('ok')\n").expect("escrever script");

        let skills = catalog_with_roots(&temp.path, &[]).expect("catálogo");
        let skill = skills
            .iter()
            .find(|skill| skill.name == "office-docx")
            .expect("skill do usuário no catálogo");
        assert_eq!(skill.source, SkillSource::User);
        assert_eq!(skill.source_str(), "user");

        let files = skill.files().expect("arquivos da skill");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0], script.to_string_lossy());
        assert!(!files.iter().any(|path| path.ends_with(SKILL_FILE)));
    }

    #[test]
    fn user_skills_win_over_bundled_on_name_collisions() {
        let bundled = vec![Skill {
            name: "pdf".to_string(),
            description: "bundled".to_string(),
            body: String::new(),
            dir: PathBuf::from("bundled/pdf"),
            source: SkillSource::Bundled,
            plugin_id: None,
        }];
        let user = vec![Skill {
            name: "pdf".to_string(),
            description: "user".to_string(),
            body: String::new(),
            dir: PathBuf::from("user/pdf"),
            source: SkillSource::User,
            plugin_id: None,
        }];
        let merged = merge_by_precedence(vec![user, bundled]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].description, "user");
        assert_eq!(merged[0].source, SkillSource::User);
    }

    #[test]
    fn catalog_is_sorted_and_skips_invalid_skills() {
        let temp = TempDir::new();
        let skills_root = temp.path.join(USER_DIR);
        write_skill(&skills_root, "zeta", "Última", "corpo");
        write_skill(&skills_root, "alfa", "Primeira", "corpo");
        // Nome inválido (maiúsculas) → ignorada, sem quebrar o catálogo.
        write_skill(&skills_root, "Invalida", "x", "corpo");

        let skills = catalog_with_roots(&temp.path, &[]).expect("catálogo");
        // As skills embutidas também entram no catálogo; aqui interessa a
        // ordem alfabética e o filtro das do usuário.
        let user_names: Vec<&str> = skills
            .iter()
            .filter(|skill| skill.source == SkillSource::User)
            .map(|skill| skill.name.as_str())
            .collect();
        assert_eq!(user_names, vec!["alfa", "zeta"]);
        let all_names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        let mut sorted = all_names.clone();
        sorted.sort_unstable();
        assert_eq!(all_names, sorted);
        assert!(!all_names.contains(&"Invalida"));
    }

    #[test]
    fn materializes_the_real_embedded_skills() {
        let temp = TempDir::new();
        let bundled_dir = materialize_bundled(&temp.path).expect("materializar skills");
        assert!(bundled_dir.is_dir());

        // Every embedded file (README included) must be on disk.
        for file in BUNDLED_SKILLS.files() {
            let path = bundled_dir.join(file.path());
            assert!(path.is_file(), "arquivo embutido ausente: {}", path.display());
            assert_eq!(
                std::fs::read(&path).expect("ler arquivo materializado"),
                file.contents()
            );
        }

        // Every embedded skill directory with a SKILL.md must load with source
        // `bundled` (formats-dev delivers them; this guards the real catalog).
        let expected: Vec<String> = BUNDLED_SKILLS
            .dirs()
            .filter(|dir| dir.files().any(|file| file.path().ends_with(SKILL_FILE)))
            .filter_map(|dir| {
                dir.path()
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
            })
            .collect();
        let skills = catalog_with_roots(&temp.path, &[]).expect("catálogo");
        for name in expected {
            let skill = skills
                .iter()
                .find(|skill| skill.name == name)
                .unwrap_or_else(|| panic!("skill embutida `{name}` não carregou"));
            assert_eq!(skill.source, SkillSource::Bundled);
        }
    }

    #[test]
    fn list_and_read_skill_tools_work() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let dir = write_skill(
            &temp.path.join(USER_DIR),
            "pdf",
            "Gerar PDFs com script stdlib.",
            "# Instruções\nUse `scripts/make_pdf.py`.",
        );
        std::fs::create_dir_all(dir.join("scripts")).expect("criar scripts");
        let script = dir.join("scripts").join("make_pdf.py");
        std::fs::write(&script, "print('ok')\n").expect("escrever script");

        let listed = run_list(&rt);
        assert!(!listed.is_error);
        let items: Vec<Value> =
            serde_json::from_str(&listed.content).expect("list_skills devolve JSON");
        let pdf = items
            .iter()
            .find(|item| item["name"] == "pdf")
            .expect("skill `pdf` listada");
        assert_eq!(pdf["description"], "Gerar PDFs com script stdlib.");
        // A skill do usuário vence a embutida de mesmo nome.
        assert_eq!(pdf["source"], "user");
        assert!(listed.summary.as_deref().unwrap_or_default().contains("skill"));

        let read_outcome = run_read(&rt, &json!({"name": "pdf"}));
        assert!(!read_outcome.is_error, "erro inesperado: {}", read_outcome.content);
        let payload: Value =
            serde_json::from_str(&read_outcome.content).expect("read_skill devolve JSON");
        assert_eq!(payload["name"], "pdf");
        assert_eq!(payload["description"], "Gerar PDFs com script stdlib.");
        assert!(payload["instructions"]
            .as_str()
            .unwrap_or_default()
            .contains("make_pdf.py"));
        let base_dir = payload["baseDir"].as_str().expect("baseDir string");
        assert_eq!(base_dir, dir.to_string_lossy());
        let files = payload["files"].as_array().expect("files array");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].as_str().unwrap_or_default(), script.to_string_lossy());
    }

    #[test]
    fn read_skill_reports_an_unknown_skill() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let outcome = run_read(&rt, &json!({"name": "inexistente"}));
        assert!(outcome.is_error);
        assert!(outcome.content.contains("não encontrada"));
        // Lista as skills disponíveis (as embutidas estão sempre no build).
        assert!(outcome.content.contains("disponíveis"));

        let outcome = run_read(&rt, &json!({}));
        assert!(outcome.is_error);
        assert!(outcome.content.contains("`name`"));
    }

    /* -------------------------------------------------------------- */
    /* Skills management (docs/FILES.md §7.4)                          */
    /* -------------------------------------------------------------- */

    fn disabled(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn is_enabled_checks_the_disabled_list() {
        assert!(is_enabled("pdf", &[]));
        assert!(is_enabled("pdf", &disabled(&["office-docx"])));
        assert!(!is_enabled("pdf", &disabled(&["pdf"])));
        assert!(!is_enabled("pdf", &disabled(&["office-docx", "pdf"])));
    }

    #[test]
    fn catalog_enabled_filters_disabled_skills_and_preserves_order() {
        let temp = TempDir::new();
        let skills_root = temp.path.join(USER_DIR);
        write_skill(&skills_root, "alfa", "Primeira", "corpo");
        write_skill(&skills_root, "beta", "Segunda", "corpo");

        let all = catalog_with_roots(&temp.path, &[]).expect("catálogo");
        // A embutida `office-docx` também é desativada por nome.
        let filtered =
            catalog_enabled_with_roots(&temp.path, &disabled(&["beta", "office-docx"]), &[])
            .expect("catálogo");
        assert!(filtered.iter().any(|skill| skill.name == "alfa"));
        assert!(!filtered.iter().any(|skill| skill.name == "beta"));
        assert!(!filtered.iter().any(|skill| skill.name == "office-docx"));
        // Ordem preservada em relação ao catálogo completo.
        let expected: Vec<&str> = all
            .iter()
            .filter(|skill| !matches!(skill.name.as_str(), "beta" | "office-docx"))
            .map(|skill| skill.name.as_str())
            .collect();
        let actual: Vec<&str> = filtered.iter().map(|skill| skill.name.as_str()).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn summary_flags_enabled_and_deletable() {
        let temp = TempDir::new();
        write_skill(&temp.path.join(USER_DIR), "minha-skill", "Skill do usuário.", "corpo");
        let skills = catalog_with_roots(&temp.path, &[]).expect("catálogo");

        let user = skills
            .iter()
            .find(|skill| skill.name == "minha-skill")
            .expect("skill do usuário");
        let enabled = user.summary(&[]);
        assert!(enabled.enabled);
        assert!(enabled.deletable, "skill do usuário pode ser excluída");
        assert_eq!(enabled.source, "user");

        let disabled_summary = user.summary(&disabled(&["minha-skill"]));
        assert!(!disabled_summary.enabled);
        assert!(disabled_summary.deletable);

        let bundled = skills
            .iter()
            .find(|skill| skill.source == SkillSource::Bundled)
            .expect("skill embutida");
        let bundled_summary = bundled.summary(&[]);
        assert!(bundled_summary.enabled);
        assert!(!bundled_summary.deletable, "skill embutida não pode ser excluída");
        assert_eq!(bundled_summary.source, "bundled");
    }

    #[test]
    fn summaries_includes_disabled_skills_with_flags() {
        let temp = TempDir::new();
        write_skill(&temp.path.join(USER_DIR), "minha-skill", "Skill do usuário.", "corpo");

        let all = summaries_with_roots(&temp.path, &[], &[]);
        let user = all
            .iter()
            .find(|summary| summary.name == "minha-skill")
            .expect("skill listada");
        assert!(user.enabled);
        assert!(user.deletable);
        assert!(all.iter().any(|summary| summary.source == "bundled" && summary.enabled));

        let with_disabled = summaries_with_roots(&temp.path, &disabled(&["minha-skill"]), &[]);
        let user = with_disabled
            .iter()
            .find(|summary| summary.name == "minha-skill")
            .expect("skill desativada continua listada para a UI");
        assert!(!user.enabled);
        // As embutidas continuam no catálogo (a UI lista todas).
        assert!(with_disabled
            .iter()
            .any(|summary| summary.source == "bundled"));
    }

    #[test]
    fn list_skill_tool_hides_disabled_skills() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let skill_dir = write_skill(
            &temp.path.join(USER_DIR),
            "minha-skill",
            "Skill do usuário.",
            "corpo",
        );
        assert!(skill_dir.is_dir());

        let all = run_list(&rt);
        let items: Vec<Value> = serde_json::from_str(&all.content).expect("JSON");
        assert!(items.iter().any(|item| item["name"] == "minha-skill"));

        rt.settings.disabled_skills = disabled(&["minha-skill", "office-docx"]);
        let filtered = run_list(&rt);
        assert!(!filtered.is_error);
        let items: Vec<Value> = serde_json::from_str(&filtered.content).expect("JSON");
        assert!(!items.iter().any(|item| item["name"] == "minha-skill"));
        assert!(!items.iter().any(|item| item["name"] == "office-docx"));
        assert!(items.iter().any(|item| item["name"] == "pdf"));
        let summary = filtered.summary.as_deref().unwrap_or_default();
        assert!(summary.contains("desativadas"), "summary inesperado: {summary}");
    }

    #[test]
    fn read_skill_tool_rejects_a_disabled_skill() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        rt.settings.disabled_skills = disabled(&["office-docx"]);

        let outcome = run_read(&rt, &json!({"name": "office-docx"}));
        assert!(outcome.is_error);
        assert!(outcome.content.contains("desativada"));
        assert!(outcome.content.contains("Configurações"));
        assert!(outcome.content.contains("list_skills"));

        // O nome desativado não aparece na lista de disponíveis.
        let unknown = run_read(&rt, &json!({"name": "inexistente"}));
        assert!(unknown.is_error);
        assert!(unknown.content.contains("pdf"));
        assert!(
            !unknown.content.contains("office-docx"),
            "skill desativada não deve ser anunciada: {}",
            unknown.content
        );
    }

    /* -------------------------------------------------------------- */
    /* Standard external repositories (Codex/Claude/OpenCode/agents)   */
    /* -------------------------------------------------------------- */

    #[test]
    fn external_roots_from_resolves_defaults_and_overrides() {
        let temp = TempDir::new();
        let home = temp.path.join("home");
        for relative in [
            ".agents/skills",
            ".codex/skills",
            ".claude/skills",
            ".config/opencode/skills",
        ] {
            std::fs::create_dir_all(home.join(relative)).expect("criar repositório padrão");
        }

        // Defaults (sem envs): agents > codex > claude > opencode.
        let defaults = external_roots_from(&home, None, None, None, None);
        let sources: Vec<SkillSource> = defaults.iter().map(|root| root.source).collect();
        assert_eq!(
            sources,
            vec![
                SkillSource::Agents,
                SkillSource::Codex,
                SkillSource::Claude,
                SkillSource::OpenCode
            ]
        );
        assert_eq!(defaults[0].dir, home.join(".agents").join("skills"));
        assert_eq!(defaults[1].dir, home.join(".codex").join("skills"));
        assert_eq!(defaults[2].dir, home.join(".claude").join("skills"));
        assert_eq!(
            defaults[3].dir,
            home.join(".config").join("opencode").join("skills")
        );

        // Overrides replace the home fallbacks (Codex/Claude/XDG/APPDATA).
        let custom_codex = temp.path.join("custom-codex");
        let custom_claude = temp.path.join("custom-claude");
        let xdg = temp.path.join("xdg");
        let appdata = temp.path.join("appdata");
        for dir in [
            custom_codex.join("skills"),
            custom_claude.join("skills"),
            xdg.join("opencode").join("skills"),
            appdata.join("opencode").join("skills"),
        ] {
            std::fs::create_dir_all(&dir).expect("criar repositório customizado");
        }
        let overridden = external_roots_from(
            &home,
            Some(&custom_codex),
            Some(&custom_claude),
            Some(&xdg),
            Some(&appdata),
        );
        assert_eq!(overridden[0].dir, home.join(".agents").join("skills"));
        assert_eq!(overridden[1].dir, custom_codex.join("skills"));
        assert_eq!(overridden[2].dir, custom_claude.join("skills"));
        assert_eq!(overridden[3].dir, xdg.join("opencode").join("skills"));
        assert_eq!(overridden[4].dir, appdata.join("opencode").join("skills"));
        assert_eq!(overridden[4].source, SkillSource::OpenCode);

        // Caminhos duplicados são emitidos uma única vez (APPDATA == ~/.config).
        let deduped = external_roots_from(&home, None, None, None, Some(&home.join(".config")));
        let opencode_count = deduped
            .iter()
            .filter(|root| root.source == SkillSource::OpenCode)
            .count();
        assert_eq!(opencode_count, 1, "duplicata não deve aparecer duas vezes");

        // Diretórios inexistentes são ignorados (e home vazio não entra em pânico).
        let empty_home = temp.path.join("home-vazio");
        std::fs::create_dir_all(&empty_home).expect("criar home vazio");
        assert!(external_roots_from(&empty_home, None, None, None, None).is_empty());
        assert!(external_roots_from(Path::new(""), None, None, None, None).is_empty());
    }

    #[test]
    fn catalog_with_roots_applies_precedence_and_ignores_hidden_dirs() {
        let temp = TempDir::new();
        let data_dir = temp.path.join("data");
        std::fs::create_dir_all(&data_dir).expect("criar app-data");
        let agents_root = temp.path.join("agents");
        let codex_root = temp.path.join("codex");
        let roots = vec![
            ExternalSkillRoot {
                source: SkillSource::Agents,
                dir: agents_root.clone(),
                plugin_id: None,
            },
            ExternalSkillRoot {
                source: SkillSource::Codex,
                dir: codex_root.clone(),
                plugin_id: None,
            },
        ];

        // Zylara (user) vence o repositório externo de mesmo nome.
        write_skill(&data_dir.join(USER_DIR), "compartilhada", "user", "corpo");
        write_skill(&agents_root, "compartilhada", "agents", "corpo");
        // A primeira origem externa (agents) vence a seguinte (codex).
        write_skill(&agents_root, "entre-fontes", "agents", "corpo");
        write_skill(&codex_root, "entre-fontes", "codex", "corpo");
        // Só existe no Codex.
        write_skill(&codex_root, "so-codex", "codex", "corpo");
        // Diretório oculto (`.system`) do Codex é ignorado.
        write_skill(&codex_root, ".system", "Sistema", "corpo");
        // SKILL.md inválido não quebra o catálogo.
        let invalid = codex_root.join("invalida");
        std::fs::create_dir_all(&invalid).expect("criar skill inválida");
        std::fs::write(invalid.join(SKILL_FILE), "# sem frontmatter\n").expect("SKILL.md inválido");

        let catalog = catalog_with_roots(&data_dir, &roots).expect("catálogo");
        let by_name = |name: &str| -> Option<&Skill> {
            catalog.iter().find(|skill| skill.name == name)
        };
        assert_eq!(
            by_name("compartilhada").map(|skill| skill.source),
            Some(SkillSource::User)
        );
        assert_eq!(
            by_name("entre-fontes").map(|skill| skill.source),
            Some(SkillSource::Agents)
        );
        assert_eq!(
            by_name("so-codex").map(|skill| skill.source),
            Some(SkillSource::Codex)
        );
        assert!(by_name(".system").is_none(), "diretório oculto não entra no catálogo");
        assert!(by_name("invalida").is_none(), "SKILL.md inválido é ignorado");
        // As embutidas continuam disponíveis.
        assert!(catalog.iter().any(|skill| skill.source == SkillSource::Bundled));

        // Ordem alfabética determinística.
        let names: Vec<&str> = catalog.iter().map(|skill| skill.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
    }

    #[test]
    fn summaries_with_roots_flags_external_sources() {
        let temp = TempDir::new();
        let data_dir = temp.path.join("data");
        std::fs::create_dir_all(&data_dir).expect("criar app-data");
        let codex_root = temp.path.join("codex");
        write_skill(&codex_root, "externa", "Skill do Codex.", "corpo");
        write_skill(&data_dir.join(USER_DIR), "minha-skill", "Minha skill.", "corpo");
        let roots = vec![ExternalSkillRoot {
            source: SkillSource::Codex,
            dir: codex_root,
            plugin_id: None,
        }];

        let all = summaries_with_roots(&data_dir, &[], &roots);
        let external = all
            .iter()
            .find(|summary| summary.name == "externa")
            .expect("skill externa listada");
        assert_eq!(external.source, "codex");
        assert!(external.enabled);
        assert!(!external.deletable, "skill externa é somente leitura");
        let user = all
            .iter()
            .find(|summary| summary.name == "minha-skill")
            .expect("skill do usuário");
        assert!(user.deletable);
        assert!(all.iter().any(|summary| summary.source == "bundled" && !summary.deletable));

        let with_disabled = summaries_with_roots(&data_dir, &disabled(&["externa"]), &roots);
        let external = with_disabled
            .iter()
            .find(|summary| summary.name == "externa")
            .expect("desativada continua listada");
        assert!(!external.enabled);
        assert!(!external.deletable);
    }

    #[test]
    fn read_with_roots_finds_external_skills() {
        let temp = TempDir::new();
        let data_dir = temp.path.join("data");
        std::fs::create_dir_all(&data_dir).expect("criar app-data");
        let codex_root = temp.path.join("codex");
        write_skill(&codex_root, "so-codex", "Skill do Codex.", "# Instruções\nUse assim.");
        let roots = vec![ExternalSkillRoot {
            source: SkillSource::Codex,
            dir: codex_root.clone(),
            plugin_id: None,
        }];

        let skill = read_with_roots(&data_dir, "so-codex", &roots)
            .expect("ler catálogo")
            .expect("skill externa encontrada");
        assert_eq!(skill.name, "so-codex");
        assert_eq!(skill.source, SkillSource::Codex);
        assert_eq!(skill.dir, codex_root.join("so-codex"));
        assert!(skill.body.contains("Instruções"));
        // Arquivos da skill são listados como caminhos absolutos (sem SKILL.md).
        let files = skill.files().expect("arquivos");
        assert!(files.iter().all(|path| !path.ends_with(SKILL_FILE)));

        assert!(read_with_roots(&data_dir, "nao-existe", &roots)
            .expect("ler catálogo")
            .is_none());
    }

    #[test]
    fn list_and_read_tools_include_external_repositories() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let codex_root = temp.path.join("codex");
        write_skill(&codex_root, "revisao-codigo", "Revisar PRs.", "corpo");
        rt.skills_roots = vec![ExternalSkillRoot {
            source: SkillSource::Codex,
            dir: codex_root.clone(),
            plugin_id: None,
        }];

        let listed = run_list(&rt);
        assert!(!listed.is_error);
        let items: Vec<Value> = serde_json::from_str(&listed.content).expect("JSON");
        let external = items
            .iter()
            .find(|item| item["name"] == "revisao-codigo")
            .expect("skill externa no list_skills");
        assert_eq!(external["source"], "codex");

        let outcome = run_read(&rt, &json!({"name": "revisao-codigo"}));
        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        let payload: Value = serde_json::from_str(&outcome.content).expect("JSON");
        assert_eq!(payload["name"], "revisao-codigo");
        assert_eq!(
            payload["baseDir"].as_str().unwrap_or_default(),
            codex_root.join("revisao-codigo").to_string_lossy()
        );

        // Desativar uma skill externa também a esconde das tools.
        rt.settings.disabled_skills = disabled(&["revisao-codigo"]);
        let listed = run_list(&rt);
        let items: Vec<Value> = serde_json::from_str(&listed.content).expect("JSON");
        assert!(!items.iter().any(|item| item["name"] == "revisao-codigo"));
        assert!(run_read(&rt, &json!({"name": "revisao-codigo"})).is_error);
    }

    /// Conditional test against the real machine: only asserts when at least one
    /// standard repository exists (`~/.agents/skills`, Codex, Claude, OpenCode).
    #[test]
    fn standard_external_roots_reads_the_real_machine_when_present() {
        let roots = standard_external_roots();
        if roots.is_empty() {
            eprintln!("nenhum repositório padrão de skills nesta máquina: teste pulado");
            return;
        }
        for root in &roots {
            assert!(root.dir.is_dir(), "root inexistente: {}", root.dir.display());
            assert!(root.source.is_external());
        }
        // Ordem de precedência: agents > codex > claude > opencode.
        let rank = |source: SkillSource| match source {
            SkillSource::Agents => 0,
            SkillSource::Codex => 1,
            SkillSource::Claude => 2,
            SkillSource::OpenCode => 3,
            _ => 4,
        };
        for pair in roots.windows(2) {
            assert!(
                rank(pair[0].source) <= rank(pair[1].source),
                "ordem de precedência inesperada: {:?}",
                roots.iter().map(|root| root.source).collect::<Vec<_>>()
            );
        }

        // Repositórios reais existem: o parser precisa aceitar TODAS as skills
        // dos diretórios com SKILL.md (block scalars, descrições longas, corpos
        // grandes) e o catálogo precisa expor os mesmos nomes dos diretórios.
        let mut total = 0usize;
        let mut expected: Vec<(String, SkillSource)> = Vec::new();
        let mut rejected: Vec<String> = Vec::new();
        for root in &roots {
            let Ok(entries) = std::fs::read_dir(&root.dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.')
                    || !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                {
                    continue;
                }
                let dir = entry.path();
                if !dir.join(SKILL_FILE).is_file() {
                    continue;
                }
                total += 1;
                match load_skill(&dir, root.source) {
                    Ok(skill) => {
                        assert_eq!(
                            skill.dir.file_name().and_then(|name| name.to_str()),
                            Some(skill.name.as_str()),
                            "nome do frontmatter difere do diretório: {}",
                            dir.display()
                        );
                        if !expected.iter().any(|(name, _)| name == &skill.name) {
                            expected.push((skill.name, root.source));
                        }
                    }
                    Err(error) => rejected.push(format!("{}: {error:#}", dir.display())),
                }
            }
        }
        if total == 0 {
            eprintln!("repositórios existem mas não têm SKILL.md: teste pulado");
            return;
        }
        // Não passa silenciosamente quando o parser rejeita skills reais.
        assert!(
            rejected.is_empty(),
            "o parser rejeitou skill(s) real(is) dos repositórios padrão:\n{}",
            rejected.join("\n")
        );
        let temp = TempDir::new();
        let catalog = catalog_with_roots(&temp.path, &roots).expect("catálogo real");
        assert!(!expected.is_empty(), "nenhuma skill real carregou");
        for (name, source) in &expected {
            let found = catalog.iter().find(|skill| &skill.name == name).unwrap_or_else(|| {
                panic!("skill real `{name}` ausente no catálogo dos repositórios padrão")
            });
            assert_eq!(
                &found.source, source,
                "origem inesperada para a skill real `{name}`"
            );
        }
        assert!(
            catalog
                .iter()
                .filter(|skill| skill.source.is_external())
                .count()
                >= expected.len(),
            "o catálogo precisa expor todas as skills externas descobertas"
        );
    }

    #[test]
    fn save_user_skill_validates_archives_and_roundtrips() {
        let temp = tempfile::tempdir().expect("temp");
        let draft = SkillDraft {
            name: "revisao-pr".to_string(),
            description: "Revisar pull requests.".to_string(),
            content: "# Revisão\n\nLeia o diff e liste riscos.".to_string(),
            overwrite: false,
        };
        let saved = save_user_skill(temp.path(), &draft, 1_700_000_000_000).expect("save");
        assert_eq!(saved.name, "revisao-pr");
        assert!(saved.body.contains("Leia o diff"));
        let read = read(temp.path(), "revisao-pr").expect("read").expect("exists");
        assert_eq!(read.description, "Revisar pull requests.");
        assert!(save_user_skill(temp.path(), &draft, 1_700_000_000_001).is_err());
        let updated = save_user_skill(
            temp.path(),
            &SkillDraft {
                content: "# Revisão v2\n\nListe testes.".to_string(),
                overwrite: true,
                ..draft
            },
            1_700_000_000_002,
        )
        .expect("overwrite");
        assert!(updated.body.contains("v2"));
        assert_eq!(
            list_skill_versions(temp.path(), "revisao-pr")
                .expect("versions")
                .len(),
            1
        );
        assert!(save_user_skill(
            temp.path(),
            &SkillDraft {
                name: "Nome Inválido".to_string(),
                ..updated_draft()
            },
            1
        )
        .is_err());
    }

    fn updated_draft() -> SkillDraft {
        SkillDraft {
            name: "revisao-pr".to_string(),
            description: "Descrição.".to_string(),
            content: "corpo".to_string(),
            overwrite: false,
        }
    }
}

