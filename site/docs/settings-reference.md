---
title: Settings reference
description: Every settings tab, control, default and range in one place.
---

Open settings with `Ctrl/⌘ ,`, the gear in the sidebar, or **Open settings** in the command
palette. The tabs are always in this order: General, Themes, Design, Terminal, Providers,
Default model, Instructions, Tools, Plugins, Agents, Data, About. Plugins can add their own
tabs at the end.

## General

| Control | Values |
| --- | --- |
| **Theme** | **Light**, **Dark**, **System** |
| **Language** | English (default), Português (Brasil), Español |
| **Text size** | 90%–115%, in 5% steps |
| **Layouts** | Show or hide **Chat**, **Code**, **Agents** |
| **Send with** | `Enter` or `Ctrl/⌘ Enter`; `Shift+Enter` is always a newline |
| **Reduce motion** | Disables transitions and animations |
| **Show token usage** | Tokens and duration under each answer |
| **Reasoning collapsed by default** | Thinking blocks start closed |
| **Auto-compaction threshold** | 50%–90%, default 85% |
| **Keep running in the system tray** | Closing the window keeps turns and schedules alive |

## Themes

Appearance mode, the installed theme list (built-in **Zylara** plus bundled **aurora**,
**ember**, **grove**, **nebula**, **nocturne**), **Install theme…**, **Reload themes**,
**Open themes folder**, and per-theme **Use** / **Active** / **Remove**. See
[Customization](/docs/customization#themes).

## Design

Interface contributed by plugins: layout tabs (**Chat**, **Code**, **Agents**), **Presets**,
**Component variants**, **Disable plugin UI** / **Enable plugin UI**, **Reset this layout**,
**Reset all plugin UI**, plus **Conflicts** and **Active modifications**.

## Terminal

| Control | Default |
| --- | --- |
| Font family | JetBrains Mono Variable |
| Font size | Follows the theme |

## Providers

The featured providers (OpenCode Go, OpenCode Zen, OpenAI, Anthropic, Gemini), **See more
providers** for the other 21, **Connect** / **Manage** per provider, the API key field,
**Test connection**, **Refresh models**, **Console** (provider dashboard), **Open data
folder**.

**OpenAI** additionally shows **Continue with ChatGPT**, **Copy link**, **Sign out**,
**Use API key as fallback** and plan usage when signed in.

**Add provider** registers a custom OpenAI-compatible endpoint; `http://` is only accepted for
localhost.

**Reliability** per provider:

| Control | Default |
| --- | --- |
| **Response headers timeout (s)** | 120 |
| **First token timeout (s)** | 180 |
| **Stream idle timeout (s)** | 120 |
| **Total stream timeout (s)** | 1800 (30 min) |
| **Retries per step** | Provider default |
| **Base backoff (ms)** / **Maximum backoff (ms)** | Provider default |
| **Retry budget (ms)** | Provider default |
| **Maximum Retry-After (ms)** | Provider default |

`0` disables a timeout or the retry budget. See
[Models and providers](/docs/models-and-providers#timeouts-and-retries).

## Default model

Provider, model and default reasoning for new conversations. The model can always be changed
from the composer; this tab only sets the starting point.

## Instructions

A free-text system instruction applied to your conversations, with a character counter and
autosave. It is sent as part of the system prompt, so changing it invalidates the prompt cache
for existing conversations.

## Tools

### Agent tools

| Toggle | Effect |
| --- | --- |
| **Web search** | Offers the search tool to the model |
| **Create files** | Offers artifact creation |
| **Send attachments to the model** | Includes attachment content in requests |
| **Generate automatic title** | Names conversations from their first message |

### Prompt cache

| Control | Values |
| --- | --- |
| **Show indicator** | Shows the cache chip in Chat and the Code context meter |
| **Cache TTL (Anthropic)** | 1 hour (default) or 5 minutes |
| **Cache retention (OpenAI)** | Automatic, In memory, 24 hours |

### Code execution

**Allow code execution** (default off) and **Execution timeout** (10–600 s, default 120).
See [Code execution](/docs/code-execution).

### Command sandbox

**Environment** (**This computer** or **Docker**), **Docker image** (default
`node:22-bookworm`), **Network in the container**, **Memory (MB)**, **CPUs**, **PIDs**,
**Read-only rootfs**, **Validate image**, **Download image**. See
[Permissions and approvals](/docs/permissions-and-approvals#docker-command-sandbox).

### Code sessions

| Control | Values |
| --- | --- |
| **Default permission mode** | **Read only**, **Review**, **Edit**, **Autonomous** |
| **Open file diff** | **In a chat tab (default)** or **In the side panel** |

### Code environment

Python and Node detection (configured path or `PATH`), versions, **Check again**, the optional
package list (`python-docx`, `openpyxl`, `python-pptx`, `reportlab`, `Pillow`) and **Copy
installation command**.

### Skills

**Skills panel in the sidebar**, counts by source, **Manage skills**, **Open skills folder**.
See [Skills](/docs/skills).

## Plugins

**Enable plugins**, **Automatic updates**, **Allow trusted plugins**, **Developer mode**,
**Safe mode**, **Registry URLs**, **Disable all plugins**. See [Plugins](/docs/plugins).

## Agents

| Section | Controls |
| --- | --- |
| **Execution and queue** | Global concurrent turns, turns per agent (default 1), queued messages per thread |
| **Budget** | Daily limit per agent, in US$ |
| **Notifications** | Enabled, **Do not disturb**, **Approvals**, **Questions**, **Completions**, **Tasks** |
| **Controlled browser** | Allowed hosts, blocked hosts, private hosts, browser in routines |
| **Desktop apps** | Allowed and blocked applications for computer use |
| **Private desktop** | Image, container state, actions per turn (20), actions per hour (120), cleanup, diagnostics |

See [Agents](/docs/agents) and [Computer use](/docs/computer-use).

## Data

| Section | Contents |
| --- | --- |
| **Storage** | The data folder path and **Open folder** |
| **Danger zone** | **Clear data…** with two confirmations: deletes conversations, attachments, artifacts, settings and API keys |

See [Data and privacy](/docs/data-and-privacy#erase).

## About

Version, stack, catalog size and storage usage; **Updates** with **Automatic updates**,
**Check now**, **Skip this version** and **View on GitHub**; links to OpenCode, the OpenCode
Console, ChatGPT, ChatGPT plan usage and the repository.

Next: [Keyboard shortcuts](/docs/keyboard-shortcuts).
