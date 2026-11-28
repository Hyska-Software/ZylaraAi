/**
 * In-app editor core.
 *
 * The Code layout's center file tab is a first-party editor: the document model
 * lives in this folder (pure, unit-tested), the React surface in
 * `src/components/code/CodeEditor.tsx` and the I/O in `useFileEditor.ts`.
 * Nothing here depends on the DOM, so the behaviors are testable in isolation.
 */

export * from './text';
export * from './history';
export * from './edits';
export * from './search';
export * from './save';
export * from './comments';
export * from './virtualize';
export * from './tokenWindow';
export * from './highlightCache';
