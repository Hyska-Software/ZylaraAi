import { FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Permanent notice on the Plugins page: the plugin platform is still
 * experimental, so its surfaces and permissions may change between releases.
 */
export function PluginExperimentalNotice() {
  const { t } = useTranslation('plugins');
  return (
    <div
      role="note"
      aria-label={t('experimental.label')}
      className="mx-5 mt-3 flex items-start gap-2 rounded-xl bg-accent-soft/40 px-3 py-2 text-[12px] text-accent"
    >
      <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t('experimental.label')}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-accent/90">
          {t('experimental.body')}
        </p>
      </div>
    </div>
  );
}
