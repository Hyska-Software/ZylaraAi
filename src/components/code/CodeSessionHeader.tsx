import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  CircleDot,
  Copy,
  ExternalLink,
  FileDiff,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  History,
  PanelRight,
  Plus,
  RefreshCw,
  ShieldCheck,
  SquarePen,
  SquareTerminal,
  Target,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  SortableList,
  Spinner,
  Tooltip,
  sortableDropClassHorizontal,
} from '@/components/ui';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Slot } from '@/components/plugins/ui/Slot';
import { RecipeDiv } from '@/lib/plugins/ui/recipe';
import type { SortableListApi } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { filterConversationsForLayout } from '@/lib/conversations';
import { goalIsRunning, goalPauseReasonLabel } from '@/lib/goalRunner';
import {
  codeFileTabKey,
  codeRepoItemTabKey,
  codeSubagentTabKey,
  useChatStore,
  useCodeStore,
  useUiStore,
  type CodeFileTab,
  type CodeIssueTab,
  type CodePullRequestTab,
  type CodeSubagentTab,
} from '@/lib/store';
import type { Conversation, GoalView, Workspace } from '@/lib/types';
import { SIDE_PANEL_DOCK_MIN_VIEWPORT, useViewportWidth } from '@/lib/sidePanel';
import { cn, copyText, sortStableByOrder } from '@/lib/utils';
import { WorkspaceTrustDialog } from './WorkspaceTrustDialog';
import { CodeContextMeterChip } from './CodeAgentWidgets';
import { FileIcon } from './FileIcon';
import { terminalManager, terminalTabLabel, type TerminalTabInfo } from './terminalManager';
import { openTerminal } from './terminalOpen';
import { useHorizontalWheelScroll } from './useHorizontalWheelScroll';
import { NO_WORKSPACE_KEY, openFolder, useWorkspaces } from './useWorkspaces';

/** Synthetic tab shown when the Code layout has no active conversation. */
const NEW_SESSION_ID = '__new_session__';
/** Synthetic center tab for an open file diff (WORKBENCH §7.2). */
const CODE_DIFF_TAB_ID = '__code_diff__';
/** Synthetic center tab for the commit history (WORKBENCH §7.2). */
const CODE_COMMITS_TAB_ID = '__code_commits__';
/** Synthetic center tab for the approved plan opened from "Ver plano". */
const CODE_PLAN_TAB_ID = '__code_plan__';
/** Synthetic center tab for the session goal (GoalPanel). */
const CODE_GOAL_TAB_ID = '__code_goal__';
/** Synthetic center tab with the repository pull requests list. */
const CODE_PULL_REQUESTS_TAB_ID = '__code_prs__';
/** Synthetic center tab with the repository issues list. */
const CODE_ISSUES_TAB_ID = '__code_issues__';
/**
 * Prefixo dos ids das abas centrais de arquivo (§7.1) — cada arquivo aberto tem
 * a própria aba. O sufixo é a chave estável `codeFileTabKey` codificada para o
 * DOM (o `\0` interno vira `%00`, então nenhum atributo carrega NUL).
 */
const CODE_FILE_TAB_PREFIX = '__code_file__:';
/** Prefix for retained subagent chat tabs (one per child conversation). */
const CODE_SUBAGENT_TAB_PREFIX = '__code_subagent__:';
/** Prefix for pull request tabs (one per PR). */
const CODE_PULL_REQUEST_TAB_PREFIX = '__code_pr__:';
/** Prefix for issue tabs (one per issue). */
const CODE_ISSUE_TAB_PREFIX = '__code_issue__:';

const SUBAGENT_TYPE_KEYS = {
  explore: 'code:header.subagent.explore',
  review: 'code:header.subagent.review',
  general: 'code:header.subagent.general',
  worker: 'code:header.subagent.worker',
} as const;

/** DOM id da aba de um pull request aberto. */
function codePullRequestTabDomId(tab: CodePullRequestTab): string {
  return `${CODE_PULL_REQUEST_TAB_PREFIX}${encodeURIComponent(codeRepoItemTabKey(tab))}`;
}

/** DOM id da aba de uma issue aberta. */
function codeIssueTabDomId(tab: CodeIssueTab): string {
  return `${CODE_ISSUE_TAB_PREFIX}${encodeURIComponent(codeRepoItemTabKey(tab))}`;
}

function findCodePullRequestTab(id: string): CodePullRequestTab | null {
  if (!id.startsWith(CODE_PULL_REQUEST_TAB_PREFIX)) return null;
  return (
    useUiStore.getState().codePullRequestTabs.find((tab) => codePullRequestTabDomId(tab) === id) ??
    null
  );
}

function findCodeIssueTab(id: string): CodeIssueTab | null {
  if (!id.startsWith(CODE_ISSUE_TAB_PREFIX)) return null;
  return useUiStore.getState().codeIssueTabs.find((tab) => codeIssueTabDomId(tab) === id) ?? null;
}

/** DOM id da aba de um arquivo aberto. */
function codeFileTabDomId(tab: CodeFileTab): string {
  return `${CODE_FILE_TAB_PREFIX}${encodeURIComponent(codeFileTabKey(tab))}`;
}

function codeSubagentTabDomId(tab: CodeSubagentTab): string {
  return `${CODE_SUBAGENT_TAB_PREFIX}${encodeURIComponent(codeSubagentTabKey(tab))}`;
}

function findCodeSubagentTab(id: string): CodeSubagentTab | null {
  if (!id.startsWith(CODE_SUBAGENT_TAB_PREFIX)) return null;
  return (
    useUiStore
      .getState()
      .codeSubagentTabs.find((tab) => codeSubagentTabDomId(tab) === id) ?? null
  );
}

/** Localiza a aba de arquivo de um id do DOM (ou `null` se não estiver aberta). */
function findCodeFileTab(id: string): CodeFileTab | null {
  if (!id.startsWith(CODE_FILE_TAB_PREFIX)) return null;
  return useUiStore.getState().codeFileTabs.find((tab) => codeFileTabDomId(tab) === id) ?? null;
}

/** Nome curto da aba (o aria/title levam o caminho completo). */
function codeFileTabName(tab: CodeFileTab): string {
  return tab.path.split('/').pop() || tab.path;
}

/**
 * Id of the conversation surface the session tabs control. `WorkspaceCenter`
 * (layout/) owns that element and should render it with this id so
 * `aria-controls` points at a real region.
 */
const SESSION_PANEL_ID = 'code-session-panel';

