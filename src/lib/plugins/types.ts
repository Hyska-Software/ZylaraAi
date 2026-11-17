/**
 * Plugin platform contracts mirroring `src-tauri/src/plugins/manifest.rs` and
 * `data/plugin-contract.json`. Keep this file in sync with the Rust structs;
 * the contract parity test covers slots/components/permissions/limits.
 */

export type PluginRisk = 'low' | 'medium' | 'high' | 'critical';
export type PluginToolRisk = 'read' | 'network' | 'write' | 'shell';
export type PluginSurface = 'chat' | 'code' | 'agent' | 'global';
export type PluginLocation = 'main' | 'sidebar';
export type PluginDock = 'right';

export interface PluginPublisher {
  id: string;
  name: string;
  keyId?: string;
  homepage?: string | null;
}

export type PluginAction =
  | { kind: 'openView'; target: string }
  | { kind: 'openPage'; target: string; layout?: PluginLayoutId | null }
  | { kind: 'openPanel'; target: string }
  | { kind: 'openPanelTab'; target: string; layout?: PluginLayoutId | null }
  | { kind: 'setLayout'; target: PluginLayoutId }
  | { kind: 'openSettings'; target?: string | null }
  | { kind: 'setVariant'; component: string; target: string }
  | { kind: 'setPreset'; target: string; layout?: PluginLayoutId | null }
  | { kind: 'toggleMode'; target: string }
  | { kind: 'insertDraft'; text: string }
  | { kind: 'openExternal'; url: string }
  | { kind: 'execute'; method: string; params?: unknown };

export type PluginLayoutId = 'chat' | 'code' | 'agent';

export interface SlotContribution {
  slot: string;
  id?: string | null;
  entry?: string | null;
  component?: string | null;
  title?: string | null;
  titleKey?: string | null;
  icon?: string | null;
  action?: PluginAction | null;
  declarative?: boolean | null;
  layouts?: PluginLayoutId[];
  order?: number | null;
  priority?: number | null;
  key?: string | null;
  when?: Record<string, string | number | boolean> | null;
}

export interface ViewContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  description?: string | null;
  descriptionKey?: string | null;
  icon?: string | null;
  surface?: PluginSurface;
  location?: PluginLocation;
  layouts?: PluginLayoutId[];
  order?: number | null;
  entry?: string | null;
  component?: string | null;
}

export interface NavContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  page: string;
  layouts?: PluginLayoutId[];
  order?: number | null;
  badge?: string | null;
}

export interface PanelContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  entry?: string | null;
  component?: string | null;
  dock: PluginDock;
  tab?: boolean | null;
  layouts?: PluginLayoutId[];
  order?: number | null;
}

export interface CommandContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  description?: string | null;
  descriptionKey?: string | null;
  command?: string | null;
  keywords?: string | null;
  icon?: string | null;
  hotkey?: string | null;
  action: PluginAction;
}

export interface SettingsTabContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  order?: number | null;
  entry?: string | null;
  component?: string | null;
}

