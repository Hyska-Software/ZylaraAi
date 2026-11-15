/** Normalized host events delivered to plugin UI (trusted and sandboxed). */
import { useChatStore } from '@/lib/store/chatStore';
import { useUiStore } from '@/lib/store/uiStore';
import { getPluginRegistryState, pluginHasPermission } from '@/lib/plugins/registry';
import { emitPluginFrameEvent } from '@/lib/plugins/frame';
import { emitTrustedEvent } from '@/lib/plugins/trusted';

const WINDOW_MS = 1000;
const MAX_PER_WINDOW = 50;
const windows = new Map<string, { start: number; count: number }>();

function allowed(pluginId: string, event: string): boolean {
  const plugin = getPluginRegistryState().plugins.find((entry) => entry.id === pluginId);
  if (!plugin) return false;
  const scope = event.split('/')[0] === 'message' || event.split('/')[0] === 'turn' ||
    event.split('/')[0] === 'conversation'
    ? 'chat'
    : 'ui';
  if (!pluginHasPermission(plugin, `events:${scope}`) && !pluginHasPermission(plugin, 'events:*')) {
    return false;
  }
  const now = Date.now();
  const window = windows.get(pluginId);
  if (!window || now - window.start > WINDOW_MS) {
    windows.set(pluginId, { start: now, count: 1 });
    return true;
  }
  if (window.count >= MAX_PER_WINDOW) return false;
  window.count += 1;
  return true;
}

export function emitPluginEvent(name: string, detail: Record<string, unknown>): void {
  for (const plugin of getPluginRegistryState().plugins) {
    if (!allowed(plugin.id, name)) continue;
    emitTrustedEvent(plugin.id, name, detail);
    emitPluginFrameEvent(plugin.id, name, detail);
  }
}

/** Subscribes to host stores and forwards normalized events. */
export function startPluginEventBridge(): () => void {
  let lastLayout = useUiStore.getState().layoutMode;
  let lastPage = '';
  let lastConversation = useChatStore.getState().activeId;
  let lastStreaming = useChatStore.getState().streaming;
  let lastMessageCount = 0;
  let lastDock = '';

  const readMessages = () => {
    const id = useChatStore.getState().activeId;
    return id ? useChatStore.getState().messagesByConversation[id]?.length ?? 0 : 0;
  };
  lastMessageCount = readMessages();

  const pageKey = () => {
    const state = useUiStore.getState();
    const page = state.pluginPages[state.layoutMode];
    return page ? `${page.pluginId}:${page.pageId}` : `${state.layoutMode}:${state.activeView}`;
  };
  lastPage = pageKey();
  lastDock = Object.values(useUiStore.getState().pluginDockTab).join('|');

  const unUi = useUiStore.subscribe((state) => {
    if (state.layoutMode !== lastLayout) {
      lastLayout = state.layoutMode;
      emitPluginEvent('layout/changed', { layout: state.layoutMode });
    }
    const page = pageKey();
    if (page !== lastPage) {
      lastPage = page;
      emitPluginEvent('page/changed', { layout: state.layoutMode, page });
    }
    const dock = Object.values(state.pluginDockTab).join('|');
    if (dock !== lastDock) {
      lastDock = dock;
      emitPluginEvent('dock/changed', {
        layout: state.layoutMode,
        tab: state.pluginDockTab[state.layoutMode] ?? null,
        open: Boolean(state.pluginDockTab[state.layoutMode]),
      });
    }
  });
  const unChat = useChatStore.subscribe((state) => {
    if (state.activeId !== lastConversation) {
      lastConversation = state.activeId;
      emitPluginEvent('conversation/selected', {
        conversationId: state.activeId,
        layout: useUiStore.getState().layoutMode,
      });
      lastMessageCount = readMessages();
    }
    const count = readMessages();
    if (count > lastMessageCount && state.activeId) {
      const messages = state.messagesByConversation[state.activeId] ?? [];
      const last = messages[messages.length - 1];
      emitPluginEvent('message/appended', {
        conversationId: state.activeId,
        messageId: last?.id ?? null,
        role: last?.role ?? null,
      });
    }
    lastMessageCount = count;
    if (Boolean(state.streaming) !== Boolean(lastStreaming)) {
      const id = state.streaming?.turnId ?? lastStreaming?.turnId ?? null;
      emitPluginEvent(
        state.streaming ? 'turn/started' : 'turn/finished',
        {
          conversationId: state.streaming?.conversationId ?? lastStreaming?.conversationId ?? null,
          turnId: id,
          status: state.streaming ? 'running' : 'finished',
        },
      );
      lastStreaming = state.streaming;
    }
  });

  return () => {
    unUi();
    unChat();
    windows.clear();
  };
}
