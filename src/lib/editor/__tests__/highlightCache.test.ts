import { describe, expect, it, vi } from 'vitest';

import {
  HighlightCache,
  HIGHLIGHT_TILE_LINES,
  normalizeTokens,
  signatureOf,
} from '../highlightCache';
import { lineStarts } from '../text';

/** Fake tokenizer: each physical line gets one keyword token and one plain token. */
const tokenize = vi.fn((code: string, language: string) =>
  normalizeTokens(
    code.split('\n').flatMap((line) => [
      { type: language === 'typescript' ? 'keyword' : 'function', content: 'kw' },
      line,
      '\n',
    ]),
  ),
);

function makeCache() {
  tokenize.mockClear();
  return new HighlightCache(tokenize);
}

const text = Array.from({ length: 450 }, (_, index) => `const v${index} = ${index};`).join('\n');
const starts = lineStarts(text);

describe('HighlightCache', () => {
  it('tokenizes only the tiles of the requested range', () => {
    const cache = makeCache();
    expect(cache.ensureRange(text, starts, 'typescript', 0, 5)).toBe(true);
    expect(tokenize).toHaveBeenCalledTimes(1);
    expect(cache.get(0)?.[0].types).toContain('keyword');
    expect(cache.get(450)).toBeUndefined();
  });

  it('covers a range spanning two tiles', () => {
    const cache = makeCache();
    cache.ensureRange(text, starts, 'typescript', HIGHLIGHT_TILE_LINES - 1, HIGHLIGHT_TILE_LINES + 1);
    expect(tokenize).toHaveBeenCalledTimes(2);
    const line199 = cache.get(HIGHLIGHT_TILE_LINES - 1) ?? [];
    expect(line199.map((token) => token.content).join('')).toContain(`const v${HIGHLIGHT_TILE_LINES - 1}`);
    const line200 = cache.get(HIGHLIGHT_TILE_LINES) ?? [];
    expect(line200.map((token) => token.content).join('')).toContain(`const v${HIGHLIGHT_TILE_LINES}`);
  });

  it('does not re-tokenize unchanged tiles', () => {
    const cache = makeCache();
    cache.ensureRange(text, starts, 'typescript', 0, 3);
    expect(cache.ensureRange(text, starts, 'typescript', 1, 4)).toBe(false);
    expect(tokenize).toHaveBeenCalledTimes(1);
  });

  it('re-tokenizes only a tile whose content changed', () => {
    const cache = makeCache();
    cache.ensureRange(text, starts, 'typescript', 0, 3);
    cache.ensureRange(text, starts, 'typescript', HIGHLIGHT_TILE_LINES + 2, HIGHLIGHT_TILE_LINES + 3);
    expect(tokenize).toHaveBeenCalledTimes(2);

    const changed = `${text.slice(0, 20)}// x${text.slice(20)}`;
    const changedStarts = lineStarts(changed);
    expect(cache.ensureRange(changed, changedStarts, 'typescript', 0, 3)).toBe(true);
    expect(tokenize).toHaveBeenCalledTimes(3);
    // The other tile is reused.
    expect(cache.ensureRange(changed, changedStarts, 'typescript', HIGHLIGHT_TILE_LINES + 2, HIGHLIGHT_TILE_LINES + 3)).toBe(false);
  });

  it('invalidates tiles when the language changes', () => {
    const cache = makeCache();
    cache.ensureRange(text, starts, 'typescript', 0, 3);
    cache.clear();
    expect(cache.get(0)).toBeUndefined();
    expect(cache.ensureRange(text, starts, 'python', 0, 3)).toBe(true);
    expect(cache.get(0)?.[0].types).toContain('function');
  });

  it('plans stale tiles in viewport order', () => {
    const cache = makeCache();
    const tasks = cache.plan(text, starts, 'typescript', 300, 320);
    expect(tasks.length).toBe(3);
    expect(tasks[0].startLine).toBe(200);
    expect(tasks[1].startLine).toBe(400);
    // First tile is closest to the viewport but ordered after 400? No: 200 is
    // closest; 0 is farthest.
    expect(tasks[2].startLine).toBe(0);

    cache.compute(tasks[0], 'typescript');
    expect(cache.plan(text, starts, 'typescript', 300, 320).map((tile) => tile.startLine)).toEqual([400, 0]);
  });

  it('survives a tokenizer failure with plain tokens', () => {
    const broken = new HighlightCache(() => {
      throw new Error('bad grammar');
    });
    expect(broken.ensureRange(text, starts, 'typescript', 0, 2)).toBe(true);
    expect(broken.get(0)?.[0].content).toBe('const v0 = 0;');
  });

  it('computes a stable signature from code and language', () => {
    expect(signatureOf('abc', 'typescript')).toBe(signatureOf('abc', 'typescript'));
    expect(signatureOf('abc', 'typescript')).not.toBe(signatureOf('abd', 'typescript'));
    expect(signatureOf('abc', 'typescript')).not.toBe(signatureOf('abc', 'python'));
  });
});
