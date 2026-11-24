// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppInfo, Conversation, Settings, Workspace } from '@/lib/types';

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
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  listArtifacts: vi.fn(),
  setConversationCodeLinked: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  exportConversation: vi.fn(),
  setConversationPinned: vi.fn(),
  reorderWorkspaces: vi.fn(),
  reorderConversations: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

/** Terminal flows live behind their own module (the sidebar itself never spawns a PTY). */
const terminalOpen = vi.hoisted(() => ({ openWorkspaceTerminal: vi.fn() }));

vi.mock('./terminalOpen', () => ({
  openWorkspaceTerminal: terminalOpen.openWorkspaceTerminal,
  openTerminal: vi.fn(),
}));

// Imported after the API mock.
import { useAppStore, useChatStore, useUiStore } from '@/lib/store';
import type { StreamingState } from '@/lib/store';
import { __resetWorkspacesForTests } from './useWorkspaces';
import { CodeSidebar } from './CodeSidebar';

const originalMatchMedia = window.matchMedia;

/** jsdom setup returns `matches: false`; tests may force the compact drawer. */
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

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
    borderRadiusEnabled: true,
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

function streamingState(overrides: Partial<StreamingState> = {}): StreamingState {
  return {
    turnId: 'turn-1',
    conversationId: 'c-2',
    assistantId: 'assistant-1',
    userMessageId: 'user-1',
    phase: 'text',
    step: 1,
    startedAt: 1,
    turnKind: 'user',
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

function renderSidebar(onClose?: () => void) {
  return render(onClose ? <CodeSidebar onClose={onClose} /> : <CodeSidebar />);
}

/** `count` Code sessions of one workspace, in a deterministic manual order. */
function codeSessions(count: number, workspaceId = 'ws-1'): Conversation[] {
  return Array.from({ length: count }, (_, index) =>
    conversation({
      id: `c-${index + 1}`,
      title: `Sessão ${index + 1}`,
      workspaceId,
      sortOrder: index,
      updatedAt: index + 1,
    }),
  );
}

/** Radix DropdownMenu opens on pointerdown, not click (see other tests). */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspacesForTests();
  window.matchMedia = matchMediaReturning(false);
  mocks.listWorkspaces.mockResolvedValue([]);
  mocks.listConversations.mockResolvedValue([]);
  mocks.listArtifacts.mockResolvedValue([]);
  mocks.createConversation.mockResolvedValue(conversation());
  mocks.getConversation.mockImplementation(async (id: string) => ({
    // Mirror the backend: the stored conversation keeps its mode/codeLinked.
    conversation:
      useChatStore.getState().conversations.find((entry) => entry.id === id) ??
      conversation({ id }),
    messages: [],
  }));
  mocks.setConversationCodeLinked.mockImplementation(async (id: string, linked: boolean) =>
    conversation({ id, mode: 'chat', codeLinked: linked }),
  );
  mocks.setConversationWorkspace.mockImplementation(async (id: string, workspaceId: string | null) =>
    conversation({ id, workspaceId }),
  );
  mocks.setWorkspaceTrusted.mockResolvedValue(workspace({ trusted: true }));
  mocks.setPermissionMode.mockResolvedValue({
    conversationId: 'c-new',
    permissionMode: 'edit',
    planMode: false,
    todos: [],
    jobs: [],
    approvals: [],
  });
  useAppStore.setState({ settings: settings(), appInfo: appInfo() });
  useChatStore.setState({
    conversations: [],
    conversationsLoading: false,
    activeId: null,
    activeIdByLayout: { chat: null, code: null, agent: null },
    streamsByConversation: {},
    streaming: null,
  });
  useUiStore.setState({
    layoutMode: 'code',
    codeView: 'session',
    codePanelOpen: true,
    codePanelTab: 'changes',
    activeWorkspaceId: null,
    openSessionsByWorkspace: {},
    commandPaletteOpen: false,
    settingsOpen: false,
  });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe('CodeSidebar — chrome e ações', () => {
  it('é a sidebar de Sessões sobre a superfície do chrome, sem borda divisória', () => {
    renderSidebar();

    const aside = screen.getByRole('complementary', { name: 'Sessões' });
    expect(aside.className).toContain('bg-surface');
    expect(aside.className).toContain('w-full');
    expect(aside.className).not.toContain('border-r');
  });

  it('oferece Novo agente, Plugins e Skills na ordem, sem as ações removidas', async () => {
    renderSidebar();

    const newAgent = screen.getByRole('button', { name: /Nova sess/i });
    const plugins = screen.getByRole('button', { name: 'Plugins' });
    const skills = screen.getByRole('button', { name: 'Skills' });

    expect(
      newAgent.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(plugins.compareDocumentPosition(skills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Abrir pasta' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adicionar sessão do Chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Buscar$/ })).toBeNull();
    await waitFor(() => expect(mocks.listWorkspaces).toHaveBeenCalled());
  });

  it('+ Novo agente no workspace ativo cria a sessão vinculada', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useUiStore.setState({ activeWorkspaceId: 'ws-1', codeView: 'skills' });
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /Nova sess/i }));

    // O centro volta para a sessão imediatamente.
    expect(useUiStore.getState().codeView).toBe('session');
    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledTimes(1));
    expect(mocks.createConversation.mock.calls[0]?.[3]).toBe('code');
    await waitFor(() =>
      expect(mocks.setConversationWorkspace).toHaveBeenCalledWith('c-new', 'ws-1'),
    );
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-new'));
    expect(useUiStore.getState().openSessionsByWorkspace['ws-1']).toEqual(['c-new']);
  });

  it('+ Novo agente sem workspace ativo pede uma pasta', async () => {
    const ws = workspace();
    mocks.pickWorkspaceFolder.mockResolvedValue('C:/dev/zylara');
    mocks.addWorkspace.mockResolvedValue(ws);
    mocks.listWorkspaces.mockResolvedValue([ws]);
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /Nova sess/i }));

    await waitFor(() => expect(mocks.pickWorkspaceFolder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useUiStore.getState().activeWorkspaceId).toBe('ws-1'));
  });

  it('Skills abre a página de Skills e marca o item como atual', () => {
    renderSidebar();

    const skills = screen.getByRole('button', { name: 'Skills' });
    expect(skills.getAttribute('aria-current')).toBeNull();

    fireEvent.click(skills);

    expect(useUiStore.getState().codeView).toBe('skills');
    expect(screen.getByRole('button', { name: 'Skills' }).getAttribute('aria-current')).toBe('page');
  });

  it('Plugins abre a página de Plugins no Code e marca o item como atual', () => {
    renderSidebar();

    const plugins = screen.getByRole('button', { name: 'Plugins' });
    expect(plugins.getAttribute('aria-current')).toBeNull();

    fireEvent.click(plugins);

    expect(useUiStore.getState().codeView).toBe('plugins');
    expect(screen.getByRole('button', { name: 'Plugins' }).getAttribute('aria-current')).toBe('page');
  });

  it('esconde Skills quando o painel de skills está desativado nas configurações', () => {
    useAppStore.setState({ settings: settings({ skillsPanelEnabled: false }) });
    renderSidebar();

    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
    // O resto das ações continua disponível.
    expect(screen.getByRole('button', { name: /Nova sess/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeTruthy();
  });

});

describe('CodeSidebar — Workspaces reais', () => {
  it('mostra o estado vazio honesto com CTA de abrir pasta', async () => {
    renderSidebar();

    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeTruthy();
    expect(await screen.findByText('Nenhum workspace aberto')).toBeTruthy();
    expect(
      screen.getByText('Abra uma pasta para o agente ler, editar e rodar comandos.'),
    ).toBeTruthy();

    const cta = screen.getByRole('button', { name: 'Abrir pasta…' });
    mocks.pickWorkspaceFolder.mockResolvedValue('C:/dev/zylara');
    mocks.addWorkspace.mockResolvedValue(workspace());
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    fireEvent.click(cta);

    await waitFor(() => expect(mocks.pickWorkspaceFolder).toHaveBeenCalledTimes(1));
  });

  it('lista workspaces com nome/branch/estado sujo e contador de sessões', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      workspace(),
      workspace({ id: 'ws-2', name: 'site-institucional', path: 'C:/dev/site', git: null }),
    ]);
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Corrigir o build', workspaceId: 'ws-1' }),
        conversation({ id: 'c-2', title: 'Revisar o diff', workspaceId: 'ws-1' }),
      ],
    });

    renderSidebar();

    const core = await screen.findByRole('button', { name: 'zylara-core' });
    expect(core.textContent).toContain('main');
    expect(core.textContent).toContain('2');
    const site = screen.getByRole('button', { name: 'site-institucional' });
    expect(site.textContent).toContain('0');

    // As sessões do workspace aparecem agrupadas sob ele.
    expect(screen.getByRole('button', { name: 'Corrigir o build' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revisar o diff' })).toBeTruthy();
  });

  it('expande/recolhe as sessões do workspace', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Corrigir o build', workspaceId: 'ws-1' })],
    });
    renderSidebar();

    expect(await screen.findByRole('button', { name: 'Corrigir o build' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recolher sessões de zylara-core' }));

    expect(screen.queryByRole('button', { name: 'Corrigir o build' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expandir sessões de zylara-core' }));
    expect(screen.getByRole('button', { name: 'Corrigir o build' })).toBeTruthy();
  });

  it('mostra o spinner de execução na sessão em andamento', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Sessão ativa', workspaceId: 'ws-1' }),
        conversation({ id: 'c-2', title: 'Sessão em execução', workspaceId: 'ws-1' }),
      ],
      activeId: 'c-1',
      streamsByConversation: { 'c-2': streamingState() },
      streaming: null,
    });
    renderSidebar();

    const idle = await screen.findByRole('button', { name: 'Sessão ativa' });
    const running = screen.getByRole('button', { name: 'Sessão em execução' });
    const runningRow = running.closest('div') as HTMLElement;

    expect(within(idle).queryByRole('status')).toBeNull();
    // The spinner shares the row-actions slot: it lives outside the session
    // button so the "…" trigger can be painted above it on hover.
    expect(within(running).queryByRole('status')).toBeNull();
    const status = within(runningRow).getByRole('status', { name: 'Executando' });
    expect(within(runningRow).getAllByRole('status')).toHaveLength(1);
    expect(status.parentElement?.className).toContain('right-1');

    // The old active-session dot is gone from every row.
    expect(idle.querySelector('span[aria-hidden="true"].rounded-full')).toBeNull();
    expect(running.querySelector('span[aria-hidden="true"].rounded-full')).toBeNull();
  });

  it('destaca o workspace ativo e marca pasta não confiável como Leitura', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace({ trusted: false })]);
    useUiStore.setState({ activeWorkspaceId: 'ws-1' });
    renderSidebar();

    const row = await screen.findByRole('button', { name: 'zylara-core' });
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).toContain('Leitura');
  });

  it('sessões sem workspace ficam no grupo "Sem workspace"', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão órfã', workspaceId: null })],
    });
    renderSidebar();

    expect(await screen.findByRole('heading', { name: 'Sem workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sessão órfã' })).toBeTruthy();
  });

  it('cria uma sessão no grupo "Sem workspace" pelo botão +', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useUiStore.setState({ activeWorkspaceId: 'ws-1', codeView: 'skills' });
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão órfã', workspaceId: null })],
    });
    renderSidebar();

    fireEvent.click(await screen.findByRole('button', { name: 'Nova sessão sem workspace' }));

    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledTimes(1));
    expect(mocks.createConversation.mock.calls[0]?.[3]).toBe('code');
    expect(mocks.setConversationWorkspace).not.toHaveBeenCalled();
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-new'));
    expect(useUiStore.getState().activeWorkspaceId).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
    expect(useUiStore.getState().openSessionsByWorkspace.__sem_workspace__).toEqual(['c-new']);
  });

  it('recolhe e expande o grupo "Sem workspace"', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão órfã', workspaceId: null })],
    });
    renderSidebar();

    expect(await screen.findByRole('heading', { name: 'Sem workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sessão órfã' })).toBeTruthy();

    const collapse = screen.getByRole('button', { name: 'Recolher sessões sem workspace' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);

    expect(screen.queryByRole('button', { name: 'Sessão órfã' })).toBeNull();
    const expand = screen.getByRole('button', { name: 'Expandir sessões sem workspace' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Sessão órfã' })).toBeTruthy();
  });

  it('esconde o grupo "Sem workspace" quando não há sessões órfãs', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão do workspace', workspaceId: 'ws-1' })],
    });
    renderSidebar();

    await screen.findByRole('button', { name: 'Sessão do workspace' });
    expect(screen.queryByRole('heading', { name: 'Sem workspace' })).toBeNull();
    expect(screen.queryByText(/Nenhuma sessão sem workspace/)).toBeNull();
  });

  it('pesquisa workspaces por nome/caminho e sessão com filtro real', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      workspace(),
      workspace({ id: 'ws-2', name: 'Site Hyska', path: 'C:/dev/hyska', git: null }),
    ]);
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar workspaces' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Pesquisar workspaces/ }), {
      target: { value: 'hyska' },
    });

    expect(screen.queryByRole('button', { name: 'zylara-core' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Site Hyska' })).toBeTruthy();
    expect(screen.getByText('1 de 2 workspaces')).toBeTruthy();
  });

  it('filtra por "Com git" e limpa os filtros depois', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      workspace(),
      workspace({ id: 'ws-2', name: 'Site Hyska', path: 'C:/dev/hyska', git: null }),
    ]);
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    openMenu(screen.getByRole('button', { name: 'Filtrar workspaces' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Com git' }));

    expect(screen.getByRole('button', { name: 'zylara-core' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Site Hyska' })).toBeNull();

    openMenu(screen.getByRole('button', { name: 'Filtrar workspaces' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Limpar filtros' }));
    expect(await screen.findByRole('button', { name: 'Site Hyska' })).toBeTruthy();
  });

  it('"Adicionar workspace" abre o seletor nativo de pasta', async () => {
    mocks.pickWorkspaceFolder.mockResolvedValue(null);
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar workspace' }));
    await waitFor(() => expect(mocks.pickWorkspaceFolder).toHaveBeenCalledTimes(1));
  });

  it('abre a conversa ao clicar na sessão e registra a aba do workspace', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Corrigir o build', workspaceId: 'ws-1' })],
    });
    useUiStore.setState({ codeView: 'skills', activeWorkspaceId: 'ws-1' });

    renderSidebar();
    await screen.findByRole('button', { name: 'Corrigir o build' });
    fireEvent.click(screen.getByRole('button', { name: 'Corrigir o build' }));

    expect(useUiStore.getState().codeView).toBe('session');
    await waitFor(() => expect(mocks.getConversation).toHaveBeenCalledWith('c-1'));
    await waitFor(() => expect(useChatStore.getState().activeId).toBe('c-1'));
    expect(useUiStore.getState().openSessionsByWorkspace['ws-1']).toEqual(['c-1']);
  });

  it('mostra erro de listagem com ação de tentar novamente', async () => {
    mocks.listWorkspaces.mockRejectedValueOnce(new Error('backend offline'));
    renderSidebar();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar os workspaces');
    expect(alert.textContent).toContain('backend offline');

    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'zylara-core' })).toBeTruthy());
  });
});

