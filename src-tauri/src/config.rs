//! Application settings + credentials.
//!
//! Settings live in `<app-data>/settings.json`; credentials live in
//! `<app-data>/secrets.json` (never sent to the renderer in plain text).
//!
//! `secrets.json` v2 holds both the provider API keys and the OAuth
//! ("Sign in with ChatGPT") registrations. This module is the **single writer**
//! of that file: every mutation goes through a global read-modify-write
//! [`Mutex`], reloads the file first (so concurrent writers never lose an
//! update), writes atomically with a unique temp file (`secrets.<uuid>.tmp`,
//! owner-only on Unix) and never overwrites a corrupt file — it records/returns
//! an error, keeps the original bytes and leaves a `secrets.bak` copy behind.
//!
//! As a convenience the backend also detects keys from the OpenCode CLI
//! (`~/.local/share/opencode/auth.json`) and from the provider environment
//! variable (`OPENAI_API_KEY` for OpenAI, `OPENCODE_API_KEY` for Go/Zen; the
//! latter is kept as the legacy fallback).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Context};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::domain::{ProviderKeyStatus, Settings};

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

pub fn data_dir(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn settings_path(app: &AppHandle) -> PathBuf {
    data_dir(app)
        .map(|d| d.join("settings.json"))
        .unwrap_or_else(|_| PathBuf::from("settings.json"))
}

pub fn secrets_path(app: &AppHandle) -> PathBuf {
    data_dir(app)
        .map(|d| d.join("secrets.json"))
        .unwrap_or_else(|_| PathBuf::from("secrets.json"))
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/// Limites do tempo máximo de execução de código (`codeTimeoutSecs`), expostos
/// no slider da tela de configuração e aplicados também pelo `run_code`.
pub const CODE_TIMEOUT_MIN_SECS: u32 = 10;
pub const CODE_TIMEOUT_MAX_SECS: u32 = 600;

/// Integrated terminal font size bounds (px); mirrored by
/// `src/lib/terminalSettings.ts`.
pub const TERMINAL_FONT_SIZE_MIN: u32 = 8;
pub const TERMINAL_FONT_SIZE_MAX: u32 = 32;
/// Longest accepted custom terminal font-family string.
pub const TERMINAL_FONT_FAMILY_MAX_CHARS: usize = 200;

/// Retenção dos arquivos de spill (saída completa de tools) do harness de
/// código, em dias. Fora da faixa, o valor é clampado.
pub const SPILL_RETENTION_MIN_DAYS: u32 = 1;
pub const SPILL_RETENTION_MAX_DAYS: u32 = 365;

/// Tempo máximo para o usuário responder a uma aprovação do harness, em
/// segundos (30 s .. 1 h). Fora da faixa, o valor é clampado.
pub const APPROVAL_TIMEOUT_MIN_SECS: u32 = 30;
pub const APPROVAL_TIMEOUT_MAX_SECS: u32 = 3_600;

/// Versão do `settings.json`. Arquivos sem `settingsVersion` são v1.
///
/// v2 (harness de código): o default de fábrica do modo de permissão das novas
/// sessões do Code passa de `edit` (Editar) para `autonomous` (Autônomo) e o
/// campo ganha controle em Configurações → Ferramentas. Como o campo existia no
/// arquivo desde a v1.9 **sem** nenhuma UI, um `"edit"` persistido num arquivo
/// v1 é o default de fábrica antigo, não uma escolha do usuário — a migração de
/// leitura o converte (ver [`parse_settings_json`]).
///
/// v3 (computer use): a imagem gráfica passa de `zylara/computer:latest` (tag
/// de build local, nunca publicada) para a imagem publicada no GHCR. Um valor
/// igual ao default antigo é migrado uma única vez; imagens customizadas são
/// preservadas.
const SETTINGS_VERSION: u32 = 3;

/// Normaliza a lista de skills desativadas vinda do disco ou do renderer:
/// `trim`, descarta entradas vazias, remove duplicatas e ordena (a comparação
/// com o catálogo é por nome canônico). `skills_panel_enabled` é booleano e não
/// precisa de transformação.
pub(crate) fn normalize_disabled_skills(names: Vec<String>) -> Vec<String> {
    let mut names: Vec<String> = names
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// Clamp/repair values coming from disk or from the renderer so the UI never
/// has to deal with out-of-range settings.
///
/// Booleanos de preferência (como `thinking_collapsed_by_default`) são
/// preservados como vieram do disco/renderer: não há transformação a aplicar.
fn normalize_settings(mut settings: Settings) -> Settings {
    let defaults = Settings::default();

    if !settings.font_scale.is_finite() {
        settings.font_scale = defaults.font_scale;
    }
    settings.font_scale = settings.font_scale.clamp(0.85, 1.3);

    settings.terminal_font_family = settings
        .terminal_font_family
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(TERMINAL_FONT_FAMILY_MAX_CHARS)
        .collect();
    settings.terminal_font_size = settings
        .terminal_font_size
        .clamp(TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX);

    if !matches!(settings.theme.as_str(), "light" | "dark" | "system") {
        settings.theme = defaults.theme;
    }
    if !crate::themes::is_valid_theme_id(&settings.theme_id) {
        settings.theme_id = crate::themes::BUILTIN_THEME_ID.to_string();
    }
    settings.locale = crate::i18n::normalize_language(&settings.locale).to_string();
    if !matches!(settings.send_key.as_str(), "enter" | "ctrl+enter") {
        settings.send_key = defaults.send_key;
    }
    if !matches!(
        settings.reasoning_default.as_str(),
        "auto" | "off" | "low" | "medium" | "high" | "max"
    ) {
        settings.reasoning_default = defaults.reasoning_default;
    }
    if settings.default_provider.trim().is_empty() {
        settings.default_provider = defaults.default_provider;
    }
    if settings.default_model.trim().is_empty() {
        settings.default_model = defaults.default_model;
    }
    settings.code_timeout_secs = settings
        .code_timeout_secs
        .clamp(CODE_TIMEOUT_MIN_SECS, CODE_TIMEOUT_MAX_SECS);
    settings.code_python_path = settings.code_python_path.trim().to_string();
    settings.code_node_path = settings.code_node_path.trim().to_string();
    settings.disabled_skills =
        normalize_disabled_skills(std::mem::take(&mut settings.disabled_skills));

    // Harness de código (docs/goals/code-harness/PLAN.md §7). Os booleanos
    // `shell_enabled`/`auto_compact`/`notifications_enabled`/
    // `trust_workspaces_by_default` são preferências do usuário: preservados
    // como vieram (o default seguro de cada um já está em `Settings::default`).
    // `code_default_permission_mode` é enum tipado: valores inválidos no JSON
    // são tratados na leitura (`parse_settings_json`).
    settings.execution_environment = match settings
        .execution_environment
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "docker" => "docker".to_string(),
        _ => "local".to_string(),
    };
    settings.docker_image = settings.docker_image.trim().to_string();
    if settings.docker_image.is_empty() || settings.docker_image.chars().count() > 200 {
        settings.docker_image = defaults.docker_image;
    }
    settings.computer_environment =
        crate::agents::normalize_computer_environment(&settings.computer_environment);
    for field in [
        &mut settings.browser_allowed_domains,
        &mut settings.browser_blocked_domains,
        &mut settings.computer_allowed_apps,
        &mut settings.computer_blocked_apps,
    ] {
        *field = field
            .iter()
            .map(|domain| domain.trim().to_ascii_lowercase())
            .filter(|domain| !domain.is_empty() && domain.chars().count() <= 253)
            .take(200)
            .collect();
    }
    settings.docker_memory_mb = settings.docker_memory_mb.clamp(256, 16_384);
    settings.docker_cpus = settings.docker_cpus.clamp(0.25, 16.0);
    settings.docker_pids_limit = settings.docker_pids_limit.clamp(32, 4_096);
    settings.max_concurrent_turns = settings.max_concurrent_turns.clamp(1, 32);
    settings.max_concurrent_turns_per_agent = settings.max_concurrent_turns_per_agent.clamp(1, 4);
    settings.max_queue_length_per_thread = settings.max_queue_length_per_thread.clamp(1, 100);
    match settings.agent_daily_cost_limit_usd {
        Some(value) if !value.is_finite() || value <= 0.0 => {
            settings.agent_daily_cost_limit_usd = None;
        }
        Some(value) => {
            settings.agent_daily_cost_limit_usd = Some(value.min(10_000.0));
        }
        None => {}
    }
    settings.computer_docker_image = settings.computer_docker_image.trim().to_string();
    if settings.computer_docker_image.is_empty()
        || settings.computer_docker_image.chars().count() > 200
    {
        settings.computer_docker_image = defaults.computer_docker_image;
    }
    settings.computer_docker_container = settings.computer_docker_container.trim().to_string();
    if settings.computer_docker_container.is_empty()
        || !settings
            .computer_docker_container
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        settings.computer_docker_container = defaults.computer_docker_container;
    }
    settings.computer_max_actions_per_turn = settings.computer_max_actions_per_turn.clamp(1, 200);
    settings.computer_max_actions_per_hour = settings.computer_max_actions_per_hour.clamp(1, 2_000);
    settings.spill_retention_days = settings
        .spill_retention_days
        .clamp(SPILL_RETENTION_MIN_DAYS, SPILL_RETENTION_MAX_DAYS);
    settings.approval_timeout_secs = settings
        .approval_timeout_secs
        .clamp(APPROVAL_TIMEOUT_MIN_SECS, APPROVAL_TIMEOUT_MAX_SECS);
    // Diff do arquivo: aba do chat (padrão) ou painel lateral. Qualquer outro
    // valor cai no padrão para a UI nunca ficar num estado impossível.
    settings.diff_open_mode = match settings
        .diff_open_mode
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "panel" => "panel".into(),
        _ => "tab".into(),
    };
    // Provider resilience: every value is clamped so the UI cannot park a turn.
    settings.provider_headers_timeout_secs =
        settings.provider_headers_timeout_secs.clamp(30, 600);
    settings.provider_first_event_timeout_secs =
        settings.provider_first_event_timeout_secs.clamp(30, 900);
    settings.provider_idle_timeout_secs = settings.provider_idle_timeout_secs.clamp(15, 600);
    settings.provider_total_timeout_secs =
        settings.provider_total_timeout_secs.min(7_200);
    settings.provider_max_retries = settings.provider_max_retries.min(8);
    settings.provider_retry_base_delay_ms =
        settings.provider_retry_base_delay_ms.clamp(100, 5_000);
    settings.provider_retry_max_delay_ms =
        settings.provider_retry_max_delay_ms.clamp(500, 60_000);
    settings.provider_retry_max_elapsed_ms =
        settings.provider_retry_max_elapsed_ms.min(600_000);
    settings.provider_retry_after_cap_ms =
        settings.provider_retry_after_cap_ms.clamp(1_000, 600_000);
    settings.plugin_registry_url = settings
        .plugin_registry_url
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(2_000)
        .collect();
    settings
}

