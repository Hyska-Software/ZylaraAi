// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  AppInfo,
  ApprovalRequest,
  Conversation,
  GoalView,
  Settings,
  Workspace,
  WorkspaceGitStatus,
} from '@/lib/types';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  addWorkspace: vi.fn(),
  setWorkspaceTrusted: vi.fn(),
  setPermissionMode: vi.fn(),
  removeWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  setConversationWorkspace: vi.fn(),
  openWorkspaceInExplorer: vi.fn(),
  getCodeSessionState: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  listArtifacts: vi.fn(),
  gitStatus: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

const gitListeners: Array<(event: { payload: { workspaceId: string } }) => void> = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: { workspaceId: string } }) => void) => {
    gitListeners.push(handler);
    return () => {
      const index = gitListeners.indexOf(handler);
      if (index >= 0) gitListeners.splice(index, 1);
    };
  }),
}));

const terminalMock = vi.hoisted(() => {
  type TerminalTab = {
    id: string;
    title: string;
    cwd: string;
    cols: number;
    rows: number;
    running: boolean;
    exitCode: number | null;
    killing: boolean;
  };
  type Snapshot = {
    tabs: TerminalTab[];
    activeId: string | null;
    loading: boolean;
    error: { code: string; message: string; detail: string; canRetry: boolean } | null;
    limit: number;
    used: number;
  };
  const empty = (): Snapshot => ({
    tabs: [],
    activeId: null,
    loading: false,
    error: null,
    limit: 4,
    used: 0,
  });
  let snapshot = empty();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const manager = {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getSnapshot: vi.fn(() => snapshot),
    open: vi.fn(async () => 'term-1' as string | null),
    activate: vi.fn(),
    close: vi.fn(async () => undefined),
    reorderTabs: vi.fn(),
  };
  return {
    manager,
    emit(next: Partial<Snapshot>): void {
      snapshot = { ...snapshot, ...next };
      notify();
    },
    reset(): void {
      snapshot = empty();
      listeners.clear();
    },
    tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
      return {
        id: 'term-1',
        title: 'Terminal 1',
        cwd: 'C:/projetos/zylara',
        cols: 100,
        rows: 24,
        running: true,
        exitCode: null,
        killing: false,
        ...overrides,
      };
    },
  };
});

vi.mock('./terminalManager', () => ({
  terminalManager: terminalMock.manager,
  terminalTabLabel: (tab: { title: string; running: boolean }) =>
    tab.running ? tab.title : `${tab.title} (fechado)`,
  TERMINAL_TAB_LIMIT: 4,
}));

// Imported after the API mock.
import { emptyCodeSession, useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { __resetWorkspacesForTests } from './useWorkspaces';
import { CodeSessionHeader } from './CodeSessionHeader';

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

function matchMediaReturning(matches: boolean): typeof window.matchMedia {
  return vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

/** `useViewportWidth` reads `window.innerWidth`; keep it in sync with the resize event. */
function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
    borderRadiusEnabled: true,
    chatExecutionAnimationEnabled: true,
    locale: 'pt-BR',
    defaultProvider: 'opencode-go',
    defaultModel: 'deepseek-v4.1-flash',
    reasoningDefault: 'max',
    systemPrompt: '',
    webSearchEnabled: true,
    fileCreationEnabled: true,
    sendKey: 'enter',
    showTokenUsage: true,
    reduceMotion: false,
    thinkingCollapsedByDefault: false,
    fontScale: 1,
    includeAttachments: true,
    autoTitle: true,
    codeExecutionEnabled: false,
    codeTimeoutSecs: 120,
    codePythonPath: '',
    codeNodePath: '',
    skillsPanelEnabled: true,
    disabledSkills: [],
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'zylara-core',
    path: 'C:/dev/zylara',
    createdAt: 1,
    updatedAt: 2,
    trusted: true,
    git: { root: 'C:/dev/zylara', branch: 'main', dirty: true },
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-new',
    title: 'Nova conversa',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
    messageCount: 0,
    preview: null,
    // Session fixtures here are Code sessions unless the test says otherwise.
    mode: 'code',
    ...overrides,
  };
}

function appInfo(): AppInfo {
  return {
    name: 'Zylara',
    version: '0.1.0',
    tauriVersion: '2.0.0',
    platform: 'windows',
    startedAt: 1,
    dataDir: 'C:/zylara',
  };
}

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name });

function rect(top: number, height: number, left: number, right: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right,
    width: right - left,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Radix DropdownMenu opens on pointerdown, not click (see other tests). */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
}

/** Opens the "+" menu and activates one of its items. */
async function chooseMenuItem(name: RegExp): Promise<void> {
  openMenu(screen.getByRole('button', { name: 'Nova aba' }));
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
  gitListeners.length = 0;
  terminalMock.reset();
  mocks.gitStatus.mockResolvedValue({
    isRepo: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  } satisfies WorkspaceGitStatus);
  __resetWorkspacesForTests();
  window.matchMedia = matchMediaReturning(false);
  setViewport(1440);
  mocks.listWorkspaces.mockResolvedValue([]);
  mocks.listConversations.mockResolvedValue([]);
  mocks.listArtifacts.mockResolvedValue([]);
  mocks.createConversation.mockResolvedValue(conversation());
  mocks.getCodeSessionState.mockResolvedValue(null);
  mocks.getWorkspace.mockResolvedValue(null);
  mocks.getConversation.mockImplementation(async (id: string) => ({
    conversation: conversation({ id, title: id }),
    messages: [],
  }));
  mocks.setConversationWorkspace.mockImplementation(async (id: string, workspaceId: string | null) =>
    conversation({ id, workspaceId }),
  );
  useAppStore.setState({ settings: settings(), appInfo: appInfo() });
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  useChatStore.setState({
    conversations: [],
    conversationsLoading: false,
    activeId: null,
    activeIdByLayout: { chat: null, code: null, agent: null },
  });
  useUiStore.setState({
    layoutMode: 'code',
    codeView: 'session',
    codeFileTab: null,
    codeFileTabs: [],
    codePlanTab: null,
    codeSubagentTabs: [],
    codeSubagentTab: null,
    codeGoalOpen: false,
    goalDialog: null,
    codePanelOpen: true,
    codePanelTab: 'changes',
    activeWorkspaceId: null,
    openSessionsByWorkspace: {},
    codeTabOrder: [],
    artifactPanelOpen: false,
    artifacts: [],
  });
  useCodeStore.setState({ byConversation: {} });
  useChatStore.setState({ streaming: null });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
});

