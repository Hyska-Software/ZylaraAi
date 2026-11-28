import { describe, expect, it } from 'vitest';

import {
  visibleLineWindow,
  WINDOW_OVERSCAN_LINES,
  windowCoversDocument,
} from '../virtualize';

const base = { rowHeight: 20, scrollTop: 0, viewportHeight: 600, lineCount: 5_000 };

describe('visibleLineWindow', () => {
  it('paints the viewport plus the overscan around it', () => {
    const window = visibleLineWindow(base);
    expect(window.start).toBe(0);
    // 600 / 20 = 30 visible rows + 1 lookahead + overscan below.
    expect(window.end).toBe(31 + WINDOW_OVERSCAN_LINES);
    expect(window.count).toBe(window.end - window.start);
    expect(window.padTop).toBe(0);
    expect(window.padBottom).toBe((base.lineCount - window.end) * base.rowHeight);
  });

  it('moves the window with the scroll and keeps the paddings exact', () => {
    const window = visibleLineWindow({ ...base, scrollTop: 1_000 });
    expect(window.start).toBe(50 - WINDOW_OVERSCAN_LINES);
    expect(window.padTop).toBe(window.start * base.rowHeight);
    expect(window.end).toBe(81 + WINDOW_OVERSCAN_LINES);
    // Painted block + paddings reproduce the full document height.
    const painted = window.count * base.rowHeight;
    expect(window.padTop + painted + window.padBottom).toBe(base.lineCount * base.rowHeight);
  });

  it('clamps at the end of the document', () => {
    const window = visibleLineWindow({
      ...base,
      scrollTop: (base.lineCount - 30) * base.rowHeight,
    });
    expect(window.end).toBe(base.lineCount);
    expect(window.padBottom).toBe(0);
    expect(window.count).toBeLessThanOrEqual(31 + WINDOW_OVERSCAN_LINES * 2);
  });

  it('never returns an empty window', () => {
    expect(visibleLineWindow({ ...base, lineCount: 1, viewportHeight: 0 })).toMatchObject({
      start: 0,
      end: 1,
      padTop: 0,
      padBottom: 0,
      count: 1,
    });
    // A viewport of 0 (jsdom) still paints one line plus overscan.
    const tiny = visibleLineWindow({ ...base, viewportHeight: 0 });
    expect(tiny.count).toBe(1 + WINDOW_OVERSCAN_LINES);
  });

  it('survives degenerate inputs', () => {
    const window = visibleLineWindow({
      ...base,
      scrollTop: Number.NaN,
      viewportHeight: Number.NaN,
      rowHeight: 0,
      lineCount: 0,
    });
    expect(window.start).toBe(0);
    expect(window.end).toBe(1);
    expect(window.padBottom).toBe(0);
  });

  it('reports when the window covers the whole document', () => {
    const whole = visibleLineWindow({ ...base, lineCount: 10 });
    expect(windowCoversDocument(whole, 10)).toBe(true);
    const partial = visibleLineWindow({ ...base, lineCount: 5_000 });
    expect(windowCoversDocument(partial, 5_000)).toBe(false);
  });
});
