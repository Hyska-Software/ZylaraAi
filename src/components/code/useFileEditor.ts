/**
 * I/O of the center file tab: read, save (compare-and-swap), save as, save all,
 * revert, reload, autosave and external-change detection.
 *
 * The document itself lives in `useEditorStore`; this hook only talks to the
 * backend and translates the results into store actions. Saves always send the
 * hash of the version the buffer was loaded from, so an edit made by the agent
 * (or another window) is never overwritten silently.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { api } from '@/lib/api';
import {
  detectEol,
  editableRejection,
  guessIndentation,
  normalizeEol,
  prepareSaveText,
  type ReadOnlyReason,
} from '@/lib/editor';
import type { EditorPreferences } from '@/lib/editorSettings';
import { t } from '@/lib/i18n';
import {
  dirtyBuffers,
  editorBufferKey,
  isBufferDirty,
  useEditorStore,
  type DiskVersion,
  type EditorBuffer,
} from '@/lib/store';
import type { WorkspaceChangedEvent, WorkspaceFileContent } from '@/lib/types';
import { saveEditorBuffer } from './saveBuffer';
import { WORKSPACE_CHANGED_EVENT } from './useWorkspaceWatch';

export interface UseFileEditorOptions {
  workspaceId: string;
  /** Workspace-relative path with `/`. */
  path: string;
  preferences: EditorPreferences;
}

export interface FileEditorApi {
  /** Last disk read (also feeds the read-only preview). */
  content: WorkspaceFileContent | null;
  /** Editor document (`null` for read-only previews). */
  buffer: EditorBuffer | null;
  loading: boolean;
  error: string | null;
  /** Why the file is read-only; `null` when it is editable. */
  readOnlyReason: ReadOnlyReason | null;
  dirty: boolean;
  save: () => Promise<boolean>;
  /** Writes the buffer to a new path and retargets it; returns the new path. */
  saveAs: (nextPath: string) => Promise<string | null>;
  /** Saves every dirty buffer of the workspace. */
  saveAll: () => Promise<number>;
  /** Re-reads the file from disk, discarding local edits. */
  reload: () => Promise<void>;
  /** Discards unsaved edits back to the last saved version (no disk read). */
  revert: () => void;
  /** Overwrites the file on disk even though it changed underneath ("keep mine"). */
  keepMine: () => Promise<boolean>;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function diskVersion(content: WorkspaceFileContent): DiskVersion {
  return {
    text: normalizeEol(content.text),
    hash: content.hash ?? null,
    eol: content.eol ?? detectEol(content.text),
  };
}

function toEol(value: string | null | undefined): 'lf' | 'crlf' {
  return value === 'crlf' ? 'crlf' : 'lf';
}

export function useFileEditor({
  workspaceId,
  path,
  preferences,
}: UseFileEditorOptions): FileEditorApi {
  const key = editorBufferKey(workspaceId, path);
  const buffer = useEditorStore((state) => state.buffers[key] ?? null);
  const [content, setContent] = useState<WorkspaceFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Invalidates in-flight reads when the tab changes or unmounts. */
  const requestRef = useRef(0);
  /** Preferences are read lazily by callbacks (never stale, never a dependency). */
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  const load = useCallback(
    async (options: { force?: boolean } = {}) => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setLoading(true);
      setError(null);
      try {
        const next = await api.readWorkspaceFile(workspaceId, path);
        if (requestRef.current !== requestId) return;
        setContent(next);
        if (editableRejection(next) !== null) return;

        const version = diskVersion(next);
        const store = useEditorStore.getState();
        const current = store.buffers[key];
        if (!current) {
          const prefs = preferencesRef.current;
          const indentation = prefs.detectIndentation
            ? guessIndentation(version.text, {
                tabSize: prefs.tabSize,
                insertSpaces: prefs.insertSpaces,
              })
            : { tabSize: prefs.tabSize, insertSpaces: prefs.insertSpaces };
          store.ensureBuffer({ workspaceId, path, ...version, indentation });
          return;
        }
        if (options.force) {
          store.reloadFromDisk(key, version);
          return;
        }
        // Remount of an open tab: adopt the disk version only when the buffer
        // has no local edits; otherwise let the user resolve the conflict.
        if (version.hash === current.savedHash) return;
        if (isBufferDirty(current)) store.setConflict(key, true);
        else store.reloadFromDisk(key, version);
      } catch (loadError) {
        if (requestRef.current !== requestId) return;
        setContent(null);
        setError(describeError(loadError, t('code:editor.errors.load')));
      } finally {
        if (requestRef.current === requestId) setLoading(false);
      }
    },
    [key, path, workspaceId],
  );

