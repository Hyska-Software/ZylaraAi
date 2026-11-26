import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';

import { openExternal } from '@/lib/genui/open-external';
import { useAppStore } from '@/lib/store';
import type { AcpRegistryAgent } from '@/lib/types';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
} from '@/components/ui';
import { ProviderGlyph } from './ProviderGlyph';

export interface AcpRegistryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Searchable view of the signed ACP registry. Listing never executes a command. */
export function AcpRegistryDialog({ open, onOpenChange }: AcpRegistryDialogProps) {
  const { t } = useTranslation('settings');
  const registry = useAppStore((state) => state.acpRegistry);
  const loadRegistry = useAppStore((state) => state.loadRegistry);
  const refreshRegistry = useAppStore((state) => state.refreshRegistry);
  const installAgent = useAppStore((state) => state.installAgent);
  const installedAgents = useAppStore((state) => state.acpAgents);
  const [query, setQuery] = useState('');
  const [consented, setConsented] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void loadRegistry();
  }, [open, loadRegistry]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return registry;
    return registry.filter((agent) =>
      [agent.id, agent.name, agent.description, agent.license ?? ''].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    );
  }, [query, registry]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshRegistry(true);
    } finally {
      setRefreshing(false);
    }
  };

  const install = async (agent: AcpRegistryAgent) => {
    if (!consented[agent.id] || !agent.supported || agent.installed) return;
    setBusy(agent.id);
    setError(null);
    try {
      await installAgent(agent.id, true);
      toast.success(t('providers.acp.toasts.installed', { name: agent.name }));
      setConsented((current) => ({ ...current, [agent.id]: false }));
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.error(t('providers.acp.toasts.failed', { message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg" className="p-0">
        <DialogHeader className="gap-1 pr-12">
          <DialogTitle>{t('providers.acp.registry.title')}</DialogTitle>
          <DialogDescription>{t('providers.acp.registry.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 px-6">
          <div className="relative flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle"
            />
            <Input
              className="pl-9"
              aria-label={t('providers.acp.registry.search')}
              placeholder={t('providers.acp.registry.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <IconButton
            label={t('providers.acp.registry.refresh')}
            loading={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden className="size-4" />
          </IconButton>
        </div>


        {error ? (
          <p role="alert" className="mx-6 mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-foreground-muted">
              {t('providers.acp.registry.empty', { query })}
            </p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((agent) => (
                <li
                  key={agent.id}
                  className="rounded-xl bg-surface-hover px-3 py-3"
                  aria-label={agent.name}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ProviderGlyph
                      providerId={`acp__${agent.id}`}
                      name={agent.name}
                      iconSvg={
                        agent.iconSvg
                        ?? installedAgents.find((installed) => installed.registryId === agent.id)?.iconSvg
                      }
                      size={20}
                    />
                    <p className="text-[13px] font-medium text-foreground">{agent.name}</p>
                    <Badge tone="neutral">{agent.version}</Badge>
                    {agent.installed ? (
                      <Badge tone="success">{t('providers.acp.registry.installed')}</Badge>
                    ) : null}
                    <Badge tone={agent.supported ? 'success' : 'warning'}>
                      {agent.supported ? (
                        <CheckCircle2
                          role="img"
                          aria-label={t('providers.acp.registry.supported')}
                          className="size-3"
                        />
                      ) : (
                        <AlertTriangle
                          role="img"
                          aria-label={t('providers.acp.registry.unsupported')}
                          className="size-3"
                        />
                      )}
                      {agent.supported
                        ? t('providers.acp.registry.supported')
                        : t('providers.acp.registry.unsupported')}
                    </Badge>
                  </div>

                  <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
                    {agent.description}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground-muted">
                    {agent.license ? (
                      <span>{t('providers.acp.registry.license', { license: agent.license })}</span>
                    ) : null}
                    {agent.homepage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="-mx-2"
                        aria-label={t('providers.acp.registry.homepage')}
                        rightIcon={<ExternalLink aria-hidden className="size-3" />}
                        onClick={() => void openExternal(agent.homepage!)}
                      >
                        {t('providers.acp.registry.homepage')}
                      </Button>
                    ) : null}
                    {agent.repository ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="-mx-2"
                        aria-label={t('providers.acp.registry.repository')}
                        rightIcon={<ExternalLink aria-hidden className="size-3" />}
                        onClick={() => void openExternal(agent.repository!)}
                      >
                        {t('providers.acp.registry.repository')}
                      </Button>
                    ) : null}
                    {agent.distributions.map((distribution) => (
                      <Badge key={distribution} tone="outline">
                        {distribution}
                      </Badge>
                    ))}
                  </div>

                  {!agent.supported && agent.installReason ? (
                    <p className="mt-1 text-[11px] text-warning">
                      {t('providers.acp.registry.installReason', { reason: agent.installReason })}
                    </p>
                  ) : null}

                  {!agent.installed && agent.supported ? (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <label className="flex min-w-0 flex-1 items-start gap-2 text-[11px] leading-relaxed text-foreground-muted">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-3.5 shrink-0 accent-accent"
                          aria-label={t('providers.acp.registry.consent')}
                          checked={Boolean(consented[agent.id])}
                          onChange={(event) =>
                            setConsented((current) => ({
                              ...current,
                              [agent.id]: event.target.checked,
                            }))
                          }
                        />
                        <span>{t('providers.acp.registry.consent')}</span>
                      </label>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busy === agent.id}
                        disabled={!consented[agent.id]}
                        onClick={() => void install(agent)}
                      >
                        {t('providers.acp.registry.install')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="border-0 px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('providers.acp.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
