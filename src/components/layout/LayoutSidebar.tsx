/** Layout-aware sidebar container (replaceable via `layout.sidebar`). */
import { AgentSidebar } from '@/components/agents/AgentSidebar';
import { CodeSidebar } from '@/components/code/CodeSidebar';

import { Sidebar } from './Sidebar';

export function LayoutSidebar({
  layout,
  onClose,
}: {
  layout: 'chat' | 'code' | 'agent';
  onClose?: () => void;
}) {
  if (layout === 'code') return <CodeSidebar onClose={onClose} />;
  if (layout === 'agent') return <AgentSidebar onClose={onClose} />;
  return <Sidebar onClose={onClose} />;
}
