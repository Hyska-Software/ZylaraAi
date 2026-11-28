import { describe, expect, it } from 'vitest';

import {
  deleteLines,
  duplicateLines,
  goToLine,
  indentSelection,
  insertNewline,
  insertPlain,
  insertText,
  moveLines,
  outdentSelection,
  selectAll,
  toggleLineComment,
  type EditOptions,
  type EditorState,
} from '../edits';

const options: EditOptions = {
  tabSize: 2,
  insertSpaces: true,
  autoIndent: true,
  autoCloseBrackets: true,
};

function state(text: string, anchor: number, head = anchor): EditorState {
  return { text, selection: { anchor, head } };
}

describe('editor edit operations', () => {
  it('inserts plain text over a selection', () => {
    expect(insertPlain(state('hello world', 6, 11), 'there')).toEqual({
      text: 'hello there',
      selection: { anchor: 11, head: 11 },
    });
  });

  it('auto-closes brackets and quotes', () => {
    const opened = insertText(state('', 0), '(', options);
    expect(opened.text).toBe('()');
    expect(opened.selection).toEqual({ anchor: 1, head: 1 });

    const quote = insertText(state('', 0), '"', options);
    expect(quote.text).toBe('""');

    // Typing the closing character steps over it.
    const stepped = insertText(state('()', 1), ')', options);
    expect(stepped.text).toBe('()');
    expect(stepped.selection).toEqual({ anchor: 2, head: 2 });

    // A quote right after a word never closes.
    const apostrophe = insertText(state("don", 3), "'", options);
    expect(apostrophe.text).toBe("don'");

    // With auto-close off nothing is inserted around the caret.
    const disabled = insertText(state('', 0), '(', { ...options, autoCloseBrackets: false });
    expect(disabled.text).toBe('(');
  });

  it('wraps the selection when typing an opener', () => {
    const wrapped = insertText(state('value', 0, 5), '(', options);
    expect(wrapped.text).toBe('(value)');
    expect(wrapped.selection).toEqual({ anchor: 1, head: 6 });
  });

  it('keeps the indentation on Enter and expands a pair', () => {
    const indented = insertNewline(state('  call()', 8), options);
    expect(indented.text).toBe('  call()\n  ');
    expect(indented.selection.anchor).toBe(11);

    const expanded = insertNewline(state('  ()', 3), options);
    expect(expanded.text).toBe('  (\n    \n  )');
    expect(expanded.selection.anchor).toBe(8);

    const noIndent = insertNewline(state('x', 1), { ...options, autoIndent: false });
    expect(noIndent.text).toBe('x\n');
  });

  it('indents and outdents selected lines', () => {
    const indented = indentSelection(state('a\nb', 0, 3), options);
    expect(indented.text).toBe('  a\n  b');
    expect(indented.selection).toEqual({ anchor: 0, head: 7 });

    const collapsed = indentSelection(state('ab', 1), options);
    expect(collapsed.text).toBe('a  b');
    expect(collapsed.selection).toEqual({ anchor: 3, head: 3 });

    const outdented = outdentSelection(indented, options);
    expect(outdented.text).toBe('a\nb');

    const tabs = outdentSelection(state('\tx', 1), { ...options, insertSpaces: false });
    expect(tabs.text).toBe('x');
  });

  it('toggles line comments after the indentation', () => {
    const commented = toggleLineComment(state('  const a = 1;', 4), { line: '//' });
    expect(commented.text).toBe('  // const a = 1;');

    const uncommented = toggleLineComment(commented, { line: '//' });
    expect(uncommented.text).toBe('  const a = 1;');

    const block = toggleLineComment(state('a\nb', 0, 3), { line: '#' });
    expect(block.text).toBe('# a\n# b');

    const withoutLineComment = toggleLineComment(state('x', 0), { block: ['<!--', '-->'] });
    expect(withoutLineComment.text).toBe('x');
  });

  it('moves, duplicates and deletes lines', () => {
    const movedUp = moveLines(state('a\nb\nc', 2), 'up');
    expect(movedUp.text).toBe('b\na\nc');
    expect(movedUp.selection.anchor).toBe(0);

    const movedDown = moveLines(state('a\nb\nc', 0), 'down');
    expect(movedDown.text).toBe('b\na\nc');

    // Edges are no-ops.
    expect(moveLines(state('a\nb', 0), 'up').text).toBe('a\nb');
    expect(moveLines(state('a\nb', 3), 'down').text).toBe('a\nb');

    const duplicated = duplicateLines(state('a\nb\nc', 2));
    expect(duplicated.text).toBe('a\nb\nb\nc');
    expect(duplicated.selection.anchor).toBe(4);

    const deleted = deleteLines(state('a\nb\nc', 2));
    expect(deleted.text).toBe('a\nc');
    expect(deleted.selection.anchor).toBe(2);
  });

  it('selects everything and goes to a line', () => {
    expect(selectAll(state('abc', 1)).selection).toEqual({ anchor: 0, head: 3 });

    const jumped = goToLine(state('a\nb\nc', 0), 2);
    expect(jumped.selection.anchor).toBe(2);
    expect(goToLine(state('a\nb', 0), 99).selection.anchor).toBe(2);
    expect(goToLine(state('a\nb', 0), 0).selection.anchor).toBe(0);
  });
});
