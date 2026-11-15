//! Artifact library tools: `list_artifacts` (browse/search) and `read_artifact`
//! (bring a file's content into the model context).
//!
//! The library is the **user's** library: every artifact of every conversation
//! **plus the files the user uploaded directly to the library** (artifacts
//! without a conversation, `conversation_id = None`).
//! `db::list_all_artifacts` is the single source of truth for the listing and
//! `db::get_artifact` supplies the authoritative on-disk path; conversation
//! titles come from `db::list_conversations` and are used for provenance
//! (`conversationTitle`/`currentConversation` in the JSON and the origin line in
//! the read header). Artifacts without a conversation are labelled
//! [`LIBRARY_ORIGIN_LABEL`] ("Biblioteca (enviado pelo usuário)"). Read access
//! is user-scoped on purpose — the artifacts belong to the user, not to the
//! conversation that created them.
//!
//! Search is intentionally local and deterministic: lower-case + Latin-1
//! diacritic removal (no new dependency), name matches first, conversation title
//! second, textual content last. Binary formats (PDF/DOCX/XLSX/PPTX) match by
//! name only — their text is extracted by `read_artifact`, never inside
//! `list_artifacts`.
//!
//! Both tools are read-only and always available (they are not gated by the
//! turn flags); `read_artifact` paginates in **characters** so a single call
//! always fits under the harness model budget (24_000 chars).

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::db::StoredArtifact;
use crate::domain::{Artifact, ArtifactKind, ArtifactPreview};
use crate::documents::preview::{archive_preview, binary_preview, image_preview};
use crate::i18n;
use crate::providers::ToolDefinition;

use super::{clean_inline, json_str, json_u32, truncate_chars, ToolOutcome, ToolRuntime};

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/// Default/paginated read size in characters (`maxChars`).
const DEFAULT_READ_CHARS: usize = 12_000;
const MIN_READ_CHARS: usize = 1_000;
/// Hard per-call text budget: header + excerpts + footer stay below the
/// harness `MAX_MODEL_TOOL_RESULT_CHARS = 24_000`.
const MAX_READ_CHARS: usize = 20_000;
/// Refuse to load artifacts above this size (an artifact can be up to 25 MB
/// when produced by `run_code`); the user can open it in the artifacts panel.
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

const DEFAULT_LIST_LIMIT: usize = 10;
const MAX_LIST_LIMIT: usize = 50;
/// Content search caps: at most 1 MB per textual artifact and 16 MB per call.
const CONTENT_SCAN_BYTES_PER_FILE: usize = 1024 * 1024;
const CONTENT_SCAN_BYTES_TOTAL: usize = 16 * 1024 * 1024;
const MAX_SNIPPETS_PER_ARTIFACT: usize = 3;
const SNIPPET_MAX_CHARS: usize = 200;
/// Total snippet text budget for one `list_artifacts` response.
const SNIPPET_BUDGET_CHARS: usize = 4_000;
/// Hard JSON budget for one `list_artifacts` response (the model truncates tool
/// results at 24_000 chars, so the JSON must stay well below it).
const MAX_LIST_JSON_CHARS: usize = 20_000;
/// The query echoed back in the JSON is capped so a pathological argument can
/// never consume the JSON budget on its own.
const MAX_ECHOED_QUERY_CHARS: usize = 200;
/// Ranking constants (deterministic, tested).
const RANK_NAME_EXACT: u32 = 100;
const RANK_NAME_PREFIX: u32 = 80;
const RANK_NAME_TERMS: u32 = 60;
/// Match on the origin conversation title sits between the name and the
/// content ranks (a title is a stronger hint than a random content occurrence).
const RANK_CONVERSATION_TITLE: u32 = 45;
const RANK_CONTENT_BASE: u32 = 40;
const MAX_CONTENT_OCCURRENCES: usize = 20;
/// Candidates listed when a name is ambiguous or unknown.
const MAX_NAME_CANDIDATES: usize = 10;

/// Human-readable origin of an artifact without a conversation: the user sent
/// the file directly to the Biblioteca (library upload), so there is no origin
/// conversation title or id to show.
const LIBRARY_ORIGIN_LABEL: &str = "Biblioteca (enviado pelo usuário)";

/// Accepted `kind` slugs (lower-case, the same strings the UI receives).
const KIND_SLUGS: &[&str] = &[
    "markdown",
    "code",
    "text",
    "html",
    "csv",
    "json",
    "svg",
    "image",
    "pdf",
    "docx",
    "xlsx",
    "pptx",
    "audio",
    "video",
    "archive",
    "binary",
];

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

pub fn list_definition() -> ToolDefinition {
    ToolDefinition {
        name: "list_artifacts".to_string(),
        description: "List or search the USER's artifact library across ALL conversations (not \
                      only the current one) to reuse a file as context. The library also contains \
                      the files the user uploaded directly to it (no conversation: \
                      conversationId/conversationTitle are null). With `query`, searches the file \
                      name, the origin conversation title and the textual content \
                      (accents/case-insensitive) and returns up to 3 matching lines per artifact; \
                      without it, lists the most recent artifacts first. Each item carries \
                      conversationId/conversationTitle/currentConversation. Always available; \
                      counts towards the data-tool budget."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Termos de busca no nome, no título da conversa de origem e no conteúdo textual (ignora acentos e maiúsculas; todos os termos precisam aparecer). Omita para listar os artefatos mais recentes da biblioteca."
                },
                "kind": {
                    "type": "string",
                    "description": "Filtra por tipo: markdown, code, text, html, csv, json, svg, image, pdf, docx, xlsx, pptx, audio, video, archive, binary."
                },
                "limit": {
                    "type": "integer",
                    "description": "Máximo de artefatos retornados (1–50, padrão 10)."
                }
            },
            "additionalProperties": false
        }),
    }
}

pub fn read_definition() -> ToolDefinition {
    ToolDefinition {
        name: "read_artifact".to_string(),
        description: "Read ANY artifact of the user (from any conversation or a file the user \
                      uploaded to the library) and bring its content into the context: raw text \
                      for textual artifacts, extracted text for PDF/DOCX/XLSX/PPTX, \
                      metadata/structure for images, audio, video, ZIP and binary files. The header \
                      shows the origin conversation, or \"Biblioteca (enviado pelo usuário)\" for \
                      library uploads. Text is paginated in characters (`offset` + `maxChars`) and \
                      the result ends with the next offset. Always available; counts towards the \
                      data-tool budget."
            .to_string(),
        parameters: json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Id do artefato (preferido)."
                },
                "name": {
                    "type": "string",
                    "description": "Nome do arquivo quando o id é desconhecido; precisa ser único na biblioteca do usuário (todas as conversas)."
                },
                "offset": {
                    "type": "integer",
                    "description": "Deslocamento em caracteres no texto extraído (padrão 0)."
                },
                "maxChars": {
                    "type": "integer",
                    "description": "Máximo de caracteres nesta chamada (1.000–20.000, padrão 12.000)."
                }
            },
            "additionalProperties": false
        }),
    }
}

/* ------------------------------------------------------------------ */
/* `list_artifacts`                                                    */
/* ------------------------------------------------------------------ */

/// One artifact of the user-wide library, enriched with its origin conversation.
#[derive(Clone)]
struct LibraryEntry {
    artifact: Artifact,
    /// Title of the conversation that created the artifact (`None` when the
    /// conversation row is gone **or** when the artifact is a library upload
    /// without a conversation; the id/label is used as fallback).
    conversation_title: Option<String>,
    /// True when the artifact belongs to the turn's conversation.
    current: bool,
}

impl LibraryEntry {
    /// Human-readable provenance: the conversation title, falling back to its
    /// id; artifacts without a conversation are user uploads to the library.
    fn conversation_label(&self) -> &str {
        self.conversation_title
            .as_deref()
            .or(self.artifact.conversation_id.as_deref())
            .unwrap_or(LIBRARY_ORIGIN_LABEL)
    }
}

/// Artifact entry scored by the search, with the snippets collected from its
/// textual content.
struct Candidate {
    entry: LibraryEntry,
    rank: u32,
    snippets: Vec<(u32, String)>,
}

/// Loads the user-wide library once: every artifact of every conversation (and
/// every library upload, which has no conversation) plus the conversation titles
/// used for provenance.
fn load_library(rt: &ToolRuntime) -> Result<Vec<LibraryEntry>, String> {
    let artifacts = rt.db.list_all_artifacts().map_err(|error| {
        i18n::t_args(
            "tools.artifact_library.listFailed",
            &[("error", &format!("{error:#}"))],
        )
    })?;
    let titles = conversation_titles(rt)?;
    Ok(artifacts
        .into_iter()
        .map(|artifact| {
            let current =
                artifact.conversation_id.as_deref() == Some(rt.conversation_id.as_str());
            let conversation_title = artifact
                .conversation_id
                .as_deref()
                .and_then(|conversation_id| titles.get(conversation_id).cloned());
            LibraryEntry {
                artifact,
                conversation_title,
                current,
            }
        })
        .collect())
}

/// Maps `conversation_id -> title` for provenance (`conversationTitle` and the
/// read header). Conversations without a row are simply absent from the map.
fn conversation_titles(rt: &ToolRuntime) -> Result<HashMap<String, String>, String> {
    let conversations = rt
        .db
        .list_conversations()
        .map_err(|error| {
            i18n::t_args(
                "tools.artifact_library.conversationsFailed",
                &[("error", &format!("{error:#}"))],
            )
        })?;
    Ok(conversations
        .into_iter()
        .map(|conversation| (conversation.id, conversation.title))
        .collect())
}