/// Parse tolerante de `settings.json`.
///
/// `Settings` carrega enums (`codeDefaultPermissionMode`); um valor inválido
/// gravado à mão faria o `serde` falhar o arquivo inteiro e `load_settings`
/// cair em `Settings::default()`, apagando todas as preferências. Aqui a chave
/// inválida é removida antes da tipagem, então só ela volta ao default.
///
/// Também aplica as migrações de leitura:
/// - v1 → v2: arquivos sem `settingsVersion` (ou v1) trocam o `"edit"` legado do
///   modo de permissão do Code pelo novo default `"autonomous"`;
/// - v2 → v3: a tag local antiga do computer use (`zylara/computer:latest`) vira
///   a imagem publicada no GHCR. Valores customizados são preservados.
fn parse_settings_json(raw: &str) -> Result<Settings, serde_json::Error> {
    let mut value: serde_json::Value = serde_json::from_str(raw)?;
    if let Some(object) = value.as_object_mut() {
        let version = object
            .get("settingsVersion")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if version < 2 {
            let legacy_default = object
                .get("codeDefaultPermissionMode")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|mode| mode.trim() == "edit");
            if legacy_default {
                object.insert(
                    "codeDefaultPermissionMode".to_string(),
                    serde_json::Value::String("autonomous".to_string()),
                );
            }
        }
        if version < u64::from(SETTINGS_VERSION) {
            let legacy_computer_image = object
                .get("computerDockerImage")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|image| image.trim() == "zylara/computer:latest");
            if legacy_computer_image {
                object.insert(
                    "computerDockerImage".to_string(),
                    serde_json::Value::String(
                        crate::domain::DEFAULT_COMPUTER_DOCKER_IMAGE.to_string(),
                    ),
                );
            }
        }
        if !object.contains_key("locale") {
            // Files predating the `locale` field were all pt-BR.
            object.insert(
                "locale".to_string(),
                serde_json::Value::String("pt-BR".to_string()),
            );
        } else if !object
            .get("locale")
            .is_some_and(serde_json::Value::is_string)
        {
            object.remove("locale");
        }
        let invalid_mode = object
            .get("codeDefaultPermissionMode")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|mode| {
                !matches!(
                    mode.trim(),
                    "read_only" | "review" | "edit" | "autonomous"
                )
            });
        if invalid_mode {
            object.remove("codeDefaultPermissionMode");
        }
    }
    serde_json::from_value(value)
}

/// Serializa as configurações normalizadas já com a versão do schema.
///
/// `settingsVersion` **não** faz parte de [`Settings`] (não trafega no IPC):
/// existe só no arquivo, para que as migrações de leitura saibam distinguir um
/// default antigo de uma escolha do usuário.
fn serialize_settings_json(settings: &Settings) -> anyhow::Result<String> {
    let mut value = serde_json::to_value(settings).context(crate::i18n::t("config.errors.serializeSettings"))?;
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "settingsVersion".to_string(),
            serde_json::Value::from(SETTINGS_VERSION),
        );
    }
    serde_json::to_string_pretty(&value).context(crate::i18n::t("config.errors.serializeSettings"))
}

pub fn load_settings(app: &AppHandle) -> Settings {
    let path = settings_path(app);
    let settings = match std::fs::read_to_string(&path) {
        Ok(raw) => parse_settings_json(&raw)
            .map(normalize_settings)
            .unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    crate::i18n::set_language(&settings.locale);
    settings
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> anyhow::Result<()> {
    let normalized = normalize_settings(settings.clone());
    let raw = serialize_settings_json(&normalized)?;
    write_private(&settings_path(app), &raw)?;
    crate::i18n::set_language(&normalized.locale);
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Private/atomic file writes                                          */
/* ------------------------------------------------------------------ */

/// Writes a file atomically and, where the platform supports it, with
/// owner-only permissions. On Windows `%APPDATA%` is already ACL-restricted to
/// the current user, so the default ACL is kept.
///
/// The temp file has a unique name so concurrent writers can never step on each
/// other's temporary file. A crash between create and rename may leave one
/// behind; [`reset_credentials_at`] removes those leftovers.
fn write_private(path: &Path, contents: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("falha ao criar {}", parent.display()))?;
        }
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!(crate::i18n::t_args(
            "config.errors.invalidPath",
            &[("path", &path.display().to_string())],
        )))?;
    let tmp = path.with_file_name(format!(
        "{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));

    let result = match write_private_tmp(&tmp, contents) {
        Ok(()) => {
            if std::fs::rename(&tmp, path).is_err() {
                // Same-volume rename is atomic on Windows and Unix; the fallback
                // only exists for exotic filesystems.
                let fallback = std::fs::write(path, contents)
                    .with_context(|| format!("falha ao gravar {}", path.display()));
                let _ = std::fs::remove_file(&tmp);
                fallback.map(|_| tighten_permissions(path))
            } else {
                Ok(())
            }
        }
        Err(error) => Err(error),
    };
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_private_tmp(tmp: &Path, contents: &str) -> anyhow::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(tmp)
        .with_context(|| format!("falha ao escrever {}", tmp.display()))?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn tighten_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn tighten_permissions(_path: &Path) {}

fn remove_stale_temp_files(path: &Path) {
    let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!("{}.", file_name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) && name.ends_with(".tmp") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/* ------------------------------------------------------------------ */
/* Secrets (v2 — the single writer of `<app-data>/secrets.json`)       */
/* ------------------------------------------------------------------ */

/// Current on-disk credentials schema. v1 files (no `version`/`oauth`) are
/// loaded transparently and rewritten as v2 on the next mutation.
pub const SECRETS_VERSION: u32 = 2;

/// Placeholder used by `Debug` implementations so tokens can never leak into a
/// log line through `{credentials:?}`.
const REDACTED: &str = "<redacted>";

/// `<app-data>/secrets.json`:
///
/// ```json
/// {
///   "version": 2,
///   "providers": { "opencode-go": "sk-…" },
///   "oauth": {
///     "hostId": "urn:uuid:…",
///     "active": { "openai": "oaiapp_…" },
///     "registrations": {
///       "openai": {
///         "oaiapp_…": {
///           "email": "user@example.com", "issuer": "https://auth.openai.com",
///           "subject": "…", "clientId": "oaiapp_…",
///           "extAgentHostId": "urn:uuid:…", "idToken": "…",
///           "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer",
///           "expiresIn": 3600, "scopes": ["…"],
///           "savedAt": 1700000000000, "earliestRefreshAt": null,
///           "planUsage": true, "disconnected": false
///         }
///       }
///     }
///   },
///   "github": { "token": "ghp_…", "login": "octocat", "scopes": ["repo"] }
/// }
/// ```
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SecretsFile {
    pub version: u32,
    pub providers: BTreeMap<String, String>,
    pub oauth: OAuthStore,
    /// GitHub account used by the PR/Issue tabs. Additive block: builds that do
    /// not know it simply ignore the key (`#[serde(default)]`).
    pub github: GitHubSecrets,
    /// Plugin secrets under `plugin:<id>:<key>`. Values never cross the IPC
    /// boundary; RPC calls can only test existence or inject the secret into a
    /// mediated HTTP request.
    pub plugins: BTreeMap<String, String>,
}

impl Default for SecretsFile {
    fn default() -> Self {
        Self {
            version: SECRETS_VERSION,
            providers: BTreeMap::new(),
            oauth: OAuthStore::default(),
            github: GitHubSecrets::default(),
            plugins: BTreeMap::new(),
        }
    }
}

impl std::fmt::Debug for SecretsFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretsFile")
            .field("version", &self.version)
            .field("providers", &self.providers.keys().collect::<Vec<_>>())
            .field("oauth", &self.oauth)
            .field("github", &self.github)
            .field(
                "plugins",
                &self.plugins.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// GitHub personal access token plus the metadata resolved when it was saved.
///
/// The token is only ever read by the backend: IPC commands expose `login` and
/// `scopes`, never the secret itself.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitHubSecrets {
    pub token: Option<String>,
    /// Login returned by `GET /user` during validation.
    pub login: Option<String>,
    /// Scopes reported by the `x-oauth-scopes` header.
    pub scopes: Vec<String>,
    /// Unix ms of the last successful validation (`0` = unknown).
    pub saved_at: i64,
}

impl std::fmt::Debug for GitHubSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitHubSecrets")
            .field("token", &self.token.as_ref().map(|_| REDACTED))
            .field("login", &self.login)
            .field("scopes", &self.scopes)
            .field("saved_at", &self.saved_at)
            .finish()
    }
}

/// OAuth block of `secrets.json`: one stable host id plus the registrations
/// keyed by provider and issued `client_id`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OAuthStore {
    /// `urn:uuid:<v4>` generated once per installation.
    pub host_id: Option<String>,
    /// provider id -> active `client_id` (`oaiapp_…`).
    pub active: BTreeMap<String, String>,
    /// provider id -> (`client_id` -> registration).
    pub registrations: BTreeMap<String, BTreeMap<String, StoredOAuthRegistration>>,
}

impl OAuthStore {
    pub fn active_client_id(&self, provider_id: &str) -> Option<&str> {
        self.active.get(provider_id).map(String::as_str)
    }

    pub fn registration(
        &self,
        provider_id: &str,
        client_id: &str,
    ) -> Option<&StoredOAuthRegistration> {
        self.registrations
            .get(provider_id)
            .and_then(|registrations| registrations.get(client_id))
    }

    /// Active registration of a provider (mapping is retained on sign-out).
    pub fn active_registration(&self, provider_id: &str) -> Option<&StoredOAuthRegistration> {
        let client_id = self.active_client_id(provider_id)?;
        self.registration(provider_id, client_id)
    }

    /// Inserts a registration and makes its `client_id` active. The mapping
    /// (email/subject/client id/host id) survives sign-out; only tokens go away.
    pub fn save_registration(
        &mut self,
        provider_id: &str,
        registration: StoredOAuthRegistration,
    ) -> anyhow::Result<()> {
        let client_id = registration.client_id.trim().to_string();
        if client_id.is_empty() {
            bail!("registro OAuth sem clientId");
        }
        self.active
            .insert(provider_id.to_string(), client_id.clone());
        self.registrations
            .entry(provider_id.to_string())
            .or_default()
            .insert(client_id, registration);
        Ok(())
    }

    /// Sign-out: deletes only the tokens and marks the account disconnected.
    /// Returns `false` when there is no active registration to clear.
    pub fn clear_tokens(&mut self, provider_id: &str) -> bool {
        let Some(client_id) = self.active.get(provider_id).cloned() else {
            return false;
        };
        let Some(registration) = self
            .registrations
            .get_mut(provider_id)
            .and_then(|registrations| registrations.get_mut(&client_id))
        else {
            return false;
        };
        registration.id_token.clear();
        registration.access_token.clear();
        registration.refresh_token.clear();
        registration.disconnected = true;
        true
    }
}

/// One credential set for one account/client id. Tokens are persisted here and
/// are **never** serialized to the renderer; `Debug` redacts them.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredOAuthRegistration {
    pub email: Option<String>,
    pub issuer: String,
    pub subject: String,
    pub client_id: String,
    pub ext_agent_host_id: String,
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub scopes: Vec<String>,
    /// Unix milliseconds when the tokens were obtained.
    pub saved_at: i64,
    /// Optional server hint; refresh is skipped before this instant.
    pub earliest_refresh_at: Option<String>,
    /// The `chatgpt.tokens.use.direct` scope was granted.
    pub plan_usage: bool,
    /// Signed out: tokens cleared, mapping retained.
    pub disconnected: bool,
}

