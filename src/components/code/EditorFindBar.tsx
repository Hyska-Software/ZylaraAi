import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from 'lucide-react';

import { IconButton, Input } from '@/components/ui';
import type { SearchOptions } from '@/lib/editor';
import { cn } from '@/lib/utils';

export interface EditorFindBarProps {
  mode: 'find' | 'replace';
  query: string;
  replacement: string;
  options: SearchOptions;
  /** Number of matches found for the current query. */
  matchCount: number;
  /** 0-based index of the highlighted match (`-1` when there is none). */
  activeIndex: number;
  /** True when the match list was capped. */
  limited: boolean;
  /** True when the query is an invalid regular expression. */
  invalid: boolean;
  onChangeQuery: (value: string) => void;
  onChangeReplacement: (value: string) => void;
  onChangeOptions: (options: SearchOptions) => void;
  onNext: () => void;
  onPrevious: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  className?: string;
}

/**
 * Find/replace bar of the in-app editor (WORKBENCH §7.1).
 *
 * Non-modal: it floats over the top-right of the document so the text stays
 * visible while typing a query. Enter/Shift+Enter walk the matches, Esc closes
 * and returns focus to the editor (the editor owns that transition).
 */
export function EditorFindBar({
  mode,
  query,
  replacement,
  options,
  matchCount,
  activeIndex,
  limited,
  invalid,
  onChangeQuery,
  onChangeReplacement,
  onChangeOptions,
  onNext,
  onPrevious,
  onReplace,
  onReplaceAll,
  onClose,
  className,
}: EditorFindBarProps) {
  const { t } = useTranslation('code');
  const queryRef = useRef<HTMLInputElement | null>(null);

  // Focus the field when the bar opens or switches to replace.
  useEffect(() => {
    const input = queryRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [mode]);

  const toggle = (key: keyof SearchOptions) => {
    onChangeOptions({ ...options, [key]: !options[key] });
  };

  const countLabel = invalid
    ? t('code:editor.find.invalid')
    : query.length === 0
      ? ''
      : matchCount === 0
        ? t('code:editor.find.noMatches')
        : t('code:editor.find.matchCount', { current: activeIndex + 1, total: matchCount });

  return (
    <div
      role="search"
      aria-label={t(mode === 'replace' ? 'code:editor.find.replaceLabel' : 'code:editor.find.label')}
      className={cn(
        'absolute right-3 top-2 z-20 w-[min(420px,calc(100%-1.5rem))] rounded-xl bg-surface-raised p-2 shadow-lg',
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <Input
          ref={queryRef}
          value={query}
          aria-label={t('code:editor.find.findPlaceholder')}
          placeholder={t('code:editor.find.findPlaceholder')}
          invalid={invalid}
          spellCheck={false}
          autoComplete="off"
          className="h-8 min-w-0 flex-1 font-mono text-[12px]"
          onChange={(event) => onChangeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) onPrevious();
              else onNext();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <span
          aria-live="polite"
          className="min-w-14 shrink-0 text-right text-[11px] tabular-nums text-foreground-subtle"
        >
          {countLabel}
        </span>
        <IconButton
          label={t('code:editor.find.caseSensitive')}
          size="sm"
          active={options.caseSensitive}
          onClick={() => toggle('caseSensitive')}
        >
          <CaseSensitive aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t('code:editor.find.wholeWord')}
          size="sm"
          active={options.wholeWord}
          onClick={() => toggle('wholeWord')}
        >
          <WholeWord aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t('code:editor.find.regex')}
          size="sm"
          active={options.regex}
          onClick={() => toggle('regex')}
        >
          <Regex aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t('code:editor.find.previous')}
          size="sm"
          disabled={matchCount === 0}
          onClick={onPrevious}
        >
          <ChevronUp aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={t('code:editor.find.next')}
          size="sm"
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <ChevronDown aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton label={t('code:editor.find.close')} size="sm" onClick={onClose}>
          <X aria-hidden className="size-4" strokeWidth={1.75} />
        </IconButton>
      </div>

      {mode === 'replace' ? (
        <div className="mt-1.5 flex items-center gap-1">
          <Input
            value={replacement}
            aria-label={t('code:editor.find.replacePlaceholder')}
            placeholder={t('code:editor.find.replacePlaceholder')}
            spellCheck={false}
            autoComplete="off"
            className="h-8 min-w-0 flex-1 font-mono text-[12px]"
            onChange={(event) => onChangeReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onReplace();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <IconButton
            label={t('code:editor.find.replaceOne')}
            size="sm"
            disabled={matchCount === 0}
            onClick={onReplace}
          >
            <Replace aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label={t('code:editor.find.replaceAll')}
            size="sm"
            disabled={matchCount === 0}
            onClick={onReplaceAll}
          >
            <ReplaceAll aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
        </div>
      ) : null}

      {limited ? (
        <p className="mt-1 text-[11px] text-warning">{t('code:editor.find.limited')}</p>
      ) : null}
    </div>
  );
}

export default EditorFindBar;
