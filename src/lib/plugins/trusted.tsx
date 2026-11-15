/**
 * Trusted plugin loader (main webview).
 *
 * Trusted plugins are explicitly opt-in (`pluginAllowTrusted`), signed/known to
 * the user, and run with the same privileges as the app. They are evaluated
 * with a narrow host object that shares the host React instance; they never
 * receive Tauri internals or provider credentials.
 */
import React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { useAppStore, useChatStore } from '@/lib/store';
import { useUiStore } from '@/lib/store/uiStore';
import { pluginComponentExists } from './contract';
import {
  pluginHasPermission,
  registerTrustedPlugin,
  unregisterTrustedPlugin,
  type PluginComponent,
  type TrustedRegistration,
} from './registry';
import { usePluginStore } from './store';
import type { PluginRecord } from './types';

const loaded = new Map<string, { registration: TrustedRegistration; deactivate?: () => void }>();
const failures = new Map<string, number>();
const eventHandlers = new Map<string, Map<string, Set<(detail: unknown) => void>>>();

function requirePermission(plugin: PluginRecord, permission: string): boolean {
  if (pluginHasPermission(plugin, permission)) return true;
  toast.error(i18n.t('plugins:errors.permissionDenied', { permission }), {
    description: plugin.name,
  });
  return false;
}

function addStyle(pluginId: string, css: string): () => void {
  if (typeof document === 'undefined' || !css.trim()) return () => {};
  const style = document.createElement('style');
  style.dataset.zylaraPluginCss = pluginId;
  style.textContent = css;
  document.head.appendChild(style);
  return () => style.remove();
}

function createHost(plugin: PluginRecord, registration: TrustedRegistration) {
  const log = (level: string, message: string) => {
    void api.pluginRpc(plugin.id, 'log', { level, message }).catch(() => {});
  };
  const host = {
    plugin: {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      manifest: plugin.manifest,
      permissions: plugin.permissions,
    },
    react: React,
    reactDom: ReactDOM,
    jsx: jsxRuntime.jsx,
    jsxs: jsxRuntime.jsxs,
    Fragment: jsxRuntime.Fragment,
    registerComponent(id: string, component: PluginComponent) {
      registration.components.set(id, component);
    },
    registerView(id: string, component: PluginComponent) {
      registration.views.set(id, component);
    },
    registerPanel(id: string, component: PluginComponent) {
      registration.panels.set(id, component);
    },
    registerSlot(slotId: string, component: PluginComponent) {
      registration.slots.set(slotId, component);
    },
    registerSettingsTab(id: string, component: PluginComponent) {
      registration.settingsTabs.set(id, component);
    },
    registerArtifactViewer(id: string, component: PluginComponent) {
      registration.artifactViewers.set(id, component);
    },
    replaceComponent(id: string, component: PluginComponent) {
      if (!pluginComponentExists(id)) {
        throw new Error(`unknown component id: ${id}`);
      }
      if (!requirePermission(plugin, `ui.override:${id}`)) return;
      registration.overrides.set(id, component);
    },
    wrapComponent(id: string, wrapper: PluginComponent) {
      if (!pluginComponentExists(id)) {
        throw new Error(`unknown component id: ${id}`);
      }
      if (!requirePermission(plugin, `ui.override:${id}`)) return;
      const list = registration.wrappers.get(id) ?? [];
      list.push(wrapper);
      registration.wrappers.set(id, list);
    },
    replaceShell(component: PluginComponent) {
      if (!requirePermission(plugin, 'ui.shell')) return;
      registration.shell = component;
    },
    addGlobalCss(css: string) {
      if (!requirePermission(plugin, 'ui.css.global')) return;
      registration.css.push(css);
      registration.cleanup.push(addStyle(plugin.id, css));
    },
    registerToolHandler(
      name: string,
      handler: (input: { tool: string; arguments: unknown }) => unknown,
    ) {
      registration.toolHandlers.set(name, handler);
    },
    registerCommandHandler(name: string, handler: (params: unknown) => unknown) {
      registration.commands.set(name, handler);
    },
    on(event: string, handler: (detail: unknown) => void) {
      const byEvent = eventHandlers.get(plugin.id) ?? new Map();
      const set = byEvent.get(event) ?? new Set();
      set.add(handler);
      byEvent.set(event, set);
      eventHandlers.set(plugin.id, byEvent);
      registration.cleanup.push(() => set.delete(handler));
      return () => set.delete(handler);
    },
    rpc: (method: string, params?: unknown) => api.pluginRpc(plugin.id, method, params ?? {}),
    openView(viewId: string) {
      usePluginStore.getState().openView(plugin.id, viewId);
    },
    openPanel(panelId: string) {
      usePluginStore.getState().openPanel(plugin.id, panelId);
    },
    closeOverlays() {
      usePluginStore.getState().closeOverlays();
    },
    layoutMode() {
      return useUiStore.getState().layoutMode;
    },
    /** Trusted lane only: explicit access to the host Zustand stores. */
    stores: {
      ui: {
        getState: useUiStore.getState,
        setState: useUiStore.setState,
        subscribe: useUiStore.subscribe,
      },
      app: {
        getState: useAppStore.getState,
        setState: useAppStore.setState,
        subscribe: useAppStore.subscribe,
      },
      chat: {
        getState: useChatStore.getState,
        setState: useChatStore.setState,
        subscribe: useChatStore.subscribe,
      },
    },
    notify(title: string, body = '') {
      void api
        .pluginRpc(plugin.id, 'notify', { title, body })
        .catch((error) =>
          toast.error(title, { description: String(error), duration: 5000 }),
        );
    },
    log,
    t(key: string, fallback?: string) {
      return i18n.t(`plugins:${plugin.id}.${key}`, {
        defaultValue: fallback ?? key,
      }) as string;
    },
  };
  return host;
}

