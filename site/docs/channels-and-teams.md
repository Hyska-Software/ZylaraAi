---
title: Channels and teams
description: Let several agents answer in one channel, choose a leader, and read per-agent usage.
---

A channel is a shared conversation where several agents can answer the same message. It is
useful when a question benefits from different specialties, or when you want a reviewer to
see what a builder proposed.

## Creating a channel

1. In the Agents sidebar, open **Channels** and press **New channel**.
2. Give it a **Name**.
3. Pick the **Members** — up to **6 agents**.
4. Optionally choose a **Leader**: **None — everyone answers** by default.

The channel header shows the member avatars, a summary (*"N agents · names"*) and a leader
badge when one is set.

## How a message is answered

- Write in the channel composer and send. With no leader, every member may answer.
- `@name` mentions a specific agent; without a mention the message goes to everyone.
- With a leader, the leader answers first and may delegate to the other members.
- Each reply is generated in a hidden private thread for that agent and then published to the
  channel, so the channel stays readable while each agent keeps its own context.

The channel composer supports attachments but has no model selector: each agent answers with
its own configured model and reasoning settings.

If some members fail, the channel reports **Some agents did not answer** and keeps the
replies that succeeded.

## Team page

**Team** (sidebar footer) is the roster: *"Agents you can call at any time."*

| Element | Purpose |
| --- | --- |
| **Create agent**, **Create with AI**, **Templates**, **Import** | Add agents |
| Agent cards | Identity, description, conversation count, last activity, tokens and cost, **Talk**, **Archive** |
| **Archived** | Restore or delete archived agents |
| **Stats** | Usage for the whole team |

## Stats

**Stats** aggregates every agent over **7 days**, **30 days**, **90 days** or **All**:

- **Tokens used** — input, output and reasoning;
- **Total spend** — as reported by the providers;
- **Turns** — with average tokens per turn;
- **Most used model**;
- **Usage per day** chart and a **By model** table with turns, tokens, share and cost.

Use it to decide which agent or model is worth keeping, and to check the daily budget set in
**Settings → Agents → Budget**.

## Practices that work

- Give the leader a coordination instruction ("ask the builder for the diff, then review it")
  rather than a domain task.
- Keep membership small: three to six agents answer faster and produce less repetition than a
  full roster.
- Grant **Delegate tasks** only to agents that should hand work to others.
- Use channels for discussion and a normal thread for execution; the thread keeps a clean
  context and a workspace.

Next: [Computer use](/docs/computer-use).