describe('CodeSessionHeader — cabeçalho da sessão', () => {
  it('mostra "Nova sessão", a aba ativa e o menu do + quando não há conversa', async () => {
    render(<CodeSessionHeader />);

    expect(screen.getByRole('heading', { name: 'Nova sessão' })).toBeTruthy();
    expect(screen.getByText('Sem workspace')).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Abas abertas' })).toBeTruthy();
    expect(tab('Nova sessão').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Nova aba' })).toBeTruthy();

    openMenu(screen.getByRole('button', { name: 'Nova aba' }));
    expect(await screen.findByRole('menuitem', { name: /Nova sessão/ })).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: /Terminal/ })).toBeTruthy();
  });

  it('mostra o título da conversa ativa e a transforma em aba', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Corrigir o build' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);

    expect(screen.getByRole('heading', { name: 'Corrigir o build' })).toBeTruthy();
    await waitFor(() =>
      expect(tab('Corrigir o build').getAttribute('aria-selected')).toBe('true'),
    );
    // Abas apontam para o painel da conversa (contrato com o WorkspaceCenter).
    expect(tab('Corrigir o build').getAttribute('aria-controls')).toBe('code-session-panel');
  });

  it('destaca a aba ativa com preenchimento neutro e sem sombra', async () => {
    const first = render(<CodeSessionHeader />);
    const newSessionTab = tab('Nova sessão');
    expect(newSessionTab.className).toContain('bg-surface-active');
    expect(newSessionTab.className).not.toContain('shadow-sm');
    first.unmount();

    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Corrigir o build' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Corrigir o build').getAttribute('aria-selected')).toBe('true'));
    const activeShell = tab('Corrigir o build').parentElement;
    // A sombra sobre uma superfície branca vira um halo no tema claro.
    expect(activeShell?.className).toContain('bg-surface-active');
    expect(activeShell?.className).not.toContain('shadow-sm');
  });

  it('rola as abas com a roda do mouse e esconde a barra de rolagem', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Primeira sessão' }),
        conversation({ id: 'c-2', title: 'Segunda sessão' }),
        conversation({ id: 'c-3', title: 'Terceira sessão' }),
      ],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);

    act(() => {
      useChatStore.setState({ activeId: 'c-2' });
    });
    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());
    act(() => {
      useChatStore.setState({ activeId: 'c-3' });
    });
    await waitFor(() => expect(tab('Terceira sessão')).toBeTruthy());

    const strip = screen.getByRole('tablist', { name: 'Abas abertas' });
    expect(strip.className).toContain('scrollbar-none');
    // jsdom has no layout: declare an overflowing strip and scroll from the start.
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
    strip.scrollLeft = 0;

    fireEvent.wheel(strip, { deltaY: 120 });
    expect(strip.scrollLeft).toBe(120);

    fireEvent.wheel(strip, { deltaY: 5000 });
    expect(strip.scrollLeft).toBe(600);
  });

  it('aplica a variante de design na barra de abas', () => {
    usePluginUiPrefs.setState({
      ...EMPTY_PREFS,
      variants: { 'code.tab.strip:code': 'builtin:segmented' },
    });

    render(<CodeSessionHeader />);

    const strip = screen.getByRole('tablist', { name: 'Abas abertas' });
    expect(strip.getAttribute('data-variant')).toBe('segmented');
    expect(strip.className).toContain('bg-surface');
    expect(strip.className).toContain('p-1');
  });

  it('mostra badge "Aguardando aprovação" quando há pedido pendente', async () => {
    const pending: ApprovalRequest[] = [
      {
        id: 'apr-1',
        toolCallId: 'call-1',
        tool: 'submit_plan',
        title: 'Aprovar plano?',
        detail: { kind: 'other', text: 'Resumo' },
        risk: 'ask',
        options: [],
        createdAt: 1,
      },
    ];
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Com gate' })],
      activeId: 'c-1',
    });
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), approvals: pending } },
    });

    render(<CodeSessionHeader />);

    expect(await screen.findByText('Aguardando aprovação')).toBeTruthy();
  });

  it('sincroniza novas abas com a conversa ativa', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Primeira sessão' })],
      activeId: 'c-1',    });
    render(<CodeSessionHeader />);

    act(() => {
      useChatStore.setState((state) => ({
        conversations: [
          ...state.conversations,
          conversation({ id: 'c-2', title: 'Segunda sessão' }),
        ],
        activeId: 'c-2',
      }));
    });

    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());
    expect(tab('Primeira sessão').getAttribute('aria-selected')).toBe('false');
    expect(tab('Segunda sessão').getAttribute('aria-selected')).toBe('true');
  });

  it('abre outra conversa ao clicar na aba', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Primeira sessão' }),
        conversation({ id: 'c-2', title: 'Segunda sessão' }),
      ],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);

    act(() => {
      useChatStore.setState({ activeId: 'c-2' });
    });
    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());

    fireEvent.click(tab('Primeira sessão'));

    await waitFor(() => expect(mocks.getConversation).toHaveBeenCalledWith('c-1'));
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-1'));
  });

  it('+ cria uma nova sessão real no namespace Code', async () => {
    render(<CodeSessionHeader />);

    await chooseMenuItem(/Nova sessão/);

    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledTimes(1));
    expect(mocks.createConversation.mock.calls[0]?.[3]).toBe('code');
    // Sem workspace atual, a sessão nasce sem vínculo (nada de workspace falso).
    expect(mocks.setConversationWorkspace).not.toHaveBeenCalled();
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-new'));
    await waitFor(() => expect(tab('Nova conversa').getAttribute('aria-selected')).toBe('true'));
  });

  it('+ cria a nova sessão no mesmo workspace da sessão ativa', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    mocks.listConversations.mockResolvedValue([
      conversation({ id: 'c-new', title: 'Nova conversa', workspaceId: 'ws-1' }),
    ]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Corrigir o build', workspaceId: 'ws-1' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);
    await chooseMenuItem(/Nova sessão/);

    await waitFor(() =>
      expect(mocks.setConversationWorkspace).toHaveBeenCalledWith('c-new', 'ws-1'),
    );
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-new'));
    expect(useUiStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(useUiStore.getState().openSessionsByWorkspace['ws-1']).toContain('c-new');
  });

  it('+ sem sessão ativa cria no workspace selecionado na sidebar', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useUiStore.setState({ activeWorkspaceId: 'ws-1' });

    render(<CodeSessionHeader />);
    await chooseMenuItem(/Nova sessão/);

    await waitFor(() =>
      expect(mocks.setConversationWorkspace).toHaveBeenCalledWith('c-new', 'ws-1'),
    );
    expect(useUiStore.getState().openSessionsByWorkspace['ws-1']).toContain('c-new');
  });
});

