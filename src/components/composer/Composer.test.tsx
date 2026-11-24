// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  Agent,
  AttachmentInfo,
  ChatMessage,
  ContextStats,
  Conversation,
  ProviderAuthStatus,
  ProviderInfo,
  ProviderKeyStatus,
} from '@/lib/types';
import type { StreamingState } from '@/lib/store/chatStore';

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => true),
}));

vi.mock('@/components/chat/external', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
// The model pill has its own suite (ui-systems); here it only needs to exist.
vi.mock('@/components/models/ModelPill', () => ({
  ModelPill: ({
    onClick,
    providerId,
    modelId,
    reasoning,
  }: {
    onClick: () => void;
    providerId?: string;
    modelId?: string;
    reasoning?: unknown;
  }) => (
    <button
      type="button"
      onClick={onClick}
      data-provider={providerId ?? ''}
      data-model={modelId ?? ''}
      data-reasoning={reasoning ? JSON.stringify(reasoning) : ''}
    >
      Modelo
    </button>
  ),
}));

// Imported after the mocks above.
import { api } from '@/lib/api';
import { emptyCodeSession, useAgentStore, useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import { Composer } from './Composer';

function openAiProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
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

function apiKey(providerId = 'openai'): ProviderKeyStatus {
  return { providerId, hasKey: true, source: 'settings', mode: 'api-key' };
}

function seedApp(options: {
  provider?: ProviderInfo | null;
  auth?: ProviderAuthStatus | null;
  keys?: ProviderKeyStatus[];
}): void {
  const provider = options.provider === undefined ? openAiProvider() : options.provider;
  useAppStore.setState({
    providers: provider ? [provider] : [],
    auth: options.auth ? [options.auth] : [],
    keys: options.keys ?? [],
    selection: {
      providerId: provider?.id ?? 'openai',
      modelId: provider?.defaultModelId ?? '',
      reasoning: null,
    },
  });
}

function typeMessage(value = 'Olá'): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem para o Zylara' }), {
    target: { value },
  });
}

const sendButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Enviar mensagem' }) as HTMLButtonElement;

function chatConversation(id = 'conv-chat'): Conversation {
  return {
    id,
    title: 'Conversa de teste',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    providerId: 'openai',
    modelId: 'gpt-6.1-sol',
    messageCount: 0,
    mode: 'chat',
  };
}

function agentConversation(id = 'conv-agent'): Conversation {
  return {
    ...chatConversation(id),
    mode: 'agent',
    agentId: 'agent-1',
  };
}

function agentRecord(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Irineu',
    role: 'Engenheiro',
    description: '',
    avatar: { kind: 'emoji', value: '🛠️', shape: 'rounded' },
    department: 'Engenharia',
    pinned: false,
    sortOrder: 1,
    providerId: 'openai',
    modelId: 'gpt-6.1-sol',
    reasoning: { mode: 'effort', effort: 'high' },
    instructions: '',
    promptVersion: 1,
    starters: [],
    capabilities: {
      webSearch: true,
      fileAccess: true,
      codeExecution: true,
      skills: null,
      tools: null,
      mcpServers: null,
    },
    memoryEnabled: false,
    workspaceId: null,
    permissionMode: 'edit',
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    threadCount: 0,
    lastActiveAt: null,
    ...overrides,
  };
}

function contextStats(overrides: Partial<ContextStats> = {}): ContextStats {
  return {
    used: 42_000,
    window: 200_000,
    outputCap: 32_000,
    percent: 21,
    messages: 12,
    breakdown: { systemPrompt: 10_000, toolDefinitions: 2_000, messages: 30_000 },
    ...overrides,
  };
}

function seedChatContext(conversationId = 'conv-chat', stats: ContextStats | null = contextStats()): void {
  useCodeStore.setState({
    byConversation: {
      [conversationId]: { ...emptyCodeSession(conversationId), context: stats },
    },
  });
}

function seedActiveChat(conversationId = 'conv-chat'): void {
  useChatStore.setState({
    activeId: conversationId,
    conversations: [chatConversation(conversationId)],
  });
}

