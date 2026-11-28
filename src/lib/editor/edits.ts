/**
 * Pure edit operations of the in-app editor.
 *
 * Every function takes the current document state and returns the next one, so
 * the React surface only has to apply the result to its textarea and the undo
 * history. Nothing here touches the DOM.
 */

import {
  blockRange,
  hasSelection,
  leadingWhitespace,
  lineEnd,
  lineStarts,
  lineText,
  selectedLineRange,
  selectionEnd,
  selectionStart,
  type EditorSelection,
} from './text';

export interface EditorState {
  text: string;
  selection: EditorSelection;
}

export interface EditOptions {
  tabSize: number;
  insertSpaces: boolean;
  autoIndent: boolean;
  autoCloseBrackets: boolean;
}

export interface CommentTokens {
  /** Line comment marker (`//`, `#`, `--`, `;`). */
  line?: string;
  /** Block comment pair (`['<!--', '-->']`). */
  block?: [string, string];
}

/** Matches an opening character to its closing counterpart. */
const BRACKET_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
};

const CLOSING_CHARS = new Set(Object.values(BRACKET_PAIRS));
const QUOTES = new Set(['"', "'", '`']);

/** One indentation step for the current options. */
export function indentUnit(options: Pick<EditOptions, 'insertSpaces' | 'tabSize'>): string {
  return options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t';
}

function caretState(text: string, caret: number): EditorState {
  const clamped = Math.max(0, Math.min(caret, text.length));
  return { text, selection: { anchor: clamped, head: clamped } };
}

/** Replaces a range and leaves the caret at the end of the inserted text. */
export function replaceRange(
  state: EditorState,
  start: number,
  end: number,
  insert: string,
): EditorState {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(start, end);
  const text = `${state.text.slice(0, from)}${insert}${state.text.slice(to)}`;
  return caretState(text, from + insert.length);
}

/** Inserts text exactly as given, replacing the selection (find/replace, paste). */
export function insertPlain(state: EditorState, insert: string): EditorState {
  return replaceRange(state, selectionStart(state.selection), selectionEnd(state.selection), insert);
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\w$]/.test(character);
}

/**
 * Types one character.
 *
 * Bracket/quote auto-close rules (all optional through `autoCloseBrackets`):
 * - typing an opener with a selection wraps the selection;
 * - with the caret before the matching closer, typing the closer just steps
 *   over it instead of duplicating it;
 * - an opener with nothing word-like after it inserts the pair, caret inside.
 * A quote right after a word character (`don't`) never auto-closes.
 */
export function insertText(state: EditorState, insert: string, options: EditOptions): EditorState {
  const { text } = state;
  const start = selectionStart(state.selection);
  const end = selectionEnd(state.selection);

  if (!options.autoCloseBrackets || insert.length !== 1) return insertPlain(state, insert);

  const opener = insert;
  const before = start > 0 ? text[start - 1] : undefined;
  const next = text[end] ?? undefined;

  // Typing a closer over an existing one: step over it.
  if (CLOSING_CHARS.has(opener) && !hasSelection(state.selection) && next === opener) {
    return caretState(text, start + 1);
  }

  const closer = BRACKET_PAIRS[opener];
  if (!closer) return insertPlain(state, insert);

  if (QUOTES.has(opener) && isWordCharacter(before)) return insertPlain(state, insert);

  if (hasSelection(state.selection)) {
    const selected = text.slice(start, end);
    const updated = `${text.slice(0, start)}${opener}${selected}${closer}${text.slice(end)}`;
    return {
      text: updated,
      selection: { anchor: start + 1, head: start + 1 + selected.length },
    };
  }

  const nextCharacter = text[start] ?? '';
  const canOpenPair =
    nextCharacter === '' || nextCharacter === '\n' || /\s/.test(nextCharacter);
  if (!canOpenPair) return insertPlain(state, insert);

  const updated = `${text.slice(0, start)}${opener}${closer}${text.slice(start)}`;
  return caretState(updated, start + 1);
}

/**
 * Enter: keeps the current indentation, expands a bracket pair onto two lines
 * and, with auto-indent on, indents the new line one level when the line ends
 * with an opener.
 */
