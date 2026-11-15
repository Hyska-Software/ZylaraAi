/** User-controlled plugin design preferences (per layout). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { LayoutId } from './types';

const LAYOUTS: LayoutId[] = ['chat', 'code', 'agent'];

export interface PluginUiPrefs {
  version: 1;
  enabled: boolean;
  presets: Record<LayoutId, string | null>;
  variants: Record<string, string>;
  winners: Record<string, string>;
  disabled: string[];
  navOrder: Record<LayoutId, string[]>;
  navHidden: Record<LayoutId, string[]>;
}

export interface PluginUiPrefsActions {
  setEnabled: (enabled: boolean) => void;
  setPreset: (layout: LayoutId, preset: string | null) => void;
  setVariant: (component: string, layout: LayoutId, variant: string | null) => void;
  setWinner: (component: string, contributionKey: string | null) => void;
  setDisabled: (contributionKey: string, disabled: boolean) => void;
  setNavOrder: (layout: LayoutId, order: string[]) => void;
  setNavHidden: (layout: LayoutId, hidden: string[]) => void;
  resetLayout: (layout: LayoutId) => void;
  resetAll: () => void;
}

export const EMPTY_PREFS: PluginUiPrefs = {
  version: 1,
  enabled: true,
  presets: { chat: null, code: null, agent: null },
  variants: {},
  winners: {},
  disabled: [],
  navOrder: { chat: [], code: [], agent: [] },
  navHidden: { chat: [], code: [], agent: [] },
};

export function variantKey(component: string, layout: LayoutId): string {
  return `${component}:${layout}`;
}

export const usePluginUiPrefs = create<PluginUiPrefs & PluginUiPrefsActions>()(
  persist(
    (set) => ({
      ...EMPTY_PREFS,
      setEnabled: (enabled) => set({ enabled }),
      setPreset: (layout, preset) =>
        set((state) => ({ presets: { ...state.presets, [layout]: preset } })),
      setVariant: (component, layout, variant) =>
        set((state) => {
          const key = variantKey(component, layout);
          const variants = { ...state.variants };
          if (variant) variants[key] = variant;
          else delete variants[key];
          return { variants };
        }),
      setWinner: (component, contributionKey) =>
        set((state) => {
          const winners = { ...state.winners };
          if (contributionKey) winners[component] = contributionKey;
          else delete winners[component];
          return { winners };
        }),
      setDisabled: (contributionKey, disabled) =>
        set((state) => ({
          disabled: disabled
            ? [...state.disabled.filter((key) => key !== contributionKey), contributionKey]
            : state.disabled.filter((key) => key !== contributionKey),
        })),
      setNavOrder: (layout, order) =>
        set((state) => ({ navOrder: { ...state.navOrder, [layout]: order } })),
      setNavHidden: (layout, hidden) =>
        set((state) => ({ navHidden: { ...state.navHidden, [layout]: hidden } })),
      resetLayout: (layout) =>
        set((state) => {
          const variants = { ...state.variants };
          for (const key of Object.keys(variants)) {
            if (key.endsWith(`:${layout}`)) delete variants[key];
          }
          return {
            presets: { ...state.presets, [layout]: null },
            variants,
            navOrder: { ...state.navOrder, [layout]: [] },
            navHidden: { ...state.navHidden, [layout]: [] },
          };
        }),
      resetAll: () => set({ ...EMPTY_PREFS }),
    }),
    { name: 'zylara.plugins.ui' },
  ),
);

export const PLUGIN_UI_LAYOUTS = LAYOUTS;
