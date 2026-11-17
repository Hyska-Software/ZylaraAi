---
title: Permissions and approvals
description: Read, Review, Edit and Autonomous modes, the approval card, protected paths and the Docker command sandbox.
---

In the Code layout the agent can change files and run programs. Zylara makes the boundary
explicit: you choose a permission mode per session, and anything outside it becomes an
approval card in the transcript.

## Permission modes

The permission chip in the composer switches mode at any time:

| Mode | What the agent may do |
| --- | --- |
| **Read** | Read files and query the workspace. No writes, no commands. |
| **Review** | Propose edits; every write needs your approval. |
| **Edit** | Edit files freely; commands need approval. |
| **Autonomous** | Run commands, edit, read secrets and control the computer without asking. A toast warns **Autonomous mode enabled**. |

The default for new Code sessions is set in **Settings → Tools → Code sessions → Default
permission mode**. Choose **Read only** or **Review** for an unfamiliar repository, and
reserve **Autonomous** for folders you would let a script modify.

`/permissions` in the composer points at the chip; it does not change the mode by itself.

Plan mode is a separate switch: the **Plan** chip in the composer or `/plan` asks the agent
to propose a plan before acting — see [Goals and tasks](/docs/goals-and-tasks#plan-mode).

## Approval cards

When an action falls outside the current mode, the turn pauses and a card appears in the
transcript:

| Card title | Trigger |
| --- | --- |
| **Run command?** | A shell command that is not classified as read-only |
| **Write change?** | Creating or editing a file |
| **Read file?** | Reading outside the workspace |
| **Read file outside the project?** | A path that leaves the workspace |
| **Read secret file?** | A file matching secret patterns (`.env`, `*.pem`, `*.key`, credentials) |
| **Run destructive action?** | Deleting or overwriting in a destructive way |
| **Access the network?** | A request to a host outside the allowlist |
| **Control the computer?** | Computer-use actions |

Each card offers **Allow**, **Deny** and **Always allow**, and the grant is scoped:

- **This session** — until the session ends.
- **This workspace** — for every session in that folder.
- **Always** — for the installation.

You can add a **Reason for denial (optional)**; the agent sees it and can adjust. `Esc`
denies the pending card. While an approval is pending, the composer only offers **Stop**.

## What runs without asking

Read-only inspection commands are recognized in every mode: `git status`, `git diff`,
`git log`, `ls`, `cat`, `head`, `tail`, `rg`/`grep`, version probes and similar. Anything
composed (pipes, `;`, redirections), anything that writes, and anything destructive is never
classified as safe and always asks outside **Autonomous**.

The agent also cannot stage, commit, push, fetch or pull — those are workbench actions that
only you perform. See [Workbench](/docs/code-workbench#commit).

## Paths and secrets

- Tools are confined to the workspace. Reaching outside it requires approval, and the path
  is shown in the card before you decide.
- Secret-like files are treated as protected even inside the workspace: `.env`, `*.pem`,
  `*.key`, credential files. The agent asks before reading them.
- File writes are capped at 2 MB per call, and a write must follow a read of the same file,
  so the agent cannot blind-overwrite something it never saw.

## Untrusted workspaces

Opening a folder with **Open Read-Only** removes the shell and editing tools for that
workspace. The header keeps a **Read-only** badge, and project instructions are not loaded.
Revoke trust from the workspace menu to return to this state.

## Docker command sandbox

For stronger isolation of shell commands, switch the command environment to Docker in
**Settings → Tools → Command sandbox**:

| Setting | Meaning |
| --- | --- |
| **Environment** | **This computer** (default) or **Docker** |
| **Docker image** | Image used for commands; default `node:22-bookworm` |
| **Network in the container** | Off by default; when off, commands cannot reach the network |
| **Memory (MB)**, **CPUs**, **PIDs** | Resource limits |
| **Read-only rootfs** | Mounts the container filesystem read-only |
| **Validate image** / **Download image** | Checks or pulls the image before use |

Only the workspace is mounted, at `/workspace` — never your home folder, the Docker socket or
credentials. Containers run with `--cap-drop ALL`, `no-new-privileges`, a non-root user, a
tmpfs `/tmp` and the limits above. They are removed on exit, on timeout, on cancel and on tab
close, and **Clean up containers** in the same screen removes leftovers.

The sandbox covers `run_command`-style tools and background jobs. It does **not** cover
[code execution](/docs/code-execution), which runs `run_code` directly on the machine.

## Agents and computer use

Agent threads use the same modes and approval cards. An agent's own permission mode is set
in its editor, and **Computer use** adds per-action approval cards (screenshot, click, type,
key) unless the agent runs in **Autonomous** — see [Computer use](/docs/computer-use).

Next: [Goals and tasks](/docs/goals-and-tasks).
