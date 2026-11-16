import { describe, expect, it } from 'vitest';

import { pluginThemeId, pluginThemeInfos } from '@/lib/plugins/themes';
import type { PluginManifest, PluginRecord } from '@/lib/plugins/types';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 2,
    id: 'com.acme.notes',
    name: 'Acme Notes',
    version: '1.2.0',
    description: 'Notes with a paper palette.',
    author: 'Acme',
    apiVersion: 2,
    engines: {},
    publisher: { id: 'acme', name: 'Acme', keyId: 'acme-2026' },
    permissions: ['ui.theme'],
    contributes: {
      ui: {
        slots: [],
        views: [],
        nav: [],
        panels: [],
        commands: [],
        settingsTabs: [],
        themes: [
          {
            id: 'paper',
            name: 'Acme paper',
            light: { '--accent': '#8b5cf6', 'dangerous-token': 'red' },
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
    runtime: { ui: 'declarative' },
    trusted: false,
    ...overrides,
  };
}

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
  const pluginManifest = manifest(overrides.manifest ?? {});
  return {
    id: pluginManifest.id,
    name: pluginManifest.name,
    version: pluginManifest.version,
    apiVersion: 2,
    description: pluginManifest.description,
    author: pluginManifest.author,
    homepage: null,
    icon: null,
    root: 'C:/plugins/notes',
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
    ...overrides,
  };
}

describe('plugin themes', () => {
  it('creates a settings-safe id and normalizes tokens', () => {
    const id = pluginThemeId('com.acme.notes', 'paper');
    expect(id).toMatch(/^plugin-[0-9a-f]{16}$/);
    expect(id.length).toBe(23);

    const themes = pluginThemeInfos([record()]);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      id,
      name: 'Acme paper',
      version: '1.2.0',
      author: 'Acme',
      builtIn: false,
      pluginId: 'com.acme.notes',
      pluginName: 'Acme Notes',
    });
    expect(themes[0].light.tokens).toEqual({ accent: '#8b5cf6' });
    expect(themes[0].dark.tokens).toEqual({ accent: '#a78bfa' });
    expect(themes[0].fonts).toEqual({ sans: null, mono: null });
  });

  it('skips disabled plugins and plugins without ui.theme', () => {
    expect(pluginThemeInfos([record({ active: false })])).toEqual([]);
    expect(pluginThemeInfos([record({ enabled: false })])).toEqual([]);
    expect(
      pluginThemeInfos([
        record({
          permissions: [],
        }),
      ]),
    ).toEqual([]);
  });
});
