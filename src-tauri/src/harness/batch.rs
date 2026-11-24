//! Chamadas "batch" (não-streaming para o usuário) do harness.
//!
//! Usadas para tarefas auxiliares que não fazem parte do turno visível: resumo
//! de compactação de contexto e sugestão de mensagem de commit. Reaproveitam a
//! mesma resolução de credencial/protocolo e o mesmo transporte do turno, mas
//! descartam os eventos (o texto é coletado em memória).

use std::sync::Arc;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::providers::{
    self, CompletionRequest, HistoryMessage, ProviderError, ProviderEvent, ReasoningRequest,
    StreamTimeouts,
};

use super::{provider_config, resolve_credential, resolve_model, resolve_protocols, HarnessDeps};

/// Requisição de texto único (sem tools).
pub struct BatchRequest<'a> {
    pub provider_id: &'a str,
    pub model_id: &'a str,
    pub timeouts: StreamTimeouts,
    pub system_prompt: &'a str,
    pub user_text: &'a str,
    pub max_output_tokens: u32,
    pub temperature: Option<f32>,
    /// Reasoning policy for this auxiliary request (short outputs may need it off).
    pub reasoning: ReasoningRequest,
}

/// Executa uma completion não-streaming e devolve o texto final.
///
/// Falhas de provedor são devolvidas com contexto; o chamador decide se é
/// crítico (compactação) ou opcional (sugestão de commit).
pub async fn complete_text(
    deps: &HarnessDeps,
    request: BatchRequest<'_>,
) -> anyhow::Result<String> {
    let provider = deps
        .catalog
        .provider(request.provider_id)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("provedor desconhecido: {}", request.provider_id))?;
    let model = resolve_model(deps, &provider, request.model_id).ok_or_else(|| {
        anyhow::anyhow!(
            "modelo `{}` indisponível no provedor `{}`",
            request.model_id,
            provider.id
        )
    })?;
    let credential = resolve_credential(deps, &provider)
        .await
        .map_err(|error| anyhow::anyhow!("credencial indisponível: {error}"))?;
    let protocols = resolve_protocols(&provider, &model)?;
    let cancel = CancellationToken::new();
    let completion = CompletionRequest {
        config: provider_config(&provider, &model, &credential, "batch"),
        protocols,
        history: vec![HistoryMessage::user(request.user_text.to_string())],
        system_prompt: request.system_prompt.to_string(),
        tools: Vec::new(),
        reasoning: request.reasoning,
        max_output_tokens: Some(request.max_output_tokens.clamp(512, 4_096)),
        temperature: request.temperature,
        cancel: cancel.clone(),
        // F4b: plano de cache explícito preenchido no wiring da F4.
        cache_plan: None,
        timeouts: request.timeouts,
    };

    let completion = Arc::new(completion);
    let request_for_attempt = {
        let completion = completion.clone();
        move || (*completion).clone()
    };
    collect_with_retry(deps, request_for_attempt).await
}

/// Retry policy for auxiliary (non-turn) completions: fewer attempts than a
/// user turn because these calls are optional or run under a prompt-cache
/// prefix that should not wait minutes.
fn auxiliary_retry_policy() -> providers::retry::RetryPolicy {
    providers::retry::RetryPolicy {
        max_retries: 2,
        ..Default::default()
    }
}

/// Runs one provider completion, retrying transient failures only when no text
/// was collected (a retry after partial text would duplicate the summary).
async fn collect_with_retry<F>(
    deps: &HarnessDeps,
    mut build: F,
) -> anyhow::Result<String>
where
    F: FnMut() -> CompletionRequest,
{
    let policy = auxiliary_retry_policy();
    let mut failures = 0u32;
    let mut elapsed = std::time::Duration::ZERO;
    loop {
        let request = build();
        let text = Arc::new(Mutex::new(String::new()));
        let (sink, mut events) = tokio::sync::mpsc::unbounded_channel::<ProviderEvent>();
        let reader = {
            let text = text.clone();
            tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    if let ProviderEvent::TextDelta(delta) = event {
                        text.lock().push_str(&delta);
                    }
                }
            })
        };
        let result = match &deps.streamer {
            Some(streamer) => streamer(request, sink).await,
            None => providers::stream_completion(&deps.http, request, sink).await,
        };
        match result {
            Ok(()) => {
                reader
                    .await
                    .map_err(|error| anyhow::anyhow!("leitor do batch falhou: {error}"))?;
                let trimmed = text.lock().trim().to_string();
                if trimmed.is_empty() {
                    anyhow::bail!("o modelo não devolveu texto");
                }
                return Ok(trimmed);
            }
            Err(error) => {
                // The stream may have sent partial deltas before failing; only
                // retry when nothing was collected.
                reader.abort();
                let _ = reader.await;
                let nothing_collected = text.lock().is_empty();
                if nothing_collected {
                    if let Some(provider_error) = error.downcast_ref::<ProviderError>() {
                        failures += 1;
                        match providers::retry::decide(
                            &policy,
                            provider_error,
                            failures,
                            elapsed,
                            providers::retry::jitter_sample(),
                        ) {
                            providers::retry::RetryDecision::Retry { delay, .. } => {
                                tokio::time::sleep(delay).await;
                                elapsed = elapsed.saturating_add(delay);
                                continue;
                            }
                            providers::retry::RetryDecision::Stop { .. } => {}
                        }
                    }
                }
                return Err(error);
            }
        }
    }
}

