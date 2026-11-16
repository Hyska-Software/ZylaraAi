//! Projeções da sessão de código sobre `code_events` (log append-only).
//!
//! `messages` continua sendo a fonte da história do modelo; `code_events` é a
//! fonte dos fatos da UI: permissões, plano, tarefas, contexto, aprovações,
//! alterações e reversões (`docs/goals/code-harness/HARNESS.md` §11).
//!
//! **Projeção única** (`PLAN.md` D9): `commands::code` e o harness delegam para
//! as funções deste módulo; nenhuma tela recalcula o estado do plano/tarefas.
//! O plano é um fold de `plan/mode → plan/submitted → plan/feedback →
//! plan/approved → turn/ended`, e `updated_at` vem sempre do evento que define
//! o estado.

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::db::{Db, StoredCodeEvent};
use crate::domain::{ContextBreakdown, ContextStats, PlanState, PlanView, TodoItem, TodoStatus};

pub const KIND_APPROVAL_DECIDED: &str = "approval/decided";
pub const KIND_PERMISSION_MODE: &str = "permission/mode";
pub const KIND_PLAN_MODE: &str = "plan/mode";
pub const KIND_CREATOR_MODE: &str = "creator/mode";
pub const KIND_PLAN_SUBMITTED: &str = "plan/submitted";
pub const KIND_PLAN_FEEDBACK: &str = "plan/feedback";
pub const KIND_PLAN_APPROVED: &str = "plan/approved";
pub const KIND_TODOS: &str = "todos";
pub const KIND_CONTEXT_STATS: &str = "context/stats";
pub const KIND_CONTEXT_COMPACTED: &str = "context/compacted";
pub const KIND_REVERT: &str = "revert/performed";
pub const KIND_TURN_ENDED: &str = "turn/ended";

/// Feedback sintético quando uma revisão ficou órfã (aprovação expirou ou o
/// turno terminou sem decisão): o card volta para planejamento com instrução.
pub fn stale_review_feedback() -> String {
    crate::i18n::t("code.session.reviewInactive")
}

/// Grava um evento da sessão (JSON serializado).
pub fn append(
    db: &Db,
    conversation_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    payload: &Value,
) -> anyhow::Result<()> {
    db.append_code_event(conversation_id, turn_id, kind, &payload.to_string())?;
    Ok(())
}

/// Último evento de um `kind` (com `seq`/`created_at` — o fold do plano precisa
/// dos dois para ordenar e para o `updated_at` estável).
pub fn latest_event(
    db: &Db,
    conversation_id: &str,
    kind: &str,
) -> anyhow::Result<Option<StoredCodeEvent>> {
    db.latest_code_event(conversation_id, kind)
}

fn decode<T: DeserializeOwned>(event: &StoredCodeEvent) -> Option<T> {
    serde_json::from_str::<T>(&event.payload).ok()
}

fn latest<T: DeserializeOwned>(
    db: &Db,
    conversation_id: &str,
    kind: &str,
) -> anyhow::Result<Option<T>> {
    Ok(latest_event(db, conversation_id, kind)?.and_then(|event| decode::<T>(&event)))
}

#[derive(Debug, serde::Deserialize)]
struct ModePayload {
    #[serde(default)]
    active: bool,
}

