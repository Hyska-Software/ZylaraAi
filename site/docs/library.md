---
title: Library
description: Every file from every conversation, plus your own uploads, in one searchable page.
---

The Library collects every artifact the agent created, in any conversation, together with
files you upload there yourself. It is the place to find a report you generated last month
without remembering which chat produced it.

Open it from the sidebar (**Library**) or with **Open library** in the command palette. The
page replaces the chat column; **Back to chat** or `Esc` returns.

## Layout

| Control | Options |
| --- | --- |
| Search | **Search the library** — matches file name, file type and the conversation it came from |
| Sort | **Recent**, **Oldest**, **Name (A–Z)**, **Size** |
| View | **Grid** or **List** |
| Filters | **All**, **Favorites**, **Images**, **Documents**, **Code**, **Media**, **Others**, each with a count |
| Upload | **Upload files**, or drag files onto the page ("Drop to upload to the library") |

Empty states are explicit: **Your library is empty** when there is nothing at all, **No
artifacts found** when filters hide everything, with a **Clear filters** action.

## Working with a file

Each card (or list row) offers:

| Action | Result |
| --- | --- |
| **Open** | Opens the preview dialog with **Previous** / **Next** navigation and the position in the list |
| **Rename** | Changes the displayed file name |
| **Add to favorites** / **Remove from favorites** | Marks the file for the **Favorites** filter |
| **Save as…** | Writes a copy anywhere on disk |
| **Delete** | Removes the file after confirmation |

The preview dialog uses the same renderer as the artifact panel: PDF pages, DOCX HTML, XLSX
sheets, PPTX slides, images with zoom, audio/video players, Markdown, JSON trees, CSV tables,
code with highlighting and hexdump for unknown binaries — see
[Artifacts](/docs/artifacts#previews-by-format).

## Files you upload

Uploading adds a file to the Library and makes it available to the agent as context in later
turns. This is the way to keep a reference document around without attaching it to every
message.

## How the agent uses the Library

The agent searches your artifacts with `list_artifacts` — matching name, conversation title
and extracted text, ignoring accents — and reads any result with `read_artifact`. Results
show which conversation produced each file. Reading a file brings its content into the
current context, with text extraction for PDF, DOCX, XLSX and PPTX, metadata and structure
for images, a ZIP listing, and pagination for long text.

Two limits matter for privacy: the library exposes **artifacts and metadata only**, never
messages from other conversations, and the content is injected as untrusted data — the agent
is instructed not to follow instructions found inside files.

## Storage

Library files live in `artifacts/` inside your app-data folder. Deleting a conversation
removes the artifacts created in it; deleting a file from the Library removes it everywhere.
Uploads are kept until you delete them or clear the app data.

Next: [Web search and sources](/docs/web-search).
