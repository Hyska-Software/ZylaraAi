//! Signed plugin store: registry parsing, cache, updates, rollback and
//! revocation checks.
//!
//! The registry is a signed JSON document. The signature identifies the
//! registry publisher; it is pinned on first use just like plugin publisher
//! keys. Index metadata is advisory: the package itself must still carry a
//! valid publisher signature.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::signature::{RegistrySignature, VerifiedKey};
use super::{permissions, PluginManager, PluginUpdateInfo};
use crate::update::version;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;
const MAX_REGISTRY_BYTES: usize = 4 * 1024 * 1024;
const CACHE_TTL_MS: i64 = 15 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub plugins: Vec<RegistryPlugin>,
    #[serde(default)]
    pub revoked: Vec<RevokedPlugin>,
    #[serde(default)]
    pub signature: Option<RegistrySignature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default = "default_api_version")]
    pub api_version: u32,
    pub publisher: RegistryPublisher,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    pub package_url: String,
    #[serde(default)]
    pub package_sha256: Option<String>,
    #[serde(default)]
    pub package_size: Option<u64>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default = "default_channel")]
    pub channel: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub yanked: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    /// Set by the host on store views so multi-registry installs can show the
    /// origin. Absent from the signed registry document.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub registry_url: String,
    /// SHA-256 fingerprint of `publisher.publicKey`, set by the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryPublisher {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default)]
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedPlugin {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStoreView {
    pub plugins: Vec<RegistryPlugin>,
    pub revoked: Vec<RevokedPlugin>,
    pub source_url: String,
    pub fetched_at: i64,
    pub registry_name: String,
    pub signature_key_id: Option<String>,
}

fn default_api_version() -> u32 {
    1
}

fn default_channel() -> String {
    "stable".to_string()
}

/// Splits the configured registry setting into independent signed registries.
/// Commas/newlines/semicolons let enterprises combine an official registry with
/// a company mirror without changing the settings schema.
pub fn registry_urls(raw: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for part in raw.split(|character: char| {
        character == ',' || character == ';' || character == '\n' || character == '\r'
    }) {
        let part = part.trim();
        if !part.is_empty() && !urls.iter().any(|existing| existing == part) {
            urls.push(part.to_string());
        }
    }
    urls
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    let hash = digest.finalize();
    let mut out = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn publisher_fingerprint(public_key: &str) -> Option<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key.trim())
        .ok()?;
    Some(super::signature::key_fingerprint(&bytes))
}

fn cache_json_valid(body: &str) -> bool {
    serde_json::from_str::<Value>(body).is_ok()
}

fn resolve_package_url(registry_url: &str, package_url: &str) -> Result<String> {
    if package_url.contains("://") || std::path::Path::new(package_url).is_absolute() {
        return Ok(package_url.to_string());
    }
    let local = registry_url
        .strip_prefix("file://")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            (!registry_url.contains("://")).then(|| std::path::PathBuf::from(registry_url))
        });
    if let Some(path) = local {
        let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
        return Ok(parent.join(package_url).to_string_lossy().to_string());
    }
    let base = url::Url::parse(registry_url).context("invalid registry URL")?;
    Ok(base.join(package_url).context("invalid package URL")?.to_string())
}

