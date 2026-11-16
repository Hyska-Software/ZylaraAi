import { describe, expect, it } from 'vitest';

import { i18n } from '@/lib/i18n';
import { pluginI18nKey } from '@/lib/plugins/i18n';
import { pluginLabel } from '@/lib/plugins/registry';
import type { PluginRecord } from '@/lib/plugins/types';

describe('plugin locale lookup', () => {
  it('resolves dotted reverse-DNS ids through the hash key', () => {
    const id = 'com.acme.notes';
    i18n.addResourceBundle(
      'pt-BR',
      'plugins',
      { [pluginI18nKey(id)]: { views: { demo: 'Notas' } } },
      true,
      true,
    );

    expect(
      pluginLabel({ id } as PluginRecord, 'views.demo', 'fallback'),
    ).toBe('Notas');
    expect(
      pluginLabel({ id } as PluginRecord, 'views.missing', 'fallback'),
    ).toBe('fallback');
  });

  it('keeps colliding sanitized ids distinct', () => {
    expect(pluginI18nKey('com.acme.notes')).not.toBe(
      pluginI18nKey('com_acme.notes'),
    );
  });
});
