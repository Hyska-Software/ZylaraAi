// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { pluginRpc: vi.fn(() => Promise.resolve({})) } }));

import { useUiStore } from '@/lib/store/uiStore';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { setPluginUiState } from '@/lib/plugins/ui/registry';
import { VariantProvider, useStyleRecipe } from '@/lib/plugins/ui/recipe';
import type { PluginUiState, PresetSpec } from '@/lib/plugins/ui/types';

const BASE = 'relative rounded-3xl bg-surface-raised shadow-sm';

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

function Host() {
  const style = useStyleRecipe('chat.composer', BASE);
  return <div data-testid="host" className={style.className} data-variant={style.variantId ?? undefined} />;
}

function renderHost() {
  return render(
    <VariantProvider component="chat.composer">
      <Host />
    </VariantProvider>,
  );
}

beforeEach(() => {
  useUiStore.setState({ layoutMode: 'chat' });
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  setPluginUiState(emptyState());
});

afterEach(() => cleanup());

describe('style recipes', () => {
  it('keeps the host classes when no variant is selected', () => {
    renderHost();
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-variant')).toBeNull();
    expect(host.className).toContain('rounded-3xl');
    expect(host.className).not.toContain('rounded-2xl');
    expect(host.className).not.toContain('p-4');
  });

  it('applies an explicitly selected builtin variant over the host classes', () => {
    usePluginUiPrefs.setState({
      ...EMPTY_PREFS,
      variants: { 'chat.composer:chat': 'builtin:card' },
    });
    renderHost();
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-variant')).toBe('card');
    expect(host.className).toContain('rounded-2xl');
    expect(host.className).toContain('p-4');
    expect(host.className).not.toContain('rounded-3xl');
  });

  it('applies the variant declared by the active preset', () => {
    const preset = {
      key: 'com.acme:preset:paper',
      pluginId: 'com.acme',
      plugin: { id: 'com.acme', name: 'Acme' },
      source: 'plugin',
      order: 100,
      priority: 100,
      layouts: ['chat'],
      presetId: 'paper',
      title: 'Paper',
      tokens: { light: {}, dark: {} },
      density: null,
      variants: { 'chat.composer': 'builtin:flat' },
      css: null,
    } as unknown as PresetSpec;
    setPluginUiState(emptyState({ presets: [preset] }));
    usePluginUiPrefs.setState({ ...EMPTY_PREFS, presets: { chat: preset.key, code: null, agent: null } });
    renderHost();
    const host = screen.getByTestId('host');
    expect(host.getAttribute('data-variant')).toBe('flat');
    expect(host.className).toContain('bg-surface');
    expect(host.className).toContain('rounded-md');
  });
});
