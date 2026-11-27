/**
 * 40px chrome row shared by the three layouts (DESIGN §5).
 *
 * It replaces the old 56px title bar: the row is the layout's own header, so it
 * carries the layout identity on the left and the app chrome (global actions +
 * the reserved window-controls corner) on the right. The brand and the sidebar
 * toggle appear here only when the sidebar itself is not visible (collapsed or
 * compact drawer), so the app icon is never lost and never duplicated.
 */
import type { ReactNode } from 'react';
import { useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ChromeBrand, DragSpacer, SidebarToggle } from './ChromeBrand';
import { GlobalActions } from './ChromeActions';
import { useChromeCornerReserve } from './ChromeCorner';
import { useIsCompact } from './hooks';
import { DRAG_ROW_CLASS, useWindowDragProps } from './windowChrome';

export interface LayoutTopRowProps {
  /** Layout identity: title, tabs context, chips. */
  leading?: ReactNode;
  /** Layout-specific controls, placed before the global chrome cluster. */
  children?: ReactNode;
  /** Overrides the automatic "sidebar is hidden" detection. */
  showBrand?: boolean;
  /** Which surface owns the window-controls corner (see `useChromeCornerReserve`). */
  reserveRole?: 'center' | 'dock';
  className?: string;
}

export function LayoutTopRow({
  leading,
  children,
  showBrand,
  reserveRole = 'center',
  className,
}: LayoutTopRowProps) {
  const isCompact = useIsCompact();
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const showSidebarChrome = showBrand ?? (isCompact || !sidebarOpen);
  const reserve = useChromeCornerReserve(reserveRole);
  const drag = useWindowDragProps();

  return (
    <div
      {...drag}
      className={cn(
        'relative flex h-10 shrink-0 items-center gap-2 px-2',
        DRAG_ROW_CLASS,
        className,
      )}
    >
      {showSidebarChrome ? (
        <>
          <ChromeBrand />
          <SidebarToggle />
        </>
      ) : null}

      {leading}
      <DragSpacer />
      {children}
      <GlobalActions />
      <span aria-hidden className={cn('shrink-0', reserve)} />
    </div>
  );
}
