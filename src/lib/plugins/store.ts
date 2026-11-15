/**
 * Installed plugin state. The Rust manager is the source of truth for
 * activation/permissions; this store only mirrors snapshots and coordinates UI
 * state (open view/panel, selected declarative theme).
 */
import { create } from 'zustand';

import { i18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { resolveDark, useUiStore } from '@/lib/store/uiStore';
import { useAppStore } from '@/lib/store/appStore';
import { useThemeStore } from '@/lib/store/themeStore';
import { setPluginSnapshot, usePluginRegistry } from './registry';
import type {
  PluginLogRow,
  PluginAuditRow,
  PluginLocaleBundle,
  PluginPackageInspection,
  PluginRecord,
  PluginSnapshot,
  PluginStoreView,
  PluginThemeEntry,
  PluginThemeSelection,
  PluginUpdateInfo,
} from './types';

const EMPTY_SNAPSHOT: PluginSnapshot = {
  plugins: [],
  safeMode: false,
  pluginsEnabled: true,
  allowTrusted: false,
  devMode: false,
  configFingerprint: '',
};

const THEME_STORAGE_KEY = 'zylara.plugin.theme';

interface ActiveTarget {
  pluginId: string;
  id: string;
}

interface PluginState {
  snapshot: PluginSnapshot;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  store: PluginStoreView | null;
  storeLoading: boolean;
  storeError: string | null;
  updates: PluginUpdateInfo[];
  updatesLoading: boolean;
  busyPluginId: string | null;
  localeBundle: PluginLocaleBundle;
  themes: PluginThemeEntry[];
  activeTheme: PluginThemeSelection | null;
  activeView: ActiveTarget | null;
  activePanel: ActiveTarget | null;
  lastInspection: PluginPackageInspection | null;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  refreshStore: (force?: boolean) => Promise<void>;
  checkUpdates: (force?: boolean) => Promise<void>;
  inspectPackage: (path: string) => Promise<PluginPackageInspection>;
  installPackage: (
    path: string,
    grantedPermissions?: string[] | null,
    allowUnsigned?: boolean,
    allowKeyRotation?: boolean,
  ) => Promise<PluginRecord>;
  installFolder: (path: string, grantedPermissions?: string[] | null) => Promise<PluginRecord>;
  installUrl: (
    url: string,
    grantedPermissions?: string[] | null,
    allowUnsigned?: boolean,
    allowKeyRotation?: boolean,
  ) => Promise<PluginRecord>;
  installFromStore: (
    pluginId: string,
    grantedPermissions?: string[] | null,
    allowKeyRotation?: boolean,
  ) => Promise<PluginRecord>;
  updatePlugin: (
    pluginId: string,
    grantedPermissions?: string[] | null,
    allowKeyRotation?: boolean,
  ) => Promise<PluginRecord>;
  rollback: (pluginId: string) => Promise<PluginRecord>;
  uninstall: (pluginId: string, keepData: boolean) => Promise<void>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<PluginRecord>;
  setPermissions: (pluginId: string, permissions: string[]) => Promise<PluginRecord>;
  setAutoUpdate: (pluginId: string, enabled: boolean) => Promise<void>;
  devReload: (pluginId?: string | null) => Promise<void>;
  openDir: (pluginId: string) => Promise<void>;
  logs: (pluginId: string, limit?: number) => Promise<PluginLogRow[]>;
  audit: (pluginId: string, limit?: number) => Promise<PluginAuditRow[]>;
  openView: (pluginId: string, viewId: string) => void;
  openPanel: (pluginId: string, panelId: string) => void;
  closeOverlays: () => void;
  leaveSafeMode: () => Promise<void>;
  setActiveTheme: (selection: PluginThemeSelection | null) => void;
  saveSecret: (pluginId: string, key: string, value: string | null) => Promise<void>;
  listSecrets: (pluginId: string) => Promise<string[]>;
}

let initialized: Promise<void> | null = null;
let themeListenerInstalled = false;

function readStoredTheme(): PluginThemeSelection | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PluginThemeSelection>;
    return typeof parsed.pluginId === 'string' && typeof parsed.themeId === 'string'
      ? { pluginId: parsed.pluginId, themeId: parsed.themeId }
      : null;
  } catch {
    return null;
  }
}

function mergeLocaleFallback(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] =
      value &&
      current &&
      typeof value === 'object' &&
      typeof current === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(current)
        ? mergeLocaleFallback(
            current as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return merged;
}

function flattenedPluginLocales(bundle: PluginLocaleBundle): void {
  for (const [pluginId, locales] of Object.entries(bundle.entries ?? {})) {
    const fallback = locales.en;
    const english = fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? (fallback as Record<string, unknown>)
      : {};
    for (const [locale, value] of Object.entries(locales)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const merged =
        locale === 'en'
          ? (value as Record<string, unknown>)
          : mergeLocaleFallback(english, value as Record<string, unknown>);
      i18n.addResourceBundle(locale, 'plugins', { [pluginId]: merged }, true, true);
    }
  }
}

