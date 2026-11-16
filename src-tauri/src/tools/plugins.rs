//! Agent-facing plugin installation.
//!
//! The agent may stage a plugin package, but it can never activate it: the
//! package is installed disabled and every permission is left for the user to
//! review in Settings → Plugins. Plugin code does not run during installation.

use std::path::Path;

use serde_json::{json, Value};

use crate::domain::{ApprovalDetail, RiskClass};
use crate::i18n;
use crate::providers::ToolDefinition;
use crate::tools::registry::ToolCtx;
use crate::tools::{ToolOutcome, ToolRuntime};

pub const NAME: &str = "install_plugin";
pub const VALIDATE_NAME: &str = "validate_plugin";

const DESCRIPTION: &str = "Install a signed Zylara plugin package from an HTTPS URL or a path inside the workspace. \
The plugin is installed disabled and its code never runs; the user must review and activate it in Settings → Plugins. \
Never upgrades or replaces an installed plugin.";

/// Prompt guidance for the Code profile (kept out of the wire description).
pub const GUIDANCE: &str = "Use `install_plugin` only when the user asks you to install a plugin. \
Pass an HTTPS URL or a `.zplugin` path inside the workspace; the tool stages the plugin disabled. \
Never claim it is active: tell the user to review permissions and enable it in Settings → Plugins.";

static CODE_ONLY: &[crate::domain::TurnProfile] = &[crate::domain::TurnProfile::Code];

pub static CODE_SPEC: crate::tools::registry::ToolSpec = crate::tools::registry::ToolSpec {
    name: NAME,
    description: DESCRIPTION,
    schema: schema_value,
    parallel: crate::tools::registry::ParallelClass::Exclusive,
    risk: crate::domain::RiskClass::Write,
    mutating: true,
    requires_workspace: false,
    profiles: CODE_ONLY,
    guidance: GUIDANCE,
};

const VALIDATE_DESCRIPTION: &str = "Validate a local Zylara plugin package (.zplugin) or unpacked plugin folder \
without installing or executing it. Returns the manifest identity, signature status, declared permissions, \
UI/tool surface and validation warnings. Use it repeatedly while authoring a plugin.";

pub const VALIDATE_GUIDANCE: &str = "In Plugin Creator mode, call `validate_plugin` after editing the manifest or \
package files and before `install_plugin`; use it with the CLI `dev`/`review` checks for full coverage.";

pub static VALIDATE_SPEC: crate::tools::registry::ToolSpec = crate::tools::registry::ToolSpec {
    name: VALIDATE_NAME,
    description: VALIDATE_DESCRIPTION,
    schema: validate_schema_value,
    parallel: crate::tools::registry::ParallelClass::Safe,
    risk: crate::domain::RiskClass::Read,
    mutating: false,
    requires_workspace: true,
    profiles: CODE_ONLY,
    guidance: VALIDATE_GUIDANCE,
};

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "HTTPS URL or workspace-relative path to a signed .zplugin package."
            }
        },
        "required": ["source"],
        "additionalProperties": false
    })
}

pub fn definition() -> ToolDefinition {
    ToolDefinition {
        name: NAME.to_string(),
        description: DESCRIPTION.to_string(),
        parameters: schema(),
    }
}

pub fn schema_value() -> Value {
    schema()
}

fn validate_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "Workspace-relative path to a .zplugin package or an unpacked plugin folder."
            }
        },
        "required": ["source"],
        "additionalProperties": false
    })
}

fn validate_schema_value() -> Value {
    validate_schema()
}

/// Validate a local package/folder for the creator mode. Read-only: it neither
/// installs nor evaluates plugin code.
pub fn run_validate(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let source = match source(args) {
        Ok(source) => source,
        Err(outcome) => return outcome,
    };
    if is_url(&source) {
        return ToolOutcome::error(format!(
            "PLUGIN_VALIDATE_PATH: {}",
            i18n::t("tools.plugins.validate.pathOnly")
        ));
    }
    let Some(workspace) = ctx.workspace.as_ref() else {
        return ToolOutcome::error(format!(
            "FS_NO_WORKSPACE: {}",
            i18n::t("tools.plugins.install.workspaceRequired")
        ));
    };
    // A package is a file; an unpacked plugin is a directory. Resolve twice so
    // both shapes stay confined to the workspace (Read rejects directories).
    let path = crate::workspace::safe_path::resolve(
        &workspace.root,
        &source,
        crate::workspace::safe_path::Access::Read,
    )
    .or_else(|file_error| {
        crate::workspace::safe_path::resolve(
            &workspace.root,
            &source,
            crate::workspace::safe_path::Access::ReadDir,
        )
        .map_err(|_| file_error)
    });
    let path = match path {
        Ok(path) => path,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    let Some(manager) = crate::plugins::global_manager() else {
        return ToolOutcome::error(i18n::t("tools.plugins.install.unavailable"));
    };
    let inspection = if path.is_dir() {
        manager.inspect_dev_folder(&path)
    } else {
        manager.inspect(&path)
    };
    match inspection {
        Ok(inspection) => {
            let content = serde_json::to_string_pretty(&inspection)
                .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"));
            ToolOutcome {
                content: format!(
                    "{}\n{content}",
                    i18n::t("tools.plugins.validate.valid")
                ),
                summary: Some(i18n::t_args(
                    "tools.plugins.validate.summary",
                    &[
                        ("plugin", inspection.manifest.id.as_str()),
                        ("version", inspection.manifest.version.as_str()),
                    ],
                )),
                ..Default::default()
            }
        }
        Err(error) => ToolOutcome::error(format!(
            "PLUGIN_INVALID: {error:#}"
        )),
    }
}

fn source(args: &Value) -> Result<String, ToolOutcome> {
    let value = args
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ToolOutcome::error(format!(
                "TOOL_INVALID_ARGS: {}",
                i18n::t("tools.plugins.install.invalidSource")
            ))
        })?;
    Ok(value.to_string())
}

