#!/usr/bin/env node
/**
 * Generates the Rust and SDK mirrors of `data/plugin-contract.json`.
 *
 * The contract is the single source of truth. This script never invents data:
 * it validates the shape and writes deterministic constants that both runtimes
 * use for parity checks. Run `pnpm plugin:contract` after editing the JSON.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = join(root, 'data', 'plugin-contract.json');
const themeTokensPath = join(root, 'data', 'theme-tokens.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const themeTokens = JSON.parse(readFileSync(themeTokensPath, 'utf8'));

function fail(message) {
  console.error(`plugin-contract: ${message}`);
  process.exit(1);
}

const ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const ENTRY_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LAYOUTS = new Set(contract.layouts ?? []);
const MODES = new Set(['declarative', 'sandbox', 'trusted']);
const KINDS = new Set(['single', 'list', 'keyed', 'chain', 'hoc']);
const SCOPES = new Set(['root', 'layout', 'conversation', 'message', 'composer']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const RECIPE_VALUES = contract.styleRecipes ?? {};

if (contract.apiVersion !== 2) fail('apiVersion must be 2');
if (contract.manifestSchemaVersion !== 2) fail('manifestSchemaVersion must be 2');
if (!Array.isArray(contract.layouts) || contract.layouts.length === 0) fail('layouts must be a non-empty array');
for (const layout of contract.layouts) {
  if (typeof layout !== 'string' || !ENTRY_ID.test(layout)) fail(`invalid layout: ${layout}`);
}
if (!Array.isArray(contract.hostPages) || contract.hostPages.length === 0) fail('hostPages must be a non-empty array');
for (const page of contract.hostPages) {
  if (typeof page !== 'string' || !ENTRY_ID.test(page)) fail(`invalid host page: ${page}`);
}

for (const [key, values] of Object.entries(RECIPE_VALUES)) {
  if (!Array.isArray(values) || values.length === 0) fail(`styleRecipes.${key} must be a non-empty array`);
  if (new Set(values).size !== values.length) fail(`styleRecipes.${key} has duplicate values`);
  for (const value of values) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) fail(`styleRecipes.${key} has invalid value: ${value}`);
  }
}

function recipesValid(recipe, label) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) fail(`${label} recipe must be an object`);
  for (const [key, value] of Object.entries(recipe)) {
    const allowed = RECIPE_VALUES[key];
    if (!allowed) fail(`${label} recipe has unknown key: ${key}`);
    if (!allowed.includes(value)) fail(`${label} recipe ${key} has invalid value: ${value}`);
  }
  return Object.keys(recipe).length;
}

const slotIds = new Set();
for (const slot of contract.slots ?? []) {
  if (!ID.test(slot.id)) fail(`invalid slot id: ${slot.id}`);
  if (slotIds.has(slot.id)) fail(`duplicate slot: ${slot.id}`);
  slotIds.add(slot.id);
  if (!KINDS.has(slot.kind)) fail(`slot ${slot.id} has invalid kind: ${slot.kind}`);
  if (!SCOPES.has(slot.scope)) fail(`slot ${slot.id} has invalid scope: ${slot.scope}`);
  if (!Array.isArray(slot.props)) fail(`slot ${slot.id} must have props[]`);
  if (!Array.isArray(slot.layouts) || slot.layouts.length === 0) fail(`slot ${slot.id} must have layouts[]`);
  for (const layout of slot.layouts) {
    if (!LAYOUTS.has(layout)) fail(`slot ${slot.id} has unknown layout: ${layout}`);
  }
  if (!Array.isArray(slot.modes) || slot.modes.length === 0) fail(`slot ${slot.id} must have modes[]`);
  for (const mode of slot.modes) {
    if (!MODES.has(mode)) fail(`slot ${slot.id} has unknown mode: ${mode}`);
  }
  if (slot.kind === 'keyed') {
    if (typeof slot.entryKey !== 'string' || !slot.props.includes(slot.entryKey)) {
      fail(`keyed slot ${slot.id} must declare entryKey in props`);
    }
  } else if (slot.entryKey !== undefined) {
    fail(`slot ${slot.id} declares entryKey but is not keyed`);
  }
  if (slot.modes.includes('sandbox') && (slot.kind === 'hoc' || slot.kind === 'single')) {
    fail(`slot ${slot.id}: ${slot.kind} slots cannot run sandboxed`);
  }
  if (slot.modes.includes('sandbox') && slot.id === 'chat.markdown.fence') {
    fail('chat.markdown.fence is trusted-only');
  }
}

const componentIds = new Set();
for (const component of contract.components ?? []) {
  if (componentIds.has(component.id)) fail(`duplicate component: ${component.id}`);
  componentIds.add(component.id);
  if (!KINDS.has(component.kind) || !['single', 'hoc'].includes(component.kind)) {
    fail(`component ${component.id} has invalid kind`);
  }
  if (!Array.isArray(component.lanes) || component.lanes.length === 0) {
    fail(`component ${component.id} must have lanes[]`);
  }
  if (component.lanes.some((lane) => lane !== 'trusted')) {
    fail(`component ${component.id} lanes must be ["trusted"]`);
  }
  if (!Array.isArray(component.layouts) || component.layouts.length === 0) {
    fail(`component ${component.id} must have layouts[]`);
  }
  if (!RISKS.has(component.risk)) fail(`component ${component.id} has invalid risk`);
  if (!Array.isArray(component.props)) fail(`component ${component.id} must have props[]`);
  const variants = component.variants ?? [];
  if (!Array.isArray(variants)) fail(`component ${component.id} variants must be an array`);
  if (new Set(variants).size !== variants.length) fail(`component ${component.id} has duplicate variants`);
  for (const variant of variants) {
    if (typeof variant !== 'string' || !ENTRY_ID.test(variant)) {
      fail(`component ${component.id} has invalid variant: ${variant}`);
    }
  }
  const builtin = component.builtinRecipes ?? {};
  if (variants.length === 0) {
    if (Object.keys(builtin).length !== 0) fail(`component ${component.id} has recipes without variants`);
  } else {
    const keys = Object.keys(builtin);
    if (keys.length !== variants.length || variants.some((variant) => !keys.includes(variant))) {
      fail(`component ${component.id} builtinRecipes must match variants`);
    }
    for (const [variant, recipe] of Object.entries(builtin)) {
      recipesValid(recipe, `component ${component.id} variant ${variant}`);
    }
  }
}

const permissionIds = new Set();
for (const permission of contract.permissions ?? []) {
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(permission.id)) {
    fail(`invalid permission id: ${permission.id}`);
  }
  if (permissionIds.has(permission.id)) fail(`duplicate permission: ${permission.id}`);
  permissionIds.add(permission.id);
  if (!RISKS.has(permission.risk)) fail(`permission ${permission.id} has invalid risk`);
  if (typeof permission.scoped !== 'boolean') fail(`permission ${permission.id} must declare scoped`);
  if (typeof permission.trustedOnly !== 'boolean') fail(`permission ${permission.id} must declare trustedOnly`);
}
for (const id of ['ui.override', 'ui.shell', 'unsafe.renderer', 'process.spawn', 'secrets.read']) {
  const permission = contract.permissions.find((entry) => entry.id === id);
  if (!permission?.trustedOnly) fail(`permission ${id} must be trustedOnly`);
}
const cssPermission = contract.permissions.find((entry) => entry.id === 'ui.css.global');
if (!cssPermission || cssPermission.trustedOnly) fail('ui.css.global must be available to every lane');

const eventNames = new Set();
for (const event of contract.events ?? []) {
  if (typeof event.name !== 'string' || !event.name.includes('/')) fail(`invalid event name: ${event.name}`);
  if (eventNames.has(event.name)) fail(`duplicate event: ${event.name}`);
  eventNames.add(event.name);
  if (!Array.isArray(event.props)) fail(`event ${event.name} must have props[]`);
}

const limits = contract.limits ?? {};
for (const key of [
  'packageBytes',
  'trustedPackageBytes',
  'files',
  'unpackedBytes',
  'promptCharsPerPlugin',
  'promptCharsTotal',
  'kvBytes',
  'dataBytes',
  'logBytes',
  'networkBytes',
  'rpcBytes',
  'toolResultChars',
  'toolTimeoutSecs',
]) {
  if (!Number.isInteger(limits[key]) || limits[key] <= 0) fail(`limit ${key} must be a positive integer`);
}
const uiLimits = contract.uiLimits ?? {};
for (const key of [
  'slotEntriesPerPlugin',
  'navEntriesPerPlugin',
  'pagesPerPlugin',
  'panelTabsPerPlugin',
  'variantsPerPlugin',
  'presetsPerPlugin',
  'cssCharsPerPlugin',
  'genuiComponentsPerPlugin',
  'genuiSchemaChars',
  'genuiPromptCharsPerPlugin',
]) {
  if (!Number.isInteger(uiLimits[key]) || uiLimits[key] <= 0) fail(`uiLimit ${key} must be a positive integer`);
}

for (const list of ['required', 'optionalColor', 'optionalLength']) {
  const values = themeTokens[list];
  if (!Array.isArray(values) || values.length === 0) fail(`theme-tokens.${list} must be a non-empty array`);
  if (new Set(values).size !== values.length) fail(`theme-tokens.${list} has duplicates`);
}

const stringArray = (values, indent = '    ') => values.map((value) => `${indent}"${value}",`).join('\n');
const numberConst = (name, value) => `pub const ${name}: u64 = ${value};`;

const rust = `// @generated by scripts/build-plugin-contract.mjs — do not edit.
// Source: data/plugin-contract.json

pub const API_VERSION: u32 = ${contract.apiVersion};
pub const SUPPORTED_API_VERSIONS: &[u32] = &[1, ${contract.apiVersion}];
pub const MANIFEST_SCHEMA_VERSION: u32 = ${contract.manifestSchemaVersion};
pub const TOOL_NAME_PREFIX: &str = "${contract.toolNamePrefix}";
pub const TOOL_NAME_MAX_CHARS: usize = ${contract.toolNameMaxChars};

pub static LAYOUT_IDS: &[&str] = &[
${stringArray(contract.layouts)}
];

pub static HOST_PAGE_IDS: &[&str] = &[
${stringArray(contract.hostPages)}
];

pub static SLOT_IDS: &[&str] = &[
${stringArray(contract.slots.map((slot) => slot.id))}
];

pub static SLOT_KINDS: &[&str] = &[
${stringArray(contract.slots.map((slot) => slot.kind))}
];

pub static SLOT_SCOPES: &[&str] = &[
${stringArray(contract.slots.map((slot) => slot.scope))}
];

pub static COMPONENT_IDS: &[&str] = &[
${stringArray(contract.components.map((component) => component.id))}
];

pub static PERMISSION_IDS: &[&str] = &[
${stringArray(contract.permissions.map((permission) => permission.id))}
];

pub static TRUSTED_ONLY_PERMISSIONS: &[&str] = &[
${stringArray(contract.permissions.filter((permission) => permission.trustedOnly).map((permission) => permission.id))}
];

pub static EVENT_NAMES: &[&str] = &[
${stringArray(contract.events.map((event) => event.name))}
];

pub static THEME_REQUIRED_TOKENS: &[&str] = &[
${stringArray(themeTokens.required)}
];

pub static THEME_OPTIONAL_COLOR_TOKENS: &[&str] = &[
${stringArray(themeTokens.optionalColor)}
];

pub static THEME_OPTIONAL_LENGTH_TOKENS: &[&str] = &[
${stringArray(themeTokens.optionalLength)}
];

pub const LIMIT_PACKAGE_BYTES: u64 = ${limits.packageBytes};
pub const LIMIT_TRUSTED_PACKAGE_BYTES: u64 = ${limits.trustedPackageBytes};
pub const LIMIT_FILES: usize = ${limits.files};
pub const LIMIT_UNPACKED_BYTES: u64 = ${limits.unpackedBytes};
pub const LIMIT_PROMPT_CHARS_PER_PLUGIN: usize = ${limits.promptCharsPerPlugin};
pub const LIMIT_PROMPT_CHARS_TOTAL: usize = ${limits.promptCharsTotal};
pub const LIMIT_KV_BYTES: u64 = ${limits.kvBytes};
pub const LIMIT_DATA_BYTES: u64 = ${limits.dataBytes};
pub const LIMIT_LOG_BYTES: u64 = ${limits.logBytes};
pub const LIMIT_NETWORK_BYTES: u64 = ${limits.networkBytes};
pub const LIMIT_RPC_BYTES: u64 = ${limits.rpcBytes};
pub const LIMIT_TOOL_RESULT_CHARS: usize = ${limits.toolResultChars};
pub const LIMIT_TOOL_TIMEOUT_SECS: u64 = ${limits.toolTimeoutSecs};

${numberConst('UI_LIMIT_SLOT_ENTRIES', uiLimits.slotEntriesPerPlugin)}
${numberConst('UI_LIMIT_NAV_ENTRIES', uiLimits.navEntriesPerPlugin)}
${numberConst('UI_LIMIT_PAGES', uiLimits.pagesPerPlugin)}
${numberConst('UI_LIMIT_PANEL_TABS', uiLimits.panelTabsPerPlugin)}
${numberConst('UI_LIMIT_VARIANTS', uiLimits.variantsPerPlugin)}
${numberConst('UI_LIMIT_PRESETS', uiLimits.presetsPerPlugin)}
${numberConst('UI_LIMIT_CSS_CHARS', uiLimits.cssCharsPerPlugin)}
${numberConst('UI_LIMIT_GENUI_COMPONENTS', uiLimits.genuiComponentsPerPlugin)}
${numberConst('UI_LIMIT_GENUI_SCHEMA_CHARS', uiLimits.genuiSchemaChars)}
${numberConst('UI_LIMIT_GENUI_PROMPT_CHARS', uiLimits.genuiPromptCharsPerPlugin)}
`;

const sdk = `// @generated by scripts/build-plugin-contract.mjs — do not edit.
// Source: data/plugin-contract.json

export const PLUGIN_API_VERSION = ${contract.apiVersion} as const;
export const SUPPORTED_API_VERSIONS = [1, ${contract.apiVersion}] as const;
export const PLUGIN_MANIFEST_SCHEMA_VERSION = ${contract.manifestSchemaVersion} as const;

export const LAYOUT_IDS = [
${stringArray(contract.layouts)}
] as const;
export type PluginLayoutId = (typeof LAYOUT_IDS)[number];

export const HOST_PAGE_IDS = [
${stringArray(contract.hostPages)}
] as const;
export type PluginHostPageId = (typeof HOST_PAGE_IDS)[number];

export const SLOT_IDS = [
${stringArray(contract.slots.map((slot) => slot.id))}
] as const;
export type PluginSlotId = (typeof SLOT_IDS)[number];

export const SLOT_KINDS = [
${stringArray(contract.slots.map((slot) => slot.kind))}
] as const;

export const COMPONENT_IDS = [
${stringArray(contract.components.map((component) => component.id))}
] as const;
export type PluginComponentId = (typeof COMPONENT_IDS)[number];

export const PERMISSION_IDS = [
${stringArray(contract.permissions.map((permission) => permission.id))}
] as const;
export type PluginPermissionId = (typeof PERMISSION_IDS)[number];

export const EVENT_NAMES = [
${stringArray(contract.events.map((event) => event.name))}
] as const;
export type PluginEventName = (typeof EVENT_NAMES)[number];

export const PLUGIN_LIMITS = ${JSON.stringify(limits, null, 2)} as const;

export const PLUGIN_UI_LIMITS = ${JSON.stringify(uiLimits, null, 2)} as const;
`;

const rustPath = join(root, 'src-tauri', 'src', 'plugins', 'contract_generated.rs');
const sdkPath = join(root, 'packages', 'plugin-sdk', 'src', 'contract.generated.ts');
mkdirSync(dirname(rustPath), { recursive: true });
mkdirSync(dirname(sdkPath), { recursive: true });
writeFileSync(rustPath, rust, 'utf8');
writeFileSync(sdkPath, sdk, 'utf8');
console.log(`plugin-contract: wrote ${rustPath}`);
console.log(`plugin-contract: wrote ${sdkPath}`);
