// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILink, ILinkProvider, Terminal as XTerm } from '@xterm/xterm';

const opener = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock('@/components/chat/external', () => ({ openExternalUrl: opener.openExternalUrl }));

import {
  createTerminalLinkHandler,
  createTerminalUrlLinkProvider,
  findTerminalLinks,
} from './terminalLinks';

function fakeTerminal(line: string | undefined, y: number): XTerm {
  return {
    cols: 100,
    buffer: {
      active: {
        getLine: (index: number) =>
          index === y - 1 && line !== undefined
            ? { translateToString: () => line }
            : undefined,
      },
    },
  } as unknown as XTerm;
}

beforeEach(() => {
  opener.openExternalUrl.mockReset();
});

describe('findTerminalLinks', () => {
  it('detects a Vite-style localhost URL with its exact offsets', () => {
    const text = '  Local:   http://localhost:1420/';
    expect(findTerminalLinks(text)).toEqual([
      { url: 'http://localhost:1420/', start: 11, end: 33 },
    ]);
  });

  it('keeps query strings, balanced brackets and trailing slashes', () => {
    const url = 'https://example.com/docs/(v2)?q=1/';
    expect(findTerminalLinks(`See ${url} now`)).toEqual([
      { url, start: 4, end: 4 + url.length },
    ]);
  });

  it('trims sentence punctuation and an unmatched closing bracket', () => {
    expect(findTerminalLinks('Deployed (https://example.com/app), done.')).toEqual([
      { url: 'https://example.com/app', start: 10, end: 33 },
    ]);
  });

  it('finds every URL on a line and ignores unsupported schemes', () => {
    const text = 'ftp://host/file http://a.test/x and https://b.test/y file://local';
    expect(findTerminalLinks(text).map((match) => match.url)).toEqual([
      'http://a.test/x',
      'https://b.test/y',
    ]);
  });
});

describe('createTerminalUrlLinkProvider', () => {
  it('maps line offsets to 1-based xterm ranges and opens the URL on click', () => {
    const line = '  Local:   http://localhost:1420/';
    const provider = createTerminalUrlLinkProvider(fakeTerminal(line, 7));
    let links: ILink[] | undefined;
    provider.provideLinks(7, (result) => {
      links = result;
    });

    expect(links).toHaveLength(1);
    expect(links?.[0].text).toBe('http://localhost:1420/');
    expect(links?.[0].range).toEqual({
      start: { x: 12, y: 7 },
      end: { x: 33, y: 7 },
    });
    expect(links?.[0].decorations).toEqual({ pointerCursor: true, underline: true });

    links?.[0].activate({} as MouseEvent, links[0].text);
    expect(opener.openExternalUrl).toHaveBeenCalledWith('http://localhost:1420/');
  });

  it('returns no links for an empty or out-of-range buffer line', () => {
    const provider: ILinkProvider = createTerminalUrlLinkProvider(fakeTerminal(undefined, 3));
    provider.provideLinks(3, (links) => expect(links).toBeUndefined());
    provider.provideLinks(0, (links) => expect(links).toBeUndefined());
  });
});

describe('createTerminalLinkHandler', () => {
  it('opens OSC 8 links through the same external opener', () => {
    createTerminalLinkHandler().activate({} as MouseEvent, 'https://example.com/osc8', {
      start: { x: 1, y: 1 },
      end: { x: 1, y: 1 },
    });
    expect(opener.openExternalUrl).toHaveBeenCalledWith('https://example.com/osc8');
  });
});
