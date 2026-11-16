---
name: plugin-authoring
description: Create, extend, validate, package and install a Zylara plugin (.zplugin), including sandboxed/trusted UI, slots, pages, nav, dock tabs, variants, presets, CSS, GenUI, tools, prompt sections and skills.
---

# Authoring Zylara plugins

In the Code layout, `/creator` enables **Plugin Creator mode**: the runtime
context gets this workflow and the read-only `validate_plugin` tool. The mode is
session-scoped; `/creator off` disables it.

Use this skill when the user asks to create, modify, debug, package or install a
Zylara plugin. Work inside the repository/workspace and use the normal file and
command tools; there is no separate "plugin builder" tool.

## Source of truth

Read these before writing a manifest:

- `data/plugin-contract.json` — slots, components, layouts, permissions, limits,
  events and style recipes.
- `data/plugin-manifest.schema.json` — accepted manifest v1/v2 shape.
- `data/genui-contract.json` — GenUI component schema and plugin component rules.
- `plugins/fixtures/sandbox-demo/` and `plugins/fixtures/trusted-demo/` — working
  reference packages for every lane.
- `docs/PLUGINS.md` — packaging/install/runtime overview. If it disagrees with the
  contract, the contract wins.

Never invent a slot, component, layout or permission id. If the requested change
needs a new host anchor, add it to `data/plugin-contract.json` first, regenerate
mirrors with `pnpm plugin:contract`, and implement the host mount before using it
from a plugin.

## Choose the lane

| Need | Lane |
|---|---|
| Buttons/actions, pages, nav, panels, settings tabs, themes, i18n, commands | Declarative |
| Own HTML/JS UI, tools, backend logic, CSS, GenUI iframe components | Sandboxed |
| React component replacement/wrapping, shell override, React GenUI | Trusted |

Default to **sandboxed**. Use **trusted** only when React access is required; it
needs `runtime.ui: "trusted"`, `"trusted": true`, `unsafe.renderer`, user opt-in
(`allowTrusted`) and explicit consent. Never mark a plugin trusted just for
convenience.

## Scaffold

```bash
node scripts/plugin/cli.mjs init plugins/<name> com.example.<name>
```

`init` creates a signed sandboxed baseline (`manifest.json`, `ui/`, `backend/`,
`locales/`, `skills/`, `META-INF/publisher.pem`). It is intentionally minimal;
edit the manifest for the requested features.

For v2 UI features (nav, dock tabs, variants, presets, scoped CSS, GenUI
components), use `schemaVersion: 2`, `apiVersion: 2`, `layouts` arrays and the
`contributes.ui` fields from the schema. `layouts` defaults to all three
(`chat`, `code`, `agent`) and must be a subset of the contract.

Minimal v2 UI contributions:

```json
{
  "schemaVersion": 2,
  "apiVersion": 2,
  "permissions": ["ui.nav", "ui.view", "ui.panel", "ui.slot:chat.message.actions"],
  "contributes": {
    "ui": {
      "nav": [{ "id": "notes", "title": "Notes", "icon": "notebook", "page": "notes", "layouts": ["chat"] }],
      "views": [{ "id": "notes", "title": "Notes", "icon": "notebook", "entry": "ui/page.html", "layouts": ["chat"] }],
      "panels": [{ "id": "outline", "title": "Outline", "entry": "ui/panel.html", "tab": true, "layouts": ["chat"] }],
      "slots": [{ "slot": "chat.message.actions", "id": "pin", "entry": "ui/action.html" }]
    }
  },
  "runtime": { "ui": "sandbox" }
}
```

Requirements that are easy to miss:

- Every declared contribution needs its permission (`ui.nav`, `ui.view`,
  `ui.panel`, `ui.slot:<slot>`, `ui.variant`, `ui.preset`, `ui.css.global`,
  `ui.genui`, `ui.command`, `ui.theme`, …).
- `nav.page` must reference a view in the same manifest or a host page from the
  contract.
- `panels[].tab: true` is a dock tab; `tab: false` takes over the whole dock.
- Keyed slots require `key`; `when` only uses declared slot props.
- Sandbox entries are package-relative HTML files. Trusted `component` names must
  be registered by `main.js` at runtime.
