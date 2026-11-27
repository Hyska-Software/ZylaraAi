/**
 * Right dock shell for a plugin panel owned by a layout without its own strip.
 *
 * CodePanel and AgentPanel already integrate plugin panels into their tab
 * strips; the chat dock and the takeover panels need the shell itself: the
 * persisted side-panel width, the resize handle and the same `surface` chrome
 * the artifact panel uses. Without it a plugin panel rendered straight into the
 * right-panel slot has no width and squeezes the conversation.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Files, X } from 'lucide-react';

import { SIDE_PANEL_WIDTH_MIN, SIDE_PANEL_WIDTH_STEP, useUiStore, type LayoutMode } from '@/lib/store';
import { useSidePanelResize } from '@/lib/sidePanel';
import { pluginLabel } from '@/lib/plugins/registry';
import { dockTabsForLayout } from '@/lib/plugins/ui/dock';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { cn } from '@/lib/utils';
import { IconButton, Tooltip } from '@/components/ui';
import { PanelResizer } from '@/components/layout/PanelResizer';
import { useChromeCornerReserve } from '@/components/layout/ChromeCorner';
import { PluginPageHeader } from '../PluginHosts';
import { PluginDockTabHost } from './PluginDockTabHost';
import { PluginDockTabStrip } from './PluginDockTabStrip';

export interface PluginDockPanelProps {
  layout: LayoutMode;
  /** Dock tab to render; resolved again here so a stale key never renders. */
  tabKey: string;
  /** The panel replaces the host dock (`contributes.ui.panels[].tab === false`). */
  takeover?: boolean;
  className?: string;
}

export function PluginDockPanel({ layout, tabKey, takeover = false, className }: PluginDockPanelProps) {
  const { t } = useTranslation('plugins');
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const { layout: dock, onResize, onResizeEnd, onReset } = useSidePanelResize();
  // Rightmost surface: the dock header clears the window-controls corner.
  const chromeReserve = useChromeCornerReserve('dock');
  const tab = ui.panelTabs.find((entry) => entry.key === tabKey);
  const tabs = useMemo(
    () => dockTabsForLayout(ui.panelTabs, layout, prefs.disabled),
    [prefs.disabled, ui.panelTabs, layout],
  );
  // Only the chat dock has a host surface a tab can return to (`Artifacts`);
  // elsewhere the panel keeps the page header with the "back" affordance.
  const hostTab = !takeover && layout === 'chat' && tabs.length > 0;
  const close = () => {
    const state = useUiStore.getState();
    state.closePluginDockTab(layout);
    if (takeover) state.dismissPluginDockTakeover(layout);
  };

  if (!tab || !prefs.enabled || prefs.disabled.includes(tab.key)) return null;
  const title = pluginLabel(tab.plugin, tab.titleKey, tab.title);

  return (
    <aside
      aria-label={title}
      style={{ width: dock.width }}
      className={cn(
        dock.docked
          ? 'relative z-10 flex h-full shrink-0 flex-col border-l border-border bg-surface-raised outline-none'
          : 'absolute inset-y-0 right-0 z-40 flex max-w-[92vw] flex-col border-l border-border bg-surface-raised shadow-2xl outline-none',
        className,
      )}
      data-plugin-dock={tab.key}
    >
      {hostTab ? (
        <div
          className={cn(
            'flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2',
            chromeReserve,
          )}
        >
          <div
            role="tablist"
            aria-label={t('host.dockTabs')}
            className="flex min-w-0 flex-1 items-center gap-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={false}
              aria-label={t('artifacts:panel.title')}
              title={t('artifacts:panel.title')}
              onClick={close}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
                'text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              )}
            >
              <Files aria-hidden className="size-3.5" strokeWidth={1.75} />
              {t('artifacts:panel.title')}
            </button>
            <PluginDockTabStrip layout={layout} />
          </div>
          <Tooltip content={t('host.close')} side="bottom">
            <IconButton label={t('host.close')} size="sm" onClick={close}>
              <X aria-hidden className="size-4" />
            </IconButton>
          </Tooltip>
        </div>
      ) : (
        <PluginPageHeader
          title={title}
          subtitle={tab.plugin.name}
          pluginId={tab.pluginId}
          onClose={close}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PluginDockTabHost layout={layout} tabKey={tab.key} />
      </div>

      <PanelResizer
        side="end"
        value={dock.width}
        min={SIDE_PANEL_WIDTH_MIN}
        max={dock.maxWidth}
        step={SIDE_PANEL_WIDTH_STEP}
        label={t('artifacts:panel.resize')}
        className="absolute inset-y-0 -left-2 z-10"
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onReset={onReset}
      />
    </aside>
  );
}
