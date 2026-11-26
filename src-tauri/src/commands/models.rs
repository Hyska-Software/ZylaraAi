//! Model catalog surface for the UI.
//!
//! The bundled catalog (`data/catalog.json`) is the source of truth for wire
//! protocols/capabilities. Providers that expose an account-specific model list
//! (OpenAI / ChatGPT plan) are refreshed through `refresh_provider_models` and
//! merged here, so the renderer, the picker and the harness see the same list.

use std::path::PathBuf;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::catalog::{ModelInfo, Modalities, ProviderInfo, ReasoningOption};
use crate::config;
use crate::domain::CatalogView;
use crate::state::AppState;

const CACHE_FILE: &str = "models-cache.json";
const CACHE_VERSION: u32 = 1;

/* ------------------------------------------------------------------ */
/* Remote list                                                         */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteModel {
    pub id: String,
    pub display_name: Option<String>,
    pub visibility: Option<String>,
    /// Context window reported by the account list (Anthropic `max_input_tokens`).
    pub context_window: Option<u32>,
    /// Max output tokens reported by the account list (Anthropic `max_tokens`).
    pub max_output: Option<u32>,
    /// Input modalities reported by the account list (`capabilities.*.supported`
    /// or the `modalities.input` array on older list shapes).
    pub input_modalities: Vec<String>,
    /// Reasoning efforts reported by the account list (`capabilities.effort`).
    pub reasoning_efforts: Vec<String>,
    /// The model exposes some thinking control (`capabilities.thinking`).
    pub reasoning: bool,
    /// Generation methods reported by the list (`supportedGenerationMethods`).
    pub generation_methods: Vec<String>,
    /// The payload carried a `capabilities` object, so "no reasoning/image" is
    /// authoritative instead of "metadata absent" (see [`estimated_model`]).
    pub capabilities_reported: bool,
}

/// One page of a provider model list plus the cursor for the next page.
#[derive(Debug, Clone, Default)]
pub struct RemotePage {
    pub models: Vec<RemoteModel>,
    /// `after_id` value for the next request when the provider paginates.
    pub next_after: Option<String>,
    /// `nextPageToken` value (Google `GET /v1beta/models`).
    pub next_page_token: Option<String>,
}

impl RemoteModel {
    /// True when the account list reports image/pdf input support.
    fn can_receive_images(&self) -> bool {
        self.input_modalities
            .iter()
            .any(|modality| modality == "image" || modality == "pdf")
    }
}

/// Effort levels the UI understands, in the order the picker shows them.
const REASONING_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

fn flag_supported(item: &Value, pointer: &str) -> bool {
    item.pointer(pointer).and_then(Value::as_bool).unwrap_or(false)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn u32_field(item: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_u64))
        .and_then(|value| u32::try_from(value).ok())
}

