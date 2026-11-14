// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  AgentInput,
  Artifact,
  AttachmentInfo,
  ChatMessage,
  Conversation,
  ConversationDetail,
  SubagentLiveState,
  TurnPayload,
  TurnEvent,
} from '@/lib/types';

const mocks = vi.hoisted(() => {
  const api = {
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    getConversation: vi.fn(),
    getCacheStats: vi.fn(),
    notifyDesktop: vi.fn().mockResolvedValue(true),
    listActiveTurns: vi.fn(),
    listTurnEvents: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    setConversationPinned: vi.fn(),
    reorderConversations: vi.fn(),
    setConversationCodeLinked: vi.fn(),
    setConversationModel: vi.fn(),
    searchConversations: vi.fn(),
    truncateConversation: vi.fn(),
    importAttachments: vi.fn(),
    importClipboardAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    listArtifacts: vi.fn(),
    runTurn: vi.fn(),
    cancelTurn: vi.fn(),
    getCodeSessionState: vi.fn(),
    goalCanContinue: vi.fn(),
    updateGoal: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    updateAgent: vi.fn(),
    setProviderKey: vi.fn(),
    getCatalog: vi.fn(),
    refreshCatalog: vi.fn(),
    appInfo: vi.fn(),
    validateProvider: vi.fn(),
  };
  return { api };
});

vi.mock('@/lib/api', () => ({ api: mocks.api }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// Imported after the mocks above.
import { useMessageQueueStore } from '@/lib/store/messageQueueStore';
import { useAgentStore } from '@/lib/store/agentStore';
import { useAppStore } from '@/lib/store/appStore';
import {
  useChatStore,
  selectActiveConversationStarted,
  modelLockReason,
  notificationsAllowed,
} from '@/lib/store/chatStore';
import { emptyCodeSession, useCodeStore } from '@/lib/store/codeStore';
import { useUiStore } from '@/lib/store/uiStore';
import { catalog } from '@/lib/catalog';
import { toast } from 'sonner';
import type { GoalView } from '@/lib/types';

const busSeqByTurn = new Map<string, number>();
/** Mirrors the Tauri bus envelope for a turn started by this renderer. */
function emitBus(payload: TurnPayload, event: TurnEvent) {
  const turnId = payload.turnId!;
  const seq = (busSeqByTurn.get(turnId) ?? 0) + 1;
  busSeqByTurn.set(turnId, seq);
  useChatStore.getState().handleTurnEvent({
    turnId,
    seq,
    conversationId: payload.conversationId,
    event,
  });
}

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  title: 'Nova conversa',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  pinned: false,
  providerId: 'opencode-go',
  modelId: 'deepseek-v4.1-flash',
  messageCount: 0,
  ...overrides,
});

const agentRecord = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  name: 'Irineu',
  role: 'Engenheiro',
  description: '',
  avatar: { kind: 'emoji', value: '🛠️', shape: 'rounded' },
  department: 'Engenharia',
  pinned: false,
  sortOrder: 1,
  providerId: 'opencode-go',
  modelId: 'deepseek-v4.1-flash',
  reasoning: null,
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
  threadCount: 2,
  lastActiveAt: 2,
  ...overrides,
});

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Explique MCP',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 1,
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Resposta final',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 2,
    ...overrides,
  };
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    conversationId: 'conv-1',
    messageId: 'assistant-1',
    name: 'relatorio.md',
    mimeType: 'text/markdown',
    kind: 'markdown',
    size: 120,
    createdAt: 1,
    ...overrides,
  };
}

function resetStores(): void {
  useChatStore.setState({
    conversations: [],
    conversationsLoading: false,
    activeId: null,
    activeIdByLayout: { chat: null, code: null, agent: null },
    messagesByConversation: {},
    loadingConversationId: null,
    streamsByConversation: {},
    streaming: null,
    pendingAttachments: [],
    error: null,
  });
  useUiStore.setState({ artifacts: [], layoutMode: 'chat' });
  useCodeStore.setState({ byConversation: {} });
  useMessageQueueStore.setState({ byConversation: {}, pausedByConversation: {} });
  useAgentStore.setState({
    agentsById: {},
    orderedIds: [],
    status: 'idle',
    error: null,
    mutationById: {},
    initialized: false,
  });
  useAppStore.setState({
    providers: [],
    selection: {
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
      reasoning: { mode: 'effort', effort: 'max' },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
  mocks.api.listConversations.mockResolvedValue([]);
  mocks.api.listActiveTurns.mockResolvedValue([]);
  mocks.api.listTurnEvents.mockResolvedValue([]);
  mocks.api.getConversation.mockResolvedValue(undefined);
  mocks.api.getCacheStats.mockResolvedValue(null);
  mocks.api.listArtifacts.mockResolvedValue([]);
  mocks.api.renameConversation.mockResolvedValue(undefined);
  mocks.api.deleteConversation.mockResolvedValue(undefined);
  mocks.api.setConversationPinned.mockResolvedValue(undefined);
  mocks.api.truncateConversation.mockResolvedValue(undefined);
  mocks.api.cancelTurn.mockResolvedValue(true);
  mocks.api.createConversation.mockResolvedValue(conversation());
  mocks.api.getCodeSessionState.mockResolvedValue({
    conversationId: 'conv-1',
    permissionMode: 'edit',
    planMode: false,
    todos: [],
    jobs: [],
    approvals: [],
  });
  mocks.api.goalCanContinue.mockResolvedValue({ ok: false, reason: 'no_goal' });
  mocks.api.saveSettings.mockResolvedValue({
    settings: useAppStore.getState().settings,
    keys: [],
  });
  mocks.api.updateAgent.mockImplementation(async (id: string, input: AgentInput) =>
    agentRecord({ id, ...input }),
  );
  mocks.api.setConversationModel.mockImplementation(
    async (conversationId: string, providerId: string, modelId: string) =>
      conversation({ id: conversationId, providerId, modelId, messageCount: 2 }),
  );
  mocks.api.updateGoal.mockResolvedValue({
    conversationId: 'conv-1',
    permissionMode: 'edit',
    planMode: false,
    todos: [],
    jobs: [],
    approvals: [],
    goal: null,
  });
});

describe('chatStore.send', () => {
  it('creates a conversation, streams events and finalizes the assistant message', async () => {
    const payloads: TurnPayload[] = [];
    mocks.api.listConversations.mockResolvedValue([
      conversation({ title: 'O que é MCP', messageCount: 2 }),
    ]);

    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        payloads.push(payload);
        emitBus(payload, { type: 'turn_started', turnId: payload.turnId!, userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'reasoning_delta', delta: 'pensando…' });
        emitBus(payload, { type: 'reasoning_done' });
        emitBus(payload, { type: 'text_delta', delta: 'Olá ' });
        emitBus(payload, { type: 'text_delta', delta: 'mundo' });
        emitBus(payload, {
          type: 'tool_call_started',
          toolCall: { id: 'tool-1', name: 'web_search', arguments: '', status: 'running' },
        });
        emitBus(payload, { type: 'tool_call_args', id: 'tool-1', delta: '{"query":"mcp"}' });
        emitBus(payload, {
          type: 'tool_call_finished',
          id: 'tool-1',
          status: 'done',
          result: 'ok',
          summary: '1 resultado',
          citations: [{ id: 'cit-1', title: 'MCP', url: 'https://modelcontextprotocol.io' }],
        });
        emitBus(payload, { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } });
        emitBus(payload, { type: 'title_updated', conversationId: 'conv-1', title: 'O que é MCP' });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({
            content: 'Olá mundo',
            reasoning: 'pensando…',
            toolCalls: [
              {
                id: 'tool-1',
                name: 'web_search',
                arguments: '{"query":"mcp"}',
                result: 'ok',
                status: 'done' as const,
                summary: '1 resultado',
              },
            ],
            citations: [{ id: 'cit-1', title: 'MCP', url: 'https://modelcontextprotocol.io' }],
            usage: { inputTokens: 10, outputTokens: 5 },
          }),
          usage: { inputTokens: 10, outputTokens: 5 },
          error: null,
          conversation: conversation({ title: 'O que é MCP', messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Explique MCP');

    await vi.waitFor(() => {
      expect(useChatStore.getState().streaming).toBeNull();
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      conversationId: 'conv-1',
      content: 'Explique MCP',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
      reasoning: { mode: 'effort', effort: 'max' },
    });
    expect(payloads[0].turnId).toBeTruthy();

    const state = useChatStore.getState();
    expect(state.activeId).toBe('conv-1');
    expect(state.pendingAttachments).toEqual([]);

    const messages = state.messagesByConversation['conv-1'];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: 'user-1', role: 'user', content: 'Explique MCP' });
    expect(messages[1]).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Olá mundo',
      reasoning: 'pensando…',
      status: 'complete',
    });
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls[0]).toMatchObject({
      id: 'tool-1',
      status: 'done',
      arguments: '{"query":"mcp"}',
    });
    expect(messages[1].citations.map((citation) => citation.url)).toEqual([
      'https://modelcontextprotocol.io',
    ]);
    await vi.waitFor(() => {
      expect(useChatStore.getState().conversations[0]?.title).toBe('O que é MCP');
    });
  });

  it('uses the server execution timestamps for live tool durations', async () => {
    mocks.api.listConversations.mockResolvedValue([
      conversation({ title: 'Timestamps', messageCount: 2 }),
    ]);
    let executingStartedAt: number | null = null;
    let finishedAt: number | null = null;

    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, {
          type: 'tool_call_started',
          toolCall: {
            id: 'tool-1',
            name: 'read_file',
            arguments: '',
            status: 'running',
            startedAt: 1,
          },
        });
        emitBus(payload, { type: 'tool_call_executing', id: 'tool-1', startedAt: 1_000 });
        executingStartedAt =
          useChatStore
            .getState()
            .messagesByConversation['conv-1']
            ?.find((message) => message.id === 'assistant-1')
            ?.toolCalls.find((tool) => tool.id === 'tool-1')?.startedAt ?? null;
        emitBus(payload, {
          type: 'tool_call_finished',
          id: 'tool-1',
          status: 'done',
          result: 'ok',
          finishedAt: 2_500,
        });
        finishedAt =
          useChatStore
            .getState()
            .messagesByConversation['conv-1']
            ?.find((message) => message.id === 'assistant-1')
            ?.toolCalls.find((tool) => tool.id === 'tool-1')?.finishedAt ?? null;
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'ok' }),
          usage: { inputTokens: 1, outputTokens: 1 },
          error: null,
          conversation: conversation({ title: 'Timestamps', messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
    expect(executingStartedAt).toBe(1_000);
    expect(finishedAt).toBe(2_500);
  });

  const streamedAssistant = () =>
    useChatStore.getState().messagesByConversation['conv-1'][1];

  it('separa a narração de passos consecutivos no streaming', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'text_delta', delta: 'Primeiro.' });
        emitBus(payload, { type: 'step_started', step: 2 });
        emitBus(payload, { type: 'text_delta', delta: 'Segundo.' });
        await gate;
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Final.' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => expect(streamedAssistant().content).toBe('Primeiro.\n\nSegundo.'));
    expect(streamedAssistant().content.startsWith('\n')).toBe(false);

    release();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
    // O texto persistido continua sendo o resultado autoritativo do turno.
    expect(streamedAssistant().content).toBe('Final.');
  });

  it('não insere separador no primeiro passo', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'text_delta', delta: 'Primeiro.' });
        await gate;
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Primeiro.' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => expect(streamedAssistant().content).toBe('Primeiro.'));
    expect(streamedAssistant().content.startsWith('\n')).toBe(false);
    release();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
  });

  it('passo sem texto não deixa separador sobrando', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'text_delta', delta: 'Primeiro.' });
        // Passo intermediário sem narração: a fronteira fica pendente e o
        // próximo texto recebe exatamente um separador. Delta vazio não
        // consome a fronteira.
        emitBus(payload, { type: 'step_started', step: 2 });
        emitBus(payload, { type: 'text_delta', delta: '' });
        emitBus(payload, { type: 'step_started', step: 3 });
        emitBus(payload, { type: 'text_delta', delta: 'Segundo.' });
        await gate;
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Primeiro.\n\nSegundo.' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => expect(streamedAssistant().content).toBe('Primeiro.\n\nSegundo.'));
    expect(streamedAssistant().content.match(/\n\n/g)).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
  });

  it('cancelado preserva a narração separada e o status', async () => {
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'text_delta', delta: 'Primeiro.' });
        emitBus(payload, { type: 'step_started', step: 2 });
        emitBus(payload, { type: 'text_delta', delta: 'Segundo.' });
        emitBus(payload, { type: 'cancelled' });
        return {
          userMessage: userMessage(),
          // O backend guarda só o último passo em cancelamento; a tela não
          // pode perder a narração anterior já visível.
          assistantMessage: assistantMessage({ content: 'Segundo.', status: 'cancelled' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => expect(streamedAssistant().status).toBe('cancelled'));
    expect(streamedAssistant().content).toBe('Primeiro.\n\nSegundo.');
  });

  it('erro preserva a narração separada e o status coerente', async () => {
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'text_delta', delta: 'Primeiro.' });
        emitBus(payload, { type: 'step_started', step: 2 });
        emitBus(payload, { type: 'text_delta', delta: 'Segundo.' });
        emitBus(payload, { type: 'error', message: 'gateway falhou', code: 'PROVIDER_ERROR' });
        return {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Segundo.' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => expect(streamedAssistant().status).toBe('complete'));
    expect(streamedAssistant().content).toBe('Primeiro.\n\nSegundo.');
    expect(useChatStore.getState().error).toContain('gateway falhou');
  });

  it('records an error and keeps partial content when the turn rejects', async () => {
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, { type: 'turn_started', turnId: 'turn-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' });
        emitBus(payload, { type: 'text_delta', delta: 'parcial' });
        throw new Error('gateway fora do ar');
      },
    );

    await useChatStore.getState().send('Oi');
    await vi.waitFor(() => {
      expect(useChatStore.getState().streaming).toBeNull();
    });

    const state = useChatStore.getState();
    const assistant = state.messagesByConversation['conv-1'][1];
    expect(assistant.content).toBe('parcial');
    expect(assistant.status).toBe('complete');
    expect(state.error).toContain('gateway fora do ar');
  });

  it('builds the thinking trace incrementally while the turn streams', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 1 });
        emitBus(payload, { type: 'reasoning_delta', delta: 'Vou pesquisar.' });
        emitBus(payload, { type: 'reasoning_done' });
        emitBus(payload, {
          type: 'tool_call_started',
          toolCall: { id: 'tool-1', name: 'web_search', arguments: '', status: 'running' },
        });
        await gate;
        emitBus(payload, {
          type: 'tool_call_finished',
          id: 'tool-1',
          status: 'done',
          result: '{"results":[]}',
          summary: '0 resultados',
        });
        emitBus(payload, { type: 'step_started', step: 2 });
        emitBus(payload, { type: 'reasoning_delta', delta: 'Concluído.' });
        emitBus(payload, { type: 'reasoning_done' });
        const trace = [
          { reasoning: 'Vou pesquisar.', toolCalls: 1 },
          { reasoning: 'Concluído.', toolCalls: 0 },
        ];
        const finalMessage = assistantMessage({
          reasoning: 'Vou pesquisar.Concluído.',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'web_search',
              arguments: '',
              result: '{"results":[]}',
              status: 'done' as const,
              summary: '0 resultados',
            },
          ],
          trace,
        });
        const result = {
          userMessage: userMessage(),
          assistantMessage: finalMessage,
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'message_updated', message: finalMessage });
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Pesquise');

    // While the turn is held open, the first step is already on the timeline.
    const streamingMessage = useChatStore.getState().messagesByConversation['conv-1'][1];
    expect(streamingMessage.status).toBe('streaming');
    expect(streamingMessage.trace).toEqual([{ reasoning: 'Vou pesquisar.', toolCalls: 1 }]);

    release();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    const finalMessage = useChatStore.getState().messagesByConversation['conv-1'][1];
    expect(finalMessage.trace).toEqual([
      { reasoning: 'Vou pesquisar.', toolCalls: 1 },
      { reasoning: 'Concluído.', toolCalls: 0 },
    ]);
  });
});

