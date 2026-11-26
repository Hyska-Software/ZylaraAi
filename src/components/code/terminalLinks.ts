/**
 * Hyperlinks in the Code terminal.
 *
 * PTY output is plain text most of the time (Vite, package managers, git...),
 * so xterm alone cannot know that `http://localhost:1420/` is clickable. This
 * module registers a link provider for those URLs and a shared handler for OSC 8
 * hyperlinks, both opening through the app's external URL opener.
 */
import type { ILink, ILinkHandler, ILinkProvider, Terminal as XTerm } from '@xterm/xterm';

import { openExternalUrl } from '@/components/chat/external';

export interface TerminalLinkMatch {
  /** The validated URL. */
  url: string;
  /** 0-based, inclusive start offset in the buffer line. */
  start: number;
  /** 0-based, exclusive end offset in the buffer line. */
  end: number;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_SENTENCE_PUNCTUATION = /[.,;:!?]+$/;
const CLOSING_DELIMITERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countOccurrences(text: string, character: string): number {
  let count = 0;
  for (const current of text) {
    if (current === character) count += 1;
  }
  return count;
}

/** Removes punctuation a shell added after a URL, keeping balanced brackets. */
function trimTrailingPunctuation(raw: string): string {
  let url = raw.replace(TRAILING_SENTENCE_PUNCTUATION, '');
  while (url.length > 0) {
    const opener = CLOSING_DELIMITERS[url[url.length - 1]];
    if (!opener || countOccurrences(url, opener) >= countOccurrences(url, url[url.length - 1])) {
      break;
    }
    url = url.slice(0, -1).replace(TRAILING_SENTENCE_PUNCTUATION, '');
  }
  return url;
}

/**
 * Finds http(s) URLs in one terminal line, with 0-based offsets suitable for
 * xterm's 1-based buffer ranges. Invalid/unsupported schemes are skipped.
 */
export function findTerminalLinks(text: string): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const url = trimTrailingPunctuation(match[0]);
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    matches.push({ url, start: match.index, end: match.index + url.length });
  }
  return matches;
}

/** xterm link provider for URLs written directly to the terminal buffer. */
export function createTerminalUrlLinkProvider(term: XTerm): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = y >= 1 ? term.buffer.active.getLine(y - 1) : undefined;
      const text = line?.translateToString(true, 0, term.cols) ?? '';
      const matches = findTerminalLinks(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      callback(
        matches.map(({ url, start, end }): ILink => ({
          text: url,
          // xterm buffer positions are 1-based; `end` is inclusive.
          range: {
            start: { x: start + 1, y },
            end: { x: end, y },
          },
          decorations: { pointerCursor: true, underline: true },
          activate: () => {
            void openExternalUrl(url);
          },
        })),
      );
    },
  };
}

/**
 * Handler for OSC 8 hyperlinks emitted by modern CLI tools. Without it xterm
 * falls back to a native `confirm()` warning; non-HTTP protocols keep being
 * ignored by xterm (`allowNonHttpProtocols` stays false).
 */
export function createTerminalLinkHandler(): ILinkHandler {
  return {
    activate: (_event, text) => {
      void openExternalUrl(text);
    },
  };
}
