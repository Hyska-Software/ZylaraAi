// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { WorkspaceChangedEvent, WorkspaceGitStatus } from '@/lib/types';

const mocks = vi.hoisted(() => ({ gitStatus: vi.fn() }));

const listeners: Array<(event: { payload: WorkspaceChangedEvent }) => void> = [];

vi.mock('@/lib/api', () => ({ api: mocks }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (_name: string, handler: (event: { payload: WorkspaceChangedEvent }) => void) => {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  ),
}));

import { notifyCodeGitRefresh, useCodeFileGitStatus } from './useCodeFileGitStatus';

function status(branch: string): WorkspaceGitStatus {
  return {
    isRepo: true,
    branch,
    staged: [],
    unstaged: [{ path: 'src/a.ts', status: 'M' }],
    untracked: [],
    conflicted: [],
  };
}

function emitWorkspaceChanged(payload: WorkspaceChangedEvent): void {
  for (const handler of [...listeners]) handler({ payload });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
  mocks.gitStatus.mockResolvedValue(status('main'));
});

describe('useCodeFileGitStatus', () => {
  it('loads the status of the active workspace', async () => {
    const { result } = renderHook(() => useCodeFileGitStatus('ws-1'));
    await waitFor(() => expect(result.current.status?.branch).toBe('main'));
    expect(mocks.gitStatus).toHaveBeenCalledWith('ws-1');
  });

  it('does not call the backend without a workspace', async () => {
    const { result } = renderHook(() => useCodeFileGitStatus(null));
    await act(async () => {});
    expect(result.current.status).toBeNull();
    expect(mocks.gitStatus).not.toHaveBeenCalled();
  });

  it('refreshes on workspace changes of the same workspace only', async () => {
    const { result } = renderHook(() => useCodeFileGitStatus('ws-1'));
    await waitFor(() => expect(result.current.status?.branch).toBe('main'));
    await waitFor(() => expect(listeners.length).toBe(1));

    mocks.gitStatus.mockResolvedValue(status('feature'));
    emitWorkspaceChanged({ workspaceId: 'ws-2', paths: [], overflow: false });
    expect(mocks.gitStatus).toHaveBeenCalledTimes(1);

    emitWorkspaceChanged({ workspaceId: 'ws-1', paths: ['.git/index'], overflow: false });
    await waitFor(() => expect(result.current.status?.branch).toBe('feature'));
    expect(mocks.gitStatus).toHaveBeenCalledTimes(2);
  });

  it('refreshes on an explicit Code notification', async () => {
    const { result } = renderHook(() => useCodeFileGitStatus('ws-1'));
    await waitFor(() => expect(result.current.status?.branch).toBe('main'));
    mocks.gitStatus.mockResolvedValue(status('feature'));

    act(() => notifyCodeGitRefresh('ws-1'));
    await waitFor(() => expect(result.current.status?.branch).toBe('feature'));
  });

  it('ignores a late response from a superseded request', async () => {
    const first = deferred<WorkspaceGitStatus>();
    const second = deferred<WorkspaceGitStatus>();
    mocks.gitStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useCodeFileGitStatus('ws-1'));
    await waitFor(() => expect(mocks.gitStatus).toHaveBeenCalledTimes(1));

    act(() => notifyCodeGitRefresh('ws-1'));
    await waitFor(() => expect(mocks.gitStatus).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(status('newest'));
      await second.promise;
    });
    await waitFor(() => expect(result.current.status?.branch).toBe('newest'));

    await act(async () => {
      first.resolve(status('stale'));
      await first.promise;
    });
    expect(result.current.status?.branch).toBe('newest');
  });

  it('clears the status on a failed refresh', async () => {
    const { result } = renderHook(() => useCodeFileGitStatus('ws-1'));
    await waitFor(() => expect(result.current.status?.branch).toBe('main'));
    mocks.gitStatus.mockRejectedValueOnce(new Error('git failed'));

    act(() => notifyCodeGitRefresh('ws-1'));
    await waitFor(() => expect(result.current.status).toBeNull());
  });
});
