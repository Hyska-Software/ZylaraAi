/**
 * Pure helpers behind the model selector (compact pill popover + full dialog).
 *
 * Everything here is UI-agnostic and fully testable: keys, search, filters,
 * grouping, thinking-mode options, labels and detail summaries. The two
 * selector surfaces (`ModelPill`, `ModelPickerDialog`) and their shared
 * components consume this module as the single source of truth, so behavior
 * cannot drift between them.
 *
 * Contract: `docs/MODEL_SELECTOR_REDESIGN.md` §5.1.
 */
import {
  defaultReasoningFor,
  effortLabel,
  formatContextWindow,
  formatPrice,
  isCuratedProvider,
  modelBadges,
  reasoningUi,
} from './catalog';
import { t } from './i18n';
import { compareText } from './i18n/format';
import type {
  ModelInfo,
  ModelSelection,
  ProviderAuthStatus,
  ProviderInfo,
  ProviderKeyStatus,
  ReasoningSelection,
} from './types';

/* ------------------------------------------------------------------ */
/* Model keys                                                          */
/* ------------------------------------------------------------------ */

/**
 * Stable identity of a model inside the selector. Model ids repeat across
 * providers, so every list key is `providerId:modelId`.
 */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function parseModelKey(key: string): { providerId: string; modelId: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    providerId: key.slice(0, separator),
    modelId: key.slice(separator + 1),
  };
}

export function selectionKey(selection: ModelSelection | null | undefined): string | null {
  const providerId = selection?.providerId;
  const modelId = selection?.modelId;
  return providerId && modelId ? modelKey(providerId, modelId) : null;
}

/* ------------------------------------------------------------------ */
/* Selector providers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Providers the model selector offers.
 *
 * The bundled catalog ships ~26 providers, but one without a credential cannot
 * answer a turn, so listing all of them would flood the pill label and the
 * provider tabs. The selector lists the curated "popular" set (keeping the
 * missing-key call to action reachable), every provider with a stored credential
 * or a connected account, user-defined/plugin providers, and the provider of the
 * current selection (an account-only provider never disappears).
 */
export function selectorProviders(
  providers: readonly ProviderInfo[],
  keyStatuses: readonly ProviderKeyStatus[],
  authStatuses: readonly ProviderAuthStatus[],
  currentProviderId?: string | null,
): ProviderInfo[] {
  const usable = new Set<string>();
  for (const status of keyStatuses) {
    if (status.hasKey) usable.add(status.providerId);
  }
  for (const status of authStatuses) {
    if (status.state === 'signed-in' || status.state === 'plan-disabled') {
      usable.add(status.providerId);
    }
  }
  return providers.filter(
    (provider) =>
      isCuratedProvider(provider.id) ||
      usable.has(provider.id) ||
      provider.origin === 'custom' ||
      provider.origin === 'plugin' ||
      (provider.transport === 'acp' &&
        provider.acp?.installed === true &&
        provider.acp.enabled !== false) ||
      provider.id === currentProviderId,
  );
}

/* ------------------------------------------------------------------ */
/* Families                                                            */
/* ------------------------------------------------------------------ */

const FAMILY_LABELS: Record<string, string> = {
  claude: 'Claude',
  gpt: 'GPT',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  qwen: 'Qwen',
  minimax: 'MiniMax',
  mimo: 'MiMo',
  grok: 'Grok',
  gemini: 'Gemini',
  muse: 'Muse',
  longcat: 'LongCat',
  step: 'Step',
  hy: 'HY',
  mistral: 'Mistral',
  nemotron: 'Nemotron',
  flint: 'Flint',
  omen: 'Omen',
  beam: 'Beam',
};

