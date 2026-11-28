// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const copyTextMock = vi.hoisted(() => vi.fn());
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, copyText: copyTextMock };
});
vi.mock('sonner', () => ({ toast: toastMocks }));

vi.mock('@/lib/api', () => ({
  api: {
    listWorkspaces: vi.fn(),
    listWorkspaceFiles: vi.fn(),
    refreshWorkspaceTree: vi.fn(),
    watchWorkspace: vi.fn(),
    unwatchWorkspace: vi.fn(),
    gitStatus: vi.fn(),
    gitFetch: vi.fn(),
    gitPull: vi.fn(),
    gitPush: vi.fn(),
    gitBranches: vi.fn(),
    gitCreateBranch: vi.fn(),
    gitSwitchBranch: vi.fn(),
    getWorkspace: vi.fn(),
    gitLog: vi.fn(),
    readWorkspaceFile: vi.fn(),
    getFileDiff: vi.fn(),
    gitStage: vi.fn(),
    gitUnstage: vi.fn(),
    gitDiscard: vi.fn(),
    getCodeSessionState: vi.fn(),
    gitCommit: vi.fn(),
    suggestCommitMessage: vi.fn(),
    revertFile: vi.fn(),
    getWorkspaceChanges: vi.fn(),
    listTerminals: vi.fn(),
    createWorkspaceFile: vi.fn(),
    createWorkspaceDir: vi.fn(),
    renameWorkspaceEntry: vi.fn(),
    duplicateWorkspaceEntry: vi.fn(),
    deleteWorkspaceEntry: vi.fn(),
    revealWorkspaceEntry: vi.fn(),
    saveWorkspaceFile: vi.fn(),
  },
}));

const watchEvents = vi.hoisted(() => ({
  handlers: [] as Array<(event: { payload: unknown }) => void>,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: unknown }) => void) => {
      watchEvents.handlers.push(handler);
      return () => {
        const index = watchEvents.handlers.indexOf(handler);
        if (index >= 0) watchEvents.handlers.splice(index, 1);
      };
    },
  ),
}));

import { api } from '@/lib/api';
import {
  CODE_PANEL_TAB_ORDER_DEFAULT,
  SIDE_PANEL_WIDTH_DEFAULT,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_STEP,
  useChatStore,
  useCodeStore,
  useUiStore,
  emptyCodeSession,
} from '@/lib/store';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { setPluginUiState } from '@/lib/plugins/ui/registry';
import type { PanelTabSpec, SlotContribution } from '@/lib/plugins/ui/types';
import type { Conversation, Workspace, WorkspaceFileEntry, WorkspaceGitStatus } from '@/lib/types';
import { __resetWorkspacesForTests } from './useWorkspaces';
import { CodePanel } from './CodePanel';

const apiMock = vi.mocked(api);

const originalInnerWidth = window.innerWidth;

/** `useViewportWidth` reads `window.innerWidth`; keep it in sync with the resize event. */
function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

const panel = (): HTMLElement | null => screen.queryByRole('complementary');
const requiredPanel = (): HTMLElement =>
  screen.getByRole('complementary', { name: 'Painel de arquivos e alterações' });

function resetPanelState(): void {
  useUiStore.setState({
    codePanelOpen: true,
    codePanelTab: 'changes',
    codePanelOpenTabs: [...CODE_PANEL_TAB_ORDER_DEFAULT],
    codePanelTabOrder: [...CODE_PANEL_TAB_ORDER_DEFAULT],
    sidePanelWidth: SIDE_PANEL_WIDTH_DEFAULT,
    sidebarOpen: true,
    sidebarWidth: 272,
    codeView: 'session',
    codeFileTab: null,
    codeFileTreeExpandedByWorkspace: {},
    pluginDockTab: { chat: null, code: null, agent: null },
  });
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Sessão de código',
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
    messageCount: 0,
    preview: null,
    mode: 'code',
    codeLinked: false,
    workspaceId: null,
    agentKind: 'zylara',
    permissionMode: 'edit',
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'zylara',
    path: 'C:/projetos/zylara',
    createdAt: 1,
    updatedAt: 2,
    trusted: true,
    git: { root: 'C:/projetos/zylara', branch: 'main', ahead: 0, behind: 0, dirty: true },
    ...overrides,
  };
}

function notRepoStatus(): WorkspaceGitStatus {
  return { isRepo: false, staged: [], unstaged: [], untracked: [], conflicted: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  copyTextMock.mockResolvedValue(true);
  watchEvents.handlers.length = 0;
  apiMock.listWorkspaces.mockResolvedValue([]);
  apiMock.listWorkspaceFiles.mockResolvedValue([]);
  apiMock.refreshWorkspaceTree.mockResolvedValue({
    files: [],
    dirs: {},
    gitStatus: notRepoStatus(),
  });
  apiMock.watchWorkspace.mockResolvedValue(undefined);
  apiMock.unwatchWorkspace.mockResolvedValue(undefined);
  apiMock.gitLog.mockResolvedValue([]);
  apiMock.gitBranches.mockResolvedValue({ current: 'main', branches: ['main'], all: [] });
  apiMock.getWorkspace.mockResolvedValue(null);
  apiMock.getCodeSessionState.mockResolvedValue({
    conversationId: 'conv-1',
    permissionMode: 'autonomous',
    planMode: false,
    todos: [],
    context: null,
    changes: null,
    lastTurnChanges: null,
    jobs: [],
    approvals: [],
    questions: [],
  });
  apiMock.listTerminals.mockResolvedValue([]);
  apiMock.createWorkspaceFile.mockResolvedValue('note.md');
  apiMock.createWorkspaceDir.mockResolvedValue('pasta');
  apiMock.renameWorkspaceEntry.mockResolvedValue('src/renomeado.ts');
  apiMock.duplicateWorkspaceEntry.mockResolvedValue('src/app (copy).ts');
  apiMock.deleteWorkspaceEntry.mockResolvedValue(undefined);
  apiMock.revealWorkspaceEntry.mockResolvedValue(undefined);
  apiMock.saveWorkspaceFile.mockResolvedValue(null);
  setViewport(1440);
  resetPanelState();
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  __resetWorkspacesForTests();
  useChatStore.setState({ conversations: [], activeId: null });
  useCodeStore.setState({ byConversation: {} });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
});

