/** Settings → Plugins: global policy, registry, developer and recovery tools. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FolderOpen, Puzzle, RefreshCw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button, Switch, Textarea } from '@/components/ui';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { useUiStore } from '@/lib/store/uiStore';
import { usePluginStore } from '@/lib/plugins/store';

function SettingRow({
  title,
  description,
  control,
  danger,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl bg-surface-raised/40 px-3 py-2.5">
      <div className="min-w-0">
        <p className={danger ? 'text-[12px] font-medium text-danger' : 'text-[12px] font-medium text-foreground'}>
          {title}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-foreground-muted">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

export function PluginsTab() {
  const { t } = useTranslation('plugins');
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const snapshot = usePluginStore((state) => state.snapshot);
  const [registryUrl, setRegistryUrl] = useState(settings.pluginRegistryUrl ?? '');

  useEffect(() => {
    setRegistryUrl(settings.pluginRegistryUrl ?? '');
  }, [settings.pluginRegistryUrl]);

  const saveRegistry = () => {
    const trimmed = registryUrl.trim();
    if (trimmed === (settings.pluginRegistryUrl ?? '')) return;
    void saveSettings({ pluginRegistryUrl: trimmed });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Puzzle aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-foreground">{t('settings.title')}</h2>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-foreground-muted">
            {t('settings.description')}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setSettingsOpen(false);
            setActiveView('plugins');
          }}
        >
          {t('settings.openPage')}
        </Button>
      </div>

      <PluginSlot slot="settings.plugins.header" />

      <div className="flex flex-col gap-2">
        <SettingRow
          title={t('settings.enabledTitle')}
          description={t('settings.enabledDescription')}
          control={
            <Switch
              checked={settings.pluginsEnabled}
              onCheckedChange={(checked) => void saveSettings({ pluginsEnabled: checked })}
              aria-label={t('settings.enabledTitle')}
            />
          }
        />
        <SettingRow
          title={t('settings.autoUpdateTitle')}
          description={t('settings.autoUpdateDescription')}
          control={
            <Switch
              checked={settings.pluginAutoUpdate}
              onCheckedChange={(checked) => void saveSettings({ pluginAutoUpdate: checked })}
              aria-label={t('settings.autoUpdateTitle')}
            />
          }
        />
        <SettingRow
          title={t('settings.trustedTitle')}
          description={t('settings.trustedDescription')}
          danger={settings.pluginAllowTrusted}
          control={
            <Switch
              checked={settings.pluginAllowTrusted}
              onCheckedChange={(checked) => {
                if (checked) {
                  const accepted = window.confirm(t('settings.trustedConfirm'));
                  if (!accepted) return;
                }
                void saveSettings({ pluginAllowTrusted: checked }).then(() =>
                  usePluginStore.getState().reload(),
                );
              }}
              aria-label={t('settings.trustedTitle')}
            />
          }
        />
        <SettingRow
          title={t('settings.devTitle')}
          description={t('settings.devDescription')}
          control={
            <Switch
              checked={settings.pluginDevMode}
              onCheckedChange={(checked) => void saveSettings({ pluginDevMode: checked })}
              aria-label={t('settings.devTitle')}
            />
          }
        />
        <SettingRow
          title={t('settings.safeTitle')}
          description={t('settings.safeDescription')}
          danger={settings.pluginSafeMode}
          control={
            <Switch
              checked={settings.pluginSafeMode}
              onCheckedChange={(checked) =>
                void saveSettings({ pluginSafeMode: checked }).then(() =>
                  usePluginStore.getState().reload(),
                )
              }
              aria-label={t('settings.safeTitle')}
            />
          }
        />
      </div>

      <section className="rounded-xl bg-surface-raised/30 p-3">
        <label className="text-[12px] font-medium text-foreground" htmlFor="plugin-registry-url">
          {t('settings.registryTitle')}
        </label>
        <p className="mt-0.5 text-[11px] text-foreground-muted">
          {t('settings.registryDescription')}
        </p>
        <div className="mt-2 flex gap-2">
          <Textarea
            id="plugin-registry-url"
            value={registryUrl}
            onChange={(event) => setRegistryUrl(event.target.value)}
            onBlur={saveRegistry}
            rows={2}
            placeholder={t('settings.registryPlaceholder')}
            className="min-h-16 min-w-0 flex-1 resize-y font-mono text-[11.5px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!registryUrl.trim()}
            onClick={() => {
              const trimmed = registryUrl.trim();
              void saveSettings({ pluginRegistryUrl: trimmed })
                .then(() => usePluginStore.getState().refreshStore(true))
                .then(() => toast.success(t('toasts.registryRefreshed')))
                .catch((error) => toast.error(String(error)));
            }}
          >
            <RefreshCw aria-hidden className="size-3.5" />
            {t('actions.refresh')}
          </Button>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void api.openPluginsDir().catch((error) => toast.error(String(error)))}
        >
          <FolderOpen aria-hidden className="size-3.5" />
          {t('actions.openFolder')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void usePluginStore
              .getState()
              .devReload()
              .then(() => toast.success(t('toasts.devReloaded')))
              .catch((error) => toast.error(String(error)))
          }
        >
          <RefreshCw aria-hidden className="size-3.5" />
          {t('actions.devReload')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger hover:bg-danger-soft"
          onClick={() => {
            if (!window.confirm(t('settings.disableAllConfirm'))) return;
            void saveSettings({ pluginsEnabled: false }).then(() =>
              usePluginStore.getState().reload(),
            );
          }}
        >
          <ShieldAlert aria-hidden className="size-3.5" />
          {t('settings.disableAll')}
        </Button>
        {snapshot.safeMode ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void usePluginStore
                .getState()
                .leaveSafeMode()
                .catch((error) => toast.error(String(error)))
            }
          >
            <AlertTriangle aria-hidden className="size-3.5" />
            {t('safeMode.recover')}
          </Button>
        ) : null}
      </section>

      <p className="text-[11px] leading-relaxed text-foreground-subtle">
        {t('settings.footnote')}
      </p>
    </div>
  );
}
