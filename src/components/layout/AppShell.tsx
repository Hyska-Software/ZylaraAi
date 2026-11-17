import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { clampSidebarWidth, SIDEBAR_WIDTH_DEFAULT, useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { TitleBar } from './TitleBar';
import { ComponentSlot } from '@/components/plugins/ui/Slot';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { useIsCompact, useReduceMotion } from './hooks';

const EASE_OUT_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Host right-dock container; a trusted plugin can replace it and still receive
 * the active panel as `children`. */
function RightPanelFallback({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export interface AppShellProps {
  children: ReactNode;
  /**
   * Sidebar surface of the active layout. Chat passes the conversation sidebar
   * (default), Code passes its sessions sidebar. The drawer variant receives
   * `onClose` so the overlay can be dismissed after navigation.
   */
  sidebar?: (context: { onClose?: () => void }) => ReactNode;
  /** Accessible name of the sidebar/drawer (DESIGN §5, PLAN §3.2). */
  sidebarLabel?: string;
  /**
   * Right side panel (sources/artifacts). It self-positions inside the content
   * row: absolutely over the chat in overlay mode or as a flex column when
   * docked. Keeping it as the row's last child lets docked mode share width
   * with the chat instead of covering it.
   */
  rightPanel?: ReactNode;
  /**
   * True when the docked right panel is actually rendered. The chat then also
   * rounds its top-right corner, mirroring the top-left corner against the
   * sidebar: the two chrome surfaces meet the conversation only through the
   * corner radius, never through a 1px divider (DESIGN §5).
   */
  rightPanelOpen?: boolean;
  /**
   * Optional slot for global overlays (dialogs, command palette) rendered by
   * `App.tsx` above the shell content.
   */
  overlays?: ReactNode;
}

/**
 * Application frame (DESIGN §5): custom title bar, sidebar (inline on desktop,
 * drawer below 1024px) and the main content column.
 *
 * The desktop sidebar is resizable: `liveWidth` keeps the drag preview local
 * (no persistence on every pointer move) while the committed value lives in
 * `useUiStore` with the rest of the persisted UI state.
 */
export function AppShell({
  children,
  sidebar,
  sidebarLabel,
  rightPanel,
  rightPanelOpen = false,
  overlays,
}: AppShellProps) {
  const { t } = useTranslation('common');
  const resolvedSidebarLabel = sidebarLabel ?? t('shell.sidebar.aria');
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const isCompact = useIsCompact();
  const reduceMotion = useReduceMotion();

  const renderSidebar = sidebar ?? ((context: { onClose?: () => void }) => <Sidebar {...context} />);

  /** Width previewed while dragging; `null` means "use the persisted width". */
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const width = clampSidebarWidth(liveWidth ?? sidebarWidth);
  const drawerWidth = clampSidebarWidth(sidebarWidth);

  /* A persisted "open" sidebar must not cover the chat on small windows. */
  useEffect(() => {
    if (isCompact) setSidebarOpen(false);
  }, [isCompact, setSidebarOpen]);

  /* Sidebar keyboard toggle (⌘/Ctrl+B) lives in App.tsx's global shortcuts. */

  /* A drag interrupted by a layout switch/sidebar collapse never receives its
     release: drop the stale preview so the persisted width takes over. */
  useEffect(() => {
    if (!sidebarOpen || isCompact) setLiveWidth(null);
  }, [sidebarOpen, isCompact]);

  /* Escape closes the compact drawer. */
  useEffect(() => {
    if (!isCompact) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useUiStore.getState().sidebarOpen) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isCompact, setSidebarOpen]);

  const handleResize = useCallback((next: number) => {
    setLiveWidth(clampSidebarWidth(next));
  }, []);

  const handleResizeEnd = useCallback(
    (next: number) => {
      // The store clamps as well; the local preview disappears in the same commit.
      setSidebarWidth(next);
      setLiveWidth(null);
    },
    [setSidebarWidth],
  );

  const handleReset = useCallback(() => {
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    setLiveWidth(null);
  }, [setSidebarWidth]);

  /* Width stays transition-free while dragging (DESIGN §11); the collapse and
     the compact drawer keep the regular 220ms ease-out-soft. */
  const sidebarTransition =
    liveWidth !== null
      ? { duration: 0, ease: EASE_OUT_SOFT }
      : { duration: reduceMotion ? 0 : 0.22, ease: EASE_OUT_SOFT };
  const transition = { duration: reduceMotion ? 0 : 0.22, ease: EASE_OUT_SOFT };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-foreground">
        <ComponentSlot name="layout.titlebar" fallback={TitleBar} />

        <div className="relative flex min-h-0 flex-1">
          {!isCompact ? (
            <motion.div
              initial={false}
              animate={{ width: sidebarOpen ? width : 0 }}
              transition={sidebarTransition}
              className="relative z-20 shrink-0 overflow-hidden"
            >
              <div className="h-full" style={{ width }} inert={!sidebarOpen}>
                {renderSidebar({})}
              </div>
            </motion.div>
          ) : null}

          {/* Absolutely positioned after the sidebar edge: no layout width and no
              overlap with the conversation list scrollbar. */}
          {!isCompact && sidebarOpen ? (
            <div className="absolute inset-y-0 z-30" style={{ left: width }}>
              <SidebarResizer
                width={width}
                onResize={handleResize}
                onResizeEnd={handleResizeEnd}
                onReset={handleReset}
              />
            </div>
          ) : null}

          {/* The chat is a rounded pane over the chrome (DESIGN §5): the topbar,
              sidebar and docked right panel share the `surface` background and
              no divider lines, so only the top corner radii separate the
              surfaces. The right radius only exists while that panel is open;
              otherwise the chat runs to the window edge. */}
          <main
            className={cn(
              'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tl-lg bg-background',
              rightPanelOpen && 'rounded-tr-lg',
            )}
          >
            {children}
          </main>

          <ComponentSlot
            name="layout.right-panel"
            fallback={RightPanelFallback}
            props={{ children: rightPanel }}
          />
        </div>

        <AnimatePresence>
          {isCompact && sidebarOpen
            ? [
                <motion.div
                  key="sidebar-backdrop"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18 }}
                  onClick={() => setSidebarOpen(false)}
                  aria-hidden
                  className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm"
                />,
                <motion.div
                  key="sidebar-drawer"
                  role="dialog"
                  aria-modal="true"
                  aria-label={resolvedSidebarLabel}
                  initial={{ x: reduceMotion ? 0 : -drawerWidth }}
                  animate={{ x: 0 }}
                  exit={{ x: reduceMotion ? 0 : -drawerWidth }}
                  transition={transition}
                  style={{ width: drawerWidth }}
                  className="fixed inset-y-0 left-0 z-50 max-w-[calc(100vw-3rem)] shadow-2xl"
                >
                  {renderSidebar({ onClose: () => setSidebarOpen(false) })}
                </motion.div>,
              ]
            : null}
        </AnimatePresence>

        {overlays}
    </div>
  );
}
