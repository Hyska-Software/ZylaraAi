// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileChange, WorkspaceGitStatus } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  getFileDiffAt: vi.fn(),
  gitStage: vi.fn(),
  gitStageAll: vi.fn(),
  gitUnstage: vi.fn(),
  gitUnstageAll: vi.fn(),
  gitDiscard: vi.fn(),
  revertFile: vi.fn(),
  gitLog: vi.fn(),
  gitCommit: vi.fn(),
  suggestCommitMessage: vi.fn(),
  gitBranches: vi.fn(),
  gitCompare: vi.fn(),
  gitCommitDetail: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({ toast: toastMocks }));

import {
  buildChangeRows,
  ChangesPanel,
  committableRows,
  countPendingChanges,
  pickBranchBase,
  rowsForGroup,
} from './ChangesPanel';

function status(overrides: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    isRepo: true,
    root: 'H:/projeto',
    branch: 'main',
    staged: [{ path: 'src/a.ts', status: 'M' }],
    unstaged: [{ path: 'src/b.ts', status: 'M' }],
    untracked: ['novo.ts'],
    conflicted: [],
    ...overrides,
  };
}

const sessionChanges: FileChange[] = [
  {
    path: 'src/b.ts',
    kind: 'modified',
    added: 4,
    removed: 1,
    diff: '@@ -1 +1 @@\n-a\n+b',
  },
];

const rowButton = (path: string) => screen.getByTitle(path);

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFileDiff.mockResolvedValue('@@ -1 +1 @@\n-a\n+b');
  mocks.getFileDiffAt.mockResolvedValue('@@ -1 +1 @@\n-a\n+b');
  mocks.gitBranches.mockResolvedValue({ current: 'main', branches: ['main', 'feature'] });
  mocks.gitCompare.mockResolvedValue({
    base: 'feature',
    mergeBase: 'abc1234deadbeef',
    files: [{ path: 'src/b.ts', status: 'M', added: 4, removed: 1 }],
  });
  mocks.gitCommitDetail.mockResolvedValue({
    hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    author: 'Ana',
    email: 'ana@example.com',
    date: '2026-11-09',
    subject: 'Add clipboard previews',
    body: '',
    files: [
      {
        path: 'src/app.ts',
        oldPath: null,
        status: 'M',
        added: 2,
        removed: 1,
        binary: false,
        diff: '@@ -1 +1 @@\n-a\n+b',
      },
    ],
    truncated: false,
  });
  mocks.gitStage.mockResolvedValue(status());
  mocks.gitStageAll.mockResolvedValue(status());
  mocks.gitUnstage.mockResolvedValue(status());
  mocks.gitUnstageAll.mockResolvedValue(status());
  mocks.gitDiscard.mockResolvedValue(status());
  mocks.revertFile.mockResolvedValue(true);
  mocks.gitLog.mockResolvedValue([]);
  mocks.gitCommit.mockResolvedValue(status());
  mocks.suggestCommitMessage.mockResolvedValue('Mensagem sugerida');
});

