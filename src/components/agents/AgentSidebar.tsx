import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  Activity,
  Archive,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  Ellipsis,
  Globe2,
  Hash,
  ListChecks,
  ListTree,
  MessageCircle,
  MessageCircleQuestion,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Palette,
  Pencil,
  Pin,
  PinOff,
  PanelRight,
  Plus,
  Power,
  Search,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { AgentAvatar } from './AgentAvatar';
import { AgentAvatarStack } from './AgentAvatarStack';
import { AgentActivityDots } from './AgentActivityDots';
import { AgentActivityDialog } from './AgentActivityDialog';
import { AgentChannelDialog } from './AgentChannelDialog';
import { AgentDialogBody } from './AgentDialogBody';
import { AgentRevisionDialog } from './AgentRevisionDialog';
import { AgentTaskBoardDialog } from './AgentTaskBoardDialog';
import { AgentTasksDialog } from './AgentTasksDialog';
import { departmentKey, localizedDepartment, relativeTime } from './agentUtils';
import { compareText, localeLowerCase } from '@/lib/i18n/format';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  SortableList,
  sortableDropClass,
} from '@/components/ui';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Slot } from '@/components/plugins/ui/Slot';
import { pluginIcon } from '@/lib/plugins/icons';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { navEntries, openNavTarget } from '@/lib/plugins/ui/nav';
import type { SortableListApi } from '@/components/ui';
import {
  selectActiveAgents,
  selectPinnedAgents,
  useMessageQueueStore,
  useAgentStore,
  useChatStore,
  useCodeStore,
  useUiStore,
} from '@/lib/store';
import type { Agent, AgentChannel, Conversation } from '@/lib/types';
import { cn, compareConversationOrder, createSerialRunner } from '@/lib/utils';

const runChannelReorder = createSerialRunner();

function sortChannels(channels: AgentChannel[]): AgentChannel[] {
  return [...channels].sort(
    (left, right) =>
      (left.sortOrder ?? 0) - (right.sortOrder ?? 0) ||
      right.updatedAt - left.updatedAt ||
      compareText(left.id, right.id),
  );
}

export interface AgentSidebarProps {
  className?: string;
  onClose?: () => void;
}

