// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogView,
  LoginChallenge,
  ModelInfo,
  ProviderAuthStatus,
  ProviderInfo,
  Settings,
  SettingsView,
} from '@/lib/types';

const mocks = vi.hoisted(() => {
  const api = {
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    setProviderKey: vi.fn(),
    getCatalog: vi.fn(),
    refreshCatalog: vi.fn(),
    listRemoteModels: vi.fn(),
    refreshProviderModels: vi.fn(),
    appInfo: vi.fn(),
    validateProvider: vi.fn(),
    openaiLoginStart: vi.fn(),
    openaiLoginWait: vi.fn(),
    openaiLoginCancel: vi.fn(),
    openaiSignOut: vi.fn(),
    openaiAuthStatus: vi.fn(),
  };
  return { api };
});

vi.mock('@/lib/api', () => ({ api: mocks.api }));

import { useAppStore, favoriteKey } from '@/lib/store/appStore';
import { i18n, setLanguage } from '@/lib/i18n';

const settings: Settings = {
  theme: 'system',
  themeId: 'zylara',
  borderRadiusEnabled: true,
  chatExecutionAnimationEnabled: true,
  locale: 'pt-BR',
  defaultProvider: 'openai',
  defaultModel: 'gpt-6.1-sol',
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
};

function model(id: string, name: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    family: 'gpt',
    protocols: ['openai-responses'],
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    attachment: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    contextWindow: 400_000,
    maxOutput: 32_768,
    openWeights: false,
    tags: [],
    status: 'stable',
    ...overrides,
  };
}

const openaiProvider: ProviderInfo = {
  id: 'openai',
  name: 'OpenAI (ChatGPT)',
  shortName: 'ChatGPT',
  description: 'OpenAI',
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
  models: [
    model('gpt-6.1-sol', 'GPT-6.1 Sol'),
    model('gpt-account-only', 'Conta only', { estimated: true }),
  ],
  notes: [],
};

function authStatus(overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    providerId: 'openai',
    mode: 'oauth',
    state: 'signed-in',
    accountLabel: 'user@example.com',
    planUsage: true,
    expiresAt: Date.now() + 3_600_000,
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    clientIdMasked: 'oaiapp_a…1234',
    hostIdMasked: 'urn:uuid:…',
    hint: null,
    ...overrides,
  };
}

function settingsView(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    settings,
    keys: [{ providerId: 'openai', hasKey: true, masked: null, source: 'chatgpt', mode: 'oauth' }],
    auth: [authStatus()],
    secretsError: null,
    ...overrides,
  };
}

function catalogViewWith(
  providers: ProviderInfo[],
  keys: CatalogView['keys'] = [],
  auth: ProviderAuthStatus[] = [],
): CatalogView {
  return {
    catalog: {
      version: 1,
      generatedAt: '2026-10-26T00:00:00.000Z',
      sources: {},
      providers,
    },
    keys,
    auth,
    remoteRefreshedAt: 1_700_000_000_000,
  };
}

function catalogView(providerOverrides: Partial<ProviderInfo> = {}): CatalogView {
  return catalogViewWith(
    [{ ...openaiProvider, ...providerOverrides }],
    [{ providerId: 'openai', hasKey: true, masked: null, source: 'chatgpt', mode: 'oauth' }],
    [authStatus()],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppStore.setState({
    ready: false,
    initializing: false,
    appInfo: null,
    settings,
    keys: [],
    auth: [],
    secretsError: null,
    providers: [],
    selection: { providerId: 'openai', modelId: 'gpt-6.1-sol', reasoning: null },
    favorites: [],
    error: null,
    catalogRefreshedAt: null,
    loginChallenge: null,
  });
  mocks.api.getSettings.mockResolvedValue(settingsView());
  mocks.api.getCatalog.mockResolvedValue(catalogView());
  mocks.api.appInfo.mockResolvedValue({ name: 'Zylara' });
});

