/**
 * Owner of the interactive terminals of the Code layout.
 *
 * The PTY sessions must outlive React remounts and the Code session they were
 * opened from: the right panel is unmounted when the user switches to
 * Arquivos/Alterações, collapses the panel, resizes the window below the dock
 * breakpoint, switches session/workspace or closes the session tab. Keeping the
 * xterm instances + IPC channels here (one global runtime, split only by
 * surface) means those changes never leak a PTY nor hide a running terminal:
 * a tab opened in one workspace stays listed and usable everywhere in the Code
 * layout until the user closes it.
 *
 * The `TerminalPanel` is only a view: it attaches/detaches the hosts and reads
 * snapshots through `useSyncExternalStore`.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type IDisposable, type ITheme } from '@xterm/xterm';

import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAppStore } from '@/lib/store';
import { normalizeTerminalFontSize } from '@/lib/terminalSettings';
import type { TerminalEvent, TerminalInfo, TerminalTarget } from '@/lib/types';
import { createTerminalLinkHandler, createTerminalUrlLinkProvider } from './terminalLinks';
import {
  buildTerminalTheme,
  prefersReducedMotion,
  terminalFontFamily,
} from './terminalTheme';

/** Mirrors `MAX_TERMINALS` in the Rust terminal registry (global cap). */
export const TERMINAL_TAB_LIMIT = 4;

/** Two independent terminal surfaces split one global PTY list. */
export type TerminalSurface = 'panel' | 'center';

export interface TerminalErrorState {
  code: string;
  /** Friendly message shown to the user (pt-BR). */
  message: string;
  /** Raw backend error, used as tooltip/diagnostic. */
  detail: string;
  canRetry: boolean;
}

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
  killing: boolean;
}

export interface TerminalSnapshot {
  tabs: TerminalTabInfo[];
  activeId: string | null;
  loading: boolean;
  error: TerminalErrorState | null;
  limit: number;
  /** Total terminals in the conversation (both surfaces share the backend cap). */
  used: number;
}

interface TerminalInstance {
  id: string;
  /** Folder the terminal was opened in; only used to restart in the same place. */
  target: TerminalTarget;
  surface: TerminalSurface;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
  killing: boolean;
  exitWritten: boolean;
  writeErrorWritten: boolean;
  disposed: boolean;
  term: XTerm;
  fit: FitAddon;
  host: HTMLDivElement;
  input: IDisposable | null;
  observer: ResizeObserver | null;
}

/**
 * Process-wide terminals of the Code layout. The list is *not* keyed by
 * conversation: switching session/workspace (or closing the session tab) must
 * keep every terminal visible, so only the surface splits the list.
 */
interface TerminalRuntime {
  instances: Map<string, TerminalInstance>;
  order: string[];
  activeIds: Record<TerminalSurface, string | null>;
  loadingBySurface: Record<TerminalSurface, boolean>;
  errors: Record<TerminalSurface, TerminalErrorState | null>;
  containers: Record<TerminalSurface, HTMLElement | null>;
  nextIndex: number;
  snapshots: Record<TerminalSurface, TerminalSnapshot>;
  reconciled: boolean;
  reconcile: Promise<void> | null;
}

const EMPTY_SNAPSHOT: TerminalSnapshot = {
  tabs: [],
  activeId: null,
  loading: false,
  error: null,
  limit: TERMINAL_TAB_LIMIT,
  used: 0,
};

/** Fresh global runtime; `snapshots` must stay referentially stable per surface. */
function createRuntime(): TerminalRuntime {
  const runtime: TerminalRuntime = {
    instances: new Map(),
    order: [],
    activeIds: { panel: null, center: null },
    loadingBySurface: { panel: false, center: false },
    errors: { panel: null, center: null },
    containers: { panel: null, center: null },
    nextIndex: 1,
    snapshots: { panel: EMPTY_SNAPSHOT, center: EMPTY_SNAPSHOT },
    reconciled: false,
    reconcile: null,
  };
  runtime.snapshots = {
    panel: buildSnapshot(runtime, 'panel'),
    center: buildSnapshot(runtime, 'center'),
  };
  return runtime;
}

/** Label shared by the right-panel tabs and the central terminal tabs. */
export function terminalTabLabel(tab: TerminalTabInfo): string {
  return tab.running ? tab.title : t('code:terminal.tabClosed', { title: tab.title });
}

