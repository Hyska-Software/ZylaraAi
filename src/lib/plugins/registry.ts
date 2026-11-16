/**
 * Merged contribution registry for declarative, sandboxed and trusted plugins.
 *
 * The backend is the authority for which plugins are active and which
 * permissions are granted; this module only projects the snapshot into UI
 * lists. Trusted registrations are added by the main-webview loader and removed
 * on disable/safe mode.
 */
import { type ComponentType } from 'react';
import { useSyncExternalStore } from 'react';
import { t } from '@/lib/i18n';
import { pluginI18nKey } from './i18n';
import {
  PLUGIN_SLOTS,
  pluginPermissionBase,
  pluginPermissionSpec,
} from './contract';
import type {
  ArtifactViewerContribution,
  CommandContribution,
  PanelContribution,
  PluginAction,
  PluginLayoutId,
  PluginManifest,
  PluginPermissionView,
  PluginRecord,
  PluginSnapshot,
  SettingsTabContribution,
  SlotContribution as ManifestSlotContribution,
  ViewContribution,
} from './types';
import { setPluginUiState } from './ui/registry';
import type {
  ArtifactViewerSpec,
  ComponentReplacement,
  ComponentWrap,
  CssEntry,
  GenuiComponentSpec,
  NavEntry,
  PageSpec,
  PanelTabSpec,
  PresetSpec,
  SettingsTabSpec,
  SlotContribution as UiSlotContribution,
  VariantSpec,
} from './ui/types';
export type PluginComponent = ComponentType<Record<string, unknown>>;

export interface TrustedRegistration {
  pluginId: string;
  views: Map<string, PluginComponent>;
  panels: Map<string, PluginComponent>;
  slots: Map<string, PluginComponent>;
  settingsTabs: Map<string, PluginComponent>;
  artifactViewers: Map<string, PluginComponent>;
  components: Map<string, PluginComponent>;
  overrides: Map<string, PluginComponent>;
  wrappers: Map<string, PluginComponent[]>;
  shell: PluginComponent | null;
  uiSlots: UiSlotContribution[];
  uiPages: PageSpec[];
  uiPanelTabs: PanelTabSpec[];
  uiNav: NavEntry[];
  uiSettingsTabs: SettingsTabSpec[];
  uiArtifactViewers: ArtifactViewerSpec[];
  uiVariants: VariantSpec[];
  uiPresets: PresetSpec[];
  uiCss: CssEntry[];
  uiGenui: GenuiComponentSpec[];
  uiReplacements: ComponentReplacement[];
  uiWraps: ComponentWrap[];
  uiCommands: CommandContribution[];
  toolHandlers: Map<string, (input: { tool: string; arguments: unknown }) => unknown>;
  commands: Map<string, (params: unknown) => unknown>;
  cleanup: Array<() => void>;
}

export interface ResolvedView {
  plugin: PluginRecord;
  view: ViewContribution;
  key: string;
  component: PluginComponent | null;
}

export interface ResolvedPanel {
  plugin: PluginRecord;
  panel: PanelContribution;
  key: string;
  component: PluginComponent | null;
}

export interface ResolvedCommand {
  plugin: PluginRecord;
  command: CommandContribution;
  key: string;
}

export interface ResolvedSettingsTab {
  plugin: PluginRecord;
  tab: SettingsTabContribution;
  key: string;
  component: PluginComponent | null;
}

export interface ResolvedArtifactViewer {
  plugin: PluginRecord;
  viewer: ArtifactViewerContribution;
  key: string;
  component: PluginComponent | null;
}

export interface PluginConflict {
  kind: 'command' | 'hotkey' | 'override';
  value: string;
  pluginId: string;
  otherPluginId: string;
}

export interface PluginRegistryState {
  snapshot: PluginSnapshot;
  plugins: PluginRecord[];
  views: ResolvedView[];
  panels: ResolvedPanel[];
  commands: ResolvedCommand[];
  settingsTabs: ResolvedSettingsTab[];
  artifactViewers: ResolvedArtifactViewer[];
  conflicts: PluginConflict[];
  revision: number;
}

const EMPTY_SNAPSHOT: PluginSnapshot = {
  plugins: [],
  safeMode: false,
  pluginsEnabled: true,
  allowTrusted: false,
  devMode: false,
  configFingerprint: '',
};

