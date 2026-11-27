//! Plugin platform integration tests (package → install → tools/prompt/skills
//! → update/rollback → uninstall; registry verification; safe mode).

use std::collections::BTreeMap;
use std::io::{Cursor, Write};
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{json, Value};

use super::package;
use super::signature;
use super::PluginManager;
use crate::db::Db;
use crate::domain::{Settings, TurnProfile};

fn manifest(version: &str, permissions: &[&str]) -> Value {
    let mut permissions = permissions.to_vec();
    for required in ["ui.view", "agent.tools", "agent.prompt", "agent.skills"] {
        if !permissions.contains(&required) {
            permissions.push(required);
        }
    }
    json!({
        "schemaVersion": 1,
        "id": "com.acme.demo",
        "name": "Demo",
        "version": version,
        "apiVersion": 1,
        "description": "Fixture plugin",
        "author": "Acme",
        "engines": { "zylara": ">=0.10.0 <1.0.0" },
        "publisher": { "id": "acme", "name": "Acme", "keyId": "acme-2026" },
        "permissions": permissions,
        "contributes": {
            "ui": {
                "views": [{
                    "id": "demo",
                    "title": "Demo",
                    "surface": "chat",
                    "location": "sidebar",
                    "entry": "ui/page.html"
                }]
            },
            "tools": [{
                "name": "lookup",
                "description": "Look up a record.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string" } }
                }
            }],
            "promptSections": [{ "id": "rules", "title": "Demo rules", "file": "prompt.md" }],
            "skills": ["skills"],
            "locales": ["locales"]
        },
        "runtime": {
            "ui": "sandbox",
            "backend": { "kind": "js", "entry": "backend/index.html" }
        }
    })
}

fn build_package(version: &str, permissions: &[&str]) -> Vec<u8> {
    build_package_with_key(version, permissions, [42u8; 32], "acme-2026")
}

