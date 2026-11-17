import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { DollarSign } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import type { SessionCostView } from '@/lib/sessionCost';
import type { CacheConversationUi } from '@/lib/store/cacheStore';
import type { CompactionMethod, ContextBreakdown, ContextStats } from '@/lib/types';
import { cn, formatCost, formatTokens } from '@/lib/utils';
import {
  CacheChipSegment,
  CacheDiagnostics,
  cacheIconTone,
  cacheStateSentence,
} from './CacheHitChip';

export interface ContextMeterProps {
  stats: ContextStats;
  /**
   * Cache de prompt do host (Code: `useCacheStore`). `undefined` desliga a
   * seção de cache (hosts antigos); `null` mostra `—` + a nota honesta de
   * "sem amostras" enquanto o primeiro request não chega.
   */
  cache?: CacheConversationUi | null;
  /**
   * Session spending of every turn (subagents included), priced with the
   * official catalog. `undefined`/`null` hides the cost segment (hosts that do
   * not aggregate usage).
   */
  cost?: SessionCostView | null;
  /** Mensagens resumidas na última compactação (quando o host souber). */
  compacted?: number | null;
  /** Compactação em andamento (o chip fica `aria-busy` e a nota muda). */
  compacting?: boolean;
  /** Lane da última compactação (`local` vs nativa do provedor). */
  compactionMethod?: CompactionMethod;
  /** Falha da última tentativa de compactação (linha de aviso). */
  compactionWarning?: string | null;
  className?: string;
}

type TierKey = 'ok' | 'warning' | 'critical';

interface Tier {
  key: TierKey;
  labelKey: string;
  /** Cor do anel/alerta (a barra usa as cores do breakdown). */
  ring: string;
}

const TIERS: Record<TierKey, Tier> = {
  ok: { key: 'ok', labelKey: 'context.tier.ok', ring: 'text-success' },
  warning: { key: 'warning', labelKey: 'context.tier.warning', ring: 'text-warning' },
  critical: { key: 'critical', labelKey: 'context.tier.critical', ring: 'text-danger' },
};

function tierFor(percent: number): Tier {
  if (percent >= 90) return TIERS.critical;
  if (percent >= 70) return TIERS.warning;
  return TIERS.ok;
}

/** Percentual sempre 0–100 (payloads antigos/tolerância a dados ruins). */
function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * Janela do modelo em formato curto (1M sem casa decimal; 200K; 32K).
 * `formatTokens` imprime "1.0M", então a janela ganha este helper local.
 */
function formatWindow(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return formatTokens(value);
}

/** Legenda e segmentos na ordem do briefing: sistema → ferramentas → mensagens. */
const BREAKDOWN_SEGMENTS: Array<{
  key: keyof ContextBreakdown;
  labelKey: string;
  color: string;
}> = [
  { key: 'systemPrompt', labelKey: 'context.segments.systemPrompt', color: 'bg-context-system' },
  { key: 'toolDefinitions', labelKey: 'context.segments.toolDefinitions', color: 'bg-context-tools' },
  { key: 'messages', labelKey: 'context.segments.messages', color: 'bg-context-messages' },
];

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ContextRing({ percent, tier }: { percent: number; tier: Tier }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0 -rotate-90"
      fill="none"
      strokeWidth={2}
    >
      <circle cx={8} cy={8} r={RING_RADIUS} stroke="currentColor" className="text-surface-active" />
      <circle
        cx={8}
        cy={8}
        r={RING_RADIUS}
        stroke="currentColor"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
        className={cn(
          'transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none',
          tier.ring,
        )}
      />
    </svg>
  );
}

/**
 * Medidor de contexto do harness de código (WORKBENCH §4/§9), agora com o
 * indicador de cache de prompt ao lado do anel (PLAN §7).
 *
 * Chip compacto no header (anel + percentual de contexto + divisor + `Zap` +
 * `%` de cache) que abre um popover com o detalhamento do contexto e a seção
 * "Cache de prompt" (último request, teto, barra lido/gravado/novo, acumulado,
 * estado, última quebra, TTL e nº de amostras). Componente puro: os eventos
 * `context_stats`/`cache_stats` do backend atualizam os stores e o componente
 * rerenderiza no lugar (larguras animadas, valores tabulares, sem layout shift).
 * The optional `cost` prop adds the session spending segment (USD, official
 * catalog prices, subagents included) and its input/output/cache breakdown.
 */
