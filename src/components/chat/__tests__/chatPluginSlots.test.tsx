// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: { pluginRpc: vi.fn(() => Promise.resolve({})) },
}));

import { Markdown } from '../Markdown';
import { MessageItem } from '../MessageItem';
import { useUiStore } from '@/lib/store/uiStore';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { setPluginUiState } from '@/lib/plugins/ui/registry';
import type {
  ComponentReplacement,
  PluginUiState,
  SlotContribution,
} from '@/lib/plugins/ui/types';

const plugin = {
  id: 'com.acme.demo',
  name: 'Demo',
  version: '1.0.0',
  manifest: { contributes: { ui: {} } },
  permissions: [],
  trusted: true,
  active: true,
  enabled: true,
} as never;

function emptyState(overrides: Partial<PluginUiState> = {}) {
  return {
    slots: [],
    replacements: [],
    wraps: [],
    pages: [],
    panelTabs: [],
    nav: [],
    settingsTabs: [],
    artifactViewers: [],
    variants: [],
    presets: [],
    css: [],
    genui: [],
    ...overrides,
  };
}

function replacement(overrides: Partial<ComponentReplacement> = {}): ComponentReplacement {
  return {
    key: 'demo:replace:chat.message.user',
    plugin,
    pluginId: 'com.acme.demo',
    source: 'trusted',
    order: 100,
    priority: 100,
    layouts: ['chat', 'code', 'agent'],
    component: 'chat.message.user',
    entryId: 'chat.message.user',
    componentFn: () => <div>plugin-user</div>,
    ...overrides,
  };
}

function fenceSlot(overrides: Partial<SlotContribution> = {}): SlotContribution {
  return {
    key: 'demo:slot:mermaid',
    plugin,
    pluginId: 'com.acme.demo',
    source: 'trusted',
    order: 100,
    priority: 100,
    layouts: ['chat', 'code', 'agent'],
    slot: 'chat.markdown.fence',
    entryId: 'mermaid',
    kind: 'keyed',
    keyMatch: 'mermaid',
    component: () => <div>plugin-fence</div>,
    entry: null,
    action: null,
    title: null,
    titleKey: null,
    icon: null,
    when: null,
    ...overrides,
  };
}

const message = {
  id: 'm-1',
  conversationId: 'conv-1',
  role: 'user',
  content: 'Ajuste os arquivos.',
  status: 'complete',
  toolCalls: [],
  citations: [],
  attachments: [],
  createdAt: 1,
};

beforeEach(() => {
  useUiStore.setState({ layoutMode: 'chat' });
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  setPluginUiState(emptyState());
});

afterEach(() => cleanup());

describe('chat plugin surfaces', () => {
  it('keeps a per-layout message replacement isolated', () => {
    setPluginUiState(emptyState({ replacements: [replacement({ layouts: ['code'] })] }));
    render(<MessageItem message={message as never} isStreaming={false} isGroupStart />);
    expect(screen.getByText('Ajuste os arquivos.')).toBeTruthy();
    expect(screen.queryByText('plugin-user')).toBeNull();

    act(() => useUiStore.setState({ layoutMode: 'code' }));
    expect(screen.getByText('plugin-user')).toBeTruthy();
  });

  it('falls back to the host message when a replacement crashes', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPluginUiState(
      emptyState({
        replacements: [
          replacement({
            componentFn: () => {
              throw new Error('boom');
            },
          }),
        ],
      }),
    );
    render(<MessageItem message={message as never} isStreaming={false} isGroupStart />);
    expect(screen.getByText('Ajuste os arquivos.')).toBeTruthy();
    error.mockRestore();
  });

  it('keeps the host bubble when no variant is selected', () => {
    const { container } = render(
      <MessageItem message={message as never} isStreaming={false} isGroupStart />,
    );
    const bubble = container.querySelector('[data-variant]');
    expect(bubble).toBeNull();
    const text = screen.getByText('Ajuste os arquivos.');
    expect(text.className).toContain('rounded-3xl');
    expect(text.className).toContain('px-4');
    expect(text.className).not.toContain('rounded-2xl');
    expect(text.className).not.toContain('p-3');
  });

  it('applies a variant recipe through the component slot', () => {
    usePluginUiPrefs.setState({
      ...EMPTY_PREFS,
      variants: { 'chat.message.user:chat': 'builtin:card' },
    });
    const { container } = render(
      <MessageItem message={message as never} isStreaming={false} isGroupStart />,
    );
    const bubble = container.querySelector('[data-variant="card"]');
    expect(bubble).toBeTruthy();
    expect(bubble?.className).toContain('bg-surface-raised');
  });

  it('intercepts only the matching markdown fence language', () => {
    setPluginUiState(emptyState({ slots: [fenceSlot()] }));
    render(<Markdown content={'```mermaid\ngraph TD;A-->B\n```'} />);
    expect(screen.getByText('plugin-fence')).toBeTruthy();
    cleanup();
    render(<Markdown content={'```ts\nconst a = 1;\n```'} />);
    expect(screen.queryByText('plugin-fence')).toBeNull();
  });
});
