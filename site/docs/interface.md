---
title: Interface
description: Where every control lives: title bar, sidebar, composer, transcript, panels and the command palette.
---

Zylara has one window with a title bar, a sidebar, a center column (transcript plus
composer) and an optional right panel. The three layouts reuse this frame and change the
sidebar and the tools available.

## Title bar

| Element | What it does |
| --- | --- |
| Brand mark | Returns to the layout home |
| **Toggle sidebar** | Shows or hides the sidebar (`Ctrl/⌘ B`) |
| **Chat · Code · Agents** pill | Switches layout. Right-click it to hide layouts you do not use. Hidden when only one layout is enabled. |
| **ChatGPT plan** chip | Appears when you are signed in with ChatGPT; opens plan usage |
| Update chip | Appears when a newer stable version exists |
| Window controls | Minimize, maximize, close |

## Sidebar (Chat layout)

Top to bottom:

1. **New chat** — starts an empty conversation (`Ctrl/⌘ N`).
2. **Library** — every file from every conversation, plus files you upload.
3. **Plugins** — installed, discoverable and updatable plugins.
4. **Skills** — enable, disable and inspect skills (hidden when **Skills panel in the
   sidebar** is off in **Settings → Tools**).
5. **Search conversations** — opens the command palette (`Ctrl/⌘ K`).
6. Conversation history, grouped as **Pinned**, **Today**, **Yesterday**, **Last 7 days**,
   **Last 30 days** and **Older**. Rows can be reordered with `Alt+↑` / `Alt+↓`.
7. **Settings** in the footer, with the app version.

Each conversation row has a `⋯` menu: **Pin/Unpin**, **Rename**, **Export** (Markdown),
**Use in Code** / **Remove from Code**, **Delete**.

## Composer

The floating input at the bottom of the center column.

| Control | Purpose |
| --- | --- |
| **+** | Attach files (documents, images or all files) |
| Globe toggle | **Web search** for this message |
| Tools toggle | **Create files** (artifacts) |
| Model pill | Opens **Select model** |
| ✦ | Thinking mode (effort or budget) |
| Send / ⚡ / ↑ | Send, **Send now** (interrupt), **Queue message** while streaming |
| ■ | **Stop response** |
| Permission chip | Code and Agents only — see [Permissions and approvals](/docs/permissions-and-approvals) |
| Plan chip | Code and Agents only — plan and task progress |

Below the field: *"Zylara can make mistakes. Check important information."*

Type `/` for slash commands (plugins, `/creator`, and the Code commands `/plan`, `/compact`,
`/commit`, `/test`, `/review` and others) and `@` to reference a file — `@` requires a
workspace, so it appears in the Code layout and in agent threads with a folder.

## Transcript

Each answer can contain, in order:

- a **thinking block** (collapsed by default if you enabled **Reasoning collapsed by
  default**), listing reasoning and every tool call with its status and expandable output;
- the Markdown answer, with tables, math, diagrams and code;
- **citation chips** when the agent searched the web;
- **artifact cards** for generated files;
- a footer with **Copy response**, **Regenerate response**, **Helpful** / **Not helpful**,
  the model name and, when enabled, tokens and duration.

Your own messages have **Copy message** and **Edit message** (editing offers **Save and
resend**). While streaming, a **Jump to the end of the conversation** button appears if you
scroll up.

## Right panel

The same dock hosts two panels:

- **Artifacts** — list of files with a per-format preview, **Save as…**, **Open in default
  app**, **Delete** and previous/next navigation. See [Artifacts](/docs/artifacts).
- **Sources** — every page the agent read, with title, domain and link. It can float over
  the chat or dock beside it, and is resizable.

In the Code and Agents layouts this dock also shows the Files/Changes/Terminal panel — see
[Workbench](/docs/code-workbench).

## Command palette

`Ctrl/⌘ K` opens it from anywhere. Start with `>` to search commands or `#` to search
conversations; without a prefix it searches both.

Commands are grouped as **Conversations**, **Navigation**, **Tools**, **Plugins**,
**Appearance**, **Settings** and **System**, and include: new chat, pin conversation,
export, copy last answer, stop response, regenerate, switch layout, focus the composer,
toggle the sidebar, open artifacts or sources, open the Library, manage skills, switch
model, toggle web search, file creation or code execution, toggle theme, open settings,
open the data folder, reload the model catalog and install a plugin from a file.

`↑`/`↓` navigate, `Enter` runs, `Ctrl/⌘ Enter` runs the secondary action (pin/unpin),
`Esc` clears the search and then closes.

## Empty state

A new conversation shows **"How can I help?"** with four suggestion cards — **Analyze a
document**, **Search the web**, **Create a file**, **Explain code** — and shortcut hints for
commands, sidebar and send.

## Where to go next

- [Conversations](/docs/conversations) — history, editing, queue.
- [Keyboard shortcuts](/docs/keyboard-shortcuts) — the full list.
- [Customization](/docs/customization) — theme, text size, layouts, language.
