/**
 * What can be edited, and what the editor writes back.
 *
 * The reader caps text at 512 KiB and detects the encoding; a file that was
 * truncated, decoded from another charset, flagged binary or is a media preview
 * cannot be round-tripped, so it stays a read-only preview with an explicit
 * reason instead of a silently lossy editor.
 */

import { EDITOR_MAX_EDIT_BYTES } from '@/lib/editorSettings';
import type { WorkspaceFileContent } from '@/lib/types';

/** Why a file cannot be edited (localized by the viewer). */
export type ReadOnlyReason =
  | 'binary'
  | 'image'
  | 'pdf'
  | 'preview-omitted'
  | 'truncated'
  | 'encoding'
  | 'too-large';

export interface SaveFormatOptions {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

/** `null` means the file can be edited in place. */
export function editableRejection(content: WorkspaceFileContent | null): ReadOnlyReason | null {
  if (!content) return 'preview-omitted';

  const mime = content.mimeType?.trim().toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (content.previewOmitted) return 'preview-omitted';
  if (content.binary) return 'binary';
  if (content.truncated) return 'truncated';

  const encoding = content.encoding?.trim();
  if (encoding && !/^utf-?8$/i.test(encoding)) return 'encoding';

  if (content.size > EDITOR_MAX_EDIT_BYTES) return 'too-large';

  return null;
}

/**
 * Applies the save-time formatting preferences to an LF buffer.
 *
 * Trailing whitespace is stripped per line (a file that is only whitespace
 * becomes empty), and the final newline is normalized to exactly one.
 */
export function prepareSaveText(text: string, options: SaveFormatOptions): string {
  let prepared = text;
  if (options.trimTrailingWhitespace) {
    prepared = prepared
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n');
  }
  if (options.insertFinalNewline) {
    if (prepared.length > 0 && !prepared.endsWith('\n')) prepared = `${prepared}\n`;
  }
  return prepared;
}
