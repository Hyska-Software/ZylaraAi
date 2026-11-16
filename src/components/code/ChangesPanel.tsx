import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CircleAlert,
  FileDiff,
  GitBranch,
  Minus,
  Plus,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Spinner,
} from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { compareText } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type {
  CommitTarget,
  FileChange,
  FileChangeKind,
  FileChangeSummary,
  WorkspaceCommitDetail,
  WorkspaceGitBranches,
  WorkspaceGitCommit,
  WorkspaceGitCompare,
  WorkspaceGitStatus,
} from '@/lib/types';
import { CommitBar, shortHash } from './CommitBar';
import { ChangesFilterMenu, type ChangesFilter } from './ChangesFilterMenu';
import { DiffView } from './DiffView';
import { FileIcon } from './FileIcon';

export type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'session' | 'commit' | 'branch';
export type ChangeOrigin = 'session' | 'git' | 'both';

/**
 * Input accepted by the panel: the backend summary (`FileChangeSummary`, with
 * `origin`/`staged`) plus an optional diff already known from the journal/tool.
 */
export type ChangeInput = FileChangeSummary & Pick<FileChange, 'diff'>;

/** One file row of the changes list. */
export interface ChangeRow {
  path: string;
/** Short git status code (`M`, `A`, `D`, `R`, `U`…). */
  status: string;
  group: ChangeGroup;
  origin: ChangeOrigin;
  /** `true` when the change is in the git index. */
  staged: boolean;
  /**
   * `true` for git `MM` files: edits in the index **and** in the working tree.
   * The row keeps the index side as its primary group and lists here the
   * working-tree side, so both filters see the file without counting it twice.
   */
  alsoUnstaged?: boolean;
  added?: number;
  removed?: number;
  /** Diff already known from the session journal (skips the API call). */
  knownDiff?: string | null;
  /** Base revision for a comparison diff (`git diff <base>`). */
  base?: string | null;
}

export interface ChangesPanelProps {
  workspaceId?: string | null;
  conversationId?: string | null;
  /** Working tree status; `null` while unknown. */
  gitStatus?: WorkspaceGitStatus | null;
  gitLoading?: boolean;
  gitError?: string | null;
  /** Files touched by the current session (journal) plus git working tree entries. */
  sessionChanges?: ChangeInput[] | null;
  /** Files touched only by the most recent turn. `null`/`undefined` = unknown. */
  lastTurnChanges?: ChangeInput[] | null;
  /** Recent commits shown in the Commit filter submenu. */
  commits?: WorkspaceGitCommit[];
  commitsLoading?: boolean;
  sessionLoading?: boolean;
  sessionError?: string | null;
  /** Called after stage/unstage/revert/commit so the container reloads the data. */
  onRefresh?: () => void;
  /** Abre a aba central de histórico de commits (lista + diff completo). */
/**
   * Abre o diff como aba central em vez do detalhe inline do painel
   * (`Settings.diffOpenMode`, padrão `tab`). Quando definido, clicar numa linha
   * chama `onOpenDiffTab` e o painel não abre o diff interno.
   */
  onOpenDiffTab?: ((row: ChangeRow) => void) | null;
  /** Hides low-priority toolbar text at the panel's minimum width. */
  compact?: boolean;
  className?: string;
}

const GROUPS = ['staged', 'unstaged', 'untracked', 'session', 'commit', 'branch'] as const;

/** Stable catalog key per change group. */
const GROUP_KEYS = {
  staged: 'code:changes.groups.staged',
  unstaged: 'code:changes.groups.unstaged',
  untracked: 'code:changes.groups.untracked',
  session: 'code:changes.groups.session',
  commit: 'code:changes.groups.commit',
  branch: 'code:changes.groups.branch',
} as const;

const KIND_STATUS: Record<FileChangeKind, string> = {
  created: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

const STATUS_STYLES: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-danger',
  R: 'text-accent',
  C: 'text-accent',
  U: 'text-danger',
  '?': 'text-foreground-subtle',
};

function normalizeStatus(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) return 'M';
  return trimmed[0].toUpperCase();
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/** Picks the default comparison branch: main, master, then the first other. */
export function pickBranchBase(
  branches: readonly string[],
  current: string | null | undefined,
): string | null {
  const others = branches.filter((branch) => branch !== current);
  if (others.length === 0) return null;
  return (
    others.find((branch) => branch === 'main') ??
    others.find((branch) => branch === 'master') ??
    others[0]
  );
}

