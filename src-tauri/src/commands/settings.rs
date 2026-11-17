//! Settings, API keys, app info and code environment/skills commands
//! (implemented by the storage module).
//!
//! Credential handling is auth-mode aware: the OAuth ("Sign in with ChatGPT")
//! status comes from `crate::oauth` (derived from the store, never from the
//! network), while API keys keep the previous secrets-file/env/CLI resolution.
//! Tokens are never returned by these commands.

use std::path::Path;
use std::time::Duration;

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::catalog::ProviderInfo;
use crate::config::{self, StoredOAuthRegistration};
use crate::domain::{AppInfo, CodeEnvironmentStatus, ProviderValidation, Settings, SettingsView};
use crate::state::AppState;

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

/* ------------------------------------------------------------------ */
/* Settings view                                                       */
/* ------------------------------------------------------------------ */

fn settings_view(app: &AppHandle, state: &AppState) -> SettingsView {
    let provider_ids: Vec<String> = state
        .catalog_with_plugins()
        .providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect();
    SettingsView {
        settings: config::load_settings(app),
        keys: config::all_key_status(app, &provider_ids),
        // `oauth::statuses` is the single source of truth: one entry per catalog
        // provider (OAuth registration or API key), in catalog order.
        auth: state.auth_statuses(app),
        secrets_error: config::secrets_error(),
    }
}

/* ------------------------------------------------------------------ */
/* Settings + keys                                                     */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Result<SettingsView, String> {
    Ok(settings_view(&app, &state))
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<SettingsView, String> {
    config::save_settings(&app, &settings).map_err(to_error)?;
    state.plugins.apply_settings(&settings);
    crate::tray::sync(&app, &settings);
    Ok(settings_view(&app, &state))
}

/// Copy shown when the pasted key is too short to be a real API key.
fn api_key_validation_hint(provider: &ProviderInfo) -> String {
    // The catalog id is stable, so copy can be provider-specific without
    // guessing from URLs. Direct providers get their own console text; the
    // ChatGPT provider keeps the plan copy and the gateways the OpenCode copy.
    if provider.id == "gemini" {
        crate::i18n::t("settings.keys.hint.gemini")
    } else if provider.id == "anthropic" {
        crate::i18n::t("settings.keys.hint.anthropic")
    } else if provider.supports_oauth() {
        crate::i18n::t("settings.keys.hint.oauth")
    } else {
        crate::i18n::t("settings.keys.hint.generic")
    }
}

/// Validates/trims the API key of a provider. `None` means "remove the key".
fn normalize_provider_key(
    provider: &ProviderInfo,
    key: Option<String>,
) -> Result<Option<String>, String> {
    let key = key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    let Some(key) = key else {
        return Ok(None);
    };
    if key.starts_with("eyJ") && key.matches('.').count() == 2 {
        return Err(crate::i18n::t("settings.keys.sessionToken"));
    }
    let length = key.chars().count();
    if length < 20 {
        return Err(crate::i18n::t_args(
            "settings.keys.tooShort",
            &[
                ("length", &length.to_string()),
                ("hint", &api_key_validation_hint(provider)),
            ],
        ));
    }
    if key.chars().any(char::is_whitespace) {
        return Err(crate::i18n::t("settings.keys.whitespace"));
    }
    Ok(Some(key))
}

#[tauri::command]
pub fn set_provider_key(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    key: Option<String>,
) -> Result<SettingsView, String> {
    let provider = state
        .provider(&provider_id)
        .ok_or_else(|| {
            crate::i18n::t_args(
                "settings.errors.providerUnknown",
                &[("provider_id", &provider_id)],
            )
        })?;
    let key = normalize_provider_key(&provider, key)?;
    // `config` rewrites the whole v2 file, so the OAuth block is preserved.
    config::set_api_key(&app, &provider_id, key.as_deref()).map_err(to_error)?;
    Ok(settings_view(&app, &state))
}

/* ------------------------------------------------------------------ */
/* App info                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> Result<AppInfo, String> {
    let _ = &app;
    Ok(AppInfo {
        name: "Zylara".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        started_at: state.started_at,
        data_dir: state.data_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = config::data_dir(&app).map_err(to_error)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| {
            crate::i18n::t_args(
                "settings.errors.openDataDir",
                &[("error", &error.to_string())],
            )
        })
}

/* ------------------------------------------------------------------ */
/* Code environment & skills                                           */
/* ------------------------------------------------------------------ */

/// Detects Python/Node, optional packages and available skills.
///
/// The detection spawns interpreter processes (`--version`, `find_spec`), so it
/// runs on a blocking thread instead of the async IPC executor.
#[tauri::command]
pub async fn get_code_environment(app: AppHandle) -> Result<CodeEnvironmentStatus, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    let settings = config::load_settings(&app);
    tauri::async_runtime::spawn_blocking(move || {
        crate::tools::code_exec::environment_status(&data_dir, &settings)
    })
    .await
    .map_err(|error| {
        crate::i18n::t_args(
            "settings.errors.codeEnvironment",
            &[("error", &error.to_string())],
        )
    })
}

