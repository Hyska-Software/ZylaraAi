//! `zplugin://` asset protocol and the sandboxed iframe SDK.
//!
//! Assets are served only for active plugins, only from the current version
//! root, and never with directory listing. HTML gets a restrictive CSP; the SDK
//! is a virtual asset (`/@zylara/sdk.js`) so plugins ship no host code.

use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};

use super::PluginManager;

pub const PROTOCOL: &str = "zplugin";

pub fn asset_url(plugin_id: &str, path: &str) -> String {
    let path = path.trim_start_matches('/');
    #[cfg(windows)]
    {
        format!("http://zplugin.localhost/{plugin_id}/{path}")
    }
    #[cfg(not(windows))]
    {
        format!("zplugin://localhost/{plugin_id}/{path}")
    }
}

pub fn sdk_url() -> String {
    #[cfg(windows)]
    {
        "http://zplugin.localhost/@zylara/sdk.js".to_string()
    }
    #[cfg(not(windows))]
    {
        "zplugin://localhost/@zylara/sdk.js".to_string()
    }
}

pub fn handle(manager: &PluginManager, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let decoded = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8_lossy()
        .trim_start_matches('/')
        .to_string();
    let path = decoded.as_str();
    if path == "@zylara/sdk.js" {
        return text_response("application/javascript", sdk_js(), false);
    }
    let (plugin_id, relative) = match path.split_once('/') {
        Some((plugin_id, relative)) => (plugin_id, relative),
        None => return error_response(StatusCode::NOT_FOUND, "missing plugin id"),
    };
    let Some(path) = manager.asset_path(plugin_id, relative) else {
        return error_response(StatusCode::NOT_FOUND, "asset not found");
    };
    serve_file(&path, request)
}

