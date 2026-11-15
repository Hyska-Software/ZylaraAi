//! Safe `.zplugin` package reading, inspection and atomic extraction.
//!
//! A package is a ZIP with `manifest.json` at the root and an optional detached
//! `META-INF/signature.json`. Nothing is written to disk until the archive,
//! manifest, signature, limits and every path have been validated.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::contract;
use super::manifest::{validate_relative_path, PluginManifest, ToolContribution, ToolSource};
use super::signature::{self, PackageSignature, VerifiedKey, SIGNATURE_PATH};

pub const MANIFEST_PATH: &str = "manifest.json";
pub const MAX_TOOL_JSON_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct PackageFiles {
    pub manifest: PluginManifest,
    /// Every package file except the signature (path → bytes).
    pub files: BTreeMap<String, Vec<u8>>,
    pub signature: Option<PackageSignature>,
    pub verified: Option<VerifiedKey>,
    pub package_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInspection {
    pub manifest: PluginManifest,
    /// `verified` | `unsigned` | `invalid`
    pub signature_status: String,
    pub publisher_id: String,
    pub publisher_name: String,
    pub key_id: Option<String>,
    pub key_fingerprint: Option<String>,
    pub permissions: Vec<String>,
    pub file_count: usize,
    pub total_bytes: u64,
    pub package_hash: String,
    pub warnings: Vec<String>,
    pub engine_ok: bool,
}

pub fn read_bytes(bytes: &[u8], allow_unsigned: bool) -> Result<PackageFiles> {
    let limits = contract::limits();
    if bytes.len() as u64 > limits.trusted_package_bytes {
        bail!(
            "package is too large ({} bytes; limit {})",
            bytes.len(),
            limits.trusted_package_bytes
        );
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).context("package is not a valid ZIP")?;
    if archive.len() > limits.files {
        bail!("package has {} entries; limit is {}", archive.len(), limits.files);
    }
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut total: u64 = 0;
    let mut seen_lowercase = std::collections::HashSet::new();
    let mut signature_bytes: Option<Vec<u8>> = None;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .with_context(|| format!("cannot read ZIP entry #{index}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .name()
            .map_err(|error| anyhow::anyhow!("cannot read ZIP entry name: {error}"))?
            .to_string();
        if name.contains('\\') {
            bail!("ZIP entry `{name}` uses a backslash separator");
        }
        validate_relative_path(&name).with_context(|| format!("unsafe ZIP entry `{name}`"))?;
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind == 0o120000 {
                bail!("ZIP entry `{name}` is a symbolic link");
            }
            if kind != 0 && kind != 0o100000 {
                bail!("ZIP entry `{name}` is not a regular file");
            }
        }
        let key = name.to_ascii_lowercase();
        if !seen_lowercase.insert(key) {
            bail!("ZIP contains duplicate (case-insensitive) path `{name}`");
        }
        if entry.size() > limits.unpacked_bytes {
            bail!("ZIP entry `{name}` is too large");
        }
        let mut data = Vec::with_capacity(entry.size().min(8 * 1024 * 1024) as usize);
        entry
            .read_to_end(&mut data)
            .with_context(|| format!("cannot decompress `{name}`"))?;
        total = total.saturating_add(data.len() as u64);
        if total > limits.unpacked_bytes {
            bail!(
                "package expands to more than {} bytes",
                limits.unpacked_bytes
            );
        }
        let lower_name = name.to_ascii_lowercase();
        if lower_name.ends_with(".key")
            || lower_name.ends_with("/publisher.pem")
            || lower_name == "publisher.pem"
        {
            bail!("package contains signing material (`{name}`)");
        }
        if name == SIGNATURE_PATH {
            signature_bytes = Some(data);
        } else {
            files.insert(name, data);
        }
    }
    if files.len() > limits.files {
        bail!("package has too many files");
    }
    let manifest_bytes = files
        .get(MANIFEST_PATH)
        .ok_or_else(|| anyhow::anyhow!("package has no root {MANIFEST_PATH}"))?;
    let manifest = PluginManifest::parse(manifest_bytes)?;
    let max = if manifest.is_trusted() {
        limits.trusted_package_bytes
    } else {
        limits.package_bytes
    };
    if bytes.len() as u64 > max {
        bail!(
            "package is too large for its trust level ({} bytes; limit {})",
            bytes.len(),
            max
        );
    }
    if total > max {
        bail!(
            "package expands beyond the limit for its trust level ({} bytes; limit {})",
            total,
            max
        );
    }
    if !manifest.supports_current_app() {
        bail!(
            "plugin requires Zylara `{}`; this app is {}",
            manifest.engines.zylara,
            env!("CARGO_PKG_VERSION")
        );
    }

    let signature = match signature_bytes {
        Some(raw) => {
            let signature: PackageSignature = serde_json::from_slice(&raw)
                .context("META-INF/signature.json is not valid JSON")?;
            Some(signature)
        }
        None => None,
    };
    let verified = match &signature {
        Some(signature) => {
            if signature.publisher_id != manifest.publisher.id {
                bail!(
                    "signature publisher `{}` does not match manifest publisher `{}`",
                    signature.publisher_id,
                    manifest.publisher.id
                );
            }
            if !manifest.publisher.key_id.trim().is_empty()
                && !signature.key_id.eq_ignore_ascii_case(manifest.publisher.key_id.trim())
            {
                bail!(
                    "signature keyId `{}` does not match manifest keyId `{}`",
                    signature.key_id,
                    manifest.publisher.key_id
                );
            }
            Some(
                signature::verify_package(&files, signature)
                    .context("publisher signature verification failed")?,
            )
        }
        None => {
            if !allow_unsigned {
                bail!("package is not signed");
            }
            None
        }
    };
    let package_hash = signature::package_digest(&files);
    Ok(PackageFiles {
        manifest,
        files,
        signature,
        verified,
        package_hash,
    })
}

pub fn read_file(path: &Path, allow_unsigned: bool) -> Result<PackageFiles> {
    let bytes = std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    read_bytes(&bytes, allow_unsigned)
}

/// Reads an unpacked development plugin folder. Dev packages are never signed
/// and only load when developer mode is explicitly enabled.
pub fn read_dev_folder(root: &Path) -> Result<PackageFiles> {
    let limits = contract::limits();
    let manifest_path = root.join(MANIFEST_PATH);
    let manifest_bytes = std::fs::read(&manifest_path)
        .with_context(|| format!("cannot read {}", manifest_path.display()))?;
    let manifest = PluginManifest::parse(&manifest_bytes)?;
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    collect_folder(root, root, &mut files, &mut total, limits.files, limits.package_bytes)?;
    files.insert(MANIFEST_PATH.to_string(), manifest_bytes);
    let package_hash = signature::package_digest(&files);
    Ok(PackageFiles {
        manifest,
        files,
        signature: None,
        verified: None,
        package_hash,
    })
}

fn collect_folder(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut u64,
    max_files: usize,
    max_bytes: u64,
) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("cannot list {}", dir.display()))? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            bail!("development plugin contains a symlink: {}", entry.path().display());
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_folder(root, &path, files, total, max_files, max_bytes)?;
            continue;
        }
        if !file_type.is_file() {
            bail!("development plugin contains a special file: {}", path.display());
        }
        let relative = path
            .strip_prefix(root)
            .context("development plugin path escapes its folder")?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        validate_relative_path(&relative)?;
        let bytes = std::fs::read(&path)?;
        *total = total.saturating_add(bytes.len() as u64);
        if *total > max_bytes {
            bail!("development plugin exceeds {max_bytes} bytes");
        }
        if files.len() >= max_files {
            bail!("development plugin has more than {max_files} files");
        }
        files.insert(relative, bytes);
    }
    Ok(())
}

