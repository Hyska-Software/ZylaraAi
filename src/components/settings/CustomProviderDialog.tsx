import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { CustomProviderInput, ProviderInfo } from '@/lib/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  Label,
  Switch,
} from '@/components/ui';

const ID_PREFIX = 'custom__';

/** Field that failed the client-side validation (drives the invalid styling). */
type InvalidField = 'name' | 'id' | 'baseUrl' | 'models';

/** Input element id of each validatable field (used to focus the first error). */
const FIELD_ELEMENT_IDS: Record<Exclude<InvalidField, 'models'>, string> = {
  name: 'custom-provider-name',
  id: 'custom-provider-id',
  baseUrl: 'custom-provider-base',
};

/**
 * Plain HTTP is only allowed to loopback hosts (Ollama, LM Studio, vLLM),
 * mirroring `providers/custom.rs::validate_base_url`.
 */
const LOOPBACK_HTTP = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

function isAcceptableBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  return /^https:\/\//i.test(trimmed) || LOOPBACK_HTTP.test(trimmed);
}

interface ModelRow {
  id: string;
  name: string;
  reasoning: boolean;
  attachment: boolean;
}

function emptyModel(): ModelRow {
  return { id: '', name: '', reasoning: false, attachment: false };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function modelRowsFrom(provider: ProviderInfo): ModelRow[] {
  return provider.models.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: Boolean(model.reasoning),
    attachment: Boolean(model.attachment),
  }));
}

export interface CustomProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Provider being edited; `null` creates a new one. */
  provider?: ProviderInfo | null;
}

/**
 * Creates or edits a user-defined OpenAI-compatible provider. Any endpoint that
 * speaks the `openai-chat` protocol works; the API key is entered through the
 * normal provider form afterwards.
 */
