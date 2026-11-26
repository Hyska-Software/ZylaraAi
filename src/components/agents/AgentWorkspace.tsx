import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArchiveRestore, ArrowLeft, MessagesSquare } from 'lucide-react';

import { AgentChannelDialog } from './AgentChannelDialog';
import { AgentChannelView } from './AgentChannelView';
import { AgentEditorDialog } from './AgentEditorDialog';
import { AgentHome, AgentWelcome } from './AgentHome';
import { AgentPanelOpener } from './AgentPanelToggle';
import { AgentRoutinesView } from './AgentRoutinesView';
import { AgentStatsView } from './AgentStatsView';
import { AgentThreadHeader } from './AgentThreadHeader';
import { TeamView } from './TeamView';
import { ChatView } from '@/components/chat/ChatView';
import {
  CodeCommitHistoryView,
  CodeDiffView,
  CodeFileView,
  CodePlanView,
} from '@/components/code';
import { GoalPanel } from '@/components/code/GoalPanel';
import { Button, IconButton } from '@/components/ui';
import { isExperimentalFeatureEnabled } from '@/lib/experiments';
import {
  selectAgent,
  useAgentStore,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import type { Agent, AgentChannel } from '@/lib/types';

function ArchivedAgentHome({ agent }: { agent: Agent }) {
  const { t } = useTranslation('agents');
  const restore = useAgentStore((state) => state.restore);
  const conversations = useChatStore((state) => state.conversations);
  const threads = conversations.filter(
    (conversation) =>
      conversation.mode === 'agent' &&
      conversation.agentId === agent.id &&
      !conversation.channelId,
  );
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-surface-hover text-foreground-muted">
          <MessagesSquare className="size-6" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">{agent.name}</h1>
        <p className="mt-1 text-[13px] text-foreground-muted">
          {t('workspaceView.archivedRole', { role: agent.role })}
        </p>
        <p className="mt-4 text-[13px] leading-relaxed text-foreground-muted">
          {t('workspaceView.archivedDescription', { count: threads.length })}
        </p>
        <Button className="mt-6" onClick={() => void restore(agent.id)}>
          <ArchiveRestore className="mr-1.5 size-4" />
          {t('workspaceView.restoreAgent')}
        </Button>
      </div>
    </div>
  );
}

/** Central Code views opened from the agent workspace panel (diff/file/plan/
 * commits/goal). The conversation itself stays mounted underneath so returning
 * never loses the draft or scroll position. */
function AgentCodeView({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('agents');
  const codeView = useUiStore((state) => state.codeView);
  const setCodeView = useUiStore((state) => state.setCodeView);
  const diffTab = useUiStore((state) => state.codeDiffTab);
  const fileTab = useUiStore((state) => state.codeFileTab);
  const planTab = useUiStore((state) => state.codePlanTab);
  const commitsTab = useUiStore((state) => state.codeCommitsTab);
  const selectCommit = useUiStore((state) => state.selectCodeCommit);

  if (codeView === 'diff' && diffTab) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentCodeViewHeader title={t('workspaceView.changes')} onBack={() => setCodeView('session')} />
        <CodeDiffView target={diffTab} className="min-h-0 flex-1" />
      </div>
    );
  }
  if (codeView === 'file' && fileTab) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentCodeViewHeader title={fileTab.path} onBack={() => setCodeView('session')} />
        <CodeFileView target={fileTab} className="min-h-0 flex-1" />
      </div>
    );
  }
  if (codeView === 'plan' && planTab) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentCodeViewHeader title={t('workspaceView.plan')} onBack={() => setCodeView('session')} />
        <CodePlanView tab={planTab} className="min-h-0 flex-1" />
      </div>
    );
  }
  if (codeView === 'commits' && commitsTab) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentCodeViewHeader title={t('workspaceView.history')} onBack={() => setCodeView('session')} />
        <CodeCommitHistoryView
          target={commitsTab}
          onSelect={(revision) => selectCommit(revision)}
          className="min-h-0 flex-1"
        />
      </div>
    );
  }
  if (codeView === 'goal') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentCodeViewHeader title={t('workspaceView.goal')} onBack={() => setCodeView('session')} />
        <GoalPanel conversationId={conversationId} className="min-h-0 flex-1" />
      </div>
    );
  }
  return null;
}

function AgentCodeViewHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useTranslation('agents');
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
      <IconButton label={t('workspaceView.backToConversation')} size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeft className="size-4" />
      </IconButton>
      <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground-muted">
        {title}
      </p>
    </header>
  );
}

