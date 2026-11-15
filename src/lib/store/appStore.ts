import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../api';
import { setLanguage } from '../i18n';
import {
  defaultReasoningFor,
  defaultSelection,
  defaultSelectionFrom,
  findModelIn,
  findProviderIn,
} from '../catalog';
import type {
  AppInfo,
  LoginChallenge,
  ModelSelection,
  ProviderAuthStatus,
  ProviderInfo,
  ProviderKeyStatus,
  ProviderValidation,
  ReasoningSelection,
  Settings,
  SettingsView,
} from '../types';

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  themeId: 'zylara',
  locale: 'en',
  defaultProvider: 'opencode-go',
  defaultModel: 'deepseek-v4.1-flash',
  reasoningDefault: 'max',
  systemPrompt: '',
  webSearchEnabled: true,
  fileCreationEnabled: true,
  sendKey: 'enter',
  showTokenUsage: true,
  reduceMotion: false,
  thinkingCollapsedByDefault: false,
  fontScale: 1,
  terminalFontFamily: '',
  terminalFontSize: 12,
  includeAttachments: true,
  autoTitle: true,
  codeExecutionEnabled: false,
  codeTimeoutSecs: 120,
  codePythonPath: '',
  codeNodePath: '',
  skillsPanelEnabled: true,
  disabledSkills: [],
  // Padrão do produto para novas sessões do Code (Configurações → Ferramentas).
  codeDefaultPermissionMode: 'autonomous',
  closeToTray: true,
  closeToTrayPrompted: false,
  pluginsEnabled: true,
  pluginRegistryUrl: '',
  pluginAutoUpdate: false,
  pluginAllowTrusted: false,
  pluginSafeMode: false,
  pluginDevMode: false,
};

interface AppState {
  ready: boolean;
  initializing: boolean;
  appInfo: AppInfo | null;
  settings: Settings;
  keys: ProviderKeyStatus[];
  auth: ProviderAuthStatus[];
  /** Present when `secrets.json` could not be parsed (backend-reported). */
  secretsError: string | null;
  providers: ProviderInfo[];
  selection: ModelSelection;
  favorites: string[];
  error: string | null;
  catalogRefreshedAt: number | null;
  /** Pending ChatGPT login attempt (URL is shown so it can be reopened). */
  loginChallenge: LoginChallenge | null;

  init: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  /**
   * Reloads settings from the backend without touching the catalog/model
   * selection. Used after commands that mutate settings server-side (e.g.
   * skill enable/disable) so a later full save cannot clobber the change.
   */
  reloadSettings: () => Promise<void>;
  setProviderKey: (providerId: string, key: string | null) => Promise<void>;
  setSelection: (selection: ModelSelection) => void;
  /**
   * Updates the active selection without touching the persisted defaults.
   * Used when opening an existing conversation (its model is locked in) and
   * when "Novo chat" resets to the configured defaults.
   */
  setActiveSelection: (selection: ModelSelection) => void;
  setReasoning: (reasoning: ReasoningSelection | null) => void;
  /** Favorites are keyed by `providerId:modelId` (legacy bare ids still match). */
  toggleFavorite: (providerId: string, modelId?: string) => void;
  isFavorite: (providerId: string, modelId?: string) => boolean;
  refreshCatalog: () => Promise<void>;
  /** Reloads only the local catalog view (plugin providers) without probing. */
  reloadCatalog: () => Promise<void>;
  refreshProviderModels: (providerId: string) => Promise<ProviderInfo[]>;
  validateProvider: (providerId: string) => Promise<ProviderValidation>;
  setError: (error: string | null) => void;

  /* -------- ChatGPT plan auth -------- */
  authStatus: (providerId: string) => ProviderAuthStatus | undefined;
  /** Whether the active provider can send a turn (API key or OAuth token). */
  providerReady: (providerId: string) => boolean;
  startChatGptLogin: (providerId: string, forceConsent?: boolean) => Promise<LoginChallenge>;
  awaitChatGptLogin: (attemptId: string) => Promise<ProviderAuthStatus>;
  cancelChatGptLogin: (attemptId: string) => Promise<void>;
  refreshAuth: () => Promise<void>;
  signOutProvider: (providerId: string) => Promise<void>;
}

/** Favorite key for a provider/model pair. */
export function favoriteKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function matchesFavorite(favorites: string[], providerId: string, modelId: string): boolean {
  return favorites.includes(favoriteKey(providerId, modelId)) || favorites.includes(modelId);
}

