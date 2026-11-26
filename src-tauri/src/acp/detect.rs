//! Detect ACP agents already installed on the device.
//!
//! Only executables on PATH are considered; manifests from the Registry supply
//! the names and metadata. Login state is discovered later by `client::probe`,
//! never by reading third-party credential files.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use tauri::{Emitter, Manager};
use futures_util::StreamExt;

use crate::acp::registry::{self, RegistryManifest};
use crate::acp::{AcpAgentRow, AcpAgentView};
use crate::db::Db;

const WINDOWS_EXTENSIONS: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];
const KNOWN_EXTENSIONS: [&str; 5] = [".exe", ".cmd", ".bat", ".par", ".com"];

/// Names to look for on PATH, derived from a Registry manifest.
pub fn candidate_names(manifest: &RegistryManifest, target: &str) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(dist) = manifest.distribution.binary.get(target) {
        if let Some(name) = executable_stem(&dist.cmd) {
            names.push(name);
        }
    }
    for package in [
        manifest.distribution.npx.as_ref(),
        manifest.distribution.uvx.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(name) = package_stem(&package.package) {
            names.push(name);
        }
    }
    let mut seen = std::collections::HashSet::new();
    names.retain(|name| seen.insert(name.clone()));
    names
}

fn executable_stem(cmd: &str) -> Option<String> {
    let trimmed = cmd.trim().trim_start_matches("./").trim_start_matches(".\\");
    let file_name = Path::new(trimmed).file_name()?.to_string_lossy();
    let lower = file_name.to_ascii_lowercase();
    let stem = KNOWN_EXTENSIONS
        .iter()
        .find(|extension| lower.ends_with(**extension))
        .map(|extension| file_name[..file_name.len() - extension.len()].to_string())
        .unwrap_or_else(|| file_name.to_string());
    let stem = stem.trim();
    (!stem.is_empty() && !stem.contains('/') && !stem.contains('\\')).then(|| stem.to_string())
}

fn package_stem(package: &str) -> Option<String> {
    let without_scope = package.rsplit('/').next().unwrap_or(package);
    let without_version = without_scope
        .split_once("==")
        .map(|(name, _)| name)
        .or_else(|| without_scope.split_once('@').map(|(name, _)| name))
        .unwrap_or(without_scope);
    let name = without_version.trim();
    (!name.is_empty() && !name.contains('/') && !name.contains('\\')).then(|| name.to_string())
}

