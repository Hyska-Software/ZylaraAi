// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: {} }));

import { applyPresetForLayout } from '@/lib/plugins/ui/presets';
import type { PresetSpec } from '@/lib/plugins/ui/types';

const preset: PresetSpec = {
  key: 'com.acme:preset:paper',
  pluginId: 'com.acme',
  plugin: { id: 'com.acme', name: 'Acme' } as never,
  source: 'plugin',
  order: 100,
  layouts: ['chat'],
  presetId: 'paper',
  title: 'Paper',
  tokens: { light: { background: '#faf8f4' }, dark: { background: '#14120f' } },
  density: 'compact',
  variants: {},
  css: null,
};

afterEach(() => {
  applyPresetForLayout('chat', null, [preset], false);
});

describe('plugin presets', () => {
  it('applies allowlisted tokens and density for a layout', () => {
    applyPresetForLayout('chat', preset.key, [preset], true);
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#faf8f4');
    expect(document.documentElement.dataset.zylaraDensity).toBe('compact');
    expect(document.documentElement.dataset.zylaraPreset).toBe(preset.key);
  });

  it('ignores presets from other layouts and restores on disable', () => {
    applyPresetForLayout('code', preset.key, [preset], true);
    expect(document.documentElement.dataset.zylaraPreset).toBeUndefined();
    applyPresetForLayout('chat', preset.key, [preset], true);
    applyPresetForLayout('chat', null, [preset], true);
    expect(document.documentElement.dataset.zylaraPreset).toBeUndefined();
  });

  it('drops tokens outside the theme allowlist', () => {
    applyPresetForLayout(
      'chat',
      preset.key,
      [
        {
          ...preset,
          tokens: { light: { 'not-a-token': '#fff', accent: '#123456' }, dark: {} },
        },
      ],
      true,
    );
    expect(document.documentElement.style.getPropertyValue('--not-a-token')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');
  });
});