fn build_package_with_key(
    version: &str,
    permissions: &[&str],
    seed: [u8; 32],
    key_id: &str,
) -> Vec<u8> {
    let mut manifest = manifest(version, permissions);
    manifest["publisher"]["keyId"] = serde_json::json!(key_id);
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::from([
        ("manifest.json".to_string(), serde_json::to_vec(&manifest).unwrap()),
        (
            "ui/page.html".to_string(),
            b"<html><body><script src=\"/@zylara/sdk.js\"></script></body></html>".to_vec(),
        ),
        (
            "backend/index.html".to_string(),
            b"<html><body><script src=\"/@zylara/sdk.js\"></script></body></html>".to_vec(),
        ),
        (
            "prompt.md".to_string(),
            b"Always consult the demo index before answering.".to_vec(),
        ),
        (
            "skills/demo/SKILL.md".to_string(),
            b"---\nname: demo-skill\ndescription: Demo skill.\n---\n# Demo".to_vec(),
        ),
        ("locales/en.json".to_string(), br#"{"views":{"demo":"Demo"}}"#.to_vec()),
    ]);
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let signature = signature::sign_package(&files, "acme", key_id, &key);
    files.insert(
        signature::SIGNATURE_PATH.to_string(),
        serde_json::to_vec(&signature).unwrap(),
    );
    zip_files(&files)
}

fn zip_files(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in files {
            writer.start_file(name, options).expect("start zip entry");
            writer.write_all(bytes).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

fn write_package(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("write package");
    path
}

fn manager(temp: &tempfile::TempDir, settings: &Settings) -> Arc<PluginManager> {
    let db = Arc::new(Db::open_in_memory().expect("db"));
    PluginManager::load_for_test(temp.path(), db, settings, false).expect("manager")
}

#[test]
fn parses_plugin_deep_links_without_scheme_smuggling() {
    let target = super::capture_deep_links(vec![
        "zylara://plugin/install?url=https%3A%2F%2Fexample.com%2Fplugin.zplugin".to_string(),
    ])
    .expect("deep link");
    assert_eq!(target, "https://example.com/plugin.zplugin");
    assert_eq!(super::take_pending_deep_link().as_deref(), Some(target.as_str()));
    let convenience = super::capture_deep_links(vec![
        "zylara://plugin/https%3A%2F%2Fexample.com%2Fconvenience.zplugin".to_string(),
    ])
    .expect("convenience deep link");
    assert_eq!(convenience, "https://example.com/convenience.zplugin");
    let _ = super::take_pending_deep_link();
    assert!(super::capture_deep_links(vec![
        "zylara://plugin/install?url=http%3A%2F%2Fevil.example%2Fplugin.zplugin".to_string()
    ])
    .is_none());
    assert!(super::capture_deep_links(vec!["--safe-mode".to_string()]).is_none());
}

#[test]
fn committed_fixtures_validate() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("fixtures");
    for (file, id, trusted) in [
        ("sandbox-demo-1.2.0.zplugin", "com.acme.notes", false),
        ("trusted-demo-1.0.0.zplugin", "com.acme.trusted-demo", true),
    ] {
        let package = package::read_file(&root.join(file), false)
            .unwrap_or_else(|error| panic!("{file}: {error:#}"));
        assert_eq!(package.manifest.id, id);
        assert_eq!(package.manifest.is_trusted(), trusted);
        assert!(package.verified.is_some(), "{file} must be signed");
        let tools = package::resolve_tools(&package).expect("tools");
        assert!(!tools.is_empty(), "{file} has tools");
        if id == "com.acme.trusted-demo" {
            assert!(
                !package.manifest.contributes.providers.is_empty(),
                "trusted fixture must also register a declarative provider"
            );
            assert_eq!(
                package.manifest.runtime.entry.as_deref(),
                Some("main.js"),
                "trusted fixture must ship the webview main script"
            );
        }
    }
}

#[test]
fn agent_install_stages_the_plugin_disabled_until_the_user_activates_it() {
    let temp = tempfile::tempdir().expect("temp");
    let manager = manager(&temp, &Settings::default());
    let path = write_package(
        temp.path(),
        "agent-demo-1.0.0.zplugin",
        &build_package("1.0.0", &["ui.view", "storage"]),
    );
    let record = manager
        .install_for_activation(&path)
        .expect("agent install");
    assert!(!record.enabled);
    assert!(!record.active);
    assert_eq!(record.disabled_reason.as_deref(), Some("activation_required"));
    assert!(
        record.permissions.iter().all(|permission| permission.granted),
        "activation is a single user decision; permissions stay recorded until then"
    );
    assert!(manager.active_ids().is_empty(), "no contribution may load");
    assert!(
        manager.tool_definitions(TurnProfile::Chat).is_empty(),
        "agent install cannot expose plugin tools before activation"
    );

    let duplicate = manager
        .install_for_activation(&path)
        .expect_err("agent install must not replace an installed plugin");
    assert!(duplicate.to_string().contains("PLUGIN_ALREADY_INSTALLED"));

    let activated = manager
        .set_enabled("com.acme.demo", true)
        .expect("user activation");
    assert!(activated.enabled);
    assert!(activated.active);
    assert_eq!(manager.active_ids(), vec!["com.acme.demo"]);
}

#[test]
fn installs_lifecycle_and_exposes_tools_prompt_and_skills() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let before_install = manager.config_fingerprint();
    let path = write_package(
        temp.path(),
        "demo-1.0.0.zplugin",
        &build_package(
            "1.0.0",
            &[
                "ui.view",
                "agent.tools",
                "agent.prompt",
                "agent.skills",
                "storage",
            ],
        ),
    );
    let record = manager
        .install(
            &path,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install");
    assert_eq!(record.version, "1.0.0");
    assert!(record.active);
    assert_ne!(before_install, manager.config_fingerprint());
    assert_eq!(manager.active_ids(), vec!["com.acme.demo"]);
    let tools = manager.tool_definitions(TurnProfile::Chat);
    assert!(
        tools.iter().any(|tool| tool.name == "plugin__com_acme_demo__lookup"),
        "{tools:?}"
    );
    assert!(manager
        .tool_definitions(TurnProfile::Code)
        .iter()
        .any(|tool| tool.name == "plugin__com_acme_demo__lookup"));
    assert!(manager.tool_owner("plugin__com_acme_demo__lookup").is_some());
    let prompt = manager.prompt_context();
    assert!(prompt.text.contains("Demo rules"));
    assert!(prompt.text.contains("consult the demo index"));
    assert!(!prompt.fingerprint.is_empty());
    let prompt_before_disable = prompt.fingerprint.clone();
    manager
        .set_enabled("com.acme.demo", false)
        .expect("disable");
    assert_ne!(prompt_before_disable, manager.prompt_context().fingerprint);
    manager
        .set_enabled("com.acme.demo", true)
        .expect("re-enable");
    assert!(manager.prompt_context().text.contains("Demo rules"));
    let skills = manager.skill_roots();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].plugin_id.as_deref(), Some("com.acme.demo"));
    let locales = manager.locale_bundle();
    assert_eq!(
        locales.entries["com.acme.demo"]["en"]["views"]["demo"],
        "Demo"
    );
    let root = std::path::PathBuf::from(&record.root);
    manager
        .uninstall("com.acme.demo", false)
        .expect("uninstall");
    assert!(manager.record("com.acme.demo").is_none());
    assert!(manager.active_ids().is_empty());
    assert!(!root.exists());
}

