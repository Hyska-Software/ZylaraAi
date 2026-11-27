---
name: plugin-ui
description: Complete Zylara plugin UI reference: declarative and sandbox contributions, slots, pages, nav, panels, settings tabs, commands, themes, variants, presets, CSS/i18n and the exact sandbox SDK. Read before writing UI files or UI contributions.
---

# Plugin UI

Use this skill for declarative and sandboxed UI. For React overrides, wrappers,
shell replacement and trusted GenUI read `plugin-trusted`. For GenUI blocks and
plugin GenUI components read `plugin-genui`.

## Generated UI contract

<!-- BEGIN GENERATED:contract -->
### Layouts

`chat`, `code`, `agent`

### Host pages

`chat`, `skills`, `library`, `plugins`, `team`, `stats`, `routines`

### Slots

Reserved slots are not mounted by this host version; a manifest that targets one is rejected.

| Slot | Kind | Scope | Layouts | Modes | Props | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `titlebar.actions` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Actions at the end of the layout's top chrome row. |
| `app.titlebar.brand` | single | root | chat, code, agent | trusted | — | App icon in the chrome (icon only, no wordmark). |
| `app.overlay` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Floating layer above the shell. |
| `chat.sidebar.header` | list | layout | chat | declarative, sandbox, trusted | — | Header of the chat sidebar. |
| `chat.sidebar.footer` | list | layout | chat | declarative, sandbox, trusted | — | Footer of the chat sidebar. |
| `sidebar.nav.before` | list | layout | chat, code, agent | declarative, sandbox, trusted | — | Content before the navigation items. |
| `sidebar.nav.after` | list | layout | chat, code, agent | declarative, sandbox, trusted | — | Content after the navigation items. |
| `sidebar.conversation.row.frame` | hoc | layout | chat, code | trusted | conversation, active | Wraps each conversation row. |
| `code.sidebar.header` | list | layout | code | declarative, sandbox, trusted | — | Header of the code sidebar. |
| `code.sidebar.footer` | list | layout | code | declarative, sandbox, trusted | — | Footer of the code sidebar. |
| `agent.sidebar.header` | list | layout | agent | declarative, sandbox, trusted | — | Header of the agents sidebar. |
| `agent.sidebar.footer` | list | layout | agent | declarative, sandbox, trusted | — | Footer of the agents sidebar. |
| `agent.thread.row.frame` | hoc | layout | agent | trusted | conversation, active | Wraps each agent thread row. |
| `agent.channel.row.frame` | hoc | layout | agent | trusted | channel, active | Wraps each agent channel row. |
| `chat.header.actions` | list | conversation | chat, code | declarative, sandbox, trusted | — | Actions in the chat header. |
| `chat.header.leading` | list | conversation | chat, code | declarative, sandbox, trusted | — | Content before the chat header title. |
| `chat.header.trailing` | list | conversation | chat, code | declarative, sandbox, trusted | — | Content after the chat header actions. |
| `chat.view.frame` | hoc | layout | chat, code | trusted | — | Wraps the whole chat column. |
| `chat.messages.before` | list | conversation | chat, code | declarative, sandbox, trusted | — | Content above the message list. |
| `chat.messages.after` | list | conversation | chat, code | declarative, sandbox, trusted | — | Content below the message list. |
| `chat.message.list.frame` | hoc | conversation | chat, code | trusted | messages, streaming | Wraps the message list. |
| `chat.message.before` | chain | message | chat, code | declarative, sandbox, trusted | — | Chain before each message. |
| `chat.message.after` | chain | message | chat, code | declarative, sandbox, trusted | — | Chain after each message. |
| `chat.message.node` | keyed | message | chat, code | declarative, sandbox, trusted | message, role | Role-specific message takeover (user, assistant, system, goal-round). |
| `chat.message.body.frame` | hoc | message | chat, code | trusted | — | Wraps the message body. |
| `chat.reasoning.body.frame` | hoc | message | chat, code | trusted | — | Wraps the reasoning body. |
| `chat.message.tool` | keyed | message | chat, code | trusted | tool | Per-tool renderer keyed by tool name. |
| `chat.message.tool.group.frame` | hoc | message | chat, code | trusted | — | Wraps each tool group. |
| `chat.message.usage` | single | message | chat, code | trusted | — | Token/usage footer of a message. |
| `chat.message.usage.actions` | list | message | chat, code | declarative, sandbox, trusted | — | Actions next to the usage footer. |
| `chat.message.attachments.frame` | hoc | message | chat, code | trusted | attachments | Wraps message attachment chips. |
| `chat.message.artifacts.frame` | hoc | message | chat, code | trusted | artifacts | Wraps message artifact cards. |
| `chat.message.citations.frame` | hoc | message | chat, code | trusted | citations | Wraps message citations. |
| `chat.message.actions` | list | message | chat, code | declarative, sandbox, trusted | — | Actions after each message. |
| `chat.markdown.fence` | keyed | message | chat, code | trusted | language, code | Fence renderer keyed by language. |
| `chat.turn.error.frame` | hoc | conversation | chat, code | trusted | — | Wraps the turn error banner. |
| `chat.queue.frame` | hoc | conversation | chat, code | trusted | — | Wraps the queued message bar. |
| `chat.scroll.jump` | single | conversation | chat, code | trusted | — | Jump-to-latest control. |
| `chat.composer.frame` | hoc | composer | chat, code | trusted | — | Wraps the composer card. |
| `chat.composer.input.frame` | hoc | composer | chat, code | trusted | — | Wraps the composer input. |
| `chat.composer.toolbar` | list | composer | chat, code | declarative, sandbox, trusted | draft | Composer toolbar items. |
| `chat.composer.actions` | list | composer | chat, code | declarative, sandbox, trusted | streaming, canSend | Actions next to send/stop. |
| `chat.composer.attachments` | list | composer | chat, code | declarative, sandbox, trusted | — | Content above the composer input. |
| `chat.composer.notice` | list | composer | chat, code | declarative, sandbox, trusted | — | Notice row above the composer. |
| `chat.composer.slash` | list | composer | chat, code | declarative, sandbox, trusted | query | Extra slash-command rows. |
| `chat.welcome.actions` | list | layout | chat, code | declarative, sandbox, trusted | — | Actions on the welcome screen. |
| `chat.welcome.suggestions` | list | layout | chat, code | declarative, sandbox, trusted | — | Suggestion chips on the welcome screen. |
| `code.header.actions` | list | conversation | code | declarative, sandbox, trusted | workspaceId | Actions in the code session header. |
| `code.session.header.frame` | hoc | layout | code | trusted | — | Wraps the code session header. |
| `code.tabs.before` | list | layout | code | declarative, sandbox, trusted | — | Content before the code tab strip. |
| `code.tabs.after` | list | layout | code | declarative, sandbox, trusted | — | Content after the code tab strip. |
| `code.tab.strip.frame` | hoc | layout | code | trusted | — | Wraps the code tab strip. |
| `code.panel.header` | list | layout | code | declarative, sandbox, trusted | — | Header of the code right panel. |
| `code.panel.tabs` | list | layout | code | declarative, sandbox, trusted | — | Extra tabs in the code right panel. |
| `code.panel.body.frame` | hoc | layout | code | trusted | — | Wraps the code right panel body. |
| `code.terminal.toolbar` | list | layout | code | declarative, sandbox, trusted | — | Actions in the terminal toolbar. |
| `code.diff.toolbar` | list | layout | code | declarative, sandbox, trusted | — | Actions in the diff toolbar. |
| `code.welcome.actions` | list | layout | code | declarative, sandbox, trusted | — | Actions on the code welcome screen. |
| `agent.header.actions` | list | layout | agent | declarative, sandbox, trusted | — | Actions in the agent thread header. |
| `agent.panel.tabs` | list | layout | agent | declarative, sandbox, trusted | — | Extra tabs in the agent right panel. |
| `agent.panel.header` | list | layout | agent | declarative, sandbox, trusted | — | Header of the agent right panel. |
| `right.panel.header` | list | layout | chat, code, agent | declarative, sandbox, trusted | — | Header of the right dock. |
| `right.panel.body.frame` | hoc | layout | chat, code, agent | trusted | — | Wraps the active right dock panel. |
| `settings.plugins.header` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Header of the plugins settings tab. |
| `settings.rail.before` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Content before the settings rail items. |
| `settings.rail.after` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Content after the settings rail items. |
| `settings.page.header` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Header of the active settings page. |
| `palette.actions` | list | root | chat, code, agent | declarative, trusted | query | Extra rows in the command palette. |
| `palette.footer` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Footer of the command palette. |
| `plugins.detail.actions` | list | root | chat, code, agent | declarative, sandbox, trusted | pluginId | Actions in the plugin detail dialog. |
| `plugins.view.header` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Header of the plugins page. |
| `artifact.preview.toolbar` | list | root | chat, code, agent | declarative, sandbox, trusted | artifactId, artifactKind, mimeType | Toolbar of the artifact preview. |
| `artifact.card.actions` | list | root | chat, code, agent | declarative, sandbox, trusted | artifactId, artifactKind | Actions on an artifact card. |
| `agent.thread.view.frame` | hoc | layout | agent | trusted | agentId, conversationId | Wraps the agent thread view. |
| `agent.channel.view.frame` | hoc | layout | agent | trusted | channelId | Wraps the agent channel view. |
| `agent.channel.message.before` | chain | message | agent | declarative, sandbox, trusted | agentId, channelId, message | Chain before each channel message. |
| `agent.channel.message.after` | chain | message | agent | declarative, sandbox, trusted | agentId, channelId, message | Chain after each channel message. |
| `agent.channel.message.body.frame` | hoc | message | agent | trusted | agentId, channelId, message | Wraps the channel message body. |
| `agent.channel.composer.frame` | hoc | composer | agent | trusted | agentId, channelId | Wraps the channel composer. |
| `agent.channel.composer.actions` | list | composer | agent | declarative, sandbox, trusted | agentId, channelId | Actions next to the channel composer. |