const chipClassName =
  'inline-flex h-7 max-w-60 shrink-0 items-center gap-1.5 rounded-full bg-surface px-2.5 ' +
  'text-[11.5px] text-foreground-muted transition-colors duration-150 ' +
  'hover:bg-surface-hover hover:text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ' +
  'disabled:pointer-events-none disabled:opacity-60';

interface SessionTab {
  id: string;
  title: string;
}

function sessionTitle(conversations: Conversation[], id: string): string {
  return (
    conversations.find((conversation) => conversation.id === id)?.title ??
    t('code:header.newSession')
  );
}

const GOAL_BADGE_TONE = {
  accent: 'bg-accent-soft text-accent',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const;

interface GoalBadgeProps {
  goal: GoalView;
  running: boolean;
  onOpen: () => void;
}

/**
 * Badge do objetivo no cabeçalho (PLAN §10.6): rodada em andamento
 * (`accent` + spinner), pausado (`warning`), bloqueado (`danger`) e ativo
 * (`N/M`). Concluído não aparece — o card de atenção/painel cuidam desse caso.
 * Clicar abre a aba central "Objetivo" (`openCodeGoal`).
 */
function GoalBadge({ goal, running, onOpen }: GoalBadgeProps) {
  const { t } = useTranslation('code');
  const tone =
    goal.status === 'paused' ? 'warning' : goal.status === 'blocked' ? 'danger' : 'accent';
  const pauseLabel = goalPauseReasonLabel(goal.pauseReason);
  const ariaLabel = running
    ? t('code:header.goalBadge.running', { current: goal.rounds, max: goal.maxRounds })
    : goal.status === 'paused'
      ? pauseLabel
        ? t('code:header.goalBadge.pausedWithReason', { reason: pauseLabel })
        : t('code:header.goalBadge.paused')
      : goal.status === 'blocked'
        ? t('code:header.goalBadge.blocked')
        : t(
            goal.autoContinue
              ? 'code:header.goalBadge.activeAuto'
              : 'code:header.goalBadge.activeManual',
            { current: goal.rounds, max: goal.maxRounds },
          );
  const visible =
    goal.status === 'paused'
      ? t('code:header.goalBadge.visiblePaused')
      : goal.status === 'blocked'
        ? t('code:header.goalBadge.visibleBlocked')
        : `${goal.rounds}/${goal.maxRounds}`;

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onOpen}
      className={cn(
        'inline-flex h-7 max-w-36 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium',
        'transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        GOAL_BADGE_TONE[tone],
      )}
    >
      {running ? (
        <Spinner size="xs" />
      ) : (
        <Target aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      )}
      <span className="truncate tabular-nums">{visible}</span>
    </button>
  );
}

interface WorkspaceChipProps {
  workspace: Workspace | null;
  busy: boolean;
  onRefresh: () => void;
  onOpenExplorer: () => void;
  onCopyPath: () => void;
  onOpenFolder: () => void;
  /** Troca a sessão ativa de workspace (null = sem workspace). */
  onBind: (workspaceId: string | null) => void;
  onToggleTrust: () => void;
}

/**
 * Chip do workspace da sessão + menu de ações (WORKBENCH §4). Sem workspace o
 * chip vira o CTA "Sem workspace" (abrir pasta ou vincular a um já aberto) —
 * nunca um beco sem saída.
 */
