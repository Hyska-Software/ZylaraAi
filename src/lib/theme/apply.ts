/**
 * Applies a theme to the document.
 *
 * Themes are declarative: the backend validates every token and asset. This
 * module only maps the validated token map to CSS custom properties, registers
 * bundled fonts and exposes the wallpaper. It never injects CSS or HTML.
 */
import type { ThemeInfo } from '@/lib/types';
import { normalizeThemeTokens } from './tokens';

export const BUILTIN_THEME_ID = 'zylara';
/** Pre-paint cache consumed by the inline script in `index.html`. */
export const THEME_CACHE_KEY = 'zylara.theme.cache';
export const THEME_APPLIED_EVENT = 'zylara:theme-applied';

const WALLPAPER_VAR = '--app-wallpaper';
const FONT_VARS = ['--font-sans', '--font-mono'] as const;
const FONT_FALLBACK_SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_FALLBACK_MONO = "ui-monospace, 'Cascadia Code', 'Fira Code', monospace";

const assetCache = new Map<string, Promise<string>>();
const appliedVariables = new Set<string>();
const fontFaces = new Map<string, FontFace>();

type AssetLoader = (themeId: string, asset: string) => Promise<string>;

function documentRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

function dispatchThemeApplied(): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(THEME_APPLIED_EVENT));
}

function safeFontId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '_');
}

function fontFamilyFor(themeId: string, kind: 'sans' | 'mono'): string {
  return `ZylaraTheme_${safeFontId(themeId)}_${kind}`;
}

/** Radius tokens are consumed by the Tailwind utilities through `--theme-radius-*`. */
function cssVariableForToken(key: string): string {
  return key.startsWith('radius-') ? `--theme-${key}` : `--${key}`;
}

/** Tracks the `dark`/`light` class and the native `color-scheme`. */
export function applyThemeMode(dark: boolean): void {
  const root = documentRoot();
  if (!root) return;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

/**
 * Flattens every corner through the `flat-borders` class in globals.css. The
 * CSS rule also overrides inline theme radii, so no theme re-apply is needed.
 */
export function applyBorderRadius(enabled: boolean): void {
  const root = documentRoot();
  if (!root) return;
  root.classList.toggle('flat-borders', !enabled);
}

/** Reads a computed CSS token from `<html>` with a defensive fallback. */
export function readCssToken(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function cacheTokens(theme: ThemeInfo): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const light = normalizeThemeTokens(theme.light.tokens);
    const dark = normalizeThemeTokens(theme.dark.tokens);
    if (Object.keys(light).length === 0 && Object.keys(dark).length === 0) {
      localStorage.removeItem(THEME_CACHE_KEY);
      return;
    }
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ light, dark }));
  } catch {
    // localStorage may be unavailable in restricted webviews; runtime state stays correct.
  }
}

