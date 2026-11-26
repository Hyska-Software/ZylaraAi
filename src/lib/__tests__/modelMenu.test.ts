import { describe, expect, it } from 'vitest';
import { getModel, getProvider, providerAuth, providerSupportsPlan, providers } from '@/lib/catalog';
import type { ModelInfo, ProviderAuthStatus, ProviderInfo } from '@/lib/types';
import {
  budgetPresets,
  buildModelGroups,
  currentThinkingId,
  effortDescription,
  effortSegmentLabel,
  entryKey,
  familyLabel,
  firstSelectable,
  flattenGroups,
  keyStatusFor,
  keyStatusLabel,
  modelDetails,
  modelFilterOptions,
  modelKey,
  modelMatchesFilters,
  modelMatchesQuery,
  modelStatusNote,
  modelSupportsReasoning,
  modelSupportsVision,
  normalizeSearch,
  parseModelKey,
  providerHasKey,
  reasoningForModel,
  selectionKey,
  protocolLabel,
  selectorProviders,
  thinkingHeadline,
  thinkingNote,
  thinkingOptions,
  thinkingSelectionFor,
} from '@/lib/modelMenu';

const go = getProvider('opencode-go')!;
const zen = getProvider('opencode-zen')!;
const allProviders = providers();

function syntheticModel(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    id: 'modelo-teste',
    name: 'Modelo Teste',
    family: 'default',
    protocols: ['openai-chat'],
    reasoning: true,
    reasoningOptions: [],
    attachment: false,
    modalities: { input: ['text'], output: ['text'] },
    contextWindow: 128_000,
    maxOutput: 16_384,
    cost: null,
    releaseDate: null,
    knowledge: null,
    openWeights: false,
    description: null,
    tags: [],
    status: 'stable',
    ...overrides,
  };
}

function syntheticProvider(models: ModelInfo[]): ProviderInfo {
  return { ...go, id: 'teste', name: 'Provedor Teste', shortName: 'T', models };
}

function groupLabels(groups: ReturnType<typeof buildModelGroups>): string[] {
  return groups.map((group) => group.label);
}

function groupIds(groups: ReturnType<typeof buildModelGroups>): string[] {
  return flattenGroups(groups).map((entry) => entry.model.id);
}

describe('model keys', () => {
  it('builds and parses provider-qualified keys', () => {
    expect(modelKey('opencode-go', 'glm-5.3-flash')).toBe('opencode-go:glm-5.3-flash');
    expect(parseModelKey('opencode-go:glm-5.3-flash')).toEqual({
      providerId: 'opencode-go',
      modelId: 'glm-5.3-flash',
    });
    expect(parseModelKey('sem-provedor')).toBeNull();
    expect(parseModelKey(':modelo')).toBeNull();
    expect(parseModelKey('provedor:')).toBeNull();
  });

  it('derives the selection key', () => {
    expect(
      selectionKey({ providerId: 'opencode-go', modelId: 'glm-5.3-flash', reasoning: null }),
    ).toBe('opencode-go:glm-5.3-flash');
    expect(selectionKey(null)).toBeNull();
  });
});

describe('familyLabel', () => {
  it('uses curated display names', () => {
    expect(familyLabel('claude')).toBe('Claude');
    expect(familyLabel('deepseek')).toBe('DeepSeek');
    expect(familyLabel('minimax')).toBe('MiniMax');
    expect(familyLabel('gpt')).toBe('GPT');
    expect(familyLabel('longcat')).toBe('LongCat');
  });

  it('maps default/empty to "Outros" and capitalizes unknown families', () => {
    expect(familyLabel('default')).toBe('Outros');
    expect(familyLabel('')).toBe('Outros');
    expect(familyLabel(null)).toBe('Outros');
    expect(familyLabel('outros')).toBe('Outros');
    expect(familyLabel('nova-familia')).toBe('Nova-familia');
  });
});

