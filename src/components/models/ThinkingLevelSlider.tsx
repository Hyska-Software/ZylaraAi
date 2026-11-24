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
  onSelect: (option: ThinkingOption) => void;
  /** Renders a back button (used by the compact model popover). */
  onBack?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

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

/** Sliding replacement for the segmented thinking-level selector. */
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
  const options = thinkingOptions(model, value);
  const currentId = currentThinkingId(value);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.current || option.id === currentId),
  );
  const selected = options[selectedIndex];
  if (!selected) return null;

  const color = reasoningLevelColor(selected);
  const last = options.length - 1;
  const percent = last > 0 ? (selectedIndex / last) * 100 : 0;

  const handleReset = () => {
    const fallback = defaultReasoningFor(model);
    const fallbackId = currentThinkingId(fallback);
    const option = options.find((entry) => entry.id === fallbackId);
    if (option) onSelect(option);
  };

  return (
    <div
      className={cn('flex flex-col gap-3 rounded-2xl p-4', className)}
      style={{ background: `color-mix(in oklab, ${color} 10%, var(--surface))` }}
      data-level-color={color}
    >
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
        <div className="flex min-w-0 flex-1 flex-col items-center text-center">
          <span className="max-w-full truncate text-[13px] font-semibold" style={{ color }}>
            {selected.label}
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

      <div className="relative flex h-5 items-center">
        {options.map((option, index) => (
          <span
            key={option.id}
            aria-hidden
            className={cn(
              'pointer-events-none absolute size-1.5 -translate-x-1/2 rounded-full',
              index > selectedIndex ? 'bg-border-strong' : 'bg-accent',
            )}
            style={{ left: `${last > 0 ? (index / last) * 100 : 0}%` }}
          />
        ))}
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={selectedIndex}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={t('thinking.sliderAria')}
          aria-valuetext={selected.label}
          onChange={(event) => {
            const option = options[Number(event.currentTarget.value)];
            if (option) onSelect(option);
          }}
          className={cn(
            'relative z-10 h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none',
            'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed disabled:opacity-50',
            '[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:ring-2 [&::-webkit-slider-thumb]:ring-accent [&::-webkit-slider-thumb]:bg-surface-raised [&::-webkit-slider-thumb]:shadow-md',
            '[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:ring-2 [&::-moz-range-thumb]:ring-accent [&::-moz-range-thumb]:bg-surface-raised',
          )}
          style={{
            background: `linear-gradient(to right, ${color} 0%, ${color} ${percent}%, var(--border-strong) ${percent}%, var(--border-strong) 100%)`,
          }}
        />
      </div>

      <p className="text-center text-[11px] leading-relaxed text-foreground-muted">
        {selected.description}
      </p>
    </div>
  );
}
