import { afterEach, describe, expect, it } from 'vitest';

import { parseGenUI } from '@/lib/genui';
import { setPluginGenuiComponents } from '@/lib/genui/extension';
import type { GenuiComponentSpec } from '@/lib/plugins/ui/types';

function component(overrides: Partial<GenuiComponentSpec> = {}): GenuiComponentSpec {
  return {
    key: 'com.acme:genui:metric',
    pluginId: 'com.acme',
    plugin: { id: 'com.acme', name: 'Acme' } as never,
    type: 'plugin:com.acme:metric',
    id: 'metric',
    title: 'Metric',
    summary: 'One KPI',
    props: {
      label: { type: 'text', required: true, maxChars: 40 },
      trend: { type: 'enum', values: ['up', 'down'] },
    },
    render: { kind: 'trusted', component: 'metric' },
    component: () => null,
    ...overrides,
  };
}

afterEach(() => setPluginGenuiComponents([]));

describe('plugin genui components', () => {
  it('accepts a registered plugin component', () => {
    setPluginGenuiComponents([component()]);
    const result = parseGenUI(
      '{"components":[{"type":"plugin:com.acme:metric","props":{"label":"MRR","trend":"up"}}]}',
    );
    expect(result.spec).not.toBeNull();
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });

  it('reports unknown plugin components', () => {
    const result = parseGenUI(
      '{"components":[{"type":"plugin:com.acme:missing","props":{}}]}',
    );
    expect(result.spec).toBeNull();
    expect(result.diagnostics.some((entry) => entry.code === 'ui.unknown-type')).toBe(true);
  });

  it('validates plugin props with the shared normalizer', () => {
    setPluginGenuiComponents([component()]);
    const result = parseGenUI(
      '{"components":[{"type":"plugin:com.acme:metric","props":{"label":"MRR","trend":"sideways"}}]}',
    );
    expect(result.diagnostics.some((entry) => entry.code === 'ui.prop-type')).toBe(true);
    const missing = parseGenUI(
      '{"components":[{"type":"plugin:com.acme:metric","props":{}}]}',
    );
    expect(missing.spec).toBeNull();
    expect(missing.diagnostics.some((entry) => entry.code === 'ui.missing-prop')).toBe(true);
  });
});
