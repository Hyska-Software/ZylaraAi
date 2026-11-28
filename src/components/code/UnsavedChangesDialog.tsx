import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';

export interface UnsavedChangesDialogProps {
  open: boolean;
  /** Files whose buffer has unsaved edits. */
  paths: string[];
  busy?: boolean;
  /** Saves the affected buffers and continues the gesture. */
  onSave: () => void;
  /** Throws the edits away and continues. */
  onDiscard: () => void;
  /** Aborts the gesture. */
  onCancel: () => void;
}

/**
 * Guard for gestures that would drop unsaved edits (closing a file tab).
 *
 * A single file is named directly; a batch falls back to a count. Nothing is
 * discarded until the user picks an option, and `Esc`/outside click cancels.
 */
export function UnsavedChangesDialog({
  open,
  paths,
  busy = false,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const { t } = useTranslation('code');
  const single = paths.length === 1 ? paths[0] : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('code:editor.close.title')}</DialogTitle>
          <DialogDescription>
            {single
              ? t('code:editor.close.description', { path: single })
              : t('code:editor.close.descriptionMany', { files: paths.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2 px-6 pb-2 pt-1 text-[11.5px] text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{t('code:editor.close.warning')}</span>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t('code:editor.close.cancel')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onDiscard}>
            {t('code:editor.close.discard')}
          </Button>
          <Button size="sm" loading={busy} onClick={onSave}>
            {t('code:editor.close.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default UnsavedChangesDialog;
