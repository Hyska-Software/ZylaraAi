/**
 * Shared save primitive.
 *
 * Used by the tab's I/O hook, by "Save all" and by the close/rename guards, so
 * every write goes through the same compare-and-swap and formatting rules.
 */

import { api } from '@/lib/api';
import { prepareSaveText } from '@/lib/editor';
import type { EditorPreferences } from '@/lib/editorSettings';
import { t } from '@/lib/i18n';
import { isBufferDirty, useEditorStore, type EditorBuffer } from '@/lib/store';

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function toEol(value: string | null | undefined): 'lf' | 'crlf' {
  return value === 'crlf' ? 'crlf' : 'lf';
}

/**
 * Writes a buffer to disk.
 *
 * `force` skips the compare-and-swap (Save As target, or the user explicitly
 * keeping their version after a conflict). Returns `false` when the backend
 * refused the write — the buffer keeps its edits and carries the error.
 */
export async function saveEditorBuffer(
  target: EditorBuffer,
  preferences: EditorPreferences,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const store = useEditorStore.getState();
  if (!isBufferDirty(target)) return true;

  const prepared = prepareSaveText(target.text, {
    trimTrailingWhitespace: preferences.trimTrailingWhitespace,
    insertFinalNewline: preferences.insertFinalNewline,
  });

  store.markSaving(target.key);
  try {
    const written = await api.writeWorkspaceFile(target.workspaceId, target.path, prepared, {
      expectedHash: options.force ? null : target.savedHash,
      eol: target.eol,
    });
    const latest = useEditorStore.getState();
    if (!latest.buffers[target.key]) return true;
    // The user may have kept typing while the write was in flight: only the
    // saved text becomes the new base, never the live document.
    if (latest.buffers[target.key].text === target.text) {
      latest.setText(target.key, prepared, target.selection);
    }
    latest.markSaved(target.key, {
      text: prepared,
      hash: written.hash,
      eol: toEol(written.eol),
    });
    return true;
  } catch (saveError) {
    const message = describeError(saveError, t('code:editor.errors.save'));
    const latest = useEditorStore.getState();
    if (message.includes('FS_STALE_VERSION')) latest.setConflict(target.key, true);
    latest.markSaveFailed(target.key, message);
    return false;
  }
}