describe('normalizeSearch / modelMatchesQuery', () => {
  const glm = getModel('opencode-go', 'glm-5.3-flash')!;

  it('normalizes case, accents and spacing', () => {
    expect(normalizeSearch('  Visão  ')).toBe('visao');
    expect(normalizeSearch('GLM-5.3')).toBe('glm-5.3');
  });

  it('matches name, id and family tokens (case/accent insensitive)', () => {
    expect(modelMatchesQuery(glm, go, 'glm')).toBe(true);
    expect(modelMatchesQuery(glm, go, 'GLM 5.3')).toBe(true);
    expect(modelMatchesQuery(glm, go, 'glm-5.3-flash')).toBe(true);
    expect(modelMatchesQuery(glm, go, 'flash')).toBe(true);
    expect(modelMatchesQuery(glm, go, 'nao-existe')).toBe(false);
    expect(modelMatchesQuery(glm, go, '')).toBe(true);
  });

  it('matches provider names and descriptions', () => {
    expect(modelMatchesQuery(glm, go, 'opencode')).toBe(true);
    expect(modelMatchesQuery(glm, go, 'multimodal')).toBe(true);
  });

  it('requires every token to match', () => {
    expect(modelMatchesQuery(glm, go, 'glm flash')).toBe(true);
    expect(modelMatchesQuery(glm, go, 'glm claude')).toBe(false);
  });
});

describe('filters', () => {
  const glm = getModel('opencode-go', 'glm-5.3-flash')!;
  const beam = getModel('opencode-go', 'beam-free')!;
  const noVision = getModel('opencode-go', 'glm-5.1')!;
  const mimo = getModel('opencode-go', 'mimo-v2.6-flash')!;

  it('exposes the quick filter options', () => {
    expect(modelFilterOptions().map((option) => option.value)).toEqual([
      'favorites',
      'vision',
      'reasoning',
      'free',
    ]);
  });

  it('matches capability filters', () => {
    expect(modelSupportsVision(glm)).toBe(true);
    expect(modelSupportsVision(noVision)).toBe(false);
    expect(modelSupportsReasoning(glm)).toBe(true);
    expect(modelSupportsReasoning(mimo)).toBe(false);
    expect(modelMatchesFilters(glm, ['vision', 'reasoning'])).toBe(true);
    expect(modelMatchesFilters(noVision, ['vision'])).toBe(false);
    expect(modelMatchesFilters(beam, ['free'])).toBe(true);
    expect(modelMatchesFilters(mimo, ['reasoning'])).toBe(false);
  });

  it('matches favorites by model id and requires every filter', () => {
    expect(modelMatchesFilters(glm, ['favorites'], ['glm-5.3-flash'])).toBe(true);
    expect(modelMatchesFilters(glm, ['favorites'], [])).toBe(false);
    expect(modelMatchesFilters(glm, ['favorites', 'free'], ['glm-5.3-flash'])).toBe(false);
  });
});

describe('buildModelGroups (scoped)', () => {
  it('lists favorites first, then families with "Outros" last', () => {
    const groups = buildModelGroups([go], {
      providerId: go.id,
      favorites: ['glm-5.3-flash'],
    });
    expect(groups[0].label).toBe('Favoritos');
    expect(groups[0].items.map((entry) => entry.model.id)).toEqual(['glm-5.3-flash']);
    expect(groups[groups.length - 1].label).toBe('Outros');
    expect(groupLabels(groups)).toContain('Claude');
    expect(groupLabels(groups)).toContain('DeepSeek');
    expect(groupLabels(groups)).toContain('GLM');
  });

  it('does not duplicate favorites inside their family', () => {
    const groups = buildModelGroups([go], {
      providerId: go.id,
      favorites: ['glm-5.3-flash'],
    });
    const ids = groupIds(groups);
    expect(ids.filter((id) => id === 'glm-5.3-flash')).toHaveLength(1);
    const glmGroup = groups.find((group) => group.label === 'GLM');
    expect(glmGroup?.items.some((entry) => entry.model.id === 'glm-5.3-flash')).toBe(false);
  });

  it('hides unavailable models by default and keeps them in the dialog mode', () => {
    const hidden = groupIds(buildModelGroups([go], { providerId: go.id }));
    expect(hidden).not.toContain('mimo-v2.5-pro');

    const visible = groupIds(
      buildModelGroups([go], { providerId: go.id, includeUnavailable: true }),
    );
    expect(visible).toContain('mimo-v2.5-pro');
  });

  it('scopes the list to the requested provider', () => {
    const groups = buildModelGroups(allProviders, { providerId: go.id });
    const entries = flattenGroups(groups);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.providerId === go.id)).toBe(true);
  });

  it('applies capability filters inside the scope', () => {
    const groups = buildModelGroups([go], { providerId: go.id, filters: ['free'] });
    const entries = flattenGroups(groups);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.model.status === 'free')).toBe(true);
  });

  it('exposes provider metadata on every entry', () => {
    const [group] = buildModelGroups([go], { providerId: go.id });
    expect(group.items[0]).toMatchObject({
      providerId: go.id,
      providerName: go.name,
      providerShortName: go.shortName,
    });
  });
});

