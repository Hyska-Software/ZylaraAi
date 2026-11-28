// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { useAppStore, useEditorStore, useUiStore } from '@/lib/store';
import { editorBufferKey } from '@/lib/store/editorStore';
import type { Settings } from '@/lib/types';
import { useCodeFileClose } from './useCodeFileClose';

const mocks = vi.hoisted(() => ({ writeWorkspaceFile: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: { writeWorkspaceFile: mocks.writeWorkspaceFile } }));

const tab = { workspaceId: 'ws-1', path: 'src/app.ts' };
const key = editorBufferKey(tab.workspaceId, tab.path);

function openTab() {
  useUiStore.setState({
    codeFileTabs: [tab],
    codeFileTab: tab,
    secondaryCodeFileTab: null,
    codeView: 'file',
  });
}

function bufferInit(text = 'const a = 1;\n') {
  return {
    workspaceId: tab.workspaceId,
    path: tab.path,
    text,
    eol: 'lf' as const,
    hash: 'hash-1',
    indentation: { tabSize: 2, insertSpaces: true },
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.getState().reset();
  useAppStore.setState({ settings: { locale: 'pt-BR' } as Settings });
  mocks.writeWorkspaceFile.mockImplementation(async (_ws: string, path: string, text: string) => ({
    path,
    size: text.length,
    hash: 'hash-2',
    eol: 'lf',
  }));
});

describe('useCodeFileClose', () => {
  it('closes a clean tab immediately and drops its buffer', () => {
    openTab();
    useEditorStore.getState().ensureBuffer(bufferInit());
    const { result } = renderHook(() => useCodeFileClose());

    act(() => result.current.requestClose(tab));

    expect(result.current.pending).toBeNull();
    expect(useUiStore.getState().codeFileTabs).toHaveLength(0);
    expect(useEditorStore.getState().buffers[key]).toBeUndefined();
  });

  it('waits for the user when the buffer is dirty', () => {
    openTab();
    useEditorStore.getState().ensureBuffer(bufferInit());
    useEditorStore.getState().setText(key, 'local\n');
    const { result } = renderHook(() => useCodeFileClose());

    act(() => result.current.requestClose(tab));

    expect(result.current.pending?.paths).toEqual([tab.path]);
    expect(useUiStore.getState().codeFileTabs).toHaveLength(1);

    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();
    expect(useUiStore.getState().codeFileTabs).toHaveLength(1);
  });

  it('saves before closing', async () => {
    openTab();
    useEditorStore.getState().ensureBuffer(bufferInit());
    useEditorStore.getState().setText(key, 'local\n');
    const { result } = renderHook(() => useCodeFileClose());

    act(() => result.current.requestClose(tab));
    await act(async () => {
      await result.current.saveAndClose();
    });

    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith('ws-1', 'src/app.ts', 'local\n', {
      expectedHash: 'hash-1',
      eol: 'lf',
    });
    expect(useEditorStore.getState().buffers[key]).toBeUndefined();
  });

  it('keeps the tab open when the save is refused', async () => {
    mocks.writeWorkspaceFile.mockRejectedValueOnce('FS_STALE_VERSION: mudou');
    openTab();
    useEditorStore.getState().ensureBuffer(bufferInit());
    useEditorStore.getState().setText(key, 'local\n');
    const { result } = renderHook(() => useCodeFileClose());

    act(() => result.current.requestClose(tab));
    await act(async () => {
      await result.current.saveAndClose();
    });

    expect(useUiStore.getState().codeFileTabs).toHaveLength(1);
    expect(useEditorStore.getState().buffers[key].text).toBe('local\n');
    expect(useEditorStore.getState().buffers[key].conflict).toBe(true);
  });

  it('keeps the buffer while the file is still open in the split pane', () => {
    const other = { workspaceId: 'ws-1', path: 'src/other.ts' };
    useUiStore.setState({
      codeFileTabs: [other],
      codeFileTab: other,
      secondaryCodeFileTab: tab,
      codeView: 'file',
    });
    useEditorStore.getState().ensureBuffer(bufferInit());
    const { result } = renderHook(() => useCodeFileClose());

    act(() => result.current.requestClose(tab));

    expect(useEditorStore.getState().buffers[key]).toBeTruthy();
  });
});
