/**
 * Language helpers used by the editor: the comment marker for Ctrl+/ and the
 * indentation guess used when `editorDetectIndentation` is on.
 */

import type { CommentTokens } from './edits';

/**
 * Line comment marker per Prism language id (`src/lib/highlight/languages.ts`).
 * Languages without a line comment (JSON, CSS, HTML…) are intentionally absent:
 * Ctrl+/ does nothing rather than inserting a marker that would break the file.
 */
const LINE_COMMENTS: Record<string, string> = {
  javascript: '//',
  typescript: '//',
  jsx: '//',
  tsx: '//',
  go: '//',
  rust: '//',
  c: '//',
  cpp: '//',
  csharp: '//',
  java: '//',
  kotlin: '//',
  scala: '//',
  dart: '//',
  swift: '//',
  php: '//',
  glsl: '//',
  hlsl: '//',
  wgsl: '//',
  opencl: '//',
  zig: '//',
  groovy: '//',
  solidity: '//',
  protobuf: '//',
  less: '//',
  scss: '//',
  graphql: '#',
  python: '#',
  ruby: '#',
  perl: '#',
  r: '#',
  elixir: '#',
  crystal: '#',
  nim: '#',
  bash: '#',
  powershell: '#',
  docker: '#',
  makefile: '#',
  cmake: '#',
  yaml: '#',
  toml: '#',
  ini: '#',
  git: '#',
  nginx: '#',
  apacheconf: '#',
  nix: '#',
  hcl: '#',
  bicep: '//',
  sql: '--',
  lua: '--',
  haskell: '--',
  elm: '--',
  asciidoc: '//',
  julia: '#',
  matlab: '%',
  latex: '%',
  erlang: '%',
  prolog: '%',
  fortran: '!',
  nasm: ';',
  lisp: ';',
  scheme: ';',
  clojure: ';',
  racket: ';',
};

/** Block comment pair for languages whose comment is markup. */
const BLOCK_COMMENTS: Record<string, [string, string]> = {
  markdown: ['<!--', '-->'],
  markup: ['<!--', '-->'],
  pug: ['//-', ''],
  css: ['/*', '*/'],
  twig: ['{#', '#}'],
  liquid: ['{% comment %}', '{% endcomment %}'],
  handlebars: ['{{!--', '--}}'],
};

/** Comment tokens for a language id; empty when the language has neither. */
export function commentTokensForLanguage(language: string): CommentTokens {
  const line = LINE_COMMENTS[language];
  const block = BLOCK_COMMENTS[language];
  return {
    ...(line ? { line } : {}),
    ...(block ? { block } : {}),
  };
}

export interface IndentationGuess {
  insertSpaces: boolean;
  tabSize: number;
}

/**
 * Guesses the indentation of a file from its first lines: tabs win when they
 * dominate, otherwise the smallest positive space indent becomes the unit
 * (capped to 1–8). Falls back to the configured preferences when the file has
 * no indented line.
 */
export function guessIndentation(
  text: string,
  fallback: { tabSize: number; insertSpaces: boolean },
): IndentationGuess {
  const lines = text.split('\n', 400);
  let tabs = 0;
  let spaces = 0;
  let smallest = Number.POSITIVE_INFINITY;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = /^[ \t]+/.exec(line)?.[0];
    if (!indent) continue;
    if (indent.startsWith('\t')) tabs += 1;
    else {
      spaces += 1;
      smallest = Math.min(smallest, indent.length);
    }
  }

  if (tabs === 0 && spaces === 0) return { ...fallback };
  if (tabs > spaces) return { insertSpaces: false, tabSize: fallback.tabSize };
  const width = Number.isFinite(smallest) ? Math.min(8, Math.max(1, smallest)) : fallback.tabSize;
  return { insertSpaces: true, tabSize: width };
}
