import { describe, expect, it } from 'vitest';

import {
  EDITOR_FONT_FAMILY_MAX_LENGTH,
  normalizeEditorFontFamily,
  normalizeEditorFontSize,
  normalizeEditorLineHeight,
  normalizeEditorTabSize,
  normalizeEditorTheme,
} from './editorSettings';

describe('editorSettings', () => {
  it('falls back to app for unknown theme modes', () => {
    expect(normalizeEditorTheme('dark')).toBe('dark');
    expect(normalizeEditorTheme('light')).toBe('light');
    expect(normalizeEditorTheme('system')).toBe('app');
    expect(normalizeEditorTheme(undefined)).toBe('app');
  });

  it('clamps numeric preferences and replaces non-finite values', () => {
    expect(normalizeEditorFontSize(99)).toBe(28);
    expect(normalizeEditorFontSize(1)).toBe(8);
    expect(normalizeEditorFontSize(Number.NaN)).toBe(12);
    expect(normalizeEditorLineHeight(9)).toBe(2.2);
    expect(normalizeEditorLineHeight(0)).toBe(1.2);
    expect(normalizeEditorLineHeight(1.75)).toBe(1.8);
    expect(normalizeEditorTabSize(42)).toBe(8);
    expect(normalizeEditorTabSize(undefined)).toBe(2);
  });

  it('sanitizes the font-family list without changing valid stacks', () => {
    expect(normalizeEditorFontFamily('  Fira Code, monospace  ')).toBe('Fira Code, monospace');
    expect(normalizeEditorFontFamily('A\nB\u0000C')).toBe('ABC');
    expect(normalizeEditorFontFamily('x'.repeat(300)).length).toBe(
      EDITOR_FONT_FAMILY_MAX_LENGTH,
    );
    expect(normalizeEditorFontFamily(42)).toBe('');
  });
});
