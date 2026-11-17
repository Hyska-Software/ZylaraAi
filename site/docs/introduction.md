---
title: What is Zylara
description: A local-first AI desktop app built on Tauri and React, with three layouts and no server of its own.
---

Zylara is a desktop client for large language models. It is a native window (Tauri 2 with a
React interface) that talks directly to the provider you choose. There is no Zylara account,
no relay server and no upload of your conversations.

## Local-first by design

| What | Where it stays |
| --- | --- |
| Conversations and messages | `zylara.db` (SQLite) in your app-data folder |
| Attachments you send | `attachments/` in the same folder |
| Files the agent creates | `artifacts/` in the same folder |
| API keys and the ChatGPT session | `secrets.json` in the same folder, read only by the backend |
| Skills you write | `skills/` in the same folder |

The renderer never receives a key or a token: it gets masked identifiers and metadata. The
only network destinations are the provider you selected, the update feed and the plugin
registries you configure — see [Data and privacy](/docs/data-and-privacy).

## Three layouts, one engine

The layout pill in the title bar switches between **Chat**, **Code** and **Agents**. All
three use the same conversation engine (streaming, tools, reasoning, artifacts), but they
expose different tools and different context.

- **Chat** is the default: a conversation list, a composer, attachments, web search,
  generated files and the Library.
- **Code** binds a conversation to a folder on disk. The agent can read and edit files, run
  commands, keep a plan and a task list, and the app shows a diff for review. Nothing is
  staged or committed without you.
- **Agents** gives a persona its own model, instructions, memory, workspace, permission
  mode, routines and channels, so it can keep working across conversations.

Sessions are separated per layout: a Chat conversation never appears in Code or Agents
unless you explicitly add it to Code. See [Conversations](/docs/conversations#sessions-and-layouts).

## Bring your own provider

Zylara does not resell model access. You connect a provider and pay it directly:

- **OpenCode Go** and **OpenCode Zen** (OpenCode Console key)
- **OpenAI** — API key, or **Continue with ChatGPT** to use an eligible ChatGPT plan
- **Anthropic** — official API, pay-as-you-go
- **Gemini**
- 21 further key-based providers (DeepSeek, xAI, Mistral, Moonshot, Z.AI, MiniMax,
  OpenRouter, Groq, Together, Fireworks, Cerebras, NVIDIA NIM, DeepInfra, SiliconFlow,
  SambaNova, Scaleway, Novita, Venice AI, Inception, StepFun, Vercel AI Gateway)

The bundled catalog lists 26 providers and 464 models with context size, output limit,
price, vision and reasoning support. See [Models and providers](/docs/models-and-providers).

## What you can do

| Capability | Page |
| --- | --- |
| Analyze documents and images | [Attachments](/docs/attachments) |
| Create and preview files | [Artifacts](/docs/artifacts) |
| Run code to build real formats | [Code execution](/docs/code-execution) |
| Search the web with citations | [Web search and sources](/docs/web-search) |
| Get interactive answers (tables, charts, forms) | [Generative UI](/docs/generative-ui) |
| Work in a repository | [Workbench](/docs/code-workbench) |
| Run a long objective | [Goals and tasks](/docs/goals-and-tasks) |
| Keep assistants with memory and schedules | [Agents](/docs/agents) |
| Add features from third parties | [Plugins](/docs/plugins) |

## What Zylara is not

- **Not a cloud service.** There is no hosted version; closing the app stops everything,
  including scheduled routines and goals that are waiting for a round.
- **Not a sandbox by default.** Code execution runs with your user permissions. The Docker
  command sandbox is opt-in and covers `run_command`-style tools, not `run_code`. See
  [Code execution](/docs/code-execution#safety).
- **Not an IDE.** The workbench reads, diffs, commits and runs a terminal, but it does not
  replace an editor for large refactors.
- **Not a model.** Model behaviour, limits and prices come from the provider; the app
  displays what the provider reports.

## Platforms and project

Zylara runs on Windows 10/11 (WebView2), macOS 11+ (arm64) and Linux (`.deb`, `.rpm`,
`.AppImage`). It is an open-source project under the MIT license, maintained without a
commercial plan; that statement describes the project's purpose and does not restrict the
rights granted by the license.

Next: [Installation](/docs/installation).
