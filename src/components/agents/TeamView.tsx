import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ArchiveRestore, BarChart3, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { AgentAvatar } from './AgentAvatar';
import { AgentBuilderDialog } from './AgentBuilderDialog';
import { AgentDialogBody } from './AgentDialogBody';
import { AgentTemplatesDialog } from './AgentTemplatesDialog';
import { formatUsageCost, formatUsageTokens, modelLabel, relativeTime } from './agentUtils';
import {
  AGENT_TEMPLATES,
  localizedAgentTemplate,
  templateCapabilities,
  type AgentTemplate,
} from '@/lib/agentTemplates';
import { api } from '@/lib/api';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
} from '@/components/ui';
import {
  selectActiveAgents,
  selectArchivedAgents,
  useAgentStore,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import type { Agent, AgentUsage } from '@/lib/types';

function AgentCard({
  agent,
  usage,
  onOpen,
  onTalk,
  onEdit,
  onArchive,
}: {
  agent: Agent;
  usage?: AgentUsage;
  onOpen: () => void;
  onTalk: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const { t } = useTranslation('agents');
  const providers = useAppStore((state) => state.providers);
  return (
    <article className="group flex min-h-44 flex-col rounded-2xl bg-surface-hover p-4 transition-colors hover:bg-surface-active">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('team.openAgentAria', { name: agent.name })}
        className="flex min-w-0 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <AgentAvatar avatar={agent.avatar} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold tracking-tight text-foreground">
            {agent.name}
          </span>
          <span className="block truncate text-[12px] text-foreground-muted">{agent.role}</span>
        </span>
      </button>
      <p className="mt-3 line-clamp-2 min-h-10 text-[13px] leading-relaxed text-foreground-muted">
        {agent.description || t('team.noDescription')}
      </p>
      <p className="mt-3 truncate text-[11px] text-foreground-subtle">
        {modelLabel(providers, agent.providerId, agent.modelId)}
      </p>
      <p className="mt-1 truncate text-[11px] text-foreground-subtle">
        {t('team.threads', { count: agent.threadCount })}
        {agent.lastActiveAt
          ? ` · ${relativeTime(agent.lastActiveAt)}`
          : ` · ${t('team.noActivity')}`}
      </p>
      {usage && usage.turns > 0 ? (
        <p className="mt-1 truncate text-[11px] text-foreground-subtle">
          {t('home.tokensCost', {
            tokens: formatUsageTokens(usage.totalTokens),
            cost: formatUsageCost(usage.cost),
          })}
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-2 pt-4">
        <Button size="sm" onClick={onTalk}>
          {t('team.talk')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          {t('common:actions.edit')}
        </Button>
        <IconButton
          size="sm"
          label={t('team.archiveAria', { name: agent.name })}
          title={t('team.archive')}
          className="ml-auto"
          onClick={onArchive}
        >
          <Archive className="size-4" />
        </IconButton>
      </div>
    </article>
  );
}

export function TeamView() {
  const { t } = useTranslation('agents');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [usageById, setUsageById] = useState<Record<string, AgentUsage>>({});
  const agents = useAgentStore(useShallow(selectActiveAgents));
  const archived = useAgentStore(useShallow(selectArchivedAgents));
  const createAgent = useAgentStore((state) => state.create);
  const archive = useAgentStore((state) => state.archive);
  const restore = useAgentStore((state) => state.restore);
  const remove = useAgentStore((state) => state.remove);
  const refresh = useAgentStore((state) => state.refresh);
  const openEditor = useUiStore((state) => state.openAgentEditor);
  const setActiveAgentId = useUiStore((state) => state.setActiveAgentId);
  const setAgentView = useUiStore((state) => state.setAgentView);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const clearActiveConversation = useChatStore((state) => state.clearActiveConversation);
  const conversations = useChatStore((state) => state.conversations);

  const agentIds = agents.map((agent) => agent.id).join('|');
  useEffect(() => {
    if (!agentIds) {
      setUsageById({});
      return;
    }
    let disposed = false;
    void api
      .listAgentUsage()
      .then((rows) => {
        if (disposed) return;
        setUsageById(
          Object.fromEntries(rows.map((usage) => [usage.agentId, usage] as const)),
        );
      })
      .catch(() => {
        if (!disposed) setUsageById({});
      });
    return () => {
      disposed = true;
    };
  }, [agentIds]);

  const openAgent = (agent: Agent) => {
    setActiveAgentId(agent.id);
    clearActiveConversation();
  };

  const talk = async (agent: Agent) => {
    setActiveAgentId(agent.id);
    await startNewConversation('agent', { agentId: agent.id });
  };

  const createFromTemplate = async (template: AgentTemplate) => {
    const providers = useAppStore.getState().providers;
    const selection = useAppStore.getState().selection;
    const provider = providers.find((entry) => entry.id === selection.providerId) ?? providers[0];
    if (!provider) {
      toast.error(t('team.noProvider'));
      return;
    }
    const localized = localizedAgentTemplate(template);
    try {
      const agent = await createAgent({
        name: localized.name,
        role: localized.role,
        description: localized.description,
        avatar: template.avatar,
        department: localized.department,
        providerId: provider.id,
        modelId: provider.defaultModelId,
        reasoning: null,
        instructions: localized.instructions,
        starters: localized.starters,
        capabilities: templateCapabilities(template),
        memoryEnabled: template.memoryEnabled ?? false,
        workspaceId: null,
        permissionMode: template.permissionMode ?? 'autonomous',
      });
      await useChatStore.getState().refreshConversations();
      setActiveAgentId(agent.id);
      clearActiveConversation();
      setTemplatesOpen(false);
      toast.success(t('team.createdFromTemplate'), { description: agent.name });
    } catch (error) {
      toast.error(t('team.createError'), { description: String(error) });
    }
  };

  const archiveAgent = async (agent: Agent) => {
    try {
      await archive(agent.id);
      toast.success(t('team.archived'), {
        description: agent.name,
        action: {
          label: t('team.undo'),
          onClick: () => void restore(agent.id),
        },
      });
    } catch (error) {
      toast.error(t('team.archiveError'), { description: String(error) });
    }
  };

  const restoreAgent = async (agent: Agent) => {
    try {
      await restore(agent.id);
      toast.success(t('team.restored'), { description: agent.name });
    } catch (error) {
      toast.error(t('team.restoreError'), { description: String(error) });
    }
  };

  const importAgent = async () => {
    try {
      const imported = await api.importAgent();
      if (!imported) return;
      await refresh();
      await useChatStore.getState().refreshConversations();
      setActiveAgentId(imported.id);
      clearActiveConversation();
      toast.success(t('team.imported'), { description: imported.name });
    } catch (error) {
      toast.error(t('team.importError'), { description: String(error) });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget.id);
      await useChatStore.getState().refreshConversations();
      toast.success(t('team.deleted'), { description: deleteTarget.name });
      setDeleteTarget(null);
    } catch (error) {
      toast.error(t('team.deleteError'), { description: String(error) });
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
  // Active agents keep the guard so their history is archived first; an
  // archived agent is already inactive, so permanent deletion removes every
  // conversation with it (the backend does the same).
  const deleteBlocked =
    deleteTarget !== null && deleteTarget.archivedAt === null && deleteThreads > 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {agents.length === 0 ? (
        <div className="flex min-h-[70vh] items-center justify-center px-6 py-10">
          <div className="w-full max-w-2xl text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-surface-hover text-accent">
              <Sparkles className="size-6" />
            </div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">{t('team.emptyTitle')}</h1>
            <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-foreground-muted">
              {t('team.emptyDescription')}
            </p>
            <div className="mt-6 grid gap-3 text-left sm:grid-cols-3">
              {AGENT_TEMPLATES.slice(0, 3).map((template) => {
                const localized = localizedAgentTemplate(template);
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => void createFromTemplate(template)}
                    className="rounded-xl bg-surface-hover p-4 text-left transition-colors hover:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <AgentAvatar avatar={template.avatar} size="md" />
                    <span className="mt-2 block text-[13px] font-medium">{localized.name}</span>
                    <span className="mt-1 block text-[12px] leading-relaxed text-foreground-muted">
                      {localized.description}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Button onClick={() => openEditor({ mode: 'create' })}>
                <Plus className="mr-1.5 size-4" />
                {t('team.createFirst')}
              </Button>
              <Button variant="secondary" onClick={() => setBuilderOpen(true)}>
                <Sparkles className="mr-1.5 size-4" />
                {t('team.createWithAi')}
              </Button>
              <Button variant="ghost" onClick={() => setTemplatesOpen(true)}>
                {t('team.seeTemplates')}
              </Button>
              <Button variant="ghost" onClick={() => setAgentView('stats')}>
                <BarChart3 className="mr-1.5 size-4" />
                {t('team.stats')}
              </Button>
              <Button variant="ghost" onClick={() => void importAgent()}>
                <Upload className="mr-1.5 size-4" />
                {t('team.import')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-5xl px-6 py-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t('team.title')}</h1>
              <p className="mt-1 text-[13px] text-foreground-muted">
                {t('team.subtitle')}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAgentView('stats')}>
                <BarChart3 className="mr-1.5 size-4" />
                {t('team.stats')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void importAgent()}>
                <Upload className="mr-1.5 size-4" />
                {t('team.import')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setTemplatesOpen(true)}>
                {t('team.templates')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setBuilderOpen(true)}>
                <Sparkles className="mr-1.5 size-4" />
                {t('team.createWithAi')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => openEditor({ mode: 'create' })}>
                <Plus className="mr-1.5 size-4" />
                {t('team.createAgent')}
              </Button>
            </div>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                usage={usageById[agent.id]}
                onOpen={() => openAgent(agent)}
                onTalk={() => void talk(agent)}
                onEdit={() => {
                  setActiveAgentId(agent.id);
                  openEditor({ mode: 'edit', agentId: agent.id });
                }}
                onArchive={() => void archiveAgent(agent)}
              />
            ))}
          </div>
        </div>
      )}

      {archived.length > 0 ? (
        <section className="mx-auto w-full max-w-5xl px-6 pb-10">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold tracking-tight">{t('team.archivedTitle')}</h2>
              <p className="mt-1 text-[12px] text-foreground-muted">
                {t('team.archivedDescription')}
              </p>
            </div>
            <span className="text-[11px] text-foreground-subtle">
              {t('team.archivedCount', { count: archived.length })}
            </span>
          </div>
          <div className="mt-4 space-y-2">
            {archived.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-3 rounded-xl bg-surface p-3"
              >
                <AgentAvatar avatar={agent.avatar} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{agent.name}</p>
                  <p className="truncate text-[11px] text-foreground-muted">
                    {agent.role} · {t('team.threads', { count: agent.threadCount })}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void restoreAgent(agent)}>
                  <ArchiveRestore className="mr-1.5 size-3.5" />
                  {t('team.restore')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(agent)}>
                  <Trash2 className="mr-1.5 size-3.5" />
                  {t('common:actions.delete')}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <AgentBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} />
      <AgentTemplatesDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        onPick={createFromTemplate}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader className="pb-4 pr-12">
            <DialogTitle>{t('team.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? deleteTarget.archivedAt !== null && deleteThreads > 0
                  ? t('team.deleteDescriptionWithThreads', {
                      name: deleteTarget.name,
                      count: deleteThreads,
                    })
                  : t('team.deleteDescription', { name: deleteTarget.name })
                : t('team.deleteIrreversible')}
            </DialogDescription>
          </DialogHeader>
          {deleteBlocked ? (
            <AgentDialogBody>
              <p className="rounded-lg bg-surface px-3 py-2 text-[12px] text-foreground-muted">
                {t('team.deleteBlocked', { name: deleteTarget?.name, count: deleteThreads })}
              </p>
            </AgentDialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={deleteBlocked}
              onClick={() => void confirmDelete()}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