#[test]
fn update_requires_consent_for_new_permissions_and_rolls_back() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let v1 = write_package(
        temp.path(),
        "v1.zplugin",
        &build_package("1.0.0", &["ui.view", "agent.tools", "agent.prompt", "agent.skills"]),
    );
    manager
        .install(
            &v1,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install v1");
    let v2 = write_package(
        temp.path(),
        "v2.zplugin",
        &build_package(
            "1.1.0",
            &[
                "ui.view",
                "agent.tools",
                "agent.prompt",
                "agent.skills",
                "net:api.example.com",
            ],
        ),
    );
    let error = manager
        .install(
            &v2,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect_err("new permission needs explicit consent");
    assert!(error.to_string().contains("PLUGIN_PERMISSIONS_CHANGED"), "{error:#}");
    assert_eq!(
        manager.record("com.acme.demo").expect("record").version,
        "1.0.0"
    );

    let record = manager
        .install(
            &v2,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: Some(vec![
                    "ui.view".to_string(),
                    "agent.tools".to_string(),
                    "agent.prompt".to_string(),
                    "agent.skills".to_string(),
                    "net:api.example.com".to_string(),
                ]),
            },
        )
        .expect("install v2");
    assert_eq!(record.version, "1.1.0");
    assert_eq!(record.previous_version.as_deref(), Some("1.0.0"));

    let rolled_back = manager.rollback("com.acme.demo").expect("rollback");
    assert_eq!(rolled_back.version, "1.0.0");
    assert!(rolled_back.active);
}

