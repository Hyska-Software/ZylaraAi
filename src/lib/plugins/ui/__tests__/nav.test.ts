import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '@/lib/store/uiStore';
import { navEntries, HOST_NAV, openNavTarget } from '@/lib/plugins/ui/nav';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { setPluginUiState } from '@/lib/plugins/ui/registry';
import type { NavEntry } from '@/lib/plugins/ui/types';

const pluginEntry: NavEntry = {
  key: 'com.acme:nav:notes',
  source: 'plugin',
  pluginId: 'com.acme',
  plugin: { id: 'com.acme', name: 'Acme' } as never,
  id: 'notes',
  title: 'Notes',
  titleKey: null,
  icon: 'Puzzle',
  page: 'notes',
  layouts: ['chat', 'code'],
  order: 15,
  badge: null,
};

beforeEach(() => {
  setPluginUiState({
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
  });
  useUiStore.setState({
    layoutMode: 'chat',
    activeView: 'chat',
    pluginPages: { chat: null, code: null, agent: null },
    pluginDockTab: { chat: null, code: null, agent: null },
  });
});

describe('plugin navigation', () => {
  it('merges host and plugin entries per layout', () => {
    expect(navEntries('chat', [pluginEntry]).map((entry) => entry.key)).toEqual([
      'com.acme:nav:notes',
      'host:library',
      'host:plugins-chat',
      'host:skills-chat',
    ]);
    expect(navEntries('agent', [pluginEntry]).map((entry) => entry.key)).toEqual([
      'host:plugins-agent',
      'host:team-agent',
      'host:routines-agent',
    ]);
    expect(navEntries('code', [pluginEntry]).map((entry) => entry.key)).toContain(
      'com.acme:nav:notes',
    );
  });

  it('applies hidden keys and explicit order', () => {
    const entries = navEntries('chat', [pluginEntry], {
      hidden: { chat: ['host:library'], code: [], agent: [] },
      order: { chat: ['host:skills-chat', 'host:plugins-chat'], code: [], agent: [] },
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'host:skills-chat',
      'host:plugins-chat',
      'com.acme:nav:notes',
    ]);
  });

  it('opens a plugin page only in the entry layout', () => {
    openNavTarget({ ...pluginEntry, layouts: ['code'] });
    expect(useUiStore.getState().pluginPages.code).toEqual({
      pluginId: 'com.acme',
      pageId: 'notes',
    });
    expect(useUiStore.getState().pluginPages.chat).toBeNull();
    expect(useUiStore.getState().layoutMode).toBe('code');
  });

  it('routes a plugin nav that targets a host page through the host view', () => {
    openNavTarget({ ...pluginEntry, page: 'plugins', layouts: ['chat'] });
    expect(useUiStore.getState().activeView).toBe('plugins');
    expect(useUiStore.getState().pluginPages.chat).toBeNull();
  });

  it('opens host pages without leaving a plugin page active', () => {
    useUiStore.setState({
      pluginPages: { chat: { pluginId: 'com.acme', pageId: 'notes' }, code: null, agent: null },
    });
    const library = navEntries('chat', []).find((entry) => entry.key === 'host:library');
    expect(library).toBeTruthy();
    openNavTarget(library as NavEntry);
    expect(useUiStore.getState().activeView).toBe('library');
    expect(useUiStore.getState().pluginPages.chat).toBeNull();
  });

  it('declares the three sidebars', () => {
    expect(HOST_NAV.some((entry) => entry.layouts.includes('agent'))).toBe(true);
    expect(HOST_NAV.some((entry) => entry.layouts.includes('code'))).toBe(true);
    expect(HOST_NAV.some((entry) => entry.layouts.includes('chat'))).toBe(true);
  });

  it('hides plugin entries while the global plugin UI switch is off', () => {
    usePluginUiPrefs.setState({ enabled: false });
    try {
      const keys = navEntries('chat', [pluginEntry]).map((entry) => entry.key);
      expect(keys).not.toContain('com.acme:nav:notes');
      expect(keys).toContain('host:library');
    } finally {
      usePluginUiPrefs.setState({ enabled: true });
    }
    expect(navEntries('chat', [pluginEntry]).map((entry) => entry.key)).toContain(
      'com.acme:nav:notes',
    );
  });
});
