/**
 * Per-tab editor buffers.
 *
 * A file tab is unmounted when the user switches tabs, so the document (text,
 * selection, undo history and save state) cannot live in component state — it
 * would be lost on every tab switch. This store keeps one buffer per
 * `workspace + path`, shared by both halves of the split editor and by the Code
 * and Agents layouts.
 *
 * The store is intentionally I/O free: `useFileEditor` performs the IPC and
 * calls these actions with the results.
 */

import { create } from 'zustand';

import { createHistory, type EditorHistory, type EditorSelection, type Eol } from '@/lib/editor';

export interface BufferIndentation {
  tabSize: number;
  insertSpaces: boolean;
}

export interface EditorBuffer {
  key: string;
  workspaceId: string;
  path: string;
  /** Current text, always LF-normalized. */
  text: string;
  /** Text as last read or saved, always LF-normalized. */
  savedText: string;
  /** Line ending of the file on disk; the backend applies it on save. */
  eol: Eol;
  /** sha256 of the bytes the buffer is based on (`null` = new/untracked file). */
  savedHash: string | null;
  selection: EditorSelection;
  scrollTop: number;
  history: EditorHistory;
  status: 'idle' | 'saving' | 'error';
  /** Error from the last save attempt (localized message from the backend). */
  error: string | null;
  /** The file changed on disk while the buffer has local edits. */
  conflict: boolean;
  lastSavedAt: number | null;
  /** Indentation resolved for this file (detected or from settings). */
  indentation: BufferIndentation;
  /** Last time the buffer was shown, used by the eviction policy. */
  touchedAt: number;
}

export interface EditorBufferInit {
  workspaceId: string;
  path: string;
  text: string;
  eol: Eol;
  hash: string | null;
  indentation: BufferIndentation;
}

export interface DiskVersion {
  text: string;
  hash: string | null;
  eol: Eol;
}

export interface EditorStoreState {
  buffers: Record<string, EditorBuffer>;
  /** Returns the existing buffer for the tab or creates it from the disk read. */
  ensureBuffer: (init: EditorBufferInit) => EditorBuffer;
  setText: (key: string, text: string, selection?: EditorSelection) => void;
  setSelection: (key: string, selection: EditorSelection) => void;
  setScrollTop: (key: string, scrollTop: number) => void;
  setHistory: (key: string, history: EditorHistory) => void;
  markSaving: (key: string) => void;
  /** Adopts the written text as the new saved version. */
  markSaved: (key: string, version: DiskVersion, savedAt?: number) => void;
  markSaveFailed: (key: string, error: string) => void;
  setConflict: (key: string, conflict: boolean) => void;
  /** Replaces the buffer with the version on disk (reload / discard). */
  reloadFromDisk: (key: string, version: DiskVersion) => void;
  /** Save As: the buffer moves to a new path, keeping text and history. */
  retarget: (oldKey: string, next: { workspaceId: string; path: string; hash: string | null; eol: Eol }) => void;
  touch: (key: string) => void;
  drop: (key: string) => void;
  /** Drops the buffers of a file and everything under it (delete/rename). */
  dropUnder: (workspaceId: string, path: string) => void;
  reset: () => void;
}

