import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DownloadedUpdate, UpdateInfo, UpdateStatus } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  updateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  getUpdateNotes: vi.fn(),
  downloadUpdate: vi.fn(),
  cancelUpdateDownload: vi.fn(),
  installUpdate: vi.fn(),
  revealUpdate: vi.fn(),
  setUpdatePreferences: vi.fn(),
  skipUpdateVersion: vi.fn(),
  markUpdateNotified: vi.fn(),
  acknowledgeUpdateResult: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// Imported after the mocks above.
import { initialUpdateState, useUpdateStore } from '@/lib/store';
import { UpdateChip } from './UpdateChip';

function releaseInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    available: true,
    releaseName: 'Zylara v0.2.0',
    releasedAt: '2026-11-01T12:00:00Z',
    htmlUrl: 'https://github.com/Hyska-Software/ZylaraAi/releases/tag/v0.2.0',
    asset: {
      name: 'Zylara-Setup-0.2.0-windows-x64.exe',
      size: 100,
      sha256: 'a'.repeat(64),
      downloadUrl:
        'https://github.com/Hyska-Software/ZylaraAi/releases/download/v0.2.0/Zylara-Setup-0.2.0-windows-x64.exe',
      platformLabel: 'Windows x64',
      kind: 'setup',
    },
    checkedAt: 1,
    stale: false,
    ...overrides,
  };
}

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    currentVersion: '0.1.0',
    preferences: {
      autoCheck: true,
      lastCheckAt: Date.now() - 60_000,
      skippedVersion: null,
      notifiedVersion: null,
    },
    info: null,
    download: null,
    managed: { mode: 'manual', supported: false, reason: null },
    ...overrides,
  };
}

const downloaded: DownloadedUpdate = {
  version: '0.2.0',
  path: 'C:\\Users\\ana\\AppData\\Roaming\\app.zylara.chat\\updates\\0.2.0\\setup.exe',
  size: 100,
  sha256: 'a'.repeat(64),
};

function seed(overrides: Partial<ReturnType<typeof initialUpdateState>> = {}) {
  useUpdateStore.setState({
    ...initialUpdateState(),
    hydrated: true,
    ...overrides,
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  seed();
  mocks.getUpdateNotes.mockResolvedValue({
    notes: 'Correções e melhorias',
    releasedAt: '2026-11-01T12:00:00Z',
    htmlUrl: 'https://github.com/Hyska-Software/ZylaraAi/releases/tag/v0.2.0',
  });
  mocks.skipUpdateVersion.mockResolvedValue(status());
});

describe('UpdateChip', () => {
  it('renders nothing when there is no update', () => {
    const { container } = render(<UpdateChip />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the available version in the chrome row and opens the panel', async () => {
    seed({ info: releaseInfo(), phase: 'available' });
    render(<UpdateChip />);

    const trigger = screen.getByRole('button', {
      name: 'Atualização v0.2.0 disponível',
    });
    expect(trigger).toBeTruthy();

    await userEvent.click(trigger);
    expect(await screen.findByText('Nova versão disponível')).toBeTruthy();
    expect(screen.getByText('Zylara v0.2.0 · publicada em 01 de nov. de 2026')).toBeTruthy();
    expect(mocks.getUpdateNotes).toHaveBeenCalledWith('0.2.0');
    expect(await screen.findByText(/Correções e melhorias/)).toBeTruthy();
  });

  it('shows live download progress in the trigger and the panel', async () => {
    seed({
      info: releaseInfo(),
      phase: 'downloading',
      progress: { received: 40, total: 100, percent: 40, bytesPerSec: 20 },
      open: true,
    });
    render(<UpdateChip />);

    expect(screen.getByRole('button', { name: 'Baixando atualização — 40%' })).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByText('40 B de 100 B')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
  });

  it('keeps the Windows setup flow when managed installs are unsupported', async () => {
    seed({
      info: releaseInfo(),
      downloaded,
      managed: { mode: 'manual', supported: false, reason: 'unsupported-platform' },
      phase: 'ready',
    });
    mocks.installUpdate.mockResolvedValue(undefined);
    render(<UpdateChip />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Atualização v0.2.0 pronta para instalar' }),
    );
    expect(screen.queryByRole('button', { name: 'Instalar e reiniciar' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: /Instalar agora/ }));
    expect(mocks.installUpdate).toHaveBeenCalledWith('0.2.0');
  });

  it('offers install and restart for a managed AppImage', async () => {
    seed({
      info: releaseInfo({
        asset: {
          name: 'Zylara-0.2.0-linux-x64.AppImage',
          size: 100,
          sha256: 'a'.repeat(64),
          downloadUrl:
            'https://github.com/Hyska-Software/ZylaraAi/releases/download/v0.2.0/Zylara-0.2.0-linux-x64.AppImage',
          platformLabel: 'Linux x64 · AppImage',
          kind: 'appimage',
        },
      }),
      downloaded: { ...downloaded, path: '/home/ana/updates/0.2.0/app.AppImage' },
      managed: { mode: 'managed', supported: true },
      phase: 'ready',
    });
    mocks.installUpdate.mockResolvedValue(undefined);
    render(<UpdateChip />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Atualização v0.2.0 pronta para instalar' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Instalar e reiniciar' }));
    expect(mocks.installUpdate).toHaveBeenCalledWith('0.2.0');
  });

  it('uses the managed closing label while installing', () => {
    seed({
      info: releaseInfo({
        asset: {
          name: 'Zylara-0.2.0-linux-x64.AppImage',
          size: 100,
          sha256: 'a'.repeat(64),
          downloadUrl:
            'https://github.com/Hyska-Software/ZylaraAi/releases/download/v0.2.0/Zylara-0.2.0-linux-x64.AppImage',
          platformLabel: 'Linux x64 · AppImage',
          kind: 'appimage',
        },
      }),
      managed: { mode: 'managed', supported: true },
      phase: 'installing',
    });
    render(<UpdateChip />);
    expect(
      screen.getByRole('button', { name: 'Fechando o Zylara para aplicar a atualização' }),
    ).toBeTruthy();
  });

  it('ignores a version from the panel', async () => {
    seed({ info: releaseInfo(), phase: 'available' });
    render(<UpdateChip />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Atualização v0.2.0 disponível' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Ignorar esta versão' }));
    expect(mocks.skipUpdateVersion).toHaveBeenCalledWith('0.2.0');
  });

  it('keeps the chip visible when the panel is dismissed', async () => {
    seed({ info: releaseInfo(), phase: 'available' });
    render(<UpdateChip />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Atualização v0.2.0 disponível' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Agora não' }));
    expect(useUpdateStore.getState().open).toBe(false);
    expect(useUpdateStore.getState().info).not.toBeNull();
  });
});
