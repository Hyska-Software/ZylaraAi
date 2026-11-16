/**
 * Theme-token allowlist shared by host themes and plugin theme/preset
 * contributions.
 *
 * Keys are bare CSS custom-property suffixes (`accent`, `radius-md`); the
 * renderer accepts an optional `--` prefix from plugin manifests but always
 * applies the bare form so `radius-*` reaches the host's `--theme-radius-*`
 * mapping.
 */
import themeTokens from '@data/theme-tokens.json';

export const THEME_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([
  ...themeTokens.required,
  ...themeTokens.optionalColor,
  ...themeTokens.optionalLength,
]);

const TOKEN_KEY = /^[a-z0-9-]+$/;
const MAX_VALUE_CHARS = 64;

/**
 * Keeps only allowlisted, syntactically safe tokens. Invalid entries are
 * dropped rather than normalized so a malformed plugin theme cannot smuggle an
 * arbitrary custom property into the document.
 */
export function normalizeThemeTokens(
  tokens: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!tokens) return normalized;
  for (const [rawKey, rawValue] of Object.entries(tokens)) {
    if (typeof rawValue !== 'string') continue;
    const key = rawKey.startsWith('--') ? rawKey.slice(2) : rawKey;
    if (!TOKEN_KEY.test(key) || !THEME_TOKEN_ALLOWLIST.has(key)) continue;
    const value = rawValue.trim();
    if (
      value.length === 0 ||
      value.length > MAX_VALUE_CHARS ||
      value.includes(';') ||
      value.includes('{') ||
      value.includes('}') ||
      /url\s*\(/i.test(value) ||
      /javascript:/i.test(value) ||
      /[\\\u0000-\u001f]/.test(value)
    ) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}
