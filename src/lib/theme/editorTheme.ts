/**
 * Viewer-scoped palette for Settings › Editor.
 *
 * The shared Prism theme colors are CSS variables, so overriding those
 * variables on the viewer element is enough to give file/diff views a
 * dedicated light/dark palette without a second syntax theme or new tokens.
 * `app` emits no override and therefore follows the active host theme/mode.
 */
import type { CSSProperties } from 'react';

import type { EditorThemeMode } from '@/lib/editorSettings';
import type { ThemeInfo } from '@/lib/types';
import { normalizeThemeTokens } from './tokens';

type PaletteMode = Extract<EditorThemeMode, 'light' | 'dark'>;

const EDITOR_TOKENS = [
  'background',
  'surface',
  'surface-raised',
  'surface-hover',
  'surface-active',
  'foreground',
  'foreground-muted',
  'foreground-subtle',
  'border',
  'accent',
  'accent-hover',
  'accent-foreground',
  'accent-soft',
  'success',
  'success-soft',
  'warning',
  'warning-soft',
  'danger',
  'danger-soft',
  'code-bg',
  'user-bubble',
] as const;

/** Built-in Zylara values from `globals.css` (theme packages may omit tokens). */
const BUILTIN_PALETTES: Record<PaletteMode, Record<string, string>> = {
  light: {
    background: '#ffffff',
    surface: '#f7f7f8',
    'surface-raised': '#ffffff',
    'surface-hover': '#f0f0f2',
    'surface-active': '#e9e9ed',
    foreground: '#0e0e11',
    'foreground-muted': '#5f6066',
    'foreground-subtle': '#8b8c93',
    border: '#e8e8ec',
    accent: '#6b4eff',
    'accent-hover': '#5a3df0',
    'accent-foreground': '#ffffff',
    'accent-soft': '#f1edff',
    success: '#16a34a',
    'success-soft': '#eafaf0',
    warning: '#b45309',
    'warning-soft': '#fff7e6',
    danger: '#dc2626',
    'danger-soft': '#fef2f2',
    'code-bg': '#f7f7f8',
    'user-bubble': '#f2f2f4',
  },
  dark: {
    background: '#17171a',
    surface: '#101012',
    'surface-raised': '#1e1e22',
    'surface-hover': '#242429',
    'surface-active': '#2b2b31',
    foreground: '#ececf1',
    'foreground-muted': '#a1a1ab',
    'foreground-subtle': '#6f6f7a',
    border: '#28282e',
    accent: '#8b7bff',
    'accent-hover': '#9b8dff',
    'accent-foreground': '#121016',
    'accent-soft': '#221d3a',
    success: '#4ade80',
    'success-soft': '#10231a',
    warning: '#fbbf24',
    'warning-soft': '#2a2110',
    danger: '#f87171',
    'danger-soft': '#2b1313',
    'code-bg': '#1c1c20',
    'user-bubble': '#242429',
  },
};

/** Returns inline styles that scope the active theme's palette to a viewer. */
export function editorThemeStyle(
  theme: ThemeInfo | undefined,
  mode: EditorThemeMode,
): CSSProperties {
  if (mode === 'app') return {};

  const overrides = normalizeThemeTokens(theme?.[mode].tokens);
  const style: Record<string, string> = {};
  for (const token of EDITOR_TOKENS) {
    style[`--${token}`] = overrides[token] ?? BUILTIN_PALETTES[mode][token];
  }
  style.colorScheme = mode;
  return style as CSSProperties;
}
