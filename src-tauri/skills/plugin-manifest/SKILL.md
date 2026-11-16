---
name: plugin-manifest
description: Complete Zylara plugin manifest reference: v1/v2 fields, contribution types, permissions, ids, limits, validation rules, action kinds and the exact contract tables. Read before writing or changing manifest.json.
---

# Plugin manifest

The manifest is `manifest.json` at the root of the package. It is parsed and
validated before extraction; every error names the field and value. This skill
contains the entire contract. Do not read application documentation.

## Shape

```json
{
  "schemaVersion": 2,
  "id": "com.acme.notes",
  "name": "Acme Notes",
  "version": "1.0.0",
  "description": "Notes for the current conversation.",
  "author": "Acme",
  "homepage": "https://acme.example",
  "icon": "assets/icon.svg",
  "apiVersion": 2,
  "engines": { "zylara": ">=0.10.0 <1.0.0" },
  "publisher": { "id": "acme", "name": "Acme", "keyId": "studio-notes" },
  "permissions": ["ui.view", "ui.nav", "ui.slot:chat.message.actions"],
  "contributes": {
    "ui": {},
    "tools": [],
    "promptSections": [],
    "skills": [],
    "locales": [],
    "providers": [],
    "artifactViewers": []
  },
  "runtime": { "ui": "sandbox", "backend": { "kind": "js", "entry": "backend/index.html" } }
}
```

`contributes` is optional as a whole and each child is optional. `runtime` is
optional and defaults to no UI. Every declared contribution requires its
permission; a contribution without its permission is rejected.

## Generated contract tables

<!-- BEGIN GENERATED:contract -->
### Layouts

`chat`, `code`, `agent`

### Host pages

`chat`, `skills`, `library`, `plugins`, `team`, `stats`, `routines`

### Slots

Reserved slots are not mounted by this host version; a manifest that targets one is rejected.

| Slot | Kind | Scope | Layouts | Modes | Props | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `titlebar.actions` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Actions in the window title bar. |
| `chat.sidebar.header` | list | layout | chat | declarative, sandbox, trusted | — | Header of the chat sidebar. |
| `chat.sidebar.footer` | list | layout | chat | declarative, sandbox, trusted | — | Footer of the chat sidebar. |
| `sidebar.nav.before` | list | layout | chat, code, agent | declarative, sandbox, trusted | — | Content before the navigation items. |
| `sidebar.nav.after` | list | layout | chat, code, agent | declarative, sandbox, trusted | — | Content after the navigation items. |
| `agent.sidebar.footer` | list | layout | agent | declarative, sandbox, trusted | — | Footer of the agents sidebar. |
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
| `chat.message.usage` | single | message | chat, code | trusted | — | Token/usage footer of a message. |
| `chat.message.usage.actions` | list | message | chat, code | declarative, sandbox, trusted | — | Actions next to the usage footer. |
| `chat.message.attachments.frame` | hoc | message | chat, code | trusted | attachments | Wraps message attachment chips. |
| `chat.message.artifacts.frame` | hoc | message | chat, code | trusted | artifacts | Wraps message artifact cards. |
| `chat.message.citations.frame` | hoc | message | chat, code | trusted | citations | Wraps message citations. |
| `chat.message.actions` | list | message | chat, code | declarative, sandbox, trusted | — | Actions after each message. |
| `chat.markdown.fence` | keyed | message | chat, code | trusted | language, code | Fence renderer keyed by language. |
| `chat.turn.error.frame` | hoc | conversation | chat, code | trusted | — | Wraps the turn error banner. |
| `chat.queue.frame` | hoc | conversation | chat, code | trusted | — | Wraps the queued message bar. |
| `chat.composer.frame` | hoc | composer | chat, code | trusted | — | Wraps the composer card. |
| `chat.composer.toolbar` | list | composer | chat, code | declarative, sandbox, trusted | draft | Composer toolbar items. |
| `chat.composer.actions` | list | composer | chat, code | declarative, sandbox, trusted | streaming, canSend | Actions next to send/stop. |
| `chat.composer.attachments` | list | composer | chat, code | declarative, sandbox, trusted | — | Content above the composer input. |
| `chat.composer.slash` | list | composer | chat, code | declarative, sandbox, trusted | query | Extra slash-command rows. |
| `chat.welcome.actions` | list | layout | chat, code | declarative, sandbox, trusted | — | Actions on the welcome screen. |
| `chat.welcome.suggestions` | list | layout | chat, code | declarative, sandbox, trusted | — | Suggestion chips on the welcome screen. |
| `code.header.actions` | list | conversation | code | declarative, sandbox, trusted | workspaceId | Actions in the code session header. |
| `code.panel.header` | list | layout | code | declarative, sandbox, trusted | — | Header of the code right panel. |
| `code.panel.tabs` | list | layout | code | declarative, sandbox, trusted | — | Extra tabs in the code right panel. |
| `agent.panel.tabs` | list | layout | agent | declarative, sandbox, trusted | — | Extra tabs in the agent right panel. |
| `right.panel.header` | list | layout | chat, code, agent | declarative, sandbox, trusted | — | Header of the right dock. |
| `settings.plugins.header` | list | root | chat, code, agent | declarative, sandbox, trusted | — | Header of the plugins settings tab. |
| `plugins.detail.actions` | list | root | chat, code, agent | declarative, sandbox, trusted | pluginId | Actions in the plugin detail dialog. |
| `artifact.preview.toolbar` | list | root | chat, code, agent | declarative, sandbox, trusted | artifactId, artifactKind, mimeType | Toolbar of the artifact preview. |

