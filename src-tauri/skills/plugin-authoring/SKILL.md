---
name: plugin-authoring
description: Author, modify, debug, validate, package and install any Zylara plugin (.zplugin) from Chat without a workspace or from any Code workspace. Self-contained workflow for declarative, sandboxed and trusted plugins; routes to the complete manifest, UI, GenUI, agent, trusted and packaging references.
---

# Authoring Zylara plugins

`/creator` enables **Plugin Creator mode**. The mode is conversation-scoped and
works in Chat (no workspace) and in Code (any workspace). The companion skills
contain the complete contract; do not read application docs, repository
fixtures, contract JSON files or repository scripts. If an id or field is
rejected, reload the relevant companion skill and use `plugin_studio validate`.

## Read first

1. Read this skill.
2. Read `plugin-manifest` **always** before writing `manifest.json`.
3. Read the companion skills required by the table below.
4. Read `plugin-package` before `validate`, `pack` or `install`.

| You need | Read |
|---|---|
| Manifest fields, ids, permissions, limits, validation rules, actions | `plugin-manifest` |
| Slots, pages, nav, panels, commands, settings tabs, themes, variants, presets, CSS, sandbox SDK | `plugin-ui` |
| GenUI blocks in tool results or plugin GenUI components | `plugin-genui` |
| Agent tools, backend JS, RPC, prompt sections, plugin skills, providers, storage/network/secrets/events | `plugin-agent` |
| React overrides/wrappers/shell, trusted host API, trusted GenUI, global CSS | `plugin-trusted` |
| Studio actions, packaging, signature, install/activation, errors | `plugin-package` |

## Tool: plugin_studio

Use `plugin_studio` for the whole build. It creates an app-managed plugin
directory and never requires a workspace, Node, Python or repository files.

```
init      create a folder, manifest template and signing key
write     write one text or base64 file inside the plugin folder
read      read one text file (never signing material)
list      list files and sizes
remove    remove one file
validate  inspect the folder without executing plugin code
pack      sign and create <slug>-<version>.zplugin
install   stage the signed package disabled for the user
status    paths, files, key fingerprint and package state
```

Typical calls:

```json
{"action":"init","pluginId":"com.acme.notes","name":"Acme Notes","template":"sandbox","target":"auto"}
{"action":"write","plugin":"com.acme.notes","path":"manifest.json","content":"{...}"}
{"action":"write","plugin":"com.acme.notes","path":"ui/page.html","content":"<!doctype html>..."}
{"action":"validate","plugin":"com.acme.notes"}
{"action":"pack","plugin":"com.acme.notes"}
{"action":"install","plugin":"com.acme.notes"}
```

`target:"auto"` writes under `<workspace>/plugins/<slug>` when a trusted Code
workspace exists and under `<app-data>/plugin-studio/<conversation>/<slug>`
otherwise. Chat always uses the app-data studio. `target:"workspace"` requires a
trusted workspace; `target:"studio"` always uses app data. The tool result
reports the exact `pluginDir`; use it, do not guess.

The plugin is always installed **disabled**. Never enable it, never grant
permissions, never call store setters. Tell the user to review permissions and
activate it in Settings → Plugins.

## Workflow

1. Clarify only requirements that block implementation (what the plugin must do,
   where it appears, whether it needs trusted React). If the request is clear,
   proceed without asking.
2. Call `plugin_studio init` with a reverse-domain id and the lane template.
3. Read `plugin-manifest` and write a complete manifest. Add only the
   contributions and permissions the plugin actually uses.
4. Write UI/backend/tool/skill/locale files using `plugin_studio write` and the
   examples in the companion skills.
5. Call `validate` after the manifest and after each functional block. Fix every
   error before continuing.
6. Call `pack`, then `install`. Report the package path, plugin id/version,
   declared permissions and validation result.
7. Never claim the plugin is active. No code from a plugin runs during authoring,
   validation, packing or installation.

## Choose the lane

