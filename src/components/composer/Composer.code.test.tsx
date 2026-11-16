// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Conversation, ProviderInfo } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  searchWorkspaceFiles: vi.fn(),
  compactSession: vi.fn(),
  setPlanMode: vi.fn(),
  setCreatorMode: vi.fn(),
  setPermissionMode: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  listArtifacts: vi.fn(),
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('@/components/chat/external', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock('@/components/models/ModelPill', () => ({
  ModelPill: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      Modelo
    </button>
  ),
}));

// Imported after the mocks above.
import { toast } from 'sonner';
import { emptyCodeSession, useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import { Composer } from './Composer';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    title: 'Corrigir o build',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    providerId: 'deepseek',
    modelId: 'deepseek-v4.1-flash',
    messageCount: 0,
    preview: null,
    mode: 'code',
    workspaceId: 'ws-1',
    permissionMode: 'edit',
    ...overrides,
  };
}

const FILES = ['src/app.ts', 'src/lib/api.ts', 'src/main.tsx'];

function providerFixture(): ProviderInfo {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'DeepSeek',
    description: '',
    baseUrl: 'https://api.deepseek.com',
    consoleUrl: '',
    endpoints: { 'openai-chat': '/chat/completions', models: '/models' },
    authEnv: 'DEEPSEEK_API_KEY',
    defaultModelId: 'deepseek-v4.1-flash',
    auth: 'api-key',
    requestProfiles: { apiKey: 'standard' },
    models: [],
    notes: [],
  };
}

const textarea = (): HTMLTextAreaElement =>
  screen.getByRole('textbox', { name: 'Tarefa para o agente' }) as HTMLTextAreaElement;

function typeInComposer(value: string): void {
  fireEvent.change(textarea(), { target: { value } });
}

function openMentionMenu(): void {
  typeInComposer('@');
}

const codePanelTab = () => useUiStore.getState().codePanelTab;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchWorkspaceFiles.mockResolvedValue(FILES);
  mocks.compactSession.mockRejectedValue(new Error('Compactação ainda não disponível'));
  mocks.setPlanMode.mockResolvedValue({
    conversationId: 'c-1',
    permissionMode: 'edit',
    planMode: false,
    todos: [],
    jobs: [],
    approvals: [],
  });
  mocks.setCreatorMode.mockResolvedValue({
    conversationId: 'c-1',
    permissionMode: 'edit',
    planMode: false,
    creatorMode: false,
    todos: [],
    jobs: [],
    approvals: [],
  });
  mocks.setPermissionMode.mockResolvedValue({
    conversationId: 'c-1',
    permissionMode: 'edit',
    planMode: false,
    todos: [],
    jobs: [],
    approvals: [],
  });
  mocks.createConversation.mockResolvedValue(conversation({ id: 'c-new' }));
  useAppStore.setState({
    providers: [providerFixture()],
    auth: [],
    keys: [{ providerId: 'deepseek', hasKey: true, source: 'settings', mode: 'api-key' }],
    selection: {
      providerId: 'deepseek',
      modelId: 'deepseek-v4.1-flash',
      reasoning: null,
    },
  });
  useChatStore.setState({
    conversations: [conversation()],
    activeId: 'c-1',
    streaming: null,
    pendingAttachments: [],
    error: null,
    errorCode: null,
    errorHint: null,
  });
  useCodeStore.setState({ byConversation: {} });
  useUiStore.setState({
    layoutMode: 'code',
    activeWorkspaceId: 'ws-1',
    codePanelTab: 'files',
    codePanelOpen: false,
    settingsOpen: false,
    codeView: 'session',
    codeGoalOpen: false,
    goalDialog: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Composer — placeholder e atalho no modo Code', () => {
  it('com workspace usa a copy que ensina @ e /', () => {
    render(<Composer />);

    expect(textarea().getAttribute('placeholder')).toBe(
      'Descreva a tarefa… @ para arquivos, / para comandos',
    );
  });

  it('sem workspace mantém a copy anterior', () => {
    useUiStore.setState({ activeWorkspaceId: null });
    useChatStore.setState({ conversations: [conversation({ workspaceId: null })], activeId: 'c-1' });
    render(<Composer />);

    expect(textarea().getAttribute('placeholder')).toBe('Descreva a tarefa para o agente…');
  });

  it('Ctrl/Cmd+L foca o composer no modo Code', () => {
    render(<Composer />);

    fireEvent.keyDown(window, { key: 'l', ctrlKey: true });

    expect(document.activeElement).toBe(textarea());
  });
});

