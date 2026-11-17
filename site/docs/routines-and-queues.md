---
title: Routines and queues
description: Queue messages while an agent works and schedule recurring instructions that run while the app is open.
---

Two mechanisms keep an agent working without you retyping prompts: a message queue for the
conversation you are in, and routines that run on a schedule.

## The message queue

While a turn is streaming, the composer can hold your next message instead of interrupting:

- **Queue message** (↑) adds it to the queue; **Send now** (⚡) interrupts the current answer
  and sends immediately.
- The queue bar shows **Queued · N** with **Resume queue**, **Pause queue**, **Send now**,
  **Clear queue** and per-item **Remove from queue**.
- Queues are FIFO and persisted: closing the app does not lose them.
- Only one turn runs per conversation at a time. **Settings → Agents → Execution and queue**
  sets the global turn limit, the per-agent limit (default 1) and how many messages a thread
  can queue.

The **Activity** dialog lists running turns and offers **Stop everything**; the sidebar shows
a queue count and a stop action for the agent.

## Routines

A routine is a stored instruction that runs on a schedule or on an event, and posts its
result into the agent's main conversation.

Open **Routines** from the Agents sidebar footer. The page has **Day**, **Week** and
**Month** views, **Today**, an agent filter (**All agents**), **All routines** and **New
routine**.

### Creating a routine

| Field | Options |
| --- | --- |
| **Agent** | Which agent runs it |
| **Title** | Name shown in the calendar |
| **Instruction** | The prompt; up to 8 KiB |
| **Trigger** | **Scheduled** or **By event** |
| **Frequency** | **Every interval** or **Every day** |
| **Interval (min)** | 5 to 10,080 minutes (one week) |
| **Time** | Hour and minute for daily routines |
| **Days of the week** | Which days it may run |
| **Active** | Turns the routine on or off |

Each agent can have up to **50 routines**.

### Runs

| Action | Result |
| --- | --- |
| **Run now** | Starts a run immediately, without waiting for the schedule |
| **Runs** | Opens *"Runs of *title*"* with the last 30 runs and their status |
| **Pause / enable** | Stops or resumes the schedule |
| **Edit** | Changes the instruction or schedule |
| **Delete** | Removes the routine; the main conversation is preserved |

The **Routines** tab in the agent panel shows **Run history** and the latest runs.

### What a routine can and cannot do

- Routines run **only while the app is open**: a scheduler ticks every 30 seconds and skips
  missed runs instead of replaying them. Nothing runs in the cloud.
- The result is posted to the agent's **main conversation**, so you can read it later like any
  other answer.
- Unattended runs **fail closed** on approvals: if the instruction needs a permission the
  agent does not have, the run stops instead of waiting for a human who is not there.
- Notifications follow **Settings → Agents → Notifications**, including **Do not disturb**
  and the per-event toggles.

## Choosing between them

| Need | Use |
| --- | --- |
| Send a follow-up without losing the current answer | Queue |
| Repeat the same instruction daily or hourly | Routine |
| Work that must continue until an objective is met | [Goal](/docs/goals-and-tasks#goals) |
| One-off work in parallel | A new conversation or a [subagent](/docs/goals-and-tasks#subagents) |

Next: [Channels and teams](/docs/channels-and-teams).
