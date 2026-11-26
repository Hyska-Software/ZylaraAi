//! Secure installation of agents published in the ACP Registry.
//!
//! Binaries are downloaded over HTTPS, hash-checked before anything is
//! extracted, unpacked with traversal/symlink/ADS/size checks and swapped into
//! place atomically. `npx`/`uvx` agents are only described here: the package
//! manager downloads them on first launch, after the user's consent.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::header::USER_AGENT;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::acp::registry::{self, Distribution, RegistryManifest};
use crate::acp::AcpAgentRow;
use crate::domain::now_ms;

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANSION_RATIO: u64 = 200;
const MAX_ENTRIES: usize = 10_000;
const COPY_CHUNK: usize = 64 * 1024;

/// Metadata of one archive entry, collected before any file is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// Rejects traversal, absolute paths, Windows alternate data streams, reserved
/// device names and other cross-platform path surprises.
fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty() || path.chars().count() > 240 {
        bail!("archive path must have 1..=240 characters: `{path}`");
    }
    if path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.contains(':')
        || path.contains('\0')
    {
        bail!("archive path `{path}` must be relative and use `/` separators");
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            bail!("archive path `{path}` contains an unsafe component");
        }
        if component.ends_with(['.', ' ']) || component.chars().any(char::is_control) {
            bail!("archive path `{path}` contains a Windows-unsafe component");
        }
        let stem = component.split('.').next().unwrap_or(component);
        const RESERVED: &[&str] = &[
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
            "LPT9",
        ];
        if RESERVED.iter().any(|name| stem.eq_ignore_ascii_case(name)) {
            bail!("archive path `{path}` uses a reserved Windows name");
        }
    }
    Ok(())
}

/// Joins a registry-provided relative path to `base` and proves, by
/// canonicalizing both sides, that the result is still inside `base`.
pub fn safe_join(base: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative_path(relative)?;
    let root = dunce::canonicalize(base).with_context(|| format!("cannot resolve {}", base.display()))?;
    let joined = dunce::canonicalize(root.join(relative))
        .with_context(|| format!("cannot resolve `{relative}` under {}", root.display()))?;
    if joined == root || !joined.starts_with(&root) {
        bail!("path `{relative}` escapes {}", root.display());
    }
    Ok(joined)
}

fn entry_path(base: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative_path(relative)?;
    Ok(base.join(relative))
}

/// Pure validation of an entire archive manifest: no I/O, no extraction.
pub fn validate_entries(entries: &[ArchiveEntry], compressed_size: u64) -> Result<()> {
    if entries.len() > MAX_ENTRIES {
        bail!("archive has too many entries ({})", entries.len());
    }
    let mut seen = HashSet::new();
    let mut total: u64 = 0;
    for entry in entries {
        validate_relative_path(&entry.path)?;
        if entry.is_symlink {
            bail!("archive entry `{}` is a symbolic link", entry.path);
        }
        if !seen.insert(entry.path.to_ascii_lowercase()) {
            bail!("archive has a duplicate path: `{}`", entry.path);
        }
        if entry.is_dir {
            continue;
        }
        total = total.saturating_add(entry.size);
        if total > MAX_UNCOMPRESSED_BYTES {
            bail!(
                "archive expands to more than {} bytes",
                MAX_UNCOMPRESSED_BYTES
            );
        }
        if compressed_size == 0
            || total > compressed_size.saturating_mul(MAX_EXPANSION_RATIO)
        {
            bail!(
                "archive expansion ratio exceeds {MAX_EXPANSION_RATIO}x (`{}`)",
                entry.path
            );
        }
    }
    Ok(())
}

/// Compares the downloaded file against the manifest hash *before* extraction.
/// Missing hashes are allowed (the Registry may omit them); malformed ones are
/// never silently ignored.
pub fn verify_sha256(path: &Path, expected: Option<&str>) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("manifest sha256 is not a 64-character hex string");
    }
    let mut file = fs::File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; COPY_CHUNK];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual != expected {
        bail!("sha256 mismatch: expected {expected}, downloaded {actual}");
    }
    Ok(())
}

/// Detects the archive format from the downloaded file name (which is derived
/// from the manifest URL and never contains a query string).
fn archive_format(file_name: &str) -> Result<&'static str> {
    let name = file_name.to_ascii_lowercase();
    if name.ends_with(".zip") {
        Ok("zip")
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Ok("tar.gz")
    } else {
        bail!("unsupported archive format: {file_name}")
    }
}

