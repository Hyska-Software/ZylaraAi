/**
 * Raw mono SVGs from `@lobehub/icons-static-svg` (MIT — https://icons.lobehub.com).
 *
 * Imported with Vite's `?raw` so only the provider marks the settings screen
 * needs are bundled (no icon font, no CDN request, works offline inside Tauri).
 * Each file is a 24×24 `fill="currentColor"` glyph, so the list paints it with
 * the design tokens and it stays legible in both themes.
 *
 * Keep the keys in sync with `ProviderIconKey` (`src/lib/providerIcons.ts`);
 * the unit tests assert both sides cover exactly the same keys.
 */
import type { ProviderIconKey } from './providerIcons';

import anthropicSvg from '@lobehub/icons-static-svg/icons/anthropic.svg?raw';
import cerebrasSvg from '@lobehub/icons-static-svg/icons/cerebras.svg?raw';
import deepseekSvg from '@lobehub/icons-static-svg/icons/deepseek.svg?raw';
import fireworksSvg from '@lobehub/icons-static-svg/icons/fireworks.svg?raw';
import geminiSvg from '@lobehub/icons-static-svg/icons/gemini.svg?raw';
import groqSvg from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import inceptionSvg from '@lobehub/icons-static-svg/icons/inception.svg?raw';
import minimaxSvg from '@lobehub/icons-static-svg/icons/minimax.svg?raw';
import mistralSvg from '@lobehub/icons-static-svg/icons/mistral.svg?raw';
import moonshotSvg from '@lobehub/icons-static-svg/icons/moonshot.svg?raw';
import novitaSvg from '@lobehub/icons-static-svg/icons/novita.svg?raw';
import nvidiaSvg from '@lobehub/icons-static-svg/icons/nvidia.svg?raw';
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import openrouterSvg from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import siliconcloudSvg from '@lobehub/icons-static-svg/icons/siliconcloud.svg?raw';
import stepfunSvg from '@lobehub/icons-static-svg/icons/stepfun.svg?raw';
import togetherSvg from '@lobehub/icons-static-svg/icons/together.svg?raw';
import veniceSvg from '@lobehub/icons-static-svg/icons/venice.svg?raw';
import vercelSvg from '@lobehub/icons-static-svg/icons/vercel.svg?raw';
import xaiSvg from '@lobehub/icons-static-svg/icons/xai.svg?raw';
import zhipuSvg from '@lobehub/icons-static-svg/icons/zhipu.svg?raw';

/** SVG source per bundled provider mark. */
export const PROVIDER_ICON_SVG: Readonly<Record<ProviderIconKey, string>> = {
  opencode: opencodeSvg,
  openai: openaiSvg,
  anthropic: anthropicSvg,
  gemini: geminiSvg,
  cerebras: cerebrasSvg,
  deepseek: deepseekSvg,
  fireworks: fireworksSvg,
  groq: groqSvg,
  inception: inceptionSvg,
  minimax: minimaxSvg,
  mistral: mistralSvg,
  moonshot: moonshotSvg,
  novita: novitaSvg,
  nvidia: nvidiaSvg,
  openrouter: openrouterSvg,
  siliconcloud: siliconcloudSvg,
  stepfun: stepfunSvg,
  together: togetherSvg,
  venice: veniceSvg,
  vercel: vercelSvg,
  xai: xaiSvg,
  zhipu: zhipuSvg,
};