/** Human copy for the stable `TERMINAL_*` error codes, resolved at call time. */
function terminalErrorMessage(code: string): string {
  switch (code) {
    case 'TERMINAL_LIMIT':
      return t('code:terminal.error.limit');
    case 'TERMINAL_NO_WORKSPACE':
      return t('code:terminal.error.noWorkspace');
    case 'TERMINAL_WORKSPACE_MISSING':
      return t('code:terminal.error.workspaceMissing');
    case 'TERMINAL_CONVERSATION_NOT_FOUND':
      return t('code:terminal.error.conversationNotFound');
    case 'TERMINAL_CONVERSATION':
      return t('code:terminal.error.conversation');
    case 'TERMINAL_SPAWN':
      return t('code:terminal.error.spawn');
    case 'TERMINAL_READ':
      return t('code:terminal.error.read');
    case 'TERMINAL_WRITE':
      return t('code:terminal.error.write');
    case 'TERMINAL_RESIZE':
      return t('code:terminal.error.resize');
    case 'TERMINAL_NOT_FOUND':
      return t('code:terminal.error.notFound');
    case 'TERMINAL_EXITED':
      return t('code:terminal.error.exited');
    case 'TERMINAL_CLOSE':
      return t('code:terminal.error.close');
    case 'TERMINAL_KILL':
      return t('code:terminal.error.kill');
    default:
      return t('code:terminal.error.fallback');
  }
}

const RETRYABLE_CODES = new Set([
  'TERMINAL_SPAWN',
  'TERMINAL_READ',
  'TERMINAL_WRITE',
  'TERMINAL_RESIZE',
  'TERMINAL_CLOSE',
  'TERMINAL_KILL',
  'TERMINAL_ERROR',
]);

function errorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z0-9_]+):/.exec(raw);
  return match?.[1] ?? 'TERMINAL_ERROR';
}

function toTerminalError(error: unknown): TerminalErrorState {
  const raw = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return {
    code,
    message: terminalErrorMessage(code),
    detail: raw,
    canRetry: RETRYABLE_CODES.has(code),
  };
}

function schedule(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback);
  } else {
    setTimeout(callback, 0);
  }
}

function terminalHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.className = 'absolute inset-0';
  host.dataset.terminalHost = 'true';
  host.style.opacity = '0';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', t('code:terminal.hostLabel'));
  return host;
}

interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
}

/** Terminal typography from the persisted settings (theme mono by default). */
function terminalAppearance(): TerminalAppearance {
  const settings = useAppStore.getState().settings;
  return {
    fontFamily: terminalFontFamily(settings.terminalFontFamily),
    fontSize: normalizeTerminalFontSize(settings.terminalFontSize),
  };
}

function createTerminal(appearance: TerminalAppearance): XTerm {
  const term = new XTerm({
    cursorBlink: !prefersReducedMotion(),
    fontFamily: appearance.fontFamily,
    fontSize: appearance.fontSize,
    scrollback: 5_000,
    allowProposedApi: true,
    screenReaderMode: true,
    theme: buildTerminalTheme(),
    // OSC 8 hyperlinks use the same validated opener instead of xterm's confirm.
    linkHandler: createTerminalLinkHandler(),
  });
  // Plain http(s) URLs printed by PTY commands become clickable too.
  term.registerLinkProvider(createTerminalUrlLinkProvider(term));
  return term;
}

/** Waits for the configured font before measuring cells (avoids stale rows/columns). */
async function loadTerminalFont(appearance: TerminalAppearance): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  try {
    await document.fonts.load(`${appearance.fontSize}px ${appearance.fontFamily}`);
  } catch {
    // Fall back to the bundled stack; FitAddon will measure whatever loads.
  }
}

/** Imperative store used by the Code layout terminal panel. */
class TerminalManager {
  private runtime: TerminalRuntime = createRuntime();
  private listeners = new Set<() => void>();
  private staging: HTMLDivElement | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Stable snapshot of one surface (identity only changes when something did). */
  getSnapshot(surface: TerminalSurface = 'panel'): TerminalSnapshot {
    return this.runtime.snapshots[surface];
  }

