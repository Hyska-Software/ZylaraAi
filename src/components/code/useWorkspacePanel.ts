import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import type {
  WorkspaceFileEntry,
  WorkspaceGitCommit,
  WorkspaceGitStatus,
  WorkspaceTreeSnapshot,
} from '@/lib/types';

export interface WorkspacePanelDiff {
  /** Lane showing the diff (`null` = nothing open). */
  path: string | null;
  staged: boolean;
  text: string;
  loading: boolean;
  error: string | null;
}

export interface UseWorkspacePanelOptions {
  /** Commit log size (default 20). */
  commitLimit?: number;
}

/** Options of a snapshot refresh (manual `⟳`, panel actions and the watcher). */
export interface WorkspacePanelRefreshOptions {
  /** Lazily loaded directories to reload together with the root tree. */
  dirs?: string[];
  /** `false` keeps `filesLoading`/`gitLoading` untouched (background refresh, no skeleton). Default `true`. */
  foreground?: boolean;
  /** `false` skips `gitLog` (watcher batches). Default `true`. */
  reloadCommits?: boolean;
}

export interface UseWorkspacePanelResult {
  workspaceId: string | null;
  files: WorkspaceFileEntry[];
  /** Total entries found by the backend before its budget cut; `null` when unknown. */
  fileTotal: number | null;
  /** True when the backend truncated the tree listing. */
  filesTruncated: boolean;
  gitStatus: WorkspaceGitStatus | null;
  commits: WorkspaceGitCommit[];
  /** True while files or git status are being (re)loaded. */
  loading: boolean;
  filesLoading: boolean;
  gitLoading: boolean;
  commitsLoading: boolean;
  filesError: string | null;
  gitError: string | null;
  commitsError: string | null;
  /** `gitStatus.isRepo` when known, `false` otherwise. */
  isRepo: boolean;
  diff: WorkspacePanelDiff;
  /**
   * Reloads the tree, `git status` and (optionally) the commit log through a
   * single backend snapshot. Resolves with the snapshot, or `null` when the
   * workspace is absent or a newer refresh superseded this one.
   */
  refresh: (options?: WorkspacePanelRefreshOptions) => Promise<WorkspaceTreeSnapshot | null>;
  /** Loads the unified diff of one file (uses the container's known diff when given). */
  openDiff: (path: string, options?: { staged?: boolean; knownDiff?: string | null }) => Promise<void>;
  closeDiff: () => void;
}

const EMPTY_DIFF: WorkspacePanelDiff = {
  path: null,
  staged: false,
  text: '',
  loading: false,
  error: null,
};

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/**
 * Data hook of the Code right panel (WORKBENCH §7): loads the workspace file
 * tree, git status and commit log through `@/lib/api`, exposes per-file diff
 * loading and a `refresh()` used after stage/unstage/revert/commit.
 *
 * The container owns the workspace choice; passing `null` resets every piece
 * of state without touching the API (honest empty state).
 */
