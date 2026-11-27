/**
 * Chrome row of the three sidebars (DESIGN §5): app icon + sidebar toggle, the
 * update pill in the right-hand slot, and the drawer close button when the
 * sidebar is rendered as a compact overlay.
 *
 * It replaces the old title bar's left cluster, so the sidebar itself starts the
 * window's top band and the layout below keeps a single 40px chrome row.
 */
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ChromeBrand, DragSpacer, SidebarToggle } from './ChromeBrand';
import { UpdateChip } from './UpdateChip';
import { DRAG_ROW_CLASS, useWindowDragProps } from './windowChrome';

export interface SidebarChromeRowProps {
  /** Present only when the sidebar is a compact drawer. */
  onClose?: () => void;
  className?: string;
}

export function SidebarChromeRow({ onClose, className }: SidebarChromeRowProps) {
  const { t } = useTranslation('common');
  const drag = useWindowDragProps();

  return (
    <div
      {...drag}
      className={cn(
        'flex h-10 shrink-0 items-center gap-1 pl-2 pr-1',
        DRAG_ROW_CLASS,
        className,
      )}
    >
      <ChromeBrand />
      {/* In the drawer the close button replaces the toggle: the drawer already
          owns the sidebar visibility. */}
      {onClose ? null : <SidebarToggle />}
      <DragSpacer />
      <UpdateChip />
      {onClose ? (
        <IconButton
          label={t('shell.sidebar.close')}
          size="sm"
          variant="ghost"
          onClick={onClose}
          className="no-drag"
        >
          <X className="size-4" />
        </IconButton>
      ) : null}
    </div>
  );
}
