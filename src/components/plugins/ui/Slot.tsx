/** Host-rendered plugin regions: slots and replaceable components. */
import { createElement, useMemo, type ReactNode } from 'react';

import { pluginSlotSpec } from '@/lib/plugins/contract';
import { PluginFrame } from '@/lib/plugins/frame';
import { runSlotAction, slotLabel } from '@/lib/plugins/host';
import { pluginIcon } from '@/lib/plugins/icons';
import { pluginHasPermission, pluginLabel } from '@/lib/plugins/registry';
import { useUiStore } from '@/lib/store/uiStore';
import { cn } from '@/lib/utils';

import { PluginBoundary } from './PluginBoundary';
import { VariantProvider } from '@/lib/plugins/ui/recipe';
import { pluginContextRecord } from '@/lib/plugins/ui/context';
import { runPluginHostAction } from '@/lib/plugins/ui/hostActions';
import { usePluginUi, pickWinner } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { contributionMatchesLayout, electChain, selectSlotContributions } from '@/lib/plugins/ui/slots';
import type {
  ComponentReplacement,
  ComponentWrap,
  LayoutId,
  PluginComponent,
  SlotContribution,
} from '@/lib/plugins/ui/types';

const warned = new Set<string>();

export interface SlotProps {
  name: string;
  owner?: Record<string, unknown>;
  entryKey?: string | null;
  layout?: LayoutId;
  className?: string;
  compact?: boolean;
  variant?: 'row' | 'block' | 'inline';
  fallback?: ReactNode;
  children?: ReactNode;
  onlyPluginId?: string;
  /**
   * Extra per-occurrence routing: a host region that already renders a surface
   * (for example the dock tab strip) can drop contributions that would only
   * duplicate it.
   */
  filter?: (entry: SlotContribution) => boolean;
}

function SlotEntry({
  entry,
  owner,
  layout,
  compact,
}: {
  entry: SlotContribution;
  owner: Record<string, unknown>;
  layout: LayoutId;
  compact: boolean;
}) {
  const title = pluginLabel(entry.plugin, entry.titleKey, entry.title ?? entry.entryId);
  if (entry.component) {
    const Component = entry.component;
    return (
      <Component
        plugin={entry.plugin}
        layout={layout}
        slot={entry.slot}
        matched={entry.select ? entry.select(owner) : owner}
        {...owner}
      />
    );
  }
  if (entry.entry) {
    return (
      <PluginFrame
        plugin={entry.plugin}
        entry={entry.entry}
        kind="slot"
        slot={entry.slot}
        title={title}
        context={pluginContextRecord({ ...owner, slot: entry.slot, layout })}
        maxHeight={compact ? 64 : 240}
        onHostAction={(action, params) => runPluginHostAction(entry.plugin, action, params)}
      />
    );
  }
  if (!entry.action) return null;
  const Icon = pluginIcon(entry.icon);
  return (
    <button
      type="button"
      onClick={() => runSlotAction(entry)}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg bg-surface-raised/70 px-2',
        'text-[12px] font-medium text-foreground-muted transition-colors',
        'hover:bg-surface-hover hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      <span className="truncate">{title}</span>
    </button>
  );
}

function SlotContributionView({
  entry,
  owner,
  layout,
  compact,
}: {
  entry: SlotContribution;
  owner: Record<string, unknown>;
  layout: LayoutId;
  compact: boolean;
}) {
  return (
    <div
      className="min-w-0"
      data-zylara-plugin={entry.pluginId}
      data-zylara-contribution={entry.key}
    >
      <PluginBoundary plugin={entry.plugin}>
        <SlotEntry entry={entry} owner={owner} layout={layout} compact={compact} />
      </PluginBoundary>
    </div>
  );
}

