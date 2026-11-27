/**
 * Frameless-window chrome primitives (DESIGN §5).
 *
 * The app has no dedicated title bar: every layout paints a 40px chrome row at
 * the top of its center column and `AppShell` keeps a single `ChromeCorner`
 * with the native window controls. These helpers centralize the Tauri window
 * calls, the shared maximize state and the drag-region props so a row only has
 * to spread `useWindowDragProps()`.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Class for a row that also acts as a drag region (text must not be selected). */
export const DRAG_ROW_CLASS = 'select-none';

/**
 * Interactive descendants that must never start a window drag or maximize the
 * window on double click (tabs, chips, buttons, text fields).
 */
const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[contenteditable="true"]',
].join(', ');

/** Resolves the Tauri window lazily so the renderer also boots outside Tauri. */
export function appWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function minimizeWindow(): void {
  void appWindow()
    ?.minimize()
    .catch(() => undefined);
}

export function closeWindow(): void {
  void appWindow()
    ?.close()
    .catch(() => undefined);
}

/* ------------------------------------------------------------------------- *
 * Shared maximize state: one native listener serves every subscriber.
 * ------------------------------------------------------------------------- */

let maximized = false;
let subscribed = false;
let unlisten: (() => void) | undefined;
const listeners = new Set<() => void>();

function setMaximized(value: boolean): void {
  if (maximized === value) return;
  maximized = value;
  for (const listener of listeners) listener();
}

/** Toggles the window and returns the resulting maximized state. */
export async function toggleMaximizeWindow(): Promise<boolean> {
  const win = appWindow();
  if (!win) return maximized;
  try {
    if (await win.isMaximized()) {
      await win.unmaximize();
      setMaximized(false);
      return false;
    }
    await win.maximize();
    setMaximized(true);
    return true;
  } catch {
    return maximized;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!subscribed) {
    subscribed = true;
    const win = appWindow();
    if (win) {
      void (async () => {
        try {
          setMaximized(await win.isMaximized());
          // A resize also covers the OS-level maximize/restore shortcuts.
          unlisten = await win.onResized(() => {
            void win
              .isMaximized()
              .then(setMaximized)
              .catch(() => undefined);
          });
        } catch {
          /* window API unavailable (e.g. plain browser preview) */
        }
      })();
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscribed = false;
      unlisten?.();
      unlisten = undefined;
    }
  };
}

const getMaximized = () => maximized;
const getServerMaximized = () => false;

/** `true` while the window is maximized (drives the restore icon). */
export function useWindowMaximized(): boolean {
  return useSyncExternalStore(subscribe, getMaximized, getServerMaximized);
}

/* ------------------------------------------------------------------------- *
 * Drag regions.
 * ------------------------------------------------------------------------- */

export interface WindowDragProps {
  'data-tauri-drag-region': true;
  onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** Props for a top row: drags the window and maximizes on double click. */
export function useWindowDragProps(): WindowDragProps {
  const onDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
    void toggleMaximizeWindow();
  }, []);

  return useMemo(
    () => ({ 'data-tauri-drag-region': true as const, onDoubleClick }),
    [onDoubleClick],
  );
}

/** Props for a passive spacer: moves the window without owning the double click. */
export function dragRegionProps(): { 'data-tauri-drag-region': true } {
  return { 'data-tauri-drag-region': true };
}
