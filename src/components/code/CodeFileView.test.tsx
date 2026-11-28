// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkspaceFileContent } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  getFileDiffHead: vi.fn(),
  openWorkspaceInExplorer: vi.fn(),
  revealWorkspaceEntry: vi.fn(),
  listen: vi.fn(),
  decodeBase64: vi.fn(),
  loadPdf: vi.fn(),
  renderPdfPage: vi.fn(),
  isPdfRenderCancelled: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    readWorkspaceFile: mocks.readWorkspaceFile,
    writeWorkspaceFile: mocks.writeWorkspaceFile,
    getFileDiffHead: mocks.getFileDiffHead,
    openWorkspaceInExplorer: mocks.openWorkspaceInExplorer,
    revealWorkspaceEntry: mocks.revealWorkspaceEntry,
  },
}));

// The editor talks to the workspace watcher through this module.
vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

// O helper real carrega pdf.js + worker; aqui só interessa o contrato do viewer.
vi.mock('@/lib/pdf', () => ({
  decodeBase64: mocks.decodeBase64,
  loadPdf: mocks.loadPdf,
  renderPdfPage: mocks.renderPdfPage,
  isPdfRenderCancelled: mocks.isPdfRenderCancelled,
}));

import { useEditorStore } from '@/lib/store';
import { CodeFileView } from './CodeFileView';

const target = { workspaceId: 'ws-1', path: 'src/app.ts' };

function fileContent(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
  return {
    path: 'src/app.ts',
    text: 'const total = 1;\nexport default total;\n',
    truncated: false,
    size: 40,
    hash: 'hash-1',
    eol: 'lf',
    ...overrides,
  };
}

function pdfHandle(numPages = 2) {
  return {
    pdf: { numPages, getPage: vi.fn() },
    numPages,
    destroy: vi.fn(async () => undefined),
  };
}

function pdfRenderHandle() {
  return {
    promise: Promise.resolve({ width: 612, height: 792, pixelWidth: 612, pixelHeight: 792 }),
    cancel: vi.fn(),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByTestId('code-editor-textarea') as HTMLTextAreaElement;
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.getState().reset();
  // O conteúdo devolvido espelha o caminho pedido (como o backend real).
  mocks.readWorkspaceFile.mockImplementation(async (_workspaceId: string, path: string) =>
    fileContent({ path }),
  );
  mocks.writeWorkspaceFile.mockImplementation(async (_workspaceId: string, path: string, text: string) => ({
    path,
    size: text.length,
    hash: 'hash-2',
    eol: 'lf',
  }));
  mocks.getFileDiffHead.mockResolvedValue('');
  mocks.openWorkspaceInExplorer.mockResolvedValue(undefined);
  mocks.revealWorkspaceEntry.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async () => () => undefined);
  mocks.decodeBase64.mockReturnValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  mocks.loadPdf.mockResolvedValue(pdfHandle());
  mocks.renderPdfPage.mockImplementation(() => pdfRenderHandle());
  mocks.isPdfRenderCancelled.mockReturnValue(false);
});

