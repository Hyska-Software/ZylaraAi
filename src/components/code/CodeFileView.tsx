import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { buildInlineDiff } from '@/lib/diff';
import { editorPreferences } from '@/lib/editorSettings';
import { t } from '@/lib/i18n';
import {
  useAppStore,
  useEditorStore,
  useUiStore,
  type CodeFileTab,
} from '@/lib/store';
import { isBufferDirty } from '@/lib/store/editorStore';
import { cn, copyText } from '@/lib/utils';
import { CodeEditor, type CodeEditorHandle, type EditorDiffMarks } from './CodeEditor';
import { EditorHeader } from './EditorHeader';
import { FileNameDialog } from './FileNameDialog';
import { FilePreview, languageForPath } from './FilePreview';
import { useFileEditor } from './useFileEditor';

export interface CodeFileViewProps {
  /** Arquivo aberto na aba central (workspace + caminho relativo). */
  target: CodeFileTab;
  className?: string;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '.' : path.slice(0, index);
}

function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * Aba central de arquivo do layout Code (WORKBENCH §7.1).
 *
 * Editable text files open in the in-app editor (`CodeEditor`): typing, undo,
 * find/replace, autosave and save variants all operate on a per-tab buffer that
 * survives switching tabs. Everything the backend cannot round-trip (binary,
 * image, PDF, truncated preview, non-UTF-8, oversized) keeps the read-only
 * `FilePreview` with inline diff marks, so no file is silently lossy.
 *
 * The diff against HEAD is loaded for both surfaces: read-only previews paint
 * inline marks, while the editor paints thin gutter bars derived from the saved
 * text. Marks are hidden while the buffer is dirty, because an unsaved buffer
 * has no backend diff and line positions would drift.
 */
