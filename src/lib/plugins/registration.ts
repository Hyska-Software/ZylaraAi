/**
 * Runtime registrations owned by the trusted lane.
 *
 * Everything listed here is dismissed when the plugin is unloaded or its
 * permissions shrink. The projection into UI contributions happens in
 * `plugins/registry.ts`.
 */
import type {
  ArtifactViewerSpec,
  ComponentReplacement,
  ComponentWrap,
  CssEntry,
  GenuiComponentSpec,
  NavEntry,
  PageSpec,
  PanelTabSpec,
  PluginComponent,
  PresetSpec,
  SettingsTabSpec,
  SlotContribution,
  VariantSpec,
} from './ui/types';

export type ToolHandler = (input: { tool: string; arguments: unknown }) => unknown;
export type CommandHandler = (params: unknown) => unknown;

export interface TrustedRegistration {
  pluginId: string;
  slots: SlotContribution[];
  pages: PageSpec[];
  panelTabs: PanelTabSpec[];
  nav: NavEntry[];
  settingsTabs: SettingsTabSpec[];
  artifactViewers: ArtifactViewerSpec[];
  variants: VariantSpec[];
  presets: PresetSpec[];
  css: CssEntry[];
  genui: GenuiComponentSpec[];
  replacements: ComponentReplacement[];
  wraps: ComponentWrap[];
  toolHandlers: Map<string, ToolHandler>;
  commands: Map<string, CommandHandler>;
  cleanup: Array<() => void>;
}
