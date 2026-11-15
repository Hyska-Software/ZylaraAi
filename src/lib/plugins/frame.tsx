/**
 * Sandboxed plugin frame host.
 *
 * The iframe is loaded from `zplugin://`/`zplugin.localhost` with
 * `sandbox="allow-scripts"` (no same-origin, no popups). Communication is
 * `postMessage` with a per-frame nonce; every RPC is mediated by the Rust
 * broker, so the iframe never receives Tauri APIs or provider secrets.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/lib/api';
import { useUiStore } from '@/lib/store/uiStore';
import { pluginUiState } from './ui/registry';
import { useThemeRevision } from '@/lib/theme/useThemeRevision';
import { cn } from '@/lib/utils';
import { usePluginStore } from './store';
import type { PluginRecord, PluginToolCallEvent, PluginToolResult } from './types';
import { pluginAssetUrl } from './urls';

export type PluginFrameKind =
  | 'view'
  | 'panel'
  | 'dock'
  | 'slot'
  | 'backend'
  | 'artifact'
  | 'settings'
  | 'genui';

const FRAME_LOAD_TIMEOUT_MS = 12_000;
const failures = new Map<string, number>();
const liveFrames = new Set<{
  pluginId: string;
  isReady: () => boolean;
  send: (message: Record<string, unknown>) => void;
}>();

/** Delivers a normalized host event to every sandboxed frame of a plugin. */
export function emitPluginFrameEvent(
  pluginId: string,
  name: string,
  detail: unknown,
): void {
  for (const frame of liveFrames) {
    if (frame.pluginId !== pluginId || !frame.isReady()) continue;
    frame.send({ type: 'event', name, detail });
  }
}

/**
 * Records a sandboxed contribution failure and disables the plugin after three
 * failures in the current process. Keeps the app usable when a plugin crash
 * loops on mount. The user can re-enable it after fixing the plugin.
 */
export function reportPluginFailure(plugin: PluginRecord, message: string): void {
  void api
    .pluginRpc(plugin.id, 'log', { level: 'error', message })
    .catch(() => {});
  const count = (failures.get(plugin.id) ?? 0) + 1;
  failures.set(plugin.id, count);
  if (count !== 3) return;
  void api
    .setPluginEnabled(plugin.id, false)
    .then(() => usePluginStore.getState().reload())
    .catch(() => {});
}

export interface PluginFrameHandle {
  invokeTool: (event: PluginToolCallEvent) => Promise<PluginToolResult>;
  send: (message: Record<string, unknown>) => void;
}

