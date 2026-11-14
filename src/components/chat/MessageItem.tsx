import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Pencil, RefreshCw, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { CodeTurnSummary } from '@/components/code/CodeTurnSummary';
import { AttachmentChips } from '@/components/composer/AttachmentChips';
import { useReduceMotion } from '@/components/layout/hooks';
import { Badge, Button, IconButton, Spinner } from '@/components/ui';
import { findModel, getModel } from '@/lib/catalog';
import { useAppStore, useAgentStore, useChatStore, useUiStore } from '@/lib/store';
import type { ChatMessage } from '@/lib/types';
import { cn, copyText, formatDuration, formatTokens } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { hasTraceText } from '@/lib/agentTrace';
import { CitationChips } from './CitationChips';
import { BrandMark } from './BrandMark';
import { GoalRoundDivider } from './GoalRoundDivider';
import { Markdown } from './Markdown';
import { AgentSteps } from './AgentSteps';
import { MessageArtifacts } from './MessageArtifacts';

/**
 * Errors that indicate a missing/invalid provider key get a settings CTA.
 * Historical messages carry no error code, so the pattern covers every
 * supported language; live turns are classified by `errorCode` instead.
 */
const KEY_ERROR_PATTERN =
  /(chave de api|api[ _-]?key|401|unauthorized|no configurad|credencial|credenciales)/i;
const KEY_ERROR_CODES: Record<string, true> = {
  missing_credentials: true,
  auth_required: true,
};

/** Entrance animation shared by every message (DESIGN §11: fade-in-up 260ms). */
const MESSAGE_MOTION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
};

/** Blinking caret is rendered by `.zylara-prose--streaming` in globals.css. */