| Need | Lane |
|---|---|
| Slot actions, commands, settings tabs, themes, nav to host pages, i18n | Declarative |
| Own HTML/JS UI, backend logic, tools, GenUI, scoped/global CSS | Sandboxed |
| React component replacement/wrapping, shell override, React GenUI, host stores | Trusted |

Default to **sandboxed**. Use **trusted** only when React access is required. A
trusted plugin needs `"trusted": true`, `runtime.ui: "trusted"`,
`runtime.entry`, the `unsafe.renderer` permission, user opt-in (`allowTrusted`)
and explicit consent. Never mark a plugin trusted for convenience.

## File layout

```
manifest.json
README.md
locales/en.json  locales/pt-BR.json  locales/es.json
ui/page.html  ui/panel.html  ui/action.html  ui/toolbar.html
backend/index.html
main.js                    # trusted only
tools.json                 # optional inline tool source
prompt.md                  # optional prompt section
skills/<name>/SKILL.md     # optional packaged skill
assets/...                 # optional package assets
META-INF/publisher.key     # studio-managed; never written or read by the agent
META-INF/publisher.pub     # studio-managed
META-INF/studio.json       # studio-managed
```

All package paths are relative, use `/`, are at most 240 characters, and cannot
use `..`, absolute paths, drive letters, ADS, symlinks or reserved Windows
names. Do not write `META-INF/**`; the studio owns signing material.

## Minimal examples

### Declarative

```json
{
  "schemaVersion": 2,
  "id": "com.acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": 2,
  "publisher": { "id": "acme", "name": "Acme", "keyId": "studio-hello" },
  "permissions": ["ui.slot:chat.composer.toolbar", "ui.command", "ui.theme", "chat.write"],
  "contributes": {
    "ui": {
      "slots": [{
        "slot": "chat.composer.toolbar",
        "id": "hello",
        "title": "Hello",
        "icon": "Sparkles",
        "action": { "kind": "insertDraft", "text": "Hello from my plugin" }
      }],
      "commands": [{
        "id": "hello",
        "title": "Insert hello",
        "command": "hello",
        "action": { "kind": "insertDraft", "text": "Hello" }
      }],
      "themes": [{
        "id": "paper",
        "name": "Paper",
        "light": { "background": "#faf8f4" },
        "dark": { "background": "#14120f" }
      }]
    }
  },
  "runtime": { "ui": "declarative" }
}
```

### Sandboxed UI + tool

Manifest:

```json
{
  "schemaVersion": 2,
  "id": "com.acme.clock",
  "name": "Clock",
  "version": "1.0.0",
  "apiVersion": 2,
  "publisher": { "id": "acme", "name": "Acme", "keyId": "studio-clock" },
  "permissions": [
    "ui.view", "ui.nav", "ui.slot:chat.message.actions",
    "agent.tools", "storage", "notifications"
  ],
  "contributes": {
    "ui": {
      "views": [{ "id": "clock", "title": "Clock", "entry": "ui/page.html", "layouts": ["chat"] }],
      "nav": [{ "id": "clock", "title": "Clock", "icon": "Sparkles", "page": "clock", "layouts": ["chat"] }],
      "slots": [{ "slot": "chat.message.actions", "id": "stamp", "entry": "ui/action.html" }]
    },
    "tools": [{
      "name": "now",
      "description": "Return the current local time.",
      "parameters": { "type": "object", "properties": {}, "additionalProperties": false },
      "risk": "read",
      "profiles": ["chat", "code"]
    }],
    "locales": ["locales"]
  },
  "runtime": { "ui": "sandbox", "backend": { "kind": "js", "entry": "backend/index.html" } }
}
```

`ui/page.html`:

```html
<!doctype html><meta charset="utf-8">
<style>body{font:14px system-ui;color:var(--foreground);background:var(--background);padding:16px}</style>
<body><h1>Clock</h1><p id="now">…</p>
<script src="/@zylara/sdk.js"></script>
<script>
ZylaraPlugin.on('init', () => { document.getElementById('now').textContent = new Date().toLocaleString(); ZylaraPlugin.resize(); });
</script>
```

