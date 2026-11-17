//! Mediated RPC surface for sandboxed/trusted plugins.
//!
//! Every method checks a persisted grant. Secrets are never returned to the
//! plugin; `net.request` can inject one into an outgoing header. Network access
//! is allowlisted, HTTPS-only, redirect-revalidated and blocks loopback/private
//! targets (including DNS answers).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tauri_plugin_opener::OpenerExt;

use super::contract;
use super::permissions::{self, ERR_PERMISSION_DENIED};
use super::PluginManager;

const MAX_SETTINGS_JSON: usize = 256 * 1024;
const MAX_NET_REDIRECTS: usize = 3;

fn params_size(params: &Value) -> Option<usize> {
    serde_json::to_vec(params).ok().map(|bytes| bytes.len())
}

impl PluginManager {
    pub async fn rpc(&self, plugin_id: &str, method: &str, params: Value) -> Result<Value> {
        let Some(record) = self.record(plugin_id) else {
            bail!("PLUGIN_NOT_FOUND: `{plugin_id}` is not installed");
        };
        if !record.active {
            bail!("PLUGIN_NOT_ACTIVE: `{plugin_id}` is not enabled");
        }
        if params_size(&params).unwrap_or(0) > contract::limits().rpc_bytes as usize {
            bail!("PLUGIN_RPC_TOO_LARGE: params exceed the RPC limit");
        }
        let grants = self
            .db()
            .plugin_granted_permissions(plugin_id)
            .context("cannot read plugin permissions")?;
        let result = match method {
            "ping" => Ok(json!({ "ok": true, "pluginId": plugin_id })),
            "storage.get" => self.storage_get(plugin_id, &grants, &params),
            "storage.set" => self.storage_set(plugin_id, &grants, &params),
            "storage.remove" => self.storage_remove(plugin_id, &grants, &params),
            "storage.list" => self.storage_list(plugin_id, &grants),
            "settings.get" => self.settings_get(plugin_id, &grants, &params),
            "settings.set" => self.settings_set(plugin_id, &grants, &params),
            "settings.all" => self.settings_all(plugin_id, &grants),
            "secrets.has" => self.secrets_has(plugin_id, &grants, &params),
            "secrets.names" => self.secrets_names(plugin_id, &grants),
            "secrets.read" => self.secrets_read(plugin_id, &grants, &params),
            "net.request" => self.net_request(plugin_id, &grants, &params).await,
            "chat.read" => self.chat_read(plugin_id, &grants, &params),
            "chat.draft" => self.chat_draft_rpc(plugin_id, &grants, &params),
            "chat.list" => self.chat_list(plugin_id, &grants),
            "log" => self.log_rpc(plugin_id, &params),
            "notify" => self.notify_rpc(plugin_id, &grants, &params),
            "opener.open" => self.opener_open(plugin_id, &grants, &params),
            "clipboard.read" => self.clipboard_read(plugin_id, &grants).await,
            "fs.read" => self.fs_read(plugin_id, &grants, &params),
            "fs.write" => self.fs_write(plugin_id, &grants, &params),
            "fs.list" => self.fs_list(plugin_id, &grants, &params),
            other => bail!("PLUGIN_RPC_UNKNOWN: unknown method `{other}`"),
        };
        let decision = if result.is_ok() { "allowed" } else { "error" };
        let _ = self.db().plugin_audit(
            plugin_id,
            method,
            Some(&super::params_digest(&params)),
            decision,
        );
        result
    }

    fn storage_key(params: &Value) -> Result<String> {
        let key = params
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if key.is_empty() || key.chars().count() > 200 || key.contains(['/', '\\', '\0']) {
            bail!("PLUGIN_RPC_INVALID: invalid storage key");
        }
        Ok(key.to_string())
    }

    fn storage_get(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "storage")?;
        let key = Self::storage_key(params)?;
        let value = self.db().plugin_state_get(plugin_id, &key)?;
        let value = value
            .map(|raw| serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        Ok(json!({ "value": value }))
    }