impl PluginManager {
    async fn load_registry(&self, url: &str, force: bool) -> Result<(RegistryIndex, PluginStoreView, VerifiedKey)> {
        let url = url.trim();
        if url.is_empty() {
            bail!("PLUGIN_REGISTRY_NOT_CONFIGURED: set a registry URL in Settings → Plugins");
        }
        let cache_key = format!("registry:{url}");
        let cached = self.db().plugin_store_cache_get(&cache_key)?;
        let now = crate::domain::now_ms();
        let (raw, etag, fetched_at) = if let Some((cached_etag, body, cached_at)) = cached {
            if !force && now.saturating_sub(cached_at) < CACHE_TTL_MS {
                if cache_json_valid(&body) {
                    (body, cached_etag, cached_at)
                } else {
                    // A corrupt cache is ignored, never trusted as an index.
                    self.fetch_registry(url, None).await?
                }
            } else {
                match self.fetch_registry(url, cached_etag.as_deref()).await {
                    Ok(fresh) => fresh,
                    Err(error) if !force && cache_json_valid(&body) => {
                        // Offline/stale registry: keep the signed cached index
                        // usable instead of blocking the store. Signature and
                        // publisher pinning are still verified below.
                        eprintln!("zylara: plugin registry offline, using cache: {error:#}");
                        (body, cached_etag, cached_at)
                    }
                    Err(error) => return Err(error),
                }
            }
        } else {
            self.fetch_registry(url, None).await?
        };
        if raw.len() > MAX_REGISTRY_BYTES {
            bail!("PLUGIN_REGISTRY_INVALID: registry exceeds 4 MiB");
        }
        let mut value: Value = serde_json::from_str(&raw)
            .context("PLUGIN_REGISTRY_INVALID: registry is not valid JSON")?;
        let signature_value = value
            .get("signature")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_REGISTRY_UNSIGNED: registry has no signature"))?;
        let signature: RegistrySignature = serde_json::from_value(signature_value)
            .context("PLUGIN_REGISTRY_INVALID: signature block is invalid")?;
        if let Some(object) = value.as_object_mut() {
            object.remove("signature");
        }
        let canonical = serde_json::to_vec(&value)?;
        let verified = super::signature::verify_registry(&canonical, &signature)
            .context("PLUGIN_REGISTRY_SIGNATURE_INVALID: registry signature does not match")?;
        let registry_publisher = format!("registry:{url}");
        if let Some(existing) = self
            .db()
            .plugin_publisher_key(&registry_publisher, &verified.key_id)?
        {
            if existing.revoked || existing.public_key != verified.public_key {
                bail!("PLUGIN_REGISTRY_KEY_CHANGED: registry key is not the pinned key");
            }
        } else {
            self.db().plugin_pin_publisher(
                &registry_publisher,
                &verified.key_id,
                &verified.public_key,
                &verified.fingerprint,
            )?;
        }
        let index: RegistryIndex =
            serde_json::from_value(value).context("PLUGIN_REGISTRY_INVALID: registry shape")?;
        if index.schema_version != REGISTRY_SCHEMA_VERSION {
            bail!(
                "PLUGIN_REGISTRY_UNSUPPORTED: schemaVersion {}",
                index.schema_version
            );
        }
        for plugin in &index.plugins {
            super::manifest::validate_plugin_id(&plugin.id)
                .with_context(|| format!("registry plugin `{}`", plugin.id))?;
            if plugin.package_url.trim().is_empty() {
                bail!("PLUGIN_REGISTRY_INVALID: `{}` has no packageUrl", plugin.id);
            }
            permissions::validate_declared(&plugin.permissions).with_context(|| {
                format!("PLUGIN_REGISTRY_INVALID: `{}` permissions", plugin.id)
            })?;
        }
        self.apply_revocations(&index)?;
        let view = PluginStoreView {
            plugins: index
                .plugins
                .iter()
                .cloned()
                .map(|mut plugin| {
                    plugin.registry_url = url.to_string();
                    plugin.key_fingerprint =
                        publisher_fingerprint(&plugin.publisher.public_key);
                    plugin
                })
                .collect(),
            revoked: index.revoked.clone(),
            source_url: url.to_string(),
            fetched_at,
            registry_name: index.name.clone(),
            signature_key_id: Some(verified.key_id.clone()),
        };
        let _ = self.db().plugin_store_cache_set(&cache_key, etag.as_deref(), &raw);
        Ok((index, view, verified))
    }