describe('CodePanel — visibilidade', () => {
  it('aparece como painel fixo ao lado da conversa em janelas largas', () => {
    render(<CodePanel />);

    const aside = requiredPanel();
    expect(aside.style.width).toBe(`${SIDE_PANEL_WIDTH_DEFAULT}px`);
    // Mirrors the left sidebar chrome: same surface, no vertical divider.
    expect(aside.className).not.toContain('border-l');
    expect(aside.className).toContain('bg-surface');
    expect(aside.className).not.toContain('bg-surface-raised');
    expect(screen.getByRole('tablist', { name: 'Conteúdo do painel' })).toBeTruthy();
  });

  it('aplica a variante de design na barra de abas', () => {
    useUiStore.setState({ layoutMode: 'code' });
    usePluginUiPrefs.setState({
      ...EMPTY_PREFS,
      variants: { 'code.tab.strip:code': 'builtin:segmented' },
    });

    render(<CodePanel />);

    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    expect(strip.getAttribute('data-variant')).toBe('segmented');
    expect(strip.className).toContain('bg-surface');
    expect(strip.className).toContain('p-1');
  });

  it('volta à aba nativa quando a aba de plugin ativa não existe mais', () => {
    useUiStore.setState({ pluginDockTab: { chat: null, code: 'missing-plugin-tab', agent: null } });

    render(<CodePanel />);

    expect(screen.getByText('Nenhum workspace aberto')).toBeTruthy();
  });

  it('fiche-se oculto quando codePanelOpen é falso', () => {
    useUiStore.setState({ codePanelOpen: false });

    render(<CodePanel />);

    expect(panel()).toBeNull();
  });

  it('fiche-se oculto abaixo de 1120px, como o painel fixo do chat', () => {
    setViewport(1000);

    render(<CodePanel />);

    expect(panel()).toBeNull();
    // A preferência continua salva para quando a janela crescer.
    expect(useUiStore.getState().codePanelOpen).toBe(true);
  });
});