describe('chatStore.regenerate', () => {
  it('truncates the last assistant message and streams a replacement without duplicating the user message', async () => {
    useChatStore.setState({
      conversations: [conversation({ messageCount: 2 })],
      activeId: 'conv-1',
      messagesByConversation: {
        'conv-1': [userMessage(), assistantMessage()],
      },
    });

    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, { type: 'turn_started', turnId: payload.turnId!, userMessageId: 'user-1', assistantMessageId: 'assistant-2' });
        emitBus(payload, { type: 'text_delta', delta: 'nova resposta' });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ id: 'assistant-2', content: 'nova resposta' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().regenerate();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    expect(mocks.api.truncateConversation).toHaveBeenCalledWith('conv-1', 'assistant-1');
    const messages = useChatStore.getState().messagesByConversation['conv-1'];
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages[1].content).toBe('nova resposta');
  });
});

describe('chatStore.resumeMessage', () => {
  const resumeState = {
    version: 1,
    turnId: 'turn-old',
    step: 2,
    turnKind: 'user' as const,
    profile: 'chat' as const,
    reason: 'provider_error' as const,
    detail: 'gateway indisponível',
    reasoning: null,
    options: { webSearch: true, createFiles: true, runCode: true },
    stopContinuations: 0,
    updatedAt: 10,
  };

  it('continues the interrupted message at the next step without touching the transcript', async () => {
    const interrupted = assistantMessage({
      id: 'assistant-1',
      content: 'Narração do passo 1',
      status: 'error',
      error: { message: 'gateway indisponível', retryable: true, attempts: 2 },
      resumeState,
      toolCalls: [
        {
          id: 'call-1',
          name: 'list_skills',
          arguments: '{}',
          result: 'ok',
          status: 'done' as const,
        },
      ],
    });
    useChatStore.setState({
      conversations: [conversation({ messageCount: 2 })],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [userMessage(), interrupted] },
      streamsByConversation: {},
      streaming: null,
      error: 'gateway indisponível',
    });

    let seen: TurnPayload | null = null;
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        seen = payload;
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'step_started', step: 3 });
        emitBus(payload, { type: 'text_delta', delta: 'Concluído.' });
        const final = assistantMessage({ id: 'assistant-1', content: 'Concluído.' });
        const result = {
          userMessage: userMessage(),
          assistantMessage: final,
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'message_updated', message: final });
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    const started = await useChatStore.getState().resumeMessage('assistant-1');
    expect(started).toBe(true);
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    // Same row, same tool cards: nothing was truncated or duplicated.
    const messages = useChatStore.getState().messagesByConversation['conv-1'];
    expect(messages).toHaveLength(2);
    expect(messages[1].id).toBe('assistant-1');
    expect(messages[1].content).toBe('Concluído.');
    expect(mocks.api.truncateConversation).not.toHaveBeenCalled();

    expect(seen).not.toBeNull();
    expect(seen!.resumeAssistantMessageId).toBe('assistant-1');
    expect(seen!.turnKind).toBe('user');
    expect(seen!.content).toBe('Explique MCP');
  });

  it('does nothing without a resume point or while another turn streams', async () => {
    useChatStore.setState({
      conversations: [conversation({ messageCount: 2 })],
      activeId: 'conv-1',
      messagesByConversation: {
        'conv-1': [userMessage(), assistantMessage({ id: 'assistant-1' })],
      },
      streamsByConversation: {},
      streaming: null,
    });
    expect(await useChatStore.getState().resumeMessage('assistant-1')).toBe(false);

    useChatStore.setState({
      messagesByConversation: {
        'conv-1': [
          userMessage(),
          assistantMessage({ id: 'assistant-1', resumeState }),
        ],
      },
      streaming: {
        turnId: 'turn-live',
        conversationId: 'conv-1',
        assistantId: 'assistant-1',
        userMessageId: 'user-1',
        phase: 'text',
        step: 1,
        startedAt: Date.now(),
        turnKind: 'user',
      },
    });
    expect(await useChatStore.getState().resumeMessage('assistant-1')).toBe(false);
    expect(mocks.api.runTurn).not.toHaveBeenCalled();
  });
});