#[test]
fn updating_a_user_disabled_plugin_keeps_it_disabled() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let v1 = write_package(
        temp.path(),
        "v1.zplugin",
        &build_package(
            "1.0.0",
            &["ui.view", "agent.tools", "agent.prompt", "agent.skills"],
        ),
    );
    manager
        .install(
            &v1,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install v1");
    manager
        .set_enabled("com.acme.demo", false)
        .expect("disable plugin");

    let v2 = write_package(
        temp.path(),
        "v2.zplugin",
        &build_package(
            "1.1.0",
            &["ui.view", "agent.tools", "agent.prompt", "agent.skills"],
        ),
    );
    let record = manager
        .install(
            &v2,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("update v2");

    assert_eq!(record.version, "1.1.0");
    assert!(!record.enabled);
    assert!(!record.active);
    assert_eq!(record.disabled_reason.as_deref(), Some("user_disabled"));
    assert!(manager.active_ids().is_empty());
}

#[test]
fn rollback_does_not_regrant_permissions_missing_from_the_current_map() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let v1 = write_package(
        temp.path(),
        "v1.zplugin",
        &build_package("1.0.0", &["storage"]),
    );
    manager
        .install(
            &v1,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install v1");

    let v2 = write_package(temp.path(), "v2.zplugin", &build_package("1.1.0", &[]));
    manager
        .install(
            &v2,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("update v2 without storage");

    let rolled_back = manager.rollback("com.acme.demo").expect("rollback");
    assert_eq!(rolled_back.version, "1.0.0");
    assert!(!rolled_back.enabled);
    assert!(!rolled_back.active);
    assert_eq!(
        rolled_back.disabled_reason.as_deref(),
        Some("permissions_incomplete")
    );
    assert!(manager.active_ids().is_empty());
}

#[test]
fn registry_revocation_reloads_the_live_runtime() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let package = write_package(
        temp.path(),
        "demo.zplugin",
        &build_package("1.0.0", &[]),
    );
    manager
        .install(
            &package,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install");
    assert!(!manager.active_ids().is_empty());

    let index = super::RegistryIndex {
        schema_version: 1,
        name: "test".to_string(),
        generated_at: String::new(),
        plugins: Vec::new(),
        revoked: vec![super::RevokedPlugin {
            id: "com.acme.demo".to_string(),
            version: "1.0.0".to_string(),
            reason: "test".to_string(),
        }],
        signature: None,
    };
    manager.apply_revocations(&index).expect("revocation");

    assert!(manager.active_ids().is_empty());
    let record = manager.record("com.acme.demo").expect("record");
    assert!(!record.enabled);
    assert!(!record.active);
    assert_eq!(record.disabled_reason.as_deref(), Some("revoked"));
}

#[test]
fn publisher_key_rotation_requires_typed_consent_and_revokes_the_old_key() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let first = write_package(temp.path(), "v1.zplugin", &build_package("1.0.0", &[]));
    manager
        .install(
            &first,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install old key");
    let rotated = write_package(
        temp.path(),
        "v1-rotated.zplugin",
        &build_package_with_key("1.1.0", &[], [77u8; 32], "acme-2027"),
    );
    let error = manager
        .install(
            &rotated,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect_err("rotation needs confirmation");
    assert!(error.to_string().contains("PLUGIN_KEY_CHANGED"), "{error:#}");
    let installed = manager
        .install_with_rotation(
            &rotated,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
            true,
        )
        .expect("rotated install");
    assert_eq!(installed.version, "1.1.0");
    let old = manager
        .db()
        .plugin_publisher_key("acme", "acme-2026")
        .expect("old key")
        .expect("old key row");
    assert!(old.revoked);
    let new = manager
        .db()
        .plugin_publisher_key("acme", "acme-2027")
        .expect("new key")
        .expect("new key row");
    assert!(!new.revoked);
}

#[test]
fn safe_mode_hides_every_contribution_without_deleting_state() {
    let temp = tempfile::tempdir().expect("temp");
    let db = Arc::new(Db::open_in_memory().expect("db"));
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = PluginManager::load_for_test(temp.path(), db.clone(), &settings, false)
        .expect("manager");
    let path = write_package(temp.path(), "demo.zplugin", &build_package("1.0.0", &["agent.tools"]));
    manager
        .install(
            &path,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install");
    drop(manager);

    let settings = Settings {
        plugin_safe_mode: true,
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let safe = PluginManager::load_for_test(temp.path(), db, &settings, false).expect("manager");
    let snapshot = safe.snapshot();
    assert!(snapshot.safe_mode);
    assert!(snapshot.plugins.iter().all(|plugin| !plugin.active));
    assert!(safe.tool_definitions(TurnProfile::Chat).is_empty());
    assert!(safe.prompt_context().text.is_empty());
    assert_eq!(safe.record("com.acme.demo").expect("row").version, "1.0.0");
}

#[test]
fn rejects_path_traversal_zip_and_unsigned_packages() {
    let temp = tempfile::tempdir().expect("temp");
    let mut files = BTreeMap::from([
        (
            "manifest.json".to_string(),
            serde_json::to_vec(&manifest("1.0.0", &[])).unwrap(),
        ),
        ("../escape.txt".to_string(), b"evil".to_vec()),
    ]);
    let bytes = zip_files(&files);
    let path = write_package(temp.path(), "evil.zplugin", &bytes);
    let error = package::read_file(&path, true).expect_err("traversal rejected");
    assert!(error.to_string().contains("unsafe ZIP entry"), "{error:#}");

    files.remove("../escape.txt");
    files.remove(signature::SIGNATURE_PATH);
    let bytes = zip_files(&files);
    let path = write_package(temp.path(), "unsigned.zplugin", &bytes);
    let error = package::read_file(&path, false).expect_err("unsigned rejected");
    assert!(error.to_string().contains("not signed"), "{error:#}");
}

#[test]
fn package_signature_rejects_tampering() {
    let temp = tempfile::tempdir().expect("temp");
    let mut files = BTreeMap::from([
        (
            "manifest.json".to_string(),
            serde_json::to_vec(&manifest("1.0.0", &[])).unwrap(),
        ),
        ("ui/page.html".to_string(), b"<html>ok</html>".to_vec()),
    ]);
    let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
    let signature = signature::sign_package(&files, "acme", "acme-2026", &key);
    files.insert(
        signature::SIGNATURE_PATH.to_string(),
        serde_json::to_vec(&signature).unwrap(),
    );
    files.insert("ui/page.html".to_string(), b"<html>evil</html>".to_vec());
    let path = write_package(temp.path(), "tampered.zplugin", &zip_files(&files));
    let error = package::read_file(&path, false).expect_err("tamper rejected");
    assert!(
        format!("{error:#}").contains("package hash mismatch"),
        "{error:#}"
    );
}

#[test]
fn revoking_a_permission_disables_the_plugin_and_contribution_state() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let path = write_package(
        temp.path(),
        "demo.zplugin",
        &build_package("1.0.0", &["ui.view", "agent.tools", "agent.prompt", "agent.skills"]),
    );
    manager
        .install(
            &path,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install");
    assert_eq!(manager.active_ids(), vec!["com.acme.demo"]);

    let record = manager
        .set_permissions(
            "com.acme.demo",
            [
                "ui.view".to_string(),
                "agent.prompt".to_string(),
                "agent.skills".to_string(),
            ]
            .to_vec(),
        )
        .expect("revoke agent.tools");
    assert!(!record.enabled);
    assert!(!record.active);
    assert!(manager.tool_definitions(TurnProfile::Chat).is_empty());
    assert!(manager.prompt_context().text.is_empty());

    manager
        .set_permissions(
            "com.acme.demo",
            [
                "ui.view".to_string(),
                "agent.tools".to_string(),
                "agent.prompt".to_string(),
                "agent.skills".to_string(),
            ]
            .to_vec(),
        )
        .expect("regrant");
    assert!(manager.set_enabled("com.acme.demo", true).expect("enable").active);
}

#[test]
fn registry_checks_updates_without_trusting_the_index_alone() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let path = write_package(temp.path(), "v1.zplugin", &build_package("1.0.0", &["agent.tools"]));
    manager
        .install(
            &path,
            super::InstallOptions {
                source: "test".to_string(),
                allow_unsigned: false,
                granted_permissions: None,
            },
        )
        .expect("install");

    let registry_key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    let mut registry = json!({
        "schemaVersion": 1,
        "name": "Test registry",
        "generatedAt": "2026-11-14T00:00:00Z",
        "plugins": [{
            "id": "com.acme.demo",
            "name": "Demo",
            "version": "1.2.0",
            "apiVersion": 1,
            "publisher": {
                "id": "acme",
                "name": "Acme",
                "keyId": "acme-2026",
                "publicKey": base64::engine::general_purpose::STANDARD.encode(
                    ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]).verifying_key().to_bytes()
                )
            },
            "summary": "Demo plugin",
            "packageUrl": "https://example.invalid/demo.zplugin",
            "permissions": ["agent.tools", "net:api.example.com"],
            "channel": "stable"
        }],
        "revoked": []
    });
    let canonical = signature::canonical_json_bytes(&registry).unwrap();
    let signature = signature::sign_registry(&canonical, "registry-2026", &registry_key);
    registry["signature"] = serde_json::to_value(signature).unwrap();
    let registry_path = temp.path().join("registry.json");
    std::fs::write(
        &registry_path,
        serde_json::to_vec_pretty(&registry).unwrap(),
    )
    .expect("write registry");
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let view = runtime
        .block_on(manager.store_view(registry_path.to_string_lossy().as_ref(), true))
        .expect("signed registry");
    assert_eq!(view.plugins.len(), 1);
    let updates = runtime
        .block_on(manager.check_updates(registry_path.to_string_lossy().as_ref(), true))
        .expect("updates");
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].latest_version, "1.2.0");
    assert_eq!(updates[0].new_permissions, vec!["net:api.example.com"]);

    let fixture_registry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("fixtures")
        .join("registry.json");
    let provider = runtime
        .block_on(manager.install_from_registry_with_rotation(
            fixture_registry.to_string_lossy().as_ref(),
            "com.acme.gateway",
            None,
            true,
        ))
        .expect("install provider fixture from the local registry");
    assert_eq!(provider.id, "com.acme.gateway");
    assert!(manager.provider("plugin__com_acme_gateway__gateway").is_some());

    // A modified index without a valid signature is rejected.
    let mut tampered: Value = serde_json::from_slice(
        &std::fs::read(&registry_path).expect("read registry"),
    )
    .expect("json");
    tampered["plugins"][0]["version"] = json!("9.9.9");
    let tampered_path = temp.path().join("tampered-registry.json");
    std::fs::write(&tampered_path, serde_json::to_vec(&tampered).unwrap()).expect("write");
    let error = runtime
        .block_on(manager.store_view(tampered_path.to_string_lossy().as_ref(), true))
        .expect_err("tampered registry rejected");
    assert!(
        format!("{error:#}").contains("PLUGIN_REGISTRY_SIGNATURE_INVALID"),
        "{error:#}"
    );
}

