import { describeCodeTool } from '@/lib/agentTrace';
import { getModel } from '@/lib/catalog';
import { t } from '@/lib/i18n';
import { formatDate } from '@/lib/i18n/format';
import type { StreamingState } from '@/lib/store/chatStore';
import type { ChatMessage, Conversation, MessageStatus } from '@/lib/types';
import { relativeTime } from '@/lib/utils';

export type ConversationRowTone = 'muted' | 'accent' | 'success' | 'danger' | 'warning';

/** Shared token mapping for the status chip in both sidebars. */
export const CONVERSATION_ROW_TONE_CLASS: Record<ConversationRowTone, string> = {
  muted: 'text-foreground-subtle',
  accent: 'text-accent',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
};

export interface ConversationRowStatus {
  label: string;
  tone: ConversationRowTone;
  spinner: boolean;
}

/** Only the live fields the sidebar row needs from a stream. */
export type ConversationRowTurn = Pick<StreamingState, 'assistantId' | 'phase'>;

const STATUS_LABELS: Record<MessageStatus, string> = {
  streaming: 'rowStatusRunning',
  complete: 'rowStatusFinished',
  error: 'rowStatusFailed',
  cancelled: 'rowStatusCancelled',
  incomplete: 'rowStatusIncomplete',
};

const STATUS_TONES: Record<MessageStatus, ConversationRowTone> = {
  streaming: 'accent',
  complete: 'success',
  error: 'danger',
  cancelled: 'muted',
  incomplete: 'warning',
};

/** A live turn always wins over the persisted status from the last one. */
export function conversationRowStatus(
  conversation: Conversation,
  turn?: ConversationRowTurn | null,
): ConversationRowStatus {
  if (turn) {
    return {
      label: t('common:shell.sidebar.rowStatusRunning'),
      tone: 'accent',
      spinner: true,
    };
  }
  const status = conversation.lastStatus;
  if (!status) {
    // Older backends do not send lastStatus; a non-empty session has finished.
    if (conversation.messageCount > 0) {
      return {
        label: t('common:shell.sidebar.rowStatusFinished'),
        tone: 'success',
        spinner: false,
      };
    }
    return {
      label: t('common:shell.sidebar.rowStatusNew'),
      tone: 'muted',
      spinner: false,
    };
  }
  return {
    label: t(`common:shell.sidebar.${STATUS_LABELS[status]}`),
    tone: STATUS_TONES[status],
    spinner: false,
  };
}

/** Tool activity while streaming; otherwise the persisted first-prompt preview. */
export function conversationRowActivity(
  conversation: Conversation,
  turn: ConversationRowTurn | null,
  messages: readonly ChatMessage[] | undefined,
): string {
  if (turn) {
    const assistant = messages?.find((message) => message.id === turn.assistantId);
    const tools = assistant?.toolCalls ?? [];
    const tool =
      [...tools].reverse().find((entry) => entry.status === 'running') ??
      tools[tools.length - 1] ??
      null;
    if (tool) return describeCodeTool(tool).label;
    if (turn.phase === 'tool') return t('chat:trace.toolsRunning');
  }
  return conversation.preview?.trim() || t('common:shell.sidebar.rowNoActivity');
}

export interface ConversationRowModel {
  /** Catalog family used by `FamilyAvatar` to pick the brand glyph. */
  family: string | null;
  /** Model name used for the tooltip and the initials fallback. */
  name: string;
}

/**
 * Model identity for the row's activity icon. The last assistant turn wins when
 * its messages are loaded; otherwise the session's current model is used.
 */
export function conversationRowModel(
  conversation: Conversation,
  messages?: readonly ChatMessage[],
): ConversationRowModel {
  const lastAssistant = messages
    ? [...messages].reverse().find((message) =>
        message.role === 'assistant' && Boolean(message.modelId || message.providerId),
      )
    : undefined;
  const providerId = lastAssistant?.providerId || conversation.providerId;
  const modelId = lastAssistant?.modelId || conversation.modelId;
  const model = getModel(providerId, modelId);
  return {
    family: model?.family ?? providerId ?? null,
    name: model?.name ?? modelId,
  };
}

/** Compact sidebar time: "now", today's clock time, then relative date. */
export function conversationRowTime(timestamp: number): string {
  const now = Date.now();
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp < 45_000) {
    return t('common:shell.sidebar.rowTimeNow');
  }
  const sameDay = new Date(timestamp).toDateString() === new Date(now).toDateString();
  if (sameDay) return formatDate(timestamp, { hour: '2-digit', minute: '2-digit' });
  return relativeTime(timestamp);
}