export function insertNewline(state: EditorState, options: EditOptions): EditorState {
  const { text } = state;
  const start = selectionStart(state.selection);
  const end = selectionEnd(state.selection);

  if (hasSelection(state.selection)) {
    const replaced = `${text.slice(0, start)}\n${text.slice(end)}`;
    const indent = options.autoIndent ? leadingWhitespace(text, start) : '';
    if (!indent) return caretState(replaced, start + 1);
    return caretState(`${text.slice(0, start)}\n${indent}${text.slice(end)}`, start + 1 + indent.length);
  }

  const indent = options.autoIndent ? leadingWhitespace(text, start) : '';
  const unit = indentUnit(options);
  const before = text[start - 1];
  const after = text[start];
  const closesPair =
    options.autoCloseBrackets &&
    before !== undefined &&
    after !== undefined &&
    BRACKET_PAIRS[before] === after;

  if (closesPair) {
    const updated = `${text.slice(0, start)}\n${indent}${unit}\n${indent}${text.slice(start)}`;
    return caretState(updated, start + 1 + indent.length + unit.length);
  }

  const updated = `${text.slice(0, start)}\n${indent}${text.slice(start)}`;
  return caretState(updated, start + 1 + indent.length);
}

function lineParts(text: string): string[] {
  return text.split('\n');
}

function selectionForLines(
  text: string,
  first: number,
  last: number,
  collapsedColumn?: number,
): EditorSelection {
  if (collapsedColumn !== undefined) {
    const starts = lineStarts(text);
    const line = Math.max(0, Math.min(first, starts.length - 1));
    const start = starts[line];
    return { anchor: start + collapsedColumn, head: start + collapsedColumn };
  }
  const starts = lineStarts(text);
  const anchor = starts[Math.max(0, Math.min(first, starts.length - 1))];
  const lastLine = Math.max(0, Math.min(last, starts.length - 1));
  return { anchor, head: lineEnd(text, lastLine, starts) };
}

/** Tab with a selection indents every selected line; without one, inserts a unit. */
export function indentSelection(state: EditorState, options: EditOptions): EditorState {
  const unit = indentUnit(options);
  const { text } = state;

  if (!hasSelection(state.selection)) {
    const caret = selectionStart(state.selection);
    const updated = `${text.slice(0, caret)}${unit}${text.slice(caret)}`;
    return caretState(updated, caret + unit.length);
  }

  const block = blockRange(text, state.selection);
  const caretColumn = selectionStart(state.selection) - block.start;
  const lines = lineParts(text);
  for (let line = block.first; line <= block.last; line += 1) {
    lines[line] = `${unit}${lines[line]}`;
  }
  const updated = lines.join('\n');
  const collapsed = state.selection.anchor === state.selection.head;
  return {
    text: updated,
    selection: selectionForLines(
      updated,
      block.first,
      block.last,
      collapsed ? caretColumn + unit.length : undefined,
    ),
  };
}

/** Shift+Tab: removes one indentation step from every selected line. */
export function outdentSelection(state: EditorState, options: EditOptions): EditorState {
  const { text } = state;
  const unit = indentUnit(options);
  const block = blockRange(text, state.selection);
  const collapsed = state.selection.anchor === state.selection.head;
  const caret = selectionStart(state.selection);
  const caretLine = collapsed ? selectedLineRange(text, state.selection).first : -1;
  const caretColumn = collapsed ? caret - block.start : 0;

  const lines = lineParts(text);
  let removedOnCaretLine = 0;
  for (let line = block.first; line <= block.last; line += 1) {
    const content = lines[line];
    let removed = 0;
    if (unit === '\t') {
      if (content.startsWith('\t')) removed = 1;
    } else {
      while (removed < unit.length && content[removed] === ' ') removed += 1;
    }
    if (removed > 0) lines[line] = content.slice(removed);
    if (line === caretLine) removedOnCaretLine = removed;
  }

  const updated = lines.join('\n');
  return {
    text: updated,
    selection: selectionForLines(
      updated,
      block.first,
      block.last,
      collapsed ? Math.max(0, caretColumn - removedOnCaretLine) : undefined,
    ),
  };
}

function isLineCommented(line: string, token: string): boolean {
  return line.trimStart().startsWith(token);
}

/**
 * Ctrl+/: comments or uncomments the selected lines. The marker is inserted
 * after the indentation so the block keeps its shape.
 */
