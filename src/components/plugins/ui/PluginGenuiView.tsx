/** Renders a plugin-provided GenUI component inside a ```ui block. */
import { copyText } from '@/lib/utils';
import { PluginBoundary } from './PluginBoundary';
import { PluginFrame } from '@/lib/plugins/frame';
import type { PluginGenuiComponent } from '@/lib/genui/extension';

export function PluginGenuiView({
  entry,
  props,
}: {
  entry: PluginGenuiComponent;
  props: Record<string, unknown>;
}) {
  const onAction = (kind: string, text: string) => {
    if (kind === 'copy') {
      void copyText(text);
      return;
    }
    window.dispatchEvent(new CustomEvent('zylara:suggest', { detail: text }));
  };
  if (entry.component) {
    const Component = entry.component;
    return (
      <PluginBoundary plugin={entry.plugin}>
        <Component plugin={entry.plugin} props={props} onAction={onAction} />
      </PluginBoundary>
    );
  }
  if (entry.render.entry) {
    return (
      <PluginFrame
        plugin={entry.plugin}
        entry={entry.render.entry}
        kind="genui"
        title={entry.spec.summary}
        context={{ props }}
        minHeight={entry.render.height ?? 160}
        maxHeight={480}
      />
    );
  }
  return null;
}
