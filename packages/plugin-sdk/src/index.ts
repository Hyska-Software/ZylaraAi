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

export interface PluginApi {
  readonly pluginId: string;
  readonly locale: string;
  readonly context: Record<string, unknown>;
  readonly theme: PluginInit['theme'];
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (detail: unknown) => void): () => void;
  onTool(handler: (invocation: ToolInvocation) => ToolResult | string | Promise<ToolResult | string>): void;
  t(key: string, fallback?: string): string;
  notify(message: string): Promise<unknown>;
  resize(): void;
  openView(viewId: string): void;
  openPanel(panelId: string): void;
  closeOverlays(): void;
  openExternal(url: string): Promise<unknown>;
  ready(): void;
}

declare global {
  interface Window {
    ZylaraPlugin: PluginApi;
  }
}

export type PluginPermission =
  | 'ui.view'
  | 'ui.panel'
  | 'ui.command'
  | 'ui.artifact'
  | 'ui.settings'
  | 'ui.theme'
  | 'ui.shell'
  | 'ui.css.global'
  | 'commands'
  | 'hotkeys'
  | 'settings'
  | 'agent.tools'
  | 'agent.prompt'
  | 'agent.skills'
  | 'chat.read'
  | 'chat.write'
  | 'storage'
  | 'events'
  | 'notifications'
  | 'clipboard.read'
  | 'dialog'
  | 'opener'
  | 'providers'
  | 'process.spawn'
  | 'secrets.use'
  | 'secrets.read'
  | 'unsafe.renderer'
  | `ui.slot:${string}`
  | `ui.override:${string}`
  | `net:${string}`
  | `fs.read:${string}`
  | `fs.write:${string}`;

export interface Manifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  description?: string;
  author?: string;
  publisher: { id: string; name: string; keyId?: string };
  permissions: PluginPermission[];
  contributes?: Record<string, unknown>;
  runtime: {
    ui: 'none' | 'declarative' | 'sandbox' | 'trusted';
    entry?: string | null;
    backend?: { kind: 'js'; entry: string } | null;
  };
  trusted?: boolean;
}
