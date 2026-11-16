//! Safe filesystem boundary for the `plugin_studio` authoring tool.
//!
//! A plugin folder lives either in the app-data studio or inside a trusted
//! workspace. This module collects package files without signing material,
//! writes signed `.zplugin` archives and reads them back with the same
//! verification path used by installation.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use ed25519_dalek::SigningKey;

use super::contract;
use super::manifest::{validate_relative_path, PluginManifest};
use super::package::{self, PackageFiles, MANIFEST_PATH};
use super::signature::{self, SIGNATURE_PATH};

const EXCLUDED_DIRS: &[&str] = &[".git", "node_modules"];

#[derive(Debug, Clone)]
pub struct AuthoringPackage {
    pub id: String,
    pub version: String,
    pub package_hash: String,
    pub verified: bool,
    pub permissions: Vec<String>,
}

/// Collects an authoring folder into package-relative paths.
///
/// `META-INF` is studio-owned and never shipped. Symlinks, special files,
/// hidden entries and the package output itself are rejected or skipped so a
/// later `pack` cannot include signing material or a previous archive.
pub fn collect_authoring_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    if !root.is_dir() {
        bail!("PLUGIN_STUDIO_NOT_FOUND: {} is not a plugin folder", root.display());
    }
    let limits = contract::limits();
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    collect(root, root, &mut files, &mut total, limits.files)?;
    if files.get(MANIFEST_PATH).is_none() {
        bail!("PLUGIN_INVALID: manifest.json is missing");
    }
    Ok(files)
}

fn collect(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut u64,
    max_files: usize,
) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("cannot list {}", dir.display()))? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            bail!(
                "PLUGIN_STUDIO_PATH: symlink is not allowed: {}",
                entry.path().display()
            );
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".gitignore" {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if EXCLUDED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if name == "META-INF" {
                continue;
            }
            collect(root, &path, files, total, max_files)?;
            continue;
        }
        if !file_type.is_file() {
            bail!(
                "PLUGIN_STUDIO_PATH: special file is not allowed: {}",
                path.display()
            );
        }
        let relative = path
            .strip_prefix(root)
            .context("plugin path escapes its folder")?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        validate_relative_path(&relative)
            .with_context(|| format!("plugin path `{relative}` is unsafe"))?;
        if relative == SIGNATURE_PATH
            || relative.ends_with(".zplugin")
            || relative.starts_with("META-INF/")
        {
            continue;
        }
        let bytes = std::fs::read(&path)?;
        *total = total.saturating_add(bytes.len() as u64);
        if *total > contract::limits().trusted_package_bytes {
            bail!("PLUGIN_QUOTA_PACKAGE: plugin folder exceeds the package limit");
        }
        if files.len() >= max_files {
            bail!("PLUGIN_QUOTA_FILES: plugin folder has too many files");
        }
        files.insert(relative, bytes);
    }
    Ok(())
}

pub fn parse_authoring_manifest(files: &BTreeMap<String, Vec<u8>>) -> Result<PluginManifest> {
    let bytes = files
        .get(MANIFEST_PATH)
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_INVALID: manifest.json is missing"))?;
    PluginManifest::parse(bytes)
}

pub fn validate_authoring_limits(
    files: &BTreeMap<String, Vec<u8>>,
    manifest: &PluginManifest,
) -> Result<()> {
    let limits = contract::limits();
    let max = if manifest.is_trusted() {
        limits.trusted_package_bytes
    } else {
        limits.package_bytes
    };
    let total: u64 = files.values().map(|bytes| bytes.len() as u64).sum();
    if total > max {
        bail!("PLUGIN_QUOTA_PACKAGE: plugin exceeds {max} bytes");
    }
    if files.len() > limits.files {
        bail!("PLUGIN_QUOTA_FILES: plugin has too many files");
    }
    Ok(())
}

/// Reads an authoring folder without developer mode and without executing it.
pub fn inspect_authoring_folder(path: &Path) -> Result<PackageFiles> {
    let files = collect_authoring_files(path)?;
    let manifest = parse_authoring_manifest(&files)?;
    validate_authoring_limits(&files, &manifest)?;
    let package_hash = signature::package_digest(&files);
    Ok(PackageFiles {
        manifest,
        files,
        signature: None,
        verified: None,
        package_hash,
    })
}

/// Signs and writes a package. The returned map includes the signature file.
pub fn write_signed_package(
    root: &Path,
    out: &Path,
    signing_key: &SigningKey,
    publisher_id: &str,
    key_id: &str,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = collect_authoring_files(root)?;
    let manifest = parse_authoring_manifest(&files)?;
    validate_authoring_limits(&files, &manifest)?;
    if manifest.publisher.id != publisher_id {
        bail!(
            "PLUGIN_STUDIO_KEY: manifest publisher `{}` does not match studio publisher `{publisher_id}`",
            manifest.publisher.id
        );
    }
    if !manifest.publisher.key_id.is_empty()
        && !manifest.publisher.key_id.eq_ignore_ascii_case(key_id)
    {
        bail!(
            "PLUGIN_STUDIO_KEY: manifest keyId `{}` does not match studio key `{key_id}`",
            manifest.publisher.key_id
        );
    }
    let signature = signature::sign_package(&files, publisher_id, key_id, signing_key);
    let signature_bytes = serde_json::to_vec_pretty(&signature)?;
    files.insert(SIGNATURE_PATH.to_string(), signature_bytes);

    let parent = out.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .with_context(|| format!("cannot create {}", parent.display()))?;
    let file_name = out
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_PATH: invalid package output"))?;
    let tmp = parent.join(format!(".{file_name}.tmp"));
    let file = File::create(&tmp)
        .with_context(|| format!("cannot create {}", tmp.display()))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644)
        .last_modified_time(zip::DateTime::default());
    for (path, bytes) in &files {
        writer
            .start_file(path.as_str(), options)
            .with_context(|| format!("cannot add {path} to package"))?;
        writer
            .write_all(bytes)
            .with_context(|| format!("cannot write {path} to package"))?;
    }
    writer.finish().context("cannot finish package")?;
    if out.exists() {
        std::fs::remove_file(out)
            .with_context(|| format!("cannot replace {}", out.display()))?;
    }
    std::fs::rename(&tmp, out)
        .with_context(|| format!("cannot replace {}", out.display()))?;
    Ok(files)
}

pub fn read_package(path: &Path) -> Result<AuthoringPackage> {
    let package = package::read_file(path, false)?;
    Ok(AuthoringPackage {
        id: package.manifest.id.clone(),
        version: package.manifest.version.clone(),
        package_hash: package.package_hash.clone(),
        verified: package.verified.is_some(),
        permissions: package.manifest.permissions.clone(),
    })
}

pub fn read_package_files(path: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    Ok(package::read_file(path, false)?.files)
}

pub fn file_sha256(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    Ok(signature::sha256_hex(&bytes))
}

/// Existing package output path for a plugin folder (`<slug>-<version>.zplugin`
/// next to the folder).
pub fn package_path_for(plugin_dir: &Path) -> Result<PathBuf> {
    let files = collect_authoring_files(plugin_dir)?;
    let manifest = parse_authoring_manifest(&files)?;
    let parent = plugin_dir
        .parent()
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_PATH: plugin folder has no parent"))?;
    let slug = plugin_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("PLUGIN_STUDIO_PATH: invalid plugin folder"))?;
    Ok(parent.join(format!(
        "{}-{}.zplugin",
        slug,
        manifest.version
    )))
}