export function Slot({
  name,
  owner = {},
  entryKey = null,
  layout,
  className,
  compact = false,
  variant = 'row',
  fallback = null,
  children,
  onlyPluginId,
  filter,
}: SlotProps) {
  const spec = pluginSlotSpec(name);
  const currentLayout = useUiStore((state) => state.layoutMode);
  const resolvedLayout = layout ?? currentLayout;
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();

  const contributions = useMemo(() => {
    if (!prefs.enabled || !spec) return [];
    const selected = selectSlotContributions(ui.slots, {
      slot: name,
      layout: resolvedLayout,
      entryKey,
      onlyPluginId,
      disabled: prefs.disabled,
      owner,
    }).filter((entry) => pluginHasPermission(entry.plugin, `ui.slot:${entry.slot}`));
    return filter ? selected.filter(filter) : selected;
  }, [prefs.disabled, prefs.enabled, name, resolvedLayout, entryKey, onlyPluginId, owner, spec, ui.slots, filter]);

  if (!spec) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[plugins] unknown slot ${name}`);
    }
    return <>{fallback}</>;
  }

  if (spec.kind === 'hoc') {
    const layers = contributions.filter((entry) => entry.component);
    if (layers.length === 0) return <>{children ?? fallback}</>;
    let node: ReactNode = children ?? fallback;
    // First order is outermost: wrap from the innermost layer upwards.
    for (const layer of [...layers].reverse()) {
      const Layer = layer.component as PluginComponent;
      const inner = node;
      node = (
        <PluginBoundary key={layer.key} plugin={layer.plugin} fallback={inner}>
          {createElement(Layer, {
            ...owner,
            plugin: layer.plugin,
            layout: resolvedLayout,
            children: inner,
            Host: inner,
          })}
        </PluginBoundary>
      );
    }
    return <>{node}</>;
  }

  if (spec.kind === 'chain') {
    const elected = electChain(contributions, owner);
    if (!elected) return <>{fallback ?? children}</>;
    return (
      <SlotContributionView
        entry={{ ...elected, select: undefined }}
        owner={owner}
        layout={resolvedLayout}
        compact={compact}
      />
    );
  }

  if (spec.kind === 'single') {
    const winner = pickWinner(contributions, prefs.winners[name] ?? null);
    if (!winner) return <>{fallback ?? children}</>;
    return (
      <SlotContributionView
        entry={winner}
        owner={owner}
        layout={resolvedLayout}
        compact={compact}
      />
    );
  }

  if (contributions.length === 0) return <>{fallback ?? children ?? null}</>;
  return (
    <div
      className={cn(
        variant === 'row' && 'flex min-w-0 flex-wrap items-center gap-1.5',
        variant === 'block' && 'flex min-w-0 flex-col gap-1',
        variant === 'inline' && 'inline-flex min-w-0 items-center gap-1.5',
        className,
      )}
      data-plugin-slot={name}
      data-zylara-slot={name}
    >
      {contributions.map((entry) => (
        <SlotContributionView
          key={entry.key}
          entry={entry}
          owner={owner}
          layout={resolvedLayout}
          compact={compact}
        />
      ))}
    </div>
  );
}

export function useSlotContributions(
  name: string,
  options: { layout?: LayoutId; entryKey?: string | null; onlyPluginId?: string } = {},
): SlotContribution[] {
  const currentLayout = useUiStore((state) => state.layoutMode);
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  return useMemo(() => {
    if (!prefs.enabled) return [];
    return selectSlotContributions(ui.slots, {
      slot: name,
      layout: options.layout ?? currentLayout,
      entryKey: options.entryKey ?? null,
      onlyPluginId: options.onlyPluginId,
      disabled: prefs.disabled,
    }).filter((entry) => pluginHasPermission(entry.plugin, `ui.slot:${entry.slot}`));
  }, [prefs.disabled, prefs.enabled, name, options.layout, options.entryKey, options.onlyPluginId, currentLayout, ui.slots]);
}

export interface ComponentSlotProps {
  name: string;
  fallback: PluginComponent;
  props?: Record<string, unknown>;
  onlyPluginId?: string;
}

function applyWraps(
  node: ReactNode,
  wraps: ComponentWrap[],
  props: Record<string, unknown>,
  layout: LayoutId,
): ReactNode {
  let result = node;
  for (const wrap of [...wraps].reverse()) {
    const Wrapper = wrap.wrapper;
    const inner = result;
    result = (
      <PluginBoundary key={wrap.key} plugin={wrap.plugin} fallback={inner}>
        {createElement(Wrapper, {
          ...props,
          plugin: wrap.plugin,
          layout,
          children: inner,
          Host: inner,
        })}
      </PluginBoundary>
    );
  }
  return result;
}

export function ComponentSlot({ name, fallback, props = {}, onlyPluginId }: ComponentSlotProps) {
  const currentLayout = useUiStore((state) => state.layoutMode);
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();

  const replacements = useMemo<ComponentReplacement[]>(() => {
    if (!prefs.enabled) return [];
    return ui.replacements.filter(
      (entry) =>
        entry.component === name &&
        contributionMatchesLayout(entry, currentLayout) &&
        (!onlyPluginId || entry.pluginId === onlyPluginId) &&
        !prefs.disabled.includes(entry.key) &&
        pluginHasPermission(
          entry.plugin,
          name === 'layout.shell' ? 'ui.shell' : `ui.override:${name}`,
        ),
    );
  }, [prefs.disabled, prefs.enabled, name, currentLayout, onlyPluginId, ui.replacements]);

  const wraps = useMemo<ComponentWrap[]>(() => {
    if (!prefs.enabled) return [];
    return ui.wraps
      .filter(
        (entry) =>
          entry.component === name &&
          contributionMatchesLayout(entry, currentLayout) &&
          (!onlyPluginId || entry.pluginId === onlyPluginId) &&
          !prefs.disabled.includes(entry.key) &&
          pluginHasPermission(entry.plugin, `ui.override:${name}`),
      )
      .sort((left, right) => left.order - right.order || left.priority - right.priority);
  }, [prefs.disabled, prefs.enabled, name, currentLayout, onlyPluginId, ui.wraps]);

  const replacement = pickWinner(replacements, prefs.winners[name] ?? null);
  const host = createElement(fallback, props);
  const base = replacement ? (
    <PluginBoundary plugin={replacement.plugin} fallback={host}>
      {createElement(replacement.componentFn, {
        ...props,
        plugin: replacement.plugin,
        layout: currentLayout,
      })}
    </PluginBoundary>
  ) : (
    <VariantProvider component={name}>{host}</VariantProvider>
  );

  return (
    <>
      {applyWraps(base, wraps, props, currentLayout)}
    </>
  );
}
