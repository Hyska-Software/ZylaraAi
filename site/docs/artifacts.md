---
title: Artifacts
description: Files the agent creates, how each format is previewed in the panel, and how to save or open them.
---

An artifact is a file the agent produced: a Markdown report, an HTML page, a CSV table, a
code file, a PDF, a DOCX, a spreadsheet, a slide deck, an image, an audio or video file, or
a ZIP. Artifacts are stored inside Zylara and can be previewed, saved or opened without
leaving the app.

## How artifacts are created

| Tool | Formats |
| --- | --- |
| **Create files** (`create_file`) | Markdown, TXT/log, HTML, CSV/TSV, JSON, SVG and source code — text written directly |
| **Code execution** (`run_code`) | Everything else: PDF, DOCX, XLSX, PPTX, PNG/JPEG/WebP/GIF/TIFF, audio, video, ZIP and other binaries |

Text formats work with just the tools toggle in the composer. Binary formats need
[code execution](/docs/code-execution) enabled and Python or Node available.

Each artifact is written to `artifacts/<id>/<name>` with its metadata in the database, so it
survives restarts and appears in the Library.

## In the conversation

Artifacts appear as compact cards under the message that created them, up to two per row.
When a single message produces more than four, the chat shows the first ones and a
**View all (N)** button that opens the panel in list mode.

Cards and the panel are reconciled after every turn, so a card is never left behind if an
event is lost.

## The Artifacts panel

Open it from a card, from **View all**, or with **Open artifacts panel** in the command
palette.

| Control | Purpose |
| --- | --- |
| **View list** | Shows every artifact of the conversation as cards |
| **Previous / Next artifact** | Moves through the list, with a `1 of 3 artifacts` counter |
| **Save as…** | Writes a copy anywhere on disk through the native dialog |
| **Open in default app** | Hands the file to the system application |
| **Delete** | Removes the artifact after confirmation |
| **Close** | Hides the panel |
| Float / dock | The panel can float over the chat or dock beside it; docking needs a wide enough window |

## Previews by format

| Format | Preview |
| --- | --- |
| Markdown | Rendered document with a **Document / Code** toggle |
| TXT / log | Numbered lines, configurable line wrap |
| HTML | Rendered in a sandboxed iframe |
| CSV / TSV | Table with delimiter detection (`,` `;` tab `|`) |
| JSON | Collapsible tree, plus highlighted source; invalid JSON falls back to code |
| Code (30+ languages) | Syntax highlighting with line wrap or horizontal scroll |
| SVG | Sanitized rendering with zoom and fit |
| PDF | Page navigation and zoom (pdf.js) |
| DOCX | Rendered HTML in a sandboxed iframe |
| XLSX | Grid with one tab per sheet |
| PPTX | Slide cards with title, text and speaker notes |
| Images | Zoom, pan and transparency checkerboard; TIFF converted to PNG |
| Audio / video | Native player with metadata (files up to 24 MiB inline) |
| ZIP | Entry list (up to 400) with a summary |
| Other binaries | Detected format plus a 4 KB hexdump |
| Anything unsupported | A card with **Save as…** and **Open** |

Office previews are structural: text, tables and slide order are shown, but colors, images,
merged cells and exact layout are not reproduced. Scanned PDFs are not OCR'd.

## Working with artifacts

- **Save as…** is the only action that writes outside the app-data folder; nothing is
  overwritten without the native dialog.
- **Open in default app** is useful for formats the built-in preview does not render, such
  as audio or video containers.
- Files are kept until you delete the artifact or its conversation, or clear the app data.
- Artifacts from every conversation are listed in [Library](/docs/library), where they can be
  searched, favorited and renamed.

## What the agent can do with them

The agent can search and read the artifact library of **all your conversations** through two
tools: `list_artifacts` (search by name, conversation title and text content) and
`read_artifact` (bring content into context, with text extraction for PDF/DOCX/XLSX/PPTX,
image metadata, ZIP listing and pagination).

The library exposes artifacts and their metadata only — never messages from other
conversations — and the content is treated as untrusted data, not as instructions.

Next: [Library](/docs/library).
