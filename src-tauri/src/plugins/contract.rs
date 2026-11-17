//! Runtime view of `data/plugin-contract.json`.
//!
//! The JSON file is the single source of truth shared with the renderer and the
//! SDK. The generated constants in [`super::contract_generated`] are used by
//! parity tests; runtime validation always reads this parsed contract so a new
//! slot or permission only needs one edit.

use std::collections::BTreeMap;
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
    pub layouts: Vec<String>,
    pub host_pages: Vec<String>,
    pub limits: PluginLimits,
    pub ui_limits: PluginUiLimits,
    pub style_recipes: BTreeMap<String, Vec<String>>,
    pub slots: Vec<SlotSpec>,
    pub components: Vec<ComponentSpec>,
    #[serde(default)]
    pub reserved_slots: Vec<String>,
    #[serde(default)]
    pub reserved_components: Vec<String>,
    #[serde(default)]
    pub reserved_permissions: Vec<String>,
    pub events: Vec<EventSpec>,
    pub permissions: Vec<PermissionSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotSpec {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub scope: String,
    pub props: Vec<String>,
    #[serde(default)]
    pub entry_key: Option<String>,
    pub layouts: Vec<String>,
    pub modes: Vec<String>,
    #[serde(default)]
    pub replacement: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSpec {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub lanes: Vec<String>,
    pub layouts: Vec<String>,
    pub props: Vec<String>,
    #[serde(default)]
    pub variants: Vec<String>,
    #[serde(default)]
    pub builtin_recipes: BTreeMap<String, BTreeMap<String, String>>,
    pub risk: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSpec {
    pub name: String,
    pub scope: String,
    #[serde(default)]
    pub props: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSpec {
    pub id: String,
    pub scoped: bool,
    pub risk: String,
    #[serde(default)]
    pub trusted_only: bool,
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
    pub modes_per_plugin: usize,
    pub mode_prompt_chars: usize,
    pub agent_templates_per_plugin: usize,
    pub template_instructions_chars: usize,
    pub custom_providers: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUiLimits {
    pub slot_entries_per_plugin: usize,
    pub nav_entries_per_plugin: usize,
    pub pages_per_plugin: usize,
    pub panel_tabs_per_plugin: usize,
    pub sidebar_tabs_per_plugin: usize,
    pub variants_per_plugin: usize,
    pub presets_per_plugin: usize,
    pub css_chars_per_plugin: usize,
    pub genui_components_per_plugin: usize,
    pub genui_schema_chars: usize,
    pub genui_prompt_chars_per_plugin: usize,
}

static CONTRACT: LazyLock<PluginContract> = LazyLock::new(|| {
    let contract: PluginContract = serde_json::from_str(CONTRACT_JSON)
        .expect("data/plugin-contract.json must be valid JSON");
    validate(&contract);
    contract
});

fn validate(contract: &PluginContract) {
    assert_eq!(contract.api_version, 2, "plugin contract apiVersion");
    assert_eq!(
        contract.manifest_schema_version, 2,
        "plugin contract manifestSchemaVersion"
    );
    assert!(
        !contract.tool_name_prefix.is_empty(),
        "plugin contract toolNamePrefix"
    );
    assert!(
        (8..=64).contains(&contract.tool_name_max_chars),
        "plugin contract toolNameMaxChars"
    );
    assert!(!contract.layouts.is_empty(), "plugin contract layouts");
    assert!(!contract.host_pages.is_empty(), "plugin contract hostPages");
    for slot in &contract.slots {
        assert!(
            matches!(
                slot.kind.as_str(),
                "single" | "list" | "keyed" | "chain" | "hoc"
            ),
            "slot {} has an unknown kind",
            slot.id
        );
        assert!(
            matches!(
                slot.scope.as_str(),
                "root" | "layout" | "conversation" | "message" | "composer"
            ),
            "slot {} has an unknown scope",
            slot.id
        );
        assert!(
            slot.modes
                .iter()
                .all(|mode| matches!(mode.as_str(), "declarative" | "sandbox" | "trusted")),
            "slot {} has an unknown mode",
            slot.id
        );
        assert!(
            !slot.layouts.is_empty()
                && slot
                    .layouts
                    .iter()
                    .all(|layout| contract.layouts.contains(layout)),
            "slot {} has an invalid layout",
            slot.id
        );
        if slot.kind == "keyed" {
            let key = slot
                .entry_key
                .as_deref()
                .expect("keyed slot must declare entryKey");
            assert!(
                slot.props.iter().any(|prop| prop == key),
                "slot {} entryKey must be in props",
                slot.id
            );
        }
    }
    for component in &contract.components {
        assert!(
            matches!(component.kind.as_str(), "single" | "hoc"),
            "component {} has an unknown kind",
            component.id
        );
        assert!(
            !component.lanes.is_empty() && component.lanes.iter().all(|lane| lane == "trusted"),
            "component {} lanes must be [trusted]",
            component.id
        );
        assert!(
            !component.layouts.is_empty()
                && component
                    .layouts
                    .iter()
                    .all(|layout| contract.layouts.contains(layout)),
            "component {} has an invalid layout",
            component.id
        );
        assert!(
            matches!(
                component.risk.as_str(),
                "low" | "medium" | "high" | "critical"
            ),
            "component {} has an unknown risk",
            component.id
        );
        if component.variants.is_empty() {
            assert!(
                component.builtin_recipes.is_empty(),
                "component {} has recipes without variants",
                component.id
            );
        } else {
            for variant in &component.variants {
                let recipe = component
                    .builtin_recipes
                    .get(variant)
                    .unwrap_or_else(|| panic!("component {} missing recipe for {variant}", component.id));
                assert!(
                    style_recipe_valid(contract, recipe),
                    "component {} has an invalid recipe for {variant}",
                    component.id
                );
            }
        }
    }
    for id in &contract.reserved_slots {
        assert!(
            contract.slots.iter().any(|slot| &slot.id == id),
            "reserved slot {id} is not in slots"
        );
    }
    for id in &contract.reserved_components {
        assert!(
            contract.components.iter().any(|component| &component.id == id),
            "reserved component {id} is not in components"
        );
    }
    let mut reserved = std::collections::HashSet::new();
    for id in contract
        .reserved_slots
        .iter()
        .chain(contract.reserved_components.iter())
    {
        assert!(reserved.insert(id), "duplicate reserved surface {id}");
    }
    for permission in &contract.permissions {
        assert!(
            matches!(permission.risk.as_str(), "low" | "medium" | "high" | "critical"),
            "permission {} has an unknown risk",
            permission.id
        );
    }
    for id in ["ui.override", "ui.shell", "unsafe.renderer", "secrets.read"] {
        assert!(
            contract
                .permissions
                .iter()
                .find(|permission| permission.id == id)
                .is_some_and(|permission| permission.trusted_only),
            "permission {id} must be trustedOnly"
        );
    }
    for id in &contract.reserved_permissions {
        assert!(
            !contract
                .permissions
                .iter()
                .any(|permission| &permission.id == id),
            "reserved permission {id} is also declared"
        );
    }
    assert!(
        contract
            .permissions
            .iter()
            .find(|permission| permission.id == "ui.css.global")
            .is_some_and(|permission| !permission.trusted_only),
        "ui.css.global must be available to every lane"
    );
    let mut events = std::collections::HashSet::new();
    for event in &contract.events {
        assert!(
            event.name.contains('/'),
            "event {} must be namespaced",
            event.name
        );
        assert!(events.insert(event.name.as_str()), "duplicate event {}", event.name);
    }
    let ui = &contract.ui_limits;
    for value in [
        ui.slot_entries_per_plugin,
        ui.nav_entries_per_plugin,
        ui.pages_per_plugin,
        ui.panel_tabs_per_plugin,
        ui.variants_per_plugin,
        ui.presets_per_plugin,
        ui.css_chars_per_plugin,
        ui.genui_components_per_plugin,
        ui.genui_schema_chars,
        ui.genui_prompt_chars_per_plugin,
    ] {
        assert!(value > 0, "plugin ui limits must be positive");
    }
}

/// Validates a style recipe against the contract allowlist.
pub fn style_recipe_valid(
    contract: &PluginContract,
    recipe: &BTreeMap<String, String>,
) -> bool {
    recipe.iter().all(|(key, value)| {
        contract
            .style_recipes
            .get(key)
            .is_some_and(|values| values.iter().any(|candidate| candidate == value))
    })
}

pub fn style_recipe_valid_for_contract(recipe: &BTreeMap<String, String>) -> bool {
    style_recipe_valid(contract(), recipe)
}

pub fn contract() -> &'static PluginContract {
    &CONTRACT
}

pub fn limits() -> &'static PluginLimits {
    &CONTRACT.limits
}

pub fn ui_limits() -> &'static PluginUiLimits {
    &CONTRACT.ui_limits
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

/// Permissions published by the contract but not implemented by this host.
/// A manifest that declares one is rejected with a precise error.
pub fn permission_reserved(permission: &str) -> bool {
    CONTRACT
        .reserved_permissions
        .iter()
        .any(|entry| entry == permission_base(permission))
}

pub fn permission_risk(permission: &str) -> &'static str {
    permission_spec(permission_base(permission))
        .map(|spec| spec.risk.as_str())
        .unwrap_or("critical")
}

pub fn permission_scoped(base: &str) -> bool {
    permission_spec(base).is_some_and(|spec| spec.scoped)
}

pub fn permission_trusted_only(base: &str) -> bool {
    permission_spec(base).is_some_and(|spec| spec.trusted_only)
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

pub fn slot_reserved(id: &str) -> bool {
    CONTRACT.reserved_slots.iter().any(|slot| slot == id)
}

pub fn component_spec(id: &str) -> Option<&'static ComponentSpec> {
    CONTRACT
        .components
        .iter()
        .find(|component| component.id == id)
}

pub fn component_reserved(id: &str) -> bool {
    CONTRACT.reserved_components.iter().any(|component| component == id)
}

pub fn event_spec(name: &str) -> Option<&'static EventSpec> {
    CONTRACT.events.iter().find(|event| event.name == name)
}

