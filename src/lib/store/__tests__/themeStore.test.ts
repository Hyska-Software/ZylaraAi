// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listThemes: vi.fn(),
  installTheme: vi.fn(),
  uninstallTheme: vi.fn(),
  getThemeAsset: vi.fn(),
  openThemesDir: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));

import { useAppStore } from '@/lib/store/appStore';
import { BUILTIN_THEME, useThemeStore } from '@/lib/store/themeStore';
import { useUiStore } from '@/lib/store/uiStore';
import { THEME_CACHE_KEY } from '@/lib/theme/apply';
import type { Settings, ThemeInfo } from '@/lib/types';

function theme(overrides: Partial<ThemeInfo> = {}): ThemeInfo {
  return {
    id: 'ocean',
    name: 'Ocean',
    version: '1.0.0',
    author: '',
    description: '',
    builtIn: false,
    light: { tokens: { background: '#fff', accent: '#2563eb' }, wallpaper: null },
    dark: { tokens: { background: '#071018', accent: '#60a5fa' }, wallpaper: null },
    fonts: { sans: null, mono: null },
    ...overrides,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...useAppStore.getState().settings, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
  delete document.documentElement.dataset.themeTokens;
  useThemeStore.setState({
    themes: [],
    activeId: 'zylara',
    ready: false,
    error: null,
  });
  useAppStore.setState({ settings: settings({ themeId: 'zylara' }) });
  useUiStore.setState({ theme: 'dark' });
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
    auth: [],
    secretsError: null,
  }));
  mocks.getThemeAsset.mockRejectedValue(new Error('no asset'));
});

describe('themeStore', () => {
  it('applies the persisted installed theme on init', async () => {
    mocks.listThemes.mockResolvedValue([theme()]);
    useAppStore.setState({ settings: settings({ themeId: 'ocean' }) });

    await useThemeStore.getState().init();

    expect(useThemeStore.getState().activeId).toBe('ocean');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#60a5fa');
  });

  it('preserves bundled built-ins and applies the persisted bundled theme', async () => {
    const aurora = theme({
      id: 'aurora',
      name: 'Aurora',
      author: 'Zylara',
      builtIn: true,
      light: { tokens: { background: '#f5fbff', accent: '#0f766e' }, wallpaper: null },
      dark: { tokens: { background: '#07141c', accent: '#2dd4bf' }, wallpaper: null },
    });
    mocks.listThemes.mockResolvedValue([aurora]);
    useAppStore.setState({ settings: settings({ themeId: 'aurora' }) });

    await useThemeStore.getState().init();

    expect(useThemeStore.getState().themes.map((entry) => entry.id)).toEqual([
      'zylara',
      'aurora',
    ]);
    expect(useThemeStore.getState().activeId).toBe('aurora');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2dd4bf');
    const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
    expect(cached.dark.accent).toBe('#2dd4bf');
  });

  it('falls back to Zylara and persists the fallback when the id is unknown', async () => {
    mocks.listThemes.mockResolvedValue([]);
    useAppStore.setState({ settings: settings({ themeId: 'ghost' }) });

    await useThemeStore.getState().init();

    expect(useThemeStore.getState().activeId).toBe('zylara');
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: 'zylara' }),
    );
  });

  it('keeps booting with the built-in theme when listing fails', async () => {
    mocks.listThemes.mockRejectedValue(new Error('disk unavailable'));
    useAppStore.setState({ settings: settings({ themeId: 'ocean' }) });

    await useThemeStore.getState().init();

    expect(useThemeStore.getState().ready).toBe(true);
    expect(useThemeStore.getState().activeId).toBe('zylara');
    expect(useThemeStore.getState().error).toContain('disk unavailable');
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('installs a package and refreshes the gallery', async () => {
    mocks.installTheme.mockResolvedValue({ theme: theme(), replaced: false });
    mocks.listThemes.mockResolvedValue([theme()]);

    const result = await useThemeStore.getState().install('C:/tmp/ocean.zip');

    expect(result.replaced).toBe(false);
    expect(useThemeStore.getState().themes.map((entry) => entry.id)).toEqual(['zylara', 'ocean']);
    expect(mocks.installTheme).toHaveBeenCalledWith('C:/tmp/ocean.zip');
  });

  it('resets the active id when the active theme is removed', async () => {
    useThemeStore.setState({ themes: [theme()], activeId: 'ocean', ready: true });
    mocks.uninstallTheme.mockResolvedValue([]);

    await useThemeStore.getState().uninstall('ocean');

    expect(useThemeStore.getState().activeId).toBe('zylara');
    expect(useThemeStore.getState().themes.map((entry) => entry.id)).toEqual(['zylara']);
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: 'zylara' }),
    );
  });

  it('merges plugin themes, applies them and persists their id', async () => {
    const pluginTheme = theme({
      id: 'plugin-0123456789abcdef',
      name: 'Acme paper',
      author: 'Acme',
      builtIn: false,
      pluginId: 'com.acme.notes',
      pluginName: 'Acme Notes',
      light: { tokens: { accent: '#8b5cf6', surface: '#faf9ff' }, wallpaper: null },
      dark: { tokens: { accent: '#a78bfa', surface: '#17131f' }, wallpaper: null },
    });
    useThemeStore.setState({
      hostThemes: [BUILTIN_THEME],
      pluginThemes: [],
      themes: [BUILTIN_THEME],
      activeId: 'zylara',
      ready: true,
    });
    useUiStore.setState({ theme: 'dark' });

    useThemeStore.getState().setPluginThemes([pluginTheme]);
    expect(useThemeStore.getState().themes.map((entry) => entry.id)).toEqual([
      'zylara',
      pluginTheme.id,
    ]);

    await useThemeStore.getState().setActive(pluginTheme.id);

    expect(useThemeStore.getState().activeId).toBe(pluginTheme.id);
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: pluginTheme.id }),
    );
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a78bfa');
    expect(document.documentElement.style.getPropertyValue('--surface')).toBe('#17131f');
  });

  it('falls back to Zylara when an active plugin theme disappears', async () => {
    const pluginTheme = theme({
      id: 'plugin-0123456789abcdef',
      pluginId: 'com.acme.notes',
      pluginName: 'Acme Notes',
    });
    useThemeStore.setState({
      hostThemes: [BUILTIN_THEME],
      pluginThemes: [pluginTheme],
      themes: [BUILTIN_THEME, pluginTheme],
      activeId: pluginTheme.id,
      ready: true,
    });

    useThemeStore.getState().setPluginThemes([]);

    expect(useThemeStore.getState().activeId).toBe('zylara');
    expect(useThemeStore.getState().themes.map((entry) => entry.id)).toEqual(['zylara']);
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: 'zylara' }),
    );
  });

  it('keeps a host theme selected when plugin themes are registered', async () => {
    const pluginTheme = theme({
      id: 'plugin-0123456789abcdef',
      pluginId: 'com.acme.notes',
      pluginName: 'Acme Notes',
    });
    useThemeStore.setState({
      hostThemes: [theme()],
      pluginThemes: [],
      themes: [BUILTIN_THEME, theme()],
      activeId: 'ocean',
      ready: true,
    });

    useThemeStore.getState().setPluginThemes([pluginTheme]);

    expect(useThemeStore.getState().activeId).toBe('ocean');
  });
});
