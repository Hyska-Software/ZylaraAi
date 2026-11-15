/**
 * Installed plugin detail: identity, signature, permissions, tools, prompt,
 * skills, logs, secrets, theme and lifecycle actions.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FolderOpen,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
} from 'lucide-react';
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
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Spinner,
} from '@/components/ui';
import { api } from '@/lib/api';
import { openPluginPanel, openPluginView } from '@/lib/plugins/host';
import { pluginIcon } from '@/lib/plugins/icons';
import { pluginLabel, usePluginRegistry } from '@/lib/plugins/registry';
import { usePluginStore } from '@/lib/plugins/store';
import { useUiStore } from '@/lib/store/uiStore';
import { copyText } from '@/lib/utils';
import type {
  PluginAuditRow,
  PluginLogRow,
  PluginRecord,
  PluginRisk,
  PluginToolCallRow,
} from '@/lib/plugins/types';
import { pluginIconUrl } from '@/lib/plugins/urls';
import { cn } from '@/lib/utils';

const RISK_TONE: Record<PluginRisk, string> = {
  low: 'text-foreground-muted',
  medium: 'text-warning',
  high: 'text-warning',
  critical: 'text-danger',
};

function PluginAvatar({ plugin, size = 36 }: { plugin: PluginRecord; size?: number }) {
  const src = pluginIconUrl(plugin.id, plugin.icon);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="rounded-lg object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex items-center justify-center rounded-lg bg-accent-soft text-accent"
      style={{ width: size, height: size }}
    >
      <span aria-hidden className="text-[15px] font-semibold">
        {plugin.name.slice(0, 1).toUpperCase()}
      </span>
    </span>
  );
}

function SignaturePill({ status }: { status: string }) {
  const { t } = useTranslation('plugins');
  const verified = status === 'verified';
  const dev = status === 'dev';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
        verified
          ? 'bg-success-soft text-success'
          : dev
            ? 'bg-accent-soft text-accent'
            : 'bg-warning-soft text-warning',
      )}
    >
      {verified ? (
        <ShieldCheck aria-hidden className="size-3" />
      ) : (
        <ShieldQuestion aria-hidden className="size-3" />
      )}
      {verified
        ? t('signature.verified')
        : dev
          ? t('signature.dev')
          : t('signature.unsigned')}
    </span>
  );
}

export function PluginDetailDialog({
  pluginId,
  onClose,
}: {
  pluginId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('plugins');
  const plugin = usePluginStore((state) =>
    state.snapshot.plugins.find((candidate) => candidate.id === pluginId),
  );
  const updates = usePluginStore((state) => state.updates);
  const themes = usePluginStore((state) => state.themes);
  const activeTheme = usePluginStore((state) => state.activeTheme);
  const registry = usePluginRegistry();
  const [tab, setTab] = useState('overview');
  const [grants, setGrants] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<PluginLogRow[] | null>(null);
  const [audit, setAudit] = useState<PluginAuditRow[] | null>(null);
  const [toolCalls, setToolCalls] = useState<PluginToolCallRow[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsRevision, setLogsRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [keepData, setKeepData] = useState(true);
  const [secretKey, setSecretKey] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretNames, setSecretNames] = useState<string[]>([]);

  useEffect(() => {
    if (!plugin) return;
    setGrants(
      Object.fromEntries(
        plugin.permissions.map((permission) => [permission.id, permission.granted]),
      ),
    );
    setTab('overview');
    setLogs(null);
    setAudit(null);
    setToolCalls(null);
    setUninstallOpen(false);
    setSecretKey('');
    setSecretValue('');
    void usePluginStore
      .getState()
      .listSecrets(plugin.id)
      .then(setSecretNames)
      .catch(() => setSecretNames([]));
  }, [plugin?.id, plugin?.updatedAt]);

  useEffect(() => {
    if (!plugin || tab !== 'logs') return;
    setLogsLoading(true);
    void Promise.all([
      api.listPluginLogs(plugin.id, 150),
      api.listPluginAudit(plugin.id, 80),
      api.listPluginToolCalls(plugin.id, 80),
    ])
      .then(([nextLogs, nextAudit, nextCalls]) => {
        setLogs(nextLogs);
        setAudit(nextAudit);
        setToolCalls(nextCalls);
      })
      .catch((error) => {
        toast.error(t('detail.logsError'), { description: String(error) });
      })
      .finally(() => setLogsLoading(false));
  }, [plugin?.id, tab, t, logsRevision]);

  const views = useMemo(
    () => registry.views.filter((view) => view.plugin.id === pluginId),
    [registry.views, pluginId],
  );
  const panels = useMemo(
    () => registry.panels.filter((panel) => panel.plugin.id === pluginId),
    [registry.panels, pluginId],
  );
  const settingsTabs = useMemo(
    () => registry.settingsTabs.filter((entry) => entry.plugin.id === pluginId),
    [registry.settingsTabs, pluginId],
  );
  const pluginThemes = useMemo(
    () => themes.filter((entry) => entry.pluginId === pluginId),
    [themes, pluginId],
  );
  const update = updates.find((entry) => entry.pluginId === pluginId);

  if (!plugin || !pluginId) return null;

  const copyDiagnostics = async () => {
    const snapshot = usePluginStore.getState().snapshot;
    const payload = {
      exportedAt: new Date().toISOString(),
      snapshot: {
        safeMode: snapshot.safeMode,
        pluginsEnabled: snapshot.pluginsEnabled,
        allowTrusted: snapshot.allowTrusted,
        devMode: snapshot.devMode,
        configFingerprint: snapshot.configFingerprint,
      },
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        apiVersion: plugin.apiVersion,
        source: plugin.source,
        signatureStatus: plugin.signatureStatus,
        publisherId: plugin.publisherId,
        publisherName: plugin.publisherName,
        keyId: plugin.keyId,
        keyFingerprint: plugin.keyFingerprint,
        trusted: plugin.trusted,
        active: plugin.active,
        enabled: plugin.enabled,
        disabledReason: plugin.disabledReason,
        sizeBytes: plugin.sizeBytes,
        permissions: plugin.permissions,
        tools: plugin.tools,
        promptChars: plugin.promptChars,
        skillRoots: plugin.skillRoots,
        locales: plugin.locales,
      },
      logs: logs ?? [],
      audit: audit ?? [],
      toolCalls: toolCalls ?? [],
    };
    const ok = await copyText(JSON.stringify(payload, null, 2));
    if (ok) toast.success(t('detail.diagnosticsCopied'));
    else toast.error(t('detail.diagnosticsFailed'));
  };

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await usePluginStore.getState().reload();
    } catch (error) {
      toast.error(t('detail.actionFailed'), { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    try {
      await usePluginStore.getState().uninstall(plugin.id, keepData);
      onClose();
    } catch (error) {
      toast.error(t('detail.uninstallFailed'), { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSecret = async () => {
    if (!secretKey.trim()) return;
    try {
      await usePluginStore.getState().saveSecret(plugin.id, secretKey.trim(), secretValue);
      setSecretKey('');
      setSecretValue('');
      setSecretNames(await usePluginStore.getState().listSecrets(plugin.id));
      toast.success(t('detail.secretSaved'));
    } catch (error) {
      toast.error(t('detail.secretFailed'), { description: String(error) });
    }
  };

  return (
    <Dialog open={Boolean(pluginId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="h-[620px] w-[760px] max-w-[calc(100vw-2rem)] gap-0 p-0" aria-describedby={undefined}>
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3 pt-5">
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              <PluginAvatar plugin={plugin} size={42} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-[16px]">{plugin.name}</DialogTitle>
                <span className="font-mono text-[11px] text-foreground-subtle">
                  v{plugin.version}
                </span>
                <SignaturePill status={plugin.signatureStatus} />
                {plugin.trusted ? (
                  <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10.5px] font-medium text-danger">
                    {t('signature.trusted')}
                  </span>
                ) : null}
                {!plugin.active ? (
                  <span className="rounded-full bg-surface-active px-2 py-0.5 text-[10.5px] text-foreground-muted">
                    {t('installed.inactive')}
                  </span>
                ) : null}
              </div>
              <DialogDescription className="mt-1 text-[12px] text-foreground-muted">
                {plugin.publisherName} ·{' '}
                {plugin.description || t('detail.noDescription')}
              </DialogDescription>
            </div>
            <Switch
              checked={plugin.enabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void run(() => usePluginStore.getState().setEnabled(plugin.id, checked))
              }
              aria-label={t('detail.enableAria')}
            />
          </div>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 mt-3 w-fit shrink-0">
            <TabsTrigger value="overview">{t('detail.tabs.overview')}</TabsTrigger>
            <TabsTrigger value="permissions">
              {t('detail.tabs.permissions', { count: plugin.permissions.length })}
            </TabsTrigger>
            <TabsTrigger value="content">{t('detail.tabs.content')}</TabsTrigger>
            <TabsTrigger value="logs">{t('detail.tabs.logs')}</TabsTrigger>
            <TabsTrigger value="data">{t('detail.tabs.data')}</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full" type="auto">
              <div className="px-5 py-4">
                <TabsContent value="overview">
                  <div className="flex flex-col gap-5">
                    {plugin.disabledReason ? (
                      <div className="flex items-start gap-2 rounded-xl bg-warning-soft/30 px-3 py-2 text-[12px] text-warning">
                        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                        <div>
                          <p className="font-semibold">{t('detail.inactiveReason')}</p>
                          <p className="mt-0.5 font-mono text-[11px] text-warning/90">
                            {plugin.disabledReason}
                          </p>
                        </div>
                      </div>
                    ) : null}

                    <section className="grid grid-cols-2 gap-3 text-[12px]">
                      <div>
                        <p className="text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                          {t('detail.publisher')}
                        </p>
                        <p className="mt-0.5 text-foreground">{plugin.publisherName}</p>
                        <p className="font-mono text-[10.5px] text-foreground-subtle">
                          {plugin.publisherId}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                          {t('detail.installedAt')}
                        </p>
                        <p className="mt-0.5 text-foreground">
                          {new Date(plugin.installedAt).toLocaleString()}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                          {t('detail.signature')}
                        </p>
                        <p className="mt-0.5 break-all font-mono text-[10.5px] text-foreground-muted">
                          {plugin.keyFingerprint
                            ? plugin.keyFingerprint.slice(0, 32)
                            : plugin.keyId || t('signature.none')}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                          {t('detail.size')}
                        </p>
                        <p className="mt-0.5 text-foreground">
                          {(plugin.sizeBytes / 1024).toFixed(1)} KiB
                        </p>
                      </div>
                      <div>
                        <p className="text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                          {t('detail.source')}
                        </p>
                        <p className="mt-0.5 break-all text-foreground">{plugin.source}</p>
                      </div>
                      <div>
                        <p className="text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                          {t('detail.apiVersion')}
                        </p>
                        <p className="mt-0.5 text-foreground">v{plugin.apiVersion}</p>
                      </div>
                    </section>

                    {plugin.homepage ? (
                      <button
                        type="button"
                        className="inline-flex w-fit items-center gap-1.5 text-[12px] text-accent hover:underline"
                        onClick={() =>
                          void api
                            .pluginRpc(plugin.id, 'opener.open', { url: plugin.homepage })
                            .catch((error) => toast.error(String(error)))
                        }
                      >
                        <ExternalLink aria-hidden className="size-3.5" />
                        {t('detail.homepage')}
                      </button>
                    ) : null}

                    <section>
                      <p className="mb-1.5 text-[10.5px] uppercase tracking-wide text-foreground-subtle">
                        {t('detail.views')}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {[...views, ...panels, ...settingsTabs].length === 0 ? (
                          <span className="text-[12px] text-foreground-muted">
                            {t('detail.noUi')}
                          </span>
                        ) : (
                          views.map((view) => {
                            const Icon = pluginIcon(view.view.icon);
                            return (
                              <button
                                key={view.key}
                                type="button"
                                onClick={() => {
                                  onClose();
                                  openPluginView(plugin, view.view.id);
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-surface-raised px-2 py-1 text-[11.5px] text-foreground-muted hover:bg-surface-hover hover:text-foreground"
                              >
                                <Icon aria-hidden className="size-3.5" />
                                {pluginLabel(plugin, view.view.titleKey, view.view.title)}
                              </button>
                            );
                          })
                        )}
                        {panels.map((panel) => {
                          const Icon = pluginIcon(panel.panel.icon);
                          return (
                            <button
                              key={panel.key}
                              type="button"
                              onClick={() => {
                                onClose();
                                openPluginPanel(plugin, panel.panel.id);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-raised px-2 py-1 text-[11.5px] text-foreground-muted hover:bg-surface-hover hover:text-foreground"
                            >
                              <Icon aria-hidden className="size-3.5" />
                              {pluginLabel(plugin, panel.panel.titleKey, panel.panel.title)}
                            </button>
                          );
                        })}
                        {settingsTabs.map((tab) => {
                          const Icon = pluginIcon(tab.tab.icon);
                          return (
                            <button
                              key={tab.key}
                              type="button"
                              onClick={() => {
                                onClose();
                                useUiStore
                                  .getState()
                                  .openSettings(`plugin:${tab.key}`);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-raised px-2 py-1 text-[11.5px] text-foreground-muted hover:bg-surface-hover hover:text-foreground"
                            >
                              <Icon aria-hidden className="size-3.5" />
                              {pluginLabel(plugin, tab.tab.titleKey, tab.tab.title)}
                            </button>
                          );
                        })}
                      </div>
                    </section>

                    {update ? (
                      <div className="flex items-center justify-between gap-3 rounded-xl bg-accent-soft/20 px-3 py-2">
                        <div className="text-[12px]">
                          <p className="font-medium text-foreground">
                            {t('detail.updateAvailable', { version: update.latestVersion })}
                          </p>
                          {update.newPermissions.length > 0 ? (
                            <p className="text-[11px] text-warning">
                              {t('detail.newPermissions', {
                                count: update.newPermissions.length,
                              })}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              usePluginStore
                                .getState()
                                .updatePlugin(plugin.id, update.permissions),
                            )
                          }
                        >
                          <RefreshCw aria-hidden className="size-3.5" />
                          {t('actions.update')}
                        </Button>
                      </div>
                    ) : null}

                    <section className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void run(() => usePluginStore.getState().openDir(plugin.id))}
                      >
                        <FolderOpen aria-hidden className="size-3.5" />
                        {t('actions.openFolder')}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy || !plugin.previousVersion}
                        onClick={() =>
                          void run(() => usePluginStore.getState().rollback(plugin.id))
                        }
                      >
                        <RotateCcw aria-hidden className="size-3.5" />
                        {t('actions.rollback', { version: plugin.previousVersion ?? '—' })}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:bg-danger-soft"
                        disabled={busy}
                        onClick={() => setUninstallOpen(true)}
                      >
                        <Trash2 aria-hidden className="size-3.5" />
                        {t('actions.uninstall')}
                      </Button>
                    </section>

                    {uninstallOpen ? (
                      <section className="rounded-xl bg-danger-soft/20 p-3">
                        <p className="text-[12px] font-semibold text-danger">
                          {t('detail.uninstallTitle', { name: plugin.name })}
                        </p>
                        <label className="mt-2 flex items-center gap-2 text-[12px] text-foreground-muted">
                          <input
                            type="checkbox"
                            checked={keepData}
                            onChange={(event) => setKeepData(event.target.checked)}
                            className="size-3.5 accent-[var(--accent)]"
                          />
                          {t('detail.keepData')}
                        </label>
                        <div className="mt-3 flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setUninstallOpen(false)}>
                            {t('consent.cancel')}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void handleUninstall()}
                          >
                            {t('actions.uninstall')}
                          </Button>
                        </div>
                      </section>
                    ) : null}
                  </div>
                </TabsContent>

                <TabsContent value="permissions">
                  <div className="flex flex-col gap-3">
                    <p className="text-[12px] text-foreground-muted">
                      {t('detail.permissionsHint')}
                    </p>
                    {plugin.permissions.map((permission) => (
                      <label
                        key={permission.id}
                        className="flex cursor-pointer items-start gap-2 rounded-lg bg-surface-raised/40 px-3 py-2"
                      >
                        <input
                          type="checkbox"
                          checked={grants[permission.id] ?? false}
                          onChange={(event) =>
                            setGrants((current) => ({
                              ...current,
                              [permission.id]: event.target.checked,
                            }))
                          }
                          className="mt-0.5 size-3.5 accent-[var(--accent)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <code className="text-[11px] text-foreground">{permission.id}</code>
                            <span
                              className={cn(
                                'text-[10px] font-medium uppercase tracking-wide',
                                RISK_TONE[permission.risk],
                              )}
                            >
                              {t(`risk.${permission.risk}`)}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-[11px] text-foreground-muted">
                            {permission.description}
                          </span>
                        </span>
                      </label>
                    ))}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            usePluginStore
                              .getState()
                              .setPermissions(
                                plugin.id,
                                Object.entries(grants)
                                  .filter(([, granted]) => granted)
                                  .map(([permission]) => permission),
                              ),
                          )
                        }
                      >
                        {t('detail.savePermissions')}
                      </Button>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="content">
                  <div className="flex flex-col gap-5">
                    <section>
                      <h3 className="text-[12px] font-semibold text-foreground">
                        {t('detail.toolsTitle', { count: plugin.tools.length })}
                      </h3>
                      {plugin.tools.length === 0 ? (
                        <p className="mt-1 text-[12px] text-foreground-muted">
                          {t('detail.noTools')}
                        </p>
                      ) : (
                        <ul className="mt-2 flex flex-col gap-1.5">
                          {plugin.tools.map((tool) => (
                            <li
                              key={tool.wireName}
                              className="rounded-lg bg-surface-raised/40 px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center gap-1.5">
                                <code className="text-[11px] text-foreground">{tool.wireName}</code>
                                <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
                                  {tool.risk}
                                </span>
                                <span className="text-[10px] text-foreground-subtle">
                                  {tool.profiles.join(' + ')}
                                </span>
                              </div>
                              <p className="mt-1 text-[11px] text-foreground-muted">
                                {tool.description}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section>
                      <h3 className="text-[12px] font-semibold text-foreground">
                        {t('detail.promptTitle')}
                      </h3>
                      {plugin.prompt ? (
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-code-bg/40 p-3 text-[11px] leading-relaxed text-foreground-muted">
                          {plugin.prompt}
                        </pre>
                      ) : (
                        <p className="mt-1 text-[12px] text-foreground-muted">
                          {t('detail.noPrompt')}
                        </p>
                      )}
                    </section>

                    <section>
                      <h3 className="text-[12px] font-semibold text-foreground">
                        {t('detail.skillsTitle')}
                      </h3>
                      {plugin.skillRoots.length === 0 ? (
                        <p className="mt-1 text-[12px] text-foreground-muted">
                          {t('detail.noSkills')}
                        </p>
                      ) : (
                        <ul className="mt-2 flex flex-col gap-1 text-[11px] font-mono text-foreground-muted">
                          {plugin.skillRoots.map((root) => (
                            <li key={root}>{root}</li>
                          ))}
                        </ul>
                      )}
                    </section>
                  </div>
                </TabsContent>

                <TabsContent value="logs">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 flex-1 text-[12px] text-foreground-muted">{t('detail.logsHint')}</p>
                    <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={logsLoading}
                      onClick={() => void copyDiagnostics()}
                    >
                      <Copy aria-hidden className="size-3.5" />
                      {t('detail.copyDiagnostics')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={logsLoading}
                      onClick={() => setLogsRevision((value) => value + 1)}
                    >
                      <RefreshCw aria-hidden className="size-3.5" />
                      {t('actions.refresh')}
                    </Button>
                    </div>
                  </div>
                  {logsLoading ? (
                    <div className="flex justify-center py-8">
                      <Spinner />
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-col gap-4">
                      <section>
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                          {t('detail.logs')}
                        </h3>
                        <div className="mt-2 flex flex-col gap-1">
                          {(logs ?? []).length === 0 ? (
                            <p className="text-[12px] text-foreground-muted">
                              {t('detail.noLogs')}
                            </p>
                          ) : (
                            logs?.map((row) => (
                              <div
                                key={row.id}
                                className="flex items-start gap-2 rounded bg-surface-raised/40 px-2 py-1 text-[11px]"
                              >
                                <span className="w-14 shrink-0 text-foreground-subtle">
                                  {row.level}
                                </span>
                                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground-muted">
                                  {row.message}
                                </span>
                                <span className="shrink-0 text-[10px] text-foreground-subtle">
                                  {new Date(row.createdAt).toLocaleTimeString()}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </section>
                      <section>
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                          {t('detail.audit')}
                        </h3>
                        <div className="mt-2 flex flex-col gap-1">
                          {(audit ?? []).length === 0 ? (
                            <p className="text-[12px] text-foreground-muted">
                              {t('detail.noAudit')}
                            </p>
                          ) : (
                            audit?.map((row) => (
                              <div
                                key={row.id}
                                className="flex items-center gap-2 rounded bg-surface-raised/40 px-2 py-1 text-[11px]"
                              >
                                <code className="min-w-0 flex-1 truncate text-foreground-muted">
                                  {row.capability}
                                </code>
                                <span className="shrink-0 text-foreground-subtle">
                                  {row.decision}
                                </span>
                                <span className="shrink-0 text-[10px] text-foreground-subtle">
                                  {new Date(row.createdAt).toLocaleTimeString()}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </section>
                      <section>
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                          {t('detail.toolCalls')}
                        </h3>
                        <div className="mt-2 flex flex-col gap-1">
                          {(toolCalls ?? []).length === 0 ? (
                            <p className="text-[12px] text-foreground-muted">
                              {t('detail.noToolCalls')}
                            </p>
                          ) : (
                            toolCalls?.map((row) => (
                              <div
                                key={row.id}
                                className="flex items-center gap-2 rounded bg-surface-raised/40 px-2 py-1 text-[11px]"
                              >
                                <code className="min-w-0 flex-1 truncate text-foreground-muted">
                                  {row.tool}
                                </code>
                                <span className="shrink-0 text-foreground-subtle">
                                  {row.status}
                                  {row.durationMs != null ? ` · ${row.durationMs} ms` : ''}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </section>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="data">
                  <div className="flex flex-col gap-5">
                    <section className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void run(() => usePluginStore.getState().openDir(plugin.id))}
                      >
                        <FolderOpen aria-hidden className="size-3.5" />
                        {t('actions.openFolder')}
                      </Button>
                      <code className="break-all text-[10.5px] text-foreground-subtle">
                        {plugin.root}
                      </code>
                    </section>

                    <section className="flex items-center justify-between gap-3 rounded-lg bg-surface-raised/40 px-3 py-2">
                      <span className="text-[12px] text-foreground">
                        {t('detail.autoUpdate')}
                      </span>
                      <Switch
                        checked={plugin.autoUpdate}
                        onCheckedChange={(checked) =>
                          void run(() =>
                            usePluginStore.getState().setAutoUpdate(plugin.id, checked),
                          )
                        }
                      />
                    </section>

                    <section>
                      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
                        <KeyRound aria-hidden className="size-3.5" />
                        {t('detail.secretsTitle')}
                      </h3>
                      <p className="mt-1 text-[11px] text-foreground-muted">
                        {t('detail.secretsHint')}
                      </p>
                      <div className="mt-2 flex flex-col gap-1 text-[11px] font-mono text-foreground-muted">
                        {secretNames.length === 0 ? (
                          <span>{t('detail.noSecrets')}</span>
                        ) : (
                          secretNames.map((name) => <span key={name}>{name}</span>)
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <Input
                          value={secretKey}
                          onChange={(event) => setSecretKey(event.target.value)}
                          placeholder={t('detail.secretKey')}
                          className="h-8 w-40 text-[12px]"
                        />
                        <Input
                          value={secretValue}
                          onChange={(event) => setSecretValue(event.target.value)}
                          placeholder={t('detail.secretValue')}
                          type="password"
                          autoComplete="off"
                          className="h-8 w-56 text-[12px]"
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!secretKey.trim()}
                          onClick={() => void handleSaveSecret()}
                        >
                          {t('actions.save')}
                        </Button>
                      </div>
                    </section>

                    <section>
                      <h3 className="text-[12px] font-semibold text-foreground">
                        {t('detail.themesTitle')}
                      </h3>
                      {pluginThemes.length === 0 ? (
                        <p className="mt-1 text-[12px] text-foreground-muted">
                          {t('detail.noThemes')}
                        </p>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {pluginThemes.map((entry) => {
                            const selected =
                              activeTheme?.pluginId === plugin.id &&
                              activeTheme.themeId === entry.theme.id;
                            return (
                              <Button
                                key={entry.theme.id}
                                size="sm"
                                variant={selected ? 'secondary' : 'ghost'}
                                onClick={() =>
                                  usePluginStore.getState().setActiveTheme(
                                    selected
                                      ? null
                                      : { pluginId: plugin.id, themeId: entry.theme.id },
                                  )
                                }
                              >
                                {entry.theme.name}
                              </Button>
                            );
                          })}
                          {activeTheme?.pluginId === plugin.id ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => usePluginStore.getState().setActiveTheme(null)}
                            >
                              {t('detail.resetTheme')}
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </section>
                  </div>
                </TabsContent>
              </div>
            </ScrollArea>
          </div>
        </Tabs>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('host.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { PluginAvatar, SignaturePill };
