import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Crown,
  ListChecks,
  Loader2,
  Plus,
  Settings2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { AgentAvatar } from './AgentAvatar';
import { AgentAvatarStack } from './AgentAvatarStack';
import { AgentTaskBoardDialog } from './AgentTaskBoardDialog';
import { AgentPanelButton, AgentPanelOpener } from './AgentPanelToggle';
import { TASK_TERMINAL_STATUSES, taskStatusMeta } from './agentTaskStatus';
import { Markdown } from '@/components/chat/Markdown';
import { AttachmentChips } from '@/components/composer/AttachmentChips';
import {
  clipboardHasFiles,
  clipboardText,
  pickAttachmentPaths,
} from '@/components/composer/attachmentFiles';
import { ComposerActivity } from '@/components/composer/ComposerActivity';
import { useReduceMotion } from '@/components/layout/hooks';
import { IconButton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { agentAvatarForEmoji, DEFAULT_AGENT_AVATAR } from '@/lib/agentAvatar';
import { Slot } from '@/components/plugins/ui/Slot';
import { localeLowerCase } from '@/lib/i18n/format';
import { useAgentStore, useAppStore, useUiStore } from '@/lib/store';
import type {
  AgentAvatar as AgentAvatarSpec,
  AgentChannel,
  AgentChannelMessage,
  AgentTask,
  AttachmentInfo,
} from '@/lib/types';
import { cn, copyText } from '@/lib/utils';

/** Distance from the bottom (px) still considered "reading the latest message". */
const BOTTOM_THRESHOLD = 96;

/** The textarea grows up to ten lines before scrolling (same as the chat composer). */
const MAX_LINES = 10;

type Translate = TFunction<'agents'>;

function messageAuthor(
  message: AgentChannelMessage,
  names: Map<string, { name: string; avatar: AgentAvatarSpec }>,
  t: Translate,
): { name: string; avatar: AgentAvatarSpec } {
  if (message.role === 'user') return { name: t('channel.you'), avatar: agentAvatarForEmoji('🧑') };
  if (message.agentId) {
    return (
      names.get(message.agentId) ?? {
        name: t('channel.unknownAgent'),
        avatar: DEFAULT_AGENT_AVATAR,
      }
    );
  }
  return { name: t('channel.system'), avatar: agentAvatarForEmoji('⚙️') };
}

/** Copy action shown on hover, mirroring the chat message footer. */
function MessageCopyButton({ content, label }: { content: string; label: string }) {
  const { t } = useTranslation('agents');
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      clearTimeout(timer.current ?? undefined);
    },
    [],
  );

  const copy = async () => {
    const ok = await copyText(content);
    if (!ok) {
      toast.error(t('channel.copyError'));
      return;
    }
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <IconButton
      label={copied ? t('channel.copied') : label}
      size="sm"
      variant="ghost"
      className="size-8"
      onClick={() => void copy()}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </IconButton>
  );
}

/**
 * Shared channel view: one chronological thread with user posts and one reply
 * per member agent. Replies are generated in each agent's hidden private thread
 * (see `commands::channels`), so the channel stays a readable shared room.
 *
 * The surface mirrors the standard agent thread (`ChatView` + `Composer`):
 * same column width, message rhythm, smart scroll and composer shell. The model
 * selector is intentionally absent — each member agent already owns its route.
 */