export function CustomProviderDialog({ open, onOpenChange, provider }: CustomProviderDialogProps) {
  const { t } = useTranslation('settings');
  const reloadCatalog = useAppStore((state) => state.reloadCatalog);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [consoleUrl, setConsoleUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [authPrefix, setAuthPrefix] = useState('');
  const [models, setModels] = useState<ModelRow[]>([emptyModel()]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<InvalidField | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setErrorField(null);
    setSaving(false);
    setAdvancedOpen(false);
    if (provider) {
      setName(provider.name);
      setSlug(provider.id.startsWith(ID_PREFIX) ? provider.id.slice(ID_PREFIX.length) : provider.id);
      setSlugTouched(true);
      setBaseUrl(provider.baseUrl);
      setConsoleUrl(provider.consoleUrl ?? '');
      setAuthHeader(provider.authHeader ?? '');
      setAuthPrefix(provider.authPrefix ?? '');
      const rows = modelRowsFrom(provider);
      setModels(rows.length ? rows : [emptyModel()]);
    } else {
      setName('');
      setSlug('');
      setSlugTouched(false);
      setBaseUrl('');
      setConsoleUrl('');
      setAuthHeader('');
      setAuthPrefix('');
      setModels([emptyModel()]);
    }
  }, [open, provider]);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  /** Any edit drops the current validation message so it never goes stale. */
  const clearError = () => {
    setError(null);
    setErrorField(null);
  };

  const fail = (field: InvalidField, message: string) => {
    setErrorField(field);
    setError(message);
    // Move the caret to the offending field so the alert is never off-screen.
    const target = document.getElementById(
      field === 'models' ? 'custom-provider-model-0-id' : FIELD_ELEMENT_IDS[field],
    );
    if (target instanceof HTMLInputElement && !target.disabled) target.focus();
  };

  const updateModel = (index: number, patch: Partial<ModelRow>) => {
    clearError();
    setModels((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  const submit = async () => {
    const trimmedSlug = effectiveSlug.trim();
    const cleanedModels = models
      .map((row) => ({
        id: row.id.trim(),
        name: row.name.trim() || row.id.trim(),
        reasoning: row.reasoning,
        attachment: row.attachment,
      }))
      .filter((row) => row.id.length > 0);
    if (!name.trim()) {
      fail('name', t('providers.custom.errors.name'));
      return;
    }
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(trimmedSlug)) {
      fail('id', t('providers.custom.errors.id'));
      return;
    }
    if (!isAcceptableBaseUrl(baseUrl)) {
      fail('baseUrl', t('providers.custom.errors.baseUrl'));
      return;
    }
    if (cleanedModels.length === 0) {
      fail('models', t('providers.custom.errors.models'));
      return;
    }
    const payload: CustomProviderInput = {
      id: trimmedSlug,
      name: name.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      consoleUrl: consoleUrl.trim() || undefined,
      authHeader: authHeader.trim() || undefined,
      authPrefix: authPrefix || undefined,
      models: cleanedModels,
    };
    setSaving(true);
    clearError();
    try {
      await api.saveCustomProvider(payload);
      await reloadCatalog();
      toast.success(t('providers.custom.saved', { name: payload.name }));
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeModel = (index: number) => {
    clearError();
    setModels((current) =>
      current.length > 1 ? current.filter((_, at) => at !== index) : [emptyModel()],
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="p-0">
        <DialogHeader className="gap-1 pr-12">
          <DialogTitle>
            {provider ? t('providers.custom.editTitle', { name: provider.name }) : t('providers.custom.title')}
          </DialogTitle>
          <DialogDescription>{t('providers.custom.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 pb-5 pt-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="custom-provider-name">{t('providers.custom.name')}</Label>
              <Input
                id="custom-provider-name"
                value={name}
                maxLength={80}
                autoFocus
                placeholder={t('providers.custom.namePlaceholder')}
                invalid={errorField === 'name'}
                onChange={(event) => {
                  clearError();
                  setName(event.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-provider-id">{t('providers.custom.id')}</Label>
              <Input
                id="custom-provider-id"
                value={effectiveSlug}
                maxLength={48}
                aria-describedby="custom-provider-id-hint"
                spellCheck={false}
                placeholder={t('providers.custom.idPlaceholder')}
                disabled={Boolean(provider)}
                invalid={errorField === 'id'}
                onChange={(event) => {
                  clearError();
                  setSlugTouched(true);
                  setSlug(slugify(event.target.value));
                }}
              />
              <p
                id="custom-provider-id-hint"
                className="text-xs leading-relaxed text-foreground-muted"
              >
                {t('providers.custom.idHint')}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-provider-base">{t('providers.custom.baseUrl')}</Label>
            <Input
              id="custom-provider-base"
              value={baseUrl}
              aria-describedby="custom-provider-base-hint"
              spellCheck={false}
              placeholder={t('providers.custom.baseUrlPlaceholder')}
              invalid={errorField === 'baseUrl'}
              onChange={(event) => {
                clearError();
                setBaseUrl(event.target.value);
              }}
            />
            <p
              id="custom-provider-base-hint"
              className="text-xs leading-relaxed text-foreground-muted"
            >
              {t('providers.custom.baseUrlHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-provider-console">{t('providers.custom.consoleUrl')}</Label>
            <Input
              id="custom-provider-console"
              value={consoleUrl}
              spellCheck={false}
              placeholder={t('providers.custom.consoleUrlPlaceholder')}
              onChange={(event) => {
                clearError();
                setConsoleUrl(event.target.value);
              }}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t('providers.custom.models')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                leftIcon={<Plus size={16} aria-hidden />}
                onClick={() => {
                  clearError();
                  setModels((current) => [...current, emptyModel()]);
                }}
              >
                {t('providers.custom.addModel')}
              </Button>
            </div>
            <div className="divide-y divide-border overflow-hidden rounded-xl bg-surface">
              {models.map((row, index) => (
                <div key={index} className="space-y-2.5 px-3 py-3">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Input
                      id={`custom-provider-model-${index}-id`}
                      value={row.id}
                      maxLength={128}
                      spellCheck={false}
                      placeholder={t('providers.custom.modelId')}
                      aria-label={`${t('providers.custom.modelId')} ${index + 1}`}
                      invalid={errorField === 'models' && row.id.trim().length === 0}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                    />
                    <Input
                      value={row.name}
                      maxLength={120}
                      placeholder={t('providers.custom.modelName')}
                      aria-label={`${t('providers.custom.modelName')} ${index + 1}`}
                      onChange={(event) => updateModel(index, { name: event.target.value })}
                    />
                    <div className="flex items-center justify-end">
                      <IconButton
                        size="sm"
                        label={t('providers.custom.removeModel')}
                        className="hover:text-danger"
                        disabled={models.length === 1 && !row.id.trim() && !row.name.trim()}
                        onClick={() => removeModel(index)}
                      >
                        <Trash2 size={16} aria-hidden />
                      </IconButton>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Switch
                      checked={row.reasoning}
                      label={t('providers.custom.reasoning')}
                      onCheckedChange={(checked) => updateModel(index, { reasoning: checked })}
                    />
                    <Switch
                      checked={row.attachment}
                      label={t('providers.custom.attachment')}
                      onCheckedChange={(checked) => updateModel(index, { attachment: checked })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-surface">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="custom-provider-advanced"
              onClick={() => setAdvancedOpen((value) => !value)}
              className={cn(
                'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left',
                'transition-colors duration-150 hover:bg-surface-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                advancedOpen ? 'rounded-t-xl' : 'rounded-xl',
              )}
            >
              <span className="text-[13px] font-medium text-foreground">
                {t('providers.custom.advanced')}
              </span>
              <ChevronDown
                aria-hidden
                strokeWidth={2}
                className={cn(
                  'size-4 shrink-0 text-foreground-subtle transition-transform duration-150',
                  advancedOpen && 'rotate-180',
                )}
              />
            </button>
            {advancedOpen ? (
              <div
                id="custom-provider-advanced"
                className="grid gap-3 border-t border-border px-3 py-3 sm:grid-cols-2"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="custom-provider-auth-header">
                    {t('providers.custom.authHeader')}
                  </Label>
                  <Input
                    id="custom-provider-auth-header"
                    value={authHeader}
                    maxLength={64}
                    spellCheck={false}
                    placeholder={t('providers.custom.authHeaderPlaceholder')}
                    onChange={(event) => {
                      clearError();
                      setAuthHeader(event.target.value);
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="custom-provider-auth-prefix">
                    {t('providers.custom.authPrefix')}
                  </Label>
                  <Input
                    id="custom-provider-auth-prefix"
                    value={authPrefix}
                    maxLength={32}
                    spellCheck={false}
                    placeholder={t('providers.custom.authPrefixPlaceholder')}
                    onChange={(event) => {
                      clearError();
                      setAuthPrefix(event.target.value);
                    }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-[12px] leading-relaxed text-danger"
            >
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('providers.custom.cancel')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {provider ? t('providers.custom.save') : t('providers.custom.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