describe('chatStore other actions', () => {
  it('stop() cancels the active turn', async () => {
    useChatStore.setState({
      streaming: {
        turnId: 'turn-9',
        conversationId: 'conv-1',
        assistantId: 'assistant-1',
        userMessageId: 'user-1',
        phase: 'text',
        step: 1,
        startedAt: Date.now(),
        turnKind: 'user',
      },
    });
    await useChatStore.getState().stop();
    expect(mocks.api.cancelTurn).toHaveBeenCalledWith('turn-9');
  });

  it('stopConversation cancels a background thread and keeps the visible one', async () => {
    const background = {
      turnId: 'turn-bg',
      conversationId: 'conv-bg',
      assistantId: 'assistant-bg',
      userMessageId: null,
      phase: 'tool' as const,
      step: 2,
      startedAt: Date.now(),
      turnKind: 'user' as const,
    };
    const visible = {
      turnId: 'turn-visible',
      conversationId: 'conv-1',
      assistantId: 'assistant-1',
      userMessageId: null,
      phase: 'text' as const,
      step: 1,
      startedAt: Date.now(),
      turnKind: 'user' as const,
    };
    useChatStore.setState({
      activeId: 'conv-1',
      streamsByConversation: { 'conv-bg': background, 'conv-1': visible },
      streaming: visible,
    });

    await useChatStore.getState().stopConversation('conv-bg');

    expect(mocks.api.cancelTurn).toHaveBeenCalledWith('turn-bg');
    expect(useChatStore.getState().streaming?.turnId).toBe('turn-visible');
    expect(useChatStore.getState().streamsByConversation['conv-1']).toBeTruthy();
  });

  it('openConversation loads messages and artifacts', async () => {
    const detail: ConversationDetail = {
      conversation: conversation({ messageCount: 2 }),
      messages: [userMessage(), assistantMessage()],
    };
    mocks.api.getConversation.mockResolvedValue(detail);
    mocks.api.listArtifacts.mockResolvedValue([
      {
        id: 'artifact-1',
        conversationId: 'conv-1',
        name: 'relatorio.md',
        mimeType: 'text/markdown',
        kind: 'markdown',
        size: 120,
        createdAt: 1,
      },
    ]);

    await useChatStore.getState().openConversation('conv-1');

    expect(useChatStore.getState().messagesByConversation['conv-1']).toHaveLength(2);
    expect(useUiStore.getState().artifacts).toHaveLength(1);
    expect(useUiStore.getState().artifacts[0].name).toBe('relatorio.md');
  });

  it('keeps the live agent execution details when reopening a streaming conversation', async () => {
    const liveConversation = conversation({
      id: 'conv-1',
      mode: 'agent',
      agentId: 'agent-1',
      messageCount: 2,
    });
    const otherConversation = conversation({ id: 'conv-2', title: 'Outra thread' });
    const liveAssistant = assistantMessage({
      id: 'assistant-live',
      conversationId: 'conv-1',
      content: '',
      reasoning: 'Vou ler o arquivo.',
      status: 'streaming',
      trace: [{ reasoning: 'Vou ler o arquivo.', toolCalls: 1 }],
      toolCalls: [
        {
          id: 'call-1',
          name: 'read_file',
          arguments: '{"path":"src/app.ts"}',
          result: null,
          status: 'running',
          startedAt: 1,
          finishedAt: null,
        },
      ],
    });
    const liveStream = {
      turnId: 'turn-live',
      conversationId: 'conv-1',
      assistantId: 'assistant-live',
      userMessageId: 'user-live',
      phase: 'tool' as const,
      step: 1,
      startedAt: 1,
      turnKind: 'user' as const,
      subagents: {},
    };
    useChatStore.setState({
      conversations: [liveConversation, otherConversation],
      activeId: 'conv-2',
      activeIdByLayout: { chat: null, code: null, agent: 'conv-2' },
      messagesByConversation: {
        'conv-1': [userMessage({ id: 'user-live', conversationId: 'conv-1' }), liveAssistant],
        'conv-2': [userMessage({ id: 'user-other', conversationId: 'conv-2' })],
      },
      streamsByConversation: { 'conv-1': liveStream },
      streaming: null,
    });
    useUiStore.setState({ layoutMode: 'agent' });
    // The stream is live in the backend: opening the thread must keep the
    // in-memory execution details instead of treating it as a stale row.
    mocks.api.listActiveTurns.mockResolvedValue([
      { turnId: 'turn-live', conversationId: 'conv-1', startedAt: 1 },
    ]);
    // The persisted row is still the empty checkpoint placeholder: reloading it
    // would erase reasoning/tool steps that only exist in the live stream.
    mocks.api.getConversation.mockResolvedValue({
      conversation: liveConversation,
      messages: [
        userMessage({ id: 'user-live', conversationId: 'conv-1' }),
        assistantMessage({
          id: 'assistant-live',
          conversationId: 'conv-1',
          content: '',
          reasoning: null,
          status: 'streaming',
          trace: [],
        }),
      ],
    });

    await useChatStore.getState().openConversation('conv-1');

    expect(mocks.api.getConversation).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeId).toBe('conv-1');
    expect(useChatStore.getState().streaming?.turnId).toBe('turn-live');
    const assistant = useChatStore
      .getState()
      .messagesByConversation['conv-1'].find((message) => message.id === 'assistant-live');
    expect(assistant?.trace).toEqual([{ reasoning: 'Vou ler o arquivo.', toolCalls: 1 }]);
    expect(assistant?.toolCalls).toHaveLength(1);
  });

  it('does not overwrite messages persisted while the conversation was reloading', async () => {
    const loadingConversation = conversation({ id: 'conv-1', messageCount: 2 });
    const staleAssistant = assistantMessage({
      id: 'assistant-live',
      conversationId: 'conv-1',
      content: '',
      reasoning: null,
      status: 'streaming',
      trace: [],
    });
    const finalAssistant = assistantMessage({
      id: 'assistant-live',
      conversationId: 'conv-1',
      content: 'Resposta final',
      reasoning: 'Pensei no problema.',
      status: 'complete',
      trace: [{ reasoning: 'Pensei no problema.', toolCalls: 1 }],
    });
    useChatStore.setState({
      conversations: [loadingConversation, conversation({ id: 'conv-2' })],
      activeId: 'conv-2',
      messagesByConversation: {
        'conv-2': [userMessage({ id: 'user-2', conversationId: 'conv-2' })],
      },
    });
    let resolveDetail!: (value: ConversationDetail) => void;
    mocks.api.getConversation.mockReturnValue(
      new Promise<ConversationDetail>((resolve) => {
        resolveDetail = resolve;
      }),
    );

    const opening = useChatStore.getState().openConversation('conv-1');
    // The turn finishes (and persists its trace) before the fetch resolves.
    useChatStore.setState((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        'conv-1': [
          userMessage({ id: 'user-live', conversationId: 'conv-1' }),
          finalAssistant,
        ],
      },
    }));
    resolveDetail?.({
      conversation: loadingConversation,
      messages: [
        userMessage({ id: 'user-live', conversationId: 'conv-1' }),
        staleAssistant,
      ],
    });
    await opening;

    const messages = useChatStore.getState().messagesByConversation['conv-1'];
    expect(messages.find((message) => message.id === 'assistant-live')?.content).toBe(
      'Resposta final',
    );
    expect(messages.find((message) => message.id === 'assistant-live')?.trace).toEqual([
      { reasoning: 'Pensei no problema.', toolCalls: 1 },
    ]);
  });

  it('deleteConversation removes the conversation and clears its messages', async () => {
    useChatStore.setState({
      conversations: [conversation()],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [userMessage()] },
    });
    await useChatStore.getState().deleteConversation('conv-1');
    expect(useChatStore.getState().conversations).toHaveLength(0);
    expect(useChatStore.getState().messagesByConversation['conv-1']).toBeUndefined();
  });

  it('ships the DeepSeek V4.1 Flash model in the bundled catalog', () => {
    const go = catalog.providers.find((provider) => provider.id === 'opencode-go');
    expect(go?.models.some((model) => model.id === 'deepseek-v4.1-flash')).toBe(true);
  });

  it('reorderConversations updates positions and persists', async () => {
    const first = conversation({ id: 'a', updatedAt: 20 });
    const second = conversation({ id: 'b', updatedAt: 10 });
    useChatStore.setState({ conversations: [first, second] });
    mocks.api.reorderConversations.mockResolvedValue(undefined);

    await useChatStore.getState().reorderConversations(['b', 'a']);

    expect(mocks.api.reorderConversations).toHaveBeenCalledWith(['b', 'a']);
    expect(useChatStore.getState().conversations.map((item) => item.id)).toEqual(['b', 'a']);
    expect(useChatStore.getState().conversations[0].sortOrder).toBe(0);
  });

  it('reorderConversations reverts and refreshes when the backend fails', async () => {
    const first = conversation({ id: 'a', updatedAt: 20 });
    const second = conversation({ id: 'b', updatedAt: 10 });
    useChatStore.setState({ conversations: [first, second] });
    mocks.api.reorderConversations.mockRejectedValue(new Error('falhou'));
    mocks.api.listConversations.mockResolvedValue([first, second]);

    await useChatStore.getState().reorderConversations(['b', 'a']);

    expect(toast.error).toHaveBeenCalledWith(
      'Não foi possível reordenar as conversas',
      expect.anything(),
    );
    expect(useChatStore.getState().conversations.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('chatStore artifact change detection', () => {
  it('adds artifact events only for the active conversation, in canonical order', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, { type: 'artifact_created', artifact: artifact({ id: 'late', createdAt: 20 }) });
        emitBus(payload, { type: 'artifact_created', artifact: artifact({ id: 'early', createdAt: 10 }) });
        // A background turn of another conversation must not leak into this chat.
        emitBus(payload, {
          type: 'artifact_created',
          artifact: artifact({ id: 'foreign', conversationId: 'conv-2', createdAt: 5 }),
        });
        await gate;
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage(),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );
    mocks.api.listArtifacts.mockResolvedValue([
      artifact({ id: 'early', createdAt: 10 }),
      artifact({ id: 'late', createdAt: 20 }),
    ]);

    void useChatStore.getState().send('Crie dois arquivos');
    await vi.waitFor(() => expect(useUiStore.getState().artifacts).toHaveLength(2));
    expect(useUiStore.getState().artifacts.map((entry) => entry.id)).toEqual(['early', 'late']);

    release();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
    expect(useUiStore.getState().artifacts.map((entry) => entry.id)).toEqual(['early', 'late']);
  });

  it('reconciles with the backend when the turn finishes, recovering missed events', async () => {
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage(),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        // No `artifact_created` event at all: only the authoritative resync
        // can reveal the artifact.
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );
    mocks.api.listArtifacts.mockResolvedValue([artifact({ id: 'only-on-disk' })]);

    await useChatStore.getState().send('Crie um arquivo');

    await vi.waitFor(() => {
      expect(useUiStore.getState().artifacts.map((entry) => entry.id)).toEqual(['only-on-disk']);
    });
    expect(mocks.api.listArtifacts).toHaveBeenCalledWith('conv-1');
  });

  it('refreshes the artifacts when reopening the cached active conversation', async () => {
    useChatStore.setState({
      conversations: [conversation({ messageCount: 2 })],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [userMessage(), assistantMessage()] },
    });
    mocks.api.listArtifacts.mockResolvedValue([
      artifact({ id: 'a1', createdAt: 1 }),
      artifact({ id: 'a2', createdAt: 2 }),
    ]);

    await useChatStore.getState().openConversation('conv-1');

    expect(mocks.api.getConversation).not.toHaveBeenCalled();
    expect(mocks.api.listArtifacts).toHaveBeenCalledWith('conv-1');
    expect(useUiStore.getState().artifacts.map((entry) => entry.id)).toEqual(['a1', 'a2']);
  });

  it('drops a sync result when the user switched conversations meanwhile', async () => {
    useChatStore.setState({ activeId: 'conv-1' });
    let resolveList: (value: Artifact[]) => void = () => {};
    mocks.api.listArtifacts.mockReturnValue(
      new Promise<Artifact[]>((resolve) => {
        resolveList = resolve;
      }),
    );

    const pending = useChatStore.getState().syncArtifacts();
    useChatStore.setState({ activeId: 'conv-2' });
    resolveList([artifact({ id: 'stale' })]);
    await pending;

    expect(useUiStore.getState().artifacts).toEqual([]);
  });

  it('keeps the newest result when two synchronizations overlap', async () => {
    useChatStore.setState({ activeId: 'conv-1' });
    let resolveFirst: (value: Artifact[]) => void = () => {};
    let resolveSecond: (value: Artifact[]) => void = () => {};
    mocks.api.listArtifacts
      .mockReturnValueOnce(
        new Promise<Artifact[]>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<Artifact[]>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const first = useChatStore.getState().syncArtifacts();
    const second = useChatStore.getState().syncArtifacts();
    resolveSecond([artifact({ id: 'newer', createdAt: 2 })]);
    resolveFirst([artifact({ id: 'older', createdAt: 1 })]);
    await Promise.all([first, second]);

    expect(useUiStore.getState().artifacts.map((entry) => entry.id)).toEqual(['newer']);
  });

  it('clears the panel artifacts when the last conversation is deleted', async () => {
    useChatStore.setState({
      conversations: [conversation()],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [userMessage()] },
    });
    useUiStore.setState({
      artifacts: [artifact()],
      activeArtifactId: 'artifact-1',
      artifactPanelOpen: true,
      artifactPanelView: 'preview',
    });

    await useChatStore.getState().deleteConversation('conv-1');

    expect(useUiStore.getState().artifacts).toEqual([]);
    expect(useUiStore.getState().artifactPanelOpen).toBe(false);
  });
});