### Components

Components marked `reserved` still support variants/presets but cannot be replaced or wrapped in this host version.

| Component | Override | Layouts | Variants | Props | Built-in recipes |
| --- | --- | --- | --- | --- | --- |
| `layout.shell` | available | chat, code, agent | — | children, sidebar, sidebarLabel, rightPanel, rightPanelOpen | — |
| `layout.titlebar` | reserved | chat, code, agent | — | — | — |
| `layout.sidebar` | available | chat, code, agent | — | layout, onClose | — |
| `layout.center` | available | chat, code, agent | — | — | — |
| `layout.right-panel` | available | chat, code, agent | default, flush, card | layout | default, flush, card |
| `chat.view` | available | chat, code | — | conversationId, layout, welcome | — |
| `chat.header` | available | chat, code | default, minimal, floating | conversationId | default, minimal, floating |
| `chat.welcome` | available | chat, code | default, hero, compact | — | default, hero, compact |
| `chat.message.list` | available | chat, code | — | messages, streaming, readOnly | — |
| `chat.message.item` | available | chat, code | — | message, isStreaming, isGroupStart, readOnly | — |
| `chat.message.user` | available | chat, code | bubble, plain, card, compact | message, conversationId | bubble, plain, card, compact |
| `chat.message.assistant` | available | chat, code | plain, card, framed, compact | message, conversationId, isStreaming | plain, card, framed, compact |
| `chat.message.system` | available | chat, code | — | message | — |
| `chat.message.goal-round` | available | chat, code | — | message | — |
| `chat.message.avatar` | available | chat, code | — | role, message | — |
| `chat.message.markdown` | available | chat, code | — | content, streaming | — |
| `chat.message.reasoning` | available | chat, code | — | message | — |
| `chat.message.tool-group` | reserved | chat, code | — | message | — |
| `chat.message.tool-row` | reserved | chat, code | — | tool | — |
| `chat.turn.error` | available | chat, code | — | code, hint, planProvider, usageUrl | — |
| `chat.queue.bar` | available | chat, code | — | conversationId | — |
| `chat.composer` | available | chat, code | card, flat, outline, dock | — | card, flat, outline, dock |
| `chat.composer.input` | reserved | chat, code | — | — | — |
| `sidebar.nav.item` | available | chat, code, agent | default, pill, underline | icon, label, active, badge, onSelect | default, pill, underline |
| `sidebar.conversation.row` | available | chat, code | default, compact, card | conversation, active | default, compact, card |
| `code.workbench` | available | code | — | — | — |
| `code.session.header` | available | code | — | — | — |
| `code.tab.strip` | reserved | code | default, segmented, underline | — | default, segmented, underline |
| `code.panel` | available | code | — | — | — |
| `code.welcome` | available | code | — | — | — |
| `agent.workspace` | available | agent | — | — | — |
| `agent.sidebar` | available | agent | — | — | — |
| `agent.tab.strip` | reserved | agent | default, segmented, underline | — | default, segmented, underline |
| `agent.thread.view` | available | agent | — | agentId, conversationId | — |
| `agent.channel.view` | reserved | agent | — | channelId | — |
| `agent.channel.message` | reserved | agent | — | message, channelId | — |
| `agent.channel.composer` | reserved | agent | — | channelId | — |
| `agent.panel` | available | agent | — | — | — |
| `settings.dialog` | available | chat, code, agent | default, wide, compact | — | default, wide, compact |
| `settings.page` | available | chat, code, agent | — | tab | — |
| `settings.rail` | available | chat, code, agent | — | — | — |
| `plugins.view` | available | chat, code, agent | — | — | — |
| `plugins.detail` | available | chat, code, agent | — | pluginId | — |
| `artifact.panel` | available | chat, code, agent | — | — | — |
| `artifact.preview` | available | chat, code, agent | — | artifactId | — |
| `palette.dialog` | available | chat, code, agent | — | — | — |

