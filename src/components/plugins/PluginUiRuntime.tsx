/** Publishes plugin UI state on <html> and hosts later CSS/preset effects. */
import { useEffect } from 'react';

import { useUiStore } from '@/lib/store/uiStore';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { usePluginStyles } from '@/lib/plugins/ui/css';
import { useApplyPresets } from '@/lib/plugins/ui/presets';

export function PluginUiRuntime() {
  const layout = useUiStore((state) => state.layoutMode);
  const enabled = usePluginUiPrefs((state) => state.enabled);
  usePluginStyles();
  useApplyPresets();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.zylaraLayout = layout;
    root.dataset.zylaraPluginUi = enabled ? 'on' : 'off';
  }, [layout, enabled]);

  return null;
}