pub async fn run_list(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    // `kind` is validated before touching the database: an unknown slug is a
    // caller mistake and the error lists every accepted value.
    let kind_filter = match parse_kind_filter(args) {
        Ok(kind) => kind,
        Err(message) => return ToolOutcome::error(message),
    };
    let limit = json_u32(args, "limit")
        .map(|value| value.clamp(1, MAX_LIST_LIMIT as u32) as usize)
        .unwrap_or(DEFAULT_LIST_LIMIT);
    let query = json_str(args, "query")
        .map(|query| query.trim().to_string())
        .filter(|query| !query.is_empty());

    let library = match load_library(rt) {
        Ok(library) => library,
        Err(message) => return ToolOutcome::error(message),
    };
    // `total` contract: without a query it is the (kind filtered) library size;
    // with a query it is the number of artifacts that matched.
    let library: Vec<LibraryEntry> = library
        .into_iter()
        .filter(|entry| {
            kind_filter
                .as_ref()
                .map_or(true, |kind| &entry.artifact.kind == kind)
        })
        .collect();

    let (total, candidates) = match query.as_deref() {
        None => {
            // The library now spans every conversation: list the newest artifacts
            // first (created_at desc, id desc) instead of the oldest ones.
            let mut ordered = library;
            ordered.sort_by(|left, right| {
                right
                    .artifact
                    .created_at
                    .cmp(&left.artifact.created_at)
                    .then(right.artifact.id.cmp(&left.artifact.id))
            });
            (
                ordered.len(),
                ordered
                    .into_iter()
                    .map(|entry| Candidate {
                        entry,
                        rank: 0,
                        snippets: Vec::new(),
                    })
                    .collect::<Vec<_>>(),
            )
        }
        Some(query) => {
            let candidates = search_library(rt, &library, query);
            (candidates.len(), candidates)
        }
    };

    // Build the JSON incrementally and stop early when it reaches the hard
    // budget: `returned` is always recomputed from what actually fits.
    let mut items: Vec<Value> = Vec::new();
    let mut snippet_budget = SNIPPET_BUDGET_CHARS;
    let mut snippets_truncated = false;
    let mut list_trimmed = false;
    for candidate in candidates.iter().take(limit) {
        let mut matches = Vec::new();
        for (line, snippet) in &candidate.snippets {
            let size = snippet.chars().count();
            if size > snippet_budget {
                snippets_truncated = true;
                break;
            }
            snippet_budget = snippet_budget.saturating_sub(size);
            matches.push(json!({ "line": line, "text": snippet }));
        }
        let entry = &candidate.entry;
        let artifact = &entry.artifact;
        items.push(json!({
            "id": artifact.id,
            "name": artifact.name,
            "kind": kind_slug(&artifact.kind),
            "mimeType": artifact.mime_type,
            "size": artifact.size,
            "createdAt": artifact.created_at,
            "messageId": artifact.message_id,
            "language": artifact.language,
            "conversationId": artifact.conversation_id,
            "conversationTitle": entry.conversation_title,
            "currentConversation": entry.current,
            "matches": matches,
        }));
        // +1.000 reserves the fixed payload fields (query/total/returned/note)
        // and the conversation titles of the remaining items.
        let serialized_size = serde_json::to_string(&items)
            .map(|json| json.chars().count())
            .unwrap_or(usize::MAX);
        if serialized_size + 1_000 > MAX_LIST_JSON_CHARS {
            items.pop();
            list_trimmed = true;
            break;
        }
    }
    let returned = items.len();

    let note = list_note(query.as_deref(), total, returned, snippets_truncated, list_trimmed);
    let payload = json!({
        "query": query.as_deref().map(|query| truncate_chars(query, MAX_ECHOED_QUERY_CHARS)),
        "total": total,
        "returned": returned,
        "snippetsTruncated": snippets_truncated,
        "artifacts": items,
        "note": note,
    });
    let content = serde_json::to_string(&payload).unwrap_or_else(|_| String::from("{}"));

    ToolOutcome {
        content,
        summary: Some(list_summary(returned, total)),
        presentation: Some(json!({
            "kind": "artifact_list",
            "returned": returned,
            "total": total,
        })),
        ..Default::default()
    }
}

/// Short card summary used by the timeline (the tool result event itself is
/// truncated at 8k, so the summary must carry the counts). Singular/plural in
/// pt-BR: 1 → "1 artefato", N → "N artefatos".
fn list_summary(returned: usize, total: usize) -> String {
    if returned == 0 {
        i18n::t_count("tools.artifact_library.summary", 0, &[])
    } else if total > returned {
        // `total > returned >= 1` implies total ≥ 2: the tail is always plural.
        i18n::t_args(
            "tools.artifact_library.summary.partial",
            &[
                ("returned", &returned.to_string()),
                ("total", &total.to_string()),
            ],
        )
    } else {
        i18n::t_count(
            "tools.artifact_library.summary",
            returned,
            &[("count", &returned.to_string())],
        )
    }
}

fn character_count(count: usize) -> String {
    i18n::t_count(
        "tools.artifact_library.characters",
        count,
        &[("count", &count.to_string())],
    )
}

/// `note` do resultado da listagem: deixa explícito que a biblioteca é do
/// usuário (todas as conversas **e** arquivos enviados por ele à Biblioteca), a
/// ordem sem `query` e o que a busca cobre.
fn list_note(
    query: Option<&str>,
    total: usize,
    returned: usize,
    snippets_truncated: bool,
    list_trimmed: bool,
) -> String {
    let mut note = match (query, total) {
        (None, 0) => "Nenhum artefato na biblioteca ainda.".to_string(),
        (None, _) => "Biblioteca de artefatos do usuário (todas as conversas e arquivos enviados \
                      por ele à Biblioteca), mais recentes primeiro; arquivos enviados pelo usuário \
                      aparecem com `conversationId`/`conversationTitle` nulos. Use `read_artifact` \
                      para ler o conteúdo (PDF/DOCX/XLSX/PPTX têm texto extraído)."
            .to_string(),
        (Some(_), 0) => "Nenhum artefato corresponde à busca. A busca cobre o nome, o título da \
                         conversa de origem e o conteúdo textual de markdown, code, text, html, \
                         csv, json e svg; arquivos enviados pelo usuário à Biblioteca são \
                         encontrados pelo nome; para PDF/DOCX/XLSX/PPTX use `read_artifact`."
            .to_string(),
        (Some(_), _) => "Busca no nome, no título da conversa de origem e no conteúdo textual dos \
                         artefatos, incluindo os arquivos enviados pelo usuário à Biblioteca \
                         (sem conversa); PDF/DOCX/XLSX/PPTX e binários são encontrados apenas pelo \
                         nome — use `read_artifact` para extrair o texto."
            .to_string(),
    };
    if snippets_truncated {
        note.push_str(" Trechos adicionais foram omitidos para caber no contexto.");
    }
    if list_trimmed {
        note.push_str(&format!(
            " Lista reduzida a {returned} de {total} artefatos para caber no contexto; refine a \
             busca ou use `read_artifact`."
        ));
    }
    note
}

fn search_library(rt: &ToolRuntime, library: &[LibraryEntry], query: &str) -> Vec<Candidate> {
    let terms: Vec<String> = normalize_search_text(query)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    // Terms are already normalized, so the rebuilt query has single spaces and
    // matches the normalized file names byte for byte.
    let normalized_query = terms.join(" ");
    let mut remaining_bytes = CONTENT_SCAN_BYTES_TOTAL;
    let mut candidates = Vec::new();

    for entry in library {
        let artifact = &entry.artifact;
        let normalized_name = normalize_search_text(&artifact.name);
        let name_rank = name_rank(&normalized_name, &normalized_query, &terms);
        // Origin conversation title: a stronger hint than a random content match
        // but weaker than any name match.
        let conversation_rank = entry
            .conversation_title
            .as_deref()
            .map(|title| {
                let normalized_title = normalize_search_text(title);
                if terms
                    .iter()
                    .all(|term| normalized_title.contains(term.as_str()))
                {
                    RANK_CONVERSATION_TITLE
                } else {
                    0
                }
            })
            .unwrap_or(0);

        let mut content_rank = 0u32;
        let mut snippets = Vec::new();
        if artifact.kind.is_textual() {
            if let Some(text) = scan_text_content(rt, artifact, &mut remaining_bytes) {
                let normalized_text = normalize_search_text(&text);
                let occurrences: usize = terms
                    .iter()
                    .map(|term| normalized_text.matches(term.as_str()).count())
                    .sum();
                if terms
                    .iter()
                    .all(|term| normalized_text.contains(term.as_str()))
                {
                    content_rank = RANK_CONTENT_BASE
                        + occurrences.min(MAX_CONTENT_OCCURRENCES) as u32;
                    snippets = extract_snippets(&text, &terms);
                }
            }
        }

        let rank = name_rank.max(conversation_rank).max(content_rank);
        if rank == 0 {
            continue;
        }
        candidates.push(Candidate {
            entry: entry.clone(),
            rank,
            snippets,
        });
    }

    // Deterministic: rank desc, newest first, then id asc.
    candidates.sort_by(|left, right| {
        right
            .rank
            .cmp(&left.rank)
            .then(right.entry.artifact.created_at.cmp(&left.entry.artifact.created_at))
            .then(left.entry.artifact.id.cmp(&right.entry.artifact.id))
    });
    candidates
}

/// Ranking do nome do arquivo (determinístico, sem depender de UUID/`created_at`):
/// exato 100 → prefixo 80 → todos os termos 60.
///
/// O tier **exato** compara também o nome sem extensão: os artefatos sempre têm
/// extensão (`.md`, `.csv`, …), então a query `relatorio` precisa casar
/// `relatorio.md` como exata (100). Sem essa comparação, `relatorio.md` e
/// `relatorio-q3-final.md` cairiam no mesmo tier de prefixo (80) e o empate
/// seria decidido por `created_at`/id — ou seja, pelo UUID aleatório.
fn name_rank(normalized_name: &str, normalized_query: &str, terms: &[String]) -> u32 {
    let name_stem = strip_extension(normalized_name);
    let query_stem = strip_extension(normalized_query);
    if normalized_name == normalized_query || name_stem == query_stem {
        RANK_NAME_EXACT
    } else if normalized_name.starts_with(normalized_query) {
        RANK_NAME_PREFIX
    } else if terms
        .iter()
        .all(|term| normalized_name.contains(term.as_str()))
    {
        RANK_NAME_TERMS
    } else {
        0
    }
}

/// Reads at most [`CONTENT_SCAN_BYTES_PER_FILE`] of a textual artifact through
/// `db::get_artifact` (the authoritative path — `list_all_artifacts` returns no
/// path). The shared budget stops the scan after 16 MB per call.
///
/// The whole user library is searchable, so artifacts from any conversation are
/// read here (they belong to the user).
fn scan_text_content(
    rt: &ToolRuntime,
    artifact: &Artifact,
    remaining_bytes: &mut usize,
) -> Option<String> {
    if *remaining_bytes == 0 {
        return None;
    }
    let stored = rt.db.get_artifact(&artifact.id).ok().flatten()?;
    let cap = CONTENT_SCAN_BYTES_PER_FILE.min(*remaining_bytes);
    let bytes = read_file_prefix(Path::new(&stored.path), cap)?;
    *remaining_bytes = remaining_bytes.saturating_sub(bytes.len());
    Some(crate::documents::decode_text(&bytes, None))
}

