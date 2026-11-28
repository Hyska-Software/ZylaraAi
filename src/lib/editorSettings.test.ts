import { describe, expect, it } from 'vitest';

import {
  EDITOR_AUTO_SAVE_DELAY_MAX,
  EDITOR_AUTO_SAVE_DELAY_MIN,
  EDITOR_FONT_FAMILY_MAX_LENGTH,
  editorPreferences,
  normalizeEditorAutoSave,
  normalizeEditorAutoSaveDelay,
  normalizeEditorFontFamily,
  normalizeEditorFontSize,
  normalizeEditorLineHeight,
  normalizeEditorTabSize,
  normalizeEditorTheme,
  resolveEditorFlag,
} from './editorSettings';
import type { Settings } from './types';

const baseSettings = {
  locale: 'en',
} as Settings;

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
    expect(normalizeEditorAutoSaveDelay(50)).toBe(EDITOR_AUTO_SAVE_DELAY_MIN);
    expect(normalizeEditorAutoSaveDelay(99_999)).toBe(EDITOR_AUTO_SAVE_DELAY_MAX);
    expect(normalizeEditorAutoSaveDelay(undefined)).toBe(800);
  });

  it('normalizes the auto save mode', () => {
    expect(normalizeEditorAutoSave('delay')).toBe('delay');
    expect(normalizeEditorAutoSave('blur')).toBe('blur');
    expect(normalizeEditorAutoSave('always')).toBe('off');
    expect(normalizeEditorAutoSave(undefined)).toBe('off');
  });

  it('resolves boolean flags against their documented defaults', () => {
    expect(resolveEditorFlag(undefined, 'autoIndent')).toBe(true);
    expect(resolveEditorFlag(false, 'autoIndent')).toBe(false);
    expect(resolveEditorFlag(undefined, 'trimTrailingWhitespace')).toBe(false);
    expect(resolveEditorFlag(true, 'trimTrailingWhitespace')).toBe(true);
  });

  it('sanitizes the font-family list without changing valid stacks', () => {
    expect(normalizeEditorFontFamily('  Fira Code, monospace  ')).toBe('Fira Code, monospace');
    expect(normalizeEditorFontFamily('A\nB\u0000C')).toBe('ABC');
    expect(normalizeEditorFontFamily('x'.repeat(300)).length).toBe(
      EDITOR_FONT_FAMILY_MAX_LENGTH,
    );
    expect(normalizeEditorFontFamily(42)).toBe('');
  });

  it('builds the resolved preferences with defaults applied', () => {
    const defaults = editorPreferences(baseSettings);
    expect(defaults).toMatchObject({
      theme: 'app',
      fontSize: 12,
      lineHeight: 1.7,
      tabSize: 2,
      lineNumbers: true,
      insertSpaces: true,
      autoIndent: true,
      autoCloseBrackets: true,
      insertFinalNewline: true,
      trimTrailingWhitespace: false,
      highlight: true,
      fontLigatures: false,
      autoSave: 'off',
      autoSaveDelay: 800,
    });

    const custom = editorPreferences({
      ...baseSettings,
      editorLineNumbers: false,
      editorAutoSave: 'blur',
      editorAutoSaveDelay: 1500,
      editorTrimTrailingWhitespace: true,
      editorHighlight: false,
      editorFontLigatures: true,
      editorTabSize: 4,
    });
    expect(custom).toMatchObject({
      lineNumbers: false,
      autoSave: 'blur',
      autoSaveDelay: 1500,
      trimTrailingWhitespace: true,
      highlight: false,
      fontLigatures: true,
      tabSize: 4,
    });
  });
});

