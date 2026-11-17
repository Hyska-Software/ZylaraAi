// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  pluginModesState: vi.fn(),
  setPluginMode: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

import { PluginModeChips } from '@/components/composer/PluginModeChips';
import { usePluginStore } from '@/lib/plugins/store';
import type { PluginModeView } from '@/lib/plugins/types';

const mode: PluginModeView = {
  key: 'com.acme.modes:review',
  pluginId: 'com.acme.modes',
  pluginName: 'Acme Modes',
  id: 'review',
  title: 'Review',
  description: 'Read the diff before answering',
  profiles: ['chat', 'code'],
  toolsAdd: ['web_search'],
  toolsRemove: ['install_plugin'],
  writesBlocked: true,
  defaultOn: false,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pluginModesState.mockResolvedValue({ on: [], off: [] });
  mocks.setPluginMode.mockResolvedValue({ on: [mode.key], off: [] });
  usePluginStore.setState((state) => ({
    snapshot: { ...state.snapshot, modes: [mode] },
  }));
});

describe('PluginModeChips', () => {
  afterEach(() => cleanup());

  it('renders one chip per mode of the profile', async () => {
    render(<PluginModeChips conversationId="conv-1" profile="chat" />);
    const chips = await screen.findAllByRole('button', { name: /Review/ });
    expect(chips).toHaveLength(1);
    expect(mocks.pluginModesState).toHaveBeenCalledWith('conv-1');
  });

  it('toggles the mode for the open conversation', async () => {
    render(<PluginModeChips conversationId="conv-1" profile="chat" />);
    const [chip] = await screen.findAllByRole('button', { name: /Review/ });
    chip.click();
    await waitFor(() =>
      expect(mocks.setPluginMode).toHaveBeenCalledWith('conv-1', mode.key, true),
    );
  });

  it('hides modes that do not apply to the profile', async () => {
    usePluginStore.setState((state) => ({
      snapshot: {
        ...state.snapshot,
        modes: [{ ...mode, key: 'com.acme.modes:code-only', id: 'code-only', profiles: ['code'] }],
      },
    }));
    const { container } = render(<PluginModeChips conversationId="conv-1" profile="chat" />);
    await waitFor(() => expect(container.childElementCount).toBe(0));
  });
});
