import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Lock, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  defaultReasoningFor,
  findModelIn,
  providerAuth,
  providers as catalogProviders,
  reasoningUi,
} from '@/lib/catalog';
import {
  buildModelGroups,
  currentThinkingId,
  effortSegmentLabel,
  entryKey,
  favoriteEntryMatches,
  firstSelectable,
  flattenGroups,
  keyStatusFor,
  modelKey,
  normalizeSearch,
  parseModelKey,
  reasoningForModel,
  selectionKey,
  selectorProviders,
  thinkingHeadline,
  thinkingOptions,
  thinkingSelectionFor,
  type ModelListEntry,
  type ThinkingOption,
} from '@/lib/modelMenu';
import { openExternal } from '@/lib/genui/open-external';
import type { ReasoningSelection } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  modelLockCopy,
  modelLockReason,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import {
  Kbd,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui';
import { FamilyAvatar } from './FamilyAvatar';
import { ModelDetailPanel } from './ModelDetailPanel';
import { authStatusFor } from './providerAuth';
import { ALL_PROVIDERS, ProviderSelect } from './ProviderSelect';
import { ModelList } from './ModelList';
import { ModelSearchField } from './ModelSearchField';
import { modelOptionId } from './ModelRow';
import { ThinkingOptions } from './ThinkingOptions';
import { ThinkingLevelSlider } from './ThinkingLevelSlider';

export interface ModelPillProps {
  /** Overrides the store selection (useful for previews/secondary surfaces). */
  providerId?: string;
  modelId?: string;
  reasoning?: ReasoningSelection | null;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
  /** Opens the full model dialog (invoked by "Ver todos os modelos…"). */
  onClick?: () => void;
}

type Stage = 'model' | 'thinking';

/** DOM ids must stay unique when more than one pill is mounted (tests/previews). */
function domId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** ChatGPT usage dashboard (same URL exposed by the provider console). */
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Floating details bubble: width, gap to the popover, margin and hide delay. */
const DETAILS_WIDTH = 17 * 16;
const DETAILS_GAP = 12;
const DETAILS_VIEWPORT_MARGIN = 8;
const DETAILS_HIDE_DELAY_MS = 120;

interface DetailsPosition {
  top: number;
  left: number;
}

/** jsdom (tests) may not implement rAF; fall back to a macrotask. */
function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => callback());
  }
  return window.setTimeout(callback, 0);
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  else window.clearTimeout(frame);
}

function selectableIndex(entries: ModelListEntry[], from: number, delta: number): number {
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = (((from + delta * offset) % entries.length) + entries.length) % entries.length;
    if (entries[index].model.status !== 'unavailable') return index;
  }
  return -1;
}

function firstSelectableIndex(entries: ModelListEntry[]): number {
  return entries.findIndex((entry) => entry.model.status !== 'unavailable');
}

function lastSelectableIndex(entries: ModelListEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].model.status !== 'unavailable') return index;
  }
  return -1;
}

interface KeyboardHintProps {
  /** "aplicar" on the thinking step, "escolher" on the model list. */
  commitLabel: string;
  /** Compact, label-free legend used by the narrow thinking menu. */
  dense?: boolean;
}

/** Discreet keyboard legend shown in the popover footer. */
function KeyboardHint({ commitLabel, dense = false }: KeyboardHintProps) {
  const { t } = useTranslation('models');
  if (dense) {
    return (
      <span aria-hidden className="flex items-center gap-1 text-[10px] leading-none text-foreground-subtle">
        <Kbd className="h-4 min-w-4 px-1 text-[10px]" title={t('picker.kbdNavigate')}>
          ↑↓
        </Kbd>
        <Kbd className="h-4 min-w-4 px-1 text-[10px]" title={t('picker.kbdApply')}>
          ↵
        </Kbd>
        <Kbd className="h-4 min-w-4 px-1 text-[10px]" title={t('picker.kbdClose')}>
          Esc
        </Kbd>
      </span>
    );
  }

  return (
    <span aria-hidden className="flex items-center gap-1 text-[10px] text-foreground-subtle">
      <Kbd>↑↓</Kbd>
      <span>{t('picker.footerNavigate')}</span>
      <span aria-hidden>·</span>
      <Kbd>↵</Kbd>
      <span>{commitLabel}</span>
      <span aria-hidden>·</span>
      <Kbd>Esc</Kbd>
      <span>{t('picker.footerClose')}</span>
    </span>
  );
}