describe('appStore — OpenAI plan usage', () => {
  it('loads the merged catalog view, auth statuses and secrets error', async () => {
    mocks.api.getSettings.mockResolvedValue(settingsView({ secretsError: 'arquivo inválido' }));
    await useAppStore.getState().init();
    const state = useAppStore.getState();
    expect(state.ready).toBe(true);
    expect(state.providers.map((provider) => provider.id)).toContain('openai');
    expect(state.providers[0].models.map((entry) => entry.id)).toContain('gpt-account-only');
    expect(state.auth[0].state).toBe('signed-in');
    expect(state.secretsError).toBe('arquivo inválido');
    expect(state.selection.providerId).toBe('openai');
    expect(state.selection.modelId).toBe('gpt-6.1-sol');
  });

  it('keeps a persisted account-only model across restarts', async () => {
    useAppStore.setState({
      selection: { providerId: 'openai', modelId: 'gpt-account-only', reasoning: null },
    });
    await useAppStore.getState().init();
    expect(useAppStore.getState().selection.modelId).toBe('gpt-account-only');
  });

  it('reports readiness from OAuth status or API key', () => {
    useAppStore.setState({ providers: [openaiProvider], keys: [], auth: [authStatus()] });
    expect(useAppStore.getState().providerReady('openai')).toBe(true);

    useAppStore.setState({ auth: [], keys: [{ providerId: 'openai', hasKey: true, source: 'settings', mode: 'api-key' }] });
    expect(useAppStore.getState().providerReady('openai')).toBe(true);

    useAppStore.setState({ auth: [authStatus({ state: 'signed-out' })], keys: [] });
    expect(useAppStore.getState().providerReady('openai')).toBe(false);
  });

  it('runs the two-phase login and refreshes auth + models', async () => {
    const challenge: LoginChallenge = {
      attemptId: 'a1',
      authUrl: 'https://auth.openai.com/api/accounts/authorize?x=1',
      expiresAt: Date.now() + 600_000,
      browserOpened: true,
      browserError: null,
    };
    mocks.api.openaiLoginStart.mockResolvedValue(challenge);
    mocks.api.openaiLoginWait.mockResolvedValue(authStatus());
    mocks.api.openaiAuthStatus.mockResolvedValue([authStatus()]);
    mocks.api.refreshProviderModels.mockResolvedValue(catalogView());

    const started = await useAppStore.getState().startChatGptLogin('openai');
    expect(started).toEqual(challenge);
    expect(useAppStore.getState().loginChallenge).toEqual(challenge);

    const status = await useAppStore.getState().awaitChatGptLogin('a1');
    expect(status.state).toBe('signed-in');
    expect(mocks.api.openaiLoginWait).toHaveBeenCalledWith('a1');
    expect(useAppStore.getState().loginChallenge).toBeNull();
    expect(mocks.api.refreshProviderModels).toHaveBeenCalledWith('openai');
    expect(useAppStore.getState().auth[0].state).toBe('signed-in');
  });

  it('clears the pending challenge on cancel and on login failure', async () => {
    mocks.api.openaiLoginStart.mockResolvedValue({
      attemptId: 'a1',
      authUrl: 'https://example',
      expiresAt: Date.now() + 1000,
      browserOpened: true,
      browserError: null,
    });
    mocks.api.openaiLoginCancel.mockResolvedValue(undefined);
    await useAppStore.getState().startChatGptLogin('openai');
    await useAppStore.getState().cancelChatGptLogin('a1');
    expect(useAppStore.getState().loginChallenge).toBeNull();

    mocks.api.openaiLoginWait.mockRejectedValue(new Error('denied'));
    await expect(useAppStore.getState().awaitChatGptLogin('a2')).rejects.toThrow('denied');
    expect(useAppStore.getState().loginChallenge).toBeNull();
    expect(useAppStore.getState().error).toContain('denied');
  });

  it('signs out and refreshes auth state', async () => {
    mocks.api.openaiSignOut.mockResolvedValue(authStatus({ state: 'signed-out', planUsage: false }));
    mocks.api.openaiAuthStatus.mockResolvedValue([
      authStatus({ state: 'signed-out', planUsage: false }),
    ]);
    await useAppStore.getState().signOutProvider('openai');
    expect(mocks.api.openaiSignOut).toHaveBeenCalledWith('openai');
    expect(useAppStore.getState().auth[0].state).toBe('signed-out');
  });

  it('keys favorites by provider and keeps legacy ids working', () => {
    const store = useAppStore.getState();
    store.toggleFavorite('openai', 'gpt-6.1-sol');
    expect(useAppStore.getState().favorites).toContain(favoriteKey('openai', 'gpt-6.1-sol'));
    expect(useAppStore.getState().isFavorite('openai', 'gpt-6.1-sol')).toBe(true);

    // Legacy bare id still matches (old persisted favorites).
    useAppStore.setState({ favorites: ['gpt-6.1-sol'] });
    expect(useAppStore.getState().isFavorite('openai', 'gpt-6.1-sol')).toBe(true);

    // Toggling once migrates the legacy entry to the pair key.
    useAppStore.getState().toggleFavorite('openai', 'gpt-6.1-sol');
    expect(useAppStore.getState().favorites).not.toContain('gpt-6.1-sol');
    expect(useAppStore.getState().isFavorite('openai', 'gpt-6.1-sol')).toBe(false);
  });
});

