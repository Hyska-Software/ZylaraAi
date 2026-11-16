/**
 * Installed-theme state and application.
 *
 * The backend is the source of truth for the installed host packages; plugin
 * themes are projected from the active plugin snapshot by `usePluginStore`.
 * Both feed one merged list so `settings.themeId` is the only persisted
 * selection and `applyThemeTokens` the only application path.
 */
import { create } from 'zustand';

import { api } from '../api';
import { BUILTIN_THEME_ID, applyThemeAssets, applyThemeTokens, forgetAllThemeAssets, forgetThemeAssets, forgetThemeFonts, readThemeAsset } from '../theme/apply';
import type { ThemeInfo, ThemeInstallResult } from '../types';
import { useAppStore } from './appStore';
import { resolveDark, useUiStore } from './uiStore';

export { BUILTIN_THEME_ID } from '../theme/apply';

export const BUILTIN_THEME: ThemeInfo = {
  id: BUILTIN_THEME_ID,
  name: 'Zylara',
  version: '',
  author: '',
  description: '',
  builtIn: true,
  light: { tokens: {}, wallpaper: null },
  dark: { tokens: {}, wallpaper: null },
  fonts: { sans: null, mono: null },
};

function dedupe(themes: readonly ThemeInfo[]): ThemeInfo[] {
  const seen = new Set<string>();
  return themes.filter((theme) => {
    if (seen.has(theme.id)) return false;
    seen.add(theme.id);
    return true;
  });
}

/**
 * Built-in → bundled → installed host packages → plugin themes. Plugin themes
 * are intentionally last so host packages keep their existing position in the
 * gallery.
 */
