import { describe, expect, it } from 'vitest';

import { commentTokensForLanguage, guessIndentation } from '../comments';

describe('editor language helpers', () => {
  it('maps languages to their comment markers', () => {
    expect(commentTokensForLanguage('typescript')).toEqual({ line: '//' });
    expect(commentTokensForLanguage('python')).toEqual({ line: '#' });
    expect(commentTokensForLanguage('sql')).toEqual({ line: '--' });
    expect(commentTokensForLanguage('markdown')).toEqual({ block: ['<!--', '-->'] });
    expect(commentTokensForLanguage('css')).toEqual({ block: ['/*', '*/'] });
    // JSON has no legal comment: the command becomes a no-op.
    expect(commentTokensForLanguage('json')).toEqual({});
  });

  it('guesses indentation from the file', () => {
    const fallback = { tabSize: 2, insertSpaces: true };
    expect(guessIndentation('if (x) {\n    y();\n}\n', fallback)).toEqual({
      insertSpaces: true,
      tabSize: 4,
    });
    expect(guessIndentation('if (x) {\n\ty();\n}\n', fallback)).toEqual({
      insertSpaces: false,
      tabSize: 2,
    });
    expect(guessIndentation('const a = 1;\n', fallback)).toEqual(fallback);
  });
});
