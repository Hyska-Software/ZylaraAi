import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Folder,
  FolderOpen,
  Search,
  X,
} from 'lucide-react';
import { IconButton, Input, Spinner, Tooltip } from '@/components/ui';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WorkspaceFileEntry } from '@/lib/types';
import { FileIcon } from './FileIcon';

/** Row of the flattened tree rendered by `FileTree`. */
interface TreeRow {
  entry: WorkspaceFileEntry;
  /** Visual depth (0 = root). */
  depth: number;
  /** Ancestor directory paths (outermost first), used to hide collapsed subtrees. */
  ancestors: string[];
}

export interface FileTreeProps {
  /** Entries returned by `api.listWorkspaceFiles` (files and expanded dirs). */
  entries: WorkspaceFileEntry[];
  loading?: boolean;
  /** Read error shown instead of the list (`null`/omitted = no error). */
  error?: string | null;
  /** Controlled selection; when omitted the tree keeps the last selection itself. */
  selectedPath?: string | null;
  /** Expanded directory paths; an empty set (the default) collapses every folder. */
  expandedPaths?: ReadonlySet<string>;
  /**
   * Total files in the workspace when the backend capped the listing ("mostrando
   * X de Y"). Ignored when smaller than the visible count.
   */
  totalCount?: number;
  onSelectFile?: (path: string) => void;
  /** Fired when a directory is expanded/collapsed; the container may fetch children. */
  onToggleDir?: (path: string) => void;
  /** Header actions; the container owns the persisted expanded state. */
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  /** Diretórios com filhos sendo carregados (lazy expansion); mostra spinner no lugar do chevron. */
  loadingPaths?: ReadonlySet<string>;
  className?: string;
}

function gitBadge(status: string): { label: string; className: string } | null {
  switch (status) {
    case 'M':
      return { label: t('code:tree.badge.modified'), className: 'text-warning' };
    case 'A':
      return { label: t('code:tree.badge.added'), className: 'text-success' };
    case 'D':
      return { label: t('code:tree.badge.deleted'), className: 'text-danger' };
    case 'R':
      return { label: t('code:tree.badge.renamed'), className: 'text-accent' };
    case 'C':
      return { label: t('code:tree.badge.copied'), className: 'text-accent' };
    case 'U':
      return { label: t('code:tree.badge.conflicted'), className: 'text-danger' };
    case '?':
      return { label: t('code:tree.badge.untracked'), className: 'text-foreground-subtle' };
    case '!':
      return { label: t('code:tree.badge.ignored'), className: 'text-foreground-subtle' };
    default:
      return null;
  }
}

/** Recursively flattens the tree into rows; handles nested `children` and flat depth lists. */
function flatten(
  entries: WorkspaceFileEntry[],
  ancestors: string[] = [],
  parentDepth = -1,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of entries) {
    const depth = Math.max(entry.depth ?? 0, parentDepth + 1);
    rows.push({ entry, depth, ancestors });
    if (entry.children?.length) rows.push(...flatten(entry.children, [...ancestors, entry.path], depth));
  }
  return rows;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** True when any ancestor directory of `row` is not expanded. */
function isHiddenByCollapse(row: TreeRow, expanded: ReadonlySet<string>): boolean {
  return row.ancestors.some((path) => !expanded.has(path));
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];
const EMPTY_EXPANDED_PATHS: ReadonlySet<string> = new Set();

/**
 * Workspace file tree for the Code right panel (WORKBENCH §7.1/§15).
 *
 * Rendering is flattened (one DOM row per visible entry, no recursive markup),
 * which keeps thousands of entries cheap without adding a virtualization
 * dependency. Expansion is controlled by the container through `expandedPaths`
 * + `onToggleDir`; the component only tracks the roving focus, so keyboard
 * navigation stays local. Directories start collapsed. Full a11y contract:
 * `role="tree"`/`treeitem`, `aria-expanded`, `aria-selected`, ↑/↓/←/→/Home/End/Enter.
 */