describe('model lock', () => {
  const streamingState = (conversationId: string): NonNullable<ReturnType<typeof useChatStore.getState>['streaming']> => ({
    turnId: 'turn-1',
    conversationId,
    assistantId: 'assistant-1',
    userMessageId: 'user-1',
    phase: 'text',
    step: 1,
    startedAt: Date.now(),
    turnKind: 'user',
  });

  it('locks Chat conversations once started and during a turn', () => {
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBeNull();

    useChatStore.setState({
      activeId: 'conv-1',
      conversations: [conversation({ messageCount: 0 })],
      messagesByConversation: { 'conv-1': [] },
    });
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBeNull();

    useChatStore.setState({ messagesByConversation: { 'conv-1': [userMessage()] } });
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBe('started');

    // The conversation list alone already says the conversation started.
    useChatStore.setState({
      messagesByConversation: {},
      conversations: [conversation({ messageCount: 2 })],
    });
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBe('started');

    // A running turn also locks the model (empty conversation fixture).
    useChatStore.setState({
      messagesByConversation: {},
      conversations: [conversation({ messageCount: 0 })],
      streaming: streamingState('conv-1'),
    });
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBe('streaming');
  });

  it('unlocks model switching for Code sessions in the Code layout, except while streaming', () => {
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [conversation({ id: 'code-1', mode: 'code', messageCount: 2 })],
      messagesByConversation: { 'code-1': [userMessage(), assistantMessage()] },
      streaming: null,
    });
    expect(modelLockReason(useChatStore.getState(), 'code')).toBeNull();
    // The same conversation seen from the Chat layout keeps the Chat rules.
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBe('started');

    // Shared (codeLinked) sessions follow the Code layout where they appear.
    useChatStore.setState({
      conversations: [
        conversation({ id: 'code-1', mode: 'chat', codeLinked: true, messageCount: 2 }),
      ],
    });
    expect(modelLockReason(useChatStore.getState(), 'code')).toBeNull();
    expect(modelLockReason(useChatStore.getState(), 'chat')).toBe('started');

    // A running turn always locks the selector (the model is already resolved).
    useChatStore.setState({ streaming: streamingState('code-1') });
    expect(modelLockReason(useChatStore.getState(), 'code')).toBe('streaming');
  });

  it('selectActiveConversationStarted tracks messages regardless of layout', () => {
    expect(selectActiveConversationStarted(useChatStore.getState())).toBe(false);
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [conversation({ id: 'code-1', mode: 'code', messageCount: 0 })],
      messagesByConversation: { 'code-1': [] },
    });
    expect(selectActiveConversationStarted(useChatStore.getState())).toBe(false);
    useChatStore.setState({
      conversations: [conversation({ id: 'code-1', mode: 'code', messageCount: 3 })],
    });
    expect(selectActiveConversationStarted(useChatStore.getState())).toBe(true);
  });

  it('chooseModel persists the pair of a started Code session without changing the defaults', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [
        conversation({
          id: 'code-1',
          mode: 'code',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          messageCount: 2,
        }),
      ],
      messagesByConversation: {
        'code-1': [
          userMessage({ conversationId: 'code-1' }),
          assistantMessage({ conversationId: 'code-1' }),
        ],
      },
    });
    const next = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      reasoning: { mode: 'effort' as const, effort: 'high' as const },
    };
    mocks.api.setConversationModel.mockResolvedValue(
      conversation({
        id: 'code-1',
        mode: 'code',
        providerId: next.providerId,
        modelId: next.modelId,
        messageCount: 2,
      }),
    );

    await expect(useChatStore.getState().chooseModel(next)).resolves.toBe(true);

    expect(mocks.api.setConversationModel).toHaveBeenCalledWith(
      'code-1',
      'anthropic',
      'claude-sonnet-5-5',
    );
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      reasoning: next.reasoning,
    });
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
    });
    // Session-level change: the configured default for new chats is untouched.
    expect(mocks.api.saveSettings).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('chooseModel only updates the thinking mode when the session keeps the same route', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [
        conversation({
          id: 'code-1',
          mode: 'code',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          messageCount: 2,
        }),
      ],
      messagesByConversation: { 'code-1': [userMessage(), assistantMessage()] },
    });

    await expect(
      useChatStore.getState().chooseModel({
        providerId: 'opencode-go',
        modelId: 'deepseek-v4.1-flash',
        reasoning: { mode: 'effort', effort: 'low' },
      }),
    ).resolves.toBe(true);

    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'low',
    });
    expect(mocks.api.saveSettings).not.toHaveBeenCalled();
  });

  it('chooseModel keeps the old behavior for a new/empty Code session (defaults)', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [conversation({ id: 'code-1', mode: 'code', messageCount: 0 })],
      messagesByConversation: { 'code-1': [] },
    });

    await expect(
      useChatStore
        .getState()
        .chooseModel({ providerId: 'anthropic', modelId: 'claude-haiku-5-5', reasoning: null }),
    ).resolves.toBe(true);

    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-haiku-5-5',
    });
    await vi.waitFor(() => {
      expect(mocks.api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultProvider: 'anthropic',
          defaultModel: 'claude-haiku-5-5',
        }),
      );
    });
  });

  it('chooseModel refuses to bypass the Chat lock', async () => {
    useChatStore.setState({
      activeId: 'conv-1',
      conversations: [conversation({ messageCount: 2 })],
      messagesByConversation: { 'conv-1': [userMessage()] },
    });

    await expect(
      useChatStore
        .getState()
        .chooseModel({ providerId: 'opencode-go', modelId: 'glm-5.3-flash', reasoning: null }),
    ).resolves.toBe(false);

    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
    expect(useAppStore.getState().selection.modelId).toBe('deepseek-v4.1-flash');
    expect(toast.info).toHaveBeenCalled();
  });

  it('chooseModel reverts the optimistic selection when the backend rejects', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [
        conversation({
          id: 'code-1',
          mode: 'code',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          messageCount: 2,
        }),
      ],
      messagesByConversation: { 'code-1': [userMessage(), assistantMessage()] },
    });
    mocks.api.setConversationModel.mockRejectedValue(
      new Error('MODEL_LOCKED: aguarde a resposta atual terminar'),
    );

    await expect(
      useChatStore
        .getState()
        .chooseModel({ providerId: 'anthropic', modelId: 'claude-sonnet-5-5', reasoning: null }),
    ).resolves.toBe(false);

    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
    });
    expect(toast.error).toHaveBeenCalledWith('Não foi possível alterar o modelo', {
      description: 'aguarde a resposta atual terminar',
    });
  });

  it('chooseModel refuses to switch while a turn is streaming', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [
        conversation({
          id: 'code-1',
          mode: 'code',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          messageCount: 2,
        }),
      ],
      messagesByConversation: { 'code-1': [userMessage(), assistantMessage()] },
      streaming: streamingState('code-1'),
    });

    await expect(
      useChatStore
        .getState()
        .chooseModel({ providerId: 'anthropic', modelId: 'claude-sonnet-5-5', reasoning: null }),
    ).resolves.toBe(false);

    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
    });
    expect(toast.info).toHaveBeenCalledWith('Aguarde a resposta atual terminar', {
      description: 'A troca de modelo fica disponível quando a resposta atual terminar.',
    });
  });

  it('keeps the Chat lock for a Chat-native session even in the Code layout', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'chat-1',
      conversations: [conversation({ id: 'chat-1', mode: 'chat', messageCount: 2 })],
      messagesByConversation: { 'chat-1': [userMessage(), assistantMessage()] },
    });

    expect(modelLockReason(useChatStore.getState(), 'code')).toBe('started');
    await expect(
      useChatStore
        .getState()
        .chooseModel({ providerId: 'opencode-go', modelId: 'glm-5.3-flash', reasoning: null }),
    ).resolves.toBe(false);
    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
  });

  it('chooseModel on the Agents home updates the persona route', async () => {
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    useAgentStore.setState({
      agentsById: { 'agent-1': agentRecord() },
      orderedIds: ['agent-1'],
    });
    useChatStore.setState({ activeId: null, conversations: [] });
    const next = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      reasoning: { mode: 'effort' as const, effort: 'high' as const },
    };

    await expect(useChatStore.getState().chooseModel(next)).resolves.toBe(true);

    expect(mocks.api.updateAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining(next),
    );
    expect(useAgentStore.getState().agentsById['agent-1']).toMatchObject(next);
    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
    // The agent owns the route: the global defaults stay untouched.
    expect(useAppStore.getState().selection.modelId).toBe('deepseek-v4.1-flash');
    expect(mocks.api.saveSettings).not.toHaveBeenCalled();
  });

  it('chooseModel keeps an empty agent thread in sync with the persona edit', async () => {
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    useAgentStore.setState({
      agentsById: { 'agent-1': agentRecord() },
      orderedIds: ['agent-1'],
    });
    const thread = conversation({
      id: 'agent-thread',
      mode: 'agent',
      agentId: 'agent-1',
      messageCount: 0,
    });
    useChatStore.setState({
      activeId: thread.id,
      conversations: [thread],
      messagesByConversation: { [thread.id]: [] },
    });
    const next = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      reasoning: { mode: 'effort' as const, effort: 'high' as const },
    };
    mocks.api.setConversationModel.mockResolvedValue({
      ...thread,
      providerId: next.providerId,
      modelId: next.modelId,
    });

    await expect(useChatStore.getState().chooseModel(next)).resolves.toBe(true);

    expect(mocks.api.updateAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining(next),
    );
    expect(mocks.api.setConversationModel).toHaveBeenCalledWith(
      'agent-thread',
      'anthropic',
      'claude-sonnet-5-5',
    );
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
    });
  });

  it('chooseModel refuses to switch the route of a started agent thread', async () => {
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    useAgentStore.setState({
      agentsById: { 'agent-1': agentRecord() },
      orderedIds: ['agent-1'],
    });
    const thread = conversation({
      id: 'agent-thread',
      mode: 'agent',
      agentId: 'agent-1',
      messageCount: 2,
    });
    useChatStore.setState({
      activeId: thread.id,
      conversations: [thread],
      messagesByConversation: {
        [thread.id]: [userMessage({ conversationId: thread.id }), assistantMessage({ conversationId: thread.id })],
      },
    });

    await expect(
      useChatStore
        .getState()
        .chooseModel({ providerId: 'anthropic', modelId: 'claude-sonnet-5-5', reasoning: null }),
    ).resolves.toBe(false);

    expect(mocks.api.updateAgent).not.toHaveBeenCalled();
    expect(mocks.api.setConversationModel).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalled();
  });

  it('setReasoning updates the persona while the agent model is locked', async () => {
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1' });
    useAgentStore.setState({
      agentsById: {
        'agent-1': agentRecord({ reasoning: { mode: 'effort', effort: 'high' } }),
      },
      orderedIds: ['agent-1'],
    });
    const thread = conversation({
      id: 'agent-thread',
      mode: 'agent',
      agentId: 'agent-1',
      messageCount: 2,
    });
    useChatStore.setState({
      activeId: thread.id,
      conversations: [thread],
      messagesByConversation: {
        [thread.id]: [userMessage({ conversationId: thread.id })],
      },
    });

    useChatStore.getState().setReasoning({ mode: 'off' });

    await vi.waitFor(() => {
      expect(useAgentStore.getState().agentsById['agent-1'].reasoning).toEqual({ mode: 'off' });
    });
    expect(mocks.api.updateAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ reasoning: { mode: 'off' } }),
    );
    // The global chat selection is not the source of truth for agent turns.
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'max',
    });
  });

  it('send uses the composer selection of a started Code session (model unlocked)', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      conversations: [
        conversation({
          id: 'code-1',
          mode: 'code',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          messageCount: 2,
        }),
      ],
      messagesByConversation: {
        'code-1': [
          userMessage({ conversationId: 'code-1' }),
          assistantMessage({ conversationId: 'code-1' }),
        ],
      },
    });
    useAppStore.setState({
      selection: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-5-5',
        reasoning: { mode: 'effort', effort: 'high' },
      },
    });

    const payloads: TurnPayload[] = [];
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        payloads.push(payload);
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
        });
        const result = {
          userMessage: userMessage({ id: 'user-2', conversationId: 'code-1' }),
          assistantMessage: assistantMessage({ id: 'assistant-2', conversationId: 'code-1' }),
          usage: null,
          error: null,
          conversation: conversation({
            id: 'code-1',
            mode: 'code',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-5-5',
            messageCount: 4,
          }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('continua');
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    expect(payloads[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      profile: 'code',
    });
  });

  it('syncs the active selection to the conversation model when opening a started conversation', async () => {
    mocks.api.getConversation.mockResolvedValue({
      conversation: conversation({
        providerId: 'opencode-go',
        modelId: 'glm-5.3-flash',
        messageCount: 2,
      }),
      messages: [userMessage(), assistantMessage()],
    });

    await useChatStore.getState().openConversation('conv-1');

    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'glm-5.3-flash',
    });
  });

  it('syncs the selection for an account-only model when reopening a started Code session', async () => {
    const baseProvider = catalog.providers.find((provider) => provider.id === 'openai');
    expect(baseProvider).toBeTruthy();
    const accountModel = {
      ...baseProvider!.models[0],
      id: 'gpt-account-only',
      name: 'GPT Conta',
    };
    useAppStore.setState({
      providers: [
        { ...baseProvider!, models: [accountModel, ...baseProvider!.models] },
        ...catalog.providers.filter((provider) => provider.id !== 'openai'),
      ],
    });
    mocks.api.getConversation.mockResolvedValue({
      conversation: conversation({
        id: 'code-1',
        mode: 'code',
        providerId: 'openai',
        modelId: 'gpt-account-only',
        messageCount: 2,
      }),
      messages: [userMessage(), assistantMessage()],
    });
    useUiStore.setState({ layoutMode: 'code' });

    await useChatStore.getState().openConversation('code-1');

    // The merged view (catalog + account-only models) must resolve the session
    // pair; the static catalog alone would leave the composer on a stale model.
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-account-only',
    });
  });

  it('does not change the selection when opening an empty conversation', async () => {
    mocks.api.getConversation.mockResolvedValue({
      conversation: conversation({
        providerId: 'opencode-zen',
        modelId: 'gpt-6-luna',
        messageCount: 0,
      }),
      messages: [],
    });

    await useChatStore.getState().openConversation('conv-2');

    expect(useAppStore.getState().selection.modelId).toBe('deepseek-v4.1-flash');
  });

  it('startNewConversation resets the composer to the configured defaults after a started conversation', async () => {
    useChatStore.setState({
      activeId: 'conv-1',
      conversations: [conversation({ messageCount: 2 })],
      messagesByConversation: { 'conv-1': [userMessage(), assistantMessage()] },
    });
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        defaultProvider: 'opencode-go',
        defaultModel: 'glm-5.3-flash',
        reasoningDefault: 'high',
      },
    });
    mocks.api.createConversation.mockResolvedValue(
      conversation({ id: 'conv-2', title: 'Nova conversa', messageCount: 0 }),
    );

    await useChatStore.getState().startNewConversation();

    expect(useAppStore.getState().selection).toEqual({
      providerId: 'opencode-go',
      modelId: 'glm-5.3-flash',
      reasoning: { mode: 'effort', effort: 'high' },
    });
  });

  it('keeps the current selection when starting a new chat from the welcome screen', async () => {
    useAppStore.setState({
      selection: {
        providerId: 'opencode-go',
        modelId: 'qwen3.8-flash',
        reasoning: { mode: 'effort', effort: 'low' },
      },
    });
    mocks.api.createConversation.mockResolvedValue(
      conversation({ id: 'conv-3', title: 'Nova conversa', messageCount: 0 }),
    );

    await useChatStore.getState().startNewConversation();

    expect(useAppStore.getState().selection.modelId).toBe('qwen3.8-flash');
  });

  it('send keeps the conversation model even if the global selection was mutated', async () => {
    useChatStore.setState({
      activeId: 'conv-1',
      conversations: [conversation({ messageCount: 2 })],
      messagesByConversation: { 'conv-1': [userMessage(), assistantMessage()] },
    });
    // Simulates any surface bypassing the UI lock.
    useAppStore.setState({
      selection: {
        providerId: 'opencode-go',
        modelId: 'glm-5.3-flash',
        reasoning: { mode: 'effort', effort: 'low' },
      },
    });

    const payloads: TurnPayload[] = [];
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        payloads.push(payload);
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
        });
        const result = {
          userMessage: userMessage({ id: 'user-2' }),
          assistantMessage: assistantMessage({ id: 'assistant-2', content: 'ok' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 4 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('continua');
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    expect(payloads[0]).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
    });
  });

  it('regenerate keeps the conversation model even if the global selection was mutated', async () => {
    useChatStore.setState({
      activeId: 'conv-1',
      conversations: [conversation({ messageCount: 2 })],
      messagesByConversation: { 'conv-1': [userMessage(), assistantMessage()] },
    });
    useAppStore.setState({
      selection: {
        providerId: 'opencode-go',
        modelId: 'glm-5.3-flash',
        reasoning: { mode: 'effort', effort: 'low' },
      },
    });

    const payloads: TurnPayload[] = [];
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        payloads.push(payload);
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-2',
        });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ id: 'assistant-2', content: 'nova' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().regenerate();
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    expect(payloads[0]).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
    });
  });
});

