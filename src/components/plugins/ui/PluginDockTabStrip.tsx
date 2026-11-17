/**
 * Plugin tabs of a layout's right dock strip.
 *
 * The host panel owns the strip (CodePanel/AgentPanel build their tabs and the
 * chat dock adds the host "Artifacts" tab), so this component only appends the
 * plugin-owned buttons: one per panel, resolved by `dockTabsForLayout` so a
 * panel declared by both the manifest and trusted code never shows twice.
 */
import { useMemo } from 'react';

import { useUiStore, type LayoutMode } from '@/lib/store/uiStore';
import { pluginLabel } from '@/lib/plugins/registry';
import { pluginIcon } from '@/lib/plugins/icons';
import { cn } from '@/lib/utils';
import { dockTabsForLayout } from '@/lib/plugins/ui/dock';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';

export interface PluginDockTabStripProps {
  layout: LayoutMode;
  /** Icon-only buttons, used by hosts that hide labels below a width. */
  compact?: boolean;
  className?: string;
}

export function PluginDockTabStrip({ layout, compact = false, className }: PluginDockTabStripProps) {
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const activeKey = useUiStore((state) => state.pluginDockTab[layout] ?? null);
  const openDockTab = useUiStore((state) => state.openPluginDockTab);
  const tabs = useMemo(
    () => dockTabsForLayout(ui.panelTabs, layout, prefs.disabled),
    [prefs.disabled, ui.panelTabs, layout],
  );
  if (!prefs.enabled || tabs.length === 0) return null;
  return (
    <div
      role="presentation"
      className={cn('flex shrink-0 items-center gap-0.5', className)}
      data-plugin-dock-tabs={layout}
    >
      {tabs.map((entry) => {
        const Icon = pluginIcon(entry.icon);
        const selected = activeKey === entry.key;
        const label = pluginLabel(entry.plugin, entry.titleKey, entry.title);
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={label}
            title={label}
            onClick={() => openDockTab(entry.key, layout)}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              selected
                ? 'bg-surface-active text-foreground'
                : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
              compact && 'px-2',
            )}
          >
            <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
            {compact ? null : label}
          </button>
        );
      })}
    </div>
  );
}