describe('buildModelGroups (global search)', () => {
  it('searches every provider and labels groups by provider + family', () => {
    const groups = buildModelGroups(allProviders, { query: 'opus' });
    const labels = groupLabels(groups);
    expect(labels.length).toBeGreaterThan(0);
    // Claude Opus existe no gateway (Zen) e no provedor Anthropic direto.
    expect(
      labels.every((label) => label === 'Zen · Claude' || label === 'Anthropic · Claude'),
    ).toBe(true);
    const providerIds = flattenGroups(groups).map((entry) => entry.providerId);
    expect(providerIds).toContain(zen.id);
    expect(providerIds).toContain('anthropic');
  });

  it('ignores the provider scope while searching', () => {
    const groups = buildModelGroups(allProviders, {
      providerId: go.id,
      query: 'claude-opus-5',
    });
    expect(flattenGroups(groups).some((entry) => entry.providerId === zen.id)).toBe(true);
  });

  it('returns no groups when nothing matches', () => {
    expect(buildModelGroups(allProviders, { query: 'modelo-inexistente-xyz' })).toEqual([]);
  });

  it('combines search with filters', () => {
    const groups = buildModelGroups(allProviders, { query: 'claude', filters: ['vision'] });
    const entries = flattenGroups(groups);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => modelSupportsVision(entry.model))).toBe(true);
  });
});

describe('provedor Anthropic direto (API key)', () => {
  const anthropic = getProvider('anthropic')!;

  it('expõe catálogo Claude exclusivo do protocolo anthropic', () => {
    expect(anthropic.name).toBe('Anthropic');
    expect(anthropic.shortName).toBe('Anthropic');
    // Sem `auth: "oauth"` no catálogo → provedor de API key (sem plano).
    expect(providerAuth(anthropic)).toBe('api-key');
    expect(providerSupportsPlan(anthropic)).toBe(false);
    expect(anthropic.headers).toEqual({ 'anthropic-version': '2026-10-21' });
    expect(anthropic.endpoints.anthropic).toBe('/messages');
    expect(anthropic.models.length).toBeGreaterThanOrEqual(10);
    for (const model of anthropic.models) {
      expect(model.family).toBe('claude');
      expect(model.protocols).toEqual(['anthropic']);
      expect(model.reasoningOptions.length).toBeGreaterThan(0);
    }
  });

  it('lista os modelos no seletor com contexto, preço e raciocínio', () => {
    const entries = flattenGroups(buildModelGroups(allProviders, { providerId: 'anthropic' }));
    expect(entries).toHaveLength(anthropic.models.length);
    const sonnet = entries.find((entry) => entry.model.id === 'claude-sonnet-5-5')!;
    expect(sonnet.providerShortName).toBe('Anthropic');
    const details = modelDetails(sonnet.model, sonnet.providerName)!;
    expect(details.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'context', label: 'Contexto', value: '1M' }),
        expect.objectContaining({ id: 'cost', label: 'Custo (1M tok.)', value: '$2.00 / $10.00' }),
        expect.objectContaining({ id: 'protocol', label: 'Protocolo', value: 'Anthropic Messages' }),
      ]),
    );
    // Esforço: os cinco níveis documentados (low..max).
    expect(thinkingOptions(sonnet.model, { mode: 'effort', effort: 'high' }).map((o) => o.id))
      .toEqual(['effort:low', 'effort:medium', 'effort:high', 'effort:xhigh', 'effort:max']);
  });

  it('modelo com orçamento (4.5) usa modo thinking enabled', () => {
    const haiku = getModel('anthropic', 'claude-haiku-4-5')!;
    const details = modelDetails(haiku, 'Anthropic')!;
    expect(details.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'context', label: 'Contexto', value: '200K' }),
      ]),
    );
    expect(thinkingOptions(haiku, { mode: 'budget', budget: 8_192 }).map((o) => o.id)).toEqual([
      'off',
      'budget:4096',
      'budget:8192',
      'budget:16384',
      'budget:32768',
    ]);
  });

  it('busca global "claude sonnet 5.5" encontra o modelo dos dois provedores', () => {
    const groups = buildModelGroups(allProviders, { query: 'claude sonnet 5.5' });
    const providerIds = new Set(flattenGroups(groups).map((entry) => entry.providerId));
    expect(providerIds.has('anthropic')).toBe(true);
    expect(providerIds.has(zen.id)).toBe(true);
  });
});

