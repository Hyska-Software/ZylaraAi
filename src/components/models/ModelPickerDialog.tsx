import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  defaultReasoningFor,
  findModelIn,
  findProviderIn,
  providerAuth,
  providers as catalogProviders,
} from '@/lib/catalog';
import {
  buildModelGroups,
  entryKey,
  favoriteEntryMatches,
  firstSelectable,
  flattenGroups,
  keyStatusFor,
  modelFilterOptions,
  modelKey,
  normalizeSearch,
  reasoningForModel,
  selectionKey,
  selectorProviders,
  type ModelFilter,
  type ModelListEntry,
} from '@/lib/modelMenu';
import { openExternal } from '@/lib/genui/open-external';
import type {
  ModelInfo,
  ModelSelection,
  ProviderInfo,
  ReasoningSelection,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  agentSelectionForLayout,
  modelLockCopy,
  modelLockReason,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import type { ModelLockReason } from '@/lib/store';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Kbd,
} from '@/components/ui';
import { ModelDetailPanel } from './ModelDetailPanel';
import { FamilyAvatar } from './FamilyAvatar';
import { authStatusFor } from './providerAuth';
import { ALL_PROVIDERS, ProviderSelect } from './ProviderSelect';
import { ModelList } from './ModelList';
import { ModelSearchField } from './ModelSearchField';
import { modelOptionId } from './ModelRow';
import { ThinkingSelector } from './ThinkingSelector';

interface PreviewState {
  providerId: string;
  modelId: string;
  reasoning: ReasoningSelection | null;
}

function defaultModelFor(provider?: ProviderInfo): ModelInfo | undefined {
  if (!provider) return undefined;
  return (
    provider.models.find(
      (model) => model.id === provider.defaultModelId && model.status !== 'unavailable',
    ) ??
    provider.models.find((model) => model.status !== 'unavailable') ??
    provider.models[0]
  );
}

function initialProviderId(providerList: ProviderInfo[], selection: ModelSelection): string {
  return (
    providerList.find((provider) => provider.id === selection.providerId)?.id ??
    providerList[0]?.id ??
    ''
  );
}

/** Opening state of the preview: the committed selection whenever it exists. */
function initialPreview(providerList: ProviderInfo[], selection: ModelSelection): PreviewState {
  const provider =
    providerList.find((entry) => entry.id === selection.providerId) ?? providerList[0];
  const model =
    provider?.models.find((entry) => entry.id === selection.modelId) ?? defaultModelFor(provider);
  if (!provider || !model) {
    return {
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoning: selection.reasoning,
    };
  }
  return {
    providerId: provider.id,
    modelId: model.id,
    reasoning:
      model.id === selection.modelId
        ? reasoningForModel(model, selection.reasoning)
        : defaultReasoningFor(model),
  };
}

/** ChatGPT usage dashboard (same URL exposed by the provider console). */
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

function EmptyResults({ onClear, canClear }: { onClear: () => void; canClear: boolean }) {
  const { t } = useTranslation('models');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Search aria-hidden className="size-5 text-foreground-subtle" />
      <p className="text-[13px] font-medium text-foreground">
        {canClear ? t('picker.noResultsTitle') : t('picker.noModelsTitle')}
      </p>
      <p className="text-xs text-foreground-muted">
        {canClear ? t('picker.noResultsHint') : t('picker.noModelsHint')}
      </p>
      {canClear ? (
        <Button variant="secondary" size="sm" onClick={onClear} className="mt-1">
          {t('picker.clearSearchAndFilters')}
        </Button>
      ) : null}
    </div>
  );
}

interface ModelPickerDialogBodyProps {
  onClose: () => void;
}

/**
 * Everything inside the dialog lives here so it is mounted from scratch on every
 * opening: search, filters and the preview are born empty instead of being reset
 * by effects during render (the old `wasOpen` hack).
 */