/// Parses one model entry, tolerating every shape we know:
/// `{"models":[{"slug","display_name","visibility"}]}` (OpenAI plan usage),
/// `{"data":[{"id","display_name","max_input_tokens","max_tokens","capabilities"}]}`
/// (Anthropic Models API) and `{"data":[{"id"}]}` (OpenAI platform).
fn parse_remote_model(item: &Value) -> Option<RemoteModel> {
    // Gemini lists `name` as the resource (`models/gemini-…`) and `displayName`
    // as the label; the other providers use `id`/`slug` + `display_name`.
    let raw_id = item
        .get("id")
        .or_else(|| item.get("slug"))
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let id = raw_id.rsplit('/').next().unwrap_or(raw_id).trim().to_string();
    if id.is_empty() {
        return None;
    }
    let display_name = item
        .get("display_name")
        .or_else(|| item.get("displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            // `name` is a display label only when it was not used as the id.
            if item.get("id").is_some() || item.get("slug").is_some() {
                item.get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            } else {
                None
            }
        });
    let visibility = item
        .get("visibility")
        .and_then(Value::as_str)
        .map(str::to_string);
    // The plan route hides internal models from the picker; other providers do
    // not send `visibility` at all.
    if visibility.as_deref().is_some_and(|value| value != "list") {
        return None;
    }
    // Retired models still appear in the Anthropic catalogue as history but can
    // never be called: keep them out of the account list.
    if item.get("lifecycle").and_then(Value::as_str) == Some("retired") {
        return None;
    }
    // Gemini model lists include embedding/agent endpoints; only models that
    // accept generateContent are selectable in the chat UI.
    let generation_methods = string_array(item.get("supportedGenerationMethods"));
    if !generation_methods.is_empty()
        && !generation_methods
            .iter()
            .any(|method| method == "generateContent")
    {
        return None;
    }

    let capabilities = item.get("capabilities");
    let capabilities_reported = capabilities.is_some_and(Value::is_object);
    let mut input_modalities: Vec<String> = Vec::new();
    if capabilities_reported {
        input_modalities.push("text".to_string());
        if flag_supported(item, "/capabilities/image_input/supported") {
            input_modalities.push("image".to_string());
        }
        if flag_supported(item, "/capabilities/pdf_input/supported") {
            input_modalities.push("pdf".to_string());
        }
    } else {
        // Older/other list shapes may still expose modalities directly.
        input_modalities = string_array(item.pointer("/modalities/input"));
    }

    let reasoning_efforts = capabilities
        .and_then(|value| value.get("effort"))
        .map(|effort| {
            REASONING_EFFORTS
                .iter()
                .filter(|level| flag_supported(effort, &format!("/{level}/supported")))
                .map(|level| (*level).to_string())
                .collect()
        })
        .unwrap_or_default();
    let reasoning = flag_supported(item, "/capabilities/thinking/supported")
        || item.get("reasoning").and_then(Value::as_bool).unwrap_or(false)
        || item.get("thinking").and_then(Value::as_bool).unwrap_or(false);

    Some(RemoteModel {
        id,
        display_name,
        visibility,
        context_window: u32_field(
            item,
            &["max_input_tokens", "context_window", "inputTokenLimit"],
        ),
        max_output: u32_field(
            item,
            &["max_tokens", "max_output_tokens", "outputTokenLimit"],
        ),
        input_modalities,
        reasoning_efforts,
        reasoning,
        generation_methods,
        capabilities_reported,
    })
}

/// Parses a model-list page and the pagination cursor, when the provider sends
/// one (`has_more` + `last_id` on the Anthropic Models API).
pub fn parse_remote_page(document: &Value) -> RemotePage {
    let array = document
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| document.get("data").and_then(Value::as_array));
    let Some(array) = array else {
        return RemotePage::default();
    };
    let models = array.iter().filter_map(parse_remote_model).collect();
    let has_more = document.get("has_more").and_then(Value::as_bool).unwrap_or(false);
    let next_after = if has_more {
        document
            .get("last_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_string)
    } else {
        None
    };
    let next_page_token = document
        .get("nextPageToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    RemotePage {
        models,
        next_after,
        next_page_token,
    }
}

/// Flattens the first page (kept for callers/tests that only need the list).
pub fn parse_remote_models(document: &Value) -> Vec<RemoteModel> {
    parse_remote_page(document).models
}

/// Appends the `after_id` cursor of a paginated list endpoint.
pub fn next_page_url(base: &str, after: &str) -> String {
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}after_id={after}")
}

/// Appends (or replaces) the Google `pageToken` of a paginated list endpoint.
pub fn next_page_token_url(base: &str, token: &str) -> String {
    let base = base
        .split_once("pageToken=")
        .map(|(head, _)| head.trim_end_matches(|c| c == '&' || c == '?'))
        .unwrap_or(base);
    let separator = if base.contains('?') { '&' } else { '?' };
    let token = utf8_percent_encode(token, NON_ALPHANUMERIC);
    format!("{base}{separator}pageToken={token}")
}

/// Text-output Gemini models this provider exposes.
pub const GEMINI_CHAT_MODELS: [&str; 3] =
    ["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"];

/// Provider-specific allowlist for the live account list.
pub(crate) fn remote_model_allowed(provider_id: &str, model_id: &str) -> bool {
    provider_id != "gemini" || GEMINI_CHAT_MODELS.iter().any(|allowed| *allowed == model_id)
}

fn models_endpoint(provider: &ProviderInfo) -> String {
    let path = provider
        .endpoints
        .get("models")
        .map(String::as_str)
        .unwrap_or("/models");
    format!("{}{}", provider.base_url.trim_end_matches('/'), path)
}

