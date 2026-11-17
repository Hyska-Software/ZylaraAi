---
title: Conversations
description: Manage chat history, search, pin, export, edit messages, queue replies and link a chat to the Code layout.
---

Every chat is a conversation stored locally. The title is generated from the first message
and updated as the conversation evolves; you can rename it at any time.

## History

The sidebar groups conversations by recency: **Pinned**, **Today**, **Yesterday**, **Last 7
days**, **Last 30 days**, **Older**. Pin the ones you reopen often — pinned conversations
ignore the date groups and stay at the top. Drag rows (or press `Alt+↑` / `Alt+↓`) to order
them inside a group.

## Find a conversation

- `Ctrl/⌘ K`, then `#` to search conversations by title and content.
- The sidebar row **Search conversations** opens the same palette.
- Searching from the palette also matches commands, so you can jump from a chat to
  **Open artifacts panel** or **Switch model** in one keystroke.

## Rename, export, delete

Open the `⋯` menu on a conversation row:

| Action | Result |
| --- | --- |
| **Pin / Unpin** | Keeps the conversation at the top of the sidebar |
| **Rename** | Sets a custom title |
| **Export** | Writes the conversation as Markdown to a file you choose |
| **Use in Code / Remove from Code** | Links the chat to the Code layout, or unlinks it |
| **Delete** | Removes the conversation after confirmation |

Deleting a conversation removes its messages and the artifacts that belong to it. Files you
already saved elsewhere on disk are untouched. To erase everything at once, use
**Settings → Data → Clear data…** — see [Data and privacy](/docs/data-and-privacy).

## Message actions

| Where | Action |
| --- | --- |
| Assistant message | **Copy response**, **Regenerate response**, **Helpful response**, **Not helpful** |
| Your message | **Copy message**, **Edit message** → **Save and resend** (`Ctrl/⌘ Enter`) or Cancel (`Esc`) |
| Thinking block | Expand a tool call to read **Output** and **Copy output** |
| Artifact card | Open the preview, **Save as…**, **Open in default app** |

Editing a message truncates everything after it and sends the edited version again. There
is no branching in Chat; branching exists in the Code layout, where a session can go back to
an earlier point.

## Queueing messages

While an answer is streaming, the send button splits:

- **Send now** (⚡) interrupts the current response and sends your message immediately.
- **Queue message** (↑) stores it to run right after the current turn.

The queue bar above the composer shows **Queued · N** with **Resume queue**, **Pause queue**,
**Send now**, **Clear queue** and per-item **Remove from queue**. The queue is per
conversation and survives restarts; only one turn runs per conversation at a time.

## Sessions and layouts

Conversations are scoped to the layout that created them:

- A **Chat** conversation appears only in the Chat sidebar.
- A **Code** session appears only in the Code sidebar and is bound to a workspace.
- An **agent** thread belongs to its agent.

**Use in Code** links an existing Chat conversation to the Code layout so the coding agent
can continue it with file tools; it stays available in both layouts and is marked **From
Chat** in the Code sidebar. **Remove from Code** unlinks it without deleting anything.

## Model changes inside a conversation

The model belongs to the conversation in Chat and to the session in Code. Switching models
inserts a **Model changed to …** divider in the transcript, so you can tell which model
produced which answer. Answers written by a different model are replayed into the next
request in a neutral form, not as raw provider state.

## Storage and retention

Conversations live in `zylara.db` inside your app-data folder; attachments and artifacts
live in subfolders next to it. Nothing is uploaded. Export a conversation if you need a
portable copy, or copy the whole folder while the app is closed to back everything up — see
[Data and privacy](/docs/data-and-privacy#back-up-and-restore).

Next: [Models and providers](/docs/models-and-providers).