export function CodeFileView({ target, className }: CodeFileViewProps) {
  const { workspaceId, path } = target;
  const { t: translate } = useTranslation('code');
  const settings = useAppStore((state) => state.settings);
  const preferences = useMemo(() => editorPreferences(settings), [settings]);
  const codeFileWrap = useUiStore((state) => state.codeFileWrap);
  const setCodeFileWrap = useUiStore((state) => state.setCodeFileWrap);
  const openCodeDiff = useUiStore((state) => state.openCodeDiff);
  const retargetCodeFile = useUiStore((state) => state.retargetCodeFile);
  const editorRef = useRef<CodeEditorHandle | null>(null);

  const {
    content,
    buffer,
    loading,
    error,
    readOnlyReason,
    save,
    saveAs,
    saveAll,
    reload,
    revert,
    keepMine,
  } = useFileEditor({ workspaceId, path, preferences });

  const hasDirtyBuffers = useEditorStore((state) =>
    Object.values(state.buffers).some(
      (entry) => entry.workspaceId === workspaceId && entry.text !== entry.savedText,
    ),
  );

  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(true);
  const [diffError, setDiffError] = useState<string | null>(null);

  const editable = readOnlyReason === null && buffer !== null;
  const language = useMemo(() => languageForPath(path), [path]);

  /* The read-only preview owns its inline marks and error/summary header. */
  const loadDiff = useCallback(async () => {
    if (!content || readOnlyReason === null) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      setDiff(await api.getFileDiffHead(workspaceId, path));
    } catch (loadError) {
      setDiff(null);
      setDiffError(describeError(loadError, t('code:preview.diff.error')));
    } finally {
      setDiffLoading(false);
    }
  }, [content, path, readOnlyReason, workspaceId]);

  useEffect(() => {
    if (readOnlyReason === null) {
      setDiff(null);
      setDiffLoading(false);
      return;
    }
    void loadDiff();
  }, [loadDiff, readOnlyReason]);

  const [editorDiff, setEditorDiff] = useState<string | null>(null);
  const editorDiffRun = useRef(0);
  const savedText = buffer?.savedText ?? null;
  const savedHash = buffer?.savedHash ?? null;

  /* The editable gutter uses the saved file's HEAD diff. A save or a clean
     reload changes `savedHash` and refreshes it; a stale request is discarded. */
  useEffect(() => {
    if (!editable) {
      setEditorDiff(null);
      return undefined;
    }
    const run = editorDiffRun.current + 1;
    editorDiffRun.current = run;
    setEditorDiff(null);
    let disposed = false;
    void api
      .getFileDiffHead(workspaceId, path)
      .then((text) => {
        if (!disposed && run === editorDiffRun.current) setEditorDiff(text ?? '');
      })
      .catch(() => {
        if (!disposed && run === editorDiffRun.current) setEditorDiff(null);
      });
    return () => {
      disposed = true;
    };
  }, [editable, workspaceId, path, savedHash]);

  const diffMarks = useMemo<EditorDiffMarks | null>(() => {
    if (!editorDiff || !savedText || isBufferDirty(buffer)) return null;
    const inline = buildInlineDiff(editorDiff, savedText.split('\n').length);
    return { lineTones: inline.lineTones, deletions: inline.deletions };
  }, [editorDiff, savedText, buffer]);

  const openExternal = useCallback(() => {
    void api.openWorkspaceInExplorer(workspaceId);
  }, [workspaceId]);

  const revealFile = useCallback(() => {
    void api.revealWorkspaceEntry(workspaceId, path);
  }, [path, workspaceId]);

  const copyPath = useCallback(() => {
    void copyText(path);
  }, [path]);

  const viewDiff = useCallback(() => {
    openCodeDiff({ workspaceId, path, staged: false });
  }, [openCodeDiff, path, workspaceId]);

  const handleSaveAs = useCallback(
    async (name: string) => {
      const parent = parentPath(path);
      const nextPath = [parent === '.' ? '' : parent, name].filter(Boolean).join('/');
      setSaveAsBusy(true);
      try {
        const written = await saveAs(nextPath);
        if (written) {
          retargetCodeFile({ workspaceId, path }, { workspaceId, path: written });
          setSaveAsOpen(false);
        }
      } finally {
        setSaveAsBusy(false);
      }
    },
    [path, retargetCodeFile, saveAs, workspaceId],
  );

  /* Ctrl+S / Ctrl+Shift+S keep working when the focus is on the header bar. */
  const handleContainerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.key.toLowerCase() !== 's' || !editable) return;
    event.preventDefault();
    if (event.shiftKey) setSaveAsOpen(true);
    else void save();
  };

  const currentName = fileName(path);

  if (editable && buffer) {
    return (
      <div
        className={cn('flex min-h-0 flex-1 flex-col', className)}
        onKeyDown={handleContainerKeyDown}
      >
        <EditorHeader
          buffer={buffer}
          language={language}
          wrap={codeFileWrap}
          hasDirtyBuffers={hasDirtyBuffers}
          onToggleWrap={() => setCodeFileWrap(!codeFileWrap)}
          onSave={() => void save()}
          onSaveAs={() => setSaveAsOpen(true)}
          onSaveAll={() => void saveAll()}
          onReload={() => void reload()}
          onRevert={revert}
          onFind={(mode) => editorRef.current?.openFind(mode)}
          onGoToLine={() => editorRef.current?.openGoToLine()}
          onViewDiff={viewDiff}
          onReveal={revealFile}
          onCopyPath={copyPath}
        />

        {buffer.conflict ? (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning-soft px-3 py-1.5 text-[11.5px] text-warning"
          >
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="font-medium">{translate('code:editor.conflict.title')}</span>
            <span className="text-foreground-muted">
              {translate('code:editor.conflict.description')}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => void reload()}>
                {translate('code:editor.conflict.reload')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void keepMine()}>
                {translate('code:editor.conflict.keepMine')}
              </Button>
            </span>
          </div>
        ) : buffer.status === 'error' && buffer.error ? (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger-soft px-3 py-1.5 text-[11.5px] text-danger"
          >
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate" title={buffer.error}>
              {translate('code:editor.errors.saveBanner')}
            </span>
            <span className="min-w-0 truncate text-foreground-muted">{buffer.error}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void save()}
            >
              {translate('common:actions.retry')}
            </Button>
          </div>
        ) : null}

        <CodeEditor
          ref={editorRef}
          buffer={buffer}
          preferences={preferences}
          language={language}
          wrap={codeFileWrap}
          diffMarks={diffMarks ?? undefined}
          onSave={() => void save()}
          onSaveAs={() => setSaveAsOpen(true)}
        />

        <FileNameDialog
          open={saveAsOpen}
          mode="saveAs"
          path={path}
          initialName={currentName}
          busy={saveAsBusy}
          title={translate('code:editor.saveAs.title')}
          description={translate('code:editor.saveAs.description', { path })}
          submitLabel={translate('code:editor.actions.saveAs')}
          onClose={() => setSaveAsOpen(false)}
          onSubmit={(name) => void handleSaveAs(name)}
        />
      </div>
    );
  }

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', className)}
      onKeyDown={handleContainerKeyDown}
    >
      <FilePreview
        content={content}
        loading={loading}
        error={error}
        diff={diff}
        diffLoading={diffLoading}
        diffError={diffError}
        onReload={() => void reload()}
        onOpenExternal={openExternal}
        className="min-h-0 flex-1"
      />
    </div>
  );
}

export default CodeFileView;
