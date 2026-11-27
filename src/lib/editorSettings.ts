/**
 * File-viewer settings shared by Settings › Editor and the Code workbench
 * views. The Rust side mirrors the same bounds in `config.rs`.
 */

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

export function normalizeEditorTheme(value: unknown): EditorThemeMode {
  return typeof value === 'string' && EDITOR_THEME_MODES.includes(value as EditorThemeMode)
    ? (value as EditorThemeMode)
    : 'app';
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

/** Strips control characters and caps the length of a CSS font-family list. */
export function normalizeEditorFontFamily(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value)
    .filter((character) => !/[\u0000-\u001f\u007f]/.test(character))
    .join('')
    .trim()
    .slice(0, EDITOR_FONT_FAMILY_MAX_LENGTH);
}
