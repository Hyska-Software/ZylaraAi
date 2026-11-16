/**
 * Global plugin host: trusted loading, hidden backend frames and the bridge for
 * agent tool calls. Mounted once by `App.tsx`.
 */
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useUiStore } from '@/lib/store/uiStore';
import { runPluginCommand } from './host';
import { getPluginRegistryState, pluginHasPermission, trustedPluginRegistration } from './registry';
import { usePluginStore } from './store';
import {
  hasBackendFrame,
  invokeBackendTool,
  sendToBackendFrames,
  PluginBackendFrame,
} from './frame';
import { emitTrustedEvent, loadTrustedPlugin, loadedTrustedPluginIds, unloadTrustedPlugin } from './trusted';
import { startPluginEventBridge } from './ui/events';
import { pluginUiState, subscribePluginUi } from './ui/registry';
import { setPluginGenuiComponents } from '@/lib/genui/extension';
import type {
  PluginNotificationEvent,
  PluginToolCallEvent,
  PluginToolResult,
} from './types';

const backendRequested = new Set<string>();
const backendWaiters = new Map<string, Set<() => void>>();

function notifyBackendMounted(pluginId: string) {
  const waiters = backendWaiters.get(pluginId);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter();
  backendWaiters.delete(pluginId);
}

export function requestBackend(pluginId: string) {
  backendRequested.add(pluginId);
  window.dispatchEvent(new CustomEvent('zylara:plugin-backend-requested'));
  return new Promise<void>((resolve) => {
    if (hasBackendFrame(pluginId)) {
      resolve();
      return;
    }
    const waiters = backendWaiters.get(pluginId) ?? new Set();
    waiters.add(resolve);
    backendWaiters.set(pluginId, waiters);
    window.setTimeout(() => {
      waiters.delete(resolve);
      resolve();
    }, 10_000);
  });
}

const backendReady = new Set<string>();

export function markBackendReady(pluginId: string) {
  backendReady.add(pluginId);
  notifyBackendMounted(pluginId);
}

async function dispatchToolCall(event: PluginToolCallEvent): Promise<void> {
  const result = await runTool(event);
  try {
    await api.pluginCallResult(result);
  } catch {
    // The turn may have been cancelled; the Rust side already timed out.
  }
}

