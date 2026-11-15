/**
 * Projeção de diagnóstico de cache (F5.4, PLAN §7).
 *
 * Funções puras que combinam o snapshot restaurado de `get_cache_stats` com o
 * estado ao vivo do `cacheStore`. Nada aqui recalcula hit%: números vêm do
 * backend; ausências degradam para `null` e a UI mostra `—`.
 */
import { t } from '@/lib/i18n';
import type { CacheConversationUi } from '@/lib/store/cacheStore';
import type {
  CacheBreakReason,
  CacheSample,
  CacheState,
  CacheStats,
  CacheStatsView,
} from '@/lib/types';

/** Quantas quebras recentes o painel lista. */
export const RECENT_BREAKS_LIMIT = 5;

export interface CacheBreakEntry {
  step: number;
  at: number;
  label: string;
  detail: string | null;
}

export interface CacheDiagnosticsView {
  providerId: string | null;
  modelId: string | null;
  protocol: string | null;
  epoch: number;
  state: CacheState | null;
  hit: number | null;
  sessionHit: number | null;
  steadyHit: number | null;
  ceiling: number | null;
  ttlSeconds: number | null;
  minCacheableTokens: number | null;
  current: CacheStats | null;
  session: CacheStats | null;
  /** Amostras em ordem cronológica (mais antiga primeiro, mais nova por último). */
  samples: CacheSample[];
  totalSamples: number;
  lastBreak: CacheBreakEntry | null;
  /** Quebras mais recentes primeiro. */
  breaks: CacheBreakEntry[];
  latest: CacheSample | null;
  hasData: boolean;
}

export interface CacheDiagnosticsInput {
  view: CacheStatsView | null;
  live: CacheConversationUi | null;
  /** Fallback quando ainda não há amostra (provider/modelo da conversa). */
  fallbackProviderId?: string | null;
  fallbackModelId?: string | null;
}

/** Rótulo do motivo de quebra do prefixo, no idioma ativo. */
export function cacheBreakLabel(reason: CacheBreakReason | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case 'first_request':
      return t('agents:cache.break.firstRequest');
    case 'system_prompt':
      return t('agents:cache.break.systemPrompt');
    case 'tool_definitions':
      return t('agents:cache.break.toolDefinitions');
    case 'history_rewrite':
      return t('agents:cache.break.historyRewrite');
    case 'head_trim':
      return t('agents:cache.break.headTrim');
    case 'compaction':
      return t('agents:cache.break.compaction');
    case 'model_switch':
      return t('agents:cache.break.modelSwitch');
    case 'protocol_fallback':
      return t('agents:cache.break.protocolFallback');
    case 'attachments':
      return t('agents:cache.break.attachments');
    case 'config_change':
      return t('agents:cache.break.configChange');
    case 'plugin_config_changed':
      return t('agents:cache.break.pluginConfigChanged');
    case 'ttl_expired':
      return t('agents:cache.break.ttlExpired');
    case 'provider_policy':
      return t('agents:cache.break.providerPolicy');
    default:
      return String(reason);
  }
}

/** Rótulo curto do estado do cache (`Frio`, `Estável`, ...). */
export function cacheStateLabel(state: CacheState | null | undefined): string {
  switch (state) {
    case 'warming':
      return t('agents:cache.state.warming');
    case 'stable':
      return t('agents:cache.state.stable');
    case 'degraded':
      return t('agents:cache.state.degraded');
    case 'unsupported':
      return t('agents:cache.state.unsupported');
    case 'provider_policy':
      return t('agents:cache.state.providerPolicy');
    case 'cold':
    default:
      return t('agents:cache.state.cold');
  }
}

/** Tom visual do estado do cache. */
export function cacheStateTone(
  state: CacheState | null | undefined,
): 'success' | 'warning' | 'danger' | 'muted' | 'accent' {
  switch (state) {
    case 'stable':
      return 'success';
    case 'degraded':
      return 'danger';
    case 'warming':
      return 'accent';
    case 'cold':
    case 'unsupported':
    case 'provider_policy':
      return 'muted';
    default:
      return 'muted';
  }
}

/** TTL do cache em formato curto (`1 h`, `5 min`); `—` quando ausente. */
export function formatCacheTtl(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  }
  return `${Math.round(seconds / 60)} min`;
}

/** Tom do badge de estado para os tokens semânticos do design system. */
export function cacheStateBadgeTone(
  state: CacheState | null,
): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  switch (state) {
    case 'stable':
      return 'success';
    case 'degraded':
      return 'danger';
    case 'warming':
      return 'accent';
    case 'cold':
    case 'unsupported':
    case 'provider_policy':
      return 'neutral';
    default:
      return 'neutral';
  }
}

function breakEntry(sample: CacheSample): CacheBreakEntry | null {
  if (!sample.breakReason) return null;
  return {
    step: sample.step,
    at: sample.at,
    label: cacheBreakLabel(sample.breakReason) ?? String(sample.breakReason),
    detail: sample.breakDetail ?? null,
  };
}

/**
 * Combina snapshot + live. O live (evento `cache_stats`) vence quando já tem
 * amostras; o snapshot cobre o primeiro render e metadados de sessão
 * (TTL/mínimo) que o evento por request não carrega.
 */
export function buildCacheDiagnostics({
  view,
  live,
  fallbackProviderId,
  fallbackModelId,
}: CacheDiagnosticsInput): CacheDiagnosticsView {
  const current = live?.current ?? view?.current ?? null;
  const session = live?.session ?? view?.session ?? null;
  const rawSamples = live && live.samples.length > 0 ? live.samples : (view?.recent ?? []);
  const samples = [...rawSamples].sort((a, b) => a.at - b.at || a.step - b.step);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  const breaks = samples
    .flatMap((sample) => {
      const entry = breakEntry(sample);
      return entry ? [entry] : [];
    })
    .slice(-RECENT_BREAKS_LIMIT)
    .reverse();
  const lastBreak: CacheBreakEntry | null =
    breaks[0] ??
    (session?.breakReason
      ? {
          step: latest?.step ?? 0,
          at: session.at,
          label: cacheBreakLabel(session.breakReason) ?? String(session.breakReason),
          detail: session.breakDetail ?? null,
        }
      : live?.lastBreak
        ? {
            step: latest?.step ?? 0,
            at: live.lastBreak.at,
            label: live.lastBreak.reason,
            detail: live.lastBreak.detail,
          }
        : null);

  const epoch = live?.epoch ?? view?.epoch ?? latest?.epoch ?? 0;
  const hit = current?.hitPercent ?? latest?.hitPercent ?? null;
  const sessionHit = session?.sessionHitPercent ?? current?.sessionHitPercent ?? null;
  const steadyHit = session?.steadyHitPercent ?? current?.steadyHitPercent ?? null;
  const ceiling = current?.ceilingPercent ?? latest?.ceilingPercent ?? null;

  return {
    providerId: latest?.providerId || fallbackProviderId || null,
    modelId: latest?.modelId || fallbackModelId || null,
    protocol: latest?.protocol || null,
    epoch,
    state: current?.state ?? latest?.state ?? null,
    hit,
    sessionHit,
    steadyHit,
    ceiling,
    ttlSeconds: session?.ttlSeconds ?? current?.ttlSeconds ?? null,
    minCacheableTokens: session?.minCacheableTokens ?? current?.minCacheableTokens ?? null,
    current,
    session,
    samples,
    totalSamples: current?.samples ?? session?.samples ?? samples.length,
    lastBreak,
    breaks,
    latest,
    hasData: current != null || session != null || samples.length > 0,
  };
}