fn zip_entries(path: &Path) -> Result<(Vec<ArchiveEntry>, u64)> {
    let file = fs::File::open(path).context("cannot open downloaded archive")?;
    let size = file.metadata()?.len();
    let mut archive = zip::ZipArchive::new(file).context("download is not a valid ZIP archive")?;
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .with_context(|| format!("cannot read ZIP entry #{index}"))?;
        let mut name = entry
            .name()
            .map_err(|error| anyhow::anyhow!("invalid ZIP entry name: {error}"))?
            .to_string();
        let is_dir = entry.is_dir();
        if is_dir && name.ends_with('/') {
            name.pop();
        }
        let mode = entry.unix_mode().unwrap_or(0);
        let kind = mode & 0o170000;
        // Regular files and directories are the only safe kinds. Treat any
        // special kind (symlink, FIFO, device) as unsafe.
        let is_symlink = kind == 0o120000 || (kind != 0 && kind != 0o100000 && kind != 0o040000);
        entries.push(ArchiveEntry {
            path: name,
            size: entry.size(),
            is_dir,
            is_symlink,
        });
    }
    Ok((entries, size))
}

fn extract_zip(path: &Path, destination: &Path) -> Result<()> {
    let file = fs::File::open(path).context("cannot open downloaded archive")?;
    let mut archive = zip::ZipArchive::new(file)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let name = entry
            .name()
            .map_err(|error| anyhow::anyhow!("invalid ZIP entry name: {error}"))?
            .to_string();
        if entry.is_dir() {
            fs::create_dir_all(entry_path(destination, name.trim_end_matches('/'))?)?;
            continue;
        }
        let target = entry_path(destination, &name)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let declared = entry.size();
        let mut file = fs::File::create(&target)?;
        let written = copy_limited(&mut entry, &mut file, declared)?;
        if written != declared {
            bail!("ZIP entry `{name}` has an unexpected size");
        }
    }
    Ok(())
}

fn tar_entries(path: &Path) -> Result<(Vec<ArchiveEntry>, u64)> {
    let file = fs::File::open(path).context("cannot open downloaded archive")?;
    let size = file.metadata()?.len();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut entries = Vec::new();
    for item in archive.entries()? {
        let entry = item.context("cannot read tar entry")?;
        let header = entry.header();
        let raw_path = entry.path().context("invalid tar entry path")?;
        let name = raw_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("tar entry path is not UTF-8"))?
            .to_string();
        let is_dir = header.entry_type().is_dir();
        let path = if is_dir {
            name.trim_end_matches('/').to_string()
        } else {
            name
        };
        let is_symlink = !is_dir && !header.entry_type().is_file();
        entries.push(ArchiveEntry {
            path,
            size: header.size()?,
            is_dir,
            is_symlink,
        });
    }
    Ok((entries, size))
}

fn extract_targz(path: &Path, destination: &Path) -> Result<()> {
    let file = fs::File::open(path).context("cannot open downloaded archive")?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for item in archive.entries()? {
        let mut entry = item.context("cannot read tar entry")?;
        let is_dir = entry.header().entry_type().is_dir();
        let name = entry
            .path()?
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("tar entry path is not UTF-8"))?
            .to_string();
        if is_dir {
            fs::create_dir_all(entry_path(destination, name.trim_end_matches('/'))?)?;
            continue;
        }
        let target = entry_path(destination, &name)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::File::create(&target)?;
        let declared = entry.header().size()?;
        let written = copy_limited(&mut entry, &mut file, declared)?;
        if written != declared {
            bail!("tar entry `{name}` has an unexpected size");
        }
    }
    Ok(())
}

fn copy_limited<R: Read, W: Write>(reader: &mut R, writer: &mut W, limit: u64) -> Result<u64> {
    let mut buffer = [0_u8; COPY_CHUNK];
    let mut written = 0_u64;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        written = written.saturating_add(read as u64);
        if written > limit {
            bail!("archive entry expands beyond its declared size");
        }
        writer.write_all(&buffer[..read])?;
    }
    Ok(written)
}

fn extract_archive(archive: &Path, destination: &Path) -> Result<()> {
    let name = archive
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let format = archive_format(name)?;
    let (entries, compressed_size) = match format {
        "zip" => zip_entries(archive)?,
        "tar.gz" => tar_entries(archive)?,
        other => bail!("unsupported archive format: {other}"),
    };
    validate_entries(&entries, compressed_size)?;
    let root = dunce::canonicalize(destination)?;
    match format {
        "zip" => extract_zip(archive, &root),
        "tar.gz" => extract_targz(archive, &root),
        other => bail!("unsupported archive format: {other}"),
    }
}