/// First `limit` bytes of `path` (never loads a huge file into memory).
fn read_file_prefix(path: &Path, limit: usize) -> Option<Vec<u8>> {
    use std::io::Read;

    let file = std::fs::File::open(path).ok()?;
    let mut reader = file.take(limit as u64);
    let mut buffer = Vec::new();
    reader.read_to_end(&mut buffer).ok()?;
    Some(buffer)
}

/// Up to [`MAX_SNIPPETS_PER_ARTIFACT`] lines (1-based) containing any term.
fn extract_snippets(text: &str, terms: &[String]) -> Vec<(u32, String)> {
    let mut snippets = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if snippets.len() >= MAX_SNIPPETS_PER_ARTIFACT {
            break;
        }
        let normalized_line = normalize_search_text(line);
        if !terms
            .iter()
            .any(|term| normalized_line.contains(term.as_str()))
        {
            continue;
        }
        let cleaned = clean_inline(line);
        if cleaned.is_empty() {
            continue;
        }
        snippets.push((
            u32::try_from(index + 1).unwrap_or(u32::MAX),
            truncate_snippet(&cleaned),
        ));
    }
    snippets
}

fn truncate_snippet(text: &str) -> String {
    if text.chars().count() <= SNIPPET_MAX_CHARS {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(SNIPPET_MAX_CHARS - 1).collect();
    clipped.push('…');
    clipped
}

/// Lower-case + Latin-1 diacritic removal. Implemented locally on purpose: the
/// search must stay dependency-free and deterministic (`relatório` ≈
/// `relatorio`, `AÇÃO` ≈ `acao`).
fn normalize_search_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for character in text.chars() {
        for lower in character.to_lowercase() {
            // Decomposed accents (`e` + U+0301) are folded by dropping the mark.
            if ('\u{0300}'..='\u{036f}').contains(&lower) {
                continue;
            }
            match lower {
                'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => output.push('a'),
                'æ' => output.push_str("ae"),
                'ç' => output.push('c'),
                'é' | 'è' | 'ê' | 'ë' => output.push('e'),
                'í' | 'ì' | 'î' | 'ï' => output.push('i'),
                'ð' => output.push('d'),
                'ñ' => output.push('n'),
                'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'ø' => output.push('o'),
                'œ' => output.push_str("oe"),
                'ß' => output.push_str("ss"),
                'ú' | 'ù' | 'û' | 'ü' => output.push('u'),
                'ý' | 'ÿ' => output.push('y'),
                'þ' => output.push_str("th"),
                other => output.push(other),
            }
        }
    }
    output
}

fn parse_kind_filter(args: &Value) -> Result<Option<ArtifactKind>, String> {
    let raw = match json_str(args, "kind") {
        Some(raw) => raw.trim().to_string(),
        None => return Ok(None),
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let slug = raw.to_lowercase();
    kind_from_slug(&slug).map(Some).ok_or_else(|| {
        i18n::t_args(
            "tools.artifact_library.invalidKind",
            &[("kind", &raw), ("accepted", &KIND_SLUGS.join(", "))],
        )
    })
}

fn kind_slug(kind: &ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Markdown => "markdown",
        ArtifactKind::Code => "code",
        ArtifactKind::Text => "text",
        ArtifactKind::Html => "html",
        ArtifactKind::Csv => "csv",
        ArtifactKind::Json => "json",
        ArtifactKind::Svg => "svg",
        ArtifactKind::Image => "image",
        ArtifactKind::Pdf => "pdf",
        ArtifactKind::Docx => "docx",
        ArtifactKind::Xlsx => "xlsx",
        ArtifactKind::Pptx => "pptx",
        ArtifactKind::Audio => "audio",
        ArtifactKind::Video => "video",
        ArtifactKind::Archive => "archive",
        ArtifactKind::Binary => "binary",
    }
}

fn kind_from_slug(slug: &str) -> Option<ArtifactKind> {
    Some(match slug {
        "markdown" => ArtifactKind::Markdown,
        "code" => ArtifactKind::Code,
        "text" => ArtifactKind::Text,
        "html" => ArtifactKind::Html,
        "csv" => ArtifactKind::Csv,
        "json" => ArtifactKind::Json,
        "svg" => ArtifactKind::Svg,
        "image" => ArtifactKind::Image,
        "pdf" => ArtifactKind::Pdf,
        "docx" => ArtifactKind::Docx,
        "xlsx" => ArtifactKind::Xlsx,
        "pptx" => ArtifactKind::Pptx,
        "audio" => ArtifactKind::Audio,
        "video" => ArtifactKind::Video,
        "archive" => ArtifactKind::Archive,
        "binary" => ArtifactKind::Binary,
        _ => return None,
    })
}

/* ------------------------------------------------------------------ */
/* `read_artifact`                                                     */
/* ------------------------------------------------------------------ */

/// Resolved artifact plus the title of the conversation that created it.
struct ResolvedArtifact {
    stored: StoredArtifact,
    conversation_title: Option<String>,
}

/// Origin conversation of a read artifact, shown in the result header.
struct Origin {
    title: Option<String>,
    current: bool,
}

impl Origin {
    fn new(artifact: &Artifact, conversation_title: Option<String>, current_conversation_id: &str) -> Self {
        Self {
            title: conversation_title,
            current: artifact.conversation_id.as_deref() == Some(current_conversation_id),
        }
    }

    /// `Título (outra conversa)` / `id (esta conversa)`; artifacts without a
    /// conversation (user uploads to the library) use [`LIBRARY_ORIGIN_LABEL`].
    fn label(&self, artifact: &Artifact) -> String {
        if artifact.conversation_id.is_none() {
            return LIBRARY_ORIGIN_LABEL.to_string();
        }
        let name = self
            .title
            .as_deref()
            .or(artifact.conversation_id.as_deref())
            .unwrap_or("conversa desconhecida");
        let scope = if self.current {
            "esta conversa"
        } else {
            "outra conversa"
        };
        format!("{name} ({scope})")
    }
}

pub async fn run_read(rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    let resolved = match resolve_artifact(rt, args) {
        Ok(resolved) => resolved,
        Err(message) => return ToolOutcome::error(message),
    };
    let artifact = &resolved.stored.artifact;
    // Provenance: the library is user-wide, so every read shows where the file
    // came from (`esta conversa` vs `outra conversa`) or that the user uploaded
    // it to the library (`Origem: Biblioteca (enviado pelo usuário)`).
    let origin = Origin::new(
        artifact,
        resolved.conversation_title.clone(),
        &rt.conversation_id,
    );
    // The size check happens before reading: `run_code` may produce files up to
    // 25 MB and the whole read would only be refused after loading them.
    let bytes = match read_artifact_bytes(artifact, &resolved.stored.path) {
        Ok(bytes) => bytes,
        Err(message) => return ToolOutcome::error(message),
    };

    match &artifact.kind {
        kind if kind.is_textual() => {
            let text = crate::documents::decode_text(&bytes, None);
            text_outcome(artifact, &origin, &text, args, None)
        }
        ArtifactKind::Pdf | ArtifactKind::Docx | ArtifactKind::Xlsx | ArtifactKind::Pptx => {
            match crate::documents::extract(&bytes, &artifact.name, &artifact.mime_type) {
                Ok(document) if !document.text.trim().is_empty() => {
                    let note = document.truncated.then_some(
                        "O texto extraído foi limitado pelo tamanho do documento.",
                    );
                    text_outcome(artifact, &origin, &document.text, args, note)
                }
                Ok(document) => metadata_outcome(
                    artifact,
                    &origin,
                    &extraction_failure_message(artifact, &document),
                ),
                Err(error) => metadata_outcome(
                    artifact,
                    &origin,
                    &format!(
                        "não foi possível extrair o texto de `{}`: {error:#}. O arquivo continua \
                         disponível no painel de artefatos.",
                        artifact.name
                    ),
                ),
            }
        }
        ArtifactKind::Image => metadata_outcome(artifact, &origin, &image_details(&bytes)),
        ArtifactKind::Archive => metadata_outcome(artifact, &origin, &archive_details(&bytes)),
        ArtifactKind::Audio => metadata_outcome(
            artifact,
            &origin,
            &format!(
                "Formato: {}\nNota: áudio é um arquivo binário e não tem transcrição disponível; o \
                 conteúdo não entra no contexto. Use o painel de artefatos para ouvir ou baixar.",
                artifact.mime_type
            ),
        ),
        ArtifactKind::Video => metadata_outcome(
            artifact,
            &origin,
            &format!(
                "Formato: {}\nNota: vídeo é um arquivo binário e não tem transcrição disponível; o \
                 conteúdo não entra no contexto. Use o painel de artefatos para reproduzir ou \
                 baixar.",
                artifact.mime_type
            ),
        ),
        _ => metadata_outcome(artifact, &origin, &binary_details(&bytes)),
    }
}

/// Resolves the artifact by `id` (user-wide: any conversation) or by `name`.
fn resolve_artifact(rt: &ToolRuntime, args: &Value) -> Result<ResolvedArtifact, String> {
    let id = json_str(args, "id")
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let name = json_str(args, "name")
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());

    if let Some(id) = id {
        let stored = match rt.db.get_artifact(&id) {
            Ok(Some(stored)) => stored,
            Ok(None) => {
                return Err(i18n::t_args(
                    "tools.artifact_library.notFound",
                    &[("id", &id)],
                ))
            }
            Err(error) => {
                return Err(i18n::t_args(
                    "tools.artifact_library.queryFailed",
                    &[("id", &id), ("error", &format!("{error:#}"))],
                ))
            }
        };
        let conversation_title = conversation_title(rt, stored.artifact.conversation_id.as_deref())?;
        return Ok(ResolvedArtifact {
            stored,
            conversation_title,
        });
    }
    if let Some(name) = name {
        return resolve_by_name(rt, &name);
    }
    Err(i18n::t("tools.artifact_library.missingReference"))
}

/// Title of one conversation (provenance for a read by id). `None` when the
/// artifact has no conversation (a user upload to the library).
fn conversation_title(
    rt: &ToolRuntime,
    conversation_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(conversation_id) = conversation_id else {
        return Ok(None);
    };
    Ok(conversation_titles(rt)?.get(conversation_id).cloned())
}