function mergeThemes(
  host: readonly ThemeInfo[],
  plugin: readonly ThemeInfo[],
): ThemeInfo[] {
  const unique = dedupe([...host, ...plugin]);
  const zylara = unique.find((theme) => theme.id === BUILTIN_THEME_ID && theme.builtIn);
  const bundled = unique.filter(
    (theme) => theme.builtIn && theme.id !== BUILTIN_THEME_ID,
  );
  const installed = unique
    .filter(
      (theme) =>
        !theme.builtIn &&
        theme.id !== BUILTIN_THEME_ID &&
        !theme.pluginId,
    )
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  const contributed = unique
    .filter((theme) => Boolean(theme.pluginId))
    .sort(
      (a, b) =>
        (a.pluginName ?? '').localeCompare(b.pluginName ?? '') ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
  return [zylara ?? BUILTIN_THEME, ...bundled, ...installed, ...contributed];
}

interface ThemeState {
  /** Host packages returned by `list_themes` (built-in/bundled/installed). */
  hostThemes: ThemeInfo[];
  /** Themes synthesized from the active plugin snapshot. */
  pluginThemes: ThemeInfo[];
  /** Merged public list: built-in, bundled, installed, then plugin themes. */
  themes: ThemeInfo[];
  activeId: string;
  ready: boolean;
  /** Last `listThemes` failure (install/uninstall failures are thrown to the UI). */
  error: string | null;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  setPluginThemes: (themes: ThemeInfo[]) => void;
  apply: () => void;
  setActive: (id: string) => Promise<void>;
  install: (path: string) => Promise<ThemeInstallResult>;
  uninstall: (id: string) => Promise<void>;
  openFolder: () => Promise<void>;
}

let applySeq = 0;
let subscribed = false;

export const useThemeStore = create<ThemeState>()((set, get) => ({
  hostThemes: [BUILTIN_THEME],
  pluginThemes: [],
  themes: [BUILTIN_THEME],
  activeId: BUILTIN_THEME_ID,
  ready: false,
  error: null,

  init: async () => {
    if (get().ready) return;
    let hostThemes = [BUILTIN_THEME];
    let error: string | null = null;
    let listFailed = false;
    try {
      hostThemes = await api.listThemes();
    } catch (cause) {
      listFailed = true;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const themes = mergeThemes(hostThemes, get().pluginThemes);
    const requested = useAppStore.getState().settings.themeId || BUILTIN_THEME_ID;
    const activeId = themes.some((theme) => theme.id === requested) ? requested : BUILTIN_THEME_ID;
    set({ hostThemes, themes, activeId, ready: true, error });
    if (!listFailed && activeId !== requested) {
      void useAppStore.getState().saveSettings({ themeId: activeId });
    }
    if (!subscribed) {
      subscribed = true;
      useUiStore.subscribe((state, previous) => {
        if (state.theme !== previous.theme) useThemeStore.getState().apply();
      });
    }
    get().apply();
  },

  refresh: async () => {
    const previous = get().hostThemes;
    let hostThemes: ThemeInfo[];
    try {
      hostThemes = await api.listThemes();
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
      get().apply();
      return;
    }
    for (const theme of previous) forgetThemeFonts(theme.id);
    forgetAllThemeAssets();
    const themes = mergeThemes(hostThemes, get().pluginThemes);
    const requested = get().activeId;
    const activeId = themes.some((theme) => theme.id === requested) ? requested : BUILTIN_THEME_ID;
    set({ hostThemes, themes, activeId, error: null });
    if (activeId !== requested) {
      await useAppStore.getState().saveSettings({ themeId: activeId });
    }
    get().apply();
  },

  setPluginThemes: (pluginThemes) => {
    const themes = mergeThemes(get().hostThemes, pluginThemes);
    const requested = get().activeId;
    const missing = requested !== BUILTIN_THEME_ID && !themes.some((theme) => theme.id === requested);
    const activeId = missing ? BUILTIN_THEME_ID : requested;
    set({ pluginThemes, themes, activeId });
    if (missing && get().ready) {
      void useAppStore.getState().saveSettings({ themeId: BUILTIN_THEME_ID });
    }
    if (get().ready) get().apply();
  },

  apply: () => {
    const { themes, activeId } = get();
    const theme = themes.find((entry) => entry.id === activeId) ?? BUILTIN_THEME;
    const dark = resolveDark(useUiStore.getState().theme);
    applyThemeTokens(theme, dark);
    const sequence = ++applySeq;
    void applyThemeAssets(
      theme,
      dark,
      (themeId, asset) => readThemeAsset(themeId, asset, api.getThemeAsset),
      () => sequence === applySeq,
    );
  },

  setActive: async (id) => {
    if (!get().themes.some((theme) => theme.id === id)) return;
    set({ activeId: id });
    await useAppStore.getState().saveSettings({ themeId: id });
    get().apply();
  },

  install: async (path) => {
    const result = await api.installTheme(path);
    forgetThemeAssets(result.theme.id);
    forgetThemeFonts(result.theme.id);
    let hostThemes: ThemeInfo[];
    try {
      hostThemes = await api.listThemes();
    } catch {
      hostThemes = [
        ...get().hostThemes.filter((theme) => theme.id !== result.theme.id),
        result.theme,
      ];
    }
    const themes = mergeThemes(hostThemes, get().pluginThemes);
    set({ hostThemes, themes, error: null });
    if (get().activeId === result.theme.id) get().apply();
    return result;
  },

  uninstall: async (id) => {
    if (get().pluginThemes.some((theme) => theme.id === id)) return;
    const hostThemes = await api.uninstallTheme(id);
    forgetThemeAssets(id);
    forgetThemeFonts(id);
    const themes = mergeThemes(hostThemes, get().pluginThemes);
    set({ hostThemes, themes });
    if (get().activeId === id) {
      set({ activeId: BUILTIN_THEME_ID });
      await useAppStore.getState().saveSettings({ themeId: BUILTIN_THEME_ID });
    }
    get().apply();
  },

  openFolder: async () => {
    await api.openThemesDir();
  },
}));
