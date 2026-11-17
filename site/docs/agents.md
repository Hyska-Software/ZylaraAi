---
title: Agents
description: Create personas with their own model, instructions, memory, workspace and permissions, and track what they cost.
---

An agent is a persona you configure once and reuse across conversations: a name, a role, a
model, instructions, optional memory, an optional folder and a permission mode. The Agents
layout is where you create, talk to and manage them.

## The layout

The sidebar is organized around agents:

| Area | Contents |
| --- | --- |
| Header | **Search agents or conversations**, **Activity** (turns in progress), **Task board**, **New agent** |
| **Pinned** | Agents you keep at the top |
| Agent groups | Agents by department, each with its recent threads and **See all (N)** |
| **Channels** | Multi-agent conversations, with **New channel** |
| Footer | **Plugins**, **Team**, **Routines**, **Settings** |

An agent's home shows its avatar, name and role, two chips — **Workspace · *permission*** and
***tokens* tokens · *cost*** — and the actions **New conversation**, **Open main
conversation**, **Edit agent** and its **Start with** suggestions, followed by **Recent
conversations**.

The right panel has four tabs: **Screen**, **Routines**, **Browser** and **Data**. When the
agent has a workspace, the Files/Changes/Terminal panel appears in the same dock.

## Creating an agent

**New agent** opens the editor with six tabs:

| Tab | Fields |
| --- | --- |
| **Identity** | **Name**, **Role** (default *Assistant*), **Department** (General, Research, Engineering, Quality, Content, Operations, Data, Support), **Description** |
| **Avatar** | Mascot body, expression, color and shape, or **Upload image** (PNG/JPEG/GIF/WebP, up to 10 MB) |
| **Model** | **Provider**, **Model**, **Fallback provider**, **Fallback model** or **None** |
| **Behavior** | **Agent instructions**, **Suggestions to start** (up to three), **Working folder** or **Internal app folder**, **Permissions**, **Agent Docker image** (optional), **Computer environment** |
| **Capabilities** | Twelve toggles plus allowlists for **Tools**, **Skills** and **MCP servers**, and **Durable memory** |
| **Memory** | The memories the agent has stored, with add, pin and delete |

The subtitle is explicit: *"Instructions do not grant permissions to the agent."* A prompt
can ask for something; only the permission mode and capabilities allow it.

**Templates** in the Team page start from eight ready-made personas: Assistant, Researcher,
Engineer, Reviewer, Writer, Operations, Analyst and Support. **Create with AI** drafts an
agent from a description; the draft is reviewed in the editor before saving.

## Capabilities

| Capability | Enables |
| --- | --- |
| **Search web** | Web search with citations |
| **File access** | Reading and writing in the workspace, and artifacts |
| **Run code** | The code sandbox, when code execution is enabled globally |
| **Delegate tasks** | Delegating, handoff and posting in channels |
| **Automations** | The agent's own routines |
| **Shared memory** | Writing memories visible to other agents |
| **Write skills** | Creating and versioning `SKILL.md` files |
| **Create agents** | Creating new agents |
| **Computer use** | Screenshots, clicks and keyboard, with per-action approval |
| **Screen capture** | Read-only screen access |
| **Controlled browser** | An isolated browser driven over CDP |
| **Docker override** | A per-agent Docker image |

Allowlists narrow what the agent sees: only the listed tools, skills and MCP servers are
offered.

## Memory

With **Durable memory** on, the agent keeps facts, preferences, procedures and notes across
conversations. It writes them through the `memory` tool (list, save, update, forget).

| Limit | Value |
| --- | --- |
| Size per memory | 4 KiB |
| Memories per agent | 200 |
| Context budget | 8 KiB (5 KiB private + 3 KiB shared) |

Memory is injected at the start of a turn as a volatile block, pinned items first, then the
most recent. It never enters the frozen system prompt, so enabling or disabling it does not
invalidate the whole prompt cache. **Data → Memory** in the panel lists everything, with
**Private** and **Shared** tabs; deleting all requires a confirmation.

Turning durable memory off keeps the notes but removes them from context.

## Workspace

An agent can work in a folder:

- **Internal app folder** — a private folder per conversation under
  `<app-data>/agent-workspaces/`, separate from other conversations. File tools work there,
  but shell, jobs, plan and MCP tools do not.
- **Working folder** — a folder you pick. After **Trust this folder? → Trust and select**,
  every tool is confined to it and the full Code toolset becomes available.

Changing the folder is refused while a turn is running, and existing threads keep the
workspace they started with. A conversation can also set its own **Folder** chip.

## Team and stats

**Team** lists *"Agents you can call at any time"* with **Create agent**, **Create with
AI**, **Templates**, **Stats** and **Import**. Each card shows the identity, description,
number of conversations, last activity, tokens and cost, with **Talk** and **Archive**.
Archived agents live in a separate section with **Restore** and delete.

**Stats** covers **7 days**, **30 days**, **90 days** or **All**, with cards for **Tokens
used** (input, output, reasoning), **Total spend**, **Turns** (average tokens per turn) and
**Most used model**, a **Usage per day** chart and a **By model** table. Costs are the values
reported by the providers.

## Sharing and lifecycle

| Action | Result |
| --- | --- |
| **Export** | Writes a `zylara-agent` JSON with configuration and memories |
| **Import** | Recreates an agent from that file, validating version, model and workspace |
| **Duplicate** | Copies the configuration, not the conversations or memories |
| **Archive** | Keeps history, blocks new turns; **Restore** from the archived section |
| **Delete** | Only when the agent has no other conversations; deleting an archived agent removes the persona, its main conversation and every conversation it owns |

**Settings → Agents** adds a daily budget per agent in US$, limits on concurrent turns and
queued messages per thread, and notification preferences (approvals, questions,
completions, tasks, do not disturb).

Next: [Routines and queues](/docs/routines-and-queues).
