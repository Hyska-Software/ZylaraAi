import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  CalendarClock,
  Database,
  Globe2,
  Monitor,
  Settings,
  type LucideIcon,
} from 'lucide-react';

import { AgentPanelBrowser } from './AgentPanelBrowser';
import { AgentPanelData } from './AgentPanelData';
import { AgentPanelRoutines } from './AgentPanelRoutines';
import { AgentPanelScreen } from './AgentPanelScreen';
import { AgentActivityDialog } from './AgentActivityDialog';
import { PanelResizer } from '@/components/layout/PanelResizer';
import { AnimatedSidePanel } from '@/components/layout/AnimatedSidePanel';
import { useChromeCornerReserve } from '@/components/layout/ChromeCorner';
import { DRAG_ROW_CLASS, useWindowDragProps } from '@/components/layout/windowChrome';
import { Slot } from '@/components/plugins/ui/Slot';
import { PluginDockTabHost } from '@/components/plugins/ui/PluginDockTabHost';
import { PluginDockTabStrip } from '@/components/plugins/ui/PluginDockTabStrip';
import { dockTabsForLayout, isRedundantDockTabAction } from '@/lib/plugins/ui/dock';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import {
  IconButton,
  SortableList,
  Tooltip,
  sortableDropClassHorizontal,
  type SortableListApi,
} from '@/components/ui';
import { api } from '@/lib/api';
import {
  SIDE_PANEL_WIDTH_DEFAULT,
  SIDE_PANEL_WIDTH_MIN,
  SIDE_PANEL_WIDTH_STEP,
  selectAgent,
  useAgentStore,
  useChatStore,
  useCodeStore,
  useUiStore,
  type AgentPanelTab,
} from '@/lib/store';
import { resolveSidePanelLayout, useViewportWidth } from '@/lib/sidePanel';
import type { Agent, AgentChannel, Conversation } from '@/lib/types';
import { cn, sortStableByOrder } from '@/lib/utils';
import { TASK_ATTENTION_STATUSES } from './agentTaskStatus';

interface AgentPanelTabDef {
  id: AgentPanelTab;
  labelKey: string;
  icon: LucideIcon;
}

const PANEL_TABS: ReadonlyArray<AgentPanelTabDef> = [
  { id: 'screen', labelKey: 'panel.tabs.screen', icon: Monitor },
  { id: 'routines', labelKey: 'panel.tabs.routines', icon: CalendarClock },
  { id: 'browser', labelKey: 'panel.tabs.browser', icon: Globe2 },
  { id: 'data', labelKey: 'panel.tabs.data', icon: Database },
];

export interface AgentPanelContext {
  agent: Agent;
  conversation: Conversation | null;
  openThread: (conversationId: string) => void;
  onEdit: () => void;
}

const PANEL_BODY_ID = 'agent-panel-body';

/**
 * Right sidebar of the Agentes layout. It is contextual to the selected
 * persona/thread and reuses the same responsive dock/resizer primitives as the
 * Code panel.
 */
