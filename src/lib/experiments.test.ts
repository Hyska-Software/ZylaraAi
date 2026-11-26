import { describe, expect, it } from 'vitest';

import {
  EXPERIMENTAL_FEATURES,
  experimentalFeaturePatch,
  isExperimentalFeatureEnabled,
  isExperimentalFeatureId,
  visibleExperimentalFeatures,
  visibleProviders,
  type ExperimentalFeatureId,
  type ExperimentalFeatureStage,
} from './experiments';
import type { ProviderInfo, Settings } from './types';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    pluginsEnabled: true,
    reasoningSliderEnabled: false,
    enabledExperimentalFeatures: {},
    ...overrides,
  } as unknown as Settings;
}

describe('experimental feature registry', () => {
  it('validates known feature ids only', () => {
    expect(isExperimentalFeatureId('acpAgents')).toBe(true);
    expect(isExperimentalFeatureId('notAFeature')).toBe(false);
    expect(isExperimentalFeatureId(42)).toBe(false);
  });

  it('lists every currently experimental feature', () => {
    expect(visibleExperimentalFeatures().map((feature) => feature.id)).toEqual([
      'pluginPlatform',
      'reasoningSlider',
      'acpAgents',
      'agentChannels',
    ]);
  });

  it('respects defaults, legacy fields and explicit overrides', () => {
    expect(isExperimentalFeatureEnabled(settings(), 'pluginPlatform')).toBe(true);
    expect(isExperimentalFeatureEnabled(settings(), 'acpAgents')).toBe(false);
    expect(isExperimentalFeatureEnabled(settings({ reasoningSliderEnabled: true }), 'reasoningSlider')).toBe(true);
    expect(isExperimentalFeatureEnabled(settings({ pluginsEnabled: false }), 'pluginPlatform')).toBe(false);
    expect(
      isExperimentalFeatureEnabled(
        settings({ reasoningSliderEnabled: false, enabledExperimentalFeatures: { reasoningSlider: true } }),
        'reasoningSlider',
      ),
    ).toBe(true);
    expect(isExperimentalFeatureEnabled(settings(), 'missing' as ExperimentalFeatureId)).toBe(false);
  });

  it('stops listing a promoted feature and ignores its stale override', () => {
    const entry = EXPERIMENTAL_FEATURES.find((feature) => feature.id === 'pluginPlatform') as {
      stage: ExperimentalFeatureStage;
    };
    const original = entry.stage;
    try {
      entry.stage = 'stable';
      expect(visibleExperimentalFeatures().map((feature) => feature.id)).not.toContain('pluginPlatform');
      expect(
        isExperimentalFeatureEnabled(
          settings({ pluginsEnabled: false, enabledExperimentalFeatures: { pluginPlatform: false } }),
          'pluginPlatform',
        ),
      ).toBe(true);
    } finally {
      entry.stage = original;
    }
  });

  it('patches the override map and the legacy field together', () => {
    const patch = experimentalFeaturePatch(settings(), 'reasoningSlider', true);
    expect(patch).toEqual({
      enabledExperimentalFeatures: { reasoningSlider: true },
      reasoningSliderEnabled: true,
    });
    const merged = experimentalFeaturePatch(
      settings({ enabledExperimentalFeatures: { acpAgents: true } }),
      'agentChannels',
      true,
    );
    expect(merged.enabledExperimentalFeatures).toEqual({ acpAgents: true, agentChannels: true });
  });

  it('hides ACP providers from the catalog while the flag is off', () => {
    const providers = [
      { id: 'acp-agent', transport: 'acp', models: [] },
      { id: 'openai', transport: 'http', models: [] },
    ] as unknown as ProviderInfo[];
    expect(visibleProviders(settings(), providers).map((provider) => provider.id)).toEqual(['openai']);
    expect(
      visibleProviders(
        settings({ enabledExperimentalFeatures: { acpAgents: true } }),
        providers,
      ).map((provider) => provider.id),
    ).toEqual(['acp-agent', 'openai']);
  });
});
