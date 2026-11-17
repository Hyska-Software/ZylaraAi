import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, PanelLeft, Square, X } from 'lucide-react';
import { IconButton, Kbd, Tooltip } from '@/components/ui';
import { useUiStore } from '@/lib/store';
import { cn, modKey } from '@/lib/utils';
import { BrandMark } from '@/components/chat/BrandMark';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Slot } from '@/components/plugins/ui/Slot';
import { LayoutModeSwitch } from './LayoutModeSwitch';
import { PlanUsageChip } from './PlanUsageChip';
import { UpdateChip } from './UpdateChip';

/** Resolves the Tauri window lazily so the renderer also boots outside Tauri. */
function appWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const CONTROL_BASE =
  'no-drag flex h-8 w-10 items-center justify-center rounded-md text-foreground-muted ' +
  'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/**
 * Frameless window chrome (DESIGN §5): drag region, brand, command search and
 * native window controls. The model/thinking selector lives only in the chat
 * composer (`components/composer/Composer.tsx`); the "Plano ChatGPT" indicator
 * is account-level and lives here, next to the global actions. The update pill
 * sits in the top-right corner, immediately before the window controls.
 *
 * The Chat | Code layout switch sits centered between the brand and the global
 * actions, like the reference pill (docs/goals/chat-code-layout/PLAN.md §3.1).
 * The three-column grid keeps it truly centered without letting either side
 * overlap it on narrower windows.
 */
export function TitleBar() {
  const { t } = useTranslation('common');
  const [isMaximized, setIsMaximized] = useState(false);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);

  useEffect(() => {
    const win = appWindow();
    if (!win) return;
    let alive = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const maximized = await win.isMaximized();
        if (alive) setIsMaximized(maximized);
        unlisten = await win.onResized(() => {
          void win
            .isMaximized()
            .then((value) => {
              if (alive) setIsMaximized(value);
            })
            .catch(() => undefined);
        });
      } catch {
        /* window API unavailable (e.g. plain browser preview) */
      }
    })();

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const handleMinimize = useCallback(() => {
    void appWindow()?.minimize().catch(() => undefined);
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    const win = appWindow();
    if (!win) return;
    try {
      const maximized = await win.isMaximized();
      if (maximized) {
        await win.unmaximize();
        setIsMaximized(false);
      } else {
        await win.maximize();
        setIsMaximized(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleClose = useCallback(() => {
    void appWindow()?.close().catch(() => undefined);
  }, []);

  const handleDragDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('button, a, input, [role="button"]')) return;
      void handleToggleMaximize();
    },
    [handleToggleMaximize],
  );

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={handleDragDoubleClick}
      className={cn(
        'drag-region relative z-30 grid h-14 shrink-0 select-none grid-cols-[1fr_auto_1fr]',
        'items-center gap-2 bg-surface pl-2 pr-1',
      )}
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
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
          <IconButton label={t('shell.titlebar.toggleSidebar')} size="sm" variant="ghost" onClick={toggleSidebar} className="no-drag">
            <PanelLeft className="size-4" />
          </IconButton>
        </Tooltip>

        <Slot
          name="app.titlebar.brand"
          fallback={
            <div data-tauri-drag-region className="flex min-w-0 items-center gap-2 pl-1 pr-1">
              <BrandMark size={22} />
              <span className="truncate text-[14px] font-semibold tracking-tight text-foreground">
                Zylara
              </span>
            </div>
          }
        />

        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      </div>

      <div className="no-drag justify-self-center">
        <LayoutModeSwitch />
      </div>

      <div className="no-drag flex min-w-0 items-center justify-end gap-2" data-tauri-drag-region>
        <PluginSlot slot="titlebar.actions" className="max-w-[40vw] justify-end" compact />
        <div className="hidden xl:block">
          <PlanUsageChip />
        </div>

        <UpdateChip />

        <div className="ml-1 flex items-center gap-0.5">
          <button type="button" aria-label={t('shell.titlebar.minimize')} onClick={handleMinimize} className={CONTROL_BASE}>
            <Minus className="size-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={isMaximized ? t('shell.titlebar.restore') : t('shell.titlebar.maximize')}
            onClick={() => void handleToggleMaximize()}
            className={CONTROL_BASE}
          >
            {isMaximized ? <Copy className="size-3.5" strokeWidth={2} /> : <Square className="size-3.5" strokeWidth={2} />}
          </button>
          <button
            type="button"
            aria-label={t('actions.close')}
            onClick={handleClose}
            className={cn(CONTROL_BASE, 'hover:bg-danger hover:text-background')}
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>
      </div>
    </header>
  );
}
