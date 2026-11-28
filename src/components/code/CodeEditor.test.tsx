// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { editorPreferences } from '@/lib/editorSettings';
import { useEditorStore } from '@/lib/store';
import type { Settings } from '@/lib/types';
import { editorBufferKey } from '@/lib/store/editorStore';
import { CodeEditor, type EditorDiffMarks } from './CodeEditor';

const preferences = editorPreferences({ locale: 'pt-BR' } as Settings);
const bufferInit = {
  workspaceId: 'ws-1',
  path: 'src/app.ts',
  text: 'const a = 1;\n',
  eol: 'lf' as const,
  hash: 'hash-1',
  indentation: { tabSize: 2, insertSpaces: true },
};
const key = editorBufferKey(bufferInit.workspaceId, bufferInit.path);

const marks: EditorDiffMarks = {
  lineTones: new Map([
    [2, 'modified'],
    [3, 'added'],
  ]),
  deletions: new Map([[4, 2]]),
};

function Harness({
  onSave = vi.fn(),
  onSaveAs = vi.fn(),
  wrap = false,
  editorPreferences: prefs = preferences,
  diffMarks,
}: {
  onSave?: () => void;
  onSaveAs?: () => void;
  wrap?: boolean;
  editorPreferences?: typeof preferences;
  diffMarks?: EditorDiffMarks;
}) {
  const buffer = useEditorStore((state) => state.buffers[key]);
  if (!buffer) return null;
  return (
    <CodeEditor
      buffer={buffer}
      preferences={prefs}
      language="typescript"
      wrap={wrap}
      diffMarks={diffMarks}
      onSave={onSave}
      onSaveAs={onSaveAs}
    />
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByTestId('code-editor-textarea') as HTMLTextAreaElement;
}

function buffer() {
  return useEditorStore.getState().buffers[key];
}

afterEach(cleanup);

beforeEach(() => {
  useEditorStore.getState().reset();
  useEditorStore.getState().ensureBuffer(bufferInit);
  useEditorStore.getState().setSelection(key, { anchor: 0, head: 0 });
});

describe('CodeEditor', () => {
  it('renders the buffer with its highlighted layer and gutter', () => {
    render(<Harness />);

    expect(textarea().value).toBe('const a = 1;\n');
    expect(textarea().getAttribute('aria-label')).toBe('Conteúdo de src/app.ts');
    // The painted layer is decorative and the textarea owns the input.
    const painted = document.querySelector('pre[aria-hidden="true"]');
    expect(painted?.textContent).toContain('const');
    expect(painted?.textContent).toContain('1');
  });

  it('writes native typing into the buffer', () => {
    render(<Harness />);

    fireEvent.change(textarea(), { target: { value: 'let a = 2;\n' } });

    expect(buffer().text).toBe('let a = 2;\n');
    expect(buffer().savedText).toBe('const a = 1;\n');
  });

  it('indents with Tab and comments with Ctrl+/', () => {
    render(<Harness />);

    fireEvent.keyDown(textarea(), { key: 'Tab' });
    expect(buffer().text).toBe('  const a = 1;\n');
    expect(buffer().selection.anchor).toBe(2);

    useEditorStore.getState().setSelection(key, { anchor: 2, head: 2 });
    fireEvent.keyDown(textarea(), { key: '/', ctrlKey: true });
    expect(buffer().text).toBe('  // const a = 1;\n');
  });

  it('auto-closes brackets and expands them on Enter', () => {
    useEditorStore.getState().setText(key, '');
    useEditorStore.getState().setSelection(key, { anchor: 0, head: 0 });
    render(<Harness />);

    fireEvent.keyDown(textarea(), { key: '(' });
    expect(buffer().text).toBe('()');
    expect(buffer().selection.anchor).toBe(1);

    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(buffer().text).toBe('(\n  \n)');
  });

  it('undoes and redoes with the keyboard', () => {
    render(<Harness />);

    fireEvent.change(textarea(), { target: { value: 'novo\n' } });
    fireEvent.keyDown(textarea(), { key: 'z', ctrlKey: true });
    expect(buffer().text).toBe('const a = 1;\n');

    fireEvent.keyDown(textarea(), { key: 'z', ctrlKey: true, shiftKey: true });
    expect(buffer().text).toBe('novo\n');
  });

  it('saves and saves as through the shortcuts', () => {
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(<Harness onSave={onSave} onSaveAs={onSaveAs} />);

    fireEvent.keyDown(textarea(), { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(textarea(), { key: 's', ctrlKey: true, shiftKey: true });
    expect(onSaveAs).toHaveBeenCalledTimes(1);
  });

  it('keeps the painted text aligned with the caret in both wrap modes', () => {
    const { rerender } = render(<Harness wrap={false} />);

    const unwrapped = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    // Unwrapped: the gutter is an overlay column and the layer carries the inset.
    expect(unwrapped.style.paddingLeft).toBe('56px');
    expect(textarea().style.paddingLeft).toBe('56px');
    expect(unwrapped.querySelector('[data-editor-gutter]')).toBeNull();
    expect(document.querySelector('[data-editor-gutter-column]')).toBeTruthy();
    expect(unwrapped.style.width).toBe('max-content');

    rerender(<Harness wrap />);

    const wrapped = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    // Wrapped: the gutter is an in-flow cell, so the layer must not add its own
    // inset (the old double inset painted the text 56px right of the caret).
    expect(wrapped.style.paddingLeft).toBe('0px');
    expect(textarea().style.paddingLeft).toBe('56px');
    const cell = wrapped.querySelector('[data-editor-gutter]') as HTMLElement | null;
    expect(cell).not.toBeNull();
    expect(cell?.style.width).toBe('56px');
    expect(document.querySelector('[data-editor-gutter-column]')).toBeNull();
    // Wrapped rows use the textarea's column width, never max-content.
    expect(wrapped.style.width).toBe('100%');
  });

  it('uses the same font metrics in the input and the painted layer', () => {
    render(<Harness />);

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    // The caret/click mapping comes from the textarea's own text metrics, so the
    // two layers must resolve to the same font (this was the second desync: the
    // textarea inherited the UI font while the layer used the mono stack).
    expect(textarea().className).toContain('font-mono');
    expect(painted.className).toContain('font-mono');
    for (const property of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'tabSize'] as const) {
      expect(textarea().style[property]).toBe(painted.style[property]);
    }
  });

  it('applies a custom font family to both layers', () => {
    const custom = editorPreferences({
      locale: 'pt-BR',
      editorFontFamily: 'Fira Code',
    } as Settings);
    render(<Harness editorPreferences={custom} />);

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    expect(textarea().style.fontFamily).toContain('Fira Code');
    expect(painted.style.fontFamily).toBe(textarea().style.fontFamily);
  });

  it('opens find, counts matches and walks them', async () => {
    useEditorStore.getState().setText(key, 'abc abc\n');
    useEditorStore.getState().setSelection(key, { anchor: 0, head: 0 });
    render(<Harness />);

    fireEvent.keyDown(textarea(), { key: 'f', ctrlKey: true });
    expect(screen.getByRole('search')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Localizar'), { target: { value: 'abc' } });
    // The count is debounced: a keystroke never scans the whole document.
    expect(await screen.findByText('1 de 2')).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText('Localizar'), { key: 'Enter' });
    expect(buffer().selection).toEqual({ anchor: 4, head: 7 });

    fireEvent.keyDown(screen.getByLabelText('Localizar'), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
  });
});

describe('CodeEditor — performance guards', () => {
  const lineAt = (index: number) => `const v${index} = ${index};`;

  function largeText(count: number): string {
    return `${Array.from({ length: count }, (_, index) => lineAt(index)).join('\n')}\n`;
  }

  it('paints only the visible window of a large document', () => {
    useEditorStore.getState().setText(key, largeText(2_000));
    render(<Harness />);

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    const rows = painted.querySelectorAll(':scope > div');
    // Window = visible line ± overscan: never the 2001 rows of the document.
    expect(rows.length).toBeLessThan(textarea().value.split('\n').length / 10);
    // Real tokens are painted (nested spans), not a plain dump of the file.
    expect(painted.querySelectorAll('span span').length).toBeGreaterThan(0);
    expect(painted.textContent).toContain('const v0 = 0;');
    // The reserved space keeps the document height exact for the validator.
    expect(parseFloat(painted.style.paddingBottom)).toBeCloseTo(
      8 + (2_001 - rows.length) * 20.4,
      2,
    );
    expect(textarea().value.split('\n')).toHaveLength(2_001);
  });

  it('follows the scroll by repainting only the new window', () => {
    const text = largeText(3_000);
    useEditorStore.getState().setText(key, text);
    render(<Harness />);

    const element = textarea();
    element.scrollTop = 1_500 * 20.4;
    fireEvent.scroll(element);

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    // Window = visible line ± overscan, so the slice is ~90 lines of 49 KiB.
    expect(painted.textContent).toContain('const v1500 = 1500;');
    expect(painted.textContent).not.toContain('const v0 = 0;');
    expect(painted.textContent.length).toBeLessThan(text.length / 4);
    expect(painted.querySelectorAll(':scope > div').length).toBeLessThan(
      textarea().value.split('\n').length / 10,
    );
  });

  it('keeps the paint window bounded while typing', () => {
    useEditorStore.getState().setText(key, largeText(2_000));
    render(<Harness />);

    fireEvent.change(textarea(), { target: { value: `${largeText(2_000)}// tail\n` } });

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    const rows = painted.querySelectorAll(':scope > div');
    expect(rows.length).toBeLessThan(textarea().value.split('\n').length / 10);
  });

  it('applies the scroll transform without writing the store per event', () => {
    useEditorStore.getState().setText(key, largeText(2_000));
    render(<Harness />);

    const element = textarea();
    element.scrollTop = 400;
    fireEvent.scroll(element);

    const layer = document.querySelector('[data-editor-layer="true"]') as HTMLElement;
    expect(layer.style.transform).toBe('translate(0px, -400px)');
    // Persisted after the idle delay, never on the scroll event itself.
    expect(useEditorStore.getState().buffers[key].scrollTop).toBe(0);
  });

  it('colors a huge minified line in the background', async () => {
    useEditorStore.getState().setText(key, `${'x'.repeat(60_000)}\n`);
    render(<Harness />);

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    // The giant line is painted plain on the first frame, then colored by the
    // tiler in idle time — it is never skipped.
    await waitFor(() => expect(painted.querySelectorAll('span span').length).toBeGreaterThan(0));
    expect(screen.queryByText('Realce de sintaxe pausado para este arquivo grande')).toBeNull();
  });

  it('colors off-screen lines of a wrapped large file', async () => {
    useEditorStore.getState().setText(key, largeText(2_400));
    render(<Harness wrap />);

    const painted = document.querySelector('pre[aria-hidden="true"]') as HTMLElement;
    expect(painted.querySelectorAll(':scope > div').length).toBe(2_401);
    // Background tiles color the entire document, not only the viewport.
    await waitFor(() => expect(painted.textContent).toContain('const v2300 = 2300;'));
    const spans = painted.querySelectorAll('span span');
    expect(spans.length).toBeGreaterThan(2_400);
    expect(painted.querySelectorAll(':scope > div')[2_300].querySelectorAll('span span').length).toBeGreaterThan(0);
  });

  it('paints diff marks in the wrapped gutter cells', () => {
    useEditorStore.getState().setText(key, 'a\nb\nc\nd\n');
    render(<Harness wrap diffMarks={marks} />);

    const modified = document.querySelector('[data-editor-diff-tone="modified"]');
    const added = document.querySelector('[data-editor-diff-tone="added"]');
    const deletion = document.querySelector('[data-editor-diff-deleted="2"]');
    expect(modified?.textContent).toBe('');
    expect(modified?.className).toContain('bg-warning');
    expect(modified?.getAttribute('title')).toBe('Linha modificada');
    expect(added?.className).toContain('bg-success');
    expect(deletion?.className).toContain('bg-danger');
    expect(document.querySelectorAll('[data-editor-gutter] [data-editor-diff-tone]')).toHaveLength(2);
  });

  it('paints window-aligned diff marks in the unwrapped gutter', () => {
    useEditorStore.getState().setText(key, 'a\nb\nc\nd\n');
    render(<Harness diffMarks={marks} />);

    const column = document.querySelector('[data-editor-gutter-column]') as HTMLElement;
    const lane = column.querySelector('[data-editor-diff-gutter]') as HTMLElement;
    expect(lane).toBeTruthy();
    expect(lane.querySelectorAll(':scope > div')).toHaveLength(5);
    expect(lane.querySelector('[data-editor-diff-tone="modified"]')).toBeTruthy();
    expect(lane.querySelector('[data-editor-diff-tone="added"]')).toBeTruthy();
    expect(lane.querySelector('[data-editor-diff-deleted="2"]')).toBeTruthy();

    textarea().scrollTop = 20;
    fireEvent.scroll(textarea());
    expect((column.firstElementChild as HTMLElement).style.transform).toBe('translateY(-20px)');
  });

  it('keeps diff marks when line numbers are hidden and omits them without marks', () => {
    useEditorStore.getState().setText(key, 'a\nb\nc\nd\n');
    const { rerender } = render(
      <Harness
        editorPreferences={{ ...preferences, lineNumbers: false }}
        diffMarks={marks}
      />,
    );

    expect(document.querySelector('[data-editor-gutter-column]')).toBeTruthy();
    expect(document.querySelector('[data-editor-diff-tone="modified"]')).toBeTruthy();
    expect(textarea().style.paddingLeft).toBe('56px');

    rerender(<Harness editorPreferences={{ ...preferences, lineNumbers: false }} />);
    expect(document.querySelector('[data-editor-gutter-column]')).toBeNull();
    expect(document.querySelector('[data-editor-diff-tone]')).toBeNull();
    expect(textarea().style.paddingLeft).toBe('16px');
  });
});
