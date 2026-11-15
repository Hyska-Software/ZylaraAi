//! Conversation CRUD commands (implemented by the storage module).

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::config;
use crate::domain::{
    Conversation, ConversationDetail, MessageRole, MessageStatus, PermissionMode, Settings,
    ToolCallStatus,
};
use crate::state::AppState;

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/// Resolves provider/model picking sane catalog defaults when the renderer
/// does not send one (or sends a combination that is not in the catalog).
fn resolve_defaults(
    state: &AppState,
    provider_id: Option<String>,
    model_id: Option<String>,
) -> (String, String) {
    let clean = |value: Option<String>| {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let mut provider_id = clean(provider_id);
    let model_id = clean(model_id);

    if provider_id.is_none() {
        if let Some(model) = model_id.as_deref() {
            provider_id = state
                .catalog
                .find_provider_for_model(model)
                .map(|provider| provider.id.clone());
        }
    }
    if provider_id.is_none() {
        provider_id = state
            .catalog
            .providers
            .first()
            .map(|provider| provider.id.clone());
    }

    let provider = provider_id
        .as_deref()
        .and_then(|id| state.provider(id));
    let resolved_provider_id = match provider.as_ref() {
        Some(provider) => provider.id.clone(),
        None => provider_id.unwrap_or_else(|| "opencode-go".to_string()),
    };
    let model_id = match (model_id, provider.as_ref()) {
        (Some(model), Some(provider)) => {
            if provider
                .models
                .iter()
                .any(|candidate| candidate.id == model)
            {
                model
            } else {
                provider.default_model_id.clone()
            }
        }
        (Some(model), None) => model,
        (None, Some(provider)) => provider.default_model_id.clone(),
        (None, None) => "glm-5.3-flash".to_string(),
    };
    (resolved_provider_id, model_id)
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

/// Modo de permissão inicial de uma sessão nova.
///
/// O Code nasce com o padrão configurado pelo usuário (Configurações →
/// Ferramentas, `Settings::code_default_permission_mode`); o Chat ignora os
/// modos, então grava `Edit` (o default histórico da coluna) e não depende da
/// preferência do Code.
fn initial_permission_mode(mode: &str, settings: &Settings) -> PermissionMode {
    if mode == crate::domain::CONVERSATION_MODE_CODE {
        settings.code_default_permission_mode
    } else {
        PermissionMode::Edit
    }
}

#[tauri::command]
pub fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    state.db.list_conversations().map_err(to_error)
}

/// Retained subagent transcripts of a parent session (hidden from the sidebar).
#[tauri::command]
pub fn list_subagent_conversations(
    state: State<'_, AppState>,
    parent_id: String,
) -> Result<Vec<Conversation>, String> {
    state
        .db
        .list_subagent_conversations(&parent_id)
        .map_err(to_error)
}

#[tauri::command]
pub fn create_conversation(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    mode: Option<String>,
    agent_id: Option<String>,
) -> Result<Conversation, String> {
    let title = title
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| crate::i18n::t("common.defaultConversationTitle"));
    if let Some(agent_id) = agent_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if let Some(mode) = mode.as_deref().map(str::trim).filter(|mode| !mode.is_empty()) {
            if mode != crate::domain::CONVERSATION_MODE_AGENT {
                return Err(crate::i18n::t(
                    "conversations.errors.agentModeInvalid",
                ));
            }
        }
        return state
            .db
            .create_agent_conversation(&agent_id, &title)
            .map_err(to_error);
    }
    if mode.as_deref().map(str::trim) == Some(crate::domain::CONVERSATION_MODE_AGENT) {
        return Err(crate::i18n::t("conversations.errors.agentRequired"));
    }
    let (provider_id, model_id) = resolve_defaults(&state, provider_id, model_id);
    // `mode` ausente/inválido cai no layout padrão (Chat).
    let mode = crate::domain::conversation_mode_or_default(mode.as_deref());
    let settings = config::load_settings(&app);
    let permission_mode = initial_permission_mode(&mode, &settings);
    state
        .db
        .create_conversation_with_mode_and_permission(
            &title,
            &provider_id,
            &model_id,
            &mode,
            permission_mode,
        )
        .map_err(to_error)
}

