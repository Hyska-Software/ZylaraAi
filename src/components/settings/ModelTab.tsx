import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import {
  defaultReasoningFor,
  formatContextWindow,
  formatPrice,
  providerAuth,
  providers as catalogProviders,
} from '@/lib/catalog';
import type { ProviderInfo, ReasoningSelection } from '@/lib/types';
import { selectActiveConversationStarted, useAppStore, useChatStore } from '@/lib/store';
import { Badge, NativeSelect } from '@/components/ui';
import { CapabilityBadges } from '@/components/models';
import { ThinkingSelector } from '@/components/models/ThinkingSelector';
import { SettingRow, SettingsBlock, SettingsSection } from './shared';

function reasoningDefaultOf(selection: ReasoningSelection | null): string {
  if (!selection) return 'auto';
  if (selection.mode === 'off') return 'off';
  if (selection.mode === 'budget') return `budget:${selection.budget ?? 8_192}`;
  return selection.effort ? `effort:${selection.effort}` : 'auto';
}

export function ModelTab() {
  const { t } = useTranslation('settings');
  const settings = useAppStore((state) => state.settings);
  const selection = useAppStore((state) => state.selection);
  const storeProviders = useAppStore((state) => state.providers);
  const auth = useAppStore((state) => state.auth);
  const setSelection = useAppStore((state) => state.setSelection);
  const setReasoning = useAppStore((state) => state.setReasoning);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const started = useChatStore(selectActiveConversationStarted);

  const providerList: ProviderInfo[] = storeProviders.length ? storeProviders : catalogProviders();

  // This tab edits the *default* model (used by new conversations). A started
  // conversation owns its model in every layout (a Code session can change it
  // from the composer/palette, never from here), so the tab must never touch the
  // active selection — only the persisted defaults.
  const [displayProviderId, setDisplayProviderId] = useState(
    settings.defaultProvider || selection.providerId,
  );
  const [displayModelId, setDisplayModelId] = useState(settings.defaultModel || selection.modelId);

  useEffect(() => {
    setDisplayProviderId(settings.defaultProvider || selection.providerId);
    setDisplayModelId(settings.defaultModel || selection.modelId);
  }, [settings.defaultProvider, settings.defaultModel, selection.providerId, selection.modelId]);

  const activeProvider =
    providerList.find((provider) => provider.id === displayProviderId) ?? providerList[0];
  const availableModels = useMemo(
    () => (activeProvider?.models ?? []).filter((entry) => entry.status !== 'unavailable'),
    [activeProvider],
  );
  const resolvedModelId = availableModels.some((entry) => entry.id === displayModelId)
    ? displayModelId
    : (availableModels[0]?.id ?? '');
  const model = activeProvider?.models.find((entry) => entry.id === resolvedModelId);
  const activeAuth = auth.find((entry) => entry.providerId === activeProvider?.id);
  /** A connected ChatGPT plan hides the per-token price (presentation decision). */
  const includedInPlan =
    Boolean(activeProvider) &&
    providerAuth(activeProvider) === 'oauth' &&
    activeAuth?.state === 'signed-in' &&
    activeAuth.planUsage;

  const [pendingReasoning, setPendingReasoning] = useState<ReasoningSelection | null>(() =>
    defaultReasoningFor(model),
  );
  useEffect(() => {
    setPendingReasoning(defaultReasoningFor(model));
  }, [model]);

  const commit = (
    providerId: string,
    modelId: string,
    reasoning: ReasoningSelection | null,
  ) => {
    setDisplayProviderId(providerId);
    setDisplayModelId(modelId);
    setPendingReasoning(reasoning);
    void saveSettings({
      defaultProvider: providerId,
      defaultModel: modelId,
      reasoningDefault: reasoningDefaultOf(reasoning),
    });
    // A started conversation keeps its model; only future chats use the default.
    if (!started) {
      setSelection({ providerId, modelId, reasoning });
      setReasoning(reasoning);
    }
  };

  const handleProviderChange = (providerId: string) => {
    const provider = providerList.find((entry) => entry.id === providerId);
    if (!provider) return;
    const preferred =
      provider.models.find((entry) => entry.id === provider.defaultModelId && entry.status !== 'unavailable') ??
      provider.models.find((entry) => entry.status !== 'unavailable') ??
      provider.models[0];
    if (!preferred) return;
    commit(provider.id, preferred.id, defaultReasoningFor(preferred));
  };

  const handleModelChange = (modelId: string) => {
    if (!activeProvider) return;
    const next = activeProvider.models.find((entry) => entry.id === modelId);
    commit(activeProvider.id, modelId, defaultReasoningFor(next));
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title={t('model.title')} description={t('model.description')}>
        {started ? (
          <SettingsBlock>
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-warning">
              <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {t('model.startedWarning')}
            </p>
          </SettingsBlock>
        ) : null}

        <SettingRow
          label={t('model.provider.label')}
          description={t('model.provider.description')}
        >
          <NativeSelect
            value={activeProvider?.id ?? ''}
            onChange={(event) => handleProviderChange(event.target.value)}
            aria-label={t('model.provider.aria')}
            wrapperClassName="w-[220px]"
          >
            {providerList.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </NativeSelect>
        </SettingRow>

        <SettingRow label={t('model.model.label')} description={t('model.model.description')}>
          <NativeSelect
            value={resolvedModelId}
            onChange={(event) => handleModelChange(event.target.value)}
            aria-label={t('model.model.aria')}
            wrapperClassName="w-[220px]"
          >
            {availableModels.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </NativeSelect>
        </SettingRow>

        {model ? (
          <SettingsBlock>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <CapabilityBadges model={model} max={5} />
                {model.estimated ? (
                  <Badge tone="outline" title={t('model.estimatedTitle')}>
                    {t('model.estimated')}
                  </Badge>
                ) : null}
                <span className="text-[11px] tabular-nums text-foreground-subtle">
                  {t('model.context', { window: formatContextWindow(model.contextWindow) })} ·{' '}
                  {includedInPlan ? t('model.includedInPlan') : formatPrice(model.cost)}
                </span>
              </div>
              <ThinkingSelector
                model={model}
                value={pendingReasoning}
                onChange={(reasoning) => {
                  setPendingReasoning(reasoning);
                  if (!started) setReasoning(reasoning);
                  void saveSettings({ reasoningDefault: reasoningDefaultOf(reasoning) });
                }}
              />
              <p className="text-[11px] leading-relaxed text-foreground-subtle">
                {t('model.reasoningNote')}
              </p>
            </div>
          </SettingsBlock>
        ) : (
          <SettingsBlock>
            <p className="text-xs text-foreground-muted">
              {t('model.missingModel', { model: settings.defaultModel })}
            </p>
          </SettingsBlock>
        )}
      </SettingsSection>

      <div className="flex items-center gap-2 rounded-xl bg-surface px-4 py-3 text-[11px] leading-relaxed text-foreground-muted">
        <Badge tone="muted">{t('model.tip')}</Badge>
        {t('model.tipBody')}
      </div>
    </div>
  );
}
