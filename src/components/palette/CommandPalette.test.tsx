// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import type { ChatMessage, Conversation, Settings } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  searchConversations: vi.fn(),
  exportConversation: vi.fn(),
  openDataDir: vi.fn(),
  openSkillsDir: vi.fn(),
  listConversations: vi.fn(),
  listArtifacts: vi.fn(),
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  setConversationPinned: vi.fn(),
  saveSettings: vi.fn(),
  refreshCatalog: vi.fn(),
  getCacheStats: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';
import { CommandPalette } from './CommandPalette';
import {
  MODEL_LOCKED_TITLE,
  MODEL_STREAMING_LOCKED_DESCRIPTION,
  MODEL_STREAMING_LOCKED_TITLE,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import { PALETTE_RECENTS_KEY } from '@/lib/palette/recents';
import { i18n } from '@/lib/i18n';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'light',
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

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Planejamento do projeto',
    createdAt: 1,
    updatedAt: 10,
    pinned: false,
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
    messageCount: 0,
    preview: 'Quero revisar as metas do trimestre',
    ...overrides,
  };
}

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Olá',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    modelId: 'deepseek-v4.1-flash',
    providerId: 'opencode-go',
    createdAt: 1,
    ...overrides,
  };
}

function renderPalette() {
  render(<CommandPalette />);
}

function paletteInput(): HTMLInputElement {
  return screen.getByRole('combobox', { name: 'Buscar conversas ou comandos' }) as HTMLInputElement;
}

function typeQuery(value: string) {
  fireEvent.change(paletteInput(), { target: { value } });
}

function allOptions(): HTMLElement[] {
  return screen.queryAllByRole('option');
}

function streamingState() {
  return {
    turnId: 'turn-1',
    conversationId: 'conv-1',
    assistantId: 'assistant-1',
    userMessageId: null,
    phase: 'text' as const,
    step: 1,
    startedAt: Date.now(),
    turnKind: 'user' as const,
  };
}

function baseState() {
  useAppStore.setState({
    settings: settings(),
    selection: { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash', reasoning: null },
    ready: true,
  });
  useChatStore.setState({
    conversations: [
      conversation({ id: 'conv-1', title: 'Planejamento do projeto', updatedAt: 10 }),
      conversation({
        id: 'conv-2',
        title: 'Reunião de segunda',
        updatedAt: 50,
        preview: 'Metas da reunião semanal',
      }),
    ],
    activeId: 'conv-1',
    messagesByConversation: { 'conv-1': [] },
    conversationsLoading: false,
    streaming: null,
    pendingAttachments: [],
    loadingConversationId: null,
  });
  useUiStore.setState({
    commandPaletteOpen: true,
    settingsOpen: false,
    settingsTab: 'general',
    modelPickerOpen: false,
    artifactPanelOpen: false,
    sourcesPanelOpen: false,
    activeView: 'chat',
    layoutMode: 'chat',
    enabledLayouts: { chat: true, code: true, agent: true },
    codeView: 'session',
    codePanelOpen: true,
    codePanelTab: 'changes',
    artifacts: [],
    theme: 'light',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem(PALETTE_RECENTS_KEY);
  mocks.searchConversations.mockResolvedValue([]);
  mocks.listConversations.mockResolvedValue([]);
  mocks.listArtifacts.mockResolvedValue([]);
  mocks.createConversation.mockResolvedValue(conversation({ id: 'new-conv' }));
  mocks.getConversation.mockResolvedValue(null);
  mocks.setConversationPinned.mockResolvedValue(undefined);
  mocks.exportConversation.mockResolvedValue('/tmp/conversa.md');
  mocks.openDataDir.mockResolvedValue(undefined);
  mocks.openSkillsDir.mockResolvedValue(undefined);
  mocks.saveSettings.mockResolvedValue({ settings: settings(), keys: [] });
  mocks.refreshCatalog.mockResolvedValue(undefined);
  mocks.getCacheStats.mockResolvedValue({
    conversationId: 'conv-1',
    current: null,
    session: null,
    epoch: 0,
    recent: [],
  });
  baseState();
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PALETTE_RECENTS_KEY);
});

describe('CommandPalette — estrutura e busca de comandos', () => {
  it('renders recent conversations, suggestions and command groups on an empty query', () => {
    renderPalette();

    expect(screen.getByRole('listbox', { name: 'Comandos e conversas' })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Conversas recentes' })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Sugestões' })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Conversas' })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Configurações' })).not.toBeNull();

    // The most recent conversation is the first result and gets the selection.
    const options = allOptions();
    expect(options[0].textContent).toContain('Planejamento do projeto');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
  });

  it('filters commands ignoring accents and highlights the match', () => {
    renderPalette();
    typeQuery('configuracoes');

    const option = screen.getByRole('option', { name: /Abrir configurações/ });
    expect(option).not.toBeNull();
    const mark = option.querySelector('mark');
    expect(mark?.textContent?.toLowerCase()).toBe('configurações');
    // The initial list (conversations/other groups) was replaced by matches.
    expect(screen.queryByRole('option', { name: /Alternar barra lateral/ })).toBeNull();
  });

  it('does not offer the removed dead "Buscar conversas" command', async () => {
    renderPalette();
    typeQuery('buscar conversas');

    expect(await screen.findByText(/Nenhum resultado para/)).not.toBeNull();
    expect(screen.queryByRole('option', { name: /Buscar conversas/ })).toBeNull();
  });

  it('shows an empty state when nothing matches', async () => {
    renderPalette();
    typeQuery('zzzzzz');

    expect(await screen.findByText(/Nenhum resultado para “zzzzzz”/)).not.toBeNull();
  });
});

