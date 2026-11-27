// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UpdateInfo } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  getUpdateNotes: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// Imported after the mocks above.
import { initialUpdateState, useUpdateStore } from '@/lib/store';
import { SidebarChromeRow } from './SidebarChromeRow';

function releaseInfo(): UpdateInfo {
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
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useUpdateStore.setState({
    ...initialUpdateState(),
    hydrated: true,
    info: releaseInfo(),
    phase: 'available',
  });
});

describe('SidebarChromeRow', () => {
  it('renders the update pill in the sidebar chrome row', () => {
    const { container } = render(<SidebarChromeRow />);
    const row = container.firstElementChild as HTMLElement;
    const trigger = screen.getByRole('button', { name: 'Atualização v0.2.0 disponível' });

    expect(row.contains(trigger)).toBe(true);
  });

  it('keeps the update pill and the close button in drawer mode', () => {
    render(<SidebarChromeRow onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Atualização v0.2.0 disponível' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fechar barra lateral' })).toBeTruthy();
  });
});