/// Uses the same file name as the download so the archive format can be
/// detected independently of the source URL's query string.
fn archive_extension(url: &str) -> Result<String> {
    let parsed = url::Url::parse(url).context("archive URL is invalid")?;
    if parsed.scheme() != "https" {
        bail!("archive URL must use HTTPS");
    }
    let path = parsed.path().to_ascii_lowercase();
    if path.ends_with(".tar.gz") {
        Ok("archive.tar.gz".into())
    } else if path.ends_with(".tgz") {
        Ok("archive.tgz".into())
    } else if path.ends_with(".zip") {
        Ok("archive.zip".into())
    } else {
        bail!("unsupported archive format: {url}")
    }
}

async fn download_archive(http: &reqwest::Client, url: &str, destination: &Path) -> Result<u64> {
    let mut response = http
        .get(url)
        .header(USER_AGENT, concat!("Zylara/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .context("ACP agent archive download failed")?
        .error_for_status()
        .context("ACP agent archive download returned an error status")?;
    let mut file = tokio::fs::File::create(destination).await?;
    let mut size = 0_u64;
    while let Some(chunk) = response.chunk().await? {
        size = size.saturating_add(chunk.len() as u64);
        if size > MAX_ARCHIVE_BYTES {
            bail!("downloaded archive exceeds {} bytes", MAX_ARCHIVE_BYTES);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(size)
}

fn locate_command(extracted: &Path, cmd: &str) -> Result<PathBuf> {
    // Registry manifests commonly spell a root-level binary as `./agent`.
    // Strip that prefix before validating; traversal is still rejected.
    let mut relative = cmd.trim();
    while let Some(rest) = relative
        .strip_prefix("./")
        .or_else(|| relative.strip_prefix(".\\"))
    {
        relative = rest;
    }
    if let Ok(path) = safe_join(extracted, relative) {
        if path.is_file() {
            return Ok(path);
        }
    }
    // Some manifests omit `.exe` even though the archive contains it.
    if cfg!(windows) && !relative.to_ascii_lowercase().ends_with(".exe") {
        let with_extension = safe_join(extracted, &format!("{relative}.exe"))?;
        if with_extension.is_file() {
            return Ok(with_extension);
        }
    }
    bail!("command `{cmd}` was not found in the extracted archive")
}

fn scoped_install_dir(data_dir: &Path, id: &str, version: &str) -> Result<PathBuf> {
    if !registry::is_valid_agent_id(id) {
        bail!("invalid registry id: {id}");
    }
    validate_relative_path(version)?;
    Ok(data_dir.join("acp").join("agents").join(id).join(version))
}

fn binary_row(
    manifest: &RegistryManifest,
    dist: &registry::BinaryDist,
    command: PathBuf,
    install_dir: PathBuf,
) -> Result<AcpAgentRow> {
    let now = now_ms();
    Ok(AcpAgentRow {
        id: format!("acp__{}", manifest.id),
        registry_id: Some(manifest.id.clone()),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        homepage: manifest.website.clone(),
        repository: manifest.repository.clone(),
        license: manifest.license.clone(),
        icon_path: None,
        source: "registry".into(),
        thinking_config_json: "{}".into(),
        kind: "binary".into(),
        command: command.to_string_lossy().into_owned(),
        args_json: serde_json::to_string(&dist.args)?,
        env_json: serde_json::to_string(&dist.env)?,
        env_secret_names_json: "[]".into(),
        install_dir: Some(install_dir.to_string_lossy().into_owned()),
        sha256: dist.sha256.clone(),
        trusted: true,
        enabled: true,
        supports_fs: true,
        supports_terminal: true,
        supports_elicitation: true,
        auth_state: "unknown".into(),
        auth_hint: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    })
}

async fn prepare_staging(
    http: &reqwest::Client,
    dist: &registry::BinaryDist,
    staging: &Path,
) -> Result<PathBuf> {
    let extension = archive_extension(&dist.archive)?;
    let download_path = staging.join(extension);
    download_archive(http, &dist.archive, &download_path).await?;
    verify_sha256(&download_path, dist.sha256.as_deref())?;
    extract_archive(&download_path, staging)?;
    // Keeping the archive would let an agent read its own installer blob.
    let _ = tokio::fs::remove_file(&download_path).await;
    locate_command(staging, &dist.cmd)
}

/// Downloads, verifies, extracts and atomically installs a native binary.
/// On any failure the previous version remains untouched.
pub async fn install_binary_async(
    http: &reqwest::Client,
    manifest: &RegistryManifest,
    target: &str,
    data_dir: &Path,
) -> Result<AcpAgentRow> {
    let dist = match registry::select_distribution(manifest, target).context("no distribution available")? {
        Distribution::Binary(binary) => binary,
        other => bail!("manifest has no binary distribution for `{target}` (found {})", other.kind()),
    };
    let final_dir = scoped_install_dir(data_dir, &manifest.id, &manifest.version)?;
    let parent = final_dir
        .parent()
        .context("install directory has no parent")?;
    tokio::fs::create_dir_all(parent).await?;

    let tmp_root = data_dir.join("acp").join(".tmp");
    tokio::fs::create_dir_all(&tmp_root).await?;
    let staging = tmp_root.join(format!(
        "{}-{}-{}",
        manifest.id,
        manifest.version,
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&staging).await?;

    let relative_command = match prepare_staging(http, &dist, &staging).await {
        Ok(command) => {
            let staging_canonical =
                dunce::canonicalize(&staging).context("cannot resolve staging directory")?;
            command
                .strip_prefix(&staging_canonical)
                .context("command is outside the staging directory")?
                .to_path_buf()
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };

    let backup = parent.join(format!(
        "{}.old-{}",
        manifest.version,
        uuid::Uuid::new_v4()
    ));
    let had_previous = final_dir.exists();
    if had_previous {
        fs::rename(&final_dir, &backup).context("cannot move previous agent version aside")?;
    }
    if let Err(error) = fs::rename(&staging, &final_dir) {
        if had_previous && backup.exists() {
            let _ = fs::rename(&backup, &final_dir);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(error).context("cannot install extracted agent");
    }
    if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }

    let install_dir = dunce::canonicalize(&final_dir)?;
    let command = dunce::canonicalize(install_dir.join(&relative_command))
        .with_context(|| format!("cannot resolve installed command {}", relative_command.display()))?;
    binary_row(manifest, &dist, command, install_dir)
}

fn package_version(package: &str) -> String {
    if let Some((_, version)) = package.rsplit_once("==").or_else(|| package.rsplit_once('@')) {
        if !version.is_empty() {
            return version.to_string();
        }
    }
    "latest".into()
}

/// Registers an npm/PyPI agent without downloading anything. The package
/// manager fetches it on first launch, after the command consent gate.
pub fn install_package(
    kind: &str,
    package: &str,
    args: &[String],
    env: &std::collections::BTreeMap<String, String>,
    id: &str,
) -> Result<AcpAgentRow> {
    if kind != "npx" && kind != "uvx" {
        bail!("unsupported package manager: {kind}");
    }
    if !registry::is_valid_agent_id(id) {
        bail!("invalid registry id: {id}");
    }
    if package.trim().is_empty() {
        bail!("package name is required");
    }
    let mut all_args = vec![package.to_string()];
    all_args.extend_from_slice(args);
    let now = now_ms();
    Ok(AcpAgentRow {
        source: "registry".into(),
        thinking_config_json: "{}".into(),
        id: format!("acp__{id}"),
        registry_id: Some(id.to_string()),
        name: id.to_string(),
        version: package_version(package),
        description: format!("{kind} package: {package}"),
        homepage: None,
        repository: None,
        license: None,
        icon_path: None,
        kind: kind.into(),
        command: kind.into(),
        args_json: serde_json::to_string(&all_args)?,
        env_json: serde_json::to_string(env)?,
        env_secret_names_json: "[]".into(),
        install_dir: None,
        sha256: None,
        trusted: true,
        enabled: true,
        supports_fs: true,
        supports_terminal: true,
        supports_elicitation: true,
        auth_state: "unknown".into(),
        auth_hint: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    })
}

/// Download and validate the monochrome SVG published by the Registry.
///
/// Registry CI already enforces 16x16 `currentColor` SVGs from the official
/// CDN; we re-check both the host and the markup before storing it locally so
/// no remote script can ever reach the renderer.
pub async fn download_icon(
    http: &reqwest::Client,
    manifest: &RegistryManifest,
    data_dir: &Path,
) -> Result<Option<PathBuf>> {
    let Some(url) = manifest.icon.as_deref() else {
        return Ok(None);
    };
    let parsed = reqwest::Url::parse(url).context("invalid ACP icon URL")?;
    anyhow::ensure!(
        parsed.scheme() == "https"
            && parsed.host_str() == Some("cdn.agentclientprotocol.com"),
        "ACP icon host is not allowed: {url}"
    );
    let response = http
        .get(parsed.clone())
        .header(USER_AGENT, format!("Zylara/{}", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .context("failed to download ACP icon")?;
    anyhow::ensure!(response.status().is_success(), "ACP icon HTTP status failed");
    let bytes = response
        .bytes()
        .await
        .context("failed to read ACP icon")?;
    anyhow::ensure!(bytes.len() <= 64 * 1024, "ACP icon is too large");
    let svg = String::from_utf8(bytes.to_vec()).context("ACP icon is not UTF-8")?;
    validate_icon_svg(&svg)?;

    let icons_dir = data_dir.join("acp").join("icons");
    tokio::fs::create_dir_all(&icons_dir).await?;
    let path = icons_dir.join(format!("{}.svg", manifest.id));
    tokio::fs::write(&path, svg.as_bytes()).await?;
    Ok(Some(path))
}

fn validate_icon_svg(svg: &str) -> Result<()> {
    let lower = svg.to_ascii_lowercase();
    anyhow::ensure!(lower.contains("<svg"), "ACP icon has no svg root");
    anyhow::ensure!(!lower.contains("<script"), "ACP icon contains a script");
    anyhow::ensure!(!lower.contains("foreignobject"), "ACP icon contains foreignObject");
    anyhow::ensure!(!lower.contains("javascript:"), "ACP icon contains a javascript URL");
    anyhow::ensure!(
        !lower.contains("onclick=")
            && !lower.contains("onload=")
            && !lower.contains("onerror=")
            && !lower.contains("onmouseover="),
        "ACP icon contains an event handler"
    );
    anyhow::ensure!(!svg.contains('#'), "ACP icon must be monochrome currentColor");
    Ok(())
}

#[cfg(test)]
mod icon_tests {
    use super::validate_icon_svg;

    #[test]
    fn monochrome_registry_svg_is_accepted() {
        validate_icon_svg(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><path fill=\"currentColor\" d=\"M0 0h16v16z\"/></svg>",
        )
        .expect("valid icon");
    }

    #[test]
    fn scripts_and_hardcoded_colors_are_rejected() {
        assert!(validate_icon_svg("<svg><script>alert(1)</script></svg>").is_err());
        assert!(validate_icon_svg("<svg><path fill=\"#ff0000\"/></svg>").is_err());
        assert!(validate_icon_svg("<svg onload=\"x()\"/>").is_err());
    }
}

/// Removes only binaries installed below `<data_dir>/acp/agents`. A tampered
/// database row cannot turn this into an arbitrary filesystem delete.
pub fn remove_install(data_dir: &Path, row: &AcpAgentRow) -> Result<()> {
    let Some(install_dir) = row.install_dir.as_deref() else {
        return Ok(());
    };
    let path = Path::new(install_dir);
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    let root = data_dir.join("acp").join("agents");
    if !root.exists() {
        bail!("install directory is outside the ACP agents root");
    }
    let root = dunce::canonicalize(root)?;
    let canonical = dunce::canonicalize(path).context("cannot resolve install directory")?;
    if canonical == root || !canonical.starts_with(&root) {
        bail!("refusing to remove an install directory outside {}", root.display());
    }
    fs::remove_dir_all(canonical)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, size: u64) -> ArchiveEntry {
        ArchiveEntry {
            path: path.into(),
            size,
            is_dir: false,
            is_symlink: false,
        }
    }

    #[test]
    fn hash_is_checked_before_extraction() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("archive.zip");
        fs::write(&file, b"acp registry payload").expect("write fixture");
        let expected = "8d3a3a3c673ea0b7dc60b5a4bd7b2e6cc5a0d8f0e6b5c4a6a1b0d1f0e8a2b1c1";
        assert!(verify_sha256(&file, None).is_ok());
        assert!(verify_sha256(&file, Some("not-a-hash")).is_err());
        assert!(verify_sha256(&file, Some(expected)).is_err());
        let actual = {
            let mut hasher = Sha256::new();
            hasher.update(b"acp registry payload");
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        assert!(verify_sha256(&file, Some(&actual)).is_ok());
        assert!(verify_sha256(&file, Some(&actual.to_ascii_uppercase())).is_ok());
    }

    #[test]
    fn validation_rejects_traversal_absolute_ads_symlink_and_duplicates() {
        validate_entries(&[entry("bin/agent.exe", 10)], 100).expect("safe entry");
        assert!(validate_entries(&[entry("../evil.exe", 10)], 100).is_err());
        assert!(validate_entries(&[entry("bin/../../evil.exe", 10)], 100).is_err());
        assert!(validate_entries(&[entry("/etc/passwd", 10)], 100).is_err());
        assert!(validate_entries(&[entry("C:/evil.exe", 10)], 100).is_err());
        assert!(validate_entries(&[entry("bin\\evil.exe", 10)], 100).is_err());
        assert!(validate_entries(&[entry("agent.exe:stream", 10)], 100).is_err());
        assert!(validate_entries(&[entry("CON.exe", 10)], 100).is_err());
        assert!(validate_entries(&[entry("bin/../agent.exe", 10)], 100).is_err());
        assert!(validate_entries(
            &[ArchiveEntry { is_symlink: true, ..entry("link", 0) }],
            100,
        )
        .is_err());
        assert!(validate_entries(&[entry("Agent.exe", 1), entry("agent.exe", 1)], 100).is_err());
        assert!(validate_entries(&[entry("huge.bin", MAX_UNCOMPRESSED_BYTES + 1)], u64::MAX).is_err());
        assert!(validate_entries(&[entry("huge.bin", 1_000)], 1).is_err());
        assert!(validate_entries(&[entry("agent.exe", 10)], 0).is_err());
    }

    #[test]
    fn safe_join_resolves_commands_inside_the_extracted_root() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("install");
        fs::create_dir_all(root.join("bin")).expect("mkdir");
        fs::write(root.join("bin").join("agent.exe"), b"binary").expect("write binary");
        fs::write(root.join("agent"), b"binary").expect("write root binary");
        let command = safe_join(&root, "bin/agent.exe").expect("command inside root");
        assert_eq!(command, dunce::canonicalize(root.join("bin").join("agent.exe")).unwrap());
        assert!(safe_join(&root, "../outside.exe").is_err());
        assert!(safe_join(&root, "bin:stream").is_err());
        assert!(locate_command(&root, "bin/agent.exe").is_ok());
        assert!(locate_command(&root, "./agent").is_ok());
        assert!(locate_command(&root, "missing.exe").is_err());
    }

    #[test]
    fn package_install_registers_without_downloading() {
        let args = vec!["--stdio".to_string()];
        let env = std::collections::BTreeMap::from([("MODE".to_string(), "acp".to_string())]);
        let row = install_package("npx", "demo-agent@1.2.3", &args, &env, "demo-agent")
            .expect("package row");
        assert_eq!(row.id, "acp__demo-agent");
        assert_eq!(row.registry_id.as_deref(), Some("demo-agent"));
        assert_eq!(row.kind, "npx");
        assert_eq!(row.command, "npx");
        assert_eq!(
            row.args_json,
            r#"["demo-agent@1.2.3","--stdio"]"#
        );
        assert_eq!(row.version, "1.2.3");
        assert_eq!(row.env_json, r#"{"MODE":"acp"}"#);
        assert_eq!(row.env_secret_names_json, "[]");
        assert!(row.trusted);
        assert!(row.enabled);
        assert_eq!(row.auth_state, "unknown");
        assert!(row.install_dir.is_none());
        assert!(install_package("curl", "demo@1.0.0", &[], &env, "demo-agent").is_err());
    }

    #[test]
    fn removal_is_scoped_to_the_agents_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let data = dir.path();
        let inside = data.join("acp").join("agents").join("demo").join("1.0.0");
        fs::create_dir_all(&inside).expect("mkdir");
        let outside = dir.path().join("elsewhere");
        fs::create_dir_all(&outside).expect("mkdir");

        let mut row = install_package("npx", "demo@1.0.0", &[], &Default::default(), "demo")
            .expect("package row");
        row.install_dir = Some(inside.to_string_lossy().into_owned());
        remove_install(data, &row).expect("remove scoped dir");
        assert!(!inside.exists());

        row.install_dir = Some(outside.to_string_lossy().into_owned());
        assert!(remove_install(data, &row).is_err());
        assert!(outside.exists());
    }

    #[test]
    fn archive_formats_are_whitelisted() {
        assert_eq!(archive_extension("https://host/a.zip?token=1").unwrap(), "archive.zip");
        assert_eq!(archive_extension("https://host/a.TAR.GZ").unwrap(), "archive.tar.gz");
        assert!(archive_extension("https://host/a.exe").is_err());
        assert!(archive_extension("file:///etc/a.zip").is_err());
    }
}
