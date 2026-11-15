import { Fragment } from 'react';

import type { StreamingState } from '@/lib/store';
import type { ChatMessage } from '@/lib/types';
import { ComponentSlot, Slot } from '@/components/plugins/ui/Slot';
import type { PluginComponent } from '@/lib/plugins/ui/types';
import { MessageItem } from './MessageItem';
import { ModelSwitchDivider, modelSwitchAt } from './ModelSwitchDivider';

export interface MessageListProps {
  messages: ChatMessage[];
  streaming: StreamingState | null;
  /** Hide message-level actions (edit/regenerate/feedback) for audit views. */
  readOnly?: boolean;
}

function MessageListHost({ messages, streaming, readOnly = false }: MessageListProps) {
  return (
    <div
      role="log"
      aria-live={streaming ? 'polite' : 'off'}
      aria-relevant="additions text"
      aria-busy={streaming !== null}
      className="flex flex-col"
    >
      {messages.map((message, index) => {
        const switchedRoute = modelSwitchAt(messages, index);
        return (
          <Fragment key={message.id}>
            {switchedRoute ? <ModelSwitchDivider route={switchedRoute} /> : null}
            <MessageItem
              message={message}
              isStreaming={streaming?.assistantId === message.id}
              isGroupStart={index === 0 || messages[index - 1]?.role !== message.role}
              readOnly={readOnly}
              streamPhase={
                streaming?.assistantId === message.id ? streaming.phase : null
              }
              streamStartedAt={
                streaming?.assistantId === message.id ? streaming.startedAt : null
              }
            />
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * Ordered list of chat messages. The container is a polite live region while a
 * turn streams so screen readers announce the new content (DESIGN §12).
 *
 * Sessions may switch model/provider between turns (Code layout); when a
 * response inaugurates a new route, a discreet divider is rendered as a sibling
 * right before it. `MessageItem` keeps owning its own grouping/spacing.
 */
export function MessageList(props: MessageListProps) {
  const owner = {
    conversationId: props.messages[0]?.conversationId ?? null,
    messages: props.messages,
    streaming: props.streaming,
  };
  return (
    <Slot name="chat.message.list.frame" owner={owner}>
      <ComponentSlot
        name="chat.message.list"
        fallback={MessageListHost as unknown as PluginComponent}
        props={props as unknown as Record<string, unknown>}
      />
    </Slot>
  );
}
