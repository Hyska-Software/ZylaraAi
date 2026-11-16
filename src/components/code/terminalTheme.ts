/**
 * xterm theme derived from the Zylara design tokens.
 *
 * xterm needs concrete color strings (its renderer does not resolve CSS
 * variables for all surfaces), so the values are read from the tokens on
 * `:root` whenever the theme changes. The ANSI palette lives in
 * `src/styles/globals.css` as `--terminal-ansi-*`.
 */
import type { ITheme } from '@xterm/xterm';

const FALLBACK_THEME: ITheme = {
  background: '#101012',
  foreground: '#ececf1',
  cursor: '#8b7bff',
  cursorAccent: '#101012',
  selectionBackground: '#8b7bff44',
  black: '#3a3a44',
  red: '#f07171',
  green: '#6bd98a',
  yellow: '#e5c07b',
  blue: '#7aa2f7',
  magenta: '#c792ea',
  cyan: '#6fd6d6',
  white: '#c7c7d1',
  brightBlack: '#6f6f7a',
  brightRed: '#ff8a8a',
  brightGreen: '#8ff0a4',
  brightYellow: '#ffd580',
  brightBlue: '#9ab8ff',
  brightMagenta: '#e0aaff',
  brightCyan: '#9bf0f0',
  brightWhite: '#ffffff',
};

/**
 * Bundled monospace stack of the terminal. It is the terminal's own default
 * (it does not follow `--font-mono`), so neither a theme nor a stale preference
 * can replace JetBrains Mono behind the user's back.
 */
export const TERMINAL_DEFAULT_FONT_FAMILY =
  "'JetBrains Mono Variable', ui-monospace, 'Cascadia Code', 'Fira Code', monospace";

/** Generic CSS families that already terminate a valid font stack. */
const GENERIC_FAMILIES = new Set([
  'monospace',
  'ui-monospace',
  'system-ui',
  'sans-serif',
  'serif',
  'cursive',
  'fantasy',
]);

/** True when the stack ends in a generic family (`Fira Code, monospace`). */
function endsWithGenericFamily(stack: string): boolean {
  const last = stack.split(',').pop()?.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase() ?? '';
  return GENERIC_FAMILIES.has(last);
}

function readToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Builds an xterm theme from the current app tokens (light or dark). */
export function buildTerminalTheme(): ITheme {
  return {
    background: readToken('--surface', FALLBACK_THEME.background ?? '#101012'),
    foreground: readToken('--foreground', FALLBACK_THEME.foreground ?? '#ececf1'),
    cursor: readToken('--accent', '#8b7bff'),
    // The cursor block blends with the terminal surface while it is inverted.
    cursorAccent: readToken('--surface', '#101012'),
    selectionBackground: readToken('--terminal-selection', '#8b7bff44'),
    black: readToken('--terminal-ansi-black', FALLBACK_THEME.black ?? '#3a3a44'),
    red: readToken('--terminal-ansi-red', FALLBACK_THEME.red ?? '#f07171'),
    green: readToken('--terminal-ansi-green', FALLBACK_THEME.green ?? '#6bd98a'),
    yellow: readToken('--terminal-ansi-yellow', FALLBACK_THEME.yellow ?? '#e5c07b'),
    blue: readToken('--terminal-ansi-blue', FALLBACK_THEME.blue ?? '#7aa2f7'),
    magenta: readToken('--terminal-ansi-magenta', FALLBACK_THEME.magenta ?? '#c792ea'),
    cyan: readToken('--terminal-ansi-cyan', FALLBACK_THEME.cyan ?? '#6fd6d6'),
    white: readToken('--terminal-ansi-white', FALLBACK_THEME.white ?? '#c7c7d1'),
    brightBlack: readToken(
      '--terminal-ansi-bright-black',
      FALLBACK_THEME.brightBlack ?? '#6f6f7a',
    ),
    brightRed: readToken('--terminal-ansi-bright-red', FALLBACK_THEME.brightRed ?? '#ff8a8a'),
    brightGreen: readToken(
      '--terminal-ansi-bright-green',
      FALLBACK_THEME.brightGreen ?? '#8ff0a4',
    ),
    brightYellow: readToken(
      '--terminal-ansi-bright-yellow',
      FALLBACK_THEME.brightYellow ?? '#ffd580',
    ),
    brightBlue: readToken('--terminal-ansi-bright-blue', FALLBACK_THEME.brightBlue ?? '#9ab8ff'),
    brightMagenta: readToken(
      '--terminal-ansi-bright-magenta',
      FALLBACK_THEME.brightMagenta ?? '#e0aaff',
    ),
    brightCyan: readToken('--terminal-ansi-bright-cyan', FALLBACK_THEME.brightCyan ?? '#9bf0f0'),
    brightWhite: readToken(
      '--terminal-ansi-bright-white',
      FALLBACK_THEME.brightWhite ?? '#ffffff',
    ),
  };
}

/**
 * Terminal font stack. An empty preference keeps the bundled JetBrains Mono
 * stack (the terminal never follows the theme token); a non-empty preference
 * wins, and when it has no generic family JetBrains Mono stays as its fallback
 * so a missing font cannot degrade the terminal to the browser default.
 */
export function terminalFontFamily(custom?: string): string {
  const trimmed = custom?.trim();
  if (!trimmed) return TERMINAL_DEFAULT_FONT_FAMILY;
  return endsWithGenericFamily(trimmed) ? trimmed : `${trimmed}, ${TERMINAL_DEFAULT_FONT_FAMILY}`;
}

/** Cursor blink and the running indicator should respect reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
