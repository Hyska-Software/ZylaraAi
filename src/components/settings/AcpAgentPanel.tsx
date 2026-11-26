import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle2, LogIn, LogOut, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAppStore } from '@/lib/store';
import type { AcpAgentView, AcpAuthView, AcpCapabilities, AcpCustomAgentInput } from '@/lib/types';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
  Textarea,
} from '@/components/ui';
import { AcpRegistryDialog } from './AcpRegistryDialog';
import { ProviderGlyph } from './ProviderGlyph';

export interface AcpAgentPanelProps {
  /** Allows embedding the panel in another settings surface. */
  className?: string;
}

interface TestResult {
  ok: boolean;
  text: string;
}

const AUTH_STATES = ['unknown', 'ready', 'auth_required', 'authenticated', 'signed-in', 'error'];

function capabilitiesFrom(agent: AcpAgentView): AcpCapabilities {
  return {
    fs: agent.supportsFs,
    terminal: agent.supportsTerminal,
    elicitation: agent.supportsElicitation,
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseEnv(raw: string): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const separator = line.indexOf('=');
    const key = separator < 0 ? '' : line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
    env[key] = line.slice(separator + 1).trim();
  }
  return env;
}

/** Settings surface for installed ACP agents; uses the regular model picker. */
export function AcpAgentPanel({ className }: AcpAgentPanelProps) {
  const { t } = useTranslation('settings');
  const agents = useAppStore((state) => state.acpAgents);
  const loadRegistry = useAppStore((state) => state.loadRegistry);
  const setTrusted = useAppStore((state) => state.setTrusted);
  const removeAgent = useAppStore((state) => state.removeAgent);
  const enableAgent = useAppStore((state) => state.enableAgent);
  const rescanDevices = useAppStore((state) => state.rescanDevices);
  const testAgent = useAppStore((state) => state.testAgent);
  const authStatus = useAppStore((state) => state.authStatus);
  const acpAuthAction = useAppStore((state) => state.acpAuthAction);
  const addCustomAgent = useAppStore((state) => state.addCustomAgent);

  const [registryOpen, setRegistryOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<Record<string, AcpCapabilities>>({});
  const [methods, setMethods] = useState<Record<string, AcpAuthView['methods']>>({});
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<AcpAgentView | null>(null);
  const [custom, setCustom] = useState({ name: '', command: '', args: '', env: '', cwd: '' });

  useEffect(() => {
    void loadRegistry();
  }, [loadRegistry]);

  useEffect(() => {
    setCapabilities((current) => {
      const next = { ...current };
      for (const agent of agents) {
        if (!next[agent.id]) next[agent.id] = capabilitiesFrom(agent);
      }
      return next;
    });
  }, [agents]);

  const authLabel = (state: string) =>
    t(
      AUTH_STATES.includes(state)
        ? `providers.acp.auth.${state}`
        : 'providers.acp.auth.unknown',
    );

  const runBusy = async (agentId: string, action: () => Promise<void>) => {
    setBusy(agentId);
    setError(null);
    try {
      await action();
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.error(t('providers.acp.toasts.failed', { message }));
    } finally {
      setBusy(null);
    }
  };

  const updateTrust = (agent: AcpAgentView, trusted: boolean, caps: AcpCapabilities) =>
    runBusy(agent.id, async () => {
      const view = await setTrusted(agent.id, trusted, caps);
      setCapabilities((current) => ({
        ...current,
        [agent.id]: capabilitiesFrom(view),
      }));
      toast.success(t('providers.acp.toasts.trusted', { name: agent.name }));
    });

  const updateCapability = (
    agent: AcpAgentView,
    key: keyof AcpCapabilities,
    value: boolean,
  ) => {
    const caps = { ...(capabilities[agent.id] ?? capabilitiesFrom(agent)), [key]: value };
    setCapabilities((current) => ({ ...current, [agent.id]: caps }));
    return runBusy(agent.id, async () => {
      const view = await setTrusted(agent.id, agent.trusted, caps);
      setCapabilities((current) => ({ ...current, [agent.id]: capabilitiesFrom(view) }));
    });
  };

  const runTest = (agent: AcpAgentView) =>
    runBusy(agent.id, async () => {
      const result = await testAgent(agent.id);
      setTests((current) => ({
        ...current,
        [agent.id]: result.ok
          ? { ok: true, text: t('providers.acp.testOk', { count: result.models }) }
          : {
              ok: false,
              text: t('providers.acp.testFailed', {
                message: result.message ?? t('providers.acp.auth.error'),
              }),
            },
      }));
    });

  const signIn = (agent: AcpAgentView) =>
    runBusy(agent.id, async () => {
      const view = await authStatus(agent.id, { acp: true });
      setMethods((current) => ({ ...current, [agent.id]: view.methods }));
      if (view.methods.length === 1) await loginWith(agent, view.methods[0].kind, view.methods[0].id);
    });

  const loginWith = (agent: AcpAgentView, kind: string, methodId: string) =>
    runBusy(agent.id, async () => {
      await acpAuthAction(agent.id, {
        kind: kind === 'terminal' ? 'terminalLogin' : 'login',
        methodId,
      });
    });

  const signOut = (agent: AcpAgentView) =>
    runBusy(agent.id, async () => {
      await acpAuthAction(agent.id, { kind: 'logout' });
    });

  const confirmRemove = () => {
    const agent = pendingRemove;
    if (!agent) return;
    setPendingRemove(null);
    void runBusy(agent.id, async () => {
      await removeAgent(agent.id);
      toast.success(t('providers.acp.toasts.removed', { name: agent.name }));
    });
  };

  const submitCustom = () => {
    const name = custom.name.trim();
    const command = custom.command.trim();
    const env = parseEnv(custom.env);
    if (!name) {
      setCustomError(t('providers.acp.custom.errors.name'));
      return;
    }
    if (!command) {
      setCustomError(t('providers.acp.custom.errors.command'));
      return;
    }
    if (!env) {
      setCustomError(t('providers.acp.custom.errors.env'));
      return;
    }
    setCustomError(null);
    void runBusy('custom', async () => {
      const input: AcpCustomAgentInput = {
        name,
        command,
        args: custom.args.split('\n').map((value) => value.trim()).filter(Boolean),
        env,
        cwd: custom.cwd.trim() || null,
      };
      const view = await addCustomAgent(input);
      toast.success(t('providers.acp.toasts.added', { name: view.name }));
      setCustom({ name: '', command: '', args: '', env: '', cwd: '' });
      setCustomOpen(false);
    });
  };

  return (
    <section className="flex flex-col gap-2" aria-label={t('providers.acp.title')} {...(className ? { className } : {})}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold tracking-tight text-foreground">
            {t('providers.acp.title')}
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">
            {t('providers.acp.description')}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Search aria-hidden className="size-3.5" />}
            onClick={() => setRegistryOpen(true)}
          >
            {t('providers.acp.browse')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Plus aria-hidden className="size-3.5" />}
            onClick={() => {
              setCustomError(null);
              setCustomOpen(true);
            }}
          >
            {t('providers.acp.addCustom')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'rescan'}
            onClick={() => void runBusy('rescan', async () => {
              await rescanDevices();
            })}
          >
            {t('providers.acp.rescan')}
          </Button>
        </div>
      </div>

      <div
        role="status"
        className="flex gap-2.5 rounded-xl bg-warning-soft p-3 text-[11px] leading-relaxed text-warning"
      >
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-semibold">{t('providers.acp.experimentalTitle')}</span>{' '}
          {t('providers.acp.experimentalHint')}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}

      {agents.length === 0 ? (
        <p className="text-xs leading-relaxed text-foreground-muted">{t('providers.acp.empty')}</p>
      ) : (
        <div className="rounded-xl bg-surface">
          <ul className="divide-y divide-border">
            {agents.map((agent) => {
              const caps = capabilities[agent.id] ?? capabilitiesFrom(agent);
              const signedIn = agent.authState === 'ready' || agent.authState === 'authenticated';
              const result = tests[agent.id];
              return (
                <li key={agent.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ProviderGlyph
                      providerId={agent.id}
                      name={agent.name}
                      iconSvg={agent.iconSvg}
                      size={20}
                    />
                    <p className="text-[13px] font-medium text-foreground">{agent.name}</p>
                    <Badge tone="neutral">{agent.version}</Badge>
                    {agent.source === 'detected' ? (
                      <Badge tone="neutral">{t('providers.acp.source.detected')}</Badge>
                    ) : null}
                    <Badge
                      tone={
                        agent.authState === 'error'
                          ? 'danger'
                          : signedIn || agent.authState === 'signed-in'
                            ? 'success'
                            : 'warning'
                      }
                    >
                      {authLabel(agent.authState)}
                    </Badge>
                    <span className="text-[11px] text-foreground-muted">
                      {t('providers.acp.models', { count: agent.modelCount })}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
                    {agent.description}
                  </p>
                  {agent.command ? (
                    <p className="mt-1 text-[11px] text-foreground-muted">
                      <span className="text-foreground">{t('providers.acp.command')}:</span>{' '}
                      <code className="font-mono">
                        {[agent.command, ...agent.args].join(' ')}
                      </code>
                    </p>
                  ) : null}
                  {agent.envNames.length ? (
                    <p className="mt-0.5 text-[11px] text-foreground-muted">
                      {t('providers.acp.envNames')}: {agent.envNames.join(', ')}
                    </p>
                  ) : null}
                  {agent.authHint ? (
                    <p className="mt-1 text-[11px] text-foreground-muted">{agent.authHint}</p>
                  ) : null}
                  {agent.lastError ? (
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-danger">
                      <AlertCircle role="img" aria-label={t('providers.acp.lastError')} className="size-3.5" />
                      {agent.lastError}
                    </p>
                  ) : null}

                  {agent.enabled ? (
                    <>
                      <div className="mt-2 flex items-center gap-2">
                        <ShieldCheck
                          role="img"
                          aria-label={t('providers.acp.trust.label')}
                          className={`size-3.5 ${agent.trusted ? 'text-success' : 'text-foreground-subtle'}`}
                        />
                        <Switch
                          checked={agent.trusted}
                          disabled={busy === agent.id}
                          label={t('providers.acp.trust.label')}
                          onCheckedChange={(trusted) => void updateTrust(agent, trusted, caps)}
                        />
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-foreground-muted">
                        {t('providers.acp.trust.warning')}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {(
                          [
                            ['fs', 'fs'],
                            ['terminal', 'terminal'],
                            ['elicitation', 'elicitation'],
                          ] as const
                        ).map(([key, labelKey]) => (
                          <label
                            key={key}
                            className="flex items-center gap-1.5 text-[11px] text-foreground-muted"
                          >
                            <input
                              type="checkbox"
                              className="size-3.5 accent-accent"
                              aria-label={t(`providers.acp.trust.${labelKey}`)}
                              disabled={!agent.trusted || busy === agent.id}
                              checked={caps[key]}
                              onChange={(event) =>
                                void updateCapability(agent, key, event.target.checked)
                              }
                            />
                            {t(`providers.acp.trust.${labelKey}`)}
                          </label>
                        ))}
                      </div>
                    </>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={agent.enabled ? 'ghost' : 'primary'}
                      loading={busy === agent.id}
                      onClick={() => void runBusy(agent.id, async () => {
                        await enableAgent(agent.id, !agent.enabled);
                      })}
                    >
                      {agent.enabled ? t('providers.acp.disable') : t('providers.acp.enable')}
                    </Button>
                    {agent.enabled ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === agent.id}
                          onClick={() => void runTest(agent)}
                        >
                          {t('providers.acp.test')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={
                            signedIn ? (
                              <LogOut aria-hidden className="size-3.5" />
                            ) : (
                              <LogIn aria-hidden className="size-3.5" />
                            )
                          }
                          loading={busy === agent.id}
                          onClick={() => void (signedIn ? signOut(agent) : signIn(agent))}
                        >
                          {signedIn ? t('providers.acp.signOut') : t('providers.acp.signIn')}
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      leftIcon={<Trash2 aria-hidden className="size-3.5" />}
                      aria-label={t('providers.acp.remove', { name: agent.name })}
                      onClick={() => setPendingRemove(agent)}
                    >
                      {t('providers.acp.remove')}
                    </Button>
                    {result ? (
                      <span
                        role="status"
                        className={`inline-flex items-center gap-1.5 text-[11px] ${
                          result.ok ? 'text-success' : 'text-danger'
                        }`}
                      >
                        {result.ok ? (
                          <CheckCircle2 aria-hidden className="size-3.5" />
                        ) : (
                          <AlertCircle aria-hidden className="size-3.5" />
                        )}
                        {result.text}
                      </span>
                    ) : null}
                  </div>

                  {methods[agent.id] && methods[agent.id].length > 1 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {methods[agent.id].map((method) => (
                        <Button
                          key={method.id}
                          size="sm"
                          variant="subtle"
                          onClick={() => void loginWith(agent, method.kind, method.id)}
                        >
                          {method.name}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <AcpRegistryDialog open={registryOpen} onOpenChange={setRegistryOpen} />

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent size="md" className="p-0">
          <DialogHeader className="gap-1 pr-12">
            <DialogTitle>{t('providers.acp.custom.title')}</DialogTitle>
            <DialogDescription>{t('providers.acp.custom.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 py-2">
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-[11px] leading-relaxed">
              {t('providers.acp.custom.warning')}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="acp-custom-name">{t('providers.acp.custom.name')}</Label>
              <Input
                id="acp-custom-name"
                placeholder={t('providers.acp.custom.namePlaceholder')}
                value={custom.name}
                onChange={(event) => setCustom((current) => ({ ...current, name: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acp-custom-command">{t('providers.acp.custom.command')}</Label>
              <Input
                id="acp-custom-command"
                placeholder={t('providers.acp.custom.commandPlaceholder')}
                value={custom.command}
                onChange={(event) =>
                  setCustom((current) => ({ ...current, command: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acp-custom-args">{t('providers.acp.custom.args')}</Label>
              <Textarea
                id="acp-custom-args"
                rows={3}
                value={custom.args}
                onChange={(event) => setCustom((current) => ({ ...current, args: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acp-custom-env">{t('providers.acp.custom.env')}</Label>
              <Textarea
                id="acp-custom-env"
                rows={3}
                value={custom.env}
                onChange={(event) => setCustom((current) => ({ ...current, env: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acp-custom-cwd">{t('providers.acp.custom.cwd')}</Label>
              <Input
                id="acp-custom-cwd"
                value={custom.cwd}
                onChange={(event) => setCustom((current) => ({ ...current, cwd: event.target.value }))}
              />
            </div>
            {customError ? (
              <p role="alert" className="text-xs text-danger">
                {customError}
              </p>
            ) : null}
          </div>
          <DialogFooter className="border-0 px-6 py-3">
            <Button variant="ghost" onClick={() => setCustomOpen(false)}>
              {t('providers.acp.custom.cancel')}
            </Button>
            <Button variant="primary" loading={busy === 'custom'} onClick={submitCustom}>
              {t('providers.acp.custom.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingRemove != null} onOpenChange={(next) => !next && setPendingRemove(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {t('providers.acp.removeTitle', { name: pendingRemove?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('providers.acp.removeBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingRemove(null)}>
              {t('providers.acp.cancel')}
            </Button>
            <Button variant="danger" onClick={confirmRemove}>
              {t('providers.acp.removeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
