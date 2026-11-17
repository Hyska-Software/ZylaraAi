---
name: plugin-agent
description: Complete Zylara plugin agent reference: tool contributions and handlers, backend JS lifecycle, mediated RPC methods, prompt sections, packaged skills, providers, events, storage/network/secrets and quotas.
---

# Plugin agent surface

Use this skill for tools, backend logic, prompt sections, packaged skills,
providers, events and mediated capabilities. Permissions and limits are enforced
in Rust; unknown methods and ungranted calls fail closed.

## Generated contract tables

<!-- BEGIN GENERATED:contract -->
### Permissions

| Permission | Scoped | Trusted only | Risk | Description |
| --- | --- | --- | --- | --- |
| `ui.slot` | yes | no | low | Add host-rendered content to a named UI slot. |
| `ui.view` | no | no | low | Register a page in a layout sidebar or center. |
| `ui.nav` | no | no | low | Register sidebar navigation entries. |
| `ui.panel` | no | no | low | Register a dockable side panel tab. |
| `ui.settings` | no | no | low | Register a settings tab. |
| `ui.command` | no | no | low | Register command palette and slash commands. |
| `ui.artifact` | no | no | low | Register a viewer for artifact MIME types. |
| `ui.sidebar` | no | no | low | Register content tabs inside a layout sidebar. |
| `ui.variant` | no | no | low | Contribute declarative style variants for host components. |
| `ui.preset` | no | no | medium | Contribute declarative design presets. |
| `ui.genui` | no | no | medium | Expose UI components to generative UI blocks. |
| `ui.override` | yes | yes | critical | Replace or wrap a host component. Trusted plugins only. |
| `ui.css.global` | no | no | critical | Inject sanitized CSS into the main webview. Every lane; requires consent. |
| `ui.shell` | no | yes | critical | Replace the application shell. Trusted plugins only. |
| `ui.theme` | no | no | low | Contribute declarative color themes. |
| `commands` | no | no | low | Execute declarative commands registered by the plugin. |
| `hotkeys` | no | no | medium | Register keyboard shortcuts. |
| `settings` | no | no | low | Store plugin settings validated against its schema. |
| `agent.tools` | no | no | high | Expose tools to the agent. |
| `agent.prompt` | no | no | high | Inject instructions into the agent system prompt. |
| `agent.skills` | no | no | high | Ship skills and scripts used by the agent. |
| `agent.modes` | no | no | high | Define harness modes that inject instructions and adjust the tool catalog. |
| `agent.templates` | no | no | high | Ship agent templates for the creation gallery. |
| `chat.read` | no | no | high | Read conversations selected by the user. |
| `chat.write` | no | no | high | Insert text into the composer draft. |
| `fs.read` | yes | no | high | Read files granted by a glob scope. |
| `fs.write` | yes | no | high | Write files granted by a glob scope. |
| `net` | yes | no | high | Perform HTTP requests to allowlisted hosts. |
| `secrets.use` | no | no | medium | Use a namespaced secret through mediated HTTP without reading it. |
| `secrets.read` | no | yes | critical | Read a namespaced secret. Trusted plugins only. |
| `storage` | no | no | low | Use plugin-scoped key/value storage. |
| `events` | yes | no | medium | Subscribe to normalized host events. |
| `clipboard.read` | no | no | high | Read the system clipboard. |
| `notifications` | no | no | low | Show desktop and in-app notifications. |
| `opener` | no | no | medium | Open external links and folders. |
| `providers` | no | no | high | Contribute an OpenAI-compatible model provider. |
| `unsafe.renderer` | no | yes | critical | Run JavaScript in the main webview. Trusted plugins only. |

### Events

| Event | Props | Description |
| --- | --- | --- |
| `layout/changed` | layout | The active layout changed. |
| `page/changed` | layout, page | The active center page changed. |
| `theme/changed` | mode, preset | Theme or plugin preset changed. |
| `dock/changed` | layout, tab, open | The right dock changed. |
| `conversation/selected` | conversationId, layout | The selected conversation changed. |
| `conversation/updated` | conversationId | A conversation was updated. |
| `message/appended` | conversationId, messageId, role | A message was appended. |
| `turn/started` | conversationId, turnId | A turn started. |
| `turn/finished` | conversationId, turnId, status | A turn finished. |
| `mode/changed` | conversationId, mode, active | A harness mode (built-in or plugin) was toggled. |