function keysFromView(view: SettingsView): ProviderKeyStatus[] {
  return view.keys;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      ready: false,
      initializing: false,
      appInfo: null,
      settings: DEFAULT_SETTINGS,
      keys: [],
      auth: [],
      secretsError: null,
      providers: [],
      selection: defaultSelection(DEFAULT_SETTINGS),
      favorites: ['glm-5.3-flash', 'claude-haiku-5-5', 'gpt-6-luna', 'kimi-k3'],
      error: null,
      catalogRefreshedAt: null,
      loginChallenge: null,

      init: async () => {
        if (get().initializing) return;
        set({ initializing: true, error: null });
        try {
          const [view, catalogView, info] = await Promise.all([
            api.getSettings(),
            api.getCatalog(),
            api.appInfo().catch(() => null),
          ]);
          const settings = view.settings;
          // The merged view (bundled catalog + account model list) is the
          // source of truth for the renderer, not the static JSON import.
          const providers = catalogView.catalog.providers;
          const persisted = get().selection;
          const fallback = defaultSelectionFrom(settings, providers);
          const candidateProvider = persisted?.providerId ?? fallback.providerId;
          const provider =
            findProviderIn(providers, candidateProvider) ??
            findProviderIn(providers, fallback.providerId);
          const modelId =
            persisted?.modelId && provider?.models.some((m) => m.id === persisted.modelId)
              ? persisted.modelId
              : fallback.modelId;
          const model = findModelIn(providers, provider?.id ?? fallback.providerId, modelId);
          const reasoning =
            persisted?.reasoning && persisted.providerId === provider?.id && persisted.modelId === modelId
              ? persisted.reasoning
              : defaultReasoningFor(model);

          set({
            ready: true,
            initializing: false,
            settings,
            keys: keysFromView(view),
            auth: view.auth ?? catalogView.auth ?? [],
            secretsError: view.secretsError ?? null,
            providers,
            appInfo: info,
            selection: { providerId: provider?.id ?? fallback.providerId, modelId, reasoning },
            catalogRefreshedAt: catalogView.remoteRefreshedAt ?? null,
          });
          await setLanguage(settings.locale);
        } catch (error) {
          set({ initializing: false, error: error instanceof Error ? error.message : String(error) });
        }
      },

      saveSettings: async (patch) => {
        const previousLocale = get().settings.locale;
        const changesLocale = patch.locale !== undefined;
        const next: Settings = { ...get().settings, ...patch };
        set({ settings: next });
        if (changesLocale) await setLanguage(next.locale);
        try {
          const view = await api.saveSettings(next);
          set({
            settings: view.settings,
            keys: view.keys,
            auth: view.auth ?? get().auth,
            secretsError: view.secretsError ?? null,
          });
          if (changesLocale) await setLanguage(view.settings.locale);
        } catch (error) {
          set((state) => ({
            settings: changesLocale ? { ...state.settings, locale: previousLocale } : state.settings,
            error: error instanceof Error ? error.message : String(error),
          }));
          if (changesLocale) await setLanguage(previousLocale);
        }
      },

      reloadSettings: async () => {
        try {
          const view = await api.getSettings();
          set({
            settings: view.settings,
            keys: view.keys,
            auth: view.auth ?? get().auth,
            secretsError: view.secretsError ?? null,
          });
          await setLanguage(view.settings.locale);
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        }
      },

      setProviderKey: async (providerId, key) => {
        try {
          const view = await api.setProviderKey(providerId, key);
          set({ keys: view.keys, auth: view.auth ?? get().auth });
          // A saved API key unlocks the provider account model list: pull it
          // right away so the picker already shows every model the account can
          // use (new ids/snapshots included) without a manual "Atualizar".
          // Providers without a `models` endpoint (Go/Zen gateways) keep only
          // the bundled catalog.
          if (!key) return;
          const provider = get().providers.find((entry) => entry.id === providerId);
          if (!provider?.endpoints?.models) return;
          try {
            await get().refreshProviderModels(providerId);
          } catch {
            // Non-fatal: the bundled catalog stays usable and "Testar conexão"
            // surfaces the real credential/network error.
          }
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        }
      },

      setSelection: (selection) => {
        set({ selection });
        const settings = get().settings;
        if (settings.defaultProvider !== selection.providerId || settings.defaultModel !== selection.modelId) {
          void get().saveSettings({ defaultProvider: selection.providerId, defaultModel: selection.modelId });
        }
      },

      setReasoning: (reasoning) => set((state) => ({ selection: { ...state.selection, reasoning } })),

      setActiveSelection: (selection) => set({ selection }),

      toggleFavorite: (providerId, modelId) => {
        // Legacy callers pass only the model id: resolve against the active
        // provider so the UI keeps working while call sites migrate.
        const pairProvider = modelId === undefined ? get().selection.providerId : providerId;
        const pairModel = modelId ?? providerId;
        const key = favoriteKey(pairProvider, pairModel);
        set((state) => {
          const active = matchesFavorite(state.favorites, pairProvider, pairModel);
          const without = state.favorites.filter(
            (entry) => entry !== key && entry !== pairModel,
          );
          return { favorites: active ? without : [key, ...without] };
        });
      },

      isFavorite: (providerId, modelId) => {
        const pairProvider = modelId === undefined ? get().selection.providerId : providerId;
        const pairModel = modelId ?? providerId;
        return matchesFavorite(get().favorites, pairProvider, pairModel);
      },

      reloadCatalog: async () => {
        try {
          const catalogView = await api.getCatalog();
          const providers = catalogView.catalog.providers;
          const current = get().selection;
          const fallback = defaultSelectionFrom(get().settings, providers);
          const provider =
            findProviderIn(providers, current.providerId) ??
            findProviderIn(providers, fallback.providerId);
          const modelId =
            current.modelId && provider?.models.some((model) => model.id === current.modelId)
              ? current.modelId
              : findModelIn(providers, provider?.id ?? fallback.providerId, fallback.modelId)?.id ??
                fallback.modelId;
          set({
            providers,
            keys: catalogView.keys,
            auth: catalogView.auth ?? get().auth,
            selection: {
              providerId: provider?.id ?? fallback.providerId,
              modelId,
              reasoning:
                current.providerId === provider?.id && current.modelId === modelId
                  ? current.reasoning
                  : null,
            },
          });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        }
      },

      refreshCatalog: async () => {
        try {
          const catalogView = await api.refreshCatalog();
          set({
            providers: catalogView.catalog.providers,
            keys: catalogView.keys,
            auth: catalogView.auth ?? get().auth,
            catalogRefreshedAt: catalogView.remoteRefreshedAt ?? Date.now(),
          });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        }
      },

      refreshProviderModels: async (providerId) => {
        const catalogView = await api.refreshProviderModels(providerId);
        const providers = catalogView.catalog.providers;
        set({
          providers,
          keys: catalogView.keys,
          auth: catalogView.auth ?? get().auth,
          catalogRefreshedAt: catalogView.remoteRefreshedAt ?? Date.now(),
        });
        return providers;
      },

      validateProvider: (providerId) => api.validateProvider(providerId),

      authStatus: (providerId) => get().auth.find((entry) => entry.providerId === providerId),

      providerReady: (providerId) => {
        const provider = get().providers.find((entry) => entry.id === providerId);
        if (!provider) return false;
        const key = get().keys.find((entry) => entry.providerId === providerId);
        if (key?.hasKey) return true;
        return Boolean(get().authStatus(providerId)?.state === 'signed-in');
      },

      startChatGptLogin: async (providerId, forceConsent = false) => {
        const challenge = await api.openaiLoginStart(providerId, forceConsent);
        set({ loginChallenge: challenge, error: null });
        return challenge;
      },

      awaitChatGptLogin: async (attemptId) => {
        try {
          const status = await api.openaiLoginWait(attemptId);
          await get().refreshAuth();
          set({ loginChallenge: null });
          // A fresh sign-in may unlock account-only models.
          try {
            await get().refreshProviderModels(status.providerId);
          } catch {
            // Non-fatal: the bundled catalog stays usable.
          }
          return status;
        } catch (error) {
          set({
            loginChallenge: null,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      cancelChatGptLogin: async (attemptId) => {
        try {
          await api.openaiLoginCancel(attemptId);
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          set({ loginChallenge: null });
        }
      },

      refreshAuth: async () => {
        try {
          const [statuses, view] = await Promise.all([
            api.openaiAuthStatus(),
            api.getSettings(),
          ]);
          set({
            auth: statuses,
            keys: view.keys,
            secretsError: view.secretsError ?? null,
          });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
        }
      },

      signOutProvider: async (providerId) => {
        try {
          await api.openaiSignOut(providerId);
          await get().refreshAuth();
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },

      setError: (error) => set({ error }),
    }),
    {
      name: 'zylara.app',
      partialize: (state) => ({ selection: state.selection, favorites: state.favorites }),
    },
  ),
);