fn is_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

async fn install_url(source: &str) -> ToolOutcome {
    let Some(manager) = crate::plugins::global_manager() else {
        return ToolOutcome::error(i18n::t("tools.plugins.install.unavailable"));
    };
    match manager.install_url_for_activation(source, None).await {
        Ok(record) => installed_outcome(&record),
        Err(error) => ToolOutcome::error(format!("{error:#}")),
    }
}

fn install_path(source: &str, ctx: &ToolCtx) -> ToolOutcome {
    let Some(workspace) = ctx.workspace.as_ref() else {
        return ToolOutcome::error(format!(
            "FS_NO_WORKSPACE: {}",
            i18n::t("tools.plugins.install.workspaceRequired")
        ));
    };
    let path = match crate::workspace::safe_path::resolve(
        &workspace.root,
        source,
        crate::workspace::safe_path::Access::Read,
    ) {
        Ok(path) => path,
        Err(error) => return ToolOutcome::error(error.to_string()),
    };
    if path.extension().and_then(|value| value.to_str()) != Some("zplugin") {
        return ToolOutcome::error(format!(
            "TOOL_INVALID_ARGS: {}",
            i18n::t("tools.plugins.install.notZplugin")
        ));
    }
    let Some(manager) = crate::plugins::global_manager() else {
        return ToolOutcome::error(i18n::t("tools.plugins.install.unavailable"));
    };
    match manager.install_for_activation(&path) {
        Ok(record) => installed_outcome(&record),
        Err(error) => ToolOutcome::error(format!("{error:#}")),
    }
}

fn installed_outcome(record: &crate::plugins::PluginRecord) -> ToolOutcome {
    let permissions = record
        .permissions
        .iter()
        .map(|permission| permission.id.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let permissions = if permissions.is_empty() {
        i18n::t("tools.plugins.install.noPermissions")
    } else {
        permissions
    };
    ToolOutcome {
        content: i18n::t_args(
            "tools.plugins.install.installed",
            &[
                ("plugin", record.id.as_str()),
                ("version", record.version.as_str()),
                ("permissions", permissions.as_str()),
            ],
        ),
        summary: Some(i18n::t_args(
            "tools.plugins.install.summary",
            &[("plugin", record.name.as_str())],
        )),
        ..Default::default()
    }
}

/// Chat profile: only remote HTTPS packages, because Chat has no workspace to
/// read a local `.zplugin` from.
pub async fn run_chat(_rt: &ToolRuntime, args: &Value) -> ToolOutcome {
    let source = match source(args) {
        Ok(source) => source,
        Err(outcome) => return outcome,
    };
    if !is_url(&source) {
        return ToolOutcome::error(format!(
            "PLUGIN_PACKAGE_URL: {}",
            i18n::t("tools.plugins.install.urlOnly")
        ));
    }
    if source.starts_with("http://") {
        return ToolOutcome::error("PLUGIN_PACKAGE_URL: package URL must use https");
    }
    install_url(&source).await
}

/// Code profile: URL or a package confined to the workspace. Write policy is
/// applied when a workspace exists; the package is still only staged disabled.
pub async fn run_code(ctx: &ToolCtx, args: &Value) -> ToolOutcome {
    let source = match source(args) {
        Ok(source) => source,
        Err(outcome) => return outcome,
    };
    if is_url(&source) {
        if source.starts_with("http://") {
            return ToolOutcome::error("PLUGIN_PACKAGE_URL: package URL must use https");
        }
        if ctx.workspace.is_some() {
            if let Err(outcome) = crate::tools::code::exec::policy_check(
                ctx,
                NAME,
                RiskClass::Write,
                true,
                Some(source.as_str()),
                false,
                None,
                ApprovalDetail::Other {
                    text: i18n::t_args(
                        "tools.plugins.install.approvalDetail",
                        &[("source", source.as_str())],
                    ),
                },
                &i18n::t("tools.plugins.install.approvalTitle"),
            )
            .await
            {
                return outcome;
            }
        }
        return install_url(&source).await;
    }
    if let Err(outcome) = crate::tools::code::exec::policy_check(
        ctx,
        NAME,
        RiskClass::Write,
        true,
        Some(source.as_str()),
        false,
        None,
        ApprovalDetail::Other {
            text: i18n::t_args(
                "tools.plugins.install.approvalDetail",
                &[("source", source.as_str())],
            ),
        },
        &i18n::t("tools.plugins.install.approvalTitle"),
    )
    .await
    {
        return outcome;
    }
    install_path(&source, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_requires_a_single_source() {
        let schema = schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["source"]));
        assert_eq!(schema["additionalProperties"], false);
    }

    #[test]
    fn definition_keeps_the_agent_disabled_contract_in_its_description() {
        let definition = definition();
        assert_eq!(definition.name, NAME);
        assert!(definition.description.contains("installed disabled"));
        assert!(definition.description.contains("never runs"));
    }

    #[test]
    fn source_rejects_empty_values() {
        let outcome = source(&json!({ "source": " " })).expect_err("empty source");
        assert!(outcome.is_error);
        assert!(outcome.content.contains("TOOL_INVALID_ARGS"));
    }

    #[test]
    fn validate_spec_is_read_only_and_requires_a_source() {
        let schema = validate_schema_value();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["source"]));
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(VALIDATE_SPEC.name, VALIDATE_NAME);
        assert_eq!(VALIDATE_SPEC.risk, crate::domain::RiskClass::Read);
        assert!(!VALIDATE_SPEC.mutating);
        assert!(VALIDATE_SPEC.description.contains("without installing"));
    }
}