  /** Appends the hosts of one surface to its visible container. */
  attach(
    container: HTMLElement,
    options: { surface?: TerminalSurface; focus?: boolean } = {},
  ): void {
    const surface = options.surface ?? 'panel';
    const runtime = this.runtime;
    if (runtime.containers[surface] === container) return;
    if (runtime.containers[surface]) this.detachHosts(runtime, surface);
    runtime.containers[surface] = container;
    // The container belongs exclusively to this surface's hosts; clearing it
    // protects against stale hosts from a previous implementation/HMR.
    container.replaceChildren();
    for (const id of runtime.order) {
      const instance = runtime.instances.get(id);
      if (instance?.surface === surface) container.appendChild(instance.host);
    }
    this.applyTheme();
    this.syncVisibility(runtime);
    const focus = options.focus === true;
    schedule(() => {
      if (focus) this.focusActive(runtime, surface);
      else this.fitActive(runtime, surface);
    });
    void this.reconcile();
  }

  /** Detaches the hosts without destroying the PTY or the xterm buffer. */
  detach(container?: HTMLElement, surface: TerminalSurface = 'panel'): void {
    const runtime = this.runtime;
    if (container && runtime.containers[surface] && runtime.containers[surface] !== container) {
      return;
    }
    this.detachHosts(runtime, surface);
    runtime.containers[surface] = null;
  }

  async open(target: TerminalTarget, surface: TerminalSurface = 'panel'): Promise<string | null> {
    const runtime = this.runtime;
    if (runtime.loadingBySurface[surface]) return null;
    if (runtime.instances.size >= TERMINAL_TAB_LIMIT) {
      runtime.errors[surface] = toTerminalError(
        `TERMINAL_LIMIT: máximo de ${TERMINAL_TAB_LIMIT}`,
      );
      this.notify(runtime);
      return null;
    }
    await this.reconcile();
    if (runtime.loadingBySurface[surface]) return null;
    if (runtime.instances.size >= TERMINAL_TAB_LIMIT) {
      runtime.errors[surface] = toTerminalError(
        `TERMINAL_LIMIT: máximo de ${TERMINAL_TAB_LIMIT}`,
      );
      this.notify(runtime);
      return null;
    }

    runtime.loadingBySurface[surface] = true;
    runtime.errors[surface] = null;
    this.notify(runtime);

    const appearance = terminalAppearance();
    await loadTerminalFont(appearance);

    const term = createTerminal(appearance);
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = terminalHost();
    const instance: TerminalInstance = {
      id: '',
      target,
      surface,
      title: '',
      cwd: '',
      cols: term.cols || 80,
      rows: term.rows || 24,
      running: true,
      exitCode: null,
      killing: false,
      exitWritten: false,
      writeErrorWritten: false,
      disposed: false,
      term,
      fit,
      host,
      input: null,
      observer: null,
    };

    try {
      const parent = this.hostParent(runtime, surface);
      parent.appendChild(host);
      term.open(host);
      try {
        fit.fit();
      } catch {
        // No dimensions on the first paint; the ResizeObserver retries.
      }
      instance.cols = term.cols || 80;
      instance.rows = term.rows || 24;

      const info = await api.openTerminal(
        target,
        instance.cols,
        instance.rows,
        (event) => this.handleEvent(instance, event),
      );

      if (instance.disposed) {
        void api.closeTerminal(info.id).catch(() => undefined);
        return null;
      }

      instance.id = info.id;
      instance.cwd = info.cwd;
      // The process may have exited before this promise resolved: never
      // resurrect an exit event handled while the invoke was in flight.
      instance.running = instance.running && info.running;
      if (instance.exitCode === null) instance.exitCode = info.exitCode ?? null;
      if (!instance.running) {
        instance.term.options.disableStdin = true;
        instance.term.options.cursorBlink = false;
      }
      instance.cols = info.cols || instance.cols;
      instance.rows = info.rows || instance.rows;
      instance.title = t('code:terminal.title', { index: runtime.nextIndex });
      instance.host.dataset.terminalId = instance.id;
      runtime.nextIndex += 1;

      runtime.instances.set(instance.id, instance);
      runtime.order.push(instance.id);
      runtime.activeIds[surface] = instance.id;

      const container = runtime.containers[surface];
      if (container) {
        container.appendChild(instance.host);
      } else {
        instance.host.remove();
      }

      instance.input = term.onData((data) => {
        if (instance.disposed || !instance.running) return;
        void api.writeTerminal(instance.id, data).catch((writeError: unknown) => {
          if (instance.disposed || instance.writeErrorWritten) return;
          const code = errorCode(writeError);
          if (code === 'TERMINAL_EXITED' || code === 'TERMINAL_NOT_FOUND') return;
          instance.writeErrorWritten = true;
          instance.term.write(
            `\r\n\x1b[31m${terminalErrorMessage('TERMINAL_WRITE')}\x1b[0m\r\n`,
          );
        });
      });

      instance.observer = new ResizeObserver(() => {
        if (!instance.disposed) this.fitInstance(runtime, instance);
      });
      instance.observer.observe(instance.host);

      this.syncVisibility(runtime);
      this.notify(runtime);
      schedule(() => {
        this.fitInstance(runtime, instance);
        if (runtime.activeIds[surface] === instance.id) instance.term.focus();
      });
    } catch (openError) {
      instance.disposed = true;
      instance.observer?.disconnect();
      instance.input?.dispose();
      instance.host.remove();
      term.dispose();
      const parsed = toTerminalError(openError);
      runtime.errors[surface] = parsed;
      if (parsed.code === 'TERMINAL_LIMIT' && runtime.instances.size < TERMINAL_TAB_LIMIT) {
        // The backend may still hold orphans from a previous webview: allow
        // the next attempt to reconcile instead of leaving the panel stuck.
        runtime.reconciled = false;
      }
    } finally {
      runtime.loadingBySurface[surface] = false;
      this.notify(runtime);
    }
    return instance.disposed ? null : instance.id;
  }

