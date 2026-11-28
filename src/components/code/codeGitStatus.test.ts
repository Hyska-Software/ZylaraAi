import { describe, expect, it } from 'vitest';
import type { WorkspaceGitStatus } from '@/lib/types';

import {
  deriveGitFileState,
  gitCodePresentation,
  gitStatusPresentation,
  type GitFileStateKind,
} from './codeGitStatus';

function status(overrides: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    isRepo: true,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

describe('deriveGitFileState', () => {
  it('returns null outside a repository', () => {
    expect(deriveGitFileState(status({ isRepo: false }), 'src/a.ts')).toBeNull();
    expect(deriveGitFileState(null, 'src/a.ts')).toBeNull();
  });

  it('reads worktree status letters', () => {
    expect(deriveGitFileState(status({ unstaged: [{ path: 'src/a.ts', status: 'M' }] }), 'src/a.ts')).toEqual({
      code: 'M',
      kind: 'modified',
      staged: false,
      unstaged: true,
    });
    expect(deriveGitFileState(status({ staged: [{ path: 'new.ts', status: 'A' }] }), 'new.ts')).toEqual({
      code: 'A',
      kind: 'added',
      staged: true,
      unstaged: false,
    });
  });

  it('maps every tracked change letter', () => {
    const cases: Array<[string, GitFileStateKind]> = [
      ['D', 'deleted'],
      ['R', 'renamed'],
      ['C', 'copied'],
      ['T', 'typeChanged'],
      ['U', 'conflicted'],
    ];
    for (const [code, kind] of cases) {
      expect(deriveGitFileState(status({ unstaged: [{ path: 'a.ts', status: code }] }), 'a.ts')?.kind).toBe(kind);
    }
  });

  it('uses path lists for conflicted and untracked files', () => {
    expect(deriveGitFileState(status({ conflicted: ['a.ts'] }), 'a.ts')).toEqual({
      code: 'U',
      kind: 'conflicted',
      staged: false,
      unstaged: false,
    });
    expect(deriveGitFileState(status({ untracked: ['a.ts'] }), 'a.ts')).toEqual({
      code: '?',
      kind: 'untracked',
      staged: false,
      unstaged: false,
    });
  });

  it('prefers the staged letter but reports both lanes', () => {
    expect(
      deriveGitFileState(
        status({
          staged: [{ path: 'a.ts', status: 'M' }],
          unstaged: [{ path: 'a.ts', status: 'D' }],
        }),
        'a.ts',
      ),
    ).toEqual({ code: 'M', kind: 'modified', staged: true, unstaged: true });
  });

  it('normalizes path separators and leading ./', () => {
    const current = status({ staged: [{ path: 'src/a.ts', status: 'M' }] });
    expect(deriveGitFileState(current, 'src\\a.ts')?.code).toBe('M');
    expect(deriveGitFileState(current, './src/a.ts')?.code).toBe('M');
  });

  it('returns null for unknown letters and unrelated paths', () => {
    expect(deriveGitFileState(status({ unstaged: [{ path: 'a.ts', status: 'X' }] }), 'a.ts')).toBeNull();
    expect(deriveGitFileState(status({ unstaged: [{ path: 'a.ts', status: 'M' }] }), 'b.ts')).toBeNull();
  });
});

describe('gitStatusPresentation', () => {
  it('provides a glyph, label key and token class for every state', () => {
    const expected: Array<[GitFileStateKind, string, string, string]> = [
      ['added', 'A', 'code:tree.badge.added', 'text-success'],
      ['modified', 'M', 'code:tree.badge.modified', 'text-warning'],
      ['deleted', 'D', 'code:tree.badge.deleted', 'text-danger'],
      ['renamed', 'R', 'code:tree.badge.renamed', 'text-accent'],
      ['copied', 'C', 'code:tree.badge.copied', 'text-accent'],
      ['typeChanged', 'T', 'code:gitStatus.typeChanged', 'text-accent'],
      ['conflicted', 'U', 'code:tree.badge.conflicted', 'text-danger'],
      ['untracked', '?', 'code:tree.badge.untracked', 'text-foreground-subtle'],
      ['ignored', '!', 'code:tree.badge.ignored', 'text-foreground-subtle'],
    ];
    for (const [kind, glyph, labelKey, className] of expected) {
      expect(gitStatusPresentation(kind)).toEqual({ glyph, labelKey, className });
    }
  });

  it('resolves a tree badge letter into the same presentation', () => {
    expect(gitCodePresentation('m')).toEqual(gitStatusPresentation('modified'));
    expect(gitCodePresentation('?')).toEqual(gitStatusPresentation('untracked'));
    expect(gitCodePresentation('X')).toBeNull();
  });
});
