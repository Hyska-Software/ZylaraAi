import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileDiff,
  Files,
  FolderOpen,
  GitBranch,
  History,
  PanelRightClose,
  RefreshCw,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  IconButton,
  SortableList,
  Spinner,
  Tooltip,
  sortableDropClassHorizontal,
} from '@/components/ui';
import { PanelResizer } from '@/components/layout/PanelResizer';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Slot } from '@/components/plugins/ui/Slot';
import { PluginDockTabHost } from '@/components/plugins/ui/PluginDockTabHost';
import { pluginIcon } from '@/lib/plugins/icons';
import { pluginLabel } from '@/lib/plugins/registry';
import { RecipeDiv } from '@/lib/plugins/ui/recipe';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { api } from '@/lib/api';
import {
  SIDE_PANEL_WIDTH_DEFAULT,
  SIDE_PANEL_WIDTH_MIN,
  SIDE_PANEL_WIDTH_STEP,
  useAppStore,
  useChatStore,
  useCodeStore,
  useUiStore,
  type CodePanelTab,
} from '@/lib/store';
import { resolveSidePanelLayout, useViewportWidth } from '@/lib/sidePanel';
import type {
  WorkspaceChangedEvent,
  WorkspaceFileEntry,
  WorkspaceTreeSnapshot,
} from '@/lib/types';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ChangesPanel, countPendingChanges } from './ChangesPanel';
import { BranchPicker } from './BranchPicker';
import { FileTree } from './FileTree';
import { GitActionsMenu } from './GitActionsMenu';
import { TerminalPanel } from './TerminalPanel';
import { useWorkspacePanel } from './useWorkspacePanel';
import { dirsAffectedBy, useWorkspaceWatch } from './useWorkspaceWatch';
import { useWorkspaces } from './useWorkspaces';

/** Icons of the Code right panel tabs (WORKBENCH §7). The order lives in the store. */
const TAB_ICONS: Record<CodePanelTab, LucideIcon> = {
  files: Files,
  changes: FileDiff,
  terminal: SquareTerminal,
};

/** Stable catalog key per panel tab. */
const PANEL_TAB_KEYS = {
  files: 'code:panel.tabs.files',
  changes: 'code:panel.tabs.changes',
  terminal: 'code:panel.tabs.terminal',
} as const;

/** Single content region controlled by both tabs (only the active one renders). */
const PANEL_BODY_ID = 'code-panel-body';

/**
 * Mescla os filhos carregados sob demanda (lazy) na árvore do backend.
 *
 * A recursão precisa descer **sempre**, mesmo quando o diretório atual não tem
 * cache próprio: no caso real (apps > desktop > public) o cache existe num
 * neto ('apps/desktop/public'); retornar cedo no primeiro nível sem cache
 * descartava esse carregamento e o clique parecia não fazer nada.
 */
function withLazyChildren(
  entries: WorkspaceFileEntry[],
  cache: Record<string, WorkspaceFileEntry[]>,
): WorkspaceFileEntry[] {
  return entries.map((entry) => {
    if (!entry.isDir) return entry;
    const source = cache[entry.path] ?? entry.children ?? [];
    return { ...entry, children: withLazyChildren(source, cache) };
  });
}

