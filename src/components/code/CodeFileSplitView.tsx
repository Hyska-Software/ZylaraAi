import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { useUiStore, type CodeFileTab } from '@/lib/store';
import { cn } from '@/lib/utils';
import { CodeFileView } from './CodeFileView';

export interface CodeFileSplitViewProps {
  /** Left pane; `null` when "Open to the side" was the first file action. */
  primary: CodeFileTab | null;
  /** Right pane, always present while the split is open. */
  secondary: CodeFileTab;
  className?: string;
}

/** Two-file editor used by the Files tab "Open to the side" action. */
export function CodeFileSplitView({ primary, secondary, className }: CodeFileSplitViewProps) {
  const { t } = useTranslation('common');
  const closeSecondary = useUiStore((state) => state.closeSecondaryCodeFile);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-row', className)}>
      {primary ? (
        <div
          id="code-file-panel"
          role="region"
          aria-label={t('shell.workspace.fileRegion', { path: primary.path })}
          className="flex min-w-0 flex-1 flex-col"
        >
          <CodeFileView target={primary} className="flex min-h-0 flex-1 flex-col" />
        </div>
      ) : null}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          primary ? 'border-l border-border' : undefined,
        )}
      >
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground-muted">
            {secondary.path}
          </span>
          <IconButton label={t('shell.workspace.closeSideFile')} size="sm" onClick={closeSecondary}>
            <X aria-hidden className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </div>
        <div
          id="code-file-side-panel"
          role="region"
          aria-label={t('shell.workspace.fileSideRegion', { path: secondary.path })}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CodeFileView target={secondary} className="flex min-h-0 flex-1 flex-col" />
        </div>
      </div>
    </div>
  );
}

export default CodeFileSplitView;