  activate(id: string, options: { focusTerminal?: boolean } = {}): void {
    const runtime = this.runtime;
    const instance = runtime.instances.get(id);
    if (!instance) return;
    runtime.activeIds[instance.surface] = id;
    this.syncVisibility(runtime);
    this.notify(runtime);
    schedule(() => {
      this.fitInstance(runtime, instance);
      if (options.focusTerminal !== false) instance.term.focus();
    });
  }

  /**
   * Reorders the given live terminals within the global order. Terminals from
   * the other surface keep their slots, so a drag in one strip never reshuffles
   * the other strip beyond the terminals actually moved.
   */
  reorderTabs(ids: readonly string[]): void {
    const runtime = this.runtime;
    const moving = [...new Set(ids)].filter((id) => runtime.instances.has(id));
    if (moving.length < 2) return;
    const slots: number[] = [];
    for (let index = 0; index < runtime.order.length; index += 1) {
      if (moving.includes(runtime.order[index])) slots.push(index);
    }
    if (slots.length === 0) return;
    const next = [...runtime.order];
    for (let index = 0; index < slots.length; index += 1) {
      next[slots[index]] = moving[index] ?? next[slots[index]];
    }
    if (next.every((id, index) => id === runtime.order[index])) return;
    runtime.order = next;
    this.notify(runtime);
  }

  async close(id: string): Promise<void> {
    const runtime = this.runtime;
    const instance = runtime.instances.get(id);
    if (!instance) return;
    const surface = instance.surface;
    const surfaceOrder = runtime.order.filter(
      (terminalId) => runtime.instances.get(terminalId)?.surface === surface,
    );
    const index = surfaceOrder.indexOf(id);
    this.removeInstance(runtime, instance);
    if (runtime.activeIds[surface] === id) {
      runtime.activeIds[surface] = surfaceOrder[index + 1] ?? surfaceOrder[index - 1] ?? null;
    }
    if (runtime.instances.size === 0) runtime.nextIndex = 1;
    this.syncVisibility(runtime);
    this.notify(runtime);
    schedule(() => this.focusActive(runtime, surface));

    try {
      await api.closeTerminal(id);
      runtime.errors[surface] = null;
      this.notify(runtime);
    } catch (closeError) {
      runtime.errors[surface] = {
        ...toTerminalError(closeError),
        code: 'TERMINAL_CLOSE',
        message: terminalErrorMessage('TERMINAL_CLOSE'),
        canRetry: false,
      };
      this.notify(runtime);
    }
  }

  async kill(id: string): Promise<void> {
    const runtime = this.runtime;
    const instance = runtime.instances.get(id);
    if (!instance || !instance.running || instance.killing) return;
    const surface = instance.surface;
    instance.killing = true;
    runtime.errors[surface] = null;
    this.notify(runtime);
    try {
      await api.killTerminal(id);
    } catch (killError) {
      instance.killing = false;
      runtime.errors[surface] = {
        ...toTerminalError(killError),
        code: 'TERMINAL_KILL',
        message: terminalErrorMessage('TERMINAL_KILL'),
        canRetry: false,
      };
      this.notify(runtime);
    }
  }

  clear(id: string): void {
    const instance = this.runtime.instances.get(id);
    if (!instance) return;
    instance.term.clear();
    instance.term.focus();
  }

