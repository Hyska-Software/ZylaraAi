// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceFileContent } from '@/lib/types';

const utilsMocks = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));
const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const pdfMocks = vi.hoisted(() => ({
  decodeBase64: vi.fn(),
  loadPdf: vi.fn(),
  renderPdfPage: vi.fn(),
  isPdfRenderCancelled: vi.fn(),
}));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, copyText: utilsMocks.copyText };
});
vi.mock('sonner', () => ({ toast: toastMocks }));
// O helper real carrega pdf.js + worker; aqui só interessa o contrato do viewer.
vi.mock('@/lib/pdf', () => ({
  decodeBase64: pdfMocks.decodeBase64,
  loadPdf: pdfMocks.loadPdf,
  renderPdfPage: pdfMocks.renderPdfPage,
  isPdfRenderCancelled: pdfMocks.isPdfRenderCancelled,
}));

import { useUiStore } from '@/lib/store';
import { FilePreview, languageForPath } from './FilePreview';

function content(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
  return {
    path: 'src/app.ts',
    text: 'const total = 1;\nexport default total;\n',
    truncated: false,
    size: 48,
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

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  utilsMocks.copyText.mockResolvedValue(true);
  pdfMocks.decodeBase64.mockReturnValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  pdfMocks.loadPdf.mockResolvedValue(pdfHandle());
  pdfMocks.renderPdfPage.mockImplementation(() => pdfRenderHandle());
  pdfMocks.isPdfRenderCancelled.mockReturnValue(false);
  // Preferência global do workbench (persistida no store).
  useUiStore.setState({ codeFileWrap: false });
});

