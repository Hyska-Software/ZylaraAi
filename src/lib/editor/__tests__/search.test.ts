import { describe, expect, it } from 'vitest';

import {
  activeMatchIndex,
  findMatches,
  replaceAllMatches,
  replaceMatch,
  type SearchOptions,
} from '../search';

const literal: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

describe('editor search', () => {
  it('finds literal matches case-insensitively by default', () => {
    const result = findMatches('Foo foo FOO', 'foo', literal);
    expect(result.error).toBeNull();
    expect(result.matches).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('honors case and whole-word options', () => {
    const exact = findMatches('Foo foo', 'foo', { ...literal, caseSensitive: true });
    expect(exact.matches).toHaveLength(1);

    const word = findMatches('foobar foo', 'foo', { ...literal, wholeWord: true });
    expect(word.matches).toEqual([{ start: 7, end: 10 }]);
  });

  it('supports regular expressions and reports syntax errors', () => {
    const result = findMatches('a1 b22 c333', '\\d+', { ...literal, regex: true });
    expect(result.matches.map((match) => match.end - match.start)).toEqual([1, 2, 3]);

    const invalid = findMatches('abc', '([', { ...literal, regex: true });
    expect(invalid.error).toBe('invalid');
    expect(invalid.matches).toEqual([]);
  });

  it('does not loop on zero-length matches', () => {
    const result = findMatches('a\nb', '^', { ...literal, regex: true });
    expect(result.matches).toHaveLength(2);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches('abc', '', literal)).toEqual({ matches: [], error: null, limited: false });
  });

  it('picks the active match from the caret', () => {
    const matches = [
      { start: 0, end: 3 },
      { start: 10, end: 13 },
    ];
    expect(activeMatchIndex(matches, 1)).toBe(0);
    expect(activeMatchIndex(matches, 11)).toBe(1);
    expect(activeMatchIndex(matches, 5)).toBe(1);
    expect(activeMatchIndex(matches, 99)).toBe(0);
    expect(activeMatchIndex([], 0)).toBe(-1);
  });

  it('replaces one match and all matches literally', () => {
    const single = replaceMatch('foo bar foo', { start: 8, end: 11 }, 'baz');
    expect(single.text).toBe('foo bar baz');
    expect(single.selection).toEqual({ anchor: 11, head: 11 });

    const all = replaceAllMatches(
      'foo bar foo',
      [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
      ],
      'x',
    );
    expect(all.text).toBe('x bar x');
    expect(all.count).toBe(2);

    expect(replaceAllMatches('abc', [], 'x').count).toBe(0);
  });
});