export function emitTrustedEvent(pluginId: string, event: string, detail: unknown): boolean {
  const byEvent = eventHandlers.get(pluginId);
  const handlers = byEvent?.get(event);
  if (!handlers || handlers.size === 0) return false;
  for (const handler of [...handlers]) {
    try {
      handler(detail);
    } catch (error) {
      console.error(`[plugin ${pluginId}] ${event} handler failed`, error);
    }
  }
  return true;
}

export async function loadTrustedPlugin(plugin: PluginRecord): Promise<void> {
  if (loaded.has(plugin.id)) return;
  const settings = usePluginStore.getState().snapshot;
  if (!plugin.trusted || !settings.allowTrusted) return;
  if (!pluginHasPermission(plugin, 'unsafe.renderer')) {
    toast.error(i18n.t('plugins:errors.trustedPermission'), { description: plugin.name });
    return;
  }
  const entry = plugin.mainScript;
  if (!entry) return;
  let source: string;
  try {
    source = await api.pluginAssetText(plugin.id, entry);
  } catch (error) {
    toast.error(i18n.t('plugins:errors.trustedLoadFailed', { name: plugin.name }), {
      description: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const registration: TrustedRegistration = {
    pluginId: plugin.id,
    views: new Map(),
    panels: new Map(),
    slots: new Map(),
    settingsTabs: new Map(),
    artifactViewers: new Map(),
    components: new Map(),
    overrides: new Map(),
    wrappers: new Map(),
    shell: null,
    css: [],
    toolHandlers: new Map(),
    commands: new Map(),
    cleanup: [],
  };
  const host = createHost(plugin, registration);
  let definition: {
    activate?: (host: unknown) => unknown;
    deactivate?: () => void;
  } | null = null;
  (host as unknown as Record<string, unknown>).registerPlugin = (value: typeof definition) => {
    definition = value;
  };
  try {
    // Trusted code is the explicit, opt-in lane. The Function constructor is
    // the documented loader boundary; no non-trusted plugin reaches this path.
    const factory = new Function(
      'host',
      'React',
      'ReactDOM',
      'jsx',
      'jsxs',
      'Fragment',
      `${source}\n//# sourceURL=zplugin://${plugin.id}/${entry}`,
    );
    factory(
      host,
      React,
      ReactDOM,
      jsxRuntime.jsx,
      jsxRuntime.jsxs,
      jsxRuntime.Fragment,
    );
    const activation = definition as {
      activate?: (host: unknown) => unknown;
      deactivate?: () => void;
    } | null;
    if (activation && typeof activation.activate === 'function') {
      await Promise.race([
        Promise.resolve(activation.activate(host)),
        new Promise((_, reject) =>
          window.setTimeout(
            () => reject(new Error('PLUGIN_TRUSTED_ACTIVATE_TIMEOUT')),
            5_000,
          ),
        ),
      ]);
    }
    registerTrustedPlugin(registration);
    loaded.set(plugin.id, {
      registration,
      deactivate: activation?.deactivate?.bind(activation),
    });
    failures.delete(plugin.id);
  } catch (error) {
    unregisterSafe(registration);
    const count = (failures.get(plugin.id) ?? 0) + 1;
    failures.set(plugin.id, count);
    console.error(`[plugin ${plugin.id}] trusted load failed`, error);
    toast.error(i18n.t('plugins:errors.trustedLoadFailed', { name: plugin.name }), {
      description: error instanceof Error ? error.message : String(error),
    });
    if (count >= 3) {
      await api.setPluginEnabled(plugin.id, false).catch(() => {});
      await usePluginStore.getState().reload();
    }
  }
}

function unregisterSafe(registration: TrustedRegistration) {
  for (const cleanup of registration.cleanup) {
    try {
      cleanup();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export function loadedTrustedPluginIds(): string[] {
  return [...loaded.keys()];
}

export function unloadTrustedPlugin(pluginId: string) {
  const entry = loaded.get(pluginId);
  if (!entry) return;
  try {
    entry.deactivate?.();
  } catch {
    // A failing deactivate cannot keep the plugin mounted.
  }
  unregisterSafe(entry.registration);
  unregisterTrustedPlugin(pluginId);
  loaded.delete(pluginId);
  eventHandlers.delete(pluginId);
  document
    .querySelectorAll(`style[data-zylara-plugin-css="${CSS.escape(pluginId)}"]`)
    .forEach((style) => style.remove());
}

export function unloadAllTrusted() {
  for (const pluginId of [...loaded.keys()]) unloadTrustedPlugin(pluginId);
}
