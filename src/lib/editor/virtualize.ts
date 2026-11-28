/**
 * Windowing math for the in-app editor's painted layer.
 *
 * The `<textarea>` owns the document and the scroll; the Prism layer only paints
 * the glyphs. Painting every line of a large file is what made typing and
 * scrolling cost O(document), so the layer renders a **window** of lines around
 * the viewport and reserves the rest of the height with paddings.
 *
 * Only valid for unwrapped text, where a line is exactly `rowHeight` tall — the
 * wrapped mode keeps the whole document because only the browser knows the
 * heights of wrapped lines.
 */

/** Extra lines painted above and below the viewport. */
export const WINDOW_OVERSCAN_LINES = 40;

export interface LineWindowInput {
  /** Current vertical scroll offset of the textarea. */
  scrollTop: number;
  /** Visible height of the textarea (its client height). */
  viewportHeight: number;
  /** Height of one unwrapped line in px (`fontSize * lineHeight`). */
  rowHeight: number;
  /** Total number of lines in the document (at least 1). */
  lineCount: number;
  overscan?: number;
}

export interface LineWindow {
  /** First painted line (0-based, inclusive). */
  start: number;
  /** Last painted line (exclusive). */
  end: number;
  /** Height reserved above the painted window. */
  padTop: number;
  /** Height reserved below the painted window. */
  padBottom: number;
  /** Number of painted lines (`end - start`). */
  count: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Window of lines that must be painted for the current scroll position. */
export function visibleLineWindow({
  scrollTop,
  viewportHeight,
  rowHeight,
  lineCount,
  overscan = WINDOW_OVERSCAN_LINES,
}: LineWindowInput): LineWindow {
  const row = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 1;
  const total = Math.max(1, Math.round(lineCount));
  const viewport = Math.max(0, viewportHeight);

  const top = clamp(scrollTop, 0, Math.max(0, total * row));
  const firstVisible = Math.floor(top / row);
  const visibleCount = Math.max(1, Math.ceil(viewport / row) + 1);
  const margin = Math.max(0, Math.round(overscan));

  const start = clamp(firstVisible - margin, 0, total - 1);
  const end = clamp(firstVisible + visibleCount + margin, start + 1, total);
  return {
    start,
    end,
    padTop: start * row,
    padBottom: (total - end) * row,
    count: end - start,
  };
}

/** True when the window paints the whole document (nothing to window). */
export function windowCoversDocument(window: LineWindow, lineCount: number): boolean {
  return window.start === 0 && window.end >= Math.max(1, lineCount);
}