/// Executa uma completion **já montada** e devolve o texto final.
///
/// Usada pela compactação cache-safe (F3b): o request é o próprio request normal
/// da conversa (system prompt, tools e histórico), com uma instrução de
/// sumarização anexada no fim — então o provider reaproveita o prefixo cacheado.
/// Nenhum evento é emitido para a UI.
pub async fn complete_request(
    deps: &HarnessDeps,
    request: CompletionRequest,
) -> anyhow::Result<String> {
    let request = Arc::new(request);
    let request_for_attempt = {
        let request = request.clone();
        move || (*request).clone()
    };
    collect_with_retry(deps, request_for_attempt).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Settings;

    fn deps_with_streamer(streamer: super::super::ProviderStreamer) -> HarnessDeps {
        let db = Arc::new(crate::db::Db::open_in_memory().expect("db"));
        HarnessDeps {
            app: None,
            db,
            http: reqwest::Client::new(),
            search_http: reqwest::Client::new(),
            catalog: crate::catalog::CatalogFile::load().expect("catalog"),
            streamer: Some(streamer),
            credential_override: Some(super::super::CredentialOverride::ApiKey("k".into())),
            refresh_override: None,
            model_source: None,
            api_key_override: None,
            data_dir: Some(std::env::temp_dir()),
            skills_roots: Some(Vec::new()),
            approvals: None,
            observed: None,
            jobs: None,
            questions: None,
            mcp: None,
        }
    }

    #[tokio::test]
    async fn collects_streamed_text_and_rejects_empty_answers() {
        let streamer: super::super::ProviderStreamer = Arc::new(|_request, sink| {
            Box::pin(async move {
                let _ = sink.send(ProviderEvent::TextDelta("primeira ".to_string()));
                let _ = sink.send(ProviderEvent::TextDelta("segunda".to_string()));
                Ok(())
            })
        });
        let deps = deps_with_streamer(streamer);
        let text = complete_text(
            &deps,
            BatchRequest {
                provider_id: "opencode-go",
                model_id: "deepseek-v4.1-flash",
                timeouts: StreamTimeouts::default(),
                system_prompt: "Resuma.",
                user_text: "conteúdo",
                max_output_tokens: 256,
                temperature: None,
                reasoning: ReasoningRequest::Auto,
            },
        )
        .await
        .expect("texto coletado");
        assert_eq!(text, "primeira segunda");
        let _ = Settings::default();
    }

    #[tokio::test]
    async fn empty_answer_is_an_error() {
        let streamer: super::super::ProviderStreamer =
            Arc::new(|_request, _sink| Box::pin(async move { Ok(()) }));
        let deps = deps_with_streamer(streamer);
        let error = complete_text(
            &deps,
            BatchRequest {
                provider_id: "opencode-go",
                model_id: "deepseek-v4.1-flash",
                timeouts: StreamTimeouts::default(),
                system_prompt: "Resuma.",
                user_text: "conteúdo",
                max_output_tokens: 256,
                temperature: None,
                reasoning: ReasoningRequest::Auto,
            },
        )
        .await
        .expect_err("vazio é erro");
        assert!(format!("{error}").contains("não devolveu texto"));
    }

    #[tokio::test]
    async fn forwards_the_requested_reasoning_policy_to_the_provider() {
        let seen = Arc::new(Mutex::new(None::<ReasoningRequest>));
        let seen_for_streamer = seen.clone();
        let streamer: super::super::ProviderStreamer = Arc::new(move |request, sink| {
            let seen = seen_for_streamer.clone();
            Box::pin(async move {
                *seen.lock() = Some(request.reasoning);
                let _ = sink.send(ProviderEvent::TextDelta("feat(git): describe change".into()));
                Ok(())
            })
        });
        let deps = deps_with_streamer(streamer);
        let text = complete_text(
            &deps,
            BatchRequest {
                provider_id: "opencode-go",
                model_id: "deepseek-v4.1-flash",
                timeouts: StreamTimeouts::default(),
                system_prompt: "Commit subject.",
                user_text: "diff",
                max_output_tokens: 1_024,
                temperature: Some(0.2),
                reasoning: ReasoningRequest::Off,
            },
        )
        .await
        .expect("texto coletado");

        assert_eq!(text, "feat(git): describe change");
        assert!(seen
            .lock()
            .as_ref()
            .is_some_and(|reasoning| reasoning.is_off()));
    }
}
