//! Permission validation shared by install, UI contributions and the RPC broker.
//!
//! The renderer never decides a permission: it asks the backend, which checks
//! the persisted grants of the plugin. Capability errors use stable codes so the
//! UI can offer an actionable fix.

use anyhow::{bail, Result};

use super::contract;

pub const ERR_PERMISSION_DENIED: &str = "PLUGIN_PERMISSION_DENIED";
pub const ERR_PERMISSION_UNKNOWN: &str = "PLUGIN_PERMISSION_UNKNOWN";

pub fn normalize_permissions(permissions: &[String]) -> Vec<String> {
    let mut values: Vec<String> = permissions
        .iter()
        .map(|permission| permission.trim().to_string())
        .filter(|permission| !permission.is_empty())
        .collect();
    values.sort();
    values.dedup();
    values
}

pub fn validate_declared(permissions: &[String]) -> Result<()> {
    for permission in permissions {
        if !contract::permission_known(permission) {
            bail!("{ERR_PERMISSION_UNKNOWN}: `{permission}` is not a known permission");
        }
        let base = contract::permission_base(permission);
        if contract::permission_scoped(base) && permission == base {
            bail!("{ERR_PERMISSION_UNKNOWN}: scoped permission `{permission}` needs a scope");
        }
    }
    Ok(())
}

pub fn granted_any(grants: &[String], required: &str) -> bool {
    grants
        .iter()
        .any(|granted| contract::permission_matches(granted, required))
}

pub fn require(grants: &[String], required: &str) -> Result<()> {
    if granted_any(grants, required) {
        return Ok(());
    }
    bail!("{ERR_PERMISSION_DENIED}: `{required}` was not granted")
}

pub fn require_any(grants: &[String], required: &[&str]) -> Result<()> {
    if required.iter().any(|permission| granted_any(grants, permission)) {
        return Ok(());
    }
    bail!(
        "{ERR_PERMISSION_DENIED}: one of `{}` was not granted",
        required.join("`, `")
    )
}

/// `raw.githubusercontent.com` matches `net:raw.githubusercontent.com` and
/// `net:github.com` does not. Wildcards match any host.
pub fn net_host_allowed(grants: &[String], host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    grants.iter().any(|grant| {
        let Some(scope) = grant.strip_prefix("net:") else {
            return false;
        };
        if scope == "*" {
            return true;
        }
        let scope = scope.trim().trim_end_matches('.').to_ascii_lowercase();
        host == scope || host.ends_with(&format!(".{scope}"))
    })
}

pub fn net_scope(grants: &[String]) -> Vec<String> {
    grants
        .iter()
        .filter_map(|grant| grant.strip_prefix("net:").map(str::to_string))
        .collect()
}

/// Scoped filesystem grants use glob patterns (`fs.read:C:/work/**`). The path
/// is compared after canonicalization by the caller so `..` and symlinks cannot
/// escape the granted pattern.
pub fn fs_path_allowed(grants: &[String], base: &str, path: &std::path::Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    grants.iter().any(|grant| {
        let Some(scope) = grant.strip_prefix(&format!("{base}:")) else {
            return false;
        };
        let scope = scope.trim();
        if scope == "*" {
            return true;
        }
        let scope = scope.replace('\\', "/").to_ascii_lowercase();
        globset::GlobBuilder::new(&scope)
            .literal_separator(true)
            .build()
            .map(|glob| glob.compile_matcher().is_match(&normalized))
            .unwrap_or(false)
    })
}

pub fn fs_scope(grants: &[String], base: &str) -> Vec<String> {
    grants
        .iter()
        .filter_map(|grant| grant.strip_prefix(&format!("{base}:")).map(str::to_string))
        .collect()
}

pub fn is_trusted_only(permission: &str) -> bool {
    matches!(
        contract::permission_base(permission),
        "ui.override" | "ui.css.global" | "ui.shell" | "unsafe.renderer" | "secrets.read"
            | "process.spawn"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_net_grants_match_subdomains_but_not_suffix_attacks() {
        let grants = vec!["net:github.com".to_string()];
        assert!(net_host_allowed(&grants, "github.com"));
        assert!(net_host_allowed(&grants, "api.github.com"));
        assert!(!net_host_allowed(&grants, "evilgithub.com"));
        assert!(!net_host_allowed(&grants, "github.com.evil.example"));
        assert!(net_host_allowed(&vec!["net:*".to_string()], "anywhere.example"));
    }

    #[test]
    fn denied_capabilities_use_stable_codes() {
        let error = require(&[], "storage").expect_err("denied");
        assert!(error.to_string().starts_with(ERR_PERMISSION_DENIED));
        require(&["storage".to_string()], "storage").expect("granted");
    }

    #[test]
    fn install_validation_rejects_scoped_base_and_unknown_ids() {
        assert!(validate_declared(&["net".to_string()]).is_err());
        assert!(validate_declared(&["nope".to_string()]).is_err());
        assert!(validate_declared(&["net:api.github.com".to_string()]).is_ok());
    }

    #[test]
    fn trusted_only_permissions_are_flagged() {
        for permission in [
            "ui.override:chat.welcome",
            "ui.css.global",
            "ui.shell",
            "unsafe.renderer",
            "secrets.read",
            "process.spawn",
        ] {
            assert!(is_trusted_only(permission), "{permission}");
        }
        assert!(!is_trusted_only("storage"));
    }

    #[test]
    fn scoped_fs_grants_match_globs_case_insensitively() {
        let grants = vec!["fs.read:C:/work/**".to_string()];
        assert!(fs_path_allowed(&grants, "fs.read", std::path::Path::new("C:/work/a.txt")));
        assert!(fs_path_allowed(
            &grants,
            "fs.read",
            std::path::Path::new("C:\\work\\nested\\a.txt")
        ));
        assert!(!fs_path_allowed(&grants, "fs.read", std::path::Path::new("C:/other/a.txt")));
        assert!(!fs_path_allowed(&grants, "fs.write", std::path::Path::new("C:/work/a.txt")));
    }
}
