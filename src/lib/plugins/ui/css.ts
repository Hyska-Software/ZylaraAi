/** Plugin CSS: sanitize, rewrite package assets and mount per layout. */
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { PLUGIN_UI_LIMITS } from '@/lib/plugins/contract';
import { pluginAssetUrl } from '@/lib/plugins/urls';
import { useUiStore } from '@/lib/store/uiStore';

import { usePluginUiPrefs } from './prefs';
import { usePluginUi } from './registry';
import type { CssEntry } from './types';

const FORBIDDEN = [
  /@import/i,
  /expression\s*\(/i,
  /behavior\s*:/i,
  /-moz-binding/i,
  /javascript:/i,
];

export function sanitizePluginCss(css: string): { css: string; error: string | null } {
  if (css.length > PLUGIN_UI_LIMITS.cssCharsPerPlugin) {
    return { css: '', error: 'PLUGIN_CSS_REJECTED: too large' };
  }
  for (const pattern of FORBIDDEN) {
    if (pattern.test(css)) return { css: '', error: `PLUGIN_CSS_REJECTED: ${pattern}` };
  }
  if (/url\(\s*['"]?\s*(?:https?:|\/\/)/i.test(css)) {
    return { css: '', error: 'PLUGIN_CSS_REJECTED: external url' };
  }
  return { css, error: null };
}

function resolveAssetPath(file: string, relative: string): string {
  const segments = file.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

export function rewritePluginCssUrls(css: string, pluginId: string, file: string): string {
  return css.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, _quote: string, raw: string) => {
    const value = raw.trim();
    if (!value) return match;
    if (/^(data:|#|zplugin:|https?:|\/\/|\/)/i.test(value)) return match;
    const resolved = resolveAssetPath(file, value);
    return `url("${pluginAssetUrl(pluginId, resolved)}")`;
  });
}

interface CachedCss {
  version: string;
  updatedAt: number;
  css: string;
}

function sameCssVersion(
  cached: CachedCss | undefined,
  entry: CssEntry,
): boolean {
  return Boolean(
    cached &&
      cached.version === (entry.plugin?.version ?? '') &&
      cached.updatedAt === (entry.plugin?.updatedAt ?? 0),
  );
}

export function usePluginStyles(): void {
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const layout = useUiStore((state) => state.layoutMode);
  const [files, setFiles] = useState<Record<string, CachedCss>>({});

  useEffect(() => {
    let cancelled = false;
    const activeKeys = new Set(ui.css.map((entry) => entry.key));
    setFiles((current) => {
      const next: Record<string, CachedCss> = {};
      let changed = false;
      for (const [key, value] of Object.entries(current)) {
        if (activeKeys.has(key)) next[key] = value;
        else changed = true;
      }
      return changed ? next : current;
    });
    for (const entry of ui.css) {
      if (!entry.file || !entry.pluginId || !entry.plugin) continue;
      if (sameCssVersion(files[entry.key], entry)) continue;
      const version = entry.plugin.version;
      const updatedAt = entry.plugin.updatedAt;
      void api
        .pluginAssetText(entry.pluginId, entry.file)
        .then((text) => {
          if (cancelled) return;
          setFiles((current) => ({
            ...current,
            [entry.key]: { version, updatedAt, css: text },
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setFiles((current) => ({
            ...current,
            [entry.key]: { version, updatedAt, css: '' },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [ui.css, files]);

  useEffect(() => {
    const mounted: HTMLStyleElement[] = [];
    if (prefs.enabled) {
      const entries: CssEntry[] = ui.css.filter(
        (entry) =>
          (entry.layouts.length === 0 || entry.layouts.includes(layout)) &&
          !prefs.disabled.includes(entry.key),
      );
      for (const entry of entries) {
        const source = entry.css ?? (entry.file ? files[entry.key]?.css : '');
        if (!source) continue;
        const sanitized = sanitizePluginCss(source);
        if (sanitized.error || !entry.pluginId) {
          console.warn(`[plugins] ${sanitized.error ?? 'css missing plugin'} (${entry.key})`);
          continue;
        }
        const style = document.createElement('style');
        style.dataset.zylaraPluginCss = entry.key;
        style.textContent = entry.file
          ? rewritePluginCssUrls(sanitized.css, entry.pluginId, entry.file)
          : sanitized.css;
        document.head.appendChild(style);
        mounted.push(style);
      }
    }
    return () => {
      for (const style of mounted) style.remove();
    };
  }, [files, layout, prefs.disabled, prefs.enabled, ui.css]);
}
