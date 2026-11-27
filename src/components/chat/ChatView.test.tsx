// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  ApprovalRequest,
  ChatMessage,
  Conversation,
  ProviderAuthStatus,
  ProviderInfo,
} from '@/lib/types';

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('./external', () => ({ openExternalUrl: mocks.openExternalUrl }));
// The banner is the subject here; the message list/composer have their own suites.
vi.mock('@/components/composer/Composer', () => ({
  Composer: () => <div data-testid="composer" />,
}));
vi.mock('./MessageList', () => ({ MessageList: () => <div data-testid="messages" /> }));

// Imported after the mocks above.
import { emptyCodeSession, useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import { ChatView } from './ChatView';

function provider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    shortName: 'ChatGPT',
    description: '',
    baseUrl: 'https://api.openai.com/v1',
    consoleUrl: 'https://chatgpt.com/settings/usage',
    endpoints: { 'openai-responses': '/responses', models: '/models' },
    authEnv: 'OPENAI_API_KEY',
    defaultModelId: 'gpt-6.1-sol',
    auth: 'oauth',
    requestProfiles: { oauth: 'chatgpt-plan', apiKey: 'standard' },
    oauth: {
      issuer: 'https://auth.openai.com',
      registrationClientId: 'dynamic_agent_client',
      agentNameHint: 'Zylara',
      resource: 'https://api.openai.com/v1',
      scopes: ['openid', 'chatgpt.tokens.use.direct'],
      planUsageScope: 'chatgpt.tokens.use.direct',
      callbackPath: '/auth/callback',
      loopbackHost: '127.0.0.1',
    },
    models: [],
    notes: [],
    ...overrides,
  };
}

function signedIn(overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    providerId: 'openai',
    mode: 'oauth',
    state: 'signed-in',
    planUsage: true,
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    ...overrides,
  };
}

function conversation(): Conversation {
  return {
    id: 'conv-1',
    title: 'Conversa',
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    providerId: 'openai',
    modelId: 'gpt-6.1-sol',
    messageCount: 2,
  };
}

function userMessage(): ChatMessage {
  return {
    id: 'user-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Olá',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 1,
  };
}

function assistantMessage(status: ChatMessage['status']): ChatMessage {
  return {
    id: 'assistant-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: '',
    status,
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 2,
  };
}

interface SeedOptions {
  errorCode?: string | null;
  errorHint?: string | null;
  assistantStatus?: ChatMessage['status'];
  provider?: ProviderInfo;
  auth?: ProviderAuthStatus | null;
}

function seed(options: SeedOptions = {}): void {
  const active = options.provider ?? provider();
  useChatStore.setState({
    conversations: [conversation()],
    activeId: 'conv-1',
    messagesByConversation: {
      'conv-1': [userMessage(), assistantMessage(options.assistantStatus ?? 'error')],
    },
    streaming: null,
    loadingConversationId: null,
    errorCode: options.errorCode ?? null,
    errorHint: options.errorHint ?? null,
    error: options.errorCode ? 'Falha na resposta' : null,
  });
  useAppStore.setState({
    providers: [active],
    auth: options.auth === undefined ? [signedIn()] : options.auth ? [options.auth] : [],
    keys: [],
    selection: {
      providerId: active.id,
      modelId: active.defaultModelId,
      reasoning: null,
    },
  });
  useUiStore.setState({ settingsOpen: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrolling implementation.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ providers: [], auth: [], keys: [] });
  useUiStore.setState({ layoutMode: 'chat' });
  useChatStore.setState({ conversations: [], activeId: null, messagesByConversation: {} });
  useCodeStore.setState({ byConversation: {} });
});

