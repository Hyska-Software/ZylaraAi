---
title: Code execution
description: Let the agent run Python or Node to produce PDF, Office, image, audio, video and ZIP files, inside limits you control.
---

Some formats cannot be written as text. To produce a PDF, a DOCX, an XLSX, a slide deck or an
image, the agent writes a short script and runs it, then hands the generated file back as an
artifact. This is the **code execution** feature, and it is off until you enable it.

## Enabling it

1. Open **Settings → Tools → Code execution**.
2. Turn on **Allow code execution**.
3. Set **Execution timeout** (10 to 600 seconds; default 120).
4. Check the **Code environment** block: it lists Python and Node with their version and
   whether the path was configured by you or detected in `PATH`. **Check again** re-runs the
   detection after you install an interpreter.

While the switch is off, the tool is not offered to the model at all. When it is on, the app
shows the warning that code runs on this machine with your permissions and network access —
see [Safety](#safety).

## Interpreters

- **Python**: a configured path, or `python`, `python3` or `py` from `PATH`.
- **Node**: a configured path, or `node` from `PATH`.

Nothing is downloaded automatically. If both are missing, the agent can still write text
formats; it just cannot build binary ones.

Optional packages improve the output: `python-docx`, `openpyxl`, `python-pptx`,
`reportlab` and `Pillow`. The settings screen lists which are available and offers **Copy
installation command**; installing them is your decision.

## Limits

| Limit | Value |
| --- | --- |
| Code size | 100 KB |
| Input files | 10 files, 1 MB each |
| Output files | 20 files, 25 MB each, 64 MB total |
| Workspace size | 128 MB |
| stdout / stderr | 64 KB each |
| Timeout | 120 s default, 10 s minimum, 600 s maximum; a single call can request 5 s to 10 min |
| Cancellation | The whole process tree is killed |

Output over the limit is truncated with a note; a non-zero exit still preserves the files
that were produced.

## Workspace lifecycle

Each run gets a fresh folder under `<app-data>/code-runs/<id>/`, with only the files you
allowed as input. When the run finishes:

1. New files are collected and registered as artifacts.
2. The workspace is removed.
3. The tool returns a summary with the exit code, the console output and the artifact ids.

Nothing is written to your project or home folder by this tool.

## Safety

Code execution is **not an operating-system sandbox**. A script runs as your user, with your
permissions and your network. The protections are:

- explicit opt-in, per installation;
- a disposable workspace, timeout, output caps and process-tree cancellation;
- a sanitized environment: variables matching `*API_KEY*`, `*TOKEN*`, `*SECRET*`, `LD_*`,
  `DYLD_*` and the app's own paths are removed, so app credentials are not available to the
  script;
- the agent is instructed to run only the code it needs for the requested file.

If you need stronger isolation for commands, use the Docker **Command sandbox** in
**Settings → Tools**, which applies to shell commands and background jobs — not to this
tool. See [Permissions and approvals](/docs/permissions-and-approvals#docker-command-sandbox).

## How it fits with skills

The agent does not have to invent the script. Bundled skills (`pdf`, `office-docx`,
`office-xlsx`, `office-pptx`, `imagens`) contain instructions and small standard-library
helpers that produce valid files. A typical flow is: read the skill, write a spec, run the
helper, register the artifact. See [Skills](/docs/skills).

## When it fails

| Message | Cause |
| --- | --- |
| "Code execution is disabled" | The switch in **Settings → Tools** is off |
| "Python not found" / "Node not found" | No interpreter in `PATH` and no path configured |
| "Timed out" | The script exceeded the timeout; simplify it or raise the limit |
| "Output limit exceeded" | Too much console output; write results to a file instead |
| Non-zero exit | The script failed; the console output is in the tool result |

More: [Troubleshooting](/docs/troubleshooting).
