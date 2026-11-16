/** Applies one declarative design preset per layout. */
import { useEffect } from 'react';

import { useThemeStore } from '@/lib/store/themeStore';
import { useUiStore } from '@/lib/store/uiStore';
import { normalizeThemeTokens } from '@/lib/theme/tokens';

import { sanitizePluginCss } from './css';
import { usePluginUiPrefs } from './prefs';
import { usePluginUi } from './registry';
import type { LayoutId, PresetSpec } from './types';

const appliedTokens = new Set<string>();
let presetStyle: HTMLStyleElement | null = null;

function clearAppliedTokens(): void {
  for (const key of appliedTokens) {
    document.documentElement.style.removeProperty(key);
  }
  appliedTokens.clear();
}

export function applyPresetForLayout(
  layout: LayoutId,
  selected: string | null,
  presets: readonly PresetSpec[],
  enabled: boolean,
): void {
  clearAppliedTokens();
  presetStyle?.remove();
  presetStyle = null;
  // Restore the host theme tokens before layering a plugin preset.
  useThemeStore.getState().apply();
  const root = document.documentElement;
  if (!enabled || !selected) {
    delete root.dataset.zylaraPreset;
    return;
  }
  const preset = presets.find(
    (entry) => entry.key === selected && entry.layouts.includes(layout),
  );
  if (!preset) {
    delete root.dataset.zylaraPreset;
    return;
  }
  const dark = root.classList.contains('dark');
  const tokens = normalizeThemeTokens(dark ? preset.tokens.dark : preset.tokens.light);
  for (const [token, value] of Object.entries(tokens)) {
    const variable = `--${token}`;
    root.style.setProperty(variable, value);
    appliedTokens.add(variable);
  }
  if (preset.density) root.dataset.zylaraDensity = preset.density;
  else delete root.dataset.zylaraDensity;
  root.dataset.zylaraPreset = preset.key;
  if (preset.css) {
    const sanitized = sanitizePluginCss(preset.css);
    if (sanitized.error) {
      console.warn(`[plugins] ${sanitized.error} (${preset.key})`);
      return;
    }
    presetStyle = document.createElement('style');
    presetStyle.dataset.zylaraPluginPreset = preset.key;
    presetStyle.textContent = sanitized.css;
    document.head.appendChild(presetStyle);
  }
}

export function useApplyPresets(): void {
  const layout = useUiStore((state) => state.layoutMode);
  const prefs = usePluginUiPrefs();
  const ui = usePluginUi();
  const theme = useUiStore((state) => state.theme);
  const activeThemeId = useThemeStore((state) => state.activeId);

  useEffect(() => {
    applyPresetForLayout(
      layout,
      prefs.presets[layout],
      ui.presets,
      prefs.enabled,
    );
  }, [layout, prefs.enabled, prefs.presets, theme, activeThemeId, ui.presets, ui.revision]);
}