describe('CodePanel — abas Arquivos / Alterações', () => {
  it('abre em Alterações sem workspace e explica o que falta (estado honesto)', () => {
    render(<CodePanel />);

    expect(screen.getByRole('tab', { name: 'Alterações' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Arquivos' }).getAttribute('aria-selected')).toBe('false');

    expect(screen.getByText('Sem workspace')).toBeTruthy();
    expect(screen.getByText('Nenhum workspace aberto')).toBeTruthy();
    expect(
      screen.getByText(
        'Abra uma pasta na barra lateral para o agente ler, editar e rodar comandos aqui.',
      ),
    ).toBeTruthy();
    // Nenhum botão de commit morto: sem workspace, o Commit nem é renderizado.
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
  });

  it('troca para Arquivos e mantém o estado vazio honesto sem workspace', () => {
    render(<CodePanel />);

    fireEvent.click(screen.getByRole('tab', { name: 'Arquivos' }));

    expect(useUiStore.getState().codePanelTab).toBe('files');
    expect(screen.getByText('Nenhum workspace aberto')).toBeTruthy();
  });

  it('mantém a aba Terminal disponível sem workspace nem sessão', () => {
    useUiStore.setState({ codePanelTab: 'terminal' });

    render(<CodePanel />);

    // The terminal list is global: it is not gated by the active session.
    expect(screen.getByText('Nenhum terminal aberto')).toBeTruthy();
    expect(screen.queryByText('Nenhum workspace aberto')).toBeNull();
  });

  it('abre o arquivo em aba central sem carregar prévia inline', async () => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [
        {
          path: 'src',
          name: 'src',
          isDir: true,
          depth: 0,
          children: [
            {
              path: 'src/app.ts',
              name: 'app.ts',
              isDir: false,
              depth: 1,
              size: 20,
            },
          ],
        },
      ],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    useUiStore.setState({ codePanelTab: 'files' });

    render(<CodePanel />);

    // Directories start collapsed; open the parent before using the file.
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    expect(await screen.findByText('app.ts')).toBeTruthy();
    fireEvent.click(screen.getByText('app.ts'));

    // O clique abre a aba central (`openCodeFile`); o painel não lê o arquivo
    // nem renderiza mais a prévia inline.
    await waitFor(() => {
      expect(useUiStore.getState().codeFileTab).toEqual({
        workspaceId: 'ws-1',
        path: 'src/app.ts',
      });
    });
    expect(useUiStore.getState().codeView).toBe('file');
    expect(apiMock.readWorkspaceFile).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Conteúdo de src/app.ts')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Carregando arquivo' })).toBeNull();
    // O arquivo aberto fica destacado na árvore.
    expect(screen.getByRole('treeitem', { name: 'app.ts' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(apiMock.refreshWorkspaceTree).toHaveBeenCalledWith('ws-1', []);
    // A barra workspace · branch vive só na aba Alterações.
    fireEvent.click(screen.getByRole('tab', { name: 'Alterações' }));
    expect(await screen.findByText(/zylara/)).toBeTruthy();
  });

  it('destaca na árvore o arquivo que já está aberto na aba central', async () => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [
        {
          path: 'src',
          name: 'src',
          isDir: true,
          depth: 0,
          children: [
            { path: 'src/app.ts', name: 'app.ts', isDir: false, depth: 1, size: 20 },
            { path: 'src/main.ts', name: 'main.ts', isDir: false, depth: 1, size: 20 },
          ],
        },
      ],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    useUiStore.setState({
      codePanelTab: 'files',
      codeView: 'file',
      codeFileTab: { workspaceId: 'ws-1', path: 'src/main.ts' },
    });

    render(<CodePanel />);

    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    const selected = await screen.findByRole('treeitem', { name: 'main.ts' });
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'app.ts' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('mostra workspace e branch somente na aba Alterações', async () => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: {
        isRepo: true,
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
      },
    });
    useUiStore.setState({ codePanelTab: 'files' });

    render(<CodePanel />);

    const branchTrigger = () =>
      screen.queryByRole('button', { name: /Branch atual main/ });
    expect(branchTrigger()).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Alterações' }));
    expect(await screen.findByText('zylara')).toBeTruthy();
    // The branch lives in the picker now, not as plain text next to the workspace.
    expect(await screen.findByRole('button', { name: 'Branch atual main. Trocar de branch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filtrar alterações' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(branchTrigger()).toBeNull();
  });

  it('usa abas só com ícone quando o painel está na largura mínima', () => {
    setViewport(1120);

    render(<CodePanel />);

    const arquivos = screen.getByRole('tab', { name: 'Arquivos' });
    expect(arquivos.getAttribute('aria-label')).toBe('Arquivos');
    expect(screen.queryByText('Arquivos')).toBeNull();
    expect(requiredPanel().style.width).toBe('368px');
  });

  it('respeita o estado persistido e navega com as setas do teclado', () => {
    useUiStore.setState({ codePanelTab: 'files' });
    render(<CodePanel />);

    const arquivos = screen.getByRole('tab', { name: 'Arquivos' });
    expect(arquivos.getAttribute('aria-selected')).toBe('true');
    // Active tab reuses the same neutral fill as the left sidebar's active items.
    expect(arquivos.className).toContain('bg-surface-active');

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Arquivos' }), { key: 'ArrowRight' });

    expect(useUiStore.getState().codePanelTab).toBe('changes');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Alterações' }));

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alterações' }), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Terminal' }));

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Alterações' }), { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Arquivos' }));
    expect(useUiStore.getState().codePanelTab).toBe('files');
  });

  it('has no collapse button and persists the visibility state', async () => {
    render(<CodePanel />);

    expect(screen.queryByRole('button', { name: 'Recolher painel' })).toBeNull();

    act(() => useUiStore.getState().setCodePanelOpen(false));

    expect(useUiStore.getState().codePanelOpen).toBe(false);
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('reabre animando da largura zero até a largura persistida', async () => {
    useUiStore.setState({ codePanelOpen: false });
    render(<CodePanel />);
    expect(panel()).toBeNull();

    act(() => useUiStore.setState({ codePanelOpen: true }));

    expect(panel()).toBeTruthy();
    await waitFor(() => expect(requiredPanel().style.width).toBe(`${SIDE_PANEL_WIDTH_DEFAULT}px`));
  });
});

describe('CodePanel — redimensionamento', () => {
  it('usa a largura persistida e o mesmo divisor acessível dos painéis direitos', async () => {
    useUiStore.setState({ sidePanelWidth: 520 });

    render(<CodePanel />);

    expect(requiredPanel().style.width).toBe('520px');

    const handle = screen.getByRole('separator', { name: 'Redimensionar painel de arquivos' });
    expect(handle.getAttribute('aria-valuenow')).toBe('520');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });

    expect(useUiStore.getState().sidePanelWidth).toBe(520 + SIDE_PANEL_WIDTH_STEP);
    await waitFor(() =>
      expect(requiredPanel().style.width).toBe(`${520 + SIDE_PANEL_WIDTH_STEP}px`),
    );
  });

  it('não deixa o painel espremer a conversa abaixo de 480px (limite do viewport)', async () => {
    render(<CodePanel />);

    const handle = screen.getByRole('separator', { name: 'Redimensionar painel de arquivos' });
    fireEvent.keyDown(handle, { key: 'End' });

    // 1440 - sidebar 272 - 480 de conversa = 688px máximo no modo fixo.
    expect(useUiStore.getState().sidePanelWidth).toBe(688);
    await waitFor(() => expect(requiredPanel().style.width).toBe('688px'));
  });

  it('duplo clique no divisor restaura a largura padrão', async () => {
    useUiStore.setState({ sidePanelWidth: 600 });

    render(<CodePanel />);

    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Redimensionar painel de arquivos' }));

    expect(useUiStore.getState().sidePanelWidth).toBe(SIDE_PANEL_WIDTH_DEFAULT);
    await waitFor(() =>
      expect(requiredPanel().style.width).toBe(`${SIDE_PANEL_WIDTH_DEFAULT}px`),
    );
  });

  it('persiste sempre dentro dos limites globais dos painéis direitos', () => {
    useUiStore.setState({ sidePanelWidth: SIDE_PANEL_WIDTH_MAX });

    render(<CodePanel />);

    // A largura persistida é clampada ao espaço disponível (688px), sem passar do máximo global.
    expect(requiredPanel().style.width).toBe('688px');
    expect(useUiStore.getState().sidePanelWidth).toBe(SIDE_PANEL_WIDTH_MAX);
  });
});

