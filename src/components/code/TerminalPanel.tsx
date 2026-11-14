/**
 * Terminal tab of the Code right panel (WORKBENCH §7.3).
 *
 * This component is intentionally a thin view: `terminalManager` owns the PTY
 * sessions, xterm instances and IPC channels so switching to Arquivos/
 * Alterações, collapsing the panel, changing the session or closing the session
 * tab never leaks a process — the terminal list is global and only split by
 * surface. The view attaches the hosts of its surface and renders the
 * tabs/status/actions.
 */
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { CircleStop, Eraser, Plus, RotateCcw, SquareTerminal, X } from 'lucide-react';
// Mandatory: without xterm.css the viewport/screen/char-measure elements fall
// back to normal DOM flow (visible "WWWW…" measure text and broken rows).
import '@xterm/xterm/css/xterm.css';

import {
  Button,
  IconButton,
  Spinner,
  Tooltip,
} from '@/components/ui';
import { useAppStore } from '@/lib/store';
import { THEME_APPLIED_EVENT } from '@/lib/theme/apply';
import type { TerminalSurface, TerminalTabInfo } from './terminalManager';
import { terminalManager, terminalTabLabel } from './terminalManager';
import { openTerminal } from './terminalOpen';
import { useHorizontalWheelScroll } from './useHorizontalWheelScroll';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface TerminalPanelProps {
  /**
   * Session whose workspace seeds a new terminal (default: the active session,
   * then the workspace selected in the sidebar). It never scopes the list:
   * terminals opened elsewhere stay listed here.
   */
  conversationId?: string | null;
  className?: string;
  /** Which independent terminal set this view hosts (default: the right panel). */
  surface?: TerminalSurface;
  /** Hide the inner tab strip when the caller already owns the tab list. */
  showTabStrip?: boolean;
  /** Focus the xterm as soon as the hosts attach (central surface). */
  autoFocus?: boolean;
}

