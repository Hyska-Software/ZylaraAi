// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { editorPreferences } from '@/lib/editorSettings';
import { useEditorStore } from '@/lib/store';
import type { Settings } from '@/lib/types';
import { editorBufferKey } from '@/lib/store/editorStore';
import { useFileEditor } from './useFileEditor';

const mocks = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    readWorkspaceFile: mocks.readWorkspaceFile,
    writeWorkspaceFile: mocks.writeWorkspaceFile,
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

const settings = { locale: 'pt-BR' } as Settings;
const preferences = editorPreferences(settings);
const workspaceId = 'ws-1';
const path = 'src/app.ts';
const key = editorBufferKey(workspaceId, path);

function content(text = 'const a = 1;\n', hash = 'hash-1') {
  return {
    path,
    text,
    truncated: false,
    size: text.length,
    hash,
    eol: 'lf' as const,
  };
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.getState().reset();
  mocks.readWorkspaceFile.mockResolvedValue(content());
  mocks.writeWorkspaceFile.mockImplementation(async (_ws: string, target: string, text: string) => ({
    path: target,
    size: text.length,
    hash: 'hash-written',
    eol: 'lf',
  }));
  mocks.listen.mockImplementation(async () => () => undefined);
});

describe('useFileEditor', () => {
  it('creates the buffer from the disk read', async () => {
    const { result } = renderHook(() => useFileEditor({ workspaceId, path, preferences }));

    await waitFor(() => expect(result.current.buffer).not.toBeNull());
    expect(result.current.buffer?.text).toBe('const a = 1;\n');
    expect(result.current.buffer?.savedHash).toBe('hash-1');
    expect(result.current.dirty).toBe(false);
    expect(result.current.readOnlyReason).toBeNull();
  });

  it('saves the buffer with the loaded version as base', async () => {
    const { result } = renderHook(() => useFileEditor({ workspaceId, path, preferences }));
    await waitFor(() => expect(result.current.buffer).not.toBeNull());

    act(() => useEditorStore.getState().setText(key, 'novo\n'));
    let saved = false;
    await act(async () => {
      saved = await result.current.save();
    });

    expect(saved).toBe(true);
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith(workspaceId, path, 'novo\n', {
      expectedHash: 'hash-1',
      eol: 'lf',
    });
    expect(useEditorStore.getState().buffers[key].savedText).toBe('novo\n');
    expect(useEditorStore.getState().buffers[key].savedHash).toBe('hash-written');
  });

  it('turns a refused save into a conflict', async () => {
    mocks.writeWorkspaceFile.mockRejectedValueOnce('FS_STALE_VERSION: mudou no disco');
    const { result } = renderHook(() => useFileEditor({ workspaceId, path, preferences }));
    await waitFor(() => expect(result.current.buffer).not.toBeNull());

    act(() => useEditorStore.getState().setText(key, 'local\n'));
    await act(async () => {
      await result.current.save();
    });

    const buffer = useEditorStore.getState().buffers[key];
    expect(buffer.conflict).toBe(true);
    expect(buffer.status).toBe('error');
    expect(buffer.text).toBe('local\n');
  });

  it('saves as a new file and retargets the buffer', async () => {
    const { result } = renderHook(() => useFileEditor({ workspaceId, path, preferences }));
    await waitFor(() => expect(result.current.buffer).not.toBeNull());
    act(() => useEditorStore.getState().setText(key, 'copia\n'));
    // The target does not exist yet.
    mocks.readWorkspaceFile.mockRejectedValueOnce('FS_NOT_FOUND: nao existe');

    let written: string | null = null;
    await act(async () => {
      written = await result.current.saveAs('src/copia.ts');
    });

    expect(written).toBe('src/copia.ts');
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith(workspaceId, 'src/copia.ts', 'copia\n', {
      expectedHash: null,
      eol: 'lf',
    });
    const nextKey = editorBufferKey(workspaceId, 'src/copia.ts');
    expect(useEditorStore.getState().buffers[key]).toBeUndefined();
    expect(useEditorStore.getState().buffers[nextKey].savedText).toBe('copia\n');
  });

  it('refuses to overwrite an existing file on Save as', async () => {
    const { result } = renderHook(() => useFileEditor({ workspaceId, path, preferences }));
    await waitFor(() => expect(result.current.buffer).not.toBeNull());
    act(() => useEditorStore.getState().setText(key, 'copia\n'));

    let written: string | null = 'unset';
    await act(async () => {
      written = await result.current.saveAs('src/existente.ts');
    });

    expect(written).toBeNull();
    expect(mocks.writeWorkspaceFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().buffers[key].status).toBe('error');
    expect(useEditorStore.getState().buffers[key].error).toContain('src/existente.ts');
  });

  it('reverts the buffer to the last saved version', async () => {
    const { result } = renderHook(() => useFileEditor({ workspaceId, path, preferences }));
    await waitFor(() => expect(result.current.buffer).not.toBeNull());
    act(() => useEditorStore.getState().setText(key, 'local\n'));

    act(() => result.current.revert());

    expect(useEditorStore.getState().buffers[key].text).toBe('const a = 1;\n');
    expect(useEditorStore.getState().buffers[key].conflict).toBe(false);
  });

  it('auto saves after the configured idle delay', async () => {
    const autoPreferences = editorPreferences({
      ...settings,
      editorAutoSave: 'delay',
      editorAutoSaveDelay: 200,
    } as Settings);
    const { result } = renderHook(() =>
      useFileEditor({ workspaceId, path, preferences: autoPreferences }),
    );
    await waitFor(() => expect(result.current.buffer).not.toBeNull());

    act(() => useEditorStore.getState().setText(key, 'auto\n'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });

    expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().buffers[key].savedText).toBe('auto\n');
  });
});