describe('CodePanel — histórico de commits', () => {
  it('abre o histórico pelo botão ao lado do workspace · branch', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: {
        isRepo: true,
        root: 'C:/projetos/zylara',
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
    });

    render(<CodePanel />);

    const button = await screen.findByRole('button', { name: 'Ver histórico de commits' });
    // O botão vive na barra workspace · branch (sem a linha "ALTERAÇÕES").
    expect(screen.queryByText('Alterações')).toBeTruthy(); // tab do painel, não a barra removida
    fireEvent.click(button);

    expect(useUiStore.getState().codeView).toBe('commits');
    expect(useUiStore.getState().codeCommitsTab).toEqual({ workspaceId: 'ws-1', revision: null });
  });

  it('não mostra o botão de histórico fora de um repositório git', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);

    render(<CodePanel />);

    await screen.findByRole('tab', { name: 'Alterações' });
    expect(screen.queryByRole('button', { name: 'Ver histórico de commits' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ações do git' })).toBeNull();
  });

  it('reloads the panel and the workspace context after a branch switch', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.gitBranches.mockResolvedValue({
      current: 'main',
      branches: ['main', 'feat/login'],
      all: [
        {
          name: 'main',
          local: true,
          remote: null,
          current: true,
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          gone: false,
          subject: 'init',
          author: 'Dev',
          committedAt: 1_700_000_000,
        },
        {
          name: 'feat/login',
          local: true,
          remote: null,
          current: false,
          upstream: null,
          ahead: 0,
          behind: 0,
          gone: false,
          subject: 'feat: login',
          author: 'Dev',
          committedAt: 1_700_000_100,
        },
      ],
    });
    apiMock.gitSwitchBranch.mockResolvedValue({
      isRepo: true,
      branch: 'feat/login',
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
    });
    // `refreshWorkspaceTree` returns the new branch after the checkout.
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: {
        isRepo: true,
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        ahead: 0,
        behind: 0,
      },
    });

    render(<CodePanel />);

    const trigger = await screen.findByRole('button', {
      name: 'Branch atual main. Trocar de branch',
    });
    expect(apiMock.refreshWorkspaceTree).toHaveBeenCalledTimes(1);
    expect(apiMock.getWorkspace).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Branches do git' });
    const option = within(dialog)
      .getAllByRole('option')
      .find((node) => node.querySelector('[title]')?.getAttribute('title') === 'feat/login');
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    // The panel reloads (files changed on disk) and the cached workspace branch
    // is refreshed so the session header chip stops showing the old branch.
    await waitFor(() => expect(apiMock.gitSwitchBranch).toHaveBeenCalledWith('ws-1', 'feat/login'));
    await waitFor(() => expect(apiMock.refreshWorkspaceTree.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(apiMock.getWorkspace).toHaveBeenCalledWith('ws-1'));
  });

  it('oferece fetch, pull e push na barra da aba Alterações', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    const repoStatus = {
      isRepo: true,
      root: 'C:/projetos/zylara',
      branch: 'main',
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      ahead: 2,
      behind: 1,
    };
    apiMock.gitStatus.mockResolvedValue(repoStatus);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: repoStatus,
    });
    apiMock.gitPush.mockResolvedValue(repoStatus);

    render(<CodePanel />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ações do git' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Buscar \(fetch\)/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Puxar \(pull\)/ })).toBeTruthy();

    await user.click(within(menu).getByRole('menuitem', { name: /Enviar \(push\)/ }));
    await waitFor(() => expect(apiMock.gitPush).toHaveBeenCalledWith('ws-1'));
  });

  it('mantém o menu do Git montado quando o status volta desconhecido', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: {
        isRepo: true,
        root: 'C:/projetos/zylara',
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
      },
    });

    render(<CodePanel />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Ações do git' });
    await waitFor(() => expect(watchEvents.handlers.length).toBe(1));
    await user.click(trigger);
    await screen.findByRole('menu');

    // Recarga automática falhando: o hook devolve `gitStatus: null` (desconhecido).
    apiMock.refreshWorkspaceTree.mockRejectedValueOnce(new Error('disco ocupado'));
    act(() => {
      watchEvents.handlers[0]?.({
        payload: { workspaceId: 'ws-1', paths: ['src/a.ts'], overflow: false },
      });
    });
    await waitFor(() => expect(apiMock.refreshWorkspaceTree).toHaveBeenCalledTimes(2));

    const stillMounted = await screen.findByRole('button', { name: 'Ações do git' });
    // Mesmo nó: a barra do git mantém o último estado conhecido (repositório)
    // em vez de desmontar — e o menu aberto sobrevive à recarga.
    expect(stillMounted).toBe(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});