describe('CommandPalette — teclado', () => {
  it('navigates with arrows, wraps around, Home/End and PageDown', () => {
    renderPalette();
    const input = paletteInput();
    const options = allOptions();

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[options.length - 1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'End' });
    expect(options[options.length - 1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Home' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'PageDown' });
    expect(options[10].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'PageUp' });
    expect(options[0].getAttribute('aria-selected')).toBe('true');
  });

  it('supports Ctrl+N / Ctrl+P aliases', () => {
    renderPalette();
    const input = paletteInput();

    fireEvent.keyDown(input, { key: 'n', ctrlKey: true });
    expect(allOptions()[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'p', ctrlKey: true });
    expect(allOptions()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('executes the active command on Enter and records it as recent', async () => {
    renderPalette();
    typeQuery('alternar tema');
    fireEvent.keyDown(paletteInput(), { key: 'Enter' });

    await waitFor(() => expect(useUiStore.getState().theme).toBe('dark'));
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
    expect(window.localStorage.getItem(PALETTE_RECENTS_KEY)).toContain('alternar-tema');
    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('clears the query on the first Escape and closes on the second', () => {
    renderPalette();
    typeQuery('tema');
    const input = paletteInput();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(paletteInput().value).toBe('');
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);

    fireEvent.keyDown(paletteInput(), { key: 'Escape' });
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('ignores Enter while the input is composing (IME)', async () => {
    renderPalette();
    typeQuery('alternar tema');

    fireEvent.keyDown(paletteInput(), { key: 'Enter', isComposing: true });
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    expect(useUiStore.getState().theme).toBe('light');

    fireEvent.keyDown(paletteInput(), { key: 'Enter' });
    await waitFor(() => expect(useUiStore.getState().theme).toBe('dark'));
  });

  it('keeps the input and the active row in sync through aria-activedescendant', () => {
    renderPalette();
    const input = paletteInput();
    const firstId = allOptions()[0].id;

    expect(input.getAttribute('aria-activedescendant')).toBe(firstId);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(allOptions()[1].id);
    expect(document.getElementById(input.getAttribute('aria-activedescendant') ?? '')).not.toBeNull();
  });
});

describe('CommandPalette — escopos e busca de conversas', () => {
  it('queries the backend for conversation matches and merges local accent folding', async () => {
    renderPalette();
    typeQuery('#reuniao');

    await waitFor(() => expect(mocks.searchConversations).toHaveBeenCalledWith('reuniao'));
    const option = await screen.findByRole('option', { name: /Reunião de segunda/ });
    expect(option).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Conversas encontradas' })).not.toBeNull();
    // Scope "#" only shows conversations.
    expect(screen.queryByRole('group', { name: 'Sugestões' })).toBeNull();
  });

  it('does not query the backend for one-character or empty queries', async () => {
    renderPalette();
    typeQuery('r');
    expect(mocks.searchConversations).not.toHaveBeenCalled();

    typeQuery('');
    expect(mocks.searchConversations).not.toHaveBeenCalled();
  });

  it('shows a loading state while searching conversations', async () => {
    let resolveSearch: (values: Conversation[]) => void = () => undefined;
    mocks.searchConversations.mockImplementation(
      () => new Promise<Conversation[]>((resolve) => {
        resolveSearch = resolve;
      }),
    );

    renderPalette();
    typeQuery('projeto');

    await waitFor(() =>
      expect(screen.getAllByRole('status', { name: 'Buscando conversas' }).length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(mocks.searchConversations).toHaveBeenCalled());

    resolveSearch([conversation({ id: 'conv-3', title: 'Projeto novo' })]);
    await waitFor(() =>
      expect(screen.queryAllByRole('status', { name: 'Buscando conversas' })).toHaveLength(0),
    );
    expect(await screen.findByRole('option', { name: /Projeto novo/ })).not.toBeNull();
    // Async results move the selection to the first conversation.
    expect(
      screen.getAllByRole('option')[0].getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('falls back to the local title/preview index when the backend fails', async () => {
    mocks.searchConversations.mockRejectedValue(new Error('ipc offline'));

    renderPalette();
    typeQuery('reuniao');

    expect(await screen.findByText(/Busca no histórico indisponível/)).not.toBeNull();
    expect(await screen.findByRole('option', { name: /Reunião de segunda/ })).not.toBeNull();
  });

  it('scope ">" searches commands only and never calls the backend', async () => {
    renderPalette();
    typeQuery('>configuracoes');

    expect(paletteInput().placeholder).toBe('Buscar comandos…');
    expect(await screen.findByRole('option', { name: /Abrir configurações/ })).not.toBeNull();
    expect(mocks.searchConversations).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Conversas encontradas' })).toBeNull();
  });

  it('ignores stale conversation responses (race guard)', async () => {
    const resolvers: Array<(values: Conversation[]) => void> = [];
    mocks.searchConversations.mockImplementation(
      () => new Promise<Conversation[]>((resolve) => {
        resolvers.push(resolve);
      }),
    );

    renderPalette();
    typeQuery('reuni');
    await waitFor(() => expect(resolvers).toHaveLength(1));

    typeQuery('projeto');
    await waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1]([conversation({ id: 'conv-7', title: 'Projeto novo' })]);
    expect(await screen.findByRole('option', { name: /Projeto novo/ })).not.toBeNull();

    resolvers[0]([conversation({ id: 'conv-9', title: 'Reunião antiga' })]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole('option', { name: /Reunião antiga/ })).toBeNull();
  });

  it('drops in-flight results after unmount without crashing', async () => {
    let resolveSearch: (values: Conversation[]) => void = () => undefined;
    mocks.searchConversations.mockImplementation(
      () => new Promise<Conversation[]>((resolve) => {
        resolveSearch = resolve;
      }),
    );

    const view = render(<CommandPalette />);
    typeQuery('projeto');
    await waitFor(() => expect(mocks.searchConversations).toHaveBeenCalled());
    view.unmount();

    resolveSearch([conversation({ id: 'conv-late', title: 'Resposta atrasada' })]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('option', { name: /Resposta atrasada/ })).toBeNull();
  });

  it('opens a conversation with Enter and closes the palette', async () => {
    mocks.searchConversations.mockResolvedValue([
      conversation({ id: 'conv-2', title: 'Reunião de segunda' }),
    ]);
    mocks.getConversation.mockResolvedValue({
      conversation: conversation({ id: 'conv-2', title: 'Reunião de segunda' }),
      messages: [],
    });

    renderPalette();
    typeQuery('reuni');
    const option = await screen.findByRole('option', { name: /Reunião de segunda/ });
    fireEvent.pointerMove(option);
    fireEvent.keyDown(paletteInput(), { key: 'Enter' });

    await waitFor(() => expect(useChatStore.getState().activeId).toBe('conv-2'));
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('pins/unpins the highlighted conversation with Ctrl+Enter and stays open', async () => {
    mocks.searchConversations.mockResolvedValue([
      conversation({ id: 'conv-2', title: 'Reunião de segunda' }),
    ]);

    renderPalette();
    typeQuery('reuni');
    await screen.findByRole('option', { name: /Reunião de segunda/ });
    fireEvent.pointerMove(screen.getByRole('option', { name: /Reunião de segunda/ }));
    fireEvent.keyDown(paletteInput(), { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(mocks.setConversationPinned).toHaveBeenCalledWith('conv-2', true));
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Conversa fixada',
      expect.objectContaining({ description: 'Reunião de segunda' }),
    );
  });
});

describe('CommandPalette — comandos contextuais e deep-links', () => {
  it('only offers "Parar resposta" while streaming', async () => {
    renderPalette();
    typeQuery('parar resposta');
    expect(screen.queryByRole('option', { name: /Parar resposta/ })).toBeNull();

    act(() => {
      useChatStore.setState({ streaming: streamingState() });
    });
    expect(await screen.findByRole('option', { name: /Parar resposta/ })).not.toBeNull();
  });

  it('only offers "Limpar anexos" when attachments are pending', async () => {
    renderPalette();
    typeQuery('limpar anexos');
    expect(screen.queryByRole('option', { name: /Limpar anexos/ })).toBeNull();

    act(() => {
      useChatStore.setState({
        pendingAttachments: [
          {
            id: 'att-1',
            name: 'relatorio.pdf',
            mimeType: 'application/pdf',
            size: 1024,
            kind: 'pdf',
          },
        ],
      });
    });
    expect(await screen.findByRole('option', { name: /Limpar anexos/ })).not.toBeNull();
  });

  it('explains the locked model instead of offering the picker', async () => {
    useChatStore.setState({ messagesByConversation: { 'conv-1': [userMessage()] } });

    renderPalette();
    typeQuery('trocar modelo');

    const option = await screen.findByRole('option', {
      name: new RegExp(i18n.t(MODEL_LOCKED_TITLE)),
    });
    fireEvent.click(option);
    await waitFor(() => expect(vi.mocked(toast.info)).toHaveBeenCalled());
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('opens the model picker for a started Code session', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', mode: 'code', messageCount: 1 })],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [userMessage()] },
    });

    renderPalette();
    typeQuery('trocar modelo');

    const option = await screen.findByRole('option', { name: /Trocar modelo/ });
    fireEvent.click(option);

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(true));
    expect(vi.mocked(toast.info)).not.toHaveBeenCalledWith(
      i18n.t(MODEL_LOCKED_TITLE),
      expect.anything(),
    );
  });

  it('explains the streaming lock with the specific copy', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', mode: 'code', messageCount: 1 })],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [userMessage()] },
      streaming: streamingState(),
    });

    renderPalette();
    typeQuery('trocar modelo');

    const option = await screen.findByRole('option', {
      name: new RegExp(i18n.t(MODEL_STREAMING_LOCKED_TITLE)),
    });
    fireEvent.click(option);

    await waitFor(() =>
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(
        i18n.t(MODEL_STREAMING_LOCKED_TITLE),
        {
          description: i18n.t(MODEL_STREAMING_LOCKED_DESCRIPTION),
        },
      ),
    );
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
  });

  it('opens Settings on the requested tab', async () => {
    renderPalette();
    typeQuery('configurações dados');
    fireEvent.click(await screen.findByRole('option', { name: /Configurações › Dados/ }));

    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(true));
    expect(useUiStore.getState().settingsTab).toBe('data');
  });

  it('toggles a composer tool and reports the new state', async () => {
    renderPalette();
    typeQuery('busca web');
    fireEvent.click(await screen.findByRole('option', { name: /Desativar busca web/ }));

    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ webSearchEnabled: false }),
      ),
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Busca web desativada');
  });

  it('focuses the composer after closing', async () => {
    const listener = vi.fn();
    window.addEventListener('zylara:focus-composer', listener);

    renderPalette();
    typeQuery('focar campo de mensagem');
    fireEvent.click(await screen.findByRole('option', { name: /Focar campo de mensagem/ }));

    await waitFor(() => expect(listener).toHaveBeenCalled());
    window.removeEventListener('zylara:focus-composer', listener);
  });

  it('returns to the chat before focusing the composer from the Skills view', async () => {
    useUiStore.setState({ activeView: 'skills' });
    const listener = vi.fn();
    window.addEventListener('zylara:focus-composer', listener);

    renderPalette();
    typeQuery('focar campo de mensagem');
    fireEvent.click(await screen.findByRole('option', { name: /Focar campo de mensagem/ }));

    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(useUiStore.getState().activeView).toBe('chat');
    window.removeEventListener('zylara:focus-composer', listener);
  });

  it('reports a failed async command with a toast', async () => {
    mocks.openDataDir.mockRejectedValue(new Error('sem permissão'));

    renderPalette();
    typeQuery('abrir pasta de dados');
    fireEvent.click(await screen.findByRole('option', { name: /Abrir pasta de dados/ }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
  });
});

describe('CommandPalette — biblioteca', () => {
  it('abre a biblioteca pela paleta e fecha o overlay', async () => {
    renderPalette();
    typeQuery('abrir biblioteca');

    fireEvent.click(await screen.findByRole('option', { name: 'Abrir biblioteca' }));

    await waitFor(() => expect(useUiStore.getState().activeView).toBe('library'));
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('abre a biblioteca e aciona o seletor de arquivos pelo evento', async () => {
    const listener = vi.fn();
    window.addEventListener('zylara:library-import', listener);

    renderPalette();
    typeQuery('enviar arquivos para a biblioteca');
    fireEvent.click(
      await screen.findByRole('option', { name: 'Enviar arquivos para a biblioteca' }),
    );

    await waitFor(() => expect(useUiStore.getState().activeView).toBe('library'));
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    window.removeEventListener('zylara:library-import', listener);
  });

  it('só oferece “Voltar ao chat” fora do chat (skills e biblioteca)', async () => {
    renderPalette();
    typeQuery('voltar ao chat');
    expect(screen.queryByRole('option', { name: 'Voltar ao chat' })).toBeNull();

    act(() => {
      useUiStore.getState().setActiveView('library');
    });

    const option = await screen.findByRole('option', { name: 'Voltar ao chat' });
    fireEvent.click(option);

    await waitFor(() => expect(useUiStore.getState().activeView).toBe('chat'));
  });
});

describe('CommandPalette — recentes e reabertura', () => {
  it('orders the suggestions by recent usage', () => {
    window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(['alternar-tema', 'nova-conversa']));
    renderPalette();

    const suggestions = screen.getByRole('group', { name: 'Sugestões' });
    const options = within(suggestions).getAllByRole('option');
    expect(options[0].textContent).toContain('Alternar tema');
    expect(options[1].textContent).toContain('Novo chat');
  });

  it('resets the query when reopening', async () => {
    renderPalette();
    typeQuery('tema');
    fireEvent.keyDown(paletteInput(), { key: 'Escape' });
    fireEvent.keyDown(paletteInput(), { key: 'Escape' });
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);

    act(() => {
      useUiStore.getState().setCommandPaletteOpen(true);
    });

    await waitFor(() => expect(paletteInput().value).toBe(''));
  });

  it('keeps the palette usable when localStorage is corrupted', () => {
    window.localStorage.setItem(PALETTE_RECENTS_KEY, '{not-json');
    renderPalette();

    expect(screen.getByRole('group', { name: 'Sugestões' })).not.toBeNull();
    expect(screen.getByRole('option', { name: /Novo chat/ })).not.toBeNull();
  });

  it('restores the first row as active when reopening with an empty query (regression)', async () => {
    renderPalette();
    // Close with an empty query: the result signature is identical on reopen.
    fireEvent.keyDown(paletteInput(), { key: 'Escape' });
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);

    act(() => {
      useUiStore.getState().setCommandPaletteOpen(true);
    });

    await waitFor(() => {
      const first = screen.getAllByRole('option')[0];
      expect(first.getAttribute('aria-selected')).toBe('true');
      expect(paletteInput().getAttribute('aria-activedescendant')).toBe(first.id);
    });

    // Enter on the restored row must execute it (no dead keyboard).
    fireEvent.keyDown(paletteInput(), { key: 'Enter' });
    await waitFor(() => expect(useUiStore.getState().commandPaletteOpen).toBe(false));
  });

  it('starts from the first row when reopening after a search was left open', async () => {
    renderPalette();
    typeQuery('configuracoes');
    act(() => {
      useUiStore.getState().setCommandPaletteOpen(false);
    });

    act(() => {
      useUiStore.getState().setCommandPaletteOpen(true);
    });

    await waitFor(() => {
      expect(paletteInput().value).toBe('');
      const first = screen.getAllByRole('option')[0];
      expect(first.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('keeps the highlight when a keystroke does not change the result set', () => {
    renderPalette();
    typeQuery('tema');
    const before = paletteInput().getAttribute('aria-activedescendant');
    expect(before).not.toBeNull();

    // A trailing space produces the same results; the selection must survive.
    typeQuery('tema ');
    expect(paletteInput().getAttribute('aria-activedescendant')).toBe(before);
  });
});

describe('CommandPalette — layouts Chat e Code', () => {
  it('switches to the Code layout from the palette and closes', async () => {
    renderPalette();
    typeQuery('ir para o modo code');
    fireEvent.click(await screen.findByRole('option', { name: 'Ir para o modo Code' }));

    await waitFor(() => expect(useUiStore.getState().layoutMode).toBe('code'));
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('hides the Chat-only surfaces while in the Code layout', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    renderPalette();

    expect(await screen.findByRole('option', { name: 'Ir para o modo Chat' })).toBeTruthy();
    typeQuery('biblioteca');
    expect(screen.queryByRole('option', { name: 'Abrir biblioteca' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Enviar arquivos para a biblioteca' })).toBeNull();

    typeQuery('painel de artefatos');
    expect(screen.queryByRole('option', { name: 'Abrir painel de artefatos' })).toBeNull();
  });

  it('does not offer a layout that is disabled in the settings', async () => {
    useUiStore.setState({ enabledLayouts: { chat: true, code: false, agent: true } });
    renderPalette();
    typeQuery('ir para o modo');

    expect(screen.queryByRole('option', { name: 'Ir para o modo Code' })).toBeNull();
    expect(await screen.findByRole('option', { name: 'Ir para o modo Agentes' })).toBeTruthy();
  });

  it('opens the Skills page inside the Code center', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    renderPalette();
    typeQuery('gerenciar skills');

    fireEvent.click(await screen.findByRole('option', { name: 'Gerenciar skills' }));

    await waitFor(() => expect(useUiStore.getState().codeView).toBe('skills'));
    expect(useUiStore.getState().layoutMode).toBe('code');
    expect(useUiStore.getState().activeView).not.toBe('skills');
  });

  it('returns from the Code Skills page to the agent session', async () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'skills' });
    renderPalette();
    typeQuery('voltar à sessão');

    const option = await screen.findByRole('option', { name: 'Voltar à sessão' });
    fireEvent.click(option);

    await waitFor(() => expect(useUiStore.getState().codeView).toBe('session'));
  });

  it('focuses the composer from the Code Skills page by returning to the session', async () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'skills' });
    const listener = vi.fn();
    window.addEventListener('zylara:focus-composer', listener);

    renderPalette();
    typeQuery('focar campo de mensagem');
    fireEvent.click(await screen.findByRole('option', { name: /Focar campo de mensagem/ }));

    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(useUiStore.getState().codeView).toBe('session');
    window.removeEventListener('zylara:focus-composer', listener);
  });
});

describe('CommandPalette — sessões separadas Chat/Code', () => {
  it('does not list Code sessions in the Chat layout', async () => {
    useChatStore.setState((state) => ({
      conversations: [
        ...state.conversations,
        conversation({ id: 'code-1', title: 'Sessão exclusiva do Code', mode: 'code' }),
      ],
    }));
    renderPalette();

    expect(screen.queryByText('Sessão exclusiva do Code')).toBeNull();

    typeQuery('sessao exclusiva');
    await waitFor(() => expect(mocks.searchConversations).toHaveBeenCalled());
    expect(screen.queryByRole('option', { name: /Sessão exclusiva do Code/ })).toBeNull();
  });

  it('filters out Code sessions returned by the backend while in the Chat layout', async () => {
    mocks.searchConversations.mockResolvedValue([
      conversation({ id: 'code-1', title: 'Sessão Code escondida', mode: 'code' }),
    ]);
    renderPalette();
    typeQuery('escondida');

    await waitFor(() => expect(mocks.searchConversations).toHaveBeenCalledWith('escondida'));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Sessão Code escondida/ })).toBeNull(),
    );
  });

  it('searches only Code sessions while in the Code layout', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState((state) => ({
      conversations: [
        ...state.conversations.map((entry) => ({ ...entry, mode: 'chat' as const })),
        conversation({ id: 'code-1', title: 'Sessão do Code', mode: 'code' }),
      ],
    }));
    renderPalette();
    typeQuery('#sessao');

    expect(await screen.findByRole('option', { name: /Sessão do Code/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Planejamento do projeto/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Reunião de segunda/ })).toBeNull();
  });

  it('creates a Code session from "Novo agente" while in the Code layout', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    renderPalette();
    typeQuery('nova sess');

    fireEvent.click(await screen.findByRole('option', { name: /Nova sess/i }));

    await waitFor(() =>
      expect(mocks.createConversation).toHaveBeenCalledWith(
        'Nova conversa',
        expect.any(String),
        expect.any(String),
        'code',
      ),
    );
  });
});

describe('CommandPalette — diagnóstico de cache (F5.4)', () => {
  it('oferece o comando e abre o painel de diagnóstico da conversa ativa', async () => {
    renderPalette();
    typeQuery('diagnóstico de cache');

    const option = await screen.findByRole('option', { name: /Diagnóstico de cache/ });
    fireEvent.click(option);

    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Diagnóstico de cache' },
      { timeout: 4_000 },
    );
    await waitFor(() => expect(mocks.getCacheStats).toHaveBeenCalledWith('conv-1', 50));
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
    expect(
      await within(dialog).findByText('Sem amostras de cache nesta conversa'),
    ).toBeTruthy();
  });

  it('não oferece o diagnóstico sem conversa ativa', async () => {
    useChatStore.setState({ activeId: null });
    renderPalette();
    typeQuery('diagnóstico de cache');

    expect(await screen.findByText(/Nenhum resultado para/)).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Diagnóstico de cache/ })).toBeNull();
  });
});
