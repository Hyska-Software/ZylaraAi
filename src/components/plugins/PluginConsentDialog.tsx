/**
 * Install/update consent. Permissions are shown before anything is extracted;
 * trusted/critical permissions and new permissions are called out explicitly.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, KeyRound, ShieldCheck, ShieldQuestion } from 'lucide-react';

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
} from '@/components/ui';
import { pluginPermissionBase, pluginPermissionSpec } from '@/lib/plugins/contract';
import type { PluginPackageInspection, PluginRecord, PluginRisk } from '@/lib/plugins/types';
import { cn } from '@/lib/utils';

export interface PluginConsentData {
  id: string;
  name: string;
  version: string;
  publisher: string;
  signatureStatus: string;
  permissions: string[];
  newPermissions?: string[];
  trusted?: boolean;
  warnings?: string[];
  engineOk?: boolean;
  keyChanged?: boolean;
  keyFingerprint?: string | null;
  previousKeyFingerprint?: string | null;
}

const RISK_TONE: Record<PluginRisk, string> = {
  low: 'text-foreground-muted',
  medium: 'text-warning',
  high: 'text-warning',
  critical: 'text-danger',
};

export function PluginConsentDialog({
  open,
  onOpenChange,
  data,
  busy,
  mode,
  devMode,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: PluginConsentData | null;
  busy: boolean;
  mode: 'install' | 'update';
  devMode: boolean;
  onConfirm: (permissions: string[], allowUnsigned: boolean, allowKeyRotation: boolean) => void;
}) {
  const { t } = useTranslation('plugins');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [allowUnsigned, setAllowUnsigned] = useState(false);
  const [trustedPhrase, setTrustedPhrase] = useState('');
  const [keyPhrase, setKeyPhrase] = useState('');

  useEffect(() => {
    if (!open || !data) return;
    setChecked(Object.fromEntries(data.permissions.map((permission) => [permission, true])));
    setAllowUnsigned(false);
    setTrustedPhrase('');
    setKeyPhrase('');
  }, [open, data]);
  const keyChanged = Boolean(data?.keyChanged);

  const trusted =
    data?.trusted ||
    data?.permissions.some((permission) =>
      ['unsafe.renderer', 'ui.shell', 'ui.css.global', 'process.spawn', 'secrets.read'].includes(
        pluginPermissionBase(permission),
      ),
    );
  const critical = useMemo(
    () =>
      (data?.permissions ?? []).filter(
        (permission) => pluginPermissionSpec(permission)?.risk === 'critical',
      ),
    [data],
  );
  if (!data) return null;
  const unsigned = data.signatureStatus === 'unsigned';
  const signatureLabel =
    data.signatureStatus === 'verified'
      ? t('signature.verified')
      : data.signatureStatus === 'dev'
        ? t('signature.dev')
        : data.signatureStatus === 'invalid'
          ? t('signature.invalid')
          : t('signature.unsigned');
  const selected = Object.entries(checked)
    .filter(([, value]) => value)
    .map(([permission]) => permission);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[620px] max-w-[calc(100vw-2rem)] p-0" aria-describedby={undefined}>
        <DialogHeader className="border-b border-border px-5 pb-3 pr-12 pt-5">
          <DialogTitle className="text-[16px]">
            {mode === 'update'
              ? t('consent.updateTitle', { name: data.name })
              : t('consent.installTitle', { name: data.name })}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-foreground-muted">
            {t('consent.description', {
              version: data.version,
              publisher: data.publisher,
            })}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[52vh]">
          <div className="flex flex-col gap-4 px-5 py-4">
            <section className="rounded-xl bg-surface-raised/50 p-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="text-foreground-muted">{t('consent.publisher')}</span>
                <span className="font-medium text-foreground">{data.publisher}</span>
                <span className="text-foreground-subtle">·</span>
                <span className="text-foreground-muted">{t('consent.version')}</span>
                <span className="font-mono text-foreground">{data.version}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    data.signatureStatus === 'verified'
                      ? 'bg-success-soft text-success'
                      : data.signatureStatus === 'dev'
                        ? 'bg-accent-soft text-accent'
                        : 'bg-warning-soft text-warning',
                  )}
                >
                  {data.signatureStatus === 'verified' ? (
                    <ShieldCheck aria-hidden className="size-3" />
                  ) : (
                    <ShieldQuestion aria-hidden className="size-3" />
                  )}
                  {signatureLabel}
                </span>
                {data.trusted ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
                    <AlertTriangle aria-hidden className="size-3" />
                    {t('signature.trusted')}
                  </span>
                ) : null}
                {data.engineOk === false ? (
                  <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
                    {t('consent.engineMismatch')}
                  </span>
                ) : null}
              </div>
            </section>

            {trusted ? (
              <div className="rounded-xl bg-danger-soft/30 p-3 text-[12px] text-danger">
                <p className="font-semibold">{t('consent.trustedWarningTitle')}</p>
                <p className="mt-1 leading-relaxed text-danger/90">
                  {t('consent.trustedWarningBody')}
                </p>
                <label className="mt-3 block text-[11.5px] font-medium text-danger">
                  {t('consent.trustedConfirmLabel', { id: data.id })}
                  <Input
                    value={trustedPhrase}
                    onChange={(event) => setTrustedPhrase(event.target.value)}
                    placeholder={data.id}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1 h-8 bg-background/60 font-mono text-[12px] ring-1 ring-danger/40"
                  />
                </label>
                {trustedPhrase.trim().length > 0 &&
                trustedPhrase.trim() !== data.id ? (
                  <p className="mt-1 text-[11px] text-danger/90">
                    {t('consent.trustedConfirmMismatch')}
                  </p>
                ) : null}
              </div>
            ) : null}

            {keyChanged ? (
              <div className="rounded-xl bg-danger-soft/30 p-3 text-[12px] text-danger">
                <p className="font-semibold">{t('consent.keyChangedTitle')}</p>
                <p className="mt-1 leading-relaxed text-danger/90">
                  {t('consent.keyChangedBody')}
                </p>
                <code className="mt-2 block break-all font-mono text-[10.5px] text-danger/80">
                  {data.previousKeyFingerprint?.slice(0, 24) ?? '—'} →{' '}
                  {data.keyFingerprint?.slice(0, 24) ?? '—'}
                </code>
                <label className="mt-3 block text-[11.5px] font-medium text-danger">
                  {t('consent.keyConfirmLabel', { id: data.id })}
                  <Input
                    value={keyPhrase}
                    onChange={(event) => setKeyPhrase(event.target.value)}
                    placeholder={data.id}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1 h-8 bg-background/60 font-mono text-[12px] ring-1 ring-danger/40"
                  />
                </label>
                {keyPhrase.trim().length > 0 && keyPhrase.trim() !== data.id ? (
                  <p className="mt-1 text-[11px] text-danger/90">
                    {t('consent.keyConfirmMismatch')}
                  </p>
                ) : null}
              </div>
            ) : null}

            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold text-foreground">
                  {t('consent.permissionsTitle', { count: data.permissions.length })}
                </h3>
                <span className="inline-flex items-center gap-1 text-[11px] text-foreground-subtle">
                  <KeyRound aria-hidden className="size-3" />
                  {t('consent.permissionsHint')}
                </span>
              </div>
              {data.permissions.length === 0 ? (
                <p className="rounded-lg bg-surface-raised/40 px-3 py-2 text-[12px] text-foreground-muted">
                  {t('consent.noPermissions')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {data.permissions.map((permission) => {
                    const spec = pluginPermissionSpec(permission);
                    const base = pluginPermissionBase(permission);
                    const risk = (spec?.risk ?? 'critical') as PluginRisk;
                    const isNew = data.newPermissions?.includes(permission);
                    return (
                      <li key={permission}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 transition-colors',
                            isNew
                              ? 'bg-accent-soft/20'
                              : 'bg-surface-raised/30',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked[permission] ?? false}
                            onChange={(event) =>
                              setChecked((current) => ({
                                ...current,
                                [permission]: event.target.checked,
                              }))
                            }
                            className="mt-0.5 size-3.5 accent-[var(--accent)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <code className="text-[11px] font-medium text-foreground">
                                {base}
                              </code>
                              {permission !== base ? (
                                <span className="text-[10.5px] text-foreground-subtle">
                                  {permission.slice(base.length + 1)}
                                </span>
                              ) : null}
                              <span
                                className={cn(
                                  'text-[10px] font-medium uppercase tracking-wide',
                                  RISK_TONE[risk],
                                )}
                              >
                                {t(`risk.${risk}`)}
                              </span>
                              {isNew ? (
                                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                  {t('consent.newPermission')}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-relaxed text-foreground-muted">
                              {spec?.description ?? t('consent.unknownPermission')}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {unsigned && devMode ? (
              <label className="flex items-start gap-2 rounded-xl bg-warning-soft/30 px-3 py-2 text-[12px] text-warning">
                <input
                  type="checkbox"
                  checked={allowUnsigned}
                  onChange={(event) => setAllowUnsigned(event.target.checked)}
                  className="mt-0.5 size-3.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="font-semibold">{t('consent.allowUnsigned')}</span>
                  <span className="mt-0.5 block text-[11px] text-warning/90">
                    {t('consent.allowUnsignedHint')}
                  </span>
                </span>
              </label>
            ) : null}

            {critical.length > 0 ? (
              <p className="text-[11px] leading-relaxed text-danger">
                {t('consent.criticalHint', { count: critical.length })}
              </p>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('consent.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onConfirm(
                selected,
                allowUnsigned,
                keyChanged && keyPhrase.trim() === data.id,
              )
            }
            disabled={
              busy ||
              (unsigned && !allowUnsigned) ||
              (trusted && trustedPhrase.trim() !== data.id) ||
              (keyChanged && keyPhrase.trim() !== data.id)
            }
          >
            {busy
              ? t('consent.installing')
              : mode === 'update'
                ? t('consent.update')
                : t('consent.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function consentFromInspection(
  inspection: PluginPackageInspection,
  newPermissions: string[] = [],
  installed?: PluginRecord,
): PluginConsentData {
  const keyChanged = Boolean(
    installed?.keyFingerprint &&
      inspection.keyFingerprint &&
      installed.keyFingerprint !== inspection.keyFingerprint,
  );
  return {
    id: inspection.manifest.id,
    name: inspection.manifest.name,
    version: inspection.manifest.version,
    publisher: inspection.manifest.publisher.name,
    signatureStatus: inspection.signatureStatus,
    permissions: inspection.permissions,
    newPermissions,
    trusted: inspection.manifest.trusted,
    warnings: inspection.warnings,
    engineOk: inspection.engineOk,
    keyChanged,
    keyFingerprint: inspection.keyFingerprint,
    previousKeyFingerprint: installed?.keyFingerprint,
  };
}