function WorkspaceChip({
  workspace,
  busy,
  onRefresh,
  onOpenExplorer,
  onCopyPath,
  onOpenFolder,
  onBind,
  onToggleTrust,
}: WorkspaceChipProps) {
  const { t } = useTranslation('code');
  const { workspaces } = useWorkspaces();
  const Icon = workspace ? (workspace.git ? FolderGit2 : Folder) : FolderOpen;
  const label = workspace ? workspace.name : t('code:header.workspace.none');
  const branch = workspace?.git?.branch;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-haspopup="menu"
          aria-label={
            workspace
              ? branch
                ? workspace.git?.dirty
                  ? t('code:header.workspace.ariaWithBranchDirty', {
                      name: workspace.name,
                      branch,
                    })
                  : t('code:header.workspace.ariaWithBranch', { name: workspace.name, branch })
                : workspace.git?.dirty
                  ? t('code:header.workspace.ariaDirty', { name: workspace.name })
                  : t('code:header.workspace.aria', { name: workspace.name })
              : t('code:header.workspace.ariaNone')
          }
          title={workspace?.path ?? t('code:header.workspace.openFolderTitle')}
          className={chipClassName}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">{label}</span>
          {branch ? (
            <span className="flex min-w-0 items-center gap-1 text-foreground-subtle">
              <span aria-hidden>·</span>
              <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="max-w-24 truncate">{branch}</span>
            </span>
          ) : null}
          {workspace?.git?.dirty ? (
            <span
              aria-hidden
              title={t('code:header.workspace.dirty')}
              className="size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        {workspace ? (
          <>
            <DropdownMenuLabel className="max-w-56 truncate normal-case tracking-normal text-foreground-muted">
              {workspace.name}
            </DropdownMenuLabel>
            <DropdownMenuItem icon={<RefreshCw className="size-4" />} onSelect={onRefresh}>
              {t('code:header.workspace.refresh')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<ExternalLink className="size-4" />} onSelect={onOpenExplorer}>
              {t('code:header.workspace.openExplorer')}
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Copy className="size-4" />} onSelect={onCopyPath}>
              {t('code:header.workspace.copyPath')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<ShieldCheck className="size-4" />}
              onSelect={onToggleTrust}
              disabled={busy}
            >
              {workspace.trusted
                ? t('code:header.workspace.revokeTrust')
                : t('code:header.workspace.trust')}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="normal-case tracking-normal text-foreground-muted">
              {t('code:header.workspace.noneLinked')}
            </DropdownMenuLabel>
            <DropdownMenuItem icon={<FolderOpen className="size-4" />} onSelect={onOpenFolder}>
              {t('code:header.workspace.openFolder')}
            </DropdownMenuItem>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('code:header.workspace.switch')}</DropdownMenuLabel>
        <DropdownMenuItem
          icon={<Folder className="size-4" />}
          checked={!workspace}
          onSelect={() => onBind(null)}
        >
          {t('code:header.workspace.none')}
        </DropdownMenuItem>
        {workspaces.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            icon={entry.git ? <FolderGit2 className="size-4" /> : <Folder className="size-4" />}
            checked={workspace?.id === entry.id}
            onSelect={() => onBind(entry.id)}
          >
            {entry.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Code session chrome (WORKBENCH §4): título, chip do workspace real (branch,
 * dirty, ações), medidor de contexto, toggle do painel e abas das sessões
 * abertas. Também hospeda o diálogo de confiança da primeira pasta — o
 * cabeçalho é o único chrome sempre montado no layout Code.
 */
export function CodeSessionHeader() {
  const { t } = useTranslation('code');
  const activeId = useChatStore((state) => state.activeId);
  const conversations = useChatStore((state) => state.conversations);
  const codePanelOpen = useUiStore((state) => state.codePanelOpen);
  const toggleCodePanel = useUiStore((state) => state.toggleCodePanel);
  const codeView = useUiStore((state) => state.codeView);
  const codeDiffTab = useUiStore((state) => state.codeDiffTab);
  const closeCodeDiff = useUiStore((state) => state.closeCodeDiff);
  const codeCommitsTab = useUiStore((state) => state.codeCommitsTab);
  const closeCodeCommits = useUiStore((state) => state.closeCodeCommits);
  const codeFileTabs = useUiStore((state) => state.codeFileTabs);
  const codePlanTab = useUiStore((state) => state.codePlanTab);
  const codeSubagentTabs = useUiStore((state) => state.codeSubagentTabs);
  const codeSubagentTab = useUiStore((state) => state.codeSubagentTab);
  const closeCodeSubagent = useUiStore((state) => state.closeCodeSubagent);
  const codeGoalOpen = useUiStore((state) => state.codeGoalOpen);
  const codeFileTab = useUiStore((state) => state.codeFileTab);
  const closeCodeFile = useUiStore((state) => state.closeCodeFile);
  const codePullRequestsTab = useUiStore((state) => state.codePullRequestsTab);
  const closeCodePullRequests = useUiStore((state) => state.closeCodePullRequests);
  const codePullRequestTabs = useUiStore((state) => state.codePullRequestTabs);
  const codePullRequestTab = useUiStore((state) => state.codePullRequestTab);
  const closeCodePullRequest = useUiStore((state) => state.closeCodePullRequest);
  const codeIssuesTab = useUiStore((state) => state.codeIssuesTab);
  const closeCodeIssues = useUiStore((state) => state.closeCodeIssues);
  const codeIssueTabs = useUiStore((state) => state.codeIssueTabs);
  const codeIssueTab = useUiStore((state) => state.codeIssueTab);
  const closeCodeIssue = useUiStore((state) => state.closeCodeIssue);
  const codeTabOrder = useUiStore((state) => state.codeTabOrder);
  const setCodeTabOrder = useUiStore((state) => state.setCodeTabOrder);
  const liveSubagents = useChatStore((state) => state.streaming?.subagents);
  const viewportWidth = useViewportWidth();
  /** The docked code panel only exists on wide windows (see CodePanel). */
  const canDock = viewportWidth >= SIDE_PANEL_DOCK_MIN_VIEWPORT;

  const { workspaces, pendingTrust, refreshContext, resolveTrust, cancelTrust, startSession } =
    useWorkspaces();

  const [trustBusy, setTrustBusy] = useState(false);

  // Sessions are separated per layout: the Code tabs only ever mirror Code
  // sessions and Chat sessions explicitly shared with Code (chat-code-sessions).
  const codeConversations = useMemo(
    () => filterConversationsForLayout(conversations, 'code'),
    [conversations],
  );

  const [openIds, setOpenIds] = useState<string[]>(() => (activeId ? [activeId] : []));
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const addTabRef = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(id, node);
    else tabRefs.current.delete(id);
  };
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  useHorizontalWheelScroll(tabStripRef);

  /** Restores keyboard focus after closing a tab (R3 do EVIDENCE da fase 1). */
  const focusTab = (id: string | undefined) => {
    window.setTimeout(() => {
      if (id) tabRefs.current.get(id)?.focus();
      else plusRef.current?.focus();
    }, 0);
  };

  /* The active conversation always becomes a tab; tabs of deleted (or no
     longer Code-visible) conversations are dropped. Comparing before returning
     keeps the previous array (and the render) when nothing changed. */
  useEffect(() => {
    const known = new Set(codeConversations.map((conversation) => conversation.id));
    setOpenIds((previous) => {
      const next = previous.filter((id) => known.has(id));
      if (activeId && known.has(activeId) && !next.includes(activeId)) next.push(activeId);
      if (next.length === previous.length && next.every((id, index) => id === previous[index])) {
        return previous;
      }
      return next;
    });
  }, [activeId, codeConversations]);

  const activeConversation = activeId
    ? codeConversations.find((conversation) => conversation.id === activeId)
    : undefined;
  const title = activeConversation?.title ?? t('code:header.newSession');
  // Aprovação/pergunta pendente precisa ser descobrível mesmo com o card fora
  // da viewport (WORKBENCH §9: badge âmbar na aba/header).
  const pendingApprovals = useCodeStore((state) => {
    if (!activeId) return 0;
    const session = state.byConversation[activeId];
    if (!session) return 0;
    return session.approvals.length + session.questions.length;
  });
  // Objetivo persistento da sessão ativa (docs/goals/code-goals): o badge só
  // aparece quando há objetivo e ele não está concluído (PLAN §10.6).
  const activeGoal = useCodeStore((state) =>
    activeId ? (state.byConversation[activeId]?.goal ?? null) : null,
  );
  const streaming = useChatStore((state) => state.streaming);
  const goalRunning = activeGoal
    ? goalIsRunning(
        activeGoal,
        streaming != null,
        streaming?.turnKind,
        streaming?.conversationId,
        activeId,
      )
    : false;
  const tabs: SessionTab[] =
    openIds.length === 0
      ? []
      : sortStableByOrder(openIds, codeTabOrder).map((id) => ({
          id,
          title: sessionTitle(codeConversations, id),
        }));
  /* No active Code session (no conversation, or it belongs to Chat only): the
     tab strip falls back to the synthetic "Nova sessão" tab, so the tablist
     always has exactly one selected tab. */
  const showNewSessionTab = activeConversation === undefined;

  // The central terminal set is independent from the right panel's terminals;
  // the active terminal is owned by the manager, not duplicated in the store.
  const centerTerminals = useSyncExternalStore(
    terminalManager.subscribe,
    () => terminalManager.getSnapshot('center'),
    () => terminalManager.getSnapshot('center'),
  );

  /* Drag-and-drop order of the movable tabs (sessions + center terminals).
     The context tabs rendered after them (diff/file/plan/goal/commits) keep
     their stable order — they are not part of the reorderable strip. */
  const stripIds = sortStableByOrder(
    [
      ...(showNewSessionTab ? [] : tabs.map((tab) => tab.id)),
      ...centerTerminals.tabs.map((terminalTab) => terminalTab.id),
    ],
    codeTabOrder,
  );

  const stripItemLabel = (id: string): string => {
    const session = tabs.find((tab) => tab.id === id);
    if (session) return session.title;
    const terminalTab = centerTerminals.tabs.find((tab) => tab.id === id);
    return terminalTab ? terminalTabLabel(terminalTab) : id;
  };

  const workspace = activeConversation?.workspaceId
    ? (workspaces.find((entry) => entry.id === activeConversation.workspaceId) ?? null)
    : null;

  const selectTab = (id: string) => {
    if (centerTerminals.tabs.some((tab) => tab.id === id)) {
      terminalManager.activate(id, { focusTerminal: true });
      useUiStore.getState().setCodeView('terminal');
      return;
    }
    if (id.startsWith(CODE_FILE_TAB_PREFIX)) {
      /* Ativar a aba de arquivo (sem duplicar: `openCodeFile` só ativa se já
         estiver aberto) e mostrar o arquivo no centro. */
      const fileTarget = findCodeFileTab(id);
      if (fileTarget) useUiStore.getState().openCodeFile(fileTarget);
      return;
    }
    if (id === CODE_DIFF_TAB_ID) {
      useUiStore.getState().setCodeView('diff');
      return;
    }
    if (id === CODE_COMMITS_TAB_ID) {
      useUiStore.getState().setCodeView('commits');
      return;
    }
    if (id === CODE_PLAN_TAB_ID) {
      useUiStore.getState().setCodeView('plan');
      return;
    }
    if (id === CODE_GOAL_TAB_ID) {
      useUiStore.getState().openCodeGoal();
      return;
    }
    if (id === CODE_PULL_REQUESTS_TAB_ID) {
      useUiStore.getState().setCodeView('prs');
      return;
    }
    if (id === CODE_ISSUES_TAB_ID) {
      useUiStore.getState().setCodeView('issues');
      return;
    }
    if (id.startsWith(CODE_PULL_REQUEST_TAB_PREFIX)) {
      const target = findCodePullRequestTab(id);
      if (target) useUiStore.getState().openCodePullRequest(target);
      return;
    }
    if (id.startsWith(CODE_ISSUE_TAB_PREFIX)) {
      const target = findCodeIssueTab(id);
      if (target) useUiStore.getState().openCodeIssue(target);
      return;
    }
    if (id.startsWith(CODE_SUBAGENT_TAB_PREFIX)) {
      const subagentTarget = findCodeSubagentTab(id);
      if (subagentTarget) useUiStore.getState().openCodeSubagent(subagentTarget);
      return;
    }
    if (id === NEW_SESSION_ID) return;
    const isActiveConversation = id === activeId;
    // Clicar na aba da conversa que JÁ está ativa é no-op… exceto quando o
    // centro mostra o diff: aí a aba é o caminho de volta para a sessão.
    if (isActiveConversation && codeView === 'session') return;
    useUiStore.getState().setCodeView('session');
    if (!isActiveConversation) void useChatStore.getState().openConversation(id);
  };

  const closeTab = (id: string) => {
    if (id === NEW_SESSION_ID) return;
    if (centerTerminals.tabs.some((tab) => tab.id === id)) {
      const wasActive = codeView === 'terminal' && centerTerminals.activeId === id;
      const last = centerTerminals.tabs.length === 1;
      // `close` removes the instance and notifies synchronously before the IPC
      // await, so the snapshot below already reflects the selected neighbor.
      void terminalManager.close(id);
      if (wasActive && last) {
        useUiStore.getState().setCodeView('session');
        focusTab(activeId ?? undefined);
        return;
      }
      const next = terminalManager.getSnapshot('center').activeId;
      focusTab(next ?? activeId ?? undefined);
      return;
    }
    if (id.startsWith(CODE_FILE_TAB_PREFIX)) {
      const fileTarget = findCodeFileTab(id);
      if (!fileTarget) return;
      closeCodeFile(fileTarget);
      /* Devolve o foco: nova aba ativa (a vizinha, quando a fechada era ativa),
         senão a aba da sessão ativa, senão o botão "+" (padrão de `focusTab`). */
      const nextFileTab = useUiStore.getState().codeFileTab;
      if (nextFileTab) focusTab(codeFileTabDomId(nextFileTab));
      else focusTab(activeId ?? undefined);
      return;
    }
    if (id === CODE_DIFF_TAB_ID) {
      closeCodeDiff();
      focusTab(activeId ?? undefined);
      return;
    }
    if (id === CODE_COMMITS_TAB_ID) {
      closeCodeCommits();
      focusTab(activeId ?? undefined);
      return;
    }
    if (id === CODE_PLAN_TAB_ID) {
      useUiStore.getState().closeCodePlan();
      focusTab(activeId ?? undefined);
      return;
    }
    if (id === CODE_GOAL_TAB_ID) {
      useUiStore.getState().closeCodeGoal();
      focusTab(activeId ?? undefined);
      return;
    }
    if (id === CODE_PULL_REQUESTS_TAB_ID) {
      closeCodePullRequests();
      focusTab(activeId ?? undefined);
      return;
    }
    if (id === CODE_ISSUES_TAB_ID) {
      closeCodeIssues();
      focusTab(activeId ?? undefined);
      return;
    }
    if (id.startsWith(CODE_PULL_REQUEST_TAB_PREFIX)) {
      const target = findCodePullRequestTab(id);
      if (!target) return;
      closeCodePullRequest(target);
      const next = useUiStore.getState().codePullRequestTab;
      if (next) focusTab(codePullRequestTabDomId(next));
      else focusTab(activeId ?? undefined);
      return;
    }
    if (id.startsWith(CODE_ISSUE_TAB_PREFIX)) {
      const target = findCodeIssueTab(id);
      if (!target) return;
      closeCodeIssue(target);
      const next = useUiStore.getState().codeIssueTab;
      if (next) focusTab(codeIssueTabDomId(next));
      else focusTab(activeId ?? undefined);
      return;
    }
    if (id.startsWith(CODE_SUBAGENT_TAB_PREFIX)) {
      const subagentTarget = findCodeSubagentTab(id);
      if (!subagentTarget) return;
      closeCodeSubagent(subagentTarget);
      const nextSubagent = useUiStore.getState().codeSubagentTab;
      if (nextSubagent) focusTab(codeSubagentTabDomId(nextSubagent));
      else focusTab(activeId ?? undefined);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const rest = tabs.filter((tab) => tab.id !== id);
    setOpenIds(rest.map((tab) => tab.id));
    if (id !== activeId) {
      focusTab(activeId ?? undefined);
      return;
    }
    // Closing the active tab falls back to the next one, then to the previous;
    // closing the last tab returns to the "Nova sessão" welcome state. The
    // conversation itself stays in the history (there is no backend close).
    const neighbor = tabs[index + 1] ?? tabs[index - 1];
    if (neighbor) {
      void useChatStore.getState().openConversation(neighbor.id);
      focusTab(neighbor.id);
    } else {
      useChatStore.getState().clearActiveConversation();
      focusTab(undefined);
    }
  };

  /**
   * Middle-click closes a tab (same gesture as browser tabs). The strip
   * suppresses the WebView2 autoscroll on mouse down; the close runs on
   * auxclick, after the button is released.
   */
  const middleClickClose = (id: string) => ({
    onAuxClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      closeTab(id);
    },
  });

  const createSession = () => {
    useUiStore.getState().setCodeView('session');
    /* The "+" opens the new session next to the active one, so it inherits the
       active session's workspace instead of starting detached. With no active
       session (welcome state), the workspace selected in the sidebar is the
       project the user is looking at. */
    const workspaceId = activeConversation
      ? (activeConversation.workspaceId ?? null)
      : useUiStore.getState().activeWorkspaceId;
    if (workspaceId) useUiStore.getState().setActiveWorkspace(workspaceId);
    void startSession(workspaceId);
  };

  /**
   * Opens a terminal in the central strip. The terminal set is global, but the
   * PTY needs a folder: the active session's workspace is used, otherwise the
   * workspace selected in the sidebar seeds a new session first (see
   * `openTerminal`).
   */
  const openCenterTerminal = async () => {
    const terminalId = await openTerminal('center', activeConversation?.id ?? null);
    if (terminalId) {
      useUiStore.getState().setCodeView('terminal');
      return;
    }
    const error = terminalManager.getSnapshot('center').error;
    if (error) toast.error(error.message, { description: error.detail });
  };

  /* A stale terminal view (deleted session, layout switch, last tab closed by
     another path) falls back to the conversation. Errors stay visible so the
     center surface can show the inline retry after a failed CTA. */
  useEffect(() => {
    if (codeView !== 'terminal') return;
    if (centerTerminals.loading || centerTerminals.error) return;
    if (centerTerminals.tabs.length === 0) useUiStore.getState().setCodeView('session');
  }, [codeView, centerTerminals.loading, centerTerminals.error, centerTerminals.tabs.length]);

  /* Global shortcuts resolve to custom events so the menu actions stay in one
     place (this header) instead of being duplicated in App.tsx. */
  const actionsRef = useRef({ createSession, openCenterTerminal });
  actionsRef.current = { createSession, openCenterTerminal };
  useEffect(() => {
    const onNewSession = () => actionsRef.current.createSession();
    const onTerminal = () => void actionsRef.current.openCenterTerminal();
    window.addEventListener('zylara:code-new-session', onNewSession);
    window.addEventListener('zylara:code-new-terminal', onTerminal);
    return () => {
      window.removeEventListener('zylara:code-new-session', onNewSession);
      window.removeEventListener('zylara:code-new-terminal', onTerminal);
    };
  }, []);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>, id: string) => {
    const tablist = event.currentTarget.closest('[role="tablist"]');
    const items = tablist ? Array.from(tablist.querySelectorAll<HTMLElement>('[role="tab"]')) : [];
    const index = items.indexOf(event.currentTarget);
    const focusAt = (nextIndex: number) => {
      const element = items[nextIndex];
      if (!element) return;
      event.preventDefault();
      element.focus();
    };

    switch (event.key) {
      case 'ArrowRight':
        focusAt((index + 1) % items.length);
        break;
      case 'ArrowLeft':
        focusAt((index - 1 + items.length) % items.length);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        selectTab(id);
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        closeTab(id);
        break;
      default:
        break;
    }
  };

  const handleBindWorkspace = async (workspaceId: string | null) => {
    if (!activeConversation || workspaceId === (activeConversation.workspaceId ?? null)) return;
    try {
      await api.setConversationWorkspace(activeConversation.id, workspaceId);
      useUiStore
        .getState()
        .openWorkspaceSession(workspaceId ?? NO_WORKSPACE_KEY, activeConversation.id);
      await useChatStore.getState().refreshConversations();
      if (workspaceId) useUiStore.getState().setActiveWorkspace(workspaceId);
    } catch (error) {
      toast.error(t('code:header.toast.bindWorkspaceError'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleOpenFolder = () => {
    void openFolder({ conversationId: activeConversation?.id ?? null });
  };

  const handleCopyPath = async () => {
    if (!workspace) return;
    if (await copyText(workspace.path)) toast.success(t('code:header.toast.pathCopied'));
    else toast.error(t('code:header.toast.copyPathError'));
  };

  const handleTrustToggle = () => {
    if (!workspace) return;
    const next = !workspace.trusted;
    setTrustBusy(true);
    void api
      .setWorkspaceTrusted(workspace.id, next)
      .then(async () => {
        await refreshContext(workspace.id);
        toast.success(
          next ? t('code:header.toast.trusted') : t('code:header.toast.trustRevoked'),
          {
            description: next
              ? t('code:header.toast.trustedDescription')
              : t('code:header.toast.trustRevokedDescription'),
          },
        );
      })
      .catch((error: unknown) => {
        toast.error(t('code:header.toast.trustError'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setTrustBusy(false));
  };

  const handleResolveTrust = async (trusted: boolean) => {
    setTrustBusy(true);
    try {
      await resolveTrust(trusted);
    } finally {
      setTrustBusy(false);
    }
  };

  const handleCancelTrust = async () => {
    setTrustBusy(true);
    try {
      await cancelTrust();
    } finally {
      setTrustBusy(false);
    }
  };

  const panelLabel = codePanelOpen
    ? t('code:header.panel.hide')
    : t('code:header.panel.show');
  const panelButton = (
    <IconButton
      label={panelLabel}
      size="sm"
      active={codePanelOpen}
      aria-pressed={codePanelOpen}
      disabled={!canDock}
      onClick={toggleCodePanel}
    >
      <PanelRight className="size-4" />
    </IconButton>
  );

  /** Movable session tab of the strip (drag-and-drop reorders `codeTabOrder`). */
  const renderSessionTab = (tab: SessionTab, sortable: SortableListApi) => {
    const selected = tab.id === activeId && codeView === 'session';
    const itemProps = sortable.itemProps(tab.id);
    return (
      <div
        key={tab.id}
        role="presentation"
        {...middleClickClose(tab.id)}
        {...sortable.dropProps(tab.id)}
        className={cn(
          'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
          selected
            ? 'bg-surface-active text-foreground'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
          sortableDropClassHorizontal,
        )}
      >
        <button
          type="button"
          role="tab"
          aria-label={tab.title}
          aria-selected={selected}
          aria-controls={SESSION_PANEL_ID}
          title={tab.title}
          tabIndex={selected ? 0 : -1}
          {...itemProps}
          ref={(node) => {
            itemProps.ref(node);
            addTabRef(tab.id)(node);
          }}
          onClick={() => selectTab(tab.id)}
          onKeyDown={(event) => {
            itemProps.onKeyDown(event);
            if (!event.defaultPrevented) handleTabKeyDown(event, tab.id);
          }}
          className={cn(
            'h-full min-w-0 flex-1 cursor-pointer select-none rounded-l-lg pl-2.5 text-left text-[12px]',
            'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            !sortable.disabled && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <span className="block truncate">{tab.title}</span>
        </button>
        <button
          type="button"
          aria-label={t('code:header.closeTab', { title: tab.title })}
          tabIndex={-1}
          onClick={() => closeTab(tab.id)}
          className={cn(
            'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
            'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
    );
  };

  /** Movable center-terminal tab, ordered together with the session tabs. */
  const renderTerminalTab = (terminalTab: TerminalTabInfo, sortable: SortableListApi) => {
    const label = terminalTabLabel(terminalTab);
    const selected = codeView === 'terminal' && centerTerminals.activeId === terminalTab.id;
    const itemProps = sortable.itemProps(terminalTab.id);
    return (
      <div
        key={terminalTab.id}
        role="presentation"
        {...middleClickClose(terminalTab.id)}
        {...sortable.dropProps(terminalTab.id)}
        className={cn(
          'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
          selected
            ? 'bg-surface-active text-foreground'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
          sortableDropClassHorizontal,
        )}
      >
        <button
          type="button"
          role="tab"
          id={`terminal-tab-${terminalTab.id}`}
          aria-label={label}
          aria-selected={selected}
          aria-controls="code-terminal-panel"
          title={
            terminalTab.cwd
              ? t('code:terminal.tabTitleWithCwd', {
                  title: label,
                  cwd: terminalTab.cwd,
                })
              : label
          }
          tabIndex={selected ? 0 : -1}
          {...itemProps}
          ref={(node) => {
            itemProps.ref(node);
            addTabRef(terminalTab.id)(node);
          }}
          onClick={() => selectTab(terminalTab.id)}
          onKeyDown={(event) => {
            itemProps.onKeyDown(event);
            if (!event.defaultPrevented) handleTabKeyDown(event, terminalTab.id);
          }}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
            'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            !sortable.disabled && 'cursor-grab active:cursor-grabbing',
          )}
        >
          <SquareTerminal
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              terminalTab.running ? 'text-foreground-subtle' : 'text-warning',
            )}
            strokeWidth={1.75}
          />
          <span className="truncate">{label}</span>
          {!terminalTab.running ? (
            <span
              aria-hidden
              className="ml-0.5 inline-flex size-1.5 shrink-0 rounded-full bg-warning"
            />
          ) : null}
        </button>
        <button
          type="button"
          aria-label={t('code:header.closeTab', { title: label })}
          tabIndex={-1}
          onClick={() => closeTab(terminalTab.id)}
          className={cn(
            'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
            'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
    );
  };

  return (
    <Slot name="code.session.header.frame" owner={{ layout: 'code' }}>
    <header className="flex shrink-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2
          className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-foreground"
          title={title}
        >
          {title}
        </h2>

        {pendingApprovals > 0 ? (
          <Badge
            variant="warning"
            title={t('code:header.pendingApproval', { count: pendingApprovals })}
          >
            {t('code:header.pendingApprovalBadge')}
          </Badge>
        ) : null}

        {activeGoal && activeGoal.status !== 'completed' ? (
          <GoalBadge
            goal={activeGoal}
            running={goalRunning}
            onOpen={() => useUiStore.getState().openCodeGoal()}
          />
        ) : null}

        <WorkspaceChip
          workspace={workspace}
          busy={trustBusy}
          onRefresh={() => workspace && void refreshContext(workspace.id)}
          onOpenExplorer={() => workspace && void api.openWorkspaceInExplorer(workspace.id)}
          onCopyPath={() => void handleCopyPath()}
          onOpenFolder={handleOpenFolder}
          onBind={(workspaceId) => void handleBindWorkspace(workspaceId)}
          onToggleTrust={handleTrustToggle}
        />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <PluginSlot
            slot="code.header.actions"
            context={{
              conversationId: activeConversation?.id ?? null,
              workspaceId: workspace?.id ?? null,
            }}
            compact
          />
          {activeConversation ? (
            <CodeContextMeterChip conversationId={activeConversation.id} />
          ) : null}
          {canDock ? (
            <Tooltip content={panelLabel} side="bottom">
              {panelButton}
            </Tooltip>
          ) : (
            <Tooltip content={t('code:header.panel.widen')} side="bottom">
              {/* Disabled buttons swallow pointer events: hover the wrapper so the hint stays discoverable. */}
              <span className="inline-flex" title={t('code:header.panel.widen')}>
                {panelButton}
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <Slot name="code.tabs.before" owner={{ layout: 'code', workspaceId: workspace?.id ?? null }} />
        {/* Active tabs use a neutral fill instead of a raised surface + shadow:
            on the white header the shadow reads as a glow in light mode. */}
        <SortableList
          ids={stripIds}
          label={t('code:header.tabsTablist')}
          itemLabel={stripItemLabel}
          orientation="horizontal"
          onReorder={setCodeTabOrder}
        >
          {(sortable) => (
            <Slot name="code.tab.strip.frame" owner={{ layout: 'code' }}>
            <RecipeDiv
              component="code.tab.strip"
              ref={(node) => {
                tabStripRef.current = node;
                sortable.containerRef.current = node;
              }}
              role="tablist"
              aria-label={t('code:header.tabsTablist')}
              onMouseDown={(event) => {
                // Suppress WebView2 autoscroll on middle click.
                if (event.button === 1) event.preventDefault();
              }}
              className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5"
            >
              {showNewSessionTab ? (
                <div
                  role="tab"
                  aria-label={t('code:header.newSession')}
                  aria-selected
                  aria-controls={SESSION_PANEL_ID}
                  title={t('code:header.newSession')}
                  tabIndex={0}
                  className={cn(
                    'flex h-8 max-w-44 shrink-0 select-none items-center rounded-lg',
                    'bg-surface-active pl-2.5 pr-2 text-[12px] text-foreground',
                    'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  )}
                >
                  <span className="truncate">{t('code:header.newSession')}</span>
                </div>
              ) : null}
              {stripIds.map((id) => {
                const terminalTab = centerTerminals.tabs.find((tab) => tab.id === id);
                if (terminalTab) return renderTerminalTab(terminalTab, sortable);
                const session = tabs.find((tab) => tab.id === id);
                return session ? renderSessionTab(session, sortable) : null;
              })}
              {codeSubagentTabs.map((subagentTab) => {
                const id = codeSubagentTabDomId(subagentTab);
                const selected =
                  codeView === 'subagent' &&
                  codeSubagentTab !== null &&
                  codeSubagentTabKey(codeSubagentTab) ===
                    codeSubagentTabKey(subagentTab);
                const live = liveSubagents?.[subagentTab.taskCallId];
                const label = t('code:header.subagent.tabLabel', {
                  description: subagentTab.description,
                });
                return (
                  <div
                    key={id}
                    role="presentation"
                    {...middleClickClose(id)}
                    className={cn(
                      'group flex h-8 max-w-48 shrink-0 items-center rounded-lg transition-colors duration-150',
                      selected
                        ? 'bg-surface-active text-foreground'
                        : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-label={label}
                      aria-selected={selected}
                      aria-controls="code-subagent-panel"
                      title={label}
                      tabIndex={selected ? 0 : -1}
                      ref={addTabRef(id)}
                      onClick={() => selectTab(id)}
                      onKeyDown={(event) => handleTabKeyDown(event, id)}
                      className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <Bot
                        aria-hidden
                        className={cn(
                          'size-3.5 shrink-0',
                          live?.status === 'running' ? 'text-accent' : 'text-foreground-subtle',
                        )}
                        strokeWidth={1.75}
                      />
                      <span className="truncate">
                        {subagentTab.subagentType in SUBAGENT_TYPE_KEYS
                          ? t(SUBAGENT_TYPE_KEYS[subagentTab.subagentType as keyof typeof SUBAGENT_TYPE_KEYS])
                          : subagentTab.subagentType}{' '}
                        · {subagentTab.description}
                      </span>
                      {live?.status === 'running' ? <Spinner size="xs" /> : null}
                    </button>
                    <button
                      type="button"
                      aria-label={t('code:header.closeTab', { title: label })}
                      tabIndex={-1}
                      onClick={() => closeTab(id)}
                      className={cn(
                        'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                        'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              {codeFileTabs.map((fileTab) => {
                const id = codeFileTabDomId(fileTab);
                const name = codeFileTabName(fileTab);
                const selected =
                  codeView === 'file' &&
                  codeFileTab !== null &&
                  codeFileTabKey(codeFileTab) === codeFileTabKey(fileTab);
                return (
                  <div
                    key={id}
                    role="presentation"
                    {...middleClickClose(id)}
                    className={cn(
                      'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                      selected
                        ? 'bg-surface-active text-foreground'
                        : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-label={t('code:header.fileTab', { path: fileTab.path })}
                      aria-selected={selected}
                      aria-controls="code-file-panel"
                      title={t('code:header.fileTab', { path: fileTab.path })}
                      tabIndex={selected ? 0 : -1}
                      ref={addTabRef(id)}
                      onClick={() => selectTab(id)}
                      onKeyDown={(event) => handleTabKeyDown(event, id)}
                      className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <FileIcon path={fileTab.path} className="size-3.5" />
                      <span className="truncate">{name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('code:header.closeTab', { title: name })}
                      tabIndex={-1}
                      onClick={() => closeTab(id)}
                      className={cn(
                        'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                        'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              {codePlanTab ? (
                <div
                  role="presentation"
                  {...middleClickClose(CODE_PLAN_TAB_ID)}
                  className={cn(
                    'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                    codeView === 'plan'
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t('code:header.planTab.label')}
                    aria-selected={codeView === 'plan'}
                    aria-controls="code-plan-panel"
                    title={t('code:header.planTab.label')}
                    tabIndex={codeView === 'plan' ? 0 : -1}
                    ref={addTabRef(CODE_PLAN_TAB_ID)}
                    onClick={() => selectTab(CODE_PLAN_TAB_ID)}
                    onKeyDown={(event) => handleTabKeyDown(event, CODE_PLAN_TAB_ID)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                      'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <FileIcon path={t('code:plan.previewPath')} className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {codePlanTab.title ?? t('code:header.planTab.visible')}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('code:header.planTab.close')}
                    tabIndex={-1}
                    onClick={() => closeTab(CODE_PLAN_TAB_ID)}
                    className={cn(
                      'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                      'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {codeGoalOpen ? (
                <div
                  role="presentation"
                  {...middleClickClose(CODE_GOAL_TAB_ID)}
                  className={cn(
                    'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                    codeView === 'goal'
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t('code:header.goalTab.label')}
                    aria-selected={codeView === 'goal'}
                    aria-controls="code-goal-panel"
                    title={t('code:header.goalTab.label')}
                    tabIndex={codeView === 'goal' ? 0 : -1}
                    ref={addTabRef(CODE_GOAL_TAB_ID)}
                    onClick={() => selectTab(CODE_GOAL_TAB_ID)}
                    onKeyDown={(event) => handleTabKeyDown(event, CODE_GOAL_TAB_ID)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                      'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <Target aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t('code:header.goalTab.visible')}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('code:header.goalTab.close')}
                    tabIndex={-1}
                    onClick={() => closeTab(CODE_GOAL_TAB_ID)}
                    className={cn(
                      'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                      'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {codeDiffTab ? (
                <div
                  role="presentation"
                  {...middleClickClose(CODE_DIFF_TAB_ID)}
                  className={cn(
                    'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                    codeView === 'diff'
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t('code:header.diffTab.label', { path: codeDiffTab.path })}
                    aria-selected={codeView === 'diff'}
                    aria-controls="code-diff-panel"
                    title={t('code:header.diffTab.title', { path: codeDiffTab.path })}
                    tabIndex={codeView === 'diff' ? 0 : -1}
                    ref={addTabRef(CODE_DIFF_TAB_ID)}
                    onClick={() => selectTab(CODE_DIFF_TAB_ID)}
                    onKeyDown={(event) => handleTabKeyDown(event, CODE_DIFF_TAB_ID)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                      'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <FileDiff aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t('code:header.diffTab.visible')}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('code:header.diffTab.close', { path: codeDiffTab.path })}
                    tabIndex={-1}
                    onClick={() => closeTab(CODE_DIFF_TAB_ID)}
                    className={cn(
                      'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                      'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {codeCommitsTab ? (
                <div
                  role="presentation"
                  {...middleClickClose(CODE_COMMITS_TAB_ID)}
                  className={cn(
                    'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                    codeView === 'commits'
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t('code:header.commitsTab.label')}
                    aria-selected={codeView === 'commits'}
                    aria-controls="code-commits-panel"
                    title={t('code:header.commitsTab.label')}
                    tabIndex={codeView === 'commits' ? 0 : -1}
                    ref={addTabRef(CODE_COMMITS_TAB_ID)}
                    onClick={() => selectTab(CODE_COMMITS_TAB_ID)}
                    onKeyDown={(event) => handleTabKeyDown(event, CODE_COMMITS_TAB_ID)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                      'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <History aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t('code:header.commitsTab.visible')}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('code:header.commitsTab.close')}
                    tabIndex={-1}
                    onClick={() => closeTab(CODE_COMMITS_TAB_ID)}
                    className={cn(
                      'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                      'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {codePullRequestsTab ? (
                <div
                  role="presentation"
                  {...middleClickClose(CODE_PULL_REQUESTS_TAB_ID)}
                  className={cn(
                    'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                    codeView === 'prs'
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t('code:header.pullRequestsTab.label')}
                    aria-selected={codeView === 'prs'}
                    aria-controls="code-prs-panel"
                    title={t('code:header.pullRequestsTab.label')}
                    tabIndex={codeView === 'prs' ? 0 : -1}
                    ref={addTabRef(CODE_PULL_REQUESTS_TAB_ID)}
                    onClick={() => selectTab(CODE_PULL_REQUESTS_TAB_ID)}
                    onKeyDown={(event) => handleTabKeyDown(event, CODE_PULL_REQUESTS_TAB_ID)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                      'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <GitPullRequest aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t('code:header.pullRequestsTab.visible')}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('code:header.pullRequestsTab.close')}
                    tabIndex={-1}
                    onClick={() => closeTab(CODE_PULL_REQUESTS_TAB_ID)}
                    className={cn(
                      'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                      'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {codePullRequestTabs.map((item) => {
                const id = codePullRequestTabDomId(item);
                const selected =
                  codeView === 'pr' &&
                  codePullRequestTab !== null &&
                  codeRepoItemTabKey(codePullRequestTab) === codeRepoItemTabKey(item);
                const label = `#${item.number} ${item.title}`;
                return (
                  <div
                    key={id}
                    role="presentation"
                    {...middleClickClose(id)}
                    className={cn(
                      'group flex h-8 max-w-48 shrink-0 items-center rounded-lg transition-colors duration-150',
                      selected
                        ? 'bg-surface-active text-foreground'
                        : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-label={t('code:header.pullRequestTab.label', { number: item.number })}
                      aria-selected={selected}
                      aria-controls="code-pr-panel"
                      title={label}
                      tabIndex={selected ? 0 : -1}
                      ref={addTabRef(id)}
                      onClick={() => selectTab(id)}
                      onKeyDown={(event) => handleTabKeyDown(event, id)}
                      className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <GitPullRequest aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">
                        #{item.number} {item.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('code:header.closeTab', { title: label })}
                      tabIndex={-1}
                      onClick={() => closeTab(id)}
                      className={cn(
                        'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                        'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              {codeIssuesTab ? (
                <div
                  role="presentation"
                  {...middleClickClose(CODE_ISSUES_TAB_ID)}
                  className={cn(
                    'group flex h-8 max-w-44 shrink-0 items-center rounded-lg transition-colors duration-150',
                    codeView === 'issues'
                      ? 'bg-surface-active text-foreground'
                      : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-label={t('code:header.issuesTab.label')}
                    aria-selected={codeView === 'issues'}
                    aria-controls="code-issues-panel"
                    title={t('code:header.issuesTab.label')}
                    tabIndex={codeView === 'issues' ? 0 : -1}
                    ref={addTabRef(CODE_ISSUES_TAB_ID)}
                    onClick={() => selectTab(CODE_ISSUES_TAB_ID)}
                    onKeyDown={(event) => handleTabKeyDown(event, CODE_ISSUES_TAB_ID)}
                    className={cn(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                      'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <CircleDot aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t('code:header.issuesTab.visible')}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('code:header.issuesTab.close')}
                    tabIndex={-1}
                    onClick={() => closeTab(CODE_ISSUES_TAB_ID)}
                    className={cn(
                      'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                      'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    )}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </div>
              ) : null}
              {codeIssueTabs.map((item) => {
                const id = codeIssueTabDomId(item);
                const selected =
                  codeView === 'issue' &&
                  codeIssueTab !== null &&
                  codeRepoItemTabKey(codeIssueTab) === codeRepoItemTabKey(item);
                const label = `#${item.number} ${item.title}`;
                return (
                  <div
                    key={id}
                    role="presentation"
                    {...middleClickClose(id)}
                    className={cn(
                      'group flex h-8 max-w-48 shrink-0 items-center rounded-lg transition-colors duration-150',
                      selected
                        ? 'bg-surface-active text-foreground'
                        : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-label={t('code:header.issueTab.label', { number: item.number })}
                      aria-selected={selected}
                      aria-controls="code-issue-panel"
                      title={label}
                      tabIndex={selected ? 0 : -1}
                      ref={addTabRef(id)}
                      onClick={() => selectTab(id)}
                      onKeyDown={(event) => handleTabKeyDown(event, id)}
                      className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2.5 text-left text-[12px]',
                        'outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <CircleDot aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">
                        #{item.number} {item.title}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('code:header.closeTab', { title: label })}
                      tabIndex={-1}
                      onClick={() => closeTab(id)}
                      className={cn(
                        'mr-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                        'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      )}
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </RecipeDiv>
            </Slot>
          )}
        </SortableList>

        <Slot name="code.tabs.after" owner={{ layout: 'code' }} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              ref={plusRef}
              label={t('code:header.addTab')}
              title={t('code:header.addTab')}
              size="sm"
            >
              <Plus className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem
              icon={<SquarePen className="size-4" />}
              onSelect={createSession}
            >
              {t('code:header.newSession')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<SquareTerminal className="size-4" />}
              onSelect={() => void openCenterTerminal()}
            >
              {t('code:header.terminal')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* O diálogo de confiança vive aqui: o cabeçalho é o único chrome do Code
          sempre montado (inclusive quando a sidebar é um drawer fechado). */}
      <WorkspaceTrustDialog
        open={pendingTrust !== null}
        workspace={pendingTrust?.workspace ?? null}
        busy={trustBusy}
        onConfirm={() => void handleResolveTrust(true)}
        onReadOnly={() => void handleResolveTrust(false)}
        onCancel={() => void handleCancelTrust()}
      />
    </header>
    </Slot>
  );
}

export default CodeSessionHeader;

