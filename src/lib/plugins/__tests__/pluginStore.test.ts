// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  getPluginLocales: vi.fn(),
  getCatalog: vi.fn(),
  checkPluginUpdates: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

import { usePluginStore } from '@/lib/plugins/store';
import { useThemeStore } from '@/lib/store/themeStore';
import type { PluginManifest, PluginRecord, PluginSnapshot } from '@/lib/plugins/types';
import { useUiStore } from '@/lib/store/uiStore';

function manifest(): PluginManifest {
  return {
    schemaVersion: 2,
    id: 'com.acme.demo',
    name: 'Demo',
    version: '1.0.0',
    description: 'Demo',
    author: 'Acme',
    apiVersion: 2,
    engines: {},
    publisher: { id: 'acme', name: 'Acme', keyId: 'acme-2026' },
    permissions: ['ui.view', 'ui.panel', 'ui.theme'],
    contributes: {
      ui: {
        slots: [],
        views: [
          {
            id: 'demo',
            title: 'Demo',
            surface: 'chat',
            location: 'sidebar',
            layouts: ['chat'],
            entry: 'ui/page.html',
          },
        ],
        nav: [],
        panels: [
          {
            id: 'side',
            title: 'Side',
            entry: 'ui/panel.html',
            dock: 'right',
            tab: true,
            layouts: ['chat', 'code'],
          },
        ],
        commands: [],
        settingsTabs: [],
        themes: [
          {
            id: 'paper',
            name: 'Paper',
            light: { accent: '#8b5cf6' },
            dark: { accent: '#a78bfa' },
          },
        ],
        variants: [],
        presets: [],
        css: [],
        genui: { components: [] },
      },
      promptSections: [],
      skills: [],
      locales: [],
      providers: [],
      artifactViewers: [],
    },
    runtime: { ui: 'sandbox' },
    trusted: false,
  };
}

function record(): PluginRecord {
  const pluginManifest = manifest();
  return {
    id: pluginManifest.id,
    name: pluginManifest.name,
    version: pluginManifest.version,
    apiVersion: 2,
    description: pluginManifest.description,
    author: pluginManifest.author,
    homepage: null,
    icon: null,
    root: 'C:/plugins/demo',
    enabled: true,
    active: true,
    trusted: false,
    source: 'file',
    signatureStatus: 'verified',
    publisherId: 'acme',
    publisherName: 'Acme',
    keyId: 'acme-2026',
    keyFingerprint: null,
    installedAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    autoUpdate: false,
    previousVersion: null,
    disabledReason: null,
    sizeBytes: 1,
    permissions: [
      {
        id: 'ui.view',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'views',
        trustedOnly: false,
      },
      {
        id: 'ui.panel',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'panels',
        trustedOnly: false,
      },
      {
        id: 'ui.theme',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'themes',
        trustedOnly: false,
      },
    ],
    tools: [],
    promptChars: 0,
    prompt: '',
    skillRoots: [],
    locales: [],
    manifest: pluginManifest,
    hasBackend: false,
    mainScript: null,
  };
}

function snapshot(plugins: PluginRecord[]): PluginSnapshot {
  return {
    plugins,
    safeMode: false,
    pluginsEnabled: true,
    allowTrusted: false,
    devMode: false,
    configFingerprint: 'test',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPluginLocales.mockResolvedValue({ entries: {} });
  mocks.getCatalog.mockResolvedValue({
    catalog: { providers: [], models: [] },
    keys: [],
    auth: [],
    remoteRefreshedAt: null,
  });
  mocks.checkPluginUpdates.mockResolvedValue([]);
});

describe('plugin store activation targets', () => {
  it('closes stale center pages and dock tabs when a plugin disappears', async () => {
    const plugin = record();
    mocks.listPlugins.mockResolvedValue(snapshot([plugin]));
    useUiStore.setState({
      pluginPages: {
        chat: { pluginId: plugin.id, pageId: 'demo' },
        code: null,
        agent: null,
      },
      pluginDockTab: { chat: null, code: `${plugin.id}:panel:side`, agent: null },
      pluginDockClosed: { chat: false, code: false, agent: false },
    });

    await usePluginStore.getState().init();

    expect(useUiStore.getState().pluginPages.chat).toEqual({
      pluginId: plugin.id,
      pageId: 'demo',
    });
    expect(useUiStore.getState().pluginDockTab.code).toBe(`${plugin.id}:panel:side`);
    expect(useThemeStore.getState().pluginThemes).toHaveLength(1);
    expect(useThemeStore.getState().pluginThemes[0].pluginId).toBe(plugin.id);

    mocks.listPlugins.mockResolvedValue(snapshot([]));
    await usePluginStore.getState().reload();

    expect(useUiStore.getState().pluginPages.chat).toBeNull();
    expect(useUiStore.getState().pluginDockTab.code).toBeNull();
  });
});
