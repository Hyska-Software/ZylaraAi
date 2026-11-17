/** Layout-aware sidebar container (replaceable via `layout.sidebar`). */
import { AgentSidebar } from '@/components/agents/AgentSidebar';
import { CodeSidebar } from '@/components/code/CodeSidebar';
import { ComponentSlot } from '@/components/plugins/ui/Slot';
import type { PluginComponent } from '@/lib/plugins/ui/types';

import { Sidebar } from './Sidebar';

export function LayoutSidebar({
  layout,
  onClose,
}: {
  layout: 'chat' | 'code' | 'agent';
  onClose?: () => void;
}) {
  if (layout === 'code') return <CodeSidebar onClose={onClose} />;
  if (layout === 'agent') {
    return (
      <ComponentSlot
        name="agent.sidebar"
        fallback={AgentSidebar as unknown as PluginComponent}
        props={{ onClose }}
      />
    );
  }
  return <Sidebar onClose={onClose} />;
}