/** Aba "Terminal" do painel direito: abas de terminais, xterm e foco. */
export function TerminalPanel({
  conversationId,
  className,
  surface = 'panel',
  showTabStrip = true,
  autoFocus = false,
}: TerminalPanelProps) {
  const { t } = useTranslation('code');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const emptyCtaRef = useRef<HTMLButtonElement | null>(null);
  const previousTabs = useRef(0);
  useHorizontalWheelScroll(tabStripRef);
  const snapshot = useSyncExternalStore(
    terminalManager.subscribe,
    () => terminalManager.getSnapshot(surface),
    () => terminalManager.getSnapshot(surface),
  );
  const terminalFontFamilySetting = useAppStore((state) => state.settings.terminalFontFamily);
  const terminalFontSizeSetting = useAppStore((state) => state.settings.terminalFontSize);

  const { tabs, activeId, loading, error, limit, used } = snapshot;
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const atLimit = used >= limit;
  const blocked = atLimit;
  const outputId = surface === 'center' ? 'terminal-output-center' : 'terminal-output';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Focus the terminal when the user explicitly opened the Terminal tab;
    // switching sessions from the sidebar must keep focus where it was. The
    // central surface always focuses on mount (it is the active center view).
    const activeElement = document.activeElement;
    const focusTerminal =
      autoFocus ||
      (activeElement instanceof HTMLElement && activeElement.id === 'code-panel-tab-terminal');
    terminalManager.attach(container, { surface, focus: focusTerminal });
    return () => terminalManager.detach(container, surface);
  }, [surface, autoFocus]);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => terminalManager.applyTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleThemeApplied = () => {
      terminalManager.applyTheme();
      terminalManager.refitAll();
    };
    window.addEventListener(THEME_APPLIED_EVENT, handleThemeApplied);
    return () => window.removeEventListener(THEME_APPLIED_EVENT, handleThemeApplied);
  }, []);

  useEffect(() => {
    terminalManager.applyFonts();
  }, [terminalFontFamilySetting, terminalFontSizeSetting]);

  useEffect(() => {
    let cancelled = false;
    const fonts = document.fonts;
    if (fonts) {
      void fonts.ready
        .then(() => {
          if (!cancelled) terminalManager.refitAll();
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  /* Keep the active tab visible when the tab strip overflows (4 tabs in a
     narrow panel). */
  useEffect(() => {
    if (!activeId) return;
    const node = tabRefs.current.get(activeId);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeId, tabs.length]);

  /* Closing the last tab should not drop focus on <body>. */
  useEffect(() => {
    const previousCount = previousTabs.current;
    if (previousCount > 0 && tabs.length === 0) {
      emptyCtaRef.current?.focus();
    }
    previousTabs.current = tabs.length;
  }, [tabs.length]);

  const selectTab = (id: string, focusTerminal = true) => {
    terminalManager.activate(id, { focusTerminal });
  };

  const closeTab = (tab: TerminalTabInfo) => {
    void terminalManager.close(tab.id);
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    selectTab(next.id, false);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-surface', className)}>
      {showTabStrip ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          ref={tabStripRef}
          role="tablist"
          aria-label={t('code:terminal.tabsAria')}
          onMouseDown={(event) => {
            // Suppress WebView2 autoscroll on middle click.
            if (event.button === 1) event.preventDefault();
          }}
          className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const selected = activeId === tab.id;
            return (
              <div
                key={tab.id}
                role="presentation"
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  closeTab(tab);
                }}
                className={cn(
                  'flex h-7 max-w-40 shrink-0 items-center rounded-lg text-[12px] transition-colors duration-150',
                  selected
                    ? 'bg-surface-active text-foreground'
                    : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
                )}
              >
                <button
                  ref={(node) => {
                    if (node) tabRefs.current.set(tab.id, node);
                    else tabRefs.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  id={`terminal-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={outputId}
                  tabIndex={selected ? 0 : -1}
                  title={tab.cwd ? t('code:terminal.tabTitleWithCwd', { title: terminalTabLabel(tab), cwd: tab.cwd }) : terminalTabLabel(tab)}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-2 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <SquareTerminal
                    aria-hidden
                    className={cn(
                      'size-3.5 shrink-0',
                      tab.running ? 'text-foreground-subtle' : 'text-warning',
                    )}
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 truncate">{tab.title}</span>
                  {!tab.running ? (
                    <span
                      aria-hidden
                      className="ml-0.5 inline-flex size-1.5 shrink-0 rounded-full bg-warning"
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={t('code:terminal.closeTabAria', { title: tab.title })}
                  title={t('code:terminal.closeTabTitle')}
                  onClick={() => closeTab(tab)}
                  className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {active ? (
            <>
              <Tooltip content={t('code:terminal.clear')} side="bottom">
                <IconButton
                  label={t('code:terminal.clear')}
                  size="sm"
                  className="size-7"
                  onClick={() => terminalManager.clear(active.id)}
                >
                  <Eraser aria-hidden className="size-3.5" strokeWidth={1.75} />
                </IconButton>
              </Tooltip>
              {active.running ? (
                <Tooltip content={t('code:terminal.kill')} side="bottom">
                  <IconButton
                    label={t('code:terminal.kill')}
                    size="sm"
                    className="size-7"
                    disabled={active.killing}
                    onClick={() => void terminalManager.kill(active.id)}
                  >
                    {active.killing ? (
                      <Spinner size="xs" />
                    ) : (
                      <CircleStop aria-hidden className="size-4" strokeWidth={1.75} />
                    )}
                  </IconButton>
                </Tooltip>
              ) : (
                <Tooltip content={t('code:terminal.restart')} side="bottom">
                  <IconButton
                    label={t('code:terminal.restart')}
                    size="sm"
                    className="size-7"
                    disabled={loading}
                    onClick={() => void terminalManager.restart(active.id)}
                  >
                    <RotateCcw aria-hidden className="size-3.5" strokeWidth={1.75} />
                  </IconButton>
                </Tooltip>
              )}
              <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
            </>
          ) : null}
          <Tooltip
            content={atLimit ? t('code:terminal.limitHint', { limit }) : t('code:terminal.newTab')}
            side="bottom"
          >
            <span className="inline-flex">
              <IconButton
                label={t('code:terminal.newTab')}
                size="sm"
                className="size-7"
                loading={loading}
                disabled={blocked}
                onClick={() => void openTerminal(surface, conversationId)}
              >
                <Plus aria-hidden className="size-4" strokeWidth={1.75} />
              </IconButton>
            </span>
          </Tooltip>
        </div>
      </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          title={error.detail}
          className="flex shrink-0 items-center gap-2 border-b border-border bg-danger-soft/40 px-3 py-2 text-[12px] text-danger"
        >
          <span className="min-w-0 flex-1">{error.message}</span>
          {error.canRetry ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              leftIcon={<RotateCcw aria-hidden className="size-3" strokeWidth={1.75} />}
              onClick={() => void openTerminal(surface, conversationId)}
            >
              {t('common:actions.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div
        role="tabpanel"
        id={outputId}
        aria-labelledby={active ? `terminal-tab-${active.id}` : undefined}
        aria-busy={loading || undefined}
        className="relative min-h-0 flex-1 overflow-hidden bg-surface"
      >
        <div ref={containerRef} className="absolute inset-0" />
        {tabs.length === 0 && !loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[13px] font-medium text-foreground">{t('code:terminal.empty.title')}</p>
            <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">
              {t('code:terminal.empty.description')}
            </p>
            <Button
              ref={emptyCtaRef}
              variant="secondary"
              size="sm"
              className="mt-1"
              disabled={loading || blocked}
              title={atLimit ? t('code:terminal.limitHint', { limit }) : undefined}
              onClick={() => void openTerminal(surface, conversationId)}
            >
              {t('code:terminal.open')}
            </Button>
          </div>
        ) : null}
        {loading && tabs.length === 0 ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface/85 px-6 text-center">
            <Spinner size="sm" />
            <p className="text-[12px] text-foreground-muted">{t('code:terminal.connecting')}</p>
          </div>
        ) : null}
      </div>

      <div
        role="status"
        aria-live="polite"
        className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-foreground-muted"
      >
        <span className="min-w-0 flex-1 truncate" title={active?.cwd || undefined}>
          {active ? active.cwd || active.title : t('code:terminal.noneActive')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {active ? (
            active.running ? (
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 rounded-full bg-success',
                    !active.killing && 'motion-safe:animate-pulse',
                  )}
                />
                {active.killing
                  ? t('code:terminal.killing')
                  : t('code:terminal.running', { cols: active.cols, rows: active.rows })}
              </span>
            ) : (
              <span className="text-warning">
                {active.exitCode !== null
                  ? t('code:terminal.exitedCode', { code: active.exitCode })
                  : t('code:terminal.exited')}
              </span>
            )
          ) : null}
          <span className="text-foreground-muted">
            {used}/{limit}
          </span>
        </span>
      </div>
    </div>
  );
}

export default TerminalPanel;
