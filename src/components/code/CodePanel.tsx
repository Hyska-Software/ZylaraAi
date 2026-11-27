import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  FileDiff,
  Files,
  FolderOpen,
  GitBranch,
  History,
  Plus,
  RefreshCw,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
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
  DropdownMenuTrigger,
  IconButton,
  SortableList,
  Spinner,
  Tooltip,
  sortableDropClassHorizontal,
} from '@/components/ui';
import { PanelResizer } from '@/components/layout/PanelResizer';
import { AnimatedSidePanel } from '@/components/layout/AnimatedSidePanel';
import { useChromeCornerReserve } from '@/components/layout/ChromeCorner';
import { DRAG_ROW_CLASS, useWindowDragProps } from '@/components/layout/windowChrome';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Slot } from '@/components/plugins/ui/Slot';
import { PluginDockTabHost } from '@/components/plugins/ui/PluginDockTabHost';
import { PluginDockTabStrip } from '@/components/plugins/ui/PluginDockTabStrip';
import { dockTabsForLayout, isRedundantDockTabAction } from '@/lib/plugins/ui/dock';
import { RecipeDiv } from '@/lib/plugins/ui/recipe';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { api } from '@/lib/api';
import {
  CODE_PANEL_TAB_ORDER_DEFAULT,
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
import { cn, copyText } from '@/lib/utils';
import { ChangesPanel, countPendingChanges } from './ChangesPanel';
import { BranchPicker } from './BranchPicker';
import type { FileAction } from './FileActionsMenu';
import { FileNameDialog, type FileNameDialogMode } from './FileNameDialog';
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

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/** Builds a native absolute path from the stored root and a `/`-separated entry path. */
function absoluteWorkspacePath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${relative.split('/').join(separator)}`;
}

/** Every directory path present in the loaded tree (for the Expand all action). */
function collectDirPaths(entries: WorkspaceFileEntry[], paths: string[] = []): string[] {
  for (const entry of entries) {
    if (!entry.isDir) continue;
    paths.push(entry.path);
    if (entry.children?.length) collectDirPaths(entry.children, paths);
  }
  return paths;
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

interface PanelLauncherProps {
  onOpenTab: (tab: CodePanelTab) => void;
}

/** Shown when every panel tab is closed: reopens one of the real panel tabs. */
function PanelLauncher({ onOpenTab }: PanelLauncherProps) {
  const { t } = useTranslation('code');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-8">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-hover text-foreground-muted">
        <Plus aria-hidden className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex w-full max-w-80 flex-col gap-2">
        {CODE_PANEL_TAB_ORDER_DEFAULT.map((id) => {
          const Icon = TAB_ICONS[id];
          const label = t(PANEL_TAB_KEYS[id]);
          return (
            <button
              key={id}
              type="button"
              aria-label={label}
              onClick={() => onOpenTab(id)}
              className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-surface-hover/60 px-3 text-left text-[12px] font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Icon aria-hidden className="size-4 shrink-0 text-foreground-muted" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          );
        })}
      </div>
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
  const openTabs = useUiStore((state) => state.codePanelOpenTabs);
  const closeTab = useUiStore((state) => state.closeCodePanelTab);
  const pluginDock = useUiStore((state) => state.pluginDockTab.code);
  const ui = usePluginUi();
  const disabledPluginUi = usePluginUiPrefs((state) => state.disabled);
  const pluginTabs = useMemo(
    () => dockTabsForLayout(ui.panelTabs, 'code', disabledPluginUi),
    [disabledPluginUi, ui.panelTabs],
  );
  /* A docked key can outlive its plugin (disable/uninstall). Falling back to the
     host tab keeps the Changes/Files/Terminal content visible instead of a
     blank body with a stale selected tab. */
  const activePluginDock = pluginTabs.some((entry) => entry.key === pluginDock)
    ? pluginDock
    : null;
  const openCodeDiff = useUiStore((state) => state.openCodeDiff);
  const openCodeCommits = useUiStore((state) => state.openCodeCommits);
  const openCodeFile = useUiStore((state) => state.openCodeFile);
  const openCodeFileToSide = useUiStore((state) => state.openCodeFileToSide);
  const closeCodeFile = useUiStore((state) => state.closeCodeFile);
  const closeSecondaryCodeFile = useUiStore((state) => state.closeSecondaryCodeFile);
  const codeFileTabs = useUiStore((state) => state.codeFileTabs);
  const codeFileTab = useUiStore((state) => state.codeFileTab);
  const secondaryCodeFileTab = useUiStore((state) => state.secondaryCodeFileTab);
  const expandedPathsByWorkspace = useUiStore((state) => state.codeFileTreeExpandedByWorkspace);
  const toggleFileTreePath = useUiStore((state) => state.toggleCodeFileTreePath);
  const setCodeFileTreeExpanded = useUiStore((state) => state.setCodeFileTreeExpanded);
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
  const expandedPaths = useMemo(
    () => new Set(workspaceId ? (expandedPathsByWorkspace[workspaceId] ?? []) : []),
    [expandedPathsByWorkspace, workspaceId],
  );
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

  const [nameDialog, setNameDialog] = useState<{
    mode: FileNameDialogMode;
    parent: string;
    initialName: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceFileEntry | null>(null);
  const [fileActionBusy, setFileActionBusy] = useState(false);
  /** Width previewed while dragging; `null` means "use the persisted width". */
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  /** The "+" dropdown is also opened by right-clicking the tab strip. */
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const tabRefs = useRef(new Map<CodePanelTab, HTMLButtonElement>());
  /** Order of the tabs that are actually open (closed tabs stay in `tabOrder`). */
  const visibleTabIds = useMemo(
    () => tabOrder.filter((id) => openTabs.includes(id)),
    [openTabs, tabOrder],
  );
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
  /** One hydration pass per workspace; expanding a folder must not re-fetch it. */
  const restoredWorkspaceRef = useRef<string | null>(null);

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

  const handleExpandAll = useCallback(() => {
    if (!workspaceId) return;
    const paths = collectDirPaths(treeEntries);
    setCodeFileTreeExpanded(workspaceId, paths);
    // Load children of lazy directories too, but bound the bulk work on huge
    // workspaces; deeper directories can be expanded on demand afterwards.
    let requested = 0;
    for (const path of paths) {
      if (requested >= 32) break;
      if (lazyChildren[path] !== undefined || findTreeEntry(treeEntries, path)?.children?.length) {
        continue;
      }
      requested += 1;
      void loadDirectory(path);
    }
  }, [workspaceId, treeEntries, lazyChildren, loadDirectory, setCodeFileTreeExpanded]);

  const handleCollapseAll = useCallback(() => {
    if (workspaceId) setCodeFileTreeExpanded(workspaceId, []);
  }, [workspaceId, setCodeFileTreeExpanded]);

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

  /* Restores the children of directories the user had expanded before leaving
     the workspace. One snapshot covers every saved path; the root tree is
     loaded by useWorkspacePanel and is left untouched. */
  useEffect(() => {
    if (!workspaceId || restoredWorkspaceRef.current === workspaceId) return;
    restoredWorkspaceRef.current = workspaceId;
    const paths = (
      useUiStore.getState().codeFileTreeExpandedByWorkspace[workspaceId] ?? []
    ).slice(0, 32);
    if (paths.length === 0) return;
    let cancelled = false;
    void api
      .refreshWorkspaceTree(workspaceId, paths)
      .then((snapshot) => {
        if (!cancelled) applySnapshotDirs(snapshot, paths);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t('code:panel.toast.openFolderError'), { description: String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, applySnapshotDirs]);

  const refreshAll = useCallback(async () => {
    // Preserva a expansão: a raiz e cada diretório carregado sob demanda vêm
    // atualizados no mesmo snapshot.
    const dirs = Object.keys(lazyChildren);
    const snapshot = await panel.refresh({ dirs });
    if (snapshot) applySnapshotDirs(snapshot, dirs);
    if (activeId) void refreshSession(activeId);
  }, [lazyChildren, panel, activeId, refreshSession, applySnapshotDirs]);

  const joinEntryPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

  const handleFileAction = useCallback(
    (action: FileAction, entry: WorkspaceFileEntry | null) => {
      if (!workspaceId || !workspace) return;
      if (action === 'newFile' || action === 'newFolder') {
        setNameDialog({
          mode: action === 'newFile' ? 'createFile' : 'createDir',
          parent: entry?.isDir ? entry.path : '',
          initialName: '',
        });
        return;
      }
      if (!entry) return;
      if (action === 'rename') {
        setNameDialog({ mode: 'rename', parent: entry.path, initialName: entry.name });
        return;
      }
      if (action === 'delete') {
        setDeleteTarget(entry);
        return;
      }
      if (action === 'openToSide') {
        openCodeFileToSide({ workspaceId, path: entry.path });
        return;
      }
      if (action === 'copyPath' || action === 'copyRelativePath') {
        const text =
          action === 'copyPath'
            ? absoluteWorkspacePath(workspace.path, entry.path)
            : entry.path;
        void copyText(text).then((copied) => {
          if (copied) {
            toast.success(
              t(
                action === 'copyPath'
                  ? 'code:tree.toast.copiedAbsolute'
                  : 'code:tree.toast.copiedRelative',
              ),
            );
          } else {
            toast.error(t('code:tree.toast.copyError'));
          }
        });
        return;
      }
      setFileActionBusy(true);
      void (async () => {
        try {
          if (action === 'reveal') {
            await api.revealWorkspaceEntry(workspaceId, entry.path);
            toast.success(t('code:tree.toast.revealed'));
            return;
          }
          if (action === 'download') {
            const saved = await api.saveWorkspaceFile(workspaceId, entry.path);
            if (saved) toast.success(t('code:tree.toast.downloaded', { name: entry.name }));
            return;
          }
          const created = await api.duplicateWorkspaceEntry(workspaceId, entry.path);
          toast.success(t('code:tree.toast.duplicated', { name: created.split('/').pop() ?? created }));
          await refreshAll();
        } catch (error) {
          toast.error(t('code:tree.toast.error'), {
            description: describeError(error, t('code:tree.toast.error')),
          });
        } finally {
          setFileActionBusy(false);
        }
      })();
    },
    [openCodeFileToSide, refreshAll, t, workspace, workspaceId],
  );

  const submitNameDialog = useCallback(
    async (name: string) => {
      if (!workspaceId || !nameDialog) return;
      setFileActionBusy(true);
      try {
        if (nameDialog.mode === 'rename') {
          const oldPath = nameDialog.parent;
          const parent = oldPath.split('/').slice(0, -1).join('/');
          await api.renameWorkspaceEntry(workspaceId, oldPath, joinEntryPath(parent, name));
          const affected = (tab: { workspaceId: string; path: string }) =>
            tab.workspaceId === workspaceId &&
            (tab.path === oldPath || tab.path.startsWith(`${oldPath}/`));
          for (const tab of codeFileTabs) if (affected(tab)) closeCodeFile(tab);
          if (secondaryCodeFileTab && affected(secondaryCodeFileTab)) closeSecondaryCodeFile();
          toast.success(t('code:tree.toast.renamed', { name }));
        } else {
          const target = joinEntryPath(nameDialog.parent, name);
          if (nameDialog.mode === 'createFile') await api.createWorkspaceFile(workspaceId, target);
          else await api.createWorkspaceDir(workspaceId, target);
          toast.success(t('code:tree.toast.created', { name }));
        }
        setNameDialog(null);
        await refreshAll();
      } catch (error) {
        toast.error(t('code:tree.toast.error'), {
          description: describeError(error, t('code:tree.toast.error')),
        });
      } finally {
        setFileActionBusy(false);
      }
    },
    [
      closeCodeFile,
      closeSecondaryCodeFile,
      codeFileTabs,
      nameDialog,
      refreshAll,
      secondaryCodeFileTab,
      t,
      workspaceId,
    ],
  );

  const confirmDelete = useCallback(async () => {
    if (!workspaceId || !deleteTarget) return;
    setFileActionBusy(true);
    try {
      await api.deleteWorkspaceEntry(workspaceId, deleteTarget.path);
      const affected = (path: string) =>
        path === deleteTarget.path || path.startsWith(`${deleteTarget.path}/`);
      for (const tab of codeFileTabs) {
        if (tab.workspaceId === workspaceId && affected(tab.path)) closeCodeFile(tab);
      }
      if (secondaryCodeFileTab?.workspaceId === workspaceId && affected(secondaryCodeFileTab.path)) {
        closeSecondaryCodeFile();
      }
      setDeleteTarget(null);
      toast.success(t('code:tree.toast.deleted', { name: deleteTarget.name }));
      await refreshAll();
    } catch (error) {
      toast.error(t('code:tree.toast.error'), {
        description: describeError(error, t('code:tree.toast.error')),
      });
    } finally {
      setFileActionBusy(false);
    }
  }, [
    closeCodeFile,
    closeSecondaryCodeFile,
    codeFileTabs,
    deleteTarget,
    refreshAll,
    secondaryCodeFileTab,
    t,
    workspaceId,
  ]);

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

  /* All hooks above run unconditionally; visibility is decided by the
     animated wrapper so closing can play the same exit as the left sidebar. */

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
    const index = visibleTabIds.indexOf(current);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % visibleTabIds.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + visibleTabIds.length) % visibleTabIds.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = visibleTabIds.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = visibleTabIds[nextIndex];
    if (next) selectTab(next);
  };

  /* Empty strip: the launcher replaces the body, but a plugin dock still owns
     the panel while one of its tabs is active. */
  const showLauncher = visibleTabIds.length === 0 && !activePluginDock;

  const branch = panel.gitStatus?.branch ?? workspace?.git?.branch ?? null;
  if (panel.gitStatus) repoKnownRef.current = panel.gitStatus.isRepo;
  const repoKnown = panel.gitStatus?.isRepo ?? repoKnownRef.current;
  // Icon-only tabs below this width keep the three labels + actions from
  // colliding at the minimum docked panel width (360–430px).
  const compactTabs = layout.width < 430;
  const reserve = useChromeCornerReserve('dock');
  const drag = useWindowDragProps();

  return (
    <AnimatedSidePanel
      open={open && layout.canDock}
      width={layout.width}
      label={t('code:panel.aria')}
      resizing={previewWidth !== null}
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
          ids={visibleTabIds}
          label={t('code:panel.tablist')}
          itemLabel={(id) => t(PANEL_TAB_KEYS[id as CodePanelTab])}
          orientation="horizontal"
          onReorder={(ids) =>
            setTabOrder([...ids, ...tabOrder.filter((id) => !ids.includes(id))] as CodePanelTab[])
          }
        >
          {(sortable) => (
            <RecipeDiv
              component="code.tab.strip"
              ref={sortable.containerRef}
              role="tablist"
              aria-label={t('code:panel.tablist')}
              onMouseDown={(event) => {
                // Suppress WebView2 autoscroll on middle click.
                if (event.button === 1) event.preventDefault();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenuOpen(true);
              }}
              className="flex min-w-0 flex-1 items-center gap-0.5"
            >
              {visibleTabIds.map((id) => {
                const selected = tab === id;
                const Icon = TAB_ICONS[id];
                const itemProps = sortable.itemProps(id);
                return (
                  <div
                    key={id}
                    role="presentation"
                    {...sortable.dropProps(id)}
                    onAuxClick={(event) => {
                      if (event.button !== 1) return;
                      event.preventDefault();
                      closeTab(id);
                    }}
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
              <PluginDockTabStrip layout="code" compact={compactTabs} />
            </RecipeDiv>
          )}
        </SortableList>

        <DropdownMenu open={tabMenuOpen} onOpenChange={setTabMenuOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton
              label={t('code:panel.addTab')}
              title={t('code:panel.addTab')}
              size="sm"
            >
              <Plus aria-hidden className="size-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            {tabOrder.map((id) => {
              const Icon = TAB_ICONS[id];
              return (
                <DropdownMenuItem
                  key={id}
                  icon={<Icon aria-hidden className="size-4" strokeWidth={1.75} />}
                  checked={openTabs.includes(id)}
                  onSelect={() => setTab(id)}
                >
                  {id === 'changes' && pendingChanges > 0
                    ? t('code:panel.tabs.changesCount', { count: pendingChanges })
                    : t(PANEL_TAB_KEYS[id])}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <Slot
          name="code.panel.tabs"
          owner={{ layout: 'code' }}
          filter={(entry) => !isRedundantDockTabAction(entry, pluginTabs)}
        />

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
      </div>

      <div
        role="tabpanel"
        id={PANEL_BODY_ID}
        aria-labelledby={showLauncher ? undefined : `code-panel-tab-${tab}`}
        aria-label={showLauncher ? t('code:panel.launcher.aria') : undefined}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <Slot name="code.panel.body.frame" owner={{ layout: 'code' }}>
        {showLauncher ? (
          <PanelLauncher onOpenTab={setTab} />
        ) : activePluginDock ? (
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
            expandedPaths={expandedPaths}
            totalCount={panel.files.length}
            loadingPaths={lazyLoading}
            onSelectFile={(path) => {
              if (workspaceId) openCodeFile({ workspaceId, path });
            }}
            onToggleDir={(path) => {
              const wasExpanded = expandedPaths.has(path);
              if (workspaceId) toggleFileTreePath(workspaceId, path);
              if (wasExpanded) return;
              // Só busca quando o diretório ainda não tem filhos carregados;
              // abrir/colapsar diretórios já carregados é só estado local.
              if (lazyChildren[path] !== undefined) return;
              const node = findTreeEntry(treeEntries, path);
              if (!node || node.children?.length) return;
              void loadDirectory(path);
            }}
            onExpandAll={handleExpandAll}
            onCollapseAll={handleCollapseAll}
            onAction={handleFileAction}
            className="min-h-0 flex-1"
          />
        )}
        </Slot>
      </div>

      <FileNameDialog
        open={nameDialog !== null}
        mode={nameDialog?.mode ?? 'createFile'}
        path={nameDialog?.parent || workspace?.name || ''}
        initialName={nameDialog?.initialName ?? ''}
        busy={fileActionBusy}
        onClose={() => setNameDialog(null)}
        onSubmit={(name) => void submitNameDialog(name)}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !fileActionBusy) setDeleteTarget(null);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {t('code:tree.dialog.deleteTitle', { name: deleteTarget?.name ?? '' })}
            </DialogTitle>
          </DialogHeader>
          <DialogDescription className="px-6 pb-4">
            {t('code:tree.dialog.deleteDescription')}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={fileActionBusy}
              onClick={() => setDeleteTarget(null)}
            >
              {t('code:tree.dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={fileActionBusy}
              onClick={() => void confirmDelete()}
            >
              {t('code:tree.dialog.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </AnimatedSidePanel>
  );
}

export default CodePanel;
