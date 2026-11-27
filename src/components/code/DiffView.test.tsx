// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Settings } from '@/lib/types';

const utilsMocks = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));
const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, copyText: utilsMocks.copyText };
});
vi.mock('sonner', () => ({ toast: toastMocks }));

import { useAppStore } from '@/lib/store';
import { DiffView } from './DiffView';

const SMALL_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,2 +20,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
].join('\n');

function bigHunkDiff(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => ` linha ${index + 1}`);
  return [
    'diff --git a/big.ts b/big.ts',
    '--- a/big.ts',
    '+++ b/big.ts',
    `@@ -1,${lines} +1,${lines} @@`,
    ...body,
  ].join('\n');
}


/** Span de conteúdo de uma linha do diff (o texto é dividido em tokens do Prism). */
function diffLine(path: string, text: string): HTMLElement {
  const group = screen.getByRole('group', { name: `Diff de ${path}` });
  return within(group).getByText(
    (_, element) =>
      element?.textContent?.replace(/\u00A0/g, '').trim() === text &&
      (element?.className ?? '').includes('whitespace-pre-wrap'),
  ) as HTMLElement;
}
afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  utilsMocks.copyText.mockResolvedValue(true);
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings,
      editorTheme: 'app',
      editorFontFamily: '',
      editorFontSize: 12,
      editorLineHeight: 1.7,
      editorTabSize: 2,
      editorLineNumbers: true,
    },
  });
});

describe('DiffView', () => {
  it('renders file headers, hunk headers and the line counters', () => {
    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    const hunk = screen.getByText('@@ -10,2 +20,2 @@');
    expect(hunk.getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('--- a/src/app.ts')).toBeTruthy();
  });

  it('renders additions/removals with theme-token backgrounds and both line numbers', () => {
    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);

    const added = diffLine('src/app.ts', 'const b = 3;');
    expect(added.parentElement?.className ?? '').toContain('bg-success-soft');
    expect(added.parentElement?.textContent ?? '').toContain('21');

    const removed = diffLine('src/app.ts', 'const b = 2;');
    expect(removed.parentElement?.className ?? '').toContain('bg-danger-soft');
    expect(removed.parentElement?.textContent ?? '').toContain('11');
  });

  it('destaca a sintaxe com as cores do tema compartilhado', () => {
    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);

    const added = diffLine('src/app.ts', 'const b = 3;');
    const keyword = within(added).getByText('const');
    expect(keyword.getAttribute('style') ?? '').toContain('var(--accent)');
    const number = within(added).getByText('3');
    expect(number.getAttribute('style') ?? '').toContain('var(--warning)');

    // Arquivo sem gramática conhecida continua legível em texto puro (sem tokens).
    const plain = render(<DiffView path="notes.unknown" diff={SMALL_DIFF} />);
    const plainLine = diffLine('notes.unknown', 'const b = 3;');
    expect(plainLine.children.length).toBe(0);
    plain.unmount();
  });

  it('collapses hunks over 200 lines behind "ver mais"', () => {
    render(<DiffView path="big.ts" diff={bigHunkDiff(250)} />);
    expect(screen.queryByText((_, element) => element?.textContent?.trim() === 'linha 220' && element?.className.includes('whitespace-pre-wrap') ? true : false)).toBeNull();
    const more = screen.getByRole('button', { name: 'Ver mais (210 linhas)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(diffLine('big.ts', 'linha 220')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Recolher trecho' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('copies the patch', () => {
    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar patch' }));
    expect(utilsMocks.copyText).toHaveBeenCalledWith(SMALL_DIFF);
  });

  it('renders the binary card instead of a fake patch', () => {
    render(<DiffView path="img.png" diff={'Binary files a/img.png and b/img.png differ'} />);
    expect(screen.getByText('Arquivo binário')).toBeTruthy();
    expect(screen.queryByRole('group', { name: /Diff de/ })).toBeNull();
  });

  it('renders honest empty, loading and error states', () => {
    const { unmount } = render(<DiffView path="src/app.ts" diff="" />);
    expect(screen.getByText('Sem diferenças para mostrar')).toBeTruthy();
    unmount();

    const loading = render(<DiffView path="src/app.ts" loading />);
    expect(screen.getByRole('status', { name: 'Carregando diff' })).toBeTruthy();
    loading.unmount();

    render(<DiffView path="src/app.ts" error="git diff falhou." />);
    expect(screen.getByText('Não foi possível carregar o diff')).toBeTruthy();
    expect(screen.getByText('git diff falhou.')).toBeTruthy();
  });

  it('does not render the diff meta lines as changes', () => {
    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);
    expect(screen.queryByText('+4')).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  function setEditor(overrides: Partial<Settings>) {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, ...overrides },
    });
  }

  it('applies the persisted typography to the diff group', () => {
    setEditor({
      editorFontFamily: 'Fira Code, monospace',
      editorFontSize: 16,
      editorLineHeight: 1.8,
      editorTabSize: 3,
    });

    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);
    const group = screen.getByRole('group', { name: 'Diff de src/app.ts' }) as HTMLElement;

    expect(group.style.fontSize).toBe('16px');
    expect(group.style.lineHeight).toBe('1.8');
    expect(group.style.tabSize).toBe('3');
    expect(group.style.fontFamily.replaceAll('"', '')).toBe('Fira Code, monospace');
  });

  it('scopes a forced palette to the diff viewer', () => {
    setEditor({ editorTheme: 'light' });

    const { container } = render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);
    const root = container.firstElementChild as HTMLElement;

    expect(root.style.getPropertyValue('--background')).toBe('#ffffff');
    expect(root.style.colorScheme).toBe('light');
  });

  it('hides line numbers but keeps the diff signs', () => {
    setEditor({ editorLineNumbers: false });

    render(<DiffView path="src/app.ts" diff={SMALL_DIFF} />);
    const group = screen.getByRole('group', { name: 'Diff de src/app.ts' });

    expect(group.querySelectorAll('.tabular-nums').length).toBe(0);
    expect(diffLine('src/app.ts', 'const b = 3;').parentElement?.textContent).toContain('+');
    expect(screen.getByText('+1')).toBeTruthy();
  });
});