export function AgentPanel() {
  const { t } = useTranslation('agents');
  const open = useUiStore((state) => state.agentPanelOpen);
  const tab = useUiStore((state) => state.agentPanelTab);
  const setTab = useUiStore((state) => state.setAgentPanelTab);
  const tabOrder = useUiStore((state) => state.agentPanelTabOrder);
  const setTabOrder = useUiStore((state) => state.setAgentPanelTabOrder);
  const pluginDock = useUiStore((state) => state.pluginDockTab.agent);
  const ui = usePluginUi();
  const disabledPluginUi = usePluginUiPrefs((state) => state.disabled);
  const pluginTabs = useMemo(
    () => dockTabsForLayout(ui.panelTabs, 'agent', disabledPluginUi),
    [disabledPluginUi, ui.panelTabs],
  );
  const setOpen = useUiStore((state) => state.setAgentPanelOpen);
  const openEditor = useUiStore((state) => state.openAgentEditor);
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const persistedWidth = useUiStore((state) => state.sidePanelWidth);
  const setSidePanelWidth = useUiStore((state) => state.setSidePanelWidth);
  const viewportWidth = useViewportWidth();
  const agent = useAgentStore((state) => selectAgent(state, activeAgentId));
  const activeId = useChatStore((state) => state.activeId);
  const conversations = useChatStore((state) => state.conversations);
  const openConversation = useChatStore((state) => state.openConversation);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityCount, setActivityCount] = useState(0);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const tabRefs = useRef(new Map<AgentPanelTab, HTMLButtonElement>());

  const conversation = activeId
    ? conversations.find((entry) => entry.id === activeId) ?? null
    : null;
  const channel = useMemo<AgentChannel | null>(
    () => (activeChannelId ? ({ id: activeChannelId, name: t('panel.channelFallbackName') } as AgentChannel) : null),
    [activeChannelId, t],
  );

  const loadActivityCount = useCallback(async () => {
    const agentConversationIds = new Set(
      conversations.filter((entry) => entry.mode === 'agent').map((entry) => entry.id),
    );
    const streams = Object.keys(useChatStore.getState().streamsByConversation).filter((id) =>
      agentConversationIds.has(id),
    ).length;
    let pending = 0;
    for (const [conversationId, session] of Object.entries(
      useCodeStore.getState().byConversation,
    )) {
      if (!agentConversationIds.has(conversationId)) continue;
      pending += session.approvals.length + session.questions.length;
    }
    let tasks = 0;
    try {
      const list = await api.listAgentTasks(activeAgentId ? { ownerAgentId: activeAgentId } : {});
      tasks = list.filter((task) => TASK_ATTENTION_STATUSES.includes(task.status)).length;
    } catch {
      tasks = 0;
    }
    setActivityCount(streams + pending + tasks);
  }, [activeAgentId, conversations]);

  useEffect(() => {
    if (!open) return;
    void loadActivityCount();
    const interval = window.setInterval(() => void loadActivityCount(), 15_000);
    const reload = () => void loadActivityCount();
    window.addEventListener('zylara:agent-task-updated', reload);
    window.addEventListener('zylara:agent-routine-run', reload);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('zylara:agent-task-updated', reload);
      window.removeEventListener('zylara:agent-routine-run', reload);
    };
  }, [open, loadActivityCount]);

  const layout = useMemo(
    () =>
      resolveSidePanelLayout({
        mode: 'docked',
        viewportWidth,
        sidebarOpen,
        sidebarWidth,
        width: persistedWidth,
        previewWidth,
      }),
    [viewportWidth, sidebarOpen, sidebarWidth, persistedWidth, previewWidth],
  );

  const overlay = !layout.canDock;
  const panelWidth = overlay
    ? Math.min(440, Math.max(320, viewportWidth - 24))
    : layout.width;

  useEffect(() => {
    if (!overlay || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, open, setOpen]);

  /* All hooks above run unconditionally; the animated wrapper decides whether
     the panel is mounted so close can play the same exit as the left sidebar. */

  const clampWidth = (next: number) =>
    Math.min(layout.maxWidth, Math.max(SIDE_PANEL_WIDTH_MIN, Math.round(next)));
  const handleResize = (next: number) => setPreviewWidth(clampWidth(next));
  const handleResizeEnd = (next: number) => {
    setSidePanelWidth(clampWidth(next));
    setPreviewWidth(null);
  };
  const handleReset = () => {
    setSidePanelWidth(SIDE_PANEL_WIDTH_DEFAULT);
    setPreviewWidth(null);
  };

  const visibleTabs: AgentPanelTabDef[] = channel
    ? [{ id: 'data', labelKey: 'panel.channelTab', icon: Database }]
    : sortStableByOrder(
        PANEL_TABS.map((entry) => entry.id),
        tabOrder,
      ).flatMap((id) => {
        const entry = PANEL_TABS.find((candidate) => candidate.id === id);
        return entry ? [entry] : [];
      });
  const activeTab = channel ? 'data' : tab;
  const compactTabs = layout.width < 430;

  const selectTab = (next: AgentPanelTab) => {
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: AgentPanelTab,
  ) => {
    const index = visibleTabs.findIndex((entry) => entry.id === current);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % visibleTabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = visibleTabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = visibleTabs[nextIndex];
    if (next) selectTab(next.id);
  };

  const context: AgentPanelContext | null = agent
    ? {
        agent,
        conversation:
          conversation?.mode === 'agent' && conversation.agentId === agent.id
            ? conversation
            : null,
        openThread: (conversationId) => void openConversation(conversationId),
        onEdit: () => openEditor({ mode: 'edit', agentId: agent.id }),
      }
    : null;

  const reserve = useChromeCornerReserve('dock');
  const drag = useWindowDragProps();

  return (
    <AnimatedSidePanel
      open={open && Boolean(agent || channel)}
      width={panelWidth}
      label={t('panel.aria')}
      overlay={overlay}
      resizing={previewWidth !== null}
      onDismiss={() => setOpen(false)}
    >
      <div
        {...drag}
        className={cn(
          'flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2',
          DRAG_ROW_CLASS,
          reserve,
        )}
      >
        <SortableList
          ids={visibleTabs.map((entry) => entry.id)}
          label={t('panel.tabsAria')}
          itemLabel={(id) =>
            t((visibleTabs.find((entry) => entry.id === id)?.labelKey ?? 'panel.tabs.screen') as never)
          }
          orientation="horizontal"
          disabled={visibleTabs.length < 2}
          onReorder={(ids) =>
            setTabOrder([...ids, ...tabOrder.filter((id) => !ids.includes(id))] as AgentPanelTab[])
          }
        >
          {(sortable: SortableListApi) => (
            <div
              role="tablist"
              aria-label={t('panel.tabsAria')}
              className="flex min-w-0 flex-1 items-center gap-0.5"
            >
              {visibleTabs.map((entry) => {
                const selected = activeTab === entry.id;
                const label = t(entry.labelKey as never);
                const Icon = entry.icon;
                const itemProps = sortable.itemProps(entry.id);
                return (
                  <div
                    key={entry.id}
                    role="presentation"
                    {...sortable.dropProps(entry.id)}
                    className={cn('shrink-0', sortableDropClassHorizontal)}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={`agent-panel-tab-${entry.id}`}
                      aria-selected={selected}
                      aria-controls={PANEL_BODY_ID}
                      tabIndex={selected ? 0 : -1}
                      {...itemProps}
                      ref={(node) => {
                        itemProps.ref(node);
                        if (node) tabRefs.current.set(entry.id, node);
                        else tabRefs.current.delete(entry.id);
                      }}
                      onClick={() => selectTab(entry.id)}
                      onKeyDown={(event) => {
                        itemProps.onKeyDown(event);
                        if (!event.defaultPrevented) handleTabKeyDown(event, entry.id);
                      }}
                      aria-label={label}
                      title={label}
                      className={cn(
                        'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
                        'transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        selected
                          ? 'bg-surface-active text-foreground'
                          : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                        compactTabs && 'px-2',
                        !sortable.disabled && 'cursor-grab active:cursor-grabbing',
                      )}
                    >
                      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
                      {compactTabs ? null : label}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </SortableList>
        <PluginDockTabStrip layout="agent" compact={compactTabs} />
        <Slot
          name="agent.panel.tabs"
          owner={{ layout: 'agent' }}
          filter={(entry) => !isRedundantDockTabAction(entry, pluginTabs)}
        />
        <Slot name="agent.panel.header" owner={{ layout: 'agent' }} />
        {agent ? (
          <Tooltip content={t('panel.editAgent')} side="bottom">
            <IconButton label={t('panel.editAgent')} size="sm" onClick={context?.onEdit}>
              <Settings aria-hidden className="size-3.5" />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip content={t('activityDialog.title')} side="bottom">
          <IconButton
            label={
              activityCount > 0
                ? t('panel.activityWithCount', { count: activityCount })
                : t('activityDialog.title')
            }
            size="sm"
            onClick={() => setActivityOpen(true)}
            className="relative"
          >
            <Activity aria-hidden className="size-3.5" />
            {activityCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-3.5 text-accent-foreground">
                {activityCount > 9 ? '9+' : activityCount}
              </span>
            ) : null}
          </IconButton>
        </Tooltip>
      </div>

      <div
        role="tabpanel"
        id={PANEL_BODY_ID}
        aria-labelledby={`agent-panel-tab-${activeTab}`}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {pluginDock ? (
          <PluginDockTabHost layout="agent" tabKey={pluginDock} />
        ) : channel ? (
          <div className="flex flex-col gap-2 p-3 text-[12px] text-foreground-muted">
            <p className="font-medium text-foreground">{t('panel.sharedChannel')}</p>
            <p>
              {t('panel.sharedChannelHint')}
            </p>
          </div>
        ) : activeTab === 'screen' && context ? (
          <AgentPanelScreen context={context} />
        ) : activeTab === 'routines' && context ? (
          <AgentPanelRoutines context={context} />
        ) : activeTab === 'browser' && context ? (
          <AgentPanelBrowser context={context} />
        ) : activeTab === 'data' && context ? (
          <AgentPanelData context={context} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-[12px] text-foreground-muted">
            {t('panel.selectAgent')}
          </div>
        )}
      </div>

      {!overlay ? (
        <PanelResizer
          side="end"
          value={layout.width}
          min={SIDE_PANEL_WIDTH_MIN}
          max={layout.maxWidth}
          step={SIDE_PANEL_WIDTH_STEP}
          label={t('panel.resizeAria')}
          className="absolute inset-y-0 -left-2 z-10"
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
          onReset={handleReset}
        />
      ) : null}
      <AgentActivityDialog open={activityOpen} onOpenChange={setActivityOpen} />
    </AnimatedSidePanel>
  );
}
