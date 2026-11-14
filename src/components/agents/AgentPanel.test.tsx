// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listAgentRoutines: vi.fn(),
  updateAgent: vi.fn(),
  computerPreview: vi.fn(),
  dockerPullImage: vi.fn(),
  dockerStartDaemon: vi.fn(),
  browserSessionStatus: vi.fn(),
  browserFrame: vi.fn(),
  browserStartStream: vi.fn(),
  browserStopStream: vi.fn(),
  browserHumanInput: vi.fn(),
  computerControlStatus: vi.fn(),
  browserTakeControl: vi.fn(),
  browserClickAt: vi.fn(),
  browserPressKey: vi.fn(),
  browserInsertText: vi.fn(),
  releaseComputerControl: vi.fn(),
  getAgentUsage: vi.fn(),
  listAgentTasks: vi.fn(),
  listComputerActions: vi.fn(),
  listAgentMemories: vi.fn(),
  controlEvent: null as null | ((event: { conversationId: string; paused: boolean; takenOver: boolean; target: string; generation: string | null }) => void),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('./useComputerControlEvents', () => ({
  useComputerControlEvents: (_conversation: string | null, callback: typeof mocks.controlEvent) => { mocks.controlEvent = callback; },
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { useAgentStore, useUiStore } from '@/lib/store';
import type { Agent, AgentInput } from '@/lib/types';
import { AgentPanelBrowser } from './AgentPanelBrowser';
import { AgentPanelData } from './AgentPanelData';
import { AgentPanelScreen } from './AgentPanelScreen';

const agent: Agent = {
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
    delegation: false,
    computerUse: true,
    screenCapture: false,
    browserUse: false,
    dockerExecution: false,
    skills: null,
    tools: null,
    mcpServers: null,
  },
  memoryEnabled: false,
  workspaceId: null,
  permissionMode: 'edit',
  dockerImage: null,
  computerEnvironment: 'auto',
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  threadCount: 0,
  lastActiveAt: null,
};

const context = {
  agent,
  conversation: null,
  openThread: vi.fn(),
  onEdit: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAgentRoutines.mockResolvedValue([]);
  mocks.getAgentUsage.mockResolvedValue(null);
  mocks.listAgentTasks.mockResolvedValue([]);
  mocks.listComputerActions.mockResolvedValue([]);
  mocks.listAgentMemories.mockResolvedValue([]);
  mocks.browserSessionStatus.mockResolvedValue({
    running: false,
    port: null,
    executable: null,
    profileDir: null,
    downloadDir: null,
    tabs: [],
    activeTab: null,
  });
  mocks.browserFrame.mockResolvedValue(null);
  mocks.browserStartStream.mockResolvedValue(undefined);
  mocks.browserStopStream.mockResolvedValue(undefined);
  mocks.browserHumanInput.mockResolvedValue(undefined);
  mocks.computerControlStatus.mockResolvedValue({ paused: false, takenOver: false });
  mocks.browserTakeControl.mockResolvedValue({ kind: 'browser', url: null, generation: 'generation-1' });
  mocks.browserClickAt.mockResolvedValue(undefined);
  mocks.browserPressKey.mockResolvedValue(undefined);
  mocks.browserInsertText.mockResolvedValue(undefined);
  mocks.releaseComputerControl.mockResolvedValue(undefined);
  mocks.dockerPullImage.mockResolvedValue('ghcr.io/hyska-software/zylara-computer:latest');
  mocks.dockerStartDaemon.mockResolvedValue({
    running: true,
    started: true,
    serverVersion: '27.0.0',
  });
  mocks.updateAgent.mockImplementation(async (_id: string, input: AgentInput) => ({
    ...agent,
    ...input,
    capabilities: input.capabilities,
    computerEnvironment: input.computerEnvironment ?? 'auto',
  }));
  useAgentStore.setState({
    agentsById: { [agent.id]: agent },
    orderedIds: [agent.id],
    status: 'ready',
    initialized: true,
  });
});

afterEach(() => cleanup());

describe('AgentPanel — Tela', () => {
  it('shows the app workspace when the conversation has no selected folder', () => {
    const agentWithWorkspace = { ...agent, workspaceId: 'new-default' };
    const { rerender } = render(<AgentPanelScreen context={{ ...context, agent: agentWithWorkspace, conversation: { id: 'conv-1', workspaceId: null } as never }} />);
    expect(screen.getByText(/pasta interna do aplicativo/i)).toBeTruthy();

    rerender(<AgentPanelScreen context={{ ...context, agent, conversation: { id: 'conv-1', workspaceId: 'existing' } as never }} />);
    expect(screen.queryByText(/pasta interna do aplicativo/i)).toBeNull();
  });
  it('mostra os ambientes e mantém a nuvem desabilitada como Em breve', async () => {
    render(<AgentPanelScreen context={context} />);

    expect(await screen.findByText('Tela de Irineu')).toBeTruthy();
    expect(screen.getByText('Trabalha em')).toBeTruthy();
    expect(screen.getAllByText('Automático').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Este computador').length).toBeGreaterThan(0);
    expect(screen.getByText('Desktop na nuvem')).toBeTruthy();
    expect(screen.getByText('Em breve')).toBeTruthy();
    const cloud = screen.getByText('Desktop na nuvem').closest('button');
    expect(cloud?.disabled).toBe(true);
    expect(screen.getByText('Abra uma conversa com Irineu para ver o desktop.')).toBeTruthy();
  });

  it('salva o ambiente e liga a capability com confirmação', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AgentPanelScreen context={context} />);

    fireEvent.click(screen.getByText('Este computador').closest('button')!);

    await waitFor(() =>
      expect(mocks.updateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          computerEnvironment: 'this_computer',
          capabilities: expect.objectContaining({ computerUse: true }),
        }),
      ),
    );
  });

  it('explica como configurar o Docker quando a imagem do desktop privado falha', async () => {
    const dockerAgent: Agent = {
      ...agent,
      workspaceId: 'ws-1',
      computerEnvironment: 'private_desktop',
    };
    useAgentStore.setState({
      agentsById: { [dockerAgent.id]: dockerAgent },
      orderedIds: [dockerAgent.id],
    });
    mocks.computerPreview.mockRejectedValue(
      'COMPUTER_DOCKER_FAILED: não foi possível iniciar `ghcr.io/hyska-software/zylara-computer:latest` — pull access denied',
    );
    useUiStore.setState({ settingsOpen: false, settingsTab: 'general' });

    render(
      <AgentPanelScreen
        context={{
          ...context,
          agent: dockerAgent,
          conversation: { id: 'conv-1', workspaceId: 'ws-1' } as never,
        }}
      />,
    );

    expect(
      await screen.findByText('Imagem do Desktop privado não está disponível'),
    ).toBeTruthy();
    expect(screen.getByText(/docker pull ghcr\.io\/hyska-software\/zylara-computer:latest/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Assumir o controle' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Configurar Docker' }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsTab).toBe('agents');

    fireEvent.click(screen.getByRole('button', { name: 'Baixar imagem' }));
    await waitFor(() =>
      expect(mocks.dockerPullImage).toHaveBeenCalledWith(
        'ghcr.io/hyska-software/zylara-computer:latest',
      ),
    );
  });

  it('oferece iniciar o Docker quando o motor não está respondendo', async () => {
    const dockerAgent: Agent = {
      ...agent,
      workspaceId: 'ws-1',
      computerEnvironment: 'private_desktop',
    };
    useAgentStore.setState({
      agentsById: { [dockerAgent.id]: dockerAgent },
      orderedIds: [dockerAgent.id],
    });
    mocks.computerPreview.mockRejectedValue(
      'COMPUTER_DOCKER_DAEMON_DOWN: o motor do Docker não está respondendo — inicie o Docker Desktop e tente de novo',
    );

    render(
      <AgentPanelScreen
        context={{
          ...context,
          agent: dockerAgent,
          conversation: { id: 'conv-1', workspaceId: 'ws-1' } as never,
        }}
      />,
    );

    expect(await screen.findByText('O Docker Engine não está em execução')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar Docker' }));
    await waitFor(() => expect(mocks.dockerStartDaemon).toHaveBeenCalled());
  });
});