export function ContextMeter({
  stats,
  cache,
  cost,
  compacted,
  compacting,
  compactionMethod,
  compactionWarning,
  className,
}: ContextMeterProps) {
  const { t } = useTranslation('agents');
  const descriptionId = useId();
  const hasCache = cache !== undefined;
  const percent = clampPercent(stats.percent);
  const tier = tierFor(percent);
  const tierLabel = t(tier.labelKey as never);
  const compactedCount = compacted ?? stats.compacted ?? 0;
  const nativeCompaction =
    compactionMethod === 'openai-responses' || compactionMethod === 'anthropic';
  // Precedência: compactando > compactação nativa > nota local existente.
  const note = compacting
    ? t('context.compacting')
    : compactedCount > 0
      ? nativeCompaction
        ? t('context.compactedNative', { count: compactedCount })
        : t('context.compacted', { count: compactedCount })
      : null;
  const costLabel = cost ? (cost.priced ? formatCost(cost.totalUsd) : '—') : null;
  const costRows = cost
    ? [
        { key: 'input' as const, label: t('context.cost.rows.input'), segment: cost.input },
        { key: 'output' as const, label: t('context.cost.rows.output'), segment: cost.output },
        { key: 'cacheRead' as const, label: t('context.cost.rows.cacheRead'), segment: cost.cacheRead },
        {
          key: 'cacheWrite' as const,
          label: t('context.cost.rows.cacheWrite'),
          segment: cost.cacheWrite,
        },
      ].filter((row) => row.segment.tokens > 0)
    : [];
  const description = [
    hasCache ? cacheStateSentence(cache) : null,
    cost
      ? cost.priced
        ? t('context.cost.aria', { cost: costLabel })
        : t('context.cost.ariaUnpriced')
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  const breakdown = stats.breakdown;
  const hasBreakdown = breakdown != null;
  const parts = hasBreakdown
    ? BREAKDOWN_SEGMENTS.map((segment) => ({
        ...segment,
        label: t(segment.labelKey as never),
        value: Number.isFinite(breakdown?.[segment.key])
          ? Math.max(0, breakdown?.[segment.key] ?? 0)
          : 0,
      }))
    : [
        {
          key: 'messages' as const,
          label: t('context.segments.messages'),
          color: 'bg-accent',
          value: stats.used,
        },
      ];
  const breakdownTotal = parts.reduce((total, part) => total + part.value, 0);
  // Barra usa as cores do breakdown; payload antigo (ou breakdown zerado)
  // degrada para uma barra única accent.
  const useAccentBar = !hasBreakdown || breakdownTotal <= 0;
  const segments = useAccentBar
    ? []
    : (() => {
        const window = stats.window > 0 ? stats.window : 1;
        const raw = parts.map((part) => (part.value / window) * 100);
        const total = raw.reduce((sum, width) => sum + width, 0);
        const scale = total > 100 ? 100 / total : 1;
        return parts.map((part, index) => ({
          ...part,
          width: Number((raw[index] * scale).toFixed(1)),
        }));
      })();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('context.usedAria', { percent })}
          aria-busy={compacting ? true : undefined}
          aria-describedby={description ? descriptionId : undefined}
          className={cn(
            'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 text-[11px] font-medium tabular-nums',
            hasCache || cost ? 'min-w-[7rem]' : 'min-w-[4.25rem]',
            'text-foreground-muted transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            tier.key === 'critical' ? 'bg-danger-soft text-danger' : '',
            className,
          )}
        >
          <ContextRing percent={percent} tier={tier} />
          <span className="tabular-nums">{percent}%</span>
          <span className="sr-only"> — {tierLabel}</span>
          {hasCache ? <CacheChipSegment cache={cache} /> : null}
          {cost ? (
            <>
              <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
              <span
                className="flex shrink-0 items-center gap-0.5"
                title={t('context.cost.title')}
              >
                <DollarSign
                  aria-hidden
                  className={cn('size-3 shrink-0', hasCache && cacheIconTone(cache))}
                  strokeWidth={2}
                />
                <span
                  className={cn(
                    'whitespace-nowrap tabular-nums',
                    !cost.priced && 'text-foreground-subtle',
                  )}
                >
                  {costLabel}
                </span>
              </span>
            </>
          ) : null}
          {description ? (
            <span id={descriptionId} className="sr-only">
              {description}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t('context.detailsAria')}
        className="w-72 p-3 shadow-lg"
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 text-[13px] font-semibold text-foreground">
              {t('context.usedPercent', { percent })}
            </p>
            <p className="shrink-0 text-[11px] tabular-nums text-foreground-muted">
              ~{formatTokens(stats.used)} / {formatWindow(stats.window)}
            </p>
          </div>

          <div
            role="progressbar"
            aria-label={t('context.usedProgressAria')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={t('context.usedValueText', { percent, tier: tierLabel })}
            title={t('context.outputCapTitle', { tokens: formatTokens(stats.outputCap) })}
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-active"
          >
            {useAccentBar ? (
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            ) : (
              segments.map((segment) => (
                <div
                  key={segment.key}
                  className={cn(
                    'h-full transition-[width] duration-300 ease-out motion-reduce:transition-none',
                    segment.color,
                  )}
                  style={{ width: `${segment.width}%` }}
                />
              ))
            )}
          </div>

          <ul aria-label={t('context.compositionAria')} className="flex flex-col gap-1">
            {parts.map((part) => (
              <li
                key={part.key}
                className="flex min-w-0 items-center gap-2 text-[11px] leading-snug"
              >
                <span aria-hidden className={cn('size-2 shrink-0 rounded-[3px]', part.color)} />
                <span className="min-w-0 flex-1 truncate text-foreground-muted">{part.label}</span>
                <span
                  className="shrink-0 tabular-nums text-foreground-muted"
                  aria-label={t('context.approxTokens', { tokens: formatTokens(part.value) })}
                >
                  ~{formatTokens(part.value)}
                </span>
              </li>
            ))}
          </ul>

          {cost ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-[13px] font-semibold text-foreground">
                  {t('context.cost.title')}
                </p>
                <p
                  className={cn(
                    'shrink-0 text-[11px] font-medium tabular-nums',
                    cost.priced ? 'text-foreground' : 'text-foreground-subtle',
                  )}
                >
                  {costLabel}
                </p>
              </div>
              <ul aria-label={t('context.cost.breakdownAria')} className="flex flex-col gap-1">
                {costRows.map((row) => (
                  <li
                    key={row.key}
                    className="flex min-w-0 items-baseline justify-between gap-3 text-[11px] leading-snug"
                  >
                    <span className="min-w-0 truncate text-foreground-muted">{row.label}</span>
                    <span className="shrink-0 tabular-nums text-foreground-muted">
                      {t('context.cost.rowValue', {
                        tokens: formatTokens(row.segment.tokens),
                        cost: row.segment.priced ? formatCost(row.segment.usd) : '—',
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              {cost.subagents > 0 ? (
                <p className="text-[10.5px] leading-snug text-foreground-subtle">
                  {t('context.cost.subagents', { n: cost.subagents })}
                </p>
              ) : null}
              {cost.unpriced ? (
                <p className="text-[10.5px] leading-snug text-foreground-subtle">
                  {t('context.cost.unpricedNote')}
                </p>
              ) : null}
              <p className="text-[10.5px] leading-snug text-foreground-subtle">
                {t('context.cost.note')}
              </p>
            </div>
          ) : null}

          {hasCache ? (
            <div className="border-t border-border pt-2">
              <CacheDiagnostics cache={cache ?? null} />
            </div>
          ) : null}

          <div className="flex flex-col gap-1 border-t border-border pt-2 text-[11px] leading-snug text-foreground-muted">
            <p>{t('context.outputCap', { tokens: formatTokens(stats.outputCap) })}</p>
            {note ? (
              <p role="status" className="text-foreground-muted">
                {note}
              </p>
            ) : null}
            {compactionWarning ? (
              <p role="status" className="text-warning">
                {compactionWarning}
              </p>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
