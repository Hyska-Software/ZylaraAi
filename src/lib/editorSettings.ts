/**
 * File-viewer settings shared by Settings › Editor and the Code workbench
 * views. The Rust side mirrors the same bounds in `config.rs`.
 */

import type { Settings } from '@/lib/types';

export const EDITOR_THEME_MODES = ['app', 'light', 'dark'] as const;
export type EditorThemeMode = (typeof EDITOR_THEME_MODES)[number];

export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 28;
export const EDITOR_FONT_SIZE_DEFAULT = 12;

export const EDITOR_LINE_HEIGHT_MIN = 1.2;
export const EDITOR_LINE_HEIGHT_MAX = 2.2;
export const EDITOR_LINE_HEIGHT_DEFAULT = 1.7;

export const EDITOR_TAB_SIZE_MIN = 1;
export const EDITOR_TAB_SIZE_MAX = 8;
export const EDITOR_TAB_SIZE_DEFAULT = 2;

/** Longest accepted custom font-family string (mirrors the settings input). */
export const EDITOR_FONT_FAMILY_MAX_LENGTH = 200;

/** Auto save strategies offered by Settings › Editor → Saving. */
export const EDITOR_AUTO_SAVE_MODES = ['off', 'delay', 'blur'] as const;
export type EditorAutoSaveMode = (typeof EDITOR_AUTO_SAVE_MODES)[number];

export const EDITOR_AUTO_SAVE_DELAY_MIN = 200;
export const EDITOR_AUTO_SAVE_DELAY_MAX = 10_000;
export const EDITOR_AUTO_SAVE_DELAY_DEFAULT = 800;

/**
 * Largest file (bytes) the in-app editor opens for editing. Above this the
 * backend preview is truncated (`MAX_PREVIEW_BYTES`), so an editable buffer
 * would silently lose the tail — the file stays read-only with a reason.
 */
export const EDITOR_MAX_EDIT_BYTES = 512 * 1024;

/**
 * Above this size the editor keeps the text editable but stops painting
 * syntax highlight, so a large buffer cannot stall typing.
 */
export const EDITOR_HIGHLIGHT_MAX_BYTES = 128 * 1024;

export function normalizeEditorTheme(value: unknown): EditorThemeMode {
  return typeof value === 'string' && EDITOR_THEME_MODES.includes(value as EditorThemeMode)
    ? (value as EditorThemeMode)
    : 'app';
}

export function normalizeEditorAutoSave(value: unknown): EditorAutoSaveMode {
  return typeof value === 'string' && EDITOR_AUTO_SAVE_MODES.includes(value as EditorAutoSaveMode)
    ? (value as EditorAutoSaveMode)
    : 'off';
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function normalizeEditorFontSize(value: unknown): number {
  return Math.round(clampNumber(value, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_DEFAULT));
}

export function normalizeEditorLineHeight(value: unknown): number {
  const clamped = clampNumber(
    value,
    EDITOR_LINE_HEIGHT_MIN,
    EDITOR_LINE_HEIGHT_MAX,
    EDITOR_LINE_HEIGHT_DEFAULT,
  );
  return Number(clamped.toFixed(1));
}

export function normalizeEditorTabSize(value: unknown): number {
  return Math.round(clampNumber(value, EDITOR_TAB_SIZE_MIN, EDITOR_TAB_SIZE_MAX, EDITOR_TAB_SIZE_DEFAULT));
}

export function normalizeEditorAutoSaveDelay(value: unknown): number {
  return Math.round(
    clampNumber(
      value,
      EDITOR_AUTO_SAVE_DELAY_MIN,
      EDITOR_AUTO_SAVE_DELAY_MAX,
      EDITOR_AUTO_SAVE_DELAY_DEFAULT,
    ),
  );
}

/** Strips control characters and caps the length of a CSS font-family list. */
export function normalizeEditorFontFamily(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value)
    .filter((character) => !/[\u0000-\u001f\u007f]/.test(character))
    .join('')
    .trim()
    .slice(0, EDITOR_FONT_FAMILY_MAX_LENGTH);
}

/* ------------------------------------------------------------------ */
/* Resolved editor preferences                                         */
/* ------------------------------------------------------------------ */

/**
 * Boolean editor preferences. `true` means the feature is on; the default of
 * each flag lives here so Settings, the editor and the tests agree.
 */
export const EDITOR_FLAG_DEFAULTS = {
  insertSpaces: true,
  detectIndentation: true,
  autoIndent: true,
  autoCloseBrackets: true,
  trimTrailingWhitespace: false,
  insertFinalNewline: true,
  highlight: true,
  fontLigatures: false,
  lineNumbers: true,
} as const;

export type EditorFlagKey = keyof typeof EDITOR_FLAG_DEFAULTS;

/** Resolves an optional boolean setting against its documented default. */
export function resolveEditorFlag(value: unknown, flag: EditorFlagKey): boolean {
  return typeof value === 'boolean' ? value : EDITOR_FLAG_DEFAULTS[flag];
}

/** Everything the editing surface needs, already normalized and defaulted. */
export interface EditorPreferences {
  theme: EditorThemeMode;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  lineNumbers: boolean;
  fontLigatures: boolean;
  insertSpaces: boolean;
  detectIndentation: boolean;
  autoIndent: boolean;
  autoCloseBrackets: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  highlight: boolean;
  autoSave: EditorAutoSaveMode;
  autoSaveDelay: number;
}

/** Normalizes the persisted editor settings into the editor's runtime shape. */
export function editorPreferences(settings: Settings): EditorPreferences {
  return {
    theme: normalizeEditorTheme(settings.editorTheme),
    fontFamily: normalizeEditorFontFamily(settings.editorFontFamily),
    fontSize: normalizeEditorFontSize(settings.editorFontSize),
    lineHeight: normalizeEditorLineHeight(settings.editorLineHeight),
    tabSize: normalizeEditorTabSize(settings.editorTabSize),
    lineNumbers: settings.editorLineNumbers !== false,
    fontLigatures: settings.editorFontLigatures === true,
    insertSpaces: resolveEditorFlag(settings.editorInsertSpaces, 'insertSpaces'),
    detectIndentation: resolveEditorFlag(settings.editorDetectIndentation, 'detectIndentation'),
    autoIndent: resolveEditorFlag(settings.editorAutoIndent, 'autoIndent'),
    autoCloseBrackets: resolveEditorFlag(settings.editorAutoCloseBrackets, 'autoCloseBrackets'),
    trimTrailingWhitespace: resolveEditorFlag(
      settings.editorTrimTrailingWhitespace,
      'trimTrailingWhitespace',
    ),
    insertFinalNewline: resolveEditorFlag(settings.editorInsertFinalNewline, 'insertFinalNewline'),
    highlight: resolveEditorFlag(settings.editorHighlight, 'highlight'),
    autoSave: normalizeEditorAutoSave(settings.editorAutoSave),
    autoSaveDelay: normalizeEditorAutoSaveDelay(settings.editorAutoSaveDelay),
  };
}

