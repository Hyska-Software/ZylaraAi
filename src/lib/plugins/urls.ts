/** Origin helpers for the `zplugin` asset protocol (platform-specific). */
export function pluginAssetUrl(pluginId: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  const encoded = clean
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const windows =
    typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  return windows
    ? `http://zplugin.localhost/${pluginId}/${encoded}`
    : `zplugin://localhost/${pluginId}/${encoded}`;
}

export function pluginIconUrl(pluginId: string, icon: string | null | undefined): string | null {
  return icon ? pluginAssetUrl(pluginId, icon) : null;
}

export function pluginSdkUrl(): string {
  const windows =
    typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  return windows
    ? 'http://zplugin.localhost/@zylara/sdk.js'
    : 'zplugin://localhost/@zylara/sdk.js';
}
