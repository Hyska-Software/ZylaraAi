/** Pure routing helpers for slot contributions. */
import type { PluginSlotSpec } from '../contract';

import type { LayoutId, SlotContribution, SlotOwner } from './types';
import { orderedContributions } from './registry';

export function contributionMatchesLayout(
  contribution: { layouts: LayoutId[] },
  layout: LayoutId,
): boolean {
  return contribution.layouts.length === 0 || contribution.layouts.includes(layout);
}

export function slotAcceptsLayout(spec: PluginSlotSpec | undefined, layout: LayoutId): boolean {
  if (!spec) return false;
  return spec.layouts.includes(layout);
}

export function whenMatches(
  when: Record<string, string | number | boolean> | null,
  owner: SlotOwner,
): boolean {
  if (!when) return true;
  return Object.entries(when).every(([key, expected]) => owner[key] === expected);
}

/** Filters contributions for one slot occurrence. */
export function selectSlotContributions(
  contributions: readonly SlotContribution[],
  options: {
    slot: string;
    layout: LayoutId;
    entryKey?: string | null;
    onlyPluginId?: string | null;
    disabled?: readonly string[];
    owner?: SlotOwner;
  },
): SlotContribution[] {
  const filtered = contributions.filter((entry) => {
    if (entry.slot !== options.slot) return false;
    if (options.onlyPluginId && entry.pluginId !== options.onlyPluginId) return false;
    if (options.disabled?.includes(entry.key)) return false;
    if (!contributionMatchesLayout(entry, options.layout)) return false;
    if (entry.keyMatch !== null && entry.keyMatch !== options.entryKey) return false;
    if (!whenMatches(entry.when, options.owner ?? {})) return false;
    return true;
  });
  return orderedContributions(filtered);
}

/** First chain contribution that accepts the owner (`matched` is the owner). */
export function electChain(
  contributions: readonly SlotContribution[],
  owner: SlotOwner,
): SlotContribution | undefined {
  for (const entry of contributions) {
    if (entry.select) {
      try {
        if (entry.select(owner) != null) return entry;
      } catch {
        // A throwing selector declines; the next entry gets the turn.
      }
      continue;
    }
    if (whenMatches(entry.when, owner)) return entry;
  }
  return undefined;
}