/** Stable buffer key (workspace + path), mirroring `codeFileTabKey`. */
export function editorBufferKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`;
}

export function isBufferDirty(buffer: EditorBuffer | null | undefined): boolean {
  return buffer !== null && buffer !== undefined && buffer.text !== buffer.savedText;
}

/** Upper bounds so long sessions cannot grow memory without limit. */
export const MAX_EDITOR_BUFFERS = 30;
export const MAX_EDITOR_BUFFER_CHARS = 12 * 1024 * 1024;

function createBuffer(init: EditorBufferInit, now: number): EditorBuffer {
  return {
    key: editorBufferKey(init.workspaceId, init.path),
    workspaceId: init.workspaceId,
    path: init.path,
    text: init.text,
    savedText: init.text,
    eol: init.eol,
    savedHash: init.hash,
    selection: { anchor: 0, head: 0 },
    scrollTop: 0,
    history: createHistory(),
    status: 'idle',
    error: null,
    conflict: false,
    lastSavedAt: null,
    indentation: init.indentation,
    touchedAt: now,
  };
}

/**
 * Evicts clean buffers (never the one being opened) until both the count and
 * the character budget hold. Dirty buffers are kept: losing unsaved edits is
 * never acceptable, so a session with many dirty files simply keeps them.
 */
function evict(buffers: Record<string, EditorBuffer>, keepKey: string): Record<string, EditorBuffer> {
  const entries = Object.entries(buffers).sort((left, right) => left[1].touchedAt - right[1].touchedAt);
  let total = Object.values(buffers).reduce((sum, buffer) => sum + buffer.text.length, 0);
  let count = Object.keys(buffers).length;

  for (const [key, buffer] of entries) {
    if (count <= MAX_EDITOR_BUFFERS && total <= MAX_EDITOR_BUFFER_CHARS) break;
    if (key === keepKey || isBufferDirty(buffer)) continue;
    total -= buffer.text.length;
    count -= 1;
    delete buffers[key];
  }
  return buffers;
}

/** Buffers that would lose work if the tab closed right now. */
export function dirtyBuffers(
  buffers: Record<string, EditorBuffer>,
  workspaceId?: string,
): EditorBuffer[] {
  return Object.values(buffers).filter(
    (buffer) => isBufferDirty(buffer) && (workspaceId === undefined || buffer.workspaceId === workspaceId),
  );
}

export const useEditorStore = create<EditorStoreState>()((set, get) => ({
  buffers: {},

  ensureBuffer: (init) => {
    const key = editorBufferKey(init.workspaceId, init.path);
    const existing = get().buffers[key];
    const now = Date.now();
    if (existing) {
      // Keep the live document: a re-read must not discard unsaved edits.
      const touched = { ...existing, touchedAt: now };
      set((state) => ({ buffers: { ...state.buffers, [key]: touched } }));
      return touched;
    }
    const buffer = createBuffer(init, now);
    set((state) => {
      const buffers = evict({ ...state.buffers, [key]: buffer }, key);
      return { buffers };
    });
    return buffer;
  },

  setText: (key, text, selection) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return {
        buffers: {
          ...state.buffers,
          [key]: {
            ...buffer,
            text,
            selection: selection ?? buffer.selection,
            touchedAt: Date.now(),
          },
        },
      };
    }),

  setSelection: (key, selection) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      if (buffer.selection.anchor === selection.anchor && buffer.selection.head === selection.head) {
        return state;
      }
      return { buffers: { ...state.buffers, [key]: { ...buffer, selection } } };
    }),

  setScrollTop: (key, scrollTop) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer || buffer.scrollTop === scrollTop) return state;
      return { buffers: { ...state.buffers, [key]: { ...buffer, scrollTop } } };
    }),

  setHistory: (key, history) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return { buffers: { ...state.buffers, [key]: { ...buffer, history } } };
    }),

  markSaving: (key) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return { buffers: { ...state.buffers, [key]: { ...buffer, status: 'saving', error: null } } };
    }),

  markSaved: (key, version, savedAt = Date.now()) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return {
        buffers: {
          ...state.buffers,
          [key]: {
            ...buffer,
            // The buffer may have changed while the save was in flight; only
            // adopt the written text when it is still the latest one.
            text: buffer.text,
            savedText: version.text,
            savedHash: version.hash,
            eol: version.eol,
            status: 'idle',
            error: null,
            conflict: false,
            lastSavedAt: savedAt,
          },
        },
      };
    }),

  markSaveFailed: (key, error) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return { buffers: { ...state.buffers, [key]: { ...buffer, status: 'error', error } } };
    }),

  setConflict: (key, conflict) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer || buffer.conflict === conflict) return state;
      return { buffers: { ...state.buffers, [key]: { ...buffer, conflict } } };
    }),

  reloadFromDisk: (key, version) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return {
        buffers: {
          ...state.buffers,
          [key]: {
            ...buffer,
            text: version.text,
            savedText: version.text,
            savedHash: version.hash,
            eol: version.eol,
            status: 'idle',
            error: null,
            conflict: false,
            history: createHistory(),
            selection: { anchor: 0, head: 0 },
          },
        },
      };
    }),

  retarget: (oldKey, next) =>
    set((state) => {
      const buffer = state.buffers[oldKey];
      if (!buffer) return state;
      const key = editorBufferKey(next.workspaceId, next.path);
      const buffers = { ...state.buffers };
      delete buffers[oldKey];
      buffers[key] = {
        ...buffer,
        key,
        workspaceId: next.workspaceId,
        path: next.path,
        savedHash: next.hash,
        eol: next.eol,
      };
      return { buffers };
    }),

  touch: (key) =>
    set((state) => {
      const buffer = state.buffers[key];
      if (!buffer) return state;
      return { buffers: { ...state.buffers, [key]: { ...buffer, touchedAt: Date.now() } } };
    }),

  drop: (key) =>
    set((state) => {
      if (!state.buffers[key]) return state;
      const buffers = { ...state.buffers };
      delete buffers[key];
      return { buffers };
    }),

  dropUnder: (workspaceId, path) =>
    set((state) => {
      const prefix = `${path}/`;
      let changed = false;
      const buffers: Record<string, EditorBuffer> = {};
      for (const [key, buffer] of Object.entries(state.buffers)) {
        const affected =
          buffer.workspaceId === workspaceId &&
          (buffer.path === path || buffer.path.startsWith(prefix));
        if (affected) changed = true;
        else buffers[key] = buffer;
      }
      return changed ? { buffers } : state;
    }),

  reset: () => set({ buffers: {} }),
}));
