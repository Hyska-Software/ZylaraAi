/**
 * Pure text positioning for the in-app editor.
 *
 * The editor buffer is always LF-normalized and addressed with **UTF-16 code
 * unit offsets** — the same unit `HTMLTextAreaElement.selectionStart` uses, so
 * a selection never needs conversion when it crosses the DOM boundary. Line and
 * column are 0-based internally and rendered 1-based by the status bar.
 */

export type Eol = 'lf' | 'crlf';

export interface EditorPosition {
  /** 0-based line index. */
  line: number;
  /** 0-based column in UTF-16 code units. */
  column: number;
}

export interface EditorSelection {
  /** Fixed end of the selection (not necessarily before `head`). */
  anchor: number;
  /** Moving end: the caret. */
  head: number;
}

/** Detects the dominant line ending of a text without touching its content. */
export function detectEol(text: string): Eol {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1;
  return crlf > 0 && crlf * 2 > lf ? 'crlf' : 'lf';
}

/** Rewrites CRLF/CR into LF (the buffer's canonical form). */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Applies a line ending to LF-normalized text. */
export function applyEol(text: string, eol: Eol): string {
  const normalized = normalizeEol(text);
  return eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/**
 * Offset of the first character of every line. A trailing newline produces a
 * final empty line, exactly like a textarea (`"a\n"` has two lines).
 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/**
 * Single-entry line index cache.
 *
 * The painter, the header (Ln/Col) and the editor all ask for the line index of
 * the same buffer string, and the store never copies the text, so reference
 * equality makes the hit O(1): a keystroke builds the index once instead of once
 * per consumer.
 */
let lineIndexCache: { text: string; starts: number[] } | null = null;

export function lineIndexFor(text: string): number[] {
  if (lineIndexCache !== null && lineIndexCache.text === text) return lineIndexCache.starts;
  const starts = lineStarts(text);
  lineIndexCache = { text, starts };
  return starts;
}

/** Single-entry byte-length cache (same reference-keyed contract as above). */
let byteLengthCache: { text: string; bytes: number } | null = null;

/** UTF-8 byte length of the text, cached by string reference. */
export function byteLengthOf(text: string): number {
  if (byteLengthCache !== null && byteLengthCache.text === text) return byteLengthCache.bytes;
  const bytes = new TextEncoder().encode(text).length;
  byteLengthCache = { text, bytes };
  return bytes;
}

export function lineCount(text: string, starts: number[] = lineStarts(text)): number {
  return starts.length;
}

/** Line index containing `offset` (clamped to the text bounds). */
export function lineOf(
  text: string,
  offset: number,
  starts: number[] = lineStarts(text),
): number {
  const target = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Offset → `{ line, column }`. */
export function positionAt(
  text: string,
  offset: number,
  starts: number[] = lineStarts(text),
): EditorPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const line = lineOf(text, clamped, starts);
  return { line, column: clamped - starts[line] };
}

/** `{ line, column }` → offset, clamped to the line's content. */
export function offsetAt(
  text: string,
  position: EditorPosition,
  starts: number[] = lineStarts(text),
): number {
  const line = Math.max(0, Math.min(Math.round(position.line), starts.length - 1));
  const end = lineEnd(text, line, starts);
  const column = Math.max(0, Math.round(position.column));
  return Math.min(starts[line] + column, end);
}

/** First offset of the line, without its terminator. */
export function lineStart(line: number, starts: number[]): number {
  return starts[Math.max(0, Math.min(line, starts.length - 1))];
}

/** Offset of the line terminator (or the end of the text on the last line). */
export function lineEnd(text: string, line: number, starts: number[] = lineStarts(text)): number {
  const index = Math.max(0, Math.min(line, starts.length - 1));
  const next = starts[index + 1];
  return next === undefined ? text.length : next - 1;
}

/** Text of a line without its terminator. */
export function lineText(text: string, line: number, starts: number[] = lineStarts(text)): string {
  return text.slice(lineStart(line, starts), lineEnd(text, line, starts));
}

export function selectionStart(selection: EditorSelection): number {
  return Math.min(selection.anchor, selection.head);
}

export function selectionEnd(selection: EditorSelection): number {
  return Math.max(selection.anchor, selection.head);
}

export function hasSelection(selection: EditorSelection): boolean {
  return selection.anchor !== selection.head;
}

/**
 * Inclusive range of lines touched by a selection. A caret selects its own
 * line; a selection that ends exactly at the start of a line does not include
 * that line (the same rule every code editor uses).
 */
export function selectedLineRange(
  text: string,
  selection: EditorSelection,
  starts: number[] = lineStarts(text),
): { first: number; last: number } {
  const start = selectionStart(selection);
  const end = selectionEnd(selection);
  const first = lineOf(text, start, starts);
  let last = lineOf(text, end, starts);
  if (end > start && end === starts[last] && last > first) last -= 1;
  return { first, last };
}

/** Full-line block covered by a selection, including the last line's terminator. */
export function blockRange(
  text: string,
  selection: EditorSelection,
  starts: number[] = lineStarts(text),
): { first: number; last: number; start: number; end: number } {
  const { first, last } = selectedLineRange(text, selection, starts);
  const next = starts[last + 1];
  return {
    first,
    last,
    start: starts[first],
    end: next === undefined ? text.length : next,
  };
}

/** Leading whitespace of the line containing `offset`. */
export function leadingWhitespace(text: string, offset: number): string {
  const starts = lineStarts(text);
  const line = lineOf(text, offset, starts);
  const content = lineText(text, line, starts);
  const match = /^[ \t]*/.exec(content);
  return match ? match[0] : '';
}
