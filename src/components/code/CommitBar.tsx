import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, CircleAlert, GitCommitHorizontal, Sparkles } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Spinner,
  Textarea,
  Tooltip,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/i18n/format';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { CommitTarget, WorkspaceGitCommit, WorkspaceGitStatus } from '@/lib/types';

export interface CommitBarProps {
  workspaceId?: string | null;
  /** `false` when the workspace is not a git repository (commit disabled). */
  isRepo?: boolean;
  /** True when the commit target has at least one file to commit. */
  hasChanges?: boolean;
  /** Paths currently prepared in the index (target "Preparados"). */
  stagedPaths?: string[];
  /** Paths checked by the user (target "Selection" in the menu). */
  selectedPaths?: string[];
  added?: number;
  removed?: number;
  /** Extra reason to block the commit (e.g. merge conflicts). */
  blockedReason?: string | null;
  onCommitted?: (status: WorkspaceGitStatus) => void;
  /** Called after a successful commit so the container can reload status/files. */
  onRefresh?: () => void;
  className?: string;
}

const LOG_LIMIT = 10;

/** One-shot commit action; the primary button uses no override (smart scope). */
interface CommitVariant {
  target: CommitTarget;
  amend?: boolean;
  push?: boolean;
  sync?: boolean;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/** Short hash shown in the history (`a1b2c3d`) and in the success toast. */
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/** Git dates arrive as ISO strings; invalid values are shown as-is. */
export function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDate(date, { day: '2-digit', month: 'short' });
}

/**
 * Default commit scope: staged files when present, otherwise the whole working
 * tree. Explicit menu actions bypass this fallback.
 */
export function resolveCommitTarget(
  target: CommitTarget,
  stagedPaths: readonly string[],
): CommitTarget {
  return target === 'staged' && stagedPaths.length === 0 ? 'all' : target;
}

/**
 * Commit bar of the Code panel (WORKBENCH §7.2/§15): smart commit scope
 * (staged with an all-files fallback), message with AI suggestion, split commit
 * button with explicit variants, and a collapsible recent-commits history.
 */
