/**
 * Pure helpers for prompt-cache telemetry and the context-meter cache indicator
 * (docs/goals/prompt-cache/PLAN.md §4.7/§7). No React and no I/O: everything here
 * is unit-testable and must never invent a number the provider did not report.
 */
import { t } from './i18n';
import type {
  CacheBreakReason,
  CacheSample,
  CacheState,
  CacheStats,
  UsageInfo,
} from './types';

export interface CacheTone {
  label: string;
  /** Token classes are applied by the component; keep the helper UI-agnostic. */
  tone: 'success' | 'warning' | 'danger' | 'muted' | 'accent';
  description: string;
}

/**
 * Copy is resolved at call time so the indicator follows a runtime language
 * switch; the tone is a stable, non-translated token.
 */
export function cacheStateMeta(state: CacheState | null | undefined): CacheTone {
  switch (state ?? 'cold') {
    case 'warming':
      return {
        label: t('code:cache.state.warming.label'),
        tone: 'accent',
        description: t('code:cache.state.warming.description'),
      };
    case 'stable':
      return {
        label: t('code:cache.state.stable.label'),
        tone: 'success',
        description: t('code:cache.state.stable.description'),
      };
    case 'degraded':
      return {
        label: t('code:cache.state.degraded.label'),
        tone: 'warning',
        description: t('code:cache.state.degraded.description'),
      };
    case 'unsupported':
      return {
        label: t('code:cache.state.unsupported.label'),
        tone: 'muted',
        description: t('code:cache.state.unsupported.description'),
      };
    case 'provider_policy':
      return {
        label: t('code:cache.state.provider_policy.label'),
        tone: 'muted',
        description: t('code:cache.state.provider_policy.description'),
      };
    case 'cold':
    default:
      return {
        label: t('code:cache.state.cold.label'),
        tone: 'muted',
        description: t('code:cache.state.cold.description'),
      };
  }
}

export function cacheBreakLabel(reason: CacheBreakReason | null | undefined): string | null {
  switch (reason) {
    case 'first_request':
      return t('code:cache.break.first_request');
    case 'system_prompt':
      return t('code:cache.break.system_prompt');
    case 'tool_definitions':
      return t('code:cache.break.tool_definitions');
    case 'history_rewrite':
      return t('code:cache.break.history_rewrite');
    case 'head_trim':
      return t('code:cache.break.head_trim');
    case 'compaction':
      return t('code:cache.break.compaction');
    case 'model_switch':
      return t('code:cache.break.model_switch');
    case 'protocol_fallback':
      return t('code:cache.break.protocol_fallback');
    case 'attachments':
      return t('code:cache.break.attachments');
    case 'config_change':
      return t('code:cache.break.config_change');
    case 'plugin_config_changed':
      return t('code:cache.break.plugin_config_changed');
    case 'ttl_expired':
      return t('code:cache.break.ttl_expired');
    case 'provider_policy':
      return t('code:cache.break.provider_policy');
    case null:
    case undefined:
      return null;
    default:
      return String(reason);
  }
}

export function clampPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/**
 * Provider-billed hit percent: `read / (read + write + uncached)`.
 * Returns null when the provider did not report cache counters.
 */
export function cacheHitPercent(
  usage: Pick<
    UsageInfo,
    'cacheReadTokens' | 'cacheWriteTokens' | 'uncachedInputTokens' | 'cacheReported'
  > | null
  | undefined,
): number | null {
  if (!usage?.cacheReported) return null;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const uncached = usage.uncachedInputTokens ?? 0;
  const total = read + write + uncached;
  if (total <= 0) return null;
  return clampPercent((read / total) * 100);
}

/** Theoretical ceiling `P/(P+Δ)` for one request. */
export function ceilingPercent(
  prefixTokens: number | null | undefined,
  deltaTokens: number | null | undefined,
): number | null {
  const prefix = prefixTokens ?? 0;
  const delta = deltaTokens ?? 0;
  if (prefix <= 0 && delta <= 0) return null;
  return clampPercent((prefix / (prefix + delta)) * 100);
}

export function formatCacheHit(percent: number | null | undefined): string {
  const clamped = clampPercent(percent ?? null);
  if (clamped == null) return '—';
  return `${Math.round(clamped)}%`;
}