### Style recipe enums

| Recipe key | Allowed values |
| --- | --- |
| `surface` | `background`, `surface`, `surface-raised`, `surface-hover`, `surface-active`, `accent-soft`, `user-bubble`, `assistant-bubble`, `code-bg`, `transparent` |
| `foreground` | `foreground`, `foreground-muted`, `foreground-subtle`, `accent-foreground` |
| `radius` | `none`, `sm`, `md`, `lg`, `xl`, `2xl`, `full` |
| `padding` | `0`, `1`, `2`, `3`, `4`, `5`, `6` |
| `gap` | `0`, `1`, `2`, `3`, `4` |
| `shadow` | `none`, `sm`, `md`, `lg` |
| `width` | `auto`, `full`, `prose`, `wide` |
| `align` | `start`, `center`, `end` |
| `density` | `compact`, `comfortable`, `spacious` |
| `text` | `xs`, `sm`, `base`, `lg` |
| `avatar` | `show`, `hide` |
| `motion` | `none`, `fade`, `slide` |
### Theme tokens

| Token | Class |
| --- | --- |
| `--background` | required |
| `--surface` | required |
| `--surface-raised` | required |
| `--surface-hover` | required |
| `--surface-active` | required |
| `--foreground` | required |
| `--foreground-muted` | required |
| `--foreground-subtle` | required |
| `--border` | required |
| `--border-strong` | required |
| `--accent` | required |
| `--accent-hover` | required |
| `--accent-foreground` | required |
| `--accent-soft` | required |
| `--success` | required |
| `--success-soft` | required |
| `--warning` | required |
| `--warning-soft` | required |
| `--danger` | required |
| `--danger-soft` | required |
| `--user-bubble` | required |
| `--code-bg` | required |
| `--terminal-selection` | required |
| `--accent-ring` | optional color |
| `--context-system` | optional color |
| `--context-tools` | optional color |
| `--context-messages` | optional color |
| `--assistant-bubble` | optional color |
| `--terminal-ansi-black` | optional color |
| `--terminal-ansi-red` | optional color |
| `--terminal-ansi-green` | optional color |
| `--terminal-ansi-yellow` | optional color |
| `--terminal-ansi-blue` | optional color |
| `--terminal-ansi-magenta` | optional color |
| `--terminal-ansi-cyan` | optional color |
| `--terminal-ansi-white` | optional color |
| `--terminal-ansi-bright-black` | optional color |
| `--terminal-ansi-bright-red` | optional color |
| `--terminal-ansi-bright-green` | optional color |
| `--terminal-ansi-bright-yellow` | optional color |
| `--terminal-ansi-bright-blue` | optional color |
| `--terminal-ansi-bright-magenta` | optional color |
| `--terminal-ansi-bright-cyan` | optional color |
| `--terminal-ansi-bright-white` | optional color |
| `--radius-xs` | optional length |
| `--radius-sm` | optional length |
| `--radius-md` | optional length |
| `--radius-lg` | optional length |
| `--radius-xl` | optional length |
| `--radius-2xl` | optional length |
| `--radius-3xl` | optional length |