interface PillEmptyStateProps {
  query: string;
  onClear: () => void;
}

function PillEmptyState({ query, onClear }: PillEmptyStateProps) {
  const { t } = useTranslation('models');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Search aria-hidden className="size-5 text-foreground-subtle" />
      <p className="text-[13px] font-medium text-foreground">{t('picker.noResultsTitle')}</p>
      <p className="text-xs text-foreground-muted">{t('picker.emptyPillHint')}</p>
      {query ? (
        <button
          type="button"
          onClick={onClear}
          className={cn(
            'mt-1 rounded-lg px-2.5 py-1 text-[12px] font-medium text-accent',
            'transition-colors duration-150 hover:bg-accent-soft',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            'motion-reduce:transition-none',
          )}
        >
          {t('picker.clearSearch')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Compact model selector (DESIGN §7 default), a two-step popover:
 * 1. the compact model list: search (global across providers), provider dropdown
 *    (including All), grouped by family, with the model details shown as a
 *    floating tooltip-like bubble anchored to the active row (on hover or
 *    keyboard navigation);
 * 2. the thinking-mode list, reached after picking a model or straight from the
 *    ✦ segment (with a back button that returns without closing).
 * "Ver todos os modelos…" at the bottom opens the full dialog.
 *
 * Responsive: inside a `@container` ancestor (the composer controls row), the
 * model name and thinking label collapse to their icons below 42rem; the full
 * text stays available through `aria-label`/`title`.
 */
export function ModelPill({
  providerId,
  modelId,
  reasoning,
  compact = false,
  disabled = false,
  className,
  onClick,
}: ModelPillProps) {
  const { t, i18n: i18nInstance } = useTranslation('models');
  const selection = useAppStore((state) => state.selection);
  const favorites = useAppStore((state) => state.favorites);
  const keys = useAppStore((state) => state.keys);
  const auth = useAppStore((state) => state.auth);
  const storeProviders = useAppStore((state) => state.providers);
  const sliderEnabled = useAppStore((state) => state.settings.reasoningSliderEnabled ?? false);
  const refreshAcpThinking = useAppStore((state) => state.refreshAcpThinking);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const setReasoning = useChatStore((state) => state.setReasoning);
  // Chat locks the model once the conversation starts; a Code session keeps it
  // switchable between turns (a running turn always locks it).
  const layoutMode = useUiStore((state) => state.layoutMode);
  const lockReason = useChatStore((state) => modelLockReason(state, layoutMode));
  const locked = lockReason !== null;
  const lockCopy = lockReason ? modelLockCopy(lockReason) : null;

  const reactId = useId();
  const listId = `model-pill-${domId(reactId)}-models`;
  const thinkingListId = `model-pill-${domId(reactId)}-thinking`;

  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('model');
  const [query, setQuery] = useState('');
  const [listProviderId, setListProviderId] = useState(selection.providerId);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [thinkingTargetKey, setThinkingTargetKey] = useState<string | null>(null);
  const [thinkingValue, setThinkingValue] = useState<ReasoningSelection | null>(null);
  const [activeThinkingId, setActiveThinkingId] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<DetailsPosition | null>(null);

  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const thinkingTriggerRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Stage>('model');
  const closedByOutsideRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const hideDetailsTimerRef = useRef<number | null>(null);
  const detailsFrameRef = useRef<number | null>(null);

  const thinkingRefreshedRef = useRef<Set<string>>(new Set());
  const pid = providerId ?? selection.providerId;
  const mid = modelId ?? selection.modelId;
  // The selector lists the curated + connected providers; the merged list also
  // resolves account-only models for the current pair.
  const providerList = selectorProviders(
    storeProviders.length ? storeProviders : catalogProviders(),
    keys,
    auth,
    pid,
  );
  // The merged list resolves account-only models too (not just the static catalog).
  const model = findModelIn(providerList, pid, mid);

  const effectiveReasoning: ReasoningSelection | null =
    reasoning !== undefined
      ? reasoning
      : providerId && modelId
        ? defaultReasoningFor(model)
        : selection.reasoning;

  const name = model?.name ?? mid ?? t('picker.selectModel');
  const reasoningSupported = Boolean(model && reasoningUi(model).supported);
  const acpThinkingProbe =
    providerList.find((provider) => provider.id === pid)?.transport === 'acp' &&
    !reasoningSupported;
  const effortText = effortSegmentLabel(model, effectiveReasoning);
  const currentKey = mid ? modelKey(pid, mid) : null;
  // The lock explanation changes with the reason: a started Chat conversation
  // keeps the original copy, a running turn explains that it must finish first.
  const lockAriaLabel = locked
    ? lockReason === 'streaming'
      ? t('picker.lockedStreamingAria', { name })
      : t('picker.lockedConversationAria', { name })
    : null;

  const searching = normalizeSearch(query).length > 0;

  const groups = useMemo(
    () =>
      buildModelGroups(providerList, {
        ...(searching
          ? { query }
          : {
              providerId: listProviderId === ALL_PROVIDERS ? null : listProviderId,
            }),
        includeUnavailable: false,
        favorites,
        favoriteMatch: (pid, modelId) => favoriteEntryMatches(favorites, pid, modelId),
      }),
    [providerList, searching, query, favorites, listProviderId, i18nInstance.language],
  );

  const entries = useMemo(() => flattenGroups(groups), [groups]);

  const activeEntry = useMemo(
    () => entries.find((entry) => entryKey(entry) === activeKey) ?? null,
    [entries, activeKey],
  );

  const activeProvider = useMemo(
    () => providerList.find((provider) => provider.id === activeEntry?.providerId),
    [providerList, activeEntry],
  );

  const activeDescendant = activeEntry ? modelOptionId(listId, activeEntry) : undefined;

  // Keep the highlighted row valid whenever the query or provider changes.
  useEffect(() => {
    if (!open || stage !== 'model') return;
    if (activeKey && entries.some((entry) => entryKey(entry) === activeKey)) return;
    const next = firstSelectable(groups, currentKey);
    setActiveKey(next ? entryKey(next) : null);
  }, [open, stage, entries, groups, activeKey, currentKey]);

  /** Places the bubble beside the popover, aligned with the active row. */
  const measureDetailsPosition = (entry: ModelListEntry | null): DetailsPosition | null => {
    const content = contentRef.current;
    if (!content || !entry) return null;
    const option = document.getElementById(modelOptionId(listId, entry));
    const contentRect = content.getBoundingClientRect();
    // jsdom has no layout (rects are zero): keep the bubble unpositioned.
    if (!option || contentRect.width === 0) return null;
    const optionRect = option.getBoundingClientRect();
    const detailsRect = detailsRef.current?.getBoundingClientRect();
    const width = detailsRect?.width || DETAILS_WIDTH;
    const height = detailsRect?.height ?? 0;
    // Prefer the left side; when the window does not fit it, open to the right.
    const fitsLeft = contentRect.left >= width + DETAILS_GAP + DETAILS_VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - DETAILS_VIEWPORT_MARGIN;
    const viewportTop = Math.min(
      Math.max(optionRect.top, DETAILS_VIEWPORT_MARGIN),
      Math.max(DETAILS_VIEWPORT_MARGIN, maxTop),
    );
    return {
      top: viewportTop - contentRect.top,
      left: fitsLeft ? -(width + DETAILS_GAP) : contentRect.width + DETAILS_GAP,
    };
  };

  const measureDetailsRef = useRef(measureDetailsPosition);
  measureDetailsRef.current = measureDetailsPosition;
  const activeEntryRef = useRef<ModelListEntry | null>(activeEntry);
  activeEntryRef.current = activeEntry;

  const thinkingTarget = thinkingTargetKey ? parseModelKey(thinkingTargetKey) : null;
  const thinkingModel =
    (thinkingTarget
      ? findModelIn(providerList, thinkingTarget.providerId, thinkingTarget.modelId)
      : undefined) ?? model;
  // The thinking menu is a compact surface: it sizes to its content instead of
  // inheriting the wide two-pane layout of the model step.
  const showingThinking = stage === 'thinking' && Boolean(thinkingModel);
  const thinkingLevels =
    sliderEnabled && thinkingModel ? thinkingOptions(thinkingModel, thinkingValue) : [];

  // ACP agents advertise `thought_level` only after a model is selected. If
  // the stored catalog has no reasoning options yet, re-probe once so the
  // thinking control can appear in this same session.
  useEffect(() => {
    if (stage !== 'thinking' || !thinkingModel) return;
    if (providerList.find((provider) => provider.id === pid)?.transport !== 'acp') return;
    if (reasoningUi(thinkingModel).supported || thinkingRefreshedRef.current.has(pid)) return;
    thinkingRefreshedRef.current.add(pid);
    void refreshAcpThinking(pid);
  }, [stage, thinkingModel, pid, providerList, refreshAcpThinking]);

  const panelReasoning = activeEntry
    ? reasoningForModel(activeEntry.model, effectiveReasoning)
    : null;

  // The bubble lives outside the list flow: reposition it whenever the active
  // row or the popover geometry changes (first paint included).
  useEffect(() => {
    if (!showDetails || !activeEntry) return;
    setDetailsPosition(measureDetailsRef.current(activeEntry));
  }, [showDetails, activeEntry]);

  // Recalculate on list scroll and window resize, coalesced into one frame. The
  // listeners depend only on visibility/list identity; the active row is read
  // through a ref so hovering between rows does not re-register them.
  useEffect(() => {
    if (!showDetails) return;
    const list = document.getElementById(listId);
    const schedule = () => {
      if (detailsFrameRef.current !== null) return;
      detailsFrameRef.current = scheduleFrame(() => {
        detailsFrameRef.current = null;
        setDetailsPosition(measureDetailsRef.current(activeEntryRef.current));
      });
    };
    list?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      list?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (detailsFrameRef.current !== null) {
        cancelFrame(detailsFrameRef.current);
        detailsFrameRef.current = null;
      }
    };
  }, [showDetails, listId]);

  // No active row means nothing to describe.
  useEffect(() => {
    if (!activeEntry) setShowDetails(false);
  }, [activeEntry]);

  const focusOpener = () => {
    const trigger = openerRef.current === 'thinking' ? thinkingTriggerRef : modelTriggerRef;
    trigger.current?.focus();
  };

  const cancelPendingDetailsHide = () => {
    if (hideDetailsTimerRef.current !== null) {
      window.clearTimeout(hideDetailsTimerRef.current);
      hideDetailsTimerRef.current = null;
    }
  };

  /** Short grace period so the pointer can travel from the list into the bubble. */
  const scheduleDetailsHide = () => {
    cancelPendingDetailsHide();
    hideDetailsTimerRef.current = window.setTimeout(() => {
      hideDetailsTimerRef.current = null;
      setShowDetails(false);
    }, DETAILS_HIDE_DELAY_MS);
  };

  const hideDetails = () => {
    cancelPendingDetailsHide();
    setShowDetails(false);
    setDetailsPosition(null);
  };

  useEffect(() => () => cancelPendingDetailsHide(), []);

  const resetTransientState = () => {
    setStage('model');
    setQuery('');
    setActiveKey(null);
    setThinkingTargetKey(null);
    setThinkingValue(null);
    setActiveThinkingId(null);
    hideDetails();
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }
    const fromOutside = closedByOutsideRef.current;
    closedByOutsideRef.current = false;
    setOpen(false);
    // Keep the stage until the next open: PopoverContent stays mounted for its
    // scale-out animation, and switching to `model` here flashes the model list.
    hideDetails();
    if (!fromOutside) focusOpener();
  };

  const openModelStage = () => {
    if (locked) return;
    resetTransientState();
    setListProviderId(pid);
    setActiveKey(currentKey);
    openerRef.current = 'model';
    setOpen(true);
  };

  const switchToModelStage = () => {
    if (locked) return;
    hideDetails();
    setQuery('');
    setStage('model');
    setListProviderId(pid);
    setActiveKey(currentKey);
    openerRef.current = 'model';
  };

  const prepareThinking = () => {
    hideDetails();
    setThinkingTargetKey(currentKey);
    setThinkingValue(effectiveReasoning);
    setActiveThinkingId(currentThinkingId(effectiveReasoning));
  };

  const switchToThinkingStage = () => {
    prepareThinking();
    setStage('thinking');
    openerRef.current = 'thinking';
    setOpen(true);
  };

  const backToModelStage = () => {
    if (locked) return;
    setStage('model');
    if (thinkingTarget) setListProviderId(thinkingTarget.providerId);
    setActiveKey(thinkingTargetKey);
  };

  const handleModelSegment = () => {
    if (disabled) return;
    if (locked) {
      if (lockCopy) toast.info(lockCopy.title, { description: lockCopy.description });
      return;
    }
    if (!open) {
      openModelStage();
      return;
    }
    if (stage === 'model') {
      handleOpenChange(false);
      return;
    }
    switchToModelStage();
  };

  const handleThinkingSegment = () => {
    if (disabled || (!reasoningSupported && !acpThinkingProbe)) return;
    if (!open) {
      resetTransientState();
      prepareThinking();
      setStage('thinking');
      openerRef.current = 'thinking';
      setOpen(true);
      return;
    }
    if (stage === 'thinking') {
      handleOpenChange(false);
      return;
    }
    switchToThinkingStage();
  };

  const handleProviderChange = (value: string) => {
    hideDetails();
    setListProviderId(value);
    setQuery('');
    const nextGroups = buildModelGroups(providerList, {
      providerId: value === ALL_PROVIDERS ? null : value,
      includeUnavailable: false,
      favorites,
      favoriteMatch: (pid, modelId) => favoriteEntryMatches(favorites, pid, modelId),
    });
    // Keep the highlighted row when it is still visible (e.g. switching back to
    // All); otherwise anchor on the first selectable model of the new scope.
    const nextEntries = flattenGroups(nextGroups);
    const kept = activeKey
      ? nextEntries.find((entry) => entryKey(entry) === activeKey)
      : undefined;
    const next = kept ?? firstSelectable(nextGroups);
    setActiveKey(next ? entryKey(next) : null);
  };

  const handleQueryChange = (value: string) => {
    hideDetails();
    setQuery(value);
  };

  /** Reveals the bubble for an entry, measuring it before the first paint. */
  const revealDetails = (entry: ModelListEntry | null) => {
    cancelPendingDetailsHide();
    setDetailsPosition(measureDetailsRef.current(entry));
    setShowDetails(Boolean(entry));
  };

  /** Hovering/keyboard-moving between rows reveals the floating details. */
  const handleActivate = (key: string) => {
    const entry = entries.find((candidate) => entryKey(candidate) === key) ?? null;
    setActiveKey(key);
    revealDetails(entry);
  };

  const handleModelPick = (entry: ModelListEntry) => {
    if (entry.model.status === 'unavailable') return;
    if (locked) return;
    hideDetails();
    const nextKey = entryKey(entry);
    const nextReasoning = reasoningForModel(entry.model, effectiveReasoning);

    setActiveKey(nextKey);
    setListProviderId(entry.providerId);
    setThinkingTargetKey(nextKey);
    setThinkingValue(nextReasoning);
    setActiveThinkingId(currentThinkingId(nextReasoning));

    // `chooseModel` persists the pair on a started Code session (the change is a
    // session property there) and keeps the old behavior on new/empty chats.
    void useChatStore.getState().chooseModel({
      providerId: entry.providerId,
      modelId: entry.model.id,
      reasoning: nextReasoning,
    });

    // Continue inside the same popover: choose the thinking mode right away.
    if (reasoningUi(entry.model).supported) {
      setStage('thinking');
    } else {
      handleOpenChange(false);
    }
  };

  const handleThinkingPick = (option: ThinkingOption, keepOpen = false) => {
    const reasoning = thinkingSelectionFor(option);
    setReasoning(reasoning);
    if (keepOpen) {
      // The slider commits while the popover stays open; keep its local value
      // in sync so the thumb and label reflect the committed level.
      setThinkingValue(reasoning);
      setActiveThinkingId(currentThinkingId(reasoning));
      return;
    }
    handleOpenChange(false);
  };

  const moveActive = (delta: number) => {
    if (!entries.length) return;
    const currentIndex = entries.findIndex((entry) => entryKey(entry) === activeKey);
    const index =
      currentIndex < 0
        ? selectableIndex(entries, delta > 0 ? -1 : 0, delta)
        : selectableIndex(entries, currentIndex, delta);
    if (index >= 0) {
      setActiveKey(entryKey(entries[index]));
      revealDetails(entries[index]);
    }
  };

  const jumpActive = (edge: 'first' | 'last') => {
    if (!entries.length) return;
    const index = edge === 'first' ? firstSelectableIndex(entries) : lastSelectableIndex(entries);
    if (index >= 0) {
      setActiveKey(entryKey(entries[index]));
      revealDetails(entries[index]);
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        jumpActive('first');
        break;
      case 'End':
        event.preventDefault();
        jumpActive('last');
        break;
      case 'Enter': {
        event.preventDefault();
        const entry = activeEntry ?? firstSelectable(groups);
        if (entry) handleModelPick(entry);
        break;
      }
      default:
        break;
    }
  };

  const openFullPicker = () => {
    if (locked) return;
    handleOpenChange(false);
    if (onClick) {
      onClick();
      return;
    }
    useUiStore.getState().setModelPickerOpen(true);
  };

  const handleInteractOutside = (event: { target: EventTarget | null; preventDefault: () => void }) => {
    const target = event.target;
    // The provider dropdown is portaled outside the popover; selecting an item
    // must not close the model stage before the click is handled.
    if (target instanceof Element && target.closest('[role="menu"]')) {
      event.preventDefault();
      return;
    }
    const onTrigger =
      target instanceof Node &&
      (modelTriggerRef.current?.contains(target) === true ||
        thinkingTriggerRef.current?.contains(target) === true);
    if (onTrigger) {
      // Radix would close on the pointerdown before the segment's own click.
      event.preventDefault();
      return;
    }
    closedByOutsideRef.current = true;
  };

  const allProvidersLabel = providerList.map((provider) => provider.shortName).join(' + ');

  // If the conversation starts while the model step is open, the lock kicks in
  // and the model step must close (the thinking step stays available).
  useEffect(() => {
    if (!locked || !open || stage !== 'model') return;
    handleOpenChange(false);
  }, [locked, open, stage]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div
          className={cn(
            'no-drag inline-flex h-8 min-w-0 items-stretch overflow-hidden rounded-full bg-surface-hover',
            'text-[13px] font-medium text-foreground transition-colors duration-150',
            'focus-within:ring-2 focus-within:ring-accent/40 focus-within:ring-offset-2 focus-within:ring-offset-background',
            disabled && 'pointer-events-none opacity-60',
            compact && 'h-7 text-xs',
            className,
          )}
        >
          <button
            ref={modelTriggerRef}
            type="button"
            disabled={disabled}
            aria-haspopup={locked ? undefined : 'dialog'}
            aria-expanded={locked ? undefined : open && stage === 'model'}
            aria-disabled={locked || undefined}
            aria-label={lockAriaLabel ?? t('picker.selectModelCurrent', { name })}
            title={locked ? lockCopy?.description : name}
            onClick={handleModelSegment}
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded-l-full pl-1 pr-1.5',
              'transition-colors duration-150 focus-visible:outline-none',
              'motion-reduce:transition-none disabled:cursor-not-allowed',
              locked
                ? 'cursor-not-allowed text-foreground-subtle'
                : 'hover:bg-surface-hover',
              compact && 'gap-1 pl-0.5 pr-1',
              !locked && open && stage === 'model' && 'bg-surface-hover',
            )}
          >
            <FamilyAvatar
              family={model?.family}
              name={name}
              size={compact ? 18 : 20}
              className={locked ? 'opacity-70' : undefined}
            />
            <span
              className={cn(
                'truncate',
                compact ? 'max-w-24' : 'max-w-36',
                // Narrow composer: keep only the model icon; the full name
                // stays in the segment's aria-label and title.
                '@max-[42rem]:hidden',
                locked && 'text-foreground-subtle',
              )}
              title={locked ? lockCopy?.description : name}
            >
              {name}
            </span>
            {locked ? (
              <Lock aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
            ) : (
              <ChevronDown aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
            )}
          </button>

          <span aria-hidden className="my-1.5 w-px shrink-0 bg-border" />

          <button
            ref={thinkingTriggerRef}
            type="button"
            disabled={disabled || (!reasoningSupported && !acpThinkingProbe)}
            aria-expanded={open && stage === 'thinking'}
            aria-label={t('picker.selectThinking', { value: effortText })}
            title={reasoningSupported ? effortText : t('thinking.noReasoningHint')}
            onClick={handleThinkingSegment}
            className={cn(
              'flex min-w-0 items-center gap-1 rounded-r-full px-1.5',
              'transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-none',
              'motion-reduce:transition-none disabled:cursor-not-allowed disabled:hover:bg-transparent',
              compact && 'px-1',
              open && stage === 'thinking' && 'bg-surface-hover',
            )}
          >
            <Sparkles
              aria-hidden
              className={cn(
                'size-3 shrink-0',
                reasoningSupported ? 'text-accent' : 'text-foreground-subtle',
              )}
            />
            <span
              className={cn(
                'max-w-32 truncate text-[12px] font-normal',
                reasoningSupported ? 'text-foreground-muted' : 'text-foreground-subtle',
                compact && 'hidden',
                // Narrow composer: keep only the ✦ icon (effort stays in the
                // segment's aria-label/title).
                '@max-[42rem]:hidden',
              )}
            >
              {effortText}
            </span>
            <ChevronDown aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
          </button>
        </div>
      </PopoverAnchor>

      <PopoverContent
        ref={contentRef}
        role="dialog"
        aria-label={t('picker.selectModel')}
        align="end"
        className={cn(
          'p-0',
          showingThinking
            ? 'w-auto min-w-[16rem] max-w-[20rem]'
            : 'w-[22rem] max-w-[calc(100vw-2rem)] overflow-visible',
        )}
        onInteractOutside={handleInteractOutside}
        // Focus return is handled by the pill itself (the segments are not the
        // Radix trigger), so the focus scope must not restore a stale element.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {showingThinking && thinkingModel ? (
          thinkingLevels.length > 1 ? (
            <ThinkingLevelSlider
              model={thinkingModel}
              value={thinkingValue}
              onSelect={(option) => handleThinkingPick(option, true)}
              onBack={locked ? undefined : backToModelStage}
              autoFocus={open}
              className="w-[18rem]"
            />
          ) : (
            <div className="flex max-h-[min(24rem,calc(100dvh-6rem))] w-full flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-1">
                <ThinkingOptions
                  model={thinkingModel}
                  value={thinkingValue}
                  activeId={activeThinkingId}
                  onActiveChange={setActiveThinkingId}
                  onSelect={handleThinkingPick}
                  listId={thinkingListId}
                  onBack={locked ? undefined : backToModelStage}
                  autoFocus={open}
                />
              </div>
              <div className="flex shrink-0 items-center justify-end border-t border-border px-2 py-1">
                <KeyboardHint commitLabel={t('picker.thinkingStep')} dense />
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col">
            <div className="flex shrink-0 flex-col gap-2 border-b border-border p-2.5">
              <ModelSearchField
                value={query}
                onChange={handleQueryChange}
                ariaLabel={t('picker.searchAria')}
                controls={entries.length ? listId : undefined}
                activeDescendant={activeDescendant}
                expanded={open}
                autoFocus={open}
                placeholder={t('search.placeholder')}
                onKeyDown={handleSearchKeyDown}
              />
              <div className="flex items-center justify-between gap-2">
                {searching ? (
                  <span
                    className="text-[11px] font-medium text-foreground-muted"
                    title={t('picker.allProvidersTitle')}
                  >
                    {allProvidersLabel}
                  </span>
                ) : (
                  <ProviderSelect
                    size="sm"
                    providers={providerList}
                    value={listProviderId}
                    onChange={handleProviderChange}
                    keys={keys}
                    auth={auth}
                    ariaLabel={t('picker.providerAria')}
                  />
                )}
                <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                  {entries.length === 1
                    ? t('picker.countOne', { count: entries.length })
                    : t('picker.countOther', { count: entries.length })}
                </span>
              </div>
            </div>

            <div
              className="h-[19rem] min-h-0"
              onMouseEnter={cancelPendingDetailsHide}
              onMouseLeave={scheduleDetailsHide}
            >
              <ModelList
                groups={groups}
                listId={listId}
                ariaLabel={t('picker.modelsAria')}
                activeKey={activeKey}
                selectedKey={selectionKey({ providerId: pid, modelId: mid, reasoning: null })}
                onActivate={handleActivate}
                onPick={handleModelPick}
                onFavoriteToggle={toggleFavorite}
                variant="compact"
                showProvider={searching || listProviderId === ALL_PROVIDERS}
                emptyState={
                  <PillEmptyState query={query} onClear={() => handleQueryChange('')} />
                }
                className="h-full"
              />
            </div>

            {showDetails && activeEntry ? (
              <div
                ref={detailsRef}
                role="group"
                aria-label={t('picker.detailsGroupAria')}
                style={detailsPosition ?? undefined}
                onMouseEnter={cancelPendingDetailsHide}
                onMouseLeave={scheduleDetailsHide}
                className={cn(
                  'absolute z-30 w-[17rem] max-h-[min(20rem,calc(100dvh-4rem))] overflow-y-auto overscroll-contain',
                  'rounded-xl bg-surface-raised shadow-xl',
                )}
              >
                <ModelDetailPanel
                  entry={activeEntry}
                  favorite={favoriteEntryMatches(
                    favorites,
                    activeEntry.providerId,
                    activeEntry.model.id,
                  )}
                  onFavoriteToggle={() =>
                    toggleFavorite(activeEntry.providerId, activeEntry.model.id)
                  }
                  variant="compact"
                  reasoning={
                    reasoningUi(activeEntry.model).supported ? (
                      <div className="flex items-start gap-1.5 rounded-md bg-surface px-2 py-1.5 text-[10.5px] leading-relaxed text-foreground-muted">
                        <Sparkles aria-hidden className="mt-0.5 size-3 shrink-0 text-accent" />
                        <span>{thinkingHeadline(activeEntry.model, panelReasoning)}</span>
                      </div>
                    ) : null
                  }
                  keyStatus={keyStatusFor(keys, activeEntry.providerId)}
                  providerAuth={activeProvider ? providerAuth(activeProvider) : 'api-key'}
                  authStatus={authStatusFor(auth, activeEntry.providerId)}
                  planUsage={Boolean(authStatusFor(auth, activeEntry.providerId)?.planUsage)}
                  onManagePlan={() => {
                    void openExternal(activeProvider?.consoleUrl ?? CHATGPT_USAGE_URL);
                  }}
                  onConfigureProvider={() => {
                    handleOpenChange(false);
                    useUiStore.getState().openSettings('providers');
                  }}
                  className="h-auto"
                />
              </div>
            ) : null}

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5">
              <button
                type="button"
                onClick={openFullPicker}
                className={cn(
                  'flex min-h-8 items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-foreground-muted',
                  'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  'motion-reduce:transition-none',
                )}
              >
                <SlidersHorizontal aria-hidden className="size-3.5" />
                {t('picker.viewAllModels')}
              </button>
              <KeyboardHint commitLabel={t('picker.chooseStep')} />
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