describe('buildChangeRows', () => {
  it('merges git + session changes and marks the origin', () => {
    const rows = buildChangeRows(status(), sessionChanges);
    expect(rows.length).toBe(3);
    const b = rows.find((row) => row.path === 'src/b.ts');
    expect(b?.origin).toBe('both');
    expect(b?.added).toBe(4);
    expect(b?.removed).toBe(1);
    expect(b?.knownDiff).toContain('+b');
    const a = rows.find((row) => row.path === 'src/a.ts');
    expect(a?.origin).toBe('git');
    expect(a?.group).toBe('staged');
  });

  it('keeps session-only files in their own group', () => {
    const rows = buildChangeRows(status(), [
      { path: 'src/novo.ts', kind: 'created', added: 10, removed: 0 },
    ]);
    const created = rows.find((row) => row.path === 'src/novo.ts');
    expect(created?.status).toBe('A');
    expect(created?.group).toBe('session');
    expect(created?.origin).toBe('session');
    expect(created?.status).toBe('A');
  });

  it('uses git-origin summary entries for counters without marking them as agent edits', () => {
    const rows = buildChangeRows(status(), [
      {
        path: 'src/a.ts',
        kind: 'modified',
        added: 7,
        removed: 2,
        origin: 'git',
        staged: true,
      },
      { path: 'novo.ts', kind: 'created', added: 3, removed: 0, origin: 'git' },
    ]);
    const a = rows.find((row) => row.path === 'src/a.ts');
    expect(a?.origin).toBe('git');
    expect(a?.group).toBe('staged');
    expect(a?.added).toBe(7);
    expect(a?.removed).toBe(2);
    const novo = rows.find((row) => row.path === 'novo.ts');
    expect(novo?.origin).toBe('git');
    expect(novo?.group).toBe('untracked');
    expect(novo?.added).toBe(3);
  });

  it('keeps a file with index and working-tree edits in both groups', () => {
    const mm = status({
      staged: [{ path: 'src/meio.ts', status: 'M' }],
      unstaged: [{ path: 'src/meio.ts', status: 'M' }],
      untracked: [],
    });
    const rows = buildChangeRows(mm, []);
    // One file, listed by both filters (and counted once).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group).toBe('staged');
    expect(rows[0]?.staged).toBe(true);
    expect(rows[0]?.alsoUnstaged).toBe(true);
    expect(rowsForGroup(rows, 'staged')).toHaveLength(1);
    expect(rowsForGroup(rows, 'unstaged')).toHaveLength(1);
  });

  it('only sums the files the commit target will include', () => {
    const rows = buildChangeRows(status(), [
      { path: 'src/a.ts', kind: 'modified', added: 7, removed: 2, origin: 'git', staged: true },
      { path: 'src/b.ts', kind: 'modified', added: 3, removed: 0, origin: 'git' },
      { path: 'src/so-sessao.ts', kind: 'modified', added: 9, removed: 4 },
    ]);
    // Session-only rows are never committed.
    expect(committableRows(rows, 'all').map((row) => row.path)).not.toContain(
      'src/so-sessao.ts',
    );
    expect(committableRows(rows, 'staged').map((row) => row.path)).toEqual(['src/a.ts']);
  });

  it('counts the pending files of the tab badge', () => {
    const session = [{ path: 'src/so-sessao.ts', kind: 'modified' as const }];
    expect(countPendingChanges(status(), session)).toBe(3);
    expect(
      countPendingChanges(status({ staged: [], unstaged: [], untracked: [] }), session),
    ).toBe(0);
    expect(
      countPendingChanges(
        status({ isRepo: false, staged: [], unstaged: [], untracked: [] }),
        session,
      ),
    ).toBe(1);
  });
});