/// Name resolution order over the WHOLE user library: exact normalized name →
/// name without extension → unique substring. Never picks silently when more
/// than one candidate matches; candidates carry their origin conversation.
fn resolve_by_name(rt: &ToolRuntime, name: &str) -> Result<ResolvedArtifact, String> {
    let library = load_library(rt)?;
    if library.is_empty() {
        return Err(i18n::t("tools.artifact_library.emptyLibraryRead"));
    }
    let query = normalize_search_text(name);
    let query_stem = strip_extension(&query);

    let exact: Vec<&LibraryEntry> = library
        .iter()
        .filter(|entry| normalize_search_text(&entry.artifact.name) == query)
        .collect();
    let stem: Vec<&LibraryEntry> = library
        .iter()
        .filter(|entry| {
            strip_extension(&normalize_search_text(&entry.artifact.name)) == query_stem
        })
        .collect();
    let substring: Vec<&LibraryEntry> = library
        .iter()
        .filter(|entry| {
            let normalized = normalize_search_text(&entry.artifact.name);
            normalized.contains(&query) || strip_extension(&normalized).contains(&query_stem)
        })
        .collect();

    for matches in [&exact, &stem, &substring] {
        match matches.len() {
            1 => {
                let entry = matches[0];
                let stored = rt
                    .db
                    .get_artifact(&entry.artifact.id)
                    .map_err(|error| {
                        i18n::t_args(
                            "tools.artifact_library.queryFailed",
                            &[
                                ("id", &entry.artifact.id),
                                ("error", &format!("{error:#}")),
                            ],
                        )
                    })?
                    .ok_or_else(|| {
                        i18n::t("tools.artifact_library.staleByName")
                    })?;
                return Ok(ResolvedArtifact {
                    stored,
                    conversation_title: entry.conversation_title.clone(),
                });
            }
            0 => continue,
            _ => {
                let candidates = matches
                    .iter()
                    .take(MAX_NAME_CANDIDATES)
                    .map(|entry| name_candidate_label(entry))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!(
                    "mais de um artefato corresponde a `{name}`: {candidates}. Use o `id` para \
                     escolher."
                ));
            }
        }
    }

    let candidates = library
        .iter()
        .take(MAX_NAME_CANDIDATES)
        .map(name_candidate_label)
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "artefato `{name}` não encontrado na biblioteca; candidatos: {candidates}. Use o `id` para \
         escolher."
    ))
}

/// `nome (id, conversa: "Título")` — proveniência nas ambiguidades de nome.
/// Arquivos enviados pelo usuário (sem conversa) usam
/// `nome (id, origem: "Biblioteca (enviado pelo usuário)")`.
fn name_candidate_label(entry: &LibraryEntry) -> String {
    if entry.artifact.conversation_id.is_none() {
        return format!(
            "{} ({}, origem: \"{}\")",
            entry.artifact.name,
            entry.artifact.id,
            LIBRARY_ORIGIN_LABEL
        );
    }
    format!(
        "{} ({}, conversa: \"{}\")",
        entry.artifact.name,
        entry.artifact.id,
        entry.conversation_label()
    )
}

fn strip_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(index) if index > 0 && index + 1 < name.len() => name[..index].to_string(),
        _ => name.to_string(),
    }
}

/// Reads the artifact file, refusing anything above [`MAX_READ_BYTES`] before
/// touching the disk content.
fn read_artifact_bytes(artifact: &Artifact, path: &str) -> Result<Vec<u8>, String> {
    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            i18n::t_args(
                "tools.artifact_library.fileMissing",
                &[("name", &artifact.name)],
            )
        } else {
            i18n::t_args(
                "tools.artifact_library.fileAccessFailed",
                &[("name", &artifact.name), ("error", &error.to_string())],
            )
        }
    })?;
    if !metadata.is_file() {
        return Err(i18n::t_args(
            "tools.artifact_library.notAFile",
            &[("name", &artifact.name)],
        ));
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(i18n::t_args(
            "tools.artifact_library.readTooLarge",
            &[
                ("name", &artifact.name),
                ("size", &human_size(metadata.len())),
            ],
        ));
    }
    std::fs::read(path).map_err(|error| {
        i18n::t_args(
            "tools.artifact_library.fileReadFailed",
            &[("name", &artifact.name), ("error", &error.to_string())],
        )
    })
}

/// Text page (header + excerpt + next-offset footer). The whole `content` stays
/// below the 24_000-char model budget by construction.
fn text_outcome(
    artifact: &Artifact,
    origin: &Origin,
    text: &str,
    args: &Value,
    extraction_note: Option<&str>,
) -> ToolOutcome {
    let total = text.chars().count();
    let offset = json_u32(args, "offset")
        .map(|value| value as usize)
        .unwrap_or(0);
    let max_chars = json_u32(args, "maxChars")
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_READ_CHARS)
        .clamp(MIN_READ_CHARS, MAX_READ_CHARS);

    let mut content = artifact_header(artifact, origin);
    content.push_str(&format!("Caracteres: {total}\n"));
    if let Some(note) = extraction_note {
        content.push_str(&format!("Nota: {note}\n"));
    }

    if offset >= total {
        content.push_str(&format!(
            "Faixa exibida: nenhuma (offset {offset} ≥ total de {total} caracteres)\n\n\
             [fim do conteúdo: não há mais texto a partir do offset {offset}.]\n"
        ));
    } else {
        let end = (offset + max_chars).min(total);
        let excerpt: String = text.chars().skip(offset).take(end - offset).collect();
        content.push_str(&format!(
            "Faixa exibida: caracteres {offset}–{end} de {total}\n\n"
        ));
        content.push_str(&excerpt);
        if end < total {
            content.push_str(&format!(
                "\n\n[conteúdo truncado: exibindo {offset}–{end} de {total} caracteres; continue \
                 com offset={end}]"
            ));
        }
        content.push('\n');
    }

    ToolOutcome {
        content,
        summary: Some(format!("{} · {}", artifact.name, character_count(total))),
        ..Default::default()
    }
}

/// Metadata-only answer for images, archives, media and opaque binaries.
fn metadata_outcome(artifact: &Artifact, origin: &Origin, details: &str) -> ToolOutcome {
    let details = details.trim_end();
    ToolOutcome {
        content: format!("{}\n{}\n", artifact_header(artifact, origin), details),
        summary: Some(format!(
            "{} · {}",
            artifact.name,
            i18n::t("tools.artifact_library.binary")
        )),
        ..Default::default()
    }
}

fn artifact_header(artifact: &Artifact, origin: &Origin) -> String {
    // Uploads to the library have no conversation: label the line as the file
    // origin ("Biblioteca (enviado pelo usuário)") instead of a conversation.
    let provenance = if artifact.conversation_id.is_some() {
        format!("Conversa: {}", origin.label(artifact))
    } else {
        format!("Origem: {}", origin.label(artifact))
    };
    format!(
        "Artefato: {}\nId: {}\n{provenance}\nTipo: {} · {}\nCriado em: {}\n",
        artifact.name,
        artifact.id,
        kind_slug(&artifact.kind),
        human_size(artifact.size.max(0) as u64),
        format_created_at(artifact.created_at),
    )
}

fn extraction_failure_message(
    artifact: &Artifact,
    document: &crate::documents::ExtractedDocument,
) -> String {
    let format = document
        .metadata
        .get("format")
        .and_then(|value| value.as_str())
        .unwrap_or("documento");
    match document
        .metadata
        .get("error")
        .and_then(|value| value.as_str())
    {
        Some(error) => i18n::t_args(
            "tools.artifact_library.extractionFailed",
            &[
                ("name", &artifact.name),
                ("format", format),
                ("error", error),
            ],
        ),
        None => i18n::t_args(
            "tools.artifact_library.extractionEmpty",
            &[("name", &artifact.name)],
        ),
    }
}

fn image_details(bytes: &[u8]) -> String {
    match image_preview(bytes) {
        Ok(ArtifactPreview::Image {
            mime,
            width,
            height,
            ..
        }) => {
            let mut details = format!("Formato: {mime}");
            if let (Some(width), Some(height)) = (width.clone(), height.clone()) {
                details.push_str(&format!(" · dimensões: {width}×{height}"));
            }
            details.push_str(
                "\nNota: imagem é um arquivo binário; os pixels não entram no contexto e não há \
                 OCR. Use o painel de artefatos para visualizar ou baixar; peça ao usuário uma \
                 descrição quando precisar interpretar o conteúdo visual.",
            );
            details
        }
        Ok(ArtifactPreview::Unsupported { reason }) => i18n::t_args(
            "tools.artifact_library.previewUnavailable",
            &[("reason", &reason)],
        ),
        Ok(other) => i18n::t_args(
            "tools.artifact_library.preview",
            &[(
                "preview",
                &serde_json::to_string(&other)
                    .unwrap_or_else(|_| i18n::t("tools.artifact_library.unknownPreview")),
            )],
        ),
        Err(error) => i18n::t_args(
            "tools.artifact_library.imageInspectFailed",
            &[("error", &format!("{error:#}"))],
        ),
    }
}

fn archive_details(bytes: &[u8]) -> String {
    match archive_preview(bytes) {
        Ok(ArtifactPreview::Archive {
            format,
            entries,
            total_entries,
            truncated,
        }) => {
            let mut details = format!(
                "Formato: {format} · {total_entries} entrada(s){}\n",
                if truncated {
                    " (listagem limitada)"
                } else {
                    ""
                }
            );
            for entry in entries.iter().take(100) {
                details.push_str(&format!(
                    "- {} ({} bytes{})\n",
                    entry.name,
                    entry.size,
                    if entry.is_dir { ", diretório" } else { "" }
                ));
            }
            details.push_str(
                "Nota: o conteúdo das entradas não é extraído; use o painel de artefatos para \
                 baixar o arquivo compactado.",
            );
            details
        }
        Ok(ArtifactPreview::Unsupported { reason }) => i18n::t_args(
            "tools.artifact_library.previewUnavailable",
            &[("reason", &reason)],
        ),
        Ok(other) => i18n::t_args(
            "tools.artifact_library.preview",
            &[(
                "preview",
                &serde_json::to_string(&other)
                    .unwrap_or_else(|_| i18n::t("tools.artifact_library.unknownPreview")),
            )],
        ),
        Err(error) => i18n::t_args(
            "tools.artifact_library.archiveListFailed",
            &[("error", &format!("{error:#}"))],
        ),
    }
}

fn binary_details(bytes: &[u8]) -> String {
    match binary_preview(bytes) {
        ArtifactPreview::Binary {
            format,
            preview_bytes,
            ..
        } => format!(
            "Formato detectado: {format} · prévia de {preview_bytes} bytes\nNota: binário sem \
             representação textual; o conteúdo não entra no contexto. Use o painel de artefatos \
             para baixar o arquivo."
        ),
        other => format!(
            "Prévia: {}",
            serde_json::to_string(&other).unwrap_or_else(|_| "desconhecida".to_string())
        ),
    }
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes == 1 {
        "1 byte".to_string()
    } else {
        format!("{bytes} bytes")
    }
}