interface PluginFrameProps {
  plugin: PluginRecord;
  entry: string;
  kind: PluginFrameKind;
  context?: Record<string, unknown>;
  slot?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  minHeight?: number;
  maxHeight?: number;
  onReady?: () => void;
  onError?: (message: string) => void;
  onHostAction?: (action: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
}

const THEME_TOKENS = [
  '--background',
  '--surface',
  '--surface-raised',
  '--surface-hover',
  '--surface-active',
  '--foreground',
  '--foreground-muted',
  '--foreground-subtle',
  '--border',
  '--border-strong',
  '--accent',
  '--accent-hover',
  '--accent-soft',
  '--accent-foreground',
  '--danger',
  '--danger-soft',
  '--success',
  '--success-soft',
  '--warning',
  '--warning-soft',
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--font-sans',
  '--font-mono',
];

function readTheme(): {
  tokens: Record<string, string>;
  dark: boolean;
  locale: string;
  reduceMotion: boolean;
} {
  const tokens: Record<string, string> = {};
  if (typeof document !== 'undefined') {
    const style = getComputedStyle(document.documentElement);
    for (const token of THEME_TOKENS) {
      const value = style.getPropertyValue(token).trim();
      if (value) tokens[token] = value;
    }
  }
  return {
    tokens,
    dark: typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    locale: usePluginStore.getState().snapshot.configFingerprint
      ? (typeof window !== 'undefined'
          ? localStorage.getItem('zylara.locale') ?? 'en'
          : 'en')
      : 'en',
    reduceMotion:
      typeof document !== 'undefined' &&
      (document.documentElement.classList.contains('reduce-motion') ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  // The renderer targets ES2023 (Safari 18/Chrome 130 do not share a stable
  // Promise.withResolvers typing in this build).
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((inner) => {
    resolve = inner;
  });
  return { promise, resolve };
}

export const PluginFrame = forwardRef<PluginFrameHandle, PluginFrameProps>(
  function PluginFrame(
    {
      plugin,
      entry,
      kind,
      context,
      slot,
      className,
      style,
      title,
      minHeight = 24,
      maxHeight = 900,
      onReady,
      onError,
      onHostAction,
    },
    ref,
  ) {
    const { i18n } = useTranslation();
    const themeRevision = useThemeRevision();
    const frameRef = useRef<HTMLIFrameElement>(null);
    const nonce = useMemo(() => crypto.randomUUID().replace(/-/g, ''), []);
    const token = `zylara-plugin-${nonce}`;
    const [armed, setArmed] = useState(false);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [height, setHeight] = useState<number | null>(null);
    const pendingTools = useRef(new Map<string, (result: PluginToolResult) => void>());
    const contextRef = useRef(context);
    contextRef.current = context;
    const readyRef = useRef(false);
    readyRef.current = ready;
    const contextKey = JSON.stringify(context ?? {});
    const callbackRef = useRef({ onReady, onError });
    callbackRef.current = { onReady, onError };
    const backend = kind === 'backend';

    const send = (message: Record<string, unknown>) => {
      frameRef.current?.contentWindow?.postMessage({ ...message, token }, '*');
    };

    function initMessage(): Record<string, unknown> {
      const theme = readTheme();
      const locale = i18n.language || theme.locale;
      const bundle = usePluginStore.getState().localeBundle.entries[plugin.id]?.[locale] ?? {};
      return {
        type: 'init',
        pluginId: plugin.id,
        locale,
        theme,
        localeBundle: bundle,
        context: contextRef.current ?? {},
        kind,
        slot: slot ?? null,
        layout: useUiStore.getState().layoutMode,
      };
    }

    useEffect(() => {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== frameRef.current?.contentWindow) return;
        const data = event.data as Record<string, unknown> | null;
        if (!data || data.token !== token || typeof data.type !== 'string') return;
        if (data.type === 'ready') {
          setReady(true);
          failures.delete(plugin.id);
          send(initMessage());
          callbackRef.current.onReady?.();
          return;
        }
        if (data.type === 'resize') {
          if (backend) return;
          const next = Number(data.height);
          if (Number.isFinite(next)) {
            setHeight(Math.max(minHeight, Math.min(maxHeight, Math.round(next))));
          }
          return;
        }
        if (data.type === 'notify') {
          // Notifications are mediated by `plugin_rpc`; a raw postMessage can
          // never show host UI or bypass the notification permission.
          return;
        }
        if (!backend && data.type === 'openView' && typeof data.viewId === 'string') {
          useUiStore.getState().openPluginPage({ pluginId: plugin.id, pageId: data.viewId });
          return;
        }
        if (!backend && data.type === 'openPanel' && typeof data.panelId === 'string') {
          const tab = pluginUiState().panelTabs.find(
            (entry) => entry.pluginId === plugin.id && entry.tabId === data.panelId,
          );
          if (tab) useUiStore.getState().openPluginDockTab(tab.key);
          return;
        }
        if (!backend && data.type === 'closeOverlays') {
          useUiStore.getState().closePluginPage();
          useUiStore.getState().closePluginDockTab();
          return;
        }
        if (!backend && data.type === 'host-action') {
          const id = typeof data.id === 'string' ? data.id : '';
          const action = typeof data.action === 'string' ? data.action : '';
          const params =
            typeof data.params === 'object' && data.params
              ? (data.params as Record<string, unknown>)
              : {};
          if (!onHostAction) {
            send({ type: 'host-action-result', id, error: 'PLUGIN_HOST_ACTION_UNSUPPORTED' });
            return;
          }
          void Promise.resolve(onHostAction(action, params))
            .then((result) => send({ type: 'host-action-result', id, result }))
            .catch((error) =>
              send({
                type: 'host-action-result',
                id,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          return;
        }
        if (data.type === 'tool-result') {
          const callId = typeof data.callId === 'string' ? data.callId : '';
          pendingTools.current.get(callId)?.({
            callId,
            content: '',
            isError: false,
            ...(typeof data.result === 'object' && data.result ? data.result : {}),
          } as PluginToolResult);
          pendingTools.current.delete(callId);
          return;
        }
        if (data.type === 'rpc') {
          const id = typeof data.id === 'string' ? data.id : '';
          const method = typeof data.method === 'string' ? data.method : '';
          void api
            .pluginRpc(plugin.id, method, data.params ?? {})
            .then((result) => send({ type: 'rpc-result', id, result }))
            .catch((error) =>
              send({
                type: 'rpc-result',
                id,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        }
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
      // `token`/plugin/kind are stable for the frame; context is delivered via ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, plugin.id, backend, minHeight, maxHeight, i18n.language]);

    useEffect(() => {
      if (!ready) return;
      send({
        type: 'theme',
        theme: readTheme(),
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeRevision, i18n.language, ready]);

    useEffect(() => {
      if (!ready) return;
      send({ type: 'context', context: contextRef.current ?? {} });
      // `contextKey` is the serialized context; the frame receives the latest
      // props without re-sending locale/theme or remounting.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contextKey, ready]);

    useEffect(() => {
      setArmed(true);
      const record = {
        pluginId: plugin.id,
        isReady: () => readyRef.current,
        send,
      };
      liveFrames.add(record);
      return () => {
        liveFrames.delete(record);
        setArmed(false);
        for (const resolve of pendingTools.current.values()) {
          resolve({
            callId: '',
            content: 'PLUGIN_FRAME_UNMOUNTED: the plugin view was closed',
            isError: true,
          });
        }
        pendingTools.current.clear();
      };
    }, []);

    useEffect(() => {
      if (!armed || ready || failed) return;
      const timer = window.setTimeout(() => {
        const message = `PLUGIN_FRAME_TIMEOUT: ${plugin.name} did not initialize ${entry}`;
        setFailed(message);
        reportPluginFailure(plugin, message);
        callbackRef.current.onError?.(message);
      }, FRAME_LOAD_TIMEOUT_MS);
      return () => window.clearTimeout(timer);
      // `armed` flips after mount; `ready` cancels the watchdog.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [armed, ready, failed, plugin.id, entry]);

    useImperativeHandle(ref, () => ({
      send,
      invokeTool: (toolEvent) => {
        const { promise, resolve } = deferred<PluginToolResult>();
        if (!ready) {
          resolve({
            callId: toolEvent.callId,
            content: 'PLUGIN_BACKEND_NOT_READY: plugin backend is still loading',
            isError: true,
          });
          return promise;
        }
        pendingTools.current.set(toolEvent.callId, resolve);
        send({
          type: 'tool',
          callId: toolEvent.callId,
          tool: toolEvent.tool,
          arguments: toolEvent.arguments,
        });
        window.setTimeout(() => {
          const pending = pendingTools.current.get(toolEvent.callId);
          if (!pending) return;
          pendingTools.current.delete(toolEvent.callId);
          pending({
            callId: toolEvent.callId,
            content: 'PLUGIN_BACKEND_TIMEOUT: no answer from the plugin backend',
            isError: true,
          });
        }, Math.min(120_000, Math.max(5_000, toolEvent.timeoutSecs * 1_000 + 2_000)));
        return promise;
      },
    }));

    if (failed) {
      return (
        <div
          className={cn(
            'rounded-lg bg-danger-soft/40 px-3 py-2 text-[12px] text-danger',
            className,
          )}
          role="alert"
        >
          {failed}
        </div>
      );
    }

    const src = armed
      ? `${pluginAssetUrl(plugin.id, entry)}?zylaraNonce=${encodeURIComponent(nonce)}&zylaraPlugin=${encodeURIComponent(plugin.id)}`
      : undefined;
    return (
      <iframe
        ref={frameRef}
        src={src}
        title={title ?? plugin.name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onError={() => {
          const message = `PLUGIN_FRAME_ERROR: ${plugin.name} could not load ${entry}`;
          setFailed(message);
          reportPluginFailure(plugin, message);
          callbackRef.current.onError?.(message);
        }}
        className={cn(backend ? 'hidden' : 'w-full border-0 bg-transparent', className)}
        style={{
          ...style,
          ...(backend
            ? { width: 0, height: 0 }
            : height != null
              ? { height }
              : { minHeight }),
        }}
        data-plugin-id={plugin.id}
        data-plugin-frame={kind}
      />
    );
  },
);

/* ------------------------------------------------------------------ */
/* Backend frame registry                                              */
/* ------------------------------------------------------------------ */

const backendFrames = new Map<string, PluginFrameHandle>();

export function hasBackendFrame(pluginId: string): boolean {
  return backendFrames.has(pluginId);
}

export function invokeBackendTool(
  pluginId: string,
  event: PluginToolCallEvent,
): Promise<PluginToolResult> {
  const frame = backendFrames.get(pluginId);
  if (!frame) {
    return Promise.resolve({
      callId: event.callId,
      content: 'PLUGIN_BACKEND_UNAVAILABLE: no backend frame is mounted for this plugin',
      isError: true,
    });
  }
  return frame.invokeTool(event);
}

export function sendToBackendFrames(
  pluginId: string,
  message: Record<string, unknown>,
): boolean {
  const frame = backendFrames.get(pluginId);
  if (!frame) return false;
  frame.send(message);
  return true;
}

export function PluginBackendFrame({
  plugin,
  onReady,
}: {
  plugin: PluginRecord;
  onReady?: () => void;
}) {
  const entry = plugin.manifest.runtime.backend?.entry;
  const handle = useRef<PluginFrameHandle | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready || !handle.current) return;
    backendFrames.set(plugin.id, handle.current);
    onReadyRef.current?.();
    return () => {
      if (backendFrames.get(plugin.id) === handle.current) {
        backendFrames.delete(plugin.id);
      }
    };
  }, [plugin.id, ready, handle]);

  if (!entry) return null;
  return (
    <PluginFrame
      ref={handle}
      plugin={plugin}
      entry={entry}
      kind="backend"
      title={`${plugin.name} backend`}
      onReady={() => setReady(true)}
    />
  );
}

export function PluginFrameFallback({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg bg-surface-raised/60 px-3 py-2 text-[12px] text-foreground-muted">
      {children}
    </div>
  );
}