describe('CodeSessionHeader — workspace real', () => {
  it('mostra nome, branch e estado sujo do workspace da sessão', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Corrigir o build', workspaceId: 'ws-1' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);

    const chip = await screen.findByRole('button', {
      name: 'Workspace zylara-core, branch main, alterações não commitadas',
    });
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('zylara-core');
    expect(chip.textContent).toContain('main');
  });

  it('o menu do workspace atualiza o contexto git e abre no Explorer', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    mocks.getWorkspace.mockResolvedValue({ workspace: workspace() });
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', workspaceId: 'ws-1' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);
    const chip = await screen.findByRole('button', { name: /Workspace zylara-core/ });
    openMenu(chip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Atualizar' }));
    await waitFor(() => expect(mocks.getWorkspace).toHaveBeenCalledWith('ws-1'));

    openMenu(chip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir no Explorer' }));
    await waitFor(() => expect(mocks.openWorkspaceInExplorer).toHaveBeenCalledWith('ws-1'));
  });

  it('permite trocar a sessão de workspace pelo chip', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sem pasta', workspaceId: null })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);
    const chip = await screen.findByRole('button', { name: /Sem workspace/ });
    openMenu(chip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'zylara-core' }));

    await waitFor(() =>
      expect(mocks.setConversationWorkspace).toHaveBeenCalledWith('c-1', 'ws-1'),
    );
    expect(useUiStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(useUiStore.getState().openSessionsByWorkspace['ws-1']).toEqual(['c-1']);
  });

  it('sem workspace o chip oferece Abrir pasta… (não é beco sem saída)', async () => {
    mocks.listWorkspaces.mockResolvedValue([]);
    const ws = workspace({ trusted: false });
    mocks.pickWorkspaceFolder.mockResolvedValue('C:/dev/zylara');
    mocks.addWorkspace.mockResolvedValue(ws);
    mocks.listWorkspaces.mockResolvedValueOnce([]).mockResolvedValue([ws]);

    render(<CodeSessionHeader />);
    const chip = await screen.findByRole('button', { name: /Sem workspace/ });
    openMenu(chip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir pasta…' }));

    await waitFor(() => expect(mocks.pickWorkspaceFolder).toHaveBeenCalledTimes(1));
    // O diálogo de confiança é hospedado pelo cabeçalho.
    const dialog = await screen.findByRole('dialog', { name: 'Confiar nesta pasta?' });
    expect(dialog).toBeTruthy();
  });
});

describe('CodeSessionHeader — confiança da pasta', () => {
  it('“Confiar” aplica trusted e mantém o modo de permissão da sessão', async () => {
    const ws = workspace({ trusted: false });
    mocks.pickWorkspaceFolder.mockResolvedValue('C:/dev/zylara');
    mocks.addWorkspace.mockResolvedValue(ws);
    mocks.listWorkspaces.mockResolvedValue([ws]);
    mocks.setWorkspaceTrusted.mockResolvedValue({ ...ws, trusted: true });

    render(<CodeSessionHeader />);
    const chip = await screen.findByRole('button', { name: /Sem workspace/ });
    openMenu(chip);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir pasta…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Confiar nesta pasta?' });
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confiar' }));

    await waitFor(() => expect(mocks.setWorkspaceTrusted).toHaveBeenCalledWith('ws-1', true));
    // A sessão recém-criada já nasce no modo padrão configurado (Autônomo de
    // fábrica); confiar não pode rebaixá-la para "Editar".
    expect(mocks.setPermissionMode).not.toHaveBeenCalled();
  });
});

describe('CodeSessionHeader — sem chips de permissão/Plano', () => {
  it('com conversa ativa não renderiza os controles de permissão nem de Plano', () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão ativa', permissionMode: 'edit' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);

    // Os controles de sessão foram para o composer: o cabeçalho não os duplica.
    expect(screen.getByRole('heading', { name: 'Sessão ativa' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Modo de permissão/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modo Plano' })).toBeNull();
    expect(screen.queryByText(/Modo de permissão/)).toBeNull();
    expect(screen.queryByText('Modo Plano')).toBeNull();
  });
});

describe('CodeSessionHeader — fechar abas', () => {
  it('fecha uma aba inativa sem trocar a conversa ativa', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Primeira sessão' }),
        conversation({ id: 'c-2', title: 'Segunda sessão' }),
      ],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);
    act(() => {
      useChatStore.setState({ activeId: 'c-2' });
    });
    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Primeira sessão' }));

    expect(screen.queryByRole('tab', { name: 'Primeira sessão' })).toBeNull();
    expect(useChatStore.getState().activeId).toBe('c-2');
  });

  it('ao fechar a aba ativa, cai na vizinha', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Primeira sessão' }),
        conversation({ id: 'c-2', title: 'Segunda sessão' }),
      ],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);
    act(() => {
      useChatStore.setState({ activeId: 'c-2' });
    });
    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Segunda sessão' }));

    await waitFor(() => expect(mocks.getConversation).toHaveBeenCalledWith('c-1'));
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-1'));
    expect(screen.queryByRole('tab', { name: 'Segunda sessão' })).toBeNull();
  });

  it('ao fechar a última aba, volta para o estado "Nova sessão"', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Única sessão' })],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Única sessão' }));

    await waitFor(() => expect(useChatStore.getState().activeId).toBeNull());
    expect(tab('Nova sessão').getAttribute('aria-selected')).toBe('true');
    // A conversa não é apagada do histórico: só deixa de estar ativa.
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });

  it('fecha a aba ativa com o botão do meio do mouse', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Única sessão' })],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);

    const activeTab = await screen.findByRole('tab', { name: 'Única sessão' });
    fireEvent.mouseDown(activeTab, { button: 1 });
    fireEvent(
      activeTab,
      new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }),
    );

    await waitFor(() => expect(useChatStore.getState().activeId).toBeNull());
    expect(screen.queryByRole('tab', { name: 'Única sessão' })).toBeNull();
    expect(tab('Nova sessão').getAttribute('aria-selected')).toBe('true');
  });

  it('restaura o foco na aba vizinha ao fechar a aba ativa (teclado)', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Primeira sessão' }),
        conversation({ id: 'c-2', title: 'Segunda sessão' }),
      ],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);
    act(() => {
      useChatStore.setState({ activeId: 'c-2' });
    });
    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());

    // The mock backend renames the conversation to its id while loading, so the
    // assertion is on the same DOM node captured before the close.
    const neighbor = tab('Primeira sessão');
    tab('Segunda sessão').focus();
    fireEvent.keyDown(tab('Segunda sessão'), { key: 'Delete' });

    await waitFor(() => expect(document.activeElement).toBe(neighbor));
  });

  it('restaura o foco no botão "+" ao fechar a última aba', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Única sessão' })],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);

    fireEvent.keyDown(tab('Única sessão'), { key: 'Delete' });

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Nova aba' })),
    );
  });
});