#[test]
fn registry_url_setting_accepts_multiple_signed_registries() {
    assert_eq!(
        super::store::registry_urls(
            "https://a.example/registry.json, https://b.example/registry.json\nhttps://a.example/registry.json"
        ),
        vec![
            "https://a.example/registry.json".to_string(),
            "https://b.example/registry.json".to_string(),
        ]
    );
    assert!(super::store::registry_urls(" , \n").is_empty());
}

#[test]
fn store_view_merges_two_signed_registries_and_ignores_one_failure() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("fixtures")
        .join("registry.json");
    let first = temp.path().join("first.json");
    let second = temp.path().join("second.json");
    std::fs::copy(&fixture, &first).expect("copy first");
    std::fs::copy(&fixture, &second).expect("copy second");
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let view = runtime
        .block_on(manager.store_view(
            &format!(
                "{}, {}, {}",
                first.to_string_lossy(),
                temp.path().join("missing.json").to_string_lossy(),
                second.to_string_lossy()
            ),
            false,
        ))
        .expect("merged registry");
    assert_eq!(view.plugins.len(), 5);
    assert!(view.registry_name.contains(" + "));
    let installed = runtime
        .block_on(manager.install_from_registry(
            &format!(
                "{}, {}",
                temp.path().join("missing.json").to_string_lossy(),
                fixture.to_string_lossy()
            ),
            "com.acme.gateway",
            None,
        ))
        .expect("install from the second registry");
    assert_eq!(installed.id, "com.acme.gateway");
}

