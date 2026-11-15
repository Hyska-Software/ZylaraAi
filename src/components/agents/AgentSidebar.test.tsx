// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAgentChannels: vi.fn(),
  listAgentChannelInboxCounts: vi.fn(),
  listConversations: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  setConversationPinned: vi.fn(),
  exportConversation: vi.fn(),
  listAgentThreads: vi.fn(),
  reorderAgents: vi.fn(),
  reorderConversations: vi.fn(),
  reorderAgentChannels: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { emptyCodeSession, useAgentStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import type { StreamingState } from '@/lib/store';
import type { Agent, AgentChannel, Conversation } from '@/lib/types';
import { AgentSidebar } from './AgentSidebar';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Irineu',
    role: 'Engenheiro',
    description: 'Backend.',
    avatar: { kind: 'emoji', value: '🛠️', shape: 'rounded' },
    department: 'Engenharia',
    pinned: false,
    sortOrder: 1,
    providerId: 'opencode-go',
    modelId: 'glm-5.3-flash',
    reasoning: null,
    instructions: 'Seja direto.',
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
    memoryEnabled: true,
    workspaceId: null,
    permissionMode: 'edit',
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    threadCount: 1,
    lastActiveAt: 2,
    ...overrides,
  };
}

function thread(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'thread-1',
    title: 'Planejamento',
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    providerId: 'opencode-go',
    modelId: 'glm-5.3-flash',
    messageCount: 2,
    preview: 'oi',
    mode: 'agent',
    agentId: 'agent-1',
    ...overrides,
  };
}

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: 'channel-1',
    name: 'Lançamento',
    memberIds: ['agent-1'],
    createdAt: 1,
    updatedAt: 2,
    lastMessageAt: 2,
    ...overrides,
  };
}

function stream(overrides: Partial<StreamingState> = {}): StreamingState {
  return {
    turnId: 'turn-1',
    conversationId: 'thread-1',
    assistantId: 'assistant-1',
    userMessageId: null,
    phase: 'tool',
    step: 1,
    startedAt: 1,
    turnKind: 'user',
    ...overrides,
  };
}