fn format_created_at(created_at: i64) -> String {
    match chrono::DateTime::from_timestamp_millis(created_at) {
        Some(datetime) => datetime
            .with_timezone(&chrono::Local)
            .format("%d/%m/%Y %H:%M")
            .to_string(),
        None => "data desconhecida".to_string(),
    }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::db::Db;
    use crate::domain::Settings;

    use super::*;

    const DOCX: &[u8] = include_bytes!("../documents/testdata/relatorio-trimestral.docx");
    const XLSX: &[u8] = include_bytes!("../documents/testdata/vendas-q3.xlsx");
    const PPTX: &[u8] = include_bytes!("../documents/testdata/apresentacao-q3.pptx");
    const PDF: &[u8] = include_bytes!("../documents/testdata/contrato-servicos.pdf");
    const PNG: &[u8] = include_bytes!("../documents/testdata/grafico-receita.png");
    const ZIPPED: &[u8] = include_bytes!("../documents/testdata/pacote-projeto.zip");

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zylara-artifact-library-test-{}",
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
            skills_roots: Vec::new(),
            approval: None,
            emit: None,
        }
    }

    fn write_artifact(
        rt: &ToolRuntime,
        name: &str,
        bytes: &[u8],
        mime: Option<&str>,
    ) -> Artifact {
        crate::tools::artifacts::write_artifact(
            rt.db.as_ref(),
            &rt.data_dir,
            Some(&rt.conversation_id),
            Some(&rt.message_id),
            name,
            bytes,
            mime,
        )
        .expect("gravar artefato")
    }

    /// Writes an artifact into another conversation of the same user library.
    fn write_to_conversation(
        rt: &ToolRuntime,
        conversation_id: &str,
        name: &str,
        bytes: &[u8],
    ) -> Artifact {
        crate::tools::artifacts::write_artifact(
            rt.db.as_ref(),
            &rt.data_dir,
            Some(conversation_id),
            Some(&rt.message_id),
            name,
            bytes,
            None,
        )
        .expect("gravar artefato de outra conversa")
    }

    /// Writes a file the user uploaded directly to the Biblioteca: an artifact
    /// without conversation and without message.
    fn write_upload(rt: &ToolRuntime, name: &str, bytes: &[u8]) -> Artifact {
        crate::tools::artifacts::write_artifact(
            rt.db.as_ref(),
            &rt.data_dir,
            None,
            None,
            name,
            bytes,
            None,
        )
        .expect("gravar arquivo enviado à biblioteca")
    }

    fn create_conversation(rt: &ToolRuntime, title: &str) -> String {
        rt.db
            .create_conversation(title, "opencode-go", "deepseek-v4.1-flash")
            .expect("criar conversa")
            .id
    }

    fn list_payload(outcome: &ToolOutcome) -> Value {
        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        serde_json::from_str(&outcome.content).expect("list_artifacts devolve JSON válido")
    }

    fn names(payload: &Value) -> Vec<String> {
        payload["artifacts"]
            .as_array()
            .expect("artifacts array")
            .iter()
            .map(|artifact| artifact["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    /* --------------------------- definitions --------------------------- */

    #[test]
    fn definitions_document_the_arguments() {
        let list = list_definition();
        assert_eq!(list.name, "list_artifacts");
        let properties = &list.parameters["properties"];
        for key in ["query", "kind", "limit"] {
            assert!(
                properties.get(key).is_some(),
                "propriedade `{key}` ausente em list_artifacts"
            );
        }
        assert_eq!(list.parameters["additionalProperties"], json!(false));
        assert!(
            list.parameters.get("required").is_none(),
            "list_artifacts não tem argumentos obrigatórios"
        );

        let read = read_definition();
        assert_eq!(read.name, "read_artifact");
        let properties = &read.parameters["properties"];
        for key in ["id", "name", "offset", "maxChars"] {
            assert!(
                properties.get(key).is_some(),
                "propriedade `{key}` ausente em read_artifact"
            );
        }
        assert_eq!(read.parameters["additionalProperties"], json!(false));
        assert!(
            read.parameters.get("required").is_none(),
            "read_artifact valida os argumentos em runtime"
        );
        assert!(read.description.contains("Always available"));
        // Escopo revisado: biblioteca do USUÁRIO, todas as conversas.
        assert!(
            list.description.contains("ALL conversations"),
            "list_artifacts deve declarar escopo de usuário: {}",
            list.description
        );
        assert!(list.description.contains("USER's artifact library"));
        assert!(list.description.contains("conversationTitle"));
        assert!(list.description.contains("currentConversation"));
        // A biblioteca também contém os arquivos enviados pelo usuário (sem
        // conversa): a descrição precisa deixar isso explícito para o modelo.
        assert!(
            list.description.contains("uploaded directly"),
            "list_artifacts deve citar os arquivos enviados pelo usuário: {}",
            list.description
        );
        assert!(
            read.description.contains("ANY artifact of the user"),
            "read_artifact deve declarar escopo de usuário: {}",
            read.description
        );
        assert!(read.description.contains("from any conversation"));
        assert!(read.description.contains("origin conversation"));
        assert!(
            read.description.contains("uploaded to the library"),
            "read_artifact deve citar os arquivos enviados pelo usuário: {}",
            read.description
        );
        assert!(read.description.contains(LIBRARY_ORIGIN_LABEL));
    }

    #[test]
    fn kind_slugs_round_trip() {
        let kinds = [
            ArtifactKind::Markdown,
            ArtifactKind::Code,
            ArtifactKind::Text,
            ArtifactKind::Html,
            ArtifactKind::Csv,
            ArtifactKind::Json,
            ArtifactKind::Svg,
            ArtifactKind::Image,
            ArtifactKind::Pdf,
            ArtifactKind::Docx,
            ArtifactKind::Xlsx,
            ArtifactKind::Pptx,
            ArtifactKind::Audio,
            ArtifactKind::Video,
            ArtifactKind::Archive,
            ArtifactKind::Binary,
        ];
        assert_eq!(kinds.len(), KIND_SLUGS.len());
        for kind in kinds {
            let slug = kind_slug(&kind);
            assert!(KIND_SLUGS.contains(&slug), "slug `{slug}` fora da lista");
            assert_eq!(kind_from_slug(slug), Some(kind.clone()));
        }
        assert_eq!(kind_from_slug("planilha"), None);
    }

    #[test]
    fn normalization_ignores_case_and_latin1_accents() {
        assert_eq!(
            normalize_search_text("Relatório TRIMESTRAL — Ação ção"),
            "relatorio trimestral — acao cao"
        );
        assert_eq!(normalize_search_text("ÂÉÎÕÜ"), "aeiou");
        assert_eq!(normalize_search_text("e\u{0301}"), "e");
    }

    /* ------------------------------ list ------------------------------- */

    #[tokio::test]
    async fn empty_library_is_not_an_error() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let outcome = run_list(&rt, &json!({})).await;
        assert!(!outcome.is_error, "biblioteca vazia nunca é erro");
        let payload = list_payload(&outcome);
        assert_eq!(payload["total"], 0);
        assert_eq!(payload["returned"], 0);
        assert_eq!(payload["query"], Value::Null);
        assert_eq!(payload["note"], "Nenhum artefato na biblioteca ainda.");
        assert_eq!(payload["artifacts"], json!([]));
        assert_eq!(payload["snippetsTruncated"], false);
        assert_eq!(outcome.summary.as_deref(), Some("nenhum artefato"));
    }

    #[tokio::test]
    async fn lists_artifacts_newest_first_across_the_library() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_artifact(&rt, "c.md", b"# C\n", None);
        write_artifact(&rt, "a.md", b"# A\n", None);
        write_artifact(&rt, "b.csv", b"x,y\n1,2\n", None);

        let outcome = run_list(&rt, &json!({})).await;
        let payload = list_payload(&outcome);
        // Biblioteca do usuário: mais recentes primeiro (created_at desc, id desc).
        let mut expected: Vec<Artifact> = rt.db.list_all_artifacts().expect("listar biblioteca");
        expected.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then(right.id.cmp(&left.id))
        });
        let expected: Vec<String> = expected.into_iter().map(|artifact| artifact.name).collect();
        assert_eq!(names(&payload), expected, "ordem mais recentes primeiro");
        assert_eq!(payload["total"], 3);
        assert_eq!(payload["returned"], 3);
        assert_eq!(outcome.summary.as_deref(), Some("3 artefatos"));
        // Sem query não há snippets nem leitura de conteúdo.
        assert!(payload["artifacts"]
            .as_array()
            .expect("array")
            .iter()
            .all(|artifact| artifact["matches"] == json!([])));
        // JSON em camelCase, com a proveniência de cada artefato.
        let first = &payload["artifacts"][0];
        for key in [
            "id",
            "name",
            "kind",
            "mimeType",
            "size",
            "createdAt",
            "messageId",
            "conversationId",
            "conversationTitle",
            "currentConversation",
        ] {
            assert!(first.get(key).is_some(), "campo `{key}` ausente: {first}");
        }
        assert_eq!(first["conversationId"], "conv-1");
        assert_eq!(first["currentConversation"], true);
        assert_eq!(first["conversationTitle"], Value::Null, "sem registro de conversa");
    }

    #[tokio::test]
    async fn finds_artifacts_by_name_ignoring_accents() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_artifact(&rt, "relatório.md", "# Relatório\n".as_bytes(), None);
        write_artifact(&rt, "outro.md", b"# Outro\n", None);

        let outcome = run_list(&rt, &json!({"query": "relatorio"})).await;
        let payload = list_payload(&outcome);
        assert_eq!(payload["total"], 1);
        assert_eq!(payload["returned"], 1);
        assert_eq!(names(&payload), vec!["relatório.md"]);
        assert_eq!(payload["artifacts"][0]["kind"], "markdown");
        assert_eq!(payload["query"], "relatorio");
        assert_eq!(outcome.summary.as_deref(), Some("1 artefato"));
        // O nome casou, mas o conteúdo também menciona o termo: o trecho ajuda
        // o modelo a decidir sem um segundo `read_artifact`.
        let matches = payload["artifacts"][0]["matches"]
            .as_array()
            .expect("matches array");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["line"], 1);
        assert!(matches[0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("Relatório"));
    }

    #[tokio::test]
    async fn search_by_name_ranks_exact_then_prefix_then_terms() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        // O ranking precisa vencer sozinho: os três ranks são distintos, então a
        // ordem NÃO depende de created_at nem do UUID dos artefatos. `relatorio`
        // é exato para `relatorio.md` (nome sem extensão == query sem extensão).
        write_artifact(&rt, "relatorio-q3-final.md", b"nota", None);
        write_artifact(&rt, "relatorio.md", b"nota", None);
        write_artifact(&rt, "meu-relatorio.md", b"nota", None);

        let payload = list_payload(&run_list(&rt, &json!({"query": "relatorio"})).await);
        assert_eq!(
            names(&payload),
            vec!["relatorio.md", "relatorio-q3-final.md", "meu-relatorio.md"],
            "exato (100) > prefixo (80) > nome com todos os termos (60)"
        );
    }

    #[test]
    fn name_rank_is_deterministic_by_extensionless_equality() {
        let terms = |query: &str| -> Vec<String> {
            query.split_whitespace().map(str::to_string).collect()
        };
        // Query sem extensão: `relatorio.md` é exato (não prefixo) e
        // `relatorio-q3-final.md` é prefixo — tiers distintos, sem empate.
        assert_eq!(
            name_rank("relatorio.md", "relatorio", &terms("relatorio")),
            RANK_NAME_EXACT
        );
        assert_eq!(
            name_rank("relatorio-q3-final.md", "relatorio", &terms("relatorio")),
            RANK_NAME_PREFIX
        );
        assert_eq!(
            name_rank("meu-relatorio.md", "relatorio", &terms("relatorio")),
            RANK_NAME_TERMS
        );
        // Nome completo igual à query continua exato.
        assert_eq!(
            name_rank("relatorio.md", "relatorio.md", &terms("relatorio.md")),
            RANK_NAME_EXACT
        );
        assert_eq!(
            name_rank(
                "relatorio-q3-final.md",
                "relatorio-q3-final",
                &terms("relatorio-q3-final")
            ),
            RANK_NAME_EXACT
        );
        // Sem correspondência de nome: rank zero (conteúdo decide).
        assert_eq!(name_rank("nota.md", "relatorio", &terms("relatorio")), 0);
        // Extensões diferentes com o mesmo radical: ambos exatos (empate só
        // entre eles, nunca com o tier de prefixo).
        assert_eq!(
            name_rank("relatorio.csv", "relatorio", &terms("relatorio")),
            RANK_NAME_EXACT
        );
    }

    #[tokio::test]
    async fn search_by_content_returns_line_snippets() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let content = "# Reunião\n\nDecisão: usar o conector de ERP no Q3.\nRevisar em outubro.\n";
        write_artifact(&rt, "notas.md", content.as_bytes(), None);
        write_artifact(&rt, "diario.md", "# Diário\nSem termos aqui.\n".as_bytes(), None);

        let payload = list_payload(&run_list(&rt, &json!({"query": "conector"})).await);
        assert_eq!(payload["total"], 1, "apenas o arquivo com o termo no conteúdo");
        let artifact = &payload["artifacts"][0];
        assert_eq!(artifact["name"], "notas.md");
        let matches = artifact["matches"].as_array().expect("matches array");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["line"], 3, "linha 1-based do termo");
        assert!(
            matches[0]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("conector de ERP"),
            "trecho: {matches:?}"
        );
        // O arquivo sem match não aparece.
        assert!(!names(&payload).contains(&"diario.md".to_string()));
    }

    #[tokio::test]
    async fn search_requires_all_terms() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_artifact(&rt, "a.md", b"alpha beta\n", None);
        write_artifact(&rt, "b.md", b"alpha gamma\n", None);

        let payload = list_payload(&run_list(&rt, &json!({"query": "alpha beta"})).await);
        assert_eq!(names(&payload), vec!["a.md"]);
    }

    #[tokio::test]
    async fn search_skips_binary_content_and_explains_read() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_artifact(&rt, "dados.bin", b"conector de ERP", None);
        write_artifact(&rt, "zip.md", b"texto comum\n", None);

        let payload = list_payload(&run_list(&rt, &json!({"query": "conector"})).await);
        assert_eq!(payload["total"], 0, "binário não casa por conteúdo");
        let note = payload["note"].as_str().unwrap_or_default();
        assert!(note.contains("read_artifact"), "nota orienta o read: {note}");
    }

    #[tokio::test]
    async fn filters_by_kind_and_rejects_invalid_slugs() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_artifact(&rt, "nota.md", b"# Nota\n", None);
        write_artifact(&rt, "dados.csv", b"a,b\n1,2\n", None);

        let payload = list_payload(&run_list(&rt, &json!({"kind": "csv"})).await);
        assert_eq!(payload["total"], 1);
        assert_eq!(names(&payload), vec!["dados.csv"]);

        let outcome = run_list(&rt, &json!({"kind": "planilha"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("planilha"));
        assert!(
            outcome.content.contains("valores aceitos"),
            "erro lista os valores aceitos: {}",
            outcome.content
        );
        assert!(outcome.content.contains("markdown"));
        assert!(outcome.content.contains("binary"));
    }

    #[tokio::test]
    async fn clamps_the_limit_and_reports_total() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        for index in 0..12 {
            write_artifact(&rt, &format!("arquivo-{index:02}.md"), b"conteudo", None);
        }

        let payload = list_payload(&run_list(&rt, &json!({"limit": 0})).await);
        assert_eq!(payload["returned"], 1, "limit mínimo é 1");
        assert_eq!(payload["total"], 12);

        let outcome = run_list(&rt, &json!({"limit": 2})).await;
        let payload = list_payload(&outcome);
        assert_eq!(payload["returned"], 2);
        assert_eq!(payload["total"], 12);
        assert_eq!(outcome.summary.as_deref(), Some("2 de 12 artefatos"));

        let payload = list_payload(&run_list(&rt, &json!({"limit": 999})).await);
        assert_eq!(payload["returned"], 12, "limit acima do máximo não inventa itens");
    }

    #[tokio::test]
    async fn lists_artifacts_from_all_conversations() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let first = create_conversation(&rt, "Relatório Q3");
        let second = create_conversation(&rt, "Planejamento 2027");
        // A conversa do turno é a segunda: a flag `currentConversation` precisa
        // distinguir as duas.
        rt.conversation_id = second.clone();
        write_to_conversation(&rt, &first, "relatorio-q3.md", "# Relatório Q3\n".as_bytes());
        write_to_conversation(&rt, &second, "plano-2027.md", b"# Plano 2027\n");

        let outcome = run_list(&rt, &json!({})).await;
        let payload = list_payload(&outcome);
        assert_eq!(payload["total"], 2, "biblioteca do usuário: todas as conversas");
        assert_eq!(payload["returned"], 2);

        let artifacts = payload["artifacts"].as_array().expect("artifacts");
        let by_name = |name: &str| -> &Value {
            artifacts
                .iter()
                .find(|artifact| artifact["name"] == name)
                .unwrap_or_else(|| panic!("artefato `{name}` ausente: {artifacts:?}"))
        };
        let relatorio = by_name("relatorio-q3.md");
        assert_eq!(relatorio["conversationId"], first.as_str());
        assert_eq!(relatorio["conversationTitle"], "Relatório Q3");
        assert_eq!(relatorio["currentConversation"], false);
        let plano = by_name("plano-2027.md");
        assert_eq!(plano["conversationId"], second.as_str());
        assert_eq!(plano["conversationTitle"], "Planejamento 2027");
        assert_eq!(plano["currentConversation"], true);
        // Mais recentes primeiro: a ordem segue created_at desc, id desc.
        let mut expected: Vec<Artifact> = rt.db.list_all_artifacts().expect("biblioteca");
        expected.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then(right.id.cmp(&left.id))
        });
        assert_eq!(
            names(&payload),
            expected
                .into_iter()
                .map(|artifact| artifact.name)
                .collect::<Vec<_>>()
        );
        assert_eq!(outcome.summary.as_deref(), Some("2 artefatos"));
    }

    #[tokio::test]
    async fn lists_user_uploads_without_a_conversation() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let conversation = create_conversation(&rt, "Relatório Q3");
        rt.conversation_id = conversation.clone();
        write_to_conversation(&rt, &conversation, "gerado.md", b"# Gerado\n");
        let upload = write_upload(&rt, "contrato-servicos.pdf", PDF);

        let payload = list_payload(&run_list(&rt, &json!({})).await);
        assert_eq!(payload["total"], 2, "gerado + enviado na mesma biblioteca");
        let artifacts = payload["artifacts"].as_array().expect("artifacts");
        let by_name = |name: &str| -> &Value {
            artifacts
                .iter()
                .find(|artifact| artifact["name"] == name)
                .unwrap_or_else(|| panic!("artefato `{name}` ausente: {artifacts:?}"))
        };
        // Upload: sem conversa e sem título; nunca é "a conversa atual".
        let uploaded = by_name("contrato-servicos.pdf");
        assert_eq!(uploaded["id"], upload.id.as_str());
        assert_eq!(uploaded["kind"], "pdf");
        assert_eq!(uploaded["conversationId"], Value::Null, "upload não tem conversa");
        assert_eq!(uploaded["conversationTitle"], Value::Null);
        assert_eq!(uploaded["currentConversation"], false);
        // Artefato gerado continua com a proveniência da conversa.
        let generated = by_name("gerado.md");
        assert_eq!(generated["conversationId"], conversation.as_str());
        assert_eq!(generated["conversationTitle"], "Relatório Q3");
        assert_eq!(generated["currentConversation"], true);
        // A nota da listagem cita os arquivos enviados pelo usuário.
        let note = payload["note"].as_str().unwrap_or_default();
        assert!(
            note.contains("arquivos enviados pelo usuário"),
            "nota sem menção aos uploads: {note}"
        );
    }

    #[tokio::test]
    async fn reads_user_uploads_by_id_and_name_with_library_origin() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        // Contrato PDF real enviado pelo usuário: o texto é extraído normalmente.
        let upload = write_upload(&rt, "contrato-servicos.pdf", PDF);

        let outcome = run_read(&rt, &json!({"id": upload.id})).await;
        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(
            outcome
                .content
                .contains("Origem: Biblioteca (enviado pelo usuário)"),
            "cabeçalho sem origem da biblioteca: {}",
            outcome.content
        );
        assert!(
            outcome.content.contains("Aurora Analytics"),
            "texto do PDF não extraído: {}",
            &outcome.content[..outcome.content.len().min(400)]
        );

        // Por nome (com e sem extensão) o upload também resolve.
        let outcome = run_read(&rt, &json!({"name": "contrato-servicos"})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains(&upload.id));
        assert!(outcome
            .content
            .contains("Origem: Biblioteca (enviado pelo usuário)"));
    }

    #[tokio::test]
    async fn ambiguous_names_show_the_library_origin_for_uploads() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let conversation = create_conversation(&rt, "Planejamento");
        rt.conversation_id = conversation.clone();
        write_upload(&rt, "contrato.pdf", PDF);
        write_to_conversation(&rt, &conversation, "contrato.pdf", PDF);

        let outcome = run_read(&rt, &json!({"name": "contrato"})).await;
        assert!(outcome.is_error, "nome ambíguo deveria pedir o id");
        assert!(outcome.content.contains("mais de um artefato"));
        assert!(
            outcome
                .content
                .contains("origem: \"Biblioteca (enviado pelo usuário)\""),
            "candidato upload sem origem da biblioteca: {}",
            outcome.content
        );
        assert!(
            outcome.content.contains("conversa: \"Planejamento\""),
            "candidato gerado sem conversa de origem: {}",
            outcome.content
        );
    }

    #[tokio::test]
    async fn search_finds_user_uploads_by_name_and_content() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_upload(
            &rt,
            "notas-da-biblioteca.md",
            b"# Notas\nconector de ERP no Q3\n",
        );

        // Conteúdo textual de um arquivo enviado é pesquisável.
        let payload = list_payload(&run_list(&rt, &json!({"query": "conector"})).await);
        assert_eq!(payload["total"], 1);
        assert_eq!(names(&payload), vec!["notas-da-biblioteca.md"]);
        assert_eq!(payload["artifacts"][0]["conversationTitle"], Value::Null);
        assert_eq!(payload["artifacts"][0]["currentConversation"], false);

        // Nome do upload (sem acentos/caixa) também.
        let payload = list_payload(&run_list(&rt, &json!({"query": "BIBLIOTECA"})).await);
        assert_eq!(payload["total"], 1);
        assert_eq!(names(&payload), vec!["notas-da-biblioteca.md"]);
    }

    #[tokio::test]
    async fn search_notes_mention_user_uploads() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_upload(&rt, "enviado.md", b"# Enviado\n");

        let payload = list_payload(&run_list(&rt, &json!({"query": "enviado"})).await);
        let note = payload["note"].as_str().unwrap_or_default();
        assert!(
            note.contains("arquivos enviados pelo usuário"),
            "nota de busca sem menção aos uploads: {note}"
        );

        // Busca sem resultado também explica que uploads são achados pelo nome.
        let payload = list_payload(&run_list(&rt, &json!({"query": "inexistente"})).await);
        let note = payload["note"].as_str().unwrap_or_default();
        assert!(
            note.contains("arquivos enviados pelo usuário"),
            "nota de busca vazia sem menção aos uploads: {note}"
        );
    }

    #[tokio::test]
    async fn reads_artifacts_from_other_conversations() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let current = create_conversation(&rt, "Conversa atual");
        let other = create_conversation(&rt, "Projeto Aurora");
        rt.conversation_id = current.clone();
        let foreign =
            write_to_conversation(&rt, &other, "resumo-aurora.md", b"# Resumo\nstatus verde\n");

        // Por id: qualquer artefato do usuário é legível.
        let outcome = run_read(&rt, &json!({"id": foreign.id})).await;
        assert!(!outcome.is_error, "leitura cross-conversation: {}", outcome.content);
        assert!(outcome.content.contains("# Resumo"));
        assert!(outcome.content.contains("status verde"));
        assert!(
            outcome
                .content
                .contains("Conversa: Projeto Aurora (outra conversa)"),
            "cabeçalho sem proveniência: {}",
            outcome.content
        );

        // Por nome único na biblioteca: também resolve.
        let outcome = run_read(&rt, &json!({"name": "resumo-aurora"})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains(&foreign.id));

        // Nome repetido em duas conversas: ambíguo, candidatos com proveniência.
        write_to_conversation(&rt, &current, "resumo-aurora.md", b"# Resumo da atual\n");
        let outcome = run_read(&rt, &json!({"name": "resumo-aurora.md"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("mais de um artefato"));
        assert!(
            outcome.content.contains("conversa: \"Projeto Aurora\""),
            "candidato sem título da conversa: {}",
            outcome.content
        );
        assert!(outcome.content.contains("conversa: \"Conversa atual\""));

        // Leitura de um artefato da própria conversa marca `esta conversa`.
        let own = write_artifact(&rt, "nota-atual.md", b"# Nota\n", None);
        let outcome = run_read(&rt, &json!({"id": own.id})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(
            outcome
                .content
                .contains("Conversa: Conversa atual (esta conversa)"),
            "cabeçalho da conversa atual: {}",
            outcome.content
        );
    }

    #[tokio::test]
    async fn searches_foreign_content_and_conversation_title() {
        let temp = TempDir::new();
        let mut rt = runtime(&temp);
        let current = create_conversation(&rt, "Notas de reunião");
        let other = create_conversation(&rt, "Financeiro 2027");
        rt.conversation_id = current;
        write_to_conversation(
            &rt,
            &other,
            "planilha.md",
            b"# Planilha\nconector de ERP\n",
        );

        // Conteúdo textual de outra conversa.
        let payload = list_payload(&run_list(&rt, &json!({"query": "conector"})).await);
        assert_eq!(payload["total"], 1, "conteúdo de outra conversa é pesquisável");
        assert_eq!(names(&payload), vec!["planilha.md"]);
        assert_eq!(payload["artifacts"][0]["conversationTitle"], "Financeiro 2027");
        assert_eq!(payload["artifacts"][0]["currentConversation"], false);
        assert!(!payload["artifacts"][0]["matches"]
            .as_array()
            .expect("matches")
            .is_empty());

        // Título da conversa de origem (rank 45): casa só pelo título.
        let payload = list_payload(&run_list(&rt, &json!({"query": "financeiro"})).await);
        assert_eq!(payload["total"], 1);
        assert_eq!(names(&payload), vec!["planilha.md"]);
    }

    #[tokio::test]
    async fn notes_explain_the_user_wide_library() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        write_artifact(&rt, "nota.md", b"# Nota\n", None);

        let payload = list_payload(&run_list(&rt, &json!({})).await);
        let note = payload["note"].as_str().unwrap_or_default();
        assert!(
            note.contains("Biblioteca de artefatos do usuário (todas as conversas"),
            "nota sem escopo de usuário: {note}"
        );
        assert!(
            note.contains("arquivos enviados pelo usuário"),
            "nota sem a origem dos uploads: {note}"
        );
        assert!(note.contains("mais recentes primeiro"), "nota: {note}");

        let payload = list_payload(&run_list(&rt, &json!({"query": "inexistente"})).await);
        let note = payload["note"].as_str().unwrap_or_default();
        assert!(
            note.contains("título da conversa de origem"),
            "busca sem título da conversa na nota: {note}"
        );
    }

    #[tokio::test]
    async fn snippets_respect_the_char_budget() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        // 12 arquivos × 3 linhas longas com o termo: 7.200 chars de snippets
        // possíveis, acima do orçamento de 4.000.
        let filler = "dados ".to_string() + &"x".repeat(190);
        for index in 0..12 {
            let content = format!("{filler}\n{filler}\n{filler}\n");
            write_artifact(&rt, &format!("relatorio-{index:02}.md"), content.as_bytes(), None);
        }

        let outcome = run_list(&rt, &json!({"query": "dados", "limit": 50})).await;
        let payload = list_payload(&outcome);
        assert_eq!(payload["total"], 12);
        assert_eq!(payload["snippetsTruncated"], true, "orçamento de snippets estourado");
        let snippet_chars: usize = payload["artifacts"]
            .as_array()
            .expect("array")
            .iter()
            .flat_map(|artifact| artifact["matches"].as_array().cloned().unwrap_or_default())
            .map(|matched| matched["text"].as_str().unwrap_or_default().chars().count())
            .sum();
        assert!(
            snippet_chars <= SNIPPET_BUDGET_CHARS,
            "snippets somam {snippet_chars} chars"
        );
        assert!(outcome.content.contains("Trechos adicionais"));
    }

    #[tokio::test]
    async fn list_json_stays_below_the_model_budget_with_fifty_long_names() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let long_stem = "x".repeat(110);
        for index in 0..50 {
            let name = format!("{long_stem}-{index:02}.md");
            let content = format!(
                "{}\n{}\n{}\n",
                "relatorio ".to_string() + &"d".repeat(190),
                "relatorio ".to_string() + &"d".repeat(190),
                "relatorio ".to_string() + &"d".repeat(190)
            );
            write_artifact(&rt, &name, content.as_bytes(), None);
        }

        let outcome = run_list(&rt, &json!({"query": "relatorio", "limit": 50})).await;
        let payload = list_payload(&outcome);
        assert_eq!(payload["total"], 50);
        assert!(
            outcome.content.chars().count() < 24_000,
            "JSON de list_artifacts com {} chars passa do limite do modelo",
            outcome.content.chars().count()
        );
        let returned = payload["returned"].as_u64().expect("returned") as usize;
        assert_eq!(
            payload["artifacts"].as_array().expect("array").len(),
            returned,
            "`returned` reflete o que coube no JSON"
        );
        assert!(returned >= 1);
        if returned < 50 {
            assert!(
                outcome
                    .summary
                    .as_deref()
                    .unwrap_or_default()
                    .contains(" de 50 artefatos"),
                "summary com corte: {:?}",
                outcome.summary
            );
        }
    }

    /* ------------------------------ read ------------------------------- */

    #[tokio::test]
    async fn reads_a_text_artifact_with_header_and_summary() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let content = "# Nota\nLinha dois do relatório.\n";
        let artifact = write_artifact(&rt, "nota.md", content.as_bytes(), None);

        let outcome = run_read(&rt, &json!({"id": artifact.id})).await;
        assert!(!outcome.is_error, "erro inesperado: {}", outcome.content);
        assert!(outcome.content.contains("Artefato: nota.md"));
        assert!(outcome.content.contains(&format!("Id: {}", artifact.id)));
        assert!(outcome.content.contains("Tipo: markdown"));
        // Proveniência: sem registro de conversa, cai no id; a conversa é a do turno.
        assert!(
            outcome.content.contains("Conversa: conv-1 (esta conversa)"),
            "cabeçalho de proveniência: {}",
            outcome.content
        );
        assert!(outcome.content.contains(&format!(
            "Caracteres: {}",
            content.chars().count()
        )));
        assert!(outcome.content.contains("Linha dois do relatório."));
        assert_eq!(
            outcome.summary.as_deref(),
            Some(format!("nota.md · {} caracteres", content.chars().count()).as_str())
        );
    }

    #[tokio::test]
    async fn paginates_text_by_characters_with_next_offset() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let text = format!("{}{}", "A".repeat(1_500), "MARCO-B");
        let total = text.chars().count();
        let artifact = write_artifact(&rt, "grande.txt", text.as_bytes(), None);

        let first = run_read(
            &rt,
            &json!({"id": artifact.id, "maxChars": 1000}),
        )
        .await;
        assert!(!first.is_error, "{}", first.content);
        assert!(first.content.contains(&format!("Caracteres: {total}")));
        assert!(first.content.contains("offset=1000"), "rodapé com próximo offset");
        assert!(!first.content.contains("MARCO-B"));

        let second = run_read(
            &rt,
            &json!({"id": artifact.id, "offset": 1000, "maxChars": 1000}),
        )
        .await;
        assert!(!second.is_error, "{}", second.content);
        assert!(
            second.content.contains("MARCO-B"),
            "a segunda página precisa conter o fim do texto: {}",
            second.content
        );
        assert!(second
            .content
            .contains(&format!("Faixa exibida: caracteres 1000–{total}")));
    }

    #[tokio::test]
    async fn default_read_stays_under_the_model_budget() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let text = "B".repeat(30_000);
        let artifact = write_artifact(&rt, "enorme.txt", text.as_bytes(), None);

        let outcome = run_read(&rt, &json!({"id": artifact.id})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(
            outcome.content.chars().count() < 24_000,
            "resultado com {} chars",
            outcome.content.chars().count()
        );
        assert!(outcome.content.contains("offset=12000"), "maxChars padrão");
        assert_eq!(
            outcome.summary.as_deref(),
            Some("enorme.txt · 30000 caracteres")
        );

        // `maxChars` acima do teto é limitado a 20.000.
        let outcome = run_read(&rt, &json!({"id": artifact.id, "maxChars": 999_999})).await;
        assert!(outcome.content.contains("offset=20000"));
        assert!(outcome.content.chars().count() < 24_000);
    }

    #[tokio::test]
    async fn offset_beyond_the_end_is_a_friendly_note() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let artifact = write_artifact(&rt, "curto.txt", b"linha unica", None);

        let outcome = run_read(&rt, &json!({"id": artifact.id, "offset": 500})).await;
        assert!(!outcome.is_error, "fim do conteúdo não é erro");
        assert!(outcome.content.contains("fim do conteúdo"));
        assert!(outcome.content.contains("offset 500"));
        assert_eq!(
            outcome.summary.as_deref(),
            Some("curto.txt · 11 caracteres")
        );
    }

    #[tokio::test]
    async fn resolves_by_name_exactly_without_extension_and_rejects_ambiguity() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let artifact = write_artifact(&rt, "relatorio.md", "# Relatório\n".as_bytes(), None);

        let outcome = run_read(&rt, &json!({"name": "relatorio.md"})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains(&artifact.id));

        let outcome = run_read(&rt, &json!({"name": "relatorio"})).await;
        assert!(!outcome.is_error, "sem extensão: {}", outcome.content);
        assert!(outcome.content.contains(&artifact.id));

        let outcome = run_read(&rt, &json!({"name": "RELATÓRIO"})).await;
        assert!(!outcome.is_error, "sem acento/maiúsculas: {}", outcome.content);

        // Ambíguo por substring: dois nomes com o mesmo radical.
        write_artifact(&rt, "relatorio-anual.md", b"# Anual\n", None);
        let outcome = run_read(&rt, &json!({"name": "relato"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("mais de um artefato"));
        assert!(
            outcome.content.contains("conversa:"),
            "candidatos com proveniência: {}",
            outcome.content
        );
        assert!(outcome.content.contains("relatorio-anual.md"));
        assert!(outcome.content.contains("relatorio.md"));
        assert!(outcome.content.contains("`id`"));

        let outcome = run_read(&rt, &json!({"name": "inexistente.md"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("não encontrado"));
        assert!(outcome.content.contains("candidatos"));
    }

    #[tokio::test]
    async fn requires_an_id_or_a_name() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let outcome = run_read(&rt, &json!({})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("`id`"));
        assert!(outcome.content.contains("`name`"));

        let outcome = run_read(&rt, &json!({"id": "nao-existe"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("não encontrado"));

        // Nome sem biblioteca também é erro explicativo.
        let outcome = run_read(&rt, &json!({"name": "x.md"})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("nenhum artefato na biblioteca"));
    }

    #[tokio::test]
    async fn reports_a_missing_file_on_disk() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let artifact = write_artifact(&rt, "sumiu.md", b"# Sumiu\n", None);
        let stored = rt
            .db
            .get_artifact(&artifact.id)
            .expect("consultar")
            .expect("existe");
        std::fs::remove_file(&stored.path).expect("remover arquivo");

        let outcome = run_read(&rt, &json!({"id": artifact.id})).await;
        assert!(outcome.is_error);
        assert!(
            outcome.content.contains("não foi encontrado no disco"),
            "erro orientativo: {}",
            outcome.content
        );
        assert!(outcome.content.contains("painel de artefatos"));
    }

    #[tokio::test]
    async fn refuses_files_above_sixteen_megabytes_without_reading_them() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let bytes = vec![b'a'; (MAX_READ_BYTES + 1) as usize];
        let artifact = write_artifact(&rt, "grande.bin", &bytes, None);

        let outcome = run_read(&rt, &json!({"id": artifact.id})).await;
        assert!(outcome.is_error);
        assert!(outcome.content.contains("16 MB"));
        assert!(outcome.content.contains("painel de artefatos"));
    }

    #[tokio::test]
    async fn reads_real_office_and_pdf_fixtures_through_extraction() {
        let temp = TempDir::new();
        let rt = runtime(&temp);

        let cases: Vec<(&str, &[u8], &str)> = vec![
            ("relatorio-trimestral.docx", DOCX, "Relatório Trimestral"),
            ("vendas-q3.xlsx", XLSX, "Setembro"),
            ("apresentacao-q3.pptx", PPTX, "Resultados Q3 2026"),
            ("contrato-servicos.pdf", PDF, "Aurora Analytics"),
        ];
        for (name, bytes, expected) in cases {
            let artifact = write_artifact(&rt, name, bytes, None);
            let outcome = run_read(&rt, &json!({"id": artifact.id})).await;
            assert!(!outcome.is_error, "`{name}`: {}", outcome.content);
            assert!(
                outcome.content.contains(expected),
                "texto extraído de `{name}` não contém `{expected}`: {}",
                &outcome.content[..outcome.content.len().min(400)]
            );
            assert!(
                outcome
                    .summary
                    .as_deref()
                    .unwrap_or_default()
                    .contains("caracteres"),
                "summary de `{name}`: {:?}",
                outcome.summary
            );
            assert!(outcome.content.contains(&format!("Artefato: {name}")));
        }
    }

    #[tokio::test]
    async fn corrupt_office_file_is_an_informative_result_not_a_panic() {
        let temp = TempDir::new();
        let rt = runtime(&temp);
        let artifact = write_artifact(&rt, "quebrado.docx", b"isto nao e um docx", None);

        let outcome = run_read(&rt, &json!({"id": artifact.id})).await;
        assert!(!outcome.is_error, "arquivo corrompido vira mensagem informativa");
        assert!(outcome.content.contains("extrair texto"));
        assert!(outcome.content.contains("painel de artefatos"));
        assert_eq!(
            outcome.summary.as_deref(),
            Some("quebrado.docx · binário")
        );
    }

    #[tokio::test]
    async fn describes_image_archive_binary_and_media_metadata() {
        let temp = TempDir::new();
        let rt = runtime(&temp);

        let image = write_artifact(&rt, "grafico-receita.png", PNG, None);
        let outcome = run_read(&rt, &json!({"id": image.id})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("image/png"));
        assert!(outcome.content.contains("960"));
        assert!(outcome.content.contains("540"));
        assert!(outcome.summary.as_deref().unwrap_or_default().ends_with("binário"));

        let archive = write_artifact(&rt, "pacote-projeto.zip", ZIPPED, None);
        let outcome = run_read(&rt, &json!({"id": archive.id})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("zip"));
        assert!(outcome.content.contains("4 entrada(s)"));
        assert!(outcome.content.contains("pacote-projeto/LEIAME.md"));

        let binary = write_artifact(&rt, "dados.bin", b"\x00\x01\x02nao textual", None);
        let outcome = run_read(&rt, &json!({"id": binary.id})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("Formato detectado"));
        assert!(outcome.content.contains("application/octet-stream"));
        assert_eq!(outcome.summary.as_deref(), Some("dados.bin · binário"));

        let audio = write_artifact(&rt, "trilha.mp3", b"ID3 fake audio", None);
        let outcome = run_read(&rt, &json!({"id": audio.id})).await;
        assert!(!outcome.is_error, "{}", outcome.content);
        assert!(outcome.content.contains("áudio"));
        assert!(outcome.content.contains("não tem transcrição"));
        assert_eq!(outcome.summary.as_deref(), Some("trilha.mp3 · binário"));
    }

    #[tokio::test]
    async fn summaries_use_pt_br_singular_and_plural() {
        let temp = TempDir::new();
        let rt = runtime(&temp);

        // 1 artefato de 1 byte e 1 caractere: singular nos três textos.
        let single = write_artifact(&rt, "um.md", b"x", None);
        let outcome = run_list(&rt, &json!({})).await;
        assert_eq!(outcome.summary.as_deref(), Some("1 artefato"));
        let outcome = run_read(&rt, &json!({"id": single.id})).await;
        assert!(
            outcome.content.contains("Tipo: markdown · 1 byte"),
            "cabeçalho deve usar `1 byte`: {}",
            outcome.content
        );
        assert_eq!(outcome.summary.as_deref(), Some("um.md · 1 caractere"));

        // Plural com 2 artefatos e 2 caracteres.
        write_artifact(&rt, "dois.txt", b"ab", None);
        let outcome = run_list(&rt, &json!({})).await;
        assert_eq!(outcome.summary.as_deref(), Some("2 artefatos"));
        let dois = rt
            .db
            .list_artifacts("conv-1")
            .expect("listar")
            .into_iter()
            .find(|artifact| artifact.name == "dois.txt")
            .expect("dois.txt");
        let outcome = run_read(&rt, &json!({"id": dois.id})).await;
        assert_eq!(outcome.summary.as_deref(), Some("dois.txt · 2 caracteres"));
        assert!(outcome.content.contains("2 bytes"));

        // Corte por `limit` mantém o formato "{returned} de {total} artefatos".
        assert_eq!(list_summary(1, 3), "1 de 3 artefatos");
        assert_eq!(list_summary(2, 3), "2 de 3 artefatos");
        assert_eq!(list_summary(1, 1), "1 artefato");
        assert_eq!(list_summary(0, 0), "nenhum artefato");
    }
}
