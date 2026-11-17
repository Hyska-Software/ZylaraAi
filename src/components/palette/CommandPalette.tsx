import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CacheDiagnosticsDialog } from '@/components/agent/CacheDiagnosticsDialog';
import { Slot } from '@/components/plugins/ui/Slot';
import { CACHE_DIAGNOSTICS_EVENT } from '@/components/agent/cacheDiagnosticsRequest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Kbd,
  Spinner,
} from '@/components/ui';
import {
  PALETTE_GROUPS,
  paletteGroupLabel,
  type PaletteCommandResult,
  type PaletteItem,
  type PaletteSection,
  type PaletteScope,
} from '@/lib/palette/types';
import { parsePaletteQuery, rankCommands, rankConversations } from '@/lib/palette/search';
import {
  orderByRecents,
  readRecentCommandIds,
  recordRecentCommandId,
} from '@/lib/palette/recents';
import { filterConversationsForLayout } from '@/lib/conversations';
import { t } from '@/lib/i18n';
import { useChatStore, useUiStore } from '@/lib/store';
import { modKey } from '@/lib/utils';
import { ConversationRow } from './ConversationRow';
import { PaletteRow } from './PaletteRow';
import { usePaletteActions } from './usePaletteActions';
import { useConversationSearch } from './useConversationSearch';

/** Number of rows moved by PageUp/PageDown (list is ~11 rows tall). */
const PAGE_SIZE = 10;
const SUGGESTIONS_LIMIT = 5;
const RECENT_CONVERSATIONS_LIMIT = 5;

/** Suggested commands when there is no recent history yet. */
const QUICK_ACTIONS = [
  'nova-conversa',
  'trocar-modelo',
  'abrir-configuracoes',
  'alternar-tema',
  'focar-composer',
] as const;

function optionDomId(key: string): string {
  return `zylara-palette-${key}`;
}