const trusted = new Map<string, TrustedRegistration>();
const listeners = new Set<() => void>();

function hasPermission(plugin: PluginRecord, required: string): boolean {
  const requiredBase = pluginPermissionBase(required);
  return plugin.permissions.some((permission) => {
    if (!permission.granted) return false;
    if (permission.id === required) return true;
    const base = pluginPermissionBase(permission.id);
    if (base !== requiredBase) return false;
    return permission.id.endsWith(':*') || permission.id === required;
  });
}

export function pluginHasPermission(plugin: PluginRecord, required: string): boolean {
  return hasPermission(plugin, required);
}

export function riskForPermission(permission: PluginPermissionView): string {
  return pluginPermissionSpec(pluginPermissionBase(permission.id))?.risk ?? permission.risk;
}

function trustedFor(pluginId: string): TrustedRegistration | null {
  return trusted.get(pluginId) ?? null;
}

let state: PluginRegistryState = {
  snapshot: EMPTY_SNAPSHOT,
  plugins: [],
  views: [],
  panels: [],
  commands: [],
  settingsTabs: [],
  artifactViewers: [],
  conflicts: [],
  revision: 0,
};

function activePlugins(snapshot: PluginSnapshot): PluginRecord[] {
  if (snapshot.safeMode || !snapshot.pluginsEnabled) return [];
  return snapshot.plugins.filter((plugin) => plugin.active && plugin.enabled);
}

const ALL_LAYOUTS: PluginLayoutId[] = ['chat', 'code', 'agent'];

function viewLayouts(view: ViewContribution): PluginLayoutId[] {
  if (view.layouts?.length) return view.layouts;
  if (view.surface === 'global' || !view.surface) return ALL_LAYOUTS;
  if (view.surface === 'chat' || view.surface === 'code' || view.surface === 'agent') {
    return [view.surface];
  }
  return ALL_LAYOUTS;
}