fn api_key_for(app: &AppHandle, provider: &ProviderInfo) -> Option<String> {
    config::api_key_from_secrets(app, &provider.id)
        .or_else(|| config::api_key_from_env(&provider.id, &provider.auth_env))
        .or_else(|| config::api_key_from_opencode_cli(&provider.id))
}

/// Actionable "no credential" copy. It keeps the lowercase `nenhuma credencial`
/// prefix because `refresh_catalog` uses it to skip the expected "provider not
/// configured yet" failures without logging noise.
fn missing_credential_message(provider: &ProviderInfo) -> String {
    if provider.supports_oauth() {
        crate::i18n::t_args(
            "models.errors.noCredentialOauth",
            &[("provider", &provider.name)],
        )
    } else {
        crate::i18n::t_args(
            "models.errors.noCredential",
            &[("provider", &provider.name)],
        )
    }
}

/// Bearer credential for a provider: OAuth access token when the provider uses
/// the ChatGPT plan, otherwise (or as fallback) an API key.
async fn bearer_for(
    app: &AppHandle,
    state: &AppState,
    provider: &ProviderInfo,
) -> Result<String, String> {
    let mut oauth_error: Option<String> = None;
    if provider.supports_oauth() {
        match state.ensure_bearer(app, &provider.id).await {
            Ok(token) => return Ok(token),
            Err(error) => oauth_error = Some(format!("{error:#}")),
        }
    }
    if let Some(key) = api_key_for(app, provider) {
        return Ok(key);
    }
    Err(oauth_error.unwrap_or_else(|| missing_credential_message(provider)))
}

/// Upper bound of remote pages per refresh (the Models API caps `limit` at 1000
/// but defaults to 20; the loop makes any page size safe).
const MAX_MODEL_PAGES: usize = 50;

