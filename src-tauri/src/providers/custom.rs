//! User-defined providers (`Settings → Providers → Add provider`).
//!
//! A custom provider is stored in SQLite and merged into the catalog exactly like
//! a declarative plugin provider, so chat, Code and agents resolve it through the
//! same `AppState::provider`/`model` path. Ids are namespaced (`custom__<slug>`)
//! and can never collide with the bundled catalog or with `plugin__…`.

use std::collections::{BTreeMap, HashMap};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::catalog::{
    CacheInfo, Modalities, ModelInfo, ProviderAuth, ProviderInfo, ReasoningOption, RequestProfiles,
};
use crate::db::Db;

/// Prefix reserved for user-defined providers.
pub const ID_PREFIX: &str = "custom__";

const MAX_PROVIDERS: usize = 64;
const MAX_MODELS: usize = 200;
const MAX_HEADERS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderInput {
    /// Slug without the `custom__` prefix.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub description: String,
    pub base_url: String,
    #[serde(default)]
    pub console_url: String,
    #[serde(default)]
    pub endpoints: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub auth_header: Option<String>,
    #[serde(default)]
    pub auth_prefix: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub models: Vec<CustomModelInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output: Option<u64>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub attachment: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomProviderRow {
    id: String,
    name: String,
    short_name: String,
    description: String,
    base_url: String,
    console_url: String,
    endpoints_json: String,
    headers_json: String,
    auth_header: String,
    auth_prefix: String,
    icon: Option<String>,
    models_json: String,
    sort_order: i64,
}

/// Full provider id for a custom slug.
pub fn provider_id(slug: &str) -> String {
    format!("{ID_PREFIX}{slug}")
}

/// `true` when the id belongs to the custom namespace.
pub fn is_custom_id(provider_id: &str) -> bool {
    provider_id.starts_with(ID_PREFIX)
}

/// Every stored custom provider, ordered by name.
pub fn list(db: &Db) -> Vec<ProviderInfo> {
    match query_rows(db) {
        Ok(rows) => rows.iter().filter_map(row_to_provider).collect(),
        Err(error) => {
            eprintln!("[providers] custom list: {error}");
            Vec::new()
        }
    }
}

/// One custom provider by its full id (`custom__<slug>`).
pub fn get(db: &Db, provider_id: &str) -> Option<ProviderInfo> {
    list(db)
        .into_iter()
        .find(|provider| provider.id == provider_id)
}

/// Creates or replaces a custom provider and returns the stored provider.
pub fn save(db: &Db, input: CustomProviderInput) -> Result<ProviderInfo> {
    validate(&input)?;
    let existing = query_rows(db)?
        .into_iter()
        .filter(|row| row.id != input.id)
        .count();
    if existing >= MAX_PROVIDERS {
        bail!("PROVIDER_LIMIT: at most {MAX_PROVIDERS} custom providers");
    }
    let now = crate::domain::now_ms();
    let endpoints = normalize_endpoints(&input.endpoints);
    let models = input
        .models
        .iter()
        .map(|model| {
            serde_json::json!({
                "id": model.id.trim(),
                "name": if model.name.trim().is_empty() { model.id.trim() } else { model.name.trim() },
                "contextWindow": model.context_window,
                "maxOutput": model.max_output,
                "reasoning": model.reasoning,
                "attachment": model.attachment,
            })
        })
        .collect::<Vec<_>>();
    let conn = db.connection();
    conn.execute(
        "INSERT INTO custom_providers (
            id, name, short_name, description, base_url, console_url, endpoints_json,
            headers_json, auth_header, auth_prefix, icon, models_json, sort_order,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            short_name = excluded.short_name,
            description = excluded.description,
            base_url = excluded.base_url,
            console_url = excluded.console_url,
            endpoints_json = excluded.endpoints_json,
            headers_json = excluded.headers_json,
            auth_header = excluded.auth_header,
            auth_prefix = excluded.auth_prefix,
            icon = excluded.icon,
            models_json = excluded.models_json,
            updated_at = excluded.updated_at",
        rusqlite::params![
            input.id.clone(),
            input.name.trim(),
            input.short_name.unwrap_or_default().trim(),
            input.description.trim(),
            input.base_url.trim().trim_end_matches('/'),
            input.console_url.trim(),
            serde_json::to_string(&endpoints)?,
            serde_json::to_string(&input.headers)?,
            input.auth_header.unwrap_or_else(|| "authorization".to_string()),
            input.auth_prefix.unwrap_or_else(|| "Bearer ".to_string()),
            input.icon,
            serde_json::to_string(&models)?,
            now as i64,
            now as i64,
            now as i64,
        ],
    )
    .context("custom provider write")?;
    get(db, &provider_id(&input.id))
        .ok_or_else(|| anyhow::anyhow!("custom provider was not persisted"))
}

/// Removes a custom provider. Returns `false` when it did not exist.
pub fn remove(db: &Db, provider_id: &str) -> Result<bool> {
    let Some(slug) = provider_id.strip_prefix(ID_PREFIX) else {
        bail!("PROVIDER_NOT_CUSTOM: `{provider_id}` is not a custom provider");
    };
    let conn = db.connection();
    let removed = conn.execute("DELETE FROM custom_providers WHERE id = ?1", [slug])?;
    Ok(removed > 0)
}

fn query_rows(db: &Db) -> Result<Vec<CustomProviderRow>> {
    let conn = db.connection();
    let mut statement = conn.prepare(
        "SELECT id, name, short_name, description, base_url, console_url, endpoints_json,
                headers_json, auth_header, auth_prefix, icon, models_json, sort_order
         FROM custom_providers
         ORDER BY sort_order, name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(CustomProviderRow {
            id: row.get(0)?,
            name: row.get(1)?,
            short_name: row.get(2)?,
            description: row.get(3)?,
            base_url: row.get(4)?,
            console_url: row.get(5)?,
            endpoints_json: row.get(6)?,
            headers_json: row.get(7)?,
            auth_header: row.get(8)?,
            auth_prefix: row.get(9)?,
            icon: row.get(10)?,
            models_json: row.get(11)?,
            sort_order: row.get(12)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn row_to_provider(row: &CustomProviderRow) -> Option<ProviderInfo> {
    let endpoints: BTreeMap<String, String> = serde_json::from_str(&row.endpoints_json).ok()?;
    let headers: BTreeMap<String, String> = serde_json::from_str(&row.headers_json).ok()?;
    let stored: Vec<serde_json::Value> = serde_json::from_str(&row.models_json).unwrap_or_default();
    if stored.is_empty() {
        return None;
    }
    let models = stored
        .iter()
        .filter_map(|model| {
            let id = model.get("id")?.as_str()?.trim().to_string();
            if id.is_empty() {
                return None;
            }
            let name = model
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(&id)
                .to_string();
            let reasoning = model
                .get("reasoning")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let attachment = model
                .get("attachment")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let context_window = model
                .get("contextWindow")
                .and_then(|value| value.as_u64())
                .unwrap_or(128_000);
            let max_output = model
                .get("maxOutput")
                .and_then(|value| value.as_u64())
                .unwrap_or(16_384);
            Some(ModelInfo {
                id,
                name,
                family: row.id.clone(),
                protocols: vec!["openai-chat".to_string()],
                reasoning,
                reasoning_options: if reasoning {
                    vec![ReasoningOption::Toggle]
                } else {
                    Vec::new()
                },
                attachment,
                modalities: Modalities {
                    input: if attachment {
                        vec!["text".to_string(), "image".to_string()]
                    } else {
                        vec!["text".to_string()]
                    },
                    output: vec!["text".to_string()],
                },
                context_window: context_window.min(u32::MAX as u64) as u32,
                max_output: max_output.min(u32::MAX as u64) as u32,
                cost: None,
                release_date: None,
                knowledge: None,
                open_weights: false,
                description: None,
                tags: vec!["custom".to_string()],
                status: "stable".to_string(),
                estimated: true,
                cache: Some(CacheInfo {
                    mode: "auto".to_string(),
                    min_tokens: Some(1_024),
                    block_tokens: None,
                    ttl_options: Vec::new(),
                    supports_key: false,
                    supports_retention: false,
                    supports_explicit_breakpoints: false,
                    reports_read: true,
                    reports_write: true,
                    source: Some("custom".to_string()),
                }),
            })
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return None;
    }
    let endpoints: HashMap<String, String> = endpoints.into_iter().collect();
    Some(ProviderInfo {
        id: provider_id(&row.id),
        name: row.name.clone(),
        short_name: if row.short_name.trim().is_empty() {
            row.name.clone()
        } else {
            row.short_name.clone()
        },
        description: row.description.clone(),
        base_url: row.base_url.clone(),
        console_url: row.console_url.clone(),
        endpoints,
        headers: headers.into_iter().collect(),
        auth_env: String::new(),
        auth_header: row.auth_header.clone(),
        auth_prefix: row.auth_prefix.clone(),
        default_model_id: models
            .first()
            .map(|model| model.id.clone())
            .unwrap_or_default(),
        auth: ProviderAuth::ApiKey,
        request_profiles: RequestProfiles::default(),
        oauth: None,
        models,
        notes: vec!["User-defined provider.".to_string()],
        cache: None,
        icon: row.icon.clone(),
        category: None,
        origin: Some("custom".to_string()),
        origin_label: Some("Custom provider".to_string()),
        transport: crate::catalog::ProviderTransport::Http,
        acp: None,
        icon_svg: None,
    })
}

fn validate(input: &CustomProviderInput) -> Result<()> {
    let slug = input.id.trim();
    if slug.is_empty() || slug.chars().count() > 48 {
        bail!("PROVIDER_INVALID: id must have 1..=48 characters");
    }
    if !slug
        .chars()
        .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-' || character == '_')
        || !slug.starts_with(|character: char| character.is_ascii_lowercase())
    {
        bail!("PROVIDER_INVALID: id must be lowercase letters, digits, `-` or `_`");
    }
    if slug.starts_with("plugin") || slug.starts_with("custom") {
        bail!("PROVIDER_INVALID: id is reserved");
    }
    if input.name.trim().is_empty() || input.name.chars().count() > 80 {
        bail!("PROVIDER_INVALID: name must have 1..=80 characters");
    }
    validate_base_url(&input.base_url)?;
    if input.description.chars().count() > 2_000 {
        bail!("PROVIDER_INVALID: description is too long");
    }
    if input.headers.len() > MAX_HEADERS {
        bail!("PROVIDER_INVALID: too many headers");
    }
    for (name, value) in &input.headers {
        let lower = name.trim().to_ascii_lowercase();
        if lower.is_empty()
            || lower.chars().any(char::is_whitespace)
            || lower.chars().any(|character| !character.is_ascii_graphic())
        {
            bail!("PROVIDER_INVALID: header `{name}` is invalid");
        }
        if lower == "authorization" || lower == "cookie" || lower == "host" {
            bail!("PROVIDER_INVALID: header `{name}` is reserved for credentials");
        }
        if value.chars().count() > 256 || value.contains('\n') || value.contains('\r') {
            bail!("PROVIDER_INVALID: header `{name}` has an invalid value");
        }
    }
    if let Some(header) = &input.auth_header {
        let header = header.trim().to_ascii_lowercase();
        if header.is_empty() || header.chars().any(char::is_whitespace) {
            bail!("PROVIDER_INVALID: authHeader is invalid");
        }
    }
    if let Some(prefix) = &input.auth_prefix {
        if prefix.chars().count() > 32 || prefix.contains('\r') || prefix.contains('\n') {
            bail!("PROVIDER_INVALID: authPrefix is invalid");
        }
    }
    if input.models.is_empty() {
        bail!("PROVIDER_INVALID: at least one model is required");
    }
    if input.models.len() > MAX_MODELS {
        bail!("PROVIDER_INVALID: too many models");
    }
    for model in &input.models {
        if model.id.trim().is_empty() || model.id.chars().count() > 128 {
            bail!("PROVIDER_INVALID: model id must have 1..=128 characters");
        }
        if model.id.chars().any(char::is_whitespace) {
            bail!("PROVIDER_INVALID: model `{}` id has whitespace", model.id);
        }
        if model.name.chars().count() > 120 {
            bail!("PROVIDER_INVALID: model `{}` name is too long", model.id);
        }
    }
    if let Some(icon) = &input.icon {
        if icon.chars().count() > 256 {
            bail!("PROVIDER_INVALID: icon value is too long");
        }
    }
    for (protocol, path) in &input.endpoints {
        if protocol.trim().is_empty() || protocol.chars().count() > 40 {
            bail!("PROVIDER_INVALID: endpoint `{protocol}` is invalid");
        }
        if path.chars().count() > 256 || path.contains("..") {
            bail!("PROVIDER_INVALID: endpoint `{protocol}` path is invalid");
        }
    }
    Ok(())
}

fn validate_base_url(base_url: &str) -> Result<()> {
    let parsed = url::Url::parse(base_url.trim())
        .map_err(|_| anyhow::anyhow!("PROVIDER_INVALID: baseUrl is not a valid URL"))?;
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => Ok(()),
        // Local model servers (Ollama, LM Studio, vLLM) run over plain HTTP on
        // loopback; never allow plain HTTP to a remote host.
        "http" if loopback => Ok(()),
        "http" => bail!("PROVIDER_INVALID: http is only allowed for localhost"),
        _ => bail!("PROVIDER_INVALID: baseUrl must use https"),
    }
}

fn normalize_endpoints(endpoints: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = endpoints.clone();
    out.entry("openai-chat".to_string())
        .or_insert_with(|| "/chat/completions".to_string());
    out.entry("models".to_string())
        .or_insert_with(|| "/models".to_string());
    for path in out.values_mut() {
        let trimmed = path.trim();
        let owned = if trimmed.starts_with('/') {
            trimmed.to_string()
        } else {
            format!("/{trimmed}")
        };
        *path = owned;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> CustomProviderInput {
        CustomProviderInput {
            id: "acme".to_string(),
            name: "Acme Gateway".to_string(),
            short_name: None,
            description: String::new(),
            base_url: "https://api.acme.dev/v1".to_string(),
            console_url: String::new(),
            endpoints: BTreeMap::new(),
            headers: BTreeMap::new(),
            auth_header: None,
            auth_prefix: None,
            icon: None,
            models: vec![CustomModelInput {
                id: "acme-chat-1".to_string(),
                name: "Acme Chat 1".to_string(),
                context_window: None,
                max_output: None,
                reasoning: true,
                attachment: false,
            }],
        }
    }

    #[test]
    fn ids_are_namespaced() {
        assert_eq!(provider_id("acme"), "custom__acme");
        assert!(is_custom_id("custom__acme"));
        assert!(!is_custom_id("plugin__acme__gateway"));
    }

    #[test]
    fn rejects_plain_http_for_remote_hosts() {
        let mut value = input();
        value.base_url = "http://api.acme.dev/v1".to_string();
        assert!(validate(&value).is_err());
        value.base_url = "http://localhost:11434/v1".to_string();
        assert!(validate(&value).is_ok());
    }

    #[test]
    fn rejects_reserved_ids_and_credentials_in_headers() {
        let mut value = input();
        value.id = "plugin".to_string();
        assert!(validate(&value).is_err());
        let mut value = input();
        value.headers.insert("Authorization".to_string(), "Bearer x".to_string());
        assert!(validate(&value).is_err());
    }

    #[test]
    fn normalizes_endpoints() {
        let endpoints = normalize_endpoints(&BTreeMap::new());
        assert_eq!(endpoints.get("openai-chat").map(String::as_str), Some("/chat/completions"));
        assert_eq!(endpoints.get("models").map(String::as_str), Some("/models"));
    }
}
