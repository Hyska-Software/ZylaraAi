/**
 * Single owner of the custom window controls (DESIGN §5).
 *
 * With the title bar gone, the minimize/maximize/close cluster is anchored at
 * the window's top-right corner by `AppShell` and floats above whichever
 * surface occupies that corner (center chrome row, right dock strip or an
 * overlay side panel). Surfaces that can sit underneath reserve the same
 * footprint through `useChromeCornerReserve()` so no control is ever covered.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Minus, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  closeWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  useWindowMaximized,
  useWindowDragProps,
} from './windowChrome';

/**
 * Footprint the corner occupies: three 40px targets (`w-10`) + two 2px gaps +
 * 4px right padding = 128px, inside a 40px row (`h-10`).
 */
export const CHROME_CORNER_RESERVE = 'pr-[128px]';

const CONTROL_BASE =
  'no-drag flex h-8 w-10 items-center justify-center rounded-md text-foreground-muted ' +
  'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/** Minimize / maximize-restore / close, identical to the old title bar. */
export function WindowControls() {
  const { t } = useTranslation('common');
  const isMaximized = useWindowMaximized();

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label={t('shell.titlebar.minimize')}
        onClick={minimizeWindow}
        className={CONTROL_BASE}
      >
        <Minus className="size-4" strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? t('shell.titlebar.restore') : t('shell.titlebar.maximize')}
        onClick={() => void toggleMaximizeWindow()}
        className={CONTROL_BASE}
      >
        {isMaximized ? <Copy className="size-3.5" strokeWidth={2} /> : <Square className="size-3.5" strokeWidth={2} />}
      </button>
      <button
        type="button"
        aria-label={t('actions.close')}
        onClick={closeWindow}
        className={cn(CONTROL_BASE, 'hover:bg-danger hover:text-background')}
      >
        <X className="size-4" strokeWidth={2} />
      </button>
    </div>
  );
}

/** True while a right dock shares the row with the center column. */
const DockContext = createContext(false);

export function ChromeCornerProvider({
  /** A docked right panel currently owns the window's top-right corner. */
  docked,
  children,
}: {
  docked: boolean;
  children: ReactNode;
}) {
  return <DockContext.Provider value={docked}>{children}</DockContext.Provider>;
}

/**
 * Right padding a top surface needs so the corner never covers its controls.
 *
 * - `center`: the layout's own chrome row — it owns the corner unless a dock is
 *   docked, in which case the dock strip is the rightmost surface.
 * - `dock`: a dock/side panel header, which is always the rightmost surface.
 */
export function useChromeCornerReserve(role: 'center' | 'dock'): string {
  const docked = useContext(DockContext);
  if (role === 'dock') return CHROME_CORNER_RESERVE;
  return docked ? '' : CHROME_CORNER_RESERVE;
}

/**
 * The controls themselves, absolutely anchored to the window's top-right.
 * `z-50` keeps them clickable above overlay side panels, while dialogs (rendered
 * in portals after the shell) still cover them.
 */
export function ChromeCorner() {
  const drag = useWindowDragProps();

  return (
    <div
      data-chrome-corner
      {...drag}
      className="no-drag absolute right-0 top-0 z-50 flex h-10 items-center gap-0.5 pr-1"
    >
      <WindowControls />
    </div>
  );
}
