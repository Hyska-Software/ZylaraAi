import { Loader2 } from 'lucide-react';
import { CONVERSATION_ROW_TONE_CLASS, type ConversationRowStatus } from './conversationRowMeta';
import { cn } from '@/lib/utils';

interface ConversationRowStatusChipProps {
  status: ConversationRowStatus;
}

/** Compact turn-status chip shared by the Chat and Code conversation rows. */
export function ConversationRowStatusChip({ status }: ConversationRowStatusChipProps) {
  return (
    <span
      title={status.label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[11px]',
        CONVERSATION_ROW_TONE_CLASS[status.tone],
      )}
    >
      {status.spinner ? (
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
      )}
      {status.label}
    </span>
  );
}