async function runTool(event: PluginToolCallEvent): Promise<PluginToolResult> {
  const registration = trustedPluginRegistration(event.pluginId);
  const handler =
    registration?.toolHandlers.get(event.tool) ??
    registration?.toolHandlers.get(event.wireName);
  if (handler) {
    try {
      const value = await Promise.resolve(
        handler({ tool: event.tool, arguments: event.arguments }),
      );
      if (typeof value === 'string') {
        return { callId: event.callId, content: value, isError: false };
      }
      return {
        callId: event.callId,
        content: '',
        isError: false,
        ...(value as Partial<PluginToolResult>),
      };
    } catch (error) {
      return {
        callId: event.callId,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
  const plugin = usePluginStore
    .getState()
    .snapshot.plugins.find((candidate) => candidate.id === event.pluginId);
  if (plugin?.hasBackend) {
    await requestBackend(event.pluginId);
    return invokeBackendTool(event.pluginId, event);
  }
  return {
    callId: event.callId,
    content: `PLUGIN_TOOL_UNAVAILABLE: plugin \`${event.pluginId}\` has no handler or backend for \`${event.tool}\``,
    isError: true,
  };
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function hotkeyMatches(hotkey: string, event: KeyboardEvent): boolean {
  const parts = hotkey
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  if (event.key.toLowerCase() !== key) return false;
  const modifiers = new Set(parts.slice(0, -1));
  const wants = (name: string) => modifiers.has(name);
  const mod = wants('mod') || wants('cmd') || wants('meta');
  const ctrl = wants('ctrl') || wants('control');
  const alt = wants('alt');
  const shift = wants('shift');
  if (mod && (IS_MAC ? !event.metaKey : !event.ctrlKey)) return false;
  if (ctrl && !event.ctrlKey) return false;
  if (alt && !event.altKey) return false;
  if (shift && !event.shiftKey) return false;
  // Reject extra modifiers so Ctrl+Shift+N never fires Ctrl+N.
  if (!mod && !ctrl && (event.ctrlKey || event.metaKey)) return false;
  if (!alt && event.altKey) return false;
  if (!shift && event.shiftKey) return false;
  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

function registerPluginHotkeys(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    for (const command of getPluginRegistryState().commands) {
      if (!command.command.hotkey) continue;
      if (!pluginHasPermission(command.plugin, 'hotkeys')) continue;
      if (!hotkeyMatches(command.command.hotkey, event)) continue;
      event.preventDefault();
      void runPluginCommand(command);
      return;
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

export function PluginRuntime() {
  const snapshot = usePluginStore((state) => state.snapshot);
  const [requested, setRequested] = useState<string[]>([]);
  const readySent = useRef(false);

  useEffect(() => {
    const onRequested = () => setRequested([...backendRequested]);
    window.addEventListener('zylara:plugin-backend-requested', onRequested);
    onRequested();
    return () => window.removeEventListener('zylara:plugin-backend-requested', onRequested);
  }, []);

  useEffect(() => {
    const trustedPlugins = snapshot.plugins.filter(
      (plugin) =>
        plugin.active &&
        plugin.enabled &&
        plugin.trusted &&
        snapshot.pluginsEnabled &&
        !snapshot.safeMode,
    );
    const activeIds = new Set(trustedPlugins.map((plugin) => plugin.id));
    for (const pluginId of [...backendRequested]) {
      if (!snapshot.plugins.some((plugin) => plugin.id === pluginId && plugin.active)) {
        backendReady.delete(pluginId);
        backendRequested.delete(pluginId);
      }
    }
    setRequested([...backendRequested]);
    const trustedLoads = trustedPlugins.map((plugin) => loadTrustedPlugin(plugin));
    // Unload trusted code as soon as the plugin is disabled/removed or safe
    // mode is entered. The loader keeps its own map, so this is idempotent.
    for (const pluginId of loadedTrustedPluginIds()) {
      if (!activeIds.has(pluginId)) unloadTrustedPlugin(pluginId);
    }
    if (!readySent.current && usePluginStore.getState().initialized) {
      readySent.current = true;
      void Promise.allSettled(trustedLoads).then(() => {
        // Keep the crash marker until the trusted lane had a chance to activate;
        // a crash during activation then enters safe mode on the next boot.
        window.setTimeout(() => {
          void api.pluginRuntimeReady().catch(() => {});
        }, 250);
      });
    }
    // `registry.revision` is intentionally excluded: loading a trusted plugin
    // re-emits the registry and this effect only reacts to snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  useEffect(() => {
    const disposers: Array<() => void> = [];
    let disposed = false;
    disposers.push(registerPluginHotkeys());
    disposers.push(startPluginEventBridge());
    void listen<PluginToolCallEvent>('zylara:plugin-tool-call', (event) => {
      if (disposed) return;
      void dispatchToolCall(event.payload);
    })
      .then((unlisten) => (disposed ? unlisten() : disposers.push(unlisten)))
      .catch(() => {});
    void listen<PluginNotificationEvent>('zylara:plugin-notification', (event) => {
      if (disposed) return;
      toast.info(event.payload.title, {
        description: event.payload.body || undefined,
        duration: 6_000,
      });
    })
      .then((unlisten) => (disposed ? unlisten() : disposers.push(unlisten)))
      .catch(() => {});
    const openDeepLink = (url: string) => {
      if (!url || !/^https:\/\//i.test(url)) return;
      const ui = useUiStore.getState();
      ui.setLayoutMode('chat');
      ui.setActiveView('plugins');
      usePluginStore.getState().closeOverlays();
      window.setTimeout(
        () => window.dispatchEvent(new CustomEvent('zylara:plugin-deep-link', { detail: url })),
        0,
      );
    };
    void listen<string>('zylara:plugin-deep-link', (event) => {
      if (!disposed) openDeepLink(event.payload);
    })
      .then((unlisten) => (disposed ? unlisten() : disposers.push(unlisten)))
      .catch(() => {});
    void api
      .takePluginDeepLink()
      .then((url) => {
        if (!disposed && url) openDeepLink(url);
      })
      .catch(() => {});
    void listen('zylara:plugins-changed', () => {
      if (disposed) return;
      void usePluginStore.getState().reload();
    })
      .then((unlisten) => (disposed ? unlisten() : disposers.push(unlisten)))
      .catch(() => {});
    const onCommand = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        pluginId: string;
        method: string;
        params: unknown;
      };
      if (!detail?.pluginId) return;
      const registration = trustedPluginRegistration(detail.pluginId);
      const handler = registration?.commands.get(detail.method);
      if (handler) {
        try {
          void Promise.resolve(handler(detail.params)).catch(() => {});
        } catch {
          // A command handler error is isolated from the host.
        }
        return;
      }
      if (!emitTrustedEvent(detail.pluginId, 'command', detail)) {
        const plugin = usePluginStore
          .getState()
          .snapshot.plugins.find((candidate) => candidate.id === detail.pluginId);
        if (!plugin?.hasBackend) {
          toast.error(
            i18n.t('plugins:errors.commandUnavailable', {
              method: detail.method,
              defaultValue: `No handler for command \`${detail.method}\``,
            }),
          );
          return;
        }
        void requestBackend(detail.pluginId).then(() => {
          sendToBackendFrames(detail.pluginId, {
            type: 'command',
            method: detail.method,
            params: detail.params,
          });
        });
      }
    };
    window.addEventListener('zylara:plugin-command', onCommand);
    return () => {
      disposed = true;
      window.removeEventListener('zylara:plugin-command', onCommand);
      for (const dispose of disposers) dispose();
    };
  }, []);

  useEffect(() => {
    const sync = () => setPluginGenuiComponents(pluginUiState().genui);
    sync();
    return subscribePluginUi(sync);
  }, []);

  useEffect(() => {
    if (!snapshot.safeMode) return;
    for (const pluginId of [...backendRequested]) {
      backendReady.delete(pluginId);
      backendRequested.delete(pluginId);
    }
    setRequested([]);
  }, [snapshot.safeMode]);

  const backendPlugins = snapshot.plugins.filter(
    (plugin) =>
      plugin.active &&
      plugin.enabled &&
      plugin.hasBackend &&
      requested.includes(plugin.id) &&
      !snapshot.safeMode,
  );

  if (backendPlugins.length === 0) return null;
  return (
    <div aria-hidden className="hidden">
      {backendPlugins.map((plugin) => (
        <PluginBackendFrame
          key={`${plugin.id}:${plugin.version}`}
          plugin={plugin}
          onReady={() => markBackendReady(plugin.id)}
        />
      ))}
    </div>
  );
}

export function usePluginStrings(): (pluginId: string, key: string, fallback?: string) => string {
  return (pluginId, key, fallback) =>
    i18n.t(`plugins:${pluginId}.${key}`, { defaultValue: fallback ?? key }) as string;
}