- CSS is sanitized; use stable `[data-zylara-part='…']` anchors, not Tailwind
  internals. Package fonts/images with relative `url()`.
- GenUI sandbox components declare `render: { "kind": "sandbox", "entry": "...",
  "height": 80..480 }`; trusted components need `unsafe.renderer`.

## Implementation rules

- Package-relative paths only; no `..`, absolute paths, symlinks, ADS or reserved
  Windows names.
- Sandbox UI: `window.ZylaraPlugin` SDK served from `/@zylara/sdk.js`; use
  `on('init')`, `onEvent`, `rpc`, `ui.*`, `resize`, `onTool`/`onGenui` where
  declared. No direct host DOM access.
- Trusted UI: implement `host.registerPlugin({ activate(host) {}, deactivate() {} })`
  and register contributions through `host.ui.*` (or the legacy aliases). Return
  disposers and clean up in `deactivate`.
- Tools: declare `contributes.tools` + `agent.tools`; wire the handler with
  `host.registerToolHandler` (trusted) or `ZylaraPlugin.onTool` (sandbox). Keep
  results bounded and validate arguments.
- Prompt sections and skills are opt-in capabilities; keep them short and do not
  put secrets or user data in them.
- Locales: ship `locales/{en,pt-BR,es}.json`; never hardcode interface copy.
- Network access needs scoped `net:<host>` permission; use the mediated RPC, not
  raw fetch to arbitrary hosts.

## Installing for the user

When the app exposes the `install_plugin` tool, use it instead of asking the user
to open a file picker:

- Code session: pass a workspace-relative `.zplugin` path or an HTTPS URL.
- Chat: pass an HTTPS URL only.
- The tool validates the package, records its declared permissions and installs
  it **disabled** (`activation_required`). It never replaces an installed plugin.
- Do not try to enable the plugin or grant permissions yourself. Tell the user to
  review it in **Settings → Plugins** and activate it there.
- Signed packages are required outside developer mode; build/verify the package
  first when you generated it locally.

## Validate and package

```bash
node scripts/plugin/cli.mjs dev plugins/<name>                  # structural check
node scripts/plugin/cli.mjs pack plugins/<name> plugins/<name>.zplugin \
  --key plugins/<name>/META-INF/publisher.pem
node scripts/plugin/cli.mjs verify plugins/<name>.zplugin
node scripts/plugin/review.mjs plugins/<name>.zplugin --allow-high-risk
```

`pack` defaults the signature publisher/key id to `manifest.publisher`; pass
`--publisher`/`--key-id` only when intentionally overriding. Unsigned packages
install only in developer mode; store/URL installs require a valid signature and
consent.

Install manually through **Settings → Plugins**: pick the `.zplugin`, or use
developer mode + **Load unpacked** for an unpacked folder. Trusted plugins also
need trusted mode enabled in settings.

## Verification checklist

- Manifest validates (CLI `dev` + `review` exits 0).
- Package verifies (`verify`).
- Every permission maps to a feature and every feature maps to a permission.
- Contribution ids are stable, lowercase and unique.
- UI is isolated by layout; a `layouts: ["chat"]` contribution does not appear in
  `code`/`agent`.
- Disabling the plugin/safe mode leaves the host UI intact; no console errors on
  load.
- Tools return bounded text and do not leak secrets.
- If the plugin changes the host contract or SDK, regenerate mirrors and run
  `pnpm typecheck`, `pnpm test`, `cargo test --lib plugins::`.

## Common failures

- `PLUGIN_PERMISSION_DENIED`: missing permission or scoped grant.
- `signature publisher does not match manifest publisher`: pass the manifest
  publisher or let `pack` default it.
- Unknown slot/component: id is not in the contract or the contract mirror was
  not regenerated.
- Sandbox page blank: entry path wrong, `/@zylara/sdk.js` missing, or CSP-blocked
  external asset.
- Trusted plugin does not load: `allowTrusted` off, `unsafe.renderer` missing, or
  `host.registerPlugin` not called.