describe('Composer — controles de sessão no layout Code', () => {
  it('troca os pills de ferramentas pelos controles de permissão, Plano, Objetivo e Plano/tarefas', () => {
    render(<Composer />);

    expect(screen.getByRole('button', { name: 'Modo de permissão: Editar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Modo Plano/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Criar objetivo com /goal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plano, tarefas e trabalhos em segundo plano' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Busca web' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Criar arquivos' })).toBeNull();
  });

  it('reflete o snapshot da sessão carregado no codeStore', () => {
    useCodeStore.setState({
      byConversation: {
        'c-1': { ...emptyCodeSession('c-1'), permissionMode: 'read_only', planMode: true },
      },
    });
    render(<Composer />);

    expect(screen.getByRole('button', { name: 'Modo de permissão: Leitura' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Modo Plano: ativado' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('Composer — badge do modo Plano no campo', () => {
  function seedPlanMode(planMode: boolean): void {
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), planMode } },
    });
  }

  it('não mostra o badge quando o modo Plano está desativado', () => {
    render(<Composer />);

    expect(screen.queryByRole('button', { name: 'Desativar modo Plano' })).toBeNull();
  });

  it('mostra o badge com o rótulo "Plano" quando o snapshot da sessão tem planMode', () => {
    seedPlanMode(true);
    render(<Composer />);

    const chip = screen.getByRole('button', { name: 'Desativar modo Plano' });
    expect(chip.textContent?.trim()).toBe('Plano');
  });

  it('clique no badge desativa o Plano pelo store', async () => {
    seedPlanMode(true);
    render(<Composer />);

    fireEvent.click(screen.getByRole('button', { name: 'Desativar modo Plano' }));

    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith('c-1', false));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Desativar modo Plano' })).toBeNull(),
    );
  });

  it('divide a linha de chips acima do textarea com o chip /goal', async () => {
    seedPlanMode(true);
    render(<Composer />);

    typeInComposer('/goal');
    await screen.findByRole('option', { name: /\/goal/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    const goalChip = screen.getByText('/goal');
    const planChip = screen.getByRole('button', { name: 'Desativar modo Plano' });
    const row = planChip.parentElement;
    expect(row?.contains(goalChip)).toBe(true);
    expect(goalChip.closest('.mb-2')).toBe(row);
  });

  it('não mostra o badge fora do layout Code (sem sessão de código)', () => {
    seedPlanMode(true);
    useUiStore.setState({ layoutMode: 'chat' });
    render(<Composer />);

    expect(screen.queryByRole('button', { name: 'Desativar modo Plano' })).toBeNull();
  });
});

