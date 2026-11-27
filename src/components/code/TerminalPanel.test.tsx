// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { TerminalEvent, TerminalInfo } from '@/lib/types';

/** Instances, options and link providers of every fake xterm, in creation order. */
const xtermRegistry = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  instances: [] as Record<string, unknown>[],
  providers: [] as Array<{
    provideLinks(y: number, callback: (links: unknown[] | undefined) => void): void;
  }>,
}));

const externalMock = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock('@/components/chat/external', () => ({ openExternalUrl: externalMock.openExternalUrl }));

/** xterm needs a canvas; the test validates the wiring with the backend, not the render. */
vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    cols = 100;
    rows = 24;
    written: string[] = [];
    focused = false;
    cleared = false;
    options: Record<string, unknown>;
    host: HTMLElement | null = null;
    buffer = { active: { getLine: (_index: number): unknown => undefined } };
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      xtermRegistry.options.push(this.options);
      xtermRegistry.instances.push(this as unknown as Record<string, unknown>);
    }
    loadAddon() {}
    open(host: HTMLElement) {
      this.host = host;
    }
    focus() {
      this.focused = true;
    }
    write(data: string) {
      this.written.push(data);
    }
    clear() {
      this.cleared = true;
    }
    dispose() {}
    onData(handler: (data: string) => void) {
      (this as unknown as { handler: (data: string) => void }).handler = handler;
      return { dispose: () => undefined };
    }
    registerLinkProvider(provider: {
      provideLinks(y: number, callback: (links: unknown[] | undefined) => void): void;
    }) {
      xtermRegistry.providers.push(provider);
      return { dispose: () => undefined };
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const apiMock = vi.hoisted(() => ({
  openTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  killTerminal: vi.fn(),
  listTerminals: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { useAppStore, useChatStore, useUiStore } from '@/lib/store';
import { TerminalPanel } from './TerminalPanel';
import { __resetTerminalManagerForTests, terminalManager } from './terminalManager';
import { TERMINAL_DEFAULT_FONT_FAMILY } from './terminalTheme';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let nextTerminal = 0;

function terminalInfo(id = `term-${nextTerminal}`): TerminalInfo {
  nextTerminal += 1;
  return {
    id,
    conversationId: 'conv-1',
    title: 'zylara',
    cwd: 'C:/projetos/zylara',
    cols: 100,
    rows: 24,
    running: true,
    exitCode: null,
  };
}

function lastCallback(): (event: TerminalEvent) => void {
  const calls = apiMock.openTerminal.mock.calls;
  return calls[calls.length - 1]?.[3] as (event: TerminalEvent) => void;
}

function hosts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-host]'));
}

beforeEach(() => {
  vi.clearAllMocks();
  nextTerminal = 1;
  __resetTerminalManagerForTests();
  xtermRegistry.options.length = 0;
  xtermRegistry.instances.length = 0;
  xtermRegistry.providers.length = 0;
  externalMock.openExternalUrl.mockReset();
  useChatStore.setState({ activeId: null });
  useUiStore.setState({ activeWorkspaceId: null });
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
  apiMock.openTerminal.mockImplementation(async () => terminalInfo());
  apiMock.writeTerminal.mockResolvedValue(undefined);
  apiMock.resizeTerminal.mockResolvedValue(undefined);
  apiMock.closeTerminal.mockResolvedValue(true);
  apiMock.killTerminal.mockResolvedValue(undefined);
  apiMock.listTerminals.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('TerminalPanel', () => {
  it('abre um terminal no workspace e fecha a aba com o backend', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    expect(screen.getByText('Nenhum terminal aberto')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));

    await waitFor(() => {
      expect(apiMock.openTerminal).toHaveBeenCalledWith(
        { conversationId: 'conv-1' },
        100,
        24,
        expect.any(Function),
      );
    });
    expect(await screen.findByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(screen.getByText('C:/projetos/zylara')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fechar Terminal 1' }));

    // Closing a running terminal is immediate: no confirmation dialog.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(apiMock.closeTerminal).toHaveBeenCalledWith('term-1'));
    expect(screen.queryByRole('tab', { name: 'Terminal 1' })).toBeNull();
    expect(screen.getByText('Nenhum terminal aberto')).toBeTruthy();
  });

  it('usa a mesma superfície da sidebar como fundo do painel', () => {
    const { container } = render(<TerminalPanel conversationId="conv-1" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bg-surface');
    expect(root.className).not.toContain('bg-surface-raised');

    // The terminal viewport must not fall back to the chat `background` tone.
    const viewport = container.querySelector('[role="tabpanel"]');
    expect(viewport?.className).toContain('bg-surface');
    expect(viewport?.className).not.toContain('bg-background');
  });

  it('applies the terminal font preference to open xterms', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });
    expect(xtermRegistry.options[0]?.fontSize).toBe(12);

    act(() => {
      useAppStore.setState((state) => ({
        settings: { ...state.settings, terminalFontFamily: 'Fira Code', terminalFontSize: 18 },
      }));
    });

    await waitFor(() => {
      // A preference without a generic family keeps JetBrains Mono as its fallback.
      expect(xtermRegistry.options[0]?.fontFamily).toBe(
        `Fira Code, ${TERMINAL_DEFAULT_FONT_FAMILY}`,
      );
      expect(xtermRegistry.options[0]?.fontSize).toBe(18);
    });
  });

  it('abre URLs impressas no terminal no navegador do sistema', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    expect(xtermRegistry.options[0]?.linkHandler).toBeDefined();
    expect(xtermRegistry.providers).toHaveLength(1);

    const fake = xtermRegistry.instances[0] as {
      buffer: {
        active: {
          getLine: (index: number) => { translateToString: () => string } | undefined;
        };
      };
    };
    fake.buffer.active.getLine = (index) =>
      index === 5 ? { translateToString: () => '  Local:   http://localhost:1420/' } : undefined;

    type RecordedLink = {
      text: string;
      activate: (event: MouseEvent, text: string) => void;
    };
    let links: RecordedLink[] | undefined;
    xtermRegistry.providers[0].provideLinks(6, (result) => {
      links = result as RecordedLink[] | undefined;
    });

    const link = links?.[0];
    expect(link?.text).toBe('http://localhost:1420/');
    if (!link) throw new Error('No link was provided for the terminal line');
    link.activate({} as MouseEvent, link.text);
    expect(externalMock.openExternalUrl).toHaveBeenCalledWith('http://localhost:1420/');
  });

  it('mantém o destaque compacto das abas: preenchimento neutro e sem sombra', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));

    const selected = await screen.findByRole('tab', { name: 'Terminal 1' });
    expect(selected.parentElement?.className).toContain('h-7');
    expect(selected.parentElement?.className).toContain('bg-surface-active');
    expect(selected.parentElement?.className).not.toContain('border');
    expect(selected.parentElement?.className).not.toContain('shadow-sm');
  });

  it('fecha uma aba encerrada diretamente', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    lastCallback()({ type: 'exit', code: 0 });
    expect(await screen.findByText('Encerrado (0)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar Terminal 1' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiMock.closeTerminal).toHaveBeenCalledWith('term-1');
  });

  it('fecha a aba com o botão do meio do mouse', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));

    const terminalTab = await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.mouseDown(terminalTab, { button: 1 });
    fireEvent(
      terminalTab,
      new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }),
    );

    await waitFor(() => expect(apiMock.closeTerminal).toHaveBeenCalledWith('term-1'));
    expect(screen.queryByRole('tab', { name: 'Terminal 1' })).toBeNull();
  });

  it('reordena abas de terminal com Alt+Arrow e atualiza a ordem do manager', async () => {
    render(<TerminalPanel conversationId="conv-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Novo terminal' }));
    const second = await screen.findByRole('tab', { name: 'Terminal 2' });
    fireEvent.keyDown(second, { key: 'ArrowLeft', altKey: true });

    await waitFor(() =>
      expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
        'Terminal 2',
        'Terminal 1',
      ]),
    );
    expect(terminalManager.getSnapshot('panel').tabs.map((tab) => tab.id)).toEqual([
      'term-2',
      'term-1',
    ]);
  });

  it('mostra apenas o host ativo e troca com a aba', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Novo terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 2' });

    const [first, second] = hosts();
    expect(first.hidden).toBe(true);
    expect(second.hidden).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal 1' }));

    expect(first.hidden).toBe(false);
    expect(second.hidden).toBe(true);
  });

  it('desmontar o painel não fecha o PTY; remontar reata a mesma aba', async () => {
    const first = render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });
    first.unmount();

    expect(apiMock.closeTerminal).not.toHaveBeenCalled();

    render(<TerminalPanel conversationId="conv-1" />);
    expect(await screen.findByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(hosts()).toHaveLength(1);
  });

  it('mantém o terminal aberto ao trocar de conversa (lista global)', async () => {
    const view = render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    // Switching session/workspace must not hide nor kill the running shell.
    view.rerender(<TerminalPanel conversationId="conv-2" />);

    expect(apiMock.closeTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(screen.queryByText('Nenhum terminal aberto')).toBeNull();
    expect(hosts()).toHaveLength(1);
  });

  it('sobrevive ao fechar a conversa que abriu o terminal', async () => {
    const view = render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    // No active session anymore (tab closed or app in the welcome state).
    view.rerender(<TerminalPanel />);

    expect(apiMock.closeTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
  });

  it('reinicia no workspace da conversa que abriu o terminal', async () => {
    const view = render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    view.rerender(<TerminalPanel conversationId="conv-2" />);
    lastCallback()({ type: 'exit', code: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Reiniciar terminal' }));

    await waitFor(() => expect(apiMock.openTerminal).toHaveBeenCalledTimes(2));
    expect(apiMock.openTerminal.mock.calls[1]?.[0]).toEqual({ conversationId: 'conv-1' });
  });

  it('usa a conversa ativa do app quando o chamador não informa alvo', async () => {
    useChatStore.setState({ activeId: 'conv-9' });
    render(<TerminalPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));

    await waitFor(() =>
      expect(apiMock.openTerminal).toHaveBeenCalledWith(
        { conversationId: 'conv-9' },
        100,
        24,
        expect.any(Function),
      ),
    );
  });

  it('avisa quando não há pasta para abrir um terminal novo', async () => {
    render(<TerminalPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(apiMock.openTerminal).not.toHaveBeenCalled();
  });

  it('marca o processo como encerrado e oferece reiniciar', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    lastCallback()({ type: 'exit', code: 0 });

    expect(await screen.findByText('Encerrado (0)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reiniciar terminal' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Matar processo' })).toBeNull();
  });

  it('mata o processo pelo backend mantendo a aba', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    fireEvent.click(screen.getByRole('button', { name: 'Matar processo' }));
    await waitFor(() => expect(apiMock.killTerminal).toHaveBeenCalledWith('term-1'));

    lastCallback()({ type: 'exit', code: 130 });
    expect(await screen.findByText('Encerrado (130)')).toBeTruthy();
  });

  it('para no limite de quatro abas e desabilita a abertura', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    for (let index = 2; index <= 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Novo terminal' }));
      await screen.findByRole('tab', { name: `Terminal ${index}` });
    }

    expect(screen.getAllByRole('tab')).toHaveLength(4);
    const add = screen.getByRole('button', { name: 'Novo terminal' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it('rola a faixa de abas com a roda do mouse quando há overflow', async () => {
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));
    await screen.findByRole('tab', { name: 'Terminal 1' });

    for (let index = 2; index <= 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Novo terminal' }));
      await screen.findByRole('tab', { name: `Terminal ${index}` });
    }

    const strip = screen.getByRole('tablist', { name: 'Terminais abertos' });
    // jsdom has no layout: declare an overflowing strip and scroll from the start.
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 800 });
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 200 });
    strip.scrollLeft = 0;

    fireEvent.wheel(strip, { deltaY: 120 });
    expect(strip.scrollLeft).toBe(120);

    // Clamps at the end instead of overscrolling.
    fireEvent.wheel(strip, { deltaY: 5000 });
    expect(strip.scrollLeft).toBe(600);
  });

  it('separa os terminais do painel e do centro na mesma conversa', async () => {
    render(
      <>
        <section data-testid="panel-surface">
          <TerminalPanel conversationId="conv-1" />
        </section>
        <section data-testid="center-surface">
          <TerminalPanel conversationId="conv-1" surface="center" showTabStrip={false} autoFocus />
        </section>
      </>,
    );

    const panel = within(screen.getByTestId('panel-surface'));
    const center = within(screen.getByTestId('center-surface'));

    fireEvent.click(panel.getByRole('button', { name: 'Abrir terminal' }));
    await waitFor(() => expect(apiMock.openTerminal).toHaveBeenCalledTimes(1));
    fireEvent.click(center.getByRole('button', { name: 'Abrir terminal' }));
    await waitFor(() => expect(apiMock.openTerminal).toHaveBeenCalledTimes(2));

    // Each surface lists only its own terminals; the center never renders an
    // inner tab strip (the central strip owns those tabs).
    expect(panel.getByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(center.queryByRole('tab')).toBeNull();
    expect(panel.queryByText('Terminal 2')).toBeNull();

    const [panelHost, centerHost] = hosts();
    expect(panelHost.dataset.terminalId).toBe('term-1');
    expect(centerHost.dataset.terminalId).toBe('term-2');
    expect(panelHost.hidden).toBe(false);
    expect(centerHost.hidden).toBe(false);

    // Closing the panel PTY does not touch the center one.
    fireEvent.click(panel.getByRole('button', { name: 'Fechar Terminal 1' }));
    await waitFor(() => expect(apiMock.closeTerminal).toHaveBeenCalledWith('term-1'));
    expect(centerHost.isConnected).toBe(true);
    expect(hosts().map((host) => host.dataset.terminalId)).toEqual(['term-2']);
  });

  it('degrada com erro amigável e sem retry inútil no limite', async () => {
    apiMock.openTerminal.mockRejectedValueOnce('TERMINAL_LIMIT: máximo de 4 terminais');
    render(<TerminalPanel conversationId="conv-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir terminal' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Limite de 4 terminais');
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });

  it('reconcilia sessões órfãs de um reload do webview', async () => {
    apiMock.listTerminals.mockResolvedValueOnce([terminalInfo('term-orphan')]);
    render(<TerminalPanel conversationId="conv-1" />);

    // The renderer keeps a global list, so the reconcile asks for every session.
    await waitFor(() => expect(apiMock.listTerminals).toHaveBeenCalledWith());
    await waitFor(() => expect(apiMock.closeTerminal).toHaveBeenCalledWith('term-orphan'));
  });
});
