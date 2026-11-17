/**
 * Typed loader for `data/plugin-contract.json`, the single source of truth for
 * plugin slots, components, permissions, events and limits.
 */
import rawContract from '@data/plugin-contract.json';
import type { PluginLayoutId, PluginRisk } from './types';

export type PluginUiMode = 'declarative' | 'sandbox' | 'trusted';
export type PluginSlotKind = 'single' | 'list' | 'keyed' | 'chain' | 'hoc';
export type PluginSlotScope = 'root' | 'layout' | 'conversation' | 'message' | 'composer';

export interface PluginSlotSpec {
  id: string;
  title: string;
  kind: PluginSlotKind;
  scope: PluginSlotScope;
  props: string[];
  entryKey?: string | null;
  layouts: PluginLayoutId[];
  modes: PluginUiMode[];
  replacement: boolean;
  description?: string;
}

export interface PluginComponentSpec {
  id: string;
  title: string;
  kind: 'single' | 'hoc';
  lanes: Array<'trusted'>;
  layouts: PluginLayoutId[];
  props: string[];
  variants: string[];
  builtinRecipes?: Record<string, Record<string, string>>;
  risk: PluginRisk;
  description?: string;
}

export interface PluginPermissionSpec {
  id: string;
  scoped: boolean;
  risk: PluginRisk;
  trustedOnly: boolean;
  description: string;
}

export interface PluginEventSpec {
  name: string;
  scope: string;
  props: string[];
  description?: string;
}

export interface PluginLimits {
  packageBytes: number;
  trustedPackageBytes: number;
  files: number;
  unpackedBytes: number;
  promptCharsPerPlugin: number;
  promptCharsTotal: number;
  kvBytes: number;
  dataBytes: number;
  logBytes: number;
  networkBytes: number;
  rpcBytes: number;
  toolResultChars: number;
  toolTimeoutSecs: number;
  modesPerPlugin: number;
  modePromptChars: number;
  agentTemplatesPerPlugin: number;
  templateInstructionsChars: number;
  customProviders: number;
}

export interface PluginUiLimits {
  slotEntriesPerPlugin: number;
  navEntriesPerPlugin: number;
  pagesPerPlugin: number;
  panelTabsPerPlugin: number;
  sidebarTabsPerPlugin: number;
  variantsPerPlugin: number;
  presetsPerPlugin: number;
  cssCharsPerPlugin: number;
  genuiComponentsPerPlugin: number;
  genuiSchemaChars: number;
  genuiPromptCharsPerPlugin: number;
}

export interface PluginContract {
  apiVersion: number;
  manifestSchemaVersion: number;
  name: string;
  description: string;
  toolNamePrefix: string;
  toolNameMaxChars: number;
  layouts: PluginLayoutId[];
  hostPages: string[];
  limits: PluginLimits;
  uiLimits: PluginUiLimits;
  styleRecipes: Record<string, string[]>;
  slots: PluginSlotSpec[];
  components: PluginComponentSpec[];
  reservedSlots: string[];
  reservedComponents: string[];
  reservedPermissions: string[];
  events: PluginEventSpec[];
  permissions: PluginPermissionSpec[];
}

export const PLUGIN_CONTRACT = rawContract as unknown as PluginContract;
export const PLUGIN_LIMITS = PLUGIN_CONTRACT.limits;
export const PLUGIN_UI_LIMITS = PLUGIN_CONTRACT.uiLimits;
export const PLUGIN_LAYOUTS = PLUGIN_CONTRACT.layouts;
export const PLUGIN_HOST_PAGES = PLUGIN_CONTRACT.hostPages;
export const PLUGIN_STYLE_RECIPES = PLUGIN_CONTRACT.styleRecipes;
export const PLUGIN_SLOTS = PLUGIN_CONTRACT.slots;
export const PLUGIN_COMPONENTS = PLUGIN_CONTRACT.components;
export const PLUGIN_RESERVED_SLOTS = PLUGIN_CONTRACT.reservedSlots;
export const PLUGIN_RESERVED_COMPONENTS = PLUGIN_CONTRACT.reservedComponents;
export const PLUGIN_RESERVED_PERMISSIONS = PLUGIN_CONTRACT.reservedPermissions ?? [];
export const PLUGIN_EVENTS = PLUGIN_CONTRACT.events;
export const PLUGIN_PERMISSIONS = PLUGIN_CONTRACT.permissions;

export const PLUGIN_SLOT_IDS = PLUGIN_SLOTS.map((slot) => slot.id);
export const PLUGIN_COMPONENT_IDS = PLUGIN_COMPONENTS.map((component) => component.id);

const RESERVED_SLOT_SET = new Set(PLUGIN_RESERVED_SLOTS);
const RESERVED_COMPONENT_SET = new Set(PLUGIN_RESERVED_COMPONENTS);

const SLOT_MAP = new Map(PLUGIN_SLOTS.map((slot) => [slot.id, slot]));
const COMPONENT_MAP = new Map(PLUGIN_COMPONENTS.map((component) => [component.id, component]));
const PERMISSION_MAP = new Map(
  PLUGIN_PERMISSIONS.map((permission) => [permission.id, permission]),
);

export function pluginSlotSpec(id: string): PluginSlotSpec | undefined {
  return SLOT_MAP.get(id);
}

export function pluginComponentSpec(id: string): PluginComponentSpec | undefined {
  return COMPONENT_MAP.get(id);
}

export function pluginComponentExists(id: string): boolean {
  return COMPONENT_MAP.has(id);
}

/** Slot ids the host does not mount; manifests must not target them. */
export function pluginSlotReserved(id: string): boolean {
  return RESERVED_SLOT_SET.has(id);
}

/** Component ids the host cannot replace/wrap (variants may still apply). */
export function pluginComponentReserved(id: string): boolean {
  return RESERVED_COMPONENT_SET.has(id);
}

export function pluginPermissionBase(permission: string): string {
  return permission.split(':')[0] ?? permission;
}

export function pluginPermissionSpec(permission: string): PluginPermissionSpec | undefined {
  return PERMISSION_MAP.get(pluginPermissionBase(permission));
}

export function pluginPermissionKnown(permission: string): boolean {
  return PERMISSION_MAP.has(pluginPermissionBase(permission));
}

export function pluginPermissionTrustedOnly(permission: string): boolean {
  return pluginPermissionSpec(permission)?.trustedOnly === true;
}

const RISK_ORDER: Record<PluginRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function compareRisk(left: PluginRisk, right: PluginRisk): number {
  return RISK_ORDER[left] - RISK_ORDER[right];
}

/** Human label for a plugin icon name. The host only ships lucide icons. */
export const PLUGIN_ICON_NAMES = [
  'Plug',
  'Puzzle',
  'Sparkles',
  'GitBranch',
  'Globe',
  'Database',
  'Terminal',
  'PanelRight',
  'LayoutGrid',
  'Wand2',
  'Bot',
  'Zap',
  'ListChecks',
  'Library',
] as const;

export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

export function pluginIconName(value: string | null | undefined): PluginIconName {
  return PLUGIN_ICON_NAMES.includes(value as PluginIconName)
    ? (value as PluginIconName)
    : 'Puzzle';
}
