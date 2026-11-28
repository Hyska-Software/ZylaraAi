/**
 * Git status alphabet shared by the Code file tabs and the workspace tree.
 *
 * `WorkspaceGitStatus` carries single uppercase letters in its staged/unstaged
 * lists and keeps untracked/conflicted files in path-only lists. This module is
 * the single place that turns those DTOs into a displayable state; surfaces
 * must not keep their own copies of the letter → label/colour mapping.
 */
import type { WorkspaceGitStatus } from '@/lib/types';

export type GitFileStateKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'conflicted'
  | 'untracked'
  | 'ignored';

export interface GitFileState {
  /** Display letter coming from git (`?` for untracked). */
  code: string;
  kind: GitFileStateKind;
  /** Present in the index. */
  staged: boolean;
  /** Present in the working tree. */
  unstaged: boolean;
}

export interface GitFilePresentation {
  glyph: string;
  /** i18n key of the human-readable state. */
  labelKey: string;
  /** Tailwind token class; no literal colours here. */
  className: string;
}

const KIND_BY_CODE: Record<string, GitFileStateKind> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typeChanged',
  U: 'conflicted',
  '?': 'untracked',
  '!': 'ignored',
};

const PRESENTATION: Record<GitFileStateKind, GitFilePresentation> = {
  added: { glyph: 'A', labelKey: 'code:tree.badge.added', className: 'text-success' },
  modified: { glyph: 'M', labelKey: 'code:tree.badge.modified', className: 'text-warning' },
  deleted: { glyph: 'D', labelKey: 'code:tree.badge.deleted', className: 'text-danger' },
  renamed: { glyph: 'R', labelKey: 'code:tree.badge.renamed', className: 'text-accent' },
  copied: { glyph: 'C', labelKey: 'code:tree.badge.copied', className: 'text-accent' },
  typeChanged: { glyph: 'T', labelKey: 'code:gitStatus.typeChanged', className: 'text-accent' },
  conflicted: { glyph: 'U', labelKey: 'code:tree.badge.conflicted', className: 'text-danger' },
  untracked: { glyph: '?', labelKey: 'code:tree.badge.untracked', className: 'text-foreground-subtle' },
  ignored: { glyph: '!', labelKey: 'code:tree.badge.ignored', className: 'text-foreground-subtle' },
};

/** Git reports repository-relative paths with `/`; editor paths may use `\` or `./`. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function firstCode(status: string): string {
  const trimmed = status.trim();
  return trimmed ? trimmed[0].toUpperCase() : '';
}

/**
 * Resolves the git state of one open file. Conflicted/untracked are checked
 * before the letter lists: the backend keeps them in path-only arrays. When a
 * path appears in both index and worktree, the staged letter wins for the glyph
 * while both flags stay set so the UI can describe the split state.
 */
export function deriveGitFileState(
  gitStatus: WorkspaceGitStatus | null | undefined,
  path: string,
): GitFileState | null {
  if (!gitStatus?.isRepo || !path) return null;
  const target = normalizePath(path);
  const matches = (candidate: string) => normalizePath(candidate) === target;

  if (gitStatus.conflicted?.some(matches)) {
    return { code: 'U', kind: 'conflicted', staged: false, unstaged: false };
  }

  const stagedEntry = gitStatus.staged?.find((entry) => matches(entry.path));
  const unstagedEntry = gitStatus.unstaged?.find((entry) => matches(entry.path));
  const raw = firstCode(stagedEntry?.status ?? unstagedEntry?.status ?? '');
  const kind = KIND_BY_CODE[raw];
  if (kind) {
    return { code: raw, kind, staged: !!stagedEntry, unstaged: !!unstagedEntry };
  }

  if (gitStatus.untracked?.some(matches)) {
    return { code: '?', kind: 'untracked', staged: false, unstaged: false };
  }
  return null;
}

export function gitStatusPresentation(kind: GitFileStateKind): GitFilePresentation {
  return PRESENTATION[kind];
}

/** Presents a single tree badge letter using the shared status alphabet. */
export function gitCodePresentation(code: string): GitFilePresentation | null {
  const kind = KIND_BY_CODE[firstCode(code)];
  return kind ? PRESENTATION[kind] : null;
}
