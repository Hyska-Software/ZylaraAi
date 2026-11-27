import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm, open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Plus, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { BrandMark } from '@/components/chat/BrandMark';
import { Button, IconButton, SegmentedControl, Spinner, Switch } from '@/components/ui';
import { BUILTIN_THEME_ID, useAppStore, useThemeStore, useUiStore } from '@/lib/store';
import type { ThemeInfo, ThemeMode } from '@/lib/types';
import { cn } from '@/lib/utils';
import { SettingRow, SettingsSection } from './shared';

const SWATCH_TOKENS = ['background', 'surface', 'foreground', 'accent', 'success', 'danger'] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Theme manager: light/dark/system mode plus the installed package gallery.
 * Installing, updating and removing is backend-owned; this component only
 * drives the commands and mirrors the store.
 */
export function ThemesTab() {
  const { t } = useTranslation('settings');
  const { t: common } = useTranslation('common');
  const themes = useThemeStore((state) => state.themes);
  const activeId = useThemeStore((state) => state.activeId);
  const ready = useThemeStore((state) => state.ready);
  const error = useThemeStore((state) => state.error);
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const borderRadiusEnabled = useAppStore((state) => state.settings.borderRadiusEnabled);
  const chatExecutionAnimationEnabled = useAppStore(
    (state) => state.settings.chatExecutionAnimationEnabled,
  );
  const [installing, setInstalling] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const displayName = (entry: ThemeInfo) =>
    entry.id === BUILTIN_THEME_ID ? t('themes.builtin.name') : entry.name;
  const description = (entry: ThemeInfo) => {
    if (entry.id === BUILTIN_THEME_ID) return t('themes.builtin.description');
    if (entry.builtIn) {
      switch (entry.id) {
        case 'aurora':
          return t('themes.bundled.aurora');
        case 'ember':
          return t('themes.bundled.ember');
        case 'grove':
          return t('themes.bundled.grove');
        case 'nebula':
          return t('themes.bundled.nebula');
        case 'nocturne':
          return t('themes.bundled.nocturne');
        default:
          break;
      }
    }
    return entry.description;
  };

  const modeOptions = [
    { value: 'light', label: t('general.theme.light') },
    { value: 'dark', label: t('general.theme.dark') },
    { value: 'system', label: t('general.theme.system') },
  ];

  const handleMode = (value: string) => {
    const next = value as ThemeMode;
    setTheme(next);
    void saveSettings({ theme: next });
  };

  const handleUse = async (entry: ThemeInfo) => {
    await useThemeStore.getState().setActive(entry.id);
  };

  const handleInstall = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t('themes.package.pickTitle'),
      filters: [{ name: t('themes.package.filter'), extensions: ['zip'] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setInstalling(true);
    try {
      const result = await useThemeStore.getState().install(selected);
      toast.success(
        result.replaced ? t('themes.toasts.updated') : t('themes.toasts.installed'),
        { description: displayName(result.theme) },
      );
    } catch (cause) {
      toast.error(t('themes.toasts.installFailed'), { description: errorText(cause) });
    } finally {
      setInstalling(false);
    }
  };

  const handleRemove = async (entry: ThemeInfo) => {
    const accepted = await confirm(
      t('themes.removeConfirm.body', { name: displayName(entry) }),
      {
        title: t('themes.removeConfirm.title'),
        kind: 'warning',
        okLabel: t('themes.removeConfirm.ok'),
        cancelLabel: common('actions.cancel'),
      },
    );
    if (!accepted) return;
    setRemovingId(entry.id);
    try {
      await useThemeStore.getState().uninstall(entry.id);
      toast.success(t('themes.toasts.removed'), { description: displayName(entry) });
    } catch (cause) {
      toast.error(t('themes.toasts.removeFailed'), { description: errorText(cause) });
    } finally {
      setRemovingId(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await useThemeStore.getState().openFolder();
    } catch (cause) {
      toast.error(t('themes.toasts.openFolderFailed'), { description: errorText(cause) });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title={t('themes.mode.title')} description={t('themes.mode.description')}>
        <SettingRow label={t('themes.mode.label')} description={t('themes.mode.description')}>
          <SegmentedControl
            options={modeOptions}
            value={theme}
            onChange={handleMode}
            ariaLabel={t('themes.mode.aria')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t('themes.radius.title')}
        description={t('themes.radius.description')}
      >
        <SettingRow label={t('themes.radius.label')}>
          <Switch
            checked={borderRadiusEnabled}
            onCheckedChange={(checked) => void saveSettings({ borderRadiusEnabled: checked })}
            aria-label={t('themes.radius.aria')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t('themes.chatExecutionAnimation.title')}
        description={t('themes.chatExecutionAnimation.description')}
      >
        <SettingRow label={t('themes.chatExecutionAnimation.label')}>
          <Switch
            checked={chatExecutionAnimationEnabled}
            onCheckedChange={(checked) =>
              void saveSettings({ chatExecutionAnimationEnabled: checked })
            }
            aria-label={t('themes.chatExecutionAnimation.aria')}
          />
        </SettingRow>
      </SettingsSection>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold tracking-tight text-foreground">
              {t('themes.library.title')}
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">
              {t('themes.library.description')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              loading={installing}
              onClick={() => void handleInstall()}
              leftIcon={<Plus className="size-3.5" />}
            >
              {t('themes.actions.install')}
            </Button>
            <IconButton
              label={t('themes.actions.refresh')}
              variant="ghost"
              size="sm"
              onClick={() => void useThemeStore.getState().refresh()}
            >
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton
              label={t('themes.actions.openFolderAria')}
              variant="ghost"
              size="sm"
              onClick={() => void handleOpenFolder()}
            >
              <FolderOpen className="size-3.5" />
            </IconButton>
          </div>
        </div>

        {!ready ? (
          <div className="flex items-center justify-center rounded-xl bg-surface py-10">
            <Spinner label={t('themes.loading')} />
          </div>
        ) : (
          <div className="rounded-xl bg-surface p-3">
            {error ? (
              <div
                role="alert"
                className="mb-3 rounded-lg bg-danger-soft px-3 py-2.5"
              >
                <p className="text-[13px] font-medium text-foreground">{t('themes.loadFailed')}</p>
                <p className="mt-0.5 break-words text-[11px] leading-relaxed text-foreground-muted">
                  {error}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => void useThemeStore.getState().refresh()}
                >
                  {t('themes.retry')}
                </Button>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {themes.map((entry) => {
                const active = entry.id === activeId;
                const meta = [
                  entry.pluginName
                    ? t('themes.pluginFrom', { name: entry.pluginName })
                    : null,
                  entry.author ? t('themes.meta.by', { author: entry.author }) : null,
                  entry.version ? t('themes.meta.version', { version: entry.version }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <article
                    key={entry.id}
                    data-theme-id={entry.id}
                    className={cn(
                      'flex min-w-0 flex-col gap-3 rounded-xl p-3 transition-colors',
                      active
                        ? ' bg-accent-soft/30'
                        : ' bg-surface-hover ',
                    )}
                  >
                    <div
                      className="relative h-24 overflow-hidden rounded-lg bg-surface"
                      aria-hidden
                    >
                      {entry.id === BUILTIN_THEME_ID ? (
                        <div className="flex h-full items-center justify-center">
                          <BrandMark size={44} tint="brand" />
                        </div>
                      ) : (
                        <div className="grid h-full grid-cols-3 grid-rows-2">
                          {SWATCH_TOKENS.map((token) => (
                            <span
                              key={token}
                              className="block h-full w-full"
                              style={{
                                backgroundColor: entry.light.tokens[token] ?? 'transparent',
                              }}
                            />
                          ))}
                        </div>
                      )}
                      {active ? (
                        <span className="absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-foreground shadow-sm">
                          {t('themes.actions.active')}
                        </span>
                      ) : null}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-[13px] font-semibold text-foreground">
                          {displayName(entry)}
                        </p>
                        {entry.pluginId ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                            <Puzzle aria-hidden className="size-2.5" strokeWidth={2} />
                            {t('themes.pluginBadge')}
                          </span>
                        ) : null}
                      </div>
                      {meta ? (
                        <p className="mt-0.5 truncate text-[11px] text-foreground-subtle">{meta}</p>
                      ) : null}
                      {description(entry) ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-foreground-muted">
                          {description(entry)}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <Button
                        size="sm"
                        variant={active ? 'secondary' : 'primary'}
                        disabled={active}
                        onClick={() => void handleUse(entry)}
                      >
                        {active ? t('themes.actions.active') : t('themes.actions.use')}
                      </Button>
                      {entry.builtIn || entry.pluginId ? null : (
                        <IconButton
                          label={t('themes.actions.removeAria', { name: displayName(entry) })}
                          variant="ghost"
                          size="sm"
                          loading={removingId === entry.id}
                          onClick={() => void handleRemove(entry)}
                        >
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            {themes.every((entry) => entry.builtIn) ? (
              <p className="mt-3 text-center text-[11px] leading-relaxed text-foreground-subtle">
                {t('themes.empty')}
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
