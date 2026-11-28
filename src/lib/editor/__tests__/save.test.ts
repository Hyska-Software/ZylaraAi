import { describe, expect, it } from 'vitest';

import type { WorkspaceFileContent } from '@/lib/types';

import { editableRejection, prepareSaveText } from '../save';

function content(overrides: Partial<WorkspaceFileContent> = {}): WorkspaceFileContent {
  return {
    path: 'src/app.ts',
    text: 'const a = 1;\n',
    truncated: false,
    size: 13,
    ...overrides,
  };
}

describe('editor save helpers', () => {
  it('accepts plain UTF-8 text', () => {
    expect(editableRejection(content())).toBeNull();
    expect(editableRejection(content({ mimeType: null, size: 1024 }))).toBeNull();
  });

  it('rejects previews that cannot round-trip', () => {
    expect(editableRejection(null)).toBe('preview-omitted');
    expect(editableRejection(content({ binary: true }))).toBe('binary');
    expect(editableRejection(content({ mimeType: 'image/png' }))).toBe('image');
    expect(editableRejection(content({ mimeType: 'application/pdf' }))).toBe('pdf');
    expect(editableRejection(content({ previewOmitted: true }))).toBe('preview-omitted');
    expect(editableRejection(content({ truncated: true }))).toBe('truncated');
    expect(editableRejection(content({ encoding: 'windows-1252' }))).toBe('encoding');
    expect(editableRejection(content({ encoding: 'UTF-8' }))).toBeNull();
    expect(editableRejection(content({ size: 2 * 1024 * 1024 }))).toBe('too-large');
  });

  it('trims trailing whitespace and keeps exactly one final newline', () => {
    expect(
      prepareSaveText('a  \nb\t\n', { trimTrailingWhitespace: true, insertFinalNewline: true }),
    ).toBe('a\nb\n');
    expect(
      prepareSaveText('a\nb', { trimTrailingWhitespace: false, insertFinalNewline: true }),
    ).toBe('a\nb\n');
    expect(
      prepareSaveText('a\n\n\n', { trimTrailingWhitespace: false, insertFinalNewline: true }),
    ).toBe('a\n\n\n');
    expect(
      prepareSaveText('a', { trimTrailingWhitespace: false, insertFinalNewline: false }),
    ).toBe('a');
    expect(
      prepareSaveText('', { trimTrailingWhitespace: true, insertFinalNewline: true }),
    ).toBe('');
  });
});
