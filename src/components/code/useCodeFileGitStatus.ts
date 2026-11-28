/**
 * Git status for the Code file tabs. The tab strip stays mounted even when the
 * Changes panel is closed, so it owns a small status read instead of borrowing
 * the panel hook (which would also reload the tree/commit log).
 *
 * Refreshes are event-driven only: workspace-change batches from the backend,
 * an explicit notification after Code mutations, and window focus. No polling
 * and no second filesystem watcher — the watcher registry is not ref-counted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { api } from '@/lib/api';
import type { WorkspaceChangedEvent, WorkspaceGitStatus } from '@/lib/types';
import { WORKSPACE_CHANGED_EVENT } from './useWorkspaceWatch';

/** Local window event used by Code surfaces after a git mutation or a save. */
export const CODE_GIT_REFRESH_EVENT = 'zylara:code-git-refresh';

export function notifyCodeGitRefresh(workspaceId: string | null | undefined): void {
  if (typeof window === 'undefined' || !workspaceId) return;
  window.dispatchEvent(new CustomEvent(CODE_GIT_REFRESH_EVENT, { detail: workspaceId }));
}

export interface CodeFileGitStatusResult {
  status: WorkspaceGitStatus | null;
  refresh: () => Promise<void>;
}

export function useCodeFileGitStatus(
  workspaceId: string | null | undefined,
): CodeFileGitStatusResult {
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const runRef = useRef(0);
  const activeRef = useRef<string | null>(workspaceId ?? null);
  activeRef.current = workspaceId ?? null;

  const load = useCallback(async () => {
    const id = workspaceId ?? null;
    const run = runRef.current + 1;
    runRef.current = run;
    if (!id) {
      setStatus(null);
      return;
    }
    try {
      const next = await api.gitStatus(id);
      if (run === runRef.current && activeRef.current === id) setStatus(next ?? null);
    } catch {
      if (run === runRef.current && activeRef.current === id) setStatus(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<WorkspaceChangedEvent>(WORKSPACE_CHANGED_EVENT, ({ payload }) => {
      if (!disposed && payload?.workspaceId === workspaceId) void load();
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<string | null>).detail;
      if (detail === workspaceId) void load();
    };
    const onFocus = () => void load();
    window.addEventListener(CODE_GIT_REFRESH_EVENT, onRefresh);
    window.addEventListener('focus', onFocus);

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(CODE_GIT_REFRESH_EVENT, onRefresh);
      window.removeEventListener('focus', onFocus);
    };
  }, [workspaceId, load]);

  return { status, refresh: load };
}