describe('AgentPanel — Navegador', () => {
  it('shows the app workspace for browser sessions without a selected folder', () => {
    const agentWithWorkspace = { ...agent, workspaceId: 'new-default' };
    const { rerender } = render(<AgentPanelBrowser context={{ ...context, agent: agentWithWorkspace, conversation: { id: 'conv-1', workspaceId: null } as never }} />);
    expect(screen.getByText(/pasta interna do aplicativo/i)).toBeTruthy();

    rerender(<AgentPanelBrowser context={{ ...context, agent, conversation: { id: 'conv-1', workspaceId: 'existing' } as never }} />);
    expect(screen.queryByText(/pasta interna do aplicativo/i)).toBeNull();
  });
  it('ativa browserUse pelo switch', async () => {
    render(<AgentPanelBrowser context={context} />);

    const toggle = await screen.findByLabelText('Deixar Irineu usar um navegador');
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mocks.updateAgent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          capabilities: expect.objectContaining({ browserUse: true }),
        }),
      ),
    );
  });

  it('encaminha clique do preview quando o humano assume o controle', async () => {
    const browserAgent: Agent = {
      ...agent,
      capabilities: { ...agent.capabilities, browserUse: true },
    };
    useAgentStore.setState({
      agentsById: { [browserAgent.id]: browserAgent },
      orderedIds: [browserAgent.id],
    });
    mocks.browserSessionStatus.mockResolvedValue({
      running: true,
      port: 9222,
      executable: 'msedge.exe',
      profileDir: 'C:/app/browser/conv-1',
      downloadDir: 'C:/app/downloads',
      tabs: [{ id: 'tab-1', title: 'Exemplo', url: 'https://example.com', active: true }],
      activeTab: 'tab-1',
    });
    mocks.browserFrame.mockResolvedValue({
      dataUrl: 'data:image/jpeg;base64,abc',
      url: 'https://example.com',
      title: 'Exemplo',
      width: 1280,
      height: 820,
      capturedAt: 1,
    });
    mocks.browserTakeControl.mockResolvedValue({ kind: 'browser', url: null, generation: 'generation-1' });
    render(
      <AgentPanelBrowser
        context={{ ...context, agent: browserAgent, conversation: { id: 'conv-1' } as never }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Assumir o controle/i }));
    await waitFor(() => expect(mocks.browserTakeControl).toHaveBeenCalledWith('conv-1'));
    const image = await screen.findByAltText(/Página controlada por Irineu/);
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 1280,
        bottom: 820,
        width: 1280,
        height: 820,
        toJSON: () => ({}),
      }),
    });
    fireEvent.pointerDown(image, { clientX: 100, clientY: 120, button: 0, buttons: 1 });
    await waitFor(() =>
      expect(mocks.browserHumanInput).toHaveBeenCalledWith('conv-1', 'tab-1', 'mouse', expect.objectContaining({ type: 'mousePressed', x: 100, y: 120 }), 'generation-1'),
    );

    let resolveInput: () => void = () => {};
    mocks.browserHumanInput.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveInput = resolve; }));
    fireEvent.pointerDown(image, { clientX: 110, clientY: 120, button: 0, buttons: 1 });
    await waitFor(() => expect(mocks.browserHumanInput).toHaveBeenCalledTimes(2));
    fireEvent.pointerDown(image, { clientX: 120, clientY: 120, button: 0, buttons: 1 });
    act(() => mocks.controlEvent?.({ conversationId: 'conv-1', paused: true, takenOver: true, target: 'browser', generation: 'generation-2' }));
    await act(async () => { resolveInput(); });
    await waitFor(() => expect(mocks.browserHumanInput).toHaveBeenCalledTimes(3));
    expect(mocks.browserHumanInput.mock.calls[2]?.[4]).toBe('generation-1');
  });

  it('mostra atividade recente da conversa sem expor os dados digitados', async () => {
    mocks.listComputerActions.mockResolvedValue([{
      id: 'a1', tool: 'computer_type', action: 'computer_type', result: 'ok',
      target: { textLength: 12 }, createdAt: 1,
    }]);
    const browserAgent: Agent = { ...agent, capabilities: { ...agent.capabilities, browserUse: true } };
    mocks.browserSessionStatus.mockResolvedValue({ running: true, tabs: [], activeTab: null });
    render(<AgentPanelBrowser context={{ ...context, agent: browserAgent, conversation: { id: 'conv-1' } as never }} />);
    expect(await screen.findByText('Digitou no desktop')).toBeTruthy();
    expect(screen.queryByText('12')).toBeNull();
  });

  it('não oferece controle do navegador enquanto o desktop está nas mãos do usuário', async () => {
    const browserAgent: Agent = { ...agent, capabilities: { ...agent.capabilities, browserUse: true } };
    mocks.browserSessionStatus.mockResolvedValue({ running: true, tabs: [], activeTab: null });
    mocks.computerControlStatus.mockResolvedValue({ paused: true, takenOver: true, target: 'desktop' });
    render(<AgentPanelBrowser context={{ ...context, agent: browserAgent, conversation: { id: 'conv-1' } as never }} />);
    const button = await screen.findByRole('button', { name: 'Assumir o controle' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });
});

