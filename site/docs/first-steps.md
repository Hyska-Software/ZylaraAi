---
title: First steps
description: Connect a provider, choose a model, send your first message, attach a document and get a file back.
---

This walkthrough takes about five minutes and ends with a generated file in your Library.
It assumes Zylara is already installed — see [Installation](/docs/installation).

## 1. Connect a provider

Open **Settings → Providers** (`Ctrl/⌘ ,`). The list shows the recommended providers first.

- **OpenCode Go / OpenCode Zen** — paste a key from the [OpenCode Console](https://opencode.ai/console).
  An existing OpenCode CLI login is detected automatically.
- **OpenAI** — either **Continue with ChatGPT** (no API key, uses an eligible plan) or an
  API key starting with `sk-`.
- **Anthropic** — a key starting with `sk-ant-`. The official API is pay-as-you-go.
- **Gemini** — a key starting with `AIza`.
- **Other providers** — **See more providers** lists 21 further key-based services.

Press **Continue** and, if the provider offers it, **Test connection**. The badge next to
the provider tells you where the credential came from: **Configured**, **Environment
variable**, **OpenCode CLI**, **ChatGPT account** or **Missing**.

Keys are stored in the app's `secrets.json` and never reach the interface. Details and
fallbacks: [Models and providers](/docs/models-and-providers#connecting-a-provider).

## 2. Choose a model

Click the model pill in the composer. The **Select model** dialog lets you:

- search by name, family, identifier or capability;
- filter by **Favorites**, **Vision**, **Reasoning** and **Free**;
- narrow to one provider;
- read context size, maximum output, price per million tokens, protocol, knowledge cutoff
  and release date.

Pick a model and confirm with **Use this model**. For a first run, a general-purpose model
with **Reasoning** support is a good default; a **Vision** model is required if you plan to
attach images.

The ✦ button next to the pill sets the thinking mode: **Off**, an effort tier from
**Minimal** to **Maximum**, or a token budget between **Fast (~4k)** and
**Maximum (~32k)**. Not every model exposes the same control; when it does not, the app
says so. See [Models and providers](/docs/models-and-providers#thinking-modes).

## 3. Send your first message

Type in the composer and press `Enter` (or `Ctrl/⌘ Enter` if you changed **Send with** in
**Settings → General**). While the answer streams you can:

- read the collapsible thinking block, which lists the reasoning and every tool call;
- press the stop button (or `Esc`) to interrupt;
- press ⚡ **Send now** to interrupt and send a new message, or the queue button to line one
  up — see [Conversations](/docs/conversations#queueing-messages).

## 4. Attach a document

Use the **+** button in the composer, paste a file, or import from the clipboard. PDF, DOCX,
PPTX, XLSX/ODS/CSV, text, code, JSON, HTML and images are supported. Text is extracted in
the backend and sent as context; images go natively to vision models.

Ask something specific about the file ("summarize section 3", "which rows grew fastest").
Attachment chips show a preview and a remove action. Limits and extraction rules:
[Attachments](/docs/attachments).

## 5. Ask for a file

Make sure **Create files** is enabled in the composer (the tools toggle), then ask for
something concrete:

> Create a Markdown report with a table of the three biggest risks in the attached PDF.

The answer includes an artifact card. Open it to see the preview, then use **Save as…** to
write a copy anywhere on disk. Files are also listed in [Library](/docs/library).

If the file is a real binary format (PDF, DOCX, XLSX, PPTX, image, audio, video, ZIP), the
agent needs [code execution](/docs/code-execution) enabled and Python or Node installed.

## 6. Optional: try the Code layout

Switch the layout pill to **Code**, press **Open folder…** and pick a project. Read the
trust dialog: **Trust** lets the agent read, edit and run commands in that folder;
**Open Read-Only** only lets it read. Start with the **Review** permission mode, ask for a
small change, and inspect the diff before committing.

Continue with [Workspaces and sessions](/docs/code-workspaces) and
[Permissions and approvals](/docs/permissions-and-approvals).

## Checklist

| Done | Step | Where |
| --- | --- | --- |
| ☐ | Provider connected | **Settings → Providers** |
| ☐ | Model selected | Composer pill → **Use this model** |
| ☐ | Thinking mode chosen | ✦ button |
| ☐ | First answer received | Composer |
| ☐ | Document analyzed | **+** in the composer |
| ☐ | Artifact created and saved | Artifact card → **Save as…** |
| ☐ | Folder opened in Code (optional) | Layout pill → **Code** |

## If something looks wrong

| Symptom | Fix |
| --- | --- |
| Banner asking for a provider | Press **Open Providers** and add a key. |
| "No API key for *provider*" | Connect that provider or pick a model from a provider you configured. |
| Model pill is disabled while streaming | Wait for the current answer or stop it; the model is fixed during a turn. |
| No artifact appears | Check that **Create files** is on and that the model supports tool calls. |
| Binary format not generated | Enable **Code execution** and install Python or Node. |

More: [Troubleshooting](/docs/troubleshooting).