export function toggleLineComment(state: EditorState, tokens: CommentTokens): EditorState {
  const token = tokens.line;
  if (!token) return state;

  const { text } = state;
  const block = blockRange(text, state.selection);
  const collapsed = state.selection.anchor === state.selection.head;
  const caret = selectionStart(state.selection);
  const caretLine = collapsed ? selectedLineRange(text, state.selection).first : -1;
  const caretColumn = collapsed ? caret - block.start : 0;

  const lines = lineParts(text);
  const relevant = lines.slice(block.first, block.last + 1).filter((line) => line.trim().length > 0);
  const allCommented = relevant.length > 0 && relevant.every((line) => isLineCommented(line, token));

  let deltaOnCaretLine = 0;
  for (let line = block.first; line <= block.last; line += 1) {
    const content = lines[line];
    if (!allCommented && content.trim().length === 0) continue;
    const indent = /^[ \t]*/.exec(content)?.[0] ?? '';
    if (allCommented) {
      const rest = content.slice(indent.length);
      if (!rest.startsWith(token)) continue;
      const removable = rest.startsWith(`${token} `) ? token.length + 1 : token.length;
      lines[line] = `${indent}${rest.slice(removable)}`;
      if (line === caretLine) deltaOnCaretLine = -Math.min(removable, Math.max(0, caretColumn - indent.length));
    } else {
      const inserted = `${token} `;
      lines[line] = `${indent}${inserted}${content.slice(indent.length)}`;
      if (line === caretLine) deltaOnCaretLine = inserted.length;
    }
  }

  const updated = lines.join('\n');
  return {
    text: updated,
    selection: selectionForLines(
      updated,
      block.first,
      block.last,
      collapsed ? Math.max(0, caretColumn + deltaOnCaretLine) : undefined,
    ),
  };
}

export type MoveDirection = 'up' | 'down';

/** Alt+Up / Alt+Down: swaps the selected block with its neighbour. */
export function moveLines(state: EditorState, direction: MoveDirection): EditorState {
  const { text } = state;
  const block = blockRange(text, state.selection);
  const lines = lineParts(text);
  const lastLine = lines.length - 1;
  const delta = direction === 'up' ? -1 : 1;
  if (direction === 'up' && block.first === 0) return state;
  if (direction === 'down' && block.last === lastLine) return state;

  const moved = lines.splice(block.first, block.last - block.first + 1);
  lines.splice(block.first + delta, 0, ...moved);
  const updated = lines.join('\n');
  const collapsed = state.selection.anchor === state.selection.head;
  const caretColumn = selectionStart(state.selection) - block.start;
  return {
    text: updated,
    selection: selectionForLines(
      updated,
      block.first + delta,
      block.last + delta,
      collapsed ? caretColumn : undefined,
    ),
  };
}

/** Shift+Alt+Down: copies the selected block below itself and selects the copy. */
export function duplicateLines(state: EditorState): EditorState {
  const { text } = state;
  const block = blockRange(text, state.selection);
  const lines = lineParts(text);
  const height = block.last - block.first + 1;
  const copied = lines.slice(block.first, block.last + 1);
  lines.splice(block.last + 1, 0, ...copied);
  const updated = lines.join('\n');
  const collapsed = state.selection.anchor === state.selection.head;
  const caretColumn = selectionStart(state.selection) - block.start;
  return {
    text: updated,
    selection: selectionForLines(
      updated,
      block.first + height,
      block.last + height,
      collapsed ? caretColumn : undefined,
    ),
  };
}

/** Ctrl+Shift+K: removes the selected lines. */
export function deleteLines(state: EditorState): EditorState {
  const { text } = state;
  const block = blockRange(text, state.selection);
  const lines = lineParts(text);
  lines.splice(block.first, block.last - block.first + 1);
  if (lines.length === 0) return caretState('', 0);
  const updated = lines.join('\n');
  const starts = lineStarts(updated);
  const line = Math.min(block.first, starts.length - 1);
  return caretState(updated, starts[line]);
}

/** Ctrl+A. */
export function selectAll(state: EditorState): EditorState {
  return { text: state.text, selection: { anchor: 0, head: state.text.length } };
}

/**
 * Go to line (Ctrl+G): caret at the requested 1-based line, clamped to the
 * document. The column is preserved when it still exists.
 */
export function goToLine(state: EditorState, lineNumber: number): EditorState {
  const starts = lineStarts(state.text);
  const line = Math.max(0, Math.min(Math.round(lineNumber) - 1, starts.length - 1));
  if (!Number.isFinite(line)) return state;
  const caret = Math.min(starts[line], lineEnd(state.text, line, starts));
  return caretState(state.text, caret);
}

/** Text of the selected lines, used by indentation guessing and tests. */
export function selectedLineTexts(state: EditorState): string[] {
  const starts = lineStarts(state.text);
  const { first, last } = selectedLineRange(state.text, state.selection, starts);
  const lines: string[] = [];
  for (let line = first; line <= last; line += 1) {
    lines.push(lineText(state.text, line, starts));
  }
  return lines;
}