describe('Composer — menção @arquivo', () => {
  it('abre o listbox ao digitar @ e busca os arquivos do workspace', async () => {
    render(<Composer />);

    openMentionMenu();

    expect(await screen.findByRole('listbox', { name: 'Arquivos do workspace' })).toBeTruthy();
    await waitFor(() =>
      expect(mocks.searchWorkspaceFiles).toHaveBeenCalledWith('ws-1', '', 20),
    );
    expect(await screen.findByRole('option', { name: 'src/app.ts' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'src/main.tsx' })).toBeTruthy();
  });

  it('filtra com o termo digitado depois do @ (debounce)', async () => {
    render(<Composer />);

    typeInComposer('@api');

    await waitFor(() =>
      expect(mocks.searchWorkspaceFiles).toHaveBeenCalledWith('ws-1', 'api', 20),
    );
  });

  it('navega com setas e insere chip com Enter, enviando [arquivo: path]', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    openMentionMenu();
    await screen.findByRole('option', { name: 'src/app.ts' });

    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    expect(
      await screen.findByRole('button', { name: 'Remover menção a src/lib/api.ts' }),
    ).toBeTruthy();
    expect(textarea().value).toBe('');

    typeInComposer('Corrigir o build');
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toBe('Corrigir o build\n\n[arquivo: src/lib/api.ts]');
    expect(screen.queryByRole('button', { name: /Remover menção/ })).toBeNull();
  });

  it('Tab também seleciona a opção ativa', async () => {
    render(<Composer />);

    openMentionMenu();
    await screen.findByRole('option', { name: 'src/app.ts' });
    fireEvent.keyDown(textarea(), { key: 'Tab' });

    expect(
      await screen.findByRole('button', { name: 'Remover menção a src/app.ts' }),
    ).toBeTruthy();
  });

  it('Esc fecha o menu sem inserir chip', async () => {
    render(<Composer />);

    openMentionMenu();
    await screen.findByRole('listbox', { name: 'Arquivos do workspace' });
    fireEvent.keyDown(textarea(), { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Arquivos do workspace' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: /Remover menção/ })).toBeNull();
  });

  it('Backspace com o textarea vazio remove o último chip; o X também remove', async () => {
    render(<Composer />);

    openMentionMenu();
    await screen.findByRole('option', { name: 'src/app.ts' });
    fireEvent.keyDown(textarea(), { key: 'Tab' });
    await screen.findByRole('button', { name: 'Remover menção a src/app.ts' });

    fireEvent.keyDown(textarea(), { key: 'Backspace' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Remover menção/ })).toBeNull(),
    );

    openMentionMenu();
    await screen.findByRole('option', { name: 'src/main.tsx' });
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    fireEvent.keyDown(textarea(), { key: 'Tab' });
    fireEvent.click(await screen.findByRole('button', { name: 'Remover menção a src/lib/api.ts' }));

    expect(screen.queryByRole('button', { name: /Remover menção/ })).toBeNull();
  });

  it('não abre menção no Chat nem no Code sem workspace', async () => {
    useUiStore.setState({ layoutMode: 'chat' });
    const { unmount } = render(<Composer />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem para o Zylara' }), {
      target: { value: '@' },
    });
    await waitFor(() => expect(mocks.searchWorkspaceFiles).not.toHaveBeenCalled());
    expect(screen.queryByRole('listbox')).toBeNull();
    unmount();

    useUiStore.setState({ layoutMode: 'code', activeWorkspaceId: null });
    useChatStore.setState({ conversations: [conversation({ workspaceId: null })], activeId: 'c-1' });
    render(<Composer />);
    typeInComposer('@');
    await waitFor(() => expect(mocks.searchWorkspaceFiles).not.toHaveBeenCalled());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Composer — comandos /', () => {
  it('abre o catálogo ao digitar / e filtra pelo texto', async () => {
    render(<Composer />);

    typeInComposer('/');

    expect(await screen.findByRole('listbox', { name: 'Comandos do modo Code' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /\/compact/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /\/commit/ })).toBeTruthy();

    typeInComposer('/compa');

    await waitFor(() => expect(screen.getByRole('option', { name: /\/compact/ })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /\/commit/ })).toBeNull();
  });

  it('/compact chama a API e mostra erro honesto quando ainda não disponível', async () => {
    render(<Composer />);

    typeInComposer('/compact');
    await screen.findByRole('option', { name: /\/compact/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(mocks.compactSession).toHaveBeenCalledWith('c-1'));
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Compactação ainda não disponível',
        expect.objectContaining({ description: expect.stringContaining('Compactação') }),
      ),
    );
  });

  it('/commit abre o painel Alterações', async () => {
    render(<Composer />);

    typeInComposer('/commit');
    await screen.findByRole('option', { name: /\/commit/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(codePanelTab()).toBe('changes'));
    expect(useUiStore.getState().codePanelOpen).toBe(true);
  });

  it('/limpar limpa o texto e as menções', async () => {
    render(<Composer />);

    openMentionMenu();
    await screen.findByRole('option', { name: 'src/app.ts' });
    fireEvent.keyDown(textarea(), { key: 'Tab' });
    await screen.findByRole('button', { name: /Remover menção a src\/app.ts/ });
    typeInComposer('/limpar');

    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(textarea().value).toBe(''));
    expect(screen.queryByRole('button', { name: /Remover menção/ })).toBeNull();
  });

  it('comandos de preenchimento (/review) colocam o prompt no composer sem enviar', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    typeInComposer('/review');
    await screen.findByRole('option', { name: /\/review/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(textarea().value).toContain('Revise as alterações atuais'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('/plan ativa o modo Plano no codeStore e mantém o texto de instrução', async () => {
    mocks.setPlanMode.mockResolvedValue({
      conversationId: 'c-1',
      permissionMode: 'edit',
      planMode: true,
      todos: [],
      jobs: [],
      approvals: [],
    });
    render(<Composer />);

    typeInComposer('/plan');
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith('c-1', true));
    expect(textarea().value).toContain('Planeje a solução para esta tarefa');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Modo Plano: ativado' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  it('/plan não chama o backend quando o modo já está ativo', async () => {
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), planMode: true } },
    });
    render(<Composer />);

    typeInComposer('/plan');
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Modo Plano já está ativo'));
    expect(mocks.setPlanMode).not.toHaveBeenCalled();
  });

  it('/plan off desativa o modo Plano pelo store (chip sincroniza)', async () => {
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), planMode: true } },
    });
    render(<Composer />);

    // O catálogo completo abre com `/`; escolhe a opção pelo clique (o espaço
    // fecha o filtro, então o comando é selecionado na lista inicial).
    typeInComposer('/');
    await screen.findByRole('option', { name: /\/plan off/ });
    fireEvent.click(screen.getByRole('option', { name: /\/plan off/ }));

    await waitFor(() => expect(mocks.setPlanMode).toHaveBeenCalledWith('c-1', false));
    await waitFor(() => expect(useCodeStore.getState().byConversation['c-1']?.planMode).toBe(false));
    expect(
      screen.getByRole('button', { name: 'Modo Plano: desativado' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('não abre slash no Chat', async () => {
    useUiStore.setState({ layoutMode: 'chat' });
    render(<Composer />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem para o Zylara' }), {
      target: { value: '/' },
    });

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('/creator ativa o modo Plugin Creator no codeStore', async () => {
    mocks.setCreatorMode.mockResolvedValue({
      conversationId: 'c-1',
      permissionMode: 'edit',
      planMode: false,
      creatorMode: true,
      todos: [],
      jobs: [],
      approvals: [],
    });
    render(<Composer />);

    typeInComposer('/creator');
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    await waitFor(() => expect(mocks.setCreatorMode).toHaveBeenCalledWith('c-1', true));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Desativar modo Criador de plugins' })).toBeTruthy(),
    );
  });

  it('/creator off desativa o modo pelo store e remove o chip', async () => {
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), creatorMode: true } },
    });
    render(<Composer />);

    typeInComposer('/');
    await screen.findByRole('option', { name: /\/creator off/ });
    fireEvent.click(screen.getByRole('option', { name: /\/creator off/ }));

    await waitFor(() => expect(mocks.setCreatorMode).toHaveBeenCalledWith('c-1', false));
    await waitFor(() =>
      expect(useCodeStore.getState().byConversation['c-1']?.creatorMode).toBe(false),
    );
  });

  it('chip do Plugin Creator desativa o modo pelo codeStore', async () => {
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), creatorMode: true } },
    });
    mocks.setCreatorMode.mockResolvedValue({
      conversationId: 'c-1',
      permissionMode: 'edit',
      planMode: false,
      creatorMode: false,
      todos: [],
      jobs: [],
      approvals: [],
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole('button', { name: 'Desativar modo Criador de plugins' }));
    await waitFor(() => expect(mocks.setCreatorMode).toHaveBeenCalledWith('c-1', false));
  });
});