function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAgentChannels.mockResolvedValue([]);
  mocks.listAgentChannelInboxCounts.mockResolvedValue([]);
  mocks.listConversations.mockResolvedValue([thread()]);
  mocks.renameConversation.mockResolvedValue(undefined);
  mocks.deleteConversation.mockResolvedValue(undefined);
  mocks.setConversationPinned.mockResolvedValue(undefined);
  mocks.exportConversation.mockResolvedValue('C:/tmp/thread.md');
  mocks.listAgents.mockResolvedValue([agent()]);
  useAgentStore.setState({
    agentsById: { 'agent-1': agent() },
    orderedIds: ['agent-1'],
    status: 'ready',
    error: null,
    mutationById: {},
    initialized: true,
  });
  useChatStore.setState({
    conversations: [thread()],
    activeId: null,
    messagesByConversation: {},
    streamsByConversation: {},
    streaming: null,
  });
  useCodeStore.setState({ byConversation: {} });
  useUiStore.setState({
    layoutMode: 'agent',
    activeAgentId: 'agent-1',
    activeChannelId: null,
    agentView: 'team',
    agentRoutinesAgentId: null,
    agentEditor: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('AgentSidebar — thread lifecycle', () => {
  it('renames an agent thread from its menu', async () => {
    render(<AgentSidebar />);
    openMenu(await screen.findByRole('button', { name: 'Opções de Planejamento' }));
    fireEvent.click(await screen.findByText('Renomear'));
    const input = await screen.findByLabelText('Título da conversa');
    fireEvent.change(input, { target: { value: 'Planejamento Q4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(mocks.renameConversation).toHaveBeenCalledWith('thread-1', 'Planejamento Q4'),
    );
  });

  it('pins and exports a thread from the same menu', async () => {
    render(<AgentSidebar />);
    openMenu(await screen.findByRole('button', { name: 'Opções de Planejamento' }));
    fireEvent.click(await screen.findByText('Fixar'));
    await waitFor(() => expect(mocks.setConversationPinned).toHaveBeenCalledWith('thread-1', true));

    openMenu(await screen.findByRole('button', { name: 'Opções de Planejamento' }));
    fireEvent.click(await screen.findByText('Exportar'));
    await waitFor(() => expect(mocks.exportConversation).toHaveBeenCalledWith('thread-1', 'markdown'));
  });
});

describe('AgentSidebar — thread status', () => {
  it('surfaces the last turn failure on the thread row', async () => {
    useCodeStore.setState({
      byConversation: {
        'thread-1': { ...emptyCodeSession('thread-1'), error: 'falhou' },
      },
    });
    render(<AgentSidebar />);
    expect(await screen.findByLabelText('Último turno falhou')).toBeTruthy();
  });

  it('anima o avatar e mostra os pontos quando uma thread está rodando', async () => {
    useChatStore.setState({ streamsByConversation: { 'thread-1': stream() } });
    const { container } = render(<AgentSidebar />);
    await screen.findByText('Planejamento');
    expect(container.querySelector('[data-activity="running"]')).not.toBeNull();
    expect(
      screen.getAllByRole('status', { name: 'Respondendo' }).length,
    ).toBeGreaterThan(0);
  });

  it('mantém o avatar idle quando nenhuma thread está rodando', async () => {
    const { container } = render(<AgentSidebar />);
    await screen.findByText('Planejamento');
    expect(container.querySelector('[data-activity="running"]')).toBeNull();
    expect(screen.queryAllByRole('status', { name: 'Respondendo' })).toHaveLength(0);
  });
});

describe('AgentSidebar — channels', () => {
  it('mostra as miniaturas dos membros e o excedente no canal', async () => {
    const memberIds = ['agent-1', 'agent-2', 'agent-3', 'agent-4'];
    useAgentStore.setState({
      agentsById: Object.fromEntries(
        memberIds.map((id, index) => [id, agent({ id, name: `Agente ${index + 1}` })]),
      ),
      orderedIds: memberIds,
    });
    mocks.listAgentChannels.mockResolvedValue([channel({ memberIds })]);
    render(<AgentSidebar />);

    const row = await screen.findByRole('button', { name: 'Lançamento' });
    // Two overlapping avatars plus the overflow chip ("+2") replace the # icon.
    expect(row.querySelectorAll('[data-avatar-kind]')).toHaveLength(2);
    expect(within(row).getByText('+2')).toBeTruthy();
  });

  it('selects a channel and exposes it in the sidebar', async () => {
    mocks.listAgentChannels.mockResolvedValue([channel()]);
    render(<AgentSidebar />);
    const rows = await screen.findAllByRole('button', { name: /Lançamento/ });
    fireEvent.click(rows[0]);
    expect(useUiStore.getState().activeChannelId).toBe('channel-1');
    expect(useUiStore.getState().activeAgentId).toBeNull();
  });

  it('returns to the team page when Equipe is clicked', async () => {
    useUiStore.setState({ agentView: 'stats' });
    render(<AgentSidebar />);
    fireEvent.click(await screen.findByRole('button', { name: 'Equipe' }));
    expect(useUiStore.getState().agentView).toBe('team');
  });
});

describe('AgentSidebar — primary conversation', () => {
  it('renders it above pinned threads and hides unpin/delete', async () => {
    useChatStore.setState({
      conversations: [
        thread({ id: 'pinned', title: 'Pinned', pinned: true, updatedAt: 9_999 }),
        thread({
          id: 'main',
          title: 'Diário',
          pinned: true,
          isMain: true,
          updatedAt: 1,
        }),
      ],
      activeId: null,
      messagesByConversation: {},
      streamsByConversation: {},
      streaming: null,
    });
    render(<AgentSidebar />);

    const mainRow = await screen.findByTitle('Diário · Conversa principal');
    const pinnedRow = screen.getByTitle('Pinned');
    expect(
      mainRow.compareDocumentPosition(pinnedRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    openMenu(screen.getByRole('button', { name: 'Opções de Diário' }));
    expect(await screen.findByRole('menuitem', { name: 'Renomear' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Exportar' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Desafixar' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });
});

describe('AgentSidebar — routines entry', () => {
  it('opens the routines page from the footer', async () => {
    useUiStore.setState({ activeAgentId: null, activeChannelId: null, agentView: 'team' });
    render(<AgentSidebar />);

    fireEvent.click(await screen.findByRole('button', { name: 'Rotinas' }));

    const state = useUiStore.getState();
    expect(state.agentView).toBe('routines');
    expect(state.agentRoutinesAgentId).toBeNull();
  });

  it('opens the routines page filtered by the agent menu', async () => {
    render(<AgentSidebar />);

    openMenu(await screen.findByRole('button', { name: 'Opções de Irineu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rotinas' }));

    const state = useUiStore.getState();
    expect(state.agentView).toBe('routines');
    expect(state.agentRoutinesAgentId).toBe('agent-1');
    expect(state.activeAgentId).toBeNull();
  });
});

describe('AgentSidebar — plugins entry', () => {
  it('opens the plugins page from the footer', async () => {
    render(<AgentSidebar />);

    fireEvent.click(await screen.findByRole('button', { name: 'Plugins' }));

    const state = useUiStore.getState();
    expect(state.agentView).toBe('plugins');
    expect(state.activeAgentId).toBeNull();
    expect(state.activeChannelId).toBeNull();
    expect(useChatStore.getState().activeId).toBeNull();
  });

  it('leaves the plugins page when an agent is selected', async () => {
    useUiStore.setState({ agentView: 'plugins', activeAgentId: null, activeChannelId: null });
    render(<AgentSidebar />);

    fireEvent.click(await screen.findByText('Irineu'));

    expect(useUiStore.getState().agentView).toBe('team');
    expect(useUiStore.getState().activeAgentId).toBe('agent-1');
  });
});

describe('AgentSidebar — reordenação por teclado', () => {
  it('move o agente dentro do departamento e persiste a ordem', async () => {
    const first = agent({ id: 'agent-1', name: 'Ana', sortOrder: 1 });
    const second = agent({ id: 'agent-2', name: 'Bia', sortOrder: 2 });
    mocks.listAgents.mockResolvedValue([first, second]);
    mocks.reorderAgents.mockResolvedValue(undefined);
    useAgentStore.setState({
      agentsById: { 'agent-1': first, 'agent-2': second },
      orderedIds: ['agent-1', 'agent-2'],
      status: 'ready',
      error: null,
      mutationById: {},
      initialized: true,
    });
    useChatStore.setState({ conversations: [], activeId: null });

    render(<AgentSidebar />);

    fireEvent.keyDown(screen.getByRole('button', { name: /^Ana/ }), {
      key: 'ArrowDown',
      altKey: true,
    });

    await waitFor(() =>
      expect(mocks.reorderAgents).toHaveBeenCalledWith(['agent-2', 'agent-1']),
    );
  });

  it('move a conversa dentro do agente e preserva as ocultas', async () => {
    const threads = Array.from({ length: 6 }, (_, index) =>
      thread({
        id: `thread-${index + 1}`,
        title: `Conversa ${index + 1}`,
        updatedAt: 100 - index,
      }),
    );
    mocks.reorderConversations.mockResolvedValue(undefined);
    useChatStore.setState({ conversations: threads, activeId: null });
    useUiStore.setState({ layoutMode: 'agent', activeAgentId: 'agent-1', activeChannelId: null });

    render(<AgentSidebar />);

    fireEvent.keyDown(screen.getByRole('button', { name: /^Conversa 1/ }), {
      key: 'ArrowDown',
      altKey: true,
    });

    await waitFor(() =>
      expect(mocks.reorderConversations).toHaveBeenCalledWith([
        'thread-2',
        'thread-1',
        'thread-3',
        'thread-4',
        'thread-5',
        'thread-6',
      ]),
    );
  });
});

describe('AgentSidebar — canais reordenáveis', () => {
  it('move o canal dentro de Canais e persiste a ordem', async () => {
    const first = channel({
      id: 'channel-1',
      name: 'Analises',
      updatedAt: 20,
      sortOrder: 0,
    });
    const second = channel({
      id: 'channel-2',
      name: 'Canal',
      updatedAt: 10,
      sortOrder: 1,
    });
    mocks.listAgentChannels.mockResolvedValue([first, second]);
    mocks.reorderAgentChannels.mockResolvedValue(undefined);

    render(<AgentSidebar />);

    const button = await screen.findByRole('button', { name: /^Analises/ });
    fireEvent.keyDown(button, { key: 'ArrowDown', altKey: true });

    await waitFor(() =>
      expect(mocks.reorderAgentChannels).toHaveBeenCalledWith(['channel-2', 'channel-1']),
    );
  });
});
