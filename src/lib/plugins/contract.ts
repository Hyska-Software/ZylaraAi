/**
 * Typed loader for `data/plugin-contract.json`, the single source of truth for
 * plugin slots, permissions, component ids and limits.
 */
import rawContract from '@data/plugin-contract.json';
import type { PluginRisk } from './types';

export interface PluginSlotSpec {
  id: string;
  title: string;
  props: string[];
  modes: Array<'declarative' | 'sandbox' | 'trusted'>;
}

export interface PluginComponentSpec {
  id: string;
  title: string;
  props: string[];
}

export interface PluginPermissionSpec {
  id: string;
  scoped: boolean;
  risk: PluginRisk;
  description: string;
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
}

export interface PluginContract {
  apiVersion: number;
  manifestSchemaVersion: number;
  name: string;
  description: string;
  toolNamePrefix: string;
  toolNameMaxChars: number;
  limits: PluginLimits;
  slots: PluginSlotSpec[];
  components: PluginComponentSpec[];
  permissions: PluginPermissionSpec[];
}

export const PLUGIN_CONTRACT = rawContract as unknown as PluginContract;
export const PLUGIN_LIMITS = PLUGIN_CONTRACT.limits;
export const PLUGIN_SLOTS = PLUGIN_CONTRACT.slots;
export const PLUGIN_COMPONENTS = PLUGIN_CONTRACT.components;
export const PLUGIN_PERMISSIONS = PLUGIN_CONTRACT.permissions;

export const PLUGIN_SLOT_IDS = PLUGIN_SLOTS.map((slot) => slot.id);
export const PLUGIN_COMPONENT_IDS = PLUGIN_COMPONENTS.map((component) => component.id);

const SLOT_SET = new Set(PLUGIN_SLOT_IDS);
const COMPONENT_SET = new Set(PLUGIN_COMPONENT_IDS);
const PERMISSION_MAP = new Map(
  PLUGIN_PERMISSIONS.map((permission) => [permission.id, permission]),
);

export function pluginSlot(id: string): PluginSlotSpec | undefined {
  return SLOT_SET.has(id) ? PLUGIN_SLOTS.find((slot) => slot.id === id) : undefined;
}

export function pluginComponentExists(id: string): boolean {
  return COMPONENT_SET.has(id);
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
] as const;

export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

export function pluginIconName(value: string | null | undefined): PluginIconName {
  return PLUGIN_ICON_NAMES.includes(value as PluginIconName)
    ? (value as PluginIconName)
    : 'Puzzle';
}