async fn fetch_remote_models(
    app: &AppHandle,
    state: &AppState,
    provider: &ProviderInfo,
) -> Result<Vec<RemoteModel>, String> {
    let bearer = bearer_for(app, state, provider).await?;
    let endpoint = models_endpoint(provider);
    // Google caps the page at 1000 models; ask for the maximum up front.
    let mut url = if provider.id == "gemini" {
        format!("{endpoint}?pageSize=1000")
    } else {
        endpoint.clone()
    };
    let mut remote: Vec<RemoteModel> = Vec::new();
    let mut any_models = false;
    for _ in 0..MAX_MODEL_PAGES {
        let (header_name, header_value) = provider.credential_header(&bearer);
        // Model listing is idempotent: transient failures are retried with the
        // same policy as completion requests (capped at two extra attempts).
        let policy = crate::providers::retry::RetryPolicy {
            max_retries: 2,
            ..Default::default()
        };
        let mut attempt = 0u32;
        let document: Value = loop {
            attempt += 1;
            let mut request = state
                .http
                .get(&url)
                .header(header_name.as_str(), header_value.as_str())
                .header("User-Agent", concat!("Zylara/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(25));
            // Provider-declared headers (e.g. `anthropic-version`) are required
            // by direct APIs even on the model-list endpoint.
            for (name, value) in provider.static_headers() {
                request = request.header(name, value);
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    if attempt <= policy.max_retries {
                        tokio::time::sleep(crate::providers::retry::backoff_delay(
                            &policy,
                            attempt,
                            crate::providers::retry::jitter_sample(),
                        ))
                        .await;
                        continue;
                    }
                    return Err(format!(
                        "falha ao listar modelos de {}: {error}",
                        provider.name
                    ));
                }
            };
            let status = response.status();
            if !status.is_success() {
                let retry_after =
                    crate::providers::retry::retry_after_from_headers(response.headers());
                let body = response.text().await.unwrap_or_default();
                let error = crate::providers::ProviderError::from_http_with_retry_after(
                    status.as_u16(),
                    &body,
                    retry_after,
                );
                if attempt <= policy.max_retries && error.is_transient() {
                    let delay = retry_after
                        .filter(|delay| {
                            crate::providers::retry::duration_ms(*delay)
                                <= policy.retry_after_cap_ms
                        })
                        .unwrap_or_else(|| {
                            crate::providers::retry::backoff_delay(
                                &policy,
                                attempt,
                                crate::providers::retry::jitter_sample(),
                            )
                        });
                    tokio::time::sleep(delay).await;
                    continue;
                }
                return Err(format!(
                    "{} respondeu {status} ao listar modelos: {}",
                    provider.name,
                    body.chars().take(300).collect::<String>()
                ));
            }
            break response.json().await.map_err(|error| {
                crate::i18n::t_args(
                    "models.errors.invalidResponse",
                    &[("provider", &provider.name), ("error", &error.to_string())],
                )
            })?;
        };
        let page = parse_remote_page(&document);
        any_models |= !page.models.is_empty();
        remote.extend(
            page.models
                .into_iter()
                .filter(|model| remote_model_allowed(&provider.id, &model.id)),
        );
        if let Some(cursor) = page.next_after {
            url = next_page_url(&endpoint, &cursor);
        } else if let Some(token) = page.next_page_token {
            url = next_page_token_url(&url, &token);
        } else {
            break;
        }
    }
    // A Gemini account may have none of the three exposed models; keep the
    // bundled seed as fallback instead of failing the refresh.
    if !any_models {
        return Err(crate::i18n::t_args(
            "models.errors.noModels",
            &[("provider", &provider.name)],
        ));
    }
    Ok(remote)
}

/// Conservative metadata for a model that only the account exposes.
///
/// Providers that report capabilities in the list payload (Anthropic Models API)
/// use them verbatim; the others (OpenAI `/v1/models`) fall back to the
/// representative metadata of the provider seed so the model stays usable with
/// the right wire protocol/family instead of guessing.
fn estimated_model(provider: &ProviderInfo, remote: &RemoteModel) -> ModelInfo {
    let representative = provider.models.first();
    let protocols = representative
        .map(|model| model.protocols.clone())
        .filter(|protocols| !protocols.is_empty())
        .unwrap_or_else(|| vec!["openai-responses".to_string()]);
    let family = representative
        .map(|model| model.family.clone())
        .unwrap_or_default();

    let reasoning_options = if remote.capabilities_reported {
        if !remote.reasoning_efforts.is_empty() {
            vec![ReasoningOption::Effort {
                values: remote.reasoning_efforts.clone(),
            }]
        } else if remote.reasoning {
            vec![ReasoningOption::Toggle]
        } else {
            Vec::new()
        }
    } else {
        representative
            .map(|model| model.reasoning_options.clone())
            .unwrap_or_default()
    };

    let modalities = if remote.can_receive_images() || remote.capabilities_reported {
        Modalities {
            input: if remote.input_modalities.is_empty() {
                vec!["text".to_string()]
            } else {
                remote.input_modalities.clone()
            },
            output: vec!["text".to_string()],
        }
    } else {
        representative
            .map(|model| model.modalities.clone())
            .unwrap_or_else(|| Modalities {
                input: vec!["text".to_string()],
                output: vec!["text".to_string()],
            })
    };
    let attachment = if remote.capabilities_reported {
        remote.can_receive_images()
    } else {
        representative.map(|model| model.attachment).unwrap_or(false)
    };

    let mut tags: Vec<String> = Vec::new();
    if !reasoning_options.is_empty() {
        tags.push("reasoning".to_string());
    }
    if attachment {
        tags.push("vision".to_string());
    }

    ModelInfo {
        id: remote.id.clone(),
        name: remote
            .display_name
            .clone()
            .unwrap_or_else(|| remote.id.clone()),
        family,
        protocols,
        reasoning: !reasoning_options.is_empty(),
        reasoning_options,
        attachment,
        modalities,
        // Account-reported limits win; otherwise the seed's representative
        // model keeps the estimate in the right ballpark for the provider.
        context_window: remote
            .context_window
            .or_else(|| representative.map(|model| model.context_window))
            .unwrap_or(128_000),
        max_output: remote
            .max_output
            .or_else(|| representative.map(|model| model.max_output))
            .unwrap_or(16_384),
        cost: None,
        release_date: None,
        knowledge: None,
        open_weights: false,
        description: None,
        tags,
        status: "stable".into(),
        estimated: true,
        cache: None,
    }
}

/// Merges the account list with the bundled metadata (account order wins).
pub fn merge_models(provider: &ProviderInfo, remote: &[RemoteModel]) -> Vec<ModelInfo> {
    let mut merged: Vec<ModelInfo> = remote
        .iter()
        .map(|remote_model| {
            provider
                .models
                .iter()
                .find(|model| model.id == remote_model.id)
                .cloned()
                .unwrap_or_else(|| estimated_model(provider, remote_model))
        })
        .collect();
    for model in &provider.models {
        if !merged.iter().any(|known| known.id == model.id) {
            merged.push(model.clone());
        }
    }
    merged
}

/* ------------------------------------------------------------------ */
/* Disk cache (survives restart; never contains credentials)           */
/* ------------------------------------------------------------------ */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    fetched_at: i64,
    models: Vec<ModelInfo>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    #[serde(default)]
    providers: std::collections::BTreeMap<String, CacheEntry>,
}