describe('CodeSessionHeader — teclado e painel', () => {
  async function renderWithThreeTabs(): Promise<void> {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Primeira sessão' })],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);
    act(() => {
      useChatStore.setState((state) => ({
        conversations: [
          ...state.conversations,
          conversation({ id: 'c-2', title: 'Segunda sessão' }),
          conversation({ id: 'c-3', title: 'Terceira sessão' }),
        ],
        activeId: 'c-2',
      }));
    });
    await waitFor(() => expect(tab('Segunda sessão')).toBeTruthy());
    act(() => {
      useChatStore.setState({ activeId: 'c-3' });
    });
    await waitFor(() => expect(tab('Terceira sessão')).toBeTruthy());
  }

  it('navega entre as abas com setas e Home/End, ativando com Enter', async () => {
    await renderWithThreeTabs();

    tab('Primeira sessão').focus();
    fireEvent.keyDown(tab('Primeira sessão'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Segunda sessão'));

    fireEvent.keyDown(tab('Segunda sessão'), { key: 'End' });
    expect(document.activeElement).toBe(tab('Terceira sessão'));

    fireEvent.keyDown(tab('Terceira sessão'), { key: 'Home' });
    expect(document.activeElement).toBe(tab('Primeira sessão'));

    // Ativação manual: a seta só move o foco.
    expect(useChatStore.getState().activeId).toBe('c-3');
    fireEvent.keyDown(tab('Primeira sessão'), { key: 'Enter' });
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-1'));
  });

  it('fecha a aba focada com Delete', async () => {
    await renderWithThreeTabs();

    fireEvent.keyDown(tab('Primeira sessão'), { key: 'Delete' });

    expect(screen.queryByRole('tab', { name: 'Primeira sessão' })).toBeNull();
  });

  it('reordena as abas de sessão com Alt+ArrowRight sem ativar outra aba', async () => {
    await renderWithThreeTabs();

    tab('Primeira sessão').focus();
    fireEvent.keyDown(tab('Primeira sessão'), { key: 'ArrowRight', altKey: true });

    expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
      'Segunda sessão',
      'Primeira sessão',
      'Terceira sessão',
    ]);
    expect(useChatStore.getState().activeId).toBe('c-3');
    expect(useUiStore.getState().codeTabOrder).toEqual(['c-2', 'c-1', 'c-3']);
  });

  it('reordena a aba do terminal junto das abas de sessão', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Primeira sessão' })],
      activeId: 'c-1',
    });
    terminalMock.emit({ tabs: [terminalMock.tab()], activeId: 'term-1', used: 1 });

    render(<CodeSessionHeader />);

    await waitFor(() => expect(tab('Terminal 1')).toBeTruthy());
    fireEvent.keyDown(tab('Terminal 1'), { key: 'ArrowLeft', altKey: true });

    expect(useUiStore.getState().codeTabOrder).toEqual(['term-1', 'c-1']);
    expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
      'Terminal 1',
      'Primeira sessão',
    ]);
    expect(useChatStore.getState().activeId).toBe('c-1');
  });

  it('reordena abas de arquivo, diff e commits com Alt+Arrow e persiste a ordem', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta' })],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    act(() => {
      useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
      useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });
      useUiStore.getState().openCodeDiff({ workspaceId: 'ws-1', path: 'diff.ts', staged: false });
      useUiStore.getState().openCodeCommits('ws-1');
    });
    const fileTab = await screen.findByRole('tab', { name: 'Arquivo a.ts' });
    fireEvent.keyDown(fileTab, { key: 'ArrowRight', altKey: true });

    expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
      'Sessão aberta',
      'b.ts',
      'a.ts',
      'Diff',
      'Commits',
    ]);
    const order = useUiStore.getState().codeTabOrder;
    expect(order.indexOf(order.find((id) => id.includes('b.ts')) ?? '')).toBeLessThan(
      order.indexOf(order.find((id) => id.includes('a.ts')) ?? ''),
    );
    expect(terminalMock.manager.reorderTabs).toHaveBeenCalledWith([]);
  });

  it('move uma aba de arquivo por arrasto até depois do diff e do commits', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta' })],
      activeId: 'c-1',
    });
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    act(() => {
      useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
      useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });
      useUiStore.getState().openCodeDiff({ workspaceId: 'ws-1', path: 'diff.ts', staged: false });
      useUiStore.getState().openCodeCommits('ws-1');
    });
    const rendered = await waitFor(() => {
      const all = screen.getAllByRole('tab');
      expect(all.map((node) => node.textContent)).toEqual([
        'Sessão aberta',
        'a.ts',
        'b.ts',
        'Diff',
        'Commits',
      ]);
      return all;
    });
    screen.getByRole('tablist', { name: 'Abas abertas' }).getBoundingClientRect = () =>
      rect(0, 32, 0, 1000);
    rendered.forEach((node, index) => {
      node.getBoundingClientRect = () => rect(0, 32, index * 100, index * 100 + 80);
    });

    fireEvent.pointerDown(rendered[1], { button: 0, clientX: 40, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 450, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 450, clientY: 10 });

    await waitFor(() =>
      expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
        'Sessão aberta',
        'b.ts',
        'Diff',
        'Commits',
        'a.ts',
      ]),
    );
    const order = useUiStore.getState().codeTabOrder;
    expect(order[order.length - 1]).toContain('a.ts');
  });

  it('mantém a aba Nova sessão fixa na frente ao reordenar abas de contexto', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Nova sessão')).toBeTruthy());
    act(() => {
      useUiStore.getState().openCodeDiff({ workspaceId: 'ws-1', path: 'a.ts', staged: false });
    });
    const diffTab = await screen.findByRole('tab', { name: 'Diff de a.ts' });
    fireEvent.keyDown(diffTab, { key: 'ArrowLeft', altKey: true });

    expect(screen.getAllByRole('tab')[0]).toBe(tab('Nova sessão'));
  });

  it('o botão do painel alterna codePanelOpen e expõe aria-pressed', () => {
    render(<CodeSessionHeader />);

    const openButton = screen.getByRole('button', { name: 'Ocultar painel de arquivos' });
    expect(openButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(openButton);

    expect(useUiStore.getState().codePanelOpen).toBe(false);
    const closedButton = screen.getByRole('button', { name: 'Mostrar painel de arquivos' });
    expect(closedButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('desabilita o botão do painel e explica a largura mínima abaixo de 1120px', () => {
    setViewport(1000);

    render(<CodeSessionHeader />);

    const button = screen.getByRole('button', { name: 'Ocultar painel de arquivos' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTitle('Aumente a janela para ver o painel de arquivos')).toBeTruthy();
  });
});

describe('CodeSessionHeader — sessões separadas por layout', () => {
  it('ignora sessões do Chat não compartilhadas nas abas e no título', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-code', title: 'Sessão do Code' }),
        conversation({ id: 'c-chat', title: 'Conversa só do Chat', mode: 'chat' }),
      ],
      activeId: 'c-code',
    });

    render(<CodeSessionHeader />);

    expect(screen.getByRole('heading', { name: 'Sessão do Code' })).toBeTruthy();
    expect(tab('Sessão do Code').getAttribute('aria-selected')).toBe('true');

    // Mesmo que o activeId aponte para uma sessão exclusiva do Chat, ela não
    // vira aba/título no Code.
    act(() => {
      useChatStore.setState({ activeId: 'c-chat' });
    });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nova sessão' })).toBeTruthy());
    expect(screen.queryByRole('tab', { name: 'Conversa só do Chat' })).toBeNull();
    expect(tab('Nova sessão').getAttribute('aria-selected')).toBe('true');
  });

  it('inclui a sessão do Chat compartilhada como aba normal', async () => {
    useChatStore.setState({
      conversations: [
        conversation({
          id: 'c-shared',
          title: 'Conversa compartilhada',
          mode: 'chat',
          codeLinked: true,
        }),
      ],
      activeId: 'c-shared',
    });

    render(<CodeSessionHeader />);

    expect(screen.getByRole('heading', { name: 'Conversa compartilhada' })).toBeTruthy();
    await waitFor(() =>
      expect(tab('Conversa compartilhada').getAttribute('aria-selected')).toBe('true'),
    );
  });

  it('mostra a aba de diff aberta como aba central e fecha pelo X', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);

    act(() => {
      useUiStore.getState().openCodeDiff({
        workspaceId: 'ws-1',
        path: 'src/app.ts',
        staged: false,
        knownDiff: '@@ -1 +1 @@\n-a\n+b',
      });
    });

    const diffTab = await screen.findByRole('tab', { name: 'Diff de src/app.ts' });
    expect(diffTab.getAttribute('aria-selected')).toBe('true');
    // A aba da sessão deixa de parecer ativa enquanto o diff está aberto.
    expect(tab('Sessão aberta').getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar diff de src/app.ts' }));
    expect(useUiStore.getState().codeDiffTab).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
    expect(screen.queryByRole('tab', { name: 'Diff de src/app.ts' })).toBeNull();
  });

  it('ao fechar a última aba, limpa a sessão ativa do layout pelo store', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Única sessão' })],
      activeId: 'c-1',
      activeIdByLayout: { chat: 'c-chat-preservada', code: 'c-1', agent: null },
    });
    useUiStore.setState({ artifactPanelOpen: true });

    render(<CodeSessionHeader />);

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Única sessão' }));

    await waitFor(() => expect(useChatStore.getState().activeId).toBeNull());
    // Só a sessão do Code é limpa; a do Chat continua lembrada.
    expect(useChatStore.getState().activeIdByLayout).toEqual({
      chat: 'c-chat-preservada',
      code: null,
      agent: null,
    });
    expect(useUiStore.getState().artifactPanelOpen).toBe(false);
    expect(tab('Nova sessão').getAttribute('aria-selected')).toBe('true');
  });
});

