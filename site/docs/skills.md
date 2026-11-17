---
title: Skills
description: Instructions and scripts that teach the agent how to build each format, plus how to add your own.
---

A skill is a folder with a `SKILL.md` file: frontmatter with a name and a description, then
instructions the agent reads when it needs them. Skills can include helper scripts, so the
agent does not have to improvise how to write a DOCX or a PDF.

Skills are loaded on demand. The agent sees a short catalog in its prompt and reads the full
skill only when a task matches.

## Bundled skills

| Skill | Teaches |
| --- | --- |
| `office-docx` | Word documents: headings, paragraphs, tables, styles |
| `office-xlsx` | Excel workbooks: sheets, formulas, number formats |
| `office-pptx` | PowerPoint decks: slides, titles, bullets, notes |
| `pdf` | PDF files with text and basic layout |
| `imagens` | Raster and SVG images, sizes and formats |

Plugin-authoring skills (`plugin-authoring`, `plugin-manifest`, `plugin-ui`, `plugin-genui`,
`plugin-agent`, `plugin-trusted`, `plugin-package`) are also bundled and drive the in-app
plugin creator — see [Plugins](/docs/plugins).

Bundled skills cannot be deleted, only disabled.

## Your own skills

Put a folder in the app-data `skills/` directory:

```
<app-data>/skills/my-skill/
  SKILL.md
  scripts/helper.py      (optional)
```

`SKILL.md`:

```markdown
---
name: my-skill
description: One line the agent sees in the catalog, before it decides to open the skill.
---

# My skill

Explain the steps, the file format and any limits. Reference scripts by relative path.
```

Open the folder with **Settings → Tools → Skills → Open skills folder** or from the Skills
page. **Reload** the page after adding files by hand.

### Rules

| Rule | Value |
| --- | --- |
| Name | `[a-z0-9][a-z0-9-]{0,63}`, matching the folder |
| Description | Up to 1,024 characters; YAML block scalars (`>` / `|`) are supported |
| Body | Up to 512 KB |
| Scan depth | One level inside the skills folder; hidden folders are ignored |
| Prompt excerpt | About 200 characters of the description |

Skills are plain Markdown plus optional scripts. Helpers should use the standard library
only, so a user does not need to install packages to use them.

## Skills from other tools

Zylara reads the skill folders other agents use, **read-only**:

- `~/.agents/skills`
- `$CODEX_HOME/skills` or `~/.codex/skills`
- `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`
- `$XDG_CONFIG_HOME/opencode/skills`, `~/.config/opencode/skills` or
  `%APPDATA%\opencode\skills`

They are never modified or deleted by Zylara. When two skills share a name, precedence is
**Zylara → agents → Codex → Claude → OpenCode → bundled**.

## Managing skills

The **Skills** page (sidebar, below **New chat**) groups skills by source: **From Zylara**,
**Agents**, **Codex**, **Claude**, **OpenCode** and **Bundled**.

| Action | Notes |
| --- | --- |
| Enable / disable | A disabled skill is not listed to the agent and its scripts are not used |
| Preview | **Document** and **Code** views, plus **Version history** when available |
| Delete | Only for skills you created; bundled and external skills show **Read-only** |

**Settings → Tools → Skills** has the counts, the **Skills panel in the sidebar** switch,
**Manage skills** and **Open skills folder**.

## When the agent uses a skill

The prompt lists the catalog; the agent calls `read_skill` for the one that matches, gets the
instructions and the script paths, then uses [code execution](/docs/code-execution) to run
them. The thinking block shows the read and the run, so you can see which skill produced a
file.

## Writing a good skill

1. State the goal in one sentence and the output format precisely.
2. List the required fields of the spec the agent must build.
3. Provide a helper that validates its input and exits non-zero with a clear message.
4. Keep the body short; long reference tables belong in a separate file the agent can read.
5. Test it by asking for the format with the skill enabled and no other instructions.

Next: [Customization](/docs/customization).