function ThreadRow({
  conversation,
  active,
  sortable,
  onSelect,
  onTogglePin,
  onStartRename,
  onExport,
  onDelete,
  onStop,
}: {
  conversation: Conversation;
  active: boolean;
  sortable: SortableListApi;
  onSelect: () => void;
  onTogglePin: () => void;
  onStartRename: () => void;
  onExport: () => void;
  onDelete: () => void;
  onStop: () => void;
}) {
  const queued = useMessageQueueStore(
    (state) => state.byConversation[conversation.id]?.length ?? 0,
  );
  const busy = useChatStore((state) =>
    Boolean(
      state.streamsByConversation[conversation.id] ??
        (state.streaming?.conversationId === conversation.id ? state.streaming : null),
    ),
  );
  const session = useCodeStore((state) => state.byConversation[conversation.id]);
  const awaitingApproval = (session?.approvals.length ?? 0) > 0;
  const awaitingAnswer = (session?.questions.length ?? 0) > 0;
  const failed = Boolean(session?.error);
  const { t } = useTranslation('agents');
  const defaultMainTitles = [
    t('threads.main'),
    'Conversa principal',
    'Main conversation',
    'Conversación principal',
  ];
  const mainLabel = conversation.isMain
    ? defaultMainTitles.includes(conversation.title)
      ? t('threads.main')
      : `${conversation.title} · ${t('threads.main')}`
    : conversation.title;
  return (
    <div
      {...sortable.dropProps(conversation.id)}
      className={cn('group/thread relative flex items-center', sortableDropClass)}
    >
      <button
        type="button"
        {...sortable.itemProps(conversation.id)}
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        title={mainLabel}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pl-7 pr-8 text-left text-[12px]',
          'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          !sortable.disabled && 'cursor-grab active:cursor-grabbing',
          active
            ? 'bg-surface-active text-foreground'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
        )}
      >
        {conversation.pinned ? (
          <Pin aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
        ) : (
          <MessageSquare aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate">{mainLabel}</span>
        {queued > 0 ? (
          <span
            title={t('sidebar.queueTitle', { count: queued })}
            className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-medium text-accent"
          >
            {queued}
          </span>
        ) : null}
        {busy ? (
          <AgentActivityDots label={t('activity.responding')} />
        ) : awaitingApproval ? (
          <ShieldAlert
            aria-label={t('sidebar.awaitingApproval')}
            className="size-3.5 shrink-0 text-warning"
          />
        ) : awaitingAnswer ? (
          <MessageCircleQuestion
            aria-label={t('sidebar.awaitingAnswer')}
            className="size-3.5 shrink-0 text-accent"
          />
        ) : failed ? (
          <CircleAlert aria-label={t('sidebar.lastTurnFailed')} className="size-3.5 shrink-0 text-danger" />
        ) : (
          <span className="shrink-0 text-[10px] text-foreground-subtle">
            {relativeTime(conversation.updatedAt)}
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('sidebar.threadOptions', { title: conversation.title })}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'absolute right-0.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md',
              'text-foreground-subtle transition-colors duration-150 hover:bg-surface-active hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              'opacity-100 lg:opacity-0 lg:group-hover/thread:opacity-100 lg:focus-visible:opacity-100 lg:data-[state=open]:opacity-100',
            )}
          >
            <Ellipsis aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {busy ? (
            <>
              <DropdownMenuItem
                variant="danger"
                icon={<Square className="size-3.5" />}
                onSelect={onStop}
              >
                {t('sidebar.stopRun')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {!conversation.isMain ? (
            <DropdownMenuItem
              icon={
                conversation.pinned ? (
                  <PinOff className="size-3.5" />
                ) : (
                  <Pin className="size-3.5" />
                )
              }
              onSelect={onTogglePin}
            >
              {conversation.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem icon={<Pencil className="size-3.5" />} onSelect={onStartRename}>
            {t('sidebar.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Download className="size-3.5" />} onSelect={onExport}>
            {t('sidebar.export')}
          </DropdownMenuItem>
          {!conversation.isMain ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="danger"
                icon={<Trash2 className="size-3.5" />}
                onSelect={onDelete}
              >
                {t('common:actions.delete')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function AgentRow({
  agent,
  active,
  expanded,
  threads,
  activeThreadId,
  sortable,
  threadsDisabled,
  onReorderThreads,
  onSelect,
  onToggle,
  onNewThread,
  onEdit,
  onAvatar,
  onRevise,
  onDuplicate,
  onExport,
  onPin,
  onArchive,
  onDelete,
  onOpenThread,
  onToggleThreadPin,
  onStartThreadRename,
  onExportThread,
  onDeleteThread,
  onStopThread,
  onShowAllThreads,
  onRoutines,
  onTasks,
}: {
  agent: Agent;
  active: boolean;
  expanded: boolean;
  threads: Conversation[];
  activeThreadId: string | null;
  sortable: SortableListApi;
  threadsDisabled: boolean;
  onReorderThreads: (ids: string[]) => void;
  onSelect: () => void;
  onToggle: () => void;
  onNewThread: () => void;
  onEdit: () => void;
  onAvatar: () => void;
  onRevise: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onOpenThread: (id: string) => void;
  onToggleThreadPin: (thread: Conversation) => void;
  onStartThreadRename: (thread: Conversation) => void;
  onExportThread: (thread: Conversation) => void;
  onDeleteThread: (thread: Conversation) => void;
  onStopThread: (thread: Conversation) => void;
  onShowAllThreads: () => void;
  onRoutines: () => void;
  onTasks: () => void;
}) {
  const shown = threads.slice(0, 5);
  const streamsByConversation = useChatStore((state) => state.streamsByConversation);
  const visibleStream = useChatStore((state) => state.streaming);
  const busy = threads.some((thread) =>
    Boolean(
      streamsByConversation[thread.id] ??
        (visibleStream?.conversationId === thread.id ? visibleStream : null),
    ),
  );
  const { t } = useTranslation('agents');
  return (
    <div {...sortable.dropProps(agent.id)} className={sortableDropClass}>
      <div className="group relative flex items-center">
        <button
          type="button"
          aria-label={expanded ? t('sidebar.collapseThreads') : t('sidebar.expandThreads')}
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button
          type="button"
          {...sortable.itemProps(agent.id)}
          onClick={onSelect}
          aria-current={active ? 'true' : undefined}
          className={cn(
            'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-left',
            'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            !sortable.disabled && 'cursor-grab active:cursor-grabbing',
            active ? 'bg-surface-active' : 'hover:bg-surface-hover',
          )}
        >
          <AgentAvatar
            avatar={agent.avatar}
            size="sm"
            activity={busy ? 'running' : 'idle'}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-foreground">{agent.name}</span>
              {busy ? (
                <AgentActivityDots label={t('activity.responding')} />
              ) : null}
              {agent.pinned ? <Pin className="size-2.5 shrink-0 text-foreground-subtle" /> : null}
              {agent.computerEnvironment !== 'auto' ||
              agent.capabilities.computerUse ||
              agent.capabilities.screenCapture ||
              agent.capabilities.browserUse ? (
                agent.computerEnvironment === 'off' ? (
                  <Power
                    aria-label={t('sidebar.computerOff')}
                    className="size-3 shrink-0 text-foreground-subtle"
                  />
                ) : agent.computerEnvironment === 'browser' ? (
                  <Globe2
                    aria-label={t('sidebar.browserOnly')}
                    className="size-3 shrink-0 text-foreground-subtle"
                  />
                ) : (
                  <Monitor
                    aria-label={t('sidebar.computerAccess')}
                    className="size-3 shrink-0 text-foreground-subtle"
                  />
                )
              ) : null}
            </span>
            <span className="block truncate text-[11px] text-foreground-muted">{agent.role}</span>
          </span>
          {threads.length > 0 ? (
            <span className="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] text-foreground-subtle">
              {threads.length}
            </span>
          ) : null}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('sidebar.agentOptions', { name: agent.name })}
              onClick={(event) => event.stopPropagation()}
              className={cn(
                'absolute right-0.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md',
                'text-foreground-subtle hover:bg-surface-active hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100 lg:data-[state=open]:opacity-100',
              )}
            >
              <Ellipsis className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem icon={<MessageSquarePlus className="size-3.5" />} onSelect={onNewThread}>
              {t('sidebar.newConversation')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<ListTree className="size-3.5" />} onSelect={onShowAllThreads}>
              {t('sidebar.allThreads')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<CalendarClock className="size-3.5" />} onSelect={onRoutines}>
              {t('panel.tabs.routines')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<ListChecks className="size-3.5" />} onSelect={onTasks}>
              {t('tasks.heading')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Pencil className="size-3.5" />} onSelect={onEdit}>
              {t('panel.editAgent')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Palette className="size-3.5" />} onSelect={onAvatar}>
              {t('sidebar.agentAvatar')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<WandSparkles className="size-3.5" />} onSelect={onRevise}>
              {t('sidebar.editWithAi')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Copy className="size-3.5" />} onSelect={onDuplicate}>
              {t('sidebar.duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Download className="size-3.5" />} onSelect={onExport}>
              {t('sidebar.export')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={agent.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              onSelect={onPin}
            >
              {agent.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<Archive className="size-3.5" />} onSelect={onArchive}>
              {t('sidebar.archive')}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              onSelect={onDelete}
            >
              {t('common:actions.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded ? (
        <div className="mb-1 space-y-0.5">
          {shown.length > 0 ? (
            <SortableList
              ids={shown.map((thread) => thread.id)}
              label={t('sidebar.agentThreadsLabel', { name: agent.name })}
              itemLabel={(id) => threads.find((thread) => thread.id === id)?.title ?? id}
              disabled={threadsDisabled}
              lockedCount={shown.filter((thread) => thread.pinned).length}
              onReorder={onReorderThreads}
            >
              {(threadSortable) => (
                <div ref={threadSortable.containerRef} className="space-y-0.5">
                  {shown.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      conversation={thread}
                      active={activeThreadId === thread.id}
                      sortable={threadSortable}
                      onSelect={() => onOpenThread(thread.id)}
                      onTogglePin={() => onToggleThreadPin(thread)}
                      onStartRename={() => onStartThreadRename(thread)}
                      onExport={() => onExportThread(thread)}
                      onDelete={() => onDeleteThread(thread)}
                      onStop={() => onStopThread(thread)}
                    />
                  ))}
                </div>
              )}
            </SortableList>
          ) : null}
          {threads.length > shown.length ? (
            <button
              type="button"
              onClick={onShowAllThreads}
              className="flex h-7 w-full items-center gap-2 rounded-lg pl-7 pr-2 text-left text-[11px] text-foreground-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <ListTree aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
              {t('sidebar.showAllThreads', { count: threads.length })}
            </button>
          ) : null}
          {threads.length === 0 ? (
            <p className="py-1 pl-7 text-[11px] text-foreground-subtle">{t('sidebar.noThreads')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Overlapping member thumbnails shown on a channel row (2 + overflow chip). */
function ChannelMemberStack({ members, active }: { members: Agent[]; active: boolean }) {
  return (
    <AgentAvatarStack
      members={members}
      ringClassName={
        active
          ? 'ring-surface-active'
          : 'ring-surface group-hover/channel:ring-surface-hover'
      }
    />
  );
}

function ChannelRow({
  channel,
  members,
  active,
  label,
  pending,
  sortable,
  onSelect,
  onEdit,
}: {
  channel: AgentChannel;
  members: Agent[];
  active: boolean;
  label: string;
  pending: number;
  sortable: SortableListApi;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const dm = channel.kind === 'dm';
  const { t } = useTranslation('agents');
  return (
    <div
      {...sortable.dropProps(channel.id)}
      className={cn('group/channel relative flex items-center', sortableDropClass)}
    >
      <button
        type="button"
        {...sortable.itemProps(channel.id)}
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        title={label}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 pr-8 text-left text-[12px]',
          'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          !sortable.disabled && 'cursor-grab active:cursor-grabbing',
          active
            ? 'bg-surface-active text-foreground'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
        )}
      >
        {members.length > 0 ? (
          <ChannelMemberStack members={members} active={active} />
        ) : dm ? (
          <MessageCircle aria-hidden className="size-3.5 shrink-0 text-accent" />
        ) : (
          <Hash aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {pending > 0 ? (
          <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-medium text-background">
            {pending}
          </span>
        ) : null}
      </button>
      {dm ? null : (
        <button
          type="button"
          aria-label={t('sidebar.editChannelAria', { name: channel.name })}
          onClick={(event) => {
            event.stopPropagation();
            onEdit();
          }}
          className={cn(
            'absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md',
            'text-foreground-subtle hover:bg-surface-active hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            'opacity-100 lg:opacity-0 lg:group-hover/channel:opacity-100 lg:focus-visible:opacity-100',
          )}
        >
        <Pencil className="size-3.5" />
      </button>
      )}
    </div>
  );
}

export function AgentSidebar({ className, onClose }: AgentSidebarProps) {
  const { t } = useTranslation('agents');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [allThreadsAgent, setAllThreadsAgent] = useState<Agent | null>(null);
  const [revisionAgent, setRevisionAgent] = useState<Agent | null>(null);
  const [tasksAgent, setTasksAgent] = useState<Agent | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [taskBoardOpen, setTaskBoardOpen] = useState(false);
  const activeTurnCount = useChatStore(
    (state) => Object.keys(state.streamsByConversation).length,
  );
  const agentPanelOpen = useUiStore((state) => state.agentPanelOpen);
  const agentRightPanel = useUiStore((state) => state.agentRightPanel);
  const setAgentPanelOpen = useUiStore((state) => state.setAgentPanelOpen);
  const setAgentRightPanel = useUiStore((state) => state.setAgentRightPanel);
  const [channels, setChannels] = useState<AgentChannel[]>([]);
  const [inboxCounts, setInboxCounts] = useState<Record<string, number>>({});
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<AgentChannel | null>(null);
  const [renameThreadTarget, setRenameThreadTarget] = useState<Conversation | null>(null);
  const [renameThreadValue, setRenameThreadValue] = useState('');
  const [renameThreadBusy, setRenameThreadBusy] = useState(false);
  const [deleteThreadTarget, setDeleteThreadTarget] = useState<Conversation | null>(null);
  const [deleteThreadBusy, setDeleteThreadBusy] = useState(false);
  const agents = useAgentStore(useShallow(selectActiveAgents));
  const agentsById = useAgentStore((state) => state.agentsById);
  const status = useAgentStore((state) => state.status);
  const storeError = useAgentStore((state) => state.error);
  const refresh = useAgentStore((state) => state.refresh);
  const pinned = useAgentStore(useShallow(selectPinnedAgents));
  const pin = useAgentStore((state) => state.pin);
  const reorderAgents = useAgentStore((state) => state.reorder);
  const archive = useAgentStore((state) => state.archive);
  const restore = useAgentStore((state) => state.restore);
  const remove = useAgentStore((state) => state.remove);
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const setActiveAgentId = useUiStore((state) => state.setActiveAgentId);
  const setActiveChannelId = useUiStore((state) => state.setActiveChannelId);
  const agentView = useUiStore((state) => state.agentView);
  const setAgentView = useUiStore((state) => state.setAgentView);
  const openAgentRoutines = useUiStore((state) => state.openAgentRoutines);
  const openEditor = useUiStore((state) => state.openAgentEditor);
  const openAvatarEditor = useUiStore((state) => state.openAgentAvatarEditor);
  const openSettings = useUiStore((state) => state.openSettings);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const clearActiveConversation = useChatStore((state) => state.clearActiveConversation);
  const openConversation = useChatStore((state) => state.openConversation);
  const pluginPages = useUiStore((state) => state.pluginPages.agent);
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const agentNav = useMemo(
    () =>
      navEntries('agent', ui.nav, {
        hidden: prefs.navHidden,
        order: prefs.navOrder,
      }),
    [ui.nav, prefs.enabled, prefs.navHidden, prefs.navOrder],
  );

  const openRoutines = (agentId: string | null) => {
    setActiveAgentId(null);
    setActiveChannelId(null);
    clearActiveConversation();
    openAgentRoutines(agentId);
    onClose?.();
  };

  useEffect(() => {
    if (activeAgentId) {
      setExpanded((current) => {
        if (current.has(activeAgentId)) return current;
        const next = new Set(current);
        next.add(activeAgentId);
        return next;
      });
    }
  }, [activeAgentId]);

  const loadChannels = useCallback(() => {
    void Promise.all([api.listAgentChannels(), api.listAgentChannelInboxCounts()])
      .then(([list, counts]) => {
        setChannels(sortChannels(list));
        setInboxCounts(
          Object.fromEntries(counts.map((entry) => [entry.channelId, entry.pending])),
        );
      })
      .catch(() => {
        setChannels([]);
        setInboxCounts({});
      });
  }, []);

  useEffect(() => {
    loadChannels();
    window.addEventListener('zylara:channels-changed', loadChannels);
    window.addEventListener('zylara:agent-channel-updated', loadChannels);
    window.addEventListener('zylara:agent-inbox-updated', loadChannels);
    return () => {
      window.removeEventListener('zylara:channels-changed', loadChannels);
      window.removeEventListener('zylara:agent-channel-updated', loadChannels);
      window.removeEventListener('zylara:agent-inbox-updated', loadChannels);
    };
  }, [loadChannels]);

  const threadsFor = (agentId: string) =>
    conversations
      .filter(
        (conversation) =>
          conversation.mode === 'agent' &&
          conversation.agentId === agentId &&
          !conversation.channelId &&
          !conversation.taskId,
      )
      .sort(compareConversationOrder);

  const groups = useMemo(() => {
    const byDepartment = new Map<string, Agent[]>();
    for (const agent of agents) {
      const key = departmentKey(agent.department);
      const list = byDepartment.get(key) ?? [];
      list.push(agent);
      byDepartment.set(key, list);
    }
    return [...byDepartment.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([department, groupAgents]) => ({ department, agents: groupAgents }));
  }, [agents]);

  const normalizedQuery = localeLowerCase(query.trim());
  const matches = (agent: Agent) => {
    if (!normalizedQuery) return true;
    const haystack = localeLowerCase(
      `${agent.name} ${agent.role} ${agent.description} ${agent.department}`,
    );
    return (
      haystack.includes(normalizedQuery) ||
      threadsFor(agent.id).some((thread) =>
        localeLowerCase(thread.title).includes(normalizedQuery),
      )
    );
  };

  const visiblePinned = useMemo(
    () => pinned.filter(matches),
    [pinned, normalizedQuery, conversations],
  );
  const visibleChannels = useMemo(
    () =>
      normalizedQuery
        ? channels.filter((channel) =>
            localeLowerCase(channel.name).includes(normalizedQuery),
          )
        : channels,
    [channels, normalizedQuery],
  );
  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          agents: group.agents.filter((agent) => !agent.pinned && matches(agent)),
        }))
        .filter((group) => group.agents.length > 0),
    [groups, normalizedQuery, conversations],
  );

  const selectAgent = (agent: Agent) => {
    setAgentView('team');
    setActiveAgentId(agent.id);
    clearActiveConversation();
    setExpanded((current) => new Set(current).add(agent.id));
    onClose?.();
  };

  const selectChannel = (channel: AgentChannel) => {
    setAgentView('team');
    setActiveChannelId(channel.id);
    clearActiveConversation();
    onClose?.();
  };

  const channelLabel = (channel: AgentChannel) =>
    channel.kind === 'dm'
      ? channel.memberIds
          .map((id) => agents.find((agent) => agent.id === id)?.name)
          .filter(Boolean)
          .join(' ↔ ') || channel.name
      : channel.name;

  const newThread = (agent: Agent) => {
    setAgentView('team');
    setActiveAgentId(agent.id);
    void startNewConversation('agent', { agentId: agent.id });
    onClose?.();
  };

  const openThread = (agent: Agent, threadId: string) => {
    setAgentView('team');
    setActiveAgentId(agent.id);
    void openConversation(threadId);
    onClose?.();
  };

  const toggleThreadPinned = (thread: Conversation) => {
    void useChatStore.getState().togglePinned(thread.id);
  };

  const handleReorderAgents = (ids: string[]) => {
    void reorderAgents(ids).catch((error) => {
      toast.error(t('sidebar.reorderAgentsError'), { description: String(error) });
    });
  };

  const handleReorderChannels = (ids: string[]) => {
    const positions = new Map(ids.map((id, index) => [id, index]));
    setChannels((current) =>
      sortChannels(
        current.map((channel) =>
          positions.has(channel.id)
            ? { ...channel, sortOrder: positions.get(channel.id)! }
            : channel,
        ),
      ),
    );
    void runChannelReorder(() => api.reorderAgentChannels(ids)).catch((error) => {
      toast.error(t('sidebar.reorderChannelsError'), { description: String(error) });
      loadChannels();
    });
  };

  const handleReorderThreads = (agent: Agent, visibleIds: string[]) => {
    const full = threadsFor(agent.id).map((thread) => thread.id);
    const hidden = full.filter((id) => !visibleIds.includes(id));
    void useChatStore.getState().reorderConversations([...visibleIds, ...hidden]);
  };

  const stopThread = (thread: Conversation) => {
    void useChatStore.getState().stopConversation(thread.id);
  };

  const startThreadRename = (thread: Conversation) => {
    setRenameThreadTarget(thread);
    setRenameThreadValue(thread.title);
  };

  const confirmThreadRename = async () => {
    const target = renameThreadTarget;
    const title = renameThreadValue.trim();
    if (!target || !title) return;
    setRenameThreadBusy(true);
    try {
      await useChatStore.getState().renameConversation(target.id, title);
      setRenameThreadTarget(null);
    } catch (error) {
      toast.error(t('sidebar.renameThreadError'), { description: String(error) });
    } finally {
      setRenameThreadBusy(false);
    }
  };

  const exportThread = async (thread: Conversation) => {
    try {
      const path = await api.exportConversation(thread.id, 'markdown');
      if (path) toast.success(t('sidebar.threadExported'), { description: path });
    } catch (error) {
      toast.error(t('sidebar.exportThreadError'), { description: String(error) });
    }
  };

  const confirmThreadDelete = async () => {
    const target = deleteThreadTarget;
    if (!target) return;
    setDeleteThreadBusy(true);
    try {
      await useChatStore.getState().deleteConversation(target.id);
      setDeleteThreadTarget(null);
    } finally {
      setDeleteThreadBusy(false);
    }
  };

  const duplicateAgent = async (agent: Agent) => {
    try {
      const copy = await api.duplicateAgent(agent.id);
      await refresh();
      await useChatStore.getState().refreshConversations();
      setActiveAgentId(copy.id);
      clearActiveConversation();
      toast.success(t('sidebar.agentDuplicated'), { description: copy.name });
    } catch (error) {
      toast.error(t('sidebar.duplicateError'), { description: String(error) });
    }
  };

  const exportAgent = async (agent: Agent) => {
    try {
      const path = await api.exportAgent(agent.id);
      if (path) toast.success(t('sidebar.agentExported'), { description: path });
    } catch (error) {
      toast.error(t('sidebar.exportAgentError'), { description: String(error) });
    }
  };

  const togglePinned = async (agent: Agent) => {
    try {
      await pin(agent.id, !agent.pinned);
    } catch (error) {
      toast.error(t('sidebar.pinError'), { description: String(error) });
    }
  };

  const archiveAgent = async (agent: Agent) => {
    try {
      await archive(agent.id);
      if (activeAgentId === agent.id) clearActiveConversation();
      toast.success(t('sidebar.agentArchived'), {
        description: agent.name,
        action: {
          label: t('sidebar.undo'),
          onClick: () => void restore(agent.id),
        },
      });
    } catch (error) {
      toast.error(t('sidebar.archiveError'), { description: String(error) });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      await useChatStore.getState().refreshConversations();
      if (activeAgentId === deleteTarget.id) {
        setActiveAgentId(null);
        clearActiveConversation();
      }
      toast.success(t('sidebar.agentDeleted'), { description: deleteTarget.name });
      setDeleteTarget(null);
    } catch (error) {
      toast.error(t('sidebar.deleteError'), { description: String(error) });
    }
  };

  const deleteThreads = deleteTarget
    ? conversations.filter(
        (conversation) =>
          conversation.agentId === deleteTarget.id &&
          !conversation.channelId &&
          !conversation.isMain,
      ).length
    : 0;

  return (
    <aside className={cn('flex h-full min-h-0 flex-col bg-surface', className)}>
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-foreground-subtle">
          {t('sidebar.header')}
        </span>
        <div className="flex items-center gap-1">
          {activeTurnCount > 0 ? (
            <button
              type="button"
              onClick={() => setActivityOpen(true)}
              aria-label={t('sidebar.activityAria', { count: activeTurnCount })}
              className="flex h-6 items-center gap-1 rounded-full bg-accent-soft px-2 text-[10px] font-medium text-accent hover:bg-accent-soft/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Activity className="size-3" />
              {activeTurnCount}
            </button>
          ) : null}
          <IconButton
            label={
              agentPanelOpen && agentRightPanel === 'agent'
                ? t('panelToggle.collapse')
                : t('panelToggle.open')
            }
            size="sm"
            variant="ghost"
            active={agentPanelOpen && agentRightPanel === 'agent'}
            onClick={() => {
              setAgentRightPanel('agent');
              setAgentPanelOpen(!(agentPanelOpen && agentRightPanel === 'agent'));
            }}
          >
            <PanelRight className="size-4" />
          </IconButton>
          <IconButton
            label={t('sidebar.taskBoard')}
            size="sm"
            variant="ghost"
            onClick={() => setTaskBoardOpen(true)}
          >
            <ListChecks className="size-4" />
          </IconButton>
          <IconButton
            label={t('sidebar.newAgent')}
            size="sm"
            variant="ghost"
            onClick={() => openEditor({ mode: 'create' })}
          >
            <Plus className="size-4" />
          </IconButton>
        </div>
      </div>

      <div className="px-3">
        <Button
          variant="secondary"
          size="sm"
          className="w-full justify-start"
          disabled={!activeAgentId}
          title={activeAgentId ? t('sidebar.newConversationTitle') : t('sidebar.selectAgentTitle')}
          onClick={() => {
            if (activeAgentId) {
              void startNewConversation('agent', { agentId: activeAgentId });
              onClose?.();
            }
          }}
        >
          <MessageSquarePlus className="mr-2 size-4" />
          {t('sidebar.newConversation')}
        </Button>
      </div>

      <div className="relative mt-3 px-3">
        <Search className="pointer-events-none absolute left-5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sidebar.searchPlaceholder')}
          aria-label={t('sidebar.searchAria')}
          className="h-8 pl-8 pr-8 text-[12px]"
        />
        {query ? (
          <button
            type="button"
            aria-label={t('sidebar.clearSearch')}
            onClick={() => setQuery('')}
            className="absolute right-4 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {status === 'loading' && agents.length === 0 ? (
          <div className="space-y-2 px-2 py-3" aria-label={t('sidebar.loadingAgents')}>
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="size-7 animate-pulse rounded-lg bg-surface-active" />
                <div className="h-3 flex-1 animate-pulse rounded bg-surface-active" />
              </div>
            ))}
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="px-2 py-3 text-[12px] text-foreground-muted">
            <p>{t('sidebar.loadError')}</p>
            {storeError ? (
              <p className="mt-1 line-clamp-2 text-[11px] text-foreground-subtle">{storeError}</p>
            ) : null}
            <Button size="sm" variant="ghost" className="mt-2 px-0" onClick={() => void refresh()}>
              {t('sidebar.retry')}
            </Button>
          </div>
        ) : null}
        <section className="mb-3">
          <div className="mb-1 flex items-center justify-between px-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
              {t('sidebar.channels')}
            </p>
            <button
              type="button"
              aria-label={t('sidebar.newChannel')}
              onClick={() => {
                setEditingChannel(null);
                setChannelDialogOpen(true);
              }}
              className="flex size-5 items-center justify-center rounded text-foreground-subtle hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
          {visibleChannels.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-foreground-subtle">
              {normalizedQuery ? t('sidebar.noChannelsFound') : t('sidebar.noChannels')}
            </p>
          ) : (
            <SortableList
              ids={visibleChannels.map((channel) => channel.id)}
              label={t('sidebar.channels')}
              itemLabel={(id) => {
                const channel = visibleChannels.find((item) => item.id === id);
                return channel ? channelLabel(channel) : id;
              }}
              disabled={normalizedQuery.length > 0}
              onReorder={handleReorderChannels}
            >
              {(sortable) => (
                <div ref={sortable.containerRef} className="space-y-0.5">
                  {visibleChannels.map((channel) => (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      members={channel.memberIds
                        .map((id) => agentsById[id])
                        .filter((member): member is Agent => Boolean(member))}
                      active={activeChannelId === channel.id}
                      label={channelLabel(channel)}
                      pending={inboxCounts[channel.id] ?? 0}
                      sortable={sortable}
                      onSelect={() => selectChannel(channel)}
                      onEdit={() => {
                        setEditingChannel(channel);
                        setChannelDialogOpen(true);
                      }}
                    />
                  ))}
                </div>
              )}
            </SortableList>
          )}
        </section>

        {status === 'ready' && agents.length === 0 ? (
          <div className="px-2 py-5 text-center">
            <p className="text-[12px] text-foreground-muted">{t('sidebar.noAgents')}</p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => openEditor({ mode: 'create' })}
            >
              <Plus className="mr-1 size-3.5" />
              {t('sidebar.createAgent')}
            </Button>
          </div>
        ) : null}
        {visiblePinned.length > 0 ? (
          <section className="mb-3">
            <p className="mb-1 flex items-center gap-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
              <Pin className="size-3" />
              {t('sidebar.pinned')}
            </p>
            <SortableList
              ids={visiblePinned.map((agent) => agent.id)}
              label={t('sidebar.pinned')}
              itemLabel={(id) => visiblePinned.find((agent) => agent.id === id)?.name ?? id}
              disabled={normalizedQuery.length > 0}
              onReorder={handleReorderAgents}
            >
              {(sortable) => (
                <div ref={sortable.containerRef} className="space-y-0.5">
                  {visiblePinned.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      active={activeAgentId === agent.id}
                      expanded={expanded.has(agent.id) || Boolean(normalizedQuery)}
                      threads={threadsFor(agent.id)}
                      activeThreadId={activeId}
                      sortable={sortable}
                      threadsDisabled={normalizedQuery.length > 0}
                      onReorderThreads={(ids) => handleReorderThreads(agent, ids)}
                      onSelect={() => selectAgent(agent)}
                      onToggle={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(agent.id)) next.delete(agent.id);
                          else next.add(agent.id);
                          return next;
                        })
                      }
                      onNewThread={() => newThread(agent)}
                      onEdit={() => openEditor({ mode: 'edit', agentId: agent.id })}
                      onAvatar={() => openAvatarEditor(agent.id)}
                      onRevise={() => setRevisionAgent(agent)}
                      onDuplicate={() => void duplicateAgent(agent)}
                      onExport={() => void exportAgent(agent)}
                      onPin={() => void togglePinned(agent)}
                      onArchive={() => void archiveAgent(agent)}
                      onDelete={() => setDeleteTarget(agent)}
                      onOpenThread={(threadId) => openThread(agent, threadId)}
                      onToggleThreadPin={toggleThreadPinned}
                      onStartThreadRename={startThreadRename}
                      onExportThread={(thread) => void exportThread(thread)}
                      onDeleteThread={setDeleteThreadTarget}
                      onStopThread={stopThread}
                      onShowAllThreads={() => setAllThreadsAgent(agent)}
                      onRoutines={() => openRoutines(agent.id)}
                      onTasks={() => setTasksAgent(agent)}
                    />
                  ))}
                </div>
              )}
            </SortableList>
          </section>
        ) : null}

        {visibleGroups.map((group) => (
          <section key={localizedDepartment(group.department)} className="mb-3">
            <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
              {localizedDepartment(group.department)}
            </p>
            <SortableList
              ids={group.agents.map((agent) => agent.id)}
              label={localizedDepartment(group.department)}
              itemLabel={(id) => group.agents.find((agent) => agent.id === id)?.name ?? id}
              disabled={normalizedQuery.length > 0}
              onReorder={handleReorderAgents}
            >
              {(sortable) => (
                <div ref={sortable.containerRef} className="space-y-0.5">
                  {group.agents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      active={activeAgentId === agent.id}
                      expanded={expanded.has(agent.id) || Boolean(normalizedQuery)}
                      threads={threadsFor(agent.id)}
                      activeThreadId={activeId}
                      sortable={sortable}
                      threadsDisabled={normalizedQuery.length > 0}
                      onReorderThreads={(ids) => handleReorderThreads(agent, ids)}
                      onSelect={() => selectAgent(agent)}
                      onToggle={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(agent.id)) next.delete(agent.id);
                          else next.add(agent.id);
                          return next;
                        })
                      }
                      onNewThread={() => newThread(agent)}
                      onEdit={() => openEditor({ mode: 'edit', agentId: agent.id })}
                      onAvatar={() => openAvatarEditor(agent.id)}
                      onRevise={() => setRevisionAgent(agent)}
                      onDuplicate={() => void duplicateAgent(agent)}
                      onExport={() => void exportAgent(agent)}
                      onPin={() => void togglePinned(agent)}
                      onArchive={() => void archiveAgent(agent)}
                      onDelete={() => setDeleteTarget(agent)}
                      onOpenThread={(threadId) => openThread(agent, threadId)}
                      onToggleThreadPin={toggleThreadPinned}
                      onStartThreadRename={startThreadRename}
                      onExportThread={(thread) => void exportThread(thread)}
                      onDeleteThread={setDeleteThreadTarget}
                      onStopThread={stopThread}
                      onShowAllThreads={() => setAllThreadsAgent(agent)}
                      onRoutines={() => openRoutines(agent.id)}
                      onTasks={() => setTasksAgent(agent)}
                    />
                  ))}
                </div>
              )}
            </SortableList>
          </section>
        ))}

        {normalizedQuery &&
        visiblePinned.length === 0 &&
        visibleGroups.length === 0 &&
        visibleChannels.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-foreground-subtle">
            {t('sidebar.noMatch', { query: query.trim() })}
          </p>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border px-3 py-2">
        <PluginSlot slot="agent.sidebar.footer" className="mb-1 px-1" compact />
        <Slot name="sidebar.nav.before" owner={{ layout: 'agent' }} />
        {agentNav.map((entry) => {
          const Icon = pluginIcon(entry.icon);
          const current =
            entry.source === 'plugin'
              ? pluginPages?.pluginId === entry.pluginId && pluginPages.pageId === entry.page
              : activeAgentId === null &&
                activeChannelId === null &&
                !pluginPages &&
                agentView === entry.page;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => {
                openNavTarget(entry);
                if (entry.source === 'host') {
                  setActiveAgentId(null);
                  setActiveChannelId(null);
                  clearActiveConversation();
                }
                onClose?.();
              }}
              aria-label={entry.ariaLabel ?? entry.title}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12px]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                current
                  ? 'bg-surface-active text-foreground'
                  : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {entry.title}
            </button>
          );
        })}
        <Slot name="sidebar.nav.after" owner={{ layout: 'agent' }} />
        <button
          type="button"
          onClick={() => openSettings()}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[12px] text-foreground-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Settings className="size-3.5" />
          {t('sidebar.settings')}
        </button>
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-4 pr-12">
            <DialogTitle>{t('sidebar.deleteAgentTitle')}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t('sidebar.deleteAgentDescription', { name: deleteTarget.name })
                : t('sidebar.deleteIrreversible')}
            </DialogDescription>
          </DialogHeader>
          {deleteThreads > 0 ? (
            <AgentDialogBody>
              <p className="rounded-lg bg-surface px-3 py-2 text-[12px] text-foreground-muted">
                {t('sidebar.deleteAgentBlocked', { count: deleteThreads })}
              </p>
            </AgentDialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="danger" disabled={deleteThreads > 0} onClick={() => void confirmDelete()}>
              <Trash2 className="mr-1.5 size-3.5" />
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={allThreadsAgent !== null}
        onOpenChange={(open) => !open && setAllThreadsAgent(null)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader className="pb-4 pr-12">
            <DialogTitle>{t('sidebar.allThreadsTitle', { name: allThreadsAgent?.name ?? t('agentFallback') })}</DialogTitle>
            <DialogDescription>
              {allThreadsAgent ? t('sidebar.threadCount', { count: threadsFor(allThreadsAgent.id).length }) : ''}
            </DialogDescription>
          </DialogHeader>
          <AgentDialogBody className="space-y-0.5">
            {allThreadsAgent && threadsFor(allThreadsAgent.id).length === 0 ? (
              <p className="py-6 text-center text-[12px] text-foreground-muted">
                {t('sidebar.noThreads')}
              </p>
            ) : null}
            {allThreadsAgent
              ? (
                  <SortableList
                    ids={threadsFor(allThreadsAgent.id).map((thread) => thread.id)}
                    label={t('sidebar.agentThreadsLabel', { name: allThreadsAgent.name })}
                    itemLabel={(id) =>
                      threadsFor(allThreadsAgent.id).find((thread) => thread.id === id)?.title ?? id
                    }
                    onReorder={(ids) => void useChatStore.getState().reorderConversations(ids)}
                  >
                    {(sortable) => (
                      <div ref={sortable.containerRef} className="space-y-0.5">
                        {threadsFor(allThreadsAgent.id).map((thread) => (
                          <ThreadRow
                            key={thread.id}
                            conversation={thread}
                            active={activeId === thread.id}
                            sortable={sortable}
                            onSelect={() => {
                              openThread(allThreadsAgent, thread.id);
                              setAllThreadsAgent(null);
                            }}
                            onTogglePin={() => toggleThreadPinned(thread)}
                            onStartRename={() => startThreadRename(thread)}
                            onExport={() => void exportThread(thread)}
                            onDelete={() => setDeleteThreadTarget(thread)}
                            onStop={() => stopThread(thread)}
                          />
                        ))}
                      </div>
                    )}
                  </SortableList>
                )
              : null}
          </AgentDialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                if (allThreadsAgent) newThread(allThreadsAgent);
                setAllThreadsAgent(null);
              }}
            >
              <MessageSquarePlus className="mr-1.5 size-4" />
              {t('sidebar.newConversation')}
            </Button>
            <Button variant="ghost" onClick={() => setAllThreadsAgent(null)}>
              {t('common:actions.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentRevisionDialog
        agent={revisionAgent}
        open={revisionAgent !== null}
        onOpenChange={(open) => !open && setRevisionAgent(null)}
      />

      <AgentTasksDialog
        agent={tasksAgent}
        open={tasksAgent !== null}
        onOpenChange={(open) => !open && setTasksAgent(null)}
      />

      <AgentActivityDialog open={activityOpen} onOpenChange={setActivityOpen} />
      <AgentTaskBoardDialog open={taskBoardOpen} onOpenChange={setTaskBoardOpen} />

      <AgentChannelDialog
        channel={editingChannel}
        open={channelDialogOpen}
        onOpenChange={(open) => {
          setChannelDialogOpen(open);
          if (!open) setEditingChannel(null);
        }}
        onSaved={(saved) => {
          setChannels((current) => {
            const exists = current.some((channel) => channel.id === saved.id);
            return exists
              ? current.map((channel) => (channel.id === saved.id ? saved : channel))
              : [...current, saved];
          });
          setActiveChannelId(saved.id);
          clearActiveConversation();
          window.dispatchEvent(new CustomEvent('zylara:channels-changed'));
        }}
        onDeleted={(deletedId) => {
          setChannels((current) => current.filter((channel) => channel.id !== deletedId));
          if (activeChannelId === deletedId) setActiveChannelId(null);
          window.dispatchEvent(new CustomEvent('zylara:channels-changed'));
        }}
      />

      <Dialog
        open={renameThreadTarget !== null}
        onOpenChange={(open) => !open && setRenameThreadTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-4 pr-12">
            <DialogTitle>{t('sidebar.renameTitle')}</DialogTitle>
            <DialogDescription>{t('sidebar.renameDescription')}</DialogDescription>
          </DialogHeader>
          <AgentDialogBody>
            <Input
              value={renameThreadValue}
              maxLength={120}
              aria-label={t('sidebar.threadTitleAria')}
              onChange={(event) => setRenameThreadValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirmThreadRename();
              }}
            />
          </AgentDialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameThreadTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={renameThreadBusy || !renameThreadValue.trim()}
              onClick={() => void confirmThreadRename()}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteThreadTarget !== null}
        onOpenChange={(open) => !open && setDeleteThreadTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-4 pr-12">
            <DialogTitle>{t('sidebar.deleteThreadTitle')}</DialogTitle>
            <DialogDescription>
              {deleteThreadTarget
                ? t('sidebar.deleteThreadDescription', { title: deleteThreadTarget.title })
                : t('sidebar.deleteIrreversible')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteThreadTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={deleteThreadBusy}
              onClick={() => void confirmThreadDelete()}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
