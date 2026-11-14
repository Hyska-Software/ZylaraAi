/**
 * Fallback version shown by the renderer before `app_info` resolves.
 *
 * `app_info.version` (from `CARGO_PKG_VERSION`) is authoritative at runtime.
 * This constant only covers the loading/error path and is kept in sync with the
 * other version sources by `scripts/bump-version.ps1` / `pnpm version:set`.
 */
export const APP_VERSION_FALLBACK = '0.11.1';