describe('CodePanel — árvore lazy', () => {
  it('carrega os filhos ao abrir um diretório mais profundo e abre o arquivo', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [{ path: 'apps', name: 'apps', isDir: true, depth: 0 }],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    apiMock.listWorkspaceFiles.mockImplementation(async (_workspaceId: string, path = '.') => {
      if (path === 'apps') {
        return [{ path: 'apps/index.html', name: 'index.html', isDir: false, depth: 0, size: 10 }];
      }
      return [];
    });
    useUiStore.setState({ codePanelTab: 'files' });

    render(<CodePanel />);

    // Diretório de 1º nível sem filhos na listagem inicial.
    fireEvent.click(await screen.findByRole('treeitem', { name: 'apps' }));

    await waitFor(() =>
      expect(apiMock.listWorkspaceFiles).toHaveBeenCalledWith('ws-1', 'apps', 2),
    );
    const file = await screen.findByRole('treeitem', { name: 'index.html' });
    fireEvent.click(file);

    // Abrir o arquivo é só estado de UI: quem carrega o conteúdo é a CodeFileView.
    await waitFor(() =>
      expect(useUiStore.getState().codeFileTab).toEqual({
        workspaceId: 'ws-1',
        path: 'apps/index.html',
      }),
    );
    expect(apiMock.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('mostra a contagem real quando o backend trunca a listagem', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [{ path: 'README.md', name: 'README.md', isDir: false, depth: 0 }],
      dirs: {},
      gitStatus: notRepoStatus(),
      totalCount: 5000,
      truncated: true,
    });
    useUiStore.setState({ codePanelTab: 'files' });

    render(<CodePanel />);

    expect(await screen.findByRole('treeitem', { name: 'README.md' })).toBeTruthy();
    expect(
      screen
        .getAllByRole('status')
        .some((node) => node.textContent?.includes('Mostrando 1 de 5000')),
    ).toBe(true);
  });
});
describe('CodePanel — árvore lazy (3º nível)', () => {
  it('abre diretório de 3º nível carregando os filhos e mostra os arquivos', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    // Estrutura realista como a do app: apps > desktop > public/src/src-tauri,
    // onde o 3º nível chega SEM children (a listagem inicial cobre 3 níveis).
    const rootTree = [
      {
        path: 'apps',
        name: 'apps',
        isDir: true,
        depth: 0,
        children: [
          {
            path: 'apps/desktop',
            name: 'desktop',
            isDir: true,
            depth: 1,
            children: [
              { path: 'apps/desktop/public', name: 'public', isDir: true, depth: 2, children: [] },
              { path: 'apps/desktop/index.html', name: 'index.html', isDir: false, depth: 2, size: 10 },
            ],
          },
        ],
      },
    ];
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: rootTree,
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    apiMock.listWorkspaceFiles.mockImplementation(async (_workspaceId: string, path = '.') => {
      if (path === 'apps/desktop/public') {
        return [
          { path: 'apps/desktop/public/logo.svg', name: 'logo.svg', isDir: false, depth: 0, size: 4 },
        ];
      }
      return [];
    });
    useUiStore.setState({ codePanelTab: 'files' });

    render(<CodePanel />);

    // Only the root level opens by default: expand both ancestors first.
    fireEvent.click(await screen.findByRole('treeitem', { name: 'apps' }));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'desktop' }));
    expect(await screen.findByRole('treeitem', { name: 'public' })).toBeTruthy();
    fireEvent.click(screen.getByRole('treeitem', { name: 'public' }));

    await waitFor(() =>
      expect(apiMock.listWorkspaceFiles).toHaveBeenCalledWith('ws-1', 'apps/desktop/public', 2),
    );
    expect(await screen.findByRole('treeitem', { name: 'logo.svg' })).toBeTruthy();

    // Abrir/fechar de novo é local: não refaz a chamada de rede.
    fireEvent.click(screen.getByRole('treeitem', { name: 'public' }));
    expect(screen.queryByRole('treeitem', { name: 'logo.svg' })).toBeNull();
    fireEvent.click(screen.getByRole('treeitem', { name: 'public' }));
    expect(await screen.findByRole('treeitem', { name: 'logo.svg' })).toBeTruthy();
    const publicCalls = (apiMock.listWorkspaceFiles.mock.calls as unknown[][]).filter(
      (call) => call[1] === 'apps/desktop/public',
    );
    expect(publicCalls).toHaveLength(1);
  });
});

