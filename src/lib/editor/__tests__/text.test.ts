import { describe, expect, it } from 'vitest';

import {
  applyEol,
  blockRange,
  detectEol,
  leadingWhitespace,
  lineCount,
  lineEnd,
  lineOf,
  lineStart,
  lineStarts,
  lineText,
  normalizeEol,
  offsetAt,
  positionAt,
  selectedLineRange,
} from '../text';

describe('editor text helpers', () => {
  it('detects, normalizes and applies line endings', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('sem quebra')).toBe('lf');
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc');
    expect(applyEol('a\nb\n', 'crlf')).toBe('a\r\nb\r\n');
    expect(applyEol('a\r\nb\n', 'lf')).toBe('a\nb\n');
  });

  it('indexes lines including the trailing empty line', () => {
    const text = 'a\nbc\n';
    expect(lineStarts(text)).toEqual([0, 2, 5]);
    expect(lineCount(text)).toBe(3);
    expect(lineText(text, 0)).toBe('a');
    expect(lineText(text, 1)).toBe('bc');
    expect(lineText(text, 2)).toBe('');
    expect(lineEnd(text, 1, lineStarts(text))).toBe(4);
    expect(lineStart(1, lineStarts(text))).toBe(2);
  });

  it('maps offsets to positions and back', () => {
    const text = 'hello\nworld';
    expect(positionAt(text, 0)).toEqual({ line: 0, column: 0 });
    expect(positionAt(text, 5)).toEqual({ line: 0, column: 5 });
    expect(positionAt(text, 6)).toEqual({ line: 1, column: 0 });
    expect(positionAt(text, text.length)).toEqual({ line: 1, column: 5 });
    expect(offsetAt(text, { line: 1, column: 3 })).toBe(9);
    expect(offsetAt(text, { line: 9, column: 9 })).toBe(11);
    expect(lineOf(text, 6)).toBe(1);
    expect(lineOf(text, 99)).toBe(1);
  });

  it('resolves the selected line range like a code editor', () => {
    const text = 'one\ntwo\nthree\n';
    // Caret alone selects its own line.
    expect(selectedLineRange(text, { anchor: 5, head: 5 })).toEqual({ first: 1, last: 1 });
    // A selection ending exactly at the next line start does not include it.
    expect(selectedLineRange(text, { anchor: 0, head: 4 })).toEqual({ first: 0, last: 0 });
    expect(selectedLineRange(text, { anchor: 0, head: 5 })).toEqual({ first: 0, last: 1 });
    expect(selectedLineRange(text, { anchor: 13, head: 0 })).toEqual({ first: 0, last: 2 });
  });

  it('covers whole lines in a block range', () => {
    const text = 'one\ntwo\nthree\n';
    expect(blockRange(text, { anchor: 1, head: 1 })).toEqual({
      first: 0,
      last: 0,
      start: 0,
      end: 4,
    });
    expect(blockRange(text, { anchor: 0, head: 8 })).toMatchObject({ first: 0, last: 1, end: 8 });
    expect(blockRange(text, { anchor: 13, head: 13 })).toMatchObject({ first: 2, last: 2, end: 14 });
  });

  it('reads the indentation of the caret line', () => {
    expect(leadingWhitespace('  x\n\ty', 4)).toBe('\t');
    expect(leadingWhitespace('    x', 3)).toBe('    ');
  });
});