/** Merge usage patches without losing cache counters (chatStore merge is shallow). */
export function mergeCacheUsage(
  previous: UsageInfo | null | undefined,
  next: UsageInfo,
): UsageInfo {
  return {
    ...(previous ?? {}),
    ...next,
    cacheReadTokens: next.cacheReadTokens ?? previous?.cacheReadTokens ?? null,
    cacheWriteTokens: next.cacheWriteTokens ?? previous?.cacheWriteTokens ?? null,
    uncachedInputTokens: next.uncachedInputTokens ?? previous?.uncachedInputTokens ?? null,
    cacheReported: next.cacheReported ?? previous?.cacheReported,
  };
}

/** Old payloads (before the cache contract) degrade to "not reported". */
export function normalizeLegacyUsage(usage: UsageInfo | null | undefined): UsageInfo {
  if (!usage) return { cacheReported: false };
  if (usage.cacheReported) return usage;
  const read = usage.cacheReadTokens ?? usage.cachedTokens ?? null;
  if (read == null) return { ...usage, cacheReported: false };
  return {
    ...usage,
    cacheReadTokens: read,
    cacheReported: true,
    uncachedInputTokens:
      usage.uncachedInputTokens ??
      (usage.inputTokens != null ? Math.max(0, usage.inputTokens - read) : null),
  };
}

/** Aggregate a list of samples (token-weighted), including cold/write requests. */
export function aggregateCacheSamples(samples: CacheSample[]): CacheStats | null {
  if (samples.length === 0) return null;
  let read = 0;
  let write = 0;
  let uncached = 0;
  let input = 0;
  let eligibleRead = 0;
  let eligibleInput = 0;
  let eligibleSamples = 0;
  for (const sample of samples) {
    read += sample.cacheRead;
    write += sample.cacheWrite;
    uncached += sample.uncached;
    input += sample.inputTotal;
    if (sample.eligible) {
      eligibleSamples += 1;
      eligibleRead += sample.cacheRead;
      eligibleInput += sample.inputTotal;
    }
  }
  const last = samples[samples.length - 1];
  const hitPercent = input > 0 ? clampPercent((read / input) * 100) : null;
  const steadyHitPercent =
    eligibleInput > 0 ? clampPercent((eligibleRead / eligibleInput) * 100) : null;
  return {
    hitPercent: last?.hitPercent ?? null,
    sessionHitPercent: hitPercent,
    steadyHitPercent,
    ceilingPercent: last?.ceilingPercent ?? null,
    inputTotal: input,
    cacheRead: read,
    cacheWrite: write,
    uncached,
    eligible: eligibleSamples > 0,
    state: last?.state ?? 'cold',
    epoch: last?.epoch ?? 0,
    samples: samples.length,
    breakReason: last?.breakReason ?? null,
    breakDetail: last?.breakDetail ?? null,
    at: last?.at ?? Date.now(),
  };
}

/** Estimated USD saved by cache reads (catalog prices are per million tokens). */
export function cacheSavingsUsd(
  sample: Pick<CacheSample, 'cacheRead' | 'cacheWrite'> | null | undefined,
  cost:
    | { input?: number | null; cacheRead?: number | null; cacheWrite?: number | null }
    | null
    | undefined,
): number | null {
  if (!sample || !cost) return null;
  const inputPrice = cost.input ?? null;
  const readPrice = cost.cacheRead ?? null;
  const writePrice = cost.cacheWrite ?? null;
  if (inputPrice == null || readPrice == null) return null;
  const readSaved = (sample.cacheRead / 1_000_000) * Math.max(0, inputPrice - readPrice);
  // Cache writes are usually more expensive than plain input; report the net.
  const writeExtra =
    writePrice != null
      ? (sample.cacheWrite / 1_000_000) * Math.max(0, writePrice - inputPrice)
      : 0;
  return readSaved - writeExtra;
}

/** Build the UI aggregate for one conversation from its recent samples. */
export function conversationCacheStats(
  conversationId: string,
  samples: CacheSample[],
): CacheStats | null {
  const aggregate = aggregateCacheSamples(samples);
  if (!aggregate) return null;
  return {
    ...aggregate,
    // `conversationId` is deliberately not part of CacheStats; kept here so the
    // store can associate the aggregate without another DTO.
    at: aggregate.at,
    samples: samples.length,
  };
}