describe('CodePanel — persistência da árvore de arquivos', () => {
  const rootTree = [
    {
      path: 'src',
      name: 'src',
      isDir: true,
      depth: 0,
      children: [
        { path: 'src/app.ts', name: 'app.ts', isDir: false, depth: 1, size: 20 },
      ],
    },
  ];

  beforeEach(() => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: rootTree,
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    useUiStore.setState({ codePanelTab: 'files' });
  });

  it('abre as pastas fechadas e restaura a expansão ao reabrir a aba', async () => {
    const { unmount } = render(<CodePanel />);

    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'app.ts' })).toBeNull();

    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'app.ts' })).toBeTruthy();
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace['ws-1']).toEqual(['src']);

    unmount();
    render(<CodePanel />);
    expect(await screen.findByRole('treeitem', { name: 'app.ts' })).toBeTruthy();
  });

  it('persiste o fechamento de uma pasta já aberta', async () => {
    useUiStore.setState({ codeFileTreeExpandedByWorkspace: { 'ws-1': ['src'] } });
    const { unmount } = render(<CodePanel />);

    expect(await screen.findByRole('treeitem', { name: 'app.ts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(screen.queryByRole('treeitem', { name: 'app.ts' })).toBeNull();
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({});

    unmount();
    render(<CodePanel />);
    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'app.ts' })).toBeNull();
  });

  it('expands and collapses the whole tree from the header actions', async () => {
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [
        {
          path: 'src',
          name: 'src',
          isDir: true,
          depth: 0,
          children: [
            {
              path: 'src/components',
              name: 'components',
              isDir: true,
              depth: 1,
              children: [
                { path: 'src/components/Button.tsx', name: 'Button.tsx', isDir: false, depth: 2 },
              ],
            },
          ],
        },
      ],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    render(<CodePanel />);

    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expandir todas as pastas' }));
    expect(await screen.findByRole('treeitem', { name: 'Button.tsx' })).toBeTruthy();
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace['ws-1']).toEqual([
      'src',
      'src/components',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Recolher todas as pastas' }));
    expect(screen.queryByRole('treeitem', { name: 'Button.tsx' })).toBeNull();
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({});
    expect(apiMock.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it('restores the children of deep directories saved in a previous session', async () => {
    const deepTree = [
      {
        path: 'apps',
        name: 'apps',
        isDir: true,
        depth: 0,
        children: [
          {
            path: 'apps/desktop',
            name: 'desktop',
            isDir: true,
            depth: 1,
            children: [
              { path: 'apps/desktop/public', name: 'public', isDir: true, depth: 2, children: [] },
            ],
          },
        ],
      },
    ];
    const savedPaths = ['apps', 'apps/desktop', 'apps/desktop/public'];
    apiMock.refreshWorkspaceTree.mockImplementation(async (_workspaceId, extraDirs = []) => {
      const dirs: Record<string, WorkspaceFileEntry[]> = {};
      if (extraDirs.includes('apps/desktop/public')) {
        dirs['apps/desktop/public'] = [
          { path: 'apps/desktop/public/logo.svg', name: 'logo.svg', isDir: false, depth: 0 },
        ];
      }
      return { files: deepTree, dirs, gitStatus: notRepoStatus() };
    });
    useUiStore.setState({ codeFileTreeExpandedByWorkspace: { 'ws-1': savedPaths } });

    render(<CodePanel />);

    expect(await screen.findByRole('treeitem', { name: 'public' })).toBeTruthy();
    expect(await screen.findByRole('treeitem', { name: 'logo.svg' })).toBeTruthy();
    expect(apiMock.refreshWorkspaceTree).toHaveBeenCalledWith('ws-1', savedPaths);
    expect(apiMock.listWorkspaceFiles).not.toHaveBeenCalled();
  });
});

describe('CodePanel — atualização em tempo real', () => {
  it('recarrega árvore e status quando o watcher emite um lote', async () => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [{ path: 'src', name: 'src', isDir: true, depth: 0, children: [] }],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    useUiStore.setState({ codePanelTab: 'files' });

    render(<CodePanel />);

    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeTruthy();
    await waitFor(() => expect(watchEvents.handlers.length).toBe(1));

    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [{ path: 'docs', name: 'docs', isDir: true, depth: 0, children: [] }],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    act(() => {
      watchEvents.handlers[0]?.({
        payload: { workspaceId: 'ws-1', paths: ['docs'], overflow: false },
      });
    });

    expect(await screen.findByRole('treeitem', { name: 'docs' })).toBeTruthy();
    expect(apiMock.refreshWorkspaceTree).toHaveBeenCalledTimes(2);
    expect(apiMock.refreshWorkspaceTree).toHaveBeenLastCalledWith('ws-1', []);
  });

  it('reloads the Changes snapshot after an ignore-rule overflow batch', async () => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    useCodeStore.setState({
      byConversation: {
        'conv-1': {
          ...emptyCodeSession('conv-1'),
          changes: {
            turnId: 'turn-1',
            files: [
              { path: '.env.example', kind: 'created', added: 1, removed: 0, origin: 'git', staged: false },
              { path: '.env.local', kind: 'created', added: 1, removed: 0, origin: 'git', staged: false },
            ],
            added: 2,
            removed: 0,
          },
          lastTurnChanges: null,
        },
      },
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: {
        isRepo: true,
        root: 'C:/projetos/zylara',
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: ['.env.example', '.env.local'],
        conflicted: [],
      },
    });
    apiMock.getWorkspaceChanges.mockResolvedValue([
      { path: '.env.example', kind: 'created', added: 1, removed: 0, diff: null },
    ]);

    render(<CodePanel />);
    expect(await screen.findByTitle('.env.example')).toBeTruthy();
    await waitFor(() => expect(watchEvents.handlers.length).toBe(1));

    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [],
      dirs: {},
      gitStatus: {
        isRepo: true,
        root: 'C:/projetos/zylara',
        branch: 'main',
        staged: [],
        unstaged: [],
        untracked: ['.env.example'],
        conflicted: [],
      },
    });
    apiMock.getCodeSessionState.mockResolvedValue({
      conversationId: 'conv-1',
      permissionMode: 'autonomous',
      planMode: false,
      todos: [],
      context: null,
      changes: {
        turnId: 'turn-1',
        files: [
          { path: '.env.example', kind: 'created', added: 1, removed: 0, origin: 'git', staged: false },
        ],
        added: 1,
        removed: 0,
      },
      lastTurnChanges: null,
      jobs: [],
      approvals: [],
      questions: [],
    });
    act(() => {
      watchEvents.handlers[0]?.({
        payload: { workspaceId: 'ws-1', paths: ['.gitignore'], overflow: true },
      });
    });

    await waitFor(() => expect(screen.queryByTitle('.env.local')).toBeNull());
    expect(screen.getByTitle('.env.example')).toBeTruthy();
    expect(apiMock.refreshWorkspaceTree).toHaveBeenCalledTimes(2);
  });

  it('não liga o watcher com o painel fechado', async () => {
    useUiStore.setState({ codePanelOpen: false });

    render(<CodePanel />);
    await act(async () => {});

    expect(apiMock.watchWorkspace).not.toHaveBeenCalled();
  });
});