export function AgentChannelView({
  channelId,
  onBack,
  onEdit,
}: {
  channelId: string;
  onBack: () => void;
  onEdit: (channel: AgentChannel) => void;
}) {
  const { t } = useTranslation('agents');
  const agents = useAgentStore((state) => state.agentsById);
  const sendKey = useAppStore((state) => state.settings.sendKey);
  const [channel, setChannel] = useState<AgentChannel | null>(null);
  const [messages, setMessages] = useState<AgentChannelMessage[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [taskBoardOpen, setTaskBoardOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const requestId = useRef(0);
  const attachmentsRef = useRef<AttachmentInfo[]>([]);
  const [showJump, setShowJump] = useState(false);
  const reduceMotion = useReduceMotion();
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const setActiveChannelId = useUiStore((state) => state.setActiveChannelId);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  /* Unsent channel attachments die with the view: the draft is local (unlike
     the chat composer's store), so remove the stored rows on unmount. */
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        void api.deleteAttachment(attachment.id).catch(() => undefined);
      }
    },
    [],
  );

  const names = useMemo(() => {
    const map = new Map<string, { name: string; avatar: AgentAvatarSpec }>();
    for (const [id, agent] of Object.entries(agents)) {
      map.set(id, { name: agent.name, avatar: agent.avatar });
    }
    return map;
  }, [agents]);
  const members = useMemo(
    () =>
      (channel?.memberIds ?? []).map((id) => ({
        id,
        ...(names.get(id) ?? {
          name: t('channel.unknownAgent'),
          avatar: DEFAULT_AGENT_AVATAR,
        }),
      })),
    [channel?.memberIds, names, t],
  );
  const activeTasks = useMemo(
    () =>
      tasks
        .filter((task) => !TASK_TERMINAL_STATUSES.includes(task.status))
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [tasks],
  );
  const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  const mentionCandidates = mentionMatch
    ? members
        .filter((member) =>
          localeLowerCase(member.name).includes(localeLowerCase(mentionMatch[1])),
        )
        .slice(0, 6)
    : [];
  const activeMentionIndex =
    mentionCandidates.length > 0 ? Math.min(mentionIndex, mentionCandidates.length - 1) : 0;
  const isDm = channel?.kind === 'dm';
  const memberNames = members.map((member) => member.name).join(', ');

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 22;
    const maxHeight = lineHeight * MAX_LINES;
    const nextHeight = Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  const insertMention = (name: string) => {
    setDraft((current) =>
      current.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
        const prefix = match.startsWith(' ') ? ' ' : '';
        return `${prefix}@${name} `;
      }),
    );
    setMentionOpen(false);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
      resizeTextarea();
    });
  };

  const importPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const imported = await api.importAttachments(paths);
      if (imported.length) {
        setAttachments((current) => [...current, ...imported]);
      }
    } catch (error) {
      toast.error(t('channel.importError'), { description: String(error) });
    }
  }, [t]);

  const importClipboard = useCallback(async () => {
    try {
      const imported = await api.importClipboardAttachments();
      if (imported.length) {
        setAttachments((current) => [...current, ...imported]);
      }
    } catch (error) {
      toast.error(t('channel.pasteError'), { description: String(error) });
    }
  }, [t]);

  const handleAttach = async () => {
    if (attaching) return;
    setAttaching(true);
    try {
      await importPaths(await pickAttachmentPaths());
    } catch (error) {
      toast.error(t('channel.attachError'), { description: String(error) });
    } finally {
      setAttaching(false);
    }
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    if (!clipboardHasFiles(data) && clipboardText(data).trim().length > 0) return;
    event.preventDefault();
    void importClipboard();
  };

  const removeAttachment = async (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
    try {
      await api.deleteAttachment(id);
    } catch {
      /* non-blocking */
    }
  };

  /* Native drag & drop routed by `App.tsx` for the open channel. */
  useEffect(() => {
    const onDrop = (event: Event) => {
      const detail = (event as CustomEvent<{ paths?: string[] }>).detail;
      void importPaths(detail?.paths ?? []);
    };
    window.addEventListener('zylara:channel-drop', onDrop);
    return () => window.removeEventListener('zylara:channel-drop', onDrop);
  }, [importPaths]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distance < BOTTOM_THRESHOLD;
    atBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
  }, []);

  const load = useCallback(
    async (silent = false) => {
      const request = ++requestId.current;
      if (!silent) setLoading(true);
      try {
        const [channels, history, channelTasks] = await Promise.all([
          api.listAgentChannels(),
          api.listAgentChannelMessages(channelId),
          api.listAgentTasks({ channelId }).catch(() => [] as AgentTask[]),
        ]);
        if (request !== requestId.current) return;
        const found = channels.find((entry) => entry.id === channelId) ?? null;
        setChannel(found);
        setMessages(history);
        setTasks(channelTasks);
        if (!found) {
          toast.info(t('channel.gone'));
          setActiveChannelId(null);
        }
      } catch (error) {
        if (request === requestId.current && !silent) {
          toast.error(t('channel.openError'), { description: String(error) });
        }
      } finally {
        if (request === requestId.current) setLoading(false);
      }
    },
    [channelId, setActiveChannelId, t],
  );

  useEffect(() => {
    if (activeChannelId !== channelId) return;
    void load();
  }, [activeChannelId, channelId, load]);

  useEffect(() => {
    // Polling refreshes replies published by the member agents while a post is
    // still running; the backend appends each reply as it finishes.
    const reload = () => void load(true);
    window.addEventListener('zylara:channels-changed', reload);
    window.addEventListener('zylara:agent-channel-updated', reload);
    window.addEventListener('zylara:agent-task-updated', reload);
    const interval = window.setInterval(reload, 3000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('zylara:channels-changed', reload);
      window.removeEventListener('zylara:agent-channel-updated', reload);
      window.removeEventListener('zylara:agent-task-updated', reload);
    };
  }, [load]);

  /* Follow new replies only while the user is parked at the bottom. */
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom('auto');
  }, [messages, sending, scrollToBottom]);

  /* Always start a channel at its latest message. */
  useEffect(() => {
    atBottomRef.current = true;
    scrollToBottom('auto');
  }, [channelId, scrollToBottom]);

  const send = async () => {
    const content = draft.trim();
    const pendingAttachments = attachments;
    if ((!content && pendingAttachments.length === 0) || sending) return;
    setSending(true);
    setErrors([]);
    setMentionOpen(false);
    // A poll that started before the backend persisted this post must not
    // overwrite the optimistic bubble with an older history.
    requestId.current += 1;
    // Optimistic bubble so the composer feels immediate; the authoritative
    // list replaces it when the agents finish.
    const optimistic: AgentChannelMessage = {
      id: `optimistic-${Date.now()}`,
      channelId,
      role: 'user',
      agentId: null,
      content,
      attachments: pendingAttachments,
      createdAt: Date.now(),
    };
    setMessages((current) => [...current, optimistic]);
    setDraft('');
    attachmentsRef.current = [];
    setAttachments([]);
    setMentionIndex(0);
    requestAnimationFrame(resizeTextarea);
    try {
      const result = await api.postAgentChannelMessage(
        channelId,
        content,
        pendingAttachments.map((attachment) => attachment.id),
      );
      setMessages(result.messages);
      setErrors(result.errors);
      if (result.errors.length > 0) {
        toast.warning(t('channel.someFailed'), {
          description: result.errors[0],
        });
      }
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setDraft(content);
      attachmentsRef.current = pendingAttachments;
      setAttachments(pendingAttachments);
      void load(true);
      toast.error(t('channel.postError'), { description: String(error) });
    } finally {
      setSending(false);
      requestAnimationFrame(() => {
        resizeTextarea();
        textareaRef.current?.focus();
      });
    }
  };

  if (loading) {
    return (
      <div className="relative flex h-full items-center justify-center text-[13px] text-foreground-muted">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t('channel.loading')}
        <AgentPanelOpener />
      </div>
    );
  }
  if (!channel) {
    return (
      <div className="relative flex h-full items-center justify-center px-6 text-center text-[13px] text-foreground-muted">
        {t('channel.unavailable')}
        <AgentPanelOpener />
      </div>
    );
  }

  const leader = channel.leaderAgentId
    ? (members.find((member) => member.id === channel.leaderAgentId) ?? null)
    : null;
  const canPost = draft.trim().length > 0 || attachments.length > 0;

  return (
    <Slot name="agent.channel.view.frame" owner={{ channelId: channel.id }}>
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <IconButton label={t('channel.back')} size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </IconButton>
        {members.length > 0 ? (
          <AgentAvatarStack
            members={members}
            size="sm"
            ringClassName="ring-background"
          />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-xl bg-surface-active/70 text-[15px]">
            {isDm ? '@' : '#'}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <p className="truncate text-[13px] font-medium text-foreground">{channel.name}</p>
            {leader ? (
              <span
                title={t('channel.leaderTitle', { name: leader.name })}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-medium text-accent"
              >
                <Crown aria-hidden className="size-3" />
                <span className="max-w-[7rem] truncate">
                  {t('channel.leaderBadge', { name: leader.name })}
                </span>
              </span>
            ) : null}
          </div>
          <p
            className="flex min-w-0 items-center gap-1 text-[11px] text-foreground-muted"
            title={memberNames || undefined}
          >
            <Users className="size-3 shrink-0" />
            <span className="truncate">
              {members.length > 0
                ? t('channel.membersSummary', {
                    count: members.length,
                    names: memberNames,
                  })
                : t('channel.noMembers')}
            </span>
          </p>
        </div>
        <AgentPanelButton />
        <IconButton
          label={t('channel.tasks')}
          size="sm"
          variant="ghost"
          onClick={() => setTaskBoardOpen(true)}
        >
          <ListChecks className="size-4" />
        </IconButton>
        {isDm ? null : (
          <IconButton
            label={t('channel.edit')}
            size="sm"
            variant="ghost"
            onClick={() => onEdit(channel)}
          >
            <Settings2 className="size-4" />
          </IconButton>
        )}
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center px-6 py-12">
            <div className="max-w-sm text-center">
              <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-surface-hover text-[20px] text-foreground-muted">
                {isDm ? '@' : '#'}
              </span>
              <p className="text-[15px] font-medium text-foreground">
                {t('channel.emptyTitle', { name: channel.name, prefix: isDm ? '' : '#' })}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-foreground-muted">
                {isDm
                  ? t('channel.emptyDm')
                  : leader
                    ? t('channel.emptyLeader', { name: leader.name })
                    : t('channel.empty')}
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 pb-10 pt-6">
            <div
              role="log"
              aria-live={sending ? 'polite' : 'off'}
              aria-relevant="additions text"
              aria-busy={sending}
              className="flex flex-col"
            >
              {messages.map((message, index) => {
                const author = messageAuthor(message, names, t);
                const previous = messages[index - 1];
                const groupStart = !previous || previous.role !== message.role;
                const spacing = groupStart ? 'mt-7' : 'mt-3';

                if (message.role === 'system') {
                  return (
                    <Fragment key={message.id}>
                      <Slot name="agent.channel.message.before" owner={{ channelId: channel.id, message }} />
                      <div className={cn('flex justify-center', spacing)}>
                        <p className="rounded-full bg-surface-hover px-3 py-1 text-[11px] text-foreground-muted">
                          {message.content}
                        </p>
                      </div>
                      <Slot name="agent.channel.message.after" owner={{ channelId: channel.id, message }} />
                    </Fragment>
                  );
                }

                if (message.role === 'user') {
                  return (
                    <Fragment key={message.id}>
                      <Slot name="agent.channel.message.before" owner={{ channelId: channel.id, message }} />
                    <div
                      className={cn('group/message flex flex-col items-end', spacing)}
                    >
                      {message.attachments.length > 0 ? (
                        <AttachmentChips
                          attachments={message.attachments}
                          align="end"
                          className="mb-1.5"
                        />
                      ) : null}
                      {message.content ? (
                        <Slot
                          name="agent.channel.message.body.frame"
                          owner={{ channelId: channel.id, message }}
                        >
                          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-3xl bg-user-bubble px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
                            {message.content}
                          </div>
                        </Slot>
                      ) : null}
                      {message.content ? (
                        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100">
                          <MessageCopyButton content={message.content} label={t('channel.copyMessage')} />
                        </div>
                      ) : null}
                    </div>
                    <Slot name="agent.channel.message.after" owner={{ channelId: channel.id, message }} />
                    </Fragment>
                  );
                }

                return (
                  <Fragment key={message.id}>
                    <Slot name="agent.channel.message.before" owner={{ channelId: channel.id, message }} />
                  <div
                    className={cn('group/message flex items-start gap-3', spacing)}
                  >
                    <AgentAvatar
                      avatar={author.avatar}
                      size="sm"
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="mb-0.5 text-[11px] font-medium text-foreground-subtle">
                        {author.name}
                      </p>
                      <Slot
                        name="agent.channel.message.body.frame"
                        owner={{ channelId: channel.id, message }}
                      >
                        <Markdown content={message.content} />
                      </Slot>
                      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100">
                        <MessageCopyButton content={message.content} label={t('channel.copyReply')} />
                      </div>
                    </div>
                  </div>
                    <Slot name="agent.channel.message.after" owner={{ channelId: channel.id, message }} />
                  </Fragment>
                );
              })}
              {sending ? (
                <div className="mt-7 flex items-start gap-3">
                  <div className="size-7 shrink-0" aria-hidden />
                  <div className="flex items-center gap-2 py-1 text-[13px] text-foreground-subtle">
                    <Spinner size="xs" />
                    <span>
                      {leader
                        ? t('channel.leaderResponding', { name: leader.name })
                        : t('channel.agentsResponding')}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="relative z-10 shrink-0 px-4 pb-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-linear-to-t from-background via-background/90 to-transparent"
        />
        <div className="relative mx-auto w-full max-w-3xl">
          {activeTasks.length > 0 ? (
            <div className="mb-2 overflow-hidden rounded-xl bg-accent-soft/35">
              <div className="flex items-center gap-2 border-b border-accent/20 px-2.5 py-1.5">
                <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
                <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                  {t('channel.activeTasks')}
                </span>
                <button
                  type="button"
                  onClick={() => setTaskBoardOpen(true)}
                  className="shrink-0 text-[10px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {t('channel.viewBoard')}
                </button>
              </div>
              <div className="p-1">
                {activeTasks.slice(0, 3).map((task) => {
                  const owner = names.get(task.ownerAgentId);
                  const meta = taskStatusMeta(task.status);
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setTaskBoardOpen(true)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      {owner ? <AgentAvatar avatar={owner.avatar} size="xs" /> : null}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                        {task.title}
                      </span>
                      <span className={cn('shrink-0 text-[10px] font-medium', meta.tone)}>
                        {t(meta.labelKey as never)}
                      </span>
                    </button>
                  );
                })}
                {activeTasks.length > 3 ? (
                  <button
                    type="button"
                    onClick={() => setTaskBoardOpen(true)}
                    className="w-full rounded-lg px-1.5 py-1 text-left text-[10px] text-foreground-subtle hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {t('channel.moreTasks', { count: activeTasks.length - 3 })}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {errors.length > 0 ? (
            <div
              role="alert"
              className="mb-2 rounded-xl bg-warning-soft px-3 py-2 text-[11px] text-foreground-muted"
            >
              {errors.map((error) => (
                <p key={error} className="truncate">
                  {error}
                </p>
              ))}
            </div>
          ) : null}
          {isDm ? (
            <p className="rounded-xl bg-surface-hover px-3 py-2 text-center text-[11px] text-foreground-muted">
              {t('channel.dmNotice')}
            </p>
          ) : (
            <>
              <Slot
                name="agent.channel.composer.frame"
                owner={{ channelId: channel.id }}
              >
              <div
                className="relative rounded-3xl bg-surface-raised shadow-sm transition-colors duration-150"
              >
                <ComposerActivity active={sending} reduceMotion={reduceMotion} />
                <div className="px-3 pb-1 pt-3">
                  {mentionOpen && mentionCandidates.length > 0 ? (
                    <div
                      role="listbox"
                      id="channel-mention-listbox"
                      aria-label={t('channel.membersAria')}
                      className="mb-2 grid max-h-56 gap-0.5 overflow-y-auto rounded-xl bg-surface p-1"
                    >
                      {mentionCandidates.map((member, index) => (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          id={`channel-mention-${member.id}`}
                          aria-selected={index === activeMentionIndex}
                          aria-label={t('channel.mentionAria', { name: member.name })}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px]',
                            index === activeMentionIndex
                              ? 'bg-surface-hover text-foreground'
                              : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                          )}
                          onMouseEnter={() => setMentionIndex(index)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            insertMention(member.name);
                          }}
                        >
                          <AgentAvatar avatar={member.avatar} size="sm" />
                          <span className="truncate">{member.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {attachments.length > 0 ? (
                    <AttachmentChips
                      attachments={attachments}
                      onRemove={(id) => void removeAttachment(id)}
                      className="mb-2"
                    />
                  ) : null}
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    rows={1}
                    maxLength={16000}
                    placeholder={t('channel.messagePlaceholder', {
                      name: channel.name,
                      prefix: isDm ? '' : '#',
                    })}
                    aria-label={t('channel.messageAria', { name: channel.name })}
                    aria-autocomplete="list"
                    aria-expanded={
                      mentionOpen && mentionCandidates.length > 0 ? true : undefined
                    }
                    aria-controls={
                      mentionOpen && mentionCandidates.length > 0
                        ? 'channel-mention-listbox'
                        : undefined
                    }
                    aria-activedescendant={
                      mentionOpen && mentionCandidates.length > 0
                        ? `channel-mention-${mentionCandidates[activeMentionIndex]?.id}`
                        : undefined
                    }
                    className={
                      'block max-h-[220px] w-full resize-none bg-transparent px-1.5 py-0.5 text-[15px] leading-relaxed text-foreground placeholder:text-foreground-subtle focus:outline-none'
                    }
                    onChange={(event) => {
                      const next = event.target.value;
                      setDraft(next);
                      setMentionIndex(0);
                      setMentionOpen(/(?:^|\s)@([^\s@]*)$/.test(next));
                    }}
                    onPaste={handlePaste}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;

                      // The mention picker keeps the focus in the textarea and
                      // is navigated with arrows, like the chat composer menus.
                      if (mentionOpen && mentionCandidates.length > 0) {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setMentionOpen(false);
                          return;
                        }
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setMentionIndex(
                            (current) => (current + 1) % mentionCandidates.length,
                          );
                          return;
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setMentionIndex(
                            (current) =>
                              (current - 1 + mentionCandidates.length) %
                              mentionCandidates.length,
                          );
                          return;
                        }
                        if (event.key === 'Enter' || event.key === 'Tab') {
                          event.preventDefault();
                          const member = mentionCandidates[activeMentionIndex];
                          if (member) insertMention(member.name);
                          return;
                        }
                      }

                      if (event.key !== 'Enter') return;
                      const withModifier = event.metaKey || event.ctrlKey;
                      const shouldSend =
                        sendKey === 'ctrl+enter' ? withModifier : withModifier || !event.shiftKey;
                      if (!shouldSend) return;
                      event.preventDefault();
                      void send();
                    }}
                  />
                </div>
                <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                  <IconButton
                    label={t('channel.attach')}
                    size="sm"
                    variant="ghost"
                    loading={attaching}
                    onClick={() => void handleAttach()}
                  >
                    <Plus className="size-4" />
                  </IconButton>
                  <Slot
                    name="agent.channel.composer.actions"
                    owner={{ channelId: channel.id, active: true }}
                  />
                  <div className="ml-auto flex items-center gap-1.5">
                    {sending ? (
                      <button
                        type="button"
                        disabled
                        aria-label={t('channel.posting')}
                        className="flex size-8 shrink-0 cursor-not-allowed items-center justify-center rounded-full bg-surface-active text-foreground-subtle"
                      >
                        <Loader2 className="size-4 animate-spin" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void send()}
                        disabled={!canPost}
                        aria-label={t('channel.post')}
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                          canPost
                            ? 'bg-linear-to-br from-accent to-accent-hover text-accent-foreground hover:brightness-105'
                            : 'cursor-not-allowed bg-surface-active text-foreground-subtle',
                          canPost && !reduceMotion && 'active:scale-95',
                        )}
                      >
                        <ArrowUp className="size-4" strokeWidth={2.25} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              </Slot>
              <p className="mt-1.5 text-center text-[11px] leading-relaxed text-foreground-subtle">
                {t('channel.disclaimer')}
              </p>
            </>
          )}
        </div>
      </div>

      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-32 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => scrollToBottom(reduceMotion ? 'auto' : 'smooth')}
            aria-label={t('channel.jumpToEnd')}
            className={cn(
              'pointer-events-auto flex size-9 items-center justify-center rounded-full ',
              'bg-surface-raised text-foreground-muted shadow-md',
              'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            )}
          >
            <ArrowDown className="size-4" />
          </button>
        </div>
      ) : null}

      <AgentTaskBoardDialog
        open={taskBoardOpen}
        onOpenChange={setTaskBoardOpen}
        channelId={channelId}
        title={t('channel.tasksTitle', { name: channel.name })}
      />
    </div>
    </Slot>
  );
}
