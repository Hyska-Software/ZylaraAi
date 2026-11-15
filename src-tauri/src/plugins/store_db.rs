//! Persistence for the plugin platform. All SQL lives here; the manager sees
//! typed rows only.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Db;

#[derive(Debug, Clone)]
pub struct StoredPlugin {
    pub id: String,
    pub version: String,
    pub api_version: u32,
    pub root: String,
    pub enabled: bool,
    pub trusted: bool,
    pub source: String,
    pub signature_status: String,
    pub publisher_id: Option<String>,
    pub publisher_name: Option<String>,
    pub key_id: Option<String>,
    pub key_fingerprint: Option<String>,
    pub manifest_json: String,
    pub package_hash: String,
    pub installed_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub auto_update: bool,
    pub previous_version: Option<String>,
    pub previous_root: Option<String>,
    pub disabled_reason: Option<String>,
    pub size_bytes: i64,
}

#[derive(Debug, Clone)]
pub struct PublisherKey {
    pub publisher_id: String,
    pub key_id: String,
    pub public_key: String,
    pub fingerprint: String,
    pub trusted_at: i64,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginLogRow {
    pub id: i64,
    pub plugin_id: String,
    pub level: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuditRow {
    pub id: i64,
    pub plugin_id: String,
    pub capability: String,
    pub params_digest: Option<String>,
    pub decision: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolCallRow {
    pub id: i64,
    pub plugin_id: String,
    pub tool: String,
    pub conversation_id: Option<String>,
    pub turn_id: Option<String>,
    pub status: String,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

const PLUGIN_COLUMNS: &str = "id, version, api_version, root, enabled, trusted, source, \
     signature_status, publisher_id, publisher_name, key_id, key_fingerprint, manifest_json, \
     package_hash, installed_at, updated_at, last_used_at, auto_update, previous_version, \
     previous_root, disabled_reason, size_bytes";

fn row_to_plugin(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredPlugin> {
    Ok(StoredPlugin {
        id: row.get(0)?,
        version: row.get(1)?,
        api_version: row.get::<_, i64>(2)? as u32,
        root: row.get(3)?,
        enabled: row.get::<_, i64>(4)? != 0,
        trusted: row.get::<_, i64>(5)? != 0,
        source: row.get(6)?,
        signature_status: row.get(7)?,
        publisher_id: row.get(8)?,
        publisher_name: row.get(9)?,
        key_id: row.get(10)?,
        key_fingerprint: row.get(11)?,
        manifest_json: row.get(12)?,
        package_hash: row.get(13)?,
        installed_at: row.get(14)?,
        updated_at: row.get(15)?,
        last_used_at: row.get(16)?,
        auto_update: row.get::<_, i64>(17)? != 0,
        previous_version: row.get(18)?,
        previous_root: row.get(19)?,
        disabled_reason: row.get(20)?,
        size_bytes: row.get(21)?,
    })
}

impl Db {
    pub fn plugin_list(&self) -> Result<Vec<StoredPlugin>> {
        let conn = self.connection();
        let sql = format!("SELECT {PLUGIN_COLUMNS} FROM plugins ORDER BY id");
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map([], row_to_plugin)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar plugins")
    }

    pub fn plugin_get(&self, id: &str) -> Result<Option<StoredPlugin>> {
        let conn = self.connection();
        let sql = format!("SELECT {PLUGIN_COLUMNS} FROM plugins WHERE id = ?1");
        conn.query_row(&sql, params![id], row_to_plugin)
            .optional()
            .context("falha ao ler plugin")
    }

    pub fn plugin_upsert(&self, plugin: &StoredPlugin) -> Result<()> {
        let conn = self.connection();
        conn.execute(
            "INSERT INTO plugins (id, version, api_version, root, enabled, trusted, source, \
             signature_status, publisher_id, publisher_name, key_id, key_fingerprint, \
             manifest_json, package_hash, installed_at, updated_at, last_used_at, auto_update, \
             previous_version, previous_root, disabled_reason, size_bytes) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
             ?18, ?19, ?20, ?21, ?22) \
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, \
             api_version = excluded.api_version, root = excluded.root, enabled = excluded.enabled, \
             trusted = excluded.trusted, source = excluded.source, \
             signature_status = excluded.signature_status, publisher_id = excluded.publisher_id, \
             publisher_name = excluded.publisher_name, key_id = excluded.key_id, \
             key_fingerprint = excluded.key_fingerprint, manifest_json = excluded.manifest_json, \
             package_hash = excluded.package_hash, updated_at = excluded.updated_at, \
             last_used_at = excluded.last_used_at, auto_update = excluded.auto_update, \
             previous_version = excluded.previous_version, previous_root = excluded.previous_root, \
             disabled_reason = excluded.disabled_reason, size_bytes = excluded.size_bytes",
            params![
                plugin.id,
                plugin.version,
                plugin.api_version as i64,
                plugin.root,
                plugin.enabled as i64,
                plugin.trusted as i64,
                plugin.source,
                plugin.signature_status,
                plugin.publisher_id,
                plugin.publisher_name,
                plugin.key_id,
                plugin.key_fingerprint,
                plugin.manifest_json,
                plugin.package_hash,
                plugin.installed_at,
                plugin.updated_at,
                plugin.last_used_at,
                plugin.auto_update as i64,
                plugin.previous_version,
                plugin.previous_root,
                plugin.disabled_reason,
                plugin.size_bytes,
            ],
        )
        .context("falha ao gravar plugin")?;
        Ok(())
    }

    pub fn plugin_delete(&self, id: &str) -> Result<()> {
        let mut conn = self.connection();
        let tx = conn.transaction()?;
        for table in [
            "plugin_permissions",
            "plugin_settings",
            "plugin_state",
            "plugin_logs",
            "plugin_audit",
            "plugin_tool_calls",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE plugin_id = ?1"), params![id])?;
        }
        tx.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn plugin_set_enabled(&self, id: &str, enabled: bool, reason: Option<&str>) -> Result<()> {
        self.connection()
            .execute(
                "UPDATE plugins SET enabled = ?2, disabled_reason = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, enabled as i64, reason, crate::domain::now_ms()],
            )
            .context("falha ao alterar estado do plugin")?;
        Ok(())
    }

    pub fn plugin_set_auto_update(&self, id: &str, enabled: bool) -> Result<()> {
        self.connection().execute(
            "UPDATE plugins SET auto_update = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, enabled as i64, crate::domain::now_ms()],
        )?;
        Ok(())
    }

    pub fn plugin_set_previous(&self, id: &str, version: Option<&str>, root: Option<&str>) -> Result<()> {
        self.connection().execute(
            "UPDATE plugins SET previous_version = ?2, previous_root = ?3 WHERE id = ?1",
            params![id, version, root],
        )?;
        Ok(())
    }

    pub fn plugin_touch(&self, id: &str) -> Result<()> {
        self.connection().execute(
            "UPDATE plugins SET last_used_at = ?2 WHERE id = ?1",
            params![id, crate::domain::now_ms()],
        )?;
        Ok(())
    }

    pub fn plugin_replace_permissions(
        &self,
        id: &str,
        grants: &BTreeMap<String, bool>,
    ) -> Result<()> {
        let mut conn = self.connection();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM plugin_permissions WHERE plugin_id = ?1",
            params![id],
        )?;
        let now = crate::domain::now_ms();
        for (permission, granted) in grants {
            tx.execute(
                "INSERT INTO plugin_permissions (plugin_id, permission, granted, granted_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, permission, *granted as i64, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Every declared permission with its grant state (missing row = denied).
    pub fn plugin_permissions(&self, id: &str) -> Result<BTreeMap<String, bool>> {
        let conn = self.connection();
        let mut statement =
            conn.prepare("SELECT permission, granted FROM plugin_permissions WHERE plugin_id = ?1")?;
        let rows = statement.query_map(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })?;
        let mut grants = BTreeMap::new();
        for row in rows {
            let (permission, granted) = row?;
            grants.insert(permission, granted);
        }
        Ok(grants)
    }

    pub fn plugin_granted_permissions(&self, id: &str) -> Result<Vec<String>> {
        Ok(self
            .plugin_permissions(id)?
            .into_iter()
            .filter(|(_, granted)| *granted)
            .map(|(permission, _)| permission)
            .collect())
    }

    pub fn plugin_setting_get(&self, id: &str, key: &str) -> Result<Option<String>> {
        self.connection()
            .query_row(
                "SELECT value_json FROM plugin_settings WHERE plugin_id = ?1 AND key = ?2",
                params![id, key],
                |row| row.get(0),
            )
            .optional()
            .context("failed to read plugin setting")
    }

    pub fn plugin_setting_set(&self, id: &str, key: &str, value: &str) -> Result<()> {
        self.connection().execute(
            "INSERT INTO plugin_settings (plugin_id, key, value_json) VALUES (?1, ?2, ?3) \
             ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json",
            params![id, key, value],
        )?;
        Ok(())
    }

    pub fn plugin_settings_all(&self, id: &str) -> Result<BTreeMap<String, String>> {
        let conn = self.connection();
        let mut statement =
            conn.prepare("SELECT key, value_json FROM plugin_settings WHERE plugin_id = ?1 ORDER BY key")?;
        let rows = statement.query_map(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut settings = BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            settings.insert(key, value);
        }
        Ok(settings)
    }

    pub fn plugin_state_get(&self, id: &str, key: &str) -> Result<Option<String>> {
        self.connection()
            .query_row(
                "SELECT value_json FROM plugin_state WHERE plugin_id = ?1 AND key = ?2",
                params![id, key],
                |row| row.get(0),
            )
            .optional()
            .context("falha ao ler estado do plugin")
    }

    pub fn plugin_state_set(&self, id: &str, key: &str, value: &str) -> Result<()> {
        self.connection().execute(
            "INSERT INTO plugin_state (plugin_id, key, value_json) VALUES (?1, ?2, ?3) \
             ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json",
            params![id, key, value],
        )?;
        Ok(())
    }

    pub fn plugin_state_delete(&self, id: &str, key: &str) -> Result<()> {
        self.connection().execute(
            "DELETE FROM plugin_state WHERE plugin_id = ?1 AND key = ?2",
            params![id, key],
        )?;
        Ok(())
    }

    pub fn plugin_state_all(&self, id: &str) -> Result<BTreeMap<String, String>> {
        let conn = self.connection();
        let mut statement =
            conn.prepare("SELECT key, value_json FROM plugin_state WHERE plugin_id = ?1 ORDER BY key")?;
        let rows = statement.query_map(params![id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut state = BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            state.insert(key, value);
        }
        Ok(state)
    }

    /// State bytes used by the quota check (keys + JSON values).
    pub fn plugin_state_bytes(&self, id: &str) -> Result<u64> {
        let state = self.plugin_state_all(id)?;
        Ok(state
            .iter()
            .map(|(key, value)| key.len() as u64 + value.len() as u64)
            .sum())
    }

    pub fn plugin_delete_state(&self, id: &str) -> Result<()> {
        self.connection()
            .execute("DELETE FROM plugin_state WHERE plugin_id = ?1", params![id])?;
        Ok(())
    }

    pub fn plugin_log(&self, id: &str, level: &str, message: &str) -> Result<i64> {
        let conn = self.connection();
        conn.execute(
            "INSERT INTO plugin_logs (plugin_id, level, message, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, level, message, crate::domain::now_ms()],
        )?;
        let row_id = conn.last_insert_rowid();
        // Keep the per-plugin log bounded; the UI also pages it.
        let limit = crate::plugins::contract::limits().log_bytes as i64 / 256;
        conn.execute(
            "DELETE FROM plugin_logs WHERE plugin_id = ?1 AND id NOT IN (\
             SELECT id FROM plugin_logs WHERE plugin_id = ?1 ORDER BY id DESC LIMIT ?2)",
            params![id, limit.max(64)],
        )?;
        Ok(row_id)
    }

    pub fn plugin_logs(&self, id: Option<&str>, limit: u32, before_id: Option<i64>) -> Result<Vec<PluginLogRow>> {
        let conn = self.connection();
        let limit = limit.clamp(1, 500) as i64;
        let before = before_id.unwrap_or(i64::MAX);
        let mut rows = Vec::new();
        match id {
            Some(id) => {
                let mut statement = conn.prepare(
                    "SELECT id, plugin_id, level, message, created_at FROM plugin_logs \
                     WHERE plugin_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3",
                )?;
                let mapped = statement.query_map(params![id, before, limit], log_row)?;
                for row in mapped {
                    rows.push(row?);
                }
            }
            None => {
                let mut statement = conn.prepare(
                    "SELECT id, plugin_id, level, message, created_at FROM plugin_logs \
                     WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
                )?;
                let mapped = statement.query_map(params![before, limit], log_row)?;
                for row in mapped {
                    rows.push(row?);
                }
            }
        }
        Ok(rows)
    }

    pub fn plugin_audit(
        &self,
        id: &str,
        capability: &str,
        params_digest: Option<&str>,
        decision: &str,
    ) -> Result<()> {
        self.connection().execute(
            "INSERT INTO plugin_audit (plugin_id, capability, params_digest, decision, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, capability, params_digest, decision, crate::domain::now_ms()],
        )?;
        Ok(())
    }

    pub fn plugin_audit_rows(&self, id: Option<&str>, limit: u32) -> Result<Vec<PluginAuditRow>> {
        let conn = self.connection();
        let limit = limit.clamp(1, 500) as i64;
        let mut rows = Vec::new();
        if let Some(id) = id {
            let mut statement = conn.prepare(
                "SELECT id, plugin_id, capability, params_digest, decision, created_at \
                 FROM plugin_audit WHERE plugin_id = ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            let mapped = statement.query_map(params![id, limit], audit_row)?;
            for row in mapped {
                rows.push(row?);
            }
        } else {
            let mut statement = conn.prepare(
                "SELECT id, plugin_id, capability, params_digest, decision, created_at \
                 FROM plugin_audit ORDER BY id DESC LIMIT ?1",
            )?;
            let mapped = statement.query_map(params![limit], audit_row)?;
            for row in mapped {
                rows.push(row?);
            }
        }
        Ok(rows)
    }

    pub fn plugin_record_tool_call(
        &self,
        id: &str,
        tool: &str,
        conversation_id: Option<&str>,
        turn_id: Option<&str>,
        status: &str,
        duration_ms: Option<i64>,
    ) -> Result<()> {
        self.connection().execute(
            "INSERT INTO plugin_tool_calls \
             (plugin_id, tool, conversation_id, turn_id, status, duration_ms, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                tool,
                conversation_id,
                turn_id,
                status,
                duration_ms,
                crate::domain::now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn plugin_tool_call_rows(&self, id: &str, limit: u32) -> Result<Vec<PluginToolCallRow>> {
        let conn = self.connection();
        let mut statement = conn.prepare(
            "SELECT id, plugin_id, tool, conversation_id, turn_id, status, duration_ms, created_at \
             FROM plugin_tool_calls WHERE plugin_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![id, limit.clamp(1, 500) as i64], |row| {
            Ok(PluginToolCallRow {
                id: row.get(0)?,
                plugin_id: row.get(1)?,
                tool: row.get(2)?,
                conversation_id: row.get(3)?,
                turn_id: row.get(4)?,
                status: row.get(5)?,
                duration_ms: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("falha ao listar chamadas de tool do plugin")
    }

    pub fn plugin_publisher_key(&self, publisher_id: &str, key_id: &str) -> Result<Option<PublisherKey>> {
        self.connection()
            .query_row(
                "SELECT publisher_id, key_id, public_key, fingerprint, trusted_at, revoked \
                 FROM plugin_publisher_keys WHERE publisher_id = ?1 AND key_id = ?2",
                params![publisher_id, key_id],
                |row| {
                    Ok(PublisherKey {
                        publisher_id: row.get(0)?,
                        key_id: row.get(1)?,
                        public_key: row.get(2)?,
                        fingerprint: row.get(3)?,
                        trusted_at: row.get(4)?,
                        revoked: row.get::<_, i64>(5)? != 0,
                    })
                },
            )
            .optional()
            .context("falha ao ler chave do publisher")
    }

    pub fn plugin_publisher_keys(&self, publisher_id: &str) -> Result<Vec<PublisherKey>> {
        let conn = self.connection();
        let mut statement = conn.prepare(
            "SELECT publisher_id, key_id, public_key, fingerprint, trusted_at, revoked \
             FROM plugin_publisher_keys WHERE publisher_id = ?1",
        )?;
        let rows = statement.query_map(params![publisher_id], |row| {
            Ok(PublisherKey {
                publisher_id: row.get(0)?,
                key_id: row.get(1)?,
                public_key: row.get(2)?,
                fingerprint: row.get(3)?,
                trusted_at: row.get(4)?,
                revoked: row.get::<_, i64>(5)? != 0,
            })
        })?;
        let mut keys = Vec::new();
        for row in rows {
            keys.push(row?);
        }
        Ok(keys)
    }

    pub fn plugin_pin_publisher(
        &self,
        publisher_id: &str,
        key_id: &str,
        public_key: &str,
        fingerprint: &str,
    ) -> Result<()> {
        let now = crate::domain::now_ms();
        let conn = self.connection();
        conn.execute(
            "INSERT INTO plugin_publisher_keys \
             (publisher_id, key_id, public_key, fingerprint, revoked, rotated_at, trusted_at) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5) \
             ON CONFLICT(publisher_id, key_id) DO NOTHING",
            params![publisher_id, key_id, public_key, fingerprint, now],
        )?;
        conn.execute(
            "INSERT INTO plugin_publishers (publisher_id, key_id, public_key, fingerprint, trusted_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(publisher_id, key_id) DO NOTHING",
            params![publisher_id, key_id, public_key, fingerprint, now],
        )?;
        Ok(())
    }

    pub fn plugin_revoke_publisher_key(&self, publisher_id: &str, key_id: &str) -> Result<()> {
        self.connection().execute(
            "UPDATE plugin_publisher_keys SET revoked = 1, rotated_at = ?3 \
             WHERE publisher_id = ?1 AND key_id = ?2",
            params![publisher_id, key_id, crate::domain::now_ms()],
        )?;
        Ok(())
    }

    /// Rotates a publisher key. Only the explicit user consent path calls this;
    /// it keeps the old key (revoked) for auditability.
    pub fn plugin_rotate_publisher_key(
        &self,
        publisher_id: &str,
        key_id: &str,
        public_key: &str,
        fingerprint: &str,
    ) -> Result<()> {
        let now = crate::domain::now_ms();
        let conn = self.connection();
        conn.execute(
            "UPDATE plugin_publisher_keys SET revoked = 1, rotated_at = ?2 WHERE publisher_id = ?1",
            params![publisher_id, now],
        )?;
        conn.execute(
            "INSERT INTO plugin_publisher_keys \
             (publisher_id, key_id, public_key, fingerprint, revoked, rotated_at) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5) \
             ON CONFLICT(publisher_id, key_id) DO UPDATE SET public_key = excluded.public_key, \
             fingerprint = excluded.fingerprint, revoked = 0, rotated_at = excluded.rotated_at",
            params![publisher_id, key_id, public_key, fingerprint, now],
        )?;
        conn.execute(
            "INSERT INTO plugin_publishers (publisher_id, key_id, public_key, fingerprint, trusted_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(publisher_id, key_id) DO UPDATE SET public_key = excluded.public_key, \
             fingerprint = excluded.fingerprint, trusted_at = excluded.trusted_at",
            params![publisher_id, key_id, public_key, fingerprint, now],
        )?;
        Ok(())
    }

    pub fn plugin_store_cache_get(&self, key: &str) -> Result<Option<(Option<String>, String, i64)>> {
        self.connection()
            .query_row(
                "SELECT etag, body, fetched_at FROM plugin_store_cache WHERE key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .context("falha ao ler cache da loja de plugins")
    }

    pub fn plugin_store_cache_set(&self, key: &str, etag: Option<&str>, body: &str) -> Result<()> {
        self.connection().execute(
            "INSERT INTO plugin_store_cache (key, etag, body, fetched_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, body = excluded.body, \
             fetched_at = excluded.fetched_at",
            params![key, etag, body, crate::domain::now_ms()],
        )?;
        Ok(())
    }

    pub fn plugin_cache_fingerprint(&self, conversation_id: &str) -> Result<Option<String>> {
        self.connection()
            .query_row(
                "SELECT fingerprint FROM plugin_cache_state WHERE conversation_id = ?1",
                params![conversation_id],
                |row| row.get(0),
            )
            .optional()
            .context("falha ao ler fingerprint de plugins da conversa")
    }

    pub fn plugin_set_cache_fingerprint(&self, conversation_id: &str, fingerprint: &str) -> Result<()> {
        self.connection().execute(
            "INSERT INTO plugin_cache_state (conversation_id, fingerprint, updated_at) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(conversation_id) DO UPDATE SET fingerprint = excluded.fingerprint, \
             updated_at = excluded.updated_at",
            params![conversation_id, fingerprint, crate::domain::now_ms()],
        )?;
        Ok(())
    }
}

fn log_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginLogRow> {
    Ok(PluginLogRow {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        level: row.get(2)?,
        message: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn audit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginAuditRow> {
    Ok(PluginAuditRow {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        capability: row.get(2)?,
        params_digest: row.get(3)?,
        decision: row.get(4)?,
        created_at: row.get(5)?,
    })
}