function streamingState(overrides: Partial<StreamingState> = {}): StreamingState {
  return {
    turnId: 'turn-1',
    conversationId: 'conv-chat',
    assistantId: 'assistant-1',
    userMessageId: 'user-1',
    phase: 'tool',
    step: 1,
    startedAt: Date.now(),
    turnKind: 'user',
    ...overrides,
  };
}

function composerActivity(): HTMLElement {
  return screen.getByTestId('composer-activity');
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    streaming: null,
    pendingAttachments: [],
    error: null,
    errorCode: null,
    errorHint: null,
    activeId: null,
  });
  useCodeStore.setState({ byConversation: {} });
  useAgentStore.setState({
    agentsById: {},
    orderedIds: [],
    status: 'idle',
    error: null,
    mutationById: {},
    initialized: false,
  });
  useUiStore.setState({ settingsOpen: false, layoutMode: 'chat', activeAgentId: null });
  seedApp({ auth: signedIn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  seedApp({ provider: null, auth: null });
  useChatStore.setState({ activeId: null, conversations: [] });
  useCodeStore.setState({ byConversation: {} });
  useAppStore.setState((state) => ({
    settings: { ...state.settings, reduceMotion: false },
  }));
});

describe('Composer — gate de envio (D9)', () => {
  it('desabilita o envio e mostra o CTA de Provedores quando falta credencial', () => {
    seedApp({ auth: null });
    render(<Composer />);

    typeMessage();
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(/Entre com sua conta ChatGPT/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir Provedores' }));

    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe('providers');
  });

  it('descreve o aviso do compositor pelo textarea (aria-describedby)', () => {
    seedApp({ auth: null });
    render(<Composer />);

    const textarea = screen.getByRole('textbox', { name: 'Mensagem para o Zylara' });
    expect(textarea.getAttribute('aria-describedby')).toBe('composer-credential-notice');
  });

  it('habilita o envio com API key salva', () => {
    seedApp({ auth: null, keys: [apiKey()] });
    render(<Composer />);

    typeMessage();
    expect(sendButton().disabled).toBe(false);
    expect(screen.queryByText(/adicionar uma API key|Adicione a API key/i)).toBeNull();
  });

  it('habilita o envio com a conta ChatGPT conectada', () => {
    render(<Composer />);

    typeMessage();
    expect(sendButton().disabled).toBe(false);
  });

  it('mantém o compositor habilitado quando o catálogo está vazio (boot/testes)', () => {
    seedApp({ provider: null, auth: null });
    render(<Composer />);

    typeMessage();
    expect(sendButton().disabled).toBe(false);
  });
});

describe('Composer — variant por layoutMode (Chat | Code)', () => {
  it('no modo Chat mantém placeholder e rótulo atuais', () => {
    render(<Composer />);

    const textarea = screen.getByRole('textbox', { name: 'Mensagem para o Zylara' });
    expect(textarea.getAttribute('placeholder')).toBe('Pergunte alguma coisa…');
  });

  it('no modo Code usa a copy de tarefa para o agente', () => {
    useUiStore.setState({ layoutMode: 'code' });
    render(<Composer />);

    const textarea = screen.getByRole('textbox', { name: 'Tarefa para o agente' });
    expect(textarea.getAttribute('placeholder')).toBe('Descreva a tarefa para o agente…');
    expect(screen.queryByRole('textbox', { name: 'Mensagem para o Zylara' })).toBeNull();
  });

  it('troca a copy ao alternar o modo sem perder o rascunho nem o envio', () => {
    render(<Composer />);
    typeMessage('Corrigir o build');
    expect(sendButton().disabled).toBe(false);

    act(() => useUiStore.getState().setLayoutMode('code'));

    const textarea = screen.getByRole('textbox', { name: 'Tarefa para o agente' }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Corrigir o build');
    expect(sendButton().disabled).toBe(false);
  });

  it('no modo Chat mostra os toggles de ferramentas somente com ícone', () => {
    render(<Composer />);

    const webSearch = screen.getByRole('button', { name: 'Busca web' });
    const fileCreation = screen.getByRole('button', { name: 'Criar arquivos' });
    expect(webSearch.textContent?.trim()).toBe('');
    expect(fileCreation.textContent?.trim()).toBe('');
    expect(screen.queryByRole('button', { name: /Modo de permissão/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modo Plano' })).toBeNull();
  });

  it('marca a fileira de controles como container de consulta (colapso responsivo)', () => {
    render(<Composer />);

    // The pill/permission labels collapse with container variants, so the row
    // must be the query container for them to react to the chat width.
    const row = screen.getByRole('button', { name: 'Anexar arquivos' }).parentElement;
    expect(row?.className).toContain('@container');
  });

  it('no modo Agentes mostra o seletor com a rota da persona na home', () => {
    useAgentStore.setState({
      agentsById: {
        'agent-1': agentRecord({
          providerId: 'openai',
          modelId: 'gpt-6.1-sol',
          reasoning: { mode: 'effort', effort: 'max' },
        }),
      },
      orderedIds: ['agent-1'],
    });
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    useChatStore.setState({ activeId: null, conversations: [] });

    render(<Composer />);

    const pill = screen.getByRole('button', { name: 'Modelo' });
    expect(pill.getAttribute('data-provider')).toBe('openai');
    expect(pill.getAttribute('data-model')).toBe('gpt-6.1-sol');
    expect(pill.getAttribute('data-reasoning')).toBe(JSON.stringify({ mode: 'effort', effort: 'max' }));
  });

  it('no modo Agentes esconde o indicador de contexto e usa a rota congelada da thread', () => {
    useAgentStore.setState({
      agentsById: { 'agent-1': agentRecord() },
      orderedIds: ['agent-1'],
    });
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    const thread = {
      ...agentConversation(),
      providerId: 'openai',
      modelId: 'gpt-6.1-sol',
    };
    useChatStore.setState({ activeId: thread.id, conversations: [thread] });
    seedChatContext(thread.id);

    render(<Composer />);

    expect(screen.queryByRole('button', { name: /^Contexto usado:/ })).toBeNull();
    const pill = screen.getByRole('button', { name: 'Modelo' });
    expect(pill.getAttribute('data-provider')).toBe('openai');
    expect(pill.getAttribute('data-model')).toBe('gpt-6.1-sol');
  });
});

describe('Composer — indicador de contexto no Chat', () => {
  it('mostra o anel de contexto antes do ModelPill quando a conversa ativa tem stats', () => {
    seedActiveChat();
    seedChatContext();
    render(<Composer />);

    const chip = screen.getByRole('button', { name: 'Contexto usado: 21%' });
    const modelPill = screen.getByRole('button', { name: 'Modelo' });
    // O indicador fica antes do ModelPill na fileira de controles.
    expect(
      chip.compareDocumentPosition(modelPill) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(chip.className).toContain('h-8');
    expect(screen.queryByRole('button', { name: /^Cache de prompt:/ })).toBeNull();
  });

  it('não mostra o indicador sem conversa ativa', () => {
    seedChatContext();
    render(<Composer />);

    expect(screen.queryByRole('button', { name: /^Contexto usado:/ })).toBeNull();
  });

  it('não mostra o indicador no layout Code (o header já hospeda o medidor)', () => {
    seedActiveChat();
    seedChatContext();
    useUiStore.setState({ layoutMode: 'code' });
    render(<Composer />);

    expect(screen.queryByRole('button', { name: /^Contexto usado:/ })).toBeNull();
  });

  it('não mostra o indicador antes de existir estatística de contexto', () => {
    seedActiveChat();
    seedChatContext('conv-chat', null);
    render(<Composer />);

    expect(screen.queryByRole('button', { name: /^Contexto usado:/ })).toBeNull();
  });

  it('abre os detalhes do contexto ao clicar no ícone circular', async () => {
    seedActiveChat();
    seedChatContext();
    render(<Composer />);

    fireEvent.click(screen.getByRole('button', { name: 'Contexto usado: 21%' }));

    const dialog = await screen.findByRole('dialog', { name: 'Detalhes do contexto' });
    expect(within(dialog).getByText('21% do contexto usado')).toBeTruthy();
  });
});

describe('Composer — indicador de execução', () => {
  it('orbita o perímetro inteiro nos dois layouts durante o streaming', () => {
    useChatStore.setState({ streaming: streamingState() });
    render(<Composer />);

    expect(composerActivity().getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'Parar resposta' })).toBeTruthy();

    act(() => useUiStore.getState().setLayoutMode('code'));

    expect(composerActivity().getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'Parar resposta' })).toBeTruthy();
  });

  it('mantém o indicador estático quando reduceMotion está ativo', () => {
    useAppStore.setState((state) => ({
      settings: { ...state.settings, reduceMotion: true },
    }));
    useChatStore.setState({ streaming: streamingState() });
    render(<Composer />);

    expect(composerActivity().getAttribute('data-active')).toBe('true');
    expect(composerActivity().getAttribute('data-motion')).toBe('reduced');
  });

  it('oferece enfileirar no layout Agentes durante o streaming', async () => {
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    useChatStore.setState({ streaming: streamingState(), activeId: 'conv-1' });
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Mensagem para o agente' }), {
      target: { value: 'Olá' },
    });
    const queue = screen.getByRole('button', { name: 'Enfileirar mensagem' });
    expect(queue).toBeTruthy();
    fireEvent.click(queue);
    await waitFor(() => expect(send).toHaveBeenCalled());
  });

  it('oferece Fila e Enviar agora no Chat durante o streaming', async () => {
    useUiStore.setState({ layoutMode: 'chat' });
    useChatStore.setState({ streaming: streamingState(), activeId: 'conv-1' });
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Na fila' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enfileirar mensagem' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][1]).toBeUndefined();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Agora' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar agora' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1]).toMatchObject({ sendNow: true });
  });
});