export function AgentWorkspace() {
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const agentView = useUiStore((state) => state.agentView);
  const setActiveChannelId = useUiStore((state) => state.setActiveChannelId);
  const channelsEnabled = useAppStore((state) =>
    isExperimentalFeatureEnabled(state.settings, 'agentChannels'),
  );
  const [editingChannel, setEditingChannel] = useState<AgentChannel | null>(null);
  const [channelRevision, setChannelRevision] = useState(0);
  const agent = useAgentStore((state) => selectAgent(state, activeAgentId));
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const clearActiveConversation = useChatStore((state) => state.clearActiveConversation);
  const openConversation = useChatStore((state) => state.openConversation);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const streaming = useChatStore((state) => state.streaming);
  const processQueue = useChatStore((state) => state.processQueue);
  const openEditor = useUiStore((state) => state.openAgentEditor);
  const codeView = useUiStore((state) => state.codeView);
  const codeDiffTab = useUiStore((state) => state.codeDiffTab);
  const codeFileTab = useUiStore((state) => state.codeFileTab);
  const codePlanTab = useUiStore((state) => state.codePlanTab);
  const codeCommitsTab = useUiStore((state) => state.codeCommitsTab);
  const activeConversation = activeId
    ? conversations.find((conversation) => conversation.id === activeId)
    : undefined;
  const isThread =
    Boolean(agent) &&
    activeConversation?.mode === 'agent' &&
    !activeConversation.channelId &&
    activeConversation.agentId === agent?.id;
  const showCodeCenter =
    Boolean(activeConversation?.workspaceId) &&
    ((codeView === 'diff' && codeDiffTab !== null) ||
      (codeView === 'file' && codeFileTab !== null) ||
      (codeView === 'plan' && codePlanTab !== null) ||
      (codeView === 'commits' && codeCommitsTab !== null) ||
      codeView === 'goal');

  // A layout switch can leave the Chat/Code active id around for one paint. It
  // must never leak into the Agentes composer as an invisible send target.
  useEffect(() => {
    if (agent && activeId && !isThread) clearActiveConversation();
  }, [agent, activeId, isThread, clearActiveConversation]);

  // Disabling the experimental channel surface leaves any open channel view.
  useEffect(() => {
    if (!channelsEnabled && activeChannelId) setActiveChannelId(null);
  }, [channelsEnabled, activeChannelId, setActiveChannelId]);

  // A queue that survived a layout switch drains when the thread is opened
  // again, as long as no other turn is running.
  useEffect(() => {
    if (streaming) return;
    if (!activeId || activeConversation?.mode !== 'agent') return;
    void processQueue(activeId);
  }, [activeConversation?.mode, activeId, processQueue, streaming]);

  if (channelsEnabled && activeChannelId) {
    return (
      <>
        <AgentChannelView
          key={`${activeChannelId}-${channelRevision}`}
          channelId={activeChannelId}
          onBack={() => setActiveChannelId(null)}
          onEdit={(channel) => setEditingChannel(channel)}
        />
        <AgentChannelDialog
          channel={editingChannel}
          open={editingChannel !== null}
          onOpenChange={(open) => !open && setEditingChannel(null)}
          onSaved={() => {
            setEditingChannel(null);
            setChannelRevision((current) => current + 1);
            window.dispatchEvent(new CustomEvent('zylara:channels-changed'));
          }}
          onDeleted={() => {
            setEditingChannel(null);
            setActiveChannelId(null);
            window.dispatchEvent(new CustomEvent('zylara:channels-changed'));
          }}
        />
        <AgentEditorDialog />
      </>
    );
  }

  if (!agent) {
    return (
      <>
        {agentView === 'stats' ? (
          <AgentStatsView />
        ) : agentView === 'routines' ? (
          <AgentRoutinesView />
        ) : (
          <TeamView />
        )}
        <AgentEditorDialog />
      </>
    );
  }
  if (agent.archivedAt !== null) {
    return (
      <div className="relative h-full min-h-0">
        <ArchivedAgentHome agent={agent} />
        <AgentPanelOpener />
        <AgentEditorDialog />
      </div>
    );
  }

  const threads = conversations
    .filter((conversation) => conversation.mode === 'agent' && conversation.agentId === agent.id)
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt,
    );
  if (isThread && activeConversation && showCodeCenter) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentThreadHeader
          agent={agent}
          conversation={activeConversation}
          onBack={clearActiveConversation}
        />
        <div className="min-h-0 flex-1">
          <AgentCodeView conversationId={activeConversation.id} />
        </div>
        <AgentEditorDialog />
      </div>
    );
  }

  if (isThread && activeConversation) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <AgentThreadHeader
          agent={agent}
          conversation={activeConversation}
          onBack={clearActiveConversation}
        />
        <div className="min-h-0 flex-1">
          <ChatView
            key={activeConversation.id}
            welcome={
              <AgentWelcome
                agent={agent}
                threads={[]}
                onNewConversation={() =>
                  void startNewConversation('agent', { agentId: agent.id })
                }
                onEdit={() => openEditor({ mode: 'edit', agentId: agent.id })}
                onOpenThread={(id) => void openConversation(id)}
              />
            }
          />
        </div>
        <AgentEditorDialog />
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <AgentHome agent={agent} />
      <AgentPanelOpener />
      <AgentEditorDialog />
    </div>
  );
}