describe('CodeSidebar — limite de sessões por workspace', () => {
  it('mostra 10 sessões e carrega o restante pelo botão do grupo', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({ conversations: codeSessions(14) });
    renderSidebar();

    expect(await screen.findByRole('button', { name: 'Sessão 1' })).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /^Sessão \d+$/ })).toHaveLength(10);
    expect(screen.queryByRole('button', { name: 'Sessão 11' })).toBeNull();
    // The header badge keeps showing the whole workspace count.
    expect(screen.getByRole('button', { name: 'zylara-core' }).textContent).toContain('14');

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais 4 sessões' }));

    expect(screen.queryAllByRole('button', { name: /^Sessão \d+$/ })).toHaveLength(14);
    expect(screen.getByRole('button', { name: 'Sessão 14' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).toBeNull();
    // The control unmounts on the last page, so focus stays inside the group.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Recolher sessões de zylara-core' }),
    );
  });

  it('revela a sessão ativa mesmo quando ela está fora da primeira página', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({ conversations: codeSessions(16), activeId: 'c-13' });
    renderSidebar();

    const active = await screen.findByRole('button', { name: 'Sessão 13' });
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(screen.queryAllByRole('button', { name: /^Sessão \d+$/ })).toHaveLength(13);

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais 3 sessões' }));

    expect(screen.queryAllByRole('button', { name: /^Sessão \d+$/ })).toHaveLength(16);
  });

  it('a busca mostra todas as sessões do workspace, sem o limite de 10', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({ conversations: codeSessions(14) });
    renderSidebar();
    await screen.findByRole('button', { name: 'Sessão 1' });

    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar workspaces' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Pesquisar workspaces/ }), {
      target: { value: 'zylara' },
    });

    expect(screen.queryAllByRole('button', { name: /^Sessão \d+$/ })).toHaveLength(14);
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).toBeNull();
  });

  it('reordenar com o limite ativo persiste a ordem completa do grupo', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({ conversations: codeSessions(12) });
    renderSidebar();

    await screen.findByRole('button', { name: 'Sessão 1' });
    // The sidebar remounts once while the workspaces finish loading: re-query the live row.
    const first = screen.getByRole('button', { name: 'Sessão 1' });
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });

    await waitFor(() => expect(mocks.reorderConversations).toHaveBeenCalledTimes(1));
    const ids = mocks.reorderConversations.mock.calls[0]?.[0] as string[];
    expect(ids).toHaveLength(12);
    expect(ids.slice(0, 3)).toEqual(['c-2', 'c-1', 'c-3']);
  });
});