describe('flattenGroups / firstSelectable', () => {
  it('flattens entries in display order', () => {
    const groups = buildModelGroups([go], { providerId: go.id, favorites: ['claude-haiku-5-5'] });
    const entries = flattenGroups(groups);
    expect(entryKey(entries[0])).toBe('opencode-go:claude-haiku-5-5');
  });

  it('prefers the requested key when visible', () => {
    const groups = buildModelGroups([go], { providerId: go.id });
    const entry = firstSelectable(groups, 'opencode-go:glm-5.3-flash');
    expect(entry?.model.id).toBe('glm-5.3-flash');
  });

  it('skips unavailable preferred models and empty lists', () => {
    const groups = buildModelGroups([go], { providerId: go.id, includeUnavailable: true });
    const entry = firstSelectable(groups, 'opencode-go:mimo-v2.5-pro');
    expect(entry).not.toBeNull();
    expect(entry?.model.status).not.toBe('unavailable');
    expect(firstSelectable([])).toBeNull();
  });
});

describe('thinkingOptions', () => {
  const glm = getModel('opencode-go', 'glm-5.3-flash')!;
  const claude = getModel('opencode-go', 'claude-haiku-5-5')!;
  const kimi = getModel('opencode-go', 'kimi-k2.6')!;
  const qwen = getModel('opencode-go', 'qwen3.8-max')!;
  const noControl = getModel('opencode-go', 'mimo-v2.6-flash')!;

  it('lists effort tiers with descriptions for effort-only models', () => {
    const options = thinkingOptions(glm, { mode: 'effort', effort: 'max' });
    expect(options.map((option) => option.id)).toEqual([
      'effort:low',
      'effort:high',
      'effort:max',
    ]);
    expect(options.map((option) => option.label)).toEqual(['Baixo', 'Alto', 'Máximo']);
    expect(options.every((option) => option.description.length > 0)).toBe(true);
    expect(options.filter((option) => option.current)).toHaveLength(1);
    expect(options.find((option) => option.current)?.effort).toBe('max');
  });

  it('offers "Desligado" for models with a toggle', () => {
    const options = thinkingOptions(claude, { mode: 'off' });
    expect(options[0]).toMatchObject({ id: 'off', kind: 'off', current: true });
    expect(options.filter((option) => option.kind === 'effort')).toHaveLength(5);
  });

  it('offers "Ligado" and "Desligado" for toggle-only models', () => {
    const options = thinkingOptions(kimi, null);
    expect(options.map((option) => option.id)).toEqual(['off', 'on']);
    expect(options[1]).toMatchObject({ kind: 'on', label: 'Ligado' });
  });

  it('derives budget presets when the model only accepts budget tokens', () => {
    const budgetModel = syntheticModel({
      reasoningOptions: [{ type: 'budget_tokens', min: 2_048, max: 16_384 }],
    });
    const options = thinkingOptions(budgetModel, { mode: 'budget', budget: 8_192 });
    expect(options.map((option) => option.kind)).toEqual(['budget', 'budget', 'budget']);
    expect(options.map((option) => option.budget)).toEqual([4_096, 8_192, 16_384]);
    expect(options.find((option) => option.current)?.budget).toBe(8_192);
  });

  it('lists efforts before budget presets when the model exposes both', () => {
    const options = thinkingOptions(qwen, null);
    expect(options[0].id).toBe('off');
    expect(options.filter((option) => option.kind === 'effort')).toHaveLength(3);
    expect(options.filter((option) => option.kind === 'budget')).toHaveLength(4);
  });

  it('returns no options without reasoning control', () => {
    expect(thinkingOptions(noControl, null)).toEqual([]);
    expect(thinkingOptions(undefined, null)).toEqual([]);
  });

  it('clamps presets to the model range', () => {
    const presets = budgetPresets(
      syntheticModel({ reasoningOptions: [{ type: 'budget_tokens', min: 2_048, max: 16_384 }] }),
    );
    expect(presets.map((preset) => preset.budget)).toEqual([4_096, 8_192, 16_384]);
    expect(budgetPresets(noControl)).toEqual([]);
  });

  it('describes effort levels', () => {
    expect(effortDescription('low')).toContain('Rápido');
    expect(effortDescription('desconhecido')).toContain('Ajusta quanto');
  });

  it('derives presets from the model range when no curated preset fits', () => {
    const presets = budgetPresets(
      syntheticModel({ reasoningOptions: [{ type: 'budget_tokens', min: 1_100, max: 3_000 }] }),
    );
    expect(presets.map((preset) => preset.budget)).toEqual([1_100, 2_048, 3_000]);
    expect(presets.every((preset) => preset.label.includes('tokens'))).toBe(true);
  });
});