### Icons accepted by declarative contributions

`Plug`, `Puzzle`, `Sparkles`, `GitBranch`, `Globe`, `Database`, `Terminal`, `PanelRight`, `LayoutGrid`, `Wand2`, `Bot`, `Zap`, `ListChecks`, `Library`. Unknown icons fall back to `Puzzle`.
<!-- END GENERATED:contract -->

## Sandbox runtime

A sandboxed plugin is an HTML package loaded in an iframe without
`allow-same-origin`. The host serves `/@zylara/sdk.js`; it installs
`window.ZylaraPlugin`. The iframe must not assume host DOM access.

```html
<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 13px system-ui; color: var(--foreground); background: transparent; }
  button { height: 28px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-foreground); }
</style>
<body>
  <button id="run">Run</button>
  <script src="/@zylara/sdk.js"></script>
  <script>
    ZylaraPlugin.on('init', ({ context, theme, localeBundle }) => {
      document.documentElement.dataset.reduceMotion = String(theme.reduceMotion);
      ZylaraPlugin.resize();
    });
    document.getElementById('run').onclick = () =>
      ZylaraPlugin.rpc('notify', { title: 'Hello', body: 'From the plugin' });
  </script>
</body>
```

`PluginApi` (exact surface):

| Member | Contract |
|---|---|
| `pluginId` | string |
| `locale` | active locale string |
| `context` | `{ conversationId, layoutMode, pluginId, viewId/panelId/tab, ... }` |
| `theme` | `{ tokens: Record<string,string>, dark: boolean, reduceMotion: boolean }` |
| `ui` | `openPage(pageId, {layout?})`, `openPanelTab(tabId, {layout?})`, `closePanelTab()`, `setLayout(layout)`, `openSettings(tab?)`, `toast(title, body?)`, `setBadge(navId, badge)` |
| `rpc(method, params?)` | mediated RPC; see `plugin-agent` |
| `on(event, handler)` | returns unsubscribe; `onEvent` is an alias |
| `onGenui(handler)` | receives GenUI props for a trusted/sandbox GenUI render |
| `onTool(handler)` | receives `{tool, arguments}`; return `ToolResult` or string |
| `t(key, fallback?)` | plugin locale lookup |
| `notify(message)` | mediated notification |
| `resize()` | report iframe content size |
| `openView(id)` / `openPanel(id)` | open own contributions only |
| `closeOverlays()` | close own page/panel |
| `openExternal(url)` | HTTPS/http external link |
| `ready()` | mark the iframe ready |