### Components

Components marked `reserved` still support variants/presets but cannot be replaced or wrapped in this host version.

| Component | Override | Layouts | Variants | Props | Built-in recipes |
| --- | --- | --- | --- | --- | --- |
| `layout.shell` | available | chat, code, agent | — | children, sidebar, sidebarLabel, rightPanel, rightPanelOpen | — |
| `layout.titlebar` | available | chat, code, agent | — | — | — |
| `layout.sidebar` | available | chat, code, agent | — | layout, onClose | — |
| `layout.center` | available | chat, code, agent | — | — | — |
| `layout.right-panel` | reserved | chat, code, agent | default, flush, card | layout | default, flush, card |
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
| `chat.turn.error` | reserved | chat, code | — | code, hint, planProvider, usageUrl | — |
| `chat.queue.bar` | reserved | chat, code | — | conversationId | — |
| `chat.composer` | available | chat, code | card, flat, outline, dock | — | card, flat, outline, dock |
| `chat.composer.input` | reserved | chat, code | — | — | — |
| `sidebar.nav.item` | available | chat, code, agent | default, pill, underline | icon, label, active, badge, onSelect | default, pill, underline |
| `sidebar.conversation.row` | reserved | chat, code | default, compact, card | conversation, active | default, compact, card |
| `code.workbench` | reserved | code | — | — | — |
| `code.session.header` | reserved | code | — | — | — |
| `code.tab.strip` | reserved | code | default, segmented, underline | — | default, segmented, underline |
| `code.panel` | reserved | code | — | — | — |
| `code.welcome` | reserved | code | — | — | — |
| `agent.workspace` | reserved | agent | — | — | — |
| `agent.sidebar` | reserved | agent | — | — | — |
| `agent.tab.strip` | reserved | agent | default, segmented, underline | — | default, segmented, underline |
| `agent.thread.view` | reserved | agent | — | agentId, conversationId | — |
| `agent.channel.view` | reserved | agent | — | channelId | — |
| `agent.channel.message` | reserved | agent | — | message, channelId | — |
| `agent.channel.composer` | reserved | agent | — | channelId | — |
| `agent.panel` | reserved | agent | — | — | — |
| `settings.dialog` | available | chat, code, agent | default, wide, compact | — | default, wide, compact |
| `settings.page` | reserved | chat, code, agent | — | tab | — |
| `settings.rail` | reserved | chat, code, agent | — | — | — |
| `plugins.view` | available | chat, code, agent | — | — | — |
| `plugins.detail` | reserved | chat, code, agent | — | pluginId | — |
| `artifact.panel` | reserved | chat, code, agent | — | — | — |
| `artifact.preview` | reserved | chat, code, agent | — | artifactId | — |
| `palette.dialog` | reserved | chat, code, agent | — | — | — |

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
| `chat.read` | no | no | high | Read conversations selected by the user. |
| `chat.write` | no | no | high | Insert text into the composer draft. |
| `fs.read` | yes | no | high | Read files granted by a glob scope. |
| `fs.write` | yes | no | high | Write files granted by a glob scope. |
| `net` | yes | no | high | Perform HTTP requests to allowlisted hosts. |
| `process.spawn` | no | yes | critical | Run a native sidecar process. Trusted plugins only. |
| `secrets.use` | no | no | medium | Use a namespaced secret through mediated HTTP without reading it. |
| `secrets.read` | no | yes | critical | Read a namespaced secret. Trusted plugins only. |
| `storage` | no | no | low | Use plugin-scoped key/value storage. |
| `events` | yes | no | medium | Subscribe to normalized host events. |
| `clipboard.read` | no | no | high | Read the system clipboard. |
| `notifications` | no | no | low | Show desktop and in-app notifications. |
| `dialog` | no | no | medium | Open native file dialogs. |
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

