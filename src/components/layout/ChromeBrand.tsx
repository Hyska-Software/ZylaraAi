/**
 * Brand + sidebar toggle shared by the sidebar chrome rows and by the center
 * chrome row when the sidebar is collapsed or compact (DESIGN §5).
 *
 * The brand is icon-only: the app name is not repeated in the chrome.
 */
import { useTranslation } from 'react-i18next';
import { PanelLeft } from 'lucide-react';
import { IconButton, Kbd, Tooltip } from '@/components/ui';
import { BrandMark } from '@/components/chat/BrandMark';
import { Slot } from '@/components/plugins/ui/Slot';
import { useUiStore } from '@/lib/store';
import { cn, modKey } from '@/lib/utils';
import { dragRegionProps, useWindowDragProps } from './windowChrome';

export interface ChromeBrandProps {
  className?: string;
}

/**
 * App mark. Trusted plugins can replace it through `app.titlebar.brand`; the
 * fallback is the bare symbol (no wordmark).
 */
export function ChromeBrand({ className }: ChromeBrandProps) {
  const drag = useWindowDragProps();

  return (
    <div
      {...drag}
      className={cn('flex min-w-0 items-center justify-center px-1', className)}
    >
      <Slot name="app.titlebar.brand" fallback={<BrandMark size={22} />} />
    </div>
  );
}

/** `⌘/Ctrl+B` sidebar toggle; the tooltip carries the shortcut. */
export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  return (
    <Tooltip
      content={
        <span className="flex items-center gap-1.5">
          {t('shell.titlebar.toggleSidebar')}
          <Kbd>{modKey}</Kbd>
          <Kbd>B</Kbd>
        </span>
      }
      side="bottom"
    >
      <IconButton
        label={t('shell.titlebar.toggleSidebar')}
        size="sm"
        variant="ghost"
        onClick={toggleSidebar}
        className={cn('no-drag', className)}
      >
        <PanelLeft className="size-4" />
      </IconButton>
    </Tooltip>
  );
}

/** Passive filler that completes a drag region between two clusters. */
export function DragSpacer({ className }: { className?: string }) {
  return <div {...dragRegionProps()} className={cn('h-full min-w-0 flex-1', className)} />;
}
