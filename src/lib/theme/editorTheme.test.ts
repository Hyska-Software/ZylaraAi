import { describe, expect, it } from 'vitest';
import type { CSSProperties } from 'react';

import type { ThemeInfo } from '@/lib/types';
import { editorThemeStyle } from './editorTheme';

function theme(overrides: Partial<ThemeInfo> = {}): ThemeInfo {
  return {
    id: 'ocean',
    name: 'Ocean',
    version: '1.0.0',
    author: '',
    description: '',
    builtIn: false,
    light: { tokens: {}, wallpaper: null },
    dark: { tokens: {}, wallpaper: null },
    fonts: { sans: null, mono: null },
    ...overrides,
  };
}

function read(style: CSSProperties, name: string): string | undefined {
  return (style as Record<string, string>)[name];
}

describe('editorThemeStyle', () => {
  it('emits no override when following the host theme', () => {
    expect(editorThemeStyle(theme(), 'app')).toEqual({});
  });

  it('uses the built-in palette when theme tokens are missing', () => {
    const light = editorThemeStyle(theme(), 'light');
    expect(read(light, '--background')).toBe('#ffffff');
    expect(read(light, '--foreground')).toBe('#0e0e11');
    expect(read(light, 'colorScheme')).toBe('light');

    const dark = editorThemeStyle(undefined, 'dark');
    expect(read(dark, '--background')).toBe('#17171a');
    expect(read(dark, 'colorScheme')).toBe('dark');
  });

  it('overrides with the active theme palette of the requested mode', () => {
    const active = theme({
      light: { tokens: { background: '#f4f8ff', accent: '#2563eb' }, wallpaper: null },
      dark: { tokens: { background: '#071018' }, wallpaper: null },
    });

    const light = editorThemeStyle(active, 'light');
    expect(read(light, '--background')).toBe('#f4f8ff');
    expect(read(light, '--accent')).toBe('#2563eb');
    // Missing tokens still resolve to the built-in palette.
    expect(read(light, '--foreground')).toBe('#0e0e11');

    const dark = editorThemeStyle(active, 'dark');
    expect(read(dark, '--background')).toBe('#071018');
    expect(read(dark, '--foreground')).toBe('#ececf1');
  });
});
