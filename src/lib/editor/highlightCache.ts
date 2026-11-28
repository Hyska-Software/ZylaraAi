/**
 * Tiled syntax-highlight cache for the in-app editor.
 *
 * Prism tokenizes a whole document in one pass (a 3 000-line TypeScript file
 * costs ~42 ms on this machine), which is fine once but not on every keystroke.
 * The editor keeps tokenized **tiles** of consecutive lines: a tile is
 * re-tokenized only when its text (or the context above it) changes, and tiles
 * outside the painted window are computed in idle time by the React hook.
 *
 * Multi-line constructs are handled by tokenizing each tile with `context`
 * lines above it and dropping those context lines from the result, so a block
 * comment or template literal started earlier still colors correctly.
 */

import { windowSlice } from './tokenWindow';

/** Lines per tile: ~200 lines tokenize in a few ms. */
export const HIGHLIGHT_TILE_LINES = 200;
/** Lines of context above a tile, so multi-line constructs keep their state. */
export const HIGHLIGHT_CONTEXT_LINES = 120;

export interface TokenLine {
  types: string[];
  content: string;
}

export interface HighlightTile {
  /** First painted line of the tile (0-based). */
  startLine: number;
  /** Last painted line (exclusive). */
  endLine: number;
  /** First line actually tokenized, including context. */
  contextStartLine: number;
  /** Text of the tokenized slice. */
  code: string;
  /** Content/language signature; changes when this tile must be recomputed. */
  signature: string;
}

interface CachedTile {
  signature: string;
  lines: TokenLine[][];
}

/** Tokenize one slice and normalize it into one array of tokens per line. */
export function normalizeTokens(tokens: unknown[]): TokenLine[][] {
  const lines: TokenLine[][] = [[]];

  const push = (content: string, types: string[]) => {
    const parts = content.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) lines.push([]);
      lines[lines.length - 1].push({ types, content: parts[index] });
    }
  };

  const walk = (items: unknown[], types: string[]) => {
    for (const item of items) {
      if (typeof item === 'string') {
        push(item, types.length > 0 ? types : ['plain']);
        continue;
      }
      if (typeof item !== 'object' || item === null) continue;
      const token = item as {
        type?: string;
        alias?: string | string[];
        content?: unknown[] | string;
      };
      const next = [...types];
      if (typeof token.type === 'string') next.push(token.type);
      if (typeof token.alias === 'string') next.push(token.alias);
      else if (Array.isArray(token.alias)) next.push(...token.alias);
      if (Array.isArray(token.content)) walk(token.content, next);
      else push(String(token.content ?? ''), next);
    }
  };

  walk(tokens, []);
  return lines;
}

/** Fast, non-cryptographic content signature (FNV-1a over UTF-16 code units). */
export function signatureOf(code: string, language: string): string {
  let hash = 0x811c9dc5;
  const input = `${language}\0${code}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Stores tokenized tiles keyed by their first painted line. */
export class HighlightCache {
  private readonly tiles = new Map<number, CachedTile>();

  constructor(private readonly tokenize: (code: string, language: string) => TokenLine[][]) {}

  /** Drops all tiles (used when the language changes). */
  clear(): void {
    this.tiles.clear();
  }

  /** Cached tokens for one line, or `undefined` while the tile is not ready. */
  get(line: number): TokenLine[] | undefined {
    const tile = this.tiles.get(Math.floor(line / HIGHLIGHT_TILE_LINES));
    return tile?.lines[line - Math.floor(line / HIGHLIGHT_TILE_LINES) * HIGHLIGHT_TILE_LINES];
  }

  private tileAt(text: string, starts: number[], language: string, index: number): HighlightTile {
    const startLine = index * HIGHLIGHT_TILE_LINES;
    const endLine = Math.min(starts.length, startLine + HIGHLIGHT_TILE_LINES);
    const slice = windowSlice(
      text,
      starts,
      startLine,
      endLine,
      HIGHLIGHT_CONTEXT_LINES,
    );
    // The signature includes the context: if a multi-line construct changes
    // above the tile, its tokens must be recomputed.
    return {
      startLine,
      endLine,
      contextStartLine: slice.firstLine,
      code: slice.code,
      signature: signatureOf(slice.code, language),
    };
  }

  /**
   * Tokenizes the given line range synchronously (used for the painted window).
   * Returns `true` if any tile changed.
   */
  ensureRange(
    text: string,
    starts: number[],
    language: string,
    startLine: number,
    endLine: number,
  ): boolean {
    const first = Math.max(0, Math.floor(startLine / HIGHLIGHT_TILE_LINES));
    const last = Math.floor(Math.max(startLine, endLine - 1) / HIGHLIGHT_TILE_LINES);
    let changed = false;
    for (let index = first; index <= last; index += 1) {
      changed = this.compute(this.tileAt(text, starts, language, index), language) || changed;
    }
    this.prune(starts.length);
    return changed;
  }

  /**
   * Lists tiles that are missing or stale, ordered by distance from the focus
   * range so the viewport is colored first during background work.
   */
  plan(
    text: string,
    starts: number[],
    language: string,
    focusStart: number,
    focusEnd: number,
  ): HighlightTile[] {
    const total = Math.ceil(starts.length / HIGHLIGHT_TILE_LINES);
    const pending: HighlightTile[] = [];
    for (let index = 0; index < total; index += 1) {
      const tile = this.tileAt(text, starts, language, index);
      if (this.tiles.get(index)?.signature === tile.signature) continue;
      pending.push(tile);
    }
    pending.sort((left, right) => {
      const distance = (tile: HighlightTile) =>
        tile.endLine <= focusStart
          ? focusStart - tile.endLine
          : tile.startLine >= focusEnd
            ? tile.startLine - focusEnd
            : 0;
      return distance(left) - distance(right);
    });
    return pending;
  }

  /** Tokenizes one tile. Returns `true` when the stored tokens changed. */
  compute(tile: HighlightTile, language: string): boolean {
    const existing = this.tiles.get(Math.floor(tile.startLine / HIGHLIGHT_TILE_LINES));
    if (existing?.signature === tile.signature) return false;

    let lines: TokenLine[][];
    try {
      lines = this.tokenize(tile.code, language).slice(tile.startLine - tile.contextStartLine);
    } catch {
      lines = tile.code.split('\n').map((content) => [{ types: ['plain'], content }]);
    }
    // Keep the exact painted line count even if a grammar returns fewer lines.
    const expected = tile.endLine - tile.startLine;
    while (lines.length < expected) lines.push([{ types: ['plain'], content: '' }]);
    if (lines.length > expected) lines.length = expected;

    this.tiles.set(Math.floor(tile.startLine / HIGHLIGHT_TILE_LINES), {
      signature: tile.signature,
      lines,
    });
    return true;
  }

  private prune(lineCount: number): void {
    const total = Math.ceil(Math.max(1, lineCount) / HIGHLIGHT_TILE_LINES);
    for (const index of this.tiles.keys()) {
      if (index >= total) this.tiles.delete(index);
    }
  }
}