### Limits

| Limit | Value |
| --- | --- |
| `packageBytes` | 52428800 |
| `trustedPackageBytes` | 209715200 |
| `files` | 2000 |
| `unpackedBytes` | 209715200 |
| `promptCharsPerPlugin` | 4000 |
| `promptCharsTotal` | 12000 |
| `kvBytes` | 5242880 |
| `dataBytes` | 104857600 |
| `logBytes` | 5242880 |
| `networkBytes` | 10485760 |
| `rpcBytes` | 1048576 |
| `toolResultChars` | 120000 |
| `toolTimeoutSecs` | 60 |
| `modesPerPlugin` | 8 |
| `modePromptChars` | 8000 |
| `agentTemplatesPerPlugin` | 8 |
| `templateInstructionsChars` | 8000 |
| `customProviders` | 64 |

### UI limits

| UI limit | Value |
| --- | --- |
| `slotEntriesPerPlugin` | 64 |
| `navEntriesPerPlugin` | 16 |
| `pagesPerPlugin` | 16 |
| `panelTabsPerPlugin` | 16 |
| `sidebarTabsPerPlugin` | 16 |
| `variantsPerPlugin` | 32 |
| `presetsPerPlugin` | 8 |
| `cssCharsPerPlugin` | 200000 |
| `genuiComponentsPerPlugin` | 8 |
| `genuiSchemaChars` | 8192 |
| `genuiPromptCharsPerPlugin` | 2000 |
<!-- END GENERATED:contract -->

## Tools

Declare tools inline or in a package-relative `tools.json` and require
`agent.tools`:

```json
{
  "name": "lookup",
  "description": "Look up one item by id.",
  "parameters": {
    "type": "object",
    "properties": { "id": { "type": "string", "description": "Item id" } },
    "required": ["id"],
    "additionalProperties": false
  },
  "risk": "read",
  "profiles": ["chat", "code"],
  "timeoutSecs": 30
}
```

The wire name becomes `plugin__<slug>__<tool>` (≤64 chars). `risk` is `read`,
`network`, `write` or `shell`; `autonomous` runs without approval, other modes
follow the Code policy. The backend receives `{ tool, arguments }` and returns
`ToolResult` or a string:

