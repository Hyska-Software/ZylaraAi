import { LayoutTemplate } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui';
import { usePluginStore } from '@/lib/plugins/store';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { hasPluginUiContributions, usePluginUi } from '@/lib/plugins/ui/registry';
import { useUiStore } from '@/lib/store/uiStore';

/**
 * Surfaces the global plugin-UI switch (Settings → Design). While it is off,
 * every contribution of every active plugin is filtered out of the sidebars,
 * pages, slots and settings tabs, so a freshly installed plugin looks broken.
 * The banner only exists in that state and turns it back on in one click.
 */
export function PluginUiDisabledBanner() {
  const { t } = useTranslation('plugins');
  const ui = usePluginUi();
  const pluginUiEnabled = usePluginUiPrefs((state) => state.enabled);
  const setPluginUiEnabled = usePluginUiPrefs((state) => state.setEnabled);
  const pluginsEnabled = usePluginStore((state) => state.snapshot.pluginsEnabled);
  const safeMode = usePluginStore((state) => state.snapshot.safeMode);
  const layout = useUiStore((state) => state.layoutMode);
  const onPluginsPage = useUiStore((state) => {
    if (state.layoutMode === 'code') return state.codeView === 'plugins';
    if (state.layoutMode === 'agent') return state.agentView === 'plugins';
    return state.activeView === 'plugins';
  });
  const openSettings = useUiStore((state) => state.openSettings);

  if (pluginUiEnabled || !pluginsEnabled || safeMode || onPluginsPage) return null;
  if (!hasPluginUiContributions(ui, layout)) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex max-w-sm items-start gap-3 rounded-2xl bg-surface-raised px-3 py-2.5 shadow-lg"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <LayoutTemplate aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-foreground">{t('uiDisabled.title')}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-foreground-muted">
          {t('uiDisabled.body')}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="primary" onClick={() => setPluginUiEnabled(true)}>
            {t('uiDisabled.turnOn')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openSettings('design')}>
            {t('uiDisabled.review')}
          </Button>
        </div>
      </div>
    </div>
  );
}
