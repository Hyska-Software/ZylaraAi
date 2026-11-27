// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UpdateInfo } from '@/lib/types';

vi.mock('@/components/plugins/PluginHosts', () => ({ PluginSlot: () => null }));

// Imported after the mocks above.
import { initialUpdateState, useUpdateStore } from '@/lib/store';
import { GlobalActions } from './ChromeActions';

function releaseInfo(): UpdateInfo {
  return {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    available: true,
    releaseName: 'Zylara v0.2.0',
    releasedAt: '2026-11-01T12:00:00Z',
    htmlUrl: 'https://github.com/Hyska-Software/ZylaraAi/releases/tag/v0.2.0',
    asset: null,
    checkedAt: 1,
    stale: false,
  };
}

beforeEach(() => {
  cleanup();
  useUpdateStore.setState({
    ...initialUpdateState(),
    hydrated: true,
    info: releaseInfo(),
    phase: 'available',
  });
});

describe('GlobalActions', () => {
  it('does not render the update pill in the center chrome row', () => {
    const { container } = render(<GlobalActions />);

    expect(container.querySelector('[data-chrome-actions]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Atualização v0.2.0 disponível' })).toBeNull();
  });
});
