/**
 * A plugin-owned content tab inside a layout sidebar.
 *
 * The tab strip lives in the host sidebar (chat, code or agent); the body is
 * either a trusted React component or a sandboxed `entry` iframe. The host keeps
 * its own navigation; plugin tabs are an additive region.
 */
import { useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import {
  SortableList,
  sortableDropClassHorizontal,
  type SortableListApi,
} from '@/components/ui';
import { useChatStore } from '@/lib/store/chatStore';
import { useUiStore, type LayoutMode } from '@/lib/store/uiStore';
import { pluginLabel } from '@/lib/plugins/registry';
import { pluginIcon as iconForPlugin } from '@/lib/plugins/icons';
import { sortStableByOrder } from '@/lib/utils';
import { runPluginHostAction } from '@/lib/plugins/ui/hostActions';
import { PluginFrame } from '@/lib/plugins/frame';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { PluginBoundary } from './PluginBoundary';

export interface PluginSidebarTabHostProps {
  layout: LayoutMode;
  className?: string;
}

/** Body of the active plugin sidebar tab (nothing when none is open). */
export function PluginSidebarTabHost({ layout, className }: PluginSidebarTabHostProps) {
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const conversationId = useChatStore((state) => state.activeId);
  const activeKey = useUiStore((state) => state.pluginSidebarTab[layout] ?? null);
  const tab = (ui.sidebarTabs ?? []).find(
    (entry) => entry.key === activeKey && entry.sidebars.includes(layout),
  );
  const unavailable = !prefs.enabled || (activeKey ? prefs.disabled.includes(activeKey) : false);

  useEffect(() => {
    if (!activeKey || (!tab && !prefs.enabled) || unavailable) {
      if (activeKey) useUiStore.getState().setPluginSidebarTab(layout, null);
    }
  }, [activeKey, layout, tab, unavailable, prefs.enabled]);

  if (!tab || unavailable) return null;
  const title = pluginLabel(tab.plugin, tab.titleKey, tab.title);
  const TabComponent = tab.component;
  const context = {
    layout,
    pluginId: tab.pluginId,
    panelId: tab.id,
    conversationId,
  };
  return (
    <div className={className ?? 'flex min-h-0 flex-1 flex-col bg-surface-raised'}>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="truncate text-[12px] font-medium text-foreground">{title}</p>
        <button
          type="button"
          aria-label={title}
          className="rounded-md p-1 text-foreground-subtle transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => useUiStore.getState().setPluginSidebarTab(layout, null)}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {TabComponent ? (
          <PluginBoundary plugin={tab.plugin}>
            <TabComponent
              plugin={tab.plugin}
              layout={layout}
              conversationId={conversationId}
              tab={tab.id}
            />
          </PluginBoundary>
        ) : tab.entry ? (
          <PluginFrame
            plugin={tab.plugin}
            entry={tab.entry}
            kind="panel"
            title={title}
            context={context}
            className="h-full min-h-0"
            maxHeight={100_000}
            minHeight={200}
            onHostAction={(action, params) => runPluginHostAction(tab.plugin, action, params)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Strip of plugin tab buttons for a sidebar. */
export function PluginSidebarTabStrip({ layout }: { layout: LayoutMode }) {
  const { t } = useTranslation('plugins');
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const activeKey = useUiStore((state) => state.pluginSidebarTab[layout] ?? null);
  const tabOrder = useUiStore((state) => state.pluginSidebarTabOrder[layout]);
  const setTabOrder = useUiStore((state) => state.setPluginSidebarTabOrder);
  const tabs = useMemo(
    () =>
      (ui.sidebarTabs ?? []).filter(
        (entry) => entry.sidebars.includes(layout) && !prefs.disabled.includes(entry.key),
      ),
    [ui.sidebarTabs, prefs.disabled, layout],
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
  if (!prefs.enabled || orderedTabs.length === 0) return null;
  return (
    <SortableList
      ids={orderedTabs.map((entry) => entry.key)}
      label={t('host.sidebarTabs')}
      itemLabel={(key) => {
        const entry = orderedTabs.find((candidate) => candidate.key === key);
        return entry ? pluginLabel(entry.plugin, entry.titleKey, entry.title) : key;
      }}
      orientation="horizontal"
      disabled={orderedTabs.length < 2}
      onReorder={(ids) => setTabOrder(layout, ids)}
    >
      {(sortable: SortableListApi) => (
        <div
          ref={sortable.containerRef}
          className="scrollbar-none flex items-center gap-1 overflow-x-auto px-2 pb-1"
          role="tablist"
        >
          {orderedTabs.map((tab) => {
            const active = tab.key === activeKey;
            const Icon = iconForPlugin(tab.icon);
            const title = pluginLabel(tab.plugin, tab.titleKey, tab.title);
            const itemProps = sortable.itemProps(tab.key);
            return (
              <div
                key={tab.key}
                role="presentation"
                {...sortable.dropProps(tab.key)}
                className={sortableDropClassHorizontal}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={title}
                  aria-label={title}
                  {...itemProps}
                  onClick={() =>
                    useUiStore.getState().setPluginSidebarTab(layout, active ? null : tab.key)
                  }
                  className={
                    active
                      ? 'inline-flex items-center gap-1.5 rounded-lg bg-accent-soft px-2 py-1 text-[12px] font-medium text-foreground'
                      : 'inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-foreground-muted transition-colors hover:bg-surface-hover hover:text-foreground'
                  }
                >
                  <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
                  <span className="max-w-[9rem] truncate">{title}</span>
                  {tab.badge ? (
                    <span className="rounded-full bg-surface-active px-1.5 text-[10px] text-foreground-muted">
                      {tab.badge}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </SortableList>
  );
}
