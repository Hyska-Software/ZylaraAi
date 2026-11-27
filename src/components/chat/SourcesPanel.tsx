import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Globe, PanelRight, X } from 'lucide-react';
import { PanelResizer } from '@/components/layout/PanelResizer';
import { Badge, IconButton, Tooltip } from '@/components/ui';
import { citationDomain, conversationCitations } from '@/lib/citations';
import { useSidePanelResize } from '@/lib/sidePanel';
import {
  selectActiveMessages,
  SIDE_PANEL_WIDTH_MIN,
  SIDE_PANEL_WIDTH_STEP,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import type { Citation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useChromeCornerReserve } from '@/components/layout/ChromeCorner';
import { openExternalUrl } from './external';

/** One source row: domain + truncated title; the whole row opens the browser. */
function SourceRow({ citation }: { citation: Citation }) {
  const domain = citationDomain(citation);
  const title = citation.title?.trim() || domain;

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => void openExternalUrl(citation.url)}
        title={title}
        className={cn(
          'group/source flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left',
          'transition-colors duration-150 hover:bg-surface-hover',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        )}
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[10px] font-semibold uppercase leading-none text-accent"
        >
          {domain.charAt(0) || '•'}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-snug text-foreground">
            {domain}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-snug text-foreground-muted">
            {title}
          </span>
        </span>

        <ExternalLink
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-foreground-subtle opacity-0 transition-opacity duration-150',
            'group-hover/source:opacity-100 group-focus-visible/source:opacity-100',
            'motion-reduce:transition-none',
          )}
        />
      </button>
    </li>
  );
}

/**
 * Side panel listing every source (citation) of the conversation (DESIGN §5),
 * in first-use order and deduplicated by URL. Same surface as the artifact
 * panel; visibility and mutual exclusion live in `useUiStore`.
 *
 * It either floats over the chat (overlay, translated 240ms) or, when there is
 * room and the user pinned it, splits the content row as a docked column. The
 * responsive decision and the persisted width live in `useSidePanelResize`.
 */
export function SourcesPanel() {
  const { t } = useTranslation('chat');
  const open = useUiStore((state) => state.sourcesPanelOpen);
  const closeSourcesPanel = useUiStore((state) => state.closeSourcesPanel);
  const messages = useChatStore(selectActiveMessages);
  const sources = useMemo(() => conversationCitations(messages), [messages]);
  const panelRef = useRef<HTMLElement | null>(null);
  const { layout, mode, setMode, onResize, onResizeEnd, onReset } = useSidePanelResize();
  // Rightmost surface: the header clears the window-controls corner.
  const chromeReserve = useChromeCornerReserve('dock');

  /** Source count label: only `1` is singular (0 reads as plural). */
  const sourceCount = (count: number) =>
    count === 1
      ? t('sources.countOne', { count })
      : t('sources.countMany', { count });

  /** Pin/unpin action; the docked preference can outlive a narrow window. */
  const modeToggleLabel = mode === 'docked' ? t('sources.unpin') : t('sources.pin');
  const modeToggleDisabled = !layout.canDock && mode !== 'docked';
  const modeTooltip = modeToggleDisabled ? t('sources.pinHint') : modeToggleLabel;
  const modeToggle = (
    <IconButton
      label={modeToggleLabel}
      size="sm"
      active={mode === 'docked'}
      disabled={modeToggleDisabled}
      onClick={() => setMode(mode === 'docked' ? 'overlay' : 'docked')}
    >
      <PanelRight className="size-4" />
    </IconButton>
  );

  // Move focus into the panel when it opens so keyboard users can browse the list.
  useEffect(() => {
    if (!open) return undefined;
    const handle = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [open]);

  /* Docked: an in-flow column next to the chat. Overlay: absolutely positioned
     over the chat (containing block = AppShell's content row) and translated
     out of view when closed. */
  const asideClassName = layout.docked
    ? cn(
        'relative z-10 flex h-full shrink-0 flex-col border-l border-border bg-surface-raised outline-none',
        !open && 'hidden',
      )
    : cn(
        'absolute inset-y-0 right-0 z-40 flex max-w-[92vw] flex-col border-l border-border bg-surface-raised shadow-2xl outline-none',
        'transition-transform duration-[240ms] ease-[var(--ease-out-soft)] motion-reduce:transition-none',
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
      );

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label={t('sources.panelAria')}
      aria-hidden={!open || undefined}
      inert={!open}
      style={{
        width: layout.width,
        // Closed docked panel: hide structurally (inline) so two surfaces can
        // never end up side by side, regardless of utility-class merging.
        ...(layout.docked && !open ? { display: 'none' } : null),
      }}
      className={asideClassName}
    >
      <header
        className={cn(
          'flex shrink-0 items-center gap-2 border-b border-border py-2 pl-3',
          chromeReserve,
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Globe aria-hidden className="size-4" strokeWidth={1.9} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-foreground">
          {t('sources.title')}
        </h2>
        <Badge
          tone="muted"
          size="md"
          title={sourceCount(sources.length)}
          className="tabular-nums"
        >
          {sources.length}
        </Badge>
        <Tooltip content={modeTooltip} side="bottom">
          {/* Disabled buttons swallow pointer events: hover a wrapper so the
              "aumente a janela" hint stays discoverable. */}
          {modeToggleDisabled ? <span className="inline-flex">{modeToggle}</span> : modeToggle}
        </Tooltip>
        <Tooltip content={t('sources.closeTooltip')} side="bottom">
          <IconButton label={t('sources.close')} size="sm" onClick={closeSourcesPanel}>
            <X className="size-4" />
          </IconButton>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sources.length > 0 ? (
          <ul aria-label={t('sources.listAria')} className="flex min-w-0 flex-col gap-0.5">
            {sources.map((citation) => (
              <SourceRow key={citation.id || citation.url} citation={citation} />
            ))}
          </ul>
        ) : (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <Globe aria-hidden className="size-6 text-foreground-subtle" strokeWidth={1.9} />
            <p className="text-[13px] font-medium text-foreground">{t('sources.emptyTitle')}</p>
            <p className="max-w-64 text-xs leading-relaxed text-foreground-muted">
              {t('sources.emptyBody')}
            </p>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2 text-[11px] text-foreground-subtle">
        <span className="tabular-nums">{sourceCount(sources.length)}</span>
        <span>{t('sources.opensExternally')}</span>
      </footer>

      {/* Fora do fluxo, sobre a borda esquerda: não cobre a lista nem a scrollbar.
          O próprio aside (absolute no overlay, relative no docked) é o containing
          block do handle. */}
      <PanelResizer
        side="end"
        value={layout.width}
        min={SIDE_PANEL_WIDTH_MIN}
        max={layout.maxWidth}
        step={SIDE_PANEL_WIDTH_STEP}
        label={t('sources.resize')}
        className="absolute inset-y-0 -left-2 z-10"
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onReset={onReset}
      />
    </aside>
  );
}

export default SourcesPanel;