export function useWorkspacePanel(
  workspaceId: string | null | undefined,
  options: UseWorkspacePanelOptions = {},
): UseWorkspacePanelResult {
  const { commitLimit = 20 } = options;
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [fileTotal, setFileTotal] = useState<number | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [commits, setCommits] = useState<WorkspaceGitCommit[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspacePanelDiff>(EMPTY_DIFF);

  const loadRun = useRef(0);
  const diffRun = useRef(0);

  const load = useCallback(
    async (
      options: WorkspacePanelRefreshOptions = {},
    ): Promise<WorkspaceTreeSnapshot | null> => {
      const run = loadRun.current + 1;
      loadRun.current = run;
      const { dirs = [], foreground = true, reloadCommits = true } = options;

      if (!workspaceId) {
        setFiles([]);
        setFileTotal(null);
        setFilesTruncated(false);
        setGitStatus(null);
        setCommits([]);
        setFilesLoading(false);
        setGitLoading(false);
        setCommitsLoading(false);
        setFilesError(null);
        setGitError(null);
        setCommitsError(null);
        return null;
      }

      if (foreground) {
        setFilesLoading(true);
        setGitLoading(true);
        setFilesError(null);
        setGitError(null);
      }

      let snapshot: WorkspaceTreeSnapshot;
      try {
        snapshot = await api.refreshWorkspaceTree(workspaceId, dirs);
      } catch (error) {
        if (run !== loadRun.current) return null;
        const message = describeError(error, t('code:panelData.filesError'));
        setFiles([]);
        setFileTotal(null);
        setFilesTruncated(false);
        setFilesError(message);
        setGitStatus(null);
        setGitError(message);
        setCommits([]);
        setCommitsError(null);
        setFilesLoading(false);
        setGitLoading(false);
        setCommitsLoading(false);
        return null;
      }
      if (run !== loadRun.current) return null;

      setFiles(snapshot.files ?? []);
      setFileTotal(snapshot.totalCount ?? null);
      setFilesTruncated(snapshot.truncated ?? false);
      setFilesLoading(false);
      setGitStatus(snapshot.gitStatus);
      setGitError(null);
      setGitLoading(false);

      if (!snapshot.gitStatus?.isRepo) {
        setCommits([]);
        setCommitsError(null);
        setCommitsLoading(false);
        return snapshot;
      }
      if (!reloadCommits) return snapshot;

      setCommitsLoading(true);
      try {
        const log = await api.gitLog(workspaceId, commitLimit);
        if (run !== loadRun.current) return null;
        setCommits(log ?? []);
        setCommitsError(null);
      } catch (error) {
        if (run !== loadRun.current) return null;
        setCommits([]);
        setCommitsError(describeError(error, t('code:panelData.commitsError')));
      } finally {
        if (run === loadRun.current) setCommitsLoading(false);
      }
      return snapshot;
    },
    [workspaceId, commitLimit],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    /* A workspace switch closes any open diff and invalidates in-flight loads. */
    diffRun.current += 1;
    setDiff(EMPTY_DIFF);
  }, [workspaceId]);

  const refresh = useCallback(
    (options?: WorkspacePanelRefreshOptions) => load(options),
    [load],
  );

  const openDiff = useCallback(
    async (
      path: string,
      options: { staged?: boolean; knownDiff?: string | null } = {},
    ): Promise<void> => {
      const staged = options.staged ?? false;
      const run = diffRun.current + 1;
      diffRun.current = run;

      if (options.knownDiff != null) {
        setDiff({ path, staged, text: options.knownDiff, loading: false, error: null });
        return;
      }
      if (!workspaceId) {
        setDiff({
          path,
          staged,
          text: '',
          loading: false,
          error: t('code:panelData.noWorkspaceDiff'),
        });
        return;
      }

      setDiff({ path, staged, text: '', loading: true, error: null });
      try {
        const text = await api.getFileDiff(workspaceId, path, staged);
        if (run !== diffRun.current) return;
        setDiff({ path, staged, text: text ?? '', loading: false, error: null });
      } catch (error) {
        if (run !== diffRun.current) return;
        setDiff({
          path,
          staged,
          text: '',
          loading: false,
          error: describeError(error, t('code:panelData.diffError')),
        });
      }
    },
    [workspaceId],
  );

  const closeDiff = useCallback(() => {
    diffRun.current += 1;
    setDiff(EMPTY_DIFF);
  }, []);

  return {
    workspaceId: workspaceId ?? null,
    files,
    fileTotal,
    filesTruncated,
    gitStatus,
    commits,
    loading: filesLoading || gitLoading,
    filesLoading,
    gitLoading,
    commitsLoading,
    filesError,
    gitError,
    commitsError,
    isRepo: gitStatus?.isRepo ?? false,
    diff,
    refresh,
    openDiff,
    closeDiff,
  };
}

export default useWorkspacePanel;