  async restart(id: string): Promise<void> {
    const runtime = this.runtime;
    const instance = runtime.instances.get(id);
    if (!instance) return;
    const surface = instance.surface;
    // The new shell must run in the folder of the terminal that was closed,
    // even when the user is looking at another session/workspace.
    const target = instance.target;
    const wasActive = runtime.activeIds[surface] === id;
    await this.close(id);
    await this.open(target, surface);
    // Restart is only offered for the active terminal; the new terminal is
    // already active. No extra focus dance is needed.
    if (!wasActive) schedule(() => this.focusActive(runtime, surface));
  }

  /** Closes every terminal of a conversation (session deletion/shutdown). */
  async closeConversation(conversationId: string): Promise<void> {
    const runtime = this.runtime;
    const ids = runtime.order.filter(
      (id) => runtime.instances.get(id)?.target.conversationId === conversationId,
    );
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => this.close(id)));
    runtime.errors.panel = null;
    runtime.errors.center = null;
    this.notify(runtime);
  }

  /** Re-applies the app theme and terminal typography to every live xterm. */
  applyTheme(): void {
    const theme: ITheme = buildTerminalTheme();
    const { fontFamily, fontSize } = terminalAppearance();
    for (const instance of this.runtime.instances.values()) {
      if (!instance.disposed) {
        instance.term.options.theme = theme;
        instance.term.options.fontFamily = fontFamily;
        instance.term.options.fontSize = fontSize;
      }
    }
  }

  /** Applies a terminal font change to every live xterm and refits the PTY. */
  applyFonts(): void {
    const appearance = terminalAppearance();
    for (const instance of this.runtime.instances.values()) {
      if (!instance.disposed) {
        instance.term.options.fontFamily = appearance.fontFamily;
        instance.term.options.fontSize = appearance.fontSize;
      }
    }
    this.refitAll();
    void loadTerminalFont(appearance).then(() => this.refitAll());
  }

  /** Refits after the web font finishes loading (or the panel changes size). */
  refitAll(): void {
    for (const instance of this.runtime.instances.values()) {
      if (!instance.disposed) this.fitInstance(this.runtime, instance);
    }
  }

  /** Test-only reset; never used in production. */
  resetForTests(): void {
    for (const instance of this.runtime.instances.values()) {
      instance.disposed = true;
      instance.observer?.disconnect();
      instance.input?.dispose();
      instance.host.remove();
      instance.term.dispose();
    }
    this.runtime = createRuntime();
    this.listeners.clear();
    this.staging?.remove();
    this.staging = null;
  }

  private notify(runtime: TerminalRuntime): void {
    runtime.snapshots = {
      panel: buildSnapshot(runtime, 'panel'),
      center: buildSnapshot(runtime, 'center'),
    };
    for (const listener of this.listeners) listener();
  }

  private removeInstance(runtime: TerminalRuntime, instance: TerminalInstance): void {
    instance.disposed = true;
    runtime.instances.delete(instance.id);
    const index = runtime.order.indexOf(instance.id);
    if (index >= 0) runtime.order.splice(index, 1);
    instance.observer?.disconnect();
    instance.input?.dispose();
    instance.host.remove();
    instance.term.dispose();
  }

  private detachHosts(runtime: TerminalRuntime, surface: TerminalSurface): void {
    const container = runtime.containers[surface];
    if (!container) return;
    container.replaceChildren();
  }

  private syncVisibility(runtime: TerminalRuntime): void {
    for (const [id, instance] of runtime.instances) {
      const active = id === runtime.activeIds[instance.surface];
      instance.host.hidden = !active;
      instance.host.style.opacity = active ? '' : '0';
      if (active) instance.host.removeAttribute('aria-hidden');
      else instance.host.setAttribute('aria-hidden', 'true');
    }
  }

  private fitInstance(runtime: TerminalRuntime, instance: TerminalInstance): void {
    if (instance.disposed) return;
    if (!runtime.containers[instance.surface] || !instance.host.isConnected) return;
    if (runtime.activeIds[instance.surface] !== instance.id) return;
    try {
      instance.fit.fit();
    } catch {
      return;
    }
    const cols = instance.term.cols;
    const rows = instance.term.rows;
    if (!cols || !rows) return;
    if (cols === instance.cols && rows === instance.rows) return;
    instance.cols = cols;
    instance.rows = rows;
    void api.resizeTerminal(instance.id, cols, rows).catch(() => undefined);
    this.notify(runtime);
  }

  private focusActive(runtime: TerminalRuntime, surface: TerminalSurface): void {
    if (!runtime.containers[surface]) return;
    const activeId = runtime.activeIds[surface];
    const instance = activeId ? runtime.instances.get(activeId) : null;
    if (!instance || instance.disposed) return;
    this.fitInstance(runtime, instance);
    instance.term.focus();
  }

  private fitActive(runtime: TerminalRuntime, surface: TerminalSurface): void {
    if (!runtime.containers[surface]) return;
    const activeId = runtime.activeIds[surface];
    if (!activeId) return;
    const instance = runtime.instances.get(activeId);
    if (!instance || instance.disposed) return;
    this.fitInstance(runtime, instance);
  }

  /**
   * Opens the xterm even if the panel was closed while the IPC call was in
   * flight. The staging container is off-screen and only used for measuring;
   * the host is moved to the real container as soon as it is attached again.
   */
  private hostParent(runtime: TerminalRuntime, surface: TerminalSurface): HTMLElement {
    const container = runtime.containers[surface];
    if (container) return container;
    if (!this.staging) {
      const staging = document.createElement('div');
      staging.style.position = 'fixed';
      staging.style.left = '-10000px';
      staging.style.top = '-10000px';
      staging.style.width = '480px';
      staging.style.height = '320px';
      staging.style.visibility = 'hidden';
      staging.setAttribute('aria-hidden', 'true');
      document.body.appendChild(staging);
      this.staging = staging;
    }
    return this.staging;
  }

  private handleEvent(instance: TerminalInstance, event: TerminalEvent): void {
    if (instance.disposed) return;
    if (event.type === 'data') {
      instance.term.write(event.data);
      return;
    }
    instance.running = false;
    instance.killing = false;
    instance.exitCode = event.code ?? null;
    instance.term.options.disableStdin = true;
    instance.term.options.cursorBlink = false;
    if (!instance.exitWritten) {
      instance.exitWritten = true;
      const detail =
        instance.exitCode !== null && instance.exitCode !== undefined
          ? t('code:terminal.exitCode', { code: instance.exitCode })
          : '';
      instance.term.write(
        `\r\n\x1b[90m${t('code:terminal.exitNotice', { detail })}\x1b[0m\r\n`,
      );
    }
    const runtime = this.runtime;
    this.notify(runtime);
  }

  /**
   * Closes sessions that exist in the backend but not in this renderer. This
   * happens after a webview reload/HMR: the old channels are gone, so the
   * PTYs cannot be reattached and must be cleaned up instead of silently
   * consuming the global limit.
   */
  private reconcile(): Promise<void> {
    const runtime = this.runtime;
    if (runtime.reconciled) return Promise.resolve();
    if (runtime.reconcile) return runtime.reconcile;
    runtime.reconcile = (async () => {
      try {
        const sessions: TerminalInfo[] = await api.listTerminals();
        for (const session of sessions) {
          if (runtime.instances.has(session.id)) continue;
          await api.closeTerminal(session.id).catch(() => undefined);
        }
      } catch {
        // Older backend or IPC hiccup: opening still works and the panel can
        // surface the real error from `open`.
      } finally {
        runtime.reconciled = true;
        runtime.reconcile = null;
      }
    })();
    return runtime.reconcile;
  }
}

/** Snapshot of one surface; rebuilt by `notify` so identity tracks real changes. */
function buildSnapshot(runtime: TerminalRuntime, surface: TerminalSurface): TerminalSnapshot {
  const tabs: TerminalTabInfo[] = [];
  for (const id of runtime.order) {
    const instance = runtime.instances.get(id);
    if (!instance || instance.surface !== surface) continue;
    tabs.push({
      id: instance.id,
      title: instance.title,
      cwd: instance.cwd,
      cols: instance.cols,
      rows: instance.rows,
      running: instance.running,
      exitCode: instance.exitCode,
      killing: instance.killing,
    });
  }
  return {
    tabs,
    activeId: runtime.activeIds[surface],
    loading: runtime.loadingBySurface[surface],
    error: runtime.errors[surface],
    limit: TERMINAL_TAB_LIMIT,
    used: runtime.instances.size,
  };
}

export const terminalManager = new TerminalManager();

/** Test-only helper; keeps the singleton from leaking between Vitest cases. */
export function __resetTerminalManagerForTests(): void {
  terminalManager.resetForTests();
}