pub fn layout_ids() -> &'static [String] {
    &CONTRACT.layouts
}

pub fn host_pages() -> &'static [String] {
    &CONTRACT.host_pages
}

pub fn style_recipes() -> &'static BTreeMap<String, Vec<String>> {
    &CONTRACT.style_recipes
}

pub fn recipe_value_allowed(key: &str, value: &str) -> bool {
    CONTRACT
        .style_recipes
        .get(key)
        .is_some_and(|values| values.iter().any(|candidate| candidate == value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::contract_generated;

    #[test]
    fn embedded_contract_matches_generated_mirrors() {
        assert_eq!(contract().api_version, contract_generated::API_VERSION);
        assert_eq!(contract().manifest_schema_version, contract_generated::MANIFEST_SCHEMA_VERSION);
        assert_eq!(slot_ids(), contract_generated::SLOT_IDS);
        assert_eq!(component_ids(), contract_generated::COMPONENT_IDS);
        assert_eq!(
            contract()
                .layouts
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            contract_generated::LAYOUT_IDS
        );
        assert_eq!(
            contract()
                .host_pages
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            contract_generated::HOST_PAGE_IDS
        );
        assert_eq!(
            contract()
                .permissions
                .iter()
                .map(|permission| permission.id.as_str())
                .collect::<Vec<_>>(),
            contract_generated::PERMISSION_IDS
        );
        assert_eq!(
            contract()
                .permissions
                .iter()
                .filter(|permission| permission.trusted_only)
                .map(|permission| permission.id.as_str())
                .collect::<Vec<_>>(),
            contract_generated::TRUSTED_ONLY_PERMISSIONS
        );
        assert_eq!(limits().package_bytes, contract_generated::LIMIT_PACKAGE_BYTES);
        assert_eq!(
            ui_limits().css_chars_per_plugin as u64,
            contract_generated::UI_LIMIT_CSS_CHARS
        );
    }

    #[test]
    fn scoped_permissions_match_exact_and_wildcard_grants() {
        assert!(permission_matches("net:api.github.com", "net:api.github.com"));
        assert!(permission_matches("net:*", "net:api.github.com"));
        assert!(!permission_matches("net:api.github.com", "net:evil.example"));
        assert!(!permission_matches("storage", "net:api.github.com"));
        assert!(!permission_matches("net:", "net:api.github.com"));
        assert_eq!(permission_base("ui.slot:chat.composer.toolbar"), "ui.slot");
    }

    #[test]
    fn keyed_slots_declare_their_entry_key() {
        let slot = slot_spec("chat.message.node").expect("slot");
        assert_eq!(slot.kind, "keyed");
        assert_eq!(slot.entry_key.as_deref(), Some("role"));
        assert!(slot.props.iter().any(|prop| prop == "role"));
    }

    #[test]
    fn trusted_only_permissions_are_flagged() {
        assert!(permission_trusted_only("ui.override"));
        assert!(permission_trusted_only("ui.shell"));
        assert!(!permission_trusted_only("ui.css.global"));
        assert!(!permission_trusted_only("ui.nav"));
    }
}