function build(snapshot: PluginSnapshot): PluginRegistryState {
  const plugins = activePlugins(snapshot);
  const views: ResolvedView[] = [];
  const panels: ResolvedPanel[] = [];
  const commands: ResolvedCommand[] = [];
  const commandsBySlash = new Map<string, string>();
  const commandsByHotkey = new Map<string, string>();
  const settingsTabs: ResolvedSettingsTab[] = [];
  const artifactViewers: ResolvedArtifactViewer[] = [];
  const conflicts: PluginConflict[] = [];
  const overrideOwners = new Map<string, string[]>();
  const shellOwners: string[] = [];
  const uiSlots: UiSlotContribution[] = [];
  const uiReplacements: ComponentReplacement[] = [];
  const uiWraps: ComponentWrap[] = [];
  const uiPages: PageSpec[] = [];
  const uiPanelTabs: PanelTabSpec[] = [];
  const uiNav: NavEntry[] = [];
  const uiSettingsTabs: SettingsTabSpec[] = [];
  const uiArtifactViewers: ArtifactViewerSpec[] = [];
  const uiVariants: VariantSpec[] = [];
  const uiPresets: PresetSpec[] = [];
  const uiCss: CssEntry[] = [];
  const uiGenui: GenuiComponentSpec[] = [];
  const allLayouts: PluginLayoutId[] = ['chat', 'code', 'agent'];
  for (const plugin of plugins) {
    const registration = trustedFor(plugin.id);
    if (registration) {
      for (const componentId of registration.overrides.keys()) {
        const owners = overrideOwners.get(componentId) ?? [];
        owners.push(plugin.id);
        overrideOwners.set(componentId, owners);
      }
      if (registration.shell) shellOwners.push(plugin.id);
    }
    if (hasPermission(plugin, 'ui.view')) {
      plugin.manifest.contributes.ui.views.forEach((view) => {
        const component =
          registration?.views.get(view.id) ?? registration?.components.get(view.id) ?? null;
        views.push({
          plugin,
          view,
          key: `${plugin.id}:${view.id}`,
          component,
        });
        const layouts = viewLayouts(view);
        uiPages.push({
          key: `${plugin.id}:page:${view.id}`,
          plugin,
          pluginId: plugin.id,
          source: registration ? 'trusted' : 'manifest',
          order: view.order ?? 100,
          priority: 100,
          layouts,
          pageId: view.id,
          title: view.title,
          titleKey: view.titleKey ?? null,
          icon: view.icon ?? null,
          entry: view.entry ?? null,
          component,
        });
        if (
          view.location === 'sidebar' &&
          plugin.manifest.contributes.ui.nav.length === 0 &&
          plugin.manifest.apiVersion < 2
        ) {
          uiNav.push({
            key: `${plugin.id}:nav:${view.id}`,
            source: 'plugin',
            pluginId: plugin.id,
            plugin,
            id: view.id,
            title: view.title,
            titleKey: view.titleKey ?? null,
            icon: view.icon ?? 'Puzzle',
            page: view.id,
            layouts,
            order: 500,
            badge: null,
          });
        }
      });
    }
    if (hasPermission(plugin, 'ui.nav')) {
      plugin.manifest.contributes.ui.nav.forEach((nav) => {
        uiNav.push({
          key: `${plugin.id}:nav:${nav.id}`,
          source: 'plugin',
          pluginId: plugin.id,
          plugin,
          id: nav.id,
          title: nav.title,
          titleKey: nav.titleKey ?? null,
          icon: nav.icon ?? 'Puzzle',
          page: nav.page,
          layouts: nav.layouts?.length ? nav.layouts : ALL_LAYOUTS,
          order: nav.order ?? 200,
          badge: nav.badge ?? null,
        });
      });
    }
    if (hasPermission(plugin, 'ui.panel')) {
      plugin.manifest.contributes.ui.panels.forEach((panel) => {
        const component =
          registration?.panels.get(panel.id) ?? registration?.components.get(panel.id) ?? null;
        const tab = panel.tab ?? plugin.manifest.apiVersion >= 2;
        panels.push({
          plugin,
          panel,
          key: `${plugin.id}:${panel.id}`,
          component,
        });
        uiPanelTabs.push({
          key: `${plugin.id}:panel:${panel.id}`,
          plugin,
          pluginId: plugin.id,
          source: registration ? 'trusted' : 'manifest',
          order: panel.order ?? 100,
          priority: 100,
          layouts: panel.layouts?.length ? panel.layouts : ALL_LAYOUTS,
          tabId: panel.id,
          title: panel.title,
          titleKey: panel.titleKey ?? null,
          icon: panel.icon ?? null,
          entry: panel.entry ?? null,
          component,
          takeover: !tab,
        });
      });
    }
    plugin.manifest.contributes.ui.slots.forEach((slot, index) => {
      if (!hasPermission(plugin, `ui.slot:${slot.slot}`)) return;
      const component =
        registration?.slots.get(slot.slot) ??
        registration?.components.get(`${slot.slot}:${index}`) ??
        (slot.component ? registration?.components.get(slot.component) ?? null : null);
      const spec = PLUGIN_SLOTS.find((entry) => entry.id === slot.slot);
      uiSlots.push({
        key: `${plugin.id}:slot:${slot.id ?? index}`,
        plugin,
        pluginId: plugin.id,
        source: 'manifest',
        order: slot.order ?? 100,
        priority: slot.priority ?? 100,
        layouts: slot.layouts?.length ? slot.layouts : allLayouts,
        slot: slot.slot,
        entryId: slot.id ?? `slot-${index}`,
        kind: spec?.kind ?? 'list',
        keyMatch: slot.key ?? null,
        component,
        entry: slot.entry ?? null,
        action: slot.action ?? null,
        title: slot.title ?? null,
        titleKey: slot.titleKey ?? null,
        icon: slot.icon ?? null,
        when: slot.when ?? null,
      });
    });
    if (registration) {
      for (const slotId of registration.slots.keys()) {
        if (plugin.manifest.contributes.ui.slots.some((slot) => slot.slot === slotId)) {
          continue;
        }
        uiSlots.push({
          key: `${plugin.id}:slot:${slotId}`,
          plugin,
          pluginId: plugin.id,
          source: 'trusted',
          order: 100,
          priority: 100,
          layouts: allLayouts,
          slot: slotId,
          entryId: slotId,
          kind: PLUGIN_SLOTS.find((entry) => entry.id === slotId)?.kind ?? 'list',
          keyMatch: null,
          component: registration.slots.get(slotId) ?? null,
          entry: null,
          action: null,
          title: null,
          titleKey: null,
          icon: null,
          when: null,
        });
      }
      for (const [componentId, componentFn] of registration.overrides) {
        uiReplacements.push({
          key: `${plugin.id}:replace:${componentId}`,
          plugin,
          pluginId: plugin.id,
          source: 'trusted',
          order: 100,
          priority: 100,
          layouts: allLayouts,
          component: componentId,
          entryId: componentId,
          componentFn,
        });
      }
      for (const [componentId, wrappers] of registration.wrappers) {
        wrappers.forEach((wrapper, index) => {
          uiWraps.push({
            key: `${plugin.id}:wrap:${componentId}:${index}`,
            plugin,
            pluginId: plugin.id,
            source: 'trusted',
            order: index * 10,
            priority: 100,
            layouts: allLayouts,
            component: componentId,
            entryId: `${componentId}:${index}`,
            wrapper,
          });
        });
      }
      if (registration.shell) {
        uiReplacements.push({
          key: `${plugin.id}:replace:layout.shell`,
          plugin,
          pluginId: plugin.id,
          source: 'trusted',
          order: 100,
          priority: 100,
          layouts: allLayouts,
          component: 'layout.shell',
          entryId: 'layout.shell',
          componentFn: registration.shell,
        });
      }
      uiSlots.push(...registration.uiSlots);
      uiPages.push(...registration.uiPages);
      uiPanelTabs.push(...registration.uiPanelTabs);
      uiNav.push(...registration.uiNav);
      uiSettingsTabs.push(...registration.uiSettingsTabs);
      uiArtifactViewers.push(...registration.uiArtifactViewers);
      uiVariants.push(...registration.uiVariants);
      uiPresets.push(...registration.uiPresets);
      uiCss.push(...registration.uiCss);
      uiGenui.push(...registration.uiGenui);
      uiReplacements.push(...registration.uiReplacements);
      uiWraps.push(...registration.uiWraps);
      for (const command of registration.uiCommands) {
        commands.push({ plugin, command, key: `${plugin.id}:runtime:${command.id}` });
      }
    }
    if (hasPermission(plugin, 'ui.command')) {
      plugin.manifest.contributes.ui.commands.forEach((command) => {
        const slash = `/${(command.command?.trim().replace(/^\//, '') || command.id).toLowerCase()}`;
        const slashOwner = commandsBySlash.get(slash);
        if (slashOwner) {
          conflicts.push({
            kind: 'command',
            value: slash,
            pluginId: plugin.id,
            otherPluginId: slashOwner,
          });
          return;
        }
        const hotkey = command.hotkey?.trim().toLowerCase();
        if (hotkey) {
          const hotkeyOwner = commandsByHotkey.get(hotkey);
          if (hotkeyOwner) {
            conflicts.push({
              kind: 'hotkey',
              value: hotkey,
              pluginId: plugin.id,
              otherPluginId: hotkeyOwner,
            });
            return;
          }
          commandsByHotkey.set(hotkey, plugin.id);
        }
        commandsBySlash.set(slash, plugin.id);
        commands.push({ plugin, command, key: `${plugin.id}:${command.id}` });
      });
    }
    if (hasPermission(plugin, 'ui.settings')) {
      plugin.manifest.contributes.ui.settingsTabs.forEach((tab) => {
        const component =
          registration?.settingsTabs.get(tab.id) ??
          registration?.components.get(tab.id) ??
          null;
        settingsTabs.push({
          plugin,
          tab,
          key: `${plugin.id}:${tab.id}`,
          component,
        });
        uiSettingsTabs.push({
          key: `${plugin.id}:settings:${tab.id}`,
          plugin,
          pluginId: plugin.id,
          source: registration ? 'trusted' : 'manifest',
          order: tab.order ?? 200,
          priority: 100,
          layouts: ALL_LAYOUTS,
          tabId: tab.id,
          title: tab.title,
          titleKey: tab.titleKey ?? null,
          icon: tab.icon ?? null,
          entry: tab.entry ?? null,
          component,
        });
      });
    }
    if (hasPermission(plugin, 'ui.artifact')) {
      plugin.manifest.contributes.artifactViewers.forEach((viewer) => {
        const component = registration?.artifactViewers.get(viewer.id) ?? null;
        artifactViewers.push({
          plugin,
          viewer,
          key: `${plugin.id}:${viewer.id}`,
          component,
        });
        uiArtifactViewers.push({
          key: `${plugin.id}:artifact:${viewer.id}`,
          plugin,
          pluginId: plugin.id,
          id: viewer.id,
          title: viewer.title,
          titleKey: viewer.titleKey ?? null,
          mimeTypes: viewer.mimeTypes,
          entry: viewer.entry ?? null,
          component,
          priority: viewer.priority,
        });
      });
    }
    if (hasPermission(plugin, 'ui.variant')) {
      plugin.manifest.contributes.ui.variants.forEach((variant) => {
        uiVariants.push({
          key: `${plugin.id}:variant:${variant.component}:${variant.id}`,
          plugin,
          pluginId: plugin.id,
          source: registration ? 'trusted' : 'manifest',
          order: 100,
          priority: 100,
          layouts: variant.layouts?.length ? variant.layouts : ALL_LAYOUTS,
          component: variant.component,
          variantId: variant.id,
          title: variant.title,
          recipe: variant.recipe,
        });
      });
    }
    if (hasPermission(plugin, 'ui.preset')) {
      plugin.manifest.contributes.ui.presets.forEach((preset) => {
        uiPresets.push({
          key: `${plugin.id}:preset:${preset.id}`,
          plugin,
          pluginId: plugin.id,
          source: 'plugin',
          order: 100,
          layouts: preset.layouts?.length ? preset.layouts : ALL_LAYOUTS,
          presetId: preset.id,
          title: preset.title,
          tokens: {
            light: preset.tokens?.light ?? {},
            dark: preset.tokens?.dark ?? {},
          },
          density: preset.density ?? null,
          variants: preset.variants ?? {},
          css: preset.css ?? null,
        });
      });
    }
    if (hasPermission(plugin, 'ui.css.global')) {
      plugin.manifest.contributes.ui.css.forEach((css) => {
        uiCss.push({
          key: `${plugin.id}:css:${css.id}`,
          pluginId: plugin.id,
          plugin,
          id: css.id,
          file: css.file,
          css: null,
          layouts: css.layouts?.length ? css.layouts : ALL_LAYOUTS,
          order: css.order ?? 100,
        });
      });
    }
    if (hasPermission(plugin, 'ui.genui')) {
      plugin.manifest.contributes.ui.genui.components.forEach((component) => {
        uiGenui.push({
          key: `${plugin.id}:genui:${component.id}`,
          pluginId: plugin.id,
          plugin,
          type: `plugin:${plugin.id}:${component.id}`,
          id: component.id,
          title: component.title,
          summary: component.summary,
          props: component.props,
          render: component.render,
          component:
            component.render.component
              ? registration?.components.get(component.render.component) ?? null
              : null,
        });
      });
    }
  }
  for (const [componentId, owners] of overrideOwners) {
    if (owners.length > 1) {
      conflicts.push({
        kind: 'override',
        value: componentId,
        pluginId: owners[0],
        otherPluginId: owners[1],
      });
    }
  }
  if (shellOwners.length > 1) {
    conflicts.push({
      kind: 'override',
      value: 'layout.shell',
      pluginId: shellOwners[0],
      otherPluginId: shellOwners[1],
    });
  }
  artifactViewers.sort(
    (left, right) =>
      left.viewer.priority - right.viewer.priority ||
      left.plugin.id.localeCompare(right.plugin.id) ||
      left.viewer.id.localeCompare(right.viewer.id),
  );
  setPluginUiState({
    slots: uiSlots,
    replacements: uiReplacements,
    wraps: uiWraps,
    pages: uiPages,
    panelTabs: uiPanelTabs,
    nav: uiNav,
    settingsTabs: uiSettingsTabs,
    artifactViewers: uiArtifactViewers,
    variants: uiVariants,
    presets: uiPresets,
    css: uiCss,
    genui: uiGenui,
  });
  return {
    snapshot,
    plugins,
    views,
    panels,
    commands,
    settingsTabs,
    artifactViewers,
    conflicts,
    revision: state.revision + 1,
  };
}