  useEffect(() => {
    setContent(null);
    setError(null);
    setLoading(true);
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const saveBuffer = useCallback(
    async (target: EditorBuffer, options: { force?: boolean } = {}): Promise<boolean> =>
      options.force
        ? saveEditorBuffer(target, preferencesRef.current, { force: true })
        : saveEditorBuffer(target, preferencesRef.current),
    [],
  );

  const save = useCallback(async () => {
    const current = useEditorStore.getState().buffers[key];
    if (!current) return false;
    return saveBuffer(current);
  }, [key, saveBuffer]);

  const saveAs = useCallback(
    async (nextPath: string): Promise<string | null> => {
      const current = useEditorStore.getState().buffers[key];
      if (!current) return null;
      // Save As never replaces an existing file silently: the name dialog is
      // the only confirmation step, so an existing target is reported here.
      try {
        await api.readWorkspaceFile(workspaceId, nextPath);
        useEditorStore
          .getState()
          .markSaveFailed(key, t('code:editor.saveAs.exists', { path: nextPath }));
        return null;
      } catch {
        // Missing file: the write below creates it.
      }
      const prefs = preferencesRef.current;
      const prepared = prepareSaveText(current.text, {
        trimTrailingWhitespace: prefs.trimTrailingWhitespace,
        insertFinalNewline: prefs.insertFinalNewline,
      });
      try {
        const written = await api.writeWorkspaceFile(workspaceId, nextPath, prepared, {
          expectedHash: null,
          eol: current.eol,
        });
        const store = useEditorStore.getState();
        const nextKey = editorBufferKey(workspaceId, written.path);
        store.retarget(key, {
          workspaceId,
          path: written.path,
          hash: written.hash,
          eol: toEol(written.eol),
        });
        store.markSaved(nextKey, {
          text: prepared,
          hash: written.hash,
          eol: toEol(written.eol),
        });
        return written.path;
      } catch (saveError) {
        useEditorStore
          .getState()
          .markSaveFailed(key, describeError(saveError, t('code:editor.errors.saveAs')));
        return null;
      }
    },
    [key, workspaceId],
  );

  const saveAll = useCallback(async (): Promise<number> => {
    const targets = dirtyBuffers(useEditorStore.getState().buffers, workspaceId);
    let saved = 0;
    for (const target of targets) {
      // Sequential on purpose: parallel writes to the same folder serialize on
      // the backend lock anyway, and the UI shows one status at a time.
      if (await saveBuffer(target)) saved += 1;
    }
    return saved;
  }, [saveBuffer, workspaceId]);

  const reload = useCallback(async () => {
    await load({ force: true });
  }, [load]);

  const revert = useCallback(() => {
    const current = useEditorStore.getState().buffers[key];
    if (!current) return;
    useEditorStore.getState().reloadFromDisk(key, {
      text: current.savedText,
      hash: current.savedHash,
      eol: current.eol,
    });
  }, [key]);

  const keepMine = useCallback(async () => {
    const current = useEditorStore.getState().buffers[key];
    if (!current) return false;
    return saveBuffer(current, { force: true });
  }, [key, saveBuffer]);

  const dirty = buffer !== null && isBufferDirty(buffer);

  /* Autosave: idle delay or when the window loses focus. */
  useEffect(() => {
    if (!dirty || !buffer) return;
    if (preferences.autoSave === 'delay') {
      const timer = setTimeout(() => {
        void save();
      }, preferences.autoSaveDelay);
      return () => clearTimeout(timer);
    }
    if (preferences.autoSave === 'blur') {
      const flush = () => {
        if (document.hasFocus() && document.visibilityState === 'visible') return;
        void save();
      };
      window.addEventListener('blur', flush);
      document.addEventListener('visibilitychange', flush);
      return () => {
        window.removeEventListener('blur', flush);
        document.removeEventListener('visibilitychange', flush);
      };
    }
    return undefined;
  }, [buffer, dirty, preferences.autoSave, preferences.autoSaveDelay, save]);

  /* External changes: compare the disk hash with the buffer's base version. */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      const current = useEditorStore.getState().buffers[key];
      if (!current) return;
      try {
        const next = await api.readWorkspaceFile(workspaceId, path);
        if (disposed || editableRejection(next) !== null) return;
        const version = diskVersion(next);
        const latest = useEditorStore.getState().buffers[key];
        // Our own save: the event arrives after the hash was adopted.
        if (!latest || version.hash === latest.savedHash) return;
        if (isBufferDirty(latest)) useEditorStore.getState().setConflict(key, true);
        else useEditorStore.getState().reloadFromDisk(key, version);
      } catch {
        // Deleted or moved: the next save reports it; nothing to adopt here.
      }
    };

    void listen<WorkspaceChangedEvent>(WORKSPACE_CHANGED_EVENT, ({ payload }) => {
      if (payload?.workspaceId !== workspaceId) return;
      const prefix = `${path}/`;
      const touched =
        payload.overflow ||
        payload.paths.some(
          (changed) =>
            changed === path || changed.startsWith(prefix) || path.startsWith(`${changed}/`),
        );
      if (!touched) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), 250);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [key, path, workspaceId]);

  /* Never lose a dirty buffer to a window close without a browser prompt. */
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyBuffers(useEditorStore.getState().buffers).length === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return {
    content,
    buffer,
    loading,
    error,
    readOnlyReason: content ? editableRejection(content) : null,
    dirty,
    save,
    saveAs,
    saveAll,
    reload,
    revert,
    keepMine,
  };
}