/// Opens `<app-data>/skills` (the user skills folder) in the OS file manager,
/// creating it first so the folder always exists when the explorer opens.
#[tauri::command]
pub fn open_skills_dir(app: AppHandle) -> Result<(), String> {
    let dir = config::data_dir(&app).map_err(to_error)?.join("skills");
    std::fs::create_dir_all(&dir).map_err(|error| {
        crate::i18n::t_args(
            "settings.errors.createSkillsDir",
            &[("path", &dir.display().to_string()), ("error", &error.to_string())],
        )
    })?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| {
            crate::i18n::t_args(
                "settings.errors.openSkillsDir",
                &[("error", &error.to_string())],
            )
        })
}

/* ------------------------------------------------------------------ */
/* Reset                                                               */
/* ------------------------------------------------------------------ */

fn clear_dir(path: &Path) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let entry_path = entry.path();
        if entry_path.is_dir() {
            std::fs::remove_dir_all(&entry_path)?;
        } else {
            std::fs::remove_file(&entry_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn reset_app_data(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Cancela turnos em andamento antes de apagar o banco: impede que o harness
    // grave linhas obsoletas no meio do reset.
    state.cancel_all();
    state.db.reset().map_err(to_error)?;
    // D13: apaga também o arquivo de credenciais (API keys + OAuth) e o cache de
    // modelos. O hook roda sob o lock de RMW do config, depois de cancelar
    // logins e refreshes pendentes: nada recria credenciais no meio do reset (N4).
    config::reset_credentials_with(&app, || state.cancel_oauth()).map_err(to_error)?;
    state.clear_dynamic_models();
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    for sub in ["attachments", "artifacts", "themes"] {
        clear_dir(&data_dir.join(sub)).map_err(|error| {
            crate::i18n::t_args(
                "settings.errors.clearDir",
                &[
                    ("path", &data_dir.join(sub).display().to_string()),
                    ("error", &error.to_string()),
                ],
            )
        })?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Provider validation                                                 */
/* ------------------------------------------------------------------ */

/// `GET` URL of the provider model list. The catalog endpoint is authoritative
/// (`ProviderInfo.endpoints["models"]`): for OpenAI the base already ends in
/// `/v1`, so the old `{base}/v1/models` hardcode would build `/v1/v1/models`.
/// Legacy gateways (Go/Zen) do not declare the endpoint and keep the old path.
fn models_endpoint(provider: &ProviderInfo) -> String {
    let base = provider.base_url.trim_end_matches('/');
    match provider
        .endpoints
        .get("models")
        .map(|endpoint| endpoint.trim())
        .filter(|endpoint| !endpoint.is_empty())
    {
        Some(endpoint) if endpoint.starts_with('/') => format!("{base}{endpoint}"),
        Some(endpoint) => format!("{base}/{endpoint}"),
        None => format!("{base}/v1/models"),
    }
}

/// Model count from both response shapes: `{"data":[…]}` (API-key gateways)
/// and `{"models":[…]}` (the ChatGPT-plan account list).
fn count_models(json: &serde_json::Value) -> u32 {
    let count = json
        .get("models")
        .and_then(serde_json::Value::as_array)
        .or_else(|| json.get("data").and_then(serde_json::Value::as_array))
        .map(Vec::len)
        .unwrap_or(0);
    u32::try_from(count).unwrap_or(u32::MAX)
}

fn credential_missing_message(provider: &ProviderInfo) -> String {
    if provider.supports_oauth() {
        crate::i18n::t_args(
            "settings.validation.missingOauth",
            &[("provider", &provider.name)],
        )
    } else {
        crate::i18n::t("settings.validation.missingKey")
    }
}

fn validate_status_message(provider: &ProviderInfo, status: u16, oauth: bool) -> String {
    match status {
        401 if oauth => crate::i18n::t("settings.validation.status401Oauth"),
        401 => crate::i18n::t_args(
            "settings.validation.status401",
            &[("hint", &api_key_validation_hint(provider))],
        ),
        402 if oauth => crate::i18n::t("settings.validation.status402Oauth"),
        402 if provider.id.starts_with("opencode-") => {
            crate::i18n::t("settings.validation.status402Opencode")
        }
        // Direct providers (Anthropic, OpenAI API key) must never see the
        // OpenCode credits copy.
        402 => crate::i18n::t("settings.validation.status402"),
        403 if oauth => crate::i18n::t("settings.validation.status403Oauth"),
        403 => crate::i18n::t("settings.validation.status403"),
        404 => crate::i18n::t("settings.validation.status404"),
        429 if oauth => crate::i18n::t("settings.validation.status429Oauth"),
        429 => crate::i18n::t("settings.validation.status429"),
        _ if (500..=599).contains(&status) => crate::i18n::t_args(
            "settings.validation.status5xx",
            &[("status", &status.to_string())],
        ),
        _ => crate::i18n::t_args(
            "settings.validation.statusOther",
            &[("status", &status.to_string())],
        ),
    }
}

fn validation_failure(
    provider_id: String,
    message: impl Into<String>,
    latency_ms: Option<u64>,
) -> ProviderValidation {
    ProviderValidation {
        provider_id,
        ok: false,
        message: Some(message.into()),
        latency_ms,
        models: 0,
    }
}

/// API-key resolution for validation: saved key → provider env → OpenCode CLI.
fn resolve_api_key(app: &AppHandle, provider: &ProviderInfo) -> Option<String> {
    config::api_key_from_secrets(app, &provider.id)
        .or_else(|| config::api_key_from_env(&provider.id, &provider.auth_env))
        .or_else(|| config::api_key_from_opencode_cli(&provider.id))
}

/// Actionable explanation when the stored OAuth account exists but cannot be
/// used for a request. An API key is still preferred when present; this copy is
/// only shown when there is no API key fallback either.
fn oauth_blocker_message(registration: &StoredOAuthRegistration) -> Option<String> {
    if registration.disconnected {
        Some(crate::i18n::t("settings.validation.oauthSignedOut"))
    } else if !registration.has_refresh_token() {
        Some(crate::i18n::t("settings.validation.oauthExpired"))
    } else if !registration.plan_usage {
        Some(crate::i18n::t("settings.validation.oauthPlanNotAuthorized"))
    } else {
        None
    }
}

/// Builds the model-list `GET` for a provider: Bearer credential, Zylara
/// User-Agent and the static headers declared by the catalog (e.g.
/// `anthropic-version` for the official Anthropic API).
///
/// Header names that belong to the transport/credential layer are skipped even
/// if a catalog declares them: static headers are data, never credentials.
fn models_request(
    client: &reqwest::Client,
    provider: &ProviderInfo,
    url: &str,
    token: &str,
) -> reqwest::RequestBuilder {
    let (header_name, header_value) = provider.credential_header(token);
    let mut request = client
        .get(url)
        .header(header_name.as_str(), header_value.as_str())
        .header("User-Agent", concat!("Zylara/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15));
    for (name, value) in provider.static_headers() {
        if matches!(
            name.as_str(),
            "authorization" | "user-agent" | "host" | "content-length"
        ) {
            continue;
        }
        request = request.header(name.as_str(), value.as_str());
    }
    request
}

async fn probe_models(
    state: &AppState,
    provider: &ProviderInfo,
    url: &str,
    token: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    models_request(&state.http, provider, url, token)
        .send()
        .await
}

/// Same probe as `validate_provider`, restricted to user-defined providers
/// (`custom__<slug>`) so the creation dialog can offer a "Test connection"
/// button without touching first-party or plugin-contributed providers.
#[tauri::command]
pub async fn test_custom_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<ProviderValidation, String> {
    if !crate::providers::custom::is_custom_id(&provider_id) {
        return Err(crate::i18n::t("settings.errors.providerUnknown").to_string());
    }
    validate_provider(app, state, provider_id).await
}

#[tauri::command]
pub async fn validate_provider(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<ProviderValidation, String> {
    let provider = state
        .provider(&provider_id)
        .ok_or_else(|| {
            crate::i18n::t_args(
                "settings.errors.providerUnknown",
                &[("provider_id", &provider_id)],
            )
        })?;
    let url = models_endpoint(&provider);

    // Credential order (PLAN §2.4): a usable OAuth registration (plan usage +
    // refresh token) wins; otherwise fall back to an API key and, only when
    // there is none, explain why the OAuth account cannot be used.
    let registration = if provider.supports_oauth() {
        config::oauth_registration(&app, &provider_id)
    } else {
        None
    };
    let oauth_usable = registration
        .as_ref()
        .is_some_and(|registration| registration.plan_usage && registration.has_refresh_token());
    let oauth_blocker = registration.as_ref().and_then(oauth_blocker_message);

    let mut auth_mode = "api-key";
    let mut token = if oauth_usable {
        match state.ensure_bearer(&app, &provider_id).await {
            Ok(token) => {
                auth_mode = "oauth";
                token
            }
            Err(error) => {
                return Ok(validation_failure(
                    provider_id,
                    crate::i18n::t_args(
                        "settings.validation.oauthUnusable",
                        &[("error", &format!("{error:#}"))],
                    ),
                    None,
                ));
            }
        }
    } else {
        match resolve_api_key(&app, &provider) {
            Some(key) => key,
            None => {
                let message =
                    oauth_blocker.unwrap_or_else(|| credential_missing_message(&provider));
                return Ok(validation_failure(provider_id, message, None));
            }
        }
    };

    let started = std::time::Instant::now();
    let mut response = probe_models(&state, &provider, &url, &token).await;

    // 401 on an OAuth request: force one refresh and retry once (PLAN §2.5).
    let unauthorized = response
        .as_ref()
        .ok()
        .map(|response| response.status().as_u16())
        == Some(401);
    if unauthorized && auth_mode == "oauth" {
        match state.force_refresh(&app, &provider_id).await {
            Ok(refreshed) => {
                token = refreshed;
                response = probe_models(&state, &provider, &url, &token).await;
            }
            Err(error) => {
                return Ok(validation_failure(
                    provider_id,
                    crate::i18n::t_args(
                        "settings.validation.refreshFailed",
                        &[("error", &format!("{error:#}"))],
                    ),
                    None,
                ));
            }
        }
    }
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    match response {
        Ok(response) if response.status().is_success() => {
            let models = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .map(|json| count_models(&json))
                .unwrap_or(0);
            let message = if auth_mode == "oauth" {
                crate::i18n::t_args(
                    "settings.validation.oauthValid",
                    &[("models", &models.to_string())],
                )
            } else {
                crate::i18n::t_args(
                    "settings.validation.valid",
                    &[("models", &models.to_string())],
                )
            };
            Ok(ProviderValidation {
                provider_id,
                ok: true,
                message: Some(message),
                latency_ms: Some(latency_ms),
                models,
            })
        }
        Ok(response) => {
            let status = response.status().as_u16();
            let message = validate_status_message(&provider, status, auth_mode == "oauth");
            Ok(validation_failure(provider_id, message, Some(latency_ms)))
        }
        Err(error) => {
            let message = if error.is_timeout() {
                crate::i18n::t("settings.validation.timeout")
            } else if error.is_connect() {
                crate::i18n::t_args(
                    "settings.validation.connect",
                    &[("url", &provider.base_url)],
                )
            } else {
                crate::i18n::t_args(
                    "settings.validation.network",
                    &[("error", &error.to_string())],
                )
            };
            Ok(validation_failure(provider_id, message, Some(latency_ms)))
        }
    }
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(json: &str) -> ProviderInfo {
        serde_json::from_str(json).expect("fixture de provedor válida")
    }

    fn openai_provider() -> ProviderInfo {
        provider(
            r#"{
                "id": "openai",
                "name": "OpenAI (ChatGPT)",
                "shortName": "ChatGPT",
                "baseUrl": "https://api.openai.com/v1",
                "endpoints": { "openai-responses": "/responses", "models": "/models" },
                "auth": "oauth",
                "requestProfiles": { "oauth": "chatgpt-plan", "apiKey": "standard" },
                "authEnv": "OPENAI_API_KEY",
                "defaultModelId": "gpt-6.1-sol",
                "oauth": {
                    "issuer": "https://auth.openai.com",
                    "registrationClientId": "dynamic_agent_client",
                    "agentNameHint": "Zylara",
                    "resource": "https://api.openai.com/v1",
                    "scopes": ["openid"],
                    "planUsageScope": "chatgpt.tokens.use.direct",
                    "callbackPath": "/auth/callback",
                    "loopbackHost": "127.0.0.1"
                },
                "models": []
            }"#,
        )
    }

    fn legacy_gateway_provider() -> ProviderInfo {
        provider(
            r#"{
                "id": "opencode-go",
                "name": "OpenCode Go",
                "shortName": "Go",
                "baseUrl": "https://opencode.ai/inference/go/",
                "endpoints": { "openai-chat": "/openai/v1/chat/completions" },
                "authEnv": "OPENCODE_API_KEY",
                "defaultModelId": "deepseek-v4.1-flash",
                "models": []
            }"#,
        )
    }

    fn anthropic_provider() -> ProviderInfo {
        provider(
            r#"{
                "id": "anthropic",
                "name": "Anthropic",
                "shortName": "Anthropic",
                "baseUrl": "https://api.anthropic.com/v1",
                "consoleUrl": "https://platform.claude.com/settings/keys",
                "endpoints": { "anthropic": "/messages", "models": "/models" },
                "headers": { "anthropic-version": "2026-10-21" },
                "authEnv": "ANTHROPIC_API_KEY",
                "defaultModelId": "claude-sonnet-5-5",
                "models": []
            }"#,
        )
    }

    #[test]
    fn models_endpoint_uses_the_catalog_path_without_duplicating_v1() {
        let url = models_endpoint(&openai_provider());
        assert_eq!(url, "https://api.openai.com/v1/models");
        assert!(!url.contains("/v1/v1/"), "regressão N2: {url}");
    }

    #[test]
    fn models_endpoint_keeps_the_legacy_path_for_gateways() {
        // Go/Zen do not declare a `models` endpoint; behavior must not change.
        assert_eq!(
            models_endpoint(&legacy_gateway_provider()),
            "https://opencode.ai/inference/go/v1/models"
        );
    }

    #[test]
    fn models_endpoint_accepts_a_relative_path_without_leading_slash() {
        let mut fixture = legacy_gateway_provider();
        fixture.base_url = "https://exemplo.test/api".to_string();
        fixture
            .endpoints
            .insert("models".to_string(), "models".to_string());
        assert_eq!(models_endpoint(&fixture), "https://exemplo.test/api/models");
    }

    #[test]
    fn embedded_catalog_openai_models_endpoint_is_correct() {
        // Real catalog (not a fixture): base already ends in `/v1`.
        let catalog = crate::catalog::CatalogFile::load().expect("catálogo embutido válido");
        let provider = catalog.provider("openai").expect("provedor openai");
        assert_eq!(
            models_endpoint(provider),
            "https://api.openai.com/v1/models"
        );
        assert!(!models_endpoint(provider).contains("/v1/v1/"));
    }

    #[test]
    fn models_endpoint_supports_the_direct_anthropic_api() {
        let url = models_endpoint(&anthropic_provider());
        assert_eq!(url, "https://api.anthropic.com/v1/models");
        assert!(!url.contains("/v1/v1/"), "base já termina em /v1: {url}");

        let catalog = crate::catalog::CatalogFile::load().expect("catálogo embutido válido");
        let provider = catalog.provider("anthropic").expect("provedor anthropic");
        assert_eq!(
            models_endpoint(provider),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn models_endpoint_supports_the_direct_gemini_api() {
        let catalog = crate::catalog::CatalogFile::load().expect("catálogo embutido válido");
        let provider = catalog.provider("gemini").expect("provedor gemini");
        let url = models_endpoint(provider);
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models"
        );

        let client = reqwest::Client::new();
        let request = models_request(&client, provider, &url, "AIza-test")
            .build()
            .expect("request válido");
        let headers = request.headers();
        let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        assert_eq!(header("x-goog-api-key"), Some("AIza-test"));
        assert!(header("authorization").is_none(), "Gemini não usa Bearer");
    }

    #[test]
    fn models_request_sends_bearer_static_headers_and_user_agent() {
        let client = reqwest::Client::new();
        let mut fixture = anthropic_provider();
        fixture
            .headers
            .insert("x-zylara-test".to_string(), "1".to_string());

        let request = models_request(
            &client,
            &fixture,
            "https://api.anthropic.com/v1/models",
            "sk-ant-test-key",
        )
        .build()
        .expect("request válido");
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(
            request.url().as_str(),
            "https://api.anthropic.com/v1/models"
        );

        let headers = request.headers();
        let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
        assert_eq!(header("authorization"), Some("Bearer sk-ant-test-key"));
        assert_eq!(header("anthropic-version"), Some("2026-10-21"));
        assert_eq!(header("x-zylara-test"), Some("1"));
        assert!(
            header("user-agent").is_some_and(|value| value.starts_with("Zylara/")),
            "User-Agent do Zylara ausente"
        );
    }

    #[test]
    fn static_catalog_headers_can_never_override_credentials() {
        let client = reqwest::Client::new();
        let mut fixture = anthropic_provider();
        // A catalog is data, not a credential source: these must be ignored.
        fixture
            .headers
            .insert("authorization".to_string(), "Bearer leaked".to_string());
        fixture
            .headers
            .insert("user-agent".to_string(), "intruso".to_string());

        let request = models_request(
            &client,
            &fixture,
            "https://api.anthropic.com/v1/models",
            "sk-ant-real-key",
        )
        .build()
        .expect("request válido");
        let headers = request.headers();
        assert_eq!(
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer sk-ant-real-key")
        );
        assert!(headers
            .get("user-agent")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("Zylara/")));
    }

    #[test]
    fn counts_both_documented_model_list_shapes() {
        let account: serde_json::Value =
            serde_json::from_str(r#"{"models":[{"slug":"a"},{"slug":"b"}]}"#).expect("json");
        assert_eq!(count_models(&account), 2);

        let gateway: serde_json::Value =
            serde_json::from_str(r#"{"data":[{"id":"a"},{"id":"b"},{"id":"c"}]}"#).expect("json");
        assert_eq!(count_models(&gateway), 3);

        let empty: serde_json::Value = serde_json::from_str("{}").expect("json");
        assert_eq!(count_models(&empty), 0);
    }

    #[test]
    fn validation_messages_are_auth_aware() {
        let openai = openai_provider();
        let oauth_401 = validate_status_message(&openai, 401, true);
        assert!(oauth_401.contains("ChatGPT"));
        assert!(oauth_401.contains("Entre novamente"));

        let key_401 = validate_status_message(&openai, 401, false);
        assert!(key_401.contains("API key inválida"));
        assert!(
            !key_401.contains("Entre novamente") && !key_401.contains("sessão"),
            "copy de sessão na chave: {key_401}"
        );

        let oauth_429 = validate_status_message(&openai, 429, true);
        assert!(oauth_429.contains("pode ser do seu plano ou deste app"));
        assert!(oauth_429.contains("Gerenciar uso"));

        let gateway_429 = validate_status_message(&legacy_gateway_provider(), 429, false);
        assert!(!gateway_429.contains("plano"));

        assert!(validate_status_message(&openai, 403, true).contains("permissão"));
        assert!(validate_status_message(&openai, 402, true).contains("Pagamento"));
        assert!(validate_status_message(&openai, 503, false).contains("503"));

        // Direct Anthropic API key: actionable key copy, never ChatGPT session
        // copy nor OpenCode credits.
        let anthropic = anthropic_provider();
        let anthropic_401 = validate_status_message(&anthropic, 401, false);
        assert!(anthropic_401.contains("API key inválida"));
        assert!(anthropic_401.contains("sk-ant-"));
        assert!(!anthropic_401.contains("ChatGPT"), "{anthropic_401}");
        assert!(!anthropic_401.contains("OpenCode"), "{anthropic_401}");

        let anthropic_402 = validate_status_message(&anthropic, 402, false);
        assert!(anthropic_402.contains("Pagamento"));
        assert!(!anthropic_402.contains("OpenCode"), "{anthropic_402}");

        let anthropic_429 = validate_status_message(&anthropic, 429, false);
        assert!(anthropic_429.contains("Muitas requisições"));
        assert!(!anthropic_429.contains("OpenCode"), "{anthropic_429}");

        // Gateways keep their provider-specific credits copy; OpenAI API key
        // must not borrow it.
        assert!(
            validate_status_message(&legacy_gateway_provider(), 402, false).contains("OpenCode")
        );
        let openai_402 = validate_status_message(&openai, 402, false);
        assert!(openai_402.contains("Pagamento"));
        assert!(!openai_402.contains("OpenCode"), "{openai_402}");
    }

    #[test]
    fn api_key_validation_copy_is_provider_aware() {
        let openai = openai_provider();
        let error = normalize_provider_key(&openai, Some("curta".to_string()))
            .expect_err("chave curta deve falhar");
        assert!(error.contains("plataforma"));
        assert!(!error.contains("OpenCode Console"), "copy errada: {error}");

        let gateway = legacy_gateway_provider();
        let error = normalize_provider_key(&gateway, Some("curta".to_string()))
            .expect_err("chave curta deve falhar");
        assert!(error.contains("OpenCode Console"));

        // Anthropic = direct official API: own console copy, no ChatGPT/OpenCode.
        let anthropic = anthropic_provider();
        let hint = api_key_validation_hint(&anthropic);
        assert!(hint.contains("Console da Anthropic"), "{hint}");
        assert!(hint.contains("sk-ant-"), "{hint}");
        assert!(!hint.contains("OpenCode"), "{hint}");
        assert!(!hint.contains("ChatGPT"), "{hint}");
        let error = normalize_provider_key(&anthropic, Some("curta".to_string()))
            .expect_err("chave curta deve falhar");
        assert!(error.contains("sk-ant-"), "{error}");
        let key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
        assert_eq!(
            normalize_provider_key(&anthropic, Some(key.to_string())).expect("chave sk-ant válida"),
            Some(key.to_string()),
            "chaves sk-ant-… com >= 20 caracteres são aceitas"
        );

        let error = normalize_provider_key(&openai, Some("sk-com espaço 1234567890".to_string()))
            .expect_err("espaços devem falhar");
        assert!(error.contains("espaços"));

        assert_eq!(
            normalize_provider_key(&openai, None).expect("vazio remove a chave"),
            None
        );
        assert_eq!(
            normalize_provider_key(&openai, Some("   ".to_string())).expect("só espaços"),
            None
        );
        assert_eq!(
            normalize_provider_key(&openai, Some("  sk-openai-1234567890abcdef  ".to_string()))
                .expect("chave válida"),
            Some("sk-openai-1234567890abcdef".to_string())
        );
    }

    #[test]
    fn set_provider_key_rejects_session_tokens() {
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.assinatura";
        // A session token is never an API key, for any provider.
        for fixture in [openai_provider(), legacy_gateway_provider()] {
            let error = normalize_provider_key(&fixture, Some(jwt.to_string()))
                .expect_err("token de sessão não é API key");
            assert!(error.contains("token de sessão"), "{error}");
        }
        let error = normalize_provider_key(&openai_provider(), Some(jwt.to_string()))
            .expect_err("token de sessão não é API key");
        assert!(error.contains("ChatGPT"), "{error}");
    }

    #[test]
    fn missing_credential_copy_mentions_both_auth_paths() {
        let message = credential_missing_message(&openai_provider());
        assert!(message.contains("ChatGPT"));
        assert!(message.contains("API key"));

        let message = credential_missing_message(&legacy_gateway_provider());
        assert!(message.contains("API key"));
        assert!(!message.contains("ChatGPT"));
    }

    #[test]
    fn oauth_blocker_explains_reauth_and_plan_activation() {
        let mut registration = StoredOAuthRegistration::default();
        registration.refresh_token = "refresh".to_string();
        registration.plan_usage = true;
        assert!(oauth_blocker_message(&registration).is_none());

        registration.disconnected = true;
        let message = oauth_blocker_message(&registration).expect("conta desconectada");
        assert!(message.contains("saiu da conta"));

        registration.disconnected = false;
        registration.refresh_token.clear();
        let message = oauth_blocker_message(&registration).expect("sessão expirada");
        assert!(message.contains("expirou"));

        registration.refresh_token = "refresh".to_string();
        registration.plan_usage = false;
        let message = oauth_blocker_message(&registration).expect("plano não autorizado");
        assert!(message.contains("não está autorizado"));
    }
}