describe('ChatView — linha de chrome do layout Chat', () => {
  it('mostra o título da conversa na linha de chrome, não como overlay', () => {
    seed();
    render(<ChatView />);

    const title = screen.getByTitle('Conversa');
    expect(title.textContent).toBe('Conversa');

    // The Chat layout owns the top band: the header is a 40px in-flow drag row.
    const row = title.closest('div.h-10');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-tauri-drag-region')).toBe('true');
    expect(row?.className).not.toContain('absolute');
  });

  it('mantém o header flutuante nos layouts Code e Agentes', () => {
    useUiStore.setState({ layoutMode: 'agent' });
    seed();
    render(<ChatView />);

    // Those layouts bring their own chrome row; the chat header stays a
    // pointer-events-none overlay above the transcript.
    expect(screen.queryByTitle('Conversa')).toBeNull();
    expect(document.querySelector('div.h-10')).toBeNull();
  });
});

describe('ChatView — tela vazia', () => {
  function seedEmpty(): void {
    useChatStore.setState({
      conversations: [conversation()],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [] },
      streaming: null,
      loadingConversationId: null,
      errorCode: null,
      errorHint: null,
      error: null,
    });
  }

  it('keeps the native chat welcome by default', () => {
    seedEmpty();
    render(<ChatView />);

    expect(screen.getByText('Como posso ajudar?')).toBeTruthy();
  });

  it('aceita um welcome customizado (usado pelo layout Code)', () => {
    seedEmpty();
    render(<ChatView welcome={<div data-testid="code-welcome" />} />);

    expect(screen.getByTestId('code-welcome')).toBeTruthy();
    expect(screen.queryByText('Como posso ajudar?')).toBeNull();
  });
});