function commit(next: PluginRegistryState) {
  state = next;
  for (const listener of [...listeners]) listener();
}

export function setPluginSnapshot(snapshot: PluginSnapshot) {
  commit(build(snapshot));
}

export function getPluginRegistryState(): PluginRegistryState {
  return state;
}

export function subscribePluginRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginRegistry(): PluginRegistryState {
  return useSyncExternalStore(
    subscribePluginRegistry,
    getPluginRegistryState,
    getPluginRegistryState,
  );
}

export function registerTrustedPlugin(registration: TrustedRegistration) {
  if (trusted.has(registration.pluginId)) {
    unregisterTrustedPlugin(registration.pluginId);
  }
  trusted.set(registration.pluginId, registration);
  commit(build(state.snapshot));
}

/** Republishes an already registered trusted plugin after a dynamic change. */
export function refreshTrustedPlugin(pluginId: string) {
  if (!trusted.has(pluginId)) return;
  commit(build(state.snapshot));
}

export function unregisterTrustedPlugin(pluginId: string) {
  const registration = trusted.get(pluginId);
  if (!registration) return;
  for (const cleanup of registration.cleanup) {
    try {
      cleanup();
    } catch {
      // A plugin cleanup failure must not keep its registrations alive.
    }
  }
  trusted.delete(pluginId);
  commit(build(state.snapshot));
}

