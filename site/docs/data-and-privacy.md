---
title: Data and privacy
description: Where your data lives, what leaves the machine, how to back it up and how to erase it.
---

Zylara is local-first. Conversations, attachments, generated files, skills, settings and
credentials live in a folder on your computer, and there is no Zylara account, no analytics
and no telemetry of its own.

## Where data lives

| Platform | Folder |
| --- | --- |
| Windows | `%APPDATA%\app.zylara.chat` (cache also under `%LOCALAPPDATA%\app.zylara.chat`) |
| macOS | `~/Library/Application Support/app.zylara.chat` |
| Linux | `~/.local/share/app.zylara.chat` |

Open it from **Settings → Data → Open folder** or with **Open data folder** in the command
palette.

| Path | Contents |
| --- | --- |
| `zylara.db` | Conversations, messages, artifacts metadata, agents, memories, routines, channels, usage and plugin records (SQLite) |
| `settings.json` | Preferences |
| `secrets.json` (+ `secrets.bak`) | API keys and the ChatGPT session |
| `attachments/` | Files you sent |
| `artifacts/<id>/` | Files the agent created |
| `skills/`, `skills-bundled/` | Your skills and the bundled copies |
| `code-runs/<id>/` | Temporary workspaces for code execution (removed after each run) |
| `themes/` | Installed theme packages |
| `plugins/<id>/<version>/` | Installed plugin files |
| `agent-workspaces/` | Internal folders for agents without a project folder |
| `updates/`, `managed-install.json` | Download cache and managed-install marker |

## Credentials

Keys are written to `secrets.json` by the backend and never sent to the interface: the
renderer receives masked identifiers, e-mail and expiry, not tokens. A corrupted file is
recovered from `secrets.bak`. Plugin secrets use the `plugin:<id>:<key>` namespace, and a
plugin can only learn whether a secret exists, never read it.

The environment is also read (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENCODE_API_KEY`) and an existing OpenCode CLI login is reused, but those values are read
in memory only.

## What leaves the machine

| Destination | When |
| --- | --- |
| The provider API you selected | Every turn, with your credential |
| Bing or DuckDuckGo | Only when the agent searches the web |
| The pages the agent fetches | Only when the agent reads a URL |
| GitHub releases (`release.json`, releases API) | On start and every hour, to check for updates |
| Plugin registries and package URLs | When you install or update a plugin |
| GHCR (container registry) | When you download the computer-use image |
| Microsoft WebView2 bootstrapper | Only during a Windows install that lacks WebView2 |

There is no Zylara relay: requests go straight from your machine to the destination above.
The model catalog is built from models.dev at build time and ships inside the app, so the
picker works offline.

## Back up and restore

Close Zylara, then copy the whole data folder. That single copy contains conversations,
attachments, artifacts, skills, settings and keys.

To restore, close the app, put the folder back in place and start Zylara. Keep the app version
with the backup: a database written by a newer version may not open in an older one.

Two portable exports are also available:

- **Export** on a conversation writes a Markdown file.
- **Export** on an agent writes a `zylara-agent` JSON with its configuration and memories.

Artifacts and attachments are not included in those exports — save them with **Save as…** or
copy the data folder.

## Erase

| Scope | How |
| --- | --- |
| One conversation | `⋯` menu → **Delete** |
| One file | Library or artifact panel → **Delete** |
| Everything in the app | **Settings → Data → Danger zone → Clear data…** (two confirmations) |
| App files on Windows | `Uninstall Zylara.exe`; add **Also remove my data** or `--purge` to delete the data folder too |
| App files on macOS/Linux | Remove the app/package, then delete the data folder manually |

Uninstalling **keeps** conversations, attachments, artifacts, settings and API keys unless you
choose to remove them. The in-app **Clear data…** deletes those items and resets settings to
defaults; it cannot be undone.

## Logs

There is no general application log. Diagnostics live in specific places:

- installer log: `%TEMP%\Zylara-Setup-<date>.log` on Windows;
- managed update log: `install.log` in the data folder;
- plugin activity: the plugin log and audit tables inside `zylara.db`;
- cache diagnostics: **Cache diagnostics** in the command palette.

When reporting a problem, describe the version (**Settings → About**), the provider and model,
and the exact message shown in the app. Do not paste keys.

Next: [Troubleshooting](/docs/troubleshooting).