impl Default for StoredOAuthRegistration {
    fn default() -> Self {
        Self {
            email: None,
            issuer: String::new(),
            subject: String::new(),
            client_id: String::new(),
            ext_agent_host_id: String::new(),
            id_token: String::new(),
            access_token: String::new(),
            refresh_token: String::new(),
            token_type: "Bearer".to_string(),
            expires_in: 0,
            scopes: Vec::new(),
            saved_at: 0,
            earliest_refresh_at: None,
            plan_usage: false,
            disconnected: false,
        }
    }
}

impl std::fmt::Debug for StoredOAuthRegistration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredOAuthRegistration")
            .field("email", &self.email)
            .field("issuer", &self.issuer)
            .field("subject", &self.subject)
            .field("client_id", &self.client_id)
            .field("ext_agent_host_id", &self.ext_agent_host_id)
            .field("id_token", &REDACTED)
            .field("access_token", &REDACTED)
            .field("refresh_token", &REDACTED)
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("scopes", &self.scopes)
            .field("saved_at", &self.saved_at)
            .field("earliest_refresh_at", &self.earliest_refresh_at)
            .field("plan_usage", &self.plan_usage)
            .field("disconnected", &self.disconnected)
            .finish()
    }
}

impl StoredOAuthRegistration {
    /// True when the account can be refreshed without a new login.
    pub fn has_refresh_token(&self) -> bool {
        !self.refresh_token.trim().is_empty()
    }

    /// Absolute expiry (Unix ms) of the current access token, when known.
    pub fn expires_at_ms(&self) -> Option<i64> {
        if self.saved_at <= 0 || self.expires_in == 0 {
            return None;
        }
        let lifetime = i64::try_from(self.expires_in).ok()?.checked_mul(1000)?;
        self.saved_at.checked_add(lifetime)
    }
}

/// Last `secrets.json` load error, cached in memory because the read commands
/// (`get_settings`, `get_catalog`, `api_key`, …) are synchronous and infallible.
/// Set by a failed load; cleared only by an explicit reset.
fn secrets_error_slot() -> &'static Mutex<Option<String>> {
    static SLOT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

pub fn secrets_error() -> Option<String> {
    secrets_error_slot().lock().clone()
}

fn remember_secrets_error(message: impl Into<String>) {
    *secrets_error_slot().lock() = Some(message.into());
}

fn clear_secrets_error() {
    *secrets_error_slot().lock() = None;
}

fn credentials_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn is_not_found(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

/// Reads and parses the credentials file.
///
/// * `Ok(None)` — the file does not exist yet (fresh install).
/// * `Err(_)` — unreadable or corrupt: callers must **not** write over it.
fn read_secrets_at(path: &Path) -> anyhow::Result<Option<SecretsFile>> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let secrets = serde_json::from_str::<SecretsFile>(&raw).with_context(|| {
                crate::i18n::t_args(
                    "config.errors.invalidCredentialsJson",
                    &[("path", &path.display().to_string())],
                )
            })?;
            Ok(Some(secrets))
        }
        Err(error) if is_not_found(&error) => Ok(None),
        Err(error) => Err(error).with_context(|| {
            crate::i18n::t_args(
                "config.errors.readFile",
                &[("path", &path.display().to_string())],
            )
        }),
    }
}

/// Best-effort copy of a corrupt file, created once (never overwritten) before
/// any future write could destroy the original bytes.
fn backup_corrupt_at(path: &Path) {
    if !path.exists() {
        return;
    }
    let backup = path.with_extension("bak");
    if backup.exists() {
        return;
    }
    let _ = std::fs::copy(path, backup);
}

/// Read for infallible call sites: corrupt content yields a default store (the
/// error is remembered for `SettingsView.secretsError`) and a `.bak` copy.
fn load_secrets_reporting(path: &Path) -> SecretsFile {
    match read_secrets_at(path) {
        Ok(Some(secrets)) => secrets,
        Ok(None) => SecretsFile::default(),
        Err(error) => {
            remember_secrets_error(format!("{error:#}"));
            backup_corrupt_at(path);
            SecretsFile::default()
        }
    }
}

fn load_secrets(app: &AppHandle) -> SecretsFile {
    load_secrets_reporting(&secrets_path(app))
}

/// Read for write paths: a corrupt file is reported as an error and preserved.
fn read_secrets_for_write_at(path: &Path) -> anyhow::Result<SecretsFile> {
    match read_secrets_at(path) {
        Ok(Some(secrets)) => Ok(secrets),
        Ok(None) => Ok(SecretsFile::default()),
        Err(error) => {
            let message = format!("{error:#}");
            remember_secrets_error(&message);
            backup_corrupt_at(path);
            bail!(crate::i18n::t_args(
                "config.errors.credentialsCorrupt",
                &[("error", &message)],
            ))
        }
    }
}

fn save_secrets_at(path: &Path, secrets: &SecretsFile) -> anyhow::Result<()> {
    let raw =
        serde_json::to_string_pretty(secrets).context("falha ao serializar as credenciais")?;
    write_private(path, &raw)
}

/// Read-only view of the OAuth store for the sync IPC commands. The second
/// value is the corruption error (if any) so callers can surface it instead of
/// silently showing an empty store.
pub fn oauth_snapshot(app: &AppHandle) -> (OAuthStore, Option<String>) {
    oauth_snapshot_at(&secrets_path(app))
}

fn oauth_snapshot_at(path: &Path) -> (OAuthStore, Option<String>) {
    match read_secrets_at(path) {
        Ok(Some(secrets)) => (secrets.oauth, None),
        Ok(None) => (OAuthStore::default(), None),
        Err(error) => {
            let message = format!("{error:#}");
            remember_secrets_error(&message);
            backup_corrupt_at(path);
            (OAuthStore::default(), Some(message))
        }
    }
}

fn update_oauth_at<T>(
    path: &Path,
    f: impl FnOnce(&mut OAuthStore) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let _guard = credentials_lock().lock();
    let mut secrets = read_secrets_for_write_at(path)?;
    let value = f(&mut secrets.oauth)?;
    secrets.version = SECRETS_VERSION;
    save_secrets_at(path, &secrets)?;
    Ok(value)
}

/// Serialized read-modify-write of the OAuth block.
///
/// The file is reloaded **inside** the global lock, so two concurrent callers
/// (login finishing, token refresh, another IPC command) can never lose each
/// other's update. A corrupt file is never overwritten: the call fails and the
/// original bytes are preserved (plus a `.bak` copy).
pub fn update_oauth<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut OAuthStore) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    update_oauth_at(&secrets_path(app), f)
}

fn normalized_host_id(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn ensure_host_id_at(path: &Path) -> anyhow::Result<String> {
    // Fast path: never rewrite the file when the id is already persisted.
    if let Ok(Some(secrets)) = read_secrets_at(path) {
        if let Some(host_id) = normalized_host_id(secrets.oauth.host_id.as_deref()) {
            return Ok(host_id);
        }
    }
    update_oauth_at(path, |oauth| {
        if let Some(host_id) = normalized_host_id(oauth.host_id.as_deref()) {
            return Ok(host_id);
        }
        let host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        oauth.host_id = Some(host_id.clone());
        Ok(host_id)
    })
}

/// Stable, opaque `urn:uuid:<v4>` host id used as `ext_agent_host_id` in the
/// Sign in with ChatGPT flow. Persisted once and reused forever.
pub fn ensure_host_id(app: &AppHandle) -> anyhow::Result<String> {
    ensure_host_id_at(&secrets_path(app))
}

fn save_oauth_registration_at(
    path: &Path,
    provider_id: &str,
    mut registration: StoredOAuthRegistration,
) -> anyhow::Result<()> {
    update_oauth_at(path, |oauth| {
        if registration.ext_agent_host_id.trim().is_empty() {
            if let Some(host_id) = normalized_host_id(oauth.host_id.as_deref()) {
                registration.ext_agent_host_id = host_id;
            }
        }
        oauth.save_registration(provider_id, registration)
    })
}

/// Persists one OAuth registration and marks its `client_id` as active.
pub fn save_oauth_registration(
    app: &AppHandle,
    provider_id: &str,
    registration: StoredOAuthRegistration,
) -> anyhow::Result<()> {
    save_oauth_registration_at(&secrets_path(app), provider_id, registration)
}

fn clear_oauth_tokens_at(path: &Path, provider_id: &str) -> anyhow::Result<()> {
    update_oauth_at(path, |oauth| {
        oauth.clear_tokens(provider_id);
        Ok(())
    })
}

/// Sign-out primitive: revokes nothing (that is the OAuth module's job), only
/// clears the local tokens while retaining the account/client-id mapping.
pub fn clear_oauth_tokens(app: &AppHandle, provider_id: &str) -> anyhow::Result<()> {
    clear_oauth_tokens_at(&secrets_path(app), provider_id)
}

/// Active registration of a provider (the mapping is retained on sign-out), if
/// any. Never derives auth state; callers own that policy.
pub fn oauth_registration(app: &AppHandle, provider_id: &str) -> Option<StoredOAuthRegistration> {
    oauth_snapshot(app)
        .0
        .active_registration(provider_id)
        .cloned()
}

/// Active registration that can be used without a new login: needs a refresh
/// token and the ChatGPT plan-usage scope.
pub fn usable_oauth_registration(
    app: &AppHandle,
    provider_id: &str,
) -> Option<StoredOAuthRegistration> {
    oauth_registration(app, provider_id)
        .filter(|registration| registration.plan_usage && registration.has_refresh_token())
}

fn reset_credentials_at<T>(path: &Path, before: impl FnOnce() -> T) -> anyhow::Result<()> {
    let _guard = credentials_lock().lock();
    // Run cancellation hooks (pending OAuth login/refresh) while holding the
    // same lock writers need, so nothing can recreate credentials mid-reset.
    let _ = before();
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if is_not_found(&error) => {}
        Err(error) => {
            return Err(error).with_context(|| format!("falha ao remover {}", path.display()))
        }
    }
    // An explicit reset is the only operation allowed to discard the preserved
    // copy of a corrupt file (it may contain credentials).
    let _ = std::fs::remove_file(path.with_extension("bak"));
    remove_stale_temp_files(path);
    clear_secrets_error();
    Ok(())
}

/// Deletes `secrets.json` (API keys **and** OAuth registrations), its `.bak`
/// copy and any stale temp file, and clears the remembered load error.
pub fn reset_credentials(app: &AppHandle) -> anyhow::Result<()> {
    reset_credentials_with(app, || ())
}

/// Same as [`reset_credentials`], but runs `before` inside the credentials RMW
/// lock (used by `reset_app_data` to cancel pending OAuth work without
/// deadlocking on the same lock).
pub fn reset_credentials_with<T>(
    app: &AppHandle,
    before: impl FnOnce() -> T,
) -> anyhow::Result<()> {
    reset_credentials_at(&secrets_path(app), before)
}

/* ------------------------------------------------------------------ */
/* Key resolution (API keys)                                           */
/* ------------------------------------------------------------------ */

/// `~/.local/share/opencode/auth.json` (`%USERPROFILE%` on Windows).
fn opencode_auth_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            let mut combined = PathBuf::from(drive);
            combined.push(path);
            Some(combined.into_os_string())
        })?;
    Some(
        PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json"),
    )
}

