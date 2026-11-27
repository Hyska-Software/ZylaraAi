// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

const mocks = vi.hoisted(() => ({
  setProviderKey: vi.fn(),
  validateProvider: vi.fn(),
  openaiLoginStart: vi.fn(),
  openaiLoginWait: vi.fn(),
  openaiLoginCancel: vi.fn(),
  openaiSignOut: vi.fn(),
  openaiAuthStatus: vi.fn(),
  getSettings: vi.fn(),
  refreshProviderModels: vi.fn(),
  openDataDir: vi.fn(),
  openExternal: vi.fn(),
  copyText: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    setProviderKey: mocks.setProviderKey,
    validateProvider: mocks.validateProvider,
    openaiLoginStart: mocks.openaiLoginStart,
    openaiLoginWait: mocks.openaiLoginWait,
    openaiLoginCancel: mocks.openaiLoginCancel,
    openaiSignOut: mocks.openaiSignOut,
    openaiAuthStatus: mocks.openaiAuthStatus,
    getSettings: mocks.getSettings,
    refreshProviderModels: mocks.refreshProviderModels,
    openDataDir: mocks.openDataDir,
  },
}));

vi.mock('@/lib/genui/open-external', () => ({
  openExternal: mocks.openExternal,
}));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, copyText: mocks.copyText };
});

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// Imported after the mocks above.
import { ProvidersTab } from '@/components/settings/ProvidersTab';
import { catalog } from '@/lib/catalog';
import type {
  LoginChallenge,
  ProviderAuthStatus,
  ProviderInfo,
  ProviderKeyStatus,
} from '@/lib/types';
import { useAppStore } from '@/lib/store';

afterEach(() => cleanup());

const GO = 'opencode-go';
const ZEN = 'opencode-zen';
const OPENAI = 'openai';
const ANTHROPIC = 'anthropic';

const GO_KEY: ProviderKeyStatus = { providerId: GO, hasKey: true, source: 'settings', masked: 'sk-…go01' };
const ZEN_KEY: ProviderKeyStatus = { providerId: ZEN, hasKey: true, source: 'settings', masked: 'sk-…zen1' };
const OPENAI_NO_KEY: ProviderKeyStatus = { providerId: OPENAI, hasKey: false, source: 'none' };
const ANTHROPIC_NO_KEY: ProviderKeyStatus = {
  providerId: ANTHROPIC,
  hasKey: false,
  source: 'none',
};

/** Fresh copy of the key-status fixtures used by the mocked settings views. */
function defaultKeys(): ProviderKeyStatus[] {
  return [GO_KEY, ZEN_KEY, OPENAI_NO_KEY, ANTHROPIC_NO_KEY];
}

const CHALLENGE: LoginChallenge = {
  attemptId: 'attempt-1',
  authUrl: 'https://auth.openai.com/api/accounts/authorize?state=abc',
  expiresAt: Date.now() + 10 * 60_000,
  browserOpened: true,
  browserError: null,
};

const SIGNED_IN: ProviderAuthStatus = {
  providerId: OPENAI,
  mode: 'oauth',
  state: 'signed-in',
  accountLabel: 'user@example.com',
  planUsage: true,
  expiresAt: Date.now() + 3_600_000,
  scopes: ['openid', 'profile', 'email', 'offline_access', 'chatgpt.tokens.use.direct'],
  clientIdMasked: 'oaiapp_…1234',
  hostIdMasked: 'urn:uuid:…5678',
  hint: null,
};

function signedInStatus(overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return { ...SIGNED_IN, ...overrides };
}

function settingsView(keys: ProviderKeyStatus[], auth: ProviderAuthStatus[] = []) {
  return { settings: useAppStore.getState().settings, keys, auth };
}

/** The Connect/Manage button of a provider row (exact accessible name). */
function rowButton(name: string): HTMLElement {
  const button =
    screen.queryByRole('button', { name: `Conectar ${name}` }) ??
    screen.queryByRole('button', { name: `Gerenciar ${name}` });
  if (!button) throw new Error(`provider row not found: ${name}`);
  return button;
}

function providerRow(name: string): HTMLElement {
  return rowButton(name).closest('li') as HTMLElement;
}

