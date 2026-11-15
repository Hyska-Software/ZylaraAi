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
import type { SettingsTabId } from '@/lib/settingsTabs';
import {
  PLUGIN_UI_LIMITS,
  pluginComponentExists,
  pluginComponentSpec,
  pluginSlotSpec,
} from './contract';
import type {
  CssEntry,
  GenuiComponentSpec,
  LayoutId,
  NavEntry,
  PageSpec,
  PanelTabSpec,
  PresetSpec,
  SettingsTabSpec,
  SlotContribution,
  StyleRecipe,
  VariantSpec,
} from './ui/types';
import {
  pluginHasPermission,
  registerTrustedPlugin,
  unregisterTrustedPlugin,
  type PluginComponent,
  type TrustedRegistration,
} from './registry';
import { usePluginStore } from './store';
import { pluginUiState } from './ui/registry';
import type { PluginRecord } from './types';

const loaded = new Map<
  string,
  { registration: TrustedRegistration; deactivate?: () => void; version: string }
>();
const failures = new Map<string, number>();
const eventHandlers = new Map<string, Map<string, Set<(detail: unknown) => void>>>();

function requirePermission(plugin: PluginRecord, permission: string): boolean {
  if (pluginHasPermission(plugin, permission)) return true;
  toast.error(i18n.t('plugins:errors.permissionDenied', { permission }), {
    description: plugin.name,
  });
  return false;
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
    ui: (() => {
      let seq = 0;
      const allLayouts: LayoutId[] = ['chat', 'code', 'agent'];
      const ensure = (permission: string) => {
        if (pluginHasPermission(plugin, permission)) return;
        log('warn', `PLUGIN_PERMISSION_DENIED: ${permission}`);
        throw new Error(`PLUGIN_PERMISSION_DENIED: ${permission}`);
      };
      const keyFor = (kind: string, id: string) => `${plugin.id}:ui:${kind}:${id}:${++seq}`;
      const base = (
        kind: string,
        id: string,
        layouts: LayoutId[] | undefined,
        order = 100,
        priority = 100,
      ) => ({
        key: keyFor(kind, id),
        plugin,
        pluginId: plugin.id,
        source: 'trusted' as const,
        layouts: layouts?.length ? layouts : allLayouts,
        order,
        priority,
      });
      const dispose = <T extends { key: string }>(list: T[], key: string) => () => {
        const index = list.findIndex((entry) => entry.key === key);
        if (index >= 0) list.splice(index, 1);
      };
      return {
        registerSlot(
          spec: {
            slot: string;
            id: string;
            order?: number;
            priority?: number;
            layouts?: LayoutId[];
            key?: string | null;
            when?: Record<string, string | number | boolean> | null;
            select?: (owner: Record<string, unknown>) => unknown | null;
          },
          component: PluginComponent,
        ) {
          ensure(`ui.slot:${spec.slot}`);
          const slotSpec = pluginSlotSpec(spec.slot);
          if (!slotSpec) throw new Error(`EPLUGIN_UNKNOWN_SLOT: ${spec.slot}`);
          if (registration.uiSlots.length >= PLUGIN_UI_LIMITS.slotEntriesPerPlugin) {
            throw new Error('PLUGIN_LIMIT_REACHED: slots');
          }
          const entry: SlotContribution = {
            ...base('slot', spec.id, spec.layouts, spec.order, spec.priority),
            slot: spec.slot,
            entryId: spec.id,
            kind: slotSpec.kind,
            keyMatch: spec.key ?? null,
            component,
            entry: null,
            action: null,
            title: null,
            titleKey: null,
            icon: null,
            when: spec.when ?? null,
            select: spec.select,
          };
          registration.uiSlots.push(entry);
          return dispose(registration.uiSlots, entry.key);
        },
        replace(
          spec: { component: string; id?: string; priority?: number; layouts?: LayoutId[] },
          component: PluginComponent,
        ) {
          if (!pluginComponentExists(spec.component)) {
            throw new Error(`unknown component id: ${spec.component}`);
          }
          ensure(`ui.override:${spec.component}`);
          if (registration.uiReplacements.length >= 64) {
            throw new Error('PLUGIN_LIMIT_REACHED: replacements');
          }
          const entry = {
            ...base('replace', spec.id ?? spec.component, spec.layouts, 100, spec.priority),
            component: spec.component,
            entryId: spec.id ?? spec.component,
            componentFn: component,
          };
          registration.uiReplacements.push(entry);
          return dispose(registration.uiReplacements, entry.key);
        },
        wrap(
          spec: {
            component: string;
            id: string;
            order?: number;
            priority?: number;
            layouts?: LayoutId[];
          },
          wrapper: PluginComponent,
        ) {
          if (!pluginComponentExists(spec.component)) {
            throw new Error(`unknown component id: ${spec.component}`);
          }
          ensure(`ui.override:${spec.component}`);
          const entry = {
            ...base('wrap', `${spec.component}:${spec.id}`, spec.layouts, spec.order, spec.priority),
            component: spec.component,
            entryId: spec.id,
            wrapper,
          };
          registration.uiWraps.push(entry);
          return dispose(registration.uiWraps, entry.key);
        },
        registerVariant(spec: {
          component: string;
          id: string;
          title: string;
          layouts?: LayoutId[];
          recipe: StyleRecipe;
        }) {
          ensure('ui.variant');
          const component = pluginComponentSpec(spec.component);
          if (!component || component.variants.length === 0) {
            throw new Error(`PLUGIN_COMPONENT_HAS_NO_VARIANTS: ${spec.component}`);
          }
          const entry: VariantSpec = {
            ...base('variant', `${spec.component}:${spec.id}`, spec.layouts),
            component: spec.component,
            variantId: spec.id,
            title: spec.title,
            recipe: spec.recipe,
          };
          registration.uiVariants.push(entry);
          return dispose(registration.uiVariants, entry.key);
        },
        registerPreset(spec: {
          id: string;
          title: string;
          layouts?: LayoutId[];
          tokens?: { light?: Record<string, string>; dark?: Record<string, string> };
          density?: 'compact' | 'comfortable' | 'spacious' | null;
          variants?: Record<string, string>;
          css?: string | null;
        }) {
          ensure('ui.preset');
          const entry: PresetSpec = {
            ...base('preset', spec.id, spec.layouts),
            source: 'plugin',
            presetId: spec.id,
            title: spec.title,
            tokens: {
              light: spec.tokens?.light ?? {},
              dark: spec.tokens?.dark ?? {},
            },
            density: spec.density ?? null,
            variants: spec.variants ?? {},
            css: spec.css ?? null,
          };
          registration.uiPresets.push(entry);
          return dispose(registration.uiPresets, entry.key);
        },
        registerPage(
          spec: {
            id: string;
            title: string;
            titleKey?: string | null;
            icon?: string | null;
            layouts?: LayoutId[];
            order?: number;
          },
          component: PluginComponent,
        ) {
          ensure('ui.view');
          if (registration.uiPages.length >= PLUGIN_UI_LIMITS.pagesPerPlugin) {
            throw new Error('PLUGIN_LIMIT_REACHED: pages');
          }
          const entry: PageSpec = {
            ...base('page', spec.id, spec.layouts, spec.order),
            pageId: spec.id,
            title: spec.title,
            titleKey: spec.titleKey ?? null,
            icon: spec.icon ?? null,
            entry: null,
            component,
          };
          registration.uiPages.push(entry);
          return dispose(registration.uiPages, entry.key);
        },
        registerPanelTab(
          spec: {
            id: string;
            title: string;
            titleKey?: string | null;
            icon?: string | null;
            layouts?: LayoutId[];
            order?: number;
          },
          component: PluginComponent,
        ) {
          ensure('ui.panel');
          if (registration.uiPanelTabs.length >= PLUGIN_UI_LIMITS.panelTabsPerPlugin) {
            throw new Error('PLUGIN_LIMIT_REACHED: panel tabs');
          }
          const entry: PanelTabSpec = {
            ...base('panel', spec.id, spec.layouts, spec.order),
            tabId: spec.id,
            title: spec.title,
            titleKey: spec.titleKey ?? null,
            icon: spec.icon ?? null,
            entry: null,
            component,
            takeover: false,
          };
          registration.uiPanelTabs.push(entry);
          return dispose(registration.uiPanelTabs, entry.key);
        },
        registerSettingsTab(
          spec: {
            id: string;
            title: string;
            titleKey?: string | null;
            icon?: string | null;
            order?: number;
          },
          component: PluginComponent,
        ) {
          ensure('ui.settings');
          const entry: SettingsTabSpec = {
            ...base('settings', spec.id, allLayouts, spec.order),
            tabId: spec.id,
            title: spec.title,
            titleKey: spec.titleKey ?? null,
            icon: spec.icon ?? null,
            entry: null,
            component,
          };
          registration.uiSettingsTabs.push(entry);
          return dispose(registration.uiSettingsTabs, entry.key);
        },
        registerNav(spec: {
          id: string;
          title: string;
          titleKey?: string | null;
          icon: string;
          page: string;
          layouts?: LayoutId[];
          order?: number;
          badge?: string | null;
        }) {
          ensure('ui.nav');
          if (registration.uiNav.length >= PLUGIN_UI_LIMITS.navEntriesPerPlugin) {
            throw new Error('PLUGIN_LIMIT_REACHED: nav');
          }
          const entry: NavEntry = {
            key: keyFor('nav', spec.id),
            source: 'plugin',
            pluginId: plugin.id,
            plugin,
            id: spec.id,
            title: spec.title,
            titleKey: spec.titleKey ?? null,
            icon: spec.icon,
            page: spec.page,
            layouts: spec.layouts?.length ? spec.layouts : allLayouts,
            order: spec.order ?? 200,
            badge: spec.badge ?? null,
          };
          registration.uiNav.push(entry);
          return dispose(registration.uiNav, entry.key);
        },
        registerGenuiComponent(
          spec: {
            id: string;
            title: string;
            summary: string;
            props: Record<string, Record<string, unknown>>;
          },
          component: PluginComponent,
        ) {
          ensure('ui.genui');
          if (registration.uiGenui.length >= PLUGIN_UI_LIMITS.genuiComponentsPerPlugin) {
            throw new Error('PLUGIN_LIMIT_REACHED: genui');
          }
          const entry: GenuiComponentSpec = {
            key: keyFor('genui', spec.id),
            pluginId: plugin.id,
            plugin,
            type: `plugin:${plugin.id}:${spec.id}`,
            id: spec.id,
            title: spec.title,
            summary: spec.summary,
            props: spec.props,
            render: { kind: 'trusted', component: spec.id },
            component,
          };
          registration.uiGenui.push(entry);
          return dispose(registration.uiGenui, entry.key);
        },
        addCss(css: string, opts?: { layouts?: LayoutId[]; id?: string }) {
          ensure('ui.css.global');
          const id = opts?.id ?? `css-${++seq}`;
          const entry: CssEntry = {
            key: keyFor('css', id),
            pluginId: plugin.id,
            plugin,
            id,
            file: null,
            css,
            layouts: opts?.layouts?.length ? opts.layouts : allLayouts,
            order: 100,
          };
          registration.uiCss.push(entry);
          return dispose(registration.uiCss, entry.key);
        },
        openPage(pageId: string, opts?: { layout?: LayoutId }) {
          const layout = opts?.layout ?? useUiStore.getState().layoutMode;
          useUiStore.getState().openPluginPage({ pluginId: plugin.id, pageId }, layout);
        },
        openPanelTab(tabId: string, opts?: { layout?: LayoutId }) {
          const layout = opts?.layout ?? useUiStore.getState().layoutMode;
          const tab = pluginUiState().panelTabs.find(
            (entry) => entry.pluginId === plugin.id && entry.tabId === tabId,
          );
          if (tab) useUiStore.getState().openPluginDockTab(tab.key, layout);
        },
        closePanelTab() {
          useUiStore.getState().closePluginDockTab();
        },
        setLayout(layout: LayoutId) {
          useUiStore.getState().setLayoutMode(layout);
        },
        openSettings(tab?: string) {
          useUiStore.getState().openSettings(tab as SettingsTabId | undefined);
        },
        toast(title: string, body = '') {
          toast.info(title, { description: body || undefined });
        },
        inspect() {
          return {
            slots: registration.uiSlots.map((entry) => entry.slot),
            components: registration.uiReplacements.map((entry) => entry.component),
            pages: registration.uiPages.map((entry) => entry.pageId),
            nav: registration.uiNav.map((entry) => entry.id),
          };
        },
      };
    })(),
    commands: {
      register(
        spec: {
          id: string;
          title: string;
          description?: string;
          icon?: string;
          hotkey?: string;
          command?: string;
        },
        handler: (params: unknown) => unknown,
      ) {
        if (!pluginHasPermission(plugin, 'ui.command')) {
          log('warn', 'PLUGIN_PERMISSION_DENIED: ui.command');
          throw new Error('PLUGIN_PERMISSION_DENIED: ui.command');
        }
        const command = {
          id: spec.id,
          title: spec.title,
          description: spec.description,
          icon: spec.icon,
          hotkey: spec.hotkey,
          command: spec.command,
          action: { kind: 'execute' as const, method: spec.id },
        };
        registration.uiCommands.push(command);
        registration.commands.set(spec.id, handler);
        return () => {
          const index = registration.uiCommands.findIndex((entry) => entry.id === spec.id);
          if (index >= 0) registration.uiCommands.splice(index, 1);
          registration.commands.delete(spec.id);
        };
      },
    },
    chat: {
      conversationId() {
        return useChatStore.getState().activeId;
      },
      messages() {
        if (!pluginHasPermission(plugin, 'chat.read')) {
          throw new Error('PLUGIN_PERMISSION_DENIED: chat.read');
        }
        const id = useChatStore.getState().activeId;
        return id ? useChatStore.getState().messagesByConversation[id] ?? [] : [];
      },
      insertDraft(text: string, mode: 'append' | 'replace' = 'append') {
        if (!pluginHasPermission(plugin, 'chat.write')) {
          throw new Error('PLUGIN_PERMISSION_DENIED: chat.write');
        }
        window.dispatchEvent(
          new CustomEvent('zylara:insert-draft', {
            detail: { text, mode },
          }),
        );
      },
    },
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
      registration.uiCss.push({
        key: `${plugin.id}:css:legacy:${registration.uiCss.length}`,
        pluginId: plugin.id,
        plugin,
        id: `legacy-${registration.uiCss.length}`,
        file: null,
        css,
        layouts: ['chat', 'code', 'agent'],
        order: 100,
      });
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
      useUiStore.getState().openPluginPage({ pluginId: plugin.id, pageId: viewId });
    },
    openPanel(panelId: string) {
      const tab = pluginUiState().panelTabs.find(
        (entry) => entry.pluginId === plugin.id && entry.tabId === panelId,
      );
      if (tab) useUiStore.getState().openPluginDockTab(tab.key);
    },
    closeOverlays() {
      const state = useUiStore.getState();
      state.closePluginPage();
      state.closePluginDockTab();
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
  const existing = loaded.get(plugin.id);
  if (existing) {
    if (existing.version === plugin.version) return;
    unloadTrustedPlugin(plugin.id);
  }
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
    uiSlots: [],
    uiPages: [],
    uiPanelTabs: [],
    uiNav: [],
    uiSettingsTabs: [],
    uiArtifactViewers: [],
    uiVariants: [],
    uiPresets: [],
    uiCss: [],
    uiGenui: [],
    uiReplacements: [],
    uiWraps: [],
    uiCommands: [],
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
      version: plugin.version,
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