describe('AgentPanel — Dados', () => {
  it('mostra uso, tarefas e capacidades do agente', async () => {
    mocks.getAgentUsage.mockResolvedValue({
      agentId: 'agent-1',
      turns: 4,
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 0,
      totalTokens: 1500,
      cost: 0.25,
      lastUsedAt: Date.now(),
    });
    mocks.listAgentTasks.mockResolvedValue([
      {
        id: 'task-1',
        channelId: null,
        parentTaskId: null,
        ownerAgentId: 'agent-1',
        createdByAgentId: null,
        createdByUser: true,
        title: 'Revisar',
        brief: 'Leia.',
        acceptance: '',
        status: 'waiting_input',
        priority: 0,
        maxTurns: 4,
        maxTokens: 1000,
        maxCost: 0.5,
        deadlineAt: null,
        conversationId: null,
        originConversationId: null,
        result: null,
        resultArtifactIds: [],
        leaseUntil: null,
        handoffCount: 0,
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    render(<AgentPanelData context={context} />);

    expect(await screen.findByText('Uso')).toBeTruthy();
    expect(screen.getAllByText('Tarefas').length).toBeGreaterThan(0);
    expect(await screen.findByText('1 aberta(s) de 1')).toBeTruthy();
    expect(screen.getByText('Computador')).toBeTruthy();
  });
});