function ModelPickerDialogBody({ onClose }: ModelPickerDialogBodyProps) {
  const { t, i18n: i18nInstance } = useTranslation('models');
  const globalSelection = useAppStore((state) => state.selection);
  const layoutMode = useUiStore((state) => state.layoutMode);
  // Agents own their route; the dialog must open on the pair the next turn
  // will actually use instead of the global Chat/Code selection.
  const agentSelection = useChatStore(
    useShallow((state) => agentSelectionForLayout(state, layoutMode)),
  );
  const selection = agentSelection ?? globalSelection;
  const favorites = useAppStore((state) => state.favorites);
  const keys = useAppStore((state) => state.keys);
  const auth = useAppStore((state) => state.auth);
  const storeProviders = useAppStore((state) => state.providers);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);

  const providerList = useMemo<ProviderInfo[]>(
    () =>
      selectorProviders(
        storeProviders.length ? storeProviders : catalogProviders(),
        keys,
        auth,
        selection.providerId,
      ),
    [storeProviders, keys, auth, selection.providerId],
  );

  const searchRef = useRef<HTMLInputElement>(null);
  const rawId = useId();
  const listId = useMemo(
    () => `model-picker-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [rawId],
  );

  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<ModelFilter[]>([]);
  const [providerId, setProviderId] = useState(() => initialProviderId(providerList, selection));
  const [preview, setPreview] = useState<PreviewState>(() => initialPreview(providerList, selection));
  const [activeKey, setActiveKey] = useState<string | null>(() =>
    modelKey(preview.providerId, preview.modelId),
  );

  const searching = normalizeSearch(query).length > 0;
  const groups = useMemo(
    () =>
      buildModelGroups(providerList, {
        ...(searching
          ? { query }
          : { providerId: providerId === ALL_PROVIDERS ? null : providerId }),
        filters,
        includeUnavailable: true,
        favorites,
        favoriteMatch: (pid, modelId) => favoriteEntryMatches(favorites, pid, modelId),
      }),
    [providerList, providerId, query, filters, favorites, searching, i18nInstance.language],
  );
  const entries = useMemo(() => flattenGroups(groups), [groups]);
  const entryCount = entries.length;

  const activeEntry = useMemo(
    () => entries.find((entry) => entryKey(entry) === activeKey) ?? null,
    [entries, activeKey],
  );

  // Typing/filtering can hide the highlighted row. Re-anchor the highlight AND
  // the preview on the first visible result so Enter and "Usar este modelo"
  // always agree with what the user is looking at (task-5, achado A2).
  useEffect(() => {
    if (activeEntry) return;
    const next = firstSelectable(groups);
    if (!next) {
      setActiveKey(null);
      return;
    }
    setActiveKey(entryKey(next));
    setPreview((current) => ({
      providerId: next.providerId,
      modelId: next.model.id,
      reasoning:
        current.providerId === next.providerId && current.modelId === next.model.id
          ? current.reasoning
          : reasoningForModel(next.model, current.reasoning),
    }));
  }, [activeEntry, groups]);

  const previewProvider = providerList.find((provider) => provider.id === preview.providerId);
  const previewModel = previewProvider?.models.find((model) => model.id === preview.modelId);
  const previewAuthStatus = authStatusFor(auth, preview.providerId);
  const previewEntry = useMemo<ModelListEntry | null>(
    () =>
      previewProvider && previewModel
        ? {
            providerId: previewProvider.id,
            providerName: previewProvider.name,
            providerShortName: previewProvider.shortName,
            model: previewModel,
            favorite: favoriteEntryMatches(favorites, previewProvider.id, previewModel.id),
          }
        : null,
    [previewProvider, previewModel, favorites],
  );
  const previewKeyStatus = keyStatusFor(keys, preview.providerId);
  const previewUnavailable = previewModel?.status === 'unavailable';
  const isCurrent =
    preview.providerId === selection.providerId && preview.modelId === selection.modelId;
  const selectedKey = selectionKey(selection);

  /** Highlight only — hovering never moves the details panel (DESIGN §8). */
  const highlight = (entry: ModelListEntry) => setActiveKey(entryKey(entry));

  /** Highlight + preview: used by arrow keys, clicks and provider switches. */
  const previewEntryModel = (entry: ModelListEntry) => {
    setActiveKey(entryKey(entry));
    setPreview((current) => ({
      providerId: entry.providerId,
      modelId: entry.model.id,
      reasoning:
        current.providerId === entry.providerId && current.modelId === entry.model.id
          ? current.reasoning
          : reasoningForModel(entry.model, current.reasoning),
    }));
  };

  const moveActive = (target: 'next' | 'previous' | 'first' | 'last') => {
    if (!entries.length) return;
    const index = activeEntry ? entries.indexOf(activeEntry) : -1;
    let nextIndex: number;
    switch (target) {
      case 'first':
        nextIndex = 0;
        break;
      case 'last':
        nextIndex = entries.length - 1;
        break;
      case 'next':
        nextIndex = index < 0 ? 0 : Math.min(entries.length - 1, index + 1);
        break;
      case 'previous':
        nextIndex = index < 0 ? entries.length - 1 : Math.max(0, index - 1);
        break;
    }
    previewEntryModel(entries[nextIndex]);
  };

  const changeProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    if (nextProviderId === ALL_PROVIDERS) {
      // Keep the current preview; the re-anchor effect picks the first visible
      // model if the previous one somehow left the list.
      if (preview.providerId && preview.modelId) {
        setActiveKey(modelKey(preview.providerId, preview.modelId));
      }
      return;
    }
    if (preview.providerId === nextProviderId) {
      setActiveKey(modelKey(preview.providerId, preview.modelId));
      return;
    }
    const provider = providerList.find((entry) => entry.id === nextProviderId);
    const model = defaultModelFor(provider);
    if (!provider || !model) return;
    setActiveKey(modelKey(provider.id, model.id));
    setPreview({
      providerId: provider.id,
      modelId: model.id,
      reasoning: defaultReasoningFor(model),
    });
  };

  const toggleFilter = (filter: ModelFilter) => {
    setFilters((current) =>
      current.includes(filter)
        ? current.filter((value) => value !== filter)
        : [...current, filter],
    );
  };

  const clearSearchAndFilters = () => {
    setQuery('');
    setFilters([]);
  };

  const commitSelection = async (next: PreviewState) => {
    if (!next.modelId) return;
    // The store owns the routing rules: a started Code session persists the pair
    // on the session, while new/empty chats keep the previous behavior. When the
    // choice is refused (turn running, backend error) the dialog stays open so
    // the toast is visible.
    const committed = await useChatStore.getState().chooseModel({
      providerId: next.providerId,
      modelId: next.modelId,
      reasoning: next.reasoning,
    });
    if (committed) onClose();
  };

  const commitPreview = () => {
    if (!previewModel || previewUnavailable) return;
    void commitSelection(preview);
  };

  const commitEntry = (entry: ModelListEntry) => {
    if (entry.model.status === 'unavailable') return;
    const same =
      preview.providerId === entry.providerId && preview.modelId === entry.model.id;
    void commitSelection({
      providerId: entry.providerId,
      modelId: entry.model.id,
      reasoning: same ? preview.reasoning : reasoningForModel(entry.model, preview.reasoning),
    });
  };

  const changeReasoning = (reasoning: ReasoningSelection | null) => {
    setPreview((current) => ({ ...current, reasoning }));
  };

  const openProviderSettings = () => {
    onClose();
    // "Configurar" is about the missing API key: deep-link to Provedores.
    useUiStore.getState().openSettings('providers');
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive('next');
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive('previous');
        break;
      case 'Home':
        event.preventDefault();
        moveActive('first');
        break;
      case 'End':
        event.preventDefault();
        moveActive('last');
        break;
      case 'Enter':
        event.preventDefault();
        // The highlighted option wins; with no visible results there is nothing
        // safe to confirm (the preview may no longer be in the list).
        if (activeEntry) commitEntry(activeEntry);
        else if (entries.length > 0) commitPreview();
        break;
      default:
        break;
    }
  };

  /**
   * Esc clears the search first (and keeps the dialog open). `stopPropagation`
   * also keeps the app-level Esc shortcut from closing every overlay.
   */
  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (!normalizeSearch(query)) return;
    event.preventDefault();
    event.stopPropagation();
    setQuery('');
    searchRef.current?.focus();
  };

  return (
    <DialogContent
      showClose
      className={cn(
        'flex h-[580px] w-[760px] gap-0 rounded-2xl p-0',
        'max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)]',
      )}
      onEscapeKeyDown={handleEscapeKeyDown}
    >
      <DialogHeader className="shrink-0 gap-2.5 px-4 pb-3 pr-12 pt-4">
        <div className="flex flex-col gap-1">
          <DialogTitle>{t('picker.title')}</DialogTitle>
          <DialogDescription>{t('picker.description')}</DialogDescription>
        </div>

        <ModelSearchField
          ref={searchRef}
          value={query}
          onChange={setQuery}
          ariaLabel={t('picker.searchAria')}
          controls={entries.length ? listId : undefined}
          activeDescendant={activeEntry ? modelOptionId(listId, activeEntry) : undefined}
          expanded
          autoFocus
          onKeyDown={handleSearchKeyDown}
          onClear={() => searchRef.current?.focus()}
        />

        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div
            role="group"
            aria-label={t('picker.filtersAria')}
            className="flex flex-wrap items-center gap-1.5"
          >
            {modelFilterOptions().map((option) => {
              const pressed = filters.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={pressed}
                  title={option.title}
                  onClick={() => toggleFilter(option.value)}
                  className={cn(
                    'inline-flex h-8 items-center rounded-full px-3 text-[12px] font-medium',
                    'transition-colors duration-150 motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    pressed
                      ? ' bg-accent-soft text-accent'
                      : ' bg-transparent text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {previewAuthStatus?.planUsage ? (
              <Badge tone="accent" title={t('picker.planBadgeTitle')}>
                {t('picker.planBadge')}
              </Badge>
            ) : null}
            <span className="text-[11px] tabular-nums text-foreground-subtle">
              {entryCount === 1
                ? t('picker.countOne', { count: entryCount })
                : t('picker.countOther', { count: entryCount })}
            </span>
          </div>
        </div>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 border-t border-border">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
            {searching ? (
              <span className="px-1 text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
                {t('picker.allProviders')}
              </span>
            ) : (
              <ProviderSelect
                providers={providerList}
                value={providerId}
                onChange={changeProvider}
                keys={keys}
                auth={auth}
                ariaLabel={t('picker.providersAria')}
              />
            )}
          </div>

          <div className="min-h-0 flex-1">
            <ModelList
              groups={groups}
              listId={listId}
              ariaLabel={
                searching || providerId === ALL_PROVIDERS
                  ? t('picker.resultsAria')
                  : t('picker.providerModelsAria')
              }
              activeKey={activeEntry ? entryKey(activeEntry) : null}
              selectedKey={selectedKey}
              onActivate={(key) => {
                const entry = entries.find((candidate) => entryKey(candidate) === key);
                if (entry) highlight(entry);
              }}
              onPick={previewEntryModel}
              onCommit={commitEntry}
              onFavoriteToggle={toggleFavorite}
              variant="dialog"
              showProvider={searching || providerId === ALL_PROVIDERS}
              emptyState={
                <EmptyResults
                  onClear={clearSearchAndFilters}
                  canClear={searching || filters.length > 0}
                />
              }
            />
          </div>
        </div>

        <aside
          aria-label={t('picker.detailsAria')}
          className="w-[300px] shrink-0 border-l border-border bg-surface"
        >
          <ModelDetailPanel
            entry={previewEntry}
            favorite={previewEntry?.favorite ?? false}
            onFavoriteToggle={() => {
              if (previewEntry) toggleFavorite(previewEntry.providerId, previewEntry.model.id);
            }}
            variant="dialog"
            reasoning={
              <ThinkingSelector
                model={previewModel}
                value={preview.reasoning}
                onChange={changeReasoning}
                compact
              />
            }
            keyStatus={previewKeyStatus}
            providerAuth={previewProvider ? providerAuth(previewProvider) : 'api-key'}
            authStatus={previewAuthStatus}
            planUsage={Boolean(previewAuthStatus?.planUsage)}
            onManagePlan={() => {
              void openExternal(previewProvider?.consoleUrl ?? CHATGPT_USAGE_URL);
            }}
            onConfigureProvider={openProviderSettings}
            className="h-full min-h-0"
          />
        </aside>
      </div>

      <DialogFooter className="shrink-0 justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3 text-[11px] text-foreground-subtle">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑↓</Kbd>
            {t('picker.footerNavigate')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd>
            {t('picker.footerUse')}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t('picker.footerClose')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isCurrent ? <Badge tone="accent">{t('picker.inUse')}</Badge> : null}
          <Button
            variant="primary"
            onClick={commitPreview}
            disabled={!previewModel || previewUnavailable || entries.length === 0}
          >
            {t('picker.useModel')}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Shown instead of the selector while the model cannot change: a started Chat
 * conversation (or a Code session with a turn running). The compact dialog only
 * explains why and summarizes the model in use — the thinking mode stays
 * editable in the composer.
 */
function ModelLockedDialog({
  reason,
  onClose,
}: {
  reason: ModelLockReason;
  onClose: () => void;
}) {
  const { t } = useTranslation('models');
  const copy = modelLockCopy(reason);
  const selection = useAppStore((state) => state.selection);
  const storeProviders = useAppStore((state) => state.providers);
  const providerList = storeProviders.length ? storeProviders : catalogProviders();
  // Resolve against the merged list so account-only models keep their name.
  const model = findModelIn(providerList, selection.providerId, selection.modelId);
  const provider = findProviderIn(providerList, selection.providerId);
  const modelName = model?.name ?? selection.modelId;
  const providerName = provider?.name ?? selection.providerId;

  return (
    <DialogContent
      showClose={false}
      className="w-[440px] max-w-[calc(100vw-2rem)] gap-0 p-0"
    >
      <DialogHeader className="gap-3 px-5 pb-4 pt-5">
        <div className="flex flex-col gap-1">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5">
          <FamilyAvatar family={model?.family} name={modelName} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-foreground" title={modelName}>
              {modelName}
            </p>
            <p
              className="truncate text-[11px] text-foreground-subtle"
              title={providerName}
            >
              {providerName}
            </p>
          </div>
        </div>

        <p className="text-[12px] leading-relaxed text-foreground-muted">
          {t('picker.lockedHint')}
        </p>
      </DialogHeader>

      <DialogFooter className="justify-end px-5 py-3">
        <Button variant="secondary" onClick={onClose} autoFocus>
          {t('common:actions.close')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Full model selector (DESIGN §8): global search, quick filters, provider
 * dropdown (including All), preview panel and an explicit "Usar este modelo" confirmation.
 *
 * Mounted once in `App` and driven by `useUiStore.modelPickerOpen`; the dialog
 * body is only rendered while open, so every opening starts from a clean state.
 * The store decides when the model can change: a Chat conversation is locked
 * after its first message, a Code session stays switchable between turns and a
 * running turn locks every layout. When locked, the same dialog shows the
 * explanation instead of the selector (`modelLockReason`).
 */
export function ModelPickerDialog() {
  const open = useUiStore((state) => state.modelPickerOpen);
  const setOpen = useUiStore((state) => state.setModelPickerOpen);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const lockReason = useChatStore((state) => modelLockReason(state, layoutMode));
  const onClose = () => setOpen(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        lockReason ? (
          <ModelLockedDialog reason={lockReason} onClose={onClose} />
        ) : (
          <ModelPickerDialogBody onClose={onClose} />
        )
      ) : null}
    </Dialog>
  );
}

export default ModelPickerDialog;
