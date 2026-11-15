import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui';
import { usePluginStore } from '@/lib/plugins/store';
import { useUiStore } from '@/lib/store/uiStore';

/**
 * Global recovery banner after a plugin crash loop or `--safe-mode`. The full
 * explanation/recovery controls live in the Plugins page; this only makes the
 * state visible without opening Settings first.
 */
export function PluginSafeModeBanner() {
  const { t } = useTranslation('plugins');
  const safeMode = usePluginStore((state) => state.snapshot.safeMode);
  const activeView = useUiStore((state) => state.activeView);
  if (!safeMode || activeView === 'plugins') return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex max-w-sm items-start gap-3 rounded-2xl bg-surface-raised px-3 py-2.5 shadow-lg"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-warning-soft text-warning">
        <AlertTriangle aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-foreground">{t('safeMode.title')}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-foreground-muted">
          {t('safeMode.body')}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => useUiStore.getState().setActiveView('plugins')}
        >
          {t('safeMode.recover')}
        </Button>
      </div>
    </div>
  );
}
