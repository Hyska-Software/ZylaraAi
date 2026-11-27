/**
 * Plugin tabs of a layout's right dock strip.
 *
 * The host panel owns the strip (CodePanel/AgentPanel build their tabs and the
 * chat dock adds the host "Artifacts" tab), so this component only appends the
 * plugin-owned buttons: one per panel, resolved by `dockTabsForLayout` so a
 * panel declared by both the manifest and trusted code never shows twice.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  SortableList,
  sortableDropClassHorizontal,
  type SortableListApi,
} from '@/components/ui';
import { useUiStore, type LayoutMode } from '@/lib/store/uiStore';
import { pluginLabel } from '@/lib/plugins/registry';
import { pluginIcon } from '@/lib/plugins/icons';
import { cn, sortStableByOrder } from '@/lib/utils';
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
  const { t } = useTranslation('plugins');
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const activeKey = useUiStore((state) => state.pluginDockTab[layout] ?? null);
  const openDockTab = useUiStore((state) => state.openPluginDockTab);
  const tabOrder = useUiStore((state) => state.pluginDockTabOrder[layout]);
  const setTabOrder = useUiStore((state) => state.setPluginDockTabOrder);
  const tabs = useMemo(
    () => dockTabsForLayout(ui.panelTabs, layout, prefs.disabled),
    [prefs.disabled, ui.panelTabs, layout],
  );
  const orderedTabs = useMemo(
    () =>
      sortStableByOrder(
        tabs.map((entry) => entry.key),
        tabOrder,
      ).flatMap((key) => {
        const entry = tabs.find((candidate) => candidate.key === key);
        return entry ? [entry] : [];
      }),
    [tabs, tabOrder],
  );
  const labelFor = (key: string): string => {
    const entry = orderedTabs.find((candidate) => candidate.key === key);
    return entry ? pluginLabel(entry.plugin, entry.titleKey, entry.title) : key;
  };
  if (!prefs.enabled || orderedTabs.length === 0) return null;
  return (
    <SortableList
      ids={orderedTabs.map((entry) => entry.key)}
      label={t('host.dockTabs')}
      itemLabel={labelFor}
      orientation="horizontal"
      disabled={orderedTabs.length < 2}
      onReorder={(ids) => setTabOrder(layout, ids)}
    >
      {(sortable: SortableListApi) => (
        <div
          ref={sortable.containerRef}
          role="presentation"
          className={cn('flex shrink-0 items-center gap-0.5', className)}
          data-plugin-dock-tabs={layout}
        >
          {orderedTabs.map((entry) => {
            const Icon = pluginIcon(entry.icon);
            const selected = activeKey === entry.key;
            const label = pluginLabel(entry.plugin, entry.titleKey, entry.title);
            const itemProps = sortable.itemProps(entry.key);
            return (
              <div
                key={entry.key}
                role="presentation"
                {...sortable.dropProps(entry.key)}
                className={cn('shrink-0', sortableDropClassHorizontal)}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={label}
                  title={label}
                  {...itemProps}
                  onClick={() => openDockTab(entry.key, layout)}
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
                    'transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    selected
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                    compact && 'px-2',
                    !sortable.disabled && 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  <Icon aria-hidden className="size-3.5" />
                  {compact ? null : label}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </SortableList>
  );
}
