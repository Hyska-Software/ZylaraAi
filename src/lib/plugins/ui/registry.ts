/**
 * Reactive store for plugin UI contributions.
 *
 * `plugins/registry.ts` rebuilds the whole projection on every snapshot or
 * trusted-registration change and publishes it here. React consumers subscribe
 * through `usePluginUi`; pure helpers keep ordering deterministic.
 */
import { useSyncExternalStore } from 'react';

import type { LayoutId, PluginUiState } from './types';

const EMPTY: PluginUiState = {
  slots: [],
  replacements: [],
  wraps: [],
  pages: [],
  panelTabs: [],
  nav: [],
  settingsTabs: [],
  artifactViewers: [],
  variants: [],
  presets: [],
  css: [],
  genui: [],
  revision: 0,
};

let state: PluginUiState = EMPTY;
const listeners = new Set<() => void>();

export function pluginUiState(): PluginUiState {
  return state;
}

export function setPluginUiState(next: Omit<PluginUiState, 'revision'>): void {
  state = { ...next, revision: state.revision + 1 };
  for (const listener of [...listeners]) listener();
}

export function subscribePluginUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginUi(): PluginUiState {
  return useSyncExternalStore(subscribePluginUi, pluginUiState, pluginUiState);
}

export function orderedContributions<T extends { order: number; priority: number; key: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (left, right) =>
      left.order - right.order ||
      left.priority - right.priority ||
      left.key.localeCompare(right.key),
  );
}

/** Highest-priority (lowest number) contribution, with a user-pinned winner. */
export function pickWinner<T extends { priority: number; key: string }>(
  list: readonly T[],
  preferredKey?: string | null,
): T | undefined {
  if (preferredKey) {
    const preferred = list.find((entry) => entry.key === preferredKey);
    if (preferred) return preferred;
  }
  return [...list].sort(
    (left, right) => left.priority - right.priority || left.key.localeCompare(right.key),
  )[0];
}

export function supportsLayout(layouts: readonly LayoutId[], layout: LayoutId): boolean {
  return layouts.length === 0 || layouts.includes(layout);
}

export function contributionEnabled(key: string, disabled: readonly string[]): boolean {
  return !disabled.includes(key);
}
