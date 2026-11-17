/**
 * Zylara plugin SDK (sandboxed lane).
 *
 * The host injects `/@zylara/sdk.js`; this package only declares the API for
 * editors and for plugin authors bundling a typed iframe/backend.
 */
export * from './contract.generated';

export interface PluginInit {
  type: 'init';
  pluginId: string;
  locale: string;
  theme: {
    tokens: Record<string, string>;
    dark: boolean;
    reduceMotion: boolean;
  };
  localeBundle: Record<string, unknown>;
  context: Record<string, unknown>;
  kind: string;
}

export interface ToolInvocation {
  tool: string;
  arguments: Record<string, unknown>;
  pluginId?: string;
}

export interface ToolResult {
  content: string;
  summary?: string;
  isError?: boolean;
  presentation?: unknown;
  images?: Array<{
    mimeType: string;
    dataBase64: string;
    width?: number;
    height?: number;
  }>;
}

export interface PluginUiApi {
  openPage(pageId: string, options?: { layout?: 'chat' | 'code' | 'agent' }): Promise<unknown>;
  openPanelTab(tabId: string, options?: { layout?: 'chat' | 'code' | 'agent' }): Promise<unknown>;
  closePanelTab(): Promise<unknown>;
  setLayout(layout: 'chat' | 'code' | 'agent'): Promise<unknown>;
  openSettings(tab?: string): Promise<unknown>;
  toast(title: string, body?: string): Promise<unknown>;
  setBadge(navId: string, badge: string | null): Promise<unknown>;
}

export interface PluginApi {
  readonly pluginId: string;
  readonly locale: string;
  readonly context: Record<string, unknown>;
  readonly theme: PluginInit['theme'];
  readonly ui: PluginUiApi;
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (detail: unknown) => void): () => void;
  onEvent(event: string, handler: (detail: unknown) => void): () => void;
  onGenui(handler: (props: Record<string, unknown>) => void): void;
  onTool(handler: (invocation: ToolInvocation) => ToolResult | string | Promise<ToolResult | string>): void;
  t(key: string, fallback?: string): string;
  notify(message: string): Promise<unknown>;
  resize(): void;
  openView(viewId: string): Promise<unknown>;
  openPanel(panelId: string): Promise<unknown>;
  closeOverlays(): Promise<unknown>;
  openExternal(url: string): Promise<unknown>;
  ready(): void;
}

declare global {
  interface Window {
    ZylaraPlugin: PluginApi;
  }
}

/**
 * Scoped grants and the base ids published by the contract. `PERMISSION_IDS`
 * comes from `data/plugin-contract.json`, so a contract change reaches the SDK
 * through `pnpm plugin:contract`.
 */
export type PluginPermission =
  | (typeof PERMISSION_IDS)[number]
  | `ui.slot:${string}`
  | `ui.override:${string}`
  | `events:${string}`
  | `net:${string}`
  | `fs.read:${string}`
  | `fs.write:${string}`;

/** Published in the contract but not implemented by this host: a manifest that
 * declares one is rejected with `PLUGIN_PERMISSION_RESERVED`. */
export type ReservedPermission = (typeof RESERVED_PERMISSION_IDS)[number];

export interface PluginModeTools {
  /** Catalog tools the mode re-exposes (`web_search`, `create_file`, …). */
  add?: string[];
  /** Tools hidden while the mode is on. */
  remove?: string[];
}

/** A harness mode: persistent per-conversation switch that injects instructions
 * and can adjust the tool catalog (`contributes.modes`). */
export interface ModeContribution {
  id: string;
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  /** `chat` and/or `code`; omitted means both. */
  profiles?: Array<'chat' | 'code'>;
  prompt?: string;
  promptFile?: string;
  tools?: PluginModeTools;
  /** `blocked` hides mutating tools while the mode is active. */
  writes?: 'allowed' | 'blocked';
  defaultOn?: boolean;
}

/** An agent template shown in the Agentes gallery (`contributes.agentTemplates`).
 * Capabilities are deny-only: a template can restrict, never grant. */
export interface AgentTemplateContribution {
  id: string;
  name: string;
  nameKey?: string;
  description?: string;
  descriptionKey?: string;
  role?: string;
  icon?: string;
  instructions?: string;
  instructionsFile?: string;
  starters?: string[];
  capabilities?: Record<string, string[] | boolean>;
  permissionMode?: 'read_only' | 'edit' | 'autonomous' | 'review';
}

/** A content tab inside a layout sidebar (`contributes.ui.sidebarTabs`). */
export interface SidebarTabContribution {
  id: string;
  title: string;
  titleKey?: string;
  icon?: string;
  sidebars: Array<'chat' | 'code' | 'agent'>;
  entry?: string;
  component?: string;
  order?: number;
  badge?: string;
}

/** A declarative OpenAI-compatible provider (`contributes.providers`). */
export interface ProviderContribution {
  id: string;
  name: string;
  shortName?: string;
  description?: string;
  baseUrl: string;
  consoleUrl?: string;
  icon?: string;
  authHeader?: string;
  authPrefix?: string;
  /** Static headers; `authorization`, `cookie` and `host` are rejected. */
  headers?: Record<string, string>;
  endpoints?: Record<string, string>;
  models: Array<{
    id: string;
    name: string;
    protocols?: Array<'openai-chat'>;
    contextWindow?: number;
    maxOutput?: number;
    reasoning?: boolean;
    attachment?: boolean;
  }>;
}

/** Typed view of the manifest contributions documented in docs/PLUGINS.md. */
export interface PluginContributions {
  ui?: {
    slots?: Array<Record<string, unknown>>;
    views?: Array<Record<string, unknown>>;
    nav?: Array<Record<string, unknown>>;
    sidebarTabs?: SidebarTabContribution[];
    panels?: Array<Record<string, unknown>>;
    commands?: Array<Record<string, unknown>>;
    settingsTabs?: Array<Record<string, unknown>>;
    themes?: Array<Record<string, unknown>>;
    variants?: Array<Record<string, unknown>>;
    presets?: Array<Record<string, unknown>>;
    css?: Array<Record<string, unknown>>;
    genui?: Record<string, unknown>;
  };
  tools?: Array<Record<string, unknown>> | string;
  promptSections?: Array<{ id?: string; title?: string; file: string }>;
  skills?: string[];
  locales?: string[];
  providers?: ProviderContribution[];
  artifactViewers?: Array<Record<string, unknown>>;
  modes?: ModeContribution[];
  agentTemplates?: AgentTemplateContribution[];
}

export interface Manifest {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  version: string;
  apiVersion: 1 | 2;
  description?: string;
  author?: string;
  publisher: { id: string; name: string; keyId?: string };
  permissions: PluginPermission[];
  contributes?: PluginContributions;
  runtime: {
    ui: 'none' | 'declarative' | 'sandbox' | 'trusted';
    entry?: string | null;
    backend?: { kind: 'js'; entry: string } | null;
  };
  trusted?: boolean;
}
