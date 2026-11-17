/**
 * Body of a plugin tab inside the right dock.
 *
 * The dock chrome belongs to the host: CodePanel/AgentPanel and the chat dock
 * shell render the strip and the header, so this component only mounts the tab
 * content (trusted component or sandboxed `entry` iframe). Rendering another
 * page header here used to push a "back" affordance below the real tab strip.
 */
import { useEffect } from 'react';

import { useChatStore } from '@/lib/store/chatStore';
import { useUiStore, type LayoutMode } from '@/lib/store/uiStore';
import { pluginLabel } from '@/lib/plugins/registry';
import { runPluginHostAction } from '@/lib/plugins/ui/hostActions';
import { PluginFrame } from '@/lib/plugins/frame';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { PluginBoundary } from './PluginBoundary';

export function PluginDockTabHost({
  layout,
  tabKey,
  className,
}: {
  layout: LayoutMode;
  tabKey: string;
  className?: string;
}) {
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const conversationId = useChatStore((state) => state.activeId);
  const tab = ui.panelTabs.find(
    (entry) => entry.key === tabKey && entry.layouts.includes(layout),
  );
  const unavailable = !prefs.enabled || prefs.disabled.includes(tabKey);
  useEffect(() => {
    if (!unavailable) return;
    const state = useUiStore.getState();
    state.closePluginDockTab(layout);
    if (tab?.takeover) state.dismissPluginDockTakeover(layout);
  }, [unavailable, layout, tab?.takeover]);
  if (!tab || unavailable) return null;
  const title = pluginLabel(tab.plugin, tab.titleKey, tab.title);
  const TabComponent = tab.component;
  const context = {
    layout,
    pluginId: tab.pluginId,
    panelId: tab.tabId,
    conversationId,
  };
  return (
    <div
      className={className ?? 'flex h-full min-h-0 flex-col bg-surface-raised'}
      data-plugin-dock-tab={tab.key}
      aria-label={title}
    >
      <div className="min-h-0 flex-1">
        {TabComponent ? (
          <PluginBoundary plugin={tab.plugin}>
            <TabComponent
              plugin={tab.plugin}
              layout={layout}
              conversationId={conversationId}
              tab={tab.tabId}
            />
          </PluginBoundary>
        ) : tab.entry ? (
          <PluginFrame
            plugin={tab.plugin}
            entry={tab.entry}
            kind="dock"
            title={title}
            context={context}
            className="h-full min-h-0"
            maxHeight={100_000}
            minHeight={240}
            onHostAction={(action, params) => runPluginHostAction(tab.plugin, action, params)}
          />
        ) : null}
      </div>
    </div>
  );
}
