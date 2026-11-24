import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHARED_SCALE: Record<string, string> = {
  xs: '2px',
  sm: '2px',
  md: '4px',
  lg: '6px',
  xl: '8px',
  '2xl': '10px',
  '3xl': '12px',
};

describe('default radius scale', () => {
  it('keeps the built-in Zylara radii aligned with the bundled themes', () => {
    const cssPath = resolve(process.cwd(), 'src/styles/globals.css');
    const css = readFileSync(cssPath, 'utf8');
    const rootStart = css.indexOf(':root {');
    const rootEnd = css.indexOf('\n}', rootStart);
    expect(rootStart).toBeGreaterThan(-1);
    expect(rootEnd).toBeGreaterThan(rootStart);

    const rootBlock = css.slice(rootStart, rootEnd);
    for (const [step, value] of Object.entries(SHARED_SCALE)) {
      expect(rootBlock).toContain(`--theme-radius-${step}: ${value};`);
    }
  });
});
