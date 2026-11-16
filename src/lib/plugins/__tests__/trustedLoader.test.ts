// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pluginAssetText: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    pluginAssetText: mocks.pluginAssetText,
    pluginRpc: vi.fn(async () => ({})),
    setPluginEnabled: vi.fn(async () => ({})),
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  }),
}));

import {
  loadTrustedPlugin,
  loadedTrustedPluginIds,
  unloadTrustedPlugin,
} from '@/lib/plugins/trusted';
import { usePluginStore } from '@/lib/plugins/store';
import type { PluginManifest, PluginRecord, PluginSnapshot } from '@/lib/plugins/types';

type TrustedTestGlobals = typeof globalThis & {
  __trustedCalls?: number;
  __trustedCleanup?: number;
  __trustedDeactivate?: number;
};

const trustedGlobals = globalThis as TrustedTestGlobals;

function manifest(): PluginManifest {
  return {
    schemaVersion: 2,
    id: 'com.acme.trusted',
    name: 'Trusted',
    version: '1.0.0',
    description: 'Trusted fixture',
    author: 'Acme',
    apiVersion: 2,
    engines: {},
    publisher: { id: 'acme', name: 'Acme', keyId: 'acme-2026' },
    permissions: ['unsafe.renderer'],
    contributes: {
      ui: {
        slots: [],
        views: [],
        nav: [],
        panels: [],
        commands: [],
        settingsTabs: [],
        themes: [],
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
    runtime: { ui: 'trusted', entry: 'main.js' },
    trusted: true,
  };
}

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
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
    root: 'C:/plugins/trusted',
    enabled: true,
    active: true,
    trusted: true,
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
        id: 'unsafe.renderer',
        granted: true,
        risk: 'critical',
        scoped: false,
        description: 'renderer',
        trustedOnly: true,
      },
    ],
    tools: [],
    promptChars: 0,
    prompt: '',
    skillRoots: [],
    locales: [],
    manifest: pluginManifest,
    hasBackend: false,
    mainScript: 'main.js',
    ...overrides,
  };
}

function snapshot(plugin: PluginRecord): PluginSnapshot {
  return {
    plugins: [plugin],
    safeMode: false,
    pluginsEnabled: true,
    allowTrusted: true,
    devMode: false,
    configFingerprint: 'test',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete trustedGlobals.__trustedCalls;
  delete trustedGlobals.__trustedCleanup;
  delete trustedGlobals.__trustedDeactivate;
  mocks.pluginAssetText.mockResolvedValue(`
    host.registerPlugin({
      activate() {
        globalThis.__trustedCalls = (globalThis.__trustedCalls || 0) + 1;
        return () => { globalThis.__trustedCleanup = (globalThis.__trustedCleanup || 0) + 1; };
      },
      deactivate() { globalThis.__trustedDeactivate = (globalThis.__trustedDeactivate || 0) + 1; },
    });
  `);
});

describe('trusted loader', () => {
  it('evaluates a plugin once for concurrent loads and tears it down', async () => {
    const plugin = record();
    usePluginStore.setState({ snapshot: snapshot(plugin) });

    await Promise.all([loadTrustedPlugin(plugin), loadTrustedPlugin(plugin)]);

    expect(mocks.pluginAssetText).toHaveBeenCalledTimes(1);
    expect(trustedGlobals.__trustedCalls).toBe(1);
    expect(loadedTrustedPluginIds()).toContain(plugin.id);

    unloadTrustedPlugin(plugin.id);

    expect(trustedGlobals.__trustedCleanup).toBe(1);
    expect(trustedGlobals.__trustedDeactivate).toBe(1);
    expect(loadedTrustedPluginIds()).not.toContain(plugin.id);
  });

  it('does not evaluate an inactive or disabled plugin', async () => {
    const inactive = record({ active: false });
    usePluginStore.setState({ snapshot: snapshot(inactive) });

    await loadTrustedPlugin(inactive);
    await loadTrustedPlugin(record({ enabled: false }));

    expect(mocks.pluginAssetText).not.toHaveBeenCalled();
    expect(loadedTrustedPluginIds()).not.toContain(inactive.id);
  });
});