describe('appStore — API key save', () => {
  const anthropicProvider: ProviderInfo = {
    id: 'anthropic',
    name: 'Anthropic',
    shortName: 'Anthropic',
    description: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    consoleUrl: 'https://platform.claude.com/settings/keys',
    endpoints: { anthropic: '/messages', models: '/models' },
    headers: { 'anthropic-version': '2026-10-21' },
    authEnv: 'ANTHROPIC_API_KEY',
    defaultModelId: 'claude-sonnet-5-5',
    models: [
      model('claude-sonnet-5-5', 'Claude Sonnet 5.5', {
        family: 'claude',
        protocols: ['anthropic'],
      }),
    ],
    notes: [],
  };

  /** Gateway providers (Go/Zen) do not declare a `models` endpoint. */
  const gatewayProvider: ProviderInfo = {
    ...anthropicProvider,
    id: 'opencode-go',
    name: 'OpenCode Go',
    shortName: 'Go',
    endpoints: { 'openai-chat': '/openai/v1/chat/completions' },
    authEnv: 'OPENCODE_API_KEY',
    defaultModelId: 'deepseek-v4.1-flash',
    models: [
      model('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', {
        family: 'deepseek',
        protocols: ['openai-chat'],
      }),
    ],
  };

  const anthropicKey = {
    providerId: 'anthropic',
    hasKey: true,
    masked: 'sk-ant…1234',
    source: 'settings' as const,
    mode: 'api-key' as const,
  };

  it('puxa e mescla a lista da conta assim que a API key é salva', async () => {
    useAppStore.setState({ providers: [anthropicProvider], keys: [] });
    const providerId = anthropicProvider.id;
    mocks.api.setProviderKey.mockResolvedValue({
      settings,
      keys: [anthropicKey],
      auth: [],
      secretsError: null,
    } satisfies SettingsView);
    mocks.api.refreshProviderModels.mockResolvedValue(
      catalogViewWith(
        [
          {
            ...anthropicProvider,
            models: [
              ...anthropicProvider.models,
              model('claude-sonnet-6', 'Claude Sonnet 6', {
                family: 'claude',
                protocols: ['anthropic'],
                estimated: true,
              }),
            ],
          },
        ],
        [anthropicKey],
      ),
    );

    await useAppStore.getState().setProviderKey(providerId, 'sk-ant-api03-chave');

    expect(mocks.api.setProviderKey).toHaveBeenCalledWith(providerId, 'sk-ant-api03-chave');
    expect(mocks.api.refreshProviderModels).toHaveBeenCalledWith(providerId);
    const provider = useAppStore.getState().providers.find((entry) => entry.id === providerId)!;
    expect(provider.models.map((entry) => entry.id)).toContain('claude-sonnet-6');
    expect(useAppStore.getState().keys[0].hasKey).toBe(true);
  });

  it('não tenta puxar modelos de provedores sem endpoint de modelos (Go/Zen)', async () => {
    useAppStore.setState({ providers: [gatewayProvider], keys: [] });
    mocks.api.setProviderKey.mockResolvedValue({
      settings,
      keys: [
        {
          providerId: 'opencode-go',
          hasKey: true,
          masked: 'sk-…1234',
          source: 'settings',
          mode: 'api-key',
        },
      ],
      auth: [],
      secretsError: null,
    } satisfies SettingsView);

    await useAppStore.getState().setProviderKey('opencode-go', 'sk-go-chave');

    expect(mocks.api.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('falha ao atualizar a lista não desfaz a chave salva nem vira erro do app', async () => {
    useAppStore.setState({ providers: [anthropicProvider], keys: [] });
    mocks.api.setProviderKey.mockResolvedValue({
      settings,
      keys: [anthropicKey],
      auth: [],
      secretsError: null,
    } satisfies SettingsView);
    mocks.api.refreshProviderModels.mockRejectedValue(new Error('rede indisponível'));

    await expect(
      useAppStore.getState().setProviderKey('anthropic', 'sk-ant-api03-chave'),
    ).resolves.toBeUndefined();

    expect(useAppStore.getState().keys[0].hasKey).toBe(true);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('remover a chave não tenta puxar modelos', async () => {
    useAppStore.setState({ providers: [anthropicProvider], keys: [anthropicKey] });
    mocks.api.setProviderKey.mockResolvedValue({
      settings,
      keys: [{ ...anthropicKey, hasKey: false, masked: null, source: 'none' }],
      auth: [],
      secretsError: null,
    } satisfies SettingsView);

    await useAppStore.getState().setProviderKey('anthropic', null);

    expect(mocks.api.refreshProviderModels).not.toHaveBeenCalled();
  });
});


describe('appStore — interface language', () => {
  afterEach(async () => {
    await setLanguage('pt-BR', { persist: false });
  });

  it('syncs the renderer language from persisted settings on init', async () => {
    mocks.api.getSettings.mockResolvedValue({
      ...settingsView(),
      settings: { ...settings, locale: 'es' },
    });
    await useAppStore.getState().init();
    expect(i18n.language).toBe('es');
  });

  it('applies a locale patch and rolls back when the backend rejects it', async () => {
    mocks.api.saveSettings.mockResolvedValueOnce({
      ...settingsView(),
      settings: { ...settings, locale: 'es' },
    });
    await useAppStore.getState().saveSettings({ locale: 'es' });
    expect(useAppStore.getState().settings.locale).toBe('es');
    expect(i18n.language).toBe('es');

    mocks.api.saveSettings.mockRejectedValueOnce(new Error('save failed'));
    await useAppStore.getState().saveSettings({ locale: 'en' });
    expect(useAppStore.getState().settings.locale).toBe('es');
    expect(i18n.language).toBe('es');
    expect(useAppStore.getState().error).toContain('save failed');
  });
});