function emptyCopyFor(
  filter: ChangesFilter,
  hasWorkspace: boolean,
): { title: string; description: string } {
  if (!hasWorkspace) {
    return {
      title: t('code:changes.empty.noWorkspace.title'),
      description: t('code:changes.empty.noWorkspace.description'),
    };
  }
  switch (filter.kind) {
    case 'last-turn':
      return {
        title: t('code:changes.empty.lastTurn.title'),
        description: t('code:changes.empty.lastTurn.description'),
      };
    case 'staged':
      return {
        title: t('code:changes.empty.staged.title'),
        description: t('code:changes.empty.staged.description'),
      };
    case 'unstaged':
      return {
        title: t('code:changes.empty.unstaged.title'),
        description: t('code:changes.empty.unstaged.description'),
      };
    case 'commit':
      return {
        title: t('code:changes.empty.commit.title'),
        description: t('code:changes.empty.commit.description'),
      };
    case 'branch':
      return {
        title: t('code:changes.empty.branch.title', { base: filter.base }),
        description: t('code:changes.empty.branch.description'),
      };
    case 'uncommitted':
    default:
      return {
        title: t('code:changes.empty.uncommitted.title'),
        description: t('code:changes.empty.uncommitted.description'),
      };
  }
}

/** Merges git status and session journal into a unique, ordered row list. */
export function buildChangeRows(
  gitStatus: WorkspaceGitStatus | null | undefined,
  sessionChanges: ChangeInput[] | null | undefined,
): ChangeRow[] {
  const rows = new Map<string, ChangeRow>();

  const upsert = (row: ChangeRow) => {
    const existing = rows.get(row.path);
    if (!existing) {
      rows.set(row.path, row);
      return;
    }
    existing.origin = existing.origin === row.origin ? existing.origin : 'both';
    if (row.added !== undefined) existing.added = row.added;
    if (row.removed !== undefined) existing.removed = row.removed;
    if (row.knownDiff != null) existing.knownDiff = row.knownDiff;
    /* git `MM`: one path with edits in the index and in the working tree. The
       index side stays the primary group and the working-tree side becomes a
       flag, so the file is listed by both filters and counted only once. */
    if (row.group === 'staged' && existing.group !== 'staged') {
      existing.alsoUnstaged = true;
      existing.group = 'staged';
      existing.staged = true;
    } else if (row.group === 'unstaged' && existing.group === 'staged') {
      existing.alsoUnstaged = true;
    }
  };

  for (const file of gitStatus?.staged ?? []) {
    upsert({
      path: file.path,
      status: normalizeStatus(file.status),
      group: 'staged',
      origin: 'git',
      staged: true,
    });
  }
  for (const file of gitStatus?.unstaged ?? []) {
    upsert({
      path: file.path,
      status: normalizeStatus(file.status),
      group: 'unstaged',
      origin: 'git',
      staged: false,
    });
  }
  for (const path of gitStatus?.untracked ?? []) {
    // Arquivo novo: mostra o badge A e o diff sintético sem precisar de staging.
    upsert({ path, status: 'A', group: 'untracked', origin: 'git', staged: false });
  }
  for (const path of gitStatus?.conflicted ?? []) {
    upsert({ path, status: 'U', group: 'unstaged', origin: 'git', staged: false });
  }

  for (const change of sessionChanges ?? []) {
    const origin = change.origin ?? 'session';
    const existing = rows.get(change.path);

    // A git-only entry came from the backend summary (which already carries the
    // real counters): just complete the status row without marking it as an
    // agent edit or overriding its group/stage state.
    if (origin === 'git') {
      if (existing) {
        if (change.added !== undefined) existing.added = change.added;
        if (change.removed !== undefined) existing.removed = change.removed;
        continue;
      }
      rows.set(change.path, {
        path: change.path,
        status: KIND_STATUS[change.kind] ?? 'M',
        group: change.staged ? 'staged' : 'unstaged',
        origin: 'git',
        staged: Boolean(change.staged),
        added: change.added,
        removed: change.removed,
      });
      continue;
    }

    if (existing) {
      existing.origin = existing.origin === 'git' ? 'both' : existing.origin;
      if (change.added !== undefined) existing.added = change.added;
      if (change.removed !== undefined) existing.removed = change.removed;
      if (change.diff != null) existing.knownDiff = change.diff;
      continue;
    }

    rows.set(change.path, {
      path: change.path,
      status: KIND_STATUS[change.kind] ?? 'M',
      group: 'session',
      origin: 'session',
      staged: false,
      added: change.added,
      removed: change.removed,
      knownDiff: change.diff ?? null,
    });
  }

  return [...rows.values()].sort((a, b) => compareText(a.path, b.path));
}