/** Opens the configuration modal of a provider row. */
async function openConfig(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(rowButton(name));
  return screen.findByRole('dialog', {
    name: new RegExp(`(Conectar|Gerenciar) ${name.replace(/[()]/g, '\\$&')}`),
  });
}

async function renderTab() {
  render(<ProvidersTab />);
  return screen.findByRole('heading', { level: 3, name: 'Provedores populares' });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.validateProvider.mockResolvedValue({
    providerId: GO,
    ok: true,
    latencyMs: 12,
    models: 27,
  });
  mocks.openaiAuthStatus.mockResolvedValue([]);
  mocks.copyText.mockResolvedValue(true);
  mocks.refreshProviderModels.mockResolvedValue({
    catalog,
    keys: defaultKeys(),
    auth: [],
  });
  mocks.setProviderKey.mockImplementation(async (providerId: string, key: string | null) => {
    const nextKeys: ProviderKeyStatus[] = defaultKeys().map((entry) =>
      entry.providerId === providerId
        ? {
            ...entry,
            hasKey: key != null,
            source: key != null ? 'settings' : 'none',
            masked: key != null ? 'sk-…novo' : null,
          }
        : entry,
    );
    return settingsView(nextKeys);
  });
  mocks.getSettings.mockImplementation(async () => settingsView(defaultKeys()));
  useAppStore.setState({
    providers: catalog.providers,
    keys: defaultKeys(),
    auth: [],
    secretsError: null,
    error: null,
    loginChallenge: null,
  });
});

