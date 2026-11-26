// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { AcpAgentView, CatalogView } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  acpListRegistry: vi.fn(),
  acpInstallAgent: vi.fn(),
  acpSetTrusted: vi.fn(),
  acpRemoveAgent: vi.fn(),
  acpTestAgent: vi.fn(),
  acpAuthStatus: vi.fn(),
  acpAuth: vi.fn(),
  acpAddCustomAgent: vi.fn(),
  acpEnableAgent: vi.fn(),
  acpRescanDevices: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { AcpAgentPanel } from '@/components/settings/AcpAgentPanel';
import { setLanguage } from '@/lib/i18n';
import { useAppStore } from '@/lib/store/appStore';

function agent(overrides: Partial<AcpAgentView> = {}): AcpAgentView {
  return {
    id: 'acp__demo',
    registryId: 'demo',
    name: 'Demo Agent',
    version: '1.0.0',
    description: 'Runs locally',
    kind: 'binary',
    source: 'registry',
    command: 'demo',
    args: ['--stdio'],
    envNames: ['DEMO_TOKEN'],
    trusted: true,
    enabled: true,
    authState: 'auth_required',
    modelCount: 3,
    supportsFs: false,
    supportsTerminal: false,
    supportsElicitation: false,
    ...overrides,
  };
}

function catalogView(acpAgents: AcpAgentView[] = []): CatalogView {
  return {
    catalog: { version: 1, generatedAt: '', sources: {}, providers: [] },
    keys: [],
    auth: [],
    acpAgents,
  };
}

beforeEach(async () => {
  await setLanguage('en', { persist: false });
  cleanup();
  vi.clearAllMocks();
  mocks.acpListRegistry.mockResolvedValue([]);
  mocks.acpEnableAgent.mockImplementation(async (id: string, enabled: boolean) =>
    agent({ id, enabled }),
  );
  mocks.acpRescanDevices.mockResolvedValue([]);
  mocks.getCatalog.mockImplementation(async () =>
    catalogView(useAppStore.getState().acpAgents),
  );
  mocks.acpSetTrusted.mockImplementation(
    async (
      _id: string,
      trusted: boolean,
      caps: { fs: boolean; terminal: boolean; elicitation: boolean },
    ) =>
      agent({
        trusted,
        supportsFs: caps.fs,
        supportsTerminal: caps.terminal,
        supportsElicitation: caps.elicitation,
      }),
  );
  mocks.acpRemoveAgent.mockResolvedValue(undefined);
  mocks.acpTestAgent.mockResolvedValue({
    providerId: 'acp__demo',
    ok: true,
    models: 2,
    latencyMs: 12,
  });
  mocks.acpAuthStatus.mockResolvedValue({
    agentId: 'acp__demo',
    state: 'auth_required',
    methods: [{ id: 'device', name: 'Device code', kind: 'agent' }],
  });
  mocks.acpAuth.mockResolvedValue({ agentId: 'acp__demo', state: 'ready', methods: [] });
  mocks.acpAddCustomAgent.mockImplementation(async (input: { name: string }) =>
    agent({ id: 'acp__custom', name: input.name, registryId: null }),
  );
  useAppStore.setState({ acpAgents: [agent()], acpRegistry: [], error: null });
});

afterEach(() => cleanup());

describe('AcpAgentPanel', () => {
  it('shows the model count from the shared catalog and tests the agent', async () => {
    render(<AcpAgentPanel />);
    expect(screen.getByText('3 models')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Test agent' }));

    await waitFor(() => expect(mocks.acpTestAgent).toHaveBeenCalledWith('acp__demo'));
    expect(await screen.findByText('Connected · 2 models')).toBeTruthy();
  });

  it('sends trust and capability changes with the full capability set', async () => {
    render(<AcpAgentPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'File access' }));

    await waitFor(() =>
      expect(mocks.acpSetTrusted).toHaveBeenCalledWith('acp__demo', true, {
        fs: true,
        terminal: false,
        elicitation: false,
      }),
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Trust this agent' }));
    await waitFor(() =>
      expect(mocks.acpSetTrusted).toHaveBeenLastCalledWith('acp__demo', false, {
        fs: true,
        terminal: false,
        elicitation: false,
      }),
    );
  });

  it('signs in with the agent auth method and signs out again', async () => {
    render(<AcpAgentPanel />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(mocks.acpAuth).toHaveBeenCalledWith('acp__demo', {
        kind: 'login',
        methodId: 'device',
      }),
    );

    useAppStore.setState({ acpAgents: [agent({ authState: 'ready' })] });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(mocks.acpAuth).toHaveBeenLastCalledWith('acp__demo', { kind: 'logout' }),
    );
  });

  it('removes only after confirmation', async () => {
    render(<AcpAgentPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove agent' }));
    expect(mocks.acpRemoveAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.acpRemoveAgent).toHaveBeenCalledWith('acp__demo'));
  });

  it('adds a custom agent with parsed args, env and cwd', async () => {
    useAppStore.setState({ acpAgents: [] });
    const user = userEvent.setup();
    render(<AcpAgentPanel />);
    await user.click(screen.getByRole('button', { name: 'Add agent manually' }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local Agent' } });
    fireEvent.change(screen.getByLabelText('Absolute command path'), {
      target: { value: 'C:\\agents\\local.exe' },
    });
    fireEvent.change(screen.getByLabelText('Arguments (one per line)'), {
      target: { value: '--stdio\n--verbose' },
    });
    fireEvent.change(screen.getByLabelText('Environment variables (KEY=value, one per line)'), {
      target: { value: 'TOKEN=abc' },
    });
    fireEvent.change(screen.getByLabelText('Working directory (optional)'), {
      target: { value: 'C:\\work' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));

    await waitFor(() => expect(mocks.acpAddCustomAgent).toHaveBeenCalledTimes(1));
    expect(mocks.acpAddCustomAgent).toHaveBeenCalledWith({
      name: 'Local Agent',
      command: 'C:\\agents\\local.exe',
      args: ['--stdio', '--verbose'],
      env: { TOKEN: 'abc' },
      cwd: 'C:\\work',
    });
  });

  it('shows detected agents as disabled and enables them on click', async () => {
    useAppStore.setState({
      acpAgents: [agent({ source: 'detected', enabled: false, authState: 'ready' })],
    });
    render(<AcpAgentPanel />);

    expect(screen.getByText('Detected on this device')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test agent' })).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() =>
      expect(mocks.acpEnableAgent).toHaveBeenCalledWith('acp__demo', true),
    );
  });
});
