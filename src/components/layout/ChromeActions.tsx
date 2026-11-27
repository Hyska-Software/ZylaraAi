/**
 * Global actions of the app chrome (DESIGN §5): plugin title-bar actions. They
 * sit at the end of every layout's chrome row, immediately before the reserved
 * window-controls corner. The update pill lives in the sidebar chrome row.
 */
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { cn } from '@/lib/utils';

export interface GlobalActionsProps {
  className?: string;
}

export function GlobalActions({ className }: GlobalActionsProps) {
  return (
    <div
      className={cn('no-drag flex min-w-0 shrink items-center justify-end gap-2', className)}
      data-chrome-actions
    >
      <PluginSlot slot="titlebar.actions" className="max-w-[28vw] justify-end" compact />
    </div>
  );
}
