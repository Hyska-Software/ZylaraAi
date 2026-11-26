/**
 * Settings dialog tabs (DESIGN §9).
 *
 * Single source of truth for the built-in tab ids and translation keys shared
 * by the settings dialog and the command palette. Plugin-contributed tabs use
 * the stable `plugin:<plugin-id>:<tab-id>` namespace; their labels/icons live in
 * the plugin registry, never here.
 */

export type BuiltinSettingsTabId =
  | 'general'
  | 'themes'
  | 'design'
  | 'terminal'
  | 'providers'
  | 'model'
  | 'instructions'
  | 'tools'
  | 'plugins'
  | 'agents'
  | 'data'
  | 'experimental'
  | 'about';

/** Built-in ids plus plugin-owned tabs (`plugin:<plugin>:<tab>`). */
export type SettingsTabId = BuiltinSettingsTabId | `plugin:${string}`;

export interface SettingsTabDefinition {
  id: BuiltinSettingsTabId;
  labelKey: string;
}

export const SETTINGS_TABS = [
  { id: 'general', labelKey: 'tabs.general' },
  { id: 'themes', labelKey: 'tabs.themes' },
  { id: 'design', labelKey: 'tabs.design' },
  { id: 'terminal', labelKey: 'tabs.terminal' },
  { id: 'providers', labelKey: 'tabs.providers' },
  { id: 'model', labelKey: 'tabs.model' },
  { id: 'instructions', labelKey: 'tabs.instructions' },
  { id: 'tools', labelKey: 'tabs.tools' },
  { id: 'plugins', labelKey: 'tabs.plugins' },
  { id: 'agents', labelKey: 'tabs.agents' },
  { id: 'data', labelKey: 'tabs.data' },
  { id: 'experimental', labelKey: 'tabs.experimental' },
  { id: 'about', labelKey: 'tabs.about' },
] as const satisfies readonly SettingsTabDefinition[];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general';

const SETTINGS_TAB_IDS = new Set<string>(SETTINGS_TABS.map((tab) => tab.id));

/** Narrows an untrusted value (rehydrated state, URL, test) to a valid tab id. */
export function isSettingsTabId(value: unknown): value is SettingsTabId {
  if (typeof value !== 'string') return false;
  if (SETTINGS_TAB_IDS.has(value)) return true;
  if (!value.startsWith('plugin:')) return false;
  const rest = value.slice('plugin:'.length);
  const separator = rest.indexOf(':');
  return separator > 0 && separator < rest.length - 1;
}
