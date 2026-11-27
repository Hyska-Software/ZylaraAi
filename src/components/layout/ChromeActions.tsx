/**
 * Global actions of the app chrome (DESIGN §5): plugin title-bar actions and the
 * update pill. They sit at the end of every layout's chrome row, immediately
 * before the reserved window-controls corner.
 */
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { cn } from '@/lib/utils';
import { UpdateChip } from './UpdateChip';

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
      <UpdateChip />
    </div>
  );
}