describe('chatStore — sessões separadas Chat/Code', () => {
  it('init opens the first session visible in the persisted layout', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    mocks.api.listConversations.mockResolvedValue([
      conversation({ id: 'chat-1', mode: 'chat' }),
      conversation({ id: 'code-1', mode: 'code' }),
    ]);
    mocks.api.getConversation.mockResolvedValue({
      conversation: conversation({ id: 'code-1', mode: 'code' }),
      messages: [],
    });

    await useChatStore.getState().init();

    expect(mocks.api.getConversation).toHaveBeenCalledWith('code-1');
    expect(useChatStore.getState().activeId).toBe('code-1');
  });

  it('enterLayout restores each layout session and never leaks the other one', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'chat-1', mode: 'chat' })],
      activeId: 'chat-1',
      activeIdByLayout: { chat: 'chat-1', code: null, agent: null },
      messagesByConversation: { 'chat-1': [] },
    });

    useUiStore.setState({ layoutMode: 'code' });
    await useChatStore.getState().enterLayout('code');

    expect(useChatStore.getState().activeId).toBeNull();
    expect(useChatStore.getState().activeIdByLayout).toEqual({
      chat: 'chat-1',
      code: null,
      agent: null,
    });

    useUiStore.setState({ layoutMode: 'chat' });
    await useChatStore.getState().enterLayout('chat');

    expect(useChatStore.getState().activeId).toBe('chat-1');
  });

  it('enterLayout can share a Chat session that was added to Code', async () => {
    const shared = conversation({ id: 'shared-1', mode: 'chat', codeLinked: true });
    useChatStore.setState({
      conversations: [shared],
      activeId: null,
      activeIdByLayout: { chat: null, code: 'shared-1', agent: null },
      messagesByConversation: { 'shared-1': [] },
    });
    mocks.api.getConversation.mockResolvedValue({ conversation: shared, messages: [] });

    useUiStore.setState({ layoutMode: 'code' });
    await useChatStore.getState().enterLayout('code');

    expect(useChatStore.getState().activeId).toBe('shared-1');
  });

  it('startNewConversation creates the session in the requested mode', async () => {
    mocks.api.createConversation.mockResolvedValue(conversation({ id: 'code-new', mode: 'code' }));

    await useChatStore.getState().startNewConversation('code');

    expect(mocks.api.createConversation).toHaveBeenCalledWith(
      'Nova conversa',
      'opencode-go',
      'deepseek-v4.1-flash',
      'code',
    );
    expect(useChatStore.getState().activeId).toBe('code-new');
    expect(useChatStore.getState().activeIdByLayout.code).toBe('code-new');
  });

  it('sending without an active session creates it in the current layout mode', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    mocks.api.createConversation.mockResolvedValue(conversation({ id: 'code-send', mode: 'code' }));
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ id: 'assistant-2' }),
          usage: null,
          error: null,
          conversation: conversation({ id: 'code-send', mode: 'code' }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('inicia no Code');
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());

    expect(mocks.api.createConversation).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'code',
    );
  });

  it('enterLayout restores the session without closing the current layout page', async () => {
    const chat = conversation({ id: 'chat-1', mode: 'chat' });
    const code = conversation({ id: 'code-1', mode: 'code' });
    useChatStore.setState({
      conversations: [chat, code],
      activeId: 'code-1',
      activeIdByLayout: { chat: 'chat-1', code: 'code-1', agent: null },
      messagesByConversation: { 'chat-1': [], 'code-1': [] },
    });
    useUiStore.setState({ layoutMode: 'chat', activeView: 'library', codeView: 'session' });
    mocks.api.getConversation.mockResolvedValue({ conversation: chat, messages: [] });

    await useChatStore.getState().enterLayout('chat');

    expect(useChatStore.getState().activeId).toBe('chat-1');
    // Switching layouts must not close the Biblioteca/Skills page (R1).
    expect(useUiStore.getState().activeView).toBe('library');
  });

  it('enterLayout preserves the Code Skills page while restoring its session', async () => {
    const chat = conversation({ id: 'chat-1', mode: 'chat' });
    const code = conversation({ id: 'code-1', mode: 'code' });
    useChatStore.setState({
      conversations: [chat, code],
      activeId: 'chat-1',
      activeIdByLayout: { chat: 'chat-1', code: 'code-1', agent: null },
      messagesByConversation: { 'chat-1': [], 'code-1': [] },
    });
    useUiStore.setState({ layoutMode: 'code', codeView: 'skills', activeView: 'chat' });
    mocks.api.getConversation.mockResolvedValue({ conversation: code, messages: [] });

    await useChatStore.getState().enterLayout('code');

    expect(useChatStore.getState().activeId).toBe('code-1');
    expect(useUiStore.getState().codeView).toBe('skills');
  });

  it('enterLayout records the shared session in the layout memory even without reloading it', async () => {
    const shared = conversation({ id: 'shared-1', mode: 'chat', codeLinked: true });
    useChatStore.setState({
      conversations: [shared],
      activeId: 'shared-1',
      activeIdByLayout: { chat: null, code: null, agent: null },
      messagesByConversation: { 'shared-1': [] },
    });
    useUiStore.setState({ layoutMode: 'code' });

    await useChatStore.getState().enterLayout('code');

    expect(useChatStore.getState().activeId).toBe('shared-1');
    expect(useChatStore.getState().activeIdByLayout.code).toBe('shared-1');
  });

  it('setConversationCodeLinked updates the conversation and returns false on failure', async () => {
    useChatStore.setState({
      conversations: [conversation({ id: 'chat-1', mode: 'chat', codeLinked: false })],
    });
    mocks.api.setConversationCodeLinked.mockResolvedValue(
      conversation({ id: 'chat-1', mode: 'chat', codeLinked: true }),
    );

    await expect(
      useChatStore.getState().setConversationCodeLinked('chat-1', true),
    ).resolves.toBe(true);
    expect(useChatStore.getState().conversations[0]?.codeLinked).toBe(true);

    mocks.api.setConversationCodeLinked.mockRejectedValue(new Error('falhou'));
    await expect(
      useChatStore.getState().setConversationCodeLinked('chat-1', false),
    ).resolves.toBe(false);
  });

  it('clearActiveConversation clears the current layout session only', () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      activeId: 'code-1',
      activeIdByLayout: { chat: 'chat-1', code: 'code-1', agent: null },
    });

    useChatStore.getState().clearActiveConversation();

    expect(useChatStore.getState().activeId).toBeNull();
    expect(useChatStore.getState().activeIdByLayout).toEqual({
      chat: 'chat-1',
      code: null,
      agent: null,
    });
  });

  it('deleteConversation falls back to a session visible in the current layout', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      conversations: [
        conversation({ id: 'code-1', mode: 'code' }),
        conversation({ id: 'chat-1', mode: 'chat' }),
      ],
      activeId: 'code-1',
      messagesByConversation: { 'code-1': [] },
    });
    mocks.api.deleteConversation.mockResolvedValue(undefined);

    await useChatStore.getState().deleteConversation('code-1');

    // There is no other Code session: the Code layout goes back to its welcome
    // instead of opening the Chat session.
    expect(useChatStore.getState().activeId).toBeNull();
    expect(useChatStore.getState().conversations.map((entry) => entry.id)).toEqual(['chat-1']);
  });
});