function groupSections(commandResults: readonly PaletteCommandResult[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  for (const group of PALETTE_GROUPS) {
    const items = commandResults.filter((result) => result.action.group === group.id);
    if (items.length) {
      sections.push({ id: `group-${group.id}`, label: paletteGroupLabel(group.id), items });
    }
  }
  return sections;
}

function buildSuggestions(
  commandResults: readonly PaletteCommandResult[],
  recentIds: readonly string[],
): PaletteCommandResult[] {
  const byId = new Map(commandResults.map((result) => [result.action.id, result]));
  const ordered = orderByRecents(
    [...recentIds, ...QUICK_ACTIONS],
    recentIds,
    (id) => byId.has(id),
  ).slice(0, SUGGESTIONS_LIMIT);
  return ordered.flatMap((id) => {
    const result = byId.get(id);
    return result ? [result] : [];
  });
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-1 px-2.5 py-1" aria-hidden>
      {[0, 1].map((index) => (
        <div
          key={index}
          className="h-9 animate-pulse rounded-lg bg-surface-hover motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function EmptyState({ query, scope }: { query: string; scope: PaletteScope }) {
  const { t: tPalette } = useTranslation('palette');
  const title = query
    ? tPalette('empty.queryTitle', { query })
    : scope === 'conversations'
      ? tPalette('empty.conversationsTitle')
      : tPalette('empty.commandsTitle');
  const hint =
    scope === 'commands'
      ? tPalette('empty.commandsHint')
      : scope === 'conversations'
        ? query.length === 1
          ? tPalette('empty.conversationMinChars')
          : tPalette('empty.conversationsHint')
        : tPalette('empty.allHint');

  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
      <Search aria-hidden className="size-5 text-foreground-subtle" />
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="text-xs text-foreground-muted">{hint}</p>
    </div>
  );
}

/**
 * Runs a command after the palette has closed and Radix restored focus to the
 * previous surface. Scheduling on the next tick avoids two FocusScopes fighting
 * when the command opens another dialog (Settings / Model Picker) or focuses the
 * composer (docs/COMMAND_PALETTE.md §4.5).
 */
function scheduleAfterClose(run: () => void | Promise<void>): void {
  window.setTimeout(() => {
    void Promise.resolve(run()).catch((error: unknown) => {
      toast.error(t('palette:toasts.runFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, 0);
}

/**
 * Command palette (DESIGN §10, docs/COMMAND_PALETTE.md): searchable commands
 * plus inline conversation search, full keyboard navigation and shortcut
 * hints. Visibility lives in `useUiStore.commandPaletteOpen` (the global hotkey
 * lives in App.tsx / lib/hotkeys.ts).
 */
export function CommandPalette() {
  const { t: tPalette } = useTranslation('palette');
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const conversations = useChatStore((state) => state.conversations);

  /**
   * Chat and Code search their own sessions only (shared ones show in both).
   * Agentes is persona-scoped: a palette row must never open a thread that
   * belongs to another agent, otherwise AgentWorkspace drops it on the next
   * paint.
   */
  const visibleConversations = useMemo(
    () =>
      filterConversationsForLayout(conversations, layoutMode, {
        agentId: layoutMode === 'agent' ? activeAgentId : undefined,
      }),
    [activeAgentId, conversations, layoutMode],
  );

  const [rawQuery, setRawQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());

  /**
   * Diagnóstico de cache (F5.4). A paleta é o host persistente do dialog: ela
   * continua montada quando fecha, então o painel sobrevive ao fechamento e
   * pode ser aberto pela própria paleta ou pelo botão do popover do chip.
   */
  const [cacheDiagnosticsOpen, setCacheDiagnosticsOpen] = useState(false);
  useEffect(() => {
    const openDiagnostics = () => setCacheDiagnosticsOpen(true);
    window.addEventListener(CACHE_DIAGNOSTICS_EVENT, openDiagnostics);
    return () => window.removeEventListener(CACHE_DIAGNOSTICS_EVENT, openDiagnostics);
  }, []);

  const actions = usePaletteActions();
  const parsed = useMemo(() => parsePaletteQuery(rawQuery), [rawQuery]);
  const hasQuery = parsed.query.trim().length > 0;
  const conversationSearch = useConversationSearch(
    hasQuery ? parsed.query : '',
    open && parsed.scope !== 'commands',
  );

  const commandResults = useMemo(() => {
    if (parsed.scope === 'conversations') return [];
    return rankCommands(actions, parsed.query, recentIds);
  }, [actions, parsed.query, parsed.scope, recentIds]);

  const recentConversations = useMemo(() => {
    if (hasQuery || parsed.scope === 'commands') return [];
    return rankConversations(visibleConversations, '', { limit: RECENT_CONVERSATIONS_LIMIT });
  }, [visibleConversations, hasQuery, parsed.scope]);

  const sections = useMemo<PaletteSection[]>(() => {
    if (parsed.scope === 'commands') return groupSections(commandResults);

    if (!hasQuery) {
      const list: PaletteSection[] = [];
      if (recentConversations.length) {
        list.push({
          id: 'recent-conversations',
          label: tPalette('sections.recentConversations'),
          items: recentConversations,
        });
      }
      if (parsed.scope === 'all') {
        const suggestions = buildSuggestions(commandResults, recentIds);
        if (suggestions.length) {
          list.push({
            id: 'suggestions',
            label: tPalette('sections.suggestions'),
            items: suggestions,
          });
        }
        const suggestedIds = new Set(suggestions.map((item) => item.action.id));
        list.push(...groupSections(commandResults.filter((item) => !suggestedIds.has(item.action.id))));
      }
      return list;
    }

    const list: PaletteSection[] = [];
    if (
      conversationSearch.loading ||
      conversationSearch.results.length > 0 ||
      conversationSearch.fallback
    ) {
      list.push({
        id: 'conversation-results',
        label: tPalette('sections.conversations'),
        items: conversationSearch.results,
        loading: conversationSearch.loading,
        fallback: conversationSearch.fallback,
      });
    }
    if (parsed.scope === 'conversations') return list;
    list.push(...groupSections(commandResults));
    return list;
  }, [commandResults, conversationSearch, hasQuery, parsed.scope, recentConversations, recentIds, tPalette]);

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const flatSignature = useMemo(() => flat.map((item) => item.key).join('|'), [flat]);

  const activeIndex = flat.findIndex((item) => item.key === activeKey);
  const activeItem = activeIndex >= 0 ? flat[activeIndex] : undefined;

  /* Reset the search and reload recents on every opening. The selected row is
     re-picked by the anchoring effect below, which must re-run even when the
     result signature is identical to the previous opening (common path:
     ⌘K → Enter on the first suggestion). */
  const resetSelectionRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    setRawQuery('');
    setRecentIds(readRecentCommandIds());
    resetSelectionRef.current = true;
  }, [open]);

  /* Keep the highlight anchored to a real item as results change (async
     conversation rows, contextual commands appearing/disappearing, typing). A
     selection that still exists survives the keystroke; otherwise the first
     selectable row wins. Reopening always starts from the first row — the reset
     is consumed only after the query is cleared, so a reopen that still renders
     the previous query for one frame cannot keep a stale selection. */
  useEffect(() => {
    const keys = flatSignature ? flatSignature.split('|') : [];
    const forceFirst = resetSelectionRef.current && rawQuery === '';
    if (forceFirst) resetSelectionRef.current = false;
    setActiveKey((current) => {
      if (!forceFirst && current && keys.includes(current)) return current;
      return keys[0] ?? null;
    });
  }, [flatSignature, rawQuery, open]);

  /* Keep the highlighted row visible while navigating with the keyboard. */
  useEffect(() => {
    if (!open || !activeKey) return;
    rowRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest' });
  }, [activeKey, open]);

  /* When async conversation results arrive, move the selection onto the first
     visible row (a conversation) instead of leaving it on a command the user
     never chose — Enter should open what was just searched. */
  const wasSearchingRef = useRef(false);
  useEffect(() => {
    if (conversationSearch.loading) {
      wasSearchingRef.current = true;
      return;
    }
    if (!wasSearchingRef.current) return;
    wasSearchingRef.current = false;
    if (conversationSearch.results.length > 0 && flat.length > 0) {
      setActiveKey(flat[0].key);
    }
  }, [conversationSearch.loading, conversationSearch.results.length, flat]);

  const selectIndex = (index: number) => {
    if (!flat.length) return;
    const bounded = Math.min(Math.max(index, 0), flat.length - 1);
    setActiveKey(flat[bounded].key);
  };

  const moveActive = (delta: number) => {
    if (!flat.length) return;
    const current = activeIndex;
    if (current < 0) {
      selectIndex(delta >= 0 ? 0 : flat.length - 1);
      return;
    }
    const next = (((current + delta) % flat.length) + flat.length) % flat.length;
    setActiveKey(flat[next].key);
  };

  const executeItem = (item: PaletteItem) => {
    setOpen(false);
    if (item.kind === 'conversation') {
      void useChatStore.getState().openConversation(item.conversation.id);
      return;
    }
    setRecentIds(recordRecentCommandId(item.action.id));
    scheduleAfterClose(item.action.run);
  };

  const runSecondary = () => {
    if (activeItem?.kind !== 'conversation') return;
    const { conversation } = activeItem;
    void useChatStore.getState().togglePinned(conversation.id);
    toast.success(
      conversation.pinned
        ? tPalette('toasts.conversationUnpinned')
        : tPalette('toasts.conversationPinned'),
      {
        description: conversation.title,
      },
    );
  };

  /**
   * Single owner of Escape: always prevents the Radix default (so nothing
   * cascades to the global handler / panels), then clears the search or closes.
   */
  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    event.preventDefault();
    if (event.isComposing) return;
    if (rawQuery.length > 0) {
      setRawQuery('');
      setActiveKey(null);
      inputRef.current?.focus();
      return;
    }
    setOpen(false);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const native = event.nativeEvent;
    if (native.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        return;
      case 'Home':
        event.preventDefault();
        selectIndex(0);
        return;
      case 'End':
        event.preventDefault();
        selectIndex(flat.length - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        moveActive(PAGE_SIZE);
        return;
      case 'PageUp':
        event.preventDefault();
        moveActive(-PAGE_SIZE);
        return;
      case 'Enter':
        event.preventDefault();
        if (!activeItem) return;
        if (mod) runSecondary();
        else executeItem(activeItem);
        return;
      default:
        break;
    }

    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      moveActive(-1);
    }
  };

  const placeholder =
    parsed.scope === 'commands'
      ? tPalette('placeholders.commands')
      : parsed.scope === 'conversations'
        ? tPalette('placeholders.conversations')
        : tPalette('placeholders.all');

  const commandCount = flat.filter((item) => item.kind === 'command').length;
  const conversationCount = flat.length - commandCount;
  const announcement = conversationSearch.loading
    ? tPalette('announce.searching')
    : flat.length === 1
      ? tPalette('announce.resultsOne', { count: flat.length })
      : tPalette('announce.resultsOther', { count: flat.length });

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showClose={false}
          aria-describedby={undefined}
          onEscapeKeyDown={handleEscapeKeyDown}
          className="mt-[9vh] w-[640px] max-w-[calc(100vw-2rem)] flex-none gap-0 self-start overflow-hidden p-0"
        >
          <DialogTitle className="sr-only">{tPalette('dialog.title')}</DialogTitle>
          <DialogDescription className="sr-only">{tPalette('dialog.description')}</DialogDescription>
  
          <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4">
            <Search aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
            <input
              ref={inputRef}
              value={rawQuery}
              onChange={(event) => {
                setRawQuery(event.target.value);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={placeholder}
              aria-label={tPalette('aria.input')}
              role="combobox"
              aria-expanded
              aria-controls="zylara-palette-list"
              aria-autocomplete="list"
              aria-activedescendant={activeItem ? optionDomId(activeItem.key) : undefined}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-subtle"
            />
            {conversationSearch.loading ? (
              <Spinner size="xs" label={tPalette('announce.searching')} className="text-foreground-subtle" />
            ) : null}
            <Kbd>Esc</Kbd>
          </div>
  
          <div className="max-h-[min(420px,calc(100vh-220px))] overflow-y-auto overscroll-contain">
            <div
              id="zylara-palette-list"
              role="listbox"
              aria-label={tPalette('aria.list')}
              className={sections.length ? 'p-1.5' : 'hidden'}
            >
              {sections.map((section) => (
                <div
                  key={section.id}
                  role="group"
                  aria-labelledby={`zylara-palette-section-${section.id}`}
                  className="flex flex-col"
                >
                  <span
                    id={`zylara-palette-section-${section.id}`}
                    className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-foreground-subtle"
                  >
                    {section.label}
                  </span>
                  {section.loading ? <LoadingRows /> : null}
                  {section.fallback ? (
                    <p className="px-2.5 pb-1 text-[11px] leading-relaxed text-foreground-subtle">
                      {tPalette('sections.fallbackNote')}
                    </p>
                  ) : null}
                  {section.items.map((item) =>
                    item.kind === 'command' ? (
                      <PaletteRow
                        key={item.key}
                        id={optionDomId(item.key)}
                        action={item.action}
                        labelRanges={item.labelRanges}
                        descriptionRanges={item.descriptionRanges}
                        active={item.key === activeKey}
                        onActivate={() => setActiveKey(item.key)}
                        onExecute={() => executeItem(item)}
                        refCallback={(element) => {
                          if (element) rowRefs.current.set(item.key, element);
                          else rowRefs.current.delete(item.key);
                        }}
                      />
                    ) : (
                      <ConversationRow
                        key={item.key}
                        id={optionDomId(item.key)}
                        conversation={item.conversation}
                        titleRanges={item.titleRanges}
                        previewRanges={item.previewRanges}
                        active={item.key === activeKey}
                        matchedInContent={
                          hasQuery && item.titleRanges.length === 0 && item.previewRanges.length === 0
                        }
                        onActivate={() => setActiveKey(item.key)}
                        onExecute={() => executeItem(item)}
                        refCallback={(element) => {
                          if (element) rowRefs.current.set(item.key, element);
                          else rowRefs.current.delete(item.key);
                        }}
                      />
                    ),
                  )}
                </div>
              ))}
              <Slot name="palette.actions" owner={{ query: parsed.query }} />
            </div>
            {sections.length === 0 ? (
              conversationSearch.loading ? (
                <LoadingRows />
              ) : (
                <EmptyState query={parsed.query} scope={parsed.scope} />
              )
            ) : null}
          </div>
  
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[11px] text-foreground-subtle">
            <Slot name="palette.footer" />
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                {tPalette('footer.navigate')}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd>
                {tPalette('footer.execute')}
              </span>
              {activeItem?.kind === 'conversation' ? (
                <span className="flex items-center gap-1">
                  <Kbd>{modKey}</Kbd>
                  <Kbd>↵</Kbd>
                  {activeItem.conversation.pinned
                    ? tPalette('footer.unpin')
                    : tPalette('footer.pin')}
                </span>
              ) : null}
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd>
                {rawQuery ? tPalette('footer.clearSearch') : tPalette('footer.close')}
              </span>
              {!rawQuery ? (
                <span className="hidden sm:inline">{tPalette('footer.scopes')}</span>
              ) : null}
            </span>
            <span className="tabular-nums">
              {conversationSearch.loading && flat.length === 0 ? (
                tPalette('footer.searching')
              ) : (
                <>
                  {commandCount > 0
                    ? commandCount === 1
                      ? tPalette('footer.commandsOne', { count: commandCount })
                      : tPalette('footer.commandsOther', { count: commandCount })
                    : null}
                  {commandCount > 0 && conversationCount > 0 ? ' · ' : null}
                  {conversationCount > 0
                    ? conversationCount === 1
                      ? tPalette('footer.conversationsOne', { count: conversationCount })
                      : tPalette('footer.conversationsOther', { count: conversationCount })
                    : null}
                  {commandCount === 0 && conversationCount === 0
                    ? tPalette('footer.noResults')
                    : null}
                </>
              )}
            </span>
          </div>
  
          <div aria-live="polite" className="sr-only">
            {announcement}
          </div>
        </DialogContent>
      </Dialog>
      <CacheDiagnosticsDialog
        open={cacheDiagnosticsOpen}
        onOpenChange={setCacheDiagnosticsOpen}
      />
    </>
  );
}

export default CommandPalette;
