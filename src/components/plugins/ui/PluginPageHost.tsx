/** Center page owned by a plugin for one layout. */
import { useChatStore } from '@/lib/store/chatStore';
import { useUiStore, type LayoutMode, type PluginPageTarget } from '@/lib/store/uiStore';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { pluginLabel } from '@/lib/plugins/registry';
import { runPluginHostAction } from '@/lib/plugins/ui/hostActions';
import { PluginFrame } from '@/lib/plugins/frame';
import { PluginPageHeader } from '../PluginHosts';
import { PluginBoundary } from './PluginBoundary';

export function PluginPageHost({
  layout,
  target,
  className,
}: {
  layout: LayoutMode;
  target: PluginPageTarget;
  className?: string;
}) {
  const ui = usePluginUi();
  const enabled = usePluginUiPrefs((state) => state.enabled);
  const conversationId = useChatStore((state) => state.activeId);
  if (!enabled) return null;
  const page = ui.pages.find(
    (entry) =>
      entry.pluginId === target.pluginId &&
      entry.pageId === target.pageId &&
      entry.layouts.includes(layout),
  );
  const close = () => useUiStore.getState().closePluginPage(layout);

  if (!page) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <PluginPageHeader
          title={target.pluginId}
          subtitle={target.pageId}
          pluginId={target.pluginId}
          onClose={close}
        />
      </div>
    );
  }

  const title = pluginLabel(page.plugin, page.titleKey, page.title);
  const PageComponent = page.component;
  const context = {
    layout,
    pageId: page.pageId,
    pluginId: page.pluginId,
    conversationId,
  };
  return (
    <div
      className={className ?? 'flex h-full min-h-0 flex-col bg-background'}
      data-plugin-page={page.key}
    >
      <PluginPageHeader title={title} subtitle={page.plugin.name} pluginId={page.pluginId} onClose={close} />
      <div className="min-h-0 flex-1">
        {PageComponent ? (
          <PluginBoundary plugin={page.plugin}>
            <PageComponent
              plugin={page.plugin}
              layout={layout}
              conversationId={conversationId}
              page={page.pageId}
            />
          </PluginBoundary>
        ) : page.entry ? (
          <PluginFrame
            plugin={page.plugin}
            entry={page.entry}
            kind="view"
            title={title}
            context={context}
            className="h-full min-h-0"
            maxHeight={100_000}
            minHeight={320}
            onHostAction={(action, params) => runPluginHostAction(page.plugin, action, params)}
          />
        ) : (
          <div className="p-6 text-[13px] text-foreground-muted">{page.plugin.name}</div>
        )}
      </div>
    </div>
  );
}