/// Maps a Zylara provider id to the entry id used by the OpenCode CLI.
fn cli_entry_ids(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "opencode-go" => &["opencode-go"],
        "opencode-zen" => &["opencode", "opencode-zen"],
        _ => &[],
    }
}

/// Environment variable each provider uses by default when the catalog did not
/// provide one (`ProviderInfo.authEnv`). The legacy shared `OPENCODE_API_KEY`
/// remains the fallback for the Go/Zen gateways.
fn default_auth_env(provider_id: &str) -> &'static str {
    match provider_id {
        "openai" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => "OPENCODE_API_KEY",
    }
}

fn env_key(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn clean_key(value: Option<&String>) -> Option<String> {
    value
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

/// API key stored in `secrets.json` for this provider.
pub fn api_key_from_secrets(app: &AppHandle, provider_id: &str) -> Option<String> {
    api_key_from_secrets_file(&load_secrets(app), provider_id)
}

fn api_key_from_secrets_file(secrets: &SecretsFile, provider_id: &str) -> Option<String> {
    clean_key(secrets.providers.get(provider_id))
}

/// Provider-aware env lookup. `auth_env` comes from `ProviderInfo.authEnv`; when
/// empty the built-in default for the provider is used. The OpenCode gateways
/// keep the legacy shared `OPENCODE_API_KEY` fallback.
pub fn api_key_from_env(provider_id: &str, auth_env: &str) -> Option<String> {
    let declared = auth_env.trim();
    let name = if declared.is_empty() {
        default_auth_env(provider_id)
    } else {
        declared
    };
    if let Some(key) = env_key(name) {
        return Some(key);
    }
    // Google SDKs also accept GOOGLE_API_KEY; keep it as the second choice.
    if provider_id == "gemini" && name != "GOOGLE_API_KEY" {
        if let Some(key) = env_key("GOOGLE_API_KEY") {
            return Some(key);
        }
    }
    if name != "OPENCODE_API_KEY" && matches!(provider_id, "opencode-go" | "opencode-zen") {
        return env_key("OPENCODE_API_KEY");
    }
    None
}

/// Key detected from the OpenCode CLI login (`auth.json`); only Go/Zen have
/// entries there, every other provider returns `None`.
pub fn api_key_from_opencode_cli(provider_id: &str) -> Option<String> {
    let path = opencode_auth_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    for entry_id in cli_entry_ids(provider_id) {
        let Some(entry) = value.get(*entry_id) else {
            continue;
        };
        let key = entry
            .get("key")
            .and_then(|key| key.as_str())
            .or_else(|| entry.as_str())
            .map(str::trim)
            .filter(|key| !key.is_empty());
        if let Some(key) = key {
            return Some(key.to_string());
        }
    }
    None
}

/// Resolves a key and its origin: settings | env | opencode-cli | none.
fn resolve_key(app: &AppHandle, provider_id: &str) -> (Option<String>, &'static str) {
    let secrets = load_secrets(app);
    if let Some(key) = api_key_from_secrets_file(&secrets, provider_id) {
        return (Some(key), "settings");
    }
    if let Some(key) = api_key_from_env(provider_id, default_auth_env(provider_id)) {
        return (Some(key), "env");
    }
    if let Some(key) = api_key_from_opencode_cli(provider_id) {
        return (Some(key), "opencode-cli");
    }
    (None, "none")
}

/// Reads a key from the secrets file / environment / OpenCode CLI, in that order.
pub fn api_key(app: &AppHandle, provider_id: &str) -> Option<String> {
    resolve_key(app, provider_id).0
}

fn set_api_key_at(path: &Path, provider_id: &str, key: Option<&str>) -> anyhow::Result<()> {
    let _guard = credentials_lock().lock();
    let mut secrets = read_secrets_for_write_at(path)?;
    match key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => {
            secrets
                .providers
                .insert(provider_id.to_string(), key.to_string());
        }
        None => {
            secrets.providers.remove(provider_id);
        }
    }
    // v1 files are silently migrated to v2; the OAuth block is preserved.
    secrets.version = SECRETS_VERSION;
    save_secrets_at(path, &secrets)
}

/// Stores/removes the API key of a provider. The OAuth block is preserved.
pub fn set_api_key(app: &AppHandle, provider_id: &str, key: Option<&str>) -> anyhow::Result<()> {
    set_api_key_at(&secrets_path(app), provider_id, key)
}

/* ------------------------------------------------------------------ */
/* Plugin secrets                                                      */
/* ------------------------------------------------------------------ */

/// Namespaced key used in `secrets.json`: `plugin:<id>:<key>`.
pub fn plugin_secret_key(plugin_id: &str, key: &str) -> String {
    format!("plugin:{plugin_id}:{key}")
}

fn valid_secret_part(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 120
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn set_plugin_secret_at(
    path: &Path,
    plugin_id: &str,
    key: &str,
    value: Option<&str>,
) -> anyhow::Result<()> {
    if !valid_secret_part(plugin_id) || !valid_secret_part(key) {
        bail!("invalid plugin secret namespace");
    }
    let _guard = credentials_lock().lock();
    let mut secrets = read_secrets_for_write_at(path)?;
    let name = plugin_secret_key(plugin_id, key);
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if value.chars().count() > 8_192 {
                bail!("plugin secret is too large");
            }
            secrets.plugins.insert(name, value.to_string());
        }
        None => {
            secrets.plugins.remove(&name);
        }
    }
    secrets.version = SECRETS_VERSION;
    save_secrets_at(path, &secrets)
}

pub fn set_plugin_secret(
    app: &AppHandle,
    plugin_id: &str,
    key: &str,
    value: Option<&str>,
) -> anyhow::Result<()> {
    set_plugin_secret_at(&secrets_path(app), plugin_id, key, value)
}

fn plugin_secret_from_file(secrets: &SecretsFile, plugin_id: &str, key: &str) -> Option<String> {
    secrets
        .plugins
        .get(&plugin_secret_key(plugin_id, key))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn plugin_secret(app: &AppHandle, plugin_id: &str, key: &str) -> Option<String> {
    plugin_secret_from_file(&load_secrets(app), plugin_id, key)
}

pub fn plugin_secret_names(app: &AppHandle, plugin_id: &str) -> Vec<String> {
    let prefix = format!("plugin:{plugin_id}:");
    let secrets = load_secrets(app);
    let mut names: Vec<String> = secrets
        .plugins
        .keys()
        .filter_map(|key| key.strip_prefix(&prefix).map(str::to_string))
        .collect();
    names.sort();
    names
}

pub fn delete_plugin_secrets(app: &AppHandle, plugin_id: &str) -> anyhow::Result<()> {
    let path = secrets_path(app);
    let _guard = credentials_lock().lock();
    let mut secrets = read_secrets_for_write_at(&path)?;
    let prefix = format!("plugin:{plugin_id}:");
    secrets.plugins.retain(|key, _| !key.starts_with(&prefix));
    save_secrets_at(&path, &secrets)
}

/* ------------------------------------------------------------------ */
/* GitHub credentials                                                  */
/* ------------------------------------------------------------------ */

/// Token resolution shared by the commands: secrets file → env → `gh` CLI.
///
/// The CLI lookup is passed as a closure so the process call stays in the async
/// command layer and this function stays pure for tests.
pub fn resolve_github_token(
    secrets: &GitHubSecrets,
    env: Option<String>,
    cli: impl FnOnce() -> Option<String>,
) -> (Option<String>, &'static str) {
    if let Some(token) = clean_key(secrets.token.as_ref()) {
        return (Some(token), "settings");
    }
    if let Some(token) = env.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        return (Some(token), "env");
    }
    match cli().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        Some(token) => (Some(token), "gh-cli"),
        None => (None, "none"),
    }
}

/// `GH_TOKEN` first, then the legacy `GITHUB_TOKEN` (gh CLI precedence).
pub fn github_token_from_env() -> Option<String> {
    env_key("GH_TOKEN").or_else(|| env_key("GITHUB_TOKEN"))
}

/// Credentials stored in `secrets.json` (no env/CLI fallback).
pub fn github_secrets(app: &AppHandle) -> GitHubSecrets {
    load_secrets(app).github
}

fn set_github_credentials_at(
    path: &Path,
    token: Option<&str>,
    login: Option<&str>,
    scopes: &[String],
) -> anyhow::Result<()> {
    let _guard = credentials_lock().lock();
    let mut secrets = read_secrets_for_write_at(path)?;
    match token.map(str::trim).filter(|token| !token.is_empty()) {
        Some(token) => {
            secrets.github.token = Some(token.to_string());
            secrets.github.login = login
                .map(str::trim)
                .filter(|login| !login.is_empty())
                .map(str::to_string);
            secrets.github.scopes = scopes.to_vec();
            secrets.github.saved_at = crate::domain::now_ms();
        }
        None => secrets.github = GitHubSecrets::default(),
    }
    secrets.version = SECRETS_VERSION;
    save_secrets_at(path, &secrets)
}

/// Stores/removes the GitHub token. Providers and OAuth registrations are kept.
pub fn set_github_credentials(
    app: &AppHandle,
    token: Option<&str>,
    login: Option<&str>,
    scopes: &[String],
) -> anyhow::Result<()> {
    set_github_credentials_at(&secrets_path(app), token, login, scopes)
}