describe('CodeSessionHeader — troca de aba com diff aberto', () => {
  it('clicar na aba da sessão ativa volta do diff para a conversa', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Primeira sessão' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);

    act(() => {
      useUiStore.getState().openCodeDiff({
        workspaceId: 'ws-1',
        path: 'src/app.ts',
        staged: false,
        knownDiff: '@@ -1 +1 @@\n-a\n+b',
      });
    });

    expect(await screen.findByRole('tab', { name: 'Diff de src/app.ts' })).toBeTruthy();
    fireEvent.click(tab('Primeira sessão'));

    await waitFor(() => {
      expect(useUiStore.getState().codeView).toBe('session');
    });
    // A aba de diff continua aberta para ser reaberta pelo clique nela.
    expect(useUiStore.getState().codeDiffTab?.path).toBe('src/app.ts');
  });
});

describe('CodeSessionHeader — aba de histórico de commits', () => {
  it('mostra a aba de commits, ativa e fecha pelo X', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta' })],
      activeId: 'c-1',
    });

    render(<CodeSessionHeader />);

    act(() => {
      useUiStore.getState().openCodeCommits('ws-1');
    });

    const commitsTab = await screen.findByRole('tab', { name: 'Histórico de commits' });
    expect(commitsTab.getAttribute('aria-selected')).toBe('true');
    expect(tab('Sessão aberta').getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar histórico de commits' }));
    expect(useUiStore.getState().codeCommitsTab).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
  });
});

describe('CodeSessionHeader - abas de subagente', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta' })],
      activeId: 'c-1',
    });
  });

  it('mostra múltiplas abas de subagente, ativa e fecha cada uma', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    act(() => {
      useUiStore.getState().openCodeSubagent({
        conversationId: 'child-1',
        taskCallId: 'task-1',
        subagentType: 'explore',
        description: 'Mapear o módulo',
      });
      useUiStore.getState().openCodeSubagent({
        conversationId: 'child-2',
        taskCallId: 'task-2',
        subagentType: 'review',
        description: 'Revisar o diff',
      });
    });

    expect(useUiStore.getState().codeSubagentTabs).toHaveLength(2);
    const first = await screen.findByRole('tab', { name: 'Subagente Mapear o módulo' });
    const second = await screen.findByRole('tab', { name: 'Subagente Revisar o diff' });
    expect(first.getAttribute('aria-selected')).toBe('false');
    expect(second.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(first);
    expect(useUiStore.getState().codeView).toBe('subagent');
    expect(first.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Subagente Mapear o módulo' }));
    expect(useUiStore.getState().codeSubagentTabs).toHaveLength(1);
    expect(useUiStore.getState().codeSubagentTab?.conversationId).toBe('child-2');
    expect(screen.queryByRole('tab', { name: 'Subagente Mapear o módulo' })).toBeNull();
  });

  it('reordena abas de subagente com Alt+Arrow e persiste a ordem', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    act(() => {
      useUiStore.getState().openCodeSubagent({
        conversationId: 'child-1',
        taskCallId: 'task-1',
        subagentType: 'explore',
        description: 'Mapear o módulo',
      });
      useUiStore.getState().openCodeSubagent({
        conversationId: 'child-2',
        taskCallId: 'task-2',
        subagentType: 'review',
        description: 'Revisar o diff',
      });
    });

    const first = await screen.findByRole('tab', { name: 'Subagente Mapear o módulo' });
    const second = await screen.findByRole('tab', { name: 'Subagente Revisar o diff' });
    fireEvent.keyDown(first, { key: 'ArrowRight', altKey: true });

    const rendered = screen.getAllByRole('tab');
    expect(rendered.indexOf(second)).toBeLessThan(rendered.indexOf(first));
    expect(useUiStore.getState().codeTabOrder[1]).toContain('child-2');
  });
});

