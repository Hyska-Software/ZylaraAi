//! Runtime view of `data/plugin-contract.json`.
//!
//! The JSON file is the single source of truth shared with the renderer and the
//! SDK. The generated constants in [`super::contract_generated`] are used by
//! parity tests; runtime validation always reads this parsed contract so a new
//! slot or permission only needs one edit.

use std::sync::LazyLock;

use serde::Deserialize;

pub const CONTRACT_JSON: &str = include_str!("../../../data/plugin-contract.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContract {
    pub api_version: u32,
    pub manifest_schema_version: u32,
    pub name: String,
    pub description: String,
    pub tool_name_prefix: String,
    pub tool_name_max_chars: usize,
    pub limits: PluginLimits,
    pub slots: Vec<SlotSpec>,
    pub components: Vec<ComponentSpec>,
    pub permissions: Vec<PermissionSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotSpec {
    pub id: String,
    pub title: String,
    pub props: Vec<String>,
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSpec {
    pub id: String,
    pub title: String,
    pub props: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSpec {
    pub id: String,
    pub scoped: bool,
    pub risk: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLimits {
    pub package_bytes: u64,
    pub trusted_package_bytes: u64,
    pub files: usize,
    pub unpacked_bytes: u64,
    pub prompt_chars_per_plugin: usize,
    pub prompt_chars_total: usize,
    pub kv_bytes: u64,
    pub data_bytes: u64,
    pub log_bytes: u64,
    pub network_bytes: u64,
    pub rpc_bytes: u64,
    pub tool_result_chars: usize,
    pub tool_timeout_secs: u64,
}

static CONTRACT: LazyLock<PluginContract> = LazyLock::new(|| {
    let contract: PluginContract = serde_json::from_str(CONTRACT_JSON)
        .expect("data/plugin-contract.json must be valid JSON");
    validate(&contract);
    contract
});

fn validate(contract: &PluginContract) {
    assert_eq!(contract.api_version, 1, "plugin contract apiVersion");
    assert!(
        !contract.tool_name_prefix.is_empty(),
        "plugin contract toolNamePrefix"
    );
    assert!(
        (8..=64).contains(&contract.tool_name_max_chars),
        "plugin contract toolNameMaxChars"
    );
    for slot in &contract.slots {
        assert!(
            slot.modes
                .iter()
                .all(|mode| matches!(mode.as_str(), "declarative" | "sandbox" | "trusted")),
            "slot {} has an unknown mode",
            slot.id
        );
    }
    for permission in &contract.permissions {
        assert!(
            matches!(permission.risk.as_str(), "low" | "medium" | "high" | "critical"),
            "permission {} has an unknown risk",
            permission.id
        );
    }
}

pub fn contract() -> &'static PluginContract {
    &CONTRACT
}

pub fn limits() -> &'static PluginLimits {
    &CONTRACT.limits
}

pub fn slot_ids() -> Vec<&'static str> {
    CONTRACT.slots.iter().map(|slot| slot.id.as_str()).collect()
}

pub fn component_ids() -> Vec<&'static str> {
    CONTRACT
        .components
        .iter()
        .map(|component| component.id.as_str())
        .collect()
}

pub fn permission_spec(base: &str) -> Option<&'static PermissionSpec> {
    CONTRACT
        .permissions
        .iter()
        .find(|permission| permission.id == base)
}

/// Base id of a scoped permission (`net:api.github.com` → `net`).
pub fn permission_base(permission: &str) -> &str {
    permission.split(':').next().unwrap_or(permission)
}

pub fn permission_known(permission: &str) -> bool {
    permission_spec(permission_base(permission)).is_some()
}

pub fn permission_risk(permission: &str) -> &'static str {
    permission_spec(permission_base(permission))
        .map(|spec| spec.risk.as_str())
        .unwrap_or("critical")
}

pub fn permission_scoped(base: &str) -> bool {
    permission_spec(base).is_some_and(|spec| spec.scoped)
}

/// Whether the permission covers the requested capability.
///
/// Scoped permissions match either the exact grant (`net:api.example.com`) or
/// a wildcard grant (`net:*`). Unscoped permissions match only themselves.
pub fn permission_matches(granted: &str, required: &str) -> bool {
    if granted == required {
        return true;
    }
    let Some((base, _)) = granted.split_once(':') else {
        return false;
    };
    required
        .strip_prefix(base)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|_| granted.ends_with(":*"))
}

pub fn slot_spec(id: &str) -> Option<&'static SlotSpec> {
    CONTRACT.slots.iter().find(|slot| slot.id == id)
}

pub fn component_spec(id: &str) -> Option<&'static ComponentSpec> {
    CONTRACT
        .components
        .iter()
        .find(|component| component.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::contract_generated;

    #[test]
    fn embedded_contract_matches_generated_mirrors() {
        assert_eq!(contract().api_version, contract_generated::API_VERSION);
        assert_eq!(slot_ids(), contract_generated::SLOT_IDS);
        assert_eq!(component_ids(), contract_generated::COMPONENT_IDS);
        assert_eq!(
            contract()
                .permissions
                .iter()
                .map(|permission| permission.id.as_str())
                .collect::<Vec<_>>(),
            contract_generated::PERMISSION_IDS
        );
        assert_eq!(limits().package_bytes, contract_generated::LIMIT_PACKAGE_BYTES);
    }

    #[test]
    fn scoped_permissions_match_exact_and_wildcard_grants() {
        assert!(permission_matches("net:api.github.com", "net:api.github.com"));
        assert!(permission_matches("net:*", "net:api.github.com"));
        assert!(!permission_matches("net:api.github.com", "net:evil.example"));
        assert!(!permission_matches("storage", "net:api.github.com"));
        assert!(!permission_matches("net:", "net:api.github.com"));
        assert_eq!(permission_base("ui.slot:chat.composer.toolbar"), "ui.slot");
        assert!(permission_known("ui.slot:chat.composer.toolbar"));
        assert!(!permission_known("ui.nope"));
    }
}
