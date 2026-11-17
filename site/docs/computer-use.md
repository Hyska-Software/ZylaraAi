---
title: Computer use
description: Give an agent a private desktop inside Docker, watch it in the Screen tab, and approve each action.
---

Computer use lets an agent operate a graphical environment: take screenshots, click, type,
scroll and read window contents. On Zylara the environment is a **private desktop** running
in a Docker container, shown live in the **Screen** tab.

## Requirements

- Docker Desktop or Docker Engine installed and running.
- The computer-use image downloaded once (it is large and is not pulled automatically).
- An agent with the **Computer use** capability and a **Computer environment** that is not
  **Off**.

Local control of your real desktop is supported on Windows only. On macOS and Linux the
private desktop container is the supported path; "Desktop in the cloud" is not available yet.

## Setup

Open **Settings → Agents → Private desktop (computer use)**:

| Control | Purpose |
| --- | --- |
| **Computer use image** | Image used for the container |
| **Download image** | Pulls it before the first session |
| **Start Docker** | Starts the daemon and waits up to 120 seconds for it |
| **Computer use container** | Shows the container state |
| **Actions per turn** | Default 20 |
| **Actions per hour** | Default 120 |
| **Clean up containers** | Removes stopped containers and leftovers |
| **Diagnostics** | Checks Docker, the image and the container |

The **Screen** tab shows a help card when something is missing, with **Install/open Docker
Desktop…**, **Download image**, **Configure Docker** and, for development, **Local build**.

Per agent, the **Works in** selector sets the environment: **Automatic**, **Private desktop
(Docker)**, **This computer**, **Browser** or **Off**.

## What the agent can do

| Action | Notes |
| --- | --- |
| Screenshot, window list, accessibility tree | Reading the state of the desktop |
| Click, double-click, right-click, move, drag, scroll | Pointer control |
| Type text, press keys, focus a window | Keyboard control |
| Wait | Pauses for the UI to settle |
| Clipboard read/write | Explicit actions |
| Browser (CDP) | An isolated browser, controlled through the controlled-browser capability |

Each step is a tool call, so the thinking block shows exactly what the agent did and in which
order.

## Approvals and limits

- Outside **Autonomous**, every action raises an approval card (**Allow** / **Deny**) with no
  persistent grant: you approve the action, not the session.
- **Actions per turn** and **Actions per hour** cap the loop; the defaults are 20 and 120.
- Sensitive windows are denied by a built-in list, and **Settings → Agents** adds allow and
  deny lists for desktop apps and for browser hosts.
- An audit trail records actions; typed text is not stored.
- Network access follows the controlled-browser host policy.

## Taking over

The Screen tab is interactive when you need it:

| Control | Effect |
| --- | --- |
| **Take control** | Your keyboard and mouse drive the desktop |
| **Return to the agent** | Gives control back |
| `Ctrl+Alt+Shift+Q` | Releases the keyboard immediately |
| **Stop** (top bar) | Stops the current turn |
| **Stop everything** (Activity) | Stops every running turn |

## Limitations

- The private desktop is a container: it has its own filesystem and no access to your files
  unless you copy them in.
- Screenshots are images; text extraction depends on the accessibility tree, which many Linux
  apps expose only partially.
- The image is large; the first download can take a while, and the container starts on demand.
- Computer use does not replace the Code tools: for file work, a workspace is faster and more
  reliable.

Next: [Plugins](/docs/plugins).