describe('ProvidersTab — lista de provedores', () => {
  it('lista os provedores populares com ícone, descrição, status e botão', async () => {
    await renderTab();

    for (const name of ['OpenCode Go', 'OpenCode Zen', 'OpenAI (ChatGPT)', 'Anthropic', 'Google Gemini']) {
      expect(providerRow(name)).toBeTruthy();
    }

    // Recommended provider: chip + OpenCode glyph + configured chip.
    const go = providerRow('OpenCode Go');
    expect(within(go).getByText('Recomendado')).toBeTruthy();
    expect(within(go).getByTitle('OpenCode')).toBeTruthy();
    expect(within(go).getByText('Configurada')).toBeTruthy();

    // Short catalog copy doubles as the row subtitle.
    expect(within(providerRow('Anthropic')).getByText(/Acesso direto aos modelos Claude/)).toBeTruthy();
    expect(
      within(providerRow('Google Gemini')).getByText(/Modelos Gemini com uma API key/),
    ).toBeTruthy();

    // Unconfigured providers show only the Connect action (no status chip).
    const openai = providerRow('OpenAI (ChatGPT)');
    expect(within(openai).getByRole('button', { name: 'Conectar OpenAI (ChatGPT)' })).toBeTruthy();
    expect(within(openai).queryByText('Chave ausente')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ver mais provedores' })).toBeTruthy();
  });

  it('abre o modal ao clicar em Conectar e salva a API key', async () => {
    useAppStore.setState({
      keys: [
        { providerId: GO, hasKey: false, source: 'none' },
        ZEN_KEY,
        OPENAI_NO_KEY,
        ANTHROPIC_NO_KEY,
      ],
    });
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenCode Go');
    const input = within(dialog).getByLabelText('API key de OpenCode Go') as HTMLInputElement;
    expect(input.placeholder).toBe('Colar API key do OpenCode Console…');

    await user.type(input, 'sk-go-nova');
    await user.click(within(dialog).getByRole('button', { name: 'Continuar' }));

    await waitFor(() => {
      expect(mocks.setProviderKey).toHaveBeenCalledWith(GO, 'sk-go-nova');
    });
  });

  it('Enter no campo salva a chave e o placeholder pede substituição quando já existe uma', async () => {
    useAppStore.setState({
      keys: [
        GO_KEY,
        { providerId: ZEN, hasKey: false, source: 'none' },
        OPENAI_NO_KEY,
        ANTHROPIC_NO_KEY,
      ],
    });
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenCode Zen');
    const input = within(dialog).getByLabelText('API key de OpenCode Zen') as HTMLInputElement;
    expect(input.placeholder).toBe('Colar API key do OpenCode Console…');
    await user.type(input, 'sk-zen-nova{Enter}');

    await waitFor(() => {
      expect(mocks.setProviderKey).toHaveBeenCalledWith(ZEN, 'sk-zen-nova');
    });

    // Close the current modal before opening another provider's configuration.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // With a saved key the field switches to the "replace" hint.
    const goDialog = await openConfig(user, 'OpenCode Go');
    const goInput = within(goDialog).getByLabelText('API key de OpenCode Go') as HTMLInputElement;
    expect(goInput.placeholder).toBe('Colar nova chave para substituir…');
  });

  it('modal do Anthropic: console, remoção e teste de conexão, sem fluxo ChatGPT', async () => {
    mocks.validateProvider.mockResolvedValue({
      providerId: ANTHROPIC,
      ok: true,
      latencyMs: 8,
      models: 14,
    });
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'Anthropic');
    expect(within(dialog).getByText(/conectar sua conta Anthropic/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Continuar com ChatGPT/ })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Console' }));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://platform.claude.com/settings/keys');

    await user.click(within(dialog).getByRole('button', { name: 'Testar conexão' }));
    await waitFor(() => expect(mocks.validateProvider).toHaveBeenCalledWith(ANTHROPIC));
    expect(await within(dialog).findByText(/Conectado · 8 ms · 14 modelos/)).toBeTruthy();
  });

  it('modal mostra a chave mascarada e permite removê-la', async () => {
    useAppStore.setState({
      keys: [
        GO_KEY,
        ZEN_KEY,
        OPENAI_NO_KEY,
        { providerId: ANTHROPIC, hasKey: true, source: 'settings', masked: 'sk-ant-…9999' },
      ],
    });
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'Anthropic');
    expect(within(dialog).getByText('sk-ant-…9999')).toBeTruthy();
    expect(within(dialog).getByText(/env:/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(mocks.setProviderKey).toHaveBeenCalledWith(ANTHROPIC, null));
  });

  it('OpenAI sem login oferece Continuar com ChatGPT e a alternativa de API key', async () => {
    await renderTab();
    const user = userEvent.setup();
    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');

    expect(within(dialog).getByRole('button', { name: /Continuar com ChatGPT/ })).toBeTruthy();
    expect(within(dialog).getByText(/o limite é compartilhado/i)).toBeTruthy();
    expect(within(dialog).queryByLabelText('API key de OpenAI (ChatGPT)')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Usar API key' }));

    const input = within(dialog).getByLabelText('API key de OpenAI (ChatGPT)') as HTMLInputElement;
    expect(input.placeholder).toBe('Colar API key da OpenAI…');
    await user.type(input, 'sk-openai-123');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(mocks.setProviderKey).toHaveBeenCalledWith(OPENAI, 'sk-openai-123');
    });
  });

  it('dois fases do login: aguardando o navegador, copiar/reabrir link e cancelar', async () => {
    mocks.openaiLoginStart.mockResolvedValue(CHALLENGE);
    // Keeps the wait pending so the UI stays in the two-phase "awaiting" state.
    mocks.openaiLoginWait.mockReturnValue(new Promise(() => {}));
    mocks.openaiLoginCancel.mockResolvedValue(undefined);
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    await user.click(within(dialog).getByRole('button', { name: /Continuar com ChatGPT/ }));

    await within(dialog).findByText('Aguardando o navegador…');
    expect(mocks.openaiLoginStart).toHaveBeenCalledWith(OPENAI, false);
    expect(useAppStore.getState().loginChallenge?.attemptId).toBe('attempt-1');
    expect(within(dialog).queryByText('O navegador não abriu automaticamente')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: /Copiar link/ }));
    expect(mocks.copyText).toHaveBeenCalledWith(CHALLENGE.authUrl);
    expect(await within(dialog).findByRole('button', { name: /Link copiado/ })).toBeTruthy();

    // The raw URL stays available even when the clipboard is unavailable.
    await user.click(within(dialog).getByText('Mostrar link de login'));
    expect(within(dialog).getByText(CHALLENGE.authUrl)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /Abrir novamente/ }));
    expect(mocks.openExternal).toHaveBeenCalledWith(CHALLENGE.authUrl);

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(mocks.openaiLoginCancel).toHaveBeenCalledWith('attempt-1'));
    await waitFor(() => expect(within(dialog).queryByText('Aguardando o navegador…')).toBeNull());
  });

  it('quando o navegador não abre, avisa e prioriza o link copiável', async () => {
    mocks.openaiLoginStart.mockResolvedValue({
      ...CHALLENGE,
      browserOpened: false,
      browserError: 'Launcher "xdg-open" failed with exit status: 3',
    });
    mocks.openaiLoginWait.mockReturnValue(new Promise(() => {}));
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    await user.click(within(dialog).getByRole('button', { name: /Continuar com ChatGPT/ }));

    expect(await within(dialog).findByText('O navegador não abriu automaticamente')).toBeTruthy();
    expect(within(dialog).getByText(/xdg-open/)).toBeTruthy();
    // The copy button becomes the primary action in this state.
    expect(
      (within(dialog).getByRole('button', { name: /Copiar link/ }) as HTMLButtonElement).className,
    ).toContain('bg-foreground');

    await user.click(within(dialog).getByRole('button', { name: /Copiar link/ }));
    expect(mocks.copyText).toHaveBeenCalledWith(CHALLENGE.authUrl);
  });

  it('falha ao copiar mantém o estado pendente e reporta o erro', async () => {
    mocks.openaiLoginStart.mockResolvedValue(CHALLENGE);
    mocks.openaiLoginWait.mockReturnValue(new Promise(() => {}));
    mocks.copyText.mockResolvedValue(false);
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    await user.click(within(dialog).getByRole('button', { name: /Continuar com ChatGPT/ }));
    await within(dialog).findByText('Aguardando o navegador…');

    await user.click(within(dialog).getByRole('button', { name: /Copiar link/ }));
    expect(within(dialog).getByRole('button', { name: /Copiar link/ })).toBeTruthy();
    expect(within(dialog).getByText('Aguardando o navegador…')).toBeTruthy();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Não foi possível copiar o link',
      expect.anything(),
    );
  });

  it('conta conectada: e-mail, selo, detalhes, Gerenciar uso e Sair', async () => {
    useAppStore.setState({ auth: [signedInStatus()] });
    mocks.openaiSignOut.mockResolvedValue(signedInStatus({ state: 'signed-out', planUsage: false }));
    mocks.openaiAuthStatus.mockResolvedValue([]);
    await renderTab();
    const user = userEvent.setup();

    // The list row reflects the connected account.
    const row = providerRow('OpenAI (ChatGPT)');
    expect(within(row).getByText('Plano ChatGPT')).toBeTruthy();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    expect(within(dialog).getAllByText('user@example.com').length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole('button', { name: /Continuar com ChatGPT/ })).toBeNull();

    // Collapsible account details (masked ids/scopes/expiry — never tokens).
    await user.click(within(dialog).getByText('Detalhes da conta'));
    expect(within(dialog).getByText('oaiapp_…1234')).toBeTruthy();
    expect(within(dialog).getByText('urn:uuid:…5678')).toBeTruthy();
    expect(within(dialog).getByText(/chatgpt\.tokens\.use\.direct/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /Gerenciar uso/ }));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://chatgpt.com/settings/usage');

    await user.click(within(dialog).getByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(mocks.openaiSignOut).toHaveBeenCalledWith(OPENAI));
  });

  it('plano desativado pede consentimento explícito', async () => {
    useAppStore.setState({
      auth: [signedInStatus({ state: 'plan-disabled', planUsage: false })],
    });
    mocks.openaiLoginStart.mockResolvedValue(CHALLENGE);
    mocks.openaiLoginWait.mockReturnValue(new Promise(() => {}));
    await renderTab();
    const user = userEvent.setup();

    expect(within(providerRow('OpenAI (ChatGPT)')).getByText('Plano não ativado')).toBeTruthy();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    expect(within(dialog).getByText(/uso do plano ChatGPT não está ativado/i)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Ativar uso do plano' }));

    await waitFor(() => expect(mocks.openaiLoginStart).toHaveBeenCalledWith(OPENAI, true));
  });

  it('sessão expirada mostra Conectar novamente', async () => {
    useAppStore.setState({
      auth: [signedInStatus({ state: 'reauth-required', planUsage: false, hint: 'Entre novamente.' })],
    });
    mocks.openaiLoginStart.mockResolvedValue(CHALLENGE);
    mocks.openaiLoginWait.mockReturnValue(new Promise(() => {}));
    await renderTab();
    const user = userEvent.setup();

    expect(within(providerRow('OpenAI (ChatGPT)')).getByText('Sessão expirada')).toBeTruthy();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    expect(within(dialog).getByText('Sessão do ChatGPT expirada')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Conectar novamente' }));

    await waitFor(() => expect(mocks.openaiLoginStart).toHaveBeenCalledWith(OPENAI, false));
  });

  it('mostra o aviso de primeiro login uma única vez', async () => {
    mocks.openaiLoginStart.mockResolvedValue(CHALLENGE);
    mocks.openaiLoginWait.mockResolvedValue(signedInStatus());
    mocks.openaiAuthStatus.mockResolvedValue([signedInStatus()]);
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    await user.click(within(dialog).getByRole('button', { name: /Continuar com ChatGPT/ }));

    const notice = await screen.findByRole('dialog', { name: 'Você está usando seu plano ChatGPT' });
    await user.click(within(notice).getByRole('button', { name: 'Entendi' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Você está usando seu plano ChatGPT' }),
      ).toBeNull(),
    );
    expect(window.localStorage.getItem('zylara.openaiPlanNoticeShown')).toBe('1');

    // A fresh mount reads the persisted flag and never shows the notice again.
    cleanup();
    const second = userEvent.setup();
    useAppStore.setState({
      auth: [],
      loginChallenge: null,
      keys: defaultKeys(),
    });
    render(<ProvidersTab />);
    const secondDialog = await openConfig(second, 'OpenAI (ChatGPT)');
    await second.click(within(secondDialog).getByRole('button', { name: /Continuar com ChatGPT/ }));
    await waitFor(() => expect(mocks.openaiLoginStart).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole('dialog', { name: 'Você está usando seu plano ChatGPT' }),
    ).toBeNull();
  });

  it('não renderiza material de credencial mesmo se o status trouxer campos extras', async () => {
    const hostile = {
      ...signedInStatus(),
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.accesso.secret',
      refreshToken: 'rt-secret',
      idToken: 'id-secret',
      access_token: 'snake-secret',
    } as unknown as ProviderAuthStatus;
    useAppStore.setState({ auth: [hostile] });
    await renderTab();
    const user = userEvent.setup();

    const dialog = await openConfig(user, 'OpenAI (ChatGPT)');
    await user.click(within(dialog).getByText('Detalhes da conta'));

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text).not.toContain('rt-secret');
    expect(text).not.toContain('id-secret');
    expect(text).not.toContain('snake-secret');
    expect(text).toContain('oaiapp_…1234');
  });

  it('mostra o aviso de secrets.json inválido sem ação destrutiva', async () => {
    useAppStore.setState({ secretsError: 'expected value at line 1 column 1' });
    mocks.openDataDir.mockResolvedValue(undefined);
    await renderTab();
    const user = userEvent.setup();

    expect(screen.getByText(/Não foi possível ler o arquivo de segredos/)).toBeTruthy();
    expect(screen.getByText(/expected value at line 1 column 1/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Abrir pasta de dados/ }));
    await waitFor(() => expect(mocks.openDataDir).toHaveBeenCalled());
  });

  it('mostra os erros do store em linha e permite dispensá-los', async () => {
    useAppStore.setState({ error: 'Falha ao salvar a chave' });
    await renderTab();
    const user = userEvent.setup();

    expect(screen.getByText('A última ação falhou')).toBeTruthy();
    expect(screen.getByText('Falha ao salvar a chave')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(useAppStore.getState().error).toBeNull();
    await waitFor(() => expect(screen.queryByText('A última ação falhou')).toBeNull());
  });
});

