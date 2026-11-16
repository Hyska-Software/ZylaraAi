import { beforeEach, describe, expect, it } from 'vitest';

import { runPluginHostAction } from '@/lib/plugins/ui/hostActions';
import { pluginUiState, setPluginUiState } from '@/lib/plugins/ui/registry';
import type { NavEntry } from '@/lib/plugins/ui/types';

const plugin = {
  id: 'com.acme.notes',
  name: 'Notes',
  permissions: [{ id: 'ui.nav', granted: true }],
} as never;

const nav: NavEntry = {
  key: 'com.acme.notes:nav:notes',
  source: 'plugin',
  pluginId: 'com.acme.notes',
  plugin,
  id: 'notes',
  title: 'Notes',
  titleKey: null,
  icon: 'Puzzle',
  page: 'notes',
  layouts: ['chat'],
  order: 100,
  badge: null,
};

beforeEach(() => {
  setPluginUiState({
    slots: [],
    replacements: [],
    wraps: [],
    pages: [],
    panelTabs: [],
    nav: [{ ...nav }],
    settingsTabs: [],
    artifactViewers: [],
    variants: [],
    presets: [],
    css: [],
    genui: [],
  });
});

describe('plugin host actions', () => {
  it('updates a nav badge and republishes the UI revision', () => {
    const before = pluginUiState().revision;
    runPluginHostAction(plugin, 'setBadge', { id: 'notes', badge: '3' });

    expect(pluginUiState().nav[0].badge).toBe('3');
    expect(pluginUiState().revision).toBeGreaterThan(before);
  });

  it('rejects a badge change without ui.nav', () => {
    expect(() =>
      runPluginHostAction(
        { id: 'com.acme.notes', name: 'Notes', permissions: [] } as never,
        'setBadge',
        { id: 'notes', badge: '3' },
      ),
    ).toThrow('PLUGIN_PERMISSION_DENIED');
  });
});