describe('thinking selection mapping', () => {
  it('maps options back to selections', () => {
    expect(thinkingSelectionFor(thinkingOptions(getModel('opencode-go', 'glm-5.3-flash')!, null)[0])).toEqual(
      { mode: 'effort', effort: 'low' },
    );
    expect(
      thinkingSelectionFor(
        thinkingOptions(getModel('opencode-go', 'claude-haiku-5-5')!, null)[0],
      ),
    ).toEqual({ mode: 'off' });
    expect(
      thinkingSelectionFor(thinkingOptions(getModel('opencode-go', 'kimi-k2.6')!, null)[1]),
    ).toEqual({ mode: 'effort', effort: null });
  });

  it('derives the current option id', () => {
    expect(currentThinkingId(null)).toBeNull();
    expect(currentThinkingId({ mode: 'off' })).toBe('off');
    expect(currentThinkingId({ mode: 'effort', effort: 'high' })).toBe('effort:high');
    expect(currentThinkingId({ mode: 'effort', effort: null })).toBe('on');
    expect(currentThinkingId({ mode: 'budget', budget: 8_192 })).toBe('budget:8192');
    expect(currentThinkingId({ mode: 'budget', budget: null })).toBeNull();
  });
});

describe('thinking labels and notes', () => {
  const glm = getModel('opencode-go', 'glm-5.3-flash')!;
  const claude = getModel('opencode-go', 'claude-haiku-5-5')!;
  const noControl = syntheticModel({ reasoning: false, reasoningOptions: [] });

  it('labels the pill segment', () => {
    expect(effortSegmentLabel(glm, { mode: 'effort', effort: 'max' })).toBe('Máximo');
    expect(effortSegmentLabel(glm, { mode: 'effort', effort: null })).toBe('Ligado');
    expect(effortSegmentLabel(claude, { mode: 'off' })).toBe('Desligado');
    expect(effortSegmentLabel(claude, { mode: 'budget', budget: 16_384 })).toBe('Profundo');
    expect(effortSegmentLabel(glm, { mode: 'budget', budget: 6_000 })).toBe('6k');
    expect(effortSegmentLabel(noControl, null)).toBe('Padrão');
    expect(effortSegmentLabel(undefined, null)).toBe('Padrão');
  });

  it('headlines the current thinking mode', () => {
    expect(thinkingHeadline(glm, { mode: 'effort', effort: 'max' })).toBe('Pensamento máximo');
    expect(thinkingHeadline(claude, { mode: 'off' })).toBe('Pensamento desligado');
    expect(thinkingHeadline(claude, { mode: 'budget', budget: 16_384 })).toBe(
      'Orçamento de 16K tokens',
    );
    expect(thinkingHeadline(noControl, null)).toBe('Sem controle de raciocínio');
    expect(thinkingHeadline(undefined, null)).toBe('—');
  });

  it('explains model constraints', () => {
    expect(thinkingNote(glm)).toContain('sempre pensa');
    expect(thinkingNote(claude)).toBeNull();
    expect(thinkingNote(noControl)).toContain('não expõe');
    const budgetOnly = syntheticModel({
      reasoningOptions: [{ type: 'budget_tokens', min: 2_048, max: 16_384 }],
    });
    expect(thinkingNote(budgetOnly)).toContain('orçamento');
  });
});

