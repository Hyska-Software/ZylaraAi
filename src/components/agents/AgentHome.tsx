import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowUpRight, MessageSquarePlus, Pencil, Pin, Sparkles } from 'lucide-react';

import { AgentAvatar } from './AgentAvatar';
import { Slot } from '@/components/plugins/ui/Slot';
import { ComponentSlot } from '@/components/plugins/ui/Slot';
import type { PluginComponent } from '@/lib/plugins/ui/types';
import {
  formatUsageCost,
  formatUsageTokens,
  localizedDepartment,
  modelLabel,
  relativeTime,
} from './agentUtils';
import { ChatView } from '@/components/chat/ChatView';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { useAppStore, useChatStore, useUiStore } from '@/lib/store';
import type { Agent, AgentUsage, Conversation } from '@/lib/types';
import { compareConversationOrder } from '@/lib/utils';

type Translate = TFunction<'agents'>;

function permissionLabel(mode: string, t: Translate): string {
  switch (mode) {
    case 'read_only':
      return t('permissions.readOnly');
    case 'review':
      return t('permissions.review');
    case 'edit':
      return t('permissions.edit');
    case 'autonomous':
      return t('permissions.autonomous');
    default:
      return mode;
  }
}

function fillComposer(text: string) {
  window.dispatchEvent(new CustomEvent<string>('zylara:suggest', { detail: text }));
}

/** Billing snapshot of the persona; refreshed after edits and agent switches. */
function useAgentUsage(agentId: string, updatedAt: number): AgentUsage | null {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  useEffect(() => {
    let disposed = false;
    void api
      .getAgentUsage(agentId)
      .then((value) => {
        if (!disposed) setUsage(value);
      })
      .catch(() => {
        if (!disposed) setUsage(null);
      });
    return () => {
      disposed = true;
    };
  }, [agentId, updatedAt]);
  return usage;
}

export function AgentWelcome({
  agent,
  threads,
  onNewConversation,
  onEdit,
  onOpenThread,
  onOpenMain,
}: {
  agent: Agent;
  threads: Conversation[];
  onNewConversation: () => void;
  onEdit: () => void;
  onOpenThread: (id: string) => void;
  onOpenMain?: () => void;
}) {
  const { t } = useTranslation('agents');
  const providers = useAppStore((state) => state.providers);
  const usage = useAgentUsage(agent.id, agent.updatedAt);
  const openAvatarEditor = useUiStore((state) => state.openAgentAvatarEditor);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 pb-6 pt-10 text-center sm:pt-14">
      <button
        type="button"
        aria-label={t('home.customizeAvatarAria', { name: agent.name })}
        onClick={() => openAvatarEditor(agent.id)}
        className="group relative rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <AgentAvatar avatar={agent.avatar} size="lg" />
        <span
          aria-hidden
          className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-surface-hover text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Pencil className="size-3" />
        </span>
      </button>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">{agent.name}</h1>
      <p className="mt-1 text-[13px] text-foreground-muted">
        {agent.role}
        {agent.department
          ? ` · ${localizedDepartment(agent.department)}`
          : ''}
      </p>
      {agent.description ? (
        <p className="mt-4 max-w-lg text-[14px] leading-relaxed text-foreground-muted">
          {agent.description}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="rounded-full bg-surface-hover px-3 py-1 text-[11px] text-foreground-muted">
          {modelLabel(providers, agent.providerId, agent.modelId)}
        </span>
        {agent.workspaceId ? (
          <span className="rounded-full bg-accent-soft px-3 py-1 text-[11px] text-accent">
            {t('home.workspacePermission', {
              permission: permissionLabel(agent.permissionMode, t),
            })}
          </span>
        ) : null}
        {usage && usage.turns > 0 ? (
          <span className="rounded-full bg-surface-hover px-3 py-1 text-[11px] text-foreground-muted">
            {t('home.tokensCost', {
              tokens: formatUsageTokens(usage.totalTokens),
              cost: formatUsageCost(usage.cost),
            })}
          </span>
        ) : null}
        <Button size="sm" onClick={onNewConversation}>
          <MessageSquarePlus className="mr-1.5 size-4" />
          {t('home.newConversation')}
        </Button>
        {onOpenMain ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('home.openMainAria')}
            onClick={onOpenMain}
          >
            <Pin className="mr-1.5 size-3.5" />
            {t('threads.main')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil className="mr-1.5 size-3.5" />
          {t('home.editAgent')}
        </Button>
      </div>

      {agent.starters.length > 0 ? (
        <div className="mt-8 w-full">
          <p className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
            <Sparkles className="size-3.5" />
            {t('home.starters')}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {agent.starters.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => fillComposer(starter)}
                className="max-w-full rounded-full bg-surface-hover px-3 py-1.5 text-left text-[12px] text-foreground-muted transition-colors hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <span className="line-clamp-1">{starter}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {threads.length > 0 ? (
        <div className="mt-8 w-full text-left">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
            {t('home.recentThreads')}
          </p>
          <div className="overflow-hidden rounded-xl bg-surface-hover">
            {threads.slice(0, 4).map((thread) => (
              <button
                key={thread.id}
                type="button"
                onClick={() => onOpenThread(thread.id)}
                className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">{thread.title}</span>
                  {thread.preview ? (
                    <span className="mt-0.5 block truncate text-[11px] text-foreground-subtle">
                      {thread.preview}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[11px] text-foreground-subtle">
                  {relativeTime(thread.updatedAt)}
                </span>
                <ArrowUpRight className="size-3.5 shrink-0 text-foreground-subtle" />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Home surface: the same ChatView/composer, with the agent hero as welcome. */
export function AgentHome({ agent }: { agent: Agent }) {
  const conversations = useChatStore((state) => state.conversations);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const openConversation = useChatStore((state) => state.openConversation);
  const openEditor = useUiStore((state) => state.openAgentEditor);
  const threads = conversations
    .filter(
      (conversation) =>
        conversation.mode === 'agent' &&
        conversation.agentId === agent.id &&
        !conversation.channelId &&
        !conversation.taskId,
    )
    .sort(compareConversationOrder);
  const main = threads.find((thread) => thread.isMain) ?? null;
  const recentThreads = threads.filter((thread) => !thread.isMain);

  return (
    <Slot
      name="agent.thread.view.frame"
      owner={{ agentId: agent.id, conversationId: main?.id ?? null }}
    >
      <ComponentSlot
        name="agent.thread.view"
        fallback={ChatView as unknown as PluginComponent}
        props={{
          welcome: (
            <AgentWelcome
              agent={agent}
              threads={recentThreads}
              onNewConversation={() => void startNewConversation('agent', { agentId: agent.id })}
              onEdit={() => openEditor({ mode: 'edit', agentId: agent.id })}
              onOpenThread={(id) => void openConversation(id)}
              onOpenMain={main ? () => void openConversation(main.id) : undefined}
            />
          ),
          key: `agent-home-${agent.id}`,
        }}
      />
    </Slot>
  );
}
