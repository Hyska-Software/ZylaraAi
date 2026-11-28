import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  Ellipsis,
  FileDiff,
  FolderOpen,
  RefreshCw,
  Replace,
  RotateCcw,
  Save,
  SaveAll,
  Search,
  WrapText,
} from 'lucide-react';
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from '@/components/ui';
import { lineIndexFor, positionAt } from '@/lib/editor';
import type { EditorBuffer } from '@/lib/store';
import { languageLabel } from '@/lib/highlight';
import { isBufferDirty } from '@/lib/store/editorStore';
import { cn } from '@/lib/utils';
import { FileIcon } from './FileIcon';

export interface EditorHeaderProps {
  buffer: EditorBuffer;
  /** Prism language id of the file. */
  language: string;
  /** Persisted workbench wrap preference. */
  wrap: boolean;
  /** Any buffer of this workspace has unsaved edits (enables "Save all"). */
  hasDirtyBuffers: boolean;
  onToggleWrap: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAll: () => void;
  onReload: () => void;
  onRevert: () => void;
  onFind: (mode: 'find' | 'replace') => void;
  onGoToLine: () => void;
  onViewDiff: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  className?: string;
}

/**
 * Header of an editable file tab (WORKBENCH §7.1).
 *
 * Keeps the exact 36px bar of the read-only viewer (`PreviewHeader`) and adds
 * the editor's own affordances: dirty dot, save state, line/column, save /
 * reload / find / wrap, with the secondary commands in the overflow menu. Every
 * action is delegated to the container (`CodeFileView`), which owns the IPC.
 */
export function EditorHeader({
  buffer,
  language,
  wrap,
  hasDirtyBuffers,
  onToggleWrap,
  onSave,
  onSaveAs,
  onSaveAll,
  onReload,
  onRevert,
  onFind,
  onGoToLine,
  onViewDiff,
  onReveal,
  onCopyPath,
  className,
}: EditorHeaderProps) {
  const { t } = useTranslation('code');
  const [copied, setCopied] = useState(false);
  const dirty = isBufferDirty(buffer);
  const saving = buffer.status === 'saving';
  const position = useMemo(
    // Cached line index: the editor builds it once per text and every consumer
    // shares it, so Ln/Col costs a binary search instead of a full scan.
    () => positionAt(buffer.text, buffer.selection.head, lineIndexFor(buffer.text)),
    [buffer.selection.head, buffer.text],
  );
  const stateLabel = saving
    ? t('code:editor.header.saving')
    : dirty
      ? t('code:editor.header.unsaved')
      : t('code:editor.header.saved');

  const copyPath = () => {
    onCopyPath();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={cn('flex h-9 shrink-0 items-center gap-2 border-b border-border px-3', className)}
    >
      <FileIcon path={buffer.path} className="size-3.5" />
      <span
        className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground"
        title={buffer.path}
      >
        {buffer.path}
      </span>
      {dirty ? (
        <span
          aria-label={t('code:editor.header.dirty')}
          title={t('code:editor.header.dirty')}
          className="size-1.5 shrink-0 rounded-full bg-accent"
        />
      ) : null}
      <Badge tone="neutral" size="sm" className="shrink-0 font-mono">
        {languageLabel(language)}
      </Badge>
      <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
        {t('code:editor.header.position', {
          line: position.line + 1,
          column: position.column + 1,
        })}
      </span>
      <span
        aria-live="polite"
        className={cn(
          'shrink-0 text-[11px]',
          buffer.status === 'error'
            ? 'text-danger'
            : dirty
              ? 'text-foreground-muted'
              : 'text-success',
        )}
      >
        {buffer.status === 'error' ? t('code:editor.header.saveFailed') : stateLabel}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={t('code:editor.actions.save')} side="bottom">
          <IconButton
            label={t('code:editor.actions.save')}
            size="sm"
            disabled={saving}
            onClick={onSave}
          >
            <Save aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('code:editor.actions.reload')} side="bottom">
          <IconButton
            label={t('code:editor.actions.reload')}
            size="sm"
            disabled={saving}
            onClick={onReload}
          >
            <RefreshCw aria-hidden className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('code:editor.actions.find')} side="bottom">
          <IconButton label={t('code:editor.actions.find')} size="sm" onClick={() => onFind('find')}>
            <Search aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
        <Tooltip
          content={wrap ? t('code:preview.wrapOn') : t('code:preview.wrap')}
          side="bottom"
        >
          <IconButton
            label={t('code:preview.wrap')}
            size="sm"
            active={wrap}
            onClick={onToggleWrap}
          >
            <WrapText aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('code:editor.actions.viewDiff')} side="bottom">
          <IconButton
            label={t('code:editor.actions.viewDiff')}
            size="sm"
            onClick={onViewDiff}
          >
            <FileDiff aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('code:editor.actions.more')} size="sm">
              <Ellipsis aria-hidden className="size-4" strokeWidth={1.75} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem icon={<Save className="size-4" />} onSelect={onSaveAs}>
              {t('code:editor.actions.saveAs')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<SaveAll className="size-4" />}
              disabled={!hasDirtyBuffers}
              onSelect={onSaveAll}
            >
              {t('code:editor.actions.saveAll')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Replace className="size-4" />} onSelect={() => onFind('replace')}>
              {t('code:editor.actions.replace')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Search className="size-4" />} onSelect={onGoToLine}>
              {t('code:editor.actions.goToLine')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<RotateCcw className="size-4" />} onSelect={onRevert}>
              {t('code:editor.actions.revert')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Copy className="size-4" />} onSelect={copyPath}>
              {copied ? t('code:preview.pathCopied') : t('code:preview.copyPath')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<FolderOpen className="size-4" />} onSelect={onReveal}>
              {t('code:editor.actions.reveal')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export default EditorHeader;
