/**
 * Chrome row of the Agentes layout (DESIGN §5).
 *
 * Every agent surface (thread, home, team, routines, stats, channel) starts with
 * this 40px row, so the layout keeps a single top band with the app chrome
 * (brand when the sidebar is hidden, global actions and the window-controls
 * corner).
 */
import { LayoutTopRow } from '@/components/layout/LayoutTopRow';

export interface AgentTopBarProps {
  /** Current agent, channel or view name; omitted when the surface is generic. */
  title?: string;
}

export function AgentTopBar({ title }: AgentTopBarProps) {
  return (
    <LayoutTopRow
      className="border-b border-border/70 px-3"
      leading={
        title ? (
          <span
            title={title}
            className="min-w-0 truncate text-[13px] font-medium text-foreground"
          >
            {title}
          </span>
        ) : null
      }
    />
  );
}

export default AgentTopBar;
