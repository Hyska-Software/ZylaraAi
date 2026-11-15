/**
 * Merged contribution registry for declarative, sandboxed and trusted plugins.
 *
 * The backend is the authority for which plugins are active and which
 * permissions are granted; this module only projects the snapshot into UI
 * lists. Trusted registrations are added by the main-webview loader and removed
 * on disable/safe mode.
 */
import { createElement, type ComponentType, type ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { t } from '@/lib/i18n';
import {
  pluginComponentExists,
  pluginPermissionBase,
  pluginPermissionSpec,
} from './contract';
import type {
  ArtifactViewerContribution,
  CommandContribution,
  PanelContribution,
  PluginAction,
  PluginManifest,
  PluginPermissionView,
  PluginRecord,
  PluginSnapshot,
  SettingsTabContribution,
  SlotContribution,
  ThemeContribution,
  ViewContribution,
} from './types';

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
  css: string[];
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

export interface ResolvedSlot {
  plugin: PluginRecord;
  slot: SlotContribution;
  index: number;
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

export interface ResolvedTheme {
  plugin: PluginRecord;
  theme: ThemeContribution;
  key: string;
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
  slots: ResolvedSlot[];
  commands: ResolvedCommand[];
  settingsTabs: ResolvedSettingsTab[];
  artifactViewers: ResolvedArtifactViewer[];
  themes: ResolvedTheme[];
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
  slots: [],
  commands: [],
  settingsTabs: [],
  artifactViewers: [],
  themes: [],
  conflicts: [],
  revision: 0,
};

function activePlugins(snapshot: PluginSnapshot): PluginRecord[] {
  if (snapshot.safeMode || !snapshot.pluginsEnabled) return [];
  return snapshot.plugins.filter((plugin) => plugin.active && plugin.enabled);
}

function build(snapshot: PluginSnapshot): PluginRegistryState {
  const plugins = activePlugins(snapshot);
  const views: ResolvedView[] = [];
  const panels: ResolvedPanel[] = [];
  const slots: ResolvedSlot[] = [];
  const commands: ResolvedCommand[] = [];
  const commandsBySlash = new Map<string, string>();
  const commandsByHotkey = new Map<string, string>();
  const settingsTabs: ResolvedSettingsTab[] = [];
  const artifactViewers: ResolvedArtifactViewer[] = [];
  const themes: ResolvedTheme[] = [];
  const conflicts: PluginConflict[] = [];
  const overrideOwners = new Map<string, string[]>();
  const shellOwners: string[] = [];
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
        views.push({
          plugin,
          view,
          key: `${plugin.id}:${view.id}`,
          component: registration?.views.get(view.id) ?? registration?.components.get(view.id) ?? null,
        });
      });
    }
    if (hasPermission(plugin, 'ui.panel')) {
      plugin.manifest.contributes.ui.panels.forEach((panel) => {
        panels.push({
          plugin,
          panel,
          key: `${plugin.id}:${panel.id}`,
          component:
            registration?.panels.get(panel.id) ??
            registration?.components.get(panel.id) ??
            null,
        });
      });
    }
    plugin.manifest.contributes.ui.slots.forEach((slot, index) => {
      if (!hasPermission(plugin, `ui.slot:${slot.slot}`)) return;
      slots.push({
        plugin,
        slot,
        index,
        key: `${plugin.id}:${slot.slot}:${index}`,
        component:
          registration?.slots.get(slot.slot) ??
          registration?.components.get(`${slot.slot}:${index}`) ??
          null,
      });
    });
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
        settingsTabs.push({
          plugin,
          tab,
          key: `${plugin.id}:${tab.id}`,
          component: registration?.settingsTabs.get(tab.id) ?? null,
        });
      });
    }
    if (hasPermission(plugin, 'ui.artifact')) {
      plugin.manifest.contributes.artifactViewers.forEach((viewer) => {
        artifactViewers.push({
          plugin,
          viewer,
          key: `${plugin.id}:${viewer.id}`,
          component: registration?.artifactViewers.get(viewer.id) ?? null,
        });
      });
    }
    if (hasPermission(plugin, 'ui.theme')) {
      plugin.manifest.contributes.ui.themes.forEach((theme) => {
        themes.push({ plugin, theme, key: `${plugin.id}:${theme.id}` });
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
  slots.sort(
    (left, right) =>
      left.plugin.id.localeCompare(right.plugin.id) || left.index - right.index,
  );
  return {
    snapshot,
    plugins,
    views,
    panels,
    slots,
    commands,
    settingsTabs,
    artifactViewers,
    themes,
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
  trusted.set(registration.pluginId, registration);
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

export function slotEntries(slotId: string): ResolvedSlot[] {
  return state.slots.filter((entry) => entry.slot.slot === slotId);
}

export function pluginViewsForSurface(
  surface: 'chat' | 'code' | 'agent' | 'global',
  location: 'main' | 'sidebar',
): ResolvedView[] {
  return state.views.filter(
    (view) =>
      (view.view.surface === surface || view.view.surface === 'global') &&
      view.view.location === location,
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

export function getComponentOverride(id: string): PluginComponent | null {
  if (!pluginComponentExists(id)) return null;
  const matches = [...trusted.values()]
    .map((registration) => registration.overrides.get(id))
    .filter((component): component is PluginComponent => Boolean(component));
  // Two trusted plugins claiming the same component is a conflict: apply
  // neither until the user disables one. This avoids silent precedence.
  return matches.length === 1 ? matches[0] : null;
}

export function getComponentWrappers(id: string): PluginComponent[] {
  const wrappers: PluginComponent[] = [];
  for (const registration of trusted.values()) {
    wrappers.push(...(registration.wrappers.get(id) ?? []));
  }
  return wrappers;
}

export function getShellOverride(): PluginComponent | null {
  const matches = [...trusted.values()]
    .map((registration) => registration.shell)
    .filter((component): component is PluginComponent => Boolean(component));
  return matches.length === 1 ? matches[0] : null;
}

export function globalPluginCss(): string {
  return [...trusted.values()]
    .flatMap((registration) => registration.css)
    .join('\n');
}

/**
 * Applies trusted overrides/wrappers to a host component. Call from the host
 * component boundary (`layout.shell`, `layout.center`, …).
 */
export function resolvePluginComponent(
  id: string,
  HostComponent: PluginComponent,
): PluginComponent {
  const override = getComponentOverride(id);
  const base = override ?? HostComponent;
  const wrappers = getComponentWrappers(id);
  if (wrappers.length === 0) return base;
  return function WrappedHostComponent(props: Record<string, unknown>) {
    let node: ReactNode = createElement(base, props);
    for (const Wrapper of [...wrappers].reverse()) {
      node = createElement(Wrapper, { ...props, children: node, Host: base });
    }
    return node;
  };
}

export function pluginLabel(
  plugin: PluginRecord,
  key: string | null | undefined,
  fallback: string,
): string {
  if (!key) return fallback;
  if (key.includes(':')) return t(key);
  return t(`plugins:${plugin.id}.${key}`, { defaultValue: fallback }) as string;
}

export function pluginT(
  pluginId: string,
  key: string | null | undefined,
  fallback: string,
): string {
  if (!key) return fallback;
  if (key.includes(':')) return t(key) as string;
  return t(`plugins:${pluginId}.${key}`, { defaultValue: fallback }) as string;
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