#[tauri::command]
pub fn get_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ConversationDetail>, String> {
    state.db.get_conversation_detail(&id).map_err(to_error)
}

#[tauri::command]
pub fn rename_conversation(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(crate::i18n::t("conversations.errors.emptyTitle"));
    }
    state.db.rename_conversation(&id, title).map_err(to_error)
}

#[tauri::command]
pub fn delete_conversation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conversation = state.db.get_conversation(&id).map_err(to_error)?;
    if conversation.as_ref().is_some_and(|conversation| conversation.is_main) {
        return Err(crate::i18n::t("conversations.errors.mainCannotDelete"));
    }
    state.cancel_conversation(&id);
    let result = state.db.delete_conversation(&id).map_err(to_error);
    if result.is_ok() {
        state.terminals.close_conversation(&id);
        if let Some(browser) = crate::computer::browser::global() {
            browser.close(&id);
        }
        let _ = state
            .db
            .end_computer_session(&id, "stopped", crate::domain::now_ms());
        if let Some(conversation) = conversation {
            if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT
                && conversation.workspace_id.is_none()
            {
                let dir = crate::harness::agent_workspace::path(&state.data_dir, &id);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
    result
}

#[tauri::command]
pub fn set_conversation_pinned(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    state.db.set_pinned(&id, pinned).map_err(to_error)
}

#[tauri::command]
pub fn reorder_conversations(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    state.db.reorder_conversations(&ids).map_err(to_error)
}

/// Compartilha uma sessão do Chat com o layout Code (`linked = true`) ou
/// desfaz o vínculo (`linked = false`). Só sessões criadas no Chat podem ser
/// compartilhadas; o backend devolve a conversa atualizada.
///
/// Ao entrar no Code a sessão adota o modo de permissão padrão configurado pelo
/// usuário (Configurações → Ferramentas): no layout Chat os modos são ignorados,
/// então é a primeira vez que ele passa a valer.
#[tauri::command]
pub fn set_conversation_code_linked(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    linked: bool,
) -> Result<Conversation, String> {
    let conversation = state
        .db
        .set_conversation_code_linked(&id, linked)
        .map_err(to_error)?;
    if !linked {
        return Ok(conversation);
    }
    let settings = config::load_settings(&app);
    state
        .db
        .set_conversation_permission_mode(&id, settings.code_default_permission_mode)
        .map_err(to_error)?;
    state
        .db
        .get_conversation(&id)
        .map_err(to_error)?
        .ok_or_else(|| crate::i18n::t("conversations.errors.notFoundAfterCodeLink"))
}

#[tauri::command]
pub fn search_conversations(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<Conversation>, String> {
    state.db.search_conversations(&query).map_err(to_error)
}

#[tauri::command]
pub fn truncate_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    from_message_id: String,
) -> Result<(), String> {
    state
        .db
        .delete_messages_from(&conversation_id, &from_message_id)
        .map_err(to_error)
}

/* ------------------------------------------------------------------ */
/* Model change (mid-session, Code only)                               */
/* ------------------------------------------------------------------ */

/// Valida uma troca de provedor/modelo antes de persistir: normaliza os ids,
/// exige uma sessão do layout Code e confirma que o par resolve no catálogo.
///
/// O Chat mantém o modelo travado após a primeira mensagem; o layout Code —
/// nativo (`mode == "code"`) ou sessão do Chat vinculada (`codeLinked`) — pode
/// trocar a rota no meio da conversa. Uma thread de agente ainda vazia também
/// aceita a troca: o composer atualiza a persona e congela a rota atual antes
/// do primeiro turno. As respostas antigas continuam com o modelo em que foram
/// geradas (o harness faz o fallback neutro do replay).
///
/// O prefixo `MODEL_LOCKED: ` é contrato com o renderer, que o remove ao
/// mostrar a recusa em pt-BR.
pub(crate) fn validate_model_change(
    conversation: &Conversation,
    provider_id: &str,
    model_id: &str,
    provider_known: impl Fn(&str) -> bool,
    model_known: impl Fn(&str, &str) -> bool,
) -> Result<(String, String), String> {
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    if provider_id.is_empty() {
        return Err(crate::i18n::t("conversations.errors.selectProvider"));
    }
    if model_id.is_empty() {
        return Err(crate::i18n::t("conversations.errors.selectModel"));
    }
    let is_code_session =
        conversation.mode == crate::domain::CONVERSATION_MODE_CODE || conversation.code_linked;
    let is_empty_agent_thread = conversation.mode == crate::domain::CONVERSATION_MODE_AGENT
        && conversation.message_count == 0;
    if !is_code_session && !is_empty_agent_thread {
        if conversation.mode == crate::domain::CONVERSATION_MODE_AGENT {
            return Err(
                crate::i18n::t("conversations.errors.agentModelLocked"),
            );
        }
        return Err(
            crate::i18n::t("conversations.errors.chatModelLocked"),
        );
    }
    if !provider_known(provider_id) {
        return Err(crate::i18n::t_args(
            "conversations.errors.providerUnknown",
            &[("provider_id", &provider_id)],
        ));
    }
    if !model_known(provider_id, model_id) {
        return Err(crate::i18n::t_args(
            "conversations.errors.modelUnavailable",
            &[("model_id", &model_id), ("provider_id", &provider_id)],
        ));
    }
    Ok((provider_id.to_string(), model_id.to_string()))
}

/// Troca o provedor/modelo de uma sessão **do Code** no meio da conversa.
///
/// Defesa em profundidade do requisito: o renderer já só oferece a troca em
/// sessões do Code e fora de um turno ativo; o backend revalida para que a
/// regra valha também para chamadas IPC diretas. O par precisa resolver na
/// visão mesclada do catálogo (inclui os modelos que só a conta conhece).
#[tauri::command]
pub fn set_conversation_model(
    state: State<'_, AppState>,
    conversation_id: String,
    provider_id: String,
    model_id: String,
) -> Result<Conversation, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err(crate::i18n::t("conversations.errors.missingId"));
    }
    let conversation = state
        .db
        .get_conversation(conversation_id)
        .map_err(to_error)?
        .ok_or_else(|| crate::i18n::t_args(
            "conversations.errors.notFound",
            &[("conversation_id", &conversation_id)],
        ))?;
    let (provider_id, model_id) = validate_model_change(
        &conversation,
        &provider_id,
        &model_id,
        |provider_id| state.provider(provider_id).is_some(),
        |provider_id, model_id| state.model(provider_id, model_id).is_some(),
    )?;
    if state.has_active_turn_for(conversation_id) {
        return Err(crate::i18n::t("conversations.errors.waitCurrentReply"));
    }
    state
        .db
        .update_conversation_model(conversation_id, &provider_id, &model_id)
        .map_err(to_error)?;
    state
        .db
        .get_conversation(conversation_id)
        .map_err(to_error)?
        .ok_or_else(|| crate::i18n::t("conversations.errors.notFoundAfterModelUpdate"))
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

fn format_timestamp(ms: i64) -> String {
    crate::i18n::format_datetime(ms)
}

fn role_label(role: MessageRole) -> String {
    match role {
        MessageRole::User => crate::i18n::t("conversations.role.user"),
        MessageRole::Assistant => crate::i18n::t("conversations.role.assistant"),
        MessageRole::System => crate::i18n::t("conversations.role.system"),
    }
}

fn status_label(status: MessageStatus) -> String {
    match status {
        MessageStatus::Streaming => crate::i18n::t("conversations.status.streaming"),
        MessageStatus::Complete => crate::i18n::t("conversations.status.complete"),
        MessageStatus::Error => crate::i18n::t("conversations.status.error"),
        MessageStatus::Cancelled => crate::i18n::t("conversations.status.cancelled"),
        MessageStatus::Incomplete => crate::i18n::t("conversations.status.incomplete"),
    }
}

fn tool_status_label(status: ToolCallStatus) -> String {
    match status {
        ToolCallStatus::Running => crate::i18n::t("conversations.toolStatus.running"),
        ToolCallStatus::Done => crate::i18n::t("conversations.toolStatus.done"),
        ToolCallStatus::Error => crate::i18n::t("conversations.toolStatus.error"),
    }
}

/// One-line, length-capped text for tool call results in the markdown export.
fn summarize(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= limit {
        collapsed
    } else {
        let mut truncated: String = collapsed.chars().take(limit).collect();
        truncated.push('…');
        truncated
    }
}

fn export_markdown(detail: &ConversationDetail) -> String {
    let conversation = &detail.conversation;
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", conversation.title));
    out.push_str(&crate::i18n::t_args(
        "conversations.export.createdAtLine",
        &[("date", &format_timestamp(conversation.created_at))],
    ));
    out.push_str(&crate::i18n::t_args(
        "conversations.export.updatedAtLine",
        &[("date", &format_timestamp(conversation.updated_at))],
    ));
    out.push_str(&crate::i18n::t_args(
        "conversations.export.providerLine",
        &[("provider", &conversation.provider_id)],
    ));
    out.push_str(&crate::i18n::t_args(
        "conversations.export.modelLine",
        &[("model", &conversation.model_id)],
    ));
    out.push_str(&crate::i18n::t_args(
        "conversations.export.messageCountLine",
        &[("count", &conversation.message_count.to_string())],
    ));
    out.push_str("\n---\n");

    for message in &detail.messages {
        out.push_str(&crate::i18n::t_args(
            "conversations.export.messageHeading",
            &[
                ("role", &role_label(message.role)),
                ("date", &format_timestamp(message.created_at)),
            ],
        ));
        if message.status != MessageStatus::Complete {
            out.push_str(&crate::i18n::t_args(
                "conversations.export.statusLine",
                &[("status", &status_label(message.status))],
            ));
        }
        if !message.content.trim().is_empty() {
            out.push_str(message.content.trim_end());
            out.push_str("\n\n");
        }
        if let Some(reasoning) = message
            .reasoning
            .as_deref()
            .filter(|reasoning| !reasoning.trim().is_empty())
        {
            out.push_str(&crate::i18n::t(
                "conversations.export.reasoningSummary",
            ));
            out.push_str(reasoning.trim());
            out.push_str("\n\n</details>\n\n");
        }
        if !message.attachments.is_empty() {
            out.push_str(&crate::i18n::t("conversations.export.attachmentsHeader"));
            for attachment in &message.attachments {
                out.push_str(&crate::i18n::t_args(
                    "conversations.export.attachmentItem",
                    &[
                        ("name", &attachment.name),
                        ("kind", &attachment.kind),
                        ("size", &attachment.size.to_string()),
                    ],
                ));
            }
            out.push('\n');
        }
        if !message.tool_calls.is_empty() {
            out.push_str(&crate::i18n::t("conversations.export.toolsHeader"));
            for call in &message.tool_calls {
                let mut line = format!("- `{}` ({})", call.name, tool_status_label(call.status));
                if let Some(summary) = call
                    .summary
                    .as_deref()
                    .map(|summary| summarize(summary, 160))
                    .filter(|summary| !summary.is_empty())
                {
                    line.push_str(&format!(" — {summary}"));
                } else if let Some(result) = call
                    .result
                    .as_deref()
                    .map(|result| summarize(result, 160))
                    .filter(|result| !result.is_empty())
                {
                    line.push_str(&format!(" — {result}"));
                }
                out.push_str(&line);
                out.push('\n');
            }
            out.push('\n');
        }
        if !message.citations.is_empty() {
            out.push_str(&crate::i18n::t("conversations.export.citationsHeader"));
            for citation in &message.citations {
                out.push_str(&format!("- [{}]({})\n", citation.title, citation.url));
            }
            out.push('\n');
        }
        if let Some(usage) = &message.usage {
            let mut parts: Vec<String> = Vec::new();
            if let Some(value) = usage.input_tokens {
                parts.push(crate::i18n::t_args(
                    "conversations.export.usage.input",
                    &[("value", &value.to_string())],
                ));
            }
            if let Some(value) = usage.output_tokens {
                parts.push(crate::i18n::t_args(
                    "conversations.export.usage.output",
                    &[("value", &value.to_string())],
                ));
            }
            if let Some(value) = usage.reasoning_tokens {
                parts.push(crate::i18n::t_args(
                    "conversations.export.usage.reasoning",
                    &[("value", &value.to_string())],
                ));
            }
            if !parts.is_empty() {
                out.push_str(&crate::i18n::t_args(
                    "conversations.export.tokenUsage",
                    &[("parts", &parts.join(", "))],
                ));
            }
        }
        out.push_str("---\n");
    }

    out.push_str(&crate::i18n::t_args(
        "conversations.export.footer",
        &[
            ("version", env!("CARGO_PKG_VERSION")),
            ("date", &format_timestamp(crate::domain::now_ms())),
        ],
    ));
    out
}

/// Turns a conversation title into a safe file stem.
fn file_stem(title: &str) -> String {
    let mut stem = String::new();
    let mut last_was_separator = false;
    for character in title.trim().chars() {
        if character.is_alphanumeric() {
            stem.push(character);
            last_was_separator = false;
        } else if !last_was_separator && !stem.is_empty() {
            stem.push('-');
            last_was_separator = true;
        }
    }
    let stem = stem.trim_matches('-');
    let stem: String = stem.chars().take(60).collect();
    if stem.is_empty() {
        "conversa-zylara".to_string()
    } else {
        stem
    }
}

#[tauri::command]
pub fn export_conversation(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    format: String,
) -> Result<Option<String>, String> {
    let detail = state
        .db
        .get_conversation_detail(&id)
        .map_err(to_error)?
        .ok_or_else(|| crate::i18n::t_args("conversations.errors.notFound", &[("conversation_id", &id)]))?;

    let format = format.trim().to_lowercase();
    let (contents, extension, filter_name) = match format.as_str() {
        "markdown" | "md" => (export_markdown(&detail), "md", "Markdown"),
        "json" => (
            serde_json::to_string_pretty(&detail).map_err(to_error)?,
            "json",
            "JSON",
        ),
        other => {
            return Err(crate::i18n::t_args(
                "conversations.errors.unsupportedExportFormat",
                &[("format", other)],
            ))
        }
    };

    let file_name = format!("{}.{extension}", file_stem(&detail.conversation.title));
    let selected = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter(filter_name, &[extension])
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| crate::i18n::t_args(
            "conversations.errors.invalidDestination",
            &[("error", &error.to_string())],
        ))?;
    std::fs::write(&path, contents)
        .map_err(|error| crate::i18n::t_args(
            "conversations.errors.writeFailed",
            &[("path", &path.display().to_string()), ("error", &error.to_string())],
        ))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Citation, UsageInfo};

    fn sample_detail() -> ConversationDetail {
        let mut user = crate::domain::ChatMessage::user("conv-1", "Qual é a receita?");
        user.created_at = 1_700_000_000_000;
        let mut assistant = crate::domain::ChatMessage::assistant("conv-1");
        assistant.created_at = 1_700_000_001_000;
        assistant.content = "Misture tudo e asse.".to_string();
        assistant.status = MessageStatus::Complete;
        assistant.reasoning = Some("O usuário quer uma receita simples.".to_string());
        assistant.tool_calls = vec![crate::domain::ToolCallRecord {
            id: "call-1".to_string(),
            name: "web_search".to_string(),
            arguments: "{}".to_string(),
            result: Some("resultado longo da busca".to_string()),
            status: ToolCallStatus::Done,
            summary: Some("Busca concluída".to_string()),
            started_at: None,
            finished_at: None,
            presentation: None,
            images: Vec::new(),
        }];
        assistant.citations = vec![Citation {
            id: "cit-1".to_string(),
            title: "Receita simples".to_string(),
            url: "https://example.com/receita".to_string(),
            snippet: None,
            site_name: None,
        }];
        assistant.usage = Some(UsageInfo {
            input_tokens: Some(10),
            output_tokens: Some(20),
            ..UsageInfo::default()
        });

        ConversationDetail {
            conversation: Conversation {
                id: "conv-1".to_string(),
                title: "Receita de bolo".to_string(),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_002_000,
                pinned: false,
                sort_order: 0,
                provider_id: "opencode-go".to_string(),
                model_id: "glm-5.3-flash".to_string(),
                message_count: 2,
                preview: None,
                mode: "chat".to_string(),
                code_linked: false,
                workspace_id: None,
                agent_kind: "zylara".to_string(),
                permission_mode: crate::domain::PermissionMode::Edit,
                parent_conversation_id: None,
                subagent_task_call_id: None,
                subagent_type: None,
                agent_id: None,
                channel_id: None,
                task_id: None,
                is_main: false,
            },
            messages: vec![user, assistant],
        }
    }

    #[test]
    fn new_code_sessions_start_with_the_configured_permission_mode() {
        let mut settings = Settings::default();
        assert_eq!(
            initial_permission_mode(crate::domain::CONVERSATION_MODE_CODE, &settings),
            PermissionMode::Autonomous,
            "padrão de fábrica das novas sessões do Code é Autônomo"
        );

        settings.code_default_permission_mode = PermissionMode::Review;
        assert_eq!(
            initial_permission_mode(crate::domain::CONVERSATION_MODE_CODE, &settings),
            PermissionMode::Review
        );

        // O Chat ignora os modos e mantém o valor histórico da coluna.
        assert_eq!(
            initial_permission_mode(crate::domain::CONVERSATION_MODE_CHAT, &settings),
            PermissionMode::Edit
        );
        assert_eq!(
            initial_permission_mode("", &settings),
            PermissionMode::Edit,
            "modo ausente cai no layout Chat"
        );
    }

    #[test]
    fn markdown_export_includes_messages_reasoning_tools_and_citations() {
        let markdown = export_markdown(&sample_detail());
        assert!(markdown.starts_with("# Receita de bolo\n"));
        assert!(markdown.contains("## Usuário"));
        assert!(markdown.contains("## Assistente"));
        assert!(markdown.contains("Qual é a receita?"));
        assert!(markdown.contains("<summary>Raciocínio</summary>"));
        assert!(markdown.contains("Misture tudo e asse."));
        assert!(markdown.contains("**Ferramentas:**"));
        assert!(markdown.contains("`web_search` (concluída) — Busca concluída"));
        assert!(markdown.contains("**Citações:**"));
        assert!(markdown.contains("[Receita simples](https://example.com/receita)"));
        assert!(markdown.contains("Uso de tokens: entrada 10, saída 20"));
        assert!(markdown.contains("_Exportado por Zylara "));
    }

    #[test]
    fn file_stem_is_safe_and_bounded() {
        assert_eq!(file_stem("Receita de bolo"), "Receita-de-bolo");
        assert_eq!(file_stem("  ...  "), "conversa-zylara");
        assert_eq!(file_stem("a/b\\c:d*e?f"), "a-b-c-d-e-f");
        let long = file_stem(&"x".repeat(200));
        assert_eq!(long.chars().count(), 60);
        assert_eq!(file_stem("Café com pão"), "Café-com-pão");
    }

    #[test]
    fn summarize_collapses_whitespace_and_caps_length() {
        assert_eq!(summarize("  a\n\n b\t c ", 20), "a b c");
        let long = summarize(&"y".repeat(50), 10);
        assert!(long.ends_with('…'));
        assert_eq!(long.chars().count(), 11);
    }

    fn sample_conversation(mode: &str, code_linked: bool) -> Conversation {
        let mut conversation = sample_detail().conversation;
        conversation.mode = mode.to_string();
        conversation.code_linked = code_linked;
        conversation
    }

    #[test]
    fn model_change_is_locked_for_native_chat_sessions() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CHAT, false);
        let error =
            validate_model_change(&conversation, "openai", "gpt-6-luna", |_| true, |_, _| true)
                .expect_err("Chat nativa não troca de modelo");
        assert!(
            error.starts_with("MODEL_LOCKED: "),
            "o renderer remove esse prefixo: {error}"
        );
        assert!(
            error.contains("Code"),
            "a recusa deve indicar o Code: {error}"
        );
    }

    #[test]
    fn model_change_is_locked_for_chat_before_touching_the_catalog() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CHAT, false);
        let error = validate_model_change(
            &conversation,
            "openai",
            "gpt-6-luna",
            |_| panic!("o catálogo não deve ser consultado antes da regra de layout"),
            |_, _| panic!("o catálogo não deve ser consultado antes da regra de layout"),
        )
        .expect_err("Chat nativa não troca de modelo");
        assert!(error.starts_with("MODEL_LOCKED: "), "{error}");
    }

    #[test]
    fn model_change_is_allowed_for_code_sessions() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CODE, false);
        let changed =
            validate_model_change(&conversation, "openai", "gpt-6-luna", |_| true, |_, _| true)
                .expect("sessão nativa do Code troca de modelo");
        assert_eq!(changed, ("openai".to_string(), "gpt-6-luna".to_string()));
    }

    #[test]
    fn model_change_is_allowed_for_code_linked_chat_sessions() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CHAT, true);
        let changed = validate_model_change(
            &conversation,
            "anthropic",
            "claude-opus-5-5",
            |provider_id| provider_id == "anthropic",
            |provider_id, model_id| provider_id == "anthropic" && model_id == "claude-opus-5-5",
        )
        .expect("sessão do Chat vinculada ao Code troca de modelo");
        assert_eq!(
            changed,
            ("anthropic".to_string(), "claude-opus-5-5".to_string())
        );
    }

    #[test]
    fn model_change_is_allowed_for_empty_agent_threads() {
        let mut conversation =
            sample_conversation(crate::domain::CONVERSATION_MODE_AGENT, false);
        conversation.message_count = 0;
        let changed =
            validate_model_change(&conversation, "openai", "gpt-6-luna", |_| true, |_, _| true)
                .expect("thread de agente ainda vazia aceita a rota escolhida no composer");
        assert_eq!(changed, ("openai".to_string(), "gpt-6-luna".to_string()));
    }

    #[test]
    fn model_change_is_locked_for_started_agent_threads() {
        let mut conversation =
            sample_conversation(crate::domain::CONVERSATION_MODE_AGENT, false);
        conversation.message_count = 2;
        let error =
            validate_model_change(&conversation, "openai", "gpt-6-luna", |_| true, |_, _| true)
                .expect_err("thread de agente iniciada não troca de modelo");
        assert!(error.starts_with("MODEL_LOCKED: "), "{error}");
        assert!(error.contains("agente"), "{error}");
    }

    #[test]
    fn model_change_trims_the_ids_before_looking_them_up() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CODE, false);
        let changed = validate_model_change(
            &conversation,
            "  openai  ",
            "  gpt-6-luna  ",
            |provider_id| provider_id == "openai",
            |provider_id, model_id| provider_id == "openai" && model_id == "gpt-6-luna",
        )
        .expect("ids com espaços nas pontas");
        assert_eq!(changed, ("openai".to_string(), "gpt-6-luna".to_string()));
    }

    #[test]
    fn model_change_rejects_blank_ids() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CODE, false);
        let provider_error =
            validate_model_change(&conversation, "   ", "gpt-6-luna", |_| true, |_, _| true)
                .expect_err("provedor vazio");
        assert!(provider_error.contains("provedor"), "{provider_error}");
        assert!(
            !provider_error.starts_with("MODEL_LOCKED"),
            "{provider_error}"
        );

        let model_error =
            validate_model_change(&conversation, "openai", "\t", |_| true, |_, _| true)
                .expect_err("modelo vazio");
        assert!(model_error.contains("modelo"), "{model_error}");
        assert!(!model_error.starts_with("MODEL_LOCKED"), "{model_error}");
    }

    #[test]
    fn model_change_rejects_unknown_provider_and_model() {
        let conversation = sample_conversation(crate::domain::CONVERSATION_MODE_CODE, false);
        let provider_error =
            validate_model_change(&conversation, "nope", "x", |_| false, |_, _| true)
                .expect_err("provedor desconhecido");
        assert_eq!(provider_error, "provedor desconhecido: nope");

        let model_error = validate_model_change(
            &conversation,
            "openai",
            "gpt-inexistente",
            |_| true,
            |_, _| false,
        )
        .expect_err("modelo desconhecido");
        assert_eq!(
            model_error,
            "modelo `gpt-inexistente` não está disponível no provedor `openai`"
        );
    }
}
