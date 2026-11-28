/**
 * Close guard for file tabs.
 *
 * Closing a tab discards the document; when the buffer has unsaved edits the
 * gesture waits for the user (Save / Discard / Cancel). The same helper drops
 * the buffer only when the file is no longer open in any pane, so a file shown
 * in the split editor keeps its live document.
 */

import { useCallback, useState } from 'react';

import { editorPreferences } from '@/lib/editorSettings';
import {
  codeFileTabKey,
  useAppStore,
  useEditorStore,
  useUiStore,
  type CodeFileTab,
} from '@/lib/store';
import { editorBufferKey, isBufferDirty } from '@/lib/store/editorStore';
import { saveEditorBuffer } from './saveBuffer';

export interface PendingFileClose {
  tab: CodeFileTab;
  /** Paths that would lose edits (only the tab's own file here). */
  paths: string[];
}

export interface FileCloseController {
  /** Closes now when clean, otherwise opens the confirmation dialog. */
  requestClose: (tab: CodeFileTab) => void;
  pending: PendingFileClose | null;
  busy: boolean;
  /** Saves the dirty buffer and closes; resolves when the gesture finishes. */
  saveAndClose: () => Promise<void>;
  discardAndClose: () => void;
  cancel: () => void;
}

function isFileOpen(tab: CodeFileTab): boolean {
  const key = codeFileTabKey(tab);
  const state = useUiStore.getState();
  if (state.codeFileTabs.some((entry) => codeFileTabKey(entry) === key)) return true;
  const secondary = state.secondaryCodeFileTab;
  return secondary !== null && codeFileTabKey(secondary) === key;
}

export function useCodeFileClose(): FileCloseController {
  const [pending, setPending] = useState<PendingFileClose | null>(null);
  const [busy, setBusy] = useState(false);

  const finalize = useCallback((tab: CodeFileTab) => {
    useUiStore.getState().closeCodeFile(tab);
    if (!isFileOpen(tab)) {
      useEditorStore.getState().drop(editorBufferKey(tab.workspaceId, tab.path));
    }
  }, []);

  const requestClose = useCallback(
    (tab: CodeFileTab) => {
      const buffer = useEditorStore.getState().buffers[editorBufferKey(tab.workspaceId, tab.path)];
      if (!buffer || !isBufferDirty(buffer)) {
        finalize(tab);
        return;
      }
      setPending({ tab, paths: [tab.path] });
    },
    [finalize],
  );

  const saveAndClose = useCallback(async () => {
    if (!pending) return;
    const preferences = editorPreferences(useAppStore.getState().settings);
    setBusy(true);
    try {
      const key = editorBufferKey(pending.tab.workspaceId, pending.tab.path);
      const buffer = useEditorStore.getState().buffers[key];
      if (buffer && isBufferDirty(buffer)) {
        const saved = await saveEditorBuffer(buffer, preferences);
        // A refused save keeps the tab open: the header explains why.
        if (!saved) return;
      }
      finalize(pending.tab);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }, [finalize, pending]);

  const discardAndClose = useCallback(() => {
    if (!pending) return;
    finalize(pending.tab);
    setPending(null);
  }, [finalize, pending]);

  const cancel = useCallback(() => {
    if (busy) return;
    setPending(null);
  }, [busy]);

  return {
    requestClose,
    pending,
    busy,
    saveAndClose,
    discardAndClose,
    cancel,
  };
}
