import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@/components/ui';

export type FileNameDialogMode = 'createFile' | 'createDir' | 'rename';

export interface FileNameDialogProps {
  open: boolean;
  mode: FileNameDialogMode;
  /** Parent path for creation, current path for rename. */
  path: string;
  initialName?: string;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

/** Shared name prompt for the Files tab create and rename actions. */
export function FileNameDialog({
  open,
  mode,
  path,
  initialName = '',
  busy = false,
  onClose,
  onSubmit,
}: FileNameDialogProps) {
  const { t } = useTranslation('code');
  const inputId = useId();
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [initialName, open, mode]);

  const titleKey =
    mode === 'createFile'
      ? 'code:tree.dialog.newFileTitle'
      : mode === 'createDir'
        ? 'code:tree.dialog.newFolderTitle'
        : 'code:tree.dialog.renameTitle';
  const invalid = name.trim().length === 0 || /[\\/]/.test(name.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid || busy) return;
    onSubmit(name.trim());
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <DialogContent size="sm">
        <form onSubmit={submit} className="flex flex-col">
          <DialogHeader>
            <DialogTitle>{t(titleKey)}</DialogTitle>
            <DialogDescription>{t('code:tree.dialog.inLabel', { path })}</DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-4 pt-2">
            <label htmlFor={inputId} className="mb-1.5 block text-[12px] font-medium text-foreground-muted">
              {t('code:tree.dialog.nameLabel')}
            </label>
            <Input
              id={inputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('code:tree.dialog.namePlaceholder')}
              aria-invalid={invalid && name.length > 0}
              autoFocus
              className="h-9"
            />
            {invalid && name.length > 0 ? (
              <p role="alert" className="mt-1.5 text-[11.5px] text-danger">
                {t('code:tree.dialog.invalidName')}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {t('code:tree.dialog.cancel')}
            </Button>
            <Button type="submit" size="sm" loading={busy} disabled={invalid}>
              {mode === 'rename'
                ? t('code:tree.dialog.renameAction')
                : t('code:tree.dialog.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default FileNameDialog;
