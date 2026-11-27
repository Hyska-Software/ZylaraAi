import { beforeEach, describe, expect, it } from 'vitest';
import { codeFileTabKey, useUiStore } from '../uiStore';

function reset(): void {
  useUiStore.setState({
    codeView: 'session',
    codeFileTab: null,
    codeFileTabs: [],
    secondaryCodeFileTab: null,
    codeFileWrap: false,
    codeDiffTab: null,
  });
}

beforeEach(reset);

describe('uiStore — arquivos como abas centrais', () => {
  it('abre o primeiro arquivo no centro e marca a view', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/app.ts' });

    const state = useUiStore.getState();
    expect(state.codeView).toBe('file');
    expect(state.codeFileTabs).toEqual([{ workspaceId: 'ws-1', path: 'src/app.ts' }]);
    expect(state.codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'src/app.ts' });
  });

  it('acumula abas em vez de substituir o arquivo aberto', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/app.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/lib.rs' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-2', path: 'README.md' });

    const state = useUiStore.getState();
    expect(state.codeFileTabs).toEqual([
      { workspaceId: 'ws-1', path: 'src/app.ts' },
      { workspaceId: 'ws-1', path: 'src/lib.rs' },
      { workspaceId: 'ws-2', path: 'README.md' },
    ]);
    expect(state.codeFileTab).toEqual({ workspaceId: 'ws-2', path: 'README.md' });
    expect(state.codeView).toBe('file');
  });

  it('reabrir um arquivo já aberto só o ativa (sem duplicar a aba)', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/app.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/lib.rs' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'src/app.ts' });

    const state = useUiStore.getState();
    expect(state.codeFileTabs).toHaveLength(2);
    expect(state.codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'src/app.ts' });
    // Mesmo caminho em outro workspace é outra aba.
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-2', path: 'src/app.ts' });
    expect(useUiStore.getState().codeFileTabs).toHaveLength(3);
  });

  it('fecha a aba ativa e ativa a vizinha, mantendo a view de arquivo', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'c.ts' });

    useUiStore.getState().closeCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });

    const state = useUiStore.getState();
    expect(state.codeFileTabs.map((tab) => tab.path)).toEqual(['a.ts', 'c.ts']);
    expect(state.codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'c.ts' });
    expect(state.codeView).toBe('file');
  });

  it('fechar a última aba volta para a sessão', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().closeCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });

    const state = useUiStore.getState();
    expect(state.codeFileTabs).toEqual([]);
    expect(state.codeFileTab).toBeNull();
    expect(state.codeView).toBe('session');
  });

  it('fechar uma aba em segundo plano não muda a aba ativa nem a view', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });

    useUiStore.getState().closeCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });

    const state = useUiStore.getState();
    expect(state.codeFileTabs.map((tab) => tab.path)).toEqual(['b.ts']);
    expect(state.codeFileTab).toEqual({ workspaceId: 'ws-1', path: 'b.ts' });
    expect(state.codeView).toBe('file');
  });

  it('fechar a aba ativa em segundo plano (view diff) mantém o diff no centro', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });
    useUiStore.getState().openCodeDiff({ workspaceId: 'ws-1', path: 'a.ts', staged: false });

    useUiStore.getState().closeCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });

    expect(useUiStore.getState().codeView).toBe('diff');
    expect(useUiStore.getState().codeFileTab?.path).toBe('a.ts');

    // Fechar a última aba de arquivo também não tira o usuário do diff.
    useUiStore.getState().closeCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    expect(useUiStore.getState().codeView).toBe('diff');
    expect(useUiStore.getState().codeFileTab).toBeNull();
  });

  it('closeCodeFile() sem alvo fecha a aba ativa (compatibilidade)', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'b.ts' });

    useUiStore.getState().closeCodeFile();

    expect(useUiStore.getState().codeFileTabs.map((tab) => tab.path)).toEqual(['a.ts']);
    expect(useUiStore.getState().codeFileTab?.path).toBe('a.ts');
  });

  it('setCodeView aceita file e cai em session para o resto', () => {
    useUiStore.getState().setCodeView('file');
    expect(useUiStore.getState().codeView).toBe('file');
    useUiStore.getState().setCodeView('session');
    expect(useUiStore.getState().codeView).toBe('session');
  });

  it('opens a file to the side and closes only the secondary pane', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFileToSide({ workspaceId: 'ws-1', path: 'b.ts' });

    expect(useUiStore.getState().secondaryCodeFileTab).toEqual({
      workspaceId: 'ws-1',
      path: 'b.ts',
    });
    expect(useUiStore.getState().codeFileTab?.path).toBe('a.ts');
    expect(useUiStore.getState().codeView).toBe('file');

    useUiStore.getState().closeSecondaryCodeFile();
    expect(useUiStore.getState().secondaryCodeFileTab).toBeNull();
    expect(useUiStore.getState().codeFileTab?.path).toBe('a.ts');
  });

  it('a regular open replaces the split editor', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFileToSide({ workspaceId: 'ws-1', path: 'b.ts' });
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'c.ts' });

    expect(useUiStore.getState().secondaryCodeFileTab).toBeNull();
    expect(useUiStore.getState().codeFileTab?.path).toBe('c.ts');
  });

  it('closing the active tab also closes the secondary pane', () => {
    useUiStore.getState().openCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });
    useUiStore.getState().openCodeFileToSide({ workspaceId: 'ws-1', path: 'b.ts' });
    useUiStore.getState().closeCodeFile({ workspaceId: 'ws-1', path: 'a.ts' });

    expect(useUiStore.getState().secondaryCodeFileTab).toBeNull();
  });

  it('a chave da aba é estável por workspace + caminho', () => {
    expect(codeFileTabKey({ workspaceId: 'ws-1', path: 'a.ts' })).toBe(
      codeFileTabKey({ workspaceId: 'ws-1', path: 'a.ts' }),
    );
    expect(codeFileTabKey({ workspaceId: 'ws-1', path: 'a.ts' })).not.toBe(
      codeFileTabKey({ workspaceId: 'ws-2', path: 'a.ts' }),
    );
  });
});

describe('uiStore — quebra de linha global dos arquivos', () => {
  it('começa desligada e alterna para todas as abas', () => {
    expect(useUiStore.getState().codeFileWrap).toBe(false);

    useUiStore.getState().setCodeFileWrap(true);
    expect(useUiStore.getState().codeFileWrap).toBe(true);

    useUiStore.getState().setCodeFileWrap(false);
    expect(useUiStore.getState().codeFileWrap).toBe(false);
  });

  it('persiste a preferência no storage da UI', () => {
    useUiStore.getState().setCodeFileWrap(true);

    const stored = JSON.parse(window.localStorage.getItem('zylara.ui') ?? '{}');
    expect(stored.state?.codeFileWrap).toBe(true);
  });
});
