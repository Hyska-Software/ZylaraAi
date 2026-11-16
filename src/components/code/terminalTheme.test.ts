// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTerminalTheme, terminalFontFamily, TERMINAL_DEFAULT_FONT_FAMILY } from './terminalTheme';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminalTheme', () => {
  it('uses the sidebar surface so the terminal blends with the right panel', () => {
    const tokens: Record<string, string> = {
      '--surface': '#101012',
      // The terminal must not reuse the chat tone for its background.
      '--background': '#17171a',
      '--foreground': '#ececf1',
    };
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => tokens[name] ?? '#000000',
    } as unknown as CSSStyleDeclaration);

    const theme = buildTerminalTheme();

    expect(theme.background).toBe('#101012');
    expect(theme.cursorAccent).toBe('#101012');
  });

  it('keeps the bundled JetBrains Mono stack when the preference is empty', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) =>
        name === '--font-mono' ? '"Theme Mono", monospace' : '',
    } as unknown as CSSStyleDeclaration);

    // The terminal has its own default: a theme token must not replace it.
    expect(TERMINAL_DEFAULT_FONT_FAMILY.startsWith("'JetBrains Mono Variable'")).toBe(true);
    expect(terminalFontFamily()).toBe(TERMINAL_DEFAULT_FONT_FAMILY);
    expect(terminalFontFamily('   ')).toBe(TERMINAL_DEFAULT_FONT_FAMILY);
  });

  it('lets the terminal font preference win and keeps JetBrains Mono as its fallback', () => {
    expect(terminalFontFamily('Fira Code')).toBe(`Fira Code, ${TERMINAL_DEFAULT_FONT_FAMILY}`);
    // A stack that already ends in a generic family is respected as written.
    expect(terminalFontFamily('  "Fira Code", monospace ')).toBe('"Fira Code", monospace');
  });
});