describe('ChangesPanel', () => {
  it('groups by stage state and shows origin badges and counters', () => {
    render(<ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={sessionChanges} />);
    expect(screen.getByRole('heading', { name: /Preparados/ })).toBeTruthy();
    // Sticky group headers blend with the panel surface (same chrome as the sidebar).
    const header = screen.getByRole('heading', { name: /Preparados/ });
    expect(header.className).toContain('bg-surface');
    expect(header.className).not.toContain('bg-surface-raised');
    expect(screen.getByRole('heading', { name: /Não preparados/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Novos/ })).toBeTruthy();

    const b = rowButton('src/b.ts');
    expect(b.textContent).toContain('agente + git');
    expect(b.textContent).toContain('+4');
    expect(b.textContent).toContain('−1');
    expect(rowButton('src/a.ts').textContent).not.toContain('agente');
  });

  it('lists an MM file in both groups and counts it once', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({
          staged: [{ path: 'src/meio.ts', status: 'M' }],
          unstaged: [{ path: 'src/meio.ts', status: 'M' }],
          untracked: [],
        })}
        sessionChanges={[
          { path: 'src/meio.ts', kind: 'modified', added: 6, removed: 2, origin: 'git', staged: true },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: /Preparados/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Não preparados/ })).toBeTruthy();
    // One file, not two: the header count and the footer follow unique paths.
    expect(screen.getByText('1 arquivo')).toBeTruthy();
    expect(
      screen.getByTitle('Linhas adicionadas e removidas').textContent,
    ).toBe('+6 −2');
  });

  it('uses staged files for the footer by default and all files when nothing is staged', () => {
    const withStaged = [
      { path: 'src/a.ts', kind: 'modified' as const, added: 7, removed: 2, origin: 'git' as const, staged: true },
      { path: 'src/b.ts', kind: 'modified' as const, added: 3, removed: 0, origin: 'git' as const },
    ];
    const withoutStaged = [
      { path: 'src/a.ts', kind: 'modified' as const, added: 7, removed: 2, origin: 'git' as const },
      { path: 'src/b.ts', kind: 'modified' as const, added: 3, removed: 0, origin: 'git' as const },
    ];
    const { rerender } = render(
      <ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={withStaged} />,
    );
    const totals = () => screen.getByTitle('Linhas adicionadas e removidas').textContent;
    expect(totals()).toBe('+7 −2');

    rerender(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ staged: [] })}
        sessionChanges={withoutStaged}
      />,
    );
    expect(totals()).toBe('+10 −2');
  });

  it('ignores session-only rows in the footer and keeps the commit disabled', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ staged: [], unstaged: [], untracked: [] })}
        sessionChanges={[
          { path: 'src/ja-commitado.ts', kind: 'modified', added: 9, removed: 3 },
        ]}
      />,
    );

    expect(
      screen.getByTitle('Linhas adicionadas e removidas').textContent,
    ).toBe('+0 −0');
    const commit = screen.getByRole('button', { name: 'Commit' });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    expect(commit.getAttribute('title')).toBe('Nenhuma alteração para commitar');
  });

  it('shows git-only counters without the agent badge', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={[
          { path: 'src/a.ts', kind: 'modified', added: 7, removed: 2, origin: 'git', staged: true },
          { path: 'novo.ts', kind: 'created', added: 5, removed: 0, origin: 'git' },
        ]}
      />,
    );
    const a = rowButton('src/a.ts');
    expect(a.textContent).not.toContain('agente');
    expect(a.textContent).toContain('+7');
    expect(a.textContent).toContain('−2');
    const novo = rowButton('novo.ts');
    expect(novo.textContent).not.toContain('agente');
    expect(novo.textContent).toContain('+5');
  });

  it('marks each file row with the real file-type icon', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({
          staged: [],
          unstaged: [
            { path: 'src/main.rs', status: 'M' },
            { path: 'docs/manual.pdf', status: 'M' },
          ],
          untracked: ['novo.ts'],
        })}
        sessionChanges={[]}
      />,
    );

    const iconKey = (path: string) =>
      rowButton(path).querySelector('[data-file-icon]')?.getAttribute('data-file-icon');
    expect(iconKey('src/main.rs')).toBe('rust');
    expect(iconKey('docs/manual.pdf')).toBe('pdf');
    expect(iconKey('novo.ts')).toBe('typescript');
    // Status letter and path remain part of the row.
    expect(rowButton('src/main.rs').textContent).toContain('M');
    expect(rowButton('src/main.rs').textContent).toContain('src/main.rs');
  });

  it('shows non-ignored dotfiles in the Changes list and pending badge', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({
          staged: [],
          unstaged: [
            { path: '.env.example', status: 'M' },
            { path: '.github/workflows/ci.yml', status: 'M' },
          ],
          untracked: ['.envrc'],
        })}
        sessionChanges={[
          { path: '.env.example', kind: 'modified', added: 2, removed: 1, origin: 'git' },
          { path: '.github/workflows/ci.yml', kind: 'modified', added: 1, removed: 0, origin: 'git' },
          { path: '.envrc', kind: 'created', added: 3, removed: 0, origin: 'git' },
        ]}
      />,
    );

    expect(rowButton('.env.example')).toBeTruthy();
    expect(rowButton('.github/workflows/ci.yml')).toBeTruthy();
    expect(rowButton('.envrc')).toBeTruthy();
    expect(screen.getByText('3 arquivos')).toBeTruthy();
    expect(screen.getByTitle('Linhas adicionadas e removidas').textContent).toBe('+6 −1');
  });

  it('opens the known session diff in place and goes back', async () => {
    render(<ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={sessionChanges} />);
    fireEvent.click(rowButton('src/b.ts'));

    expect(screen.getByRole('group', { name: 'Diff de src/b.ts' })).toBeTruthy();
    expect(mocks.getFileDiff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Voltar para alterações' }));
    expect(screen.queryByRole('group', { name: /Diff de/ })).toBeNull();
    expect(rowButton('src/b.ts')).toBeTruthy();
  });

  it('loads the diff through the api when the session has none', async () => {
    render(<ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={[]} />);
    fireEvent.click(rowButton('novo.ts'));
    await waitFor(() => expect(mocks.getFileDiff).toHaveBeenCalledWith('ws-1', 'novo.ts', false));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Diff de novo.ts' })).toBeTruthy());
  });

  it('delega o diff para a aba central quando onOpenDiffTab é fornecido', async () => {
    const onOpenDiffTab = vi.fn();
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={sessionChanges}
        onOpenDiffTab={onOpenDiffTab}
      />,
    );

    fireEvent.click(rowButton('src/b.ts'));

    expect(onOpenDiffTab).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/b.ts', staged: false, knownDiff: expect.any(String) }),
    );
    // No modo aba o painel não abre o detalhe inline nem chama a API.
    expect(screen.queryByRole('group', { name: /Diff de/ })).toBeNull();
    expect(mocks.getFileDiff).not.toHaveBeenCalled();
  });

  it('stages and unstages files through the api', async () => {
    const onRefresh = vi.fn();
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={sessionChanges}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preparar novo.ts' }));
    await waitFor(() => expect(mocks.gitStage).toHaveBeenCalledWith('ws-1', ['novo.ts']));
    expect(onRefresh).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remover src/a.ts do stage' }));
    await waitFor(() => expect(mocks.gitUnstage).toHaveBeenCalledWith('ws-1', ['src/a.ts']));
  });

  it('prepares everything at once and reports the count', async () => {
    const onRefresh = vi.fn();
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={sessionChanges}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preparar tudo' }));

    await waitFor(() => expect(mocks.gitStageAll).toHaveBeenCalledWith('ws-1'));
    expect(onRefresh).toHaveBeenCalled();
    // Um arquivo já preparado + dois pendentes = 2 arquivos preparados.
    expect(toastMocks.success).toHaveBeenCalledWith('2 arquivos preparados');
  });

  it('removes every prepared file from the index at once', async () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ staged: [{ path: 'src/a.ts', status: 'M' }] })}
        sessionChanges={[]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Desmarcar tudo' }));

    await waitFor(() => expect(mocks.gitUnstageAll).toHaveBeenCalledWith('ws-1'));
    expect(toastMocks.success).toHaveBeenCalledWith('1 arquivo removido do stage');
  });

  it('does not offer "preparar tudo" while merge conflicts are pending', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({
          conflicted: ['src/c.ts'],
          staged: [],
          unstaged: [],
          untracked: [],
        })}
        sessionChanges={[]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Preparar tudo' })).toBeNull();
    expect(screen.getByText('Conflitos de merge — resolva antes de commitar.')).toBeTruthy();
  });

  it('reverts a git file through the confirmation dialog', async () => {
    render(<ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reverter src/a.ts' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reverter arquivo?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverter' }));

    await waitFor(() => expect(mocks.gitDiscard).toHaveBeenCalledWith('ws-1', ['src/a.ts']));
    expect(toastMocks.success).toHaveBeenCalledWith('Arquivo revertido');
  });

  it('reverts a session change through revertFile', async () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        conversationId="conv-1"
        gitStatus={status()}
        sessionChanges={sessionChanges}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reverter src/b.ts' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverter' }));

    await waitFor(() => expect(mocks.revertFile).toHaveBeenCalledWith('conv-1', 'src/b.ts'));
  });

  it('shows the no-git notice and keeps session changes visible', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ isRepo: false, staged: [], unstaged: [], untracked: [] })}
        sessionChanges={[{ path: 'src/x.ts', kind: 'created', added: 2, removed: 0 }]}
      />,
    );
    expect(screen.getByText('Não é um repositório Git.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Da sessão/ })).toBeTruthy();
    expect(rowButton('src/x.ts')).toBeTruthy();
  });

  it('shows the honest empty state', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ staged: [], unstaged: [], untracked: [] })}
        sessionChanges={[]}
      />,
    );
    expect(screen.getByText('Nenhuma alteração pendente')).toBeTruthy();
    expect(screen.getByText('Arquivos ocultos não ignorados aparecem aqui; arquivos ignorados pelo Git ficam fora da lista.')).toBeTruthy();
  });

  it('warns about merge conflicts and blocks the commit', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ conflicted: ['src/c.ts'] })}
        sessionChanges={sessionChanges}
      />,
    );
    expect(screen.getByText('Conflitos de merge — resolva antes de commitar.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Commit' }).getAttribute('title')).toBe(
      'Resolva os conflitos de merge antes de commitar',
    );
  });

  it('surfaces git and session read errors', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        gitError="git indisponível"
        sessionChanges={[]}
        sessionError="journal indisponível"
      />,
    );
    expect(screen.getByText('git indisponível')).toBeTruthy();
    expect(screen.getByText('journal indisponível')).toBeTruthy();
  });

  it('defaults to uncommitted and hides session-only rows', () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ staged: [], unstaged: [], untracked: [] })}
        sessionChanges={[{ path: 'src/so-sessao.ts', kind: 'modified', added: 1, removed: 0 }]}
      />,
    );
    expect(screen.queryByTitle('src/so-sessao.ts')).toBeNull();
    expect(screen.getByText('Nenhuma alteração pendente')).toBeTruthy();
  });

  it('filters staged, unstaged and last-turn rows', async () => {
    const cumulative: FileChange[] = [
      ...sessionChanges,
      { path: 'src/velho.ts', kind: 'modified', added: 1, removed: 0 },
    ];
    const view = render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={cumulative}
        lastTurnChanges={[sessionChanges[0]]}
      />,
    );
    const user = userEvent.setup();
    const choose = async (name: string) => {
      await user.click(screen.getByRole('button', { name: 'Filtrar alterações' }));
      await user.click(screen.getByRole('menuitem', { name }));
    };

    await choose('Marcadas para commit');
    expect(rowButton('src/a.ts')).toBeTruthy();
    expect(screen.queryByTitle('src/b.ts')).toBeNull();
    expect(screen.queryByTitle('novo.ts')).toBeNull();

    await choose('Não marcadas para commit');
    expect(rowButton('src/b.ts')).toBeTruthy();
    expect(rowButton('novo.ts')).toBeTruthy();
    expect(screen.queryByTitle('src/a.ts')).toBeNull();

    await choose('Último turno');
    expect(rowButton('src/b.ts')).toBeTruthy();
    expect(screen.queryByTitle('src/velho.ts')).toBeNull();

    await choose('Sem commit');
    expect(rowButton('src/a.ts')).toBeTruthy();
    expect(rowButton('src/b.ts')).toBeTruthy();
    expect(rowButton('novo.ts')).toBeTruthy();
    expect(screen.queryByTitle('src/velho.ts')).toBeNull();

    view.unmount();
  });

  it('lists a commit and opens its known patch without stage actions', async () => {
    const commits = [
      {
        hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        subject: 'Add clipboard previews',
        author: 'Ana',
        date: '2026-11-09',
      },
    ];
    const onOpenDiffTab = vi.fn();
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={[]}
        commits={commits}
        onOpenDiffTab={onOpenDiffTab}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filtrar alterações' }));
    await user.click(screen.getByRole('menuitem', { name: 'Commit' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /a1b2c3d · Add clipboard previews/ }));

    await waitFor(() =>
      expect(mocks.gitCommitDetail).toHaveBeenCalledWith('ws-1', commits[0].hash),
    );
    const row = await screen.findByTitle('src/app.ts');
    expect(screen.queryByRole('button', { name: 'Preparar src/app.ts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
    fireEvent.click(row);
    expect(onOpenDiffTab).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'src/app.ts',
        knownDiff: '@@ -1 +1 @@\n-a\n+b',
      }),
    );
  });

  it('compares against a branch and opens the ref diff', async () => {
    render(<ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filtrar alterações' }));
    await user.click(screen.getByRole('menuitem', { name: 'Branch' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'feature' }));

    await waitFor(() => expect(mocks.gitCompare).toHaveBeenCalledWith('ws-1', 'feature'));
    expect(await screen.findByRole('heading', { name: /Branch feature/ })).toBeTruthy();
    fireEvent.click(await screen.findByTitle('src/b.ts'));
    await waitFor(() =>
      expect(mocks.getFileDiffAt).toHaveBeenCalledWith(
        'ws-1',
        'src/b.ts',
        'abc1234deadbeef',
      ),
    );
  });

  it('passes the branch merge-base to the central diff tab', async () => {
    const onOpenDiffTab = vi.fn();
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status()}
        sessionChanges={[]}
        onOpenDiffTab={onOpenDiffTab}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filtrar alterações' }));
    await user.click(screen.getByRole('menuitem', { name: 'Branch' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'feature' }));
    await waitFor(() => expect(mocks.gitCompare).toHaveBeenCalled());
    fireEvent.click(await screen.findByTitle('src/b.ts'));
    expect(onOpenDiffTab).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/b.ts', base: 'abc1234deadbeef' }),
    );
  });

  it('resolves the default branch from the empty state', async () => {
    render(
      <ChangesPanel
        workspaceId="ws-1"
        gitStatus={status({ staged: [], unstaged: [], untracked: [] })}
        sessionChanges={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ver diff da branch' }));

    await waitFor(() => expect(mocks.gitBranches).toHaveBeenCalledWith('ws-1'));
    await waitFor(() => expect(mocks.gitCompare).toHaveBeenCalledWith('ws-1', 'feature'));
    expect(await screen.findByRole('heading', { name: /Branch feature/ })).toBeTruthy();
  });

  it('scopes bulk actions to the visible filter', async () => {
    render(<ChangesPanel workspaceId="ws-1" gitStatus={status()} sessionChanges={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filtrar alterações' }));
    await user.click(screen.getByRole('menuitem', { name: 'Marcadas para commit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desmarcar tudo' }));
    await waitFor(() =>
      expect(mocks.gitUnstage).toHaveBeenCalledWith('ws-1', ['src/a.ts']),
    );
    expect(mocks.gitUnstageAll).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Filtrar alterações' }));
    await user.click(screen.getByRole('menuitem', { name: 'Não marcadas para commit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preparar tudo' }));
    await waitFor(() =>
      expect(mocks.gitStage).toHaveBeenCalledWith(
        'ws-1',
        expect.arrayContaining(['src/b.ts', 'novo.ts']),
      ),
    );
    expect(mocks.gitStageAll).not.toHaveBeenCalled();
  });
});

describe('pickBranchBase', () => {
  it('prefers main, then master, then the first other branch', () => {
    expect(pickBranchBase(['main', 'dev'], null)).toBe('main');
    expect(pickBranchBase(['master', 'dev'], 'feature')).toBe('master');
    expect(pickBranchBase(['dev', 'outra'], 'main')).toBe('dev');
    expect(pickBranchBase(['main'], 'main')).toBeNull();
    expect(pickBranchBase([], null)).toBeNull();
  });
});

  it('arquivo novo aparece como A e mostra o diff sem staging', async () => {
    const untrackedStatus = status({
      staged: [],
      unstaged: [],
      untracked: ['novo.ts'],
      conflicted: [],
    });
    mocks.getFileDiff.mockResolvedValue(
      'diff --git a/novo.ts b/novo.ts\nnew file mode 100644\n--- /dev/null\n+++ b/novo.ts\n@@ -0,0 +1 @@\n+ola',
    );
    render(<ChangesPanel workspaceId="ws-1" gitStatus={untrackedStatus} sessionChanges={[]} />);

    const row = rowButton('novo.ts');
    expect(row.textContent).toContain('A');
    expect(row.textContent).not.toContain('?');

    fireEvent.click(row);
    await waitFor(() => expect(mocks.getFileDiff).toHaveBeenCalledWith('ws-1', 'novo.ts', false));
    expect(await screen.findByRole('group', { name: 'Diff de novo.ts' })).toBeTruthy();
  });