export function trustedPluginRegistration(pluginId: string): TrustedRegistration | null {
  return trustedFor(pluginId);
}

export function pluginById(pluginId: string): PluginRecord | undefined {
  return state.plugins.find((plugin) => plugin.id === pluginId);
}

export function viewByKey(key: string | null | undefined): ResolvedView | undefined {
  if (!key) return undefined;
  return state.views.find((view) => view.key === key);
}

export function panelByKey(key: string | null | undefined): ResolvedPanel | undefined {
  if (!key) return undefined;
  return state.panels.find((panel) => panel.key === key);
}

export function commandByKey(key: string): ResolvedCommand | undefined {
  return state.commands.find((command) => command.key === key);
}

export function pluginViewsForSurface(
  surface: 'chat' | 'code' | 'agent' | 'global',
  location: 'main' | 'sidebar',
): ResolvedView[] {
  return state.views.filter(
    (view) =>
      (view.view.surface === surface || view.view.surface === 'global') &&
      view.view.location === location &&
      (surface === 'global' || viewLayouts(view.view).includes(surface)),
  );
}

export function artifactViewerForMime(
  mimeType: string,
): ResolvedArtifactViewer | undefined {
  const normalized = mimeType.trim().toLowerCase();
  return state.artifactViewers.find((viewer) =>
    viewer.viewer.mimeTypes.some((mime) => {
      const pattern = mime.trim().toLowerCase();
      if (pattern === normalized) return true;
      if (pattern.endsWith('/*')) {
        return normalized.startsWith(pattern.slice(0, -1));
      }
      return false;
    }),
  );
}

