import { describe, expect, it } from 'vitest';
import { catalog } from '@/lib/catalog';
import { PROVIDER_ICON_SVG } from '@/lib/providerIconAssets';
import {
  normalizeProviderId,
  PROVIDER_ICON_KEYS,
  PROVIDER_ICON_LABELS,
  providerIconFor,
  providerIconLabel,
} from '@/lib/providerIcons';

/**
 * The expected mapping from every bundled catalog provider to the LobeHub mark.
 * This is the spec: OpenCode Go/Zen share the OpenCode mark; the direct API
 * providers use their vendor mark. `null` means the collection has no mark for
 * that vendor, so the settings list falls back to the provider initials
 * (SambaNova, Scaleway and DeepInfra are not in `@lobehub/icons-static-svg`).
 */
const EXPECTED_PROVIDER_ICONS: Readonly<Record<string, string | null>> = {
  'opencode-go': 'opencode',
  'opencode-zen': 'opencode',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  deepseek: 'deepseek',
  xai: 'xai',
  mistral: 'mistral',
  moonshot: 'moonshot',
  zai: 'zhipu',
  minimax: 'minimax',
  inception: 'inception',
  stepfun: 'stepfun',
  openrouter: 'openrouter',
  'vercel-ai-gateway': 'vercel',
  groq: 'groq',
  together: 'together',
  fireworks: 'fireworks',
  cerebras: 'cerebras',
  nvidia: 'nvidia',
  deepinfra: null,
  siliconflow: 'siliconcloud',
  sambanova: null,
  scaleway: null,
  novita: 'novita',
  venice: 'venice',
};

/** Vendor aliases accepted by the resolver. */
const EXPECTED_ALIASES: Readonly<Record<string, string>> = {
  opencode: 'opencode',
  chatgpt: 'openai',
  claude: 'anthropic',
  google: 'gemini',
  grok: 'xai',
  kimi: 'moonshot',
  glm: 'zhipu',
  zhipuai: 'zhipu',
  moonshotai: 'moonshot',
  'fireworks-ai': 'fireworks',
  togetherai: 'together',
  'novita-ai': 'novita',
  siliconflow: 'siliconcloud',
  'ai-gateway': 'vercel',
  'nvidia-nim': 'nvidia',
};

/** Official `<title>` shipped inside each mono SVG. */
const EXPECTED_SVG_TITLES: Readonly<Record<string, string>> = {
  opencode: 'opencode',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  groq: 'Groq',
  inception: 'Inception',
  minimax: 'Minimax',
  mistral: 'Mistral',
  moonshot: 'MoonshotAI',
  novita: 'Novita AI',
  nvidia: 'Nvidia',
  openrouter: 'OpenRouter',
  siliconcloud: 'SiliconCloud',
  stepfun: 'StepFun',
  together: 'together.ai',
  venice: 'Venice',
  vercel: 'Vercel',
  xai: 'Grok',
  zhipu: 'Zhipu',
};

describe('providerIconFor', () => {
  it('mapeia todo provedor do catálogo para a marca correta da LobeHub', () => {
    expect(catalog.providers.length).toBeGreaterThan(0);
    for (const provider of catalog.providers) {
      expect(providerIconFor(provider.id), provider.id).toBe(
        EXPECTED_PROVIDER_ICONS[provider.id] ?? null,
      );
    }
  });

  it('cobre os provedores de API key expostos em "Ver mais provedores"', () => {
    for (const [providerId, icon] of Object.entries(EXPECTED_PROVIDER_ICONS)) {
      expect(providerIconFor(providerId), providerId).toBe(icon);
    }
  });

  it('aceita os aliases de fornecedor', () => {
    for (const [alias, icon] of Object.entries(EXPECTED_ALIASES)) {
      expect(providerIconFor(alias), alias).toBe(icon);
    }
  });

  it('normaliza o id antes de resolver (trim, caixa e separadores)', () => {
    expect(providerIconFor('  OpenCode-Go ')).toBe('opencode');
    expect(providerIconFor('opencode_zen')).toBe('opencode');
    expect(providerIconFor('OpenAI')).toBe('openai');
    // Internal whitespace becomes `-`, so a two-word vendor name is not a hit.
    expect(normalizeProviderId('Open AI')).toBe('open-ai');
    expect(providerIconFor('Open AI')).toBeNull();
    expect(normalizeProviderId(' Gemini ')).toBe('gemini');
  });

  it('devolve null para ids desconhecidos, vazios ou de protótipo', () => {
    for (const value of [
      undefined,
      null,
      '',
      '   ',
      'sambanova',
      'scaleway',
      'deepinfra',
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(providerIconFor(value), String(value)).toBeNull();
    }
  });
});

describe('providerIconLabel', () => {
  it('rotula as marcas empacotadas com o nome comercial', () => {
    expect(providerIconLabel('opencode-go')).toBe('OpenCode');
    expect(providerIconLabel('openai')).toBe('OpenAI');
    expect(providerIconLabel('anthropic')).toBe('Anthropic');
    expect(providerIconLabel('gemini')).toBe('Gemini');
    expect(providerIconLabel('deepseek')).toBe('DeepSeek');
    expect(providerIconLabel('zai')).toBe('Z.AI');
    expect(providerIconLabel('siliconflow')).toBe('SiliconCloud');
  });

  it('devolve null quando não há marca', () => {
    expect(providerIconLabel('sambanova')).toBeNull();
    expect(providerIconLabel(null)).toBeNull();
  });
});

describe('PROVIDER_ICON_SVG', () => {
  it('tem exatamente as mesmas chaves do rótulo', () => {
    expect(Object.keys(PROVIDER_ICON_SVG).sort()).toEqual([...PROVIDER_ICON_KEYS].sort());
    expect(PROVIDER_ICON_KEYS.sort()).toEqual(Object.keys(PROVIDER_ICON_LABELS).sort());
  });

  it('empacota SVGs mono 24×24 com título oficial', () => {
    for (const key of PROVIDER_ICON_KEYS) {
      const svg = PROVIDER_ICON_SVG[key];
      expect(svg, key).toContain('viewBox="0 0 24 24"');
      expect(svg, key).toContain('fill="currentColor"');
      expect(svg, key).not.toMatch(/fill="#[0-9a-f]{3,8}"/i);
      expect(svg, key).toContain(`<title>${EXPECTED_SVG_TITLES[key]}</title>`);
      expect(svg, key).toMatch(/<path\b/);
    }
  });
});