#[test]
fn corrupt_registry_cache_is_ignored() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("fixtures")
        .join("registry.json");
    let registry_path = temp.path().join("registry.json");
    std::fs::copy(&source, &registry_path).expect("copy registry");
    let url = registry_path.to_string_lossy().to_string();
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    runtime
        .block_on(manager.store_view(&url, false))
        .expect("prime cache");
    manager
        .db()
        .plugin_store_cache_set(&format!("registry:{url}"), None, "{")
        .expect("corrupt cache");
    let fresh = runtime
        .block_on(manager.store_view(&url, false))
        .expect("cache corruption ignored");
    assert!(!fresh.plugins.is_empty());
}

#[test]
fn stale_registry_cache_is_used_when_the_registry_is_offline() {
    let temp = tempfile::tempdir().expect("temp");
    let settings = Settings {
        plugin_dev_mode: true,
        ..Settings::default()
    };
    let manager = manager(&temp, &settings);
    let source_registry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("fixtures")
        .join("registry.json");
    let registry_path = temp.path().join("registry.json");
    std::fs::copy(&source_registry, &registry_path).expect("copy registry");
    let url = registry_path.to_string_lossy().to_string();
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let first = runtime
        .block_on(manager.store_view(&url, false))
        .expect("initial registry");
    assert!(!first.plugins.is_empty());
    // Expire the cache and remove the source, simulating offline mode.
    manager
        .db()
        .connection()
        .execute(
            "UPDATE plugin_store_cache SET fetched_at = 0 WHERE key = ?1",
            rusqlite::params![format!("registry:{url}")],
        )
        .expect("expire cache");
    std::fs::remove_file(&registry_path).expect("remove registry");
    let offline = runtime
        .block_on(manager.store_view(&url, false))
        .expect("cached registry fallback");
    assert_eq!(offline.registry_name, first.registry_name);
}