`PluginInit` has `type`, `pluginId`, `locale`, `theme`, `localeBundle`, `context`
and `kind`. `ToolResult` is `{ content: string, summary?: string, isError?:
boolean, presentation?: unknown, images?: Array<{mimeType,dataBase64,width?,
height?}> }`.

## Contribution semantics

- **slots**: `list`, `keyed`, `chain` and `hoc` slots. List slots stack entries;
  keyed slots match `entryKey`/`key`; chain slots elect one entry using `when`
  or a trusted `select`; HOC slots wrap a host component and are trusted-only.
  Every slot entry needs `ui.slot:<slot>`. Use generated props for `when`.
- **views**: a page in the center or sidebar. `surface` selects the layout; v2
  `layouts` controls visibility. Use `entry` for sandbox HTML or `component` for
  a trusted React component.
- **nav**: sidebar entry; `page` must be a view id or host page. Requires
  `ui.nav`; icons use the host whitelist (generated in the contract).
- **panels**: right dock; `tab: true` is a tab, `tab: false` takes over the
  dock. Requires `ui.panel`.
- **commands**: command palette and `/` entries. `action` is declarative; a
  command can also be backed by `registerCommandHandler` in trusted code.
  Requires `ui.command`; `hotkey` also requires `hotkeys`.