    async fn fetch_registry(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<(String, Option<String>, i64)> {
        let now = crate::domain::now_ms();
        let local = if let Some(path) = url.strip_prefix("file://") {
            Some(std::path::PathBuf::from(path))
        } else if !url.contains("://") && self.options().dev_mode {
            Some(std::path::PathBuf::from(url))
        } else {
            None
        };
        if let Some(path) = local {
            if !self.options().dev_mode {
                bail!("PLUGIN_REGISTRY_LOCAL_BLOCKED: enable developer mode for local registries");
            }
            let raw = std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read registry {}", path.display()))?;
            if raw.len() > MAX_REGISTRY_BYTES {
                bail!("PLUGIN_REGISTRY_INVALID: registry exceeds 4 MiB");
            }
            return Ok((raw, None, now));
        }
        let parsed = url::Url::parse(url)
            .with_context(|| format!("PLUGIN_REGISTRY_INVALID: invalid URL `{url}`"))?;
        if parsed.scheme() != "https" {
            bail!("PLUGIN_REGISTRY_INVALID: registry URL must use https");
        }
        let mut request = self.http().get(parsed.clone()).timeout(std::time::Duration::from_secs(20));
        if let Some(etag) = etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        let response = request.send().await.context("registry request failed")?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            if let Some((etag, body, fetched_at)) = self
                .db()
                .plugin_store_cache_get(&format!("registry:{url}"))?
            {
                return Ok((body, etag, fetched_at));
            }
            bail!("PLUGIN_REGISTRY_INVALID: 304 without cache");
        }
        if !response.status().is_success() {
            bail!("PLUGIN_REGISTRY_HTTP: status {}", response.status());
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response.chunk().await? {
            if body.len() + chunk.len() > MAX_REGISTRY_BYTES {
                bail!("PLUGIN_REGISTRY_INVALID: registry exceeds 4 MiB");
            }
            body.extend_from_slice(&chunk);
        }
        Ok((String::from_utf8(body).context("registry is not UTF-8")?, etag, now))
    }

    pub async fn store_view(&self, url: &str, force: bool) -> Result<PluginStoreView> {
        let urls = registry_urls(url);
        if urls.is_empty() {
            bail!("PLUGIN_REGISTRY_NOT_CONFIGURED: set a registry URL in Settings → Plugins");
        }
        if urls.len() == 1 {
            let (_, view, _) = self.load_registry(&urls[0], force).await?;
            return Ok(view);
        }
        let mut views = Vec::new();
        let mut last_error = None;
        for registry_url in &urls {
            match self.load_registry(registry_url, force).await {
                Ok((_, view, _)) => views.push(view),
                Err(error) => last_error = Some(error),
            }
        }
        let Some(first) = views.first() else {
            return Err(last_error.unwrap_or_else(|| anyhow::anyhow!("PLUGIN_REGISTRY_INVALID")));
        };
        let mut plugins = BTreeMap::new();
        let mut revoked = BTreeMap::new();
        let mut fetched_at = 0;
        let mut registry_names = Vec::new();
        let mut signature_key_id = None;
        for view in &views {
            fetched_at = fetched_at.max(view.fetched_at);
            registry_names.push(view.registry_name.clone());
            signature_key_id = signature_key_id.or_else(|| view.signature_key_id.clone());
            for plugin in &view.plugins {
                plugins.entry(plugin.id.clone()).or_insert_with(|| plugin.clone());
            }
            for entry in &view.revoked {
                revoked
                    .entry((entry.id.clone(), entry.version.clone()))
                    .or_insert_with(|| entry.clone());
            }
        }
        Ok(PluginStoreView {
            plugins: plugins.into_values().collect(),
            revoked: revoked.into_values().collect(),
            source_url: urls.join("\n"),
            fetched_at,
            registry_name: if registry_names.is_empty() {
                first.registry_name.clone()
            } else {
                registry_names.join(" + ")
            },
            signature_key_id,
        })
    }

    pub async fn check_updates(&self, url: &str, force: bool) -> Result<Vec<PluginUpdateInfo>> {
        let urls = registry_urls(url);
        if urls.is_empty() {
            bail!("PLUGIN_REGISTRY_NOT_CONFIGURED: set a registry URL in Settings → Plugins");
        }
        let mut candidates: HashMap<String, RegistryPlugin> = HashMap::new();
        let mut revoked: HashSet<(String, String)> = HashSet::new();
        let mut loaded_any = false;
        let mut last_error = None;
        for registry_url in &urls {
            match self.load_registry(registry_url, force).await {
                Ok((index, _, _)) => {
                    loaded_any = true;
                    for entry in &index.revoked {
                        revoked.insert((entry.id.clone(), entry.version.clone()));
                    }
                    for plugin in index.plugins {
                        let replace = candidates
                            .get(&plugin.id)
                            .map_or(true, |current| version::is_newer(&plugin.version, &current.version));
                        if replace {
                            candidates.insert(plugin.id.clone(), plugin);
                        }
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }
        if !loaded_any {
            return Err(last_error.unwrap_or_else(|| anyhow::anyhow!("PLUGIN_REGISTRY_INVALID")));
        }
        let mut updates = Vec::new();
        for stored in self.db().plugin_list()? {
            let Some(candidate) = candidates.get(&stored.id) else {
                continue;
            };
            if candidate.version == stored.version
                || !version::is_newer(&candidate.version, &stored.version)
            {
                continue;
            }
            if candidate.yanked
                || revoked.contains(&(stored.id.clone(), candidate.version.clone()))
            {
                continue;
            }
            if candidate
                .min_app_version
                .as_deref()
                .is_some_and(|minimum| version::is_newer(minimum, env!("CARGO_PKG_VERSION")))
            {
                continue;
            }
            let current_grants = self.db().plugin_granted_permissions(&stored.id)?;
            let new_permissions = candidate
                .permissions
                .iter()
                .filter(|permission| !permissions::granted_any(&current_grants, permission))
                .cloned()
                .collect();
            updates.push(PluginUpdateInfo {
                plugin_id: stored.id.clone(),
                name: candidate.name.clone(),
                current_version: stored.version.clone(),
                latest_version: candidate.version.clone(),
                package_url: candidate.package_url.clone(),
                package_sha256: candidate.package_sha256.clone(),
                key_fingerprint: candidate
                    .key_fingerprint
                    .clone()
                    .or_else(|| publisher_fingerprint(&candidate.publisher.public_key)),
                permissions: candidate.permissions.clone(),
                new_permissions,
                yanked: candidate.yanked,
                channel: candidate.channel.clone(),
                summary: Some(candidate.summary.clone()),
            });
        }
        updates.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        Ok(updates)
    }

    pub async fn install_from_registry(
        &self,
        url: &str,
        plugin_id: &str,
        granted_permissions: Option<Vec<String>>,
    ) -> Result<super::PluginRecord> {
        self.install_from_registry_with_rotation(url, plugin_id, granted_permissions, false)
            .await
    }

    pub async fn install_from_registry_with_rotation(
        &self,
        url: &str,
        plugin_id: &str,
        granted_permissions: Option<Vec<String>>,
        allow_key_rotation: bool,
    ) -> Result<super::PluginRecord> {
        let urls = registry_urls(url);
        if urls.is_empty() {
            bail!("PLUGIN_REGISTRY_NOT_CONFIGURED: set a registry URL in Settings → Plugins");
        }
        let mut last_error = None;
        for registry_url in &urls {
            let (index, _, _) = match self.load_registry(registry_url, false).await {
                Ok(loaded) => loaded,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let Some(candidate) = index
                .plugins
                .iter()
                .find(|plugin| plugin.id == plugin_id)
            else {
                continue;
            };
            return self
                .install_registry_candidate(
                    registry_url,
                    &index,
                    candidate,
                    granted_permissions.clone(),
                    allow_key_rotation,
                )
                .await;
        }
        if let Some(error) = last_error {
            return Err(error);
        }
        bail!("PLUGIN_NOT_FOUND: `{plugin_id}` is not in any configured registry")
    }

    async fn install_registry_candidate(
        &self,
        registry_url: &str,
        index: &RegistryIndex,
        candidate: &RegistryPlugin,
        granted_permissions: Option<Vec<String>>,
        allow_key_rotation: bool,
    ) -> Result<super::PluginRecord> {
        if candidate.yanked
            || self.is_revoked(index, &candidate.id, &candidate.version)
        {
            bail!("PLUGIN_REVOKED: this version is not installable");
        }
        if candidate
            .min_app_version
            .as_deref()
            .is_some_and(|minimum| version::is_newer(minimum, env!("CARGO_PKG_VERSION")))
        {
            bail!("PLUGIN_INCOMPATIBLE: plugin requires a newer Zylara");
        }
        let bytes = self
            .download_package(
                &resolve_package_url(registry_url, &candidate.package_url)?,
                candidate.package_size,
            )
            .await?;
        if let Some(expected) = &candidate.package_sha256 {
            let actual = sha256_hex(&bytes);
            if !expected.eq_ignore_ascii_case(&actual) {
                bail!("PLUGIN_PACKAGE_HASH_MISMATCH: registry hash does not match the download");
            }
        }
        let package = super::package::read_bytes(&bytes, false)?;
        if package.manifest.id != candidate.id {
            bail!("PLUGIN_PUBLISHER_MISMATCH: package id does not match the registry entry");
        }
        if package.manifest.version != candidate.version {
            bail!("PLUGIN_VERSION_MISMATCH: package version does not match the registry entry");
        }
        // The package signature must belong to the registry publisher key,
        // checked before extraction so a failed update never disturbs the
        // installed version.
        if candidate.publisher.public_key.trim().is_empty() {
            bail!("PLUGIN_PUBLISHER_MISSING: registry entry has no publisher publicKey");
        }
        {
            use base64::Engine as _;
            let key = base64::engine::general_purpose::STANDARD
                .decode(candidate.publisher.public_key.trim())
                .context("registry publisher publicKey is invalid")?;
            let expected = super::signature::key_fingerprint(&key);
            if package
                .verified
                .as_ref()
                .map(|verified| verified.fingerprint.as_str())
                != Some(expected.as_str())
            {
                bail!("PLUGIN_PUBLISHER_MISMATCH: package was not signed by the registry publisher key");
            }
        }
        self.install_package_with_rotation(
            package,
            super::InstallOptions {
                source: format!("store:{registry_url}"),
                allow_unsigned: false,
                granted_permissions,
            },
            allow_key_rotation,
        )
    }

    pub async fn update_from_registry(
        &self,
        url: &str,
        plugin_id: &str,
        granted_permissions: Option<Vec<String>>,
    ) -> Result<super::PluginRecord> {
        self.install_from_registry(url, plugin_id, granted_permissions).await
    }

    pub async fn update_from_registry_with_rotation(
        &self,
        url: &str,
        plugin_id: &str,
        granted_permissions: Option<Vec<String>>,
        allow_key_rotation: bool,
    ) -> Result<super::PluginRecord> {
        self.install_from_registry_with_rotation(
            url,
            plugin_id,
            granted_permissions,
            allow_key_rotation,
        )
        .await
    }

    async fn download_package(&self, url: &str, size_hint: Option<u64>) -> Result<Vec<u8>> {
        let local = if let Some(path) = url.strip_prefix("file://") {
            Some(std::path::PathBuf::from(path))
        } else if !url.contains("://") && self.options().dev_mode {
            Some(std::path::PathBuf::from(url))
        } else {
            None
        };
        if let Some(path) = local {
            if !self.options().dev_mode {
                bail!("PLUGIN_PACKAGE_URL: local packages require developer mode");
            }
            let metadata =
                std::fs::metadata(&path).with_context(|| format!("cannot read {}", path.display()))?;
            if metadata.len() > super::contract::limits().trusted_package_bytes {
                bail!("PLUGIN_PACKAGE_TOO_LARGE: package exceeds the limit");
            }
            return std::fs::read(&path)
                .with_context(|| format!("cannot read {}", path.display()));
        }
        let parsed = url::Url::parse(url).with_context(|| format!("invalid package URL `{url}`"))?;
        if parsed.scheme() != "https" {
            bail!("PLUGIN_PACKAGE_URL: package URL must use https");
        }
        if size_hint.is_some_and(|size| size > super::contract::limits().trusted_package_bytes) {
            bail!("PLUGIN_PACKAGE_TOO_LARGE: registry advertises an oversized package");
        }
        let mut response = self
            .http()
            .get(parsed)
            .timeout(std::time::Duration::from_secs(120))
            .send()
            .await
            .context("package download failed")?;
        if !response.status().is_success() {
            bail!("PLUGIN_PACKAGE_HTTP: status {}", response.status());
        }
        let limit = super::contract::limits().trusted_package_bytes as usize;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > limit {
                bail!("PLUGIN_PACKAGE_TOO_LARGE: package exceeds the limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    fn is_revoked(&self, index: &RegistryIndex, id: &str, version: &str) -> bool {
        index
            .revoked
            .iter()
            .any(|entry| entry.id == id && entry.version == version)
    }

    fn apply_revocations(&self, index: &RegistryIndex) -> Result<()> {
        for entry in &index.revoked {
            if let Some(stored) = self.db().plugin_get(&entry.id)? {
                if stored.version == entry.version && stored.enabled {
                    self.db()
                        .plugin_set_enabled(&entry.id, false, Some("revoked"))?;
                    self.fail_pending_for(&entry.id, "PLUGIN_REVOKED: this version was revoked");
                    let _ = self.db().plugin_log(
                        &entry.id,
                        "error",
                        &format!("version {} was revoked: {}", entry.version, entry.reason),
                    );
                    let _ = self
                        .db()
                        .plugin_audit(&entry.id, "revocation", None, "disabled");
                }
            }
        }
        Ok(())
    }

    pub fn registry_url_from_settings(&self, url: &str) -> String {
        url.trim().to_string()
    }
}
