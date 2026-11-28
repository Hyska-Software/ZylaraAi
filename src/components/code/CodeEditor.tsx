import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  activeMatchIndex,
  commentTokensForLanguage,
  deleteLines,
  duplicateLines,
  findMatches,
  HighlightCache as EditorHighlightCache,
  indentSelection,
  insertNewline,
  insertText,
  lineIndexFor,
  lineText,
  matchSelection,
  moveLines,
  offsetAt,
  outdentSelection,
  positionAt,
  pushHistory,
  redoHistory,
  replaceAllMatches,
  replaceMatch,
  selectionEnd,
  selectionStart,
  toggleLineComment,
  undoHistory,
  visibleLineWindow,
  windowCoversDocument,
  windowSlice,
  WINDOW_OVERSCAN_LINES,
  type EditorSelection,
  type LineWindow,
  type SearchMatch,
  type SearchResult,
  type TokenLine,
} from '@/lib/editor';
import type { EditorPreferences } from '@/lib/editorSettings';
import { prism, SYNTAX_THEME } from '@/lib/highlight';
import { useEditorStore, type EditorBuffer } from '@/lib/store';
import { editorThemeStyle } from '@/lib/theme/editorTheme';
import { useThemeStore } from '@/lib/store/themeStore';
import { cn } from '@/lib/utils';
import { EditorFindBar } from './EditorFindBar';
import { useBackgroundHighlight } from './useBackgroundHighlight';

/** Width of the line-number gutter (`w-14` in the file viewer). */
const GUTTER_WIDTH = 56;
/** Right padding inside the gutter column. */
const GUTTER_PADDING_RIGHT = 12;
/** Horizontal padding when the gutter is hidden. */
const GUTTERLESS_PADDING = 16;
/** Vertical padding of both layers. */
const VERTICAL_PADDING = 8;
/** Right padding of both layers, so wrapping matches. */
const RIGHT_PADDING = 16;
/**
 * Maximum size of a slice that is tokenized synchronously during render (the
 * visible window). Larger slices are left to the background tiler.
 */
const SYNC_TOKENIZE_MAX_CHARS = 48 * 1024;
/** Scroll offset is written to the store after this idle time (never per event). */
const SCROLL_PERSIST_MS = 400;
/** Find matches are recomputed after this idle time while the bar is open. */
const FIND_DEBOUNCE_MS = 160;

/** Characters that auto-close (openers and their matching closers). */
const PAIR_CHARACTERS = new Set(['(', '[', '{', '"', "'", '`', ')', ']', '}']);

const EMPTY_SEARCH: SearchResult = { matches: [], error: null, limited: false };

export interface CodeEditorHandle {
  focus: () => void;
  /** Scrolls the caret into view and focuses the textarea. */
  revealOffset: (offset: number) => void;
  openFind: (mode: 'find' | 'replace') => void;
  /** Opens the inline "go to line" field (Ctrl+G). */
  openGoToLine: () => void;
}

export interface CodeEditorProps {
  buffer: EditorBuffer;
  preferences: EditorPreferences;
  /** Prism language id (highlight + comment tokens). */
  language: string;
  /** Persisted wrap preference of the workbench. */
  wrap: boolean;
  onSave: () => void;
  onSaveAs: () => void;
  className?: string;
}

interface FindState {
  mode: 'find' | 'replace';
  query: string;
  replacement: string;
  options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
  activeIndex: number;
}

/* ------------------------------------------------------------------ */
/* Painted layer                                                       */
/* ------------------------------------------------------------------ */

/**
 * Token styles resolved once from the shared syntax theme. Using them directly
 * (instead of the render-prop helpers) keeps the row component memoizable: rows
 * are only re-painted when their own line changes.
 */
const TOKEN_STYLES: Map<string, CSSProperties> = (() => {
  const styles = new Map<string, CSSProperties>();
  for (const entry of SYNTAX_THEME.styles) {
    for (const type of entry.types) {
      styles.set(type, { ...(styles.get(type) ?? {}), ...entry.style });
    }
  }
  return styles;
})();

function tokenStyle(types: string[]): CSSProperties {
  let style: CSSProperties = {};
  for (const type of types) {
    const next = TOKEN_STYLES.get(type);
    if (next) style = { ...style, ...next };
  }
  return style;
}

