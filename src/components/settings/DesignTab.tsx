/** Per-layout plugin design controls (presets, variants, conflicts, toggles). */
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui';
import { pluginComponentSpec } from '@/lib/plugins/contract';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs, variantKey } from '@/lib/plugins/ui/prefs';
import { useUiStore } from '@/lib/store/uiStore';
import type { LayoutId } from '@/lib/plugins/ui/types';

const LAYOUTS: LayoutId[] = ['chat', 'code', 'agent'];

export function DesignTab() {
  const { t } = useTranslation('settings');
  const layout = useUiStore((state) => state.layoutMode);
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();

  const presetOptions = [
    { key: 'host', label: t('design.hostDefault') },
    ...ui.presets
      .filter((entry) => entry.layouts.includes(layout))
      .map((entry) => ({ key: entry.key, label: entry.title })),
  ];
  const componentIds = Array.from(
    new Set(
      ui.replacements
        .filter((entry) => entry.layouts.includes(layout))
        .map((entry) => entry.component),
    ),
  );
  const modifications = [
    ...ui.slots.map((entry) => ({ key: entry.key, label: `slot · ${entry.slot}` })),
    ...ui.replacements.map((entry) => ({ key: entry.key, label: `component · ${entry.component}` })),
    ...ui.panelTabs.map((entry) => ({ key: entry.key, label: `dock · ${entry.title}` })),
    ...ui.nav.map((entry) => ({ key: entry.key, label: `nav · ${entry.title}` })),
  ];

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-[14px] font-semibold text-foreground">{t('design.title')}</h2>
        <p className="text-[12px] leading-relaxed text-foreground-muted">{t('design.description')}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {LAYOUTS.map((entry) => (
            <Button
              key={entry}
              size="sm"
              variant={layout === entry ? 'primary' : 'secondary'}
              onClick={() => useUiStore.getState().setLayoutMode(entry)}
            >
              {t(`design.layout.${entry}`)}
            </Button>
          ))}
          <Button
            size="sm"
            variant={prefs.enabled ? 'secondary' : 'primary'}
            onClick={() => prefs.setEnabled(!prefs.enabled)}
          >
            {prefs.enabled ? t('design.disable') : t('design.enable')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">{t('design.presets')}</h3>
        <div className="flex flex-wrap gap-1.5">
          {presetOptions.map((option) => (
            <Button
              key={option.key}
              size="sm"
              variant={(prefs.presets[layout] ?? 'host') === option.key ? 'primary' : 'secondary'}
              onClick={() => prefs.setPreset(layout, option.key === 'host' ? null : option.key)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">{t('design.variants')}</h3>
        {componentIds.length === 0 ? (
          <p className="text-[12px] text-foreground-subtle">{t('design.empty')}</p>
        ) : (
          componentIds.map((component) => {
            const spec = pluginComponentSpec(component);
            const selected = prefs.variants[variantKey(component, layout)] ?? '';
            return (
              <label key={component} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-foreground-muted">{spec?.title ?? component}</span>
                <select
                  value={selected}
                  onChange={(event) =>
                    prefs.setVariant(component, layout, event.target.value || null)
                  }
                  className="h-8 rounded-lg bg-surface-raised px-2 text-[12px] text-foreground"
                >
                  <option value="">{t('design.default')}</option>
                  {spec?.variants.map((variant) => (
                    <option key={variant} value={`builtin:${variant}`}>
                      {variant}
                    </option>
                  ))}
                  {ui.variants
                    .filter(
                      (entry) =>
                        entry.component === component && entry.layouts.includes(layout),
                    )
                    .map((entry) => (
                      <option key={entry.key} value={`${entry.pluginId}:${entry.variantId}`}>
                        {entry.title}
                      </option>
                    ))}
                </select>
              </label>
            );
          })
        )}
      </div>

      {componentIds.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-foreground">{t('design.conflicts')}</h3>
          {componentIds.map((component) => {
            const claimants = ui.replacements.filter(
              (entry) => entry.component === component && entry.layouts.includes(layout),
            );
            if (claimants.length < 2) return null;
            return (
              <label key={component} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-foreground-muted">{component}</span>
                <select
                  value={prefs.winners[component] ?? ''}
                  onChange={(event) => prefs.setWinner(component, event.target.value || null)}
                  className="h-8 rounded-lg bg-surface-raised px-2 text-[12px] text-foreground"
                >
                  <option value="">{t('design.default')}</option>
                  {claimants.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.plugin.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-foreground">{t('design.modifications')}</h3>
        {modifications.length === 0 ? (
          <p className="text-[12px] text-foreground-subtle">{t('design.empty')}</p>
        ) : (
          modifications.map((entry) => (
            <label key={entry.key} className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={!prefs.disabled.includes(entry.key)}
                onChange={(event) => prefs.setDisabled(entry.key, !event.target.checked)}
              />
              <span className="text-foreground-muted">{entry.label}</span>
            </label>
          ))
        )}
        <div className="flex gap-1.5 pt-1">
          <Button size="sm" variant="secondary" onClick={() => prefs.resetLayout(layout)}>
            {t('design.resetLayout')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => prefs.resetAll()}>
            {t('design.resetAll')}
          </Button>
        </div>
      </div>
    </section>
  );
}