describe('reasoningForModel', () => {
  const glm = getModel('opencode-go', 'glm-5.3-flash')!;
  const claude = getModel('opencode-go', 'claude-haiku-5-5')!;
  const deepseek = getModel('opencode-go', 'deepseek-v4.1-flash')!;
  const minimax = getModel('opencode-go', 'minimax-m3')!;
  const kimi = getModel('opencode-go', 'kimi-k2.6')!;
  const noControl = syntheticModel({ id: 'sem-controle', reasoning: false, reasoningOptions: [] });

  it('keeps the same effort when the next model supports it', () => {
    expect(reasoningForModel(glm, { mode: 'effort', effort: 'max' })).toEqual({
      mode: 'effort',
      effort: 'max',
    });
    expect(reasoningForModel(claude, { mode: 'effort', effort: 'max' })).toEqual({
      mode: 'effort',
      effort: 'max',
    });
  });

  it('falls back to the model default when the effort is unsupported', () => {
    expect(reasoningForModel(minimax, { mode: 'effort', effort: 'max' })).toEqual({ mode: 'off' });
    expect(reasoningForModel(deepseek, { mode: 'effort', effort: 'medium' })).toEqual({
      mode: 'effort',
      effort: 'high',
    });
  });

  it('keeps "off" only for models that can disable thinking', () => {
    expect(reasoningForModel(glm, { mode: 'off' })).toEqual({ mode: 'effort', effort: 'high' });
    expect(reasoningForModel(claude, { mode: 'off' })).toEqual({ mode: 'off' });
  });

  it('carries "on" between toggle-only models', () => {
    expect(reasoningForModel(kimi, { mode: 'effort', effort: null })).toEqual({
      mode: 'effort',
      effort: null,
    });
  });

  it('clamps a budget selection into the model range', () => {
    const budgetModel = syntheticModel({
      reasoningOptions: [{ type: 'budget_tokens', min: 2_048, max: 16_384 }],
    });
    expect(reasoningForModel(budgetModel, { mode: 'budget', budget: 99_000 })).toEqual({
      mode: 'budget',
      budget: 16_384,
    });
  });

  it('maps a budget preference onto effort tiers', () => {
    expect(reasoningForModel(glm, { mode: 'budget', budget: 32_000 })).toEqual({
      mode: 'effort',
      effort: 'max',
    });
    expect(reasoningForModel(glm, { mode: 'budget', budget: 8_192 })).toEqual({
      mode: 'effort',
      effort: 'high',
    });
    expect(reasoningForModel(glm, { mode: 'budget', budget: 2_000 })).toEqual({
      mode: 'effort',
      effort: 'low',
    });
  });

  it('returns null for models without thinking controls', () => {
    expect(reasoningForModel(noControl, { mode: 'effort', effort: 'max' })).toBeNull();
    expect(reasoningForModel(undefined, null)).toBeNull();
  });

  it('defaults budget-only models to a concrete budget when switching', () => {
    const budgetOnly = syntheticModel({
      reasoningOptions: [{ type: 'budget_tokens', min: 2_048, max: 16_384 }],
    });
    expect(reasoningForModel(budgetOnly, { mode: 'effort', effort: 'max' })).toEqual({
      mode: 'budget',
      budget: 8_192,
    });
    expect(reasoningForModel(budgetOnly, null)).toEqual({ mode: 'budget', budget: 8_192 });
  });
});

