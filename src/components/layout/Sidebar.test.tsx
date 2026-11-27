// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChatMessage, Conversation, Settings } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  createConversation: vi.fn(),
  exportConversation: vi.fn(),
  setConversationCodeLinked: vi.fn(),
  reorderConversations: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Imported after the API mock.
import { Sidebar } from './Sidebar';
import { useAppStore, useChatStore, useUiStore } from '@/lib/store';

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
    ...overrides,
  };
}

function skillsButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Gerenciar skills' });
}

function libraryButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Abrir biblioteca' });
}

function pluginsButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Abrir plugins' });
}

beforeEach(() => {
  window.matchMedia = matchMediaReturning(false);
  mocks.createConversation.mockResolvedValue(conversation());
  mocks.exportConversation.mockResolvedValue(null);
  mocks.setConversationCodeLinked.mockImplementation(async (id: string) =>
    conversation({ id, codeLinked: true }),
  );
  useAppStore.setState({ settings: settings() });
  useChatStore.setState({
    conversations: [],
    conversationsLoading: false,
    activeId: null,
    streamsByConversation: {},
    messagesByConversation: {},
  });
  useUiStore.setState({ activeView: 'chat', layoutMode: 'chat' });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe('Sidebar — largura controlada pelo AppShell', () => {
  it('fills its container instead of hard-coding the design width', () => {
    render(<Sidebar />);

    const aside = screen.getByRole('complementary', { name: 'Conversas' });
    expect(aside.className).toContain('w-full');
    expect(aside.className).not.toContain('w-[272px]');
  });

  it('funde-se ao chrome: fundo surface e nenhuma borda divisória à direita', () => {
    render(<Sidebar />);

    const aside = screen.getByRole('complementary', { name: 'Conversas' });
    expect(aside.className).toContain('bg-surface');
    // A divisão com o chat é o canto arredondado do painel, não uma linha.
    expect(aside.className).not.toContain('border-r');
  });
});

describe('Sidebar — item Skills', () => {
  it('renders Skills between Novo chat and Buscar conversas and opens the skills view', () => {
    const onClose = vi.fn();
    render(<Sidebar onClose={onClose} />);

    const newChat = screen.getByRole('button', { name: /Novo chat/ });
    const skills = skillsButton();
    const search = screen.getByRole('button', { name: /Buscar conversas/ });

    expect(skills).not.toBeNull();
    expect(skills?.textContent).toContain('Skills');
    // Ordering: Novo chat → Skills → Buscar conversas.
    expect(
      newChat.compareDocumentPosition(skills as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (skills as Node).compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Chat is the active surface: the item is not marked as current yet.
    expect(skills?.getAttribute('aria-current')).toBeNull();
    expect(useUiStore.getState().activeView).toBe('chat');

    fireEvent.click(skills as HTMLElement);

    expect(useUiStore.getState().activeView).toBe('skills');
    expect(skillsButton()?.getAttribute('aria-current')).toBe('page');
    // Desktop sidebar stays open.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides Skills when the setting is disabled', () => {
    useAppStore.setState({ settings: settings({ skillsPanelEnabled: false }) });
    render(<Sidebar />);

    expect(skillsButton()).toBeNull();
    expect(screen.queryByText('Skills')).toBeNull();
    // The rest of the sidebar is unaffected.
    expect(screen.getByRole('button', { name: /Novo chat/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Buscar conversas/ })).toBeTruthy();
  });

  it('marks Skills as the current page when the skills view is active', () => {
    useUiStore.setState({ activeView: 'skills' });
    render(<Sidebar />);

    const skills = skillsButton();
    expect(skills?.getAttribute('aria-current')).toBe('page');
    expect(skills?.className).toContain('bg-surface-active');

    // "Novo chat" is not an active page.
    expect(
      screen.getByRole('button', { name: /Novo chat/ }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('closes the compact drawer after opening the skills view', () => {
    window.matchMedia = matchMediaReturning(true);
    const onClose = vi.fn();
    render(<Sidebar onClose={onClose} />);

    fireEvent.click(skillsButton() as HTMLElement);

    expect(useUiStore.getState().activeView).toBe('skills');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns to the chat view from Novo chat (regression)', async () => {
    useUiStore.setState({ activeView: 'skills' });
    render(<Sidebar />);

    expect(skillsButton()?.getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: /Novo chat/ }));

    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useUiStore.getState().activeView).toBe('chat'));
    expect(skillsButton()?.getAttribute('aria-current')).toBeNull();
  });
});

describe('Sidebar — item Biblioteca', () => {
  it('renders Biblioteca above Skills and opens the library view', () => {
    const onClose = vi.fn();
    render(<Sidebar onClose={onClose} />);

    const newChat = screen.getByRole('button', { name: /Novo chat/ });
    const library = libraryButton();
    const skills = skillsButton();
    const search = screen.getByRole('button', { name: /Buscar conversas/ });

    expect(library).not.toBeNull();
    expect(library?.textContent).toContain('Biblioteca');
    // Ordering (PLAN §4.1): Novo chat → Biblioteca → Skills → Buscar conversas.
    expect(
      newChat.compareDocumentPosition(library as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (library as Node).compareDocumentPosition(skills as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (skills as Node).compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Same visual language as the other sidebar entries: lucide icon at size-4.
    expect(library?.querySelector('svg')?.getAttribute('class')).toContain('size-4');

    // Chat is the active surface: the item is not marked as current yet.
    expect(library?.getAttribute('aria-current')).toBeNull();
    expect(useUiStore.getState().activeView).toBe('chat');

    fireEvent.click(library as HTMLElement);

    expect(useUiStore.getState().activeView).toBe('library');
    expect(libraryButton()?.getAttribute('aria-current')).toBe('page');
    expect(skillsButton()?.getAttribute('aria-current')).toBeNull();
    // Desktop sidebar stays open.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stays visible when the skills panel is disabled', () => {
    useAppStore.setState({ settings: settings({ skillsPanelEnabled: false }) });
    render(<Sidebar />);

    expect(skillsButton()).toBeNull();
    expect(screen.queryByText('Skills')).toBeNull();

    const library = libraryButton();
    expect(library).not.toBeNull();
    expect(
      (library as Node).compareDocumentPosition(screen.getByRole('button', { name: /Buscar conversas/ })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(library as HTMLElement);
    expect(useUiStore.getState().activeView).toBe('library');
  });

  it('marks Biblioteca as the current page when the library view is active', () => {
    useUiStore.setState({ activeView: 'library' });
    render(<Sidebar />);

    const library = libraryButton();
    expect(library?.getAttribute('aria-current')).toBe('page');
    expect(library?.className).toContain('bg-surface-active');

    // Neither the chat entry nor Skills is the current page.
    expect(
      screen.getByRole('button', { name: /Novo chat/ }).getAttribute('aria-current'),
    ).toBeNull();
    expect(skillsButton()?.getAttribute('aria-current')).toBeNull();
  });

  it('closes the compact drawer after opening the library view', () => {
    window.matchMedia = matchMediaReturning(true);
    const onClose = vi.fn();
    render(<Sidebar onClose={onClose} />);

    fireEvent.click(libraryButton() as HTMLElement);

    expect(useUiStore.getState().activeView).toBe('library');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns to the chat view from Novo chat while the library is open (regression)', async () => {
    useUiStore.setState({ activeView: 'library' });
    render(<Sidebar />);

    expect(libraryButton()?.getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: /Novo chat/ }));

    expect(mocks.createConversation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useUiStore.getState().activeView).toBe('chat'));
    expect(libraryButton()?.getAttribute('aria-current')).toBeNull();
  });
});

describe('Sidebar — item Plugins', () => {
  it('renders Plugins above Skills and opens the plugins page', () => {
    const onClose = vi.fn();
    render(<Sidebar onClose={onClose} />);

    const library = libraryButton();
    const plugins = pluginsButton();
    const skills = skillsButton();

    expect(plugins).not.toBeNull();
    expect(plugins?.textContent).toContain('Plugins');
    expect(
      (library as Node).compareDocumentPosition(plugins as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (plugins as Node).compareDocumentPosition(skills as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(plugins?.getAttribute('aria-current')).toBeNull();

    fireEvent.click(plugins as HTMLElement);

    expect(useUiStore.getState().activeView).toBe('plugins');
    expect(pluginsButton()?.getAttribute('aria-current')).toBe('page');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Sidebar — sessões separadas Chat/Code', () => {
  it('lists Chat sessions only (Code sessions stay out of the Chat sidebar)', () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'chat-1', title: 'Sessão do Chat' }),
        conversation({ id: 'code-1', title: 'Sessão do Code', mode: 'code' }),
        conversation({ id: 'shared-1', title: 'Sessão compartilhada', codeLinked: true }),
      ],
      activeId: 'chat-1',
    });
    render(<Sidebar />);

    expect(screen.getByText('Sessão do Chat')).toBeTruthy();
    expect(screen.getByText('Sessão compartilhada')).toBeTruthy();
    expect(screen.queryByText('Sessão do Code')).toBeNull();
  });

  it('adds a Chat session to the Code layout from the conversation menu', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'chat-1', title: 'Sessão do Chat' })],
      activeId: 'chat-1',
    });
    render(<Sidebar />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Opções da conversa' }), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Usar no Code/ }));

    await waitFor(() =>
      expect(mocks.setConversationCodeLinked).toHaveBeenCalledWith('chat-1', true),
    );
  });

  it('offers removing the link when the session is already shared', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'shared-1', title: 'Compartilhada', codeLinked: true })],
      activeId: 'shared-1',
    });
    mocks.setConversationCodeLinked.mockImplementation(async (id: string) =>
      conversation({ id, codeLinked: false }),
    );
    render(<Sidebar />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Opções da conversa' }), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Remover do Code/ }));

    await waitFor(() =>
      expect(mocks.setConversationCodeLinked).toHaveBeenCalledWith('shared-1', false),
    );
  });
});