#[test]
fn plugin_genui_presentations_are_validated_before_reaching_the_renderer() {
    let temp = tempfile::tempdir().expect("temp");
    let manager = manager(&temp, &Settings::default());
    let (sender, _receiver) = tokio::sync::oneshot::channel();
    manager.pending.lock().insert(
        "call-genui".to_string(),
        super::PendingCall {
            plugin_id: "com.acme.demo".to_string(),
            tool: "lookup".to_string(),
            sender,
        },
    );
    let rejected = manager.complete_tool_call(super::PluginToolResult {
        call_id: "call-genui".to_string(),
        content: "result".to_string(),
        presentation: Some(json!({
            "kind": "genui",
            "source": "{\"components\":[{\"type\":\"not-a-component\"}]}"
        })),
        ..Default::default()
    });
    assert!(rejected.is_err());
    assert!(format!("{:#}", rejected.unwrap_err()).contains("PLUGIN_RESULT_INVALID"));
}

#[test]
fn manifest_schema_artifact_is_valid_and_documents_the_runtime() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("data")
        .join("plugin-manifest.schema.json");
    let raw = std::fs::read_to_string(&path).expect("manifest schema");
    let schema: Value = serde_json::from_str(&raw).expect("schema JSON");
    assert_eq!(schema["$schema"], "https://json-schema.org/draft/2020-12/schema");
    assert_eq!(schema["properties"]["schemaVersion"]["enum"], serde_json::json!([1, 2]));
    assert_eq!(
        schema["properties"]["runtime"]["properties"]["backend"]["properties"]["kind"]["const"],
        "js"
    );
    assert_eq!(
        schema["$defs"]["provider"]["properties"]["baseUrl"]["pattern"],
        "^https://"
    );
}

