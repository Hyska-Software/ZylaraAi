/**
 * Undo/redo for the in-app editor.
 *
 * Snapshot based: before every mutation the editor pushes the *previous*
 * document (text + selection). Snapshots are cheap because a burst of typing
 * coalesces into the state that started the burst — the same granularity users
 * expect from Ctrl+Z. Memory stays bounded by an entry limit and a character
 * budget, so a large file keeps fewer steps instead of growing without bound.
 */

import type { EditorSelection } from './text';

export interface EditorSnapshot {
  text: string;
  selection: EditorSelection;
}

export interface EditorHistory {
  /** Past states, oldest first; the last entry is what Ctrl+Z restores. */
  undo: EditorSnapshot[];
  future: EditorSnapshot[];
  /** Timestamp and kind of the last push, used to coalesce typing bursts. */
  lastPushAt: number;
  lastKind: string;
}

/** Maximum number of undo steps retained per buffer. */
export const HISTORY_LIMIT = 200;
/** Total characters kept across both stacks. */
export const HISTORY_CHAR_BUDGET = 4 * 1024 * 1024;
/** Typing pushes within this window collapse into the first one. */
export const HISTORY_COALESCE_MS = 600;

export function createHistory(): EditorHistory {
  return { undo: [], future: [], lastPushAt: 0, lastKind: '' };
}

function charCount(snapshots: EditorSnapshot[]): number {
  return snapshots.reduce((total, snapshot) => total + snapshot.text.length, 0);
}

/** Drops the oldest entries until both limits hold. */
function trim(history: EditorHistory): void {
  while (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  while (history.future.length > HISTORY_LIMIT) history.future.shift();
  while (
    history.undo.length + history.future.length > 0 &&
    charCount(history.undo) + charCount(history.future) > HISTORY_CHAR_BUDGET
  ) {
    if (history.undo.length >= history.future.length) history.undo.shift();
    else history.future.shift();
  }
}

/**
 * Registers `previous` as an undo step before applying an edit.
 *
 * `kind` is `typing` for character insertions, `delete` for backspace/delete
 * runs and anything else for discrete commands (indent, comment, paste, undo
 * target replacement…). Consecutive pushes of the same burst kind are ignored so
 * a word typed one key at a time undoes as a whole.
 */
export function pushHistory(
  history: EditorHistory,
  previous: EditorSnapshot,
  kind: string,
  now: number = Date.now(),
): EditorHistory {
  const coalesce =
    kind === 'typing' &&
    history.lastKind === 'typing' &&
    now - history.lastPushAt <= HISTORY_COALESCE_MS &&
    history.undo.length > 0;

  if (coalesce) {
    const next: EditorHistory = {
      ...history,
      future: [],
      lastPushAt: now,
      lastKind: kind,
    };
    return next;
  }

  const next: EditorHistory = {
    undo: [...history.undo, previous],
    // Any new edit invalidates the redo branch.
    future: [],
    lastPushAt: now,
    lastKind: kind,
  };
  trim(next);
  return next;
}

/** Ends the current coalescing burst (blur, file switch, explicit command). */
export function breakHistoryBurst(history: EditorHistory): EditorHistory {
  return { ...history, lastPushAt: 0, lastKind: '' };
}

export interface HistoryResult {
  history: EditorHistory;
  snapshot: EditorSnapshot;
}

/** Restores the previous state; `null` when there is nothing to undo. */
export function undoHistory(
  history: EditorHistory,
  current: EditorSnapshot,
): HistoryResult | null {
  const previous = history.undo[history.undo.length - 1];
  if (!previous) return null;
  return {
    history: {
      undo: history.undo.slice(0, -1),
      future: [...history.future, current],
      lastPushAt: 0,
      lastKind: '',
    },
    snapshot: previous,
  };
}

/** Re-applies an undone state; `null` when there is nothing to redo. */
export function redoHistory(
  history: EditorHistory,
  current: EditorSnapshot,
): HistoryResult | null {
  const next = history.future[history.future.length - 1];
  if (!next) return null;
  return {
    history: {
      undo: [...history.undo, current],
      future: history.future.slice(0, -1),
      lastPushAt: 0,
      lastKind: '',
    },
    snapshot: next,
  };
}

export function canUndo(history: EditorHistory): boolean {
  return history.undo.length > 0;
}

export function canRedo(history: EditorHistory): boolean {
  return history.future.length > 0;
}