describe('Composer — colar arquivos com Ctrl+V', () => {
  function attachmentInfo(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
    return {
      id: 'att-pdf',
      name: 'relatorio.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      kind: 'pdf',
      ...overrides,
    };
  }

  const composerTextarea = () =>
    screen.getByRole('textbox', { name: 'Mensagem para o Zylara' });

  it('importa arquivos do clipboard e mostra o chip com tipo', async () => {
    const spy = vi
      .spyOn(api, 'importClipboardAttachments')
      .mockResolvedValue([attachmentInfo()]);
    render(<Composer />);

    fireEvent.paste(composerTextarea(), {
      clipboardData: {
        types: ['Files'],
        files: [new File(['x'], 'relatorio.pdf', { type: 'application/pdf' })],
      },
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('relatorio.pdf')).toBeTruthy();
    expect(screen.getByText('PDF · 2 KB')).toBeTruthy();
  });

  it('não intercepta a colagem de texto', () => {
    const spy = vi.spyOn(api, 'importClipboardAttachments').mockResolvedValue([]);
    render(<Composer />);

    fireEvent.paste(composerTextarea(), {
      clipboardData: {
        types: ['text/plain'],
        files: [],
        getData: () => 'texto colado',
      },
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('consulta o clipboard quando o paste não traz texto', async () => {
    const spy = vi.spyOn(api, 'importClipboardAttachments').mockResolvedValue([]);
    render(<Composer />);

    fireEvent.paste(composerTextarea(), {
      clipboardData: { types: [], files: [], getData: () => '' },
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});

describe('Composer — navegação pelas mensagens enviadas', () => {
  function sentMessage(
    id: string,
    content: string,
    overrides: Partial<ChatMessage> = {},
  ): ChatMessage {
    return {
      id,
      conversationId: 'conv-chat',
      role: 'user',
      content,
      status: 'complete',
      toolCalls: [],
      citations: [],
      attachments: [],
      createdAt: 1,
      ...overrides,
    };
  }

  function seedSentMessages(messages: ChatMessage[]): void {
    seedActiveChat();
    useChatStore.setState((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        'conv-chat': messages.map((message) => ({ ...message, conversationId: 'conv-chat' })),
      },
    }));
  }

  const textarea = () =>
    screen.getByRole('textbox', { name: 'Mensagem para o Zylara' }) as HTMLTextAreaElement;

  const historyStatus = () => screen.queryByText(/Mensagem enviada \d+ de \d+/);

  function seedTypicalHistory(): void {
    seedSentMessages([
      sentMessage('u1', 'Primeira pergunta'),
      sentMessage('a1', 'Resposta', { role: 'assistant' }),
      sentMessage('u2', 'Segunda pergunta'),
    ]);
  }

  it('seta para cima carrega a mensagem enviada mais recente', () => {
    seedTypicalHistory();
    render(<Composer />);

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });

    expect(textarea().value).toBe('Segunda pergunta');
    expect(historyStatus()?.textContent).toContain('Mensagem enviada 1 de 2');
  });

  it('repete a seta para cima para a anterior e a seta para baixo volta', () => {
    seedTypicalHistory();
    render(<Composer />);

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    expect(textarea().value).toBe('Primeira pergunta');
    expect(historyStatus()?.textContent).toContain('Mensagem enviada 2 de 2');

    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    expect(textarea().value).toBe('Segunda pergunta');
    expect(historyStatus()?.textContent).toContain('Mensagem enviada 1 de 2');
  });

  it('a seta para baixo após a mais recente restaura o rascunho digitado', () => {
    seedTypicalHistory();
    render(<Composer />);
    typeMessage('Rascunho atual');

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    expect(textarea().value).toBe('Segunda pergunta');

    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
    expect(textarea().value).toBe('Rascunho atual');
    expect(historyStatus()).toBeNull();
  });

  it('Escape restaura o rascunho e encerra a navegação', () => {
    seedTypicalHistory();
    render(<Composer />);
    typeMessage('Rascunho atual');

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    fireEvent.keyDown(textarea(), { key: 'Escape' });

    expect(textarea().value).toBe('Rascunho atual');
    expect(historyStatus()).toBeNull();
  });

  it('ignora respostas do assistente e rodadas automáticas de objetivo', () => {
    seedSentMessages([
      sentMessage('u1', 'Primeira pergunta'),
      sentMessage('a1', 'Resposta', { role: 'assistant' }),
      sentMessage('u2', 'Rodada automática', { origin: 'goal_round' }),
      sentMessage('u3', 'Segunda pergunta'),
    ]);
    render(<Composer />);

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });

    expect(textarea().value).toBe('Primeira pergunta');
    expect(historyStatus()?.textContent).toContain('de 2');
  });

  it('não intercepta a seta para cima quando o cursor não está no início', () => {
    seedTypicalHistory();
    render(<Composer />);
    typeMessage('linha 1\nlinha 2');
    textarea().setSelectionRange(8, 8);

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });

    expect(textarea().value).toBe('linha 1\nlinha 2');
    expect(historyStatus()).toBeNull();
  });

  it('não intercepta as setas com modificadores nem a seta para baixo no rascunho', () => {
    seedTypicalHistory();
    render(<Composer />);

    fireEvent.keyDown(textarea(), { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(textarea(), { key: 'ArrowUp', metaKey: true });
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });

    expect(textarea().value).toBe('');
    expect(historyStatus()).toBeNull();
  });

  it('mantém a navegação do menu de comandos com as setas', () => {
    seedTypicalHistory();
    render(<Composer />);
    typeMessage('/');

    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' });

    expect(textarea().value).toBe('/');
    expect(historyStatus()).toBeNull();
  });

  it('trocar de conversa restaura o rascunho e encerra a navegação', () => {
    seedTypicalHistory();
    render(<Composer />);
    typeMessage('Rascunho atual');
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
    expect(textarea().value).toBe('Segunda pergunta');

    act(() => {
      useChatStore.setState({
        activeId: 'conv-other',
        conversations: [chatConversation('conv-other')],
      });
    });

    expect(textarea().value).toBe('Rascunho atual');
    expect(historyStatus()).toBeNull();
  });

  it('limpa a navegação depois de enviar a mensagem recuperada', async () => {
    seedTypicalHistory();
    const send = vi.spyOn(useChatStore.getState(), 'send').mockResolvedValue(true);
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' });

    fireEvent.click(sendButton());
    await waitFor(() => expect(send).toHaveBeenCalledWith('Segunda pergunta', undefined));

    expect(textarea().value).toBe('');
    expect(historyStatus()).toBeNull();
  });
});