describe('chatStore — rodadas do objetivo (Goal)', () => {
  const goal = (overrides: Partial<GoalView> = {}): GoalView => ({
    title: 'Objetivo',
    objective: 'Concluir a refatoração.',
    status: 'active',
    autoContinue: true,
    rounds: 1,
    maxRounds: 25,
    revision: 2,
    origin: 'user',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

  function seedGoalSession(goalValue: GoalView = goal()): void {
    useUiStore.setState({ layoutMode: 'code' });
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', mode: 'code' })],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [] },
    });
    useCodeStore.setState({
      byConversation: {
        'conv-1': { ...emptyCodeSession('conv-1'), goal: goalValue },
      },
    });
  }

  function doneEvent(): TurnEvent {
    const result = {
      userMessage: userMessage(),
      assistantMessage: assistantMessage({ content: 'ok' }),
      usage: null,
      error: null,
      conversation: conversation({ id: 'conv-1', mode: 'code' }),
    };
    return { type: 'done', result };
  }

  it('runGoalRound inicia um turno goal_round com conteúdo vazio e origem', async () => {
    seedGoalSession();
    const payloads: TurnPayload[] = [];
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        payloads.push(payload);
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, doneEvent());
        return { userMessage: userMessage(), assistantMessage: assistantMessage() };
      },
    );
    mocks.api.getCodeSessionState.mockResolvedValue({
      conversationId: 'conv-1',
      permissionMode: 'edit',
      planMode: false,
      goal: goal(),
      todos: [],
      jobs: [],
      approvals: [],
    });

    const ok = await useChatStore.getState().runGoalRound('conv-1');

    expect(ok).toBe(true);
    expect(payloads[0]).toMatchObject({
      conversationId: 'conv-1',
      content: '',
      profile: 'code',
      turnKind: 'goal_round',
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
    });
  });

  it('done continua o objetivo uma vez quando ativo e armado', async () => {
    seedGoalSession();
    mocks.api.listConversations.mockResolvedValue([
      conversation({ id: 'conv-1', mode: 'code', messageCount: 2 }),
    ]);
    const payloads: TurnPayload[] = [];
    mocks.api.getCodeSessionState.mockResolvedValue({
      conversationId: 'conv-1',
      permissionMode: 'edit',
      planMode: false,
      goal: goal(),
      todos: [],
      jobs: [],
      approvals: [],
    });
    // O primeiro preflight autoriza; o segundo (após a rodada) encerra o teste.
    mocks.api.goalCanContinue
      .mockResolvedValueOnce({ ok: true, goal: goal() })
      .mockResolvedValue({ ok: false, reason: 'completed' });
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        payloads.push(payload);
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, doneEvent());
        return { userMessage: userMessage(), assistantMessage: assistantMessage() };
      },
    );

    await useChatStore.getState().send('Vamos começar');
    await vi.waitFor(() => expect(payloads).toHaveLength(2), { timeout: 2000 });

    expect(payloads[0].turnKind).toBe('user');
    expect(payloads[1]).toMatchObject({ turnKind: 'goal_round', content: '' });
  });

  it('não continua com continuidade manual ou orçamento esgotado', async () => {
    for (const pausedGoal of [
      goal({ autoContinue: false }),
      goal({ rounds: 25 }),
    ]) {
      vi.clearAllMocks();
      seedGoalSession(pausedGoal);
      mocks.api.getCodeSessionState.mockResolvedValue({
        conversationId: 'conv-1',
        permissionMode: 'edit',
        planMode: false,
        goal: pausedGoal,
        todos: [],
        jobs: [],
        approvals: [],
      });
      mocks.api.goalCanContinue.mockResolvedValue({ ok: false, reason: 'not_armed' });
      const payloads: TurnPayload[] = [];
      mocks.api.runTurn.mockImplementation(
        async (payload: TurnPayload) => {
          payloads.push(payload);
          emitBus(payload, {
            type: 'turn_started',
            turnId: payload.turnId!,
            userMessageId: 'user-1',
            assistantMessageId: 'assistant-1',
          });
          emitBus(payload, doneEvent());
          return { userMessage: userMessage(), assistantMessage: assistantMessage() };
        },
      );

      await useChatStore.getState().send('Oi');
      await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
      expect(payloads).toHaveLength(1);
      expect(mocks.api.goalCanContinue).not.toHaveBeenCalled();
    }
  });

  it('stop() de uma rodada do objetivo pausa a continuidade automática', async () => {
    seedGoalSession();
    useChatStore.setState({
      streaming: {
        turnId: 'turn-goal',
        conversationId: 'conv-1',
        assistantId: 'assistant-1',
        userMessageId: 'user-1',
        phase: 'text',
        step: 1,
        startedAt: Date.now(),
        turnKind: 'goal_round',
      },
    });

    await useChatStore.getState().stop();

    expect(mocks.api.cancelTurn).toHaveBeenCalledWith('turn-goal');
    expect(mocks.api.updateGoal).toHaveBeenCalledWith('conv-1', 'pause', null, 2);
  });

  it('tracks the live subagent transcript while the parent task runs', async () => {
    useChatStore.setState({
      conversations: [conversation()],
      activeId: 'conv-1',
      activeIdByLayout: { chat: null, code: 'conv-1', agent: null },
    });
    let live: SubagentLiveState | undefined;
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, {
          type: 'subagent_started',
          taskCallId: 'task-1',
          conversationId: 'child-1',
          subagentType: 'explore',
          description: 'Mapear src',
          prompt: 'Mapeie src e responda',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          effort: 'high',
        });
        emitBus(payload, {
          type: 'subagent_event',
          taskCallId: 'task-1',
          event: { type: 'step_started', step: 2 },
        });
        emitBus(payload, {
          type: 'subagent_event',
          taskCallId: 'task-1',
          event: { type: 'text_delta', delta: 'Achei src/app.ts' },
        });
        emitBus(payload, {
          type: 'subagent_event',
          taskCallId: 'task-1',
          event: {
            type: 'tool_call_started',
            toolCall: {
              id: 'child-tool-1',
              name: 'read_file',
              arguments: '{"path":"src/app.ts"}',
              status: 'running',
              result: null,
            },
          },
        });
        live = useChatStore.getState().streaming?.subagents?.['task-1'];
        emitBus(payload, {
          type: 'subagent_finished',
          taskCallId: 'task-1',
          conversationId: 'child-1',
          status: 'done',
          durationMs: 42,
          usage: { totalTokens: 120 },
        });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Concluído' }),
          usage: null,
          error: null,
          conversation: conversation(),
        };
        emitBus(payload, {
          type: 'done',
          result,
        });
        return result;
      },
    );

    await useChatStore.getState().send('Delegue a exploração');

    expect(live).toMatchObject({
      conversationId: 'child-1',
      status: 'running',
      steps: 2,
      prompt: 'Mapeie src e responda',
      text: 'Achei src/app.ts',
      effort: 'high',
    });
    expect(live?.trace.length).toBe(1);
    expect(live?.trace[0]).toMatchObject({ toolCalls: 1 });
    expect(live?.toolCalls[0]).toMatchObject({ name: 'read_file', status: 'running' });
    expect(useChatStore.getState().streaming).toBeNull();
  });
});

describe('chatStore — concorrência entre agentes', () => {
  it('mantém dois turnos simultâneos e drena a fila da thread em segundo plano', async () => {
    const pending: Array<{
      payload: TurnPayload;
      finish: (content: string) => void;
    }> = [];
    mocks.api.runTurn.mockImplementation(
      (payload: TurnPayload) =>
        new Promise((resolve) => {
          pending.push({
            payload,
            finish: (content) => {
              emitBus(payload, {
                type: 'turn_started',
                turnId: payload.turnId!,
                userMessageId: `user-${payload.conversationId}`,
                assistantMessageId: `assistant-${payload.conversationId}`,
              });
              const result = {
                userMessage: userMessage({
                  id: `user-${payload.conversationId}`,
                  conversationId: payload.conversationId,
                }),
                assistantMessage: assistantMessage({
                  id: `assistant-${payload.conversationId}`,
                  conversationId: payload.conversationId,
                  content,
                }),
                usage: null,
                error: null,
                conversation: conversation({
                  id: payload.conversationId,
                  mode: 'agent',
                  agentId: 'agent-1',
                  title: `Conversa ${payload.conversationId}`,
                }),
              };
              emitBus(payload, { type: 'done', result });
              resolve(result);
            },
          });
        }),
    );

    useAgentStore.setState({
      agentsById: { 'agent-1': agentRecord() },
      orderedIds: ['agent-1'],
      status: 'ready',
      error: null,
      mutationById: {},
      initialized: true,
    });
    useChatStore.setState({
      conversations: [
        conversation({ id: 'conv-1', mode: 'agent', agentId: 'agent-1', title: 'Primeira' }),
        conversation({ id: 'conv-2', mode: 'agent', agentId: 'agent-1', title: 'Segunda' }),
      ],
      activeId: 'conv-1',
      activeIdByLayout: { chat: null, code: null, agent: 'conv-1' },
      messagesByConversation: { 'conv-1': [], 'conv-2': [] },
    });
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1', activeChannelId: null });

    await useChatStore.getState().send('primeira mensagem');
    expect(pending).toHaveLength(1);
    expect(useChatStore.getState().streamsByConversation['conv-1']).toBeTruthy();

    // Second message to the same thread waits in its FIFO.
    await useChatStore.getState().send('mensagem na fila');
    expect(pending).toHaveLength(1);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);

    // The user moves to another agent thread; it starts its own turn while the
    // first one keeps running in the background.
    useChatStore.setState({
      activeId: 'conv-2',
      streaming: null,
      activeIdByLayout: { chat: null, code: null, agent: 'conv-2' },
    });
    await useChatStore.getState().send('outra thread');

    expect(pending).toHaveLength(2);
    expect(pending.map((turn) => turn.payload.conversationId).sort()).toEqual([
      'conv-1',
      'conv-2',
    ]);
    expect(Object.keys(useChatStore.getState().streamsByConversation).sort()).toEqual([
      'conv-1',
      'conv-2',
    ]);
    expect(useChatStore.getState().streaming?.conversationId).toBe('conv-2');

    // Finishing the visible thread must not clear the background stream.
    pending[1].finish('resposta da segunda');
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
    expect(useChatStore.getState().streamsByConversation['conv-1']).toBeTruthy();

    // Finishing the background thread drains its own queue immediately, even
    // though the visible thread is idle.
    pending[0].finish('resposta da primeira');
    await vi.waitFor(() => expect(pending).toHaveLength(3), { timeout: 2000 });
    expect(pending[2].payload.conversationId).toBe('conv-1');
    expect(pending[2].payload.content).toBe('mensagem na fila');
    expect(useChatStore.getState().streamsByConversation['conv-1']).toBeTruthy();
    expect(useChatStore.getState().streaming).toBeNull();

    pending[2].finish('resposta da fila');
    await vi.waitFor(() =>
      expect(useChatStore.getState().streamsByConversation['conv-1']).toBeUndefined(),
    );
  });
});

describe('chatStore — notificações por categoria', () => {
  it('respeita DND, o master switch e cada categoria', () => {
    const base = useAppStore.getState().settings;
    useAppStore.setState({ settings: { ...base, notificationsEnabled: true, notificationsDnd: true } });
    expect(notificationsAllowed('turn_complete')).toBe(false);
    useAppStore.setState({ settings: { ...base, notificationsDnd: false } });
    expect(notificationsAllowed('turn_complete')).toBe(true);
    useAppStore.setState({ settings: { ...base, notificationsCompletions: false } });
    expect(notificationsAllowed('turn_complete')).toBe(false);
    expect(notificationsAllowed('approval_requested')).toBe(true);
    useAppStore.setState({ settings: { ...base, notificationsEnabled: false } });
    expect(notificationsAllowed('approval_requested')).toBe(false);
  });
});