#[derive(Debug, serde::Deserialize)]
struct SubmittedPayload {
    #[serde(default)]
    markdown: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct FeedbackPayload {
    #[serde(default)]
    feedback: String,
}

#[derive(Debug, serde::Deserialize)]
struct ApprovedPayload {
    #[serde(default)]
    markdown: Option<String>,
    /// Registrado no log da sessão (`plan/approved {reviewEachEdit}`) para
    /// auditoria; o modo efetivo já vai em `permission/mode`/conversa.
    #[serde(default, rename = "reviewEachEdit")]
    #[allow(dead_code)]
    review_each_edit: bool,
}

#[derive(Debug, serde::Deserialize)]
struct TodosPayload {
    #[serde(default)]
    items: Vec<TodoItem>,
}

#[derive(Debug, serde::Deserialize)]
struct CompactedPayload {
    #[serde(default)]
    messages: u32,
}

/// Modo Plano está ativo nesta sessão? (leitura viva; usada pela política e
/// pelo harness a cada passo).
pub fn plan_mode_active(db: &Db, conversation_id: &str) -> anyhow::Result<bool> {
    Ok(latest::<ModePayload>(db, conversation_id, KIND_PLAN_MODE)?
        .map(|payload| payload.active)
        .unwrap_or(false))
}

/// Liga/desliga o modo Plano (append-only; último evento vence).
pub fn set_plan_mode(db: &Db, conversation_id: &str, active: bool) -> anyhow::Result<()> {
    append(
        db,
        conversation_id,
        None,
        KIND_PLAN_MODE,
        &serde_json::json!({ "active": active }),
    )
}

/// Modo Plugin Creator ativo nesta sessão? É um modo persistente da sessão,
/// independente do modo Plano: injeta o workflow de plugin e libera a tool
/// `validate_plugin`, mas nunca ativa plugins automaticamente.
pub fn creator_mode_active(db: &Db, conversation_id: &str) -> anyhow::Result<bool> {
    Ok(latest::<ModePayload>(db, conversation_id, KIND_CREATOR_MODE)?
        .map(|payload| payload.active)
        .unwrap_or(false))
}

/// Liga/desliga o modo Plugin Creator (append-only; último evento vence).
pub fn set_creator_mode(db: &Db, conversation_id: &str, active: bool) -> anyhow::Result<()> {
    append(
        db,
        conversation_id,
        None,
        KIND_CREATOR_MODE,
        &serde_json::json!({ "active": active }),
    )
}

fn markdown_of(event: Option<&StoredCodeEvent>) -> Option<String> {
    event
        .and_then(|event| decode::<SubmittedPayload>(event))
        .and_then(|payload| payload.markdown)
}

fn feedback_of(event: Option<&StoredCodeEvent>) -> Option<String> {
    event
        .and_then(|event| decode::<FeedbackPayload>(event))
        .map(|payload| payload.feedback)
        .filter(|feedback| !feedback.trim().is_empty())
}

/// Estado do plano: em planejamento, aguardando revisão ou aprovado.
///
/// Fold por `seq` (HARNESS §11.2 / PLAN.md D4):
/// - modo ativo: a ativação abre um ciclo novo (`Planning`); dentro do ciclo, o
///   último entre `submitted`/`feedback`/`approved` decide o estado;
/// - `turn/ended` depois de um `submitted` sem decisão degrada a revisão para
///   `Planning` com feedback sintético (a aprovação não existe mais);
/// - modo inativo: um `approved` mantém o plano aprovado; sem aprovação, o
///   `submitted` fica em revisão até o fim do turno.
pub fn plan_view(db: &Db, conversation_id: &str) -> anyhow::Result<Option<PlanView>> {
    let mode = latest_event(db, conversation_id, KIND_PLAN_MODE)?;
    let submitted = latest_event(db, conversation_id, KIND_PLAN_SUBMITTED)?;
    let feedback = latest_event(db, conversation_id, KIND_PLAN_FEEDBACK)?;
    let approved = latest_event(db, conversation_id, KIND_PLAN_APPROVED)?;
    let turn_ended = latest_event(db, conversation_id, KIND_TURN_ENDED)?;

    let mode_active = mode
        .as_ref()
        .and_then(|event| decode::<ModePayload>(event))
        .map(|payload| payload.active)
        .unwrap_or(false);

    if mode_active {
        let mode_seq = mode.as_ref().map(|event| event.seq).unwrap_or(0);
        let cycle_submitted = submitted.as_ref().filter(|event| event.seq > mode_seq);
        let cycle_feedback = feedback.as_ref().filter(|event| event.seq > mode_seq);
        let cycle_approved = approved.as_ref().filter(|event| event.seq > mode_seq);

        // Aprovado dentro do ciclo corrente (defensivo; o approve desliga o modo).
        if let Some(approved_event) = cycle_approved {
            let submitted_before = cycle_submitted
                .map(|event| approved_event.seq > event.seq)
                .unwrap_or(true);
            let feedback_before = cycle_feedback
                .map(|event| approved_event.seq > event.seq)
                .unwrap_or(true);
            if submitted_before && feedback_before {
                let payload = decode::<ApprovedPayload>(approved_event);
                return Ok(Some(PlanView {
                    state: PlanState::Approved,
                    markdown: payload
                        .as_ref()
                        .and_then(|payload| payload.markdown.clone())
                        .or_else(|| markdown_of(cycle_submitted)),
                    feedback: None,
                    updated_at: approved_event.created_at,
                }));
            }
        }

        // "Continuar planejando": volta para Planning com o draft + feedback.
        if let Some(feedback_event) = cycle_feedback {
            let newer_than_submitted = cycle_submitted
                .map(|event| feedback_event.seq > event.seq)
                .unwrap_or(true);
            if newer_than_submitted {
                return Ok(Some(PlanView {
                    state: PlanState::Planning,
                    markdown: markdown_of(cycle_submitted),
                    feedback: feedback_of(Some(feedback_event)),
                    updated_at: feedback_event.created_at,
                }));
            }
        }

        if let Some(submitted_event) = cycle_submitted {
            // Turno terminou sem decisão: a revisão morreu, o agente volta a planejar.
            let stale = turn_ended
                .as_ref()
                .map(|event| event.seq > submitted_event.seq)
                .unwrap_or(false);
            if stale {
                return Ok(Some(PlanView {
                    state: PlanState::Planning,
                    markdown: markdown_of(Some(submitted_event)),
                    feedback: Some(stale_review_feedback()),
                    updated_at: turn_ended
                        .as_ref()
                        .map(|event| event.created_at)
                        .unwrap_or(submitted_event.created_at),
                }));
            }
            // Feedback anterior (de um plano rejeitado) contextualiza a revisão.
            let prior_feedback = cycle_feedback
                .filter(|event| event.seq < submitted_event.seq)
                .and_then(|event| feedback_of(Some(event)));
            return Ok(Some(PlanView {
                state: PlanState::Reviewing,
                markdown: markdown_of(Some(submitted_event)),
                feedback: prior_feedback,
                updated_at: submitted_event.created_at,
            }));
        }

        // Modo ativo sem plano neste ciclo: estado "planejando" do chip.
        return Ok(Some(PlanView {
            state: PlanState::Planning,
            markdown: None,
            feedback: None,
            updated_at: mode.as_ref().map(|event| event.created_at).unwrap_or(0),
        }));
    }

    // Modo inativo: plano aprovado continua acessível (popover do chip).
    if let Some(approved_event) = approved {
        let approved_after_submitted = submitted
            .as_ref()
            .map(|event| approved_event.seq > event.seq)
            .unwrap_or(true);
        if approved_after_submitted {
            let payload = decode::<ApprovedPayload>(&approved_event);
            return Ok(Some(PlanView {
                state: PlanState::Approved,
                markdown: payload
                    .as_ref()
                    .and_then(|payload| payload.markdown.clone())
                    .or_else(|| markdown_of(submitted.as_ref())),
                feedback: None,
                updated_at: approved_event.created_at,
            }));
        }
    }

    if let Some(submitted_event) = submitted {
        let stale = turn_ended
            .as_ref()
            .map(|event| event.seq > submitted_event.seq)
            .unwrap_or(false);
        if stale {
            return Ok(Some(PlanView {
                state: PlanState::Planning,
                markdown: markdown_of(Some(&submitted_event)),
                feedback: Some(stale_review_feedback()),
                updated_at: turn_ended
                    .as_ref()
                    .map(|event| event.created_at)
                    .unwrap_or(submitted_event.created_at),
            }));
        }
        let prior_feedback = feedback
            .as_ref()
            .filter(|event| event.seq < submitted_event.seq)
            .and_then(|event| feedback_of(Some(event)));
        return Ok(Some(PlanView {
            state: PlanState::Reviewing,
            markdown: markdown_of(Some(&submitted_event)),
            feedback: prior_feedback,
            updated_at: submitted_event.created_at,
        }));
    }

    Ok(None)
}

/// Registra o plano submetido para revisão (persistido **antes** da aprovação
/// interativa, para o draft sobreviver a negação/crash — `TOOLS.md` §2.5).
pub fn submit_plan(
    db: &Db,
    conversation_id: &str,
    turn_id: &str,
    markdown: &str,
) -> anyhow::Result<()> {
    append(
        db,
        conversation_id,
        Some(turn_id),
        KIND_PLAN_SUBMITTED,
        &serde_json::json!({ "markdown": markdown }),
    )
}

/// Persiste o feedback do "Continuar planejando" (volta o estado para Planning).
pub fn plan_feedback(
    db: &Db,
    conversation_id: &str,
    turn_id: &str,
    feedback: &str,
) -> anyhow::Result<()> {
    append(
        db,
        conversation_id,
        Some(turn_id),
        KIND_PLAN_FEEDBACK,
        &serde_json::json!({ "feedback": feedback }),
    )
}

/// Marca o plano como aprovado (a sessão sai do modo Plano). `markdown` é o
/// texto revisado pelo usuário, quando houver; `review_each_edit` registra se
/// as escritas seguintes pedem aprovação (modo Revisar efetivo, seja por
/// `approve_review` ou porque a sessão já estava em Revisar).
pub fn approve_plan(
    db: &Db,
    conversation_id: &str,
    turn_id: &str,
    markdown: Option<&str>,
    review_each_edit: bool,
) -> anyhow::Result<()> {
    let mut payload = serde_json::json!({ "reviewEachEdit": review_each_edit });
    if let Some(markdown) = markdown.filter(|markdown| !markdown.trim().is_empty()) {
        payload["markdown"] = Value::String(markdown.to_string());
    }
    append(
        db,
        conversation_id,
        Some(turn_id),
        KIND_PLAN_APPROVED,
        &payload,
    )?;
    set_plan_mode(db, conversation_id, false)
}

/// Lista de tarefas atual do agente.
pub fn todos(db: &Db, conversation_id: &str) -> anyhow::Result<Vec<TodoItem>> {
    Ok(latest::<TodosPayload>(db, conversation_id, KIND_TODOS)?
        .map(|payload| payload.items)
        .unwrap_or_default())
}

/// Substitui a lista inteira de tarefas (e emite para a UI pelo chamador).
pub fn save_todos(
    db: &Db,
    conversation_id: &str,
    turn_id: &str,
    items: &[TodoItem],
) -> anyhow::Result<()> {
    append(
        db,
        conversation_id,
        Some(turn_id),
        KIND_TODOS,
        &serde_json::json!({ "items": items }),
    )
}

/// Valida a lista de tarefas: até 50 itens, descrições não vazias/duplicadas e
/// no máximo **um** `in_progress` (`TOOLS.md` §2.5). Lista vazia é válida: é o
/// "limpar" do `todo_write`.
pub fn validate_todos(items: &[TodoItem]) -> Result<(), String> {
    if items.len() > 50 {
        return Err(crate::i18n::t("code.session.todoMaxItems").to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let content = item.content.trim();
        if content.is_empty() {
            return Err(crate::i18n::t("code.session.todoDescriptionRequired").to_string());
        }
        if !seen.insert(content.to_lowercase()) {
            return Err(format!("tarefa duplicada: `{content}`"));
        }
    }
    let in_progress = items
        .iter()
        .filter(|item| item.status == TodoStatus::InProgress)
        .count();
    if in_progress > 1 {
        return Err(crate::i18n::t("code.session.todoSingleInProgress").to_string());
    }
    Ok(())
}

/// Uso de contexto mais recente registrado pela sessão.
pub fn context_stats(db: &Db, conversation_id: &str) -> Option<ContextStats> {
    latest::<ContextStats>(db, conversation_id, KIND_CONTEXT_STATS)
        .ok()
        .flatten()
}

/// Quantas mensagens já foram cobertas por compactações (`to_seq` do último
/// resumo). O evento `context/compacted` é o fold canônico — não reciclar
/// `context/stats` (um payload parcial envenenava a projeção do medidor).
pub fn compacted_messages(db: &Db, conversation_id: &str) -> u32 {
    latest::<CompactedPayload>(db, conversation_id, KIND_CONTEXT_COMPACTED)
        .ok()
        .flatten()
        .map(|payload| payload.messages)
        .unwrap_or(0)
}

/// Persiste o uso de contexto do passo (chamado no fim de cada passo).
pub fn save_context_stats(
    db: &Db,
    conversation_id: &str,
    turn_id: &str,
    stats: &ContextStats,
) -> anyhow::Result<()> {
    append(
        db,
        conversation_id,
        Some(turn_id),
        KIND_CONTEXT_STATS,
        &serde_json::to_value(stats)?,
    )
}

/// Resumo das alterações de um turno (journal) para o evento `WorkspaceChanges`.
///
/// O journal grava uma linha por escrita/edição, então o mesmo path pode
/// aparecer várias vezes no turno. O resumo é **por arquivo** — o card de fecho
/// ("N arquivos alterados") e o total `+N −M` contariam o mesmo arquivo duas
/// vezes —, somando os contadores das edições e mantendo o `kind` da última.
pub fn turn_changes(
    db: &Db,
    conversation_id: &str,
    turn_id: &str,
) -> Option<crate::domain::ChangesSummary> {
    let entries = db
        .list_file_journal_for_turn(conversation_id, turn_id)
        .ok()?;
    if entries.is_empty() {
        return None;
    }
    let mut files: std::collections::BTreeMap<String, crate::domain::FileChangeSummary> =
        std::collections::BTreeMap::new();
    for entry in entries {
        let kind = entry.change_kind;
        let added = entry.added.unwrap_or(0);
        let removed = entry.removed.unwrap_or(0);
        files
            .entry(entry.path.clone())
            .and_modify(|file| {
                file.kind = kind;
                file.added = file.added.saturating_add(added);
                file.removed = file.removed.saturating_add(removed);
            })
            .or_insert(crate::domain::FileChangeSummary {
                path: entry.path,
                kind,
                added,
                removed,
                origin: Some("session".to_string()),
                staged: false,
            });
    }
    let files: Vec<crate::domain::FileChangeSummary> = files.into_values().collect();
    Some(crate::domain::ChangesSummary {
        turn_id: Some(turn_id.to_string()),
        added: files.iter().map(|file| file.added).sum(),
        removed: files.iter().map(|file| file.removed).sum(),
        files,
    })
}

/// Estimativa de tokens do contexto do turno (heurística `chars/4` + overhead)
/// com **breakdown** para o medidor do header (`HARNESS.md` §10.1).
///
/// - `system_prompt_chars`: system prompt efetivo do request (inclui notas);
/// - `history_chars`: texto + reasoning + argumentos das tool calls do histórico;
/// - `tool_definition_chars`: nome + descrição + JSON Schema das tools no wire;
/// - `messages`: contagem de mensagens (overhead de 8 tokens por mensagem);
/// - `tool_calls`: contagem de tool calls declaradas (16 tokens por call);
/// - `compacted`: mensagens já resumidas (informativo, vem da projeção).
///
/// A soma do breakdown é sempre `used`. Não é um tokenizer exato: a UI mostra
/// "≈" e o uso real do provider calibra em [`calibrate_context`].
#[allow(clippy::too_many_arguments)]
pub fn estimate_context(
    system_prompt_chars: usize,
    history_chars: usize,
    tool_definition_chars: usize,
    window: u32,
    output_cap: u32,
    messages: u32,
    tool_calls: u32,
    compacted: u32,
) -> ContextStats {
    let system_prompt = u32::try_from(system_prompt_chars / 4).unwrap_or(u32::MAX);
    let tool_definitions = u32::try_from(tool_definition_chars / 4).unwrap_or(u32::MAX);
    let messages_tokens = u32::try_from(history_chars / 4)
        .unwrap_or(u32::MAX)
        .saturating_add(messages.saturating_mul(8))
        .saturating_add(tool_calls.saturating_mul(16));
    let used = system_prompt
        .saturating_add(tool_definitions)
        .saturating_add(messages_tokens);
    ContextStats {
        used,
        window,
        output_cap,
        percent: context_percent(used, window),
        compacted,
        messages,
        breakdown: ContextBreakdown {
            system_prompt,
            tool_definitions,
            messages: messages_tokens,
        },
    }
}

/// Corrige a estimativa com o `usage.input_tokens` real do provider
/// (`HARNESS.md` §10.1): `used` vira o valor real e o breakdown é escalado na
/// mesma proporção; `messages` recebe o residual para a soma continuar exata.
pub fn calibrate_context(stats: &ContextStats, actual_input_tokens: u32) -> ContextStats {
    if actual_input_tokens == 0 {
        return stats.clone();
    }
    let actual = actual_input_tokens;
    let scale = |value: u32| -> u32 {
        if stats.used == 0 {
            0
        } else {
            u32::try_from((u64::from(value) * u64::from(actual)) / u64::from(stats.used))
                .unwrap_or(u32::MAX)
        }
    };
    // Nunca deixa system/tools passarem do total real (arredondamento).
    let system_prompt = scale(stats.breakdown.system_prompt).min(actual);
    let tool_definitions = scale(stats.breakdown.tool_definitions).min(actual - system_prompt);
    let messages = actual
        .saturating_sub(system_prompt)
        .saturating_sub(tool_definitions);
    ContextStats {
        used: actual,
        window: stats.window,
        output_cap: stats.output_cap,
        percent: context_percent(actual, stats.window),
        compacted: stats.compacted,
        messages: stats.messages,
        breakdown: ContextBreakdown {
            system_prompt,
            tool_definitions,
            messages,
        },
    }
}

fn context_percent(used: u32, window: u32) -> f32 {
    if window == 0 {
        0.0
    } else {
        (used as f32 / window as f32 * 100.0).min(100.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TodoStatus;

    fn db() -> Db {
        Db::open_in_memory().expect("banco em memória")
    }

    fn last_event(db: &Db, kind: &str) -> StoredCodeEvent {
        db.latest_code_event("conv-1", kind)
            .expect("ler evento")
            .expect("evento presente")
    }

    fn feedback(content: &str) -> TodoItem {
        TodoItem {
            content: content.to_string(),
            status: TodoStatus::Pending,
        }
    }

    #[test]
    fn plan_mode_and_plan_view_lifecycle() {
        let db = db();
        assert!(!plan_mode_active(&db, "conv-1").expect("modo"));
        assert!(plan_view(&db, "conv-1").expect("plano").is_none());
        set_plan_mode(&db, "conv-1", true).expect("modo plano");
        assert!(plan_mode_active(&db, "conv-1").expect("modo"));
        let view = plan_view(&db, "conv-1")
            .expect("plano")
            .expect("planejando");
        assert_eq!(view.state, PlanState::Planning);
        assert_eq!(view.updated_at, last_event(&db, KIND_PLAN_MODE).created_at);

        set_plan_mode(&db, "conv-1", false).expect("modo plano off");
        assert!(!plan_mode_active(&db, "conv-1").expect("modo"));
        assert!(plan_view(&db, "conv-1").expect("plano").is_none());

        set_plan_mode(&db, "conv-1", true).expect("modo plano");
        submit_plan(&db, "conv-1", "turn-1", "# Plano\n\n1. Fazer").expect("plano");
        let view = plan_view(&db, "conv-1").expect("plano").expect("revisando");
        assert_eq!(view.state, PlanState::Reviewing);
        assert!(view.markdown.unwrap().contains("# Plano"));
        assert_eq!(
            view.updated_at,
            last_event(&db, KIND_PLAN_SUBMITTED).created_at
        );

        approve_plan(&db, "conv-1", "turn-1", None, false).expect("aprovar");
        let view = plan_view(&db, "conv-1").expect("plano").expect("aprovado");
        assert_eq!(view.state, PlanState::Approved);
        assert_eq!(
            view.updated_at,
            last_event(&db, KIND_PLAN_APPROVED).created_at
        );
        assert!(!plan_mode_active(&db, "conv-1").expect("modo"));
    }

    #[test]
    fn creator_mode_is_persistent_and_independent_from_plan_mode() {
        let db = db();
        assert!(!creator_mode_active(&db, "conv-1").expect("modo"));
        set_creator_mode(&db, "conv-1", true).expect("modo creator");
        assert!(creator_mode_active(&db, "conv-1").expect("modo"));
        assert!(!plan_mode_active(&db, "conv-1").expect("plano"));
        assert_eq!(
            last_event(&db, KIND_CREATOR_MODE).payload,
            "{\"active\":true}"
        );

        // Plan mode and creator mode coexist: the creator workflow can be
        // investigation-only while Plan is active.
        set_plan_mode(&db, "conv-1", true).expect("modo plano");
        assert!(creator_mode_active(&db, "conv-1").expect("creator"));
        assert!(plan_mode_active(&db, "conv-1").expect("plano"));

        set_creator_mode(&db, "conv-1", false).expect("creator off");
        assert!(!creator_mode_active(&db, "conv-1").expect("modo"));
        assert!(plan_mode_active(&db, "conv-1").expect("plano"));
    }

    #[test]
    fn feedback_draft_and_revised_markdown_survive_the_cycle() {
        let db = db();
        set_plan_mode(&db, "conv-1", true).expect("modo plano");
        submit_plan(&db, "conv-1", "turn-1", "# Draft").expect("plano");
        plan_feedback(&db, "conv-1", "turn-1", "inclua testes de erro").expect("feedback");

        let view = plan_view(&db, "conv-1")
            .expect("plano")
            .expect("planejando");
        assert_eq!(view.state, PlanState::Planning);
        assert_eq!(view.markdown.as_deref(), Some("# Draft"));
        assert_eq!(view.feedback.as_deref(), Some("inclua testes de erro"));
        assert_eq!(
            view.updated_at,
            last_event(&db, KIND_PLAN_FEEDBACK).created_at
        );

        // Reenvio: volta a revisar e o feedback anterior contextualiza o card.
        submit_plan(&db, "conv-1", "turn-2", "# Draft revisado").expect("reenvio");
        let view = plan_view(&db, "conv-1").expect("plano").expect("revisando");
        assert_eq!(view.state, PlanState::Reviewing);
        assert_eq!(view.markdown.as_deref(), Some("# Draft revisado"));
        assert_eq!(view.feedback.as_deref(), Some("inclua testes de erro"));

        // Markdown revisado na aprovação é o persistido.
        approve_plan(
            &db,
            "conv-1",
            "turn-2",
            Some("# Aprovado pelo usuário"),
            true,
        )
        .expect("aprovar");
        let view = plan_view(&db, "conv-1").expect("plano").expect("aprovado");
        assert_eq!(view.state, PlanState::Approved);
        assert_eq!(view.markdown.as_deref(), Some("# Aprovado pelo usuário"));
        let approved = last_event(&db, KIND_PLAN_APPROVED);
        assert!(approved.payload.contains("\"reviewEachEdit\":true"));
    }

    #[test]
    fn reactivating_plan_after_approval_starts_a_new_cycle() {
        let db = db();
        set_plan_mode(&db, "conv-1", true).expect("modo plano");
        submit_plan(&db, "conv-1", "turn-1", "# Plano").expect("plano");
        approve_plan(&db, "conv-1", "turn-1", None, false).expect("aprovar");
        assert_eq!(
            plan_view(&db, "conv-1")
                .expect("plano")
                .expect("aprovado")
                .state,
            PlanState::Approved
        );

        set_plan_mode(&db, "conv-1", true).expect("reativar plano");
        let view = plan_view(&db, "conv-1")
            .expect("plano")
            .expect("planejando");
        assert_eq!(view.state, PlanState::Planning);
        assert!(view.markdown.is_none());
        assert!(view.feedback.is_none());
        assert_eq!(view.updated_at, last_event(&db, KIND_PLAN_MODE).created_at);
    }

    #[test]
    fn stale_review_degrades_to_planning_after_turn_end() {
        let db = db();
        set_plan_mode(&db, "conv-1", true).expect("modo plano");
        submit_plan(&db, "conv-1", "turn-1", "# Plano").expect("plano");
        append(
            &db,
            "conv-1",
            Some("turn-1"),
            KIND_TURN_ENDED,
            &serde_json::json!({ "status": "done" }),
        )
        .expect("turno encerrado");

        let view = plan_view(&db, "conv-1")
            .expect("plano")
            .expect("planejando");
        assert_eq!(view.state, PlanState::Planning);
        assert_eq!(view.markdown.as_deref(), Some("# Plano"));
        assert_eq!(view.feedback, Some(stale_review_feedback()));
        assert_eq!(view.updated_at, last_event(&db, KIND_TURN_ENDED).created_at);
    }

    #[test]
    fn todos_roundtrip_and_validation() {
        let db = db();
        let items = vec![
            TodoItem {
                content: "Ler o módulo".to_string(),
                status: TodoStatus::Completed,
            },
            TodoItem {
                content: "Corrigir o bug".to_string(),
                status: TodoStatus::InProgress,
            },
        ];
        validate_todos(&items).expect("lista válida");
        save_todos(&db, "conv-1", "turn-1", &items).expect("salvar");
        let loaded = todos(&db, "conv-1").expect("tarefas");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1].status, TodoStatus::InProgress);

        // Lista vazia é válida e limpa a projeção.
        validate_todos(&[]).expect("limpar é válido");
        save_todos(&db, "conv-1", "turn-2", &[]).expect("limpar");
        assert!(todos(&db, "conv-1").expect("tarefas").is_empty());
    }

    #[test]
    fn rejects_duplicate_multiple_in_progress_and_overflow() {
        let duplicates = vec![feedback("A"), feedback("a")];
        assert!(validate_todos(&duplicates).is_err());

        let parallel = vec![
            TodoItem {
                content: "A".to_string(),
                status: TodoStatus::InProgress,
            },
            TodoItem {
                content: "B".to_string(),
                status: TodoStatus::InProgress,
            },
        ];
        assert!(validate_todos(&parallel).is_err());

        let overflow: Vec<TodoItem> = (0..51)
            .map(|index| feedback(&format!("item {index}")))
            .collect();
        assert!(validate_todos(&overflow).is_err());

        let blank = vec![feedback("   ")];
        assert!(validate_todos(&blank).is_err());
    }

    #[test]
    fn context_stats_roundtrip() {
        let db = db();
        assert!(context_stats(&db, "conv-1").is_none());
        let stats = estimate_context(4_000, 8_000, 2_000, 200_000, 32_000, 4, 2, 0);
        save_context_stats(&db, "conv-1", "turn-1", &stats).expect("salvar stats");
        let loaded = context_stats(&db, "conv-1").expect("stats");
        assert_eq!(loaded.used, stats.used);
        assert_eq!(loaded.breakdown, stats.breakdown);
    }

    #[test]
    fn estimate_context_sums_the_breakdown_and_clamps_percent() {
        // 4k system + 8k histórico + 2k tools = 14k chars ⇒ 3.5k tokens de
        // base, + 4 mensagens × 8 + 2 tool calls × 16.
        let stats = estimate_context(4_000, 8_000, 2_000, 100_000, 32_000, 4, 2, 3);
        assert_eq!(stats.breakdown.system_prompt, 1_000);
        assert_eq!(stats.breakdown.tool_definitions, 500);
        assert_eq!(stats.breakdown.messages, 2_000 + 32 + 32);
        assert_eq!(
            stats.breakdown.system_prompt
                + stats.breakdown.tool_definitions
                + stats.breakdown.messages,
            stats.used
        );
        assert_eq!(stats.used, 3_564);
        assert_eq!(stats.messages, 4);
        assert_eq!(stats.compacted, 3);
        assert!((stats.percent - 3.564).abs() < 0.01, "{}", stats.percent);
        assert!(stats.used <= stats.window);

        // Janela minúscula: percent satura em 100 (nunca passa disso).
        let tiny = estimate_context(40_000, 0, 0, 1_000, 1_000, 0, 0, 0);
        assert_eq!(tiny.percent, 100.0);
        // Janela 0 ⇒ 0% (sem divisão por zero).
        let zero = estimate_context(4_000, 0, 0, 0, 0, 0, 0, 0);
        assert_eq!(zero.percent, 0.0);
    }

    #[test]
    fn calibrate_context_uses_the_real_input_and_keeps_the_sum() {
        let estimate = estimate_context(8_000, 16_000, 4_000, 200_000, 32_000, 6, 3, 2);
        assert_eq!(estimate.used, (8_000 + 16_000 + 4_000) / 4 + 6 * 8 + 3 * 16);

        // Uso real maior: escala tudo proporcionalmente e soma continua exata.
        let grown = calibrate_context(&estimate, 50_000);
        assert_eq!(grown.used, 50_000);
        assert_eq!(grown.percent, 25.0);
        assert_eq!(grown.messages, estimate.messages);
        assert_eq!(grown.compacted, estimate.compacted);
        assert_eq!(
            grown.breakdown.system_prompt
                + grown.breakdown.tool_definitions
                + grown.breakdown.messages,
            grown.used
        );
        assert!(grown.breakdown.system_prompt >= estimate.breakdown.system_prompt);

        // Uso real menor: encolhe proporcionalmente, sem underflow.
        let shrunk = calibrate_context(&estimate, 500);
        assert_eq!(shrunk.used, 500);
        assert_eq!(
            shrunk.breakdown.messages,
            shrunk.used - shrunk.breakdown.system_prompt - shrunk.breakdown.tool_definitions
        );

        // Sem uso real (0) ou estimativa vazia: devolve a entrada.
        assert_eq!(calibrate_context(&estimate, 0).used, estimate.used);
        let empty = estimate_context(0, 0, 0, 200_000, 32_000, 0, 0, 0);
        let calibrated = calibrate_context(&empty, 1_000);
        assert_eq!(calibrated.used, 1_000);
        assert_eq!(calibrated.breakdown.messages, 1_000);
    }

    #[test]
    fn compacted_messages_fold_and_old_stats_still_deserialize() {
        let db = db();
        assert_eq!(compacted_messages(&db, "conv-1"), 0);
        append(
            &db,
            "conv-1",
            Some("turn-1"),
            KIND_CONTEXT_COMPACTED,
            &serde_json::json!({ "messages": 12, "tokensFreed": 900 }),
        )
        .expect("compacted");
        assert_eq!(compacted_messages(&db, "conv-1"), 12);
        // O evento de compactação NÃO pode envenenar a projeção do medidor.
        assert!(context_stats(&db, "conv-1").is_none());

        // Backward-compat: payload de `context/stats` anterior ao breakdown.
        let legacy = r#"{"used":12000,"window":200000,"outputCap":32000,"percent":6.0,"compacted":0,"messages":4}"#;
        let stats: ContextStats = serde_json::from_str(legacy).expect("payload legado");
        assert_eq!(stats.used, 12_000);
        assert_eq!(stats.breakdown, ContextBreakdown::default());
    }

    #[test]
    fn turn_changes_dedupes_paths_and_sums_the_edits() {
        let db = db();
        for (path, added, removed) in [("src/a.ts", 2, 1), ("src/a.ts", 3, 0), ("src/b.ts", 1, 0)] {
            let mut entry = crate::db::FileJournalEntry::new(
                "conv-1",
                "turn-1",
                path,
                crate::domain::FileChangeKind::Modified,
            );
            entry.added = Some(added);
            entry.removed = Some(removed);
            db.append_file_journal(&entry).expect("journal");
        }

        let summary = turn_changes(&db, "conv-1", "turn-1").expect("resumo do turno");
        // Uma entrada por ARQUIVO: as duas edições de `src/a.ts` viram uma linha.
        assert_eq!(summary.files.len(), 2);
        let a = summary
            .files
            .iter()
            .find(|file| file.path == "src/a.ts")
            .expect("a.ts");
        assert_eq!(a.added, 5);
        assert_eq!(a.removed, 1);
        // O total do resumo segue a lista deduplicada.
        assert_eq!(summary.added, 6);
        assert_eq!(summary.removed, 1);
    }
}