describe('CodePanel — ordem das abas', () => {
  it('renderiza as abas na ordem persistida e navega por ela', () => {
    useUiStore.setState({
      codePanelTabOrder: ['terminal', 'files', 'changes'],
      codePanelTab: 'files',
    });

    render(<CodePanel />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((node) => node.textContent?.trim())).toEqual([
      'Terminal',
      'Arquivos',
      'Alterações',
    ]);

    tabs[1]?.focus();
    fireEvent.keyDown(tabs[1] as HTMLElement, { key: 'ArrowRight' });
    expect(useUiStore.getState().codePanelTab).toBe('changes');
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('reordena as abas com Alt+ArrowRight e persiste no store', () => {
    render(<CodePanel />);

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Arquivos' }), {
      key: 'ArrowRight',
      altKey: true,
    });

    expect(useUiStore.getState().codePanelTabOrder).toEqual(['changes', 'files', 'terminal']);
    expect(screen.getAllByRole('tab').map((node) => node.textContent?.trim())).toEqual([
      'Alterações',
      'Arquivos',
      'Terminal',
    ]);
  });

  it('mantém a seleção ao clicar numa aba depois de reordenar', () => {
    render(<CodePanel />);

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Arquivos' }), {
      key: 'ArrowRight',
      altKey: true,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Arquivos' }));

    expect(useUiStore.getState().codePanelTab).toBe('files');
    expect(screen.getByRole('tab', { name: 'Arquivos' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

describe('CodePanel — aba de plugin no dock', () => {
  const plugin = {
    id: 'com.acme.insights',
    name: 'Session Insights',
    version: '1.0.0',
    manifest: { contributes: { ui: {} } },
    permissions: [
      { id: 'ui.panel', granted: true },
      { id: 'ui.slot:code.panel.tabs', granted: true },
    ],
    trusted: true,
    active: true,
    enabled: true,
  } as never;

  function emptyUi(): Parameters<typeof setPluginUiState>[0] {
    return {
      slots: [],
      replacements: [],
      wraps: [],
      pages: [],
      panelTabs: [],
      nav: [],
      settingsTabs: [],
      artifactViewers: [],
      variants: [],
      presets: [],
      css: [],
      genui: [],
    };
  }

  function panelTab(overrides: Partial<PanelTabSpec> = {}): PanelTabSpec {
    return {
      key: 'com.acme.insights:panel:insights',
      plugin,
      pluginId: 'com.acme.insights',
      source: 'trusted',
      order: 100,
      priority: 100,
      layouts: ['code'],
      tabId: 'insights',
      title: 'Insights',
      titleKey: null,
      icon: 'Puzzle',
      entry: null,
      component: () => <div>insights-body</div>,
      takeover: false,
      ...overrides,
    };
  }

  function stripSlot(): SlotContribution {
    return {
      key: 'com.acme.insights:slot:tabs',
      plugin,
      pluginId: 'com.acme.insights',
      source: 'manifest',
      order: 100,
      priority: 100,
      layouts: ['code'],
      slot: 'code.panel.tabs',
      entryId: 'tabs',
      kind: 'list',
      keyMatch: null,
      component: null,
      entry: null,
      action: { kind: 'openPanelTab', target: 'insights' },
      title: 'Insights',
      titleKey: null,
      icon: 'Puzzle',
      when: null,
    };
  }

  beforeEach(() => {
    setPluginUiState(emptyUi());
  });

  it('mostra o painel do plugin como aba do dock, sem cabeçalho de página', () => {
    setPluginUiState({ ...emptyUi(), panelTabs: [panelTab()] });
    useUiStore.setState({ pluginDockTab: { chat: null, code: panelTab().key, agent: null } });

    render(<CodePanel />);

    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    // Host tabs stay reachable next to the plugin tab.
    expect(within(strip).getByRole('tab', { name: 'Alterações' })).toBeTruthy();
    expect(within(strip).getByRole('tab', { name: 'Insights' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(within(strip).getAllByRole('tab')).toHaveLength(4);
    // Body renders inside the dock, without a duplicated page header.
    expect(screen.getByText('insights-body')).toBeTruthy();
    const body = screen.getByRole('tabpanel');
    expect(within(body).queryByRole('button', { name: 'Voltar' })).toBeNull();
  });

  it('renderiza uma única aba por painel, mesmo com declaração duplicada e atalho no slot', () => {
    setPluginUiState({
      ...emptyUi(),
      panelTabs: [panelTab(), panelTab({ order: 20 })],
      slots: [stripSlot()],
    });

    render(<CodePanel />);

    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    expect(within(strip).getAllByRole('tab', { name: 'Insights' })).toHaveLength(1);
    // The redundant slot button (same plugin, same panel) is not rendered either.
    expect(screen.getAllByLabelText('Insights')).toHaveLength(1);
  });

  it('mantém a aba do plugin visível quando todas as abas nativas são fechadas', () => {
    setPluginUiState({ ...emptyUi(), panelTabs: [panelTab()] });
    useUiStore.setState({ codePanelOpenTabs: [] });

    render(<CodePanel />);

    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    const pluginTabButton = within(strip).getByRole('tab', { name: 'Insights' });
    const launcher = screen.getByRole('tabpanel', { name: 'Atalhos do painel' });
    // The new launcher only reopens host tabs; plugin tabs stay in the strip.
    expect(within(launcher).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Arquivos',
      'Alterações',
      'Terminal',
    ]);

    fireEvent.click(pluginTabButton);
    expect(screen.getByText('insights-body')).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: 'Atalhos do painel' })).toBeNull();
  });
});

describe('CodePanel — fechar e reabrir abas', () => {
  beforeEach(() => {
    setPluginUiState({
      slots: [],
      replacements: [],
      wraps: [],
      pages: [],
      panelTabs: [],
      nav: [],
      settingsTabs: [],
      artifactViewers: [],
      variants: [],
      presets: [],
      css: [],
      genui: [],
    });
  });

  function middleClickTab(name: string): void {
    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    const tab = within(strip).getByRole('tab', { name });
    const wrapper = tab.parentElement as HTMLElement;
    fireEvent.mouseDown(strip, { button: 1 });
    fireEvent(
      wrapper,
      new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }),
    );
  }

  it('fecha uma aba com o botão do meio e ativa a vizinha quando era a atual', () => {
    render(<CodePanel />);

    middleClickTab('Arquivos');
    expect(screen.queryByRole('tab', { name: 'Arquivos' })).toBeNull();
    expect(useUiStore.getState().codePanelOpenTabs).toEqual(['changes', 'terminal']);
    expect(useUiStore.getState().codePanelTab).toBe('changes');

    middleClickTab('Alterações');
    expect(screen.queryByRole('tab', { name: 'Alterações' })).toBeNull();
    expect(useUiStore.getState().codePanelOpenTabs).toEqual(['terminal']);
    expect(useUiStore.getState().codePanelTab).toBe('terminal');
  });

  it('reabre uma aba fechada pelo menu +', async () => {
    render(<CodePanel />);
    middleClickTab('Arquivos');

    const trigger = screen.getByRole('button', { name: 'Adicionar aba do painel' });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Arquivos' }));

    expect(screen.getByRole('tab', { name: 'Arquivos' })).toBeTruthy();
    expect(useUiStore.getState().codePanelOpenTabs).toEqual(['files', 'changes', 'terminal']);
    expect(useUiStore.getState().codePanelTab).toBe('files');
  });

  it('abre o menu de abas com o botão direito na faixa de abas', async () => {
    render(<CodePanel />);
    middleClickTab('Arquivos');

    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    fireEvent.contextMenu(strip);

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Arquivos' }));
    expect(screen.getByRole('tab', { name: 'Arquivos' })).toBeTruthy();
    expect(useUiStore.getState().codePanelOpenTabs).toEqual(['files', 'changes', 'terminal']);
  });

  it('mostra no estado vazio apenas as abas que existem no painel e reabre uma delas', () => {
    useUiStore.setState({ codePanelOpenTabs: [] });
    render(<CodePanel />);

    const strip = screen.getByRole('tablist', { name: 'Conteúdo do painel' });
    expect(within(strip).queryAllByRole('tab')).toHaveLength(0);

    const launcher = screen.getByRole('tabpanel', { name: 'Atalhos do painel' });
    expect(within(launcher).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Arquivos',
      'Alterações',
      'Terminal',
    ]);
    expect(screen.queryByRole('button', { name: 'Mais ferramentas' })).toBeNull();

    fireEvent.click(within(launcher).getByRole('button', { name: 'Arquivos' }));
    expect(screen.getByRole('tab', { name: 'Arquivos' })).toBeTruthy();
    expect(useUiStore.getState().codePanelTab).toBe('files');
  });
});

describe('CodePanel — ações do menu Arquivos', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [conversation({ workspaceId: 'ws-1' })],
      activeId: 'conv-1',
    });
    apiMock.listWorkspaces.mockResolvedValue([workspace()]);
    apiMock.refreshWorkspaceTree.mockResolvedValue({
      files: [
        {
          path: 'src',
          name: 'src',
          isDir: true,
          depth: 0,
          children: [{ path: 'src/app.ts', name: 'app.ts', isDir: false, depth: 1, size: 20 }],
        },
      ],
      dirs: {},
      gitStatus: notRepoStatus(),
    });
    useUiStore.setState({ codePanelTab: 'files' });
  });

  const openFileRow = async () => {
    fireEvent.click(await screen.findByRole('treeitem', { name: 'src' }));
    return screen.findByRole('treeitem', { name: 'app.ts' });
  };

  it('creates a file from the header dropdown through the API', async () => {
    const user = userEvent.setup();
    render(<CodePanel />);
    expect(await screen.findByRole('treeitem', { name: 'src' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Ações do arquivo' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Novo arquivo' }));
    await user.type(await screen.findByRole('textbox', { name: 'Nome' }), 'note.md');
    await user.click(screen.getByRole('button', { name: 'Criar' }));

    await waitFor(() =>
      expect(apiMock.createWorkspaceFile).toHaveBeenCalledWith('ws-1', 'note.md'),
    );
    expect(toastMocks.success).toHaveBeenCalledWith('note.md criado');
  });

  it('copies the workspace-relative path from a row context menu', async () => {
    const user = userEvent.setup();
    render(<CodePanel />);
    fireEvent.contextMenu(await openFileRow());
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Copiar caminho relativo' }));

    await waitFor(() => expect(copyTextMock).toHaveBeenCalledWith('src/app.ts'));
    expect(toastMocks.success).toHaveBeenCalledWith('Caminho relativo copiado');
  });

  it('opens a file to the side without replacing the primary tab', async () => {
    const user = userEvent.setup();
    render(<CodePanel />);
    fireEvent.contextMenu(await openFileRow());
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Abrir ao lado' }));

    expect(useUiStore.getState().secondaryCodeFileTab).toEqual({
      workspaceId: 'ws-1',
      path: 'src/app.ts',
    });
  });

  it('asks for confirmation before deleting an entry', async () => {
    const user = userEvent.setup();
    render(<CodePanel />);
    fireEvent.contextMenu(await openFileRow());
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Excluir' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Excluir app.ts?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    await waitFor(() =>
      expect(apiMock.deleteWorkspaceEntry).toHaveBeenCalledWith('ws-1', 'src/app.ts'),
    );
  });

  it('does not report success when the native save dialog is cancelled', async () => {
    const user = userEvent.setup();
    render(<CodePanel />);
    fireEvent.contextMenu(await openFileRow());
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Baixar' }));

    await waitFor(() =>
      expect(apiMock.saveWorkspaceFile).toHaveBeenCalledWith('ws-1', 'src/app.ts'),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
