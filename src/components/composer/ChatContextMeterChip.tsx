import { ContextMeter } from '@/components/agent';
import { useCodeStore } from '@/lib/store';

/**
 * Chat-only context indicator: a dynamic circular ring with the used percentage
 * that opens the full context breakdown on click. The Code and Agents layouts
 * keep their own hosts; this container only bridges the chat session's context
 * stats into the shared meter.
 */
export function ChatContextMeterChip({ conversationId }: { conversationId: string }) {
  const stats = useCodeStore((state) => state.byConversation[conversationId]?.context ?? null);
  if (!stats) return null;
  return <ContextMeter stats={stats} />;
}
