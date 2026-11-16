/**
 * i18next resource key for a plugin's locale bundle.
 *
 * Plugin ids are reverse-DNS and contain dots, which i18next treats as nested
 * key separators. The hash suffix keeps the mapping injective for valid ids
 * such as `com.acme.notes` and `com_acme.notes`.
 */
export function pluginI18nKey(pluginId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pluginId.length; index += 1) {
    hash = Math.imul(hash ^ pluginId.charCodeAt(index), 0x01000193) >>> 0;
  }
  const safe = pluginId.replace(/[^a-z0-9]/g, '_');
  return `${safe}_${hash.toString(16).padStart(8, '0')}`;
}
