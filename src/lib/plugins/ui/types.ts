/**
 * Renderer-side UI extension model.
 *
 * The contract (`data/plugin-contract.json`) owns the catalog; these types are
 * the shape of runtime contributions produced by manifests and trusted
 * registrations. Nothing here is serialized to a plugin.
 */
import type { ComponentType } from 'react';

import type {
  PluginAction,
  PluginLayoutId,
  PluginModeView,
  PluginRecord,
} from '../types';

export type LayoutId = PluginLayoutId;
export type PluginComponent = ComponentType<Record<string, unknown>>;
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain' | 'hoc';
export type SlotScope = 'root' | 'layout' | 'conversation' | 'message' | 'composer';
export type ContributionSource = 'manifest' | 'trusted';

export type SlotOwner = Record<string, unknown>;
export type SlotSelect = (owner: SlotOwner) => unknown | null;

export interface StyleRecipe {
  surface?: string;
  foreground?: string;
  radius?: string;
  padding?: string;
  gap?: string;
  shadow?: string;
  width?: string;
  align?: string;
  density?: string;
  text?: string;
  avatar?: string;
  motion?: string;
}

export interface SlotRegistration {
  slot: string;
  id: string;
  order?: number;
  priority?: number;
  layouts?: LayoutId[];
  key?: string | null;
  when?: Record<string, string | number | boolean> | null;
  select?: SlotSelect;
}

export interface ComponentReplaceRegistration {
  component: string;
  id?: string;
  priority?: number;
  layouts?: LayoutId[];
  source?: ContributionSource;
}

export interface ComponentWrapRegistration {
  component: string;
  id: string;
  order?: number;
  priority?: number;
  layouts?: LayoutId[];
  source?: ContributionSource;
}

export interface VariantRegistration {
  component: string;
  id: string;
  title: string;
  layouts?: LayoutId[];
  recipe: StyleRecipe;
}

export interface PresetRegistration {
  id: string;
  title: string;
  layouts?: LayoutId[];
  tokens?: { light?: Record<string, string>; dark?: Record<string, string> };
  density?: 'compact' | 'comfortable' | 'spacious' | null;
  variants?: Record<string, string>;
  css?: string | null;
}

export interface PageRegistration {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  layouts?: LayoutId[];
  order?: number;
}

export interface PanelTabRegistration {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  layouts?: LayoutId[];
  order?: number;
}

export interface SettingsTabRegistration {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  order?: number;
}

export interface NavRegistration {
  id: string;
  title: string;
  titleKey?: string | null;
  icon: string;
  page: string;
  layouts?: LayoutId[];
  order?: number;
  badge?: string | null;
}

export interface GenuiComponentRegistration {
  id: string;
  title: string;
  summary: string;
  props: Record<string, Record<string, unknown>>;
  render: { kind: 'trusted' | 'sandbox'; component?: string | null; entry?: string | null; height?: number | null };
}

export interface UiContributionBase {
  /** Stable contribution key (`<pluginId>:<kind>:<id>`). */
  key: string;
  plugin: PluginRecord;
  pluginId: string;
  source: ContributionSource;
  order: number;
  priority: number;
  layouts: LayoutId[];
}

export interface SlotContribution extends UiContributionBase {
  slot: string;
  entryId: string;
  kind: SlotKind;
  keyMatch: string | null;
  component: PluginComponent | null;
  entry: string | null;
  action: PluginAction | null;
  title: string | null;
  titleKey: string | null;
  icon: string | null;
  when: Record<string, string | number | boolean> | null;
  select?: SlotSelect;
}

export interface ComponentReplacement extends UiContributionBase {
  component: string;
  entryId: string;
  componentFn: PluginComponent;
}

export interface ComponentWrap extends UiContributionBase {
  component: string;
  entryId: string;
  wrapper: PluginComponent;
}

export interface PageSpec extends UiContributionBase {
  pageId: string;
  title: string;
  titleKey: string | null;
  icon: string | null;
  entry: string | null;
  component: PluginComponent | null;
}

export interface PanelTabSpec extends UiContributionBase {
  tabId: string;
  title: string;
  titleKey: string | null;
  icon: string | null;
  entry: string | null;
  component: PluginComponent | null;
  takeover: boolean;
}

export interface NavEntry {
  key: string;
  source: 'host' | 'plugin';
  pluginId: string | null;
  plugin: PluginRecord | null;
  id: string;
  title: string;
  titleKey: string | null;
  /** Accessible name; falls back to `title`. */
  ariaLabel?: string | null;
  icon: string;
  page: string;
  layouts: LayoutId[];
  order: number;
  badge: string | null;
}

export interface VariantSpec extends UiContributionBase {
  component: string;
  variantId: string;
  title: string;
  recipe: StyleRecipe;
}

export interface PresetSpec extends Omit<UiContributionBase, 'priority' | 'source'> {
  source: 'host' | 'plugin';
  presetId: string;
  title: string;
  tokens: { light: Record<string, string>; dark: Record<string, string> };
  density: 'compact' | 'comfortable' | 'spacious' | null;
  variants: Record<string, string>;
  css: string | null;
}

export interface CssEntry {
  key: string;
  pluginId: string | null;
  plugin: PluginRecord | null;
  id: string;
  file: string | null;
  css: string | null;
  layouts: LayoutId[];
  order: number;
}

export interface GenuiComponentSpec {
  key: string;
  pluginId: string;
  plugin: PluginRecord;
  type: string;
  id: string;
  title: string;
  summary: string;
  props: Record<string, Record<string, unknown>>;
  render: { kind: 'trusted' | 'sandbox'; component?: string | null; entry?: string | null; height?: number | null };
  component: PluginComponent | null;
}

export interface ArtifactViewerSpec {
  key: string;
  plugin: PluginRecord;
  pluginId: string;
  id: string;
  title: string;
  titleKey: string | null;
  mimeTypes: string[];
  entry: string | null;
  component: PluginComponent | null;
  priority: number;
}

export interface SettingsTabSpec extends UiContributionBase {
  tabId: string;
  title: string;
  titleKey: string | null;
  icon: string | null;
  entry: string | null;
  component: PluginComponent | null;
}

/** A content tab contributed to a layout sidebar (`contributes.ui.sidebarTabs`). */
export interface SidebarTabSpec {
  key: string;
  pluginId: string;
  plugin: PluginRecord;
  id: string;
  title: string;
  titleKey: string | null;
  icon: string | null;
  sidebars: LayoutId[];
  entry: string | null;
  component: PluginComponent | null;
  order: number;
  badge: string | null;
}

export interface PluginUiState {
  slots: SlotContribution[];
  replacements: ComponentReplacement[];
  wraps: ComponentWrap[];
  pages: PageSpec[];
  panelTabs: PanelTabSpec[];
  nav: NavEntry[];
  settingsTabs: SettingsTabSpec[];
  artifactViewers: ArtifactViewerSpec[];
  variants: VariantSpec[];
  presets: PresetSpec[];
  css: CssEntry[];
  genui: GenuiComponentSpec[];
  /** Harness modes contributed by active plugins. */
  modes?: PluginModeView[];
  /** Content tabs contributed to a layout sidebar. */
  sidebarTabs?: SidebarTabSpec[];
  revision: number;
}