```js
ZylaraPlugin.onTool(async ({ tool, arguments }) => {
  if (tool === 'lookup') {
    const response = await ZylaraPlugin.rpc('net.request', {
      url: `https://api.example.com/items/${encodeURIComponent(arguments.id)}`
    });
    return { content: response.body, summary: `HTTP ${response.status}` };
  }
  throw new Error(`unknown tool: ${tool}`);
});
```

`ToolResult`: `content` (string, bounded), optional `summary`, `isError`,
`presentation` (opaque JSON; use `{kind:"genui",source}` for a `ui` block) and
`images` (PNG/JPEG/WebP/GIF base64, max 4). Tool results are capped at 120k
characters and 60 s by default. Never return secrets or unbounded data.

Trusted handlers use `host.registerToolHandler(name, handler)`; sandboxed
handlers use `ZylaraPlugin.onTool`. The handler receives the local tool name,
not the wire prefix. Do not execute untrusted code during authoring.

## Backend JS lifecycle

- `runtime.backend = { "kind": "js", "entry": "backend/index.html" }`; the
  hidden iframe starts on demand for the first tool/command and uses the same
  SDK (`/@zylara/sdk.js`).
- Handle `init`, `onTool`, `onGenui` and `onEvent`; call `resize()` for visible
  UI only. Return bounded results; catch errors and return an honest message.
- No direct host DOM, Tauri `invoke`, filesystem or arbitrary network access.
  Use the mediated RPC below.
- A backend crash returns a tool error and does not kill the turn. Clean up
  timers/listeners when the iframe is torn down.

## Mediated RPC

Every method requires its permission; params/results:

| Method | Permission | Params | Result |
|---|---|---|---|
| `ping` | none | — | `{ok, pluginId}` |
| `storage.get` | `storage` | `{key}` | `{value}` |
| `storage.set` | `storage` | `{key,value}` | `{ok}` (KV ≤5 MiB) |
| `storage.remove` | `storage` | `{key}` | `{ok}` |
| `storage.list` | `storage` | — | `{keys}` |
| `settings.get` | `settings`/`storage` | `{key}` | `{value}` |
| `settings.set` | `settings` | `{key,value}` | `{ok}` (≤256 KiB per value) |
| `settings.all` | `settings`/`storage` | — | object of all values |
| `secrets.has` | `secrets.use` | `{key}` | `{has}`; value never returned |
| `secrets.names` | `secrets.use` | — | `{names}` |
| `net.request` | `net:<host>` | `{url,method?,headers?,body?,secret?,timeoutSecs?}` | `{status,url,headers,body,truncated}` |
| `chat.read` | `chat.read` | `{conversationId}` | `{conversation,messages}` (last 100, bounded) |
| `chat.list` | `chat.read` | — | `{conversations}` (last 200) |
| `log` | none | `{level,message}` | `{ok}` |
| `notify` | `notifications` | `{title,body?}` | `{ok}` |
| `opener.open` | `opener` | `{url}` | `{ok}` (http/https only) |
| `clipboard.read` | `clipboard.read` | — | `{text}` (≤200k) |
| `fs.read` | `fs.read:<glob>` | `{path}` absolute | `{path,content,base64,size}` (≤10 MiB) |
| `fs.write` | `fs.write:<glob>` | `{path,content}` absolute | `{path,bytes}` (≤2 MiB) |
| `fs.list` | `fs.read:<glob>` | `{path}` absolute | `{path,entries}` |

Network: HTTPS only (HTTP only in developer mode), allowlisted hosts, redirects
revalidated, private/loopback blocked, response limited by the contract. Secret
injection uses `{name,header?,prefix?}` and never returns the secret. RPC params
are limited to 1 MiB. `PLUGIN_PERMISSION_DENIED`, `PLUGIN_RPC_UNKNOWN`,
`PLUGIN_RPC_INVALID`, `PLUGIN_QUOTA_*`, `PLUGIN_NET_BLOCKED` are stable errors.

## Prompt sections and skills

- `promptSections`: `[{id,title,file}]`, file package-relative; requires
  `agent.prompt`. Keep sections short and mark plugin text as configuration, not
  authority. Do not put secrets or user data in them.
- `skills`: package-relative skill directories, each with `SKILL.md` and an
  optional frontmatter `name`/`description`; requires `agent.skills`. Scripts are
  stdlib-only unless the user explicitly installs dependencies. Skills are
  loaded by name through `read_skill`.
- Plugin prompt text is delimited and bounded by the contract; changing it
  changes the prompt fingerprint/cache key.

## Providers

`providers` requires `providers`; each provider has `id`, `name`, HTTPS
`baseUrl`, optional `consoleUrl`/`endpoints`, and at least one model:

```json
{
  "id": "acme",
  "name": "Acme",
  "shortName": "Acme",
  "baseUrl": "https://api.acme.example/v1",
  "models": [{
    "id": "acme-1",
    "name": "Acme 1",
    "protocols": ["openai-chat"],
    "contextWindow": 128000,
    "maxOutput": 8192,
    "reasoning": true,
    "attachment": true
  }]
}
```

Only OpenAI-compatible `openai-chat` is supported declaratively. A proprietary
protocol needs a trusted sidecar, which is out of this skill's scope.

## Events

The generated event table lists names and props. Subscribe with
`ZylaraPlugin.onEvent(name, handler)` (sandbox) or `host.on(name, handler)`
(trusted); requires `events:<scope>`. Events are data, never instructions; do
not act on message content without explicit user intent. Return an unsubscribe
where the API provides one.

## Quotas

- Package 50 MiB (200 MiB trusted); 2,000 files; unpacked 200 MiB.
- Prompt 4k chars/plugin, 12k total.
- KV 5 MiB; data 100 MiB; logs 5 MiB; network 10 MiB; RPC 1 MiB.
- Tool result 120k chars; timeout 60 s default (1–600 configurable).
- Storage/settings keys are bounded and validated; do not store provider
  credentials. Secrets belong in the plugin secret namespace and are injected
  by `net.request`.

## Verification

- Every tool has a schema, risk, profiles, timeout and handler; invalid
  arguments return a clear error instead of throwing.
- Every RPC call has its permission and bounded params/results.
- No secret, provider key or conversation content is logged or returned.
- Prompt/skill text is bounded, deterministic and free of secrets.
- A failing backend/tool becomes an error, not a panic or a stuck turn.