### UI limits

| UI limit | Value |
| --- | --- |
| `slotEntriesPerPlugin` | 64 |
| `navEntriesPerPlugin` | 16 |
| `pagesPerPlugin` | 16 |
| `panelTabsPerPlugin` | 16 |
| `variantsPerPlugin` | 32 |
| `presetsPerPlugin` | 8 |
| `cssCharsPerPlugin` | 200000 |
| `genuiComponentsPerPlugin` | 8 |
| `genuiSchemaChars` | 8192 |
| `genuiPromptCharsPerPlugin` | 2000 |
<!-- END GENERATED:contract -->

## Full JSON Schema

<!-- BEGIN GENERATED:manifest-schema -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://zylara.app/schemas/plugin-manifest.schema.json",
  "title": "Zylara plugin manifest",
  "description": "Canonical manifest.json shipped inside a .zplugin package. The Rust validator in src-tauri/src/plugins/manifest.rs is authoritative; this schema mirrors it for editors and CI.",
  "type": "object",
  "required": [
    "schemaVersion",
    "id",
    "name",
    "version",
    "apiVersion",
    "publisher"
  ],
  "properties": {
    "schemaVersion": {
      "enum": [
        1,
        2
      ]
    },
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:[.-][a-z0-9]+)+$",
      "maxLength": 128
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "version": {
      "type": "string",
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
    },
    "apiVersion": {
      "enum": [
        1,
        2
      ]
    },
    "description": {
      "type": "string",
      "maxLength": 4000
    },
    "author": {
      "type": "string",
      "maxLength": 200
    },
    "homepage": {
      "type": "string",
      "format": "uri"
    },
    "icon": {
      "type": "string",
      "maxLength": 256
    },
    "trusted": {
      "type": "boolean",
      "default": false
    },
    "engines": {
      "type": "object",
      "properties": {
        "zylara": {
          "type": "string",
          "maxLength": 128
        }
      },
      "additionalProperties": true
    },
    "publisher": {
      "type": "object",
      "required": [
        "id",
        "name"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9._-]*$",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "keyId": {
          "type": "string",
          "maxLength": 128
        },
        "homepage": {
          "type": "string",
          "format": "uri"
        }
      },
      "additionalProperties": false
    },
    "permissions": {
      "type": "array",
      "uniqueItems": true,
      "maxItems": 64,
      "items": {
        "type": "string",
        "pattern": "^(unsafe\\.renderer|ui\\.slot:[a-z0-9.]+|ui\\.override:[a-z0-9.-]+|ui\\.view|ui\\.nav|ui\\.panel|ui\\.command|ui\\.settings|ui\\.theme|ui\\.variant|ui\\.preset|ui\\.genui|ui\\.artifact|ui\\.shell|ui\\.css\\.global|commands|hotkeys|chat\\.read|chat\\.write|opener|agents\\.read|agents\\.write|agent\\.tools|agent\\.prompt|agent\\.skills|providers|storage|settings|secrets\\.use|secrets\\.read|clipboard\\.read|notify|notifications|dialog|events|fs\\.read:.+|fs\\.write:.+|net:.+|process\\.spawn)$"
      }
    },
    "runtime": {
      "type": "object",
      "properties": {
        "ui": {
          "enum": [
            "none",
            "declarative",
            "sandbox",
            "trusted"
          ]
        },
        "entry": {
          "type": "string"
        },
        "backend": {
          "type": "object",
          "required": [
            "kind",
            "entry"
          ],
          "properties": {
            "kind": {
              "const": "js"
            },
            "entry": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "contributes": {
      "type": "object",
      "properties": {
        "ui": {
          "type": "object",
          "properties": {
            "slots": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/slot"
              }
            },
            "views": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/view"
              }
            },
            "nav": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/nav"
              }
            },
            "panels": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/panel"
              }
            },
            "commands": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/command"
              }
            },
            "settingsTabs": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/settingsTab"
              }
            },
            "themes": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/theme"
              }
            },
            "variants": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/variant"
              }
            },
            "presets": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/preset"
              }
            },
            "css": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/css"
              }
            },
            "genui": {
              "$ref": "#/$defs/genui"
            }
          },
          "additionalProperties": false
        },
        "tools": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/$defs/tool"
              }
            }
          ]
        },
        "promptSections": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/promptSection"
          }
        },
        "skills": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "locales": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "providers": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/provider"
          }
        },
        "artifactViewers": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/artifactViewer"
          }
        }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false,
  "$defs": {
    "action": {
      "type": "object",
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "enum": [
            "openView",
            "openPage",
            "openPanel",
            "openPanelTab",
            "setLayout",
            "openSettings",
            "setVariant",
            "setPreset",
            "insertDraft",
            "openExternal",
            "execute"
          ]
        },
        "target": {
          "type": "string",
          "maxLength": 128
        },
        "layout": {
          "enum": [
            "chat",
            "code",
            "agent"
          ]
        },
        "component": {
          "type": "string",
          "maxLength": 64
        },
        "text": {
          "type": "string",
          "maxLength": 16000
        },
        "url": {
          "type": "string",
          "format": "uri",
          "pattern": "^https://"
        },
        "method": {
          "type": "string"
        },
        "params": {}
      },
      "additionalProperties": false
    },
    "slot": {
      "type": "object",
      "required": [
        "slot"
      ],
      "properties": {
        "slot": {
          "type": "string"
        },
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,63}$"
        },
        "entry": {
          "type": "string"
        },
        "component": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "titleKey": {
          "type": "string"
        },
        "icon": {
          "type": "string"
        },
        "action": {
          "$ref": "#/$defs/action"
        },
        "declarative": {
          "type": "boolean"
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "order": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "priority": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "key": {
          "type": "string",
          "maxLength": 64
        },
        "when": {
          "type": "object",
          "additionalProperties": {
            "type": [
              "string",
              "number",
              "boolean"
            ]
          }
        }
      },
      "additionalProperties": false
    },
    "view": {
      "type": "object",
      "required": [
        "id",
        "title"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "titleKey": {
          "type": "string"
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "descriptionKey": {
          "type": "string"
        },
        "icon": {
          "type": "string"
        },
        "surface": {
          "enum": [
            "chat",
            "code",
            "agent",
            "global"
          ]
        },
        "location": {
          "enum": [
            "main",
            "sidebar"
          ]
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "order": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "entry": {
          "type": "string"
        },
        "component": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "nav": {
      "type": "object",
      "required": [
        "id",
        "title",
        "icon",
        "page"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,63}$"
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "titleKey": {
          "type": "string"
        },
        "icon": {
          "type": "string"
        },
        "page": {
          "type": "string",
          "maxLength": 64
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "order": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "badge": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 24
        }
      },
      "additionalProperties": false
    },
    "variant": {
      "type": "object",
      "required": [
        "component",
        "id",
        "title",
        "recipe"
      ],
      "properties": {
        "component": {
          "type": "string",
          "maxLength": 64
        },
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,63}$"
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "recipe": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        }
      },
      "additionalProperties": false
    },
    "preset": {
      "type": "object",
      "required": [
        "id",
        "title"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,63}$"
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "tokens": {
          "type": "object",
          "properties": {
            "light": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 300
              }
            },
            "dark": {
              "type": "object",
              "additionalProperties": {
                "type": "string",
                "maxLength": 300
              }
            }
          },
          "additionalProperties": false
        },
        "density": {
          "enum": [
            "compact",
            "comfortable",
            "spacious"
          ]
        },
        "variants": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "css": {
          "type": [
            "string",
            "null"
          ],
          "maxLength": 200000
        }
      },
      "additionalProperties": false
    },
    "css": {
      "type": "object",
      "required": [
        "id",
        "file"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,63}$"
        },
        "file": {
          "type": "string"
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "order": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        }
      },
      "additionalProperties": false
    },
    "genui": {
      "type": "object",
      "properties": {
        "components": {
          "type": "array",
          "maxItems": 8,
          "items": {
            "$ref": "#/$defs/genuiComponent"
          }
        }
      },
      "additionalProperties": false
    },
    "genuiComponent": {
      "type": "object",
      "required": [
        "id",
        "title",
        "summary",
        "props",
        "render"
      ],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{0,63}$"
        },
        "title": {
          "type": "string",
          "maxLength": 80
        },
        "summary": {
          "type": "string",
          "maxLength": 160
        },
        "props": {
          "type": "object",
          "maxProperties": 16,
          "additionalProperties": {
            "type": "object"
          }
        },
        "render": {
          "type": "object",
          "required": [
            "kind"
          ],
          "properties": {
            "kind": {
              "enum": [
                "trusted",
                "sandbox"
              ]
            },
            "component": {
              "type": "string",
              "maxLength": 64
            },
            "entry": {
              "type": "string"
            },
            "height": {
              "type": "integer",
              "minimum": 80,
              "maximum": 480
            }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "panel": {
      "type": "object",
      "required": [
        "id",
        "title"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "titleKey": {
          "type": "string"
        },
        "icon": {
          "type": "string"
        },
        "entry": {
          "type": "string"
        },
        "component": {
          "type": "string"
        },
        "dock": {
          "enum": [
            "right"
          ]
        },
        "tab": {
          "type": "boolean"
        },
        "layouts": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": {
            "enum": [
              "chat",
              "code",
              "agent"
            ]
          }
        },
        "order": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        }
      },
      "additionalProperties": false
    },
    "command": {
      "type": "object",
      "required": [
        "id",
        "title",
        "action"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "titleKey": {
          "type": "string"
        },
        "description": {
          "type": "string",
          "maxLength": 500
        },
        "descriptionKey": {
          "type": "string"
        },
        "command": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9-]{0,31}$"
        },
        "keywords": {
          "type": "string",
          "maxLength": 500
        },
        "icon": {
          "type": "string"
        },
        "hotkey": {
          "type": "string",
          "maxLength": 80
        },
        "action": {
          "$ref": "#/$defs/action"
        }
      },
      "additionalProperties": false
    },
    "settingsTab": {
      "type": "object",
      "required": [
        "id",
        "title"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "titleKey": {
          "type": "string"
        },
        "icon": {
          "type": "string"
        },
        "order": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "entry": {
          "type": "string"
        },
        "component": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "theme": {
      "type": "object",
      "required": [
        "id",
        "name",
        "light",
        "dark"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "maxLength": 120
        },
        "light": {
          "type": "object",
          "maxProperties": 64,
          "propertyNames": {
            "pattern": "^(--)?[a-z0-9-]+$"
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 64
          }
        },
        "dark": {
          "type": "object",
          "maxProperties": 64,
          "propertyNames": {
            "pattern": "^(--)?[a-z0-9-]+$"
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 64
          }
        }
      },
      "additionalProperties": false
    },
    "tool": {
      "type": "object",
      "required": [
        "name",
        "description"
      ],
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9_]{0,31}$"
        },
        "description": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2000
        },
        "parameters": {
          "type": "object",
          "required": [
            "type"
          ],
          "properties": {
            "type": {
              "const": "object"
            }
          }
        },
        "risk": {
          "enum": [
            "read",
            "network",
            "write",
            "shell"
          ]
        },
        "profiles": {
          "type": "array",
          "items": {
            "enum": [
              "chat",
              "code"
            ]
          },
          "minItems": 1
        },
        "timeoutSecs": {
          "type": "integer",
          "minimum": 1,
          "maximum": 600
        }
      },
      "additionalProperties": false
    },
    "promptSection": {
      "type": "object",
      "required": [
        "id",
        "file"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "file": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "provider": {
      "type": "object",
      "required": [
        "id",
        "name",
        "baseUrl",
        "models"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "maxLength": 120
        },
        "shortName": {
          "type": "string",
          "maxLength": 40
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "baseUrl": {
          "type": "string",
          "pattern": "^https://"
        },
        "consoleUrl": {
          "type": "string",
          "format": "uri"
        },
        "endpoints": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "models": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "required": [
              "id",
              "name"
            ],
            "properties": {
              "id": {
                "type": "string",
                "maxLength": 128
              },
              "name": {
                "type": "string",
                "maxLength": 120
              },
              "protocols": {
                "type": "array",
                "items": {
                  "const": "openai-chat"
                }
              },
              "contextWindow": {
                "type": "integer",
                "minimum": 1024
              },
              "maxOutput": {
                "type": "integer",
                "minimum": 1
              },
              "reasoning": {
                "type": "boolean"
              },
              "attachment": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    },
    "artifactViewer": {
      "type": "object",
      "required": [
        "id",
        "title",
        "mimeTypes",
        "entry"
      ],
      "properties": {
        "id": {
          "type": "string",
          "maxLength": 64
        },
        "title": {
          "type": "string",
          "maxLength": 120
        },
        "titleKey": {
          "type": "string"
        },
        "priority": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "mimeTypes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "maxLength": 120
          }
        },
        "entry": {
          "type": "string"
        },
        "component": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  }
}
```
<!-- END GENERATED:manifest-schema -->

## Validation rules

- `schemaVersion` and `apiVersion` are `1` or `2`. `apiVersion: 2` requires
  `schemaVersion: 2`. Prefer v2 for everything new.
- `id` is lowercase ASCII, at least two segments separated by `.` or `-`, at
  most 128 characters. Reserved namespaces are rejected. Use a reverse-domain
  or publisher-product id (`com.acme.notes`).
- `name` is 1–80 characters. `description` is at most 4,000 characters.
  `version` is SemVer. `engines.zylara` is a semver range; `>=0.10.0 <1.0.0` is
  the safe default.
- `publisher.id` matches `^[a-z0-9][a-z0-9._-]*$` (max 64); `publisher.name` is
  1–120; `publisher.keyId` is at most 120 and must match the studio signature.
  Do not edit the publisher block created by `plugin_studio init`.
- `permissions` is unique, at most 64 entries. Scoped permissions require a
  scope: `ui.slot:<slot>`, `ui.override:<component>`, `net:<host>`,
  `fs.read:<glob>`, `fs.write:<glob>`, `events:<scope>`. Unknown permissions are
  rejected. Trusted-only permissions require `runtime.ui: "trusted"` and
  `"trusted": true`.
- `runtime.ui` is `none`, `declarative`, `sandbox` or `trusted`.
  `runtime.backend.kind` is only `js`; its `entry` is package-relative.
  `runtime.entry` is the trusted `main.js` evaluated by the host.
- In v2, `layouts` is required on views, nav, panels, slots, variants, presets and
  CSS; use a non-empty subset of `chat`, `code`, `agent`. Omit it only for
  contributions that explicitly allow all layouts.
- Slots: `slot` must exist in the contract and accept the chosen mode. A slot
  needs exactly one of `entry`, `component` or `action` (except declarative flag
  rules). `key` is required for keyed slots and forbidden otherwise. `when`
  only uses props declared by the slot. `component` is trusted-only; sandbox
  entries are package-relative HTML.
- `views`: `surface` is `chat`, `code`, `agent` or `global`; `location` is
  `main` or `sidebar`; v2 uses `layouts`. A view needs `entry` (sandbox) or
  `component` (trusted).
- `nav`: requires `id`, `title`, `icon`, `page`; `page` must be a view id in the
  manifest or a host page from the generated table. `badge` is at most 24
  characters.
- `panels`: `dock` is `right`; `tab: true` adds a dock tab, `tab: false` takes
  over the dock. A panel needs `entry` or `component`.
- `commands`: `command` is optional and matches
  `^[a-z0-9][a-z0-9-]{0,31}$`; ids are unique. `hotkey` requires the `hotkeys`
  permission and has 1–64 characters, at least one modifier and a supported key.
- `settingsTabs`: needs `entry` or `component`; `ui.settings` permission.
- `themes`: light/dark token maps; only allowlisted theme tokens. Invalid token
  names or values are rejected. `ui.theme` permission.
- `variants`: `component` must be a component id in the generated table with
  variants; `recipe` keys/values must use the style recipe enums. `ui.variant`.
- `presets`: `density` is `compact`, `comfortable` or `spacious`; tokens use
  the theme allowlist; `variants` only references components with variants;
  `css` requires `ui.css.global` and is limited to 200,000 characters.
  `ui.preset`.
- `css`: `file` is package-relative; `ui.css.global`; `order` 0–1000.
- `genui.components`: max 8, unique ids, props max 16, schema max 8 KiB,
  `render.kind` is `sandbox` (entry) or `trusted` (component +
  `unsafe.renderer`), height 80–480.
- `tools`: inline array or package-relative JSON file (max 256 KiB). Tool names
  match `^[a-z0-9][a-z0-9_]{0,31}$`; `risk` is `read`, `network`, `write` or
  `shell`; `profiles` is a non-empty subset of `chat`, `code`; timeout 1–600 s.
  Requires `agent.tools`.
- `promptSections`: package-relative `file`; requires `agent.prompt`; each
  section is capped by the contract prompt limits.
- `skills`: package-relative skill directories; requires `agent.skills`.
- `locales`: package-relative locale directories; `locales/{en,pt-BR,es}.json`.
- `providers`: `baseUrl` must be HTTPS; at least one model; model ids/names
  non-empty; only `openai-chat` protocol; `providers` permission.
- `artifactViewers`: unique ids, non-empty MIME types, `entry` (sandbox) or
  `component` (trusted); `ui.artifact`.
- Paths are relative, use `/`, max 240 characters, no `..`, absolute paths,
  drive letters, ADS, symlinks or reserved Windows names.
- Limits are enforced by the generated table and the package reader: package
  bytes, trusted bytes, file count, unpacked bytes, UI contributions, prompt,
  KV, data, logs, network, RPC and tool results.

## Action kinds

Every action has `kind`; the host rejects unknown fields:

| Kind | Required fields | Notes |
|---|---|---|
| `openView` | `target` | View id in this plugin |
| `openPage` | `target` | Optional `layout` |
| `openPanel` | `target` | Panel id |
| `openPanelTab` | `target` | Optional `layout` |
| `setLayout` | `target` | `chat`, `code`, `agent` |
| `openSettings` | none | Optional `target` settings tab |
| `setVariant` | `component`, `target` | Component must exist with variants |
| `setPreset` | `target` | Optional `layout` |
| `insertDraft` | `text` | Requires `chat.write`; max 20,000 chars |
| `openExternal` | `url` | Must be `http(s)` |
| `execute` | `method` | Optional `params`; max 64 KiB |

A slot may mix `action` with neither `entry` nor `component`. Do not combine
`action` with UI entries.

## Validation errors

`PLUGIN_INVALID: ...`, `PLUGIN_UNSIGNED`, `PLUGIN_ALREADY_INSTALLED`,
`PLUGIN_VERSION_CONFLICT`, `PLUGIN_PERMISSION_DENIED`, `PLUGIN_NOT_ACTIVE`,
`PLUGIN_QUOTA_*`, `PLUGIN_PACKAGE_*`, `PLUGIN_STUDIO_*`. Use the exact error as
feedback, reload this skill and fix the manifest; never invent a workaround.