export function pluginLabel(
  plugin: PluginRecord,
  key: string | null | undefined,
  fallback: string,
): string {
  if (!key) return fallback;
  if (key.includes(':')) return t(key);
  return t(`plugins:${pluginI18nKey(plugin.id)}.${key}`, { defaultValue: fallback }) as string;
}

export function pluginT(
  pluginId: string,
  key: string | null | undefined,
  fallback: string,
): string {
  if (!key) return fallback;
  if (key.includes(':')) return t(key) as string;
  return t(`plugins:${pluginI18nKey(pluginId)}.${key}`, { defaultValue: fallback }) as string;
}

export function pluginManifest(pluginId: string): PluginManifest | undefined {
  return pluginById(pluginId)?.manifest;
}

export interface PluginActionContext {
  conversationId?: string | null;
}

export function pluginActionKey(action: PluginAction): string {
  switch (action.kind) {
    case 'openView':
      return `view:${action.target}`;
    case 'openPanel':
      return `panel:${action.target}`;
    case 'insertDraft':
      return 'insertDraft';
    case 'openExternal':
      return `external:${action.url}`;
    case 'execute':
      return `execute:${action.method}`;
    default:
      return 'unknown';
  }
}

/** Permission needed to execute a declarative action in a plugin's UI. */
export function actionPermission(action: PluginAction): string | null {
  switch (action.kind) {
    case 'insertDraft':
      return 'chat.write';
    case 'openExternal':
      return 'opener';
    case 'execute':
      return 'commands';
    default:
      return null;
  }
}