/// Enforcement matrix for the permission catalog. Adding a permission to
/// `data/plugin-contract.json` without wiring it (or reserving it) fails here,
/// because every declared id must name where the host enforces it.
const ENFORCED_PERMISSIONS: &[(&str, &str)] = &[
    ("ui.slot", "manifest `ui.slot:<slot>` + renderer Slot filter"),
    ("ui.view", "manifest + registry `hasPermission(ui.view)`"),
    ("ui.nav", "manifest + registry `hasPermission(ui.nav)`"),
    ("ui.panel", "manifest + registry `hasPermission(ui.panel)`"),
    ("ui.settings", "manifest + registry `hasPermission(ui.settings)`"),
    ("ui.command", "manifest + registry `hasPermission(ui.command)`"),
    ("ui.artifact", "manifest + registry `hasPermission(ui.artifact)`"),
    ("ui.sidebar", "manifest + registry `hasPermission(ui.sidebar)`"),
    ("ui.variant", "manifest + trusted `ui.variant` + registry variants"),
    ("ui.preset", "manifest + host `setPreset` action gate"),
    ("ui.genui", "`PluginManager::genui_components` grant filter"),
    ("ui.override", "manifest target check + `ComponentSlot` override gate"),
    ("ui.css.global", "trusted `addCss`/`addGlobalCss` requirePermission"),
    ("ui.shell", "trusted `replaceShell` requirePermission"),
    ("ui.theme", "manifest + plugin-wide grant gate (`permissions_incomplete`)"),
    ("commands", "host `execute` action requires `commands`"),
    ("hotkeys", "manifest: command hotkey requires `hotkeys`"),
    ("settings", "broker `settings.*`"),
    ("agent.tools", "`tool_definitions`/`dispatch_tool` grant filter"),
    ("agent.prompt", "manifest + plugin-wide grant gate"),
    ("agent.skills", "manifest + `skill_roots` + plugin-wide grant gate"),
    ("agent.modes", "`PluginManager::modes` grant filter"),
    ("agent.templates", "`PluginManager::agent_templates` grant filter"),
    ("chat.read", "broker `chat.read`/`chat.list`"),
    ("chat.write", "broker `chat.draft`"),
    ("fs.read", "broker `fs.read`/`fs.list` glob scope"),
    ("fs.write", "broker `fs.write` glob scope"),
    ("net", "broker `net.request` host allowlist"),
    ("secrets.use", "broker `secrets.has`/`secrets.names`/`net.request`"),
    ("secrets.read", "broker `secrets.read` (trusted only)"),
    ("storage", "broker `storage.*`"),
    ("events", "renderer event bridge scope check"),
    ("clipboard.read", "broker `clipboard.read`"),
    ("notifications", "broker `notify`"),
    ("opener", "broker `opener.open` + host `openExternal`"),
    ("providers", "`PluginManager::providers` grant filter"),
    ("unsafe.renderer", "manifest trusted gate + trusted loader"),
];

#[test]
fn every_contract_permission_is_enforced_or_reserved() {
    let contract = super::contract::contract();
    for permission in &contract.permissions {
        assert!(
            ENFORCED_PERMISSIONS
                .iter()
                .any(|(id, _)| *id == permission.id.as_str()),
            "permission `{}` has no enforcement entry",
            permission.id
        );
    }
    for (id, _) in ENFORCED_PERMISSIONS {
        assert!(
            contract
                .permissions
                .iter()
                .any(|permission| permission.id == *id),
            "enforcement entry `{id}` is not declared in the contract"
        );
    }
    for reserved in &contract.reserved_permissions {
        assert!(
            !contract
                .permissions
                .iter()
                .any(|permission| &permission.id == reserved),
            "reserved permission `{reserved}` is also declared as implemented"
        );
        assert!(
            ENFORCED_PERMISSIONS.iter().all(|(id, _)| id != reserved),
            "reserved permission `{reserved}` has an enforcement entry"
        );
    }
}

#[test]
fn reserved_permissions_are_rejected_by_the_manifest() {
    let contract = super::contract::contract();
    for reserved in &contract.reserved_permissions {
        assert!(
            super::contract::permission_reserved(reserved),
            "`{reserved}` must be reported as reserved"
        );
        assert!(
            !super::contract::permission_known(reserved),
            "`{reserved}` must not be installable"
        );
    }
}