export interface ThemeContribution {
  id: string;
  name: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface VariantContribution {
  component: string;
  id: string;
  title: string;
  layouts?: PluginLayoutId[];
  recipe: Record<string, string>;
}

export interface PresetContribution {
  id: string;
  title: string;
  layouts?: PluginLayoutId[];
  tokens?: { light?: Record<string, string>; dark?: Record<string, string> };
  density?: 'compact' | 'comfortable' | 'spacious' | null;
  variants?: Record<string, string>;
  css?: string | null;
}

export interface CssContribution {
  id: string;
  file: string;
  layouts?: PluginLayoutId[];
  order?: number | null;
}

export interface GenuiRender {
  kind: 'trusted' | 'sandbox';
  component?: string | null;
  entry?: string | null;
  height?: number | null;
}

export interface GenuiComponentContribution {
  id: string;
  title: string;
  summary: string;
  props: Record<string, Record<string, unknown>>;
  render: GenuiRender;
}

export interface GenuiContribution {
  components: GenuiComponentContribution[];
}

export interface PromptSection {
  id: string;
  title: string;
  file: string;
}

export interface ToolContribution {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: PluginToolRisk;
  profiles: Array<'chat' | 'code'>;
  timeoutSecs?: number | null;
}

export interface ProviderModelContribution {
  id: string;
  name: string;
  protocols?: string[];
  contextWindow?: number | null;
  maxOutput?: number | null;
  reasoning?: boolean;
  attachment?: boolean;
}

export interface ProviderContribution {
  id: string;
  name: string;
  shortName?: string | null;
  description?: string;
  baseUrl: string;
  consoleUrl?: string;
  endpoints?: Record<string, string>;
  models: ProviderModelContribution[];
}

/** A content tab rendered inside a layout sidebar (`contributes.ui.sidebarTabs`). */
export interface SidebarTabContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  icon?: string | null;
  sidebars: PluginLayoutId[];
  entry?: string | null;
  component?: string | null;
  order?: number | null;
  badge?: string | null;
}

export interface ArtifactViewerContribution {
  id: string;
  title: string;
  titleKey?: string | null;
  mimeTypes: string[];
  entry?: string | null;
  component?: string | null;
  priority: number;
}

export interface UiContributions {
  slots: SlotContribution[];
  views: ViewContribution[];
  nav: NavContribution[];
  /** Content tabs rendered inside a layout sidebar. */
  sidebarTabs?: SidebarTabContribution[];
  panels: PanelContribution[];
  commands: CommandContribution[];
  settingsTabs: SettingsTabContribution[];
  themes: ThemeContribution[];
  variants: VariantContribution[];
  presets: PresetContribution[];
  css: CssContribution[];
  genui: GenuiContribution;
}

export interface PluginContributions {
  ui: UiContributions;
  /** Inline array or package-relative `tools.json`. */
  tools?: ToolContribution[] | string | null;
  promptSections: PromptSection[];
  skills: string[];
  locales: string[];
  providers: ProviderContribution[];
  artifactViewers: ArtifactViewerContribution[];
}

export interface PluginBackend {
  kind: string;
  entry: string;
}

export interface PluginRuntime {
  ui: 'none' | 'declarative' | 'sandbox' | 'trusted' | string;
  entry?: string | null;
  backend?: PluginBackend | null;
}

export interface PluginEngines {
  zylara?: string;
}

export interface PluginManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string | null;
  icon?: string | null;
  apiVersion: number;
  engines: PluginEngines;
  publisher: PluginPublisher;
  permissions: string[];
  contributes: PluginContributions;
  runtime: PluginRuntime;
  trusted: boolean;
}

export interface PluginPermissionView {
  id: string;
  granted: boolean;
  risk: PluginRisk;
  scoped: boolean;
  description: string;
  trustedOnly: boolean;
}

export interface PluginToolView {
  name: string;
  wireName: string;
  description: string;
  risk: PluginToolRisk;
  profiles: string[];
  parameters: Record<string, unknown>;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description: string;
  author: string;
  homepage?: string | null;
  icon?: string | null;
  root: string;
  enabled: boolean;
  active: boolean;
  trusted: boolean;
  source: string;
  signatureStatus: string;
  publisherId: string;
  publisherName: string;
  keyId?: string | null;
  keyFingerprint?: string | null;
  installedAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  autoUpdate: boolean;
  previousVersion?: string | null;
  disabledReason?: string | null;
  sizeBytes: number;
  permissions: PluginPermissionView[];
  tools: PluginToolView[];
  promptChars: number;
  prompt: string;
  skillRoots: string[];
  locales: string[];
  manifest: PluginManifest;
  hasBackend: boolean;
  mainScript?: string | null;
}