describe('ProvidersTab — Ver mais provedores', () => {
  /** Only the curated providers remain, so the dialog shows the empty state. */
  function curatedOnly() {
    const curated = new Set(['opencode-go', 'opencode-zen', 'openai', 'anthropic', 'gemini']);
    useAppStore.setState({
      providers: catalog.providers.filter((provider) => curated.has(provider.id)),
    });
  }

  it('mostra o estado vazio quando só os provedores populares existem', async () => {
    curatedOnly();
    await renderTab();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Ver mais provedores' }));

    const dialog = await screen.findByRole('dialog', { name: 'Ver mais provedores' });
    expect(within(dialog).getByText('Mais provedores em breve')).toBeTruthy();
    expect(
      within(dialog).getByText(/Novos provedores aparecem aqui assim que forem suportados/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('listitem')).toBeNull();
    expect(within(dialog).queryByRole('searchbox')).toBeNull();
  });

  it('agrupa os provedores de API key pela categoria do catálogo e filtra pela busca', async () => {
    await renderTab();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Ver mais provedores' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ver mais provedores' });

    // Groups come from the catalog `category`, in display order.
    expect(within(dialog).getByRole('heading', { name: 'Laboratórios de modelos' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Agregadores' })).toBeTruthy();
    expect(
      within(dialog).getByRole('heading', { name: 'Provedores de inferência' }),
    ).toBeTruthy();

    // Curated providers stay in the popular list only.
    expect(within(dialog).queryByText('OpenCode Go')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Conectar DeepSeek' })).toBeTruthy();
    // Bundled brand mark for a newly supported provider (`<title>` inside the SVG
    // and the glyph tooltip both carry the vendor name).
    expect(within(dialog).getAllByTitle('DeepSeek').length).toBeGreaterThan(0);

    const search = within(dialog).getByRole('searchbox', { name: 'Buscar provedores…' });
    await user.type(search, 'groq');

    await waitFor(() =>
      expect(within(dialog).queryByRole('button', { name: 'Conectar DeepSeek' })).toBeNull(),
    );
    expect(within(dialog).getByRole('button', { name: 'Conectar Groq' })).toBeTruthy();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(await within(dialog).findByText(/Nenhum provedor corresponde/)).toBeTruthy();
  });

  it('conecta um provedor novo direto do diálogo', async () => {
    await renderTab();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Ver mais provedores' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ver mais provedores' });
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Buscar provedores…' }),
      'deepseek',
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Conectar DeepSeek' }));

    const config = await screen.findByRole('dialog', { name: 'Conectar DeepSeek' });
    await user.type(within(config).getByLabelText('API key de DeepSeek'), 'sk-ds-123');
    await user.click(within(config).getByRole('button', { name: 'Continuar' }));

    await waitFor(() =>
      expect(mocks.setProviderKey).toHaveBeenCalledWith('deepseek', 'sk-ds-123'),
    );
  });

  it('provedor sem marca usa as iniciais e, sem categoria, cai em "Outros provedores"', async () => {
    const future: ProviderInfo = {
      ...catalog.providers[1],
      id: 'acme-gateway',
      name: 'Acme Gateway',
      shortName: 'Acme',
      description: 'Modelos agregados de vários provedores.',
      consoleUrl: 'https://acme.dev/keys',
      authEnv: 'ACME_API_KEY',
      category: null,
      notes: [],
      models: [],
    };
    useAppStore.setState({ providers: [...catalog.providers, future] });
    await renderTab();
    const user = userEvent.setup();

    expect(screen.queryByRole('button', { name: 'Conectar Acme Gateway' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Ver mais provedores' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ver mais provedores' });
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Buscar provedores…' }),
      'acme',
    );

    const row = await within(dialog).findByRole('listitem');
    expect(within(dialog).getByRole('heading', { name: 'Outros provedores' })).toBeTruthy();
    expect(within(row).getByText('Acme Gateway')).toBeTruthy();
    // No bundled brand mark: falls back to the provider name initials.
    expect(within(row).getByText('AG')).toBeTruthy();

    await user.click(within(row).getByRole('button', { name: 'Conectar Acme Gateway' }));

    const config = await screen.findByRole('dialog', { name: 'Conectar Acme Gateway' });
    await user.type(within(config).getByLabelText('API key de Acme Gateway'), 'sk-acme-1');
    await user.click(within(config).getByRole('button', { name: 'Continuar' }));

    await waitFor(() =>
      expect(mocks.setProviderKey).toHaveBeenCalledWith('acme-gateway', 'sk-acme-1'),
    );
  });
});

describe('ProvidersTab — seção de confiabilidade', () => {
  it('abre e recolhe a seção inteira ao clicar no cabeçalho', async () => {
    await renderTab();
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: /Confiabilidade/ });
    const headersTimeout = () =>
      screen.queryByRole('spinbutton', { name: 'Timeout dos headers (s)' });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(headersTimeout()).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(headersTimeout()).not.toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(headersTimeout()).toBeNull();
  });
});