const appliedThemeKeys = new Set<string>();

function clearPluginTheme(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const key of appliedThemeKeys) root.style.removeProperty(key);
  appliedThemeKeys.clear();
  // The theme store owns every host token. Re-applying it restores the active
  // theme after a plugin override is removed.
  useThemeStore.getState().apply();
}

function applyPluginTheme(selection: PluginThemeSelection | null): void {
  if (typeof document === 'undefined') return;
  clearPluginTheme();
  if (!selection) return;
  const entry = usePluginStore
    .getState()
    .themes.find(
      (candidate) =>
        candidate.pluginId === selection.pluginId && candidate.theme.id === selection.themeId,
    );
  if (!entry) return;
  const dark = resolveDark(useUiStore.getState().theme);
  const tokens = dark ? entry.theme.dark : entry.theme.light;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith('--') || typeof value !== 'string') continue;
    root.style.setProperty(key, value);
    appliedThemeKeys.add(key);
  }
}

function rememberTheme(selection: PluginThemeSelection | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (selection) {
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(selection));
    } else {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
  } catch {
    // Persisting the visual preference is best-effort.
  }
}

async function runAutoUpdate(): Promise<void> {
  try {
    const updates = await api.checkPluginUpdates(null, false);
    const installed = usePluginStore.getState().snapshot.plugins;
    const eligible = updates.filter((update) => {
      const plugin = installed.find((candidate) => candidate.id === update.pluginId);
      return Boolean(plugin?.autoUpdate) && update.newPermissions.length === 0;
    });
    if (eligible.length === 0) return;
    for (const update of eligible) {
      try {
        await api.updatePlugin(update.pluginId, null, update.permissions);
      } catch {
        // A failed auto-update keeps the previous version and stays visible in
        // Updates for a manual retry.
      }
    }
    await usePluginStore.getState().reload();
    await usePluginStore.getState().checkUpdates();
  } catch {
    // Auto-update is best-effort and never blocks boot.
  }
}

