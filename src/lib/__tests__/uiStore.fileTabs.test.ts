import { beforeEach, describe, expect, it } from 'vitest';

import { codeFileTabKey, useUiStore, type CodeFileTab } from '../store';

const first: CodeFileTab = { workspaceId: 'ws-1', path: 'src/a.ts' };
const second: CodeFileTab = { workspaceId: 'ws-1', path: 'src/b.ts' };

beforeEach(() => {
  useUiStore.setState({
    codeFileTabs: [],
    codeFileTab: null,
    secondaryCodeFileTab: null,
    codeView: 'session',
  });
});

describe('uiStore — file tabs (editor)', () => {
  it('opens a tab per file and activates an already open one', () => {
    useUiStore.getState().openCodeFile(first);
    useUiStore.getState().openCodeFile(second);
    useUiStore.getState().openCodeFile(first);

    const state = useUiStore.getState();
    expect(state.codeFileTabs.map(codeFileTabKey)).toEqual([
      codeFileTabKey(first),
      codeFileTabKey(second),
    ]);
    expect(state.codeFileTab).toEqual(first);
    expect(state.codeView).toBe('file');
  });

  it('retargets the tab after Save As, keeping the position', () => {
    useUiStore.getState().openCodeFile(first);
    useUiStore.getState().openCodeFile(second);
    const renamed: CodeFileTab = { workspaceId: 'ws-1', path: 'src/a-copy.ts' };

    useUiStore.getState().retargetCodeFile(first, renamed);

    const state = useUiStore.getState();
    expect(state.codeFileTabs.map(codeFileTabKey)).toEqual([
      codeFileTabKey(renamed),
      codeFileTabKey(second),
    ]);
    expect(state.codeView).toBe('file');
  });

  it('retargets the active tab and the split pane', () => {
    useUiStore.getState().openCodeFile(first);
    useUiStore.getState().openCodeFileToSide(first);
    const renamed: CodeFileTab = { workspaceId: 'ws-1', path: 'src/a-copy.ts' };

    useUiStore.getState().retargetCodeFile(first, renamed);

    const state = useUiStore.getState();
    expect(state.codeFileTab).toEqual(renamed);
    expect(state.secondaryCodeFileTab).toEqual(renamed);
    expect(state.codeFileTabs).toHaveLength(1);
    expect(codeFileTabKey(state.codeFileTabs[0])).toBe(codeFileTabKey(renamed));
  });

  it('closes the active tab to its neighbour and then back to the session', () => {
    useUiStore.getState().openCodeFile(first);
    useUiStore.getState().openCodeFile(second);

    useUiStore.getState().closeCodeFile(second);
    expect(useUiStore.getState().codeFileTab).toEqual(first);

    useUiStore.getState().closeCodeFile();
    expect(useUiStore.getState().codeFileTabs).toEqual([]);
    expect(useUiStore.getState().codeFileTab).toBeNull();
    expect(useUiStore.getState().codeView).toBe('session');
  });
});
