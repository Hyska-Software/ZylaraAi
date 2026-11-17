---
title: Workspaces and sessions
description: Open a folder, decide whether to trust it, and run coding sessions with their own model and permission mode.
---

The Code layout binds a conversation to a folder on your disk. The agent can then read and
edit files, run commands, keep a plan and produce a diff you review before committing.

## Start with a folder

The first time you switch to **Code**, the center column shows **Start with a folder**:
*"Open a folder so the agent can read, edit and run commands here."*

- **Open folder…** opens the native folder picker.
- **Recent workspaces** lists folders you used before.
- With no folder, there is nothing to do in this layout: Code is not a chat that happens to
  have file access.

Both Git repositories and plain folders work. In a plain folder the Changes panel still
works — it is built from the agent's journal — but the **Commits** tab shows **Not a Git
repository**.

## Trust

Before the first turn in a folder, Zylara asks **Trust this folder?**:

| Choice | Effect |
| --- | --- |
| **Trust** | The agent may read, edit and run commands in the folder. `AGENTS.md`/`CLAUDE.md` and local skills are loaded as project instructions. |
| **Open Read-Only** | The agent may only read. No edits, no commands, and project instructions are not loaded. |
| **Cancel** | Does not open the workspace |

An untrusted workspace keeps a **Read-only** badge in the header, and the shell tools stay
unavailable. You can revoke trust later from the workspace menu.

Trust matters because a folder can contain instructions: `AGENTS.md`, `CLAUDE.md` and skill
files are read as guidance for the agent. Only trust folders you would let a colleague run
commands in.

## Sessions

The Code sidebar lists **Workspaces** and their sessions:

| Control | Purpose |
| --- | --- |
| **New session** | Starts a fresh conversation in the selected workspace (`Ctrl/⌘ Shift+A`) |
| **Open folder** | Adds another workspace |
| **Add Chat session** | Links an existing Chat conversation to Code |
| **Search** | Filters workspaces and sessions |
| **Plugins**, **Skills** | Same pages as in Chat |
| Filters | **All**, **With git**, **Without git**, **Untrusted**, **With sessions**, **Without sessions** |
| **No workspace** | Sessions that lost their folder |

Each session carries its **own model** and **permission mode**, and both can change between
turns. Switching the model inserts a divider in the transcript, so old answers keep their
provenance.

### Linking a Chat conversation

**Add Chat session** opens a dialog: *"Choose a Chat conversation to also work on it in Code.
It stays available in both layouts."* Linked sessions are marked **From Chat** in the Code
sidebar, and **Remove from Code** (in the Chat conversation menu) unlinks them without
deleting anything.

## What the agent can do in a session

- Read files (paginated, with line numbers), list folders, search by name or content.
- Create files and replace exact strings, after reading the file first.
- Run commands, run the project's detected test/lint command, and manage background jobs.
- Read Git status, diff and log.
- Keep a task list and, in plan mode, propose a plan.
- Delegate to subagents.

It cannot stage, commit, push, fetch or pull: those are your actions in the workbench — see
[Workbench](/docs/code-workbench).

## Workspace menu

| Action | Result |
| --- | --- |
| **Open terminal** | Shell at the project path, without starting a session |
| **Reveal in file manager** | Opens the folder in the system file browser |
| **Remove from Zylara** | Forgets the workspace and its sessions list; the folder is not deleted |
| **Revoke trust** | Returns the folder to read-only for future turns |

## Sessions are separate per layout

A Code session never appears in the Chat sidebar, and a Chat conversation never appears in
Code unless you link it. This is deliberate: the Code profile exposes file and shell tools,
and mixing the two histories silently would change what the model can do. The full
explanation is in [Conversations](/docs/conversations#sessions-and-layouts).

Next: [Workbench](/docs/code-workbench).
