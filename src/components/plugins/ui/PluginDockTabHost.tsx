/** A plugin-owned tab inside the right dock. */
import { useChatStore } from '@/lib/store/chatStore';
import { useUiStore, type LayoutMode } from '@/lib/store/uiStore';
import { pluginLabel } from '@/lib/plugins/registry';
import { runPluginHostAction } from '@/lib/plugins/ui/hostActions';
import { PluginFrame } from '@/lib/plugins/frame';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { PluginBoundary } from './PluginBoundary';
import { PluginPageHeader } from '../PluginHosts';

export function PluginDockTabHost({
  layout,
  tabKey,
  onClose,
  className,
}: {
  layout: LayoutMode;
  tabKey: string;
  onClose?: () => void;
  className?: string;
}) {
  const ui = usePluginUi();
  const conversationId = useChatStore((state) => state.activeId);
  const tab = ui.panelTabs.find(
    (entry) => entry.key === tabKey && entry.layouts.includes(layout),
  );
  const close = onClose ?? (() => useUiStore.getState().closePluginDockTab(layout));
  if (!tab) return null;
  const title = pluginLabel(tab.plugin, tab.titleKey, tab.title);
  const TabComponent = tab.component;
  const context = {
    layout,
    pluginId: tab.pluginId,
    panelId: tab.tabId,
    conversationId,
  };
  return (
    <div className={className ?? 'flex h-full min-h-0 flex-col bg-surface-raised'}>
      <PluginPageHeader title={title} subtitle={tab.plugin.name} pluginId={tab.pluginId} onClose={close} />
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
