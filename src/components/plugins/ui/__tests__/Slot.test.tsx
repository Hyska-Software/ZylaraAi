// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: { pluginRpc: vi.fn(() => Promise.resolve({})) },
}));

import { ComponentSlot, Slot } from '@/components/plugins/ui/Slot';
import { useUiStore } from '@/lib/store/uiStore';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { setPluginUiState } from '@/lib/plugins/ui/registry';
import type {
  ComponentReplacement,
  ComponentWrap,
  PluginComponent,
  PluginUiState,
  SlotContribution,
} from '@/lib/plugins/ui/types';

const plugin = {
  id: 'com.acme.demo',
  name: 'Demo',
  version: '1.0.0',
  manifest: { contributes: { ui: {} } },
  permissions: [
    { id: 'ui.slot:chat.message.actions', granted: true },
    { id: 'ui.slot:chat.message.node', granted: true },
    { id: 'ui.override:chat.welcome', granted: true },
  ],
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
    key: 'demo:replace:chat.welcome',
    plugin,
    pluginId: 'com.acme.demo',
    source: 'trusted',
    order: 100,
    priority: 100,
    layouts: ['chat', 'code', 'agent'],
    component: 'chat.welcome',
    entryId: 'chat.welcome',
    componentFn: () => <div>plugin-welcome</div>,
    ...overrides,
  };
}

function slotEntry(overrides: Partial<SlotContribution> = {}): SlotContribution {
  return {
    key: 'demo:slot:one',
    plugin,
    pluginId: 'com.acme.demo',
    source: 'trusted',
    order: 100,
    priority: 100,
    layouts: ['chat', 'code', 'agent'],
    slot: 'chat.message.actions',
    entryId: 'one',
    kind: 'list',
    keyMatch: null,
    component: () => <button type="button">action-one</button>,
    entry: null,
    action: null,
    title: 'Action one',
    titleKey: null,
    icon: null,
    when: null,
    ...overrides,
  };
}

function Host() {
  return <div>host-content</div>;
}

beforeEach(() => {
  useUiStore.setState({ layoutMode: 'chat' });
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  setPluginUiState(emptyState());
});

afterEach(() => cleanup());

describe('Plugin slot engine', () => {
  it('renders list contributions for the active layout only', () => {
    setPluginUiState(
      emptyState({
        slots: [
          slotEntry({ key: 'a' }),
          slotEntry({ key: 'b', layouts: ['code'], component: () => <span>action-two</span> }),
        ],
      }),
    );
    const view = render(<Slot name="chat.message.actions" layout="chat" />);
    expect(screen.getByText('action-one')).toBeTruthy();
    expect(screen.queryByText('action-two')).toBeNull();
    act(() => setPluginUiState(emptyState({ slots: [slotEntry({ key: 'a' })] })));
    expect(view.container.querySelector('[data-zylara-plugin]')).toBeTruthy();
  });

  it('honours the keyed entry key', () => {
    setPluginUiState(
      emptyState({
        slots: [
          slotEntry({
            key: 'user',
            slot: 'chat.message.node',
            keyMatch: 'user',
            kind: 'keyed',
            component: () => <span>user-node</span>,
          }),
          slotEntry({
            key: 'assistant',
            slot: 'chat.message.node',
            keyMatch: 'assistant',
            kind: 'keyed',
            component: () => <span>assistant-node</span>,
          }),
        ],
      }),
    );
    render(<Slot name="chat.message.node" entryKey="assistant" layout="chat" />);
    expect(screen.getByText('assistant-node')).toBeTruthy();
    expect(screen.queryByText('user-node')).toBeNull();
  });

  it('renders the fallback for empty keyed and list slots', () => {
    render(
      <Slot
        name="chat.message.node"
        entryKey="user"
        layout="chat"
        fallback={<span>keyed-fallback</span>}
      />,
    );
    expect(screen.getByText('keyed-fallback')).toBeTruthy();
  });

  it('renders the fallback for unknown slots', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Slot name="unknown.slot" fallback={<span>fallback</span>} />);
    expect(screen.getByText('fallback')).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('ComponentSlot', () => {
  it('renders the host until a replacement is published', () => {
    render(<ComponentSlot name="chat.welcome" fallback={Host} />);
    expect(screen.getByText('host-content')).toBeTruthy();
    act(() => setPluginUiState(emptyState({ replacements: [replacement()] })));
    expect(screen.getByText('plugin-welcome')).toBeTruthy();
  });

  it('filters replacements by layout', () => {
    setPluginUiState(
      emptyState({ replacements: [replacement({ layouts: ['code'] })] }),
    );
    const view = render(<ComponentSlot name="chat.welcome" fallback={Host} />);
    expect(screen.getByText('host-content')).toBeTruthy();
    act(() => useUiStore.setState({ layoutMode: 'code' }));
    expect(screen.getByText('plugin-welcome')).toBeTruthy();
    view.unmount();
  });

  it('wraps the host and falls back when a replacement crashes', () => {
    const Boom: PluginComponent = () => {
      throw new Error('boom');
    };
    const wrap: ComponentWrap = {
      key: 'demo:wrap:chat.welcome',
      plugin,
      pluginId: 'com.acme.demo',
      source: 'trusted',
      order: 100,
      priority: 100,
      layouts: ['chat', 'code', 'agent'],
      component: 'chat.welcome',
      entryId: 'chat.welcome:0',
      wrapper: ({ children }) => <section data-testid="wrapped">{children as ReactNode}</section>,
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPluginUiState(emptyState({ replacements: [replacement({ componentFn: Boom })], wraps: [wrap] }));
    render(<ComponentSlot name="chat.welcome" fallback={Host} />);
    expect(screen.getByTestId('wrapped')).toBeTruthy();
    expect(screen.getByText('host-content')).toBeTruthy();
    error.mockRestore();
  });
});