export function CommitBar({
  workspaceId,
  isRepo = true,
  hasChanges = true,
  stagedPaths = [],
  selectedPaths = [],
  added = 0,
  removed = 0,
  blockedReason = null,
  onCommitted,
  onRefresh,
  className,
}: CommitBarProps) {
  const { t } = useTranslation('code');
  // The active route can differ from the persisted defaults (a started session
  // owns its model), so the suggestion must follow what the user sees selected.
  const selection = useAppStore((state) => state.selection);
  const [message, setMessage] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commits, setCommits] = useState<WorkspaceGitCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const logRun = useRef(0);
  const suggestRun = useRef(0);

  const loadLog = useCallback(async () => {
    const run = logRun.current + 1;
    logRun.current = run;
    if (!workspaceId || !isRepo) {
      setCommits([]);
      setLogError(null);
      setLogLoading(false);
      return;
    }
    setLogLoading(true);
    setLogError(null);
    try {
      const log = await api.gitLog(workspaceId, LOG_LIMIT);
      if (run !== logRun.current) return;
      setCommits(log ?? []);
    } catch (error) {
      if (run !== logRun.current) return;
      setCommits([]);
      setLogError(describeError(error, t('code:commit.error.load')));
    } finally {
      if (run === logRun.current) setLogLoading(false);
    }
  }, [workspaceId, isRepo]);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  useEffect(() => {
    suggestRun.current += 1;
    setMessage('');
    setSuggestError(null);
    setSuggesting(false);
  }, [workspaceId]);

  const stageCount = stagedPaths.length;
  const selectionCount = selectedPaths.length;
  const effectiveTarget = resolveCommitTarget('staged', stagedPaths);
  const targetPaths = effectiveTarget === 'selection' ? selectedPaths : undefined;

  useEffect(() => {
    suggestRun.current += 1;
    setSuggestError(null);
    setSuggesting(false);
  }, [effectiveTarget]);

  const suggestDisabledReason = !workspaceId
    ? t('code:commit.reason.openWorkspace')
    : !isRepo
      ? t('code:commit.reason.notRepo')
      : blockedReason
        ? blockedReason
        : !hasChanges
          ? t('code:commit.reason.noChanges')
          : effectiveTarget === 'selection' && selectionCount === 0
            ? t('code:commit.reason.noSelection')
            : null;
  const disabledReason =
    suggestDisabledReason ?? (!message.trim() ? t('code:commit.reason.noMessage') : null);

  const canCommit = !disabledReason && !committing;
  const canAmend = commits.length > 0;

  const handleSuggest = async () => {
    if (!workspaceId || suggesting || suggestDisabledReason) return;
    const run = ++suggestRun.current;
    const requestedMessage = message;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const suggestion = await api.suggestCommitMessage(
        workspaceId,
        effectiveTarget,
        targetPaths,
        selection.providerId,
        selection.modelId,
      );
      if (run !== suggestRun.current) return;
      if (suggestion?.trim()) {
        setMessage((current) => (current === requestedMessage ? suggestion.trim() : current));
      } else {
        setSuggestError(t('code:commit.suggestEmpty'));
      }
    } catch (error) {
      if (run !== suggestRun.current) return;
      setSuggestError(describeError(error, t('code:commit.suggestError')));
    } finally {
      if (run === suggestRun.current) setSuggesting(false);
    }
  };

  const runCommit = async (variant: Partial<CommitVariant> = {}) => {
    if (!workspaceId || !canCommit) return;
    const target = variant.target ?? effectiveTarget;
    if (target === 'staged' && stageCount === 0) return;
    if (target === 'selection' && selectionCount === 0) return;
    const amend = variant.amend ?? false;
    if (amend && !canAmend) return;
    const paths = target === 'selection' ? selectedPaths : undefined;
    const trimmedMessage = message.trim();
    setCommitting(true);
    let phase: 'commit' | 'pull' | 'push' = 'commit';
    try {
      const status = await api.gitCommit(workspaceId, trimmedMessage, target, paths, amend);
      setMessage('');
      setSuggestError(null);
      onCommitted?.(status);
      let hash = '';
      try {
        const log = await api.gitLog(workspaceId, LOG_LIMIT);
        setCommits(log ?? []);
        hash = log?.[0]?.hash ?? '';
      } catch {
        /* The commit succeeded; the history refresh is best-effort. */
      }
      toast.success(
        hash
          ? t(
              amend ? 'code:commit.successAmendWithHash' : 'code:commit.successWithHash',
              { hash: shortHash(hash) },
            )
          : t(amend ? 'code:commit.successAmend' : 'code:commit.success'),
      );
      onRefresh?.();

      if (variant.sync) {
        phase = 'pull';
        await api.gitPull(workspaceId);
      }
      if (variant.sync || variant.push) {
        phase = 'push';
        await api.gitPush(workspaceId);
        toast.success(t(variant.sync ? 'code:git.syncSuccess' : 'code:git.pushSuccess'));
        onRefresh?.();
      }
    } catch (error) {
      if (phase === 'commit') {
        toast.error(describeError(error, t('code:commit.error.create')));
      } else {
        toast.error(t(phase === 'pull' ? 'code:git.pullError' : 'code:git.pushError'), {
          description: describeError(error, t('code:git.connectionHint')),
        });
      }
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className={cn('flex shrink-0 flex-col border-t border-border bg-surface', className)}>
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
          {t('code:commit.section')}
        </span>
        <span className="ml-auto text-[11.5px] tabular-nums" title={t('code:commit.linesTitle')}>
          <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
        </span>
        <span
          className="text-[11.5px] text-foreground-muted"
          title={t('code:commit.targetAria')}
        >
          {effectiveTarget === 'staged'
            ? t('code:commit.scope.staged', { count: stageCount })
            : effectiveTarget === 'selection'
              ? t('code:commit.scope.selection', { count: selectionCount })
              : t('code:commit.scope.all')}
        </span>
      </div>

      <div className="px-3 pt-2">
        <Textarea
          aria-label={t('code:commit.messageAria')}
          placeholder={t('code:commit.messagePlaceholder')}
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="min-h-16 resize-none rounded-lg text-[12.5px]"
        />
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <Tooltip
          content={suggestDisabledReason ?? t('code:commit.suggestTooltip')}
          side="top"
        >
          <Button
            size="sm"
            variant="subtle"
            loading={suggesting}
            disabled={Boolean(suggestDisabledReason)}
            title={suggestDisabledReason ?? t('code:commit.suggestTooltip')}
            aria-label={t('code:commit.suggestAria')}
            leftIcon={<Sparkles aria-hidden className="size-3.5" strokeWidth={1.75} />}
            onClick={() => void handleSuggest()}
          >
            {t('code:commit.suggest')}
          </Button>
        </Tooltip>

        {/* Disabled buttons swallow pointer events: the wrapper carries the hint. */}
        <span className="ml-auto inline-flex" title={disabledReason ?? undefined}>
          <Button
            size="sm"
            variant="primary"
            loading={committing}
            disabled={!canCommit}
            title={disabledReason ?? t('code:commit.button')}
            leftIcon={<GitCommitHorizontal aria-hidden className="size-3.5" strokeWidth={1.75} />}
            className="rounded-r-none"
            onClick={() => void runCommit()}
          >
            {t('code:commit.button')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                label={t('code:commit.menuAria')}
                variant="primary"
                size="sm"
                disabled={!canCommit}
                title={disabledReason ?? t('code:commit.menuAria')}
                className="h-8 w-6 rounded-l-none px-0"
              >
                <ChevronDown aria-hidden className="size-3.5" strokeWidth={1.75} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="min-w-52">
              <DropdownMenuItem onSelect={() => void runCommit()}>
                {t('code:commit.menu.commit')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={stageCount === 0}
                onSelect={() => void runCommit({ target: 'staged' })}
              >
                {t('code:commit.menu.staged')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runCommit({ target: 'all' })}>
                {t('code:commit.menu.all')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={selectionCount === 0}
                onSelect={() => void runCommit({ target: 'selection' })}
              >
                {t('code:commit.menu.selection')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canAmend}
                title={canAmend ? undefined : t('code:commit.reason.noHead')}
                onSelect={() => void runCommit({ amend: true })}
              >
                {t('code:commit.menu.amend')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runCommit({ push: true })}>
                {t('code:commit.menu.push')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runCommit({ sync: true })}>
                {t('code:commit.menu.sync')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      {suggestError ? (
        <p role="alert" className="flex items-center gap-1.5 px-3 pb-2 text-[11.5px] text-danger">
          <CircleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          {suggestError}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setLogOpen((current) => !current)}
        aria-expanded={logOpen}
        className="flex h-8 shrink-0 items-center gap-1 border-t border-border px-3 text-[11.5px] font-medium text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            logOpen && 'rotate-90',
          )}
          strokeWidth={1.75}
        />
        {commits.length
          ? t('code:commit.recentWithCount', { count: commits.length })
          : t('code:commit.recent')}
        {logLoading ? <Spinner size="xs" label={t('code:commit.loading')} className="ml-auto" /> : null}
      </button>

      {logOpen ? (
        <div className="border-t border-border px-3 py-2">
          {logError ? (
            <p role="alert" className="text-[11.5px] text-danger">
              {logError}
            </p>
          ) : logLoading && commits.length === 0 ? (
            <p className="text-[11.5px] text-foreground-muted">{t('code:commit.loadingText')}</p>
          ) : commits.length === 0 ? (
            <div>
              <p className="text-[12px] font-medium text-foreground">{t('code:commit.empty.title')}</p>
              <p className="text-[11.5px] text-foreground-muted">
                {t('code:commit.empty.description')}
              </p>
            </div>
          ) : (
            <ul aria-label={t('code:commit.recentListAria')} className="max-h-52 space-y-1 overflow-y-auto">
              {commits.map((commit) => (
                <li key={commit.hash} className="flex items-baseline gap-2 text-[11.5px]">
                  <span
                    className="shrink-0 font-mono text-foreground-subtle"
                    title={commit.hash}
                  >
                    {shortHash(commit.hash)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-foreground" title={commit.subject}>
                    {commit.subject}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-foreground-subtle">
                    {commit.author} · {formatCommitDate(commit.date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default CommitBar;
