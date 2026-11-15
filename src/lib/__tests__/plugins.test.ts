import { describe, expect, it, beforeEach } from 'vitest';
import { createElement } from 'react';

import {
  PLUGIN_COMPONENTS,
  PLUGIN_EVENTS,
  PLUGIN_LAYOUTS,
  PLUGIN_PERMISSIONS,
  PLUGIN_SLOTS,
  PLUGIN_UI_LIMITS,
  pluginComponentSpec,
  pluginPermissionTrustedOnly,
  pluginSlotSpec,
} from '@/lib/plugins/contract';
import {
  artifactViewerForMime,
  getPluginRegistryState,
  pluginHasPermission,
  pluginViewsForSurface,
  registerTrustedPlugin,
  setPluginSnapshot,
  unregisterTrustedPlugin,
  type PluginComponent,
} from '@/lib/plugins/registry';
import { pluginUiState } from '@/lib/plugins/ui/registry';
import type { PluginManifest, PluginRecord, PluginSnapshot } from '@/lib/plugins/types';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'com.acme.demo',
    name: 'Demo',
    version: '1.0.0',
    description: 'Fixture',
    author: 'Acme',
    apiVersion: 1,
    engines: {},
    publisher: { id: 'acme', name: 'Acme', keyId: 'acme-2026' },
    permissions: [],
    contributes: {
      ui: {
        slots: [],
        views: [{ id: 'demo', title: 'Demo', surface: 'chat', location: 'sidebar', layouts: ['chat'], entry: 'ui/page.html' }],
        nav: [],
        panels: [{ id: 'side', title: 'Side', entry: 'ui/panel.html', dock: 'right' }],
        commands: [
          {
            id: 'sync',
            title: 'Sync',
            action: { kind: 'openView', target: 'demo' },
          },
        ],
        settingsTabs: [{ id: 'config', title: 'Config', entry: 'ui/settings.html' }],
        themes: [],
        variants: [],
        presets: [],
        css: [],
        genui: { components: [] },
      },
      tools: undefined,
      promptSections: [],
      skills: [],
      locales: [],
      providers: [],
      artifactViewers: [
        {
          id: 'csv-viewer',
          title: 'CSV viewer',
          mimeTypes: ['text/csv', 'text/*'],
          entry: 'ui/csv.html',
          priority: 10,
        },
      ],
    },
    runtime: { ui: 'sandbox' },
    trusted: false,
    ...overrides,
  };
}

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
  const pluginManifest = manifest(overrides.manifest ? { ...manifest(), ...overrides.manifest } : {});
  return {
    id: pluginManifest.id,
    name: pluginManifest.name,
    version: pluginManifest.version,
    apiVersion: 1,
    description: '',
    author: '',
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
    sizeBytes: 100,
    permissions: [
      {
        id: 'ui.view',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'view',
        trustedOnly: false,
      },
      {
        id: 'ui.panel',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'panel',
        trustedOnly: false,
      },
      {
        id: 'ui.command',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'command',
        trustedOnly: false,
      },
      {
        id: 'ui.settings',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'settings',
        trustedOnly: false,
      },
      {
        id: 'ui.artifact',
        granted: true,
        risk: 'low',
        scoped: false,
        description: 'artifact',
        trustedOnly: false,
      },
      {
        id: 'ui.slot:chat.composer.toolbar',
        granted: true,
        risk: 'low',
        scoped: true,
        description: 'slot',
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
    ...overrides,
  };
}

function snapshot(plugins: PluginRecord[], overrides: Partial<PluginSnapshot> = {}): PluginSnapshot {
  return {
    plugins,
    safeMode: false,
    pluginsEnabled: true,
    allowTrusted: false,
    devMode: false,
    configFingerprint: 'fp',
    ...overrides,
  };
}

beforeEach(() => {
  setPluginSnapshot(snapshot([]));
  unregisterTrustedPlugin('com.acme.demo');
});

describe('plugin contract', () => {
  it('has unique slot, component, permission and event ids', () => {
    expect(new Set(PLUGIN_SLOTS.map((slot) => slot.id)).size).toBe(PLUGIN_SLOTS.length);
    expect(new Set(PLUGIN_COMPONENTS.map((component) => component.id)).size).toBe(
      PLUGIN_COMPONENTS.length,
    );
    expect(new Set(PLUGIN_PERMISSIONS.map((permission) => permission.id)).size).toBe(
      PLUGIN_PERMISSIONS.length,
    );
    expect(new Set(PLUGIN_EVENTS.map((event) => event.name)).size).toBe(PLUGIN_EVENTS.length);
    expect(PLUGIN_SLOTS.some((slot) => slot.id === 'chat.composer.toolbar')).toBe(true);
  });

  it('describes slot kinds, scopes and layout limits', () => {
    const slot = pluginSlotSpec('chat.message.actions');
    expect(slot?.kind).toBe('list');
    expect(slot?.scope).toBe('message');
    expect(slot?.layouts).toEqual(['chat', 'code']);
    expect(pluginSlotSpec('chat.markdown.fence')?.entryKey).toBe('language');
    expect(pluginSlotSpec('chat.message.node')?.entryKey).toBe('role');
    expect(PLUGIN_LAYOUTS).toEqual(['chat', 'code', 'agent']);
    expect(PLUGIN_UI_LIMITS.cssCharsPerPlugin).toBeGreaterThan(0);
  });

  it('keeps component replacement trusted and CSS available to every lane', () => {
    const user = pluginComponentSpec('chat.message.user');
    expect(user?.lanes).toEqual(['trusted']);
    expect(user?.variants).toContain('bubble');
    expect(user?.builtinRecipes?.bubble.surface).toBe('user-bubble');
    expect(pluginPermissionTrustedOnly('ui.override')).toBe(true);
    expect(pluginPermissionTrustedOnly('ui.shell')).toBe(true);
    expect(pluginPermissionTrustedOnly('ui.css.global')).toBe(false);
    expect(pluginPermissionTrustedOnly('ui.nav')).toBe(false);
  });
});

describe('plugin registry', () => {
  it('projects views, commands and artifact viewers from active plugins', () => {
    const plugin = record();
    setPluginSnapshot(snapshot([plugin]));
    expect(pluginViewsForSurface('chat', 'sidebar')).toHaveLength(1);
    expect(artifactViewerForMime('text/csv')?.viewer.id).toBe('csv-viewer');
    expect(artifactViewerForMime('application/json')).toBeUndefined();
    expect(pluginUiState().slots).toHaveLength(0);
  });

  it('hides contributions from inactive, disabled and ungranted plugins', () => {
    const inactive = record({ active: false });
    const ungranted = record({
      permissions: record().permissions.map((permission) => ({
        ...permission,
        granted: false,
      })),
    });
    setPluginSnapshot(snapshot([inactive, ungranted]));
    expect(pluginViewsForSurface('chat', 'sidebar')).toHaveLength(0);
    expect(artifactViewerForMime('text/csv')).toBeUndefined();

    const safe = record();
    setPluginSnapshot(snapshot([safe], { safeMode: true, pluginsEnabled: false }));
    expect(pluginViewsForSurface('chat', 'sidebar')).toHaveLength(0);
  });

  it('matches scoped permissions exactly or through a wildcard grant', () => {
    const plugin = record();
    expect(pluginHasPermission(plugin, 'ui.view')).toBe(true);
    expect(pluginHasPermission(plugin, 'ui.slot:chat.composer.toolbar')).toBe(true);
    expect(pluginHasPermission(plugin, 'ui.slot:chat.header.actions')).toBe(false);
    const wildcard = record({
      permissions: [
        ...record().permissions,
        {
          id: 'net:*',
          granted: true,
          risk: 'high',
          scoped: true,
          description: 'net',
          trustedOnly: false,
        },
      ],
    });
    expect(pluginHasPermission(wildcard, 'net:api.github.com')).toBe(true);
  });

  it('projects trusted component overrides and wrappers into the UI state', () => {
    const plugin = record({ trusted: true });
    setPluginSnapshot(snapshot([plugin]));
    const Host: PluginComponent = () => createElement('div', null, 'host');
    const Override: PluginComponent = () => createElement('div', null, 'plugin');
    expect(pluginUiState().replacements).toHaveLength(0);
    registerTrustedPlugin({
      pluginId: plugin.id,
      views: new Map(),
      panels: new Map(),
      slots: new Map(),
      settingsTabs: new Map(),
      artifactViewers: new Map(),
      components: new Map(),
      overrides: new Map([['chat.welcome', Override]]),
      wrappers: new Map(),
      shell: null,
      uiSlots: [],
      uiPages: [],
      uiPanelTabs: [],
      uiNav: [],
      uiSettingsTabs: [],
      uiArtifactViewers: [],
      uiVariants: [],
      uiPresets: [],
      uiCss: [],
      uiGenui: [],
      uiReplacements: [],
      uiWraps: [],
      uiCommands: [],
      toolHandlers: new Map(),
      commands: new Map(),
      cleanup: [],
    });
    setPluginSnapshot(snapshot([plugin]));
    expect(pluginUiState().replacements[0]?.componentFn).toBe(Override);
    expect(pluginUiState().replacements[0]?.component).toBe('chat.welcome');
    expect(Host).not.toBe(Override);
  });

  it('rejects duplicate plugin commands deterministically', () => {
    const first = record();
    const second = record({ id: 'com.acme.second' });
    second.manifest.contributes.ui.commands = [
      { ...second.manifest.contributes.ui.commands[0] },
    ];
    setPluginSnapshot(snapshot([first, second]));
    const state = getPluginRegistryState();
    expect(state.commands).toHaveLength(1);
    expect(state.conflicts).toEqual([
      {
        kind: 'command',
        value: '/sync',
        pluginId: 'com.acme.second',
        otherPluginId: 'com.acme.demo',
      },
    ]);
  });
});

describe('trusted runtime UI registrations', () => {
  it('merges runtime pages, nav, variants and presets into the UI state', () => {
    const plugin = record({ trusted: true });
    setPluginSnapshot(snapshot([plugin]));
    registerTrustedPlugin({
      pluginId: plugin.id,
      views: new Map(),
      panels: new Map(),
      slots: new Map(),
      settingsTabs: new Map(),
      artifactViewers: new Map(),
      components: new Map(),
      overrides: new Map(),
      wrappers: new Map(),
      shell: null,
      uiSlots: [],
      uiPages: [{
        key: 'demo:ui:page:metrics:1',
        plugin,
        pluginId: plugin.id,
        source: 'trusted',
        order: 100,
        priority: 100,
        layouts: ['chat'],
        pageId: 'metrics',
        title: 'Metrics',
        titleKey: null,
        icon: 'Puzzle',
        entry: null,
        component: null,
      }],
      uiPanelTabs: [],
      uiNav: [{
        key: 'demo:ui:nav:metrics:2',
        source: 'plugin',
        pluginId: plugin.id,
        plugin,
        id: 'metrics',
        title: 'Metrics',
        titleKey: null,
        icon: 'Puzzle',
        page: 'metrics',
        layouts: ['chat'],
        order: 10,
        badge: null,
      }],
      uiSettingsTabs: [],
      uiArtifactViewers: [],
      uiVariants: [{
        key: 'demo:ui:variant:glass:3',
        plugin,
        pluginId: plugin.id,
        source: 'trusted',
        order: 100,
        priority: 100,
        layouts: ['chat'],
        component: 'chat.message.user',
        variantId: 'glass',
        title: 'Glass',
        recipe: { surface: 'accent-soft' },
      }],
      uiPresets: [],
      uiCss: [],
      uiGenui: [],
      uiReplacements: [],
      uiWraps: [],
      uiCommands: [],
      toolHandlers: new Map(),
      commands: new Map(),
      cleanup: [],
    });
    setPluginSnapshot(snapshot([plugin]));
    expect(pluginUiState().pages.some((entry) => entry.pageId === 'metrics')).toBe(true);
    expect(pluginUiState().nav.some((entry) => entry.page === 'metrics')).toBe(true);
    expect(pluginUiState().variants.some((entry) => entry.variantId === 'glass')).toBe(true);
  });
});
