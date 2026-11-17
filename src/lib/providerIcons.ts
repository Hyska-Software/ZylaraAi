/**
 * Provider brand glyphs — provider id → LobeHub icon resolution (pure, no
 * JSX/assets).
 *
 * Icon set: {@link https://icons.lobehub.com} (`@lobehub/icons-static-svg`,
 * MIT) — the same package already used for the model avatars
 * (`src/lib/modelIcons.ts`). The SVGs are mono (`fill="currentColor"`), so the
 * settings list tints them with the design tokens in both themes.
 *
 * This map is keyed by *provider id* (not model family): OpenCode Go and Zen
 * share the OpenCode mark, and the OpenAI/Anthropic/Gemini providers use the
 * vendor mark of the API they expose.
 */

/** Mono LobeHub marks bundled for the provider list (`?raw` SVGs). */
export type ProviderIconKey =
  | 'opencode'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'cerebras'
  | 'deepseek'
  | 'fireworks'
  | 'groq'
  | 'inception'
  | 'minimax'
  | 'mistral'
  | 'moonshot'
  | 'novita'
  | 'nvidia'
  | 'openrouter'
  | 'siliconcloud'
  | 'stepfun'
  | 'together'
  | 'venice'
  | 'vercel'
  | 'xai'
  | 'zhipu';

/** Human label of each bundled mark (tooltips, tests). */
export const PROVIDER_ICON_LABELS: Readonly<Record<ProviderIconKey, string>> = {
  opencode: 'OpenCode',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  groq: 'Groq',
  inception: 'Inception',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  moonshot: 'Moonshot AI',
  novita: 'Novita AI',
  nvidia: 'NVIDIA',
  openrouter: 'OpenRouter',
  siliconcloud: 'SiliconCloud',
  stepfun: 'StepFun',
  together: 'Together AI',
  venice: 'Venice AI',
  vercel: 'Vercel',
  xai: 'xAI',
  zhipu: 'Z.AI',
};

/** All bundled mark keys, in stable (declaration) order. */
export const PROVIDER_ICON_KEYS = Object.keys(PROVIDER_ICON_LABELS) as ProviderIconKey[];

/**
 * Provider id → bundled mark. Aliases cover the vendor names the catalog (or a
 * future provider entry) may use instead of the provider id itself.
 */
const PROVIDER_TO_ICON: Readonly<Record<string, ProviderIconKey>> = {
  'opencode-go': 'opencode',
  'opencode-zen': 'opencode',
  opencode: 'opencode',
  openai: 'openai',
  chatgpt: 'openai',
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  cerebras: 'cerebras',
  deepseek: 'deepseek',
  fireworks: 'fireworks',
  'fireworks-ai': 'fireworks',
  groq: 'groq',
  inception: 'inception',
  'inception-labs': 'inception',
  minimax: 'minimax',
  mistral: 'mistral',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  kimi: 'moonshot',
  novita: 'novita',
  'novita-ai': 'novita',
  nvidia: 'nvidia',
  'nvidia-nim': 'nvidia',
  openrouter: 'openrouter',
  siliconflow: 'siliconcloud',
  siliconcloud: 'siliconcloud',
  stepfun: 'stepfun',
  together: 'together',
  togetherai: 'together',
  venice: 'venice',
  vercel: 'vercel',
  'vercel-ai-gateway': 'vercel',
  'ai-gateway': 'vercel',
  xai: 'xai',
  grok: 'xai',
  zai: 'zhipu',
  'z-ai': 'zhipu',
  zhipu: 'zhipu',
  zhipuai: 'zhipu',
  glm: 'zhipu',
};

/** Normalizes a provider id for lookup: trim, lowercase, `_`/spaces → `-`. */
export function normalizeProviderId(providerId?: string | null): string {
  return (providerId ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * Resolves a provider id (or vendor alias) to a bundled LobeHub mark.
 * Returns `null` when the collection has no mark for it — the UI then falls
 * back to the provider initials.
 */
export function providerIconFor(providerId?: string | null): ProviderIconKey | null {
  const key = normalizeProviderId(providerId);
  if (!key) return null;
  // Own-property guard: a bare index would resolve Object.prototype keys
  // (`constructor`, `toString`, …) and leak a non-`ProviderIconKey` value.
  return Object.hasOwn(PROVIDER_TO_ICON, key) ? (PROVIDER_TO_ICON[key] ?? null) : null;
}

/** Label of the resolved mark (or `null` when the provider falls back). */
export function providerIconLabel(providerId?: string | null): string | null {
  const icon = providerIconFor(providerId);
  return icon ? PROVIDER_ICON_LABELS[icon] : null;
}