function useCopyFeedback() {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (text: string) => {
    const ok = await copyText(text);
    if (!ok) {
      toast.error(t('message.copyFailed'));
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return { copied, copy };
}

function modelLabel(message: ChatMessage): string | null {
  if (!message.modelId) return null;
  const exact = message.providerId ? getModel(message.providerId, message.modelId) : undefined;
  const model = exact ?? findModel(message.modelId)?.model;
  return model?.name ?? message.modelId;
}

interface MessageItemProps {
  message: ChatMessage;
  isStreaming: boolean;
  isGroupStart: boolean;
  /** Audit/subagent views hide edit/regenerate/feedback actions. */
  readOnly?: boolean;
  /** Streaming phase owned by the caller (global chat or a subagent tab). */
  streamPhase?: 'starting' | 'queued' | 'reasoning' | 'text' | 'tool' | 'retrying' | null;
  /** Turn start timestamp owned by the caller (used by AgentSteps). */
  streamStartedAt?: number | null;
}

const UserMessageItem = memo(function UserMessageItem({
  message,
  isStreaming,
  isGroupStart,
  readOnly = false,
}: MessageItemProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const { copied, copy } = useCopyFeedback();
  const reduceMotion = useReduceMotion();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const attachments = message.attachments ?? [];

  const startEditing = () => {
    setDraft(message.content);
    setEditing(true);
  };

  const saveEdit = () => {
    const content = draft.trim();
    if (!content) return;
    setEditing(false);
    void useChatStore.getState().editAndResend(message.id, content);
  };

  return (
    <motion.div
      initial={reduceMotion ? false : MESSAGE_MOTION.initial}
      animate={MESSAGE_MOTION.animate}
      transition={reduceMotion ? { duration: 0 } : MESSAGE_MOTION.transition}
      className={cn('group/message flex flex-col items-end', isGroupStart ? 'mt-7' : 'mt-3')}
    >
      <div className="flex max-w-[80%] flex-col items-end gap-1.5">
        {attachments.length > 0 ? <AttachmentChips attachments={attachments} align="end" /> : null}

        {editing ? (
          <div className="w-72 max-w-[70vw] rounded-2xl bg-surface-raised p-2 shadow-sm">
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditing(false);
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  saveEdit();
                }
              }}
              rows={2}
              aria-label={t('message.editAria')}
              className="max-h-60 w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed text-foreground outline-none"
            />
            <div className="flex justify-end gap-1.5 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                {tCommon('actions.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={saveEdit} disabled={!draft.trim()}>
                {t('message.saveAndResend')}
              </Button>
            </div>
          </div>
        ) : message.content ? (
          <div className="whitespace-pre-wrap break-words rounded-3xl bg-user-bubble px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
            {message.content}
          </div>
        ) : null}
      </div>

      {!editing ? (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100">
          <IconButton
            label={copied ? t('message.copied') : t('message.copy')}
            size="sm"
            variant="ghost"
            className="size-8"
            onClick={() => void copy(message.content)}
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </IconButton>
          {!readOnly ? (
            <IconButton
              label={t('message.edit')}
              size="sm"
              variant="ghost"
              className="size-8"
              disabled={isStreaming}
              onClick={startEditing}
            >
              <Pencil className="size-3.5" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
});

const AssistantMessageItem = memo(function AssistantMessageItem({
  message,
  isStreaming,
  isGroupStart,
  readOnly = false,
  streamPhase = null,
  streamStartedAt = null,
}: MessageItemProps) {
  const { t } = useTranslation('chat');
  const { copied, copy } = useCopyFeedback();
  const reduceMotion = useReduceMotion();
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const errorCode = useChatStore((state) => state.errorCode);

  const phase = streamPhase;
  const retryInfo = useChatStore((state) => {
    const stream = state.streamsByConversation[message.conversationId];
    return stream?.assistantId === message.id ? (stream.retry ?? null) : null;
  });
  const startedAt = streamStartedAt;
  const anyStreaming = useChatStore((state) => state.streaming !== null);
  const showTokenUsage = useAppStore((state) => state.settings.showTokenUsage);
  const artifacts = useUiStore((state) => state.artifacts);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const conversationAgentId = useChatStore(
    (state) =>
      state.conversations.find((entry) => entry.id === message.conversationId)?.agentId ??
      null,
  );
  const conversationAgent = useAgentStore((state) =>
    conversationAgentId ? (state.agentsById[conversationAgentId] ?? null) : null,
  );
  /* The Code workbench is task-focused: the assistant avatar (brand mark) adds
     chrome without information, so it only belongs to the Chat layout. In the
     Agentes layout the avatar is the persona, not the Zylara brand. */
  const showAssistantAvatar = layoutMode !== 'code';
  const assistantAvatar =
    layoutMode === 'agent' && conversationAgent ? (
      <AgentAvatar
        avatar={conversationAgent.avatar}
        size="sm"
        activity={isStreaming ? 'running' : 'idle'}
        className="mt-0.5"
      />
    ) : (
      <BrandMark size={24} className="mt-0.5" animated={isStreaming} />
    );
  // Workspace da sessão: com ele o resumo do turno abre o diff de cada arquivo
  // como aba central (WORKBENCH §7.2); sem workspace o card é informativo.
  const workspaceId = useChatStore(
    (state) =>
      state.conversations.find((entry) => entry.id === message.conversationId)?.workspaceId ??
      null,
  );

  const attachments = message.attachments ?? [];
  const citations = message.citations ?? [];
  const toolCalls = message.toolCalls ?? [];
  const reasoning = message.reasoning?.trim() ?? '';
  const reasoningActive = isStreaming && phase === 'reasoning';
  const awaitingText =
    isStreaming && phase !== 'retrying' && !message.content && !reasoning && toolCalls.length === 0;
  const showCaret = isStreaming && phase === 'text' && message.content.length > 0;
  const messageArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.messageId === message.id),
    [artifacts, message.id],
  );

  const usage = message.usage;
  const totalTokens =
    usage?.totalTokens ??
    ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || null);
  const model = modelLabel(message);
  const failure = message.error ?? null;
  const failed = message.status === 'error' || failure !== null;
  const failureText = failure
    ? (failure.hint ?? failure.message)
    : message.content;
  const canRetry = failure ? failure.retryable : true;
  const keyErrorCode = failure?.code ?? errorCode;
  const isKeyError =
    (message.status === 'error' || failure !== null) &&
    (KEY_ERROR_CODES[keyErrorCode ?? ''] ||
      KEY_ERROR_PATTERN.test(failure?.message ?? message.content ?? ''));

  const regenerate = () => {
    window.dispatchEvent(new CustomEvent('zylara:scroll-bottom'));
    void useChatStore.getState().regenerate();
  };

  /* An interrupted turn keeps its resume point on the row: Continue restarts the
     loop at the step it stopped, in this same message (same tool cards). */
  const resumable = Boolean(message.resumeState) && !isStreaming && !readOnly;
  const resume = () => {
    window.dispatchEvent(new CustomEvent('zylara:scroll-bottom'));
    void useChatStore.getState().resumeMessage(message.id);
  };
  const resumeAction = resumable ? (
    <Button variant="primary" size="sm" onClick={resume} disabled={anyStreaming}>
      {t('message.resume')}
    </Button>
  ) : null;

  return (
    <motion.div
      initial={reduceMotion ? false : MESSAGE_MOTION.initial}
      animate={MESSAGE_MOTION.animate}
      transition={reduceMotion ? { duration: 0 } : MESSAGE_MOTION.transition}
      className={cn('group/message flex items-start gap-3', isGroupStart ? 'mt-7' : 'mt-3')}
    >
      {showAssistantAvatar ? assistantAvatar : null}

      <div className="min-w-0 flex-1">
        {reasoning || reasoningActive || toolCalls.length > 0 || hasTraceText(message.trace) ? (
          <AgentSteps
            message={message}
            streaming={isStreaming}
            phase={phase}
            startedAt={startedAt}
          />
        ) : null}

        {message.status !== 'error' && message.content ? (
          <Markdown content={message.content} streaming={showCaret} />
        ) : null}

        {awaitingText ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-foreground-subtle">
            <Spinner size="xs" />
            <span>{phase === 'queued' ? t('message.queued') : t('message.generating')}</span>
          </div>
        ) : null}

        {isStreaming && phase === 'retrying' ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-foreground-subtle">
            <Spinner size="xs" />
            <span>
              {retryInfo?.reason === 'auth_refresh'
                ? t('message.retryAuth')
                : t('message.retrying', {
                    attempt: retryInfo?.attempt ?? 1,
                    maxAttempts: retryInfo?.maxAttempts ?? 1,
                    seconds: Math.max(1, Math.round((retryInfo?.delayMs ?? 0) / 1000)),
                  })}
            </span>
          </div>
        ) : null}

        {failed ? (
          <div role="alert" className="mt-2 rounded-xl bg-danger-soft p-3">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">{t('message.failedTitle')}</p>
                {failureText ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-foreground-muted">
                    {failureText}
                  </p>
                ) : (
                  <p className="mt-1 text-[12.5px] text-foreground-muted">{t('message.failedHint')}</p>
                )}
                {(failure?.attempts ?? 0) > 1 ? (
                  <p className="mt-1 text-[11.5px] text-foreground-subtle">
                    {t('message.attempts', { count: failure?.attempts })}
                  </p>
                ) : null}
                {!readOnly ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {resumeAction}
                    {canRetry ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={regenerate}
                        disabled={anyStreaming}
                      >
                        {t('common:actions.retry')}
                      </Button>
                    ) : null}
                    {isKeyError ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => useUiStore.getState().setSettingsOpen(true)}
                      >
                        {t('message.openSettings')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {attachments.length > 0 ? <AttachmentChips attachments={attachments} className="mt-3" /> : null}
        {/* Source chips are a Chat surface; the Code layout has no sources panel. */}
        {citations.length > 0 && layoutMode !== 'code' ? (
          <CitationChips citations={citations} className="mt-3" />
        ) : null}

        {messageArtifacts.length > 0 ? <MessageArtifacts artifacts={messageArtifacts} /> : null}

        {message.status === 'cancelled' ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{t('message.cancelled')}</Badge>
            {resumeAction}
          </div>
        ) : null}

        {message.status === 'incomplete' ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="warning">{t('message.incomplete')}</Badge>
            {resumeAction}
          </div>
        ) : null}

        {/* Fecho do turno (DESIGN §6.3): só no layout Code e com o turno
            encerrado — durante o streaming as edições ainda estão chegando.
            Turnos cancelados/erro também mostram o resumo: as edições
            parciais já são reais. Depois do selo "Cancelado", que qualifica o
            turno, e antes do rodapé de ações. */}
        {(layoutMode === 'code' || (layoutMode === 'agent' && workspaceId)) && !isStreaming ? (
          <CodeTurnSummary message={message} workspaceId={workspaceId} />
        ) : null}

        {!isStreaming &&
        message.status !== 'error' &&
        (message.content || messageArtifacts.length > 0) ? (
          <div className="mt-2 flex flex-wrap items-center gap-0.5 text-foreground-subtle opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100">
            <IconButton
              label={copied ? t('message.responseCopied') : t('message.copyResponse')}
              size="sm"
              variant="ghost"
              className="size-8"
              disabled={!message.content}
              onClick={() => void copy(message.content)}
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </IconButton>
            {!readOnly ? (
              <>
                <IconButton
                  label={t('message.regenerate')}
                  size="sm"
                  variant="ghost"
                  className="size-8"
                  disabled={anyStreaming}
                  onClick={regenerate}
                >
                  <RefreshCw className="size-3.5" />
                </IconButton>
                <IconButton
                  label={t('message.useful')}
                  size="sm"
                  variant="ghost"
                  className="size-8"
                  active={feedback === 'up'}
                  aria-pressed={feedback === 'up'}
                  onClick={() => setFeedback((current) => (current === 'up' ? null : 'up'))}
                >
                  <ThumbsUp className="size-3.5" />
                </IconButton>
                <IconButton
                  label={t('message.notUseful')}
                  size="sm"
                  variant="ghost"
                  className="size-8"
                  active={feedback === 'down'}
                  aria-pressed={feedback === 'down'}
                  onClick={() => setFeedback((current) => (current === 'down' ? null : 'down'))}
                >
                  <ThumbsDown className="size-3.5" />
                </IconButton>
              </>
            ) : null}

            {model || (showTokenUsage && totalTokens) ? (
              <span aria-hidden className="mx-1 h-3 w-px bg-border" />
            ) : null}
            {model ? <span className="px-1 text-[11px] text-foreground-subtle">{model}</span> : null}
            {showTokenUsage && totalTokens ? (
              <span className="text-[11px] tabular-nums text-foreground-subtle">
                {usage?.durationMs
                  ? t('message.tokensAndDuration', {
                      tokens: formatTokens(totalTokens),
                      duration: formatDuration(usage.durationMs),
                    })
                  : t('message.tokens', { tokens: formatTokens(totalTokens) })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
});

/**
 * Abertura de rodada automática do objetivo (`message.origin === 'goal_round'`):
 * divisor em vez de bolha do usuário (PLAN §10.5). O spinner acompanha o turno
 * `goal_round` desta conversa no `chatStore` — a mensagem do usuário não recebe
 * `isStreaming` do `MessageList` (ele é acoplado ao id do assistant).
 */
const GoalRoundMessageItem = memo(function GoalRoundMessageItem({
  message,
  isGroupStart,
}: MessageItemProps) {
  const running = useChatStore((state) =>
    Boolean(
      state.streaming &&
        state.streaming.turnKind === 'goal_round' &&
        state.streaming.conversationId === message.conversationId,
    ),
  );
  return (
    <GoalRoundDivider
      createdAt={message.createdAt}
      streaming={running}
      className={isGroupStart ? 'mt-7' : 'mt-3'}
    />
  );
});

/** Renders a single chat message: user bubble or assistant markdown turn. */
export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  if (props.message.role === 'user' && props.message.origin === 'goal_round') {
    return <GoalRoundMessageItem {...props} />;
  }
  if (props.message.role === 'user') return <UserMessageItem {...props} />;
  if (props.message.role === 'system') {
    return (
      <div className="mt-4 text-center text-[12px] italic text-foreground-subtle">{props.message.content}</div>
    );
  }
  return <AssistantMessageItem {...props} />;
});