/// Resolves the effective tool list (inline or `tools.json`), validating each
/// entry. Kept separate from manifest validation so `tools.json` is parsed only
/// once and errors point at the file.
pub fn resolve_tools(package: &PackageFiles) -> Result<Vec<ToolContribution>> {
    let Some(source) = &package.manifest.contributes.tools else {
        return Ok(Vec::new());
    };
    let tools = match source {
        ToolSource::Inline(tools) => tools.clone(),
        ToolSource::File(path) => {
            let bytes = package
                .files
                .get(path)
                .ok_or_else(|| anyhow::anyhow!("tools file `{path}` is missing"))?;
            if bytes.len() > MAX_TOOL_JSON_BYTES {
                bail!("tools file `{path}` exceeds {MAX_TOOL_JSON_BYTES} bytes");
            }
            serde_json::from_slice::<Vec<ToolContribution>>(bytes)
                .with_context(|| format!("tools file `{path}` is invalid"))?
        }
    };
    if tools.len() > 64 {
        bail!("plugin declares more than 64 tools");
    }
    validate_tools(&tools)?;
    Ok(tools)
}

pub fn validate_tools(tools: &[ToolContribution]) -> Result<()> {
    if tools.len() > 64 {
        bail!("plugin declares more than 64 tools");
    }
    let mut names = std::collections::HashSet::new();
    for tool in tools {
        if tool.name.is_empty()
            || tool.name.chars().count() > 32
            || !tool
                .name
                .chars()
                .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_')
            || tool.name.starts_with('_')
        {
            bail!("tool name `{}` is invalid (use lowercase letters/digits/underscore)", tool.name);
        }
        if !names.insert(tool.name.as_str()) {
            bail!("duplicate tool `{}`", tool.name);
        }
        if tool.description.trim().is_empty() || tool.description.chars().count() > 2_000 {
            bail!("tool `{}` description must have 1..=2000 characters", tool.name);
        }
        if !tool.parameters.is_object() || tool.parameters["type"] != "object" {
            bail!("tool `{}` parameters must be a JSON object schema with type=object", tool.name);
        }
        if !matches!(tool.risk.as_str(), "read" | "network" | "write" | "shell") {
            bail!("tool `{}` has invalid risk `{}`", tool.name, tool.risk);
        }
        if tool.profiles.is_empty()
            || tool
                .profiles
                .iter()
                .any(|profile| !matches!(profile.as_str(), "chat" | "code"))
        {
            bail!("tool `{}` has invalid profiles", tool.name);
        }
        if let Some(timeout) = tool.timeout_secs {
            if !(1..=600).contains(&timeout) {
                bail!("tool `{}` timeoutSecs must be between 1 and 600", tool.name);
            }
        }
    }
    Ok(())
}