describe('FilePreview', () => {
  it('renders the highlighted source with line numbers and the language badge', () => {
    render(<FilePreview content={content()} />);
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('TypeScript')).toBeTruthy();
    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    expect(pre).toBeTruthy();
    // One rendered row per source line (line numbers are in the gutter).
    expect(pre.querySelectorAll(':scope > div').length).toBe(3);
    expect(pre.textContent).toContain('export default total');
    expect(screen.getByText(/3 linhas/)).toBeTruthy();
  });

  it('highlights shader files with their canonical language label', () => {
    render(
      <FilePreview
        content={content({
          path: 'shaders/Geometry.hlsl',
          text: 'struct GeometryOut { float4 position : SV_Position; };\n',
        })}
      />,
    );

    expect(screen.getByText('HLSL')).toBeTruthy();
    const pre = screen.getByLabelText('Conteúdo de shaders/Geometry.hlsl');
    expect(pre.querySelector('.token.keyword')).toBeTruthy();
  });

  it('falls back to the plain text badge for unknown extensions', () => {
    render(
      <FilePreview
        content={content({ path: 'notes/unknown.zzz', text: 'something\n' })}
      />,
    );

    expect(screen.getByText('Texto')).toBeTruthy();
  });

  it('renderiza marcas inline de alteração e a seta de remoção sem o texto antigo', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      ' const total = 1;',
      '-const total = 2;',
      '+const total = 3;',
    ].join('\n');
    render(
      <FilePreview
        content={content({ text: 'const total = 1;\nconst total = 3;\n' })}
        diff={diff}
      />,
    );

    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    expect(pre.querySelector('[data-diff-tone="modified"]')?.textContent).toContain(
      'const total = 3',
    );
    expect(pre.querySelector('[data-diff-tone="added"]')).toBeNull();
    expect(screen.queryByText('const total = 2;')).toBeNull();
    expect(screen.getByRole('note', { name: '1 linha removida aqui' })).toBeTruthy();
    expect(screen.getByLabelText('Adições: 1, remoções: 1')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('mostra adição pura em verde sem seta de remoção', () => {
    render(
      <FilePreview
        content={content({ text: 'a\nnovo\n' })}
        diff={'@@ -1,0 +2,1 @@\n+novo'}
      />,
    );

    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    expect(pre.querySelector('[data-diff-tone="added"]')?.textContent).toContain('novo');
    expect(pre.querySelector('[data-diff-tone="modified"]')).toBeNull();
    expect(screen.queryByRole('note', { name: /linha removida/ })).toBeNull();
  });

  it('mostra o resumo mas não posiciona marcas em prévia truncada', () => {
    const diff =
      '@@ -1,2 +1,2 @@\n const total = 1;\n-const total = 2;\n+const total = 3;';
    render(
      <FilePreview
        content={content({
          truncated: true,
          text: 'const total = 1;\nconst total = 3;\n',
        })}
        diff={diff}
      />,
    );

    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    expect(pre.querySelector('[data-diff-tone]')).toBeNull();
    expect(pre.querySelector('[data-diff-deleted]')).toBeNull();
    expect(screen.getByLabelText('Adições: 1, remoções: 1')).toBeTruthy();
  });

  it('mostra o aviso quando o diff falha, mantendo o conteúdo legível', () => {
    render(<FilePreview content={content()} diffError="git diff falhou." />);

    expect(screen.getByLabelText('Conteúdo de src/app.ts')).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'Não foi possível carregar as alterações' }),
    ).toBeTruthy();
  });

  it('shows the file-type icon before the path in the header', () => {
    render(<FilePreview content={content()} />);
    const pathLabel = screen.getByText('src/app.ts');
    expect(pathLabel.previousElementSibling?.getAttribute('data-file-icon')).toBe('typescript');
  });

  it('uses the type icon in the binary preview header', () => {
    render(<FilePreview content={content({ path: 'docs/doc.pdf', binary: true, text: '', size: 2048 })} />);
    const pathLabel = screen.getByText('docs/doc.pdf');
    expect(pathLabel.previousElementSibling?.getAttribute('data-file-icon')).toBe('pdf');
  });

  it('copies the path and gives feedback', async () => {
    render(<FilePreview content={content()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar caminho' }));
    expect(utilsMocks.copyText).toHaveBeenCalledWith('src/app.ts');
    expect(await screen.findByRole('button', { name: 'Caminho copiado' })).toBeTruthy();
  });

  it('calls onOpenExternal with the file path', () => {
    const onOpenExternal = vi.fn();
    render(<FilePreview content={content()} onOpenExternal={onOpenExternal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir no editor externo' }));
    expect(onOpenExternal).toHaveBeenCalledWith('src/app.ts');
  });

  it('shows truncated and non-UTF-8 warnings', () => {
    render(
      <FilePreview content={content({ truncated: true, encoding: 'windows-1252', size: 900_000 })} />,
    );
    expect(screen.getAllByRole('note').length).toBe(2);
    expect(screen.getByText(/Prévia truncada/)).toBeTruthy();
    expect(screen.getByText(/Encoding windows-1252/)).toBeTruthy();
  });

  it('renders a binary card without text content', () => {
    render(<FilePreview content={content({ binary: true, text: '', size: 2048 })} />);
    expect(screen.getByText('Arquivo binário')).toBeTruthy();
    expect(screen.queryByLabelText('Conteúdo de src/app.ts')).toBeNull();
  });

  it('renders loading and error states', () => {
    const { unmount } = render(<FilePreview loading />);
    expect(screen.getByRole('status', { name: 'Carregando arquivo' })).toBeTruthy();
    unmount();

    render(<FilePreview error="Arquivo não encontrado." />);
    expect(screen.getByText('Não foi possível abrir o arquivo')).toBeTruthy();
    expect(screen.getByText('Arquivo não encontrado.')).toBeTruthy();
  });

  it('renders the empty selection state', () => {
    render(<FilePreview />);
    expect(screen.getByText('Nenhum arquivo selecionado')).toBeTruthy();
  });

  it('renders the empty file state', () => {
    render(<FilePreview content={content({ text: '' })} />);
    expect(screen.getByText('Arquivo vazio.')).toBeTruthy();
  });

  it('shows the reload action in the header when onReload is provided', () => {
    const onReload = vi.fn();
    render(<FilePreview content={content()} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar arquivo' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('offers "Tentar novamente" on the error state when onReload is provided', () => {
    const onReload = vi.fn();
    render(<FilePreview error="Falhou ao ler." onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe('FilePreview — imagem', () => {
  function imageContent(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
    return content({
      path: 'assets/logo.png',
      text: '',
      binary: true,
      size: 2048,
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
      ...overrides,
    });
  }

  it('renderiza o visualizador com xadrez, dimensões, zoom e ajustar/tamanho real', () => {
    render(<FilePreview content={imageContent()} />);

    expect(screen.getByRole('toolbar', { name: 'Controles da imagem' })).toBeTruthy();
    expect(screen.getByText('PNG')).toBeTruthy();

    const image = screen.getByAltText('assets/logo.png') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');

    // A região é focável e aceita o teclado (+, -, 0, 1).
    const stage = screen.getByRole('region', { name: 'Visualização da imagem assets/logo.png' });
    expect(stage.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(stage, { key: '+' });
    expect(screen.getByText('125%')).toBeTruthy();
    fireEvent.keyDown(stage, { key: '0' });
    expect(screen.getByText('100%')).toBeTruthy();

    // Dimensões vêm do próprio <img> ao carregar.
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 64 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 48 });
    fireEvent.load(image);
    expect(screen.getByText('64 × 48')).toBeTruthy();

    const fit = screen.getByRole('button', { name: 'Ajustar à janela' });
    const actual = screen.getByRole('button', { name: 'Tamanho real' });
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(actual);
    expect(actual.getAttribute('aria-pressed')).toBe('true');
    expect(fit.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(fit);
    expect(fit.getAttribute('aria-pressed')).toBe('true');
  });

  it('mostra aviso honesto quando o navegador não decodifica o payload', () => {
    render(<FilePreview content={imageContent({ mimeType: 'image/png' })} />);
    fireEvent.error(screen.getByAltText('assets/logo.png'));
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível decodificar a imagem');
  });
});

describe('FilePreview — PDF', () => {
  function pdfContent(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
    return content({
      path: 'docs/contrato.pdf',
      text: '',
      binary: true,
      size: 4096,
      mimeType: 'application/pdf',
      dataBase64: 'JVBERi0xLjQ=',
      ...overrides,
    });
  }

  it('renderiza a primeira página com pdf.js, navega e aplica zoom', async () => {
    render(<FilePreview content={pdfContent()} />);

    expect(screen.getByRole('toolbar', { name: 'Controles do PDF' })).toBeTruthy();
    expect(await screen.findByText('Página 1 de 2')).toBeTruthy();
    expect(pdfMocks.decodeBase64).toHaveBeenCalledWith('JVBERi0xLjQ=');
    expect(pdfMocks.loadPdf).toHaveBeenCalledTimes(1);

    const canvas = screen.getByRole('img', {
      name: 'Página 1 de 2 do PDF docs/contrato.pdf',
    });
    expect(canvas.tagName).toBe('CANVAS');

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Página 2 de 2')).toBeTruthy();
    expect(pdfMocks.renderPdfPage).toHaveBeenLastCalledWith(
      expect.anything(),
      2,
      expect.anything(),
      expect.any(Number),
      expect.anything(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Aumentar zoom' }));
    expect(await screen.findByText('125%')).toBeTruthy();
  });

  it('mostra erro de carregamento e permite tentar novamente', async () => {
    pdfMocks.loadPdf
      .mockRejectedValueOnce(new Error('PDF corrompido'))
      .mockResolvedValueOnce(pdfHandle(1));

    render(<FilePreview content={pdfContent()} />);

    expect(await screen.findByText('Não foi possível renderizar o PDF')).toBeTruthy();
    expect(screen.getByText('PDF corrompido')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Página 1 de 1')).toBeTruthy();
    expect(pdfMocks.loadPdf).toHaveBeenCalledTimes(2);
  });
});

describe('FilePreview — prévia omitida e formatos sem visualização', () => {
  it('mostra cartão honesto com tamanho quando o payload foi omitido', () => {
    render(
      <FilePreview
        content={content({
          path: 'docs/imenso.pdf',
          text: '',
          binary: true,
          size: 30 * 1024 * 1024,
          mimeType: 'application/pdf',
          previewOmitted: true,
        })}
      />,
    );

    expect(screen.getByText('Prévia não disponível')).toBeTruthy();
    expect(screen.getByText(/30 MB/)).toBeTruthy();
    expect(screen.getByText(/Abra no editor externo/)).toBeTruthy();
    expect(pdfMocks.loadPdf).not.toHaveBeenCalled();
  });

  it('não promete payload para imagem sem prévia suportada (TIFF)', () => {
    render(
      <FilePreview
        content={content({
          path: 'imagens/foto.tiff',
          text: '',
          binary: true,
          size: 5000,
          mimeType: 'image/tiff',
        })}
        onOpenExternal={vi.fn()}
      />,
    );

    expect(screen.getByText('Formato sem prévia no visualizador')).toBeTruthy();
    expect(screen.queryByAltText('imagens/foto.tiff')).toBeNull();
    expect(screen.getByRole('button', { name: 'Abrir no editor externo' })).toBeTruthy();
  });
});

describe('FilePreview — quebra de linha global', () => {
  /** Spans de conteúdo de cada linha (o 1º span de cada linha é o gutter). */
  function lineContents(pre: HTMLElement): HTMLElement[] {
    return Array.from(pre.querySelectorAll<HTMLElement>(':scope > div > span:nth-child(2)'));
  }

  it('alterna a preferência global e aplica whitespace-pre-wrap às linhas', () => {
    render(<FilePreview content={content()} />);
    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    const toggle = screen.getByRole('button', { name: 'Quebra de linha' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // Desligado: cada linha mantém `pre` (rolagem horizontal).
    expect(lineContents(pre)[0]?.className).toContain('whitespace-pre');
    expect(lineContents(pre)[0]?.className).not.toContain('whitespace-pre-wrap');

    fireEvent.click(toggle);

    expect(useUiStore.getState().codeFileWrap).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Quebra de linha' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const wrapped = lineContents(pre)[0]?.className ?? '';
    expect(wrapped).toContain('whitespace-pre-wrap');
    expect(wrapped).toContain('break-words');
  });

  it('consome a preferência global já ligada (vale para todos os arquivos)', () => {
    useUiStore.setState({ codeFileWrap: true });
    render(<FilePreview content={content()} />);

    expect(
      screen.getByRole('button', { name: 'Quebra de linha' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    expect(lineContents(pre)[0]?.className).toContain('whitespace-pre-wrap');
  });

  it('usa o mesmo fundo do código no gutter e na área rolável', () => {
    render(<FilePreview content={content()} />);
    const pre = screen.getByLabelText('Conteúdo de src/app.ts');
    const gutter = pre.querySelector(':scope > div > span:first-child');
    expect(gutter?.className).toContain('bg-background');
    expect(gutter?.className).not.toContain('bg-surface-raised');
    // A área que rola o código também declara o fundo (não herda do main).
    expect(pre.parentElement?.className).toContain('bg-background');
  });

  it('não mostra o botão de quebra de linha fora do ramo de código', () => {
    const nonCodeContents: WorkspaceFileContent[] = [
      content({
        path: 'assets/logo.png',
        text: '',
        binary: true,
        size: 2048,
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
      }),
      content({
        path: 'docs/contrato.pdf',
        text: '',
        binary: true,
        size: 4096,
        mimeType: 'application/pdf',
        dataBase64: 'JVBERi0xLjQ=',
      }),
      content({
        path: 'docs/imenso.pdf',
        text: '',
        binary: true,
        size: 30 * 1024 * 1024,
        mimeType: 'application/pdf',
        previewOmitted: true,
      }),
      content({ binary: true, text: '', size: 2048 }),
    ];

    for (const item of nonCodeContents) {
      const { unmount } = render(<FilePreview content={item} />);
      expect(screen.queryByRole('button', { name: 'Quebra de linha' })).toBeNull();
      unmount();
    }
  });
});

describe('FilePreview — Markdown', () => {
  const MD_GROUP = 'Modo de visualização do Markdown';

  function markdownContent(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
    return content({
      path: 'README.md',
      text: '# Título\n\nTexto **forte** e `código`.',
      size: 64,
      ...overrides,
    });
  }

  it('abre .md em Documento com o Markdown renderizado (padrão)', () => {
    render(<FilePreview content={markdownContent()} />);

    expect(
      screen.getByRole('radiogroup', { name: MD_GROUP }),
    ).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Documento' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Código' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.getByRole('region', { name: 'Prévia do Markdown' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Título' })).toBeTruthy();
    expect(screen.getByText('forte').tagName).toBe('STRONG');
    // O pipeline da conversa (prosa Zylara) é o mesmo.
    expect(document.querySelector('.zylara-prose')).toBeTruthy();
    // A fonte crua só existe no modo Código; e sem wrap no documento.
    expect(screen.queryByLabelText('Conteúdo de README.md')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quebra de linha' })).toBeNull();
  });

  it('alterna para Código (fonte com Prism) e volta para Documento', () => {
    render(<FilePreview content={markdownContent()} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Código' }));

    const pre = screen.getByLabelText('Conteúdo de README.md');
    expect(pre.textContent).toContain('# Título');
    expect(screen.getByRole('radio', { name: 'Código' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('heading', { level: 1, name: 'Título' })).toBeNull();
    // No modo código a quebra de linha (global) volta a aparecer.
    expect(screen.getByRole('button', { name: 'Quebra de linha' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Documento' }));

    expect(screen.queryByLabelText('Conteúdo de README.md')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Título' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Documento' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('mostra as marcas de diff apenas no modo Código', () => {
    const diff = '@@ -1,2 +1,2 @@\n # Título\n-antigo\n+novo';
    render(
      <FilePreview
        content={markdownContent({ text: '# Título\nnovo\n' })}
        diff={diff}
      />,
    );

    expect(document.querySelector('[data-diff-tone]')).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Código' }));
    const pre = screen.getByLabelText('Conteúdo de README.md');
    expect(pre.querySelector('[data-diff-tone="modified"]')?.textContent).toContain('novo');
  });

  it('reconhece .md, .markdown e .mdx', () => {
    for (const path of ['README.md', 'docs/guia.markdown', 'pages/index.mdx']) {
      const { unmount } = render(
        <FilePreview content={markdownContent({ path, text: '# Título' })} />,
      );
      expect(screen.getByRole('radiogroup', { name: MD_GROUP })).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Título' })).toBeTruthy();
      unmount();
    }
  });

  it('renderiza GFM (tabela/tarefas) e não injeta HTML perigoso', () => {
    render(
      <FilePreview
        content={markdownContent({
          path: 'docs/notas.markdown',
          text:
            '# Guia\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] feito\n\n' +
            '<script>alert("xss")</script>',
        })}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Guia' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });

  it('volta para Documento ao trocar de arquivo', () => {
    const { rerender } = render(<FilePreview content={markdownContent()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Código' }));
    expect(screen.getByLabelText('Conteúdo de README.md')).toBeTruthy();

    rerender(
      <FilePreview
        content={markdownContent({ path: 'CONTRIBUTING.md', text: '# Contribuir' })}
      />,
    );

    expect(screen.getByRole('radio', { name: 'Documento' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Contribuir' })).toBeTruthy();
    expect(screen.queryByLabelText('Conteúdo de CONTRIBUTING.md')).toBeNull();
  });

  it('mostra "Markdown vazio." no documento de um arquivo em branco', () => {
    render(<FilePreview content={markdownContent({ path: 'vazio.md', text: '   \n\t' })} />);

    expect(screen.getByText('Markdown vazio.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Prévia do Markdown' })).toBeNull();
  });

  it('não mostra o controle em arquivos que não são Markdown', () => {
    render(<FilePreview content={content()} />);

    expect(screen.queryByRole('radiogroup', { name: MD_GROUP })).toBeNull();
    expect(screen.getByLabelText('Conteúdo de src/app.ts')).toBeTruthy();
  });
});

describe('languageForPath', () => {
  it('maps extensions and special file names to Prism ids', () => {
    expect(languageForPath('src/app.ts')).toBe('typescript');
    expect(languageForPath('scripts/run.ps1')).toBe('powershell');
    expect(languageForPath('Dockerfile')).toBe('docker');
    expect(languageForPath('.env.local')).toBe('ini');
    expect(languageForPath('LICENSE')).toBe('text');
    expect(languageForPath('shaders/Geometry.hlsl')).toBe('hlsl');
    expect(languageForPath('shaders/main.vert')).toBe('glsl');
    expect(languageForPath('shaders/main.wgsl')).toBe('wgsl');
    expect(languageForPath('scripts/Main.jl')).toBe('julia');
    expect(languageForPath('src/Main.m')).toBe('objectivec');
    expect(languageForPath('notes/unknown.zzz')).toBe('zzz');
  });
});