describe('chatStore — reattach de turnos', () => {  it('reconstrói um turno ativo a partir dos eventos persistidos', async () => {
    const activeConversation = conversation({ id: 'conv-1', title: 'Reattach', messageCount: 2 });
    mocks.api.listActiveTurns.mockResolvedValue([
      { turnId: 'turn-reattach', conversationId: 'conv-1', startedAt: 1 },
    ]);
    mocks.api.getConversation.mockResolvedValue({
      conversation: activeConversation,
      messages: [
        userMessage({ id: 'user-1' }),
        assistantMessage({ id: 'assistant-1', content: '', status: 'streaming' }),
      ],
    });
    const result = {
      userMessage: userMessage({ id: 'user-1' }),
      assistantMessage: assistantMessage({ id: 'assistant-1', content: 'Resposta final' }),
      usage: null,
      error: null,
      conversation: activeConversation,
    };
    mocks.api.listTurnEvents.mockResolvedValue([
      {
        turnId: 'turn-reattach',
        seq: 1,
        event: {
          type: 'turn_started',
          turnId: 'turn-reattach',
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        },
      },
      {
        turnId: 'turn-reattach',
        seq: 2,
        event: { type: 'text_delta', delta: 'Resposta ' },
      },
      { turnId: 'turn-reattach', seq: 3, event: { type: 'done', result } },
    ]);
    useChatStore.setState({
      conversations: [activeConversation],
      activeId: 'conv-1',
      messagesByConversation: {},
      streamsByConversation: {},
      streaming: null,
    });

    await useChatStore.getState().reattachTurns();

    const messages = useChatStore.getState().messagesByConversation['conv-1'] ?? [];
    expect(messages.find((message) => message.id === 'assistant-1')?.content).toBe(
      'Resposta final',
    );
    expect(useChatStore.getState().streamsByConversation['conv-1']).toBeUndefined();
    expect(useChatStore.getState().streaming).toBeNull();
  });

  it('não duplica o checkpoint já salvo ao reaplicar os eventos do turno', async () => {
    const activeConversation = conversation({
      id: 'conv-checkpoint',
      title: 'Checkpoint',
      messageCount: 2,
    });
    mocks.api.listActiveTurns.mockResolvedValue([
      { turnId: 'turn-checkpoint', conversationId: 'conv-checkpoint', startedAt: 1 },
    ]);
    mocks.api.getConversation.mockResolvedValue({
      conversation: activeConversation,
      messages: [
        userMessage({ id: 'user-checkpoint', conversationId: 'conv-checkpoint' }),
        assistantMessage({
          id: 'assistant-checkpoint',
          conversationId: 'conv-checkpoint',
          content: 'Texto já salvo',
          reasoning: 'Raciocínio antigo',
          status: 'streaming',
        }),
      ],
    });
    mocks.api.listTurnEvents.mockResolvedValue([
      {
        turnId: 'turn-checkpoint',
        seq: 1,
        event: {
          type: 'turn_started',
          turnId: 'turn-checkpoint',
          userMessageId: 'user-checkpoint',
          assistantMessageId: 'assistant-checkpoint',
        },
      },
      {
        turnId: 'turn-checkpoint',
        seq: 2,
        event: { type: 'reasoning_delta', delta: 'Raciocínio ' },
      },
      {
        turnId: 'turn-checkpoint',
        seq: 3,
        event: { type: 'text_delta', delta: 'Resposta completa' },
      },
    ]);
    useChatStore.setState({
      conversations: [activeConversation],
      activeId: 'conv-checkpoint',
      messagesByConversation: {},
      streamsByConversation: {},
      streaming: null,
    });

    await useChatStore.getState().reattachTurns();

    const messages = useChatStore.getState().messagesByConversation['conv-checkpoint'] ?? [];
    const assistant = messages.find((message) => message.id === 'assistant-checkpoint');
    expect(assistant?.content).toBe('Resposta completa');
    expect(assistant?.reasoning).toBe('Raciocínio ');
    expect(
      useChatStore.getState().streamsByConversation['conv-checkpoint']?.turnId,
    ).toBe('turn-checkpoint');
  });

  it('loads pending session state when opening an agent thread without a selected workspace', async () => {
    const thread = conversation({ id: 'agent-thread', mode: 'agent', agentId: 'agent-1', workspaceId: null });
    mocks.api.getConversation.mockResolvedValue({ conversation: thread, messages: [] });
    useChatStore.setState({ conversations: [thread], activeId: null });
    useUiStore.setState({ layoutMode: 'agent' });

    await useChatStore.getState().openConversation(thread.id);

    expect(mocks.api.getCodeSessionState).toHaveBeenCalledWith(thread.id);
  });

  it('não cria stream fantasma para turnos internos sem eventos', async () => {
    mocks.api.listActiveTurns.mockResolvedValue([
      { turnId: 'task-turn', conversationId: 'conv-task', startedAt: 1 },
    ]);
    mocks.api.listTurnEvents.mockResolvedValue([]);
    mocks.api.getConversation.mockResolvedValue({
      conversation: conversation({ id: 'conv-task', title: 'Tarefa' }),
      messages: [],
    });
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-task', title: 'Tarefa' })],
      activeId: null,
      messagesByConversation: {},
      streamsByConversation: {},
      streaming: null,
    });

    await useChatStore.getState().reattachTurns();

    expect(useChatStore.getState().streamsByConversation['conv-task']).toBeUndefined();
  });
});

describe('chatStore — resiliência do transporte de turno', () => {
  /** One watchdog tick plus a margin (the interval is 2.5 s). */
  const TURN_WATCHDOG_STEP_MS = 2_600;

  it('aplica o bus e finaliza o turno local mesmo com o invoke pendente', async () => {
    const activeConversation = conversation({ id: 'conv-1', messageCount: 0 });
    useChatStore.setState({
      conversations: [activeConversation],
      activeId: 'conv-1',
      messagesByConversation: { 'conv-1': [] },
      streamsByConversation: {},
      streaming: null,
    });
    let payload: TurnPayload | null = null;
    mocks.api.runTurn.mockImplementation((seen: TurnPayload) => {
      payload = seen;
      return new Promise(() => {});
    });
    const final = assistantMessage({ id: 'assistant-1', content: 'Olá mundo.' });

    expect(await useChatStore.getState().send('oi')).toBe(true);
    expect(payload).not.toBeNull();

    emitBus(payload!, { type: 'queued' });
    expect(useChatStore.getState().streaming?.phase).toBe('queued');
    emitBus(payload!, {
      type: 'turn_started',
      turnId: payload!.turnId!,
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
    });
    expect(useChatStore.getState().streaming?.phase).toBe('starting');
    emitBus(payload!, { type: 'text_delta', delta: 'Olá ' });
    emitBus(payload!, { type: 'text_delta', delta: 'mundo.' });
    // The same envelope delivered twice must not duplicate the delta.
    useChatStore.getState().handleTurnEvent({
      turnId: payload!.turnId!,
      seq: 4,
      conversationId: 'conv-1',
      event: { type: 'text_delta', delta: 'mundo.' },
    });

    await vi.waitFor(() => {
      const assistant = useChatStore
        .getState()
        .messagesByConversation['conv-1']
        ?.find((message) => message.id === 'assistant-1');
      expect(assistant?.content).toBe('Olá mundo.');
    });

    emitBus(payload!, {
      type: 'done',
      result: {
        userMessage: userMessage(),
        assistantMessage: final,
        usage: null,
        error: null,
        conversation: conversation({ messageCount: 2 }),
      },
    });

    expect(useChatStore.getState().streaming).toBeNull();
    const settled = useChatStore
      .getState()
      .messagesByConversation['conv-1']
      ?.find((message) => message.id === 'assistant-1');
    expect(settled?.content).toBe('Olá mundo.');
    expect(settled?.status).toBe('complete');
  });

  it('o watchdog finaliza pelo banco quando o turno some do backend', async () => {
    vi.useFakeTimers();
    try {
      const activeConversation = conversation({ id: 'conv-1', messageCount: 0 });
      useChatStore.setState({
        conversations: [activeConversation],
        activeId: 'conv-1',
        messagesByConversation: { 'conv-1': [] },
        streamsByConversation: {},
        streaming: null,
      });
      let payload: TurnPayload | null = null;
      mocks.api.runTurn.mockImplementation((seen: TurnPayload) => {
        payload = seen;
        return new Promise(() => {});
      });
      let polls = 0;
      mocks.api.listActiveTurns.mockImplementation(async () => {
        polls += 1;
        return polls <= 1 && payload
          ? [{ turnId: payload.turnId!, conversationId: 'conv-1', startedAt: 1 }]
          : [];
      });
      const final = assistantMessage({ id: 'assistant-1', content: 'Resposta recuperada.' });
      mocks.api.getConversation.mockResolvedValue({
        conversation: activeConversation,
        messages: [userMessage(), final],
      });

      expect(await useChatStore.getState().send('oi')).toBe(true);
      expect(payload).not.toBeNull();
      // `queued` is the evidence that Rust registered the turn; without any
      // journaled event the watchdog waits for its startup grace period.
      emitBus(payload!, { type: 'queued' });

      await vi.advanceTimersByTimeAsync(TURN_WATCHDOG_STEP_MS);
      await vi.advanceTimersByTimeAsync(TURN_WATCHDOG_STEP_MS);
      await vi.advanceTimersByTimeAsync(TURN_WATCHDOG_STEP_MS);

      expect(useChatStore.getState().streaming).toBeNull();
      const recovered = useChatStore
        .getState()
        .messagesByConversation['conv-1']
        ?.find((message) => message.id === 'assistant-1');
      expect(recovered?.content).toBe('Resposta recuperada.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Stop limpa o stream quando o backend não conhece mais o turno', async () => {
    const streaming = {
      turnId: 'turn-gone',
      conversationId: 'conv-1',
      assistantId: 'assistant-1',
      userMessageId: 'user-1',
      phase: 'text' as const,
      step: 1,
      startedAt: 1,
      turnKind: 'user' as const,
    };
    useChatStore.setState({
      conversations: [conversation()],
      activeId: 'conv-1',
      messagesByConversation: {
        'conv-1': [userMessage(), assistantMessage({ status: 'streaming', content: '' })],
      },
      streamsByConversation: { 'conv-1': streaming },
      streaming,
    });
    mocks.api.cancelTurn.mockResolvedValue(false);

    await useChatStore.getState().stop();

    expect(useChatStore.getState().streaming).toBeNull();
    const assistant = useChatStore
      .getState()
      .messagesByConversation['conv-1']
      ?.find((message) => message.id === 'assistant-1');
    expect(assistant?.status).toBe('cancelled');
  });

  it('abrir uma conversa sem turno ativo descarta o stream órfão', async () => {
    const staleConversation = conversation({ id: 'conv-1', messageCount: 2 });
    const staleAssistant = assistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'streaming',
    });
    const staleStream = {
      turnId: 'turn-stale',
      conversationId: 'conv-1',
      assistantId: 'assistant-1',
      userMessageId: 'user-1',
      phase: 'tool' as const,
      step: 1,
      startedAt: 1,
      turnKind: 'user' as const,
    };
    useChatStore.setState({
      conversations: [staleConversation],
      activeId: 'conv-2',
      messagesByConversation: { 'conv-1': [userMessage(), staleAssistant] },
      streamsByConversation: { 'conv-1': staleStream },
      streaming: null,
    });
    mocks.api.listActiveTurns.mockResolvedValue([]);
    mocks.api.getConversation.mockResolvedValue({
      conversation: staleConversation,
      messages: [userMessage(), staleAssistant],
    });

    await useChatStore.getState().openConversation('conv-1');
    await vi.waitFor(() => {
      expect(useChatStore.getState().streamsByConversation['conv-1']).toBeUndefined();
    });

    const assistant = useChatStore
      .getState()
      .messagesByConversation['conv-1']
      ?.find((message) => message.id === 'assistant-1');
    expect(assistant?.status).toBe('cancelled');
  });
});

describe('chatStore — notificações de agente', () => {
  it('avisa quando um turno de agente termina fora do layout Agentes', async () => {
    const agentConversation = conversation({
      id: 'conv-1',
      mode: 'agent',
      agentId: 'agent-1',
      title: 'Plano trimestral',
    });
    useChatStore.setState({
      conversations: [agentConversation],
      activeId: 'conv-1',
      activeIdByLayout: { chat: 'conv-1', code: null, agent: 'conv-1' },
      messagesByConversation: { 'conv-1': [] },
      streaming: null,
    });
    useUiStore.setState({ layoutMode: 'chat' });
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, notificationsEnabled: true },
    });
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Pronto' }),
          usage: null,
          error: null,
          conversation: agentConversation,
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Resuma o trimestre');

    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Agente concluiu a resposta',
        expect.objectContaining({ description: 'Plano trimestral' }),
      ),
    );
  });
});

describe('chatStore — primary conversation pin', () => {
  it('does not call the backend when the primary is unpinned', async () => {
    useChatStore.setState({
      conversations: [
        conversation({ id: 'conv-1', pinned: true, isMain: true }),
      ],
      activeId: null,
    });

    await useChatStore.getState().togglePinned('conv-1');

    expect(mocks.api.setConversationPinned).not.toHaveBeenCalled();
    const stored = useChatStore.getState().conversations[0];
    expect(stored.pinned).toBe(true);
    expect(stored.isMain).toBe(true);
  });
});

describe('chatStore — clipboard attachments', () => {
  const clipboardAttachment: AttachmentInfo = {
    id: 'att-clipboard',
    name: 'print.png',
    mimeType: 'image/png',
    size: 2048,
    kind: 'image',
  };

  it('appends clipboard attachments to the composer', async () => {
    mocks.api.importClipboardAttachments.mockResolvedValue([clipboardAttachment]);
    useChatStore.setState({ pendingAttachments: [] });

    await useChatStore.getState().importClipboardAttachments();

    expect(useChatStore.getState().pendingAttachments).toEqual([clipboardAttachment]);
  });

  it('keeps the composer untouched and shows a toast on failure', async () => {
    mocks.api.importClipboardAttachments.mockRejectedValue(new Error('sem clipboard'));
    useChatStore.setState({ pendingAttachments: [] });

    await useChatStore.getState().importClipboardAttachments();

    expect(useChatStore.getState().pendingAttachments).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith(
      'Não foi possível colar o anexo',
      expect.objectContaining({ description: expect.stringContaining('sem clipboard') }),
    );
  });
});

