---
title: Attachments
description: Send PDF, Office, text, code and image files as context, and understand what the app extracts from each one.
---

Attachments give the model material to work with. Zylara reads the file in the backend,
extracts its content and sends that content as part of the request — the file itself is not
uploaded anywhere except to the provider you are using.

## Adding files

- Press **+** in the composer and choose **Documents**, **Images** or **All files**.
- Paste a file or image directly into the composer.
- Import from the clipboard when the app offers it.

Each attachment becomes a chip with a preview and a **Remove** action. You can mix several
files in one message. The switch **Settings → Tools → Agent tools → Send attachments to the
model** controls whether attachment content is included in the request at all.

## What is extracted

| Type | Extraction |
| --- | --- |
| **PDF** | Text per page (text-based PDFs; scanned pages have no OCR) |
| **DOCX** | Paragraphs, headings and tables from `word/document.xml` |
| **PPTX** | Text of each slide, including speaker notes |
| **XLSX / ODS** | Cell values per sheet |
| **CSV / TSV** | Parsed rows, delimiter detected |
| **Text, Markdown, code, JSON, HTML** | Read as text with encoding detection |
| **Images** | Metadata plus the image itself, sent natively when the model has vision |

Limit: **400,000 characters per document**. Longer documents are truncated, and the
attachment is flagged so you know the model did not see everything. Split a large document
into parts if the details matter.

## Images and vision

Images are sent natively, so the model must support vision. Use the **Vision** filter in
**Select model** to find one, otherwise the model will not receive the image. Supported
formats include PNG, JPEG, GIF, WebP, AVIF, BMP and ICO; TIFF is converted before preview.

## When to attach instead of pasting

Attach when the file is long, structured or needs to be preserved as a document; paste when
you only need a paragraph. Attached files stay referenced by the conversation, so later
questions can rely on them without re-uploading.

## Where files are stored

Attachments are copied into `attachments/` in the app-data folder and referenced by id in
the message payload. Deleting the conversation deletes its attachments. Files you want to
keep outside Zylara should be exported — see [Artifacts](/docs/artifacts) and
[Library](/docs/library).

## Limits and caveats

- **No OCR**: a scanned PDF yields little or no text. Convert it to text first.
- **No audio or video transcription**: audio and video files are handled as artifacts, not
  as attachment context.
- **Structural extraction**: DOCX/PPTX/XLSX content is read as text and cells; images,
  colors, merged cells and layout are not part of the context.
- **Provider limits apply**: a very large extraction may be truncated by the model's context
  window. The context meter in Code and the error messages in Chat tell you when that
  happens.

Next: [Artifacts](/docs/artifacts) to turn the analysis into files.