export const usePluginStore = create<PluginState>()((set, get) => ({
  snapshot: EMPTY_SNAPSHOT,
  loading: false,
  initialized: false,
  error: null,
  store: null,
  storeLoading: false,
  storeError: null,
  updates: [],
  updatesLoading: false,
  busyPluginId: null,
  localeBundle: { entries: {} },
  themes: [],
  activeTheme: readStoredTheme(),
  activeView: null,
  activePanel: null,
  lastInspection: null,

  init: async () => {
    if (initialized) return initialized;
    initialized = (async () => {
      set({ loading: true });
      try {
        const snapshot = await api.listPlugins();
        setPluginSnapshot(snapshot);
        set({ snapshot, loading: false, initialized: true, error: null });
        try {
          const [localeBundle, themes] = await Promise.all([
            api.getPluginLocales(),
            api.getPluginThemes(),
          ]);
          flattenedPluginLocales(localeBundle);
          set({ localeBundle, themes });
        } catch {
          // Locales/themes are optional; installed contributions still work.
        }
        get().setActiveTheme(readStoredTheme());
        if (!themeListenerInstalled && typeof window !== 'undefined') {
          themeListenerInstalled = true;
          useUiStore.subscribe((next, previous) => {
            if (next.theme !== previous.theme) {
              applyPluginTheme(usePluginStore.getState().activeTheme);
            }
          });
        }
        const appSettings = useAppStore.getState().settings;
        if (
          appSettings.pluginAutoUpdate &&
          appSettings.pluginRegistryUrl &&
          !snapshot.safeMode &&
          snapshot.pluginsEnabled
        ) {
          void runAutoUpdate();
        }
      } catch (error) {
        set({
          loading: false,
          initialized: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return initialized;
  },

  reload: async () => {
    try {
      const snapshot = await api.listPlugins();
      setPluginSnapshot(snapshot);
      set({ snapshot, error: null });
      const [localeBundle, themes] = await Promise.all([
        api.getPluginLocales().catch(() => ({ entries: {} })),
        api.getPluginThemes().catch(() => [] as PluginThemeEntry[]),
      ]);
      flattenedPluginLocales(localeBundle);
      set({ localeBundle, themes });
      // A missing plugin invalidates the selected theme/targets.
      const activeTheme = get().activeTheme;
      if (
        activeTheme &&
        !themes.some(
          (entry) =>
            entry.pluginId === activeTheme.pluginId && entry.theme.id === activeTheme.themeId,
        )
      ) {
        set({ activeTheme: null });
        rememberTheme(null);
      }
      applyPluginTheme(get().activeTheme);
      const activeView = get().activeView;
      const activePanel = get().activePanel;
      if (activeView && !snapshot.plugins.some((plugin) => plugin.id === activeView.pluginId)) {
        set({ activeView: null });
      }
      if (activePanel && !snapshot.plugins.some((plugin) => plugin.id === activePanel.pluginId)) {
        set({ activePanel: null });
      }
      void useAppStore.getState().reloadCatalog();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  refreshStore: async (force = false) => {
    set({ storeLoading: true, storeError: null });
    try {
      const store = await api.storeRefresh(null, force);
      set({ store, storeLoading: false });
      const updates = await api.checkPluginUpdates(null, false).catch(() => []);
      set({ updates });
    } catch (error) {
      set({
        storeLoading: false,
        storeError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  checkUpdates: async (force = false) => {
    set({ updatesLoading: true });
    try {
      const updates = await api.checkPluginUpdates(null, force);
      set({ updates, updatesLoading: false });
    } catch (error) {
      set({
        updatesLoading: false,
        storeError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  inspectPackage: async (path) => {
    const inspection = await api.inspectPluginPackage(path);
    set({ lastInspection: inspection });
    return inspection;
  },

  installPackage: async (
    path,
    grantedPermissions,
    allowUnsigned = false,
    allowKeyRotation = false,
  ) => {
    set({ busyPluginId: 'install' });
    try {
      const plugin = await api.installPlugin(
        path,
        grantedPermissions,
        allowUnsigned,
        allowKeyRotation,
      );
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  installFolder: async (path, grantedPermissions) => {
    set({ busyPluginId: 'install' });
    try {
      const plugin = await api.installPluginFolder(path, grantedPermissions);
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  installUrl: async (
    url,
    grantedPermissions,
    allowUnsigned = false,
    allowKeyRotation = false,
  ) => {
    set({ busyPluginId: 'install' });
    try {
      const plugin = await api.installPluginUrl(
        url,
        grantedPermissions,
        allowUnsigned,
        allowKeyRotation,
      );
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  installFromStore: async (pluginId, grantedPermissions, allowKeyRotation = false) => {
    set({ busyPluginId: pluginId });
    try {
      const plugin = await api.installPluginStore(
        pluginId,
        null,
        grantedPermissions ?? null,
        allowKeyRotation,
      );
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  updatePlugin: async (pluginId, grantedPermissions, allowKeyRotation = false) => {
    set({ busyPluginId: pluginId });
    try {
      const plugin = await api.updatePlugin(
        pluginId,
        null,
        grantedPermissions ?? null,
        allowKeyRotation,
      );
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  rollback: async (pluginId) => {
    set({ busyPluginId: pluginId });
    try {
      const plugin = await api.rollbackPlugin(pluginId);
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  uninstall: async (pluginId, keepData) => {
    set({ busyPluginId: pluginId });
    try {
      await api.uninstallPlugin(pluginId, keepData);
      await get().reload();
    } finally {
      set({ busyPluginId: null });
    }
  },

  setEnabled: async (pluginId, enabled) => {
    set({ busyPluginId: pluginId });
    try {
      const plugin = await api.setPluginEnabled(pluginId, enabled);
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  setPermissions: async (pluginId, permissions) => {
    set({ busyPluginId: pluginId });
    try {
      const plugin = await api.setPluginPermissions(pluginId, permissions);
      await get().reload();
      return plugin;
    } finally {
      set({ busyPluginId: null });
    }
  },

  setAutoUpdate: async (pluginId, enabled) => {
    await api.setPluginAutoUpdate(pluginId, enabled);
    await get().reload();
  },

  devReload: async (pluginId) => {
    await api.pluginDevReload(pluginId ?? null);
    await get().reload();
  },

  openDir: async (pluginId) => {
    await api.openPluginDir(pluginId);
  },

  logs: (pluginId, limit = 100) => api.listPluginLogs(pluginId, limit),
  audit: (pluginId, limit = 100) => api.listPluginAudit(pluginId, limit),

  openView: (pluginId, viewId) =>
    set({ activeView: { pluginId, id: viewId }, activePanel: null }),
  openPanel: (pluginId, panelId) =>
    set({ activePanel: { pluginId, id: panelId }, activeView: null }),
  closeOverlays: () => set({ activeView: null, activePanel: null }),

  leaveSafeMode: async () => {
    await useAppStore.getState().saveSettings({
      pluginSafeMode: false,
      pluginsEnabled: true,
    });
    await api.pluginLeaveSafeMode();
    await get().reload();
  },

  setActiveTheme: (selection) => {
    rememberTheme(selection);
    set({ activeTheme: selection });
    applyPluginTheme(selection);
  },

  saveSecret: (pluginId, key, value) => api.setPluginSecret(pluginId, key, value),
  listSecrets: (pluginId) => api.listPluginSecrets(pluginId),
}));

export function activePlugin(pluginId: string): PluginRecord | undefined {
  return usePluginStore
    .getState()
    .snapshot.plugins.find((plugin) => plugin.id === pluginId);
}

export function pluginThemeEntries(): PluginThemeEntry[] {
  return usePluginStore.getState().themes;
}

export { usePluginRegistry };