/**
 * Rows shown under one group. A git `MM` file (index + working-tree edits)
 * belongs to both `staged` and `unstaged`; its row keeps the index side as the
 * primary group and is listed here for the working-tree side too.
 */
export function rowsForGroup(rows: readonly ChangeRow[], group: ChangeGroup): ChangeRow[] {
  return rows.filter(
    (row) => row.group === group || (group === 'unstaged' && row.alsoUnstaged === true),
  );
}

/**
 * Files the commit target will actually include — the single source for the
 * footer counters and for `hasChanges`.
 *
 * Session-only rows (journal entries of the agent that are no longer pending:
 * already committed, ignored by git or outside a repository) are never
 * committed, so they must not inflate `+N −M` nor enable the commit button.
 */
export function committableRows(
  rows: readonly ChangeRow[],
  target: CommitTarget,
  selectedPaths: readonly string[] = [],
): ChangeRow[] {
  switch (target) {
    case 'staged':
      return rows.filter((row) => row.group === 'staged');
    case 'selection': {
      const selected = new Set(selectedPaths);
      return rows.filter((row) => selected.has(row.path) && row.group !== 'session');
    }
    case 'all':
    default:
      return rows.filter((row) => row.group !== 'session');
  }
}

/** `+N −M` of the given rows (missing counters count as zero). */
export function sumLines(rows: readonly ChangeRow[]): { added: number; removed: number } {
  return rows.reduce(
    (acc, row) => ({
      added: acc.added + (row.added ?? 0),
      removed: acc.removed + (row.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );
}

/**
 * Pending files (unique paths) for the badge of the panel tab: the same set the
 * default "Sem commit" filter lists. Without a known git status the session
 * rows still count, mirroring the panel fallback.
 */
export function countPendingChanges(
  gitStatus: WorkspaceGitStatus | null | undefined,
  sessionChanges: ChangeInput[] | null | undefined,
): number {
  const rows = buildChangeRows(gitStatus, sessionChanges);
  if (!gitStatus || !gitStatus.isRepo) return rows.length;
  return committableRows(rows, 'all').length;
}

/**
 * Changes tab of the Code panel (WORKBENCH §7.2/§15).
 *
 * Merges the git working tree (`gitStatus`) with the session journal
 * (`sessionChanges`), grouping by Preparados/Não preparados/Novos/Da sessão and
 * marking the origin (git × agente). Hover actions stage/unstage and revert
 * (with confirmation) through `@/lib/api`; clicking a row opens the unified
 * diff in place and the footer hosts the `CommitBar`.
 */
export function ChangesPanel({
  workspaceId,
  conversationId,
  gitStatus,
  gitLoading = false,
  gitError = null,
  sessionChanges,
  lastTurnChanges,
  commits = [],
  commitsLoading = false,
  sessionLoading = false,
  sessionError = null,
  onRefresh,
  onOpenDiffTab = null,
  compact = false,
  className,
}: ChangesPanelProps) {
  const { t } = useTranslation('code');
  const rows = useMemo(() => buildChangeRows(gitStatus, sessionChanges), [gitStatus, sessionChanges]);
  const isRepo = gitStatus?.isRepo ?? false;
  const conflicted = (gitStatus?.conflicted.length ?? 0) > 0;

  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<'stage' | 'unstage' | null>(null);
  const [confirmRow, setConfirmRow] = useState<ChangeRow | null>(null);
  const [reverting, setReverting] = useState(false);

  const [selected, setSelected] = useState<ChangeRow | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const diffRun = useRef(0);

  const [explicitFilter, setExplicitFilter] = useState<ChangesFilter | null>(null);
  const activeFilter: ChangesFilter = explicitFilter ?? { kind: 'uncommitted' };
  const filterKind = activeFilter.kind;
  const filterCommitHash = activeFilter.kind === 'commit' ? activeFilter.hash : null;
  const filterBranchBase = activeFilter.kind === 'branch' ? activeFilter.base : null;
  const filterReadOnly = filterKind === 'commit' || filterKind === 'branch';

  const [commitDetail, setCommitDetail] = useState<WorkspaceCommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const commitRun = useRef(0);

  const [branchCompare, setBranchCompare] = useState<WorkspaceGitCompare | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const branchRun = useRef(0);

  const [branches, setBranches] = useState<WorkspaceGitBranches | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const branchesRun = useRef(0);
  const [branchButtonBusy, setBranchButtonBusy] = useState(false);

  const stagedPaths = useMemo(
    () => rows.filter((row) => row.group === 'staged').map((row) => row.path),
    [rows],
  );
  /* O commit tem alvo (`target`); os contadores do rodapé seguem esse alvo em
     vez de somar todas as linhas (que incluiria o que nunca vai no commit). */
  const [commitTarget, setCommitTarget] = useState<CommitTarget>('all');
  const targetRows = useMemo(
    () => committableRows(rows, commitTarget),
    [commitTarget, rows],
  );
  const totals = useMemo(() => sumLines(targetRows), [targetRows]);

  const lastTurnPaths = useMemo(
    () => new Set((lastTurnChanges ?? sessionChanges ?? []).map((change) => change.path)),
    [lastTurnChanges, sessionChanges],
  );

  const commitRows = useMemo<ChangeRow[]>(() => {
    if (!commitDetail) return [];
    return commitDetail.files
      .map((file) => ({
        path: file.path,
        status: normalizeStatus(file.status),
        group: 'commit' as const,
        origin: 'git' as const,
        staged: false,
        added: file.added,
        removed: file.removed,
        knownDiff: file.diff,
      }))
      .sort((a, b) => compareText(a.path, b.path));
  }, [commitDetail]);

  const branchRows = useMemo<ChangeRow[]>(() => {
    if (!branchCompare) return [];
    return branchCompare.files
      .map((file) => ({
        path: file.path,
        status: normalizeStatus(file.status),
        group: 'branch' as const,
        origin: 'git' as const,
        staged: false,
        added: file.added,
        removed: file.removed,
        base: branchCompare.mergeBase,
      }))
      .sort((a, b) => compareText(a.path, b.path));
  }, [branchCompare]);

  const visibleRows = useMemo<ChangeRow[]>(() => {
    // Without a repository the panel keeps the historical session-only list.
    if (!isRepo) return rows;
    switch (filterKind) {
      case 'last-turn':
        return rows.filter((row) => lastTurnPaths.has(row.path));
      case 'unstaged':
        // git `MM` rows keep `staged` as the primary group; `alsoUnstaged` lists
        // them here so the working-tree part is never hidden.
        return rows.filter(
          (row) =>
            row.group === 'unstaged' || row.group === 'untracked' || row.alsoUnstaged === true,
        );
      case 'staged':
        return rows.filter((row) => row.group === 'staged');
      case 'commit':
        return commitRows;
      case 'branch':
        return branchRows;
      case 'uncommitted':
      default:
        return rows.filter((row) => row.group !== 'session');
    }
  }, [branchRows, commitRows, filterKind, isRepo, lastTurnPaths, rows]);

  /** Groups the active filter renders — single source for sections and bulk actions. */
  const visibleGroups = useMemo<ChangeGroup[]>(() => {
    if (!isRepo) return GROUPS.filter((group) => group !== 'commit' && group !== 'branch');
    switch (filterKind) {
      case 'staged':
        return ['staged'];
      case 'unstaged':
        return ['unstaged', 'untracked'];
      case 'commit':
        return ['commit'];
      case 'branch':
        return ['branch'];
      case 'last-turn':
        return ['staged', 'unstaged', 'untracked', 'session'];
      case 'uncommitted':
      default:
        return ['staged', 'unstaged', 'untracked'];
    }
  }, [filterKind, isRepo]);

  const sections = useMemo(
    () =>
      visibleGroups
        .map((group) => ({ group, rows: rowsForGroup(visibleRows, group) }))
        .filter((section) => section.rows.length > 0),
    [visibleGroups, visibleRows],
  );

  const visibleStagedPaths = useMemo(
    () =>
      filterReadOnly
        ? []
        : (sections.find((section) => section.group === 'staged')?.rows ?? []).map(
            (row) => row.path,
          ),
    [filterReadOnly, sections],
  );
  const visibleStageablePaths = useMemo(
    () =>
      filterReadOnly
        ? []
        : sections
            .filter((section) => section.group === 'unstaged' || section.group === 'untracked')
            .flatMap((section) => section.rows)
            .filter((row) => row.origin !== 'session' && row.status !== 'U')
            .map((row) => row.path),
    [filterReadOnly, sections],
  );

  const loadCommit = useCallback(
    async (hash: string) => {
      if (!workspaceId) return;
      const run = commitRun.current + 1;
      commitRun.current = run;
      setCommitLoading(true);
      setCommitError(null);
      setCommitDetail(null);
      try {
        const detail = await api.gitCommitDetail(workspaceId, hash);
        if (run !== commitRun.current) return;
        setCommitDetail(detail);
      } catch (error) {
        if (run !== commitRun.current) return;
        setCommitError(describeError(error, t('code:changes.loadCommitError')));
      } finally {
        if (run === commitRun.current) setCommitLoading(false);
      }
    },
    [workspaceId],
  );

  const loadBranch = useCallback(
    async (base: string) => {
      if (!workspaceId || !isRepo) return;
      const run = branchRun.current + 1;
      branchRun.current = run;
      setBranchLoading(true);
      setBranchError(null);
      setBranchCompare(null);
      try {
        const compare = await api.gitCompare(workspaceId, base);
        if (run !== branchRun.current) return;
        setBranchCompare(compare);
      } catch (error) {
        if (run !== branchRun.current) return;
        setBranchError(describeError(error, t('code:changes.compareError')));
      } finally {
        if (run === branchRun.current) setBranchLoading(false);
      }
    },
    [isRepo, workspaceId],
  );

  const loadBranches = useCallback(async () => {
    if (!workspaceId || branches || branchesLoading) return;
    const run = branchesRun.current + 1;
    branchesRun.current = run;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const result = await api.gitBranches(workspaceId);
      if (run !== branchesRun.current) return;
      setBranches(result ?? { current: null, branches: [], all: [] });
    } catch (error) {
      if (run !== branchesRun.current) return;
      setBranchesError(describeError(error, t('code:changes.loadBranchesError')));
    } finally {
      if (run === branchesRun.current) setBranchesLoading(false);
    }
  }, [branches, branchesLoading, workspaceId]);

  const openBranchDiff = useCallback(async () => {
    if (!workspaceId || !isRepo || branchButtonBusy) return;
    setBranchButtonBusy(true);
    try {
      let result = branches;
      if (!result) {
        const run = branchesRun.current + 1;
        branchesRun.current = run;
        setBranchesLoading(true);
        setBranchesError(null);
        try {
          const loaded = await api.gitBranches(workspaceId);
          if (run !== branchesRun.current) return;
          result = loaded ?? { current: null, branches: [], all: [] };
          setBranches(result);
        } finally {
          if (run === branchesRun.current) setBranchesLoading(false);
        }
      }
      const base = pickBranchBase(result?.branches ?? [], result?.current ?? null);
      if (!base) {
        toast.info(t('code:changes.noOtherBranchToast'));
        return;
      }
      setExplicitFilter({ kind: 'branch', base });
    } catch (error) {
      toast.error(describeError(error, t('code:changes.loadBranchesToastError')));
    } finally {
      setBranchButtonBusy(false);
    }
  }, [branchButtonBusy, branches, isRepo, workspaceId]);

  useEffect(() => {
    setExplicitFilter(null);
    commitRun.current += 1;
    branchRun.current += 1;
    branchesRun.current += 1;
    setCommitDetail(null);
    setCommitError(null);
    setCommitLoading(false);
    setBranchCompare(null);
    setBranchError(null);
    setBranchLoading(false);
    setBranches(null);
    setBranchesError(null);
    setBranchesLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    if (filterCommitHash) void loadCommit(filterCommitHash);
  }, [filterCommitHash, loadCommit]);

  useEffect(() => {
    if (filterBranchBase) void loadBranch(filterBranchBase);
  }, [filterBranchBase, gitStatus, loadBranch]);

  useEffect(() => {
    // Switching branches changes the available comparison targets.
    branchesRun.current += 1;
    setBranches(null);
    setBranchesError(null);
    setBranchesLoading(false);
  }, [gitStatus?.branch]);

  useEffect(
    () => () => {
      diffRun.current += 1;
    },
    [],
  );

  const openRow = useCallback(
    async (row: ChangeRow, options: { staged?: boolean } = {}) => {
      /* git `MM`: o mesmo arquivo aparece em dois grupos; o diff (e o `staged`
         repassado à aba central) segue o grupo clicado, não o grupo primário. */
      const staged = options.staged ?? row.staged;
      // Padrão: o diff abre como aba central (configurável nas Configurações).
      if (onOpenDiffTab) {
        onOpenDiffTab({ ...row, staged });
        return;
      }
      const run = diffRun.current + 1;
      diffRun.current = run;
      setSelected({ ...row, staged });
      setDiffError(null);
      if (row.knownDiff != null) {
        setDiffText(row.knownDiff);
        setDiffLoading(false);
        return;
      }
      if (!workspaceId) {
        setDiffText('');
        setDiffError(t('code:changes.noWorkspaceDiff'));
        return;
      }
      setDiffText('');
      setDiffLoading(true);
      try {
        const text = row.base
          ? await api.getFileDiffAt(workspaceId, row.path, row.base)
          : await api.getFileDiff(workspaceId, row.path, staged);
        if (run !== diffRun.current) return;
        setDiffText(text ?? '');
      } catch (error) {
        if (run !== diffRun.current) return;
        setDiffError(describeError(error, t('code:changes.loadDiffError')));
      } finally {
        if (run === diffRun.current) setDiffLoading(false);
      }
    },
    [workspaceId, onOpenDiffTab],
  );

  const closeDiff = () => {
    diffRun.current += 1;
    setSelected(null);
    setDiffText('');
    setDiffError(null);
    setDiffLoading(false);
  };

  const mutate = async (row: ChangeRow, action: 'stage' | 'unstage') => {
    if (!workspaceId || busyPath || bulkBusy) return;
    setBusyPath(row.path);
    try {
      if (action === 'stage') await api.gitStage(workspaceId, [row.path]);
      else await api.gitUnstage(workspaceId, [row.path]);
      onRefresh?.();
    } catch (error) {
      toast.error(describeError(error, t('code:changes.stageError')));
    } finally {
      setBusyPath(null);
    }
  };

  const mutateAll = async (action: 'stage' | 'unstage') => {
    if (!workspaceId || bulkBusy || busyPath || filterReadOnly) return;
    if (action === 'stage' && conflicted) return;
    const paths = action === 'stage' ? visibleStageablePaths : visibleStagedPaths;
    const count = paths.length;
    if (count === 0) return;
    setBulkBusy(action);
    try {
      if (filterKind === 'uncommitted') {
        if (action === 'stage') await api.gitStageAll(workspaceId);
        else await api.gitUnstageAll(workspaceId);
      } else if (action === 'stage') {
        await api.gitStage(workspaceId, paths);
      } else {
        await api.gitUnstage(workspaceId, paths);
      }
      toast.success(
        t(action === 'stage' ? 'code:changes.stageSuccess' : 'code:changes.unstageSuccess', {
          count,
        }),
      );
      onRefresh?.();
    } catch (error) {
      toast.error(
        describeError(
          error,
          t(
            action === 'stage'
              ? 'code:changes.stageAllError'
              : 'code:changes.unstageAllError',
          ),
        ),
      );
    } finally {
      setBulkBusy(null);
    }
  };

  const confirmRevert = async () => {
    if (!confirmRow || !workspaceId) return;
    setReverting(true);
    try {
      if ((confirmRow.origin === 'session' || confirmRow.origin === 'both') && conversationId) {
        await api.revertFile(conversationId, confirmRow.path);
      } else {
        await api.gitDiscard(workspaceId, [confirmRow.path]);
      }
      toast.success(t('code:changes.revertSuccess'));
      if (selected?.path === confirmRow.path) closeDiff();
      setConfirmRow(null);
      onRefresh?.();
    } catch (error) {
      toast.error(describeError(error, t('code:changes.revertError')));
    } finally {
      setReverting(false);
    }
  };

  const filterLoading =
    (filterKind === 'commit' && commitLoading) ||
    (filterKind === 'branch' && branchLoading);
  const loading = gitLoading || sessionLoading || filterLoading;
  const emptyCopy = emptyCopyFor(activeFilter, Boolean(workspaceId));
  const commitBar = (
    <CommitBar
      workspaceId={workspaceId}
      isRepo={isRepo}
      hasChanges={targetRows.length > 0}
      target={commitTarget}
      onTargetChange={setCommitTarget}
      stagedPaths={stagedPaths}
      added={totals.added}
      removed={totals.removed}
      blockedReason={conflicted ? t('code:changes.blockedReason') : null}
      onRefresh={onRefresh}
    />
  );

  /* The detail view and the list share the same footer (CommitBar keeps its
     message/history state while a diff is open). No modo "aba" o detalhe inline
     não é usado: o diff abre no centro. */
  const detail = selected && !onOpenDiffTab ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <IconButton label={t('code:changes.back')} size="sm" onClick={closeDiff}>
          <ArrowLeft aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground-muted">{t('code:changes.diffHeader')}</span>
      </div>
      <DiffView
        path={selected.path}
        diff={diffText}
        loading={diffLoading}
        error={diffError}
        className="min-h-0 flex-1"
      />
    </div>
  ) : null;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {detail ?? (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Toolbar stays outside the scroll area: it must not scroll with the
            list nor count towards the empty-state height. */}
        {isRepo ? (
          <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
            <ChangesFilterMenu
              value={activeFilter}
              onChange={(next) => setExplicitFilter(next)}
              commits={commits}
              commitsLoading={commitsLoading}
              branches={branches?.branches ?? null}
              currentBranch={branches?.current ?? null}
              branchesLoading={branchesLoading}
              branchesError={branchesError}
              onOpenBranches={() => void loadBranches()}
              className="min-w-0 flex-1"
            />
            <span
              className={cn(
                'shrink-0 text-[11px] tabular-nums text-foreground-subtle',
                compact && 'sr-only',
              )}
            >
              {t('code:changes.count', { count: visibleRows.length })}
            </span>
            {visibleStagedPaths.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-[11px]"
                loading={bulkBusy === 'unstage'}
                disabled={bulkBusy !== null || busyPath !== null}
                leftIcon={<Minus aria-hidden className="size-3.5" strokeWidth={2} />}
                onClick={() => void mutateAll('unstage')}
              >
                {t('code:changes.unstageAll')}
              </Button>
            ) : null}
            {visibleStageablePaths.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-[11px]"
                loading={bulkBusy === 'stage'}
                disabled={bulkBusy !== null || busyPath !== null || conflicted}
                title={
                  conflicted
                    ? t('code:changes.stageAllConflictTitle')
                    : t('code:changes.stageAllTitle')
                }
                leftIcon={<Plus aria-hidden className="size-3.5" strokeWidth={2} />}
                onClick={() => void mutateAll('stage')}
              >
                {t('code:changes.stageAll')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {gitError ? (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-border bg-danger-soft px-3 py-2 text-[11.5px] text-danger"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span>{gitError}</span>
          </div>
        ) : null}

        {gitStatus && !gitStatus.isRepo ? (
          <div className="flex shrink-0 items-start gap-2 border-b border-border bg-surface px-3 py-2 text-[11.5px] text-foreground-muted">
            <GitBranch aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span>
              <span className="font-medium text-foreground">{t('code:changes.notRepoTitle')}</span>{' '}
              {t('code:changes.notRepoDescription')}
            </span>
          </div>
        ) : null}

        {conflicted ? (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-border bg-warning-soft px-3 py-2 text-[11.5px] text-warning"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span>{t('code:changes.conflicts')}</span>
          </div>
        ) : null}

        {sessionError ? (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-border bg-danger-soft px-3 py-2 text-[11.5px] text-danger"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span>{sessionError}</span>
          </div>
        ) : null}

        {filterKind === 'commit' && commitError ? (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-border bg-danger-soft px-3 py-2 text-[11.5px] text-danger"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">{commitError}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              onClick={() => {
                if (filterCommitHash) void loadCommit(filterCommitHash);
              }}
            >
              Tentar novamente
            </Button>
          </div>
        ) : null}

        {filterKind === 'branch' && branchError ? (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-border bg-danger-soft px-3 py-2 text-[11.5px] text-danger"
          >
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">{branchError}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              onClick={() => {
                if (filterBranchBase) void loadBranch(filterBranchBase);
              }}
            >
              Tentar novamente
            </Button>
          </div>
        ) : null}

        {loading && visibleRows.length === 0 && !commitError && !branchError ? (
          <div aria-hidden className="shrink-0 space-y-1.5 p-2">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-6 animate-pulse rounded-md bg-surface-hover motion-reduce:animate-none"
                style={{ width: `${86 - row * 8}%` }}
              />
            ))}
          </div>
        ) : visibleRows.length === 0 && !commitError && !branchError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
            <FileDiff aria-hidden className="size-5 text-foreground-subtle" strokeWidth={1.75} />
            <p className="text-[12.5px] font-medium text-foreground">{emptyCopy.title}</p>
            <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">
              {emptyCopy.description}
            </p>
            {isRepo && !filterReadOnly ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-1"
                loading={branchButtonBusy}
                leftIcon={<GitBranch aria-hidden className="size-3.5" strokeWidth={1.75} />}
                onClick={() => void openBranchDiff()}
              >
                {t('code:changes.branchButton')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="shrink-0">
            {sections.map(({ group: groupId, rows: groupRows }) => {
              const label =
                groupId === 'commit' && activeFilter.kind === 'commit'
                  ? t('code:changesFilter.label.commit', { hash: shortHash(activeFilter.hash) })
                  : groupId === 'branch' && activeFilter.kind === 'branch'
                    ? t('code:changesFilter.label.branch', { name: activeFilter.base })
                    : t(GROUP_KEYS[groupId]);
              return (
                <section key={groupId} aria-label={label} className="border-b border-border">
                  <h3 className="sticky top-0 z-10 flex h-7 items-center gap-1.5 bg-surface px-3 text-[10.5px] font-medium uppercase tracking-wider text-foreground-subtle">
                    {label}
                    <span className="tabular-nums">({groupRows.length})</span>
                  </h3>
                  <ul>
                    {groupRows.map((row) => {
                      const badge =
                        row.origin === 'both'
                          ? t('code:changes.badge.sessionGitTitle')
                          : row.origin === 'session'
                            ? t('code:changes.badge.sessionTitle')
                            : null;
                      return (
                        <li
                          key={`${groupId}-${row.path}`}
                          className="group flex h-7 items-center gap-1 pr-1 hover:bg-surface-hover"
                        >
                          <button
                            type="button"
                            onClick={() => void openRow(row, { staged: groupId === 'staged' })}
                            title={row.path}
                            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                          >
                            <span
                              aria-hidden
                              className={cn(
                                'w-3 shrink-0 font-mono text-[11px] font-semibold',
                                STATUS_STYLES[row.status] ?? 'text-foreground-subtle',
                              )}
                            >
                              {row.status}
                            </span>
                            <FileIcon path={row.path} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate text-[12px] text-foreground-muted group-hover:text-foreground">
                              {row.path}
                            </span>
                            {badge ? (
                              <Badge
                                variant="accent"
                                size="sm"
                                title={t('code:changes.origin', { origin: badge })}
                                className="shrink-0"
                              >
                                {row.origin === 'both'
                                  ? t('code:changes.badge.both')
                                  : t('code:changes.badge.session')}
                              </Badge>
                            ) : null}
                            {row.added !== undefined || row.removed !== undefined ? (
                              <span className="shrink-0 text-[11px] tabular-nums">
                                <span className="text-success">+{row.added ?? 0}</span>{' '}
                                <span className="text-danger">−{row.removed ?? 0}</span>
                              </span>
                            ) : null}
                          </button>

                          {filterReadOnly ? null : (
                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
                              {groupId === 'staged' ? (
                                <IconButton
                                  label={t('code:changes.unstageFile', { path: row.path })}
                                  size="sm"
                                  disabled={busyPath === row.path || bulkBusy !== null}
                                  onClick={() => void mutate(row, 'unstage')}
                                >
                                  <Minus aria-hidden className="size-3.5" strokeWidth={2} />
                                </IconButton>
                              ) : (
                                <IconButton
                                  label={t('code:changes.stageFile', { path: row.path })}
                                  size="sm"
                                  disabled={busyPath === row.path || bulkBusy !== null || !isRepo}
                                  onClick={() => void mutate(row, 'stage')}
                                >
                                  <Plus aria-hidden className="size-3.5" strokeWidth={2} />
                                </IconButton>
                              )}
                              <IconButton
                                label={t('code:changes.revertFile', { path: row.path })}
                                size="sm"
                                disabled={busyPath === row.path || bulkBusy !== null}
                                onClick={() => setConfirmRow(row)}
                              >
                                <Undo2 aria-hidden className="size-3.5" strokeWidth={1.75} />
                              </IconButton>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
        </div>
      </div>
      )}

      {filterReadOnly ? null : commitBar}

      <Dialog
        open={confirmRow !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRow(null);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('code:changes.revertDialog.title')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="px-6 pb-4">
            {confirmRow
              ? t('code:changes.revertDialog.description', { path: confirmRow.path })
              : t('code:changes.revertDialog.descriptionGeneric')}
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRow(null)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="danger" size="sm" loading={reverting} onClick={() => void confirmRevert()}>
              {t('code:changes.revertDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ChangesPanel;
