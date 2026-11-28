import { beforeEach, describe, expect, it } from 'vitest';

import {
  dirtyBuffers,
  editorBufferKey,
  isBufferDirty,
  MAX_EDITOR_BUFFERS,
  useEditorStore,
  type EditorBufferInit,
} from '../editorStore';

function init(overrides: Partial<EditorBufferInit> = {}): EditorBufferInit {
  return {
    workspaceId: 'ws-1',
    path: 'src/app.ts',
    text: 'const a = 1;\n',
    eol: 'lf',
    hash: 'hash-1',
    indentation: { tabSize: 2, insertSpaces: true },
    ...overrides,
  };
}

const store = () => useEditorStore.getState();

beforeEach(() => {
  store().reset();
});

describe('editorStore', () => {
  it('creates a buffer once and keeps the live document', () => {
    const first = store().ensureBuffer(init());
    expect(first.savedText).toBe('const a = 1;\n');
    expect(isBufferDirty(first)).toBe(false);

    store().setText(first.key, 'const a = 2;\n');
    const again = store().ensureBuffer(init({ text: 'stale read\n' }));
    expect(again.text).toBe('const a = 2;\n');
    expect(isBufferDirty(again)).toBe(true);
  });

  it('marks saved versions and derives the dirty flag', () => {
    const buffer = store().ensureBuffer(init());
    store().setText(buffer.key, 'changed\n');
    expect(isBufferDirty(store().buffers[buffer.key])).toBe(true);

    store().markSaving(buffer.key);
    expect(store().buffers[buffer.key].status).toBe('saving');

    store().markSaved(buffer.key, { text: 'changed\n', hash: 'hash-2', eol: 'crlf' }, 42);
    const saved = store().buffers[buffer.key];
    expect(isBufferDirty(saved)).toBe(false);
    expect(saved.savedHash).toBe('hash-2');
    expect(saved.eol).toBe('crlf');
    expect(saved.lastSavedAt).toBe(42);
    expect(saved.status).toBe('idle');
  });

  it('keeps the buffer dirty when it changed during the save', () => {
    const buffer = store().ensureBuffer(init());
    store().setText(buffer.key, 'first\n');
    // The save wrote `first`, but the user kept typing.
    store().markSaved(buffer.key, { text: 'first\n', hash: 'h', eol: 'lf' });
    store().setText(buffer.key, 'second\n');
    expect(isBufferDirty(store().buffers[buffer.key])).toBe(true);
  });

  it('records save failures and conflicts', () => {
    const buffer = store().ensureBuffer(init());
    store().markSaveFailed(buffer.key, 'FS_STALE_VERSION: mudou');
    expect(store().buffers[buffer.key].status).toBe('error');
    expect(store().buffers[buffer.key].error).toContain('FS_STALE_VERSION');

    store().setConflict(buffer.key, true);
    expect(store().buffers[buffer.key].conflict).toBe(true);
    store().markSaved(buffer.key, { text: buffer.text, hash: 'h', eol: 'lf' });
    expect(store().buffers[buffer.key].conflict).toBe(false);
  });

  it('reloads from disk and clears history', () => {
    const buffer = store().ensureBuffer(init());
    store().setText(buffer.key, 'local\n');
    store().reloadFromDisk(buffer.key, { text: 'disk\n', hash: 'hash-disk', eol: 'lf' });
    const reloaded = store().buffers[buffer.key];
    expect(reloaded.text).toBe('disk\n');
    expect(isBufferDirty(reloaded)).toBe(false);
    expect(reloaded.history.undo).toHaveLength(0);
    expect(reloaded.conflict).toBe(false);
  });

  it('retargets a buffer after Save As', () => {
    const buffer = store().ensureBuffer(init());
    store().setText(buffer.key, 'novo conteudo\n');
    store().retarget(buffer.key, {
      workspaceId: 'ws-1',
      path: 'src/novo.ts',
      hash: 'hash-new',
      eol: 'lf',
    });

    const key = editorBufferKey('ws-1', 'src/novo.ts');
    expect(store().buffers[buffer.key]).toBeUndefined();
    expect(store().buffers[key].path).toBe('src/novo.ts');
    expect(store().buffers[key].text).toBe('novo conteudo\n');
  });

  it('drops a file and its children', () => {
    store().ensureBuffer(init());
    store().ensureBuffer(init({ path: 'src/lib/deep.ts' }));
    store().ensureBuffer(init({ path: 'other.ts' }));

    store().dropUnder('ws-1', 'src');
    const paths = Object.values(store().buffers).map((buffer) => buffer.path);
    expect(paths).toEqual(['other.ts']);
  });

  it('evicts clean buffers but never dirty ones', () => {
    for (let index = 0; index < MAX_EDITOR_BUFFERS + 3; index += 1) {
      const buffer = store().ensureBuffer(init({ path: `file-${index}.ts` }));
      if (index === 0) store().setText(buffer.key, 'keep me\n');
    }

    const paths = Object.values(store().buffers).map((buffer) => buffer.path);
    expect(paths.length).toBeLessThanOrEqual(MAX_EDITOR_BUFFERS + 1);
    expect(paths).toContain('file-0.ts');
  });

  it('lists dirty buffers by workspace', () => {
    const first = store().ensureBuffer(init());
    store().setText(first.key, 'x\n');
    store().ensureBuffer(init({ workspaceId: 'ws-2', path: 'b.ts' }));

    expect(dirtyBuffers(store().buffers, 'ws-1')).toHaveLength(1);
    expect(dirtyBuffers(store().buffers, 'ws-2')).toHaveLength(0);
    expect(dirtyBuffers(store().buffers)).toHaveLength(1);
  });
});
