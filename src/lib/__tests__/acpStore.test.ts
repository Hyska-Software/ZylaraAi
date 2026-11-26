// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AcpAgentView,
  AcpAuthView,
  AcpRegistryAgent,
  CatalogView,
  ProviderAuthStatus,
  ProviderInfo,
} from '@/lib/types';

const mocks = vi.hoisted(() => ({
  acpListRegistry: vi.fn(),
  acpRefreshRegistry: vi.fn(),
  acpInstallAgent: vi.fn(),
  acpAddCustomAgent: vi.fn(),
  acpRemoveAgent: vi.fn(),
  acpSetTrusted: vi.fn(),
  acpAuthStatus: vi.fn(),
  acpAuth: vi.fn(),
  acpTestAgent: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

import { useAppStore } from '@/lib/store/appStore';

const REGISTRY: AcpRegistryAgent = {
  id: 'demo',
  name: 'Demo Agent',
  version: '1.2.0',
  description: 'A test agent',
  distributions: ['binary', 'npx'],
  platforms: ['windows-x86_64'],
  installed: false,
  supported: true,
};

function agent(overrides: Partial<AcpAgentView> = {}): AcpAgentView {
  return {
    id: 'acp__demo',
    registryId: 'demo',
    name: 'Demo Agent',
    version: '1.2.0',
    description: 'A test agent',
    kind: 'binary',
    source: 'registry',
    command: 'demo',
    args: ['--stdio'],
    envNames: ['DEMO_TOKEN'],
    trusted: false,
    enabled: true,
    authState: 'unknown',
    modelCount: 3,
    supportsFs: false,
    supportsTerminal: false,
    supportsElicitation: false,
    ...overrides,
  };
}

function acpProvider(authState: string, installed = true): ProviderInfo {
  return {
    id: 'acp__demo',
    name: 'Demo Agent',
    shortName: 'Demo',
    description: '',
    baseUrl: '',
    consoleUrl: '',
    endpoints: {},
    authEnv: '',
    defaultModelId: 'default',
    models: [],
    notes: [],
    transport: 'acp',
    auth: 'acp',
    origin: 'acp',
    acp: {
      agentId: 'acp__demo',
      registryId: 'demo',
      version: '1.2.0',
      kind: 'binary',
      authState,
      trusted: true,
      installed,
    },
  };
}

function catalogView(providers: ProviderInfo[] = [], acpAgents?: AcpAgentView[]): CatalogView {
  return {
    catalog: { version: 1, generatedAt: '', sources: {}, providers },
    keys: [],
    auth: [],
    acpAgents,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCatalog.mockResolvedValue(catalogView());
  useAppStore.setState({
    acpRegistry: [],
    acpAgents: [],
    providers: [],
    keys: [],
    auth: [],
    error: null,
  });
});

describe('appStore ACP actions', () => {
  it('loads the registry and installs agents with explicit command consent', async () => {
    mocks.acpListRegistry.mockResolvedValue([REGISTRY]);
    mocks.getCatalog.mockResolvedValueOnce(catalogView([acpProvider('ready')], [agent()]));
    const loaded = await useAppStore.getState().loadRegistry();
    expect(loaded).toHaveLength(1);
    expect(useAppStore.getState().acpAgents[0].id).toBe('acp__demo');

    const installed = agent({ authState: 'ready' });
    mocks.acpInstallAgent.mockResolvedValue(installed);
    mocks.getCatalog.mockResolvedValue(catalogView([acpProvider('ready')], [installed]));
    const result = await useAppStore.getState().installAgent('demo', true);

    expect(mocks.acpInstallAgent).toHaveBeenCalledWith('demo', true);
    expect(result.id).toBe('acp__demo');
    expect(useAppStore.getState().acpRegistry[0].installed).toBe(true);
    expect(useAppStore.getState().acpAgents).toEqual([installed]);
    expect(mocks.getCatalog).toHaveBeenCalled();
  });

  it('does not install without consent and surfaces backend errors', async () => {
    mocks.acpInstallAgent.mockRejectedValue(new Error('checksum mismatch'));
    await expect(useAppStore.getState().installAgent('demo', false)).rejects.toThrow(
      'checksum mismatch',
    );
    expect(useAppStore.getState().error).toBe('checksum mismatch');
    expect(useAppStore.getState().acpAgents).toEqual([]);
  });

  it('stores capability grants and reloads the catalog after trust changes', async () => {
    useAppStore.setState({ acpAgents: [agent()] });
    const trusted = agent({
      trusted: true,
      supportsFs: true,
      supportsElicitation: true,
    });
    mocks.acpSetTrusted.mockResolvedValue(trusted);
    mocks.getCatalog.mockResolvedValue(catalogView([acpProvider('ready')], [trusted]));

    await useAppStore.getState().setTrusted('acp__demo', true, {
      fs: true,
      terminal: false,
      elicitation: true,
    });

    expect(mocks.acpSetTrusted).toHaveBeenCalledWith('acp__demo', true, {
      fs: true,
      terminal: false,
      elicitation: true,
    });
    expect(mocks.getCatalog).toHaveBeenCalled();
    expect(useAppStore.getState().acpAgents[0].supportsFs).toBe(true);
  });

  it('adds a custom agent and reloads the catalog', async () => {
    const custom = agent({ id: 'acp__custom', registryId: null, name: 'Local Agent' });
    mocks.acpAddCustomAgent.mockResolvedValue(custom);
    const input = {
      name: 'Local Agent',
      command: 'C:\\agents\\local.exe',
      args: ['--stdio'],
      env: { TOKEN: 'abc' },
      cwd: 'C:\\work',
    };

    await useAppStore.getState().addCustomAgent(input);

    expect(mocks.acpAddCustomAgent).toHaveBeenCalledWith(input);
    expect(useAppStore.getState().acpAgents).toEqual([custom]);
    expect(mocks.getCatalog).toHaveBeenCalled();
  });

  it('keeps the legacy provider authStatus synchronous and probes ACP explicitly', async () => {
    const legacy: ProviderAuthStatus = {
      providerId: 'openai',
      mode: 'oauth',
      state: 'signed-in',
      planUsage: false,
      scopes: [],
    };
    useAppStore.setState({ auth: [legacy] });
    expect(useAppStore.getState().authStatus('openai')?.state).toBe('signed-in');

    const view: AcpAuthView = {
      agentId: 'acp__demo',
      state: 'ready',
      methods: [],
      hint: null,
    };
    mocks.acpAuthStatus.mockResolvedValue(view);
    useAppStore.setState({ acpAgents: [agent()] });
    await expect(useAppStore.getState().authStatus('acp__demo', { acp: true })).resolves.toEqual(
      view,
    );
    expect(mocks.acpAuthStatus).toHaveBeenCalledWith('acp__demo');
    expect(useAppStore.getState().acpAgents[0].authState).toBe('ready');
  });

  it('re-probes an ACP agent to refresh its thinking options', async () => {
    mocks.acpAuthStatus.mockResolvedValue({
      agentId: 'acp__demo',
      state: 'ready',
      methods: [],
      hint: null,
    });
    await useAppStore.getState().refreshAcpThinking('acp__demo');
    expect(mocks.acpAuthStatus).toHaveBeenCalledWith('acp__demo');
    expect(mocks.getCatalog).toHaveBeenCalled();
  });

  it('sends login and logout actions through the typed wrapper', async () => {
    useAppStore.setState({ acpAgents: [agent()] });
    const view: AcpAuthView = {
      agentId: 'acp__demo',
      state: 'ready',
      methods: [],
    };
    mocks.acpAuth.mockResolvedValue(view);
    await useAppStore.getState().acpAuthAction('acp__demo', {
      kind: 'terminalLogin',
      methodId: 'device-code',
    });
    expect(mocks.acpAuth).toHaveBeenCalledWith('acp__demo', {
      kind: 'terminalLogin',
      methodId: 'device-code',
    });
    await useAppStore.getState().acpAuthAction('acp__demo', { kind: 'logout' });
    expect(mocks.acpAuth).toHaveBeenLastCalledWith('acp__demo', { kind: 'logout' });
  });

  it('removes an agent and reports test failures on the agent row', async () => {
    useAppStore.setState({ acpAgents: [agent()], acpRegistry: [REGISTRY] });
    mocks.acpRemoveAgent.mockResolvedValue(undefined);
    await useAppStore.getState().removeAgent('acp__demo');
    expect(mocks.acpRemoveAgent).toHaveBeenCalledWith('acp__demo');
    expect(useAppStore.getState().acpAgents).toEqual([]);
    expect(useAppStore.getState().acpRegistry[0].installed).toBe(false);

    const row = agent();
    useAppStore.setState({ acpAgents: [row] });
    mocks.acpTestAgent.mockResolvedValue({
      providerId: 'acp__demo',
      ok: false,
      message: 'auth_required',
      models: 0,
    });
    const validation = await useAppStore.getState().testAgent('acp__demo');
    expect(validation.ok).toBe(false);
    expect(useAppStore.getState().acpAgents[0].lastError).toBe('auth_required');
  });

  it('treats only installed, authenticated ACP providers as ready', () => {
    useAppStore.setState({ providers: [acpProvider('ready')], keys: [], auth: [] });
    expect(useAppStore.getState().providerReady('acp__demo')).toBe(true);
    useAppStore.setState({ providers: [acpProvider('auth_required')] });
    expect(useAppStore.getState().providerReady('acp__demo')).toBe(false);
    useAppStore.setState({ providers: [acpProvider('ready', false)] });
    expect(useAppStore.getState().providerReady('acp__demo')).toBe(false);
  });
});