fn cache_path(state: &AppState) -> PathBuf {
    state.data_dir.join(CACHE_FILE)
}

fn save_models_cache(app: &AppHandle, state: &AppState) -> anyhow::Result<()> {
    let mut providers = std::collections::BTreeMap::new();
    for provider in &state.catalog_with_plugins().providers {
        if let Some(dynamic) = state.dynamic_models_for(&provider.id) {
            providers.insert(
                provider.id.clone(),
                CacheEntry {
                    fetched_at: dynamic.fetched_at,
                    models: dynamic.models,
                },
            );
        }
    }
    let file = CacheFile {
        version: CACHE_VERSION,
        providers,
    };
    let raw = serde_json::to_string_pretty(&file)?;
    let tmp = cache_path(state).with_extension("json.tmp");
    std::fs::write(&tmp, raw)?;
    std::fs::rename(&tmp, cache_path(state))?;
    let _ = app;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

fn refreshed_at(state: &AppState) -> Option<i64> {
    state
        .catalog_with_plugins()
        .providers
        .iter()
        .filter_map(|provider| state.dynamic_models_for(&provider.id))
        .map(|dynamic| dynamic.fetched_at)
        .max()
}

pub fn catalog_view(app: &AppHandle, state: &AppState) -> CatalogView {
    let mut catalog = state.catalog_with_plugins();
    for provider in &mut catalog.providers {
        provider.models = state.models(&provider.id);
    }
    let provider_ids: Vec<String> = catalog.providers.iter().map(|p| p.id.clone()).collect();
    CatalogView {
        catalog,
        keys: config::all_key_status(app, &provider_ids),
        auth: crate::oauth::statuses(app, &state.catalog),
        remote_refreshed_at: refreshed_at(state),
        acp_agents: state
            .db
            .acp_agents()
            .unwrap_or_default()
            .into_iter()
            .map(|row| {
                crate::acp::to_view(
                    &row,
                    state
                        .db
                        .acp_models(&row.id)
                        .map(|m| m.len() as u32)
                        .unwrap_or(0),
                )
            })
            .collect(),
    }
}


#[tauri::command]
pub fn get_catalog(app: AppHandle, state: State<'_, AppState>) -> CatalogView {
    catalog_view(&app, &state)
}

/// Creates or updates a user-defined provider (Settings → Providers).
#[tauri::command]
pub fn save_custom_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    input: crate::providers::custom::CustomProviderInput,
) -> Result<CatalogView, String> {
    crate::providers::custom::save(&state.db, input).map_err(|error| error.to_string())?;
    Ok(catalog_view(&app, &state))
}

/// Removes a user-defined provider. The stored API key is preserved so
/// re-adding the same id keeps working offline.
#[tauri::command]
pub fn delete_custom_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<CatalogView, String> {
    crate::providers::custom::remove(&state.db, &provider_id).map_err(|error| error.to_string())?;
    Ok(catalog_view(&app, &state))
}

/// Refreshes the account model list of one provider and returns the merged view.
pub async fn refresh_provider_models_impl(
    app: &AppHandle,
    state: &AppState,
    provider_id: &str,
) -> anyhow::Result<CatalogView> {
    let provider = state
        .provider(provider_id)
        .ok_or_else(|| anyhow::anyhow!("provedor desconhecido: {provider_id}"))?;
    let remote = fetch_remote_models(app, state, &provider)
        .await
        .map_err(anyhow::Error::msg)?;
    let merged = merge_models(&provider, &remote);
    state.set_dynamic_models(provider_id, merged, crate::domain::now_ms());
    save_models_cache(app, state)?;
    Ok(catalog_view(app, state))
}