fn serve_file(path: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Ok(bytes) = std::fs::read(path) else {
        return error_response(StatusCode::NOT_FOUND, "asset not readable");
    };
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let is_html = mime == "text/html";
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, bytes.len()));
    let (status, body, content_range) = match range {
        Some((start, end)) => (
            StatusCode::PARTIAL_CONTENT,
            bytes[start..=end].to_vec(),
            Some(format!("bytes {start}-{end}/{}", bytes.len())),
        ),
        None => (StatusCode::OK, bytes, None),
    };
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header("cross-origin-resource-policy", "same-origin");
    if is_html {
        builder = builder.header(
            "content-security-policy",
            "default-src 'none'; script-src 'self' 'unsafe-inline'; \
             style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
             font-src 'self' data:; media-src 'self' data:; \
             connect-src 'none'; frame-src 'none'; form-action 'none'; \
             base-uri 'none'; object-src 'none'",
        );
    }
    if let Some(content_range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

fn parse_range(value: &str, len: usize) -> Option<(usize, usize)> {
    let value = value.trim().strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    let start: usize = start.trim().parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if end.trim().is_empty() {
        len - 1
    } else {
        end.trim().parse::<usize>().ok()?.min(len - 1)
    };
    (end >= start).then_some((start, end))
}

fn text_response(content_type: &str, body: &str, html: bool) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff");
    if html {
        builder = builder.header(
            "content-security-policy",
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        );
    }
    builder
        .body(body.as_bytes().to_vec())
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Host-side SDK injected into sandboxed plugin documents.
///
/// The iframe is `sandbox="allow-scripts"` without `allow-same-origin`, so the
/// only channel is `postMessage`. The host validates the source window and the
/// per-frame nonce before accepting any message.
pub fn sdk_js() -> &'static str {
    r#"
(() => {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const nonce = params.get('zylaraNonce') || '';
  const token = `zylara-plugin-${nonce || Math.random().toString(36).slice(2)}`;
  const pluginId = params.get('zylaraPlugin') || '';
  const listeners = new Map();
  const pending = new Map();
  const hostPending = new Map();
  const toolHandlers = [];
  const genuiHandlers = [];
  let init = null;
  let seq = 0;

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(`zylara:${name}`, { detail }));
    const callbacks = listeners.get(name) || [];
    for (const callback of callbacks.slice()) {
      try { callback(detail); } catch (error) { console.error(error); }
    }
  }
  function on(event, handler) {
    const list = listeners.get(event) || [];
    list.push(handler);
    listeners.set(event, list);
    return () => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }
  function post(message) {
    parent.postMessage({ ...message, token }, '*');
  }
  function rpc(method, params = {}) {
    const id = `rpc-${Date.now()}-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ type: 'rpc', id, method, params });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('PLUGIN_RPC_TIMEOUT'));
        }
      }, 120000);
    });
  }
  function hostAction(action, params = {}) {
    const id = `action-${Date.now()}-${++seq}`;
    return new Promise((resolve, reject) => {
      hostPending.set(id, { resolve, reject });
      post({ type: 'host-action', id, action, params });
      setTimeout(() => {
        if (hostPending.has(id)) {
          hostPending.delete(id);
          reject(new Error('PLUGIN_HOST_ACTION_TIMEOUT'));
        }
      }, 30000);
    });
  }
  function applyTheme(theme) {
    if (!theme) return;
    if (theme.tokens) {
      for (const [name, value] of Object.entries(theme.tokens)) {
        if (typeof name === 'string' && name.startsWith('--') && typeof value === 'string') {
          root.style.setProperty(name, value);
        }
      }
    }
    if (theme.locale) root.lang = theme.locale;
    if (theme.dark) root.dataset.theme = 'dark';
    else root.dataset.theme = 'light';
    if (theme.reduceMotion) root.dataset.reduceMotion = 'true';
  }
  function handleTool(message) {
    const { callId, tool, arguments: args } = message;
    const handler = toolHandlers[toolHandlers.length - 1];
    Promise.resolve()
      .then(() => (handler ? handler({ tool, arguments: args, pluginId }) : Promise.reject(new Error(`no tool handler for ${tool}`))))
      .then((result) => {
        if (typeof result === 'string') return { content: result };
        return result || { content: '' };
      })
      .then((result) => post({ type: 'tool-result', callId, result }))
      .catch((error) => post({ type: 'tool-result', callId, result: {
        content: String(error && error.message ? error.message : error),
        isError: true,
      }}));
  }
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.token !== token) return;
    if (data.type === 'init') {
      init = data;
      applyTheme(data.theme);
      emit('init', data);
    } else if (data.type === 'theme') {
      applyTheme(data.theme);
      emit('theme', data.theme);
    } else if (data.type === 'context') {
      if (init) init.context = data.context || {};
      emit('context', data.context || {});
    } else if (data.type === 'host-action-result') {
      const entry = hostPending.get(data.id);
      if (!entry) return;
      hostPending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    } else if (data.type === 'genui-props') {
      for (const handler of genuiHandlers.slice()) {
        try { handler(data.props || {}); } catch (error) { console.error(error); }
      }
    } else if (data.type === 'rpc-result') {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    } else if (data.type === 'tool') {
      handleTool(data);
    } else if (data.type === 'event') {
      emit(data.name, data.detail);
    }
  });

  const api = {
    get pluginId() { return (init && init.pluginId) || pluginId; },
    get locale() { return (init && init.locale) || 'en'; },
    get context() { return (init && init.context) || {}; },
    get theme() { return (init && init.theme) || {}; },
    rpc,
    on,
    onEvent(name, handler) { return on(name, handler); },
    onTool(handler) { toolHandlers.push(handler); },
    onGenui(handler) { genuiHandlers.push(handler); },
    ui: {
      openPage(pageId, options = {}) {
        return hostAction('openPage', { page: String(pageId), layout: options.layout || null });
      },
      openPanelTab(tabId, options = {}) {
        return hostAction('openPanelTab', { tab: String(tabId), layout: options.layout || null });
      },
      closePanelTab() { return hostAction('closePanelTab', {}); },
      setLayout(layout) { return hostAction('setLayout', { layout: String(layout) }); },
      openSettings(tab) { return hostAction('openSettings', { tab: tab ? String(tab) : null }); },
      toast(title, body) { return hostAction('toast', { title: String(title), body: String(body || '') }); },
      setBadge(navId, badge) { return hostAction('setBadge', { id: String(navId), badge }); },
    },
    t(key, fallback) {
      const bundle = (init && init.localeBundle) || {};
      const value = key.split('.').reduce((current, part) => (current && typeof current === 'object' ? current[part] : undefined), bundle);
      return typeof value === 'string' ? value : fallback ?? key;
    },
    notify(message) { return rpc('notify', { title: String(message) }); },
    resize() {
      post({ type: 'resize', height: Math.min(1200, Math.max(1, document.documentElement.scrollHeight)) });
    },
    openView(viewId) { return hostAction('openPage', { page: String(viewId), layout: null }); },
    openPanel(panelId) { return hostAction('openPanelTab', { tab: String(panelId), layout: null }); },
    closeOverlays() { return hostAction('closePanelTab', {}); },
    openExternal(url) { return rpc('opener.open', { url }); },
    ready() { post({ type: 'ready' }); },
  };
  Object.defineProperty(window, 'ZylaraPlugin', { value: api, configurable: false, writable: false });
  window.addEventListener('load', () => { api.resize(); api.ready(); });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    api.resize();
    api.ready();
  }
  new ResizeObserver(() => api.resize()).observe(document.body);
})();
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parser_is_bounded() {
        assert_eq!(parse_range("bytes=0-3", 10), Some((0, 3)));
        assert_eq!(parse_range("bytes=5-", 10), Some((5, 9)));
        assert_eq!(parse_range("bytes=9-99", 10), Some((9, 9)));
        assert_eq!(parse_range("bytes=10-12", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }

    #[test]
    fn sdk_exposes_the_bridge_without_host_internals() {
        let sdk = sdk_js();
        assert!(sdk.contains("'ZylaraPlugin'"));
        assert!(sdk.contains("event.source !== parent"));
        assert!(sdk.contains("PLUGIN_RPC_TIMEOUT"));
        assert!(sdk.contains("onEvent"));
        assert!(sdk.contains("onGenui"));
        assert!(sdk.contains("host-action"));
        assert!(sdk.contains("openPage"));
        assert!(!sdk.contains("__TAURI__"));
    }
}
