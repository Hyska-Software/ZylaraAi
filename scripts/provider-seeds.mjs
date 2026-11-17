/**
 * Declarative seeds for the API-key providers added to the bundled catalog.
 *
 * Every entry speaks a wire protocol the app already implements
 * (`src-tauri/src/providers/mod.rs` → `WireProtocol`) and authenticates with a
 * static bearer key, so adding one is catalog data only: `baseUrl` + `endpoints`
 * + `authEnv` + the models generated from models.dev.
 *
 * `scripts/build-catalog.mjs` turns each seed into a `ProviderInfo` entry.
 * Sources for the URL/env pairs: the provider docs and the reference catalog in
 * `H:\oh-my-pi` (`packages/catalog/src/compat/rules/providers/*.kdl` and
 * `packages/catalog/src/provider-models/openai-compat.ts`).
 *
 * Keep this table free of build side effects: `scripts/__tests__/provider-seeds.test.mjs`
 * imports it directly.
 */

/** Groups of the "See more providers" dialog, in display order. */
export const PROVIDER_CATEGORIES = ['lab', 'aggregator', 'host'];

/** Wire protocol used by every seed below. */
const CHAT = 'openai-chat';

/** Default cap on bundled models per provider (account lists add the rest). */
export const DEFAULT_MODEL_CAP = 20;

/**
 * @typedef {object} ProviderSeed
 * @property {string} id                     Catalog/provider id (`[a-z0-9-]`).
 * @property {string} name                   Display name.
 * @property {string} shortName              Compact label used in the picker.
 * @property {string} description            English product copy (UI localizes it).
 * @property {string} baseUrl                API root; `endpoints` are paths under it.
 * @property {string} consoleUrl             Where the user creates the API key.
 * @property {string} docsUrl                Public API docs (catalog provenance).
 * @property {string} protocol               Wire protocol id implemented in Rust.
 * @property {string} authEnv                Environment variable holding the key.
 * @property {string} mdProviderId           models.dev bucket with the model rows.
 * @property {string} category               One of {@link PROVIDER_CATEGORIES}.
 * @property {string} [defaultModel]         Preferred default id (falls back to the first).
 */