/// Deterministic PATH search used by tests and by `find_candidate`.
pub fn find_candidate_in(candidates: &[String], dirs: &[PathBuf]) -> Option<PathBuf> {
    for candidate in candidates {
        if candidate.is_empty() || candidate.contains('/') || candidate.contains('\\') {
            continue;
        }
        for dir in dirs {
            let display = dir.to_string_lossy().to_ascii_lowercase();
            if display.contains("\\windowsapps\\") || display.ends_with("windowsapps") {
                continue;
            }
            let names: Vec<String> = if cfg!(windows) {
                // npm creates an extensionless shell shim beside `*.cmd`;
                // CreateProcess cannot execute it (os error 193).
                WINDOWS_EXTENSIONS
                    .iter()
                    .map(|extension| format!("{candidate}{extension}"))
                    .collect()
            } else {
                vec![candidate.clone()]
            };
            for name in names {
                let path = dir.join(name);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    None
}

pub fn find_candidate(candidates: &[String]) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|dir| !dir.as_os_str().is_empty())
        .collect();
    find_candidate_in(candidates, &dirs)
}

/// Arguments required to put a detected executable into ACP mode. Binary
/// distributions publish them (e.g. `opencode acp`), package manifests do the
/// same (`--acp`). Using `[]` here made those agents fail at handshake.
pub(crate) fn detection_args(manifest: &RegistryManifest) -> Vec<String> {
    let target = registry::current_target();
    if let Some(dist) = manifest.distribution.binary.get(target) {
        return dist.args.clone();
    }
    manifest
        .distribution
        .npx
        .as_ref()
        .or(manifest.distribution.uvx.as_ref())
        .map(|dist| dist.args.clone())
        .unwrap_or_default()
}

/// A row for an executable found on PATH but not installed by our installer.
pub fn detected_row(
    manifest: &RegistryManifest,
    path: &Path,
    data_dir: &Path,
    now: i64,
) -> AcpAgentRow {
    let icon_path = data_dir
        .join("acp")
        .join("icons")
        .join(format!("{}.svg", manifest.id));
    AcpAgentRow {
        id: format!("acp__{}", manifest.id),
        registry_id: Some(manifest.id.clone()),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        homepage: manifest.website.clone(),
        repository: manifest.repository.clone(),
        license: manifest.license.clone(),
        icon_path: icon_path
            .is_file()
            .then(|| icon_path.to_string_lossy().into_owned()),
        source: "detected".to_string(),
        thinking_config_json: "{}".to_string(),
        kind: "detected".to_string(),
        command: path.to_string_lossy().into_owned(),
        args_json: serde_json::to_string(&detection_args(manifest))
            .unwrap_or_else(|_| "[]".to_string()),
        env_json: "{}".to_string(),
        env_secret_names_json: "[]".to_string(),
        install_dir: None,
        sha256: None,
        trusted: true,
        enabled: false,
        supports_fs: true,
        supports_terminal: true,
        supports_elicitation: true,
        auth_state: "unknown".to_string(),
        auth_hint: None,
        last_error: None,
        created_at: now,
        updated_at: now,
    }
}

/// Insert or refresh one detected row. Managed/manual rows are never replaced,
/// and a detected row keeps the user's activation and auth state.
pub(crate) fn store_detected(
    db: &Db,
    manifest: &RegistryManifest,
    path: &Path,
    data_dir: &Path,
) -> Result<()> {
    let existing = db
        .acp_agents()?
        .into_iter()
        .find(|row| row.registry_id.as_deref() == Some(manifest.id.as_str()));
    let now = crate::domain::now_ms();
    match existing {
        Some(row) if row.source != "detected" => Ok(()),
        Some(mut row) => {
            let command = path.to_string_lossy().into_owned();
            if row.command != command {
                row.command = command;
            }
            let args_json = serde_json::to_string(&detection_args(manifest))
                .unwrap_or_else(|_| "[]".to_string());
            if row.args_json != args_json {
                row.args_json = args_json;
            }
            let icon = data_dir
                .join("acp")
                .join("icons")
                .join(format!("{}.svg", manifest.id));
            if icon.is_file() {
                row.icon_path = Some(icon.to_string_lossy().into_owned());
            }
            row.updated_at = now;
            db.acp_agent_save(&row)
        }
        None => db.acp_agent_save(&detected_row(manifest, path, data_dir, now)),
    }
}

fn views(db: &Db) -> Result<Vec<AcpAgentView>> {
    Ok(db
        .acp_agents()?
        .into_iter()
        .map(|row| {
            let models = db.acp_models(&row.id).map(|m| m.len()).unwrap_or(0);
            crate::acp::to_view(&row, models as u32)
        })
        .collect())
}

/// Scan PATH against cached Registry manifests and persist the results.
pub async fn scan_and_store(app: &tauri::AppHandle) -> Result<Vec<AcpAgentView>> {
    let (db, http, data_dir) = {
        let state = app.state::<crate::state::AppState>();
        (state.db.clone(), state.http.clone(), state.data_dir.clone())
    };
    let manifests = registry::cached_manifests(&db);
    let target = registry::current_target();

    for manifest in &manifests {
        let Some(path) = find_candidate(&candidate_names(manifest, target)) else {
            continue;
        };
        let icon = data_dir.join("acp").join("icons").join(format!("{}.svg", manifest.id));
        if !icon.is_file() && manifest.icon.is_some() {
            let _ = crate::acp::install::download_icon(&http, manifest, &data_dir).await;
        }
        store_detected(&db, manifest, &path, &data_dir)?;
    }

    views(&db)
}

/// Boot entry point: scan, then discover login state through ACP handshakes.
pub async fn boot_scan(app: &tauri::AppHandle) {
    if let Err(error) = scan_and_store(app).await {
        eprintln!("zylara: ACP device scan failed: {error:#}");
    }
    let db = {
        let state = app.state::<crate::state::AppState>();
        state.db.clone()
    };
    let candidates: Vec<AcpAgentRow> = db
        .acp_agents()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| {
            if row.source == "detected" {
                return true;
            }
            matches!(row.auth_state.as_str(), "unknown" | "auth_required")
        })
        .collect();

    futures_util::stream::iter(candidates)
        .map(|row| {
            let app = app.clone();
            async move {
                if let Err(error) = crate::acp::client::probe(&app, &row.id).await {
                    eprintln!("zylara: ACP probe failed for {}: {error:#}", row.id);
                }
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<()>>()
        .await;

    match views(&db) {
        Ok(views) => {
            if let Err(error) = app.emit("zylara:acp-detection-updated", &views) {
                eprintln!("zylara: ACP detection event failed: {error}");
            }
        }
        Err(error) => eprintln!("zylara: ACP detection view failed: {error:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::registry::{BinaryDist, DistributionMap, PackageDist};

    fn manifest(id: &str, cmd: Option<&str>, package: Option<&str>) -> RegistryManifest {
        let mut distribution = DistributionMap::default();
        if let Some(cmd) = cmd {
            distribution.binary.insert(
                "windows-x86_64".to_string(),
                BinaryDist {
                    archive: "https://example.test/agent.zip".to_string(),
                    sha256: None,
                    cmd: cmd.to_string(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                },
            );
        }
        if let Some(package) = package {
            distribution.npx = Some(PackageDist {
                package: package.to_string(),
                args: Vec::new(),
                env: BTreeMap::new(),
            });
        }
        RegistryManifest {
            id: id.to_string(),
            name: id.to_string(),
            version: "1.0.0".to_string(),
            description: String::new(),
            repository: None,
            website: None,
            authors: Vec::new(),
            license: None,
            license_url: None,
            icon: None,
            distribution,
        }
    }

    #[test]
    fn candidate_names_cover_binary_and_package_distributions() {
        assert_eq!(
            candidate_names(&manifest("amp-acp", Some("./amp-acp.exe"), None), "windows-x86_64"),
            vec!["amp-acp".to_string()]
        );
        assert_eq!(
            candidate_names(
                &manifest("auggie", None, Some("@augmentcode/auggie@0.37.0")),
                "windows-x86_64"
            ),
            vec!["auggie".to_string()]
        );
        assert!(candidate_names(&manifest("empty", None, None), "windows-x86_64").is_empty());
    }

    #[test]
    fn find_candidate_in_checks_extensions_and_skips_windowsapps() {
        let dir = tempfile::tempdir().expect("temp dir");
        let blocked = dir.path().join("WindowsApps");
        std::fs::create_dir_all(&blocked).expect("blocked dir");
        std::fs::write(blocked.join("amp-acp.exe"), b"stub").expect("blocked exe");
        assert!(find_candidate_in(&["amp-acp".into()], &[blocked]).is_none());


        std::fs::write(dir.path().join("amp-acp"), b"npm shell shim").expect("bare shim");
        std::fs::write(dir.path().join("amp-acp.cmd"), b"stub").expect("shim");
        let found = find_candidate_in(&["amp-acp".into()], &[dir.path().to_path_buf()])
            .expect("candidate on PATH");
        assert_eq!(
            found.file_name().and_then(|name| name.to_str()),
            Some("amp-acp.cmd")
        );
    }

    #[test]
    fn detection_args_keep_binary_acp_flag() {
        let mut manifest = manifest("opencode", Some("./opencode.exe"), None);
        if let Some(dist) = manifest.distribution.binary.get_mut("windows-x86_64") {
            dist.args = vec!["acp".to_string()];
        }
        assert_eq!(detection_args(&manifest), vec!["acp".to_string()]);
        let row = detected_row(
            &manifest,
            Path::new(r"C:\tools\opencode.cmd"),
            Path::new(r"C:\data"),
            42,
        );
        assert_eq!(row.args_json, r#"["acp"]"#);
    }

    #[test]
    fn detected_row_defaults_to_disabled_but_trusted() {
        let row = detected_row(
            &manifest("amp-acp", Some("./amp-acp.exe"), None),
            Path::new(r"C:\tools\amp-acp.exe"),
            Path::new(r"C:\data"),
            42,
        );
        assert_eq!(row.source, "detected");
        assert!(!row.enabled);
        assert!(row.trusted);
        assert!(row.supports_fs && row.supports_terminal && row.supports_elicitation);
        assert_eq!(row.auth_state, "unknown");
        assert_eq!(row.args_json, "[]");
        assert_eq!(row.id, "acp__amp-acp");
    }

    #[test]
    fn rescan_preserves_managed_rows_and_user_choices() {
        let db = Db::open_in_memory().expect("in-memory db");
        let data = tempfile::tempdir().expect("temp dir");
        let manifest = manifest("amp-acp", Some("./amp-acp.exe"), None);
        let path = data.path().join("amp-acp.exe");
        let mut managed = detected_row(&manifest, &path, data.path(), 1);
        managed.source = "registry".to_string();
        managed.enabled = true;
        managed.auth_state = "ready".to_string();
        db.acp_agent_save(&managed).expect("save managed");
        store_detected(&db, &manifest, &path, data.path()).expect("rescan managed");
        let unchanged = db.acp_agent(&managed.id).expect("read").expect("row");
        assert_eq!(unchanged.source, "registry");
        assert!(unchanged.enabled);
        assert_eq!(unchanged.auth_state, "ready");

        let mut detected = detected_row(&manifest, &path, data.path(), 1);
        detected.enabled = false;
        detected.auth_state = "ready".to_string();
        db.acp_agent_save(&detected).expect("save detected");
        store_detected(&db, &manifest, &path, data.path()).expect("rescan detected");
        let kept = db.acp_agent(&detected.id).expect("read").expect("row");
        assert!(!kept.enabled);
        assert_eq!(kept.auth_state, "ready");
    }
}
