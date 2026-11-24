// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyBorderRadius,
  applyThemeAssets,
  applyThemeTokens,
  BUILTIN_THEME_ID,
  THEME_CACHE_KEY,
  THEME_APPLIED_EVENT,
} from '@/lib/theme/apply';
import type { ThemeInfo } from '@/lib/types';

function theme(overrides: Partial<ThemeInfo> = {}): ThemeInfo {
  return {
    id: 'ocean',
    name: 'Ocean',
    version: '1.0.0',
    author: 'Jane',
    description: 'Deep blue.',
    builtIn: false,
    light: { tokens: { background: '#ffffff', accent: '#2563eb' }, wallpaper: null },
    dark: { tokens: { background: '#071018', accent: '#60a5fa' }, wallpaper: null },
    fonts: { sans: null, mono: null },
    ...overrides,
  };
}

const builtin = theme({
  id: BUILTIN_THEME_ID,
  name: 'Zylara',
  builtIn: true,
  light: { tokens: {}, wallpaper: null },
  dark: { tokens: {}, wallpaper: null },
});

beforeEach(() => {
  applyThemeTokens(builtin, false);
  document.documentElement.removeAttribute('style');
  document.documentElement.className = '';
  delete document.documentElement.dataset.themeTokens;
  localStorage.clear();
});

describe('applyThemeTokens', () => {
  it('applies the active variant, toggles the mode class and caches tokens', () => {
    applyThemeTokens(theme(), true);

    const root = document.documentElement;
    expect(root.classList.contains('dark')).toBe(true);
    expect(root.classList.contains('light')).toBe(false);
    expect(root.style.getPropertyValue('--background')).toBe('#071018');
    expect(root.style.getPropertyValue('--accent')).toBe('#60a5fa');
    expect(root.dataset.themeTokens).toContain('accent');

    const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
    expect(cached.dark.accent).toBe('#60a5fa');
    expect(cached.light.background).toBe('#ffffff');
  });

  it('switches variants without leaving stale tokens', () => {
    applyThemeTokens(theme(), true);
    applyThemeTokens(theme(), false);

    const root = document.documentElement;
    expect(root.classList.contains('light')).toBe(true);
    expect(root.style.getPropertyValue('--background')).toBe('#ffffff');
    expect(root.style.getPropertyValue('--accent')).toBe('#2563eb');
  });

  it('maps radius tokens to the theme-radius variables used by Tailwind', () => {
    applyThemeTokens(
      theme({ dark: { tokens: { 'radius-md': '1.25rem' }, wallpaper: null } }),
      true,
    );

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--theme-radius-md')).toBe('1.25rem');
    expect(root.style.getPropertyValue('--radius-md')).toBe('');
  });

  it('clears every applied token and the cache when returning to the built-in theme', () => {
    applyThemeTokens(theme(), true);
    applyThemeTokens(builtin, true);

    const root = document.documentElement;
    expect(root.style.getPropertyValue('--background')).toBe('');
    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(root.dataset.themeTokens).toBeUndefined();
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it('caches tokens for bundled built-in themes that define a palette', () => {
    const aurora = theme({
      id: 'aurora',
      name: 'Aurora',
      builtIn: true,
      light: { tokens: { background: '#f5fbff' }, wallpaper: null },
      dark: { tokens: { background: '#07141c', accent: '#2dd4bf' }, wallpaper: null },
    });

    applyThemeTokens(aurora, true);

    const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
    expect(cached.dark.accent).toBe('#2dd4bf');
  });
});

describe('applyBorderRadius', () => {
  it('toggles the flat-borders class without disturbing theme tokens', () => {
    applyThemeTokens(theme(), false);

    applyBorderRadius(false);
    expect(document.documentElement.classList.contains('flat-borders')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb');

    applyBorderRadius(true);
    expect(document.documentElement.classList.contains('flat-borders')).toBe(false);
  });
});

describe('applyThemeAssets', () => {
  it('sets the wallpaper from the backend data URL', async () => {
    const read = vi.fn(async () => 'data:image/png;base64,AAAA');
    const withWallpaper = theme({
      dark: {
        tokens: {},
        wallpaper: 'images/dark.png',
      },
    });

    await applyThemeAssets(withWallpaper, true, read, () => true);

    expect(read).toHaveBeenCalledWith('ocean', 'images/dark.png');
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper')).toBe(
      'url("data:image/png;base64,AAAA")',
    );
  });

  it('clears wallpapers when switching back to the built-in theme', async () => {
    document.documentElement.style.setProperty('--app-wallpaper', 'url("old")');
    await applyThemeAssets(builtin, true, vi.fn(), () => true);
    expect(document.documentElement.style.getPropertyValue('--app-wallpaper')).toBe('');
  });

  it('does not mutate the document when a newer theme supersedes it', async () => {
    const read = vi.fn(async () => {
      await Promise.resolve();
      return 'data:image/png;base64,AAAA';
    });
    const withWallpaper = theme({ dark: { tokens: {}, wallpaper: 'images/dark.png' } });

    await applyThemeAssets(withWallpaper, true, read, () => false);

    expect(document.documentElement.style.getPropertyValue('--app-wallpaper')).toBe('');
  });

  it('emits the applied event so token-reading widgets can refresh', async () => {
    const listener = vi.fn();
    window.addEventListener(THEME_APPLIED_EVENT, listener);
    await applyThemeAssets(theme(), false, vi.fn(), () => true);
    window.removeEventListener(THEME_APPLIED_EVENT, listener);
    expect(listener).toHaveBeenCalled();
  });
});
