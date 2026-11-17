/**
 * Pure routing helpers for plugin dock tabs (the right panel of each layout).
 *
 * Every layout exposes its own strip (CodePanel, AgentPanel and the chat dock),
 * so the resolution of "which panel is a dock tab here" lives here instead of
 * being duplicated — and, more importantly, a panel is rendered **once** even
 * when a trusted plugin registers it again or a slot contribution re-opens it.
 */
import { orderedContributions } from './registry';

import type { LayoutId, PanelTabSpec, SlotContribution } from './types';

/**
 * Dock tabs visible in `layout`: non-takeover panels that declare the layout,
 * are not disabled by the user and are unique per `(pluginId, tabId)`.
 *
 * Duplicates happen when trusted code calls `registerPanelTab` for an id the
 * manifest already declares (and when a manifest lists the same id twice); the
 * trusted registration wins because it carries the component that was actually
 * registered at runtime.
 */
export function dockTabsForLayout(
  panelTabs: readonly PanelTabSpec[],
  layout: LayoutId,
  disabled: readonly string[] = [],
): PanelTabSpec[] {
  const unique = new Map<string, PanelTabSpec>();
  for (const tab of panelTabs) {
    if (tab.takeover) continue;
    if (!tab.layouts.includes(layout)) continue;
    if (disabled.includes(tab.key)) continue;
    const identity = `${tab.pluginId}:${tab.tabId}`;
    const current = unique.get(identity);
    if (!current || (current.source !== 'trusted' && tab.source === 'trusted')) {
      unique.set(identity, tab);
    }
  }
  return orderedContributions([...unique.values()]);
}

/**
 * True when a strip slot contribution (`code.panel.tabs`, `agent.panel.tabs`, …)
 * is only a declarative shortcut to a tab that is already rendered in that same
 * strip — the classic "two identical tabs" a plugin creates by declaring both a
 * panel and a header/tab button that opens it.
 */
export function isRedundantDockTabAction(
  entry: SlotContribution,
  tabs: readonly PanelTabSpec[],
): boolean {
  if (entry.component || entry.entry) return false;
  const action = entry.action;
  if (!action) return false;
  if (action.kind !== 'openPanelTab' && action.kind !== 'openPanel') return false;
  return tabs.some(
    (tab) =>
      tab.pluginId === entry.pluginId &&
      (tab.tabId === action.target || tab.key === action.target),
  );
}
