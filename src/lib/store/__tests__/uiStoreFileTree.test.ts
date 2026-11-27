import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../uiStore';

function reset(): void {
  useUiStore.setState({ codeFileTreeExpandedByWorkspace: {} });
  localStorage.removeItem('zylara.ui');
}

beforeEach(reset);

describe('uiStore — expanded directories of the Code Files tree', () => {
  it('starts with every directory collapsed', () => {
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({});
  });

  it('toggles a directory without affecting other workspaces', () => {
    const { toggleCodeFileTreePath } = useUiStore.getState();

    toggleCodeFileTreePath('ws-1', 'src');
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({
      'ws-1': ['src'],
    });

    toggleCodeFileTreePath('ws-2', 'apps');
    toggleCodeFileTreePath('ws-1', 'src/components');
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({
      'ws-1': ['src', 'src/components'],
      'ws-2': ['apps'],
    });

    toggleCodeFileTreePath('ws-1', 'src');
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace['ws-1']).toEqual([
      'src/components',
    ]);
  });

  it('replaces the whole expanded list without touching other workspaces', () => {
    useUiStore.getState().toggleCodeFileTreePath('ws-2', 'apps');
    useUiStore.getState().setCodeFileTreeExpanded('ws-1', [
      'src',
      ' src/components ',
      'src/components',
    ]);
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({
      'ws-1': ['src', 'src/components'],
      'ws-2': ['apps'],
    });

    useUiStore.getState().setCodeFileTreeExpanded('ws-1', []);
    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({
      'ws-2': ['apps'],
    });
  });

  it('drops empty workspaces and ignores blank targets', () => {
    const { toggleCodeFileTreePath } = useUiStore.getState();

    toggleCodeFileTreePath('ws-1', 'src');
    toggleCodeFileTreePath('ws-1', 'src');
    toggleCodeFileTreePath('  ', 'src');
    toggleCodeFileTreePath('ws-1', '   ');

    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({});
  });

  it('bounds the number of persisted paths per workspace', () => {
    const { toggleCodeFileTreePath } = useUiStore.getState();
    for (let index = 0; index < 205; index += 1) {
      toggleCodeFileTreePath('ws-1', `dir-${index}`);
    }

    const paths = useUiStore.getState().codeFileTreeExpandedByWorkspace['ws-1'];
    expect(paths).toHaveLength(200);
    expect(paths[0]).toBe('dir-5');
    expect(paths[199]).toBe('dir-204');
  });

  it('persists the state in the UI storage', () => {
    useUiStore.getState().toggleCodeFileTreePath('ws-1', 'src/components');

    const stored = JSON.parse(localStorage.getItem('zylara.ui') ?? '{}');
    expect(stored.state?.codeFileTreeExpandedByWorkspace).toEqual({
      'ws-1': ['src/components'],
    });
  });

  it('sanitizes malformed persisted values on rehydrate', async () => {
    localStorage.setItem(
      'zylara.ui',
      JSON.stringify({
        state: {
          codeFileTreeExpandedByWorkspace: {
            '': ['ignored'],
            'ws-1': [' src ', 'src', 42, '', 'nested/dir'],
            'ws-2': 'not-an-array',
          },
        },
        version: 0,
      }),
    );

    await useUiStore.persist.rehydrate();

    expect(useUiStore.getState().codeFileTreeExpandedByWorkspace).toEqual({
      'ws-1': ['src', 'nested/dir'],
    });
  });
});
