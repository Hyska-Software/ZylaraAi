import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useAppStore } from '@/lib/store';
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
  Spinner,
  Switch,
} from '@/components/ui';

const ID_PREFIX = 'custom__';

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
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

  const updateModel = (index: number, patch: Partial<ModelRow>) => {
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
      setError(t('providers.custom.errors.name'));
      return;
    }
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(trimmedSlug)) {
      setError(t('providers.custom.errors.id'));
      return;
    }
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      setError(t('providers.custom.errors.baseUrl'));
      return;
    }
    if (cleanedModels.length === 0) {
      setError(t('providers.custom.errors.models'));
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
    setError(null);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {provider ? t('providers.custom.editTitle', { name: provider.name }) : t('providers.custom.title')}
          </DialogTitle>
          <DialogDescription>{t('providers.custom.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="custom-provider-name">{t('providers.custom.name')}</Label>
              <Input
                id="custom-provider-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('providers.custom.namePlaceholder')}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="custom-provider-id">{t('providers.custom.id')}</Label>
              <Input
                id="custom-provider-id"
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(slugify(event.target.value));
                }}
                placeholder={t('providers.custom.idPlaceholder')}
                disabled={Boolean(provider)}
                spellCheck={false}
              />
              <p className="text-xs text-foreground-subtle">{t('providers.custom.idHint')}</p>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="custom-provider-base">{t('providers.custom.baseUrl')}</Label>
            <Input
              id="custom-provider-base"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={t('providers.custom.baseUrlPlaceholder')}
              spellCheck={false}
            />
            <p className="text-xs text-foreground-subtle">{t('providers.custom.baseUrlHint')}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="custom-provider-console">{t('providers.custom.consoleUrl')}</Label>
            <Input
              id="custom-provider-console"
              value={consoleUrl}
              onChange={(event) => setConsoleUrl(event.target.value)}
              placeholder={t('providers.custom.consoleUrlPlaceholder')}
              spellCheck={false}
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>{t('providers.custom.models')}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setModels((current) => [...current, emptyModel()])}
              >
                <Plus size={16} aria-hidden />
                {t('providers.custom.addModel')}
              </Button>
            </div>
            <div className="grid gap-2">
              {models.map((row, index) => (
                <div
                  key={index}
                  className="grid gap-2 rounded-xl bg-surface p-3 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <Input
                    value={row.id}
                    onChange={(event) => updateModel(index, { id: event.target.value })}
                    placeholder={t('providers.custom.modelId')}
                    aria-label={t('providers.custom.modelId')}
                    spellCheck={false}
                  />
                  <Input
                    value={row.name}
                    onChange={(event) => updateModel(index, { name: event.target.value })}
                    placeholder={t('providers.custom.modelName')}
                    aria-label={t('providers.custom.modelName')}
                  />
                  <div className="flex items-center justify-end">
                    <IconButton
                      size="sm"
                      label={t('providers.custom.removeModel')}
                      onClick={() =>
                        setModels((current) =>
                          current.length > 1 ? current.filter((_, at) => at !== index) : [emptyModel()],
                        )
                      }
                    >
                      <Trash2 size={16} aria-hidden />
                    </IconButton>
                  </div>
                  <div className="flex items-center gap-4 sm:col-span-3">
                    <label className="flex items-center gap-2 text-sm text-foreground-muted">
                      <Switch
                        checked={row.reasoning}
                        onCheckedChange={(checked) => updateModel(index, { reasoning: checked })}
                      />
                      {t('providers.custom.reasoning')}
                    </label>
                    <label className="flex items-center gap-2 text-sm text-foreground-muted">
                      <Switch
                        checked={row.attachment}
                        onCheckedChange={(checked) => updateModel(index, { attachment: checked })}
                      />
                      {t('providers.custom.attachment')}
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <details className="rounded-xl bg-surface p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              {t('providers.custom.advanced')}
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="custom-provider-auth-header">{t('providers.custom.authHeader')}</Label>
                <Input
                  id="custom-provider-auth-header"
                  value={authHeader}
                  onChange={(event) => setAuthHeader(event.target.value)}
                  placeholder={t('providers.custom.authHeaderPlaceholder')}
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="custom-provider-auth-prefix">{t('providers.custom.authPrefix')}</Label>
                <Input
                  id="custom-provider-auth-prefix"
                  value={authPrefix}
                  onChange={(event) => setAuthPrefix(event.target.value)}
                  placeholder={t('providers.custom.authPrefixPlaceholder')}
                  spellCheck={false}
                />
              </div>
            </div>
          </details>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('providers.custom.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner size="sm" /> : null}
            {provider ? t('providers.custom.save') : t('providers.custom.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