export function FileTree({
  entries,
  loading = false,
  error = null,
  selectedPath,
  expandedPaths,
  totalCount,
  onSelectFile,
  onToggleDir,
  onExpandAll,
  onCollapseAll,
  loadingPaths,
  className,
}: FileTreeProps) {
  const { t } = useTranslation('code');
  const [query, setQuery] = useState('');
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [uncontrolledSelected, setUncontrolledSelected] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const allRows = useMemo(() => flatten(entries), [entries]);
  const hasDirs = useMemo(() => allRows.some((row) => row.entry.isDir), [allRows]);
  const selected = selectedPath !== undefined ? selectedPath : uncontrolledSelected;
  const normalizedQuery = normalize(query.trim());
  const expanded = expandedPaths ?? EMPTY_EXPANDED_PATHS;

  const visibleRows = useMemo(() => {
    // A filter searches the whole loaded tree: matches under collapsed folders
    // stay reachable without changing the persisted expansion state.
    const expandedRows = normalizedQuery
      ? allRows
      : allRows.filter((row) => !isHiddenByCollapse(row, expanded));
    if (!normalizedQuery) return expandedRows;
    return expandedRows.filter(
      (row) =>
        normalize(row.entry.name).includes(normalizedQuery) ||
        normalize(row.entry.path).includes(normalizedQuery),
    );
  }, [allRows, expanded, normalizedQuery]);

  const setFocused = (path: string | null) => {
    setFocusedPath(path);
    if (path) rowRefs.current.get(path)?.focus();
  };

  /** The container owns expansion (and its persistence); a click requests a toggle. */
  const toggleDirectory = (path: string) => {
    onToggleDir?.(path);
  };

  const selectFile = (path: string) => {
    if (selectedPath === undefined) setUncontrolledSelected(path);
    onSelectFile?.(path);
  };

  /** Index of the focused row inside `visibleRows` (defaults to the first row). */
  const focusedIndex = () => {
    if (!focusedPath) return -1;
    return visibleRows.findIndex((row) => row.entry.path === focusedPath);
  };

  const handleRowClick = (event: MouseEvent<HTMLDivElement>, row: TreeRow) => {
    // Let the copy/clear buttons inside the header and nested controls win.
    if (event.defaultPrevented) return;
    setFocusedPath(row.entry.path);
    if (row.entry.isDir) toggleDirectory(row.entry.path);
    else selectFile(row.entry.path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!visibleRows.length) return;
    let index = focusedIndex();
    const current = index >= 0 ? visibleRows[index] : null;

    const focusRow = (nextIndex: number) => {
      const row = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, nextIndex))];
      if (row) setFocused(row.entry.path);
    };

    switch (event.key) {
      case 'ArrowDown':
        if (index < 0) focusRow(0);
        else focusRow(index + 1);
        break;
      case 'ArrowUp':
        if (index < 0) focusRow(visibleRows.length - 1);
        else focusRow(index - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(visibleRows.length - 1);
        break;
      case 'ArrowRight': {
        if (!current) return;
        if (current.entry.isDir) {
          if (!expanded.has(current.entry.path)) toggleDirectory(current.entry.path);
          else if (index + 1 < visibleRows.length && visibleRows[index + 1].depth > current.depth) {
            focusRow(index + 1);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        if (!current) return;
        if (current.entry.isDir && expanded.has(current.entry.path)) {
          toggleDirectory(current.entry.path);
        } else if (current.depth > 0) {
          /* Focus the nearest ancestor row. */
          for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            if (visibleRows[cursor].depth < current.depth) {
              focusRow(cursor);
              break;
            }
          }
        }
        break;
      }
      case 'Enter':
      case ' ': {
        if (!current) return;
        if (current.entry.isDir) toggleDirectory(current.entry.path);
        else selectFile(current.entry.path);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const treeTabIndex = (path: string): number => {
    if (focusedPath === path) return 0;
    if (focusedPath === null && visibleRows[0]?.entry.path === path) return 0;
    return -1;
  };

  const visibleFileCount = visibleRows.length;
  // Collapsed folders are not truncation: only show the counter for an active
  // filter or a backend that reported more entries than it returned.
  const total = totalCount != null && totalCount > allRows.length ? totalCount : allRows.length;
  const showCount = normalizedQuery.length > 0 || total > allRows.length;

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
            strokeWidth={1.75}
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('code:tree.filterPlaceholder')}
            aria-label={t('code:tree.filterAria')}
            className="h-8 pl-7 pr-7 text-[12px]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('code:tree.clearFilter')}
              className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-foreground-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X aria-hidden className="size-3.5" strokeWidth={2} />
            </button>
          ) : null}
        </div>
        {onExpandAll || onCollapseAll ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {onExpandAll ? (
              <Tooltip content={t('code:tree.expandAll')} side="bottom">
                <IconButton
                  label={t('code:tree.expandAll')}
                  size="sm"
                  disabled={!hasDirs}
                  onClick={onExpandAll}
                >
                  <ChevronsUpDown aria-hidden className="size-3.5" strokeWidth={1.75} />
                </IconButton>
              </Tooltip>
            ) : null}
            {onCollapseAll ? (
              <Tooltip content={t('code:tree.collapseAll')} side="bottom">
                <IconButton
                  label={t('code:tree.collapseAll')}
                  size="sm"
                  disabled={!hasDirs}
                  onClick={onCollapseAll}
                >
                  <ChevronsDownUp aria-hidden className="size-3.5" strokeWidth={1.75} />
                </IconButton>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        {loading ? <Spinner size="xs" label={t('code:tree.loading')} /> : null}
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
          <span className="flex size-9 items-center justify-center rounded-xl bg-danger-soft text-danger">
            <CircleAlert aria-hidden className="size-4" strokeWidth={1.75} />
          </span>
          <p className="text-[12.5px] font-medium text-foreground">{t('code:tree.errorTitle')}</p>
          <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">{error}</p>
        </div>
      ) : loading && entries.length === 0 ? (
        <div role="status" aria-label={t('code:tree.loadingTree')} className="flex-1 space-y-1.5 p-2">
          {SKELETON_ROWS.map((row) => (
            <div
              key={row}
              className="h-6 animate-pulse rounded-md bg-surface-hover motion-reduce:animate-none"
              style={{ width: `${88 - row * 9}%` }}
            />
          ))}
        </div>
      ) : visibleFileCount === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
          <Folder aria-hidden className="size-5 text-foreground-subtle" strokeWidth={1.75} />
          <p className="text-[12.5px] font-medium text-foreground">
            {normalizedQuery ? t('code:tree.emptySearchTitle') : t('code:tree.emptyTitle')}
          </p>
          <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">
            {normalizedQuery
              ? t('code:tree.emptySearchDescription')
              : t('code:tree.emptyDescription')}
          </p>
        </div>
      ) : (
        <div
          role="tree"
          aria-label={t('code:tree.aria')}
          aria-busy={loading || undefined}
          onKeyDown={handleKeyDown}
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {visibleRows.map((row) => {
            const { entry, depth } = row;
            const hasChildren = !!entry.children?.length;
            const isExpanded = entry.isDir && hasChildren && expanded.has(entry.path);
            const isSelected = !entry.isDir && selected === entry.path;
            const badge = entry.gitStatus ? gitBadge(entry.gitStatus) : null;
            return (
              <div
                key={entry.path}
                ref={(node) => {
                  if (node) rowRefs.current.set(entry.path, node);
                  else rowRefs.current.delete(entry.path);
                }}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={isSelected}
                aria-expanded={entry.isDir ? hasChildren && isExpanded : undefined}
                tabIndex={treeTabIndex(entry.path)}
                onClick={(event) => handleRowClick(event, row)}
                onFocus={() => setFocusedPath(entry.path)}
                style={{ paddingLeft: 8 + depth * 12 }}
                className={cn(
                  'group flex h-7 cursor-pointer select-none items-center gap-1.5 pr-2 text-[12.5px] outline-none',
                  'transition-colors duration-150 motion-reduce:transition-none',
                  isSelected
                    ? 'bg-accent-soft text-foreground'
                    : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  'focus-visible:bg-surface-hover focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40',
                )}
              >
                {entry.isDir ? (
                  loadingPaths?.has(entry.path) ? (
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <Spinner size="xs" label={t('code:tree.loadingDir', { name: entry.name })} />
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center text-foreground-subtle transition-transform duration-150 motion-reduce:transition-none',
                        isExpanded && 'rotate-90',
                      )}
                    >
                      <svg viewBox="0 0 16 16" fill="none" className="size-3">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )
                ) : (
                  <span aria-hidden className="w-3.5 shrink-0" />
                )}
                {entry.isDir ? (
                  isExpanded ? (
                    <FolderOpen aria-hidden className="size-4 shrink-0 text-accent" strokeWidth={1.75} />
                  ) : (
                    <Folder aria-hidden className="size-4 shrink-0 text-accent" strokeWidth={1.75} />
                  )
                ) : (
                  <FileIcon path={entry.path} className="size-4" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {badge ? (
                  <span
                    aria-label={t('code:tree.gitStatus', { status: badge.label })}
                    title={t('code:tree.gitStatus', { status: badge.label })}
                    className={cn('shrink-0 font-mono text-[11px] font-semibold', badge.className)}
                  >
                    {entry.gitStatus}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {showCount ? (
        <div
          role="status"
          className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] tabular-nums text-foreground-subtle"
        >
          {t('code:tree.count', { visible: visibleFileCount, total })}
        </div>
      ) : null}
    </div>
  );
}

export default FileTree;