describe('modelDetails', () => {
  const deepseek = getModel('opencode-go', 'deepseek-v4.1-flash')!;
  const unavailable = getModel('opencode-go', 'mimo-v2.5-pro')!;
  const beta = getModel('opencode-go', 'omen-alpha')!;
  const free = getModel('opencode-go', 'beam-free')!;
  const noControl = syntheticModel({ id: 'sem-controle', reasoning: false, reasoningOptions: [] });

  it('summarises context, output, pricing, input and protocol', () => {
    const details = modelDetails(deepseek, 'OpenCode Go')!;
    expect(details.name).toBe('DeepSeek V4.1 Flash');
    expect(details.providerName).toBe('OpenCode Go');
    expect(details.description).toContain('DeepSeek');
    const line = (label: string) => details.lines.find((entry) => entry.label === label)?.value;
    expect(line('Contexto')).toBe('1M');
    expect(line('Saída máx.')).toBe('384K');
    expect(line('Custo (1M tok.)')).toBe('$0.12 / $0.48');
    expect(line('Entrada')).toBe('Texto, Imagem');
    expect(line('Protocolo')).toBe('OpenAI Chat');
    // Catalog-driven value: `pnpm catalog:sync` updates the date, so the test
    // follows the model instead of hardcoding it.
    expect(line('Lançamento')).toBe(deepseek.releaseDate);
  });

  it('lists capability badges', () => {
    const details = modelDetails(deepseek)!;
    expect(details.badges).toContain('Visão');
    expect(details.badges).toContain('Raciocínio');
    expect(details.badges).toContain('Open');
    expect(modelDetails(noControl)!.badges).not.toContain('Raciocínio');
  });

  it('explains model status', () => {
    expect(modelStatusNote(unavailable)).toContain('Indisponível');
    expect(modelStatusNote(beta)).toContain('prévia');
    expect(modelStatusNote(free)).toContain('gratuito');
    expect(modelStatusNote(deepseek)).toBeNull();
    expect(modelDetails(undefined)).toBeNull();
  });
});

describe('provider key status', () => {
  const keys = [
    { providerId: 'opencode-go', hasKey: true, source: 'settings' as const },
    { providerId: 'opencode-zen', hasKey: false, source: 'none' as const },
  ];

  it('finds the key entry and whether it is configured', () => {
    expect(keyStatusFor(keys, 'opencode-go')?.hasKey).toBe(true);
    expect(providerHasKey(keys, 'opencode-go')).toBe(true);
    expect(providerHasKey(keys, 'opencode-zen')).toBe(false);
    expect(providerHasKey(keys, 'desconhecido')).toBe(false);
  });

  it('labels key sources', () => {
    expect(keyStatusLabel(keys[0])).toBe('Chave configurada');
    expect(keyStatusLabel({ providerId: 'x', hasKey: true, source: 'env' })).toBe(
      'Chave via variável de ambiente',
    );
    expect(keyStatusLabel({ providerId: 'x', hasKey: true, source: 'opencode-cli' })).toBe(
      'Chave do OpenCode CLI',
    );
    expect(keyStatusLabel(undefined)).toBe('Sem chave de API');
  });
});

describe('selectorProviders', () => {
  const ids = (list: ProviderInfo[]) => list.map((provider) => provider.id);
  const signedIn = (providerId: string) =>
    ({ providerId, state: 'signed-in' }) as unknown as ProviderAuthStatus;

  it('offers the curated providers even without a credential', () => {
    expect(ids(selectorProviders(allProviders, [], []))).toEqual([
      'opencode-go',
      'opencode-zen',
      'openai',
      'anthropic',
      'gemini',
    ]);
  });

  it('adds a provider once it has a stored key or a connected account', () => {
    expect(
      ids(selectorProviders(allProviders, [{ providerId: 'deepseek', hasKey: true, source: 'settings' }], [])),
    ).toContain('deepseek');
    expect(ids(selectorProviders(allProviders, [], [signedIn('xai')]))).toContain('xai');
    // A disconnected account does not make the provider selectable.
    expect(
      ids(
        selectorProviders(allProviders, [], [
          { providerId: 'xai', state: 'signed-out' } as unknown as ProviderAuthStatus,
        ]),
      ),
    ).not.toContain('xai');
  });

  it('keeps the current selection and user-defined providers, drops the rest', () => {
    const custom = { ...allProviders[0], id: 'acme-gateway', origin: 'custom' } as ProviderInfo;
    const list = selectorProviders([...allProviders, custom], [], [], 'deepseek');
    expect(ids(list)).toContain('deepseek');
    expect(ids(list)).toContain('acme-gateway');
    expect(ids(list)).not.toContain('groq');
    expect(ids(list)).not.toContain('openrouter');
  });

});

describe('protocolLabel', () => {
  it('localizes the ACP transport label instead of leaking the raw id', () => {
    expect(protocolLabel('acp')).not.toBe('acp');
    expect(protocolLabel('acp')).toContain('ACP');
  });
});