describe('CodeFileView — editor', () => {
  it('opens a text file in the in-app editor', async () => {
    render(<CodeFileView target={target} />);

    expect(screen.getByRole('status', { name: 'Carregando arquivo' })).toBeTruthy();
    expect(await screen.findByTestId('code-editor-textarea')).toBeTruthy();
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith('ws-1', 'src/app.ts');
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    expect(textarea().value).toBe('const total = 1;\nexport default total;\n');
    // The editor does not need the HEAD diff; it offers "view changes" instead.
    expect(mocks.getFileDiffHead).not.toHaveBeenCalled();
  });

  it('marks the buffer dirty and saves with the loaded version as base', async () => {
    render(<CodeFileView target={target} />);
    await screen.findByTestId('code-editor-textarea');

    fireEvent.change(textarea(), { target: { value: 'const total = 2;\n' } });
    expect(screen.getByText('Não salvo')).toBeTruthy();

    fireEvent.keyDown(textarea(), { key: 's', ctrlKey: true });

    await waitFor(() =>
      expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith(
        'ws-1',
        'src/app.ts',
        'const total = 2;\n',
        { expectedHash: 'hash-1', eol: 'lf' },
      ),
    );
    expect(await screen.findByText('Salvo')).toBeTruthy();
  });

  it('keeps the header save button working', async () => {
    render(<CodeFileView target={target} />);
    await screen.findByTestId('code-editor-textarea');

    fireEvent.change(textarea(), { target: { value: 'a\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(mocks.writeWorkspaceFile).toHaveBeenCalledTimes(1));
  });

  it('warns when the file changed on disk and keeps the local edits', async () => {
    render(<CodeFileView target={target} />);
    await screen.findByTestId('code-editor-textarea');

    fireEvent.change(textarea(), { target: { value: 'local\n' } });
    await waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    const handler = mocks.listen.mock.calls[0][1] as (event: {
      payload: { workspaceId: string; paths: string[]; overflow: boolean };
    }) => void;

    mocks.readWorkspaceFile.mockResolvedValueOnce(
      fileContent({ text: 'agente\n', hash: 'hash-agent' }),
    );
    await act(async () => {
      handler({ payload: { workspaceId: 'ws-1', paths: ['src/app.ts'], overflow: false } });
      await new Promise((resolve) => setTimeout(resolve, 320));
    });

    expect(await screen.findByText('Arquivo alterado no disco')).toBeTruthy();
    expect(textarea().value).toBe('local\n');

    fireEvent.click(screen.getByRole('button', { name: 'Manter minha versão' }));
    await waitFor(() =>
      expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith('ws-1', 'src/app.ts', 'local\n', {
        expectedHash: null,
        eol: 'lf',
      }),
    );
  });

  it('reloads the file from disk discarding the buffer', async () => {
    render(<CodeFileView target={target} />);
    await screen.findByTestId('code-editor-textarea');

    fireEvent.change(textarea(), { target: { value: 'local\n' } });
    mocks.readWorkspaceFile.mockResolvedValueOnce(
      fileContent({ text: 'outro\n', hash: 'hash-3' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Recarregar do disco' }));

    await waitFor(() => expect(textarea().value).toBe('outro\n'));
    expect(screen.getByText('Salvo')).toBeTruthy();
  });

  it('shows the read error and retries', async () => {
    mocks.readWorkspaceFile.mockRejectedValueOnce('FS_NOT_FOUND: arquivo removido');
    render(<CodeFileView target={{ workspaceId: 'ws-1', path: 'src/sumiu.ts' }} />);

    expect(await screen.findByText('Não foi possível abrir o arquivo')).toBeTruthy();
    expect(screen.getByText(/FS_NOT_FOUND/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    expect(await screen.findByTestId('code-editor-textarea')).toBeTruthy();
    expect(mocks.readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it('discards a stale response when the target changes with a request in flight', async () => {
    const pending = deferred<WorkspaceFileContent>();
    mocks.readWorkspaceFile
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async () => fileContent({ path: 'src/novo.ts' }));

    const { rerender } = render(
      <CodeFileView target={{ workspaceId: 'ws-1', path: 'src/velho.ts' }} />,
    );
    rerender(<CodeFileView target={{ workspaceId: 'ws-1', path: 'src/novo.ts' }} />);

    expect(await screen.findByLabelText('Conteúdo de src/novo.ts')).toBeTruthy();

    await act(async () => {
      pending.resolve(fileContent({ path: 'src/velho.ts' }));
      await pending.promise;
    });

    expect(mocks.readWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Conteúdo de src/velho.ts')).toBeNull();
    expect(screen.getByLabelText('Conteúdo de src/novo.ts')).toBeTruthy();
  });
});

describe('CodeFileView — read-only previews', () => {
  it('keeps the inline diff marks for files that cannot be edited', async () => {
    mocks.readWorkspaceFile.mockResolvedValue(
      fileContent({ path: 'src/app.ts', text: 'a\nc\n', encoding: 'windows-1252', hash: null }),
    );
    mocks.getFileDiffHead.mockResolvedValue('@@ -1,2 +1,2 @@\n a\n-b\n+c');

    render(<CodeFileView target={target} />);

    expect(await screen.findByLabelText('Conteúdo de src/app.ts')).toBeTruthy();
    expect(mocks.getFileDiffHead).toHaveBeenCalledWith('ws-1', 'src/app.ts');
    expect(await screen.findByLabelText('Adições: 1, remoções: 1')).toBeTruthy();
    expect(screen.queryByTestId('code-editor-textarea')).toBeNull();
  });

  it('keeps the content when the diff fails and shows the warning', async () => {
    mocks.readWorkspaceFile.mockResolvedValue(
      fileContent({ path: 'src/app.ts', text: 'a\n', encoding: 'windows-1252', hash: null }),
    );
    mocks.getFileDiffHead.mockRejectedValueOnce('EXEC_FAILED: git falhou');

    render(<CodeFileView target={target} />);

    expect(await screen.findByLabelText('Conteúdo de src/app.ts')).toBeTruthy();
    expect(
      await screen.findByRole('img', { name: 'Não foi possível carregar as alterações' }),
    ).toBeTruthy();
  });

  it('opens the workspace folder from the preview header', async () => {
    mocks.readWorkspaceFile.mockResolvedValue(
      fileContent({ path: 'src/app.ts', text: 'a\n', encoding: 'windows-1252', hash: null }),
    );

    render(<CodeFileView target={target} />);
    await screen.findByLabelText('Conteúdo de src/app.ts');

    fireEvent.click(screen.getByRole('button', { name: 'Abrir no editor externo' }));

    expect(mocks.openWorkspaceInExplorer).toHaveBeenCalledWith('ws-1');
  });

  it('renders the real image preview', async () => {
    mocks.readWorkspaceFile.mockResolvedValue(
      fileContent({
        path: 'assets/logo.png',
        text: '',
        binary: true,
        size: 2048,
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
        hash: null,
      }),
    );

    render(<CodeFileView target={{ workspaceId: 'ws-1', path: 'assets/logo.png' }} />);

    expect(await screen.findByRole('toolbar', { name: 'Controles da imagem' })).toBeTruthy();
    const image = screen.getByAltText('assets/logo.png') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(screen.getByText('PNG')).toBeTruthy();
  });

  it('renders the PDF with pdf.js in the center tab', async () => {
    mocks.readWorkspaceFile.mockResolvedValue(
      fileContent({
        path: 'docs/manual.pdf',
        text: '',
        binary: true,
        size: 4096,
        mimeType: 'application/pdf',
        dataBase64: 'JVBERi0xLjQ=',
        hash: null,
      }),
    );

    render(<CodeFileView target={{ workspaceId: 'ws-1', path: 'docs/manual.pdf' }} />);

    expect(await screen.findByText('Página 1 de 2')).toBeTruthy();
    expect(mocks.readWorkspaceFile).toHaveBeenCalledWith('ws-1', 'docs/manual.pdf');
    expect(
      screen.getByRole('img', { name: 'Página 1 de 2 do PDF docs/manual.pdf' }).tagName,
    ).toBe('CANVAS');
  });

  it('shows an honest card when the backend omitted the payload', async () => {
    mocks.readWorkspaceFile.mockResolvedValue(
      fileContent({
        path: 'docs/imenso.pdf',
        text: '',
        binary: true,
        size: 30 * 1024 * 1024,
        mimeType: 'application/pdf',
        previewOmitted: true,
        hash: null,
      }),
    );

    render(<CodeFileView target={{ workspaceId: 'ws-1', path: 'docs/imenso.pdf' }} />);

    expect(await screen.findByText('Prévia não disponível')).toBeTruthy();
    expect(screen.getByText(/30 MB/)).toBeTruthy();
    expect(mocks.loadPdf).not.toHaveBeenCalled();
  });
});
