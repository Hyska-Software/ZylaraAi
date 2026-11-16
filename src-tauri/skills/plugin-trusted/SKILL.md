---
name: plugin-trusted
description: Complete Zylara trusted plugin reference: opt-in/consent, trusted loader, shared React, host API registration, component overrides and wrappers, shell replacement, trusted GenUI, global CSS, host stores and cleanup.
---

# Trusted plugins

Trusted plugins run JavaScript in the main webview with the same privileges as
the app. They are only loaded when `pluginAllowTrusted` is enabled, the plugin is
signed, `unsafe.renderer` is declared, and the user explicitly trusts it. Never
choose this lane unless React access is required.

## Manifest and main.js

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

`main.js` is evaluated with a narrow `host` object and shared React:

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
  deactivate() {
    // release listeners/timers and any DOM the plugin owns
  },
});
```

`host.react`, `host.reactDom`, `host.jsx`, `host.jsxs`, `host.Fragment` are the
host's shared React. Use hooks normally; do not bundle a second React.

## `host` API

Top-level legacy/compat aliases:

| Method | Permission | Purpose |
|---|---|---|
| `registerPlugin({activate, deactivate})` | — | Entry point; must be called |
| `registerComponent(id, component)` | `unsafe.renderer` | Register a trusted component for `main.js` references |
| `registerView(id, component)` | `ui.view` | View/page component |
| `registerPanel(id, component)` | `ui.panel` | Right-dock panel component |
| `registerSlot(slotId, component)` | `ui.slot:<slot>` | Slot component |
| `registerSettingsTab(id, component)` | `ui.settings` | Settings tab component |
| `registerArtifactViewer(id, component)` | `ui.artifact` | Artifact viewer |
| `replaceComponent(id, component)` | `ui.override:<id>` | Replace a host component |
| `wrapComponent(id, wrapper)` | `ui.override:<id>` | Wrap a host component; wrapper receives `Host`/`children` |
| `replaceShell(component)` | `ui.shell` | Replace the application shell (trusted only) |
| `addGlobalCss(css)` | `ui.css.global` | Inject sanitized global CSS |
| `registerToolHandler(name, handler)` | `agent.tools` | Tool handler: `{tool, arguments}` |
| `registerCommandHandler(name, handler)` | `ui.command` | Declarative `execute` action |
| `on(event, handler)` | `events:<scope>` | Host event subscription |
| `rpc(method, params)` | method-specific | Mediated RPC (same table as `plugin-agent`) |
| `openView(id)` / `openPanel(id)` / `closeOverlays()` | — | Own surfaces only |
| `layoutMode()` | — | Current layout |
| `stores.ui/app/chat` | trusted only | `{getState,setState,subscribe}` narrow host stores |
| `notify(title, body?)` | `notifications` | Notification |
| `log(level, message)` | — | Plugin log |
| `t(key, fallback?)` | — | Plugin locale lookup |

The `host.ui` namespace is preferred for new code:

| Method | Signature |
|---|---|
| `registerSlot` | `(spec {slot,id,order?,priority?,layouts?,key?,when?,select?}, Component)` |
| `replace` | `(spec {component,id?,priority?,layouts?}, Component)` |
| `wrap` | `(spec {component,id,order?,priority?,layouts?}, Wrapper)` |
| `registerVariant` | `({component,id,title,layouts?,recipe})` |
| `registerPreset` | `({id,title,layouts?,tokens?,density?,variants?,css?})` |
| `registerPage` | `({id,title,titleKey?,icon?,layouts?,order?}, Component)` |
| `registerPanelTab` | `({id,title,titleKey?,icon?,layouts?,order?}, Component)` |
| `registerSettingsTab` | `({id,title,titleKey?,icon?,order?}, Component)` |
| `registerNav` | `({id,title,titleKey?,icon,page,layouts?,order?,badge?})` |
| `registerGenuiComponent` | `({id,title,summary,props}, Component)` |
| `addCss` | `(css, {layouts?, id?})` |
| `openPage` / `openPanelTab` / `closePanelTab` | open/close own surfaces |
| `setLayout` / `openSettings` / `toast` / `inspect` | host navigation/introspection |

All `register*` methods return a disposer when applicable. Add it to
`deactivate` or a cleanup array. A plugin that crashes three times is disabled
automatically; a failing contribution is isolated by an error boundary.

## Overrides and wrappers

`replaceComponent(id, Component)` replaces a host component; `wrapComponent(id,
Wrapper)` nests around the host. The component id must be in the generated
component table. A wrapper receives the original node as both `children` and
`Host`, plus the component props. Use `plugin-trusted` for React layouts only;
prefer a sandboxed page otherwise.

`replaceShell(Component)` requires `ui.shell` and must keep the host chrome
usable. It is the highest-risk API; only do it when the user explicitly asks.

## CSS and theming

`addGlobalCss` is sanitized (no `@import`, `expression`, `-moz-binding`,
`javascript:`, external `url()`). Scope selectors to a plugin-specific class or
`data-zylara-plugin` attribute. Prefer package CSS and theme tokens. Do not
depend on host Tailwind class names or internal DOM structure.

## Trusted GenUI

Register a React component with
`host.ui.registerGenuiComponent({id,title,summary,props}, Component)` and declare
`render: {kind:"trusted", component:"..."}` plus `unsafe.renderer`. The component
receives validated props and must render inside the provided block without
overflow. Sandboxed GenUI uses `ZylaraPlugin.onGenui` instead.

## Security checklist

- `allowTrusted` is off by default; never ask the user to bypass it in code.
- `unsafe.renderer` is mandatory and always shows a critical-risk consent.
- Never fetch provider credentials, secrets or host internals; use mediated RPC.
- Clean up listeners, timers, styles and DOM in `deactivate`.
- Keep permissions minimal; an update that adds a permission needs new consent.
- Do not execute plugin code during authoring, validation or installation.
