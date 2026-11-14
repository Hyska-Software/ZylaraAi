// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Settings } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  dockerPullImage: vi.fn(),
  dockerStartDaemon: vi.fn(),
  dockerCleanup: vi.fn(),
  platformDiagnostics: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    saveSettings: mocks.saveSettings,
    dockerPullImage: mocks.dockerPullImage,
    dockerStartDaemon: mocks.dockerStartDaemon,
    dockerCleanup: mocks.dockerCleanup,
    platformDiagnostics: mocks.platformDiagnostics,
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { AgentsTab } from '@/components/settings/AgentsTab';
import { useAppStore } from '@/lib/store';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
    locale: 'pt-BR',
    defaultProvider: 'opencode-go',
    defaultModel: 'deepseek-v4.1-flash',
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
  }));
  mocks.dockerPullImage.mockResolvedValue('ghcr.io/hyska-software/zylara-computer:latest');
  mocks.dockerStartDaemon.mockResolvedValue({
    running: true,
    started: true,
    serverVersion: '27.0.0',
  });
  useAppStore.setState({ settings: settings() });
});

afterEach(() => cleanup());

describe('AgentsTab', () => {
  it('organiza concorrência, orçamento, notificações, navegador, apps e desktop', () => {
    render(<AgentsTab />);

    expect(screen.getByText('Execução e fila')).toBeTruthy();
    expect(screen.getByText('Orçamento')).toBeTruthy();
    expect(screen.getByText('Notificações')).toBeTruthy();
    expect(screen.getByText('Navegador controlado')).toBeTruthy();
    expect(screen.getByText('Apps do desktop')).toBeTruthy();
    expect(screen.getByText('Desktop privado (computer use)')).toBeTruthy();
  });

  it('salva os limites de concorrência e fila', async () => {
    render(<AgentsTab />);

    const turns = screen.getByLabelText('Máximo de turnos simultâneos') as HTMLInputElement;
    expect(turns.value).toBe('10');
    expect(turns.max).toBe('32');

    fireEvent.change(turns, { target: { value: '5' } });
    fireEvent.blur(turns);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ maxConcurrentTurns: 5 }),
      ),
    );

    const queue = screen.getByLabelText('Máximo de mensagens na fila por thread');
    fireEvent.change(queue, { target: { value: '30' } });
    fireEvent.blur(queue);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ maxQueueLengthPerThread: 30 }),
      ),
    );
  });

  it('normaliza a allowlist e a denylist do navegador ao sair do campo', async () => {
    render(<AgentsTab />);

    const allowed = screen.getByLabelText('Hosts permitidos no navegador');
    fireEvent.change(allowed, { target: { value: ' github.com, notion.so , ' } });
    fireEvent.blur(allowed);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          browserAllowedDomains: ['github.com', 'notion.so'],
        }),
      ),
    );

    const blocked = screen.getByLabelText('Hosts bloqueados no navegador');
    fireEvent.change(blocked, { target: { value: 'admin.interno' } });
    fireEvent.blur(blocked);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          browserBlockedDomains: ['admin.interno'],
        }),
      ),
    );
  });

  it('baixa a imagem publicada do computer use', async () => {
    render(<AgentsTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Baixar imagem do computer use' }));

    await waitFor(() =>
      expect(mocks.dockerPullImage).toHaveBeenCalledWith(
        'ghcr.io/hyska-software/zylara-computer:latest',
      ),
    );
  });

  it('oferece iniciar o Docker quando o download falha com o motor parado', async () => {
    mocks.dockerPullImage.mockRejectedValueOnce(
      'DOCKER_DAEMON_UNAVAILABLE: o motor do Docker não está respondendo',
    );
    render(<AgentsTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Baixar imagem do computer use' }));

    const start = await screen.findByRole('button', { name: 'Iniciar Docker' });
    fireEvent.click(start);

    await waitFor(() => expect(mocks.dockerStartDaemon).toHaveBeenCalled());
    // The download is retried once the engine answers.
    await waitFor(() => expect(mocks.dockerPullImage).toHaveBeenCalledTimes(2));
  });
});
