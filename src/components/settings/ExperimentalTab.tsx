import { useTranslation } from 'react-i18next';
import { FlaskConical } from 'lucide-react';

import {
  experimentalFeaturePatch,
  isExperimentalFeatureEnabled,
  visibleExperimentalFeatures,
  type ExperimentalFeatureDefinition,
} from '@/lib/experiments';
import { useAppStore } from '@/lib/store';
import { Badge, Switch } from '@/components/ui';
import { SettingRow, SettingsSection } from './shared';

function ExperimentalFeatureRow({ feature }: { feature: ExperimentalFeatureDefinition }) {
  const { t } = useTranslation('settings');
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const reloadCatalog = useAppStore((state) => state.reloadCatalog);
  const enabled = isExperimentalFeatureEnabled(settings, feature.id);

  const toggle = async (checked: boolean) => {
    await saveSettings(experimentalFeaturePatch(settings, feature.id, checked));
    // ACP providers are filtered out of the catalog while the flag is off.
    if (feature.id === 'acpAgents') await reloadCatalog();
  };

  return (
    <SettingRow label={t(feature.labelKey)} description={t(feature.descriptionKey)}>
      <div className="flex items-center justify-end gap-2">
        <Badge tone="warning">{t('experimental.badge')}</Badge>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void toggle(checked)}
          aria-label={t(feature.labelKey)}
        />
      </div>
    </SettingRow>
  );
}

/** Opt-in surface for every feature whose registry stage is `experimental`. */
export function ExperimentalTab() {
  const { t } = useTranslation('settings');
  const features = visibleExperimentalFeatures();

  return (
    <div className="flex flex-col gap-6">
      <div
        role="note"
        aria-label={t('experimental.label')}
        className="flex items-start gap-2 rounded-xl bg-accent-soft/40 px-3 py-2 text-[12px] text-accent"
      >
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">{t('experimental.notice')}</p>
      </div>
      {features.length === 0 ? (
        <p className="text-xs leading-relaxed text-foreground-muted">{t('experimental.empty')}</p>
      ) : (
        <SettingsSection
          title={t('experimental.title')}
          description={t('experimental.description')}
        >
          {features.map((feature) => (
            <ExperimentalFeatureRow key={feature.id} feature={feature} />
          ))}
        </SettingsSection>
      )}
    </div>
  );
}
