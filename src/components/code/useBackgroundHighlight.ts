/**
 * Background syntax highlighting for the in-app editor.
 *
 * The painted document is split into tiles of 200 lines. The visible window is
 * tokenized synchronously (it is small), while the remaining tiles are filled
 * during idle callbacks with a small time budget, so even a 20 000-line file
 * gets colors without blocking input. Tiles whose content signature did not
 * change are reused from the previous keystroke.
 */

import { useEffect, useRef, useState } from 'react';

import {
  HighlightCache,
  normalizeTokens,
  type TokenLine,
} from '@/lib/editor';
import { prism } from '@/lib/highlight';

/** Maximum time spent tokenizing per idle callback. */
const IDLE_BUDGET_MS = 6;
/** Fallback delay when `requestIdleCallback` is not available. */
const FALLBACK_DELAY_MS = 0;
/**
 * Prism can spend seconds on pathological lines (e.g. 60 000 repeated chars).
 * Only this many characters per line are tokenized; the rest stays plain.
 * Real source lines are far shorter, so they keep full colors.
 */
const MAX_TOKENIZE_LINE_CHARS = 2_000;

export interface BackgroundHighlight {
  /** Tile cache; the caller reads tokens for the painted lines. */
  cache: HighlightCache;
  /** Increments whenever cached tokens change (to refresh the painted layer). */
  version: number;
  /** Number of tiles still waiting to be tokenized. */
  pending: number;
}

/**
 * Tokenizes one slice with the shared Prism instance. Oversized single lines
 * are truncated for Prism and their tail is appended as a plain token, so one
 * pathological line cannot block the UI or lose the rest of the file's colors.
 */
export function tokenizeWithPrism(code: string, language: string): TokenLine[][] {
  const grammar = prism.languages[language];
  const plain = (content: string): TokenLine[] => [{ types: ['plain'], content }];
  if (!grammar) return code.split('\n').map(plain);

  try {
    const tails = new Map<number, string>();
    const normalizedCode = code
      .split('\n')
      .map((line, index) => {
        if (line.length <= MAX_TOKENIZE_LINE_CHARS) return line;
        tails.set(index, line.slice(MAX_TOKENIZE_LINE_CHARS));
        return line.slice(0, MAX_TOKENIZE_LINE_CHARS);
      })
      .join('\n');
    // Prism's grammar type is internal to `prism-react-renderer`; the runtime
    // shape is a plain token grammar object.
    const tokens = prism.tokenize(
      normalizedCode,
      grammar as Parameters<typeof prism.tokenize>[1],
    );
    const lines = normalizeTokens(tokens as unknown[]);
    for (const [index, tail] of tails) {
      const line = lines[index];
      if (line && tail) line.push(...plain(tail));
    }
    return lines;
  } catch {
    // A broken third-party grammar must never break the editor.
    return code.split('\n').map(plain);
  }
}

/**
 * Keeps a tiled token cache in sync with the editor buffer. Work outside the
 * painted window is scheduled in idle time, prioritized by viewport distance.
 */
export function useBackgroundHighlight({
  text,
  starts,
  language,
  enabled,
  focusStart,
  focusEnd,
}: {
  text: string;
  starts: number[];
  language: string;
  enabled: boolean;
  focusStart: number;
  focusEnd: number;
}): BackgroundHighlight {
  const cacheRef = useRef<HighlightCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new HighlightCache(tokenizeWithPrism);
  const cache = cacheRef.current;

  const focusRef = useRef({ start: focusStart, end: focusEnd });
  focusRef.current = { start: focusStart, end: focusEnd };

  const [state, setState] = useState({ version: 0, pending: 0 });

  // A language switch invalidates every tile (different grammar).
  useEffect(() => {
    cache.clear();
    setState((current) => ({ version: current.version + 1, pending: 0 }));
  }, [cache, language]);

  useEffect(() => {
    if (!enabled) {
      setState((current) => (current.pending === 0 ? current : { ...current, pending: 0 }));
      return undefined;
    }

    const tasks = cache.plan(text, starts, language, focusRef.current.start, focusRef.current.end);
    if (tasks.length === 0) {
      setState((current) => (current.pending === 0 ? current : { ...current, pending: 0 }));
      return undefined;
    }

    let cancelled = false;
    let index = 0;
    let idleId: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = (deadline?: IdleDeadline) => {
      if (cancelled) return;
      const begin = performance.now();
      let changed = false;
      while (index < tasks.length) {
        if (performance.now() - begin >= IDLE_BUDGET_MS) break;
        if (deadline !== undefined && deadline.timeRemaining() < 1) break;
        changed = cache.compute(tasks[index], language) || changed;
        index += 1;
      }
      if (cancelled) return;
      const pending = tasks.length - index;
      setState((current) => ({
        version: current.version + (changed ? 1 : 0),
        pending,
      }));
      if (pending > 0) schedule();
    };

    const schedule = () => {
      if (typeof requestIdleCallback === 'function') {
        idleId = requestIdleCallback(run, { timeout: 250 });
      } else {
        timer = setTimeout(() => run(), FALLBACK_DELAY_MS);
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (idleId !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId);
      if (timer !== null) clearTimeout(timer);
    };
  }, [cache, enabled, language, starts, text]);

  return { cache, version: state.version, pending: state.pending };
}
