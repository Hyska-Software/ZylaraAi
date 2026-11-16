import { describe, expect, it } from 'vitest';

import { THEME_TOKEN_ALLOWLIST, normalizeThemeTokens } from '@/lib/theme/tokens';

describe('normalizeThemeTokens', () => {
  it('keeps bare allowlisted tokens and strips a single -- prefix', () => {
    expect(
      normalizeThemeTokens({
        background: '#ffffff',
        '--accent': ' #8b5cf6 ',
        'radius-md': '6px',
      }),
    ).toEqual({
      background: '#ffffff',
      accent: '#8b5cf6',
      'radius-md': '6px',
    });
  });

  it('drops unknown, malformed, empty and dangerous values', () => {
    expect(
      normalizeThemeTokens({
        '--danger-token': 'red',
        'Bad Key': 'red',
        accent: '',
        surface: 'url(https://example.com)',
        foreground: '#fff;',
        warning: '#f00}',
      }),
    ).toEqual({});
  });

  it('drops values longer than the host limit', () => {
    expect(normalizeThemeTokens({ accent: 'x'.repeat(65) })).toEqual({});
    expect(normalizeThemeTokens({ accent: 'x'.repeat(64) })).toEqual({
      accent: 'x'.repeat(64),
    });
  });

  it('exposes the shared allowlist', () => {
    expect(THEME_TOKEN_ALLOWLIST.has('background')).toBe(true);
    expect(THEME_TOKEN_ALLOWLIST.has('radius-2xl')).toBe(true);
    expect(THEME_TOKEN_ALLOWLIST.has('app-wallpaper')).toBe(false);
  });
});
