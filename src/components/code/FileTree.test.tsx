// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceFileEntry } from '@/lib/types';
import { FileTree } from './FileTree';

const entries: WorkspaceFileEntry[] = [
  {
    path: 'src',
    name: 'src',
    isDir: true,
    depth: 0,
    children: [
      { path: 'src/app.ts', name: 'app.ts', isDir: false, depth: 1, gitStatus: 'M' },
      { path: 'src/util.ts', name: 'util.ts', isDir: false, depth: 1 },
      { path: 'src/main.rs', name: 'main.rs', isDir: false, depth: 1 },
      { path: 'src/types.d.ts', name: 'types.d.ts', isDir: false, depth: 1 },
      {
        path: 'src/components',
        name: 'components',
        isDir: true,
        depth: 1,
        children: [{ path: 'src/components/Button.tsx', name: 'Button.tsx', isDir: false, depth: 2 }],
      },
    ],
  },
  { path: 'README.md', name: 'README.md', isDir: false, depth: 0, gitStatus: '?' },
  { path: 'doc.pdf', name: 'doc.pdf', isDir: false, depth: 0 },
  { path: 'blob.qqq', name: 'blob.qqq', isDir: false, depth: 0 },
];

const DEFAULT_EXPANDED = ['src', 'src/components'];

/** Mirrors the container: it owns the expanded set and reacts to `onToggleDir`. */
function renderTree(
  overrides: Partial<ComponentProps<typeof FileTree>> = {},
  initialExpanded: readonly string[] = DEFAULT_EXPANDED,
) {
  const props = {
    entries,
    onSelectFile: vi.fn(),
    onToggleDir: vi.fn(),
    ...overrides,
  };

  function Host() {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialExpanded));
    return (
      <FileTree
        {...props}
        expandedPaths={expanded}
        onToggleDir={(path) => {
          props.onToggleDir?.(path);
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          });
        }}
      />
    );
  }

  render(<Host />);
  return props;
}

const tree = () => screen.getByRole('tree', { name: 'Árvore de arquivos do workspace' });
const row = (name: string | RegExp) => screen.getByRole('treeitem', { name });

afterEach(cleanup);