describe('CodeSessionHeader - aba do plano', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta' })],
      activeId: 'c-1',
    });
  });

  it('mostra a aba do plano, ativa no centro e fecha pelo X', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    act(() => {
      useUiStore.getState().openCodePlan({
        conversationId: 'c-1',
        markdown: '# Plano aprovado',
        title: 'Plano',
        updatedAt: 1,
      });
    });

    const planTab = await screen.findByRole('tab', { name: 'Plano aprovado da sessão' });
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(planTab.getAttribute('aria-controls')).toBe('code-plan-panel');
    expect(planTab.textContent).toBe('Plano');
    expect(tab('Sessão aberta').getAttribute('aria-selected')).toBe('false');

    // Voltar para a sessão mantém a aba do plano disponível.
    fireEvent.click(tab('Sessão aberta'));
    expect(useUiStore.getState().codeView).toBe('session');
    expect(useUiStore.getState().codePlanTab?.markdown).toBe('# Plano aprovado');
    expect(planTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(planTab);
    expect(useUiStore.getState().codeView).toBe('plan');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar plano' }));
    expect(useUiStore.getState().codePlanTab).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
    expect(screen.queryByRole('tab', { name: 'Plano aprovado da sessão' })).toBeNull();
  });
});

describe('CodeSessionHeader — aba central de arquivo', () => {
  function openFile(path: string): void {
    act(() => {
      useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path });
    });
  }

  function setGitStatus(overrides: Partial<WorkspaceGitStatus>): void {
    mocks.gitStatus.mockResolvedValue({
      isRepo: true,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      ...overrides,
    } satisfies WorkspaceGitStatus);
  }

  beforeEach(() => {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão aberta', workspaceId: 'ws-1' })],
      activeId: 'c-1',
    });
  });

  it('mostra a aba do arquivo com ícone do tipo, nome curto e caminho completo', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta').getAttribute('aria-selected')).toBe('true'));

    openFile('src/app.ts');

    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });
    expect(fileTab.getAttribute('aria-selected')).toBe('true');
    expect(fileTab.getAttribute('aria-controls')).toBe('code-file-panel');
    expect(fileTab.getAttribute('title')).toBe('Arquivo src/app.ts');
    expect(fileTab.textContent).toBe('app.ts');
    expect(
      fileTab.querySelector('[data-file-icon]')?.getAttribute('data-file-icon'),
    ).toBe('typescript');
    // Enquanto o arquivo está no centro, a aba da sessão não parece ativa.
    expect(tab('Sessão aberta').getAttribute('aria-selected')).toBe('false');
  });

  it('fecha a aba pelo X, volta para a sessão e devolve o foco à aba ativa', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/app.ts');
    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });
    fileTab.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Fechar app.ts' }));

    expect(useUiStore.getState().codeFileTab).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
    expect(screen.queryByRole('tab', { name: 'Arquivo src/app.ts' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(tab('Sessão aberta')));
  });

  it('clicar na aba do arquivo reabre o arquivo; a aba da sessão volta para a conversa', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/app.ts');
    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });

    fireEvent.click(tab('Sessão aberta'));

    expect(useUiStore.getState().codeView).toBe('session');
    expect(useUiStore.getState().codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'src/app.ts' });
    expect(fileTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(fileTab);

    expect(useUiStore.getState().codeView).toBe('file');
    expect(fileTab.getAttribute('aria-selected')).toBe('true');
  });

  it('entra na navegação por teclado (setas) e fecha a aba com Delete', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/app.ts');
    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });

    tab('Sessão aberta').focus();
    fireEvent.keyDown(tab('Sessão aberta'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(fileTab);

    fireEvent.keyDown(fileTab, { key: 'Delete' });

    expect(useUiStore.getState().codeFileTab).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
  });

  it('a aba de arquivo fica entre as abas de sessão e o diff', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    act(() => {
      useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/app.ts' });
      useUiStore.getState().openCodeDiff({
        workspaceId: 'ws-1',
        path: 'src/app.ts',
        staged: false,
        knownDiff: '@@ -1 +1 @@\n-a\n+b',
      });
    });

    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });
    const diffTab = await screen.findByRole('tab', { name: 'Diff de src/app.ts' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.indexOf(fileTab)).toBeLessThan(tabs.indexOf(diffTab));
    expect(tabs.indexOf(fileTab)).toBeGreaterThan(tabs.indexOf(tab('Sessão aberta')));
    // O diff ficou como view ativa (último alvo aberto), não o arquivo.
    expect(useUiStore.getState().codeView).toBe('diff');
    expect(fileTab.getAttribute('aria-selected')).toBe('false');
  });

  it('permite várias abas de arquivo, na ordem de abertura', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    openFile('src/app.ts');
    openFile('src/main.ts');

    const first = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });
    const second = await screen.findByRole('tab', { name: 'Arquivo src/main.ts' });
    const allTabs = screen.getAllByRole('tab');
    expect(allTabs.indexOf(first)).toBeLessThan(allTabs.indexOf(second));
    expect(useUiStore.getState().codeFileTabs).toHaveLength(2);
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(first.getAttribute('aria-selected')).toBe('false');
  });

  it('clicar numa aba de arquivo ativa o arquivo sem duplicar a aba', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/app.ts');
    openFile('src/main.ts');
    const first = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });

    fireEvent.click(first);

    expect(useUiStore.getState().codeFileTabs).toHaveLength(2);
    expect(useUiStore.getState().codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'src/app.ts' });
    expect(useUiStore.getState().codeView).toBe('file');
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(tab('Arquivo src/main.ts').getAttribute('aria-selected')).toBe('false');
  });

  it('abrir o mesmo arquivo de novo só ativa a aba que já existe', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    openFile('src/app.ts');
    openFile('src/app.ts');

    expect(useUiStore.getState().codeFileTabs).toHaveLength(1);
    expect(screen.getAllByRole('tab', { name: 'Arquivo src/app.ts' })).toHaveLength(1);
  });

  it('X na aba ativa ativa e foca a vizinha da direita', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/a.ts');
    openFile('src/b.ts');
    openFile('src/c.ts');
    const middle = await screen.findByRole('tab', { name: 'Arquivo src/b.ts' });

    fireEvent.click(middle);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar b.ts' }));

    const right = screen.getByRole('tab', { name: 'Arquivo src/c.ts' });
    expect(useUiStore.getState().codeFileTabs).toHaveLength(2);
    expect(useUiStore.getState().codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'src/c.ts' });
    expect(right.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(right));
  });

  it('X numa aba de segundo plano mantém a aba ativa e a view', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/a.ts');
    openFile('src/b.ts');
    await screen.findByRole('tab', { name: 'Arquivo src/b.ts' });

    fireEvent.click(screen.getByRole('button', { name: 'Fechar a.ts' }));

    expect(useUiStore.getState().codeFileTabs).toHaveLength(1);
    expect(useUiStore.getState().codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'src/b.ts' });
    expect(useUiStore.getState().codeView).toBe('file');
    await waitFor(() => expect(document.activeElement).toBe(tab('Arquivo src/b.ts')));
  });

  it('o teclado atravessa as abas de arquivo na ordem e para no diff', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/a.ts');
    openFile('src/b.ts');
    const first = await screen.findByRole('tab', { name: 'Arquivo src/a.ts' });
    const second = await screen.findByRole('tab', { name: 'Arquivo src/b.ts' });
    act(() => {
      useUiStore.getState().openCodeDiff({
        workspaceId: 'ws-1',
        path: 'src/a.ts',
        staged: false,
        knownDiff: '@@ -1 +1 @@\n-a\n+b',
      });
    });
    const diff = await screen.findByRole('tab', { name: 'Diff de src/a.ts' });

    tab('Sessão aberta').focus();
    fireEvent.keyDown(tab('Sessão aberta'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(diff);
  });

  it('mostra o estado do git na aba do arquivo modificado', async () => {
    setGitStatus({ unstaged: [{ path: 'src/app.ts', status: 'M' }] });
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    openFile('src/app.ts');

    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts — Modificado' });
    const badge = fileTab.querySelector('[data-git-status="M"]');
    expect(badge?.textContent).toBe('M');
    expect(badge?.className).toContain('text-warning');
    expect(fileTab.getAttribute('title')).toBe('Arquivo src/app.ts — Modificado');
  });

  it('cobre todos os estados: novo, removido, renomeado, conflito, não rastreado e tipo', async () => {
    setGitStatus({
      staged: [
        { path: 'new.ts', status: 'A' },
        { path: 'src/renamed.ts', status: 'R' },
      ],
      unstaged: [
        { path: 'src/gone.ts', status: 'D' },
        { path: 'src/typed.ts', status: 'T' },
      ],
      untracked: ['src/untracked.ts'],
      conflicted: ['src/conflict.ts'],
    });
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    const cases: Array<[string, string, string]> = [
      ['new.ts', 'A', 'Adicionado · no índice'],
      ['src/gone.ts', 'D', 'Removido'],
      ['src/renamed.ts', 'R', 'Renomeado · no índice'],
      ['src/typed.ts', 'T', 'Tipo alterado'],
      ['src/untracked.ts', '?', 'Não rastreado'],
      ['src/conflict.ts', 'U', 'Com conflito'],
    ];
    for (const [path, code, label] of cases) {
      openFile(path);
      const fileTab = await screen.findByRole('tab', { name: `Arquivo ${path} — ${label}` });
      expect(fileTab.querySelector(`[data-git-status="${code}"]`)?.textContent).toBe(code);
    }
  });

  it('não mostra badge fora de um repositório', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());

    openFile('src/app.ts');

    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts' });
    expect(fileTab.querySelector('[data-git-status]')).toBeNull();
  });

  it('atualiza o badge quando o status do git muda', async () => {
    setGitStatus({ unstaged: [{ path: 'src/app.ts', status: 'M' }] });
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão aberta')).toBeTruthy());
    openFile('src/app.ts');
    await screen.findByRole('tab', { name: 'Arquivo src/app.ts — Modificado' });

    setGitStatus({ unstaged: [{ path: 'src/app.ts', status: 'D' }] });
    await act(async () => {
      for (const handler of [...gitListeners]) {
        handler({ payload: { workspaceId: 'ws-1' } });
      }
    });

    const fileTab = await screen.findByRole('tab', { name: 'Arquivo src/app.ts — Removido' });
    expect(fileTab.querySelector('[data-git-status="D"]')).toBeTruthy();
  });
});
function goal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    title: 'Fechar o bug',
    objective: 'Corrigir o cálculo de juros.',
    status: 'active',
    autoContinue: true,
    rounds: 3,
    maxRounds: 25,
    revision: 7,
    origin: 'user',
    createdAt: 1_000,
    updatedAt: 2_000,
    completedAt: null,
    lastRoundAt: null,
    lastNote: null,
    pauseReason: null,
    pauseDetail: null,
    blockerReason: null,
    blockerStreak: 0,
    stalledRounds: 0,
    tokens: 0,
    cost: 0,
    ...overrides,
  };
}

