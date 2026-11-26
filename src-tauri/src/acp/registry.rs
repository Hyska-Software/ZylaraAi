//! ACP Registry client: download, validate, select distributions for the
//! current platform and project the result into the renderer-facing views.
//!
//! The registry is curated but every entry still comes from the network, so a
//! malformed agent is dropped on its own instead of rejecting the whole list.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::{ETAG, IF_NONE_MATCH, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::acp::{AcpRegistryAgent, RegistryFile};
use crate::db::Db;

/// Official, versioned registry endpoint. Local filtering is mandatory: the
/// manifest contains distributions for many platforms at once.
pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// SQLite key holding the last successfully fetched registry snapshot.
pub const REGISTRY_CACHE_KEY: &str = "registry-latest";

const ICON_HOST: &str = "cdn.agentclientprotocol.com";

const SAMPLE: &str = include_str!("testdata/registry-sample.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, rename = "license_url", skip_serializing_if = "Option::is_none")]
    pub license_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub distribution: DistributionMap,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DistributionMap {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub binary: BTreeMap<String, BinaryDist>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npx: Option<PackageDist>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uvx: Option<PackageDist>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryDist {
    pub archive: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub cmd: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageDist {
    pub package: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// One usable way of running an agent, after platform selection.
#[derive(Debug, Clone)]
pub enum Distribution {
    Binary(BinaryDist),
    Npx(PackageDist),
    Uvx(PackageDist),
}

impl Distribution {
    /// Registry distribution key (`binary`, `npx`, `uvx`).
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Binary(_) => "binary",
            Self::Npx(_) => "npx",
            Self::Uvx(_) => "uvx",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RegistryFetch {
    pub agents: Vec<RegistryManifest>,
    pub etag: Option<String>,
    /// HTTP 304: callers keep their cached snapshot and installed flags.
    pub not_modified: bool,
}

/// Fetches the registry. A 304 with an ETag returns no agents and leaves the
/// previous cache untouched; a network/JSON/format failure is an error that
/// callers convert into "keep last good cache".
pub async fn fetch(http: &reqwest::Client, previous_etag: Option<&str>) -> Result<RegistryFetch> {
    let mut request = http
        .get(REGISTRY_URL)
        .header(USER_AGENT, concat!("Zylara/", env!("CARGO_PKG_VERSION")))
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(Duration::from_secs(20));
    if let Some(etag) = previous_etag {
        request = request.header(IF_NONE_MATCH, etag);
    }

    let response = request.send().await.context("ACP registry request failed")?;
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(RegistryFetch {
            agents: Vec::new(),
            etag: etag.or_else(|| previous_etag.map(str::to_owned)),
            not_modified: true,
        });
    }
    let response = response
        .error_for_status()
        .context("ACP registry returned an error status")?;
    let file: RegistryFile = response.json().await.context("ACP registry JSON is invalid")?;
    if !is_semverish(&file.version) || !file.version.starts_with("1.") {
        bail!("unsupported ACP registry format version: {}", file.version);
    }
    Ok(RegistryFetch {
        agents: validate_manifests(file.agents),
        etag,
        not_modified: false,
    })
}

/// Bundled first-launch snapshot, generated by `scripts/build-acp-registry.mjs`.
pub fn embedded_snapshot() -> RegistryFile {
    serde_json::from_str(include_str!("../../../data/acp-registry.json"))
        .expect("bundled ACP registry snapshot must be valid")
}

/// Manifests from the local cache, falling back to the bundled snapshot.
/// Used by device detection so scanning never needs a network request.
pub fn cached_manifests(db: &Db) -> Vec<RegistryManifest> {
    db.acp_cache_get(REGISTRY_CACHE_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<RegistryFile>(&raw).ok())
        .map(|file| file.agents)
        .unwrap_or_else(|| embedded_snapshot().agents)
}

/// Registry id format (`^[a-z][a-z0-9-]*$`).
pub fn is_valid_agent_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_semverish(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.');
    let mut count = 0;
    parts.all(|part| {
        count += 1;
        count <= 3 && !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
    }) && count == 3
}

fn icon_is_allowed(icon: &str) -> bool {
    match url::Url::parse(icon) {
        Ok(url) => {
            url.scheme() == "https"
                && url.host_str() == Some(ICON_HOST)
                && url.username().is_empty()
                && url.password().is_none()
        }
        Err(_) => false,
    }
}

fn usable_manifest(mut manifest: RegistryManifest) -> Option<RegistryManifest> {
    if !is_valid_agent_id(&manifest.id)
        || !is_semverish(&manifest.version)
        || manifest.name.trim().is_empty()
    {
        return None;
    }
    if let Some(icon) = &manifest.icon {
        if !icon_is_allowed(icon) {
            return None;
        }
    }
    // A broken platform entry must not discard an otherwise usable agent.
    manifest
        .distribution
        .binary
        .retain(|_, dist| !dist.archive.trim().is_empty() && !dist.cmd.trim().is_empty());
    if manifest
        .distribution
        .npx
        .as_ref()
        .is_some_and(|dist| dist.package.trim().is_empty())
    {
        manifest.distribution.npx = None;
    }
    if manifest
        .distribution
        .uvx
        .as_ref()
        .is_some_and(|dist| dist.package.trim().is_empty())
    {
        manifest.distribution.uvx = None;
    }
    if manifest.distribution.binary.is_empty()
        && manifest.distribution.npx.is_none()
        && manifest.distribution.uvx.is_none()
    {
        return None;
    }
    Some(manifest)
}

/// Drops invalid entries one by one; a single hostile icon or bad id never
/// removes the other agents from the list.
pub fn validate_manifests(agents: Vec<RegistryManifest>) -> Vec<RegistryManifest> {
    agents.into_iter().filter_map(usable_manifest).collect()
}

/// Platform string used by the registry manifest, resolved at build time.
/// musl builds prefer their own binary when one is published.
pub fn current_target() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "windows-aarch64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-aarch64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64", target_env = "musl")) {
        "linux-x86_64-musl"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64", target_env = "musl")) {
        "linux-aarch64-musl"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-aarch64"
    } else {
        "unknown"
    }
}

/// Native binary for `target`, then npm, then Python. Package managers are
/// selected only when no binary exists for the current platform.
pub fn select_distribution(manifest: &RegistryManifest, target: &str) -> Option<Distribution> {
    if let Some(binary) = manifest.distribution.binary.get(target) {
        if !binary.archive.trim().is_empty() && !binary.cmd.trim().is_empty() {
            return Some(Distribution::Binary(binary.clone()));
        }
    }
    if let Some(npx) = &manifest.distribution.npx {
        if !npx.package.trim().is_empty() {
            return Some(Distribution::Npx(npx.clone()));
        }
    }
    if let Some(uvx) = &manifest.distribution.uvx {
        if !uvx.package.trim().is_empty() {
            return Some(Distribution::Uvx(uvx.clone()));
        }
    }
    None
}

/// Converts validated manifests into the IPC view consumed by Settings.
/// `installed` holds registry ids (without the `acp__` provider prefix).
pub fn to_views(manifests: &[RegistryManifest], installed: &[String]) -> Vec<AcpRegistryAgent> {
    let target = current_target();
    manifests
        .iter()
        .map(|manifest| {
            let mut platforms: Vec<String> = manifest.distribution.binary.keys().cloned().collect();
            platforms.sort();
            let mut distributions: Vec<String> = platforms.clone();
            if manifest.distribution.npx.is_some() {
                distributions.push("npx".into());
            }
            if manifest.distribution.uvx.is_some() {
                distributions.push("uvx".into());
            }
            distributions.sort();
            distributions.dedup();
            let supported = select_distribution(manifest, target).is_some();
            let install_reason = if supported {
                None
            } else if manifest.distribution.binary.is_empty() {
                Some("no-distribution".into())
            } else {
                Some(format!("no-build-for-{target}"))
            };
            let (command, args, env_names) = match select_distribution(manifest, target) {
                Some(Distribution::Binary(dist)) => (
                    dist.cmd.clone(),
                    dist.args.clone(),
                    dist.env.keys().cloned().collect(),
                ),
                Some(Distribution::Npx(dist)) => {
                    let mut args = vec![dist.package.clone()];
                    args.extend(dist.args.clone());
                    ("npx".to_string(), args, dist.env.keys().cloned().collect())
                }
                Some(Distribution::Uvx(dist)) => {
                    let mut args = vec![dist.package.clone()];
                    args.extend(dist.args.clone());
                    ("uvx".to_string(), args, dist.env.keys().cloned().collect())
                }
                None => (String::new(), Vec::new(), Vec::new()),
            };
            AcpRegistryAgent {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                version: manifest.version.clone(),
                description: manifest.description.clone(),
                homepage: manifest.website.clone(),
                repository: manifest.repository.clone(),
                license: manifest.license.clone(),
                icon_url: manifest.icon.clone(),
                distributions,
                platforms,
                installed: installed.iter().any(|id| id == &manifest.id),
                command,
                args,
                env_names,
                update_available: false,
                supported,
                install_reason,
                icon_svg: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RegistryFile {
        let value: serde_json::Value = serde_json::from_str(SAMPLE).expect("fixture is JSON");
        let agents = value
            .get("agents")
            .and_then(serde_json::Value::as_array)
            .expect("fixture has agents")
            .iter()
            .filter_map(|entry| serde_json::from_value::<RegistryManifest>(entry.clone()).ok())
            .collect();
        RegistryFile {
            version: value
                .get("version")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("1.0.0")
                .to_string(),
            agents,
        }
    }

    #[test]
    fn bundled_snapshot_is_complete_and_valid() {
        let snapshot = embedded_snapshot();
        assert_eq!(snapshot.version, "1.0.0");
        assert!(snapshot.agents.len() >= 40);
        assert_eq!(validate_manifests(snapshot.agents.clone()).len(), snapshot.agents.len());
        let ids: std::collections::BTreeSet<_> = snapshot.agents.iter().map(|agent| &agent.id).collect();
        assert_eq!(ids.len(), snapshot.agents.len());
    }

    #[test]
    fn invalid_entries_are_skipped_individually() {
        let agents = validate_manifests(sample().agents);
        assert_eq!(agents.len(), 4);
        let ids: Vec<_> = agents.iter().map(|agent| agent.id.as_str()).collect();
        assert_eq!(
            ids,
            ["binary-agent", "npx-agent", "uvx-agent", "no-target-agent"]
        );
        assert!(agents.iter().all(|agent| agent.id != "Bad_ID"));
        assert!(agents.iter().all(|agent| agent.id != "hostile-icon"));
        assert!(agents.iter().all(|agent| agent.id != "bad-version"));
        assert!(agents.iter().all(|agent| agent.id != "bad-binary"));
    }

    #[test]
    fn distribution_selection_prefers_binary_then_npx_then_uvx() {
        let agents = validate_manifests(sample().agents);
        let by_id = |id: &str| agents.iter().find(|agent| agent.id == id).expect("fixture agent");

        let binary = select_distribution(by_id("binary-agent"), "windows-x86_64").expect("binary");
        assert_eq!(binary.kind(), "binary");
        match binary {
            Distribution::Binary(dist) => assert_eq!(dist.cmd, "bin/agent.exe"),
            _ => panic!("expected binary distribution"),
        }
        // A platform without a binary falls back to the package managers.
        assert_eq!(
            select_distribution(by_id("binary-agent"), "darwin-aarch64").map(|dist| dist.kind()),
            None
        );
        assert_eq!(
            select_distribution(by_id("npx-agent"), "windows-x86_64").map(|dist| dist.kind()),
            Some("npx")
        );
        assert_eq!(
            select_distribution(by_id("uvx-agent"), "windows-x86_64").map(|dist| dist.kind()),
            Some("uvx")
        );
        assert_eq!(
            select_distribution(by_id("uvx-agent"), "darwin-aarch64").map(|dist| dist.kind()),
            Some("binary")
        );
        assert!(select_distribution(by_id("no-target-agent"), "windows-x86_64").is_none());
    }

    #[test]
    fn views_report_sorted_platforms_installed_and_supported() {
        let agents = validate_manifests(sample().agents);
        let views = to_views(&agents, &["npx-agent".into()]);
        assert_eq!(views.len(), 4);
        let binary = views.iter().find(|view| view.id == "binary-agent").expect("binary view");
        assert_eq!(binary.platforms, ["linux-x86_64", "windows-x86_64"]);
        assert_eq!(
            binary.distributions,
            ["linux-x86_64", "windows-x86_64"]
        );
        assert!(binary.supported);
        assert!(!binary.installed);
        assert_eq!(binary.install_reason, None);
        assert_eq!(binary.homepage.as_deref(), Some("https://example.org/binary-agent"));
        assert_eq!(binary.license.as_deref(), Some("MIT"));

        let installed = views.iter().find(|view| view.id == "npx-agent").expect("npx view");
        assert!(installed.installed);
        assert!(installed.supported);
        assert!(installed.distributions.contains(&"npx".to_string()));

        let unsupported = views
            .iter()
            .find(|view| view.id == "no-target-agent")
            .expect("unsupported view");
        assert!(!unsupported.supported);
        assert!(unsupported
            .install_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("no-build-for-")));
    }

    #[test]
    fn ids_versions_and_icons_are_validated() {
        assert!(is_valid_agent_id("a"));
        assert!(is_valid_agent_id("some-agent-123"));
        assert!(!is_valid_agent_id("A-gent"));
        assert!(!is_valid_agent_id("-agent"));
        assert!(!is_valid_agent_id("agent_x"));
        assert!(is_semverish("1.4.0"));
        assert!(is_semverish("3000.14.30821"));
        assert!(is_semverish("2.0.0-beta.1+build.7"));
        assert!(!is_semverish("1.2"));
        assert!(!is_semverish("v1.2.3"));
        assert!(icon_is_allowed(
            "https://cdn.agentclientprotocol.com/registry/v1/latest/agent.svg"
        ));
        assert!(!icon_is_allowed("https://evil.example.org/icon.svg"));
        assert!(!icon_is_allowed("http://cdn.agentclientprotocol.com/icon.svg"));
        assert!(!icon_is_allowed("https://cdn.agentclientprotocol.com.evil.org/icon.svg"));
    }

    #[test]
    fn current_target_is_a_manifest_target_or_unknown() {
        let target = current_target();
        assert!(
            target == "unknown" || target.starts_with("windows-") || target.starts_with("linux-")
            || target.starts_with("darwin-"),
            "unexpected target: {target}"
        );
    }

    #[test]
    fn views_expose_the_exact_launch_command_and_installed_flag() {
        let manifests = sample().agents;
        let target = current_target();
        let id = manifests
            .iter()
            .find(|manifest| select_distribution(manifest, target).is_some())
            .map(|manifest| manifest.id.clone())
            .expect("a supported manifest in the fixture");
        let views = to_views(&manifests, &[id.clone()]);
        let view = views.iter().find(|view| view.id == id).expect("registry view");
        assert!(view.installed);
        assert!(!view.command.is_empty(), "consent must show the exact command");
        assert!(view.args.iter().all(|arg| !arg.is_empty()));
    }
}
