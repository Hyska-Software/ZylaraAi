// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalInfo } from '@/lib/types';

/** xterm needs a canvas; these tests validate the IPC wiring, not the render. */
vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    cols = 100;
    rows = 24;
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
    }
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    clear() {}
    dispose() {}
    registerLinkProvider() {
      return { dispose: () => undefined };
    }
    onData() {
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

const apiMock = vi.hoisted(() => ({
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  listTerminals: vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { useChatStore, useUiStore } from '@/lib/store';
import { __resetTerminalManagerForTests, terminalManager } from './terminalManager';
import { openWorkspaceTerminal } from './terminalOpen';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function terminalInfo(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: 'term-1',
    conversationId: null,
    title: 'zylara',
    cwd: 'C:/dev/zylara',
    cols: 100,
    rows: 24,
    running: true,
    exitCode: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTerminalManagerForTests();
  useChatStore.setState({ activeId: null });
  useUiStore.setState({ activeWorkspaceId: null, codeView: 'session' });
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
  apiMock.openTerminal.mockImplementation(async () => terminalInfo());
  apiMock.listTerminals.mockResolvedValue([]);
  apiMock.closeTerminal.mockResolvedValue(true);
});

afterEach(() => {
  __resetTerminalManagerForTests();
});

describe('openWorkspaceTerminal', () => {
  it('abre a shell no workspace sem criar uma conversa', async () => {
    const terminalId = await openWorkspaceTerminal('ws-1');

    expect(terminalId).toBe('term-1');
    expect(apiMock.openTerminal).toHaveBeenCalledWith(
      { workspaceId: 'ws-1' },
      100,
      24,
      expect.any(Function),
    );
    // The whole point of the menu entry: no session is seeded for the terminal.
    expect(apiMock.createConversation).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeWorkspaceId).toBe('ws-1');
    expect(useUiStore.getState().codeView).toBe('terminal');
  });

  it('mantém a vista atual e avisa quando a pasta não existe', async () => {
    apiMock.openTerminal.mockRejectedValueOnce('TERMINAL_WORKSPACE_MISSING: pasta removida');

    await expect(openWorkspaceTerminal('ws-1')).resolves.toBeNull();

    expect(toastMock.error).toHaveBeenCalled();
    expect(useUiStore.getState().codeView).toBe('session');
    expect(terminalManager.getSnapshot('center').tabs).toHaveLength(0);
  });
});
