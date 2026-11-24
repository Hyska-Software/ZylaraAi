#!/usr/bin/env node
/**
 * Builds the bundled model catalog used by both the Rust backend and the React UI.
 *
 * Data sources (regenerate with `pnpm catalog:sync`, which downloads them):
 *  - OpenCode Go / Zen official docs tables      -> model ids and display names
 *  - OpenCode Go / Zen public `/v1/models` lists -> authoritative availability, protocol and live metadata
 *  - models.dev catalog (providers opencode/...) -> capabilities, reasoning options, limits, cost
 *  - live protocol verification (probe scripts)  -> which wire protocols each model accepts
 *
 * Output: data/catalog.json
 */
import fs from 'node:fs';
import path from 'node:path';

import { LIVE_MODEL_SOURCES, parseLiveModels } from './catalog-sources.mjs';
import {
  DEFAULT_MODEL_CAP,
  endpointsFor,
  EXTRA_PROVIDERS,
  validateProviderSeeds,
} from './provider-seeds.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RESEARCH = path.join(ROOT, '.research');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RESEARCH, p), 'utf8'));
  } catch (error) {
    throw new Error(`input ausente em .research/${p}: rode "pnpm catalog:sync" (${error.message})`);
  }
}

const docsGo = readJson('docs-go.json');
const docsZen = readJson('docs-zen.json');
const modelsDev = readJson('models-dev.json');
// Protocol probes are an optional local verification artifact: without them the
// docs tables still define availability and wire protocol.
const goProtocols = (() => {
  try {
    return readJson('go-protocols.json');
  } catch {
    return [];
  }
})();

const outDir = path.join(ROOT, 'data');
const outFile = path.join(outDir, 'catalog.json');

function previousModels(providerId) {
  try {
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    return existing.providers?.find((provider) => provider.id === providerId)?.models ?? [];
  } catch {
    return [];
  }
}

const previousGoModels = previousModels('opencode-go');
const previousZenModels = previousModels('opencode-zen');

const mdModels = (providerId) => modelsDev[providerId]?.models ?? {};
const mdOpencode = mdModels('opencode');
const mdGo = mdModels('opencode-go');
const mdOpenai = mdModels('openai');
const mdAnthropic = mdModels('anthropic');
const mdGoogle = mdModels('google');
const docsOpenai = [];

const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));

const docsGoById = byId(docsGo);
const docsZenById = byId(docsZen);
const verifiedById = Object.fromEntries(goProtocols.map((r) => [r.id, r]));
// The public gateway lists are optional locally so offline builds keep working;
// when present they are the authoritative source of model availability.
const readOptionalJson = (p) => {
  try {
    return readJson(p);
  } catch {
    return null;
  }
};
const liveGoById = byId(parseLiveModels(readOptionalJson('go-models-live.json')));
const liveZenById = byId(parseLiveModels(readOptionalJson('zen-models-live.json')));

/* ------------------------------------------------------------------ */
/* Heuristics for models missing from models.dev                       */
/* ------------------------------------------------------------------ */

const FAMILY_DEFAULTS = {
  claude: {
    context: 1_000_000,
    output: 128_000,
    attachment: true,
    reasoningOptions: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  },
  gpt: {
    context: 1_050_000,
    output: 128_000,
    attachment: true,
    reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
  },
  grok: {
    context: 500_000,
    output: 128_000,
    attachment: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
  },
  gemini: {
    context: 1_048_576,
    output: 65_536,
    attachment: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  },
  glm: {
    context: 1_000_000,
    output: 131_072,
    attachment: false,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  },
  kimi: {
    context: 1_048_576,
    output: 131_072,
    attachment: true,
    reasoningOptions: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
  },
  qwen: {
    context: 1_000_000,
    output: 131_072,
    attachment: true,
    reasoningOptions: [{ type: 'toggle' }],
  },
  minimax: {
    context: 1_000_000,
    output: 128_000,
    attachment: true,
    reasoningOptions: [{ type: 'toggle' }],
  },
  mimo: {
    context: 1_048_576,
    output: 128_000,
    attachment: true,
    reasoningOptions: [],
  },
  deepseek: {
    context: 1_000_000,
    output: 384_000,
    attachment: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  },
  muse: {
    context: 1_048_576,
    output: 131_072,
    attachment: true,
    reasoningOptions: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
  },
  longcat: {
    context: 1_000_000,
    output: 131_072,
    attachment: true,
    reasoningOptions: [{ type: 'toggle' }],
  },
  step: {
    context: 1_000_000,
    output: 65_536,
    attachment: true,
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  },
  hy: {
    context: 1_000_000,
    output: 128_000,
    attachment: false,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
  },
  nemotron: { context: 1_048_576, output: 131_072, attachment: true, reasoningOptions: [] },
  mistral: { context: 524_288, output: 262_144, attachment: true, reasoningOptions: [{ type: 'effort', values: ['none', 'high'] }] },
  default: { context: 128_000, output: 16_384, attachment: false, reasoningOptions: [] },
};