/** @type {readonly ProviderSeed[]} */
export const EXTRA_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'DeepSeek',
    description: 'DeepSeek direct API — reasoning and chat models with a long context window.',
    baseUrl: 'https://api.deepseek.com',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com',
    protocol: CHAT,
    authEnv: 'DEEPSEEK_API_KEY',
    mdProviderId: 'deepseek',
    category: 'lab',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    shortName: 'xAI',
    description: 'Grok models from the xAI API.',
    baseUrl: 'https://api.x.ai/v1',
    consoleUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai/docs/models',
    protocol: CHAT,
    authEnv: 'XAI_API_KEY',
    mdProviderId: 'xai',
    category: 'lab',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    shortName: 'Mistral',
    description: 'Mistral AI models, including the Devstral coding line.',
    baseUrl: 'https://api.mistral.ai/v1',
    consoleUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api',
    protocol: CHAT,
    authEnv: 'MISTRAL_API_KEY',
    mdProviderId: 'mistral',
    category: 'lab',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    shortName: 'Moonshot',
    description: 'Kimi models from the Moonshot AI platform.',
    baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.moonshot.ai/console/api-keys',
    docsUrl: 'https://platform.moonshot.ai/docs/api/chat',
    protocol: CHAT,
    authEnv: 'MOONSHOT_API_KEY',
    mdProviderId: 'moonshotai',
    category: 'lab',
  },
  {
    id: 'zai',
    name: 'Z.AI (GLM)',
    shortName: 'Z.AI',
    description: 'GLM models from the Z.AI coding plan endpoint.',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/api-reference/introduction',
    protocol: CHAT,
    authEnv: 'ZAI_API_KEY',
    mdProviderId: 'zai',
    category: 'lab',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    shortName: 'MiniMax',
    description: 'MiniMax chat and reasoning models via the OpenAI-compatible endpoint.',
    baseUrl: 'https://api.minimax.io/v1',
    consoleUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    protocol: CHAT,
    authEnv: 'MINIMAX_API_KEY',
    mdProviderId: 'minimax',
    category: 'lab',
  },
  {
    id: 'inception',
    name: 'Inception (Mercury)',
    shortName: 'Inception',
    description: 'Mercury diffusion models from Inception Labs.',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    consoleUrl: 'https://platform.inceptionlabs.ai/dashboard/api-keys',
    docsUrl: 'https://docs.inceptionlabs.ai',
    protocol: CHAT,
    authEnv: 'INCEPTION_API_KEY',
    mdProviderId: 'inception',
    category: 'lab',
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    shortName: 'StepFun',
    description: 'Step models from the StepFun platform.',
    baseUrl: 'https://api.stepfun.ai/v1',
    consoleUrl: 'https://platform.stepfun.ai/interface-key',
    docsUrl: 'https://platform.stepfun.ai/docs/api-reference',
    protocol: CHAT,
    authEnv: 'STEPFUN_API_KEY',
    mdProviderId: 'stepfun',
    category: 'lab',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    shortName: 'OpenRouter',
    description: 'Aggregated catalog of models from many providers behind one API key.',
    baseUrl: 'https://openrouter.ai/api/v1',
    consoleUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
    protocol: CHAT,
    authEnv: 'OPENROUTER_API_KEY',
    mdProviderId: 'openrouter',
    category: 'aggregator',
  },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    shortName: 'AI Gateway',
    description: 'Vercel gateway that routes one API key across many model providers.',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    consoleUrl: 'https://vercel.com/dashboard/ai-gateway',
    docsUrl: 'https://vercel.com/docs/ai-gateway',
    protocol: CHAT,
    authEnv: 'AI_GATEWAY_API_KEY',
    mdProviderId: 'vercel',
    category: 'aggregator',
  },
  {
    id: 'groq',
    name: 'Groq',
    shortName: 'Groq',
    description: 'Low-latency inference for open-weight models.',
    baseUrl: 'https://api.groq.com/openai/v1',
    consoleUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/api-reference',
    protocol: CHAT,
    authEnv: 'GROQ_API_KEY',
    mdProviderId: 'groq',
    category: 'host',
  },
  {
    id: 'together',
    name: 'Together AI',
    shortName: 'Together',
    description: 'Hosted open-weight models with an OpenAI-compatible API.',
    baseUrl: 'https://api.together.xyz/v1',
    consoleUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai/reference/chat-completions',
    protocol: CHAT,
    authEnv: 'TOGETHER_API_KEY',
    mdProviderId: 'togetherai',
    category: 'host',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    shortName: 'Fireworks',
    description: 'Hosted open-weight models and coding models from Fireworks.',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    consoleUrl: 'https://fireworks.ai/api-keys',
    docsUrl: 'https://docs.fireworks.ai/api-reference/introduction',
    protocol: CHAT,
    authEnv: 'FIREWORKS_API_KEY',
    mdProviderId: 'fireworks-ai',
    category: 'host',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    shortName: 'Cerebras',
    description: 'Wafer-scale inference for open-weight models.',
    baseUrl: 'https://api.cerebras.ai/v1',
    consoleUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai/api-reference/chat-completions',
    protocol: CHAT,
    authEnv: 'CEREBRAS_API_KEY',
    mdProviderId: 'cerebras',
    category: 'host',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    shortName: 'NVIDIA',
    description: 'NVIDIA-hosted models through the NIM API.',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    consoleUrl: 'https://build.nvidia.com',
    docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
    protocol: CHAT,
    authEnv: 'NVIDIA_API_KEY',
    mdProviderId: 'nvidia',
    category: 'host',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    shortName: 'DeepInfra',
    description: 'Pay-per-token hosting for open-weight models.',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    consoleUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://deepinfra.com/docs/openai_api',
    protocol: CHAT,
    authEnv: 'DEEPINFRA_API_KEY',
    mdProviderId: 'deepinfra',
    category: 'host',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    shortName: 'SiliconFlow',
    description: 'Chinese open-weight hosting (DeepSeek, Qwen, GLM) with an OpenAI-compatible API.',
    baseUrl: 'https://api.siliconflow.com/v1',
    consoleUrl: 'https://cloud.siliconflow.com/account/ak',
    docsUrl: 'https://docs.siliconflow.com/en/api-reference/chat-completions',
    protocol: CHAT,
    authEnv: 'SILICONFLOW_API_KEY',
    mdProviderId: 'siliconflow',
    category: 'host',
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    shortName: 'SambaNova',
    description: 'Fast inference for open-weight models on SambaNova Cloud.',
    baseUrl: 'https://api.sambanova.ai/v1',
    consoleUrl: 'https://cloud.sambanova.ai/apis',
    docsUrl: 'https://docs.sambanova.ai/cloud/docs/get-started/overview',
    protocol: CHAT,
    authEnv: 'SAMBANOVA_API_KEY',
    mdProviderId: 'sambanova',
    category: 'host',
  },
  {
    id: 'scaleway',
    name: 'Scaleway',
    shortName: 'Scaleway',
    description: 'EU-hosted Generative APIs with an OpenAI-compatible endpoint.',
    baseUrl: 'https://api.scaleway.ai/v1',
    consoleUrl: 'https://console.scaleway.com/iam/api-keys',
    docsUrl: 'https://www.scaleway.com/en/docs/generative-apis/reference-content/',
    protocol: CHAT,
    authEnv: 'SCW_SECRET_KEY',
    mdProviderId: 'scaleway',
    category: 'host',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    shortName: 'Novita',
    description: 'Open-weight model hosting with an OpenAI-compatible API.',
    baseUrl: 'https://api.novita.ai/openai/v1',
    consoleUrl: 'https://novita.ai/settings/key-management',
    docsUrl: 'https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion',
    protocol: CHAT,
    authEnv: 'NOVITA_API_KEY',
    mdProviderId: 'novita-ai',
    category: 'host',
  },
  {
    id: 'venice',
    name: 'Venice AI',
    shortName: 'Venice',
    description: 'Privacy-focused inference for open-weight models.',
    baseUrl: 'https://api.venice.ai/api/v1',
    consoleUrl: 'https://venice.ai/settings/api',
    docsUrl: 'https://docs.venice.ai/api-reference/api-spec',
    protocol: CHAT,
    authEnv: 'VENICE_API_KEY',
    mdProviderId: 'venice',
    category: 'host',
  },
];

