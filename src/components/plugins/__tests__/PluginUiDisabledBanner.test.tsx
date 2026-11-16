// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: { pluginRpc: vi.fn(() => Promise.resolve({})) },
}));

import { PluginUiDisabledBanner } from '@/components/plugins/PluginUiDisabledBanner';
import { usePluginStore } from '@/lib/plugins/store';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { hasPluginUiContributions, setPluginUiState } from '@/lib/plugins/ui/registry';
import type { NavEntry, PluginUiState } from '@/lib/plugins/ui/types';
import { useUiStore } from '@/lib/store/uiStore';

const plugin = { id: 'com.acme.insights', name: 'Insights' } as never;

const navEntry: NavEntry = {
  key: 'com.acme.insights:nav:insights',
  source: 'plugin',
  pluginId: 'com.acme.insights',
  plugin,
  id: 'insights',
  title: 'Insights',
  titleKey: null,
  icon: 'Database',
  page: 'insights',
  layouts: ['code'],
  order: 40,
  badge: null,
};

function emptyState(overrides: Partial<PluginUiState> = {}): Omit<PluginUiState, 'revision'> {
  return {
    slots: [],
    replacements: [],
    wraps: [],
    pages: [],
    panelTabs: [],
    nav: [],
    settingsTabs: [],
    artifactViewers: [],
    variants: [],
    presets: [],
    css: [],
    genui: [],
    ...overrides,
  };
}

beforeEach(() => {
  usePluginUiPrefs.setState({ ...EMPTY_PREFS, enabled: false });
  usePluginStore.setState({
    snapshot: {
      plugins: [],
      safeMode: false,
      pluginsEnabled: true,
      allowTrusted: false,
      devMode: false,
      configFingerprint: '',
    },
  });
  useUiStore.setState({ layoutMode: 'code', codeView: 'session', activeView: 'chat' });
  setPluginUiState(emptyState({ nav: [navEntry] }));
});

afterEach(() => {
  cleanup();
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  setPluginUiState(emptyState());
});

describe('PluginUiDisabledBanner', () => {
  it('explains the switched-off plugin UI and turns it back on', async () => {
    const user = userEvent.setup();
    render(<PluginUiDisabledBanner />);

    expect(screen.getByText('A UI de plugins está desativada')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ativar UI de plugins' }));

    expect(usePluginUiPrefs.getState().enabled).toBe(true);
  });

  it('stays hidden while plugin UI is enabled', () => {
    usePluginUiPrefs.setState({ enabled: true });
    const { container } = render(<PluginUiDisabledBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('stays hidden when nothing is contributed for the current layout', () => {
    setPluginUiState(emptyState());
    const { container } = render(<PluginUiDisabledBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('stays hidden when every plugin is disabled globally or the app is in safe mode', () => {
    usePluginStore.setState({
      snapshot: {
        plugins: [],
        safeMode: false,
        pluginsEnabled: false,
        allowTrusted: false,
        devMode: false,
        configFingerprint: '',
      },
    });
    const { container } = render(<PluginUiDisabledBanner />);
    expect(container.firstChild).toBeNull();
    cleanup();

    usePluginStore.setState({
      snapshot: {
        plugins: [],
        safeMode: true,
        pluginsEnabled: true,
        allowTrusted: false,
        devMode: false,
        configFingerprint: '',
      },
    });
    const safe = render(<PluginUiDisabledBanner />);
    expect(safe.container.firstChild).toBeNull();
  });

  it('stays hidden on the plugins page, where the same state is explained', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'plugins' });
    const { container } = render(<PluginUiDisabledBanner />);
    expect(container.firstChild).toBeNull();
  });
});

describe('hasPluginUiContributions', () => {
  it('matches the layout of each contribution', () => {
    const state = { ...emptyState({ nav: [navEntry] }), revision: 0 };
    expect(hasPluginUiContributions(state, 'code')).toBe(true);
    expect(hasPluginUiContributions(state, 'chat')).toBe(false);
    expect(hasPluginUiContributions(state)).toBe(true);
    expect(hasPluginUiContributions({ ...emptyState(), revision: 0 })).toBe(false);
  });
});
