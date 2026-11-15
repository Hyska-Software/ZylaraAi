/** Plugin-provided components usable inside ```ui blocks. */
import { setPluginGenuiComponentSpecs, type GenUIComponentSpec, type GenUIPropSpec } from './contract';
import type { GenuiComponentSpec, PluginComponent } from '@/lib/plugins/ui/types';
import type { PluginRecord } from '@/lib/plugins/types';

export interface PluginGenuiComponent {
  type: string;
  pluginId: string;
  plugin: PluginRecord;
  spec: GenUIComponentSpec;
  render: GenuiComponentSpec['render'];
  component: PluginComponent | null;
}

let components = new Map<string, PluginGenuiComponent>();

function toSpec(source: GenuiComponentSpec): GenUIComponentSpec {
  const props: Record<string, GenUIPropSpec> = {};
  for (const [name, schema] of Object.entries(source.props)) {
    const raw = schema as { type?: string; required?: boolean; maxChars?: number; values?: string[] };
    const type = raw.type === 'image' ? 'imageSrc' : raw.type;
    if (
      type !== 'text' &&
      type !== 'number' &&
      type !== 'boolean' &&
      type !== 'enum' &&
      type !== 'icon' &&
      type !== 'imageSrc' &&
      type !== 'array'
    ) {
      continue;
    }
    props[name] = {
      type,
      required: raw.required === true,
      maxChars: raw.maxChars,
      values: raw.values,
    };
  }
  const doc = Object.entries(props)
    .map(([name, spec]) => `${name}${spec.required ? '' : '?'}: ${spec.type}`)
    .join(', ');
  return {
    type: source.type,
    kind: 'leaf',
    category: 'plugin',
    summary: source.summary,
    doc,
    acceptsChildren: false,
    props,
  };
}

export function setPluginGenuiComponents(list: readonly GenuiComponentSpec[]): void {
  components = new Map(
    list.map((entry) => [
      entry.type,
      {
        type: entry.type,
        pluginId: entry.pluginId,
        plugin: entry.plugin,
        spec: toSpec(entry),
        render: entry.render,
        component: entry.component,
      },
    ]),
  );
  setPluginGenuiComponentSpecs([...components.values()].map((entry) => entry.spec));
}

export function pluginGenuiComponent(type: string): PluginGenuiComponent | undefined {
  return components.get(type);
}