describe('CodeSidebar — menu do workspace', () => {
  async function renderWithWorkspace(): Promise<Workspace> {
    const ws = workspace();
    mocks.listWorkspaces.mockResolvedValue([ws]);
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });
    return ws;
  }

  it('cria uma sessão no workspace pelo menu', async () => {
    await renderWithWorkspace();

    openMenu(screen.getByRole('button', { name: 'Opções do workspace zylara-core' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Nova sessão' }));

    await waitFor(() => expect(mocks.createConversation).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mocks.setConversationWorkspace).toHaveBeenCalledWith('c-new', 'ws-1'),
    );
  });

  it('abre um terminal no workspace sem abrir uma sessão', async () => {
    await renderWithWorkspace();

    openMenu(screen.getByRole('button', { name: 'Opções do workspace zylara-core' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir terminal' }));

    await waitFor(() => expect(terminalOpen.openWorkspaceTerminal).toHaveBeenCalledWith('ws-1'));
    expect(mocks.createConversation).not.toHaveBeenCalled();
  });

  it('abre a pasta no Explorer', async () => {
    await renderWithWorkspace();

    openMenu(screen.getByRole('button', { name: 'Opções do workspace zylara-core' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir no Explorer' }));

    await waitFor(() => expect(mocks.openWorkspaceInExplorer).toHaveBeenCalledWith('ws-1'));
  });

  it('copia o caminho do workspace', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await renderWithWorkspace();

    openMenu(screen.getByRole('button', { name: 'Opções do workspace zylara-core' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copiar caminho' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:/dev/zylara'));
  });

  it('renomeia o workspace pelo diálogo', async () => {
    mocks.renameWorkspace.mockResolvedValue(workspace({ name: 'core' }));
    await renderWithWorkspace();

    openMenu(screen.getByRole('button', { name: 'Opções do workspace zylara-core' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Renomear' }));

    const dialog = await screen.findByRole('dialog', { name: 'Renomear workspace' });
    const input = within(dialog).getByRole('textbox', { name: 'Nome do workspace' });
    fireEvent.change(input, { target: { value: 'core' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(mocks.renameWorkspace).toHaveBeenCalledWith('ws-1', 'core'),
    );
  });

  it('remove do Zylara com confirmação, avisando que a pasta não é apagada', async () => {
    mocks.removeWorkspace.mockResolvedValue(undefined);
    await renderWithWorkspace();

    openMenu(screen.getByRole('button', { name: 'Opções do workspace zylara-core' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remover do Zylara' }));

    const dialog = await screen.findByRole('dialog', { name: 'Remover workspace do Zylara?' });
    expect(dialog.textContent).toContain('não será apagada');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(mocks.removeWorkspace).toHaveBeenCalledWith('ws-1'));
  });
});

describe('CodeSidebar — rodapé', () => {
  it('abre Configurações e mostra a versão do app', () => {
    renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: /Configurações/ }));

    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(screen.getByText('v0.1.0')).toBeTruthy();
  });

  it('fecha o drawer compacto depois das ações', async () => {
    window.matchMedia = matchMediaReturning(true);
    const onClose = vi.fn();
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    useChatStore.setState({
      conversations: [conversation({ id: 'c-1', title: 'Sessão compacta', workspaceId: 'ws-1' })],
    });

    renderSidebar(onClose);

    fireEvent.click(screen.getByRole('button', { name: 'Sessão compacta' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Skills' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: /Configurações/ }));
    expect(onClose).toHaveBeenCalledTimes(3);

    // O drawer só existe quando o AppShell passa onClose.
    expect(screen.getByRole('button', { name: 'Fechar barra lateral' })).toBeTruthy();
  });
});

describe('CodeSidebar — ações da sessão', () => {
  function seedSession(overrides: Partial<Conversation> = {}): Conversation {
    const item = conversation({ id: 'c-1', title: 'Sessão antiga', workspaceId: 'ws-1', ...overrides });
    useChatStore.setState({ conversations: [item], activeId: 'c-1' });
    mocks.listWorkspaces.mockResolvedValue([workspace()]);
    return item;
  }

  it('fixa a sessão pelo menu de ações', async () => {
    seedSession();
    mocks.setConversationPinned.mockResolvedValue(conversation({ id: 'c-1', pinned: true }));
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    openMenu(await screen.findByRole('button', { name: 'Opções de Sessão antiga' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Fixar' }));

    await waitFor(() => expect(mocks.setConversationPinned).toHaveBeenCalledWith('c-1', true));
  });

  it('renomeia a sessão pelo menu de ações', async () => {
    seedSession();
    mocks.renameConversation.mockResolvedValue(conversation({ id: 'c-1', title: 'Sessão nova' }));
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    openMenu(await screen.findByRole('button', { name: 'Opções de Sessão antiga' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Renomear' }));

    const input = await screen.findByRole('textbox', { name: 'Renomear sessão' });
    fireEvent.change(input, { target: { value: 'Sessão nova' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(mocks.renameConversation).toHaveBeenCalledWith('c-1', 'Sessão nova'));
  });

  it('exporta a conversa pelo menu de ações', async () => {
    seedSession();
    mocks.exportConversation.mockResolvedValue('C:/exports/sessao.md');
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    openMenu(await screen.findByRole('button', { name: 'Opções de Sessão antiga' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Exportar' }));

    await waitFor(() =>
      expect(mocks.exportConversation).toHaveBeenCalledWith('c-1', 'markdown'),
    );
  });

  it('remove uma sessão compartilhada do Code pelo menu', async () => {
    seedSession({ codeLinked: true });
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    openMenu(await screen.findByRole('button', { name: 'Opções de Sessão antiga' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remover do Code' }));

    await waitFor(() =>
      expect(mocks.setConversationCodeLinked).toHaveBeenCalledWith('c-1', false),
    );
  });

  it('exclui a conversa com confirmação', async () => {
    seedSession();
    mocks.deleteConversation.mockResolvedValue(undefined);
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    openMenu(await screen.findByRole('button', { name: 'Opções de Sessão antiga' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Excluir' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Excluir conversa')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(mocks.deleteConversation).toHaveBeenCalledWith('c-1'));
  });
});

describe('CodeSidebar — reordenação por teclado', () => {
  it('move o workspace e persiste a ordem', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      workspace({ id: 'ws-1', name: 'zylara-core', path: 'C:/dev/zylara', lastOpenedAt: 20 }),
      workspace({
        id: 'ws-2',
        name: 'site',
        path: 'C:/dev/site',
        lastOpenedAt: 10,
        git: null,
      }),
    ]);
    mocks.reorderWorkspaces.mockResolvedValue(undefined);
    renderSidebar();

    const button = await screen.findByRole('button', { name: 'zylara-core' });
    fireEvent.keyDown(button, { key: 'ArrowDown', altKey: true });

    await waitFor(() =>
      expect(mocks.reorderWorkspaces).toHaveBeenCalledWith(['ws-2', 'ws-1']),
    );
  });

  it('não reordena enquanto a busca de workspaces está ativa', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      workspace({ id: 'ws-1', name: 'zylara-core', path: 'C:/dev/zylara', lastOpenedAt: 20 }),
      workspace({ id: 'ws-2', name: 'site', path: 'C:/dev/site', lastOpenedAt: 10, git: null }),
    ]);
    renderSidebar();
    await screen.findByRole('button', { name: 'zylara-core' });

    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar workspaces' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Pesquisar workspaces/ }), {
      target: { value: 'C:/dev' },
    });

    fireEvent.keyDown(screen.getByRole('button', { name: 'zylara-core' }), {
      key: 'ArrowDown',
      altKey: true,
    });

    expect(mocks.reorderWorkspaces).not.toHaveBeenCalled();
  });
});