describe('chatStore — narração separada por resposta (Code e Agentes)', () => {
  function toolCallStarted(): TurnEvent {
    return {
      type: 'tool_call_started',
      toolCall: {
        id: 'tool-1',
        name: 'edit_file',
        arguments: '{"path":"src/app.ts"}',
        status: 'running',
        result: null,
      },
    };
  }

  function narrationEvents(): TurnEvent[] {
    return [
      { type: 'step_started', step: 1 },
      { type: 'reasoning_delta', delta: 'Vou editar.' },
      { type: 'text_delta', delta: 'Vou alterar o arquivo.' },
      toolCallStarted(),
    ];
  }

  it('move a narração do passo para o trace ao iniciar a tool no layout Code', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    // The mock releases through this holder, so the turn stays gated while the
    // assertions run against the streamed (not yet persisted) message.
    const holder: { release?: () => void } = {};
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        for (const event of narrationEvents()) emitBus(payload, event);
        await new Promise<void>((resolve) => {
          holder.release = resolve;
        });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Final.' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    const sending = useChatStore.getState().send('Oi');
    await vi.waitFor(() => {
      const assistant = useChatStore.getState().messagesByConversation['conv-1']?.[1];
      expect(assistant?.trace?.[0]?.text).toBe('Vou alterar o arquivo.');
    });
    const assistant = useChatStore.getState().messagesByConversation['conv-1'][1];
    expect(assistant.content).toBe('');
    expect(assistant.trace?.[0]).toMatchObject({
      reasoning: 'Vou editar.',
      text: 'Vou alterar o arquivo.',
      toolCalls: 1,
    });

    holder.release?.();
    await sending;
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
    expect(
      useChatStore.getState().messagesByConversation['conv-1'][1].content,
    ).toBe('Final.');
  });

  it('mantém a narração em content no layout Chat', async () => {
    useUiStore.setState({ layoutMode: 'chat' });
    const holder: { release?: () => void } = {};
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        for (const event of narrationEvents()) emitBus(payload, event);
        await new Promise<void>((resolve) => {
          holder.release = resolve;
        });
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Final.' }),
          usage: null,
          error: null,
          conversation: conversation({ messageCount: 2 }),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    const sending = useChatStore.getState().send('Oi');
    await vi.waitFor(() => {
      const assistant = useChatStore.getState().messagesByConversation['conv-1']?.[1];
      expect(assistant?.content).toBe('Vou alterar o arquivo.');
    });
    const assistant = useChatStore.getState().messagesByConversation['conv-1'][1];
    expect(assistant.trace?.[0]?.text ?? null).toBeNull();

    holder.release?.();
    await sending;
    await vi.waitFor(() => expect(useChatStore.getState().streaming).toBeNull());
  });

  it('move a narração do subagente para o trace no layout Code', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    let live: SubagentLiveState | undefined;
    mocks.api.runTurn.mockImplementation(
      async (payload: TurnPayload) => {
        emitBus(payload, {
          type: 'turn_started',
          turnId: payload.turnId!,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
        });
        emitBus(payload, {
          type: 'subagent_started',
          taskCallId: 'task-1',
          conversationId: 'child-1',
          subagentType: 'explore',
          description: 'Mapear src',
          prompt: 'Mapeie src e responda',
          providerId: 'opencode-go',
          modelId: 'deepseek-v4.1-flash',
          effort: 'high',
        });
        emitBus(payload, {
          type: 'subagent_event',
          taskCallId: 'task-1',
          event: { type: 'step_started', step: 1 },
        });
        emitBus(payload, {
          type: 'subagent_event',
          taskCallId: 'task-1',
          event: { type: 'text_delta', delta: 'Achei src/app.ts' },
        });
        emitBus(payload, {
          type: 'subagent_event',
          taskCallId: 'task-1',
          event: {
            type: 'tool_call_started',
            toolCall: {
              id: 'child-tool-1',
              name: 'read_file',
              arguments: '{"path":"src/app.ts"}',
              status: 'running',
              result: null,
            },
          },
        });
        live = useChatStore.getState().streaming?.subagents?.['task-1'];
        const result = {
          userMessage: userMessage(),
          assistantMessage: assistantMessage({ content: 'Concluído' }),
          usage: null,
          error: null,
          conversation: conversation(),
        };
        emitBus(payload, { type: 'done', result });
        return result;
      },
    );

    await useChatStore.getState().send('Delegue a exploração');

    expect(live?.text).toBe('');
    expect(live?.trace[0]).toMatchObject({
      text: 'Achei src/app.ts',
      toolCalls: 1,
    });
  });
});

describe('chatStore — fila por conversa e Enviar agora', () => {
  interface ControlledTurn {
    payload: TurnPayload;
    finish: (content: string) => void;
    cancel: () => void;
  }

  function controlledTurns(mode: 'chat' | 'code' = 'chat'): ControlledTurn[] {
    const pending: ControlledTurn[] = [];
    mocks.api.runTurn.mockImplementation(
      (payload: TurnPayload) =>
        new Promise((resolve) => {
          emitBus(payload, {
            type: 'turn_started',
            turnId: payload.turnId!,
            userMessageId: `user-${payload.turnId}`,
            assistantMessageId: `assistant-${payload.turnId}`,
          });
          const result = (content: string) => ({
            userMessage: userMessage({
              id: `user-${payload.turnId}`,
              conversationId: payload.conversationId,
              content: payload.content,
            }),
            assistantMessage: assistantMessage({
              id: `assistant-${payload.turnId}`,
              conversationId: payload.conversationId,
              content,
            }),
            usage: null,
            error: null,
            conversation: conversation({ id: payload.conversationId, mode }),
          });
          pending.push({
            payload,
            finish: (content) => {
              const value = result(content);
              emitBus(payload, { type: 'done', result: value });
              resolve(value);
            },
            cancel: () => {
              emitBus(payload, { type: 'cancelled' });
              resolve(result(''));
            },
          });
        }),
    );
    return pending;
  }

  function seedSession(mode: 'chat' | 'code'): void {
    useUiStore.setState({ layoutMode: mode });
    useChatStore.setState({
      conversations: [conversation({ id: 'conv-1', mode })],
      activeId: 'conv-1',
      activeIdByLayout: {
        chat: mode === 'chat' ? 'conv-1' : null,
        code: mode === 'code' ? 'conv-1' : null,
        agent: null,
      },
      messagesByConversation: { 'conv-1': [] },
    });
  }

  function goalFixture(overrides: Partial<GoalView> = {}): GoalView {
    return {
      title: 'Objetivo',
      objective: 'Concluir a refatoração.',
      status: 'active',
      autoContinue: true,
      rounds: 1,
      maxRounds: 25,
      revision: 2,
      origin: 'user',
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  function goalSnapshot(value: GoalView) {
    return {
      conversationId: 'conv-1',
      permissionMode: 'edit' as const,
      planMode: false,
      goal: value,
      todos: [],
      jobs: [],
      approvals: [],
    };
  }

  it('enfileira no layout Chat durante o streaming e drena ao terminar', async () => {
    seedSession('chat');
    const pending = controlledTurns('chat');

    await useChatStore.getState().send('primeira');
    expect(pending).toHaveLength(1);

    const accepted = await useChatStore.getState().send('segunda');
    expect(accepted).toBe(true);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
    expect(pending).toHaveLength(1);

    pending[0].finish('resposta');
    await vi.waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    expect(pending[1].payload.content).toBe('segunda');
    expect(pending[1].payload.turnKind).toBe('user');
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('Enviar agora cancela o turno e só então inicia a nova mensagem', async () => {
    seedSession('chat');
    const pending = controlledTurns('chat');

    await useChatStore.getState().send('primeira');
    await useChatStore.getState().send('nova', { sendNow: true });

    expect(mocks.api.cancelTurn).toHaveBeenCalledWith(pending[0].payload.turnId);
    // The item stays queued until the interrupted turn releases the slot.
    expect(pending).toHaveLength(1);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);

    pending[0].cancel();
    await vi.waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    expect(pending[1].payload.content).toBe('nova');
    expect(pending[1].payload.turnKind).toBe('user');
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('drena a fila antes da autocontinuação do objetivo', async () => {
    seedSession('code');
    // `applyResult` refreshes the sidebar; the mocked backend must return the
    // session, otherwise the goal preflight cannot find the conversation.
    mocks.api.listConversations.mockResolvedValue([
      conversation({ id: 'conv-1', mode: 'code' }),
    ]);
    const active = goalFixture();
    useCodeStore.setState({
      byConversation: { 'conv-1': { ...emptyCodeSession('conv-1'), goal: active } },
    });
    mocks.api.getCodeSessionState.mockResolvedValue(goalSnapshot(active));
    mocks.api.goalCanContinue.mockResolvedValue({ ok: true, goal: active });
    const pending = controlledTurns('code');

    await useChatStore.getState().send('primeira');
    await useChatStore.getState().send('fila');
    expect(pending).toHaveLength(1);

    pending[0].finish('ok');
    await vi.waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    expect(pending[1].payload.content).toBe('fila');
    expect(pending[1].payload.turnKind).toBe('user');
    expect(mocks.api.goalCanContinue).not.toHaveBeenCalled();

    pending[1].finish('ok');
    await vi.waitFor(() => expect(pending).toHaveLength(3), { timeout: 2000 });
    expect(pending[2].payload.turnKind).toBe('goal_round');
  });

  it('interromper uma rodada do objetivo retoma o goal antes da nova mensagem', async () => {
    seedSession('code');
    const active = goalFixture();
    useCodeStore.setState({
      byConversation: { 'conv-1': { ...emptyCodeSession('conv-1'), goal: active } },
    });
    mocks.api.getCodeSessionState.mockResolvedValue(goalSnapshot(active));
    const pending = controlledTurns('code');

    const resumed: string[] = [];
    let releaseResume: () => void = () => {};
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    mocks.api.updateGoal.mockImplementation(async (_id: string, action: string) => {
      resumed.push(action);
      await resumeGate;
      return goalSnapshot(goalFixture({ status: 'active', revision: 3 }));
    });

    await useChatStore.getState().runGoalRound('conv-1');
    expect(pending[0].payload.turnKind).toBe('goal_round');

    await useChatStore.getState().send('correção');
    const itemId = useMessageQueueStore.getState().byConversation['conv-1'][0].id;
    await useChatStore.getState().sendQueuedNow('conv-1', itemId);
    expect(mocks.api.cancelTurn).toHaveBeenCalledWith(pending[0].payload.turnId);

    // The cancellation closes the round as paused(user).
    mocks.api.getCodeSessionState.mockResolvedValue(
      goalSnapshot(goalFixture({ status: 'paused', pauseReason: 'user', revision: 2 })),
    );
    pending[0].cancel();

    await vi.waitFor(() => expect(resumed).toContain('resume'), { timeout: 2000 });
    expect(pending).toHaveLength(1);

    releaseResume();
    await vi.waitFor(() => expect(pending).toHaveLength(2), { timeout: 2000 });
    expect(pending[1].payload.content).toBe('correção');
    expect(pending[1].payload.turnKind).toBe('user');
  });

  it('Stop sem Enviar agora continua pausando a fila', async () => {
    seedSession('chat');
    const pending = controlledTurns('chat');

    await useChatStore.getState().send('primeira');
    await useChatStore.getState().send('fila');
    pending[0].cancel();

    await vi.waitFor(
      () => expect(useMessageQueueStore.getState().isPaused('conv-1')).toBe(true),
      { timeout: 2000 },
    );
    expect(pending).toHaveLength(1);
  });

  it('Stop não inicia a próxima rodada do objetivo', async () => {
    seedSession('code');
    const active = goalFixture();
    useCodeStore.setState({
      byConversation: { 'conv-1': { ...emptyCodeSession('conv-1'), goal: active } },
    });
    mocks.api.getCodeSessionState.mockResolvedValue(goalSnapshot(active));
    mocks.api.goalCanContinue.mockResolvedValue({ ok: true, goal: active });
    const pending = controlledTurns('code');

    await useChatStore.getState().send('primeira');
    await useChatStore.getState().stop();
    pending[0].cancel();

    await vi.waitFor(
      () => expect(mocks.api.getCodeSessionState.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 2000 },
    );
    // Drain the promise chain; settle must decide without the goal driver.
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(mocks.api.goalCanContinue).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
  });
});