export interface PluginSnapshot {
  plugins: PluginRecord[];
  safeMode: boolean;
  pluginsEnabled: boolean;
  allowTrusted: boolean;
  devMode: boolean;
  configFingerprint: string;
  /** Harness modes contributed by active plugins. */
  modes?: PluginModeView[];
  /** Agent templates contributed by active plugins. */
  agentTemplates?: PluginTemplateView[];
}

/** A harness mode contributed by an active plugin (`contributes.modes`). */
export interface PluginModeView {
  /** `<pluginId>:<modeId>`. */
  key: string;
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  description: string;
  icon?: string | null;
  profiles: string[];
  toolsAdd: string[];
  toolsRemove: string[];
  writesBlocked: boolean;
  defaultOn: boolean;
}

/** An agent template contributed by an active plugin. */
export interface PluginTemplateView {
  key: string;
  pluginId: string;
  pluginName: string;
  id: string;
  name: string;
  nameKey?: string | null;
  description: string;
  descriptionKey?: string | null;
  role: string;
  icon?: string | null;
  instructions: string;
  starters: string[];
  capabilities: Record<string, unknown>;
  permissionMode?: string | null;
}

/** Explicit plugin-mode state of a conversation. */
export interface PluginModesView {
  on: string[];
  off: string[];
}

export interface PluginPackageInspection {
  manifest: PluginManifest;
  signatureStatus: string;
  publisherId: string;
  publisherName: string;
  keyId?: string | null;
  keyFingerprint?: string | null;
  permissions: string[];
  fileCount: number;
  totalBytes: number;
  packageHash: string;
  warnings: string[];
  engineOk: boolean;
}

export interface RegistryPublisher {
  id: string;
  name: string;
  keyId?: string;
  publicKey?: string;
}

export interface RegistryPlugin {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  publisher: RegistryPublisher;
  summary: string;
  description: string;
  icon?: string | null;
  homepage?: string | null;
  packageUrl: string;
  packageSha256?: string | null;
  packageSize?: number | null;
  minAppVersion?: string | null;
  channel: string;
  permissions: string[];
  yanked: boolean;
  publishedAt?: string | null;
  registryUrl?: string | null;
  keyFingerprint?: string | null;
}

export interface RevokedPlugin {
  id: string;
  version: string;
  reason: string;
}

export interface PluginStoreView {
  plugins: RegistryPlugin[];
  revoked: RevokedPlugin[];
  sourceUrl: string;
  fetchedAt: number;
  registryName: string;
  signatureKeyId?: string | null;
}

export interface PluginUpdateInfo {
  pluginId: string;
  name: string;
  currentVersion: string;
  latestVersion: string;
  packageUrl: string;
  packageSha256?: string | null;
  keyFingerprint?: string | null;
  permissions: string[];
  newPermissions: string[];
  yanked: boolean;
  channel: string;
  summary?: string | null;
}

export interface PluginToolImage {
  mimeType: string;
  dataBase64: string;
  width?: number;
  height?: number;
}

export interface PluginToolResult {
  callId: string;
  content: string;
  isError: boolean;
  summary?: string | null;
  presentation?: unknown;
  images?: PluginToolImage[];
}

export interface PluginToolCallEvent {
  callId: string;
  pluginId: string;
  pluginName: string;
  tool: string;
  wireName: string;
  arguments: Record<string, unknown>;
  timeoutSecs: number;
  conversationId: string;
  turnId: string;
}

export interface PluginNotificationEvent {
  pluginId: string;
  title: string;
  body: string;
}

export interface PluginLogRow {
  id: number;
  pluginId: string;
  level: string;
  message: string;
  createdAt: number;
}

export interface PluginAuditRow {
  id: number;
  pluginId: string;
  capability: string;
  paramsDigest?: string | null;
  decision: string;
  createdAt: number;
}

export interface PluginToolCallRow {
  id: number;
  pluginId: string;
  tool: string;
  conversationId?: string | null;
  turnId?: string | null;
  status: string;
  durationMs?: number | null;
  createdAt: number;
}

export type PluginLocaleBundle = {
  entries: Record<string, Record<string, unknown>>;
};
