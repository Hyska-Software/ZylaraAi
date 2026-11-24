import { useTranslation } from 'react-i18next';
import { effortLabel, reasoningUi } from '@/lib/catalog';
import { formatNumber } from '@/lib/i18n/format';
import { thinkingOptions, thinkingSelectionFor } from '@/lib/modelMenu';
import { useAppStore } from '@/lib/store';
import type { ModelInfo, ReasoningSelection } from '@/lib/types';
import { cn } from '@/lib/utils';
import { SegmentedControl, Slider, type SegmentedOption } from '@/components/ui';
import { ThinkingLevelSlider } from './ThinkingLevelSlider';

export interface ThinkingSelectorProps {
  model?: ModelInfo | null;
  value: ReasoningSelection | null;
  onChange: (reasoning: ReasoningSelection | null) => void;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}

const DEFAULT_BUDGET_MIN = 1024;
const DEFAULT_BUDGET_MAX = 65536;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Reasoning controls driven by the catalog's `reasoningOptions`:
 * - toggle / efforts → segmented control (Desligado + esforços);
 * - `budget_tokens` → slider between the catalog min/max.
 * Models without reasoning options render a muted note (DESIGN §8).
 */
export function ThinkingSelector({
  model,
  value,
  onChange,
  compact = false,
  disabled = false,
  className,
}: ThinkingSelectorProps) {
  const { t } = useTranslation('models');
  const sliderEnabled = useAppStore((state) => state.settings.reasoningSliderEnabled ?? false);
  const ui = reasoningUi(model);

  if (!model || !ui.supported) {
    return (
      <p className={cn('text-xs leading-relaxed text-foreground-subtle', className)}>
        {t('thinking.empty')}
      </p>
    );
  }

  const mode = value?.mode ?? (ui.canDisable ? 'off' : null);
  const efforts = ui.efforts.filter((effort) => effort !== 'none');
  const budgetMin = ui.budget?.min ?? DEFAULT_BUDGET_MIN;
  const budgetMax = ui.budget?.max ?? DEFAULT_BUDGET_MAX;
  const budgetOnly = Boolean(ui.budget) && !ui.canDisable && efforts.length === 0;

  const currentEffort = mode === 'effort' ? (value?.effort ?? null) : null;
  const activeBudget = clamp(
    value?.mode === 'budget' && value.budget ? value.budget : Math.max(budgetMin, Math.min(budgetMax, 8192)),
    budgetMin,
    budgetMax,
  );

  const options: SegmentedOption[] = [];
  // The opt-in slider consumes the same level list as the segmented control,
  // so both surfaces offer identical reasoning modes.
  const levelOptions = sliderEnabled ? thinkingOptions(model, value) : [];
  const showLevelSlider = levelOptions.length > 1;
  if (!budgetOnly) {
    if (ui.canDisable) options.push({ value: 'off', label: t('thinking.offLabel') });
    for (const effort of efforts) {
      options.push({ value: `effort:${effort}`, label: effortLabel(effort) });
    }
    if (!efforts.length && !ui.budget && ui.canDisable) {
      options.push({ value: 'on', label: t('thinking.onLabel') });
    }
    if (ui.budget) options.push({ value: 'budget', label: t('thinking.budgetLabel') });
  }

  let selected: string | null = null;
  if (mode === 'budget' && ui.budget) selected = 'budget';
  else if (mode === 'off' && ui.canDisable) selected = 'off';
  else if (mode === 'effort') {
    if (currentEffort && efforts.includes(currentEffort)) selected = `effort:${currentEffort}`;
    else if (!currentEffort && !efforts.length) selected = 'on';
  }

  const handleModeChange = (next: string) => {
    if (next === 'off') {
      onChange({ mode: 'off' });
      return;
    }
    if (next === 'on') {
      onChange({ mode: 'effort', effort: null });
      return;
    }
    if (next === 'budget') {
      onChange({ mode: 'budget', budget: activeBudget });
      return;
    }
    if (next.startsWith('effort:')) {
      onChange({ mode: 'effort', effort: next.slice('effort:'.length) });
    }
  };

  const showBudget = Boolean(ui.budget) && (budgetOnly || selected === 'budget');

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {!compact ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-foreground">{t('thinking.modeLabel')}</span>
          {budgetOnly ? (
            <span className="text-xs tabular-nums text-foreground-muted">
              {t('thinking.tokens', { value: formatNumber(activeBudget) })}
            </span>
          ) : null}
        </div>
      ) : null}

      {showLevelSlider ? (
        <ThinkingLevelSlider
          model={model}
          value={value}
          disabled={disabled}
          onSelect={(option) => onChange(thinkingSelectionFor(option))}
        />
      ) : options.length > 1 ? (
        <SegmentedControl
          options={options}
          value={selected}
          onChange={handleModeChange}
          size={compact ? 'sm' : 'md'}
          ariaLabel={t('thinking.modeLabel')}
          disabled={disabled}
          fullWidth
          className="flex-wrap"
        />
      ) : null}

      {showBudget ? (
        <Slider
          label={compact ? undefined : t('thinking.budgetSliderLabel')}
          valueLabel={t('thinking.tokens', { value: formatNumber(activeBudget) })}
          value={activeBudget}
          min={budgetMin}
          max={budgetMax}
          step={256}
          disabled={disabled}
          onValueChange={(budget) => onChange({ mode: 'budget', budget })}
          aria-label={t('thinking.budgetSliderAria')}
          description={
            !compact
              ? t('thinking.budgetRange', {
                  min: formatNumber(budgetMin),
                  max: formatNumber(budgetMax),
                })
              : undefined
          }
        />
      ) : null}

      {!compact && !ui.budget && efforts.length === 0 && !ui.canDisable && !options.length ? (
        <p className="text-xs leading-relaxed text-foreground-subtle">
          {t('thinking.empty')}
        </p>
      ) : null}
    </div>
  );
}