/// Masked identifier shown in the UI. Keys are never logged or returned whole.
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 16 {
        return "••••••".to_string();
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn key_status_with<F>(secrets: &SecretsFile, provider_id: &str, fallback: F) -> ProviderKeyStatus
where
    F: FnOnce() -> Option<(String, &'static str)>,
{
    // Credential order (PLAN §2.4): an active OAuth registration shadows the API
    // key for status purposes. `has_key` only means "usable without network"
    // (refresh token present), never "access token valid right now" (SF-10).
    if let Some(registration) = secrets.oauth.active_registration(provider_id) {
        let has_key = registration.has_refresh_token();
        return ProviderKeyStatus {
            provider_id: provider_id.to_string(),
            has_key,
            masked: None,
            source: if has_key { "chatgpt" } else { "none" }.to_string(),
            mode: "oauth".to_string(),
        };
    }
    if let Some(key) = api_key_from_secrets_file(secrets, provider_id) {
        return ProviderKeyStatus {
            provider_id: provider_id.to_string(),
            has_key: true,
            masked: Some(mask_key(&key)),
            source: "settings".to_string(),
            mode: "api-key".to_string(),
        };
    }
    match fallback() {
        Some((key, source)) => ProviderKeyStatus {
            provider_id: provider_id.to_string(),
            has_key: true,
            masked: Some(mask_key(&key)),
            source: source.to_string(),
            mode: "api-key".to_string(),
        },
        None => ProviderKeyStatus {
            provider_id: provider_id.to_string(),
            has_key: false,
            masked: None,
            source: "none".to_string(),
            mode: "api-key".to_string(),
        },
    }
}

/// Status of the credential(s) of one provider (`has_key` = usable offline).
pub fn key_status(app: &AppHandle, provider_id: &str) -> ProviderKeyStatus {
    let secrets = load_secrets(app);
    key_status_with(&secrets, provider_id, || {
        api_key_from_env(provider_id, default_auth_env(provider_id))
            .map(|key| (key, "env"))
            .or_else(|| api_key_from_opencode_cli(provider_id).map(|key| (key, "opencode-cli")))
    })
}

pub fn all_key_status(app: &AppHandle, providers: &[String]) -> Vec<ProviderKeyStatus> {
    providers.iter().map(|p| key_status(app, p)).collect()
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("zylara-config-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("criar pasta temporária");
            Self { path }
        }

        fn secrets(&self) -> PathBuf {
            self.path.join("secrets.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Serializes the tests that mutate/observe the process-wide `secrets_error`
    /// slot and starts each one from a clean slot. Without this, a parallel test
    /// that calls `reset_credentials_at` (which clears the slot) can clear it
    /// between a corrupt-read `remember_secrets_error` and its assertion.
    fn error_slot_guard() -> parking_lot::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let guard = LOCK.get_or_init(|| Mutex::new(())).lock();
        clear_secrets_error();
        guard
    }

    fn registration(client_id: &str) -> StoredOAuthRegistration {
        StoredOAuthRegistration {
            email: Some("user@example.com".to_string()),
            issuer: "https://auth.openai.com".to_string(),
            subject: "subject-123".to_string(),
            client_id: client_id.to_string(),
            ext_agent_host_id: "urn:uuid:11111111-2222-3333-4444-555555555555".to_string(),
            id_token: "id-token-secret".to_string(),
            access_token: "access-token-secret".to_string(),
            refresh_token: "refresh-token-secret".to_string(),
            token_type: "Bearer".to_string(),
            expires_in: 3600,
            scopes: vec![
                "openid".to_string(),
                "chatgpt.tokens.use.direct".to_string(),
            ],
            saved_at: 1_700_000_000_000,
            earliest_refresh_at: Some("2026-01-01T00:00:00Z".to_string()),
            plan_usage: true,
            disconnected: false,
        }
    }

    #[test]
    fn masks_keys_without_revealing_them() {
        let key = "sk-opencode-1234567890abcdef";
        let masked = mask_key(key);
        assert!(masked.starts_with("sk-ope"));
        assert!(masked.ends_with("cdef"));
        assert!(!masked.contains("1234567890"));
        assert_eq!(mask_key("short"), "••••••");
    }

    #[test]
    fn v1_secrets_file_loads_and_migrates_to_v2() {
        let temp = TempDir::new();
        let path = temp.secrets();
        std::fs::write(&path, r#"{"providers":{"opencode-go":"sk-go-123"}}"#).expect("gravar v1");

        let file = read_secrets_at(&path)
            .expect("v1 deve desserializar")
            .expect("arquivo existe");
        assert_eq!(file.version, SECRETS_VERSION);
        assert_eq!(
            file.providers.get("opencode-go").map(String::as_str),
            Some("sk-go-123")
        );
        assert!(file.oauth.active.is_empty());
        assert!(file.oauth.registrations.is_empty());

        update_oauth_at(&path, |oauth| {
            oauth.host_id = Some("urn:uuid:migrated".to_string());
            Ok(())
        })
        .expect("migrar para v2");

        let raw = std::fs::read_to_string(&path).expect("ler arquivo migrado");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("JSON válido");
        assert_eq!(value["version"].as_u64(), Some(u64::from(SECRETS_VERSION)));
        assert_eq!(value["providers"]["opencode-go"], "sk-go-123");
        assert_eq!(value["oauth"]["hostId"], "urn:uuid:migrated");
    }

    #[test]
    fn empty_secrets_file_uses_v2_defaults() {
        let secrets: SecretsFile = serde_json::from_str("{}").expect("{ } é válido");
        assert_eq!(secrets.version, SECRETS_VERSION);
        assert!(secrets.providers.is_empty());
        assert!(secrets.oauth.host_id.is_none());
    }

    #[test]
    fn concurrent_rmw_does_not_lose_updates() {
        let temp = TempDir::new();
        let path = std::sync::Arc::new(temp.secrets());
        std::fs::write(path.as_path(), r#"{"providers":{"opencode-go":"sk-go"}}"#)
            .expect("gravar semente");

        std::thread::scope(|scope| {
            for worker in 0..2 {
                let path = std::sync::Arc::clone(&path);
                scope.spawn(move || {
                    for turn in 0..10 {
                        update_oauth_at(path.as_path(), |oauth| {
                            let client_id = format!("client-{worker}-{turn}");
                            let mut entry = registration(&client_id);
                            entry.client_id = client_id.clone();
                            oauth
                                .registrations
                                .entry("openai".to_string())
                                .or_default()
                                .insert(client_id, entry);
                            Ok(())
                        })
                        .expect("RMW concorrente");
                    }
                });
            }
        });

        let file = read_secrets_at(path.as_path())
            .expect("ler credenciais")
            .expect("arquivo existe");
        let registrations = file
            .oauth
            .registrations
            .get("openai")
            .expect("provedor openai presente");
        assert_eq!(
            registrations.len(),
            20,
            "atualização perdida entre threads: {registrations:?}"
        );
        assert_eq!(
            file.providers.get("opencode-go").map(String::as_str),
            Some("sk-go")
        );
    }

    #[test]
    fn corrupt_file_is_preserved_and_backed_up() {
        let _guard = error_slot_guard();
        let temp = TempDir::new();
        let path = temp.secrets();
        let original = "{ isto não é json";
        std::fs::write(&path, original).expect("gravar corrompido");

        assert!(read_secrets_at(&path).is_err());
        let error = update_oauth_at(&path, |_| Ok(())).expect_err("gravação deve ser recusada");
        assert!(format!("{error:#}").contains("corrompid"));
        assert_eq!(
            std::fs::read_to_string(&path).expect("original preservado"),
            original
        );
        let backup = path.with_extension("bak");
        assert_eq!(
            std::fs::read_to_string(&backup).expect(".bak criado"),
            original
        );
        // The remembered error feeds `SettingsView.secretsError`.
        assert!(secrets_error().is_some());

        // A second attempt does not overwrite the preserved .bak either.
        let _ = update_oauth_at(&path, |_| Ok(()));
        assert_eq!(
            std::fs::read_to_string(&backup).expect(".bak preservado"),
            original
        );

        // An explicit reset is the only path that discards both files.
        reset_credentials_at(&path, || ()).expect("reset");
        assert!(!path.exists());
        assert!(!backup.exists());
        assert!(secrets_error().is_none());
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let temp = TempDir::new();
        let path = temp.secrets();
        save_oauth_registration_at(&path, "openai", registration("oaiapp_1"))
            .expect("gravar registro");

        let entries = std::fs::read_dir(&temp.path)
            .expect("listar pasta")
            .map(|entry| {
                entry
                    .expect("entrada")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert!(
            !entries.iter().any(|name| name.ends_with(".tmp")),
            "sobrou arquivo temporário: {entries:?}"
        );
        assert!(entries.iter().any(|name| name == "secrets.json"));
    }

    #[test]
    fn reset_removes_stale_temp_files() {
        // Reset clears the global error slot: serialize with the tests that
        // observe it (see `error_slot_guard`).
        let _guard = error_slot_guard();
        let temp = TempDir::new();
        let path = temp.secrets();
        let stale = path.with_file_name(format!("secrets.json.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&stale, "resto-de-escrita").expect("gravar tmp antigo");

        reset_credentials_at(&path, || ()).expect("reset");
        assert!(!stale.exists(), "tmp órfão deve ser removido no reset");
    }

    #[test]
    fn sign_out_keeps_mapping_and_clears_tokens() {
        let temp = TempDir::new();
        let path = temp.secrets();
        save_oauth_registration_at(&path, "openai", registration("oaiapp_1"))
            .expect("salvar login");

        clear_oauth_tokens_at(&path, "openai").expect("sign-out");

        let secrets = read_secrets_at(&path)
            .expect("ler credenciais")
            .expect("arquivo existe");
        assert_eq!(
            secrets.oauth.active.get("openai").map(String::as_str),
            Some("oaiapp_1")
        );
        let registration = secrets
            .oauth
            .active_registration("openai")
            .expect("mapping retido");
        assert!(registration.access_token.is_empty());
        assert!(registration.refresh_token.is_empty());
        assert!(registration.id_token.is_empty());
        assert!(registration.disconnected);
        // The mapping needed by the next login is retained.
        assert_eq!(registration.client_id, "oaiapp_1");
        assert_eq!(registration.email.as_deref(), Some("user@example.com"));
        assert_eq!(registration.subject, "subject-123");
        assert_eq!(registration.issuer, "https://auth.openai.com");
        assert!(!registration.ext_agent_host_id.is_empty());
    }

    #[test]
    fn set_api_key_preserves_oauth_and_update_oauth_preserves_providers() {
        let temp = TempDir::new();
        let path = temp.secrets();

        save_oauth_registration_at(&path, "openai", registration("oaiapp_1"))
            .expect("salvar login");
        set_api_key_at(&path, "openai", Some("sk-openai-1234567890abcdef"))
            .expect("salvar API key");
        update_oauth_at(&path, |oauth| {
            assert_eq!(oauth.host_id, None, "ensure_host_id ainda não rodou");
            oauth.host_id = Some("urn:uuid:host".to_string());
            Ok(())
        })
        .expect("atualizar oauth");

        let secrets = read_secrets_at(&path)
            .expect("ler credenciais")
            .expect("arquivo existe");
        assert_eq!(
            secrets.providers.get("openai").map(String::as_str),
            Some("sk-openai-1234567890abcdef")
        );
        assert_eq!(secrets.oauth.host_id.as_deref(), Some("urn:uuid:host"));
        let registration = secrets
            .oauth
            .active_registration("openai")
            .expect("registro preservado");
        assert_eq!(registration.refresh_token, "refresh-token-secret");

        // Removing the API key must not touch the OAuth block either.
        set_api_key_at(&path, "openai", None).expect("remover API key");
        let secrets = read_secrets_at(&path)
            .expect("ler credenciais")
            .expect("arquivo existe");
        assert!(!secrets.providers.contains_key("openai"));
        assert!(secrets.oauth.active_registration("openai").is_some());
    }

    #[test]
    fn github_credentials_are_additive_and_preserve_other_blocks() {
        let temp = TempDir::new();
        let path = temp.secrets();

        save_oauth_registration_at(&path, "openai", registration("oaiapp_1"))
            .expect("salvar login");
        set_api_key_at(&path, "opencode-go", Some("sk-go-1234567890abcdef")).expect("salvar chave");

        set_github_credentials_at(
            &path,
            Some("ghp_1234567890abcdef"),
            Some("octocat"),
            &["repo".to_string(), "read:org".to_string()],
        )
        .expect("salvar token do GitHub");

        let secrets = read_secrets_at(&path)
            .expect("ler credenciais")
            .expect("arquivo existe");
        assert_eq!(secrets.providers.get("opencode-go").map(String::as_str), Some("sk-go-1234567890abcdef"));
        assert!(secrets.oauth.active_registration("openai").is_some());
        assert_eq!(secrets.github.token.as_deref(), Some("ghp_1234567890abcdef"));
        assert_eq!(secrets.github.login.as_deref(), Some("octocat"));
        assert_eq!(secrets.github.scopes, vec!["repo", "read:org"]);
        assert!(secrets.github.saved_at > 0);

        // Signing out clears only the GitHub block.
        set_github_credentials_at(&path, None, None, &[]).expect("remover token");
        let secrets = read_secrets_at(&path)
            .expect("ler credenciais")
            .expect("arquivo existe");
        assert!(secrets.github.token.is_none());
        assert!(secrets.github.login.is_none());
        assert!(secrets.github.scopes.is_empty());
        assert_eq!(secrets.providers.get("opencode-go").map(String::as_str), Some("sk-go-1234567890abcdef"));
        assert!(secrets.oauth.active_registration("openai").is_some());
    }

    #[test]
    fn github_token_debug_never_leaks_the_secret() {
        let secrets = GitHubSecrets {
            token: Some("ghp_supersecretvalue".to_string()),
            login: Some("octocat".to_string()),
            scopes: vec!["repo".to_string()],
            saved_at: 1,
        };
        let rendered = format!("{secrets:?}");
        assert!(!rendered.contains("ghp_supersecretvalue"));
        assert!(rendered.contains(REDACTED));
        assert!(format!("{:?}", SecretsFile { github: secrets, ..SecretsFile::default() })
            .contains(REDACTED));
    }

    #[test]
    fn github_token_resolution_prefers_secrets_then_env_then_cli() {
        let saved = GitHubSecrets {
            token: Some("  ghp_settings  ".to_string()),
            ..GitHubSecrets::default()
        };
        let (token, source) = resolve_github_token(&saved, Some("ghp_env".to_string()), || {
            Some("ghp_cli".to_string())
        });
        assert_eq!(token.as_deref(), Some("ghp_settings"));
        assert_eq!(source, "settings");

        let empty = GitHubSecrets::default();
        let (token, source) = resolve_github_token(&empty, Some("ghp_env".to_string()), || None);
        assert_eq!(token.as_deref(), Some("ghp_env"));
        assert_eq!(source, "env");

        let (token, source) = resolve_github_token(&empty, Some("   ".to_string()), || {
            Some(" ghp_cli ".to_string())
        });
        assert_eq!(token.as_deref(), Some("ghp_cli"));
        assert_eq!(source, "gh-cli");

        let (token, source) = resolve_github_token(&empty, None, || None);
        assert!(token.is_none());
        assert_eq!(source, "none");
    }

    #[test]
    fn host_id_is_stable_and_well_formed() {
        let temp = TempDir::new();
        let path = temp.secrets();

        let first = ensure_host_id_at(&path).expect("gerar host id");
        let second = ensure_host_id_at(&path).expect("reusar host id");
        assert_eq!(first, second);
        let suffix = first.strip_prefix("urn:uuid:").expect("prefixo urn:uuid:");
        assert!(
            uuid::Uuid::parse_str(suffix).is_ok(),
            "host id não é uuid v4"
        );

        // A normal credential write must not rotate the host id.
        set_api_key_at(&path, "opencode-go", Some("sk-go-1234567890abcdef")).expect("chave");
        let after = ensure_host_id_at(&path).expect("host id após escrita");
        assert_eq!(after, first);
    }

    #[test]
    fn oauth_snapshot_reports_corruption_without_overwriting() {
        let _guard = error_slot_guard();
        let temp = TempDir::new();
        let path = temp.secrets();
        std::fs::write(&path, "corrompido").expect("gravar corrompido");

        let (store, error) = oauth_snapshot_at(&path);
        assert!(error.is_some());
        assert!(store.host_id.is_none());
        assert!(path.with_extension("bak").exists());
        assert_eq!(
            std::fs::read_to_string(&path).expect("original"),
            "corrompido"
        );
        assert!(secrets_error().is_some());
    }

    #[test]
    fn credential_debug_output_redacts_tokens() {
        let registration = registration("oaiapp_1");
        let debug = format!("{registration:?}");
        for secret in [
            "id-token-secret",
            "access-token-secret",
            "refresh-token-secret",
        ] {
            assert!(!debug.contains(secret), "token vazou no Debug: {debug}");
        }

        let mut secrets = SecretsFile::default();
        secrets
            .providers
            .insert("openai".to_string(), "sk-super-secret".to_string());
        secrets
            .oauth
            .save_registration("openai", registration)
            .expect("registro");
        let debug = format!("{secrets:?}");
        assert!(!debug.contains("sk-super-secret"));
        assert!(!debug.contains("refresh-token-secret"));
    }

    #[test]
    fn registration_serializes_camel_case_and_defaults() {
        let registration = registration("oaiapp_1");
        let value = serde_json::to_value(&registration).expect("serializar registro");
        assert_eq!(value["clientId"], "oaiapp_1");
        assert_eq!(
            value["extAgentHostId"],
            "urn:uuid:11111111-2222-3333-4444-555555555555"
        );
        assert_eq!(value["expiresIn"], 3600);
        assert_eq!(value["savedAt"], 1_700_000_000_000_i64);
        assert_eq!(value["planUsage"], true);
        assert_eq!(value["disconnected"], false);

        let minimal: StoredOAuthRegistration =
            serde_json::from_str(r#"{"clientId":"c1"}"#).expect("campos ausentes usam default");
        assert_eq!(minimal.client_id, "c1");
        assert_eq!(minimal.token_type, "Bearer");
        assert_eq!(minimal.expires_in, 0);
        assert!(!minimal.plan_usage);
        assert!(minimal.expires_at_ms().is_none());
        assert_eq!(registration.expires_at_ms(), Some(1_700_003_600_000));
    }

    #[test]
    fn key_status_prefers_oauth_and_reports_mode() {
        let mut secrets = SecretsFile::default();
        secrets.providers.insert(
            "openai".to_string(),
            "sk-openai-1234567890abcdef".to_string(),
        );

        // API key only.
        let status = key_status_with(&secrets, "openai", || None);
        assert!(status.has_key);
        assert_eq!(status.source, "settings");
        assert_eq!(status.mode, "api-key");
        assert!(status.masked.is_some());

        // OAuth registration shadows the API key; `masked` is never a token.
        secrets
            .oauth
            .save_registration("openai", registration("oaiapp_1"))
            .expect("registro");
        let status = key_status_with(&secrets, "openai", || Some(("sk-env".to_string(), "env")));
        assert!(status.has_key);
        assert_eq!(status.source, "chatgpt");
        assert_eq!(status.mode, "oauth");
        assert!(status.masked.is_none());

        // Sign-out keeps the mapping but is not a usable credential anymore.
        secrets.oauth.clear_tokens("openai");
        let status = key_status_with(&secrets, "openai", || None);
        assert!(!status.has_key);
        assert_eq!(status.source, "none");
        assert_eq!(status.mode, "oauth");

        // Env/CLI fallback is reported for non-OAuth providers.
        let status = key_status_with(&secrets, "opencode-go", || {
            Some(("sk-opencode-1234567890abcdef".to_string(), "env"))
        });
        assert!(status.has_key);
        assert_eq!(status.source, "env");
        assert_eq!(status.mode, "api-key");
    }

    #[test]
    fn provider_env_keys_are_provider_aware() {
        assert_eq!(default_auth_env("openai"), "OPENAI_API_KEY");
        assert_eq!(default_auth_env("anthropic"), "ANTHROPIC_API_KEY");
        assert_eq!(default_auth_env("opencode-go"), "OPENCODE_API_KEY");
        assert_eq!(default_auth_env("opencode-zen"), "OPENCODE_API_KEY");

        let name = "ZYLARA_TEST_OPENAI_ENV_9F3C";
        std::env::set_var(name, "  sk-test-openai  ");
        assert_eq!(
            api_key_from_env("openai", name).as_deref(),
            Some("sk-test-openai")
        );
        std::env::remove_var(name);
        assert_eq!(api_key_from_env("openai", name), None);
        // Empty auth_env falls back to the built-in provider default (which is
        // not the bogus test variable); it must not panic and must not read the
        // OpenCode variable for OpenAI.
        assert_eq!(api_key_from_env("openai", ""), None);

        // The direct Anthropic provider has its own env var; it must never fall
        // back to the shared OpenCode key.
        let name = "ZYLARA_TEST_ANTHROPIC_ENV_4A1B";
        std::env::set_var(name, "  sk-ant-test-anthropic  ");
        assert_eq!(
            api_key_from_env("anthropic", name).as_deref(),
            Some("sk-ant-test-anthropic")
        );
        std::env::remove_var(name);
        assert_eq!(api_key_from_env("anthropic", name), None);
    }

    #[test]
    fn gemini_env_and_google_api_key_fallback() {
        assert_eq!(default_auth_env("gemini"), "GEMINI_API_KEY");

        let declared = "ZYLARA_TEST_GEMINI_ENV_5C2D";
        std::env::set_var(declared, "  AIza-declared  ");
        assert_eq!(
            api_key_from_env("gemini", declared).as_deref(),
            Some("AIza-declared")
        );
        std::env::remove_var(declared);

        // Fallback to the env var used by the Google SDKs. Skip when the
        // developer already has it set so the test never clobbers a real key.
        if std::env::var_os("GOOGLE_API_KEY").is_some() {
            return;
        }
        std::env::set_var("GOOGLE_API_KEY", "  AIza-fallback  ");
        let fallback = api_key_from_env("gemini", "ZYLARA_TEST_GEMINI_MISSING_8B1E");
        std::env::remove_var("GOOGLE_API_KEY");
        assert_eq!(fallback.as_deref(), Some("AIza-fallback"));
    }

    #[test]
    fn opencode_cli_detection_is_scoped_to_the_gateways() {
        assert_eq!(cli_entry_ids("opencode-go"), &["opencode-go"]);
        assert_eq!(cli_entry_ids("opencode-zen"), &["opencode", "opencode-zen"]);
        assert!(cli_entry_ids("openai").is_empty());
        assert!(cli_entry_ids("algum-provedor").is_empty());
    }

    #[test]
    fn reset_credentials_does_not_recreate_the_file() {
        // Reset clears the global error slot (asserted below): serialize with
        // the tests that observe it.
        let _guard = error_slot_guard();
        let temp = TempDir::new();
        let path = temp.secrets();
        save_oauth_registration_at(&path, "openai", registration("oaiapp_1"))
            .expect("salvar login");
        remember_secrets_error("erro antigo de credenciais");
        assert!(secrets_error().is_some());

        let mut called = false;
        reset_credentials_at(&path, || {
            called = true;
        })
        .expect("reset");
        assert!(called, "hook de cancelamento precisa rodar sob o lock");
        assert!(!path.exists());
        assert!(
            secrets_error().is_none(),
            "reset explícito deve limpar o erro lembrado"
        );
    }

    #[cfg(unix)]
    #[test]
    fn credentials_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new();
        let path = temp.secrets();
        save_oauth_registration_at(&path, "openai", registration("oaiapp_1"))
            .expect("gravar credenciais");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn terminal_settings_default_to_theme_font_and_12px() {
        let settings = parse_settings_json("{}").expect("parse empty settings");
        assert_eq!(settings.terminal_font_family, "");
        assert_eq!(settings.terminal_font_size, 12);
    }

    #[test]
    fn normalizes_out_of_range_settings() {
        let settings = Settings {
            font_scale: 4.0,
            terminal_font_family: format!("  Fira Code\n  {}", "x".repeat(300)),
            terminal_font_size: 99,
            theme: "neon".into(),
            locale: "xx".into(),
            send_key: "space".into(),
            reasoning_default: "turbo".into(),
            default_provider: "  ".into(),
            default_model: String::new(),
            code_execution_enabled: true,
            code_timeout_secs: 5_000,
            code_python_path: "  C:\\Python313\\python.exe  ".into(),
            code_node_path: "   ".into(),
            skills_panel_enabled: false,
            thinking_collapsed_by_default: true,
            disabled_skills: vec!["  zeta ".into(), "pdf".into(), "pdf".into(), String::new()],
            ..Settings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(normalized.font_scale, 1.3);
        assert!(normalized.terminal_font_family.starts_with("Fira Code"));
        assert!(!normalized.terminal_font_family.contains('\n'));
        assert_eq!(
            normalized.terminal_font_family.chars().count(),
            TERMINAL_FONT_FAMILY_MAX_CHARS
        );
        assert_eq!(normalized.terminal_font_size, TERMINAL_FONT_SIZE_MAX);
        assert_eq!(normalized.theme, "system");
        assert_eq!(normalized.locale, "en");
        assert_eq!(normalized.send_key, "enter");
        assert_eq!(normalized.reasoning_default, "max");
        assert_eq!(normalized.default_provider, "opencode-go");
        assert_eq!(normalized.default_model, "deepseek-v4.1-flash");
        assert!(normalized.code_execution_enabled);
        assert_eq!(normalized.code_timeout_secs, CODE_TIMEOUT_MAX_SECS);
        assert_eq!(normalized.code_python_path, "C:\\Python313\\python.exe");
        assert_eq!(normalized.code_node_path, "");
        assert!(!normalized.skills_panel_enabled);
        // Booleano de preferência não passa por "normalização": preserva o true.
        assert!(normalized.thinking_collapsed_by_default);
        assert_eq!(normalized.disabled_skills, vec!["pdf", "zeta"]);
    }

    #[test]
    fn normalizes_theme_id_syntax_and_preserves_installed_ids() {
        let invalid = normalize_settings(Settings {
            theme_id: "../evil".into(),
            ..Settings::default()
        });
        assert_eq!(invalid.theme_id, crate::themes::BUILTIN_THEME_ID);

        let mut valid = normalize_settings(Settings {
            theme_id: "ocean".into(),
            ..Settings::default()
        });
        assert_eq!(valid.theme_id, "ocean");

        valid = normalize_settings(Settings {
            theme_id: "plugin-0123456789abcdef".into(),
            ..Settings::default()
        });
        assert_eq!(valid.theme_id, "plugin-0123456789abcdef");

        let empty = normalize_settings(Settings {
            theme_id: String::new(),
            ..Settings::default()
        });
        assert_eq!(empty.theme_id, crate::themes::BUILTIN_THEME_ID);
    }

    #[test]
    fn legacy_settings_without_locale_migrate_to_brazilian_portuguese() {
        let settings = parse_settings_json("{}").expect("parse legado");
        assert_eq!(settings.locale, "pt-BR");
    }

    #[test]
    fn invalid_locale_type_falls_back_to_english() {
        let settings = parse_settings_json(r#"{"locale": null}"#).expect("parse locale nulo");
        assert_eq!(settings.locale, "en");
    }

    #[test]
    fn supported_locales_are_preserved() {
        for code in ["en", "pt-BR", "es"] {
            let raw = format!(r#"{{"locale":"{code}"}}"#);
            let settings = parse_settings_json(&raw).expect("parse locale suportado");
            assert_eq!(settings.locale, code);
        }
    }

    #[test]
    fn normalizes_low_out_of_range_settings() {
        let settings = Settings {
            font_scale: 0.1,
            terminal_font_size: 0,
            code_timeout_secs: 1,
            ..Settings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(normalized.font_scale, 0.85);
        assert_eq!(normalized.terminal_font_size, TERMINAL_FONT_SIZE_MIN);
        assert_eq!(normalized.code_timeout_secs, CODE_TIMEOUT_MIN_SECS);
    }

    #[test]
    fn code_settings_default_to_safe_values() {
        let defaults = Settings::default();
        // Execução de código é opt-in: default desligado.
        assert!(!defaults.code_execution_enabled);
        assert_eq!(defaults.code_timeout_secs, 120);
        // Vazio significa auto-detecção do interpretador no PATH.
        assert!(defaults.code_python_path.is_empty());
        assert!(defaults.code_node_path.is_empty());
    }

    #[test]
    fn legacy_settings_file_without_code_fields_uses_defaults() {
        // `settings.json` antigo, de antes dos campos de execução de código.
        let raw = r#"{"theme":"dark","maxSteps":10,"webSearchEnabled":false}"#;
        let parsed: Settings = serde_json::from_str(raw).expect("desserializar settings antigos");
        let normalized = normalize_settings(parsed);
        assert_eq!(normalized.theme, "dark");
        assert!(!normalized.web_search_enabled);
        assert!(!normalized.code_execution_enabled);
        assert_eq!(normalized.code_timeout_secs, 120);
        assert_eq!(normalized.code_python_path, "");
        assert_eq!(normalized.code_node_path, "");
        // Campo novo (raciocínio recolhido) ausente no arquivo antigo: default
        // false, então o bloco continua abrindo durante o streaming.
        assert!(!normalized.thinking_collapsed_by_default);
    }

    #[test]
    fn skill_settings_default_to_safe_values() {
        let defaults = Settings::default();
        // O item "Skills" da sidebar aparece por padrão.
        assert!(defaults.skills_panel_enabled);
        assert!(defaults.disabled_skills.is_empty());
    }

    #[test]
    fn tray_settings_default_to_background_mode() {
        let defaults = Settings::default();
        assert!(defaults.close_to_tray);
        assert!(!defaults.close_to_tray_prompted);
    }

    #[test]
    fn legacy_settings_file_without_tray_fields_uses_defaults() {
        let raw = r#"{"theme":"dark"}"#;
        let parsed: Settings = serde_json::from_str(raw).expect("deserialize legacy settings");
        let normalized = normalize_settings(parsed);
        assert!(normalized.close_to_tray);
        assert!(!normalized.close_to_tray_prompted);
    }

    #[test]
    fn tray_settings_round_trip_with_camel_case_keys() {
        // IPC contract: camelCase keys, plain booleans, no normalization.
        let parsed: Settings =
            serde_json::from_str(r#"{"closeToTray":false,"closeToTrayPrompted":true}"#)
                .expect("deserialize renderer settings");
        assert!(!parsed.close_to_tray);
        assert!(parsed.close_to_tray_prompted);
        let normalized = normalize_settings(parsed);
        assert!(!normalized.close_to_tray);
        assert!(normalized.close_to_tray_prompted);

        let value = serde_json::to_value(&normalized).expect("serialize settings");
        assert_eq!(value["closeToTray"], false);
        assert_eq!(value["closeToTrayPrompted"], true);
        assert!(value.get("close_to_tray").is_none());
    }

    #[test]
    fn thinking_settings_default_to_safe_values() {
        // Default: o bloco de raciocínio/passos abre durante o streaming.
        assert!(!Settings::default().thinking_collapsed_by_default);
    }

    #[test]
    fn thinking_setting_round_trips_with_camel_case_key() {
        // Contrato IPC com o renderer: chave camelCase e booleano sem transformação.
        let parsed: Settings = serde_json::from_str(r#"{"thinkingCollapsedByDefault":true}"#)
            .expect("desserializar settings do renderer");
        assert!(parsed.thinking_collapsed_by_default);

        // normalize_settings não altera o booleano.
        let normalized = normalize_settings(parsed);
        assert!(normalized.thinking_collapsed_by_default);

        // save_settings serializa com o nome camelCase consumido pelo renderer.
        let value = serde_json::to_value(&normalized).expect("serializar settings");
        assert_eq!(value["thinkingCollapsedByDefault"], true);
        assert!(value.get("thinking_collapsed_by_default").is_none());

        // load_settings relê o mesmo valor gravado.
        let reparsed: Settings =
            serde_json::from_value(value).expect("reler settings serializados");
        assert!(reparsed.thinking_collapsed_by_default);
    }

    #[test]
    fn normalizes_disabled_skills_list() {
        let settings = Settings {
            disabled_skills: vec![
                " zeta".into(),
                "alfa".into(),
                "alfa ".into(),
                String::new(),
                "   ".into(),
            ],
            ..Settings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(normalized.disabled_skills, vec!["alfa", "zeta"]);
        // Sem transformação: o switch do painel é preservado.
        assert!(normalized.skills_panel_enabled);
    }

    #[test]
    fn legacy_settings_file_without_skill_fields_uses_defaults() {
        // `settings.json` antigo, de antes da gestão de skills.
        let raw = r#"{"theme":"light","codeExecutionEnabled":true}"#;
        let parsed: Settings = serde_json::from_str(raw).expect("desserializar settings antigos");
        let normalized = normalize_settings(parsed);
        assert!(normalized.skills_panel_enabled);
        assert!(normalized.disabled_skills.is_empty());
        assert!(normalized.code_execution_enabled);
    }

    #[test]
    fn code_timeout_accepts_boundaries() {
        let settings = Settings {
            code_timeout_secs: CODE_TIMEOUT_MIN_SECS,
            ..Settings::default()
        };
        assert_eq!(
            normalize_settings(settings).code_timeout_secs,
            CODE_TIMEOUT_MIN_SECS
        );
        let settings = Settings {
            code_timeout_secs: CODE_TIMEOUT_MAX_SECS,
            ..Settings::default()
        };
        assert_eq!(
            normalize_settings(settings).code_timeout_secs,
            CODE_TIMEOUT_MAX_SECS
        );
    }

    /* -------------------------------------------------------------- */
    /* Harness de código (docs/goals/code-harness/PLAN.md §7)          */
    /* -------------------------------------------------------------- */

    #[test]
    fn code_harness_settings_default_to_safe_values() {
        let defaults = Settings::default();
        // Shell é opt-in por sessão, mas o default do app já vem ligado: cada
        // comando fora do workspace continua passando pela política de aprovação.
        assert!(defaults.shell_enabled);
        assert_eq!(defaults.execution_environment, "local");
        assert_eq!(defaults.docker_image, "node:22-bookworm");
        assert!(!defaults.docker_network);
        assert!(defaults.auto_compact);
        assert_eq!(defaults.spill_retention_days, 30);
        assert_eq!(defaults.approval_timeout_secs, 600);
        assert!(defaults.notifications_enabled);
        // Padrão do produto: novas sessões do Code nascem Autônomas (configurável
        // em Configurações → Ferramentas).
        assert_eq!(
            defaults.code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );
        // Pasta nova pede confirmação explícita.
        assert!(!defaults.trust_workspaces_by_default);
    }

    #[test]
    fn concurrent_turn_limit_defaults_to_10_and_clamps_to_32() {
        assert_eq!(Settings::default().max_concurrent_turns, 10);
        let normalized = normalize_settings(Settings {
            max_concurrent_turns: 64,
            ..Settings::default()
        });
        assert_eq!(normalized.max_concurrent_turns, 32);
        let normalized = normalize_settings(Settings {
            max_concurrent_turns: 0,
            ..Settings::default()
        });
        assert_eq!(normalized.max_concurrent_turns, 1);
    }

    #[test]
    fn normalizes_out_of_range_code_harness_settings() {
        let settings = Settings {
            spill_retention_days: 9_999,
            approval_timeout_secs: 1,
            ..Settings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(
            normalized.spill_retention_days,
            SPILL_RETENTION_MAX_DAYS
        );
        assert_eq!(
            normalized.approval_timeout_secs,
            APPROVAL_TIMEOUT_MIN_SECS
        );

        let settings = Settings {
            spill_retention_days: 0,
            approval_timeout_secs: 0,
            ..Settings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(
            normalized.spill_retention_days,
            SPILL_RETENTION_MIN_DAYS
        );
        assert_eq!(
            normalized.approval_timeout_secs,
            APPROVAL_TIMEOUT_MIN_SECS
        );
    }

    #[test]
    fn code_harness_settings_accept_their_boundaries() {
        let settings = Settings {
            spill_retention_days: SPILL_RETENTION_MIN_DAYS,
            approval_timeout_secs: APPROVAL_TIMEOUT_MAX_SECS,
            ..Settings::default()
        };
        let normalized = normalize_settings(settings);
        assert_eq!(
            normalized.spill_retention_days,
            SPILL_RETENTION_MIN_DAYS
        );
        assert_eq!(
            normalized.approval_timeout_secs,
            APPROVAL_TIMEOUT_MAX_SECS
        );

        let settings = Settings {
            spill_retention_days: SPILL_RETENTION_MAX_DAYS,
            ..Settings::default()
        };
        assert_eq!(
            normalize_settings(settings).spill_retention_days,
            SPILL_RETENTION_MAX_DAYS
        );
    }

    #[test]
    fn legacy_settings_file_without_code_harness_fields_uses_defaults() {
        // `settings.json` de antes do harness de código.
        let raw = r#"{"theme":"dark","maxSteps":10,"codeMaxSteps":9999}"#;
        let parsed = parse_settings_json(raw).expect("desserializar settings antigos");
        let normalized = normalize_settings(parsed);
        assert_eq!(normalized.theme, "dark");
        // Campos ausentes: defaults do harness.
        assert!(normalized.shell_enabled);
        assert!(normalized.auto_compact);
        assert_eq!(normalized.spill_retention_days, 30);
        assert_eq!(normalized.approval_timeout_secs, 600);
        assert!(normalized.notifications_enabled);
        assert_eq!(
            normalized.code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );
        assert!(!normalized.trust_workspaces_by_default);
        assert_eq!(normalized.diff_open_mode, "tab");
    }
    #[test]
    fn execution_environment_and_docker_image_are_normalized() {
        let mut settings = Settings::default();
        settings.execution_environment = " DOCKER ".into();
        settings.docker_image = "  python:3.12  ".into();
        let normalized = normalize_settings(settings);
        assert_eq!(normalized.execution_environment, "docker");
        assert_eq!(normalized.docker_image, "python:3.12");

        let mut invalid = Settings::default();
        invalid.execution_environment = "cloud".into();
        invalid.docker_image = "   ".into();
        let normalized = normalize_settings(invalid);
        assert_eq!(normalized.execution_environment, "local");
        assert_eq!(normalized.docker_image, "node:22-bookworm");

        let mut resources = Settings::default();
        resources.docker_memory_mb = 1;
        resources.docker_cpus = 99.0;
        resources.docker_pids_limit = 1;
        let normalized = normalize_settings(resources);
        assert_eq!(normalized.docker_memory_mb, 256);
        assert_eq!(normalized.docker_cpus, 16.0);
        assert_eq!(normalized.docker_pids_limit, 32);

        let mut computer = Settings::default();
        computer.computer_environment = " PRIVATE_DESKTOP ".into();
        assert_eq!(
            normalize_settings(computer).computer_environment,
            "private_desktop"
        );
        let mut invalid_computer = Settings::default();
        invalid_computer.computer_environment = "cloud".into();
        assert_eq!(
            normalize_settings(invalid_computer).computer_environment,
            "auto"
        );

        let mut lists = Settings::default();
        lists.browser_allowed_domains = vec![" Example.COM ".into(), "  ".into()];
        lists.browser_blocked_domains = vec!["BAD.test".into()];
        lists.computer_allowed_apps = vec![" Notepad ".into()];
        lists.computer_blocked_apps = vec!["1Password".into()];
        let normalized = normalize_settings(lists);
        assert_eq!(normalized.browser_allowed_domains, vec!["example.com"]);
        assert_eq!(normalized.browser_blocked_domains, vec!["bad.test"]);
        assert_eq!(normalized.computer_allowed_apps, vec!["notepad"]);
        assert_eq!(normalized.computer_blocked_apps, vec!["1password"]);
    }

    #[test]
    fn diff_open_mode_normalizes_to_tab_or_panel() {
        let mut settings = Settings::default();
        settings.diff_open_mode = " PANEL ".into();
        assert_eq!(normalize_settings(settings).diff_open_mode, "panel");
        let mut settings = Settings::default();
        settings.diff_open_mode = "qualquer-coisa".into();
        assert_eq!(normalize_settings(settings).diff_open_mode, "tab");
        let mut settings = Settings::default();
        settings.diff_open_mode = String::new();
        assert_eq!(normalize_settings(settings).diff_open_mode, "tab");
    }

    #[test]
    fn invalid_permission_mode_does_not_wipe_the_other_settings() {
        // Arquivo editado à mão com um modo de permissão desconhecido: só esse
        // campo volta ao default; o resto do arquivo é preservado.
        let raw = r#"{"theme":"dark","codeDefaultPermissionMode":"yolo",
                      "approvalTimeoutSecs":900,"shellEnabled":false}"#;
        let parsed = parse_settings_json(raw).expect("parse tolerante");
        let normalized = normalize_settings(parsed);
        assert_eq!(normalized.theme, "dark");
        assert_eq!(normalized.approval_timeout_secs, 900);
        assert!(!normalized.shell_enabled);
        assert_eq!(
            normalized.code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );
    }

    #[test]
    fn legacy_settings_v1_migrates_the_default_permission_mode_to_autonomous() {
        // Arquivo do app antes da v2: `"edit"` foi gravado pelo default de fábrica
        // (o campo não tinha UI), então migra para o novo padrão Autônomo.
        let raw = r#"{"theme":"dark","codeDefaultPermissionMode":"edit"}"#;
        let parsed = parse_settings_json(raw).expect("migrar arquivo v1");
        assert_eq!(
            normalize_settings(parsed).code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );

        // Arquivo sem a chave: o default do struct (Autônomo) vale.
        let parsed = parse_settings_json(r#"{"theme":"dark"}"#).expect("parse sem a chave");
        assert_eq!(
            normalize_settings(parsed).code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );
    }

    #[test]
    fn settings_v2_respects_an_explicit_edit_default() {
        // Depois da v2 o usuário pode escolher Editar no seletor: o valor
        // persistido (com `settingsVersion`) sobrevive a reabrir o app.
        let raw = r#"{"settingsVersion":2,"codeDefaultPermissionMode":"edit"}"#;
        let parsed = parse_settings_json(raw).expect("parse v2");
        assert_eq!(
            normalize_settings(parsed).code_default_permission_mode,
            crate::domain::PermissionMode::Edit
        );
    }

    #[test]
    fn settings_v2_migrates_the_legacy_local_computer_image() {
        let raw = r#"{"settingsVersion":2,"computerDockerImage":"zylara/computer:latest"}"#;
        let parsed = parse_settings_json(raw).expect("migrar imagem legada");
        assert_eq!(
            normalize_settings(parsed).computer_docker_image,
            crate::domain::DEFAULT_COMPUTER_DOCKER_IMAGE
        );
    }

    #[test]
    fn settings_v2_preserves_a_custom_computer_image() {
        let raw = r#"{"settingsVersion":2,"computerDockerImage":"example/custom:1"}"#;
        let parsed = parse_settings_json(raw).expect("parse imagem customizada");
        assert_eq!(
            normalize_settings(parsed).computer_docker_image,
            "example/custom:1"
        );
    }

    #[test]
    fn settings_v3_preserves_an_explicit_legacy_local_tag() {
        // Depois da migração, a tag local pode ser uma escolha explícita de
        // desenvolvimento e não deve ser trocada silenciosamente.
        let raw = r#"{"settingsVersion":3,"computerDockerImage":"zylara/computer:latest"}"#;
        let parsed = parse_settings_json(raw).expect("parse v3");
        assert_eq!(
            normalize_settings(parsed).computer_docker_image,
            "zylara/computer:latest"
        );
    }

    #[test]
    fn review_is_a_valid_persisted_default_permission_mode() {
        // "Revisar" é um dos quatro modos do chip e precisa sobreviver ao parse
        // tolerante (antes ele era descartado como inválido).
        let raw = r#"{"settingsVersion":2,"codeDefaultPermissionMode":"review"}"#;
        let parsed = parse_settings_json(raw).expect("parse review");
        assert_eq!(
            normalize_settings(parsed).code_default_permission_mode,
            crate::domain::PermissionMode::Review
        );
    }

    #[test]
    fn settings_serialization_stamps_the_schema_version() {
        let raw = serialize_settings_json(&Settings::default()).expect("serializar settings");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(value["settingsVersion"], u64::from(SETTINGS_VERSION));
        assert_eq!(value["codeDefaultPermissionMode"], "autonomous");

        // Idempotência do contrato de arquivo: reler o que foi gravado devolve os
        // mesmos valores (inclusive um Editar escolhido pelo usuário).
        let parsed = parse_settings_json(&raw).expect("reler settings gravados");
        assert_eq!(
            normalize_settings(parsed).code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );

        let mut custom = Settings::default();
        custom.code_default_permission_mode = crate::domain::PermissionMode::Edit;
        let raw = serialize_settings_json(&custom).expect("serializar Editar");
        let parsed = parse_settings_json(&raw).expect("reler Editar");
        assert_eq!(
            normalize_settings(parsed).code_default_permission_mode,
            crate::domain::PermissionMode::Edit
        );
    }

    #[test]
    fn code_harness_settings_round_trip_with_camel_case_keys() {
        let value =
            serde_json::to_value(Settings::default()).expect("serializar settings do harness");
        assert_eq!(value["shellEnabled"], true);
        assert_eq!(value["autoCompact"], true);
        assert_eq!(value["spillRetentionDays"], 30);
        assert_eq!(value["approvalTimeoutSecs"], 600);
        assert_eq!(value["notificationsEnabled"], true);
        assert_eq!(value["codeDefaultPermissionMode"], "autonomous");
        assert_eq!(value["trustWorkspacesByDefault"], false);
        assert_eq!(value["diffOpenMode"], "tab");
        assert!(value.get("maxSteps").is_none());
        assert!(value.get("temperature").is_none());
        assert!(value.get("codeMaxSteps").is_none());

        // Reler o JSON gravado devolve os mesmos valores (contrato IPC).
        let parsed: Settings =
            serde_json::from_value(value).expect("reler settings serializados");
        assert_eq!(
            parsed.code_default_permission_mode,
            crate::domain::PermissionMode::Autonomous
        );
    }
}