function GutterNumber({ value }: { value: number }) {
  return (
    <span
      data-editor-gutter="true"
      className="shrink-0 select-none pr-3 text-right font-mono text-[10.5px] tabular-nums text-foreground-subtle"
      // The width must match the textarea's left padding (GUTTER_WIDTH).
      style={{ width: GUTTER_WIDTH }}
    >
      {value}
    </span>
  );
}

interface PaintedRowProps {
  /** Token line, or the raw text when the window is painted plain. */
  line: TokenLine[] | string;
  lineNumber: number;
  wrap: boolean;
  lineNumbers: boolean;
  lineHeightPx: number;
}

const PaintedRow = memo(function PaintedRow({
  line,
  lineNumber,
  wrap,
  lineNumbers,
  lineHeightPx,
}: PaintedRowProps) {
  return (
    <div className="flex min-h-[20px] items-start" style={{ minHeight: lineHeightPx }}>
      {lineNumbers && wrap ? <GutterNumber value={lineNumber} /> : null}
      <span
        className="min-w-0 flex-1"
        style={{
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          overflowWrap: wrap ? 'break-word' : 'normal',
        }}
      >
        {typeof line === 'string' ? (
          line.length > 0 ? (
            line
          ) : (
            '\u200b'
          )
        ) : line.length === 0 ? (
          '\u200b'
        ) : (
          line.map((token, key) => (
            <span key={key} style={tokenStyle(token.types)}>
              {token.content}
            </span>
          ))
        )}
      </span>
    </div>
  );
});

interface PaintedRowsProps {
  /** Token lines for the painted window; a string means "not tokenized yet". */
  lines: (TokenLine[] | string)[];
  wrap: boolean;
  lineNumbers: boolean;
  lineHeightPx: number;
  /** 0-based line of the first painted row (gutter numbers in wrap mode). */
  startLine: number;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  metrics: CSSProperties;
}

/**
 * Glyph layer. Memoized on paint-relevant props so caret moves, status changes
 * and scroll frames never reconcile it; only a text/window/metrics change does.
 */
const PaintedRows = memo(function PaintedRows({
  lines,
  wrap,
  lineNumbers,
  lineHeightPx,
  startLine,
  paddingTop,
  paddingBottom,
  paddingLeft,
  paddingRight,
  metrics,
}: PaintedRowsProps) {
  const style = useMemo<CSSProperties>(
    () => ({
      ...metrics,
      paddingTop,
      paddingBottom,
      paddingLeft,
      paddingRight,
      // Wrapped text must use the same column width as the textarea; unwrapped
      // text is allowed to grow so long lines scroll horizontally.
      width: wrap ? '100%' : 'max-content',
      minWidth: '100%',
    }),
    [metrics, paddingTop, paddingBottom, paddingLeft, paddingRight, wrap],
  );

  const row = (line: TokenLine[] | string, index: number): ReactNode => (
    <PaintedRow
      key={startLine + index}
      line={line}
      lineNumber={startLine + index + 1}
      wrap={wrap}
      lineNumbers={lineNumbers}
      lineHeightPx={lineHeightPx}
    />
  );

  return (
    <pre aria-hidden className="m-0 min-w-full py-0 font-mono" style={style}>
      {lines.map((line, index) => row(line, index))}
    </pre>
  );
});

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function sameWindow(left: LineWindow, right: LineWindow): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.padTop === right.padTop &&
    left.padBottom === right.padBottom
  );
}

