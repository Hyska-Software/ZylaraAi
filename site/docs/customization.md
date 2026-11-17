---
title: Customization
description: Theme, text size, language, layout visibility, installed themes and plugin-provided interface options.
---

Appearance settings are split between **General** (behaviour and basics), **Themes**
(installed theme packages), **Design** (interface contributed by plugins) and **Terminal**.

## Appearance

| Setting | Where | Options |
| --- | --- | --- |
| Theme | **Settings → General → Theme** | **Light**, **Dark**, **System** |
| Text size | **Settings → General → Text size** | 90% to 115%, in 5% steps |
| Language | **Settings → General → Language** | English (default), Português (Brasil), Español |
| Reduce motion | **Settings → General → Reduce motion** | Disables transitions and animations |
| Layouts | **Settings → General → Layouts** | Shows or hides Chat, Code and Agents |

The layout pill in the title bar also has a right-click menu with the same visibility
toggles. When only one layout is enabled, the pill is hidden.

## Behaviour preferences

| Setting | Effect |
| --- | --- |
| **Send with** | `Enter` or `Ctrl/⌘ Enter`; `Shift+Enter` always inserts a newline |
| **Show token usage** | Tokens and duration under each answer |
| **Reasoning collapsed by default** | Thinking blocks start closed |
| **Auto-compaction threshold** | 50% to 90% of the context window, default 85% |
| **Keep running in the system tray** | Closing the window keeps the app and its turns alive |

## Themes

**Settings → Themes** lists the installed themes and the built-in **Zylara** palette. Bundled
extras include **aurora**, **ember**, **grove**, **nebula** and **nocturne**.

| Action | Result |
| --- | --- |
| **Use** | Applies the theme immediately; the active one is marked **Active** |
| **Install theme…** | Opens a `.zip` package |
| **Reload themes** | Re-reads the themes folder after you copy files by hand |
| **Open themes folder** | Shows `<app-data>/themes/` |
| **Remove** | Deletes the installed copy; the package on disk is untouched |

### Theme packages

A theme is a ZIP (up to 24 MB, at most 256 files) with a `theme.json` at the root or inside a
single top-level folder:

```
my-theme/
  theme.json
  fonts/        (optional)
  images/       (optional)
```

Only the files referenced by the manifest (`fonts`, `wallpaper`) are extracted, and file
names must use `/`, without `..` or absolute paths. Reinstalling the same id replaces the
folder atomically. Themes define colors, radii, typography and an optional wallpaper through
design tokens — the app never runs code from a theme.

## Design (plugin interface)

Plugins can contribute sidebar entries, pages, panels, slots and component variants. The
**Design** tab shows what each layout currently uses:

| Control | Result |
| --- | --- |
| Layout tabs (**Chat**, **Code**, **Agents**) | Select which layout to inspect |
| **Presets** / **Component variants** | Choose the active preset and per-component variant |
| **Disable plugin UI** / **Enable plugin UI** | Hides every plugin-contributed surface in all layouts without uninstalling anything |
| **Reset this layout** / **Reset all plugin UI** | Returns to the host defaults |
| **Conflicts** and **Active modifications** | Shows what overrides what |

This is also the recovery path when a plugin's interface misbehaves: disable plugin UI, then
remove the plugin in [Plugins](/docs/plugins).

## Terminal

**Settings → Terminal** sets the font family (default JetBrains Mono Variable) and size used
by the integrated terminal and by code blocks that follow the terminal font.

## What is not customizable

- No arbitrary CSS injection: colors and spacing come from the active theme's tokens.
- The composer layout, transcript order and panel positions are fixed per layout.
- Plugin UI can be disabled, not rearranged beyond the presets a plugin declares.

Next: [Workspaces and sessions](/docs/code-workspaces).
