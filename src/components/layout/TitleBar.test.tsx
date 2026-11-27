// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const windowMock = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false),
  minimize: vi.fn(async () => undefined),
  maximize: vi.fn(async () => undefined),
  unmaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  onResized: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowMock }));
vi.mock('@/lib/api', () => ({ api: {} }));
vi.mock('@/components/chat/external', () => ({ openExternalUrl: vi.fn(async () => true) }));

// Imported after the mocks.
import { useAppStore, useUiStore } from '@/lib/store';
import type { ProviderAuthStatus, ProviderInfo } from '@/lib/types';
import { TitleBar } from './TitleBar';

function openAiProvider(): ProviderInfo {
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
  };
}

function planAuth(): ProviderAuthStatus {
  return {
    providerId: 'openai',
    mode: 'oauth',
    state: 'signed-in',
    accountLabel: 'user@example.com',
    planUsage: true,
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
  };
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ providers: [], auth: [], keys: [] });
  useUiStore.setState({ layoutMode: 'chat' });
});

describe('TitleBar', () => {
  it('mantém a marca e os controles nativos', async () => {
    render(<TitleBar />);

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());

    expect(screen.getByText('Zylara')).toBeTruthy();
    // The topbar search was removed; the command palette stays on ⌘/Ctrl+K.
    expect(screen.queryByRole('button', { name: 'Buscar conversas e comandos' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Minimizar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Maximizar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fechar' })).toBeTruthy();
  });

  it('não monta o seletor de modelo/pensamento (ele vive no composer do chat)', async () => {
    render(<TitleBar />);

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());

    expect(screen.queryByRole('button', { name: /Selecionar modelo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Selecionar modo de pensamento/ })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Selecionar modelo' })).toBeNull();
  });

  it('funde-se ao chrome: fundo surface e nenhuma borda inferior', async () => {
    render(<TitleBar />);

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());

    const header = screen.getByRole('banner');
    expect(header.className).toContain('bg-surface');
    // A divisão com o chat é feita pelo canto arredondado do painel, não por linha.
    expect(header.className).not.toContain('border');
  });

  it('mostra o selo "Plano ChatGPT" no chrome quando a conta usa o plano', async () => {
    useAppStore.setState({
      providers: [openAiProvider()],
      auth: [planAuth()],
      keys: [],
      selection: { providerId: 'openai', modelId: 'gpt-6.1-sol', reasoning: null },
    });
    render(<TitleBar />);

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());

    const header = screen.getByRole('banner');
    const chip = screen.getByText('Plano ChatGPT');
    expect(header.contains(chip)).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Gerenciar uso do plano ChatGPT' }),
    ).toBeTruthy();
  });

  it('não mostra o selo sem plano ativo', async () => {
    useAppStore.setState({
      providers: [openAiProvider()],
      auth: [{ ...planAuth(), planUsage: false, state: 'plan-disabled' }],
      keys: [],
      selection: { providerId: 'openai', modelId: 'gpt-6.1-sol', reasoning: null },
    });
    render(<TitleBar />);

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());

    expect(screen.queryByText('Plano ChatGPT')).toBeNull();
  });

  it('does not mount the layout selector in the title bar', async () => {
    render(<TitleBar />);

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());

    expect(screen.queryByRole('group', { name: 'Modo do aplicativo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Modo do aplicativo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Code' })).toBeNull();
  });
});
