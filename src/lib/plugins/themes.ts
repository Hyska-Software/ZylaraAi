/**
 * Projects enabled plugin theme contributions into host `ThemeInfo` entries.
 *
 * The id is a stable, settings-safe namespace (`plugin-<16 hex>`): host theme
 * ids are limited to `[a-z0-9][a-z0-9._-]{0,63}`, so a readable
 * `plugin:<id>:<theme>` key cannot be persisted in `settings.themeId`.
 */
import type { ThemeInfo } from '@/lib/types';

import { pluginHasPermission } from './registry';
import { normalizeThemeTokens } from '@/lib/theme/tokens';
import type { PluginRecord } from './types';

export const PLUGIN_THEME_ID_PREFIX = 'plugin-';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/** Stable `plugin-<16 hex>` id for one plugin theme contribution. */
export function pluginThemeId(pluginId: string, themeId: string): string {
  const data = `${pluginId}\u0000${themeId}`;
  let hash = FNV_OFFSET;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= BigInt(data.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_PRIME) & FNV_MASK;
  }
  return `${PLUGIN_THEME_ID_PREFIX}${hash.toString(16).padStart(16, '0')}`;
}

/** Host-compatible themes for every enabled plugin that may contribute themes. */
export function pluginThemeInfos(
  plugins: readonly PluginRecord[],
): ThemeInfo[] {
  const themes: ThemeInfo[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.active || !plugin.enabled) continue;
    if (!pluginHasPermission(plugin, 'ui.theme')) continue;
    for (const theme of plugin.manifest.contributes.ui.themes) {
      const id = pluginThemeId(plugin.id, theme.id);
      if (seen.has(id)) continue;
      seen.add(id);
      themes.push({
        id,
        name: theme.name,
        version: plugin.version,
        author: plugin.publisherName || plugin.author,
        description: plugin.description,
        builtIn: false,
        pluginId: plugin.id,
        pluginName: plugin.name,
        light: {
          tokens: normalizeThemeTokens(theme.light),
          wallpaper: null,
        },
        dark: {
          tokens: normalizeThemeTokens(theme.dark),
          wallpaper: null,
        },
        fonts: { sans: null, mono: null },
      });
    }
  }
  return themes;
}
