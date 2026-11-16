import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui';
import type { WorkspaceGitCommit } from '@/lib/types';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { shortHash } from './CommitBar';

/** Filtro de origem das alterações exibidas na aba Alterações. */
export type ChangesFilter =
  | { kind: 'last-turn' }
  | { kind: 'uncommitted' }
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'commit'; hash: string; subject: string }
  | { kind: 'branch'; base: string };

export interface ChangesFilterMenuProps {
  value: ChangesFilter;
  onChange: (filter: ChangesFilter) => void;
  commits: WorkspaceGitCommit[];
  commitsLoading?: boolean;
  /** `null` enquanto a lista de branches ainda não foi carregada. */
  branches: string[] | null;
  currentBranch?: string | null;
  branchesLoading?: boolean;
  branchesError?: string | null;
  onOpenBranches: () => void;
  className?: string;
}

/** Stable key used by checks and tests. */
export function filterKey(filter: ChangesFilter): string {
  switch (filter.kind) {
    case 'commit':
      return `commit:${filter.hash}`;
    case 'branch':
      return `branch:${filter.base}`;
    default:
      return filter.kind;
  }
}

/** Label shown on the toolbar trigger. */
export function filterLabel(filter: ChangesFilter): string {
  switch (filter.kind) {
    case 'last-turn':
      return t('code:changesFilter.label.lastTurn');
    case 'uncommitted':
      return t('code:changesFilter.label.uncommitted');
    case 'unstaged':
      return t('code:changesFilter.label.unstaged');
    case 'staged':
      return t('code:changesFilter.label.staged');
    case 'commit':
      return t('code:changesFilter.label.commit', { hash: shortHash(filter.hash) });
    case 'branch':
      return t('code:changesFilter.label.branch', { name: filter.base });
  }
}

const COMMIT_MENU_LIMIT = 10;

/**
 * Filter dropdown of the Changes tab (WORKBENCH §7.2): last turn, uncommitted,
 * staged/unstaged, a specific commit and a branch comparison. Commit/branch are
 * submenus because each can have many options.
 */
export function ChangesFilterMenu({
  value,
  onChange,
  commits,
  commitsLoading = false,
  branches,
  currentBranch = null,
  branchesLoading = false,
  branchesError = null,
  onOpenBranches,
  className,
}: ChangesFilterMenuProps) {
  const { t } = useTranslation('code');
  const current = filterKey(value);
  const label = filterLabel(value);
  const commitItems = commits.slice(0, COMMIT_MENU_LIMIT);
  const otherBranches = (branches ?? []).filter((branch) => branch !== currentBranch);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('code:changesFilter.aria')}
          title={label}
          className={cn(
            'h-7 min-w-0 justify-start gap-1 px-2 text-[11.5px] font-medium',
            className,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem
          checked={current === 'last-turn'}
          onSelect={() => onChange({ kind: 'last-turn' })}
        >
          {t('code:changesFilter.label.lastTurn')}
        </DropdownMenuItem>
        <DropdownMenuItem
          checked={current === 'uncommitted'}
          onSelect={() => onChange({ kind: 'uncommitted' })}
        >
          {t('code:changesFilter.label.uncommitted')}
        </DropdownMenuItem>
        <DropdownMenuItem
          checked={current === 'unstaged'}
          onSelect={() => onChange({ kind: 'unstaged' })}
        >
          {t('code:changesFilter.label.unstaged')}
        </DropdownMenuItem>
        <DropdownMenuItem
          checked={current === 'staged'}
          onSelect={() => onChange({ kind: 'staged' })}
        >
          {t('code:changesFilter.label.staged')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={commits.length === 0 && !commitsLoading}
            title={
              commits.length === 0 && !commitsLoading
                ? t('code:changesFilter.noCommitsInWorkspace')
                : t('code:changesFilter.chooseCommit')
            }
          >
            {t('code:changesFilter.commit')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {commitsLoading ? (
              <DropdownMenuItem disabled>{t('code:changesFilter.loadingCommits')}</DropdownMenuItem>
            ) : commitItems.length === 0 ? (
              <DropdownMenuItem disabled>{t('code:changesFilter.noCommit')}</DropdownMenuItem>
            ) : (
              commitItems.map((commit) => (
                <DropdownMenuItem
                  key={commit.hash}
                  checked={current === `commit:${commit.hash}`}
                  title={commit.subject}
                  onSelect={() =>
                    onChange({
                      kind: 'commit',
                      hash: commit.hash,
                      subject: commit.subject,
                    })
                  }
                >
                  {shortHash(commit.hash)} · {commit.subject}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub
          onOpenChange={(open) => {
            if (open) onOpenBranches();
          }}
        >
          <DropdownMenuSubTrigger title={t('code:changesFilter.compareBranch')}>
            {t('code:changesFilter.branch')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            {branchesLoading || (branches === null && !branchesError) ? (
              <DropdownMenuItem disabled>{t('code:changesFilter.loadingBranches')}</DropdownMenuItem>
            ) : branchesError ? (
              <DropdownMenuItem disabled>{branchesError}</DropdownMenuItem>
            ) : otherBranches.length === 0 ? (
              <DropdownMenuItem disabled>{t('code:changesFilter.noOtherBranch')}</DropdownMenuItem>
            ) : (
              otherBranches.map((branch) => (
                <DropdownMenuItem
                  key={branch}
                  checked={current === `branch:${branch}`}
                  title={branch}
                  onSelect={() => onChange({ kind: 'branch', base: branch })}
                >
                  {branch}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ChangesFilterMenu;
