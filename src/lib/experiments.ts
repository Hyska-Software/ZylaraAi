/**
 * Experimental feature registry.
 *
 * Single source of truth for the stage (experimental vs stable), default and
 * legacy binding of every opt-in feature shown in Settings → Experimental.
 * Adding a feature means adding one entry here and wrapping its surface with
 * `isExperimentalFeatureEnabled`. Promoting it to stable is a stage change:
 * the entry disappears from the tab and stored overrides stop applying.
 */
import type { ProviderInfo, Settings } from './types';

export type ExperimentalFeatureId =
  | 'pluginPlatform'
  | 'reasoningSlider'
  | 'acpAgents'
  | 'agentChannels';

export type ExperimentalFeatureStage = 'experimental' | 'stable';

/** Bridges flags that already had a dedicated Settings field before the registry. */
interface LegacyBinding {
  get: (settings: Settings) => boolean;
  patch: (enabled: boolean) => Partial<Settings>;
}

export interface ExperimentalFeatureDefinition {
  id: ExperimentalFeatureId;
  stage: ExperimentalFeatureStage;
  /** Used for experimental features without an explicit user choice yet. */
  defaultEnabled: boolean;
  labelKey: string;
  descriptionKey: string;
  legacy?: LegacyBinding;
}

export const EXPERIMENTAL_FEATURES = [
  {
    id: 'pluginPlatform',
    stage: 'experimental',
    // Grandfathered surface: it shipped enabled, so disabling it must be a choice.
    defaultEnabled: true,
    labelKey: 'experimental.features.pluginPlatform.label',
    descriptionKey: 'experimental.features.pluginPlatform.description',
    legacy: {
      get: (settings) => settings.pluginsEnabled ?? true,
      patch: (enabled) => ({ pluginsEnabled: enabled }),
    },
  },
  {
    id: 'reasoningSlider',
    stage: 'experimental',
    defaultEnabled: false,
    labelKey: 'experimental.features.reasoningSlider.label',
    descriptionKey: 'experimental.features.reasoningSlider.description',
    legacy: {
      get: (settings) => settings.reasoningSliderEnabled ?? false,
      patch: (enabled) => ({ reasoningSliderEnabled: enabled }),
    },
  },
  {
    id: 'acpAgents',
    stage: 'experimental',
    defaultEnabled: false,
    labelKey: 'experimental.features.acpAgents.label',
    descriptionKey: 'experimental.features.acpAgents.description',
  },
  {
    id: 'agentChannels',
    stage: 'experimental',
    defaultEnabled: false,
    labelKey: 'experimental.features.agentChannels.label',
    descriptionKey: 'experimental.features.agentChannels.description',
  },
] as const satisfies readonly ExperimentalFeatureDefinition[];

const FEATURE_BY_ID = Object.fromEntries(
  EXPERIMENTAL_FEATURES.map((feature) => [feature.id, feature]),
) as Record<ExperimentalFeatureId, ExperimentalFeatureDefinition>;

const FEATURE_IDS = new Set<string>(EXPERIMENTAL_FEATURES.map((feature) => feature.id));

/** Narrows an untrusted value (persisted key, plugin payload) to a known id. */
export function isExperimentalFeatureId(value: unknown): value is ExperimentalFeatureId {
  return typeof value === 'string' && FEATURE_IDS.has(value);
}

/** Features currently listed in Settings → Experimental. */
export function visibleExperimentalFeatures(): readonly ExperimentalFeatureDefinition[] {
  return EXPERIMENTAL_FEATURES.filter((feature) => feature.stage === 'experimental');
}

/**
 * Effective value of a flag. Explicit registry overrides win over the legacy
 * field; stable features ignore overrides so promotion cannot leave them off.
 */
export function isExperimentalFeatureEnabled(
  settings: Settings,
  id: ExperimentalFeatureId,
): boolean {
  const feature = FEATURE_BY_ID[id];
  if (!feature) return false;
  if (feature.stage === 'stable') return feature.defaultEnabled;
  const override = settings.enabledExperimentalFeatures?.[id];
  return override ?? feature.legacy?.get(settings) ?? feature.defaultEnabled;
}

/** Patch for `saveSettings` that persists both the override and a legacy field. */
export function experimentalFeaturePatch(
  settings: Settings,
  id: ExperimentalFeatureId,
  enabled: boolean,
): Partial<Settings> {
  const feature = FEATURE_BY_ID[id];
  if (!feature) return {};
  return {
    enabledExperimentalFeatures: {
      ...(settings.enabledExperimentalFeatures ?? {}),
      [id]: enabled,
    },
    ...(feature.legacy?.patch(enabled) ?? {}),
  };
}

/** ACP providers stay in the catalog but are hidden while the flag is off. */
export function visibleProviders(
  settings: Settings,
  providers: readonly ProviderInfo[],
): ProviderInfo[] {
  if (isExperimentalFeatureEnabled(settings, 'acpAgents')) return [...providers];
  return providers.filter((provider) => provider.transport !== 'acp');
}
