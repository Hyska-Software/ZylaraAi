---
title: Workbench
description: Files, changes, diffs, commits, branches, history and the terminal, side by side with the agent.
---

The Code layout puts a workbench next to the transcript. The right panel has three tabs —
**Files**, **Changes** and **Terminal** — and files, diffs and history open as central tabs.

## Files

The tree lists the workspace with Git status badges: **Modified**, **Added**, **Deleted**,
**Renamed**, **Copied**, **Conflicted**, **Untracked** and **Ignored**. **Filter files…**
narrows the tree; a counter reports *"Showing N of M files"*.

Clicking a file opens it in a central tab with line numbers and syntax highlighting. Markdown
files get a **Document / Code** toggle, and the tab offers **Line wrap**, **Reload file** and
**Open in external editor**. Images and PDFs preview inline. Files are read-only in the
workbench: edits go through the agent or your editor.

## Changes

The panel groups changes by state:

| Group | Meaning |
| --- | --- |
| **Staged** | In the index, ready to commit |
| **Not staged** | Modified in the working tree |
| **New** | Untracked files |
| **From session** | Files the agent touched in this session |

A badge marks the origin: **agent** when the change came from the agent's journal, **agent +
git** when both agree. **Stage all** and **Unstage all** act on the group; each file has
**Stage** and **Revert**.

The filter menu switches the comparison: **Last turn**, **Uncommitted**, **Not staged**,
**Staged**, **Commit <hash>**, **Branch <name>** and **Compare with a branch**.

Merge conflicts show a banner — *"Merge conflicts — resolve them before committing"* — and
block **Stage all** until resolved.

### Diff and revert

Opening a changed file shows a unified or side-by-side diff with collapsible hunks and
**Copy patch**. Large or binary files fall back to a card instead of a diff.

- **Revert file** restores that file to its previous content, after a confirmation.
- **Revert turn** (turn footer, **Revert**) undoes every file change made in the last turn.
- Neither deletes the conversation.

Reverting is journal-based: changes the agent made through its own tools can be undone.
Files rewritten by a shell command the agent ran (a formatter, a generator) are only visible
as Git changes, and are reverted through Git, not through the journal.

## Commit

The commit bar sits under the Changes panel:

| Field | Options |
| --- | --- |
| Scope | **All**, **Staged (N)** or **Selection (N)** |
| Message | **Commit message…**, or **Suggest** for an AI-written message |
| Action | **Commit**, with the reason shown when it is disabled |

Commit is disabled when no workspace is open, the folder is not a repository, there are no
changes, nothing is staged for the selected scope, or the message is empty. Success shows
**Commit created (hash)**.

The agent never stages, commits or pushes. Review is yours.

## Branches and remotes

The branch picker in the panel bar switches branches and creates new ones (**Switch branch**,
**New branch**, **Create and switch**, grouped into local and remote). The Git menu offers
**Fetch**, **Pull** and **Push** as explicit actions. They are never triggered by the agent.

## History

**Commits** opens the commit history as a central tab, and the panel shows a collapsible
**Recent commits (N)** list. Selecting a commit shows its files and diff; the Changes filter
can compare the working tree against it.

## Terminal

The **Terminal** tab is your shell, not the agent's:

- It starts in the workspace folder with your system shell.
- **New terminal**, **Clear terminal**, **Kill process**, **Restart terminal**.
- Status shows **Running** or **Exited (code N)**.
- Up to four terminals, 5,000 lines of scrollback, using the app theme and the font from
  **Settings → Terminal**.
- Closing a terminal tab kills its process tree.

`Ctrl/⌘ Shift+T` opens a terminal as a central tab. The agent uses commands and background
jobs instead; when it needs an interactive process, it asks you.

## Turn summary

At the end of a turn in a workspace, the transcript shows the duration, tokens, changed files
and a `+42 −7` counter with **View changes** and **Revert**. **View changes** opens the diff
for that turn, which is the fastest way to review what the agent did before committing.

Next: [Permissions and approvals](/docs/permissions-and-approvals).