describe('ChatView — banners de erro do turno (T4.4a)', () => {
  it('mostra o limite atingido e abre o dashboard externo pelo CTA primário', () => {
    seed({
      errorCode: 'subscription_sharing_usage_limit_exceeded',
      errorHint: 'Limite de uso atingido — pode ser do plano ou deste app. Use "Gerenciar uso".',
    });

    render(<ChatView />);

    expect(screen.getByText('Limite de uso atingido')).toBeTruthy();
    expect(screen.getByText(/pode ser do plano ou deste app/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Gerenciar uso' }));
    expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://chatgpt.com/settings/usage');
  });

  it('trata o código neutro plan_limit como limite do plano', () => {
    seed({ errorCode: 'plan_limit' });

    render(<ChatView />);
    expect(screen.getByText('Limite de uso atingido')).toBeTruthy();
  });

  it('não mostra banner de limite para rate_limited em provedor de API key', () => {
    seed({
      errorCode: 'rate_limited',
      provider: provider({
        id: 'opencode-go',
        name: 'OpenCode Go',
        shortName: 'Go',
        auth: 'api-key',
        defaultModelId: 'deepseek-v4.1-flash',
      }),
      auth: null,
    });

    render(<ChatView />);
    expect(screen.queryByText('Limite de uso atingido')).toBeNull();
  });

  it('não mostra banner para erros não classificados', () => {
    seed({ errorCode: 'unsupported_capability' });

    render(<ChatView />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('não herda o banner quando a última resposta não terminou em erro', () => {
    seed({
      errorCode: 'subscription_sharing_usage_limit_exceeded',
      assistantStatus: 'complete',
    });

    render(<ChatView />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('abre Configurações → Provedores no erro de credencial', () => {
    seed({
      errorCode: 'auth_required',
      errorHint: 'Entre novamente com o ChatGPT para renovar sua sessão.',
      auth: signedIn({ state: 'reauth-required' }),
    });

    render(<ChatView />);

    const alert = screen.getByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Abrir Provedores' }));

    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe('providers');
  });

  it('mostra inelegível sem botão de retry no banner', () => {
    seed({ errorCode: 'subscription_sharing_user_not_eligible' });

    render(<ChatView />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Uso do plano indisponível')).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: /tentar novamente/i })).toBeNull();
  });
});

describe('ChatView — sessões por layout (defesa contra activeId obsoleto)', () => {
  it('não renderiza a conversa de outro layout no modo Chat', () => {
    const codeConversation: Conversation = { ...conversation(), mode: 'code' };
    useChatStore.setState({
      conversations: [codeConversation],
      activeId: 'conv-1',
      messagesByConversation: {
        'conv-1': [userMessage(), assistantMessage('complete')],
      },
      loadingConversationId: null,
      streaming: null,
      errorCode: null,
    });
    useUiStore.setState({ layoutMode: 'chat' });

    render(<ChatView />);

    expect(screen.queryByTestId('messages')).toBeNull();
    expect(screen.getByText('Como posso ajudar?')).toBeTruthy();
  });

  it('não renderiza a conversa do Chat no modo Code', () => {
    const chatConversation: Conversation = { ...conversation(), mode: 'chat' };
    useChatStore.setState({
      conversations: [chatConversation],
      activeId: 'conv-1',
      messagesByConversation: {
        'conv-1': [userMessage(), assistantMessage('complete')],
      },
      loadingConversationId: null,
      streaming: null,
      errorCode: null,
    });
    useUiStore.setState({ layoutMode: 'code' });

    render(<ChatView welcome={<div data-testid="code-welcome" />} />);

    expect(screen.queryByTestId('messages')).toBeNull();
    expect(screen.getByTestId('code-welcome')).toBeTruthy();
  });
});

describe('ChatView — gate de aprovação no layout Code (F-06)', () => {
  function planApproval(): ApprovalRequest {
    return {
      id: 'apr-plan',
      toolCallId: 'call-plan',
      tool: 'submit_plan',
      title: 'Aprovar plano?',
      detail: { kind: 'other', text: 'Resumo' },
      risk: 'ask',
      preview: '## Plano\n\n1. Fazer',
      options: [],
      createdAt: 1,
    };
  }

  function seedCode(messages: ChatMessage[]): void {
    const codeConversation: Conversation = { ...conversation(), mode: 'code', workspaceId: 'ws-1' };
    useChatStore.setState({
      conversations: [codeConversation],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': messages },
      loadingConversationId: null,
      streaming: null,
      errorCode: null,
      errorHint: null,
      error: null,
    });
    useAppStore.setState({
      providers: [provider()],
      auth: [signedIn()],
      keys: [],
      selection: { providerId: 'openai', modelId: 'gpt-6.1-sol', reasoning: null },
    });
    useUiStore.setState({ layoutMode: 'code' });
    useCodeStore.setState({ byConversation: {} });
  }

  it('rola até o gate quando uma aprovação aparece', async () => {
    seedCode([userMessage(), assistantMessage('complete')]);
    render(<ChatView />);

    const scrollTo = HTMLElement.prototype.scrollTo as unknown as ReturnType<typeof vi.fn>;
    scrollTo.mockClear();

    act(() => {
      useCodeStore.setState({
        byConversation: {
          'conv-1': { ...emptyCodeSession('conv-1'), approvals: [planApproval()] },
        },
      });
    });

    expect(await screen.findByText('Aguardando aprovação')).toBeTruthy();
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });

  it('mostra o gate mesmo sem mensagens (não esconde atrás do welcome)', () => {
    seedCode([]);
    useCodeStore.setState({
      byConversation: {
        'conv-1': { ...emptyCodeSession('conv-1'), approvals: [planApproval()] },
      },
    });
    render(<ChatView welcome={<div data-testid="code-welcome" />} />);

    expect(screen.queryByTestId('code-welcome')).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'Plano proposto' })).toBeTruthy();
  });

  it('mantém o gate visível mesmo com o layout Chat selecionado', () => {
    seedCode([userMessage(), assistantMessage('complete')]);
    useUiStore.setState({ layoutMode: 'chat' });
    useCodeStore.setState({
      byConversation: {
        'conv-1': { ...emptyCodeSession('conv-1'), approvals: [planApproval()] },
      },
    });
    render(<ChatView />);

    expect(screen.getByRole('alertdialog', { name: 'Plano proposto' })).toBeTruthy();
  });
});