/**
 * Editing surface of the center file tab (WORKBENCH §7.1).
 *
 * Layered, first-party editor: a transparent `<textarea>` owns input, caret,
 * selection, scrolling and IME (native behavior we never re-implement), while a
 * Prism-highlighted layer behind it paints colors and a gutter. Both layers get
 * exactly the same font metrics and paddings, so the caret sits on top of the
 * highlighted glyphs; the textarea is the single scroller and the highlight
 * layer is translated by its offsets.
 *
 * Performance rules for large files:
 * - unwrapped text paints only the visible **window** of lines (paddings keep the
 *   document height), wrapped text paints all lines but memoized per row;
 * - tokenization is windowed with context (full document only up to 32 KiB);
 * - scrolling writes transforms imperatively and never re-renders React; the
 *   scroll offset reaches the store debounced;
 * - the painted layer is memoized, so caret/status updates skip it entirely.
 */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { buffer, preferences, language, wrap, onSave, onSaveAs, className },
  ref,
) {
  const { t } = useTranslation('code');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightLayerRef = useRef<HTMLDivElement | null>(null);
  const gutterBlockRef = useRef<HTMLDivElement | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTopRef = useRef(buffer.scrollTop);
  const bufferKeyRef = useRef(buffer.key);
  bufferKeyRef.current = buffer.key;

  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [find, setFind] = useState<FindState | null>(null);
  const [findResult, setFindResult] = useState<{ text: string; result: SearchResult } | null>(null);
  const [goToLine, setGoToLine] = useState<string | null>(null);
  const goToLineRef = useRef<HTMLInputElement | null>(null);
  const lastQuery = useRef('');

  const activeTheme = useThemeStore((state) =>
    state.themes.find((entry) => entry.id === state.activeId),
  );
  const viewerStyle = useMemo(
    () => editorThemeStyle(activeTheme, preferences.theme),
    [activeTheme, preferences.theme],
  );

  /** Left inset where the text starts: the gutter column, or a small pad without it. */
  const textInset = preferences.lineNumbers ? GUTTER_WIDTH : GUTTERLESS_PADDING;
  /**
   * With wrap, the gutter is an in-flow cell at the start of every highlighted
   * row, so the highlight layer must **not** add its own left padding — that
   * doubled the inset and painted the text ~56px away from the caret.
   */
  const inlineGutter = preferences.lineNumbers && wrap;
  const highlightInset = inlineGutter ? 0 : textInset;
  const lineBoxHeight = preferences.fontSize * preferences.lineHeight;
  const lineNumbers = preferences.lineNumbers;

  const starts = useMemo(() => lineIndexFor(buffer.text), [buffer.text]);
  const lineCount = starts.length;

  const metrics = useMemo<CSSProperties>(
    () => ({
      fontSize: `${preferences.fontSize}px`,
      lineHeight: preferences.lineHeight,
      tabSize: preferences.tabSize,
      fontVariantLigatures: preferences.fontLigatures ? 'normal' : 'none',
      ...(preferences.fontFamily ? { fontFamily: preferences.fontFamily } : {}),
    }),
    [
      preferences.fontFamily,
      preferences.fontSize,
      preferences.lineHeight,
      preferences.tabSize,
      preferences.fontLigatures,
    ],
  );

  const highlightLanguage = useMemo(
    () => (prism.languages[language] ? language : 'text'),
    [language],
  );

  /* ------------------------------------------------------------------ */
  /* Paint window                                                        */
  /* ------------------------------------------------------------------ */

  const [paintWindow, setPaintWindow] = useState<LineWindow>(() =>
    visibleLineWindow({
      scrollTop: 0,
      viewportHeight: 0,
      rowHeight: lineBoxHeight,
      lineCount: starts.length,
    }),
  );
  /** Latest painted window, read by the scroll handler without re-rendering. */
  const paintedRef = useRef(paintWindow);
  paintedRef.current = paintWindow;
  const lineBoxHeightRef = useRef(lineBoxHeight);
  lineBoxHeightRef.current = lineBoxHeight;
  const lineCountRef = useRef(lineCount);
  lineCountRef.current = lineCount;
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;

  /** Window painted this render (wrapped text always paints the whole document). */
  const paint: LineWindow = wrap
    ? { start: 0, end: lineCount, padTop: 0, padBottom: 0, count: lineCount }
    : paintWindow;

  /**
   * Tokenize the visible window synchronously so the first paint already has
   * colors. The rest is filled by the background tiler in idle callbacks.
   */
  const focusStart = wrap ? 0 : paint.start;
  const focusEnd = wrap ? Math.min(lineCount, 40) : paint.end;
  const highlighting = useBackgroundHighlight({
    text: buffer.text,
    starts,
    language: highlightLanguage,
    enabled: preferences.highlight,
    focusStart,
    focusEnd,
  });

  const paintLines = useMemo<(TokenLine[] | string)[]>(() => {
    const slice = windowSlice(buffer.text, starts, paint.start, paint.end);
    // Huge minified lines are left to the background so typing never blocks.
    if (preferences.highlight && slice.code.length <= SYNC_TOKENIZE_MAX_CHARS) {
      highlighting.cache.ensureRange(
        buffer.text,
        starts,
        highlightLanguage,
        paint.start,
        paint.end,
      );
    }
    const lines: (TokenLine[] | string)[] = new Array<string | TokenLine[]>(paint.count);
    for (let index = 0; index < paint.count; index += 1) {
      const line = paint.start + index;
      // When the user turns highlighting off, never paint cached tokens.
      lines[index] =
        (preferences.highlight ? highlighting.cache.get(line) : undefined) ??
        lineText(buffer.text, line, starts);
    }
    return lines;
  }, [
    buffer.text,
    starts,
    paint.start,
    paint.end,
    paint.count,
    highlightLanguage,
    preferences.highlight,
    highlighting.cache,
    highlighting.version,
  ]);

  const gutterText = useMemo(() => {
    if (wrap || !lineNumbers || paint.count <= 0) return '';
    const numbers: string[] = new Array<string>(paint.count);
    for (let index = 0; index < paint.count; index += 1) {
      numbers[index] = String(paint.start + index + 1);
    }
    return numbers.join('\n');
  }, [wrap, lineNumbers, paint.start, paint.count]);

  /* ------------------------------------------------------------------ */
  /* Imperative scroll (never a React state update per event)            */
  /* ------------------------------------------------------------------ */

  const applyScrollVisuals = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    scrollTopRef.current = element.scrollTop;
    if (highlightLayerRef.current) {
      highlightLayerRef.current.style.transform =
        `translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`;
    }
    if (gutterBlockRef.current) {
      gutterBlockRef.current.style.transform = `translateY(${-element.scrollTop}px)`;
    }
  }, []);

  const persistScroll = useCallback(() => {
    persistTimerRef.current = null;
    useEditorStore.getState().setScrollTop(bufferKeyRef.current, scrollTopRef.current);
  }, []);

  const scheduleScrollPersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(persistScroll, SCROLL_PERSIST_MS);
  }, [persistScroll]);

  const repaintForScroll = useCallback((scrollTop: number, viewportHeight: number) => {
    if (wrapRef.current) return;
    const total = lineCountRef.current;
    const current = paintedRef.current;
    if (windowCoversDocument(current, total)) return;
    const row = lineBoxHeightRef.current;
    const first = Math.floor(scrollTop / row);
    const last = Math.ceil((scrollTop + viewportHeight) / row);
    // Hysteresis: repaint only when the viewport approaches the painted edges.
    const margin = WINDOW_OVERSCAN_LINES / 2;
    if (first >= current.start + margin && last <= current.end - margin) return;
    const next = visibleLineWindow({ scrollTop, viewportHeight, rowHeight: row, lineCount: total });
    setPaintWindow((previous) => (sameWindow(previous, next) ? previous : next));
  }, []);

  const handleScroll = () => {
    const element = textareaRef.current;
    if (!element) return;
    applyScrollVisuals();
    repaintForScroll(element.scrollTop, element.clientHeight);
    scheduleScrollPersist();
  };

  /* ------------------------------------------------------------------ */
  /* Document mutations                                                  */
  /* ------------------------------------------------------------------ */

  const commit = useCallback(
    (next: { text: string; selection: EditorSelection }, kind: string) => {
      const store = useEditorStore.getState();
      const history = pushHistory(
        buffer.history,
        { text: buffer.text, selection: buffer.selection },
        kind,
      );
      store.setText(buffer.key, next.text, next.selection);
      store.setHistory(buffer.key, history);
    },
    [buffer.history, buffer.key, buffer.selection, buffer.text],
  );

  const undo = useCallback(() => {
    const result = undoHistory(buffer.history, {
      text: buffer.text,
      selection: buffer.selection,
    });
    if (!result) return;
    const store = useEditorStore.getState();
    store.setText(buffer.key, result.snapshot.text, result.snapshot.selection);
    store.setHistory(buffer.key, result.history);
  }, [buffer.history, buffer.key, buffer.selection, buffer.text]);

  const redo = useCallback(() => {
    const result = redoHistory(buffer.history, {
      text: buffer.text,
      selection: buffer.selection,
    });
    if (!result) return;
    const store = useEditorStore.getState();
    store.setText(buffer.key, result.snapshot.text, result.snapshot.selection);
    store.setHistory(buffer.key, result.history);
  }, [buffer.history, buffer.key, buffer.selection, buffer.text]);

  const syncSelection = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    useEditorStore
      .getState()
      .setSelection(buffer.key, { anchor: element.selectionStart, head: element.selectionEnd });
  }, [buffer.key]);

  const applySelection = useCallback(
    (selection: EditorSelection) => {
      useEditorStore.getState().setSelection(buffer.key, selection);
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(
        selection.anchor,
        selection.head,
        selection.head < selection.anchor ? 'backward' : 'forward',
      );
    },
    [buffer.key],
  );

  const revealOffset = useCallback(
    (offset: number) => {
      const element = textareaRef.current;
      if (!element) return;
      const { line } = positionAt(buffer.text, offset, starts);
      const top = VERTICAL_PADDING + line * lineBoxHeight;
      const viewTop = element.scrollTop;
      const viewBottom = viewTop + element.clientHeight;
      if (top < viewTop + lineBoxHeight) {
        element.scrollTop = Math.max(0, top - lineBoxHeight * 2);
      } else if (top > viewBottom - lineBoxHeight * 2) {
        element.scrollTop = top - element.clientHeight + lineBoxHeight * 3;
      }
      applyScrollVisuals();
      repaintForScroll(element.scrollTop, element.clientHeight);
    },
    [applyScrollVisuals, buffer.text, lineBoxHeight, repaintForScroll, starts],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      revealOffset,
      openFind: (mode) => {
        const element = textareaRef.current;
        const selected = element
          ? buffer.text.slice(element.selectionStart, element.selectionEnd)
          : '';
        setFind({
          mode,
          query: selected && !selected.includes('\n') ? selected : lastQuery.current,
          replacement: '',
          options: { caseSensitive: false, wholeWord: false, regex: false },
          activeIndex: 0,
        });
      },
      openGoToLine: () => setGoToLine(''),
    }),
    [buffer.text, revealOffset],
  );

  /* ------------------------------------------------------------------ */
  /* Layout effects                                                      */
  /* ------------------------------------------------------------------ */

  const { anchor, head } = buffer.selection;
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (element.selectionStart !== anchor || element.selectionEnd !== head) {
      element.setSelectionRange(anchor, head, head < anchor ? 'backward' : 'forward');
    }
  }, [anchor, head, buffer.text]);

  /** Restores the saved scroll position when the tab mounts. */
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (buffer.scrollTop > 0 && element.scrollTop === 0) element.scrollTop = buffer.scrollTop;
    applyScrollVisuals();
    if (wrapRef.current) return;
    const next = visibleLineWindow({
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
      rowHeight: lineBoxHeightRef.current,
      lineCount: lineCountRef.current,
    });
    setPaintWindow((previous) => (sameWindow(previous, next) ? previous : next));
    // Mount / tab switch only: the scroll handler keeps the window fresh after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer.key]);

  /** Keeps the window and the transforms correct when metrics or wrap change. */
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    applyScrollVisuals();
    if (wrap) return;
    const next = visibleLineWindow({
      scrollTop: element.scrollTop,
      viewportHeight: element.clientHeight,
      rowHeight: lineBoxHeight,
      lineCount,
    });
    setPaintWindow((previous) => (sameWindow(previous, next) ? previous : next));
    // `starts.length` covers line-count changes without re-running per character.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap, lineBoxHeight, lineCount, metrics, textInset, scrollbarWidth, applyScrollVisuals]);

  /** Measures the scrollbar and the viewport (the window depends on both). */
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.offsetWidth - element.clientWidth;
      setScrollbarWidth((current) => (current === width ? current : width));
      applyScrollVisuals();
      repaintForScroll(element.scrollTop, element.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyScrollVisuals, repaintForScroll]);

  /** Applies the scroll transform after every render (two style writes). */
  useLayoutEffect(() => {
    applyScrollVisuals();
  });

  /** Flushes the pending scroll offset when the tab unmounts. */
  useEffect(
    () => () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistScroll();
      }
    },
    [persistScroll],
  );

  useLayoutEffect(() => {
    if (goToLine === null) return;
    goToLineRef.current?.focus();
    goToLineRef.current?.select();
  }, [goToLine]);

  /* ------------------------------------------------------------------ */
  /* Keyboard                                                            */
  /* ------------------------------------------------------------------ */

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    const lower = key.toLowerCase();
    /** The caret in the DOM is authoritative (arrows/click already moved it). */
    const state = {
      text: buffer.text,
      selection: { anchor: element.selectionStart, head: element.selectionEnd },
    };
    const options = {
      tabSize: buffer.indentation.tabSize,
      insertSpaces: buffer.indentation.insertSpaces,
      autoIndent: preferences.autoIndent,
      autoCloseBrackets: preferences.autoCloseBrackets,
    };

    if (mod && lower === 's') {
      event.preventDefault();
      if (event.shiftKey) onSaveAs();
      else onSave();
      return;
    }
    if (mod && lower === 'f') {
      event.preventDefault();
      const selected = element.value.slice(element.selectionStart, element.selectionEnd);
      lastQuery.current = selected && !selected.includes('\n') ? selected : lastQuery.current;
      setFind({
        mode: 'find',
        query: lastQuery.current,
        replacement: '',
        options: { caseSensitive: false, wholeWord: false, regex: false },
        activeIndex: 0,
      });
      return;
    }
    if (mod && lower === 'h') {
      event.preventDefault();
      setFind((current) => ({
        mode: 'replace',
        query: current?.query ?? '',
        replacement: current?.replacement ?? '',
        options: current?.options ?? { caseSensitive: false, wholeWord: false, regex: false },
        activeIndex: 0,
      }));
      return;
    }
    if (mod && lower === 'g') {
      event.preventDefault();
      setGoToLine('');
      return;
    }
    if (mod && lower === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && lower === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && key === '/') {
      event.preventDefault();
      commit(toggleLineComment(state, commentTokensForLanguage(language)), 'command');
      return;
    }
    if (mod && event.shiftKey && lower === 'k') {
      event.preventDefault();
      commit(deleteLines(state), 'command');
      return;
    }
    if (event.altKey && event.shiftKey && key === 'ArrowDown') {
      event.preventDefault();
      commit(duplicateLines(state), 'command');
      return;
    }
    if (event.altKey && !event.shiftKey && !mod && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      commit(moveLines(state, key === 'ArrowUp' ? 'up' : 'down'), 'command');
      return;
    }
    if (key === 'Escape' && find) {
      event.preventDefault();
      setFind(null);
      return;
    }
    if (key === 'Escape' && goToLine !== null) {
      event.preventDefault();
      setGoToLine(null);
      element.focus();
      return;
    }
    if (key === 'Tab' && !event.altKey && !mod) {
      event.preventDefault();
      commit(
        event.shiftKey ? outdentSelection(state, options) : indentSelection(state, options),
        'command',
      );
      return;
    }
    if (key === 'Enter' && !event.nativeEvent.isComposing) {
      const start = selectionStart(state.selection);
      const betweenPair =
        options.autoCloseBrackets &&
        state.text[start - 1] !== undefined &&
        state.text[start] !== undefined &&
        `${state.text[start - 1]}${state.text[start]}` in {
          '()': true,
          '[]': true,
          '{}': true,
          '""': true,
          "''": true,
          '``': true,
        };
      if (options.autoIndent || betweenPair) {
        event.preventDefault();
        commit(insertNewline(state, options), 'command');
        return;
      }
    }
    if (key === 'Backspace' && !event.nativeEvent.isComposing && options.autoCloseBrackets) {
      const start = selectionStart(state.selection);
      const end = selectionEnd(state.selection);
      if (start === end) {
        const previous = state.text[start - 1];
        const next = state.text[start];
        if (
          previous !== undefined &&
          next !== undefined &&
          ((previous === '(' && next === ')') ||
            (previous === '[' && next === ']') ||
            (previous === '{' && next === '}') ||
            (previous === '"' && next === '"') ||
            (previous === "'" && next === "'") ||
            (previous === '`' && next === '`'))
        ) {
          event.preventDefault();
          const text = `${state.text.slice(0, start - 1)}${state.text.slice(start + 1)}`;
          commit({ text, selection: { anchor: start - 1, head: start - 1 } }, 'delete');
          return;
        }
      }
    }
    if (
      !mod &&
      !event.altKey &&
      key.length === 1 &&
      !event.nativeEvent.isComposing &&
      options.autoCloseBrackets &&
      PAIR_CHARACTERS.has(key)
    ) {
      event.preventDefault();
      commit(insertText(state, key, options), 'typing');
    }
  };

  /* ------------------------------------------------------------------ */
  /* Find / replace                                                      */
  /* ------------------------------------------------------------------ */

  /* Matches for display are debounced: a keystroke must not scan the document. */
  useEffect(() => {
    if (!find || find.query.length === 0) {
      setFindResult(null);
      return undefined;
    }
    const timer = setTimeout(() => {
      setFindResult({ text: buffer.text, result: findMatches(buffer.text, find.query, find.options) });
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [buffer.text, find]);

  const matches = useMemo<SearchResult>(() => {
    if (!find || find.query.length === 0) return EMPTY_SEARCH;
    // At most `FIND_DEBOUNCE_MS` stale while typing: the previous count stays
    // visible instead of re-scanning on every keystroke.
    return findResult?.result ?? EMPTY_SEARCH;
  }, [find, findResult]);

  const activeIndex = useMemo(() => {
    if (!find || matches.matches.length === 0) return -1;
    if (find.activeIndex >= 0 && find.activeIndex < matches.matches.length) return find.activeIndex;
    return activeMatchIndex(matches.matches, selectionStart(buffer.selection));
  }, [buffer.selection, find, matches.matches]);

  /** Fresh scan for explicit actions (navigation, replace) — never per keystroke. */
  const scanMatches = (state: FindState): SearchMatch[] =>
    state.query.length === 0 ? [] : findMatches(buffer.text, state.query, state.options).matches;

  const moveMatch = (direction: 1 | -1) => {
    if (!find) return;
    const list = scanMatches(find);
    if (list.length === 0) return;
    const current = activeMatchIndex(list, selectionStart(buffer.selection));
    const index = (current + direction + list.length) % list.length;
    const match = list[index];
    setFind({ ...find, activeIndex: index });
    applySelection(matchSelection(match));
    revealOffset(match.start);
  };

  const replaceOne = () => {
    if (!find) return;
    const list = scanMatches(find);
    if (list.length === 0) return;
    const index = activeIndex >= 0 ? Math.min(activeIndex, list.length - 1) : 0;
    const match = list[index];
    if (!match) return;
    commit(replaceMatch(buffer.text, match, find.replacement), 'command');
    setFind({ ...find, activeIndex: index });
    revealOffset(match.start);
  };

  const replaceAll = () => {
    if (!find) return;
    const list = scanMatches(find);
    if (list.length === 0) return;
    const result = replaceAllMatches(buffer.text, list, find.replacement);
    commit({ text: result.text, selection: result.selection }, 'command');
    setFind({ ...find, activeIndex: 0 });
  };

  const closeFind = () => {
    setFind(null);
    textareaRef.current?.focus();
  };

  const submitGoToLine = () => {
    if (goToLine === null) return;
    const target = Number.parseInt(goToLine, 10);
    setGoToLine(null);
    if (!Number.isFinite(target) || target < 1) return;
    const offset = offsetAt(buffer.text, { line: target - 1, column: 0 }, starts);
    applySelection({ anchor: offset, head: offset });
    revealOffset(offset);
  };

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  return (
    <div
      className={cn('relative min-h-0 flex-1 overflow-hidden bg-background', className)}
      style={viewerStyle}
      data-testid="code-editor"
    >
      {/* Line-number gutter (unwrapped text): a windowed column, translated vertically. */}
      {lineNumbers && !wrap ? (
        <div
          aria-hidden
          data-editor-gutter-column="true"
          className="pointer-events-none absolute inset-y-0 left-0 z-10 overflow-hidden bg-background"
          style={{ width: GUTTER_WIDTH }}
        >
          <div
            ref={gutterBlockRef}
            style={{
              paddingTop: VERTICAL_PADDING + paint.padTop,
              paddingBottom: VERTICAL_PADDING + paint.padBottom,
            }}
          >
            <pre
              className="m-0 font-mono text-[10.5px] tabular-nums text-foreground-subtle"
              style={{
                lineHeight: `${lineBoxHeight}px`,
                textAlign: 'right',
                paddingRight: GUTTER_PADDING_RIGHT,
              }}
            >
              {gutterText}
            </pre>
          </div>
        </div>
      ) : null}

      {/* Highlight layer: clipped, translated by the textarea scroll (imperative). */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          ref={highlightLayerRef}
          data-editor-layer="true"
          style={{ width: wrap ? '100%' : 'max-content', minWidth: '100%' }}
        >
          <PaintedRows
            lines={paintLines}
            wrap={wrap}
            lineNumbers={lineNumbers}
            lineHeightPx={lineBoxHeight}
            startLine={paint.start}
            paddingTop={VERTICAL_PADDING + paint.padTop}
            paddingBottom={VERTICAL_PADDING + paint.padBottom}
            paddingLeft={highlightInset}
            paddingRight={RIGHT_PADDING + scrollbarWidth}
            metrics={metrics}
          />
        </div>
      </div>

      <textarea
        ref={textareaRef}
        value={buffer.text}
        aria-label={t('code:editor.content', { path: buffer.path })}
        aria-multiline
        data-testid="code-editor-textarea"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        wrap={wrap ? 'soft' : 'off'}
        // `font-mono` must match the highlight layer: the caret and the click
        // mapping come from the textarea's own text metrics, so a different font
        // (or advance width) makes them drift away from the painted glyphs.
        className="absolute inset-0 size-full resize-none overflow-auto bg-transparent font-mono text-transparent caret-foreground outline-none selection:bg-accent/30"
        style={{
          ...metrics,
          paddingTop: VERTICAL_PADDING,
          paddingBottom: VERTICAL_PADDING,
          paddingLeft: textInset,
          paddingRight: RIGHT_PADDING,
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          overflowWrap: wrap ? 'break-word' : 'normal',
        }}
        onChange={(event) => {
          // Native path: the DOM already holds the new value.
          const element = event.currentTarget;
          const selection = { anchor: element.selectionStart, head: element.selectionEnd };
          const previousLength = buffer.text.length;
          const nextLength = element.value.length;
          const kind =
            nextLength < previousLength
              ? 'delete'
              : Math.abs(nextLength - previousLength) > 1
                ? 'command'
                : 'typing';
          commit({ text: element.value, selection }, kind);
        }}
        onInput={undefined}
        onScroll={handleScroll}
        onSelect={syncSelection}
        onClick={syncSelection}
        onKeyUp={syncSelection}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          syncSelection();
          lastQuery.current = find?.query ?? lastQuery.current;
        }}
      />

      {preferences.highlight && highlighting.pending > 0 ? (
        <div className="pointer-events-none absolute bottom-2 right-3 z-10 rounded-md bg-surface-raised px-2 py-1 text-[10.5px] text-foreground-subtle shadow-sm">
          {t('code:editor.highlighting')}
        </div>
      ) : null}

      {goToLine !== null ? (
        <div className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-surface-raised p-1 pl-2 shadow-lg">
          <label
            htmlFor="code-editor-goto"
            className="text-[11px] font-medium text-foreground-muted"
          >
            {t('code:editor.goto.label')}
          </label>
          <input
            id="code-editor-goto"
            ref={goToLineRef}
            value={goToLine}
            inputMode="numeric"
            aria-label={t('code:editor.goto.label')}
            placeholder={t('code:editor.goto.placeholder')}
            className="h-8 w-24 rounded-lg bg-surface-hover px-2 font-mono text-[12px] text-foreground placeholder:text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setGoToLine(event.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitGoToLine();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setGoToLine(null);
                textareaRef.current?.focus();
              }
            }}
          />
        </div>
      ) : null}

      {find ? (
        <EditorFindBar
          mode={find.mode}
          query={find.query}
          replacement={find.replacement}
          options={find.options}
          matchCount={matches.matches.length}
          activeIndex={activeIndex}
          limited={matches.limited}
          invalid={matches.error !== null}
          onChangeQuery={(query) => {
            lastQuery.current = query;
            setFind({ ...find, query, activeIndex: 0 });
          }}
          onChangeReplacement={(replacement) => setFind({ ...find, replacement })}
          onChangeOptions={(options) => setFind({ ...find, options, activeIndex: 0 })}
          onNext={() => moveMatch(1)}
          onPrevious={() => moveMatch(-1)}
          onReplace={replaceOne}
          onReplaceAll={replaceAll}
          onClose={closeFind}
        />
      ) : null}
    </div>
  );
});

export default CodeEditor;