`backend/index.html`:

```html
<!doctype html><meta charset="utf-8">
<script src="/@zylara/sdk.js"></script>
<script>
ZylaraPlugin.onTool(async ({ tool }) => {
  if (tool === 'now') return { content: new Date().toLocaleString(), summary: 'Current time' };
  throw new Error(`unknown tool: ${tool}`);
});
</script>
```

### Trusted React page

Manifest:

```json
{
  "schemaVersion": 2,
  "id": "com.acme.lab",
  "name": "Acme Lab",
  "version": "1.0.0",
  "apiVersion": 2,
  "trusted": true,
  "publisher": { "id": "acme", "name": "Acme", "keyId": "studio-lab" },
  "permissions": ["unsafe.renderer", "ui.view", "ui.override:chat.welcome"],
  "contributes": {
    "ui": {
      "views": [{ "id": "lab", "title": "Lab", "component": "Lab", "layouts": ["chat", "code"] }]
    }
  },
  "runtime": { "ui": "trusted", "entry": "main.js" }
}
```

`main.js`:

```js
host.registerPlugin({
  activate(host) {
    function Lab() {
      return host.react.createElement('div', { style: { padding: 24 } }, 'Hello from a trusted plugin');
    }
    host.registerView('lab', Lab);
    host.replaceComponent('chat.welcome', () =>
      host.react.createElement('div', { style: { padding: 24 } }, 'Custom welcome'));
  },
  deactivate() {},
});
```

### Declarative provider

```json
{
  "schemaVersion": 2,
  "id": "com.acme.provider",
  "name": "Acme Provider",
  "version": "1.0.0",
  "apiVersion": 2,
  "publisher": { "id": "acme", "name": "Acme", "keyId": "studio-provider" },
  "permissions": ["providers"],
  "contributes": {
    "providers": [{
      "id": "acme",
      "name": "Acme",
      "shortName": "Acme",
      "baseUrl": "https://api.acme.example/v1",
      "models": [{ "id": "acme-1", "name": "Acme 1", "protocols": ["openai-chat"] }]
    }]
  },
  "runtime": { "ui": "none" }
}
```

## Verification checklist

- `plugin_studio validate` exits with `PLUGIN_STUDIO_VALID`; `pack` reports a
  package path and SHA-256; `install` reports `active:false` with declared
  permissions.
- Every permission maps to a contribution and every contribution has its
  permission (`ui.slot:<slot>`, `ui.view`, `ui.nav`, `ui.panel`, `ui.command`,
  `ui.settings`, `ui.theme`, `ui.variant`, `ui.preset`, `ui.css.global`,
  `ui.genui`, `agent.tools`, `agent.prompt`, `agent.skills`, `providers`, …).
- Contribution ids are stable, lowercase and unique; `layouts` is explicit in
  v2 and contains only `chat`, `code`, `agent`.
- UI is isolated by layout; a plugin that declares `layouts: ["chat"]` never
  appears in `code` or `agent`.
- Tools return bounded text/JSON and validate arguments; no secret is logged or
  returned.
- No file or package references the repository; the skill references are the
  only contract.
- Trusted plugins are signed, require `allowTrusted`, and are never activated by
  the agent.

## Common failures

- `PLUGIN_PERMISSION_DENIED`: missing permission or a scoped grant.
- `unknown slot/component`: the id is not in the generated tables; reload
  `plugin-manifest`/`plugin-ui` and use an exact id.
- `signature publisher does not match manifest publisher`: do not edit the
  `publisher` block created by `init`; the studio key belongs to it.
- Sandbox page blank: wrong package-relative entry, missing
  `/@zylara/sdk.js`, or CSP-blocked external asset.
- Trusted plugin does not load: `allowTrusted` off, `unsafe.renderer` missing,
  or `main.js` did not call `host.registerPlugin`.
- `PLUGIN_STUDIO_WORKSPACE_UNAVAILABLE`: use `target:"studio"` or open and trust
  a Code workspace.
