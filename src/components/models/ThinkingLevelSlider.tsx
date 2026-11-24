import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import { defaultReasoningFor } from '@/lib/catalog';
import {
  currentThinkingId,
  thinkingOptions,
  type ThinkingOption,
} from '@/lib/modelMenu';
import type { ModelInfo, ReasoningSelection } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface ThinkingLevelSliderProps {
  model: ModelInfo;
  value: ReasoningSelection | null;
  /** Called once per commit (pointer release or keyboard release). */
  onSelect: (option: ThinkingOption) => void;
  /** Renders a back button (used by the compact model popover). */
  onBack?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

const THUMB_SIZE = 40;
/** The track starts/ends half a thumb inside the wrapper so the thumb never clips. */
const TRACK_INSET = THUMB_SIZE / 2;
const DOTS = 6;

/**
 * Theme-token color for a thinking level. Medium stays violet to match the
 * reference design; the ramp escalates through the semantic state tokens.
 * Values are CSS variables, so installed themes keep control of the palette.
 */
export function reasoningLevelColor(option: ThinkingOption): string {
  if (option.kind === 'off') return 'var(--border-strong)';
  if (option.kind === 'budget') return 'var(--context-messages)';
  switch (option.effort) {
    case 'minimal':
      return 'var(--context-system)';
    case 'low':
      return 'var(--success)';
    case 'medium':
      return 'var(--accent)';
    case 'high':
      return 'var(--warning)';
    case 'xhigh':
      return 'color-mix(in oklab, var(--warning) 50%, var(--danger))';
    case 'max':
      return 'var(--danger)';
    default:
      return 'var(--accent)';
  }
}

/** Centers the thumb on the track, inset by half a thumb at both ends. */
function thumbLeft(fraction: number): string {
  const offset = TRACK_INSET - fraction * THUMB_SIZE;
  return `calc(${fraction * 100}% + ${offset}px)`;
}

/** Keeps the level dots fully visible inside the rounded track. */
function dotLeft(fraction: number): string {
  return `calc(${fraction * 100}% + ${DOTS / 2 - fraction * DOTS}px)`;
}

/**
 * Sliding replacement for the segmented thinking-level selector.
 *
 * The native range only previews while the pointer is down; the selection is
 * committed on pointer/keyboard release. That keeps a popover open during a
 * drag and avoids saving one value per intermediate step.
 */
export function ThinkingLevelSlider({
  model,
  value,
  onSelect,
  onBack,
  disabled = false,
  autoFocus = false,
  className,
}: ThinkingLevelSliderProps) {
  const { t } = useTranslation('models');
  const [preview, setPreview] = useState<number | null>(null);
  const options = thinkingOptions(model, value);
  const currentId = currentThinkingId(value);
  const matchedIndex = options.findIndex((option) => option.current || option.id === currentId);
  const selectedIndex = Math.max(0, matchedIndex);
  const hasSelection = matchedIndex >= 0;
  const last = options.length - 1;
  const activeIndex = Math.min(Math.max(preview ?? selectedIndex, 0), last);
  const active = options[activeIndex];

  if (!active) return null;

  const color = reasoningLevelColor(active);
  const fraction = last > 0 ? activeIndex / last : 0;
  const percent = fraction * 100;

  const commit = (index: number) => {
    const option = options[Math.min(Math.max(index, 0), last)];
    setPreview(null);
    if (option) onSelect(option);
  };

  /** A plain click on the current stop must not close the popover. */
  const commitIfChanged = (index: number) => {
    const next = Math.min(Math.max(index, 0), last);
    if (hasSelection && next === selectedIndex) {
      setPreview(null);
      return;
    }
    commit(next);
  };

  const handleReset = () => {
    const fallback = defaultReasoningFor(model);
    const fallbackId = currentThinkingId(fallback);
    const option = options.find((entry) => entry.id === fallbackId);
    setPreview(null);
    if (option) onSelect(option);
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'Home' ||
      event.key === 'End' ||
      event.key === 'PageUp' ||
      event.key === 'PageDown'
    ) {
      commitIfChanged(Number(event.currentTarget.value));
    }
  };

  return (
    <div className={cn('flex flex-col gap-3 rounded-xl bg-background p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        {onBack ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onBack}
            aria-label={t('thinking.backToList')}
            className="rounded-md p-1 text-foreground-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronLeft aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-center">
          <span className="max-w-full truncate text-sm font-semibold text-foreground">
            {active.label}
          </span>
          <span className="max-w-full truncate text-[11px] text-foreground-muted">
            {t('thinking.sliderModel', { model: model.name })}
          </span>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={handleReset}
          aria-label={t('thinking.resetAria')}
          className="rounded-md p-1 text-foreground-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RotateCcw aria-hidden className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <div
        className="relative h-12 rounded-full focus-within:ring-2 focus-within:ring-accent/40 focus-within:ring-offset-2 focus-within:ring-offset-background"
        data-level-color={color}
      >
        <div className="absolute inset-x-5 top-1/2 h-8 -translate-y-1/2 overflow-hidden rounded-full bg-surface-active">
          <div className="h-full rounded-full" style={{ width: `${percent}%`, background: color }} />
          {options.map((option, index) => {
            const dotFraction = last > 0 ? index / last : 0;
            return (
              <span
                key={option.id}
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  index <= activeIndex ? 'bg-foreground/70' : 'bg-foreground-subtle/60',
                )}
                style={{ left: dotLeft(dotFraction) }}
              />
            );
          })}
        </div>

        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 z-10 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
          style={{ left: thumbLeft(fraction), boxShadow: `0 0 0 3px ${color}` }}
        />

        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={activeIndex}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={t('thinking.sliderAria')}
          aria-valuetext={active.label}
          onChange={(event) => setPreview(Number(event.currentTarget.value))}
          onPointerUp={(event) => commitIfChanged(Number(event.currentTarget.value))}
          onPointerCancel={() => setPreview(null)}
          onKeyUp={handleKeyUp}
          className={cn(
            'absolute left-5 top-1/2 z-20 h-12 w-[calc(100%-2.5rem)] -translate-y-1/2 cursor-pointer appearance-none bg-transparent opacity-0',
            'disabled:cursor-not-allowed',
          )}
        />
      </div>
    </div>
  );
}