/** Procura um nó da árvore pelo path (para saber se os filhos já estão carregados). */
function findTreeEntry(
  entries: WorkspaceFileEntry[],
  path: string,
): WorkspaceFileEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.children?.length) {
      const found = findTreeEntry(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

function PanelEmptyState({ icon: Icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-surface-hover text-foreground-muted">
        <Icon aria-hidden className="size-5" strokeWidth={1.75} />
      </span>
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">{description}</p>
    </div>
  );
}

/**
 * Code right panel: real Arquivos/Alterações tabs for the active session's
 * workspace (`WORKBENCH.md` §7). Width shares the persisted right-panel width
 * and the accessible divider of the Chat panels; it is only rendered on
 * windows wide enough for the docked layout, so the conversation always keeps
 * at least 480px.
 */
export function CodePanel() {
  const { t } = useTranslation('code');
  const open = useUiStore((state) => state.codePanelOpen);
  const tab = useUiStore((state) => state.codePanelTab);
  const setTab = useUiStore((state) => state.setCodePanelTab);
  const tabOrder = useUiStore((state) => state.codePanelTabOrder);
  const setTabOrder = useUiStore((state) => state.setCodePanelTabOrder);
  const pluginDock = useUiStore((state) => state.pluginDockTab.code);
  const openPluginDockTab = useUiStore((state) => state.openPluginDockTab);
  const ui = usePluginUi();
  const disabledPluginUi = usePluginUiPrefs((state) => state.disabled);
  const pluginTabs = useMemo(
    () =>
      ui.panelTabs.filter(
        (entry) =>
          entry.layouts.includes('code') &&
          !entry.takeover &&
          !disabledPluginUi.includes(entry.key),
      ),
    [disabledPluginUi, ui.panelTabs],
  );
  /* A docked key can outlive its plugin (disable/uninstall). Falling back to the
     host tab keeps the Changes/Files/Terminal content visible instead of a
     blank body with a stale selected tab. */
  const activePluginDock = pluginTabs.some((entry) => entry.key === pluginDock)
    ? pluginDock
    : null;
  const setOpen = useUiStore((state) => state.setCodePanelOpen);
  const openCodeDiff = useUiStore((state) => state.openCodeDiff);
  const openCodeCommits = useUiStore((state) => state.openCodeCommits);
  const openCodeFile = useUiStore((state) => state.openCodeFile);
  const codeFileTab = useUiStore((state) => state.codeFileTab);
  // Padrão de fábrica: diff abre como aba do chat; pode ser trocado em
  // Configurações → Ferramentas (Settings.diffOpenMode).
  const diffOpenMode = useAppStore((state) => state.settings.diffOpenMode ?? 'tab');
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const persistedWidth = useUiStore((state) => state.sidePanelWidth);
  const setSidePanelWidth = useUiStore((state) => state.setSidePanelWidth);
  const viewportWidth = useViewportWidth();

  const activeId = useChatStore((state) => state.activeId);
  const conversation = useChatStore((state) =>
    state.conversations.find((entry) => entry.id === state.activeId),
  );
  const workspaceId = conversation?.workspaceId ?? null;
  const panel = useWorkspacePanel(workspaceId);
  const { workspaces, refreshContext } = useWorkspaces();
  const workspace = workspaces.find((entry) => entry.id === workspaceId) ?? null;
  const sessionChangeFiles = useCodeStore((state) =>
    activeId ? (state.byConversation[activeId]?.changes?.files ?? null) : null,
  );
  const lastTurnChangeFiles = useCodeStore((state) =>
    activeId ? (state.byConversation[activeId]?.lastTurnChanges?.files ?? null) : null,
  );
  const refreshSession = useCodeStore((state) => state.refresh);
  const sessionLoading = useCodeStore((state) =>
    activeId ? (state.byConversation[activeId]?.loading ?? false) : false,
  );
  const sessionError = useCodeStore((state) =>
    activeId ? (state.byConversation[activeId]?.error ?? null) : null,
  );
  /* Contador da aba Alterações: mesmos arquivos do filtro "Sem commit". */
  const pendingChanges = useMemo(
    () => countPendingChanges(panel.gitStatus, sessionChangeFiles),
    [panel.gitStatus, sessionChangeFiles],
  );

  /** Width previewed while dragging; `null` means "use the persisted width". */
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const tabRefs = useRef(new Map<CodePanelTab, HTMLButtonElement>());
  /**
   * Last known "this workspace is a git repo" flag. A reload can resolve the
   * status back to `null` (error or a superseded load) and a transient `null`
   * used to unmount the git toolbar — closing an open dropdown with it.
   */
  const repoKnownRef = useRef(false);
  /* Expansão sob demanda: o backend lista a árvore até 2 níveis; diretórios
     mais profundos carregam os filhos quando o usuário abre. */
  const [lazyChildren, setLazyChildren] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [lazyLoading, setLazyLoading] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setLazyChildren({});
    setLazyLoading(new Set());
    repoKnownRef.current = false;
  }, [workspaceId]);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      setLazyLoading((current) => new Set(current).add(path));
      try {
        const entries = await api.listWorkspaceFiles(workspaceId, path, 2);
        setLazyChildren((current) => ({ ...current, [path]: entries ?? [] }));
      } catch (error) {
        toast.error(t('code:panel.toast.openFolderError'), { description: String(error) });
      } finally {
        setLazyLoading((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    },
    [workspaceId],
  );

  const treeEntries = useMemo(
    () => withLazyChildren(panel.files, lazyChildren),
    [panel.files, lazyChildren],
  );

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

  /* O clique na árvore abre a aba central de arquivo (`openCodeFile`); a
     seleção destacada na árvore espelha o arquivo aberto no centro. */
  const selectedFilePath =
    workspaceId && codeFileTab?.workspaceId === workspaceId ? codeFileTab.path : undefined;

  /** Replaces the cached children of the refreshed lazy directories. */
  const applySnapshotDirs = useCallback(
    (snapshot: WorkspaceTreeSnapshot, dirs: string[]) => {
      setLazyChildren((current) => {
        const next = { ...current };
        for (const dir of dirs) {
          const entries = snapshot.dirs[dir] ?? [];
          // Deleted/empty dir becomes lazy again: the next expand reloads it.
          if (entries.length === 0) delete next[dir];
          else next[dir] = entries;
        }
        return next;
      });
    },
    [],
  );

  const refreshAll = useCallback(async () => {
    // Preserva a expansão: a raiz e cada diretório carregado sob demanda vêm
    // atualizados no mesmo snapshot.
    const dirs = Object.keys(lazyChildren);
    const snapshot = await panel.refresh({ dirs });
    if (snapshot) applySnapshotDirs(snapshot, dirs);
    if (activeId) void refreshSession(activeId);
  }, [lazyChildren, panel, activeId, refreshSession, applySnapshotDirs]);

  /**
   * Branch switch/create: the whole tree changes under the panel (a checkout
   * rewrites files), so the container reloads tree, status and commits and the
   * Changes tab drops its cached comparison targets.
   *
   * The workspace list also carries a cached `git.branch` used by the session
   * header chip and the sidebar; without refreshing it those surfaces would keep
   * showing the branch the user just left.
   */
  const handleBranchChanged = useCallback(() => {
    void refreshAll();
    if (workspaceId) void refreshContext(workspaceId);
  }, [refreshAll, refreshContext, workspaceId]);

  const handleWorkspaceChanges = useCallback(
    (event: WorkspaceChangedEvent) => {
      const loaded = Object.keys(lazyChildren);
      const dirs = (event.overflow ? loaded : dirsAffectedBy(event.paths, loaded)).slice(0, 32);
      return panel
        .refresh({ dirs, foreground: false, reloadCommits: false })
        .then((snapshot) => {
          if (snapshot) applySnapshotDirs(snapshot, dirs);
          /* Os contadores ± vêm do snapshot da sessão (git numstat), não de
             `git status`: sem isso a linha nova fica com +0 −0 até o ⟳. */
          if (activeId) void refreshSession(activeId);
        });
    },
    [activeId, lazyChildren, panel, applySnapshotDirs, refreshSession],
  );

  useWorkspaceWatch({
    workspaceId,
    enabled: open && layout.canDock,
    onChanges: handleWorkspaceChanges,
  });

  /* Reabrir o painel reconcilia mudanças ocorridas com o watcher parado. */
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  const wasVisible = useRef(open && layout.canDock);
  useEffect(() => {
    const visible = open && layout.canDock;
    if (visible && !wasVisible.current) void refreshAllRef.current();
    wasVisible.current = visible;
  }, [open, layout.canDock]);

  /* The summary from the backend already carries `origin`/`staged` per file;
     keeping it intact lets the panel distinguish git-only rows from session
     edits (and use the real ± counters). */
  const sessionChanges = sessionChangeFiles;

  /* All hooks above run unconditionally; visibility is decided afterwards. */
  if (!open || !layout.canDock) return null;

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

  const selectTab = (next: CodePanelTab) => {
    setTab(next);
    tabRefs.current.get(next)?.focus();
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, current: CodePanelTab) => {
    const index = tabOrder.findIndex((entry) => entry === current);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabOrder.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabOrder.length) % tabOrder.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabOrder.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = tabOrder[nextIndex];
    if (next) selectTab(next);
  };

  const branch = panel.gitStatus?.branch ?? workspace?.git?.branch ?? null;
  if (panel.gitStatus) repoKnownRef.current = panel.gitStatus.isRepo;
  const repoKnown = panel.gitStatus?.isRepo ?? repoKnownRef.current;
  // Icon-only tabs below this width keep the three labels + actions from
  // colliding at the minimum docked panel width (360–430px).
  const compactTabs = layout.width < 430;

  return (
    <aside
      aria-label={t('code:panel.aria')}
      style={{ width: layout.width }}
      className="relative z-10 flex h-full shrink-0 flex-col bg-surface"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <SortableList
          ids={tabOrder}
          label={t('code:panel.tablist')}
          itemLabel={(id) => t(PANEL_TAB_KEYS[id as CodePanelTab])}
          orientation="horizontal"
          onReorder={(ids) => setTabOrder(ids as CodePanelTab[])}
        >
          {(sortable) => (
            <RecipeDiv
              component="code.tab.strip"
              ref={sortable.containerRef}
              role="tablist"
              aria-label={t('code:panel.tablist')}
              className="flex min-w-0 flex-1 items-center gap-0.5"
            >
              {tabOrder.map((id) => {
                const selected = tab === id;
                const Icon = TAB_ICONS[id];
                const itemProps = sortable.itemProps(id);
                return (
                  <div
                    key={id}
                    role="presentation"
                    {...sortable.dropProps(id)}
                    className={cn('shrink-0', sortableDropClassHorizontal)}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={`code-panel-tab-${id}`}
                      aria-selected={selected}
                      aria-controls={PANEL_BODY_ID}
                      tabIndex={selected ? 0 : -1}
                      {...itemProps}
                      ref={(node) => {
                        itemProps.ref(node);
                        if (node) tabRefs.current.set(id, node);
                        else tabRefs.current.delete(id);
                      }}
                      onClick={() => setTab(id)}
                      onKeyDown={(event) => {
                        itemProps.onKeyDown(event);
                        if (!event.defaultPrevented) handleTabKeyDown(event, id);
                      }}
                      aria-label={
                        id === 'changes' && pendingChanges > 0
                          ? t('code:panel.tabs.changesCount', { count: pendingChanges })
                          : t(PANEL_TAB_KEYS[id])
                      }
                      title={
                        id === 'changes' && pendingChanges > 0
                          ? t('code:panel.tabs.changesCount', { count: pendingChanges })
                          : t(PANEL_TAB_KEYS[id])
                      }
                      className={cn(
                        'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
                        'transition-colors duration-150',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                        selected
                          ? 'bg-surface-active text-foreground'
                          : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                        compactTabs && 'px-2',
                      )}
                    >
                      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
                      {compactTabs ? null : t(PANEL_TAB_KEYS[id])}
                      {id === 'changes' && pendingChanges > 0 ? (
                        <span
                          aria-hidden
                          className="min-w-4 rounded-full bg-accent-soft px-1 text-[10px] font-semibold leading-4 tabular-nums text-accent"
                        >
                          {pendingChanges}
                        </span>
                      ) : null}
                    </button>
                  </div>
                );
              })}
              {pluginTabs.map((entry) => {
                const Icon = pluginIcon(entry.icon);
                const selected = activePluginDock === entry.key;
                const label = pluginLabel(entry.plugin, entry.titleKey, entry.title);
                return (
                  <button
                    key={entry.key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={PANEL_BODY_ID}
                    aria-label={label}
                    title={label}
                    onClick={() => openPluginDockTab(entry.key, 'code')}
                    className={cn(
                      'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium',
                      'transition-colors duration-150',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      selected
                        ? 'bg-surface-active text-foreground'
                        : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                      compactTabs && 'px-2',
                    )}
                  >
                    <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
                    {compactTabs ? null : label}
                  </button>
                );
              })}
            </RecipeDiv>
          )}
        </SortableList>

        <Slot name="code.panel.tabs" owner={{ layout: 'code' }} />

        <PluginSlot slot="code.panel.header" compact />

        <Tooltip content={t('code:panel.refreshTooltip')} side="bottom">
          <IconButton
            label={t('code:panel.refresh')}
            size="sm"
            onClick={() => void refreshAll()}
          >
            <RefreshCw aria-hidden className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('code:panel.collapse')} side="bottom">
          <IconButton label={t('code:panel.collapse')} size="sm" onClick={() => setOpen(false)}>
            <PanelRightClose className="size-4" />
          </IconButton>
        </Tooltip>
      </div>

      <div
        role="tabpanel"
        id={PANEL_BODY_ID}
        aria-labelledby={`code-panel-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {activePluginDock ? (
          <PluginDockTabHost layout="code" tabKey={activePluginDock} />
        ) : tab === 'changes' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Workspace + branch só na aba Alterações (as abas Arquivos/Terminal
                já têm o próprio contexto no cabeçalho/título). */}
            <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3 text-[12px] text-foreground-muted">
              <GitBranch aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">
                {workspace ? workspace.name : t('code:panel.workspaceNone')}
              </span>
              {workspaceId && repoKnown ? (
                <>
                  <BranchPicker
                    workspaceId={workspaceId}
                    isRepo={repoKnown}
                    currentBranch={branch}
                    ahead={panel.gitStatus?.ahead ?? 0}
                    behind={panel.gitStatus?.behind ?? 0}
                    compact={compactTabs}
                    onChanged={handleBranchChanged}
                    onRefresh={refreshAll}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    leftIcon={<History className="size-3.5" strokeWidth={1.75} />}
                    onClick={() => openCodeCommits(workspaceId)}
                    aria-label={t('code:panel.commitsHistoryAria')}
                  >
                    {t('code:panel.commitsHistory')}
                  </Button>
                  <GitActionsMenu
                    workspaceId={workspaceId}
                    isRepo={repoKnown}
                    ahead={panel.gitStatus?.ahead ?? 0}
                    behind={panel.gitStatus?.behind ?? 0}
                    onRefresh={refreshAll}
                  />
                </>
              ) : null}
            </div>
            {workspaceId ? (
              <ChangesPanel
                key={workspaceId}
                workspaceId={workspaceId}
                conversationId={activeId}
                gitStatus={panel.gitStatus}
                gitLoading={panel.gitLoading}
                gitError={panel.gitError}
                sessionChanges={sessionChanges}
                lastTurnChanges={lastTurnChangeFiles}
                commits={panel.commits}
                commitsLoading={panel.commitsLoading}
                sessionLoading={sessionLoading}
                sessionError={sessionError}
                onRefresh={refreshAll}
                onOpenDiffTab={
                  diffOpenMode === 'panel'
                    ? null
                    : (row) => {
                        if (!workspaceId) return;
                        openCodeDiff({
                          workspaceId,
                          path: row.path,
                          staged: row.staged,
                          knownDiff: row.knownDiff ?? null,
                          base: row.base ?? null,
                        });
                      }
                }
                compact={compactTabs}
                className="min-h-0 flex-1"
              />
            ) : (
              <PanelEmptyState
                icon={FolderOpen}
                title={t('code:panel.empty.noWorkspaceTitle')}
                description={t('code:panel.empty.noWorkspaceDescription')}
              />
            )}
          </div>
        ) : tab === 'terminal' ? (
          /* The terminal list is global: it stays available (and lists the
             terminals opened in other sessions/workspaces) even with no active
             session; only a new tab needs a folder to run in. */
          <TerminalPanel conversationId={activeId} className="min-h-0 flex-1" />
        ) : !workspaceId ? (
          <PanelEmptyState
            icon={FolderOpen}
            title={t('code:panel.empty.noWorkspaceTitle')}
            description={t('code:panel.empty.noWorkspaceDescription')}
          />
        ) : (
          <FileTree
            entries={treeEntries}
            loading={panel.filesLoading}
            error={panel.filesError}
            selectedPath={selectedFilePath}
            totalCount={panel.files.length}
            loadingPaths={lazyLoading}
            onSelectFile={(path) => {
              if (workspaceId) openCodeFile({ workspaceId, path });
            }}
            onToggleDir={(path) => {
              // Só busca quando o diretório ainda não tem filhos carregados;
              // abrir/colapsar diretórios já carregados é só estado local.
              if (lazyChildren[path] !== undefined) return;
              const node = findTreeEntry(treeEntries, path);
              if (!node || node.children?.length) return;
              void loadDirectory(path);
            }}
            className="min-h-0 flex-1"
          />
        )}
      </div>

      <PanelResizer
        side="end"
        value={layout.width}
        min={SIDE_PANEL_WIDTH_MIN}
        max={layout.maxWidth}
        step={SIDE_PANEL_WIDTH_STEP}
        label={t('code:panel.resizer')}
        className="absolute inset-y-0 -left-2 z-10"
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        onReset={handleReset}
      />
    </aside>
  );
}

export default CodePanel;