    fn storage_set(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "storage")?;
        let key = Self::storage_key(params)?;
        let value = params.get("value").cloned().unwrap_or(Value::Null);
        let raw = serde_json::to_string(&value)?;
        let current = self.db().plugin_state_bytes(plugin_id).unwrap_or(0);
        let previous = self
            .db()
            .plugin_state_get(plugin_id, &key)?
            .map(|raw| raw.len() as u64)
            .unwrap_or(0);
        let next = current.saturating_sub(previous).saturating_add(raw.len() as u64);
        if next > contract::limits().kv_bytes {
            bail!("PLUGIN_QUOTA_KV: plugin storage exceeds the 5 MiB limit");
        }
        self.db().plugin_state_set(plugin_id, &key, &raw)?;
        Ok(json!({ "ok": true }))
    }

    fn storage_remove(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "storage")?;
        let key = Self::storage_key(params)?;
        self.db().plugin_state_delete(plugin_id, &key)?;
        Ok(json!({ "ok": true }))
    }

    fn storage_list(&self, plugin_id: &str, grants: &[String]) -> Result<Value> {
        permissions::require(grants, "storage")?;
        let keys = self
            .db()
            .plugin_state_all(plugin_id)?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        Ok(json!({ "keys": keys }))
    }

    fn settings_key(params: &Value) -> Result<String> {
        let key = params
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if key.is_empty()
            || key.chars().count() > 120
            || !key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        {
            bail!("PLUGIN_RPC_INVALID: invalid settings key");
        }
        Ok(key.to_string())
    }

    fn settings_get(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require_any(grants, &["settings", "storage"])?;
        let key = Self::settings_key(params)?;
        let value = self
            .db()
            .plugin_setting_get(plugin_id, &key)?
            .map(|raw| serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        Ok(json!({ "value": value }))
    }

    fn settings_set(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "settings")?;
        let key = Self::settings_key(params)?;
        let value = params.get("value").cloned().unwrap_or(Value::Null);
        let raw = serde_json::to_string(&value)?;
        if raw.len() > MAX_SETTINGS_JSON {
            bail!("PLUGIN_QUOTA_SETTINGS: setting exceeds 256 KiB");
        }
        self.db().plugin_setting_set(plugin_id, &key, &raw)?;
        Ok(json!({ "ok": true }))
    }

    fn settings_all(&self, plugin_id: &str, grants: &[String]) -> Result<Value> {
        permissions::require_any(grants, &["settings", "storage"])?;
        let mut values = serde_json::Map::new();
        for (key, raw) in self.db().plugin_settings_all(plugin_id)? {
            values.insert(
                key,
                serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
            );
        }
        Ok(Value::Object(values))
    }

    fn secrets_has(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "secrets.use")?;
        let key = Self::settings_key(params)?;
        let app = self
            .app()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RUNTIME_UNAVAILABLE: no app handle"))?;
        Ok(json!({
            "has": crate::config::plugin_secret(app, plugin_id, &key).is_some()
        }))
    }

    fn secrets_names(&self, plugin_id: &str, grants: &[String]) -> Result<Value> {
        permissions::require(grants, "secrets.use")?;
        let app = self
            .app()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RUNTIME_UNAVAILABLE: no app handle"))?;
        Ok(json!({ "names": crate::config::plugin_secret_names(app, plugin_id) }))
    }

    /// Returns the secret value. Trusted-only (`secrets.read`); every call is
    /// audited by the dispatcher with a params digest that never contains the
    /// value.
    fn secrets_read(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "secrets.read")?;
        let key = Self::settings_key(params)?;
        let app = self
            .app()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RUNTIME_UNAVAILABLE: no app handle"))?;
        Ok(json!({
            "value": crate::config::plugin_secret(app, plugin_id, &key)
        }))
    }

    /// Inserts text into the composer draft of the active conversation. The
    /// renderer listens for `zylara:plugin-composer-draft` and routes it through
    /// the same composer path as the declarative `insertDraft` action.
    fn chat_draft_rpc(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "chat.write")?;
        let text: String = params
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(20_000)
            .collect();
        if text.trim().is_empty() {
            bail!("PLUGIN_RPC_INVALID: draft text is required");
        }
        let mode = params
            .get("mode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "append" | "replace" | "prepend"))
            .unwrap_or("append")
            .to_string();
        let conversation_id = params
            .get("conversationId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(app) = self.app() {
            use tauri::Emitter;
            let _ = app.emit(
                "zylara:plugin-composer-draft",
                json!({
                    "pluginId": plugin_id,
                    "conversationId": conversation_id,
                    "text": text,
                    "mode": mode,
                }),
            );
        }
        Ok(json!({ "ok": true }))
    }

    fn log_rpc(&self, plugin_id: &str, params: &Value) -> Result<Value> {
        let level = params
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("info");
        let message = params
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        self.log_from_plugin(plugin_id, level, message)?;
        Ok(json!({ "ok": true }))
    }

    fn notify_rpc(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "notifications")?;
        let title = params
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect::<String>();
        let body = params
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(1_000)
            .collect::<String>();
        if title.trim().is_empty() {
            bail!("PLUGIN_RPC_INVALID: notification title is required");
        }
        if let Some(app) = self.app() {
            use tauri::Emitter;
            let _ = app.emit(
                "zylara:plugin-notification",
                json!({ "pluginId": plugin_id, "title": title, "body": body }),
            );
        }
        Ok(json!({ "ok": true }))
    }

    fn opener_open(&self, plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "opener")?;
        let raw = params
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let url = url::Url::parse(raw).context("invalid URL")?;
        if !matches!(url.scheme(), "https" | "http") {
            bail!("PLUGIN_OPENER_BLOCKED: only http(s) links can be opened");
        }
        let app = self
            .app()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RUNTIME_UNAVAILABLE: no app handle"))?;
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .context("cannot open link")?;
        let _ = self.db().plugin_audit(plugin_id, "opener", None, "opened");
        Ok(json!({ "ok": true }))
    }

    async fn clipboard_read(&self, _plugin_id: &str, grants: &[String]) -> Result<Value> {
        permissions::require(grants, "clipboard.read")?;
        let text = tauri::async_runtime::spawn_blocking(|| {
            arboard::Clipboard::new()
                .ok()
                .and_then(|mut clipboard| clipboard.get_text().ok())
                .unwrap_or_default()
        })
        .await
        .unwrap_or_default();
        Ok(json!({ "text": text.chars().take(200_000).collect::<String>() }))
    }

    fn chat_read(&self, _plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        permissions::require(grants, "chat.read")?;
        let conversation_id = params
            .get("conversationId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if conversation_id.is_empty() {
            bail!("PLUGIN_RPC_INVALID: conversationId is required");
        }
        let Some(detail) = self.db().get_conversation_detail(conversation_id)? else {
            bail!("PLUGIN_RPC_NOT_FOUND: conversation not found");
        };
        let messages: Vec<Value> = detail
            .messages
            .iter()
            .rev()
            .take(100)
            .rev()
            .map(|message| {
                json!({
                    "id": message.id,
                    "role": message.role,
                    "content": message.content.chars().take(20_000).collect::<String>(),
                    "createdAt": message.created_at,
                    "toolCalls": message.tool_calls.iter().map(|call| json!({
                        "name": call.name,
                        "status": call.status,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        Ok(json!({
            "conversation": {
                "id": detail.conversation.id,
                "title": detail.conversation.title,
                "mode": detail.conversation.mode,
                "providerId": detail.conversation.provider_id,
                "modelId": detail.conversation.model_id,
            },
            "messages": messages,
        }))
    }

    fn chat_list(&self, _plugin_id: &str, grants: &[String]) -> Result<Value> {
        permissions::require(grants, "chat.read")?;
        let conversations = self
            .db()
            .list_conversations()?
            .into_iter()
            .take(200)
            .map(|conversation| {
                json!({
                    "id": conversation.id,
                    "title": conversation.title,
                    "mode": conversation.mode,
                    "updatedAt": conversation.updated_at,
                    "messageCount": conversation.message_count,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "conversations": conversations }))
    }

    async fn net_request(
        &self,
        plugin_id: &str,
        grants: &[String],
        params: &Value,
    ) -> Result<Value> {
        if !grants.iter().any(|grant| grant.starts_with("net:")) {
            bail!("{ERR_PERMISSION_DENIED}: no `net:` grant");
        }
        let url = params
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RPC_INVALID: url is required"))?;
        let method = params
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("GET")
            .to_ascii_uppercase();
        if !matches!(
            method.as_str(),
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
        ) {
            bail!("PLUGIN_NET_BLOCKED: method `{method}` is not allowed");
        }
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(header_object) = params.get("headers").and_then(Value::as_object) {
            for (name, value) in header_object {
                let Some(value) = value.as_str() else {
                    continue;
                };
                let lowercase = name.to_ascii_lowercase();
                if matches!(
                    lowercase.as_str(),
                    "host" | "content-length" | "connection" | "transfer-encoding" | "cookie"
                ) {
                    bail!("PLUGIN_NET_BLOCKED: header `{name}` is reserved");
                }
                if value.len() > 4_000 || name.len() > 120 {
                    bail!("PLUGIN_NET_BLOCKED: header exceeds the size limit");
                }
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .context("invalid header name")?;
                let value = reqwest::header::HeaderValue::from_str(value)
                    .context("invalid header value")?;
                headers.insert(name, value);
            }
        }
        if let Some(secret) = params.get("secret") {
            permissions::require(grants, "secrets.use")?;
            let name = secret
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("PLUGIN_RPC_INVALID: secret.name"))?;
            let header = secret
                .get("header")
                .and_then(Value::as_str)
                .unwrap_or("Authorization");
            if matches!(
                header.to_ascii_lowercase().as_str(),
                "host" | "content-length" | "connection" | "transfer-encoding" | "cookie"
            ) {
                bail!("PLUGIN_NET_BLOCKED: secret header `{header}` is reserved");
            }
            let prefix = secret.get("prefix").and_then(Value::as_str).unwrap_or("");
            let app = self
                .app()
                .ok_or_else(|| anyhow::anyhow!("PLUGIN_RUNTIME_UNAVAILABLE: no app handle"))?;
            let value = crate::config::plugin_secret(app, plugin_id, name)
                .ok_or_else(|| anyhow::anyhow!("PLUGIN_SECRET_MISSING: `{name}` is not configured"))?;
            let header = reqwest::header::HeaderName::from_bytes(header.as_bytes())
                .context("invalid secret header")?;
            let value = reqwest::header::HeaderValue::from_str(&format!("{prefix}{value}"))
                .context("invalid secret value")?;
            headers.insert(header, value);
        }
        let body = params
            .get("body")
            .and_then(Value::as_str)
            .map(str::to_string);
        if body.as_ref().is_some_and(|body| body.len() > 2 * 1024 * 1024) {
            bail!("PLUGIN_NET_BLOCKED: request body exceeds 2 MiB");
        }
        let timeout = params
            .get("timeoutSecs")
            .and_then(Value::as_u64)
            .unwrap_or(30)
            .clamp(1, 120);
        let mut current = url::Url::parse(url).context("invalid URL")?;
        let mut response_body = Vec::new();
        let mut response_truncated = false;
        let mut status = 0u16;
        let mut response_headers = serde_json::Map::new();
        let mut final_url = current.to_string();
        for redirect in 0..=MAX_NET_REDIRECTS {
            self.validate_net_url(&current, grants)?;
            let host = current
                .host_str()
                .ok_or_else(|| anyhow::anyhow!("PLUGIN_NET_BLOCKED: URL has no host"))?
                .to_string();
            let port = current.port_or_known_default().unwrap_or(443);
            let addresses = tokio::net::lookup_host((host.as_str(), port))
                .await
                .context("cannot resolve host")?
                .collect::<Vec<_>>();
            if addresses.is_empty() {
                bail!("PLUGIN_NET_BLOCKED: host did not resolve");
            }
            for address in &addresses {
                if is_forbidden_ip(address.ip()) {
                    bail!("PLUGIN_NET_BLOCKED: private/loopback target");
                }
            }
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(timeout))
                .user_agent(format!("Zylara/{}", env!("CARGO_PKG_VERSION")));
            for address in &addresses {
                builder = builder.resolve(&host, *address);
            }
            let client = builder.build().context("cannot build HTTP client")?;
            let request = client
                .request(
                    reqwest::Method::from_bytes(method.as_bytes()).context("invalid method")?,
                    current.clone(),
                )
                .headers(headers.clone());
            let request = if let Some(body) = &body {
                request.body(body.clone())
            } else {
                request
            };
            let response = request.send().await.context("network request failed")?;
            status = response.status().as_u16();
            final_url = response.url().to_string();
            response_headers.clear();
            for (name, value) in response.headers() {
                let name = name.as_str().to_ascii_lowercase();
                if matches!(name.as_str(), "set-cookie" | "authorization" | "www-authenticate") {
                    continue;
                }
                if let Ok(value) = value.to_str() {
                    response_headers.insert(name, Value::String(value.chars().take(1_000).collect()));
                }
            }
            if matches!(status, 301 | 302 | 303 | 307 | 308) && redirect < MAX_NET_REDIRECTS {
                let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
                    break;
                };
                let location = location.to_str().context("invalid redirect")?;
                let next = current.join(location).context("invalid redirect URL")?;
                let carries_credentials = params.get("secret").is_some()
                    || headers.contains_key(reqwest::header::AUTHORIZATION)
                    || headers.contains_key(reqwest::header::PROXY_AUTHORIZATION);
                if carries_credentials && next.host_str() != current.host_str() {
                    bail!("PLUGIN_NET_BLOCKED: redirect would forward credentials to another host");
                }
                current = next;
                continue;
            }
            let mut response = response;
            let limit = contract::limits().network_bytes as usize;
            while let Some(chunk) = response.chunk().await.context("network stream failed")? {
                if response_body.len() + chunk.len() > limit {
                    response_body.extend_from_slice(&chunk[..limit.saturating_sub(response_body.len())]);
                    response_truncated = true;
                    break;
                }
                response_body.extend_from_slice(&chunk);
            }
            break;
        }
        let text = String::from_utf8_lossy(&response_body).to_string();
        Ok(json!({
            "status": status,
            "url": final_url,
            "headers": response_headers,
            "body": text,
            "truncated": response_truncated,
        }))
    }

    fn validate_net_url(&self, url: &url::Url, grants: &[String]) -> Result<()> {
        let scheme_allowed = match url.scheme() {
            "https" => true,
            "http" => self.options().dev_mode,
            _ => false,
        };
        if !scheme_allowed {
            bail!("PLUGIN_NET_BLOCKED: only HTTPS is allowed");
        }
        if !url.username().is_empty() || url.password().is_some() {
            bail!("PLUGIN_NET_BLOCKED: URL credentials are not allowed");
        }
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_NET_BLOCKED: URL has no host"))?
            .to_ascii_lowercase();
        if matches!(
            host.as_str(),
            "localhost" | "metadata.google.internal" | "metadata" | "instance-data"
        ) || host.ends_with(".local")
            || host.ends_with(".internal")
        {
            bail!("PLUGIN_NET_BLOCKED: local/private host");
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            if is_forbidden_ip(ip) {
                bail!("PLUGIN_NET_BLOCKED: private/loopback target");
            }
        }
        if !permissions::net_host_allowed(grants, &host) {
            bail!("{ERR_PERMISSION_DENIED}: no `net:{host}` grant");
        }
        Ok(())
    }
    fn fs_path(params: &Value) -> Result<std::path::PathBuf> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if path.is_empty() || path.contains('\0') {
            bail!("PLUGIN_RPC_INVALID: path is required");
        }
        let path = std::path::PathBuf::from(path);
        if !path.is_absolute() {
            bail!("PLUGIN_RPC_INVALID: filesystem paths must be absolute");
        }
        Ok(path)
    }

    fn fs_read(&self, _plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        let requested = Self::fs_path(params)?;
        let path = std::fs::canonicalize(&requested)
            .with_context(|| format!("cannot resolve {}", requested.display()))?;
        if !permissions::fs_path_allowed(grants, "fs.read", &path) {
            bail!("{ERR_PERMISSION_DENIED}: no `fs.read` grant matches the path");
        }
        let metadata = std::fs::metadata(&path)?;
        if !metadata.is_file() {
            bail!("PLUGIN_RPC_INVALID: path is not a file");
        }
        if metadata.len() > 10 * 1024 * 1024 {
            bail!("PLUGIN_QUOTA_FS: file exceeds 10 MiB");
        }
        let bytes = std::fs::read(&path)?;
        let (content, base64) = match String::from_utf8(bytes.clone()) {
            Ok(text) => (text, None),
            Err(_) => {
                use base64::Engine as _;
                (
                    String::new(),
                    Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
                )
            }
        };
        Ok(json!({
            "path": path.to_string_lossy(),
            "content": content,
            "base64": base64,
            "size": metadata.len(),
        }))
    }

    fn fs_write(&self, _plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        let requested = Self::fs_path(params)?;
        let parent = requested
            .parent()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RPC_INVALID: path has no parent"))?;
        let parent = std::fs::canonicalize(parent)
            .with_context(|| format!("cannot resolve {}", parent.display()))?;
        let name = requested
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RPC_INVALID: path has no file name"))?;
        let path = parent.join(name);
        if !permissions::fs_path_allowed(grants, "fs.write", &path) {
            bail!("{ERR_PERMISSION_DENIED}: no `fs.write` grant matches the path");
        }
        if std::fs::symlink_metadata(&path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            bail!("PLUGIN_RPC_INVALID: refusing to write through a symlink");
        }
        let content = params
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("PLUGIN_RPC_INVALID: content is required"))?;
        if content.len() > 2 * 1024 * 1024 {
            bail!("PLUGIN_QUOTA_FS: write exceeds 2 MiB");
        }
        std::fs::write(&path, content)
            .with_context(|| format!("cannot write {}", path.display()))?;
        Ok(json!({ "path": path.to_string_lossy(), "bytes": content.len() }))
    }

    fn fs_list(&self, _plugin_id: &str, grants: &[String], params: &Value) -> Result<Value> {
        let requested = Self::fs_path(params)?;
        let path = std::fs::canonicalize(&requested)
            .with_context(|| format!("cannot resolve {}", requested.display()))?;
        if !permissions::fs_path_allowed(grants, "fs.read", &path) {
            bail!("{ERR_PERMISSION_DENIED}: no `fs.read` grant matches the path");
        }
        if !path.is_dir() {
            bail!("PLUGIN_RPC_INVALID: path is not a directory");
        }
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(&path)?.flatten().take(500) {
            let metadata = entry.metadata().ok();
            entries.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "directory": metadata.as_ref().is_some_and(|metadata| metadata.is_dir()),
                "size": metadata.map(|metadata| metadata.len()).unwrap_or(0),
            }));
        }
        entries.sort_by(|left, right| {
            left["name"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["name"].as_str().unwrap_or_default())
        });
        Ok(json!({ "path": path.to_string_lossy(), "entries": entries }))
    }
}

fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                || ip == Ipv4Addr::new(169, 254, 169, 254)
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip == Ipv6Addr::LOCALHOST
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses_are_rejected() {
        for raw in ["127.0.0.1", "10.0.0.2", "192.168.1.2", "169.254.1.1", "0.0.0.0", "::1"] {
            assert!(is_forbidden_ip(raw.parse().unwrap()), "{raw}");
        }
        assert!(!is_forbidden_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn params_size_counts_serialized_bytes() {
        assert!(params_size(&json!({"a": "b"})).unwrap() > 0);
    }
}