/// Fetches the live model list from every configured provider and reports when
/// the refresh happened (informational; the bundled metadata is preserved).
#[tauri::command]
pub async fn refresh_catalog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CatalogView, String> {
    let providers = state.catalog_with_plugins().providers;
    let mut refreshed = false;
    for provider in providers {
        if matches!(
            provider.transport,
            crate::catalog::ProviderTransport::Acp
        ) {
            continue;
        }
        if !provider.endpoints.contains_key("models") {
            continue;
        }
        match fetch_remote_models(&app, &state, &provider).await {
            Ok(remote) => {
                let merged = merge_models(&provider, &remote);
                state.set_dynamic_models(&provider.id, merged, crate::domain::now_ms());
                refreshed = true;
            }
            Err(error) => {
                // A missing credential is expected for unconfigured providers;
                // real failures stay visible in the provider validation UI.
                if !error.contains("nenhuma credencial") {
                    eprintln!("[catalog] {}: {error}", provider.id);
                }
            }
        }
    }
    if refreshed {
        let _ = save_models_cache(&app, &state);
    }
    let mut view = catalog_view(&app, &state);
    if !refreshed {
        view.remote_refreshed_at = refreshed_at(&state);
    }
    Ok(view)
}

#[tauri::command]
pub async fn list_remote_models(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let provider = state
        .provider(&provider_id)
        .ok_or_else(|| crate::i18n::t_args("models.errors.providerUnknown", &[("provider_id", &provider_id)]))?;
    let remote = fetch_remote_models(&app, &state, &provider).await?;
    Ok(remote.into_iter().map(|model| model.id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_the_account_shape_and_filters_visibility() {
        let document = json!({
            "models": [
                {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"},
                {"slug": "gpt-internal", "display_name": "Internal", "visibility": "hidden"},
                {"slug": "gpt-minimal"}
            ]
        });
        let models = parse_remote_models(&document);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-6.1-sol");
        assert_eq!(models[0].display_name.as_deref(), Some("GPT-6.1 Sol"));
        assert_eq!(models[1].id, "gpt-minimal");
    }

    #[test]
    fn parses_the_platform_api_shape() {
        let document = json!({"data": [{"id": "gpt-6-luna"}, {"id": "gpt-6-sol"}]});
        let models = parse_remote_models(&document);
        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["gpt-6-luna", "gpt-6-sol"]
        );
    }

    #[test]
    fn parses_the_anthropic_models_page_with_capabilities_and_cursor() {
        let document = json!({
            "data": [
                {
                    "id": "claude-opus-5-5",
                    "type": "model",
                    "display_name": "Claude Opus 5.5",
                    "created_at": "2026-09-21T00:00:00Z",
                    "lifecycle": "active",
                    "line": "opus",
                    "max_input_tokens": 1000000,
                    "max_tokens": 128000,
                    "capabilities": {
                        "effort": {
                            "supported": true,
                            "low": {"supported": true},
                            "medium": {"supported": true},
                            "high": {"supported": true},
                            "xhigh": {"supported": true},
                            "max": {"supported": true}
                        },
                        "thinking": {
                            "supported": true,
                            "types": {
                                "adaptive": {"supported": true},
                                "enabled": {"supported": true},
                                "disabled": {"supported": true}
                            }
                        },
                        "image_input": {"supported": true},
                        "pdf_input": {"supported": true}
                    }
                },
                {
                    "id": "claude-haiku-4-5",
                    "display_name": "Claude Haiku 4.5",
                    "max_input_tokens": 200000,
                    "max_tokens": 64000,
                    "capabilities": {
                        "effort": {"supported": false},
                        "thinking": {"supported": true},
                        "image_input": {"supported": true},
                        "pdf_input": {"supported": false}
                    }
                },
                {"id": "claude-retired", "lifecycle": "retired"}
            ],
            "first_id": "claude-opus-5-5",
            "has_more": true,
            "last_id": "claude-haiku-4-5"
        });
        let page = parse_remote_page(&document);
        // Retired models are history only: never selectable.
        assert_eq!(page.models.len(), 2);
        assert_eq!(page.next_after.as_deref(), Some("claude-haiku-4-5"));

        let opus = &page.models[0];
        assert_eq!(opus.context_window, Some(1_000_000));
        assert_eq!(opus.max_output, Some(128_000));
        assert_eq!(
            opus.reasoning_efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert!(opus.reasoning);
        assert!(opus.capabilities_reported);
        assert_eq!(
            opus.input_modalities,
            vec!["text", "image", "pdf"],
            "modalidades da conta"
        );
        assert!(opus.can_receive_images());

        let haiku = &page.models[1];
        assert_eq!(haiku.context_window, Some(200_000));
        assert!(haiku.reasoning_efforts.is_empty());
        assert!(haiku.reasoning);
        assert_eq!(haiku.input_modalities, vec!["text", "image"]);
    }

    #[test]
    fn openai_platform_page_has_no_cursor_and_no_capabilities() {
        let document = json!({"data": [{"id": "gpt-6-luna", "object": "model"}, {"id": "gpt-6-sol"}]});
        let page = parse_remote_page(&document);
        assert_eq!(page.models.len(), 2);
        assert!(page.next_after.is_none());
        assert!(!page.models[0].capabilities_reported);
        assert!(page.models[0].input_modalities.is_empty());
        assert!(page.models[0].context_window.is_none());
    }

    #[test]
    fn next_page_url_appends_the_cursor() {
        assert_eq!(
            next_page_url("https://api.anthropic.com/v1/models", "claude-x"),
            "https://api.anthropic.com/v1/models?after_id=claude-x"
        );
        assert_eq!(
            next_page_url("https://exemplo.test/models?limit=1000", "a"),
            "https://exemplo.test/models?limit=1000&after_id=a"
        );
    }

    #[test]
    fn merge_keeps_catalog_metadata_and_marks_unknown_models_estimated() {
        let catalog = crate::catalog::CatalogFile::load().expect("catalog");
        let provider = catalog.provider("openai").expect("openai");
        let merged = merge_models(
            provider,
            &[
                RemoteModel {
                    id: "gpt-6.1-sol".into(),
                    display_name: Some("GPT-6.1 Sol (conta)".into()),
                    ..RemoteModel::default()
                },
                RemoteModel {
                    id: "gpt-6.2-future".into(),
                    display_name: Some("GPT-6.2 Future".into()),
                    ..RemoteModel::default()
                },
            ],
        );
        let known = merged
            .iter()
            .find(|model| model.id == "gpt-6.1-sol")
            .expect("modelo do catálogo");
        assert!(!known.estimated);
        // Catalog metadata wins over the account display name.
        assert_eq!(known.name, "GPT-6.1 Sol");
        let unknown = merged
            .iter()
            .find(|model| model.id == "gpt-6.2-future")
            .expect("modelo da conta");
        assert!(unknown.estimated);
        assert_eq!(unknown.family, "gpt");
        assert_eq!(unknown.protocols, vec!["openai-responses".to_string()]);
        // Catalog-only models stay available as fallback.
        assert!(merged.iter().any(|model| model.id == "gpt-5.3-codex"));
    }

    #[test]
    fn estimated_anthropic_model_uses_the_account_capabilities() {
        let catalog = crate::catalog::CatalogFile::load().expect("catalog");
        let provider = catalog.provider("anthropic").expect("anthropic");
        let remote = RemoteModel {
            id: "claude-sonnet-6".into(),
            display_name: Some("Claude Sonnet 6".into()),
            context_window: Some(500_000),
            max_output: Some(64_000),
            input_modalities: vec!["text".into(), "image".into()],
            reasoning_efforts: vec!["low".into(), "high".into()],
            reasoning: true,
            capabilities_reported: true,
            ..RemoteModel::default()
        };
        let estimated = estimated_model(provider, &remote);
        assert!(estimated.estimated);
        assert_eq!(estimated.name, "Claude Sonnet 6");
        assert_eq!(estimated.family, "claude");
        assert_eq!(estimated.protocols, vec!["anthropic".to_string()]);
        assert_eq!(estimated.context_window, 500_000);
        assert_eq!(estimated.max_output, 64_000);
        assert!(estimated.attachment);
        assert_eq!(estimated.modalities.input, vec!["text", "image"]);
        assert_eq!(
            estimated.reasoning_options,
            vec![ReasoningOption::Effort {
                values: vec!["low".into(), "high".into()]
            }]
        );
        assert!(estimated.reasoning);
    }

    #[test]
    fn estimated_model_falls_back_to_the_provider_representative_metadata() {
        let catalog = crate::catalog::CatalogFile::load().expect("catalog");
        let provider = catalog.provider("anthropic").expect("anthropic");
        let representative = provider.models.first().expect("seed");
        let remote = RemoteModel {
            id: "claude-account-only".into(),
            ..RemoteModel::default()
        };
        let estimated = estimated_model(provider, &remote);
        assert_eq!(estimated.family, "claude");
        assert_eq!(estimated.protocols, vec!["anthropic".to_string()]);
        assert_eq!(estimated.context_window, representative.context_window);
        assert_eq!(estimated.max_output, representative.max_output);
        assert_eq!(estimated.attachment, representative.attachment);
        assert_eq!(estimated.reasoning_options, representative.reasoning_options);
    }

    #[test]
    fn missing_credential_message_is_provider_aware() {
        let catalog = crate::catalog::CatalogFile::load().expect("catalog");
        let openai = missing_credential_message(catalog.provider("openai").expect("openai"));
        assert!(openai.contains("ChatGPT"));
        assert!(openai.starts_with("nenhuma credencial"));

        let anthropic =
            missing_credential_message(catalog.provider("anthropic").expect("anthropic"));
        assert!(anthropic.starts_with("nenhuma credencial"));
        assert!(anthropic.contains("API key"));
        assert!(!anthropic.contains("ChatGPT"), "copy errada: {anthropic}");
    }

    #[test]
    fn parses_the_gemini_models_page() {
        let document = json!({
            "models": [
                {
                    "name": "models/gemini-4-carbon",
                    "baseModelId": "gemini-4-carbon",
                    "displayName": "Gemini 4 Carbon",
                    "inputTokenLimit": 1_048_576,
                    "outputTokenLimit": 65_536,
                    "supportedGenerationMethods": ["generateContent", "countTokens"],
                    "thinking": true
                },
                {
                    "name": "models/gemini-embedding-001",
                    "displayName": "Gemini Embedding",
                    "supportedGenerationMethods": ["embedContent"]
                }
            ],
            "nextPageToken": "page-2"
        });
        let page = parse_remote_page(&document);
        // Embedding-only models are not chat models.
        assert_eq!(page.models.len(), 1);
        let model = &page.models[0];
        assert_eq!(model.id, "gemini-4-carbon");
        assert_eq!(model.display_name.as_deref(), Some("Gemini 4 Carbon"));
        assert_eq!(model.context_window, Some(1_048_576));
        assert_eq!(model.max_output, Some(65_536));
        assert!(model.reasoning);
        assert_eq!(
            model.generation_methods,
            vec!["generateContent".to_string(), "countTokens".to_string()]
        );
        assert_eq!(page.next_page_token.as_deref(), Some("page-2"));
        assert!(page.next_after.is_none());
    }

    #[test]
    fn gemini_remote_filter_keeps_only_the_three_models() {
        for id in GEMINI_CHAT_MODELS {
            assert!(remote_model_allowed("gemini", id), "{id}");
        }
        for id in [
            "gemini-2.5-pro",
            "gemini-3.1-flash-image",
            "gemini-flash-latest",
            "gemini-3.8-flash-001",
        ] {
            assert!(!remote_model_allowed("gemini", id), "{id}");
        }
        assert!(remote_model_allowed("opencode-zen", "gemini-2.5-pro"));
    }

    #[test]
    fn next_page_token_url_replaces_the_previous_token() {
        assert_eq!(
            next_page_token_url("https://x.test/models?pageSize=1000", "A"),
            "https://x.test/models?pageSize=1000&pageToken=A"
        );
        assert_eq!(
            next_page_token_url(
                "https://x.test/models?pageSize=1000&pageToken=A",
                "B"
            ),
            "https://x.test/models?pageSize=1000&pageToken=B"
        );
        assert_eq!(
            next_page_token_url("https://x.test/models?pageToken=A", "B"),
            "https://x.test/models?pageToken=B"
        );
        assert_eq!(
            next_page_token_url("https://x.test/models", "a+b/c="),
            "https://x.test/models?pageToken=a%2Bb%2Fc%3D"
        );
    }
}