describe('FileTree', () => {
  it('renders folders and files with aria-expanded on expanded dirs', () => {
    renderTree();
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    expect(row(/app\.ts/).getAttribute('aria-level')).toBe('2');
    expect(row(/README\.md/)).toBeTruthy();
  });

  it('renders expand/collapse-all actions and forwards clicks', () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    renderTree({ onExpandAll, onCollapseAll });

    fireEvent.click(screen.getByRole('button', { name: 'Expandir todas as pastas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recolher todas as pastas' }));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });

  it('disables the bulk actions when there are no directories', () => {
    renderTree({
      entries: [{ path: 'README.md', name: 'README.md', isDir: false, depth: 0 }],
      onExpandAll: vi.fn(),
      onCollapseAll: vi.fn(),
    });

    expect(
      screen.getByRole('button', { name: 'Expandir todas as pastas' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Recolher todas as pastas' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('starts with every directory collapsed', () => {
    renderTree({}, []);
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: /app\.ts/ })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: /components/ })).toBeNull();
    // Root-level files stay visible.
    expect(row(/README\.md/)).toBeTruthy();
  });

  it('keeps expansion controlled by the container', () => {
    const onToggleDir = vi.fn();
    const props: ComponentProps<typeof FileTree> = {
      entries,
      expandedPaths: new Set(['src']),
      onToggleDir,
    };
    const { rerender } = render(<FileTree {...props} />);

    fireEvent.click(row('src'));
    expect(onToggleDir).toHaveBeenCalledWith('src');
    // Without a prop update from the container nothing changes locally.
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
    expect(row(/app\.ts/)).toBeTruthy();

    rerender(<FileTree {...props} expandedPaths={new Set()} />);
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: /app\.ts/ })).toBeNull();
  });

  it('expands/collapses a directory and notifies the container', () => {
    const props = renderTree();
    fireEvent.click(row('src'));
    expect(props.onToggleDir).toHaveBeenCalledWith('src');
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: /app\.ts/ })).toBeNull();
    // Grandchildren of a collapsed folder stay hidden too.
    expect(screen.queryByRole('treeitem', { name: /Button\.tsx/ })).toBeNull();

    fireEvent.click(row('src'));
    expect(props.onToggleDir).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('treeitem', { name: /app\.ts/ })).toBeTruthy();
  });

  it('selects a file on click and marks it with aria-selected', () => {
    const props = renderTree();
    fireEvent.click(row(/app\.ts/));
    expect(props.onSelectFile).toHaveBeenCalledWith('src/app.ts');
    expect(row(/app\.ts/).getAttribute('aria-selected')).toBe('true');
    expect(row(/README\.md/).getAttribute('aria-selected')).toBe('false');
  });

  it('respects a controlled selectedPath', () => {
    renderTree({ selectedPath: 'README.md' });
    expect(row(/README\.md/).getAttribute('aria-selected')).toBe('true');
    expect(row(/app\.ts/).getAttribute('aria-selected')).toBe('false');
  });

  it('filters by name and reports the visible/total count', () => {
    renderTree({ totalCount: 5000 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar arquivos' }), {
      target: { value: 'BUTTON' },
    });
    expect(screen.queryByRole('treeitem', { name: /README\.md/ })).toBeNull();
    expect(screen.getByRole('treeitem', { name: /Button\.tsx/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'Mostrando 1 de 5000 arquivos — refine a busca',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    expect(screen.getByRole('treeitem', { name: /README\.md/ })).toBeTruthy();
  });

  it('reports backend truncation without an active filter', () => {
    renderTree({ totalCount: 5000, truncated: true });
    expect(screen.getByRole('status').textContent).toContain('Mostrando 10 de 5000');
  });

  it('finds nested files under collapsed folders without changing expansion', () => {
    const props = renderTree({ totalCount: 5000 }, []);
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar arquivos' }), {
      target: { value: 'BUTTON' },
    });
    expect(screen.getByRole('treeitem', { name: /Button\.tsx/ })).toBeTruthy();
    expect(props.onToggleDir).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro' }));
    expect(screen.queryByRole('treeitem', { name: /Button\.tsx/ })).toBeNull();
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
  });

  it('does not show the truncated counter only because folders are collapsed', () => {
    renderTree({}, []);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses the real colored file-type icon on files and keeps lucide folders', () => {
    renderTree();
    const iconKey = (name: string | RegExp) =>
      row(name).querySelector('[data-file-icon]')?.getAttribute('data-file-icon');

    expect(iconKey(/app\.ts/)).toBe('typescript');
    expect(iconKey(/main\.rs/)).toBe('rust');
    expect(iconKey(/doc\.pdf/)).toBe('pdf');
    expect(iconKey(/README\.md/)).toBe('readme');
    expect(iconKey(/types\.d\.ts/)).toBe('typescript-def');
    expect(iconKey(/blob\.qqq/)).toBe('file');
    expect(iconKey(/Button\.tsx/)).toBe('react_ts');

    // Folders keep the lucide pair instead of the colored file glyphs.
    expect(row('src').querySelector('[data-file-icon]')).toBeNull();
    expect(row('src').querySelector('.lucide-folder-open')).toBeTruthy();
    // Both icons share the same 16px box so names stay aligned.
    expect(row(/app\.ts/).querySelector('[data-file-icon]')?.className).toContain('size-4');
    expect(row('src').querySelector('.lucide-folder-open')?.getAttribute('class')).toContain('size-4');

    fireEvent.click(row('src'));
    expect(row('src').querySelector('.lucide-folder')).toBeTruthy();
    expect(row('src').querySelector('.lucide-folder-open')).toBeNull();
  });

  it('shows git state badges with accessible labels', () => {
    renderTree();
    expect(screen.getByLabelText('Estado no Git: Modificado').textContent).toBe('M');
    expect(screen.getByLabelText('Estado no Git: Não rastreado').textContent).toBe('?');
  });

  it('navigates with the keyboard and selects with Enter', () => {
    const props = renderTree();
    fireEvent.keyDown(tree(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('src'));
    fireEvent.keyDown(tree(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row(/app\.ts/));
    fireEvent.keyDown(tree(), { key: 'Enter' });
    expect(props.onSelectFile).toHaveBeenCalledWith('src/app.ts');
  });

  it('collapses with ArrowLeft, expands with ArrowRight and jumps to the parent', () => {
    const props = renderTree();
    fireEvent.keyDown(tree(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('src'));
    fireEvent.keyDown(tree(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row(/app\.ts/));

    fireEvent.keyDown(tree(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('src'));
    // Expanded dir: ArrowLeft collapses before moving to the parent.
    fireEvent.keyDown(tree(), { key: 'ArrowLeft' });
    expect(props.onToggleDir).toHaveBeenCalledWith('src');
    expect(row('src').getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(tree(), { key: 'ArrowRight' });
    expect(row('src').getAttribute('aria-expanded')).toBe('true');
  });

  it('renders the loading skeleton', () => {
    render(<FileTree entries={[]} loading />);
    expect(screen.getByRole('status', { name: 'Carregando a árvore' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Carregando arquivos' })).toBeTruthy();
  });

  it('renders honest empty and error states', () => {
    const { unmount } = render(<FileTree entries={[]} />);
    expect(screen.getByText('Nenhum arquivo para mostrar')).toBeTruthy();
    unmount();

    render(<FileTree entries={[]} error="Acesso negado à pasta." />);
    expect(screen.getByText('Não foi possível ler a pasta')).toBeTruthy();
    expect(screen.getByText('Acesso negado à pasta.')).toBeTruthy();
  });

  it('pede carregamento ao abrir um diretório ainda sem filhos (lazy)', () => {
    const props = renderTree({
      entries: [{ path: 'apps', name: 'apps', isDir: true, depth: 0 }],
    });

    fireEvent.click(row('apps'));

    expect(props.onToggleDir).toHaveBeenCalledWith('apps');
    // Sem filhos carregados não há o que colapsar: o diretório não é marcado
    // como fechado (o clique apenas solicita o carregamento).
    expect(row('apps').getAttribute('aria-expanded')).toBe('false');
    expect(props.onSelectFile).not.toHaveBeenCalled();
  });

  it('mostra spinner no diretório enquanto os filhos carregam', () => {
    renderTree({
      entries: [{ path: 'apps', name: 'apps', isDir: true, depth: 0 }],
      loadingPaths: new Set(['apps']),
    });

    expect(screen.getByRole('status', { name: 'Carregando apps' })).toBeTruthy();
  });

  it('opens the row context menu with the actions for a file', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    renderTree({ onAction });

    fireEvent.contextMenu(row(/app\.ts/));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Abrir ao lado' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Baixar' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Nova pasta' })).toBeNull();

    await user.click(within(menu).getByRole('menuitem', { name: 'Copiar caminho relativo' }));
    expect(onAction).toHaveBeenCalledWith(
      'copyRelativePath',
      expect.objectContaining({ path: 'src/app.ts' }),
    );
  });

  it('opens the row menu with Shift+F10 and offers creation on folders', async () => {
    const onAction = vi.fn();
    renderTree({ onAction });

    fireEvent.focus(row('src'));
    fireEvent.keyDown(row('src'), { key: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Novo arquivo' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Nova pasta' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Abrir ao lado' })).toBeNull();
  });

  it('exposes only creation actions in the header dropdown', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    renderTree({ onAction });

    await user.click(screen.getByRole('button', { name: 'Ações do arquivo' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Novo arquivo' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Nova pasta' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Excluir' })).toBeNull();

    await user.click(within(menu).getByRole('menuitem', { name: 'Novo arquivo' }));
    expect(onAction).toHaveBeenCalledWith('newFile', null);
  });
});