describe('Composer — comando /goal', () => {
  it('aparece no catálogo com o grupo Objetivo', async () => {
    render(<Composer />);

    typeInComposer('/goal');

    expect(await screen.findByRole('option', { name: /\/goal/ })).toBeTruthy();
    const listbox = screen.getByRole('listbox', { name: 'Comandos do modo Code' });
    expect(within(listbox).getByText('Objetivo')).toBeTruthy();
  });

  it('ativa o chip /goal sem alterar nem preencher a mensagem do usuário', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    typeInComposer('/goal');
    await screen.findByRole('option', { name: /\/goal/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    // O comando vira badge no campo; não injeta prompt automático no texto.
    expect(screen.getByText('/goal')).toBeTruthy();
    // Badge (campo) + botão da barra refletem a intenção ativa.
    const goalButtons = screen.getAllByRole('button', { name: 'Desativar objetivo' });
    expect(goalButtons).toHaveLength(2);
    expect(goalButtons.every((button) => button.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(textarea().value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(useUiStore.getState().goalDialog).toBeNull();
    expect(useUiStore.getState().codeGoalOpen).toBe(false);
    expect(useUiStore.getState().codeView).toBe('session');
  });

  it('envia a mensagem intacta com goalRequest=true e limpa o badge', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    typeInComposer('/goal');
    await screen.findByRole('option', { name: /\/goal/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    fireEvent.change(textarea(), {
      target: { value: 'Refatore o parser e deixe o build verde.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('Refatore o parser e deixe o build verde.', {
        goalRequest: true,
      }),
    );
    expect(screen.queryByRole('button', { name: 'Desativar objetivo' })).toBeNull();
    expect(screen.queryByText('/goal')).toBeNull();
    // A barra volta ao estado inativo.
    expect(
      screen.getByRole('button', { name: 'Criar objetivo com /goal' }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(textarea().value).toBe('');
  });

  it('remover o badge volta ao turno normal', async () => {
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    typeInComposer('/goal');
    await screen.findByRole('option', { name: /\/goal/ });
    fireEvent.keyDown(textarea(), { key: 'Enter' });

    // O badge é um único botão: clicar em qualquer parte remove a intenção.
    fireEvent.click(screen.getByText('/goal'));

    expect(screen.queryByText('/goal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desativar objetivo' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Criar objetivo com /goal' }).getAttribute('aria-pressed'),
    ).toBe('false');

    fireEvent.change(textarea(), { target: { value: 'Oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' }));

    await waitFor(() => expect(send).toHaveBeenCalledWith('Oi', undefined));
  });

  it('o botão da barra liga e desliga o badge /goal (paridade com o modo Plano)', () => {
    render(<Composer />);

    expect(screen.queryByText('/goal')).toBeNull();
    const inactive = screen.getByRole('button', { name: 'Criar objetivo com /goal' });
    expect(inactive.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(inactive);

    // Badge no campo + botão da barra ativo (dois botões com o mesmo rótulo).
    const active = screen.getAllByRole('button', { name: 'Desativar objetivo' });
    expect(active).toHaveLength(2);
    expect(active.every((button) => button.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(screen.getByText('/goal')).toBeTruthy();

    // Desliga pelo botão da barra (o único sem texto; o badge tem "/goal").
    const barButton = active.find((button) => (button.textContent ?? '').trim() === '');
    expect(barButton).toBeTruthy();
    fireEvent.click(barButton as HTMLElement);

    expect(screen.queryByText('/goal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desativar objetivo' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Criar objetivo com /goal' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
