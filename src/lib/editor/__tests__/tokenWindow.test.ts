import { describe, expect, it } from 'vitest';

import { windowSlice, windowSliceOfText } from '../tokenWindow';
import { lineStarts } from '../text';

const text = 'one\ntwo\nthree\nfour\nfive';
const starts = lineStarts(text);

describe('windowSlice', () => {
  it('slices on line boundaries without the trailing newline', () => {
    const slice = windowSlice(text, starts, 1, 3);
    expect(slice.code).toBe('two\nthree');
    expect(slice.startLine).toBe(1);
    expect(slice.endLine).toBe(3);
    expect(slice.firstLine).toBe(1);
    expect(slice.droppedLines).toBe(0);
    // Tokenizing the slice yields exactly the painted lines.
    expect(slice.code.split('\n')).toHaveLength(2);
  });

  it('adds context above the window and reports the dropped lines', () => {
    const slice = windowSlice(text, starts, 3, 4, 2);
    expect(slice.firstLine).toBe(1);
    expect(slice.droppedLines).toBe(2);
    expect(slice.code).toBe('two\nthree\nfour');
    expect(slice.code.split('\n')).toHaveLength(3);
  });

  it('clamps the context at the start of the document', () => {
    const slice = windowSlice(text, starts, 1, 2, 40);
    expect(slice.firstLine).toBe(0);
    expect(slice.droppedLines).toBe(1);
    expect(slice.code).toBe('one\ntwo');
  });

  it('covers the last line and the empty trailing line', () => {
    const withNewline = 'a\nb\n';
    const last = windowSlice(withNewline, lineStarts(withNewline), 2, 3);
    expect(last.code).toBe('');
    expect(last.endLine).toBe(3);

    const full = windowSlice(withNewline, lineStarts(withNewline), 0, 3);
    expect(full.code).toBe('a\nb\n');
  });

  it('handles an empty document and out-of-range input', () => {
    expect(windowSliceOfText('', 0, 10)).toMatchObject({ code: '', startLine: 0, endLine: 1 });
    const beyond = windowSlice(text, starts, 99, 120);
    expect(beyond.startLine).toBe(4);
    expect(beyond.endLine).toBe(5);
    expect(beyond.code).toBe('five');
  });
});