function seedGoalSession(goalValue: GoalView, title = 'Sessão com objetivo'): void {
  useChatStore.setState({
    conversations: [conversation({ id: 'c-1', title })],
    activeId: 'c-1',
  });
  useCodeStore.setState({
    byConversation: {
      'c-1': { ...emptyCodeSession('c-1'), goal: goalValue },
    },
  });
}

describe('CodeSessionHeader — objetivo (badge)', () => {
  it('mostra o badge de rodada do objetivo ativo e abre o painel ao clicar', async () => {
    seedGoalSession(goal());

    render(<CodeSessionHeader />);

    const badge = await screen.findByRole('button', {
      name: 'Abrir objetivo: ativo, rodada 3 de 25, continuidade automática',
    });
    expect(badge.textContent).toContain('3/25');

    fireEvent.click(badge);

    expect(useUiStore.getState().codeGoalOpen).toBe(true);
    expect(useUiStore.getState().codeView).toBe('goal');
  });

  it('badge pausado expõe o motivo no nome acessível', async () => {
    seedGoalSession(goal({ status: 'paused', pauseReason: 'error', autoContinue: false }));

    render(<CodeSessionHeader />);

    const badge = await screen.findByRole('button', {
      name: /Abrir objetivo: pausado \(Pausado após um erro\)/,
    });
    expect(badge.textContent).toBe('Pausado');
  });

  it('badge bloqueado usa o tom de perigo', async () => {
    seedGoalSession(goal({ status: 'blocked', autoContinue: false }));

    render(<CodeSessionHeader />);

    const badge = await screen.findByRole('button', { name: 'Abrir objetivo: bloqueado' });
    expect(badge.className).toContain('bg-danger-soft');
    expect(badge.textContent).toBe('Bloqueado');
  });

  it('rodada em andamento mostra spinner e N/M', async () => {
    seedGoalSession(goal());
    useChatStore.setState({
      streaming: {
        turnId: 'turn-1',
        conversationId: 'c-1',
        assistantId: 'assistant-1',
        userMessageId: 'user-1',
        phase: 'text',
        step: 1,
        startedAt: 1,
        turnKind: 'goal_round',
      },
    });

    render(<CodeSessionHeader />);

    const badge = await screen.findByRole('button', {
      name: 'Abrir objetivo: rodada 3 de 25 em andamento',
    });
    expect(badge.textContent).toContain('3/25');
    expect(badge.querySelector('svg')).toBeTruthy();
  });

  it('objetivo concluído não mostra badge', async () => {
    seedGoalSession(goal({ status: 'completed', autoContinue: false }));

    render(<CodeSessionHeader />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sessão com objetivo' })).toBeTruthy());

    expect(screen.queryByRole('button', { name: /Abrir objetivo/ })).toBeNull();
  });

  it('sem objetivo não mostra badge', () => {
    render(<CodeSessionHeader />);
    expect(screen.queryByRole('button', { name: /Abrir objetivo/ })).toBeNull();
  });
});

describe('CodeSessionHeader — aba central do objetivo', () => {
  beforeEach(() => {
    seedGoalSession(goal());
  });

  it('mostra a aba Objetivo, ativa no centro e fecha pelo X', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão com objetivo')).toBeTruthy());

    act(() => {
      useUiStore.getState().openCodeGoal();
    });

    const goalTab = await screen.findByRole('tab', { name: 'Objetivo da sessão' });
    expect(goalTab.getAttribute('aria-selected')).toBe('true');
    expect(goalTab.getAttribute('aria-controls')).toBe('code-goal-panel');
    expect(goalTab.textContent).toBe('Objetivo');
    // A aba da sessão deixa de parecer ativa enquanto o painel está no centro.
    expect(tab('Sessão com objetivo').getAttribute('aria-selected')).toBe('false');

    // Voltar para a sessão mantém a aba do objetivo disponível.
    fireEvent.click(tab('Sessão com objetivo'));
    expect(useUiStore.getState().codeView).toBe('session');
    expect(goalTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(goalTab);
    expect(useUiStore.getState().codeView).toBe('goal');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar objetivo' }));
    expect(useUiStore.getState().codeGoalOpen).toBe(false);
    expect(useUiStore.getState().codeView).toBe('session');
    expect(screen.queryByRole('tab', { name: 'Objetivo da sessão' })).toBeNull();
  });

  it('navegação por teclado alcança a aba e Delete a fecha', async () => {
    render(<CodeSessionHeader />);
    await waitFor(() => expect(tab('Sessão com objetivo')).toBeTruthy());
    act(() => {
      useUiStore.getState().openCodeGoal();
    });
    const goalTab = await screen.findByRole('tab', { name: 'Objetivo da sessão' });

    tab('Sessão com objetivo').focus();
    fireEvent.keyDown(tab('Sessão com objetivo'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(goalTab);

    fireEvent.keyDown(goalTab, { key: 'Delete' });
    expect(useUiStore.getState().codeGoalOpen).toBe(false);
    expect(useUiStore.getState().codeView).toBe('session');
    expect(screen.queryByRole('tab', { name: 'Objetivo da sessão' })).toBeNull();
  });
});

describe('CodeSessionHeader — terminais nas abas', () => {
  function activeSession(): void {
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão', workspaceId: 'ws-1' })],
      activeId: 'c-1',
    });
  }

  it('o menu + abre um terminal novo na superfície central, separado do painel', async () => {
    activeSession();
    terminalMock.manager.open.mockImplementationOnce(async () => {
      const terminalTab = terminalMock.tab();
      terminalMock.emit({ tabs: [terminalTab], activeId: terminalTab.id, used: 1 });
      return terminalTab.id;
    });

    render(<CodeSessionHeader />);
    openMenu(screen.getByRole('button', { name: 'Nova aba' }));

    fireEvent.click(await screen.findByRole('menuitem', { name: /Terminal/ }));

    await waitFor(() =>
      expect(terminalMock.manager.open).toHaveBeenCalledWith(
        { conversationId: 'c-1' },
        'center',
      ),
    );
    expect(useUiStore.getState().codeView).toBe('terminal');
    // The right panel's Terminal tab is independent and stays where it was.
    expect(useUiStore.getState().codePanelTab).toBe('changes');
    expect(await screen.findByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
  });

  it('mostra a aba do terminal central e fecha a última voltando à sessão', async () => {
    activeSession();
    const terminalTab = terminalMock.tab();
    terminalMock.emit({ tabs: [terminalTab], activeId: terminalTab.id, used: 1 });
    useUiStore.setState({ codeView: 'terminal' });

    render(<CodeSessionHeader />);
    const terminalTabButton = await screen.findByRole('tab', { name: 'Terminal 1' });
    expect(terminalTabButton.getAttribute('aria-selected')).toBe('true');
    expect(terminalTabButton.getAttribute('aria-controls')).toBe('code-terminal-panel');
    expect(terminalTabButton.getAttribute('id')).toBe('terminal-tab-term-1');

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Terminal 1' }));

    await waitFor(() => expect(terminalMock.manager.close).toHaveBeenCalledWith('term-1'));
    expect(useUiStore.getState().codeView).toBe('session');
  });

  it('clicar na aba do terminal ativa o xterm e o centro', async () => {
    activeSession();
    const terminalTab = terminalMock.tab();
    terminalMock.emit({ tabs: [terminalTab], activeId: terminalTab.id, used: 1 });
    useUiStore.setState({ codeView: 'session' });

    render(<CodeSessionHeader />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Terminal 1' }));

    expect(terminalMock.manager.activate).toHaveBeenCalledWith('term-1', {
      focusTerminal: true,
    });
    expect(useUiStore.getState().codeView).toBe('terminal');
  });

  it('mantém a aba do terminal ao trocar de sessão', async () => {
    activeSession();
    const terminalTab = terminalMock.tab();
    terminalMock.emit({ tabs: [terminalTab], activeId: terminalTab.id, used: 1 });
    useUiStore.setState({ codeView: 'terminal' });

    render(<CodeSessionHeader />);
    expect(await screen.findByRole('tab', { name: 'Terminal 1' })).toBeTruthy();

    act(() =>
      useChatStore.setState({
        conversations: [
          conversation({ id: 'c-1', title: 'Sessão', workspaceId: 'ws-1' }),
          conversation({ id: 'c-2', title: 'Outra sessão', workspaceId: 'ws-2' }),
        ],
        activeId: 'c-2',
      }),
    );

    // The terminal list is global: the tab stays and the view keeps showing it.
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(useUiStore.getState().codeView).toBe('terminal');
  });

  it('os eventos dos atalhos disparam as mesmas ações do menu', async () => {
    activeSession();
    terminalMock.manager.open.mockImplementationOnce(async () => {
      const terminalTab = terminalMock.tab();
      terminalMock.emit({ tabs: [terminalTab], activeId: terminalTab.id, used: 1 });
      return terminalTab.id;
    });

    render(<CodeSessionHeader />);
    act(() => {
      window.dispatchEvent(new CustomEvent('zylara:code-new-terminal'));
    });
    await waitFor(() =>
      expect(terminalMock.manager.open).toHaveBeenCalledWith(
        { conversationId: 'c-1' },
        'center',
      ),
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('zylara:code-new-session'));
    });
    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledTimes(1));
  });
});
