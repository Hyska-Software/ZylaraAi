import { describe, expect, it, beforeEach } from 'vitest';
import { createElement } from 'react';

import { PLUGIN_COMPONENTS, PLUGIN_PERMISSIONS, PLUGIN_SLOTS } from '@/lib/plugins/contract';
import {
  artifactViewerForMime,
  getPluginRegistryState,
  pluginHasPermission,
  pluginViewsForSurface,
  registerTrustedPlugin,
  resolvePluginComponent,
  setPluginSnapshot,
  slotEntries,
  unregisterTrustedPlugin,
  type PluginComponent,
} from '@/lib/plugins/registry';
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
        views: [{ id: 'demo', title: 'Demo', surface: 'chat', location: 'sidebar', entry: 'ui/page.html' }],
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
  it('has unique slot, component and permission ids', () => {
    expect(new Set(PLUGIN_SLOTS.map((slot) => slot.id)).size).toBe(PLUGIN_SLOTS.length);
    expect(new Set(PLUGIN_COMPONENTS.map((component) => component.id)).size).toBe(
      PLUGIN_COMPONENTS.length,
    );
    expect(new Set(PLUGIN_PERMISSIONS.map((permission) => permission.id)).size).toBe(
      PLUGIN_PERMISSIONS.length,
    );
    expect(PLUGIN_SLOTS.some((slot) => slot.id === 'chat.composer.toolbar')).toBe(true);
  });
});

describe('plugin registry', () => {
  it('projects views, commands and artifact viewers from active plugins', () => {
    const plugin = record();
    setPluginSnapshot(snapshot([plugin]));
    expect(pluginViewsForSurface('chat', 'sidebar')).toHaveLength(1);
    expect(artifactViewerForMime('text/csv')?.viewer.id).toBe('csv-viewer');
    expect(artifactViewerForMime('application/json')).toBeUndefined();
    expect(slotEntries('chat.composer.toolbar')).toHaveLength(0);
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

  it('resolves trusted component overrides and wrappers', () => {
    const plugin = record({ trusted: true });
    setPluginSnapshot(snapshot([plugin]));
    const Host: PluginComponent = () => createElement('div', null, 'host');
    const Override: PluginComponent = () => createElement('div', null, 'plugin');
    expect(resolvePluginComponent('chat.welcome', Host)).toBe(Host);
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
      css: [],
      toolHandlers: new Map(),
      commands: new Map(),
      cleanup: [],
    });
    expect(resolvePluginComponent('chat.welcome', Host)).toBe(Override);
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