- **settingsTabs**: settings page, `entry` or `component`. Requires
  `ui.settings`.
- **themes**: light/dark maps of allowlisted tokens. Requires `ui.theme`.
- **variants**: declarative recipe for a host component that supports variants.
  Recipes use only `surface`, `foreground`, `radius`, `padding`, `gap`, `shadow`,
  `width`, `align`, `text`, `density` with the generated enum values.
  Requires `ui.variant`.
- **presets**: theme tokens + density + optional variant map + optional CSS.
  Requires `ui.preset`; CSS also requires `ui.css.global`.
- **css**: package CSS file, sanitized and scoped to the declared layouts.
  Requires `ui.css.global`; no `@import`, `expression`, `-moz-binding`,
  `javascript:` or external `url()`. Package relative assets are rewritten.
- **artifactViewers**: MIME viewers for the artifact preview. Requires
  `ui.artifact`.
- **commands actions**: see the action table in `plugin-manifest`.

## Layout and i18n

- `layouts` defaults to all three only when omitted in v1; v2 requires explicit
  layouts. Never show a Code-only contribution in Chat/Agent by accident.
- Ship `locales/en.json`, `locales/pt-BR.json`, `locales/es.json`. Reference
  keys in `titleKey`/`descriptionKey`; fallback to `title`/`description`.
- Use theme tokens (`--background`, `--surface`, `--surface-raised`,
  `--foreground`, `--foreground-muted`, `--foreground-subtle`, `--border`,
  `--accent`, `--accent-soft`, `--radius-*`, `--font-*`). Do not hardcode host
  colors. Respect `theme.dark` and `theme.reduceMotion`.
- CSS may target your own package classes. Host DOM classes and attributes are
  not a public API; do not depend on Tailwind internals or host structure.
  Global CSS is trusted-only and should be scoped defensively.

## Commands and actions

Declarative actions run in the host. Use `insertDraft` to place text in the
composer (requires `chat.write`), `openView`/`openPanelTab` for own surfaces,
`openExternal` for links, `openSettings` for settings, and `execute` for a
registered trusted command handler. Actions never send a message by themselves.

## Verification

- The page loads from a package-relative entry and calls `resize()` after
  render.
- The iframe has no host DOM access; all privileged work goes through RPC.
- Every UI contribution has its permission and explicit `layouts`.
- Theme/i18n keys resolve in all three locales; no hardcoded interface copy.
- CSS uses package-relative assets and no forbidden directives.