function trackedVariables(root: HTMLElement): Set<string> {
  const names = new Set(appliedVariables);
  const dataset = root.dataset.themeTokens;
  if (dataset) {
    for (const name of dataset.split(',')) {
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Applies the active variant synchronously (tokens + mode) and caches the token
 * maps for the pre-paint script. Wallpaper and fonts are applied afterwards by
 * {@link applyThemeAssets}.
 */
export function applyThemeTokens(theme: ThemeInfo, dark: boolean): void {
  const root = documentRoot();
  if (!root) return;

  for (const name of trackedVariables(root)) {
    root.style.removeProperty(`--${name}`);
  }
  appliedVariables.clear();
  delete root.dataset.themeTokens;

  const variant = dark ? theme.dark : theme.light;
  for (const [key, value] of Object.entries(normalizeThemeTokens(variant.tokens))) {
    const variable = cssVariableForToken(key);
    root.style.setProperty(variable, value);
    appliedVariables.add(variable.slice(2));
  }
  if (appliedVariables.size > 0) {
    root.dataset.themeTokens = [...appliedVariables].join(',');
  }

  root.style.removeProperty(WALLPAPER_VAR);
  for (const name of FONT_VARS) root.style.removeProperty(name);

  cacheTokens(theme);
  applyThemeMode(dark);
  dispatchThemeApplied();
}

async function loadFontFace(themeId: string, kind: 'sans' | 'mono', dataUrl: string): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    return false;
  }
  const family = fontFamilyFor(themeId, kind);
  try {
    const face = new FontFace(family, `url("${dataUrl}")`);
    await face.load();
    const previous = fontFaces.get(family);
    if (previous) {
      try {
        document.fonts.delete(previous);
      } catch {
        // A missing face is harmless; the new one still gets registered.
      }
    }
    document.fonts.add(face);
    fontFaces.set(family, face);
    return true;
  } catch (error) {
    console.warn(`[theme] could not load the ${kind} font`, error);
    return false;
  }
}

/**
 * Applies the optional wallpaper and bundled fonts. Failures are non-fatal: the
 * palette stays active and the app keeps the default font/wallpaper.
 */
export async function applyThemeAssets(
  theme: ThemeInfo,
  dark: boolean,
  readAsset: AssetLoader,
  isCurrent: () => boolean,
): Promise<void> {
  const root = documentRoot();
  if (!root) return;
  root.style.removeProperty(WALLPAPER_VAR);
  for (const name of FONT_VARS) root.style.removeProperty(name);

  if (theme.builtIn) {
    dispatchThemeApplied();
    return;
  }

  const variant = dark ? theme.dark : theme.light;
  const readOrNull = (asset: string | null | undefined): Promise<string | null> => {
    if (!asset) return Promise.resolve(null);
    return readAsset(theme.id, asset).catch((error: unknown) => {
      console.warn(`[theme] could not read the asset ${asset}`, error);
      return null;
    });
  };

  const [wallpaper, sans, mono] = await Promise.all([
    readOrNull(variant.wallpaper),
    readOrNull(theme.fonts?.sans),
    readOrNull(theme.fonts?.mono),
  ]);
  if (!isCurrent()) return;

  if (wallpaper) {
    root.style.setProperty(WALLPAPER_VAR, `url("${wallpaper}")`);
  }

  const [sansLoaded, monoLoaded] = await Promise.all([
    sans ? loadFontFace(theme.id, 'sans', sans) : Promise.resolve(false),
    mono ? loadFontFace(theme.id, 'mono', mono) : Promise.resolve(false),
  ]);
  if (!isCurrent()) return;

  if (sans && sansLoaded) {
    root.style.setProperty(
      '--font-sans',
      `"${fontFamilyFor(theme.id, 'sans')}", ${FONT_FALLBACK_SANS}`,
    );
    void document.fonts?.ready.then(() => dispatchThemeApplied()).catch(() => undefined);
  }
  if (mono && monoLoaded) {
    root.style.setProperty(
      '--font-mono',
      `"${fontFamilyFor(theme.id, 'mono')}", ${FONT_FALLBACK_MONO}`,
    );
    void document.fonts?.ready.then(() => dispatchThemeApplied()).catch(() => undefined);
  }
  dispatchThemeApplied();
}

/** Reads an asset through the shared cache; failures are evicted. */
export function readThemeAsset(
  themeId: string,
  asset: string,
  loader: AssetLoader,
): Promise<string> {
  const key = `${themeId}:${asset}`;
  const cached = assetCache.get(key);
  if (cached) return cached;
  const promise = loader(themeId, asset).catch((error: unknown) => {
    assetCache.delete(key);
    throw error;
  });
  assetCache.set(key, promise);
  return promise;
}

/** Invalidates the data URLs of one theme after install/update/remove. */
export function forgetThemeAssets(themeId: string): void {
  const prefix = `${themeId}:`;
  for (const key of assetCache.keys()) {
    if (key.startsWith(prefix)) assetCache.delete(key);
  }
}

export function forgetAllThemeAssets(): void {
  assetCache.clear();
}

/** Unregisters the font faces of one theme. */
export function forgetThemeFonts(themeId: string): void {
  const prefix = `ZylaraTheme_${safeFontId(themeId)}_`;
  for (const [family, face] of fontFaces) {
    if (!family.startsWith(prefix)) continue;
    try {
      document.fonts?.delete(face);
    } catch {
      // Ignore: the face may already be gone.
    }
    fontFaces.delete(family);
  }
}