/** Wire protocols the Rust backend implements (`WireProtocol::parse`). */
const KNOWN_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic', 'google'];

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Structural validation of the seed table. Returns the list of problems, so the
 * unit test and any future check can fail loudly instead of shipping a provider
 * the backend cannot route.
 *
 * @param {readonly ProviderSeed[]} [seeds]
 * @returns {string[]} errors (empty when the table is valid)
 */
export function validateProviderSeeds(seeds = EXTRA_PROVIDERS) {
  const errors = [];
  const seen = new Set();
  for (const seed of seeds) {
    const id = seed.id;
    if (!ID_PATTERN.test(id)) errors.push(`${id}: id must be lowercase kebab-case`);
    if (seen.has(id)) errors.push(`${id}: duplicated id`);
    seen.add(id);
    for (const field of ['name', 'shortName', 'description', 'consoleUrl', 'docsUrl', 'authEnv', 'mdProviderId']) {
      if (typeof seed[field] !== 'string' || !seed[field].trim()) {
        errors.push(`${id}: missing ${field}`);
      }
    }
    if (!/^https:\/\/[^\s]+$/.test(seed.baseUrl)) errors.push(`${id}: baseUrl must be https`);
    if (seed.baseUrl.endsWith('/')) errors.push(`${id}: baseUrl must not end with "/"`);
    if (!KNOWN_PROTOCOLS.includes(seed.protocol)) errors.push(`${id}: unknown protocol ${seed.protocol}`);
    if (!ENV_PATTERN.test(seed.authEnv)) errors.push(`${id}: authEnv must be an env-var name`);
    if (!PROVIDER_CATEGORIES.includes(seed.category)) errors.push(`${id}: unknown category ${seed.category}`);
    if (seed.defaultModel !== undefined && !seed.defaultModel.trim()) {
      errors.push(`${id}: defaultModel must be omitted or non-empty`);
    }
  }
  return errors;
}

/**
 * Endpoint map (`ProviderInfo.endpoints`) of a seed: the chat path of its wire
 * protocol plus the model-list path probed by "Test connection" and used by the
 * account refresh (`src-tauri/src/commands/models.rs`).
 *
 * @param {ProviderSeed} seed
 * @returns {Record<string, string>}
 */
export function endpointsFor(seed) {
  /** @type {Record<string, string>} */
  const endpoints = { models: '/models' };
  if (seed.protocol === 'openai-chat') endpoints['openai-chat'] = '/chat/completions';
  else if (seed.protocol === 'openai-responses') endpoints['openai-responses'] = '/responses';
  else if (seed.protocol === 'anthropic') endpoints.anthropic = '/messages';
  else if (seed.protocol === 'google') endpoints.google = '/models/{model}';
  return endpoints;
}
