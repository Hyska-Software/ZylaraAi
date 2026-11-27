import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy,
  CopyPlus,
  Download,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Link2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from '@/components/ui';
import type { WorkspaceFileEntry } from '@/lib/types';

/** Actions exposed by the Files tab menu, in the same order as the design. */
export type FileAction =
  | 'newFile'
  | 'newFolder'
  | 'openToSide'
  | 'copyPath'
  | 'copyRelativePath'
  | 'reveal'
  | 'download'
  | 'rename'
  | 'duplicate'
  | 'delete';

interface ActionItem {
  action: FileAction;
  label: string;
  icon: ReactNode;
  danger?: boolean;
}

function icon(Icon: typeof Copy): ReactNode {
  return <Icon aria-hidden className="size-4" strokeWidth={1.75} />;
}

/**
 * Action groups of the Files tab. `entry === null` means the panel header
 * (root), where only creation makes sense. Files and directories intentionally
 * expose different subsets of the same menu.
 */
export function fileActionGroups(
  entry: WorkspaceFileEntry | null,
  t: (key: string) => string,
): ActionItem[][] {
  const creation: ActionItem[] = !entry || entry.isDir
    ? [
        { action: 'newFile', label: t('code:tree.menu.newFile'), icon: icon(FilePlus2) },
        { action: 'newFolder', label: t('code:tree.menu.newFolder'), icon: icon(FolderPlus) },
      ]
    : [];
  const open: ActionItem[] = entry && !entry.isDir
    ? [{ action: 'openToSide', label: t('code:tree.menu.openToSide'), icon: icon(PanelRight) }]
    : [];
  const clipboard: ActionItem[] = entry
    ? [
        { action: 'copyPath', label: t('code:tree.menu.copyPath'), icon: icon(Copy) },
        {
          action: 'copyRelativePath',
          label: t('code:tree.menu.copyRelativePath'),
          icon: icon(Link2),
        },
        { action: 'reveal', label: t('code:tree.menu.reveal'), icon: icon(FolderOpen) },
      ]
    : [];
  if (entry && !entry.isDir) {
    clipboard.push({ action: 'download', label: t('code:tree.menu.download'), icon: icon(Download) });
  }
  const manage: ActionItem[] = entry
    ? [
        { action: 'rename', label: t('code:tree.menu.rename'), icon: icon(Pencil) },
        { action: 'duplicate', label: t('code:tree.menu.duplicate'), icon: icon(CopyPlus) },
      ]
    : [];
  const danger: ActionItem[] = entry
    ? [{ action: 'delete', label: t('code:tree.menu.delete'), icon: icon(Trash2), danger: true }]
    : [];
  return [creation, open, clipboard, manage, danger].filter((group) => group.length > 0);
}

export interface FileActionItemsProps {
  entry: WorkspaceFileEntry | null;
  onSelect: (action: FileAction) => void;
}

/** Shared item list used by the header dropdown and by the row context menu. */
export function FileActionItems({ entry, onSelect }: FileActionItemsProps) {
  const { t } = useTranslation('code');
  const groups = fileActionGroups(entry, t);
  return (
    <>
      {groups.map((group, groupIndex) => (
        <div key={groupIndex}>
          {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
          {group.map((item) => (
            <DropdownMenuItem
              key={item.action}
              icon={item.icon}
              variant={item.danger ? 'danger' : 'default'}
              onSelect={() => onSelect(item.action)}
            >
              {item.label}
            </DropdownMenuItem>
          ))}
        </div>
      ))}
    </>
  );
}

export interface FileActionsMenuButtonProps {
  onSelect: (action: FileAction) => void;
}

/** Ellipsis button in the Files panel toolbar (creation actions at the root). */
export function FileActionsMenuButton({ onSelect }: FileActionsMenuButtonProps) {
  const { t } = useTranslation('code');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('code:tree.menu.aria')} size="sm">
          <MoreHorizontal aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <FileActionItems entry={null} onSelect={onSelect} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
