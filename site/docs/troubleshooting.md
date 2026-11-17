---
title: Troubleshooting
description: Fix common problems with providers, models, streaming, files, code execution, Docker, plugins and updates.
---

Start with the message the app showed. Most failures name the provider, the tool or the file
involved, and the fix is one setting away.

## Providers and credentials

| Symptom | Cause | Fix |
| --- | --- | --- |
| Composer banner asking for a provider | No credential configured | **Open Providers** and add a key, or sign in with ChatGPT |
| "No API key for *provider*" | The selected model belongs to an unconnected provider | Connect it in **Settings → Providers**, or pick a model from a provider you already have |
| 401 / unauthorized | Wrong, expired or revoked key | Paste the key again, then **Test connection** |
| 403 on a model | Your account has no access to that model | Choose another model or upgrade the provider plan |
| "ChatGPT session expired" | The OAuth session ended | **Reconnect** in **Settings → Providers → OpenAI** |

Environment variables and an existing OpenCode CLI login are used automatically; the badge
next to the provider tells you which source is active.

## Models and answers

| Symptom | Cause | Fix |
| --- | --- | --- |
| Model marked **Unavailable** | Provider removed it or your account cannot use it | Pick another model |
| Model pill disabled | A turn is running | Stop the answer or wait |
| Answer stops mid-sentence | Provider limit, context window or network drop | Retry, or start a new conversation |
| Thinking block empty | The model does not stream reasoning | Normal; check the model details |
| Answer ignores an attachment | Non-vision model, or attachments disabled | Use the **Vision** filter and enable **Send attachments to the model** |
| Costs look wrong | Prices come from the catalog, not from the invoice | Use the provider console as the source of truth |

## Streaming and turns

| Symptom | Fix |
| --- | --- |
| Turn never starts | Check the provider badge; run **Test connection** |
| Long silence before the first token | Raise **First token timeout** in **Settings → Providers → Reliability** |
| Stuck after a network change | Stop the turn and send again; partial text is preserved |
| "Context compacted" keeps appearing | Raise **Auto-compaction threshold** or start a new conversation |
| Background session finished with no answer | Open the session; notifications are in **Settings → Agents → Notifications** |

## Files, artifacts and the Library

| Symptom | Fix |
| --- | --- |
| No artifact card | Enable **Create files** in the composer; confirm the model supports tool calls |
| PDF/DOCX/XLSX not generated | Enable **Code execution** and install Python or Node |
| Preview says it is unavailable | Use **Save as…** and open the file in the system app |
| Office preview looks plain | Expected: previews are structural, without colors or merged cells |
| Library shows nothing | Clear filters; check the conversation was not deleted |
| Scanned PDF gives no text | There is no OCR; convert the file to text first |

## Code execution

| Symptom | Fix |
| --- | --- |
| "Code execution is disabled" | **Settings → Tools → Code execution → Allow code execution** |
| "Python not found" / "Node not found" | Install the interpreter or set its path, then **Check again** |
| "Timed out" | Simplify the script or raise **Execution timeout** |
| "Output limit exceeded" | Write results to a file instead of printing them |
| Script exits non-zero | Read the console output in the tool result; artifacts produced before the error are kept |

## Docker, sandbox and computer use

| Symptom | Fix |
| --- | --- |
| Docker not found | Install Docker Desktop/Engine and press **Start Docker** |
| Command sandbox fails to start | **Validate image**, then **Download image**; check the image name |
| Container keeps running | **Clean up containers** in **Settings → Tools** or **Settings → Agents** |
| Screen tab is black | **Diagnostics** in the private-desktop settings; restart the container |
| Computer use actions denied | Approve the card, or grant the capability to the agent |
| Keyboard stuck during takeover | Press `Ctrl+Alt+Shift+Q` |

## Plugins

| Symptom | Fix |
| --- | --- |
| App will not start after installing a plugin | Start in **Safe mode** or with `--disable-plugins`, then remove the plugin |
| Plugin UI disappeared | **Settings → Design → Enable plugin UI** |
| Install rejected | Check the signature, the hash and the requested permissions; HTTPS is required |
| Plugin installed but inactive | Agent-installed plugins land disabled; enable it yourself |
| Update fails | Roll back to the previous version, then retry |

## Updates

| Symptom | Fix |
| --- | --- |
| No update notification | **Settings → About → Check now**; stable releases only |
| Version was skipped | A newer version overrides **Skip this version**; check again |
| Download fails | Verify the network and free space; the partial file is discarded |
| "Install and restart" missing | Only managed installs (Linux x64/macOS arm64 script) support it; otherwise open the downloaded package |
| Hash mismatch | Do not install; download again from the release page |

## Performance

| Symptom | Fix |
| --- | --- |
| App feels slow with long conversations | Start a new conversation; enable auto-compaction earlier |
| Cache hit rate low | Keep the system prompt and tool set stable; check **Cache diagnostics** for the break reason |
| High memory after many artifacts | Close previews; large PDFs and videos are held by the panel |
| Fan noise during a turn | Reasoning models use the CPU/GPU of the provider, not yours; local load comes from previews |

## FAQ

**Does Zylara need an account?** No. You connect a provider; there is no Zylara login.

**Can I use it offline?** The app opens and your history is local, but answers require the
provider. Web search is the only feature that talks to a search engine.

**Where are my API keys?** In `secrets.json` inside the data folder, read only by the backend.
See [Data and privacy](/docs/data-and-privacy#credentials).

**Do I lose my chats if I uninstall?** No, unless you choose **Also remove my data** or
`--purge`.

**Can the agent commit without me?** No. It can edit and run commands within its permission
mode, but staging, committing and pushing are manual.

**Why does a model behave differently in Code?** Code sessions use a different profile: file,
shell and git tools, a coding prompt and a context meter. See
[Workspaces and sessions](/docs/code-workspaces).

If none of this applies, collect the version, the provider and model, the exact error text and
the step that produced it — that is enough to reproduce most problems.
