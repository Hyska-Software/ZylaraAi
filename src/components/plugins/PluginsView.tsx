/**
 * Plugins page (Discover / Installed / Updates). Replaces the chat column from
 * the sidebar; lifecycle actions live in the detail dialog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Download,
  FolderOpen,
  Link2,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Upload,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Spinner,
  Switch,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { useUiStore } from '@/lib/store/uiStore';
import { usePluginStore } from '@/lib/plugins/store';
import { pluginContributesUi, usePluginRegistry } from '@/lib/plugins/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { commandSlashName } from '@/lib/plugins/host';
import { builtinSlashCommandNames } from '@/components/composer/commands';
import { Slot } from '@/components/plugins/ui/Slot';
import { ComponentSlot } from '@/components/plugins/ui/Slot';
import type { PluginComponent } from '@/lib/plugins/registry';
import type {
  PluginPackageInspection,
  PluginRecord,
  PluginUpdateInfo,
  RegistryPlugin,
} from '@/lib/plugins/types';
import { cn } from '@/lib/utils';
import {
  consentFromInspection,
  PluginConsentDialog,
  type PluginConsentData,
} from './PluginConsentDialog';
import { PluginAvatar, PluginDetailDialog, SignaturePill } from './PluginDetailDialog';
import { PluginExperimentalNotice } from './PluginExperimentalNotice';

type ConsentTarget =
  | { kind: 'file'; path: string; inspection: PluginPackageInspection; mode: 'install' | 'update' }
  | { kind: 'folder'; path: string; inspection: PluginPackageInspection }
  | { kind: 'url'; url: string; inspection: PluginPackageInspection }
  | { kind: 'store'; candidate: RegistryPlugin }
  | { kind: 'update'; update: PluginUpdateInfo };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function installedFor(plugins: PluginRecord[], id: string): PluginRecord | undefined {
  return plugins.find((plugin) => plugin.id === id);
}

function PluginCard({
  plugin,
  onOpen,
  onToggle,
  busy,
}: {
  plugin: PluginRecord;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('plugins');
  const pluginUiEnabled = usePluginUiPrefs((state) => state.enabled);
  const hiddenByPref = !pluginUiEnabled && pluginContributesUi(plugin);
  return (
    <div
      className={cn(
        'group flex items-start gap-3 rounded-xl bg-surface-raised/40 p-3 transition-colors',
        'hover:bg-surface-hover/60',
      )}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <PluginAvatar plugin={plugin} size={38} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-foreground">
              {plugin.name}
            </span>
            <span className="font-mono text-[10.5px] text-foreground-subtle">
              v{plugin.version}
            </span>
            <SignaturePill status={plugin.signatureStatus} />
            {plugin.previousVersion ? (
              <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-foreground-subtle">
                {t('installed.rollbackAvailable', { version: plugin.previousVersion })}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-foreground-muted">
            {plugin.description || t('installed.noDescription')}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-foreground-subtle">
            <span>{plugin.publisherName}</span>
            <span>·</span>
            <span>{t('installed.permissionCount', { count: plugin.permissions.length })}</span>
            {plugin.tools.length > 0 ? (
              <>
                <span>·</span>
                <span>{t('installed.toolCount', { count: plugin.tools.length })}</span>
              </>
            ) : null}
            <span>·</span>
            <span>{formatBytes(plugin.sizeBytes)}</span>
            {plugin.disabledReason ? (
              <>
                <span>·</span>
                <span className="text-warning">
                  {plugin.disabledReason === 'activation_required'
                    ? t('installed.activationRequired')
                    : plugin.disabledReason === 'permissions_incomplete'
                      ? t('installed.permissionsIncomplete')
                      : plugin.disabledReason === 'user_disabled'
                        ? t('installed.userDisabled')
                        : plugin.disabledReason}
                </span>
              </>
            ) : null}
            {hiddenByPref ? (
              <>
                <span>·</span>
                <span className="text-accent">{t('installed.pluginUiOff')}</span>
              </>
            ) : null}
          </span>
        </span>
      </button>
      <Switch
        checked={plugin.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={t('installed.toggleAria', { name: plugin.name })}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

export function PluginsView() {
  const { t } = useTranslation('plugins');
  const snapshot = usePluginStore((state) => state.snapshot);
  const loadError = usePluginStore((state) => state.error);
  const store = usePluginStore((state) => state.store);
  const storeLoading = usePluginStore((state) => state.storeLoading);
  const storeError = usePluginStore((state) => state.storeError);
  const updates = usePluginStore((state) => state.updates);
  const updatesLoading = usePluginStore((state) => state.updatesLoading);
  const busy = usePluginStore((state) => state.busyPluginId) !== null;
  const settings = useAppStore((state) => state.settings);
  const pluginRegistry = usePluginRegistry();
  const setSettingsOpen = useUiStore((state) => state.openSettings);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const [tab, setTab] = useState<'installed' | 'discover' | 'updates'>('installed');
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentTarget | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [urlDialog, setUrlDialog] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const discoveryRequested = useRef(false);
  const updatesRequested = useRef(false);
  const conflictMessages = useMemo(() => {
    const builtins = new Set(builtinSlashCommandNames());
    const names = new Map(pluginRegistry.plugins.map((plugin) => [plugin.id, plugin.name]));
    const lines = pluginRegistry.conflicts.map((conflict) =>
      t(`conflicts.${conflict.kind}`, {
        value: conflict.value,
        plugin: names.get(conflict.pluginId) ?? conflict.pluginId,
        other: names.get(conflict.otherPluginId) ?? conflict.otherPluginId,
      }),
    );
    for (const resolved of pluginRegistry.commands) {
      const slash = commandSlashName(resolved).toLowerCase();
      if (builtins.has(slash)) {
        lines.push(
          t('conflicts.builtin', {
            value: slash,
            plugin: resolved.plugin.name,
          }),
        );
      }
    }
    return [...new Set(lines)];
  }, [pluginRegistry.commands, pluginRegistry.conflicts, pluginRegistry.plugins, t]);

  useEffect(() => {
    if (tab !== 'discover' || discoveryRequested.current) return;
    discoveryRequested.current = true;
    if (!usePluginStore.getState().store) void usePluginStore.getState().refreshStore();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'updates' || updatesRequested.current) return;
    updatesRequested.current = true;
    void usePluginStore.getState().checkUpdates();
  }, [tab]);

  const plugins = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snapshot.plugins;
    return snapshot.plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(needle) ||
        plugin.id.toLowerCase().includes(needle) ||
        plugin.publisherName.toLowerCase().includes(needle) ||
        plugin.description.toLowerCase().includes(needle),
    );
  }, [snapshot.plugins, query]);

  const discover = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = store?.plugins ?? [];
    if (!needle) return list;
    return list.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(needle) ||
        plugin.id.toLowerCase().includes(needle) ||
        plugin.summary.toLowerCase().includes(needle),
    );
  }, [store, query]);

  const openFilePicker = useCallback(async () => {
    try {
      const selection = await open({
        multiple: false,
        title: t('picker.packageTitle'),
        filters: [{ name: 'Zylara plugin', extensions: ['zplugin'] }],
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const inspection = await usePluginStore.getState().inspectPackage(path);
      const installed = installedFor(snapshot.plugins, inspection.manifest.id);
      const mode = installed && installed.version !== inspection.manifest.version ? 'update' : 'install';
      setConsent({ kind: 'file', path, inspection, mode });
    } catch (error) {
      toast.error(t('errors.inspectFailed'), { description: String(error) });
    }
  }, [snapshot.plugins, t]);

  const openFolderPicker = useCallback(async () => {
    try {
      const selection = await open({
        directory: true,
        multiple: false,
        title: t('picker.folderTitle'),
      });
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const inspection = await api.inspectPluginFolder(path);
      setConsent({ kind: 'folder', path, inspection });
    } catch (error) {
      toast.error(t('errors.inspectFailed'), { description: String(error) });
    }
  }, [t]);

  const inspectUrlValue = useCallback(
    async (raw: string) => {
      const url = raw.trim();
      if (!url) return;
      setUrlBusy(true);
      try {
        const inspection = await api.inspectPluginUrl(url);
        setConsent({ kind: 'url', url, inspection });
      } catch (error) {
        toast.error(t('errors.inspectFailed'), { description: String(error) });
      } finally {
        setUrlBusy(false);
      }
    },
    [t],
  );

  const inspectUrl = useCallback(async () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlDialog(false);
    await inspectUrlValue(url);
  }, [inspectUrlValue, urlValue]);

  useEffect(() => {
    const onDeepLink = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      const url =
        typeof detail === 'string'
          ? detail
          : detail && typeof detail === 'object' && 'url' in detail && typeof detail.url === 'string'
            ? detail.url
            : null;
      if (url) void inspectUrlValue(url);
    };
    window.addEventListener('zylara:plugin-deep-link', onDeepLink);
    return () => window.removeEventListener('zylara:plugin-deep-link', onDeepLink);
  }, [inspectUrlValue]);

  useEffect(() => {
    const onInstallFile = () => void openFilePicker();
    window.addEventListener('zylara:plugin-install-file', onInstallFile);
    return () => window.removeEventListener('zylara:plugin-install-file', onInstallFile);
  }, [openFilePicker]);

  useEffect(() => {
    const onDrop = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (!detail || typeof detail !== 'object' || !('paths' in detail)) return;
      const paths = Array.isArray(detail.paths)
        ? detail.paths.filter((path): path is string => typeof path === 'string')
        : [];
      const first = paths.find((path) => path.toLowerCase().endsWith('.zplugin'));
      if (!first) return;
      void usePluginStore
        .getState()
        .inspectPackage(first)
        .then((inspection) => {
          const installed = installedFor(snapshot.plugins, inspection.manifest.id);
          setConsent({
            kind: 'file',
            path: first,
            inspection,
            mode:
              installed && installed.version !== inspection.manifest.version
                ? 'update'
                : 'install',
          });
        })
        .catch((error) => toast.error(t('errors.inspectFailed'), { description: String(error) }));
    };
    window.addEventListener('zylara:plugin-drop', onDrop);
    return () => window.removeEventListener('zylara:plugin-drop', onDrop);
  }, [snapshot.plugins, t]);

  const consentData: PluginConsentData | null = useMemo(() => {
    if (!consent) return null;
    if (consent.kind === 'store') {
      const candidate = consent.candidate;
      const installed =
        installedFor(snapshot.plugins, candidate.id) ??
        snapshot.plugins.find(
          (plugin) => plugin.publisherId === candidate.publisher.id && plugin.keyFingerprint,
        );
      return {
        id: candidate.id,
        name: candidate.name,
        version: candidate.version,
        publisher: candidate.publisher.name,
        signatureStatus: 'verified',
        permissions: candidate.permissions,
        trusted: candidate.permissions.some((permission) =>
          permission.startsWith('unsafe.renderer'),
        ),
        engineOk: true,
        keyChanged: Boolean(
          installed?.keyFingerprint &&
            candidate.keyFingerprint &&
            installed.keyFingerprint !== candidate.keyFingerprint,
        ),
        keyFingerprint: candidate.keyFingerprint,
        previousKeyFingerprint: installed?.keyFingerprint,
      };
    }
    if (consent.kind === 'update') {
      const installed = installedFor(snapshot.plugins, consent.update.pluginId);
      return {
        id: consent.update.pluginId,
        name: consent.update.name,
        version: consent.update.latestVersion,
        publisher: t('store.publisherUnknown'),
        signatureStatus: 'verified',
        permissions: consent.update.permissions,
        newPermissions: consent.update.newPermissions,
        trusted: consent.update.permissions.some((permission) =>
          permission.startsWith('unsafe.renderer'),
        ),
        engineOk: true,
        keyChanged: Boolean(
          installed?.keyFingerprint &&
            consent.update.keyFingerprint &&
            installed.keyFingerprint !== consent.update.keyFingerprint,
        ),
        keyFingerprint: consent.update.keyFingerprint,
        previousKeyFingerprint: installed?.keyFingerprint,
      };
    }
    return consentFromInspection(
      consent.inspection,
      [],
      installedFor(snapshot.plugins, consent.inspection.manifest.id) ??
        snapshot.plugins.find(
          (plugin) =>
            plugin.publisherId === consent.inspection.publisherId && plugin.keyFingerprint,
        ),
    );
  }, [consent, snapshot.plugins, t]);

  const consentMode: 'install' | 'update' =
    consent?.kind === 'update' || (consent?.kind === 'file' && consent.mode === 'update')
      ? 'update'
      : 'install';

  const confirmConsent = async (
    permissions: string[],
    allowUnsigned: boolean,
    allowKeyRotation: boolean,
  ) => {
    if (!consent) return;
    setConsentBusy(true);
    try {
      if (consent.kind === 'file') {
        await usePluginStore
          .getState()
          .installPackage(consent.path, permissions, allowUnsigned, allowKeyRotation);
      } else if (consent.kind === 'folder') {
        await usePluginStore.getState().installFolder(consent.path, permissions);
      } else if (consent.kind === 'url') {
        await usePluginStore
          .getState()
          .installUrl(consent.url, permissions, allowUnsigned, allowKeyRotation);
      } else if (consent.kind === 'store') {
        await usePluginStore
          .getState()
          .installFromStore(consent.candidate.id, permissions, allowKeyRotation);
      } else if (consent.kind === 'update') {
        await usePluginStore
          .getState()
          .updatePlugin(consent.update.pluginId, permissions, allowKeyRotation);
      }
      toast.success(t('toasts.installComplete'));
      setConsent(null);
      updatesRequested.current = false;
      void usePluginStore.getState().checkUpdates();
    } catch (error) {
      toast.error(t('errors.installFailed'), { description: String(error) });
    } finally {
      setConsentBusy(false);
    }
  };

  const togglePlugin = async (plugin: PluginRecord, enabled: boolean) => {
    try {
      await usePluginStore.getState().setEnabled(plugin.id, enabled);
    } catch (error) {
      toast.error(t('errors.toggleFailed'), { description: String(error) });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-col gap-3 border-b border-border px-5 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <Puzzle aria-hidden className="size-4 text-accent" strokeWidth={2} />
          <h1 className="text-[15px] font-semibold text-foreground">{t('view.title')}</h1>
          <span className="rounded-full bg-surface-active px-2 py-0.5 text-[10.5px] text-foreground-muted">
            {t('view.installedCount', { count: snapshot.plugins.length })}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => void openFilePicker()} disabled={busy}>
              <Upload aria-hidden className="size-3.5" />
              {t('actions.installFile')}
            </Button>
            {snapshot.devMode ? (
              <Button size="sm" variant="ghost" onClick={() => void openFolderPicker()} disabled={busy}>
                <FolderOpen aria-hidden className="size-3.5" />
                {t('actions.installFolder')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setUrlDialog(true)}>
              <Link2 aria-hidden className="size-3.5" />
              {t('actions.installUrl')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSettingsOpen('plugins')}
              aria-label={t('actions.settings')}
              title={t('actions.settings')}
            >
              <Settings aria-hidden className="size-3.5" />
            </Button>
          </div>
          <Slot name="plugins.view.header" />
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('view.searchPlaceholder')}
              aria-label={t('view.searchPlaceholder')}
              className="h-8 pl-8 text-[12px]"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('actions.refresh')}
            title={t('actions.refresh')}
            onClick={() => void usePluginStore.getState().reload()}
          >
            <RefreshCw aria-hidden className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void api.openPluginsDir().catch((error) => toast.error(String(error)))}
          >
            <FolderOpen aria-hidden className="size-3.5" />
            {t('actions.openFolder')}
          </Button>
        </div>
      </header>

      <PluginExperimentalNotice />

      {snapshot.safeMode ? (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl bg-warning-soft/30 px-3 py-2 text-[12px] text-warning">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t('safeMode.title')}</p>
            <p className="mt-0.5 text-[11px] text-warning/90">{t('safeMode.body')}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void usePluginStore
                .getState()
                .leaveSafeMode()
                .then(() => usePluginStore.getState().reload())
                .catch((error) => toast.error(String(error)))
            }
          >
            {t('safeMode.recover')}
          </Button>
        </div>
      ) : null}

      {loadError ? (
        <div className="mx-5 mt-3 rounded-xl bg-danger-soft/30 px-3 py-2 text-[12px] text-danger">
          <p className="font-semibold">{t('errors.loadFailed')}</p>
          <p className="mt-0.5 break-words text-[11px] text-danger/90">{loadError}</p>
        </div>
      ) : null}

      {conflictMessages.length > 0 ? (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-xl bg-warning-soft/30 px-3 py-2 text-[12px] text-warning">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t('conflicts.title')}</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-warning/90">
              {conflictMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as typeof tab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-5 mt-3 w-fit shrink-0">
          <TabsTrigger value="installed">
            {t('tabs.installed')}
            <span className="ml-1.5 text-[10px] text-foreground-subtle">
              {snapshot.plugins.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="discover">{t('tabs.discover')}</TabsTrigger>
          <TabsTrigger value="updates">
            {t('tabs.updates')}
            {updates.length > 0 ? (
              <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] text-accent-foreground">
                {updates.length}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full" type="auto">
            <div className="px-5 py-4">
              <TabsContent value="installed">
                {plugins.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-raised/20 px-6 py-12 text-center">
                    <Puzzle aria-hidden className="size-6 text-foreground-subtle" />
                    <p className="text-[13px] font-medium text-foreground">
                      {t('empty.installedTitle')}
                    </p>
                    <p className="max-w-md text-[12px] text-foreground-muted">
                      {t('empty.installedBody')}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => void openFilePicker()}>
                        <Upload aria-hidden className="size-3.5" />
                        {t('actions.installFile')}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setTab('discover')}>
                        {t('tabs.discover')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-2 xl:grid-cols-2">
                    {plugins.map((plugin) => (
                      <PluginCard
                        key={plugin.id}
                        plugin={plugin}
                        busy={busy}
                        onOpen={() => setDetailId(plugin.id)}
                        onToggle={(enabled) => void togglePlugin(plugin, enabled)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="discover">
                {storeLoading ? (
                  <div className="flex justify-center py-12">
                    <Spinner />
                  </div>
                ) : storeError || !settings.pluginRegistryUrl ? (
                  <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-raised/20 px-6 py-12 text-center">
                    <GlobePlaceholder />
                    <p className="text-[13px] font-medium text-foreground">
                      {t('store.unavailableTitle')}
                    </p>
                    <p className="max-w-md text-[12px] text-foreground-muted">
                      {storeError
                        ? t('store.unavailableBody', { error: storeError })
                        : t('store.configureBody')}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setSettingsOpen('plugins')}>
                        {t('actions.settings')}
                      </Button>
                      {settings.pluginRegistryUrl ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void usePluginStore.getState().refreshStore(true)}
                        >
                          <RefreshCw aria-hidden className="size-3.5" />
                          {t('actions.retry')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : discover.length === 0 ? (
                  <div className="rounded-xl bg-surface-raised/20 px-6 py-12 text-center text-[12px] text-foreground-muted">
                    {t('empty.discover')}
                  </div>
                ) : (
                  <div className="grid gap-2 xl:grid-cols-2">
                    {discover.map((candidate) => {
                      const installed =
        installedFor(snapshot.plugins, candidate.id) ??
        snapshot.plugins.find(
          (plugin) => plugin.publisherId === candidate.publisher.id && plugin.keyFingerprint,
        );
                      const isNewer =
                        installed && installed.version !== candidate.version;
                      return (
                        <div
                          key={candidate.id}
                          className="flex items-start gap-3 rounded-xl bg-surface-raised/40 p-3"
                        >
                          {candidate.icon ? (
                            <img
                              src={candidate.icon}
                              alt=""
                              className="size-[38px] rounded-lg object-cover"
                            />
                          ) : (
                            <span className="flex size-[38px] items-center justify-center rounded-lg bg-accent-soft text-accent">
                              <Puzzle aria-hidden className="size-4" />
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[13px] font-semibold text-foreground">
                                {candidate.name}
                              </span>
                              <span className="font-mono text-[10.5px] text-foreground-subtle">
                                v{candidate.version}
                              </span>
                              {candidate.publisher.name ? (
                                <span className="text-[10.5px] text-foreground-subtle">
                                  {candidate.publisher.name}
                                </span>
                              ) : null}
                              {candidate.channel ? (
                                <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-foreground-muted">
                                  {candidate.channel}
                                </span>
                              ) : null}
                              {candidate.registryUrl ? (
                                <span
                                  className="max-w-40 truncate font-mono text-[10px] text-foreground-subtle"
                                  title={candidate.registryUrl}
                                >
                                  {candidate.registryUrl.replace(/^https?:\/\//, '').split('/')[0]}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[11.5px] text-foreground-muted">
                              {candidate.summary || candidate.description}
                            </p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                              {installed ? (
                                <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] text-foreground-muted">
                                  {isNewer
                                    ? t('store.updateFrom', { version: installed.version })
                                    : t('store.installed')}
                                </span>
                              ) : null}
                              <span className="text-[10px] text-foreground-subtle">
                                {candidate.permissions.length}{' '}
                                {t('store.permissions')}
                              </span>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant={installed ? 'secondary' : 'primary'}
                            disabled={
                              busy ||
                              Boolean(installed && !isNewer) ||
                              candidate.yanked ||
                              Boolean(
                                store?.revoked.some(
                                  (entry) =>
                                    entry.id === candidate.id &&
                                    entry.version === candidate.version,
                                ),
                              )
                            }
                            onClick={() => {
                              if (installed) {
                                const update = updates.find(
                                  (entry) => entry.pluginId === candidate.id,
                                );
                                if (update) {
                                  setConsent({ kind: 'update', update });
                                  return;
                                }
                              }
                              setConsent({ kind: 'store', candidate });
                            }}
                          >
                            <Download aria-hidden className="size-3.5" />
                            {installed
                              ? isNewer
                                ? t('actions.update')
                                : t('store.installed')
                              : t('actions.install')}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="updates">
                {updatesLoading ? (
                  <div className="flex justify-center py-12">
                    <Spinner />
                  </div>
                ) : updates.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-raised/20 px-6 py-12 text-center">
                    <RefreshCw aria-hidden className="size-5 text-foreground-subtle" />
                    <p className="text-[13px] font-medium text-foreground">
                      {t('empty.updatesTitle')}
                    </p>
                    <p className="text-[12px] text-foreground-muted">{t('empty.updatesBody')}</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-1"
                      onClick={() => void usePluginStore.getState().checkUpdates(true)}
                    >
                      {t('actions.checkNow')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {updates.map((update) => (
                      <div
                        key={update.pluginId}
                        className="flex items-center gap-3 rounded-xl bg-surface-raised/40 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13px] font-semibold text-foreground">
                              {update.name}
                            </span>
                            <span className="font-mono text-[10.5px] text-foreground-subtle">
                              {update.currentVersion} → {update.latestVersion}
                            </span>
                            {update.newPermissions.length > 0 ? (
                              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning">
                                {t('detail.newPermissions', {
                                  count: update.newPermissions.length,
                                })}
                              </span>
                            ) : null}
                          </div>
                          {update.summary ? (
                            <p className="mt-0.5 truncate text-[11.5px] text-foreground-muted">
                              {update.summary}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => setConsent({ kind: 'update', update })}
                        >
                          {t('actions.update')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </div>
          </ScrollArea>
        </div>
      </Tabs>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-2 text-[11px] text-foreground-subtle">
        <span>
          {settings.pluginRegistryUrl
            ? t('footer.registry', { url: settings.pluginRegistryUrl })
            : t('footer.noRegistry')}
        </span>
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={() => {
            usePluginStore.getState().closeOverlays();
            setActiveView('chat');
          }}
        >
          {t('host.backToChat')}
        </button>
      </div>

      <ComponentSlot
        name="plugins.detail"
        fallback={PluginDetailDialog as unknown as PluginComponent}
        props={{ pluginId: detailId, onClose: () => setDetailId(null) }}
      />

      <PluginConsentDialog
        open={consent !== null}
        onOpenChange={(open) => !open && setConsent(null)}
        data={consentData}
        busy={consentBusy || busy}
        mode={consentMode}
        devMode={snapshot.devMode}
        onConfirm={(permissions, allowUnsigned, allowKeyRotation) =>
          void confirmConsent(permissions, allowUnsigned, allowKeyRotation)
        }
      />

      <Dialog open={urlDialog} onOpenChange={setUrlDialog}>
        <DialogContent className="w-[520px] max-w-[calc(100vw-2rem)]" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="text-[15px]">{t('url.title')}</DialogTitle>
            <DialogDescription className="text-[12px] text-foreground-muted">
              {t('url.description')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={urlValue}
            onChange={(event) => setUrlValue(event.target.value)}
            placeholder={t('url.placeholder')}
            autoFocus
            className="h-9 text-[12px]"
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setUrlDialog(false)}>
              {t('consent.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={urlBusy || !urlValue.trim()}
              onClick={() => void inspectUrl()}
            >
              {urlBusy ? t('url.inspecting') : t('url.inspect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GlobePlaceholder() {
  return (
    <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
      <Link2 aria-hidden className="size-5" />
    </span>
  );
}

export default PluginsView;
