import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FolderKanban, Loader2, PanelRight, Pencil } from 'lucide-react';

import { AgentAvatar } from './AgentAvatar';
import { AgentActivityDots } from './AgentActivityDots';
import { AgentComputerControl } from './AgentComputerControl';
import { AgentConversationWorkspace } from './AgentConversationWorkspace';
import { TASK_TERMINAL_STATUSES, taskStatusMeta } from './agentTaskStatus';
import { modelLabel } from './agentUtils';
import { CodeContextMeterChip } from '@/components/code/CodeAgentWidgets';
import { Slot } from '@/components/plugins/ui/Slot';
import { Button, IconButton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAppStore, useChatStore, useUiStore } from '@/lib/store';
import type {
  Agent,
  AgentTaskStatus,
  AgentTaskUpdatedEvent,
  Conversation,
} from '@/lib/types';
import { cn } from '@/lib/utils';

export function AgentThreadHeader({
  agent,
  conversation,
  onBack,
}: {
  agent: Agent;
  conversation: Conversation;
  onBack: () => void;
}) {
  const { t } = useTranslation('agents');
  const providers = useAppStore((state) => state.providers);
  const turnActive = useChatStore((state) => Boolean(state.streamsByConversation[conversation.id]));
  const [taskStatus, setTaskStatus] = useState<AgentTaskStatus | null>(null);
  const taskId = conversation.taskId;

  useEffect(() => {
    if (!taskId) {
      setTaskStatus(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void api
        .getAgentTask(taskId)
        .then((detail) => {
          if (!cancelled) setTaskStatus(detail.task.status);
        })
        .catch(() => {
          /* status is best-effort */
        });
    };
    load();
    const onTaskUpdated = (event: Event) => {
      const detail = (event as CustomEvent<AgentTaskUpdatedEvent>).detail;
      if (detail?.taskId === taskId) setTaskStatus(detail.status as AgentTaskStatus);
    };
    window.addEventListener('zylara:agent-task-updated', onTaskUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('zylara:agent-task-updated', onTaskUpdated);
    };
  }, [taskId]);

  const taskMeta = taskStatus ? taskStatusMeta(taskStatus) : null;
  const taskActive = taskStatus ? !TASK_TERMINAL_STATUSES.includes(taskStatus) : false;
  const openEditor = useUiStore((state) => state.openAgentEditor);
  const panelOpen = useUiStore((state) => state.agentPanelOpen);
  const setPanelOpen = useUiStore((state) => state.setAgentPanelOpen);
  const rightPanel = useUiStore((state) => state.agentRightPanel);
  const setRightPanel = useUiStore((state) => state.setAgentRightPanel);
  const codePanelOpen = useUiStore((state) => state.codePanelOpen);
  const setCodePanelOpen = useUiStore((state) => state.setCodePanelOpen);
  const agentPanelActive = panelOpen && rightPanel === 'agent';
  const workspacePanelActive = codePanelOpen && rightPanel === 'workspace';
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
      <IconButton label={t('threadHeader.back')} size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeft className="size-4" />
      </IconButton>
      <AgentAvatar
        avatar={agent.avatar}
        size="sm"
        activity={turnActive || taskActive ? 'running' : 'idle'}
      />
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">{agent.name}</span>
          {!taskId && turnActive ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-medium text-accent">
              <AgentActivityDots label={t('threadHeader.running')} />
              <span aria-hidden>{t('threadHeader.running')}</span>
            </span>
          ) : null}
          {taskMeta ? (
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-hover px-1.5 py-0.5 text-[9px] font-medium',
                taskMeta.tone,
              )}
            >
              {taskActive ? <Loader2 aria-hidden className="size-3 animate-spin" /> : null}
              {t(taskMeta.labelKey as never)}
            </span>
          ) : null}
        </span>
        <p className="truncate text-[11px] text-foreground-muted">
          {conversation.title} · {modelLabel(providers, conversation.providerId, conversation.modelId)}
        </p>
      </div>
      <AgentComputerControl conversationId={conversation.id} />
      <Slot
        name="agent.header.actions"
        owner={{ agentId: agent.id, conversationId: conversation.id }}
      />
      <AgentConversationWorkspace conversation={conversation} busy={turnActive} onChanged={(updated) => {
        useChatStore.setState((state) => ({
          conversations: state.conversations.map((item) => item.id === updated.id ? updated : item),
        }));
      }} />
      {conversation.workspaceId ? (
        <CodeContextMeterChip conversationId={conversation.id} showCache={false} />
      ) : null}
      <IconButton
        label={agentPanelActive ? t('panelToggle.collapse') : t('panelToggle.open')}
        size="sm"
        variant="ghost"
        active={agentPanelActive}
        onClick={() => {
          setRightPanel('agent');
          setPanelOpen(!agentPanelActive);
          if (!agentPanelActive) setCodePanelOpen(false);
        }}
      >
        <PanelRight className="size-4" />
      </IconButton>
      {conversation.workspaceId ? (
        <IconButton
          label={
            workspacePanelActive
              ? t('threadHeader.collapseWorkspace')
              : t('threadHeader.openWorkspace')
          }
          size="sm"
          variant="ghost"
          active={workspacePanelActive}
          onClick={() => {
            setRightPanel('workspace');
            setCodePanelOpen(!workspacePanelActive);
            if (!workspacePanelActive) setPanelOpen(false);
          }}
        >
          <FolderKanban className="size-4" />
        </IconButton>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openEditor({ mode: 'edit', agentId: agent.id })}
      >
        <Pencil className="mr-1.5 size-3.5" />
        {t('threadHeader.editAgent')}
      </Button>
    </header>
  );
}
