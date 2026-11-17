# Zylara user documentation (`zylara.dev/docs`)

This folder is the publishable source for the user-facing documentation site. It is plain
Markdown so it can be dropped into the Next.js app without a build step: every page is a
file, and `nav.json` is the sidebar tree.

## Folder contract

```
site/docs/
  README.md      this file (not published)
  nav.json       sidebar tree: sections -> items { title, slug, description }
  index.md       /docs landing page
  <slug>.md      one page per route: /docs/<slug>
```

- `slug` in `nav.json` is the file name without `.md`. The landing page uses `slug: ""`
  and maps to `index.md` / `/docs`.
- Every page starts with YAML frontmatter:

```yaml
---
title: Installation
description: One sentence used for the page header, meta description and search results.
---
```

- Internal links use the published route, not the file path: `[Artifacts](/docs/artifacts)`.
  This keeps links working after the content moves into the Next.js site.
- Headings: one `#` per page (from the frontmatter title, rendered by the site), then `##`
  and `###`. Do not repeat the title as an `##`.
- Voice: second person, present tense, imperative for procedures. No marketing claims.
- UI labels are written exactly as they appear in the app (English locale,
  `src/locales/en/*.json`): **Settings → Tools → Code execution**, **Save as…**,
  **Continue with ChatGPT**. Menu paths use `→`.
- Numbers (limits, defaults, timeouts, counts) come from code or from the internal docs
  listed below. If a behaviour changes, update the page and this map together.

## Page → source map (for maintenance)

| Page | Ground truth |
| --- | --- |
| `introduction`, `index` | `README.md`, `docs/ARCHITECTURE.md` |
| `installation` | `docs/INSTALLER.md`, `installer/`, `src/locales/en/installer.json` |
| `interface`, `conversations` | `src/components/{layout,chat,composer,palette}/**`, `src/lib/hotkeys.ts`, `docs/DESIGN.md`, `docs/COMMAND_PALETTE.md` |
| `models-and-providers` | `docs/MODELS.md`, `data/catalog.json`, `src/locales/en/{models,settings}.json` |
| `attachments`, `artifacts`, `library` | `docs/FILES.md`, `src/components/artifacts/**`, `src/components/library/**` |
| `web-search` | `src-tauri/src/tools/{web_search,fetch_url}.rs`, `src/components/chat/{CitationChips,SourcesPanel}.tsx` |
| `generative-ui`, `markdown-and-math` | `data/genui-contract.json`, `docs/GENUI.md`, `docs/MARKDOWN.md` |
| `code-execution`, `skills` | `docs/FILES.md` §7–§13, `src-tauri/src/tools/code_exec.rs`, `src-tauri/skills/**` |
| `customization` | `docs/THEMES.md`, `src-tauri/themes/**`, `src/locales/en/settings.json` |
| `code-workspaces`, `code-workbench` | `docs/goals/code-harness/{WORKBENCH,TOOLS}.md`, `src/components/code/**` |
| `permissions-and-approvals` | `src-tauri/src/policy/**`, `docs/DOCKER.md`, `src/components/agent/ApprovalCard.tsx` |
| `goals-and-tasks` | `docs/goals/code-goals/PLAN.md`, `docs/TASKS.md`, `src/components/agent/{GoalCard,PlanCard,TodoCard,JobsBar,ContextMeter}.tsx` |
| `agents` | `docs/AGENTS.md`, `src/components/agents/**`, `src-tauri/src/agents/**` |
| `routines-and-queues` | `docs/AGENTS.md` §routines/queue, `src/components/agents/AgentRoutinesView.tsx` |
| `channels-and-teams` | `docs/AGENTS.md` §channels, `src/components/agents/{AgentChannelView,TeamView}.tsx` |
| `computer-use` | `docs/COMPUTER.md`, `docs/DOCKER.md`, `src/components/agents/PrivateDesktopViewer.tsx` |
| `plugins` | `docs/PLUGINS.md`, `docs/PLUGIN_STORE.md`, `docs/PLUGIN_SECURITY.md`, `data/plugin-contract.json` |
| `settings-reference` | `src/lib/settingsTabs.ts`, `src/locales/en/settings.json` |
| `keyboard-shortcuts` | `src/lib/hotkeys.ts`, `src/components/palette/CommandPalette.tsx` |
| `data-and-privacy` | `src-tauri/src/config.rs`, `src-tauri/src/db.rs`, `docs/INSTALLER.md` |
| `troubleshooting` | all of the above |

## Reviewing a change

1. Open the page and the mapped source; confirm every label, default and limit.
2. Check links: every `/docs/<slug>` target exists in `nav.json`.
3. Keep the page under ~900 words; move exhaustive lists to tables.

The documentation describes Zylara **0.13.1**. State the version only where behaviour is
version-sensitive (updates, installers, model catalog).