function familyOf(id, familyHint) {
  if (familyHint) {
    const f = String(familyHint).toLowerCase();
    for (const key of Object.keys(FAMILY_DEFAULTS)) {
      if (f.startsWith(key)) return key;
    }
  }
  const s = id.toLowerCase();
  const order = [
    'claude',
    'gpt',
    'grok',
    'gemini',
    'glm',
    'kimi',
    'qwen',
    'minimax',
    'mimo',
    'deepseek',
    'muse',
    'longcat',
    'step',
    'nemotron',
    'mistral',
    'hy',
  ];
  for (const key of order) {
    if (s.startsWith(key) || s.includes('-' + key)) return key;
  }
  if (s.startsWith('hy')) return 'hy';
  return 'default';
}

function prettifyId(id) {
  return id
    .split('-')
    .map((chunk) => {
      if (/^(gpt|glm|kimi|qwen|mimo|hy\d|k\d)/i.test(chunk)) return chunk.toUpperCase();
      if (/^\d/.test(chunk)) return chunk;
      return chunk.charAt(0).toUpperCase() + chunk.slice(1);
    })
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* Protocol selection                                                  */
/* ------------------------------------------------------------------ */

const PROTOCOL_ENDPOINTS = {
  'openai-chat': '/openai/v1/chat/completions',
  'openai-responses': '/openai/v1/responses',
  anthropic: '/anthropic/v1/messages',
  google: '/google/v1beta/models/{model}',
};

// Explicit choices where more than one wire protocol works: picking the one that
// exposes reasoning best (Anthropic returns `thinking` blocks, Responses returns
// reasoning summaries) keeps the "thinking mode" UI meaningful.
const PROTOCOL_OVERRIDES = {
  'minimax-m3': ['anthropic', 'openai-chat'],
  'minimax-m2.7': ['anthropic', 'openai-chat'],
  'minimax-m2.5': ['anthropic', 'openai-chat'],
  'minimax-m3.1-flash': ['anthropic', 'openai-chat'],
  'kimi-k3': ['anthropic', 'openai-chat'],
  'kimi-k3.1-pro': ['anthropic', 'openai-chat'],
};

function protocolsFor(id, docProtocol, verifiedProtocol, liveProtocols = []) {
  const set = new Set();
  const add = (p) => p && set.add(p);
  for (const p of PROTOCOL_OVERRIDES[id] ?? []) add(p);
  add(verifiedProtocol);
  add(docProtocol);
  for (const p of liveProtocols) add(p);
  if (id.startsWith('claude')) add('anthropic');
  if (id.startsWith('gemini')) add('google');
  if (id.startsWith('gpt') || id.startsWith('grok') || id.startsWith('muse')) add('openai-responses');
  const list = [...set];
  // Prefer the verified/protocol-override order, then documentation order.
  return list;
}

/* ------------------------------------------------------------------ */
/* Model assembly                                                      */
/* ------------------------------------------------------------------ */

/** Normalizes MIME-style live modalities to the catalog's short labels. */
function canonicalModality(value) {
  if (typeof value !== 'string') return null;
  if (value === 'text') return 'text';
  if (value === 'application/pdf') return 'pdf';
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  return value;
}

/**
 * Converts a live `/v1/models` entry to the metadata shape used by buildModel.
 * models.dev entries are merged on top, so live data only fills gaps (models
 * released today often exist in the API before models.dev indexes them).
 */
function liveMetadata(entry) {
  if (!entry) return {};
  const raw = entry.raw;
  const input = Array.isArray(raw.modalities?.input) ? raw.modalities.input : [];
  const output = Array.isArray(raw.modalities?.output) ? raw.modalities.output : [];
  const textCost = raw.cost?.text;
  const cost =
    typeof textCost?.input?.price === 'number' && typeof textCost.output?.price === 'number'
      ? {
          input: textCost.input.price,
          output: textCost.output.price,
          cache_read: textCost.input.cache?.read?.price,
          cache_write: textCost.input.cache?.write?.price,
        }
      : null;
  return {
    name: raw.name,
    description: raw.description,
    family: raw.family,
    reasoning: raw.capabilities?.reasoning?.supported,
    modalities: {
      input: [...new Set(input.map(canonicalModality).filter(Boolean))],
      output: [...new Set(output.map(canonicalModality).filter(Boolean))],
    },
    attachment: input.some((value) => /^(image|video)\//.test(value) || value === 'application/pdf'),
    limit: { context: raw.limit?.context, output: raw.limit?.output },
    cost,
    release_date: raw.release_date,
    knowledge: raw.knowledge,
    open_weights: raw.open_weights,
  };
}

function buildModel(id, { docsEntry, verified, md, providerKind, liveProtocols = [], fallbackProtocols = [], previousName }) {
  const family = familyOf(id, md?.family);
  const defaults = FAMILY_DEFAULTS[family] ?? FAMILY_DEFAULTS.default;

  const protocols = protocolsFor(id, docsEntry?.protocol, verified?.detected, liveProtocols);
  // A known-unavailable model may leave the docs table; keep its last known
  // protocol so the catalog does not lose that metadata while it is retained.
  if (!protocols.length && fallbackProtocols.length) protocols.push(...fallbackProtocols);
  const reasoningOptions = md?.reasoning_options ?? defaults.reasoningOptions;
  const attachment = md?.attachment ?? defaults.attachment;
  const modalities =
    md?.modalities ??
    {
      input: attachment ? ['text', 'image'] : ['text'],
      output: ['text'],
    };

  const tags = [];
  if (id.includes('free')) tags.push('free');
  if (family === 'glm' || family === 'deepseek' || family === 'qwen' || family === 'kimi' || family === 'mimo') tags.push('open-weights');
  if (/flash|luna|nano|mini|lightning/i.test(id)) tags.push('fast');
  if (reasoningOptions.length) tags.push('reasoning');
  if (attachment) tags.push('vision');

  let status = 'stable';
  if (id.includes('free')) status = 'free';
  else if (/preview|contributor|alpha|experimental/.test(id)) status = 'beta';
  if (providerKind === 'go' && verified && !verified.detected) status = 'unavailable';

  return {
    id,
    name: docsEntry?.name ?? previousName ?? md?.name ?? prettifyId(id),
    family,
    protocols,
    reasoning: md?.reasoning ?? reasoningOptions.length > 0,
    reasoningOptions,
    attachment,
    modalities,
    contextWindow: md?.limit?.context ?? defaults.context,
    maxOutput: md?.limit?.output ?? defaults.output,
    cost: md?.cost ?? null,
    releaseDate: md?.release_date ?? null,
    knowledge: md?.knowledge ?? null,
    openWeights: md?.open_weights ?? false,
    description: md?.description ?? null,
    tags,
    status,
  };
}

/**
 * Prompt-cache capabilities defaults per provider kind (docs/goals/prompt-cache).
 * `minTokens: null` means unknown -> the request is excluded from the hit-rate
 * target until `scripts/probe-cache.mjs` fills the measured value.
 */
function cacheDefaults(kind) {
  if (kind === 'go' || kind === 'zen') {
    return {
      // Probe F4.0 (29/10): o gateway aceita cache_control no protocolo anthropic
      // (Claude Haiku 5.5: write 1h=2127, read=2127 na 2ª chamada) e reporta
      // usage.opencode.tokens.*. Mínimo conservador; modelos live ajustam.
      mode: 'explicit',
      minTokens: 2048,
      blockTokens: null,
      ttlOptions: ['1h'],
      supportsKey: true,
      supportsRetention: false,
      supportsExplicitBreakpoints: true,
      reportsRead: true,
      reportsWrite: true,
      source: 'probe',
    };
  }
  if (kind === 'openai') {
    return {
      mode: 'auto',
      minTokens: 1024,
      blockTokens: 128,
      ttlOptions: ['in_memory', '24h'],
      supportsKey: true,
      supportsRetention: true,
      supportsExplicitBreakpoints: true,
      reportsRead: true,
      reportsWrite: true,
      source: 'family-default',
    };
  }
  if (kind === 'anthropic') {
    return {
      mode: 'explicit',
      minTokens: null,
      blockTokens: null,
      ttlOptions: ['5m', '1h'],
      supportsKey: false,
      supportsRetention: false,
      supportsExplicitBreakpoints: true,
      reportsRead: true,
      reportsWrite: true,
      source: 'family-default',
    };
  }
  return undefined;
}

function buildProvider({ id, name, shortName, description, baseUrl, defaultModelId, docsById, mdSource, liveById = {}, kind, notes, keepModels = [] }) {
  // Docs rows without an endpoint (the new pricing tables) are not proof of a
  // chat route: only the live list or a protocol probe can establish one.
  const ids = new Set(Object.keys(liveById));
  for (const [modelId, entry] of Object.entries(docsById)) {
    if (entry.protocol || liveById[modelId] || verifiedById[modelId]) ids.add(modelId);
  }
  if (kind === 'go') for (const id of Object.keys(verifiedById)) ids.add(id);
  const keepById = byId(keepModels);
  const models = [...ids].map((modelId) =>
    buildModel(modelId, {
      docsEntry: docsById[modelId],
      verified: verifiedById[modelId],
      md: { ...liveMetadata(liveById[modelId]), ...mdSource[modelId] },
      providerKind: kind,
      liveProtocols: liveById[modelId]?.protocols,
      fallbackProtocols: keepById[modelId]?.protocols,
      previousName: keepById[modelId]?.name,
    }),
  );
  // Keep entries that were already bundled but are absent from this build's
  // sources: docs tables rotate models and protocol probes are local-only, so a
  // build must not silently drop a gateway model that still works.
  for (const model of keepModels) {
    if (!ids.has(model.id)) {
      ids.add(model.id);
      models.push(model);
    }
  }
  models.sort((a, b) => {
    // keep models.dev order-ish: by family then name
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    return a.name.localeCompare(b.name);
  });

  return {
    id,
    name,
    shortName,
    description,
    baseUrl,
    consoleUrl: 'https://opencode.ai/console',
    endpoints: PROTOCOL_ENDPOINTS,
    authEnv: 'OPENCODE_API_KEY',
    defaultModelId,
    models,
    notes: notes ?? [],
    cache: cacheDefaults(kind),
  };
}

/* ------------------------------------------------------------------ */
/* API-key providers (one wire protocol, models.dev seeds)             */
/* ------------------------------------------------------------------ */

// Model ids that are not text-chat endpoints of an OpenAI-compatible API:
// embeddings, media generation, rerankers and hosted tools use other routes.
const CHAT_EXCLUDED =
  /(embed|rerank|moderation|tts|audio|whisper|transcri|speech|image|imagen|dall-e|sora|flux|stable-diffusion|realtime|computer[-_]use|search[-_]preview|guard)/i;

/**
 * models.dev rows of a seed worth bundling: text output, chat-capable, newest
 * first and capped — the account list (`GET /models`) adds the rest at runtime.
 */
function chatModelEntries(spec) {
  const bucket = modelsDev[spec.mdProviderId]?.models ?? {};
  const entries = Object.entries(bucket).filter(([id, md]) => {
    if (CHAT_EXCLUDED.test(id)) return false;
    const output = md?.modalities?.output ?? ['text'];
    return output.includes('text');
  });
  entries.sort(([aId, a], [bId, b]) => {
    const aDate = a?.release_date ?? '';
    const bDate = b?.release_date ?? '';
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    return aId.localeCompare(bId);
  });
  return entries.slice(0, spec.modelCap ?? DEFAULT_MODEL_CAP);
}

/**
 * models.dev reports `-1` on budget-only reasoners to mean "no minimum/maximum";
 * the Rust catalog stores these as `u32`, so an impossible value is dropped and
 * the UI falls back to its documented default.
 */
function sanitizeReasoningOptions(options) {
  return (options ?? []).map((option) => {
    if (option?.type !== 'budget_tokens') return option;
    const next = { ...option };
    if (typeof next.min !== 'number' || next.min < 0) delete next.min;
    if (typeof next.max !== 'number' || next.max < 0) delete next.max;
    return next;
  });
}

/**
 * Builds a provider entry from a seed (`scripts/provider-seeds.mjs`): every model
 * speaks the seed's single wire protocol, the default model is the newest priced
 * stable row, and the endpoints pair the chat path with the `/models` probe used
 * by "Test connection" and the account refresh.
 */
function buildApiKeyProvider(spec) {
  const entries = chatModelEntries(spec);
  const models = entries.map(([id, md]) => {
    const model = buildModel(id, { md });
    return {
      ...model,
      reasoningOptions: sanitizeReasoningOptions(model.reasoningOptions),
      protocols: [spec.protocol],
    };
  });
  if (!models.length) {
    console.warn(`[catalog] ${spec.id}: nenhum modelo em models.dev (${spec.mdProviderId})`);
  }

  const ids = new Set(models.map((model) => model.id));
  const preferred = models.find((model) => model.cost && model.status === 'stable');
  const defaultModelId =
    spec.defaultModel && ids.has(spec.defaultModel)
      ? spec.defaultModel
      : (preferred?.id ?? models[0]?.id ?? '');

  models.sort((a, b) => {
    if (a.family !== b.family) return a.family.localeCompare(b.family);
    return a.name.localeCompare(b.name);
  });

  return {
    id: spec.id,
    name: spec.name,
    shortName: spec.shortName,
    description: spec.description,
    baseUrl: spec.baseUrl,
    consoleUrl: spec.consoleUrl,
    endpoints: endpointsFor(spec),
    authEnv: spec.authEnv,
    defaultModelId,
    models,
    category: spec.category,
    notes: [],
    // Prompt-cache behavior is unknown until probed (`scripts/probe-cache.mjs`);
    // `null` keeps the request free of unsupported cache directives.
    cache: null,
  };
}

/* ------------------------------------------------------------------ */
/* OpenAI (ChatGPT plan usage — Sign in with ChatGPT)                  */
/* ------------------------------------------------------------------ */

const OPENAI_ENDPOINTS = {
  'openai-responses': '/responses',
  models: '/models',
};

const OPENAI_OAUTH = {
  issuer: 'https://auth.openai.com',
  discoveryUrl: 'https://auth.openai.com/.well-known/openid-configuration',
  registrationClientId: 'dynamic_agent_client',
  agentNameHint: 'Zylara',
  resource: 'https://api.openai.com/v1',
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'resource.invoke',
    'chatgpt.tokens.use.direct',
  ],
  planUsageScope: 'chatgpt.tokens.use.direct',
  callbackPath: '/auth/callback',
  loopbackHost: '127.0.0.1',
};

const OPENAI_DOCS = [
  'https://developers.openai.com/siwc/token-sharing-open-source/',
  'https://developers.openai.com/siwc/token-sharing-open-source/sign-in',
  'https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference',
];

// Models that are not chat/completion endpoints of the Responses API (or that
// exist only for hosted tools) are not selectable in the chat UI.
const OPENAI_EXCLUDED = /(image|imagen|dall-e|embedding|realtime|transcribe|tts|audio|moderation|whisper|computer[-_]use|deep[-_]research|search[-_]preview|sora|babbage|davinci|daybreak)/i;
// The bundled seed stays on current chat families; the live `/v1/models` list
// (fetched after sign-in) is authoritative for the account.
const OPENAI_SEED_FAMILIES = /^(gpt-5(\.\d+)?(-|$)|gpt-6(\.\d+)?(-|$)|o3(-|$)|o4-mini(-|$))/i;

function buildOpenAiProvider() {
  const models = Object.entries(mdOpenai)
    .filter(([id, md]) => {
      if (OPENAI_EXCLUDED.test(id)) return false;
      if (!OPENAI_SEED_FAMILIES.test(id)) return false;
      const output = md?.modalities?.output ?? ['text'];
      if (!output.includes('text')) return false;
      return true;
    })
    .map(([id, md]) => {
      const model = buildModel(id, { md, providerKind: 'openai' });
      // The app's icon resolver and grouping only know the "gpt" family
      // (models.dev exposes gpt-sol/gpt-luna/gpt-astra/...).
      return {
        ...model,
        family: 'gpt',
        protocols: ['openai-responses'],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const ids = new Set(models.map((model) => model.id));
  const defaultModelId = ids.has('gpt-6.1-sol')
    ? 'gpt-6.1-sol'
    : (ids.has('gpt-6-astra') ? 'gpt-6-astra' : (models[0]?.id ?? ''));

  return {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    shortName: 'ChatGPT',
    description:
      'Modelos OpenAI usando o plano ChatGPT da sua conta (Sign in with ChatGPT) ou uma API key da plataforma.',
    baseUrl: 'https://api.openai.com/v1',
    consoleUrl: 'https://chatgpt.com/settings/usage',
    endpoints: OPENAI_ENDPOINTS,
    auth: 'oauth',
    requestProfiles: { oauth: 'chatgpt-plan', apiKey: 'standard' },
    authEnv: 'OPENAI_API_KEY',
    defaultModelId,
    oauth: OPENAI_OAUTH,
    models,
    cache: cacheDefaults('openai'),
    notes: [
      'O uso consome o limite do seu plano ChatGPT (o mesmo pool compartilhado por apps, Codex e ChatGPT Work).',
      'Contas Plus têm a janela de 5 h compartilhada; Pro não tem esse limite. Limites específicos deste app também podem valer.',
      'A lista de modelos é específica da conta: use "Atualizar modelos" após entrar.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic (API oficial, API key)                                    */
/* ------------------------------------------------------------------ */

const ANTHROPIC_ENDPOINTS = {
  anthropic: '/messages',
  models: '/models',
};

/**
 * `anthropic-version` é obrigatório em toda requisição da API oficial. O valor é
 * o mais recente do histórico documentado (platform.claude.com/docs/en/api/versioning)
 * e fica no catálogo para poder ser atualizado sem recompilar o código.
 */
const ANTHROPIC_HEADERS = {
  'anthropic-version': '2026-10-21',
};

const ANTHROPIC_DOCS = [
  'https://platform.claude.com/docs/en/api/overview',
  'https://platform.claude.com/docs/en/api/messages/create',
  'https://platform.claude.com/docs/en/api/models/list',
  'https://platform.claude.com/docs/en/api/versioning',
];

// Só a linha Claude: nada de modelos de imagem/embedding do mesmo fornecedor.
const ANTHROPIC_SEED = /^claude-(opus|sonnet|haiku|fable|mythos)-/;
// A partir da geração 4.6 os IDs são dateless; snapshots com data ficam para a
// lista viva da conta (`GET /v1/models`), não para o seed embutido.
const ANTHROPIC_DATED_SNAPSHOT = /-\d{8}$/;

function buildAnthropicProvider() {
  const models = Object.entries(mdAnthropic)
    .filter(([id, md]) => {
      if (!ANTHROPIC_SEED.test(id)) return false;
      if (ANTHROPIC_DATED_SNAPSHOT.test(id)) return false;
      const output = md?.modalities?.output ?? ['text'];
      return output.includes('text');
    })
    .map(([id, md]) => {
      const model = buildModel(id, { md, providerKind: 'anthropic' });
      return {
        ...model,
        // O resolvedor de ícone/agrupamento do app só conhece a família "claude".
        family: 'claude',
        protocols: ['anthropic'],
        // models.dev marca os aliases como "(latest)"; o nome exibido não precisa.
        name: model.name.replace(/\s*\(latest\)$/i, ''),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const ids = new Set(models.map((model) => model.id));
  const defaultModelId = ids.has('claude-sonnet-5-5')
    ? 'claude-sonnet-5-5'
    : (models[0]?.id ?? '');

  return {
    id: 'anthropic',
    name: 'Anthropic',
    shortName: 'Anthropic',
    description:
      'Modelos Claude pela API oficial da Anthropic — cobrança por token na sua conta (pay-as-you-go).',
    baseUrl: 'https://api.anthropic.com/v1',
    consoleUrl: 'https://platform.claude.com/settings/keys',
    endpoints: ANTHROPIC_ENDPOINTS,
    headers: ANTHROPIC_HEADERS,
    authEnv: 'ANTHROPIC_API_KEY',
    defaultModelId,
    models,
    cache: cacheDefaults('anthropic'),
    notes: [
      'Cobrança por token na sua conta Anthropic (pay-as-you-go) — este provedor não usa assinatura/plano.',
      'Crie ou revise a API key em https://platform.claude.com/settings/keys.',
      'A lista da conta é buscada em GET /v1/models; use "Atualizar modelos" para mesclar novidades.',
      'Versão da API fixada em anthropic-version: 2026-10-21 (sem headers beta).',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Google Gemini (Gemini Developer API, API key)                       */
/* ------------------------------------------------------------------ */

const GEMINI_ENDPOINTS = {
  google: '/models/{model}',
  models: '/models',
};

const GEMINI_DOCS = [
  'https://ai.google.dev/gemini-api/docs/models',
  'https://ai.google.dev/api/models',
  'https://ai.google.dev/api/generate-content',
];

// The provider exposes only the requested text-output families. Media, Live,
// TTS, embeddings and agent models use different APIs and are filtered out.
const GEMINI_SEED = ['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash'];

// Official model pages: 65,536 tokens for a single streaming request.
const GEMINI_MAX_OUTPUT = {
  'gemini-4-carbon': 65_536,
  'gemini-4-argon': 65_536,
  'gemini-3.8-flash': 65_536,
};

function buildGeminiProvider() {
  const models = GEMINI_SEED.map((id) => {
    const md = mdGoogle[id];
    const model = buildModel(id, md ? { md, providerKind: 'gemini' } : { providerKind: 'gemini' });
    return {
      ...model,
      // The picker/icon resolver knows only the "gemini" family.
      family: 'gemini',
      protocols: ['google'],
      maxOutput: GEMINI_MAX_OUTPUT[id] ?? model.maxOutput,
    };
  });

  const ids = new Set(models.map((model) => model.id));
  const defaultModelId = ids.has('gemini-4-argon')
    ? 'gemini-4-argon'
    : (ids.has('gemini-3.8-flash') ? 'gemini-3.8-flash' : (models[0]?.id ?? ''));

  return {
    id: 'gemini',
    name: 'Google Gemini',
    shortName: 'Gemini',
    description:
      'Modelos Gemini pela API oficial do Google — cobrança por token na sua conta (Gemini Developer API).',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    consoleUrl: 'https://aistudio.google.com/apikey',
    endpoints: GEMINI_ENDPOINTS,
    authHeader: 'x-goog-api-key',
    authPrefix: '',
    authEnv: 'GEMINI_API_KEY',
    defaultModelId,
    models,
    cache: {
      mode: 'auto',
      minTokens: 4096,
      blockTokens: null,
      ttlOptions: [],
      supportsKey: false,
      supportsRetention: false,
      supportsExplicitBreakpoints: false,
      reportsRead: true,
      reportsWrite: false,
      source: 'docs',
    },
    notes: [
      'Cobrança por token na sua conta Google (Gemini Developer API).',
      'Crie ou revise a API key em https://aistudio.google.com/apikey.',
      'A lista da conta é buscada em GET /v1beta/models e limitada a Gemini 4 Carbon, Gemini 4 Argon e Gemini 3.8 Flash.',
      'Thinking low/medium/high com resumos; long decode acima de 65.536 tokens não é suportado.',
    ],
  };
}

const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  sources: {
    docs: [
      'https://opencode.ai/v2/docs/console/go/',
      'https://opencode.ai/v2/docs/console/models/',
      ...OPENAI_DOCS,
      ...ANTHROPIC_DOCS,
      ...GEMINI_DOCS,
    ],
    models: 'https://models.dev/api.json',
    live: Object.fromEntries(LIVE_MODEL_SOURCES.map((source) => [source.provider, source.url])),
    probe: 'scripts/probe-models.mjs',
    // Provenance of the API-key providers: their public API docs.
    providers: Object.fromEntries(EXTRA_PROVIDERS.map((spec) => [spec.id, spec.docsUrl])),
  },
  providers: [
    buildProvider({
      id: 'opencode-go',
      name: 'OpenCode Go',
      shortName: 'Go',
      description: 'Assinatura OpenCode Go — modelos abertos de alta performance com limites mensais.',
      baseUrl: 'https://opencode.ai/inference/go',
      defaultModelId: 'deepseek-v4.1-flash',
      docsById: docsGoById,
      mdSource: { ...mdGo, ...mdOpencode },
      liveById: liveGoById,
      kind: 'go',
      keepModels: previousGoModels,
      notes: [
        'Envie o header x-opencode-session para melhor roteamento e prompt caching.',
        'Modelos marcados como "contributor" podem usar seus dados para treino.',
      ],
    }),
    buildProvider({
      id: 'opencode-zen',
      name: 'OpenCode Zen',
      shortName: 'Zen',
      description: 'OpenCode Console (pay-as-you-go) — catálogo curado de modelos de vários provedores.',
      baseUrl: 'https://opencode.ai/inference',
      defaultModelId: 'gpt-6-luna',
      docsById: docsZenById,
      mdSource: mdOpencode,
      liveById: liveZenById,
      kind: 'zen',
      keepModels: previousZenModels,
      notes: ['Funciona com créditos do OpenCode Console.', 'Modelos gratuitos exigem o cliente OpenCode.'],
    }),
    buildOpenAiProvider(),
    buildAnthropicProvider(),
    buildGeminiProvider(),
    // API-key providers surfaced under "See more providers" (Settings → Providers).
    ...EXTRA_PROVIDERS.map(buildApiKeyProvider),
  ],
};

const seedErrors = validateProviderSeeds();
if (seedErrors.length) {
  throw new Error(`provider-seeds inválidos:\n  ${seedErrors.join('\n  ')}`);
}

fs.mkdirSync(outDir, { recursive: true });

// `--provider <id>` updates only that provider while leaving the others
// byte-identical (the catalog tasks require a surgical diff). Unknown ids fall
// back to the full rebuild below.
const SURGICAL_PROVIDERS = {
  openai: { build: buildOpenAiProvider, docs: OPENAI_DOCS },
  anthropic: { build: buildAnthropicProvider, docs: ANTHROPIC_DOCS },
  gemini: { build: buildGeminiProvider, docs: GEMINI_DOCS },
  ...Object.fromEntries(
    EXTRA_PROVIDERS.map((spec) => [
      spec.id,
      { build: () => buildApiKeyProvider(spec), docs: [spec.docsUrl] },
    ]),
  ),
};

const providerFlagIndex = process.argv.indexOf('--provider');
const onlyProvider = providerFlagIndex >= 0 ? process.argv[providerFlagIndex + 1] : null;

let output = catalog;
const surgical = onlyProvider ? SURGICAL_PROVIDERS[onlyProvider] : null;
if (surgical) {
  const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const provider = surgical.build();
  output = {
    ...existing,
    generatedAt: new Date().toISOString(),
    sources: {
      ...existing.sources,
      docs: [...new Set([...(existing.sources?.docs ?? []), ...surgical.docs])],
    },
    providers: [...existing.providers.filter((item) => item.id !== provider.id), provider],
  };
}

// Do not rewrite the tracked file when only `generatedAt` would change: builds
// run this script automatically, and a timestamp-only diff would dirty the
// working tree on every build.
function withoutTimestamp(value) {
  const { generatedAt, ...rest } = value;
  return JSON.stringify(rest);
}

let unchanged = false;
try {
  unchanged = withoutTimestamp(JSON.parse(fs.readFileSync(outFile, 'utf8'))) === withoutTimestamp(output);
} catch {
  unchanged = false;
}

if (unchanged) {
  console.log('catalog unchanged; keeping generatedAt');
} else {
  const tmp = `${outFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(output, null, 1));
  fs.renameSync(tmp, outFile);
  console.log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KiB)`);
}

// The catalog is bundled twice (renderer import + `include_str!` in Rust), so
// keep an eye on its size: cap the per-provider seeds instead of shipping more.
const catalogKiB = fs.statSync(outFile).size / 1024;
if (catalogKiB > 512) {
  console.warn(
    `[catalog] aviso: ${catalogKiB.toFixed(1)} KiB (acima de 512 KiB) — reduza o modelCap dos seeds.`,
  );
}

for (const p of output.providers) {
  const byProtocol = p.models.reduce((acc, m) => {
    const key = m.protocols[0] ?? 'none';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`${p.id}: ${p.models.length} models, primary protocols=${JSON.stringify(byProtocol)}`);
  const missing = p.models.filter((m) => m.reasoningOptions.length === 0).length;
  console.log(`  reasoning-control: ${p.models.length - missing}, no-reasoning: ${missing}`);
  const noMeta = p.models.filter((m) => !m.cost).length;
  console.log(`  without pricing metadata: ${noMeta}`);
}
