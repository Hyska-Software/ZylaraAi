---
title: Overview
description: Zylara is a local-first desktop app for chatting with AI models, creating files and running coding agents on your own machine.
---

Zylara is a desktop app for working with AI models on your own computer. Conversations,
attachments, generated files and agent memory stay in a local data folder; requests go
straight to the provider you connected.

It ships with three layouts that share the same engine:

| Layout | What it is for | Start here |
| --- | --- | --- |
| **Chat** | Ask questions, analyze documents, create files, search the web | [Interface](/docs/interface) |
| **Code** | Work inside a folder: read, edit, run commands, review diffs, commit | [Workspaces and sessions](/docs/code-workspaces) |
| **Agents** | Long-lived personas with memory, routines, channels and optional computer use | [Agents](/docs/agents) |

## Three ways to start

1. **Just installed?** Follow [First steps](/docs/first-steps): connect a provider, pick a
   model and send your first message.
2. **Want files?** Ask for a report, spreadsheet or image and read
   [Artifacts](/docs/artifacts) to learn how the result is previewed and saved.
3. **Have a codebase?** Open the folder in the Code layout and read
   [Permissions and approvals](/docs/permissions-and-approvals) before letting the agent
   edit anything.

## What you can do

- Chat with 464 models from 26 providers, including OpenCode Go and Zen, OpenAI (API key or
  your ChatGPT plan), Anthropic and Gemini. See [Models and providers](/docs/models-and-providers).
- Send PDF, DOCX, XLSX, PPTX, text, code and images as context — see [Attachments](/docs/attachments).
- Get real files back (Markdown, HTML, CSV, JSON, code, PDF, Office, images, audio, video,
  ZIP) with a preview per format — see [Artifacts](/docs/artifacts).
- Let the agent run Python or Node to build those files, opt-in and bounded — see
  [Code execution](/docs/code-execution).
- Work on a real folder with diffs, approvals, commits and a terminal — see
  [Workbench](/docs/code-workbench).
- Run long objectives round by round instead of one message at a time — see
  [Goals and tasks](/docs/goals-and-tasks).
- Keep agents with memory, schedules and shared channels — see [Agents](/docs/agents).
- Extend the app with signed plugins — see [Plugins](/docs/plugins).

## How this documentation is organized

| Section | Pages |
| --- | --- |
| **Start here** | Overview, [What is Zylara](/docs/introduction), [Installation](/docs/installation), [First steps](/docs/first-steps) |
| **Chat** | [Interface](/docs/interface), [Conversations](/docs/conversations), [Models and providers](/docs/models-and-providers), [Attachments](/docs/attachments), [Artifacts](/docs/artifacts), [Library](/docs/library), [Web search and sources](/docs/web-search), [Generative UI](/docs/generative-ui), [Markdown and math](/docs/markdown-and-math) |
| **Tools** | [Code execution](/docs/code-execution), [Skills](/docs/skills), [Customization](/docs/customization) |
| **Code** | [Workspaces and sessions](/docs/code-workspaces), [Workbench](/docs/code-workbench), [Permissions and approvals](/docs/permissions-and-approvals), [Goals and tasks](/docs/goals-and-tasks) |
| **Agents** | [Agents](/docs/agents), [Routines and queues](/docs/routines-and-queues), [Channels and teams](/docs/channels-and-teams), [Computer use](/docs/computer-use) |
| **Reference** | [Plugins](/docs/plugins), [Settings reference](/docs/settings-reference), [Keyboard shortcuts](/docs/keyboard-shortcuts), [Data and privacy](/docs/data-and-privacy), [Troubleshooting](/docs/troubleshooting) |

## Requirements at a glance

- Windows 10/11, macOS 11+ (arm64) or a Linux distribution able to run the `.deb`, `.rpm`
  or `.AppImage` package.
- One provider credential: an OpenCode Console key, an OpenAI key or ChatGPT account, an
  Anthropic key, a Gemini key, or any of the other supported providers.
- Optional: Python 3.9+ and/or Node for [code execution](/docs/code-execution), Docker for
  the [command sandbox](/docs/permissions-and-approvals#docker-command-sandbox) and
  [computer use](/docs/computer-use).

This documentation describes Zylara **0.13.1**. Anything that depends on the version
(installers, updates, the model catalog) is marked in the page.