describe('Sidebar — reordenação por teclado', () => {
  it('move a conversa dentro da seção e persiste a ordem', async () => {
    const now = Date.now();
    mocks.reorderConversations.mockResolvedValue(undefined);
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-1', title: 'Primeira', updatedAt: now }),
        conversation({ id: 'c-2', title: 'Segunda', updatedAt: now - 1_000 }),
      ],
      activeId: null,
    });
    render(<Sidebar />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Primeira' }), {
      key: 'ArrowDown',
      altKey: true,
    });

    await waitFor(() =>
      expect(mocks.reorderConversations).toHaveBeenCalledWith(['c-2', 'c-1']),
    );
    expect(useChatStore.getState().conversations.map((item) => item.id)).toEqual(['c-2', 'c-1']);
  });
});

describe('Sidebar — mais informações nas linhas de conversa', () => {
  it('mostra prévia, hora e status concluído por padrão', () => {
    const today = new Date();
    today.setHours(17, 56, 0, 0);
    useChatStore.setState({
      conversations: [
        conversation({
          id: 'c-done',
          title: 'Visão geral do projeto',
          preview: 'App desktop local-first (Tauri 2 +...)',
          lastStatus: 'complete',
          updatedAt: today.getTime(),
        }),
      ],
      activeId: null,
    });
    render(<Sidebar />);

    const row = screen.getByRole('button', { name: 'Visão geral do projeto' });
    expect(row.textContent).toContain('App desktop local-first (Tauri 2 +...)');
    expect(row.textContent).toContain('Concluída');
    expect(row.textContent).toContain('17:56');
    expect(within(row).getByTitle('DeepSeek V4.1 Flash')).toBeTruthy();
    expect(row.className).not.toContain('pr-8');
    expect(row.parentElement?.querySelector('.bg-linear-to-l')).toBeTruthy();
  });

  it('mostra a ferramenta ativa e o status em execução durante um turno', () => {
    const assistant: ChatMessage = {
      id: 'a-1',
      conversationId: 'c-live',
      role: 'assistant',
      content: '',
      status: 'streaming',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'docs/AGENTS.md' }),
          status: 'running',
        },
      ],
      citations: [],
      attachments: [],
      createdAt: 1,
    };
    useChatStore.setState({
      conversations: [
        conversation({
          id: 'c-live',
          title: 'analisa o projeto e me da um relatório',
          preview: 'analisa o projeto e me da um r...',
          updatedAt: Date.now(),
        }),
      ],
      activeId: 'c-live',
      streamsByConversation: {
        'c-live': {
          turnId: 't-1',
          conversationId: 'c-live',
          assistantId: 'a-1',
          userMessageId: null,
          phase: 'tool',
          step: 1,
          startedAt: Date.now(),
          turnKind: 'user',
        },
      },
      messagesByConversation: { 'c-live': [assistant] },
    });
    render(<Sidebar />);

    const row = screen.getByRole('button', {
      name: 'analisa o projeto e me da um relatório',
    });
    expect(row.textContent).toContain('docs/AGENTS.md');
    expect(row.textContent).not.toContain('analisa o projeto e me da um r...');
    expect(row.textContent).toContain('Em execução');
    expect(row.textContent).toContain('agora');
  });

  it('sinaliza uma conversa cujo último turno falhou', () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'c-error', title: 'Com falha', lastStatus: 'error' }),
      ],
      activeId: null,
    });
    render(<Sidebar />);

    expect(screen.getByRole('button', { name: 'Com falha' }).textContent).toContain('Falhou');
  });
});