/** Curated family label; unknown families are capitalized, empty/default → "Outros". */
export function familyLabel(family: string | null | undefined): string {
  const key = (family ?? '').toLowerCase().trim();
  if (isOtherFamily(family)) return t('models:family.other');
  const known = FAMILY_LABELS[key];
  if (known) return known;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function isOtherFamily(family: string | null | undefined): boolean {
  const key = (family ?? '').toLowerCase().trim();
  return !key || key === 'default' || key === 'outros' || key === 'other';
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

const DIACRITICS = /[\u0300-\u036f]/g;

/** Lowercase, accent-free and trimmed — used by every search comparison. */
export function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(DIACRITICS, '').toLowerCase().trim();
}

function modelHaystack(model: ModelInfo, provider?: ProviderInfo): string {
  return normalizeSearch(
    [
      model.name,
      model.id,
      model.family,
      familyLabel(model.family),
      model.description ?? '',
      model.tags.join(' '),
      provider?.name ?? '',
      provider?.shortName ?? '',
    ].join(' '),
  );
}

/**
 * Token-AND search over name, id, family, description, tags and provider.
 * Diacritics and casing are ignored, so "visao" finds "Visão" tags too.
 */
export function modelMatchesQuery(
  model: ModelInfo,
  provider: ProviderInfo | undefined,
  query: string,
): boolean {
  const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = modelHaystack(model, provider);
  return tokens.every((token) => haystack.includes(token));
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

export type ModelFilter = 'favorites' | 'vision' | 'reasoning' | 'free';

export interface ModelFilterOption {
  value: ModelFilter;
  label: string;
  title: string;
}

/** Quick filters shown as toggle chips in the full dialog. */
export function modelFilterOptions(): ModelFilterOption[] {
  return [
    {
      value: 'favorites',
      label: t('models:filters.favorites.label'),
      title: t('models:filters.favorites.title'),
    },
    {
      value: 'vision',
      label: t('models:filters.vision.label'),
      title: t('models:filters.vision.title'),
    },
    {
      value: 'reasoning',
      label: t('models:filters.reasoning.label'),
      title: t('models:filters.reasoning.title'),
    },
    {
      value: 'free',
      label: t('models:filters.free.label'),
      title: t('models:filters.free.title'),
    },
  ];
}

export function modelSupportsVision(model: ModelInfo): boolean {
  return model.attachment || model.modalities.input.includes('image');
}

export function modelSupportsReasoning(model: ModelInfo): boolean {
  return reasoningUi(model).supported;
}

/** Favorites are keyed `providerId:modelId`; legacy bare ids match any provider. */
export function favoriteEntryMatches(
  favorites: readonly string[],
  providerId: string,
  modelId: string,
): boolean {
  return favorites.includes(modelKey(providerId, modelId)) || favorites.includes(modelId);
}

/** Every active filter must match (AND semantics). */
export function modelMatchesFilters(
  model: ModelInfo,
  filters: ModelFilter[],
  favorites: string[] = [],
  favoriteMatch?: (modelId: string) => boolean,
): boolean {
  return filters.every((filter) => {
    switch (filter) {
      case 'favorites':
        return favoriteMatch ? favoriteMatch(model.id) : favorites.includes(model.id);
      case 'vision':
        return modelSupportsVision(model);
      case 'reasoning':
        return modelSupportsReasoning(model);
      case 'free':
        return model.status === 'free';
      default:
        return true;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export interface ModelListEntry {
  providerId: string;
  providerName: string;
  providerShortName: string;
  model: ModelInfo;
  favorite: boolean;
}

export interface ModelListGroup {
  key: string;
  label: string;
  /** Set when the group belongs to one provider (search results / global lists). */
  providerId: string | null;
  items: ModelListEntry[];
}

export interface BuildModelGroupsOptions {
  /** Restricts the list to a provider when there is no query. */
  providerId?: string | null;
  query?: string;
  filters?: ModelFilter[];
  favorites?: string[];
  /**
   * Provider-aware favorite matcher. The store keys favorites by
   * `providerId:modelId`; callers that already have the pair logic can pass it
   * here (defaults to the legacy bare-id check for backwards compatibility).
   */
  favoriteMatch?: (providerId: string, modelId: string) => boolean;
  /** The dialog shows unavailable models (disabled); the compact pill hides them. */
  includeUnavailable?: boolean;
}

function toEntry(provider: ProviderInfo, model: ModelInfo, favorite: boolean): ModelListEntry {
  return {
    providerId: provider.id,
    providerName: provider.name,
    providerShortName: provider.shortName,
    model,
    favorite,
  };
}

function groupModelsByFamily(models: ModelInfo[]): { family: string; models: ModelInfo[] }[] {
  const map = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const family = model.family || 'default';
    const list = map.get(family) ?? [];
    list.push(model);
    map.set(family, list);
  }
  return [...map.entries()]
    .map(([family, list]) => ({
      family,
      models: list.sort((a, b) => compareText(a.name, b.name)),
    }))
    .sort((a, b) => {
      const aOther = isOtherFamily(a.family);
      const bOther = isOtherFamily(b.family);
      if (aOther !== bOther) return aOther ? 1 : -1;
      return compareText(familyLabel(a.family), familyLabel(b.family));
    });
}

/**
 * Builds the groups consumed by `ModelList`.
 *
 * - With a query, the search spans every provider (global) and groups read
 *   "Go · Claude"; the current provider scope is intentionally ignored.
 * - Without a query, the list is scoped to `providerId` (when given) and
 *   favorites come first, followed by the remaining families ("Outros" last).
 */
export function buildModelGroups(
  providers: ProviderInfo[],
  options: BuildModelGroupsOptions = {},
): ModelListGroup[] {
  const {
    providerId = null,
    query = '',
    filters = [],
    favorites = [],
    favoriteMatch,
    includeUnavailable = false,
  } = options;
  const isFavorite = (candidateProvider: ProviderInfo, model: ModelInfo): boolean =>
    favoriteMatch
      ? favoriteMatch(candidateProvider.id, model.id)
      : favoriteEntryMatches(favorites, candidateProvider.id, model.id);
  const searching = normalizeSearch(query).length > 0;

  const scoped = searching || providerId == null
    ? providers
    : providers.filter((provider) => provider.id === providerId);

  const filtered = scoped
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => {
        if (!includeUnavailable && model.status === 'unavailable') return false;
        if (!modelMatchesFilters(model, filters, favorites, (modelId) => favoriteMatch
          ? favoriteMatch(provider.id, modelId)
          : favoriteEntryMatches(favorites, provider.id, modelId))) {
          return false;
        }
        if (!modelMatchesQuery(model, provider, query)) return false;
        return true;
      }),
    }))
    .filter((entry) => entry.models.length > 0);

  const groups: ModelListGroup[] = [];

  if (searching || providerId == null) {
    // Global mode: one group per provider + family, providers in catalog order.
    for (const { provider, models } of filtered) {
      for (const family of groupModelsByFamily(models)) {
        groups.push({
          key: `${provider.id}:${family.family}`,
          label: t('models:groups.providerFamily', {
            provider: provider.shortName,
            family: familyLabel(family.family),
          }),
          providerId: provider.id,
          items: family.models.map((model) => toEntry(provider, model, isFavorite(provider, model))),
        });
      }
    }
    return groups;
  }

  // Scoped mode: favorites first, then families (favorites removed from them).
  for (const { provider, models } of filtered) {
    const favoriteModels = models
      .filter((model) => isFavorite(provider, model))
      .sort((a, b) => compareText(a.name, b.name));
    if (favoriteModels.length) {
      groups.push({
        key: `${provider.id}:favorites`,
        label: t('models:groups.favorites'),
        providerId: provider.id,
        items: favoriteModels.map((model) => toEntry(provider, model, true)),
      });
    }
    const rest = models.filter((model) => !isFavorite(provider, model));
    for (const family of groupModelsByFamily(rest)) {
      groups.push({
        key: `${provider.id}:${family.family}`,
        label: familyLabel(family.family),
        providerId: provider.id,
        items: family.models.map((model) => toEntry(provider, model, false)),
      });
    }
  }

  return groups;
}

export function flattenGroups(groups: ModelListGroup[]): ModelListEntry[] {
  return groups.flatMap((group) => group.items);
}

export function entryKey(entry: ModelListEntry): string {
  return modelKey(entry.providerId, entry.model.id);
}

/** Preferred entry when still visible, otherwise the first selectable one. */
export function firstSelectable(
  groups: ModelListGroup[],
  preferredKey?: string | null,
): ModelListEntry | null {
  const entries = flattenGroups(groups);
  if (preferredKey) {
    const preferred = entries.find(
      (entry) => entryKey(entry) === preferredKey && entry.model.status !== 'unavailable',
    );
    if (preferred) return preferred;
  }
  return entries.find((entry) => entry.model.status !== 'unavailable') ?? entries[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Thinking modes                                                      */
/* ------------------------------------------------------------------ */

export type ThinkingOptionKind = 'off' | 'on' | 'effort' | 'budget';

export interface ThinkingOption {
  /** Stable id used for listbox options: "off" | "on" | "effort:high" | "budget:8192". */
  id: string;
  kind: ThinkingOptionKind;
  label: string;
  description: string;
  effort?: string;
  budget?: number;
  current: boolean;
}

export function effortDescription(effort: string): string {
  switch (effort) {
    case 'none':
      return t('models:effortDescriptions.none');
    case 'minimal':
      return t('models:effortDescriptions.minimal');
    case 'low':
      return t('models:effortDescriptions.low');
    case 'medium':
      return t('models:effortDescriptions.medium');
    case 'high':
      return t('models:effortDescriptions.high');
    case 'xhigh':
      return t('models:effortDescriptions.xhigh');
    case 'max':
      return t('models:effortDescriptions.max');
    default:
      return t('models:effortDescriptions.fallback');
  }
}

export interface BudgetPreset {
  budget: number;
  label: string;
  description: string;
}

const BUDGET_PRESET_BUDGETS = [4_096, 8_192, 16_384, 32_768] as const;

/** Copy of a budget preset; `null` for an out-of-catalog budget. */
function budgetPresetCopy(budget: number): { label: string; description: string } | null {
  switch (budget) {
    case 4_096:
      return {
        label: t('models:budget.fast.label'),
        description: t('models:budget.fast.description'),
      };
    case 8_192:
      return {
        label: t('models:budget.balanced.label'),
        description: t('models:budget.balanced.description'),
      };
    case 16_384:
      return {
        label: t('models:budget.deep.label'),
        description: t('models:budget.deep.description'),
      };
    case 32_768:
      return {
        label: t('models:budget.max.label'),
        description: t('models:budget.max.description'),
      };
    default:
      return null;
  }
}

/** Budget presets that fit the model's declared range. */
export function budgetPresets(model?: ModelInfo | null): BudgetPreset[] {
  const ui = reasoningUi(model);
  if (!ui.budget) return [];
  const min = ui.budget.min ?? 1_024;
  const max = ui.budget.max ?? 65_536;
  return BUDGET_PRESET_BUDGETS.filter((budget) => budget >= min && budget <= max).flatMap(
    (budget) => {
      const copy = budgetPresetCopy(budget);
      return copy ? [{ budget, ...copy }] : [];
    },
  );
}

/**
 * Every thinking mode offered by a model, in display order, with descriptions.
 *
 * - toggle-only models expose "Ligado" + "Desligado";
 * - effort models expose the effort tiers (+ "Desligado" when allowed);
 * - budget-only models expose token presets;
 * - models with efforts *and* budget expose both (efforts first).
 */
export function thinkingOptions(
  model: ModelInfo | undefined | null,
  selection: ReasoningSelection | null | undefined,
): ThinkingOption[] {
  if (!model) return [];
  const ui = reasoningUi(model);
  if (!ui.supported) return [];

  const currentId = currentThinkingId(selection);
  const options: ThinkingOption[] = [];
  const efforts = ui.efforts.filter((effort) => effort !== 'none');
  const presets = budgetPresets(model);

  if (ui.canDisable) {
    options.push({
      id: 'off',
      kind: 'off',
      label: t('models:thinking.offLabel'),
      description: t('models:thinking.offDescription'),
      current: currentId === 'off',
    });
  }

  if (efforts.length) {
    for (const effort of efforts) {
      options.push({
        id: `effort:${effort}`,
        kind: 'effort',
        label: effortLabel(effort),
        description: effortDescription(effort),
        effort,
        current: currentId === `effort:${effort}`,
      });
    }
  } else if (!presets.length) {
    // Toggle-only model: offer the explicit "on" state.
    options.push({
      id: 'on',
      kind: 'on',
      label: t('models:thinking.onLabel'),
      description: t('models:thinking.onDescription'),
      current: currentId === 'on',
    });
  }

  for (const preset of presets) {
    options.push({
      id: `budget:${preset.budget}`,
      kind: 'budget',
      label: preset.label,
      description: preset.description,
      budget: preset.budget,
      current: currentId === `budget:${preset.budget}`,
    });
  }

  return options;
}

export function currentThinkingId(
  selection: ReasoningSelection | null | undefined,
): string | null {
  if (!selection) return null;
  if (selection.mode === 'off') return 'off';
  if (selection.mode === 'effort') {
    return selection.effort ? `effort:${selection.effort}` : 'on';
  }
  if (selection.mode === 'budget') {
    return selection.budget ? `budget:${selection.budget}` : null;
  }
  return null;
}

export function thinkingSelectionFor(option: ThinkingOption): ReasoningSelection {
  if (option.kind === 'off') return { mode: 'off' };
  if (option.kind === 'budget') return { mode: 'budget', budget: option.budget ?? 8_192 };
  if (option.kind === 'on') return { mode: 'effort', effort: null };
  return { mode: 'effort', effort: option.effort ?? null };
}

/** Note shown above the thinking list when the model has constraints. */
export function thinkingNote(model?: ModelInfo | null): string | null {
  const ui = reasoningUi(model);
  if (!model || !ui.supported) return t('models:thinking.noControl');
  if (!ui.canDisable && ui.efforts.length) {
    return t('models:thinking.alwaysEffort');
  }
  if (!ui.canDisable && ui.budget) {
    return t('models:thinking.alwaysBudget');
  }
  return null;
}

/** Short label on the thinking segment of the pill (e.g. "Alto", "Desligado"). */
export function effortSegmentLabel(
  model: ModelInfo | undefined,
  selection: ReasoningSelection | null | undefined,
): string {
  if (!model) return t('models:thinking.defaultLabel');
  const ui = reasoningUi(model);
  if (!ui.supported) return t('models:thinking.defaultLabel');
  if (!selection || selection.mode === 'off') {
    return ui.canDisable ? t('models:thinking.offLabel') : t('models:thinking.defaultLabel');
  }
  if (selection.mode === 'effort') {
    return selection.effort ? effortLabel(selection.effort) : t('models:thinking.onLabel');
  }
  if (selection.mode === 'budget') {
    const budget = selection.budget ?? 4_096;
    const preset = budgetPresetCopy(budget);
    if (preset) return preset.label;
    return t('models:thinking.budgetK', { value: Math.round(budget / 1_024) });
  }
  return t('models:thinking.defaultLabel');
}

/** Sentence used by the detail panel to describe the current thinking mode. */
export function thinkingHeadline(
  model: ModelInfo | undefined,
  selection: ReasoningSelection | null | undefined,
): string {
  if (!model) return '—';
  const ui = reasoningUi(model);
  if (!ui.supported) return t('models:thinking.headlineNoControl');
  if (!selection || selection.mode === 'off') {
    return ui.canDisable ? t('models:thinking.headlineOff') : t('models:thinking.headlineDefault');
  }
  if (selection.mode === 'effort') {
    if (!selection.effort) return t('models:thinking.headlineOn');
    return t('models:thinking.headlineEffort', {
      effort: effortLabel(selection.effort).toLowerCase(),
    });
  }
  if (selection.mode === 'budget') {
    return t('models:thinking.headlineBudget', {
      value: formatContextWindow(selection.budget ?? 8_192),
    });
  }
  return t('models:thinking.headlineDefault');
}

function pickEffort(efforts: string[], preferred: string): string {
  if (efforts.includes(preferred)) return preferred;
  return efforts[0] ?? preferred;
}

/**
 * Reasoning to apply when switching models: keep the current effort whenever
 * the next model supports it, otherwise fall back to the model default so we
 * never send an unsupported mode.
 */
export function reasoningForModel(
  model: ModelInfo | undefined,
  previous: ReasoningSelection | null | undefined,
): ReasoningSelection | null {
  if (!model) return null;
  const ui = reasoningUi(model);
  if (!ui.supported) return null;

  if (previous?.mode === 'off' && ui.canDisable) {
    return { mode: 'off' };
  }
  if (previous?.mode === 'budget' && ui.budget) {
    const min = ui.budget.min ?? 1_024;
    const max = ui.budget.max ?? 65_536;
    const budget = Math.min(max, Math.max(min, previous.budget ?? 8_192));
    return { mode: 'budget', budget };
  }
  if (previous?.mode === 'effort' && previous.effort && ui.efforts.includes(previous.effort)) {
    return { mode: 'effort', effort: previous.effort };
  }
  if (previous?.mode === 'effort' && !previous.effort && !ui.efforts.length) {
    // "on" carries over to another toggle-only model.
    return { mode: 'effort', effort: null };
  }
  if (previous?.mode === 'budget' && ui.efforts.length) {
    const budget = previous.budget ?? 8_192;
    if (budget >= 24_576) return { mode: 'effort', effort: pickEffort(ui.efforts, 'max') };
    if (budget >= 8_192) return { mode: 'effort', effort: pickEffort(ui.efforts, 'high') };
    return { mode: 'effort', effort: pickEffort(ui.efforts, 'low') };
  }
  return defaultReasoningFor(model);
}

/* ------------------------------------------------------------------ */
/* Details                                                             */
/* ------------------------------------------------------------------ */

export function protocolLabel(protocol: string): string {
  switch (protocol) {
    case 'openai-chat':
      return t('models:protocols.openai-chat');
    case 'openai-responses':
      return t('models:protocols.openai-responses');
    case 'anthropic':
      return t('models:protocols.anthropic');
    case 'google':
      return t('models:protocols.google');
    default:
      return protocol;
  }
}

export function modalityLabel(modality: string): string {
  switch (modality.toLowerCase()) {
    case 'text':
      return t('models:modalities.text');
    case 'image':
      return t('models:modalities.image');
    case 'pdf':
      return t('models:modalities.pdf');
    case 'audio':
      return t('models:modalities.audio');
    case 'video':
      return t('models:modalities.video');
    default:
      return modality;
  }
}

export type ModelDetailLineId =
  | 'context'
  | 'maxOutput'
  | 'cost'
  | 'input'
  | 'protocol'
  | 'knowledge'
  | 'release';

export interface ModelDetailLine {
  id: ModelDetailLineId;
  label: string;
  value: string;
}

export interface ModelDetail {
  id: string;
  name: string;
  providerName: string;
  description: string | null;
  badges: string[];
  lines: ModelDetailLine[];
  statusNote: string | null;
}

/** Human-readable summary shown in the detail panel of both surfaces. */
export function modelDetails(
  model: ModelInfo | undefined,
  providerName?: string,
): ModelDetail | null {
  if (!model) return null;

  const lines: ModelDetailLine[] = [
    {
      id: 'context',
      label: t('models:details.context'),
      value: formatContextWindow(model.contextWindow),
    },
    {
      id: 'maxOutput',
      label: t('models:details.maxOutput'),
      value: formatContextWindow(model.maxOutput),
    },
    { id: 'cost', label: t('models:details.cost'), value: formatPrice(model.cost) },
  ];

  const inputs = (model.modalities.input ?? [])
    .map((modality) => modalityLabel(modality))
    .join(', ');
  if (inputs) lines.push({ id: 'input', label: t('models:details.input'), value: inputs });

  const protocols = model.protocols.map((protocol) => protocolLabel(protocol)).join(', ');
  if (protocols) lines.push({ id: 'protocol', label: t('models:details.protocol'), value: protocols });

  if (model.knowledge) {
    lines.push({ id: 'knowledge', label: t('models:details.knowledge'), value: model.knowledge });
  }
  if (model.releaseDate) {
    lines.push({ id: 'release', label: t('models:details.release'), value: model.releaseDate });
  }

  return {
    id: model.id,
    name: model.name,
    providerName: providerName ?? '',
    description: model.description?.trim() || null,
    badges: modelBadges(model),
    lines,
    statusNote: modelStatusNote(model),
  };
}

/** Short status note rendered as a warning/info box in the detail panel. */
export function modelStatusNote(model?: ModelInfo | null): string | null {
  if (!model) return null;
  if (model.status === 'unavailable') {
    return t('models:status.unavailable');
  }
  if (model.status === 'beta') return t('models:status.beta');
  if (model.status === 'free') return t('models:status.free');
  return null;
}

/* ------------------------------------------------------------------ */
/* Provider keys                                                       */
/* ------------------------------------------------------------------ */

export function keyStatusFor(
  keys: ProviderKeyStatus[],
  providerId: string,
): ProviderKeyStatus | undefined {
  return keys.find((key) => key.providerId === providerId);
}

export function providerHasKey(keys: ProviderKeyStatus[], providerId: string): boolean {
  return Boolean(keyStatusFor(keys, providerId)?.hasKey);
}

export function keyStatusLabel(key?: ProviderKeyStatus): string {
  switch (key?.source) {
    case 'settings':
      return t('models:keys.settings');
    case 'env':
      return t('models:keys.env');
    case 'opencode-cli':
      return t('models:keys.opencodeCli');
    case 'chatgpt':
      return key?.hasKey ? t('models:keys.chatgpt') : t('models:keys.chatgptExpired');
    default:
      return key?.mode === 'oauth' ? t('models:keys.noChatgpt') : t('models:keys.noKey');
  }
}