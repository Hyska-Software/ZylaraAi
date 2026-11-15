/** Sidebar navigation row shared by the three layouts. */
import { pluginIcon } from '@/lib/plugins/icons';
import { pluginLabel } from '@/lib/plugins/registry';
import { useStyleRecipe } from '@/lib/plugins/ui/recipe';
import type { NavEntry, PluginComponent } from '@/lib/plugins/ui/types';
import { cn } from '@/lib/utils';

import { ComponentSlot } from '@/components/plugins/ui/Slot';

export interface NavItemHostProps {
  icon: string;
  label: string;
  ariaLabel?: string | null;
  active: boolean;
  badge?: string | null;
  onSelect: () => void;
}

export function NavItemHost({ icon, label, ariaLabel, active, badge, onSelect }: NavItemHostProps) {
  const Icon = pluginIcon(icon);
  const recipe = useStyleRecipe('sidebar.nav.item', 'rounded-lg');
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={ariaLabel ?? label}
      aria-current={active ? 'page' : undefined}
      data-variant={recipe.variantId ?? undefined}
      className={cn(
        'mx-3 mt-1 flex h-8 items-center gap-2 px-2 text-[13px]',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        recipe.className,
        active
          ? 'bg-surface-active text-foreground'
          : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {badge ? (
        <span className="ml-auto rounded-full bg-accent-soft px-1.5 text-[10px] font-medium text-accent">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function navItemLabel(entry: NavEntry): string {
  if (entry.plugin) return pluginLabel(entry.plugin, entry.titleKey, entry.title);
  return entry.title;
}

export function SidebarNavItem({
  entry,
  active,
  onSelect,
}: {
  entry: NavEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <ComponentSlot
      name="sidebar.nav.item"
      fallback={NavItemHost as unknown as PluginComponent}
      props={{
        icon: entry.icon,
        label: navItemLabel(entry),
        ariaLabel: entry.ariaLabel ?? null,
        active,
        badge: entry.badge,
        onSelect,
      }}
    />
  );
}
