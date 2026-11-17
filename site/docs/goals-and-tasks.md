---
title: Goals and tasks
description: Plan before acting, track tasks, run long objectives round by round, and watch context, jobs and subagents.
---

A single message is often not enough for a real task. Zylara adds four mechanisms on top of
the normal turn: plan mode, a task list, goals that continue across rounds, and background
jobs.

## Plan mode

Turn on the **Plan** chip in the composer, or type `/plan` (and `/plan off` to leave it). The
agent investigates and proposes a plan instead of editing files.

The plan card appears in the transcript with one of three states: **Preparing**, **Awaiting
approval**, **Approved**. When it is ready you choose:

| Action | Result |
| --- | --- |
| **Approve and run** | The agent executes the plan |
| **Approve and review each edit** | Executes with a write approval for every file |
| **Keep planning** | Sends the plan back for revision |
| **Run as Goal** | Turns the plan into a goal with rounds |

Plan mode is independent of the permission mode: it changes what the agent does first, not
what it is allowed to do. See [Permissions and approvals](/docs/permissions-and-approvals).

## Tasks

For work with several steps, the agent keeps a task list shown in the **Tasks** card:

- header **Tasks** with *"N of M completed"* and *"N in progress"*;
- statuses **Pending**, **In progress** and **Completed**;
- the list updates as steps finish, so you can tell a stalled task from a finished one.

The composer's plan chip shows `N/M` progress and opens a popover with the plan state, the
task list and any running jobs.

## Goals

A goal is an objective that runs over several turns, each one a full round with its own
tools, approvals and artifacts.

### Starting a goal

Type `/goal` in the composer. It becomes a removable chip, and the next message carries the
request. The agent creates the goal itself (via the `goal` tool) and describes it in the
transcript.

### Rounds

- A goal runs **1 to 100 rounds**; the default is small and can be extended.
- **Continue automatically** keeps starting rounds until the goal is complete, the limit is
  reached, or progress stops.
- Each round is a normal turn: approvals still apply, and a background session can pause for
  one.

### States

| State | Meaning |
| --- | --- |
| **Working** | A round is running |
| **Automatic** | Will continue on its own |
| **Manual** | Waits for you to start the next round |
| **Paused** | Stopped for one of the reasons below |
| **Completed** | Finished and accepted |
| **Blocked** | Stuck on the same impediment |

Pause reasons are explicit: **Paused by you**, **Paused after an error**, **Round limit
reached**, **No progress in 3 rounds**, **Previous round interrupted**.

### Controls

The goal pill in the composer opens a popover with **Pause after this round**, **Resume
goal**, **Extend limit**, **Complete goal** (with a confirmation), **Open goal** and **Disable
goal**. The **Goal** tab shows the objective, **Rounds**, **Total time**, **Tokens**, **Cost**,
**Last activity**, **Copy goal** and the **Round history** with each round's status.

### Attention card

When a goal needs you, a card appears in the transcript: **Active goal**, **Goal paused**,
**Goal blocked** or **Goal completed**, with the reason and the relevant actions — **Resume
goal**, **Extend limit**, **Complete goal**, **Reopen goal**, **Open goal** or **Dismiss**.

A goal is marked **Blocked** only after the same reason repeats three times; the card shows
**Blocker recorded (N of 3)** so you can intervene before that.

Goals run in the app process. Closing Zylara stops the rounds; nothing continues in the
cloud.

## Context and cache

Long sessions eventually fill the context window. The context meter in the Code header shows
**N% of context used** and breaks it down into **System prompt**, **Tool definitions** and
**Messages**, with the output limit.

- Near the threshold the app compacts: older messages are summarized and the transcript
  notes **Context compacted · N messages summarized**.
- The threshold is configurable in **Settings → General → Auto-compaction threshold**
  (50%–90%, default 85%).
- `/compact` compacts immediately.

Next to it, the cache chip reports **N% hit rate** with states **Cold**, **Warming up**,
**Stable**, **Cache dropped**, **Not reported** and **Provider policy**, plus the reason when
a cache breaks (system prompt changed, tool definitions changed, history rewritten, context
compacted, model switch, TTL expired). **Cache diagnostics** shows the details.

## Background jobs

Commands that take long can run as jobs. The **Background jobs** popover lists them with
status **Running**, **Done**, **Failed** or **Stopped**, and offers **View job** and **Stop
job**. Jobs survive the turn that started them and are killed when the app closes.

## Subagents

For parallel research the agent can delegate to subagents. Each one appears as a live row
inside the thinking block with its status, steps, model and recent text, and **Open chat**
opens a read-only transcript tab.

- Investigation subagents (explore, review, general) are read-only: no edits, no shell, no
  questions, no delegation; **24 steps / 15 minutes**.
- Worker subagents can edit and run commands; **48 steps / 30 minutes**, and they require the
  parent session to be in **Autonomous** with plan mode off.
- Delegation depth is one level, with at most four delegations per turn.

Next: [Agents](/docs/agents).
