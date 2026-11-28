/**
 * Find and replace for the in-app editor.
 *
 * Matching is UTF-16 offset based like the rest of the editor, so a match can be
 * selected in the textarea without conversion. Regexes are the user's own and
 * their syntax errors are returned instead of thrown.
 */

import type { EditorSelection } from './text';

export interface SearchOptions {
  caseSensitive: boolean;
  /** Only match at word boundaries. */
  wholeWord: boolean;
  /** Treat the query as a regular expression. */
  regex: boolean;
}

export interface SearchMatch {
  start: number;
  end: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** Regex compilation error, shown next to the field. */
  error: string | null;
  /** True when the match list was capped (`SEARCH_MATCH_LIMIT`). */
  limited: boolean;
}

/** Hard cap so a pathological regex cannot freeze the editor. */
export const SEARCH_MATCH_LIMIT = 10_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegExp(query: string, options: SearchOptions): RegExp | null {
  let source = options.regex ? query : escapeRegExp(query);
  if (options.wholeWord) {
    const startsWithWord = /^[\w$]/.test(query);
    const endsWithWord = /[\w$]$/.test(query);
    if (startsWithWord) source = `\\b${source}`;
    if (endsWithWord) source = `${source}\\b`;
  }
  try {
    // `m` makes `^`/`$` match per line, like every code editor's find box.
    const flags = `${options.caseSensitive ? 'g' : 'gi'}${options.regex ? 'm' : ''}`;
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** All matches of `query` in `text`, in document order. */
export function findMatches(text: string, query: string, options: SearchOptions): SearchResult {
  if (query.length === 0) return { matches: [], error: null, limited: false };

  const pattern = buildRegExp(query, options);
  if (!pattern) return { matches: [], error: 'invalid', limited: false };

  const matches: SearchMatch[] = [];
  let limited = false;
  let guard = 0;
  for (;;) {
    const next = pattern.exec(text);
    if (!next) break;
    matches.push({ start: next.index, end: next.index + next[0].length });
    // Zero-length matches (e.g. `^` or `a*`) must advance or the loop spins.
    if (next[0].length === 0) pattern.lastIndex += 1;
    guard += 1;
    if (matches.length >= SEARCH_MATCH_LIMIT) {
      limited = true;
      break;
    }
    if (guard > SEARCH_MATCH_LIMIT * 2) break;
  }
  return { matches, error: null, limited };
}

/**
 * Index of the match that should be highlighted for a caret/selection at
 * `offset`. When the caret sits inside a match that one wins; otherwise the
 * next match after the caret (wrapping to the first).
 */
export function activeMatchIndex(matches: SearchMatch[], offset: number): number {
  if (matches.length === 0) return -1;
  const inside = matches.findIndex((match) => offset >= match.start && offset <= match.end);
  if (inside >= 0) return inside;
  const next = matches.findIndex((match) => match.start > offset);
  return next >= 0 ? next : 0;
}

export function matchSelection(match: SearchMatch): EditorSelection {
  return { anchor: match.start, head: match.end };
}

/** Replaces one match with literal text; the caret lands after the replacement. */
export function replaceMatch(
  text: string,
  match: SearchMatch,
  replacement: string,
): { text: string; selection: EditorSelection } {
  const updated = `${text.slice(0, match.start)}${replacement}${text.slice(match.end)}`;
  const caret = match.start + replacement.length;
  return { text: updated, selection: { anchor: caret, head: caret } };
}

/**
 * Replaces every match at once. Replacements are literal (no `$1` expansion) so
 * the result never depends on capture-group numbering.
 */
export function replaceAllMatches(
  text: string,
  matches: SearchMatch[],
  replacement: string,
): { text: string; selection: EditorSelection; count: number } {
  if (matches.length === 0) {
    return { text, selection: { anchor: 0, head: 0 }, count: 0 };
  }
  let updated = '';
  let cursor = 0;
  for (const match of matches) {
    updated += text.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  updated += text.slice(cursor);
  return { text: updated, selection: { anchor: 0, head: 0 }, count: matches.length };
}
