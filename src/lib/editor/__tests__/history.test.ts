import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  createHistory,
  HISTORY_LIMIT,
  pushHistory,
  redoHistory,
  undoHistory,
  type EditorSnapshot,
} from '../history';

function snapshot(text: string, caret = text.length): EditorSnapshot {
  return { text, selection: { anchor: caret, head: caret } };
}

describe('editor history', () => {
  it('undoes and redoes snapshots', () => {
    let history = createHistory();
    expect(canUndo(history)).toBe(false);

    history = pushHistory(history, snapshot('a'), 'typing', 0);
    expect(canUndo(history)).toBe(true);

    const undone = undoHistory(history, snapshot('ab'));
    expect(undone?.snapshot.text).toBe('a');
    expect(canRedo(undone!.history)).toBe(true);

    const redone = redoHistory(undone!.history, snapshot('a'));
    expect(redone?.snapshot.text).toBe('ab');
  });

  it('coalesces typing bursts but not discrete commands', () => {
    let history = createHistory();
    history = pushHistory(history, snapshot(''), 'typing', 1_000);
    history = pushHistory(history, snapshot('a'), 'typing', 1_200);
    expect(history.undo).toHaveLength(1);

    // A different kind always pushes.
    history = pushHistory(history, snapshot('ab'), 'command', 1_300);
    expect(history.undo).toHaveLength(2);

    // A typing burst after the coalescing window pushes too.
    history = pushHistory(history, snapshot('abc'), 'typing', 5_000);
    expect(history.undo).toHaveLength(3);
  });

  it('a new edit drops the redo branch', () => {
    let history = createHistory();
    history = pushHistory(history, snapshot('a'), 'typing', 0);
    const undone = undoHistory(history, snapshot('ab'))!;
    expect(canRedo(undone.history)).toBe(true);

    const edited = pushHistory(undone.history, snapshot('a'), 'typing', 10_000);
    expect(canRedo(edited)).toBe(false);
    expect(redoHistory(edited, snapshot('x'))).toBeNull();
  });

  it('keeps the stack bounded', () => {
    let history = createHistory();
    for (let index = 0; index < HISTORY_LIMIT + 25; index += 1) {
      history = pushHistory(history, snapshot(`line ${index}`), 'command', index * 10_000);
    }
    expect(history.undo).toHaveLength(HISTORY_LIMIT);
    expect(history.undo[history.undo.length - 1].text).toBe(`line ${HISTORY_LIMIT + 24}`);
    expect(history.undo[0].text).toBe(`line ${25}`);
  });

  it('returns null when there is nothing to undo or redo', () => {
    const history = createHistory();
    expect(undoHistory(history, snapshot('a'))).toBeNull();
    expect(redoHistory(history, snapshot('a'))).toBeNull();
  });
});
