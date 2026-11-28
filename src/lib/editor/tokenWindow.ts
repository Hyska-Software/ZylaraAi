/**
 * Tokenization window of the in-app editor.
 *
 * Prism tokenizes whole documents and its grammar is stateful (a template
 * literal or block comment can span hundreds of lines), so re-tokenizing the
 * file on every keystroke is both slow and unavoidable *for a slice without
 * context*. The editor therefore tokenizes only the painted window plus a
 * margin of lines above it: the margin gives multi-line constructs the state
 * they started with, and the cost stays proportional to the viewport.
 *
 * A construct that starts **above** the margin is painted as plain text; the
 * caller keeps full-document tokenization for small files, so this only affects
 * large documents.
 */

import { lineStarts } from './text';

export interface WindowSlice {
  /** Text of the slice, always starting and ending on a line boundary. */
  code: string;
  /** 0-based line where `code` starts. */
  firstLine: number;
  /** Leading lines of `code` that exist only as tokenization context. */
  droppedLines: number;
  /** First painted line (0-based) covered by `code`. */
  startLine: number;
  /** Last painted line (exclusive) covered by `code`. */
  endLine: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Slice of `text` covering `[start, end)` with `context` extra lines above it.
 * The slice never ends with a newline (the terminator of the last line is
 * excluded), so its token count equals the number of lines it represents.
 */
export function windowSlice(
  text: string,
  starts: number[],
  start: number,
  end: number,
  context = 0,
): WindowSlice {
  const lineCount = starts.length;
  const firstPainted = clamp(Math.floor(start), 0, Math.max(0, lineCount - 1));
  const lastPainted = clamp(Math.ceil(end), firstPainted + 1, lineCount);
  const firstLine = clamp(firstPainted - Math.max(0, Math.floor(context)), 0, firstPainted);

  const from = starts[firstLine];
  const to = lastPainted >= lineCount ? text.length : Math.max(from, starts[lastPainted] - 1);
  return {
    code: text.slice(from, to),
    firstLine,
    droppedLines: firstPainted - firstLine,
    startLine: firstPainted,
    endLine: lastPainted,
  };
}

/** `lineStarts` convenience wrapper for callers that only have the text. */
export function windowSliceOfText(
  text: string,
  start: number,
  end: number,
  context = 0,
): WindowSlice {
  return windowSlice(text, lineStarts(text), start, end, context);
}
