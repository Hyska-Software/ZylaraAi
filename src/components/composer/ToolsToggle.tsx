import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolsToggleProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onToggle: () => void;
  className?: string;
}

/** Icon-only on/off tool toggle used in the chat composer toolbar (DESIGN §7). */
export function ToolsToggle({ icon: Icon, label, active, onToggle, className }: ToolsToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full',
        'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active
          ? 'bg-accent-soft text-accent hover:bg-accent-soft/80'
          : 'bg-transparent text-foreground-muted hover:bg-surface-hover hover:text-foreground',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
