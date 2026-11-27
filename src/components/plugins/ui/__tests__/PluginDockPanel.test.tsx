// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PluginDockPanel } from '@/components/plugins/ui/PluginDockPanel';
import { setPluginSnapshot } from '@/lib/plugins/registry';
import { EMPTY_PREFS, usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { useUiStore } from '@/lib/store/uiStore';
import type { PluginRecord } from '@/lib/plugins/types';

const PANEL_KEY = 'com.acme.insights:panel:insights';
const PAGE_KEY = 'com.acme.insights:panel:insights-page';

function record(panels: Array<Record<string, unknown>>): PluginRecord {
  return {
    id: 'com.acme.insights',
    name: 'Session Insights',
    version: '1.0.0',
    apiVersion: 2,
    description: '',
    author: '',
    homepage: null,
    icon: null,
    publisherId: 'acme',
    publisherName: 'Acme',
    keyId: null,
    keyFingerprint: null,
    enabled: true,
    active: true,
    trusted: false,
    source: 'user',
    signatureStatus: 'unsigned',
    autoUpdate: false,
    previousVersion: null,
    disabledReason: null,
    sizeBytes: 0,
    hasBackend: false,
    mainScript: null,
    permissions: [
      { id: 'ui.panel', granted: true, risk: 'low', scoped: false, description: '', trustedOnly: false },
    ],
    tools: [],
    prompt: '',
    promptChars: 0,
    skillRoots: [],
    locales: [],
    manifest: {
      schemaVersion: 2,
      id: 'com.acme.insights',
      name: 'Session Insights',
      version: '1.0.0',
      description: '',
      author: '',
      apiVersion: 2,
      engines: {},
      publisher: { id: 'acme', name: 'Acme' },
      permissions: ['ui.panel'],
      contributes: {
        ui: {
          slots: [],
          views: [],
          nav: [],
          sidebarTabs: [],
          panels,
          commands: [],
          settingsTabs: [],
          themes: [],
          variants: [],
          presets: [],
          css: [],
          genui: { components: [] },
        },
        promptSections: [],
        skills: [],
        locales: [],
        providers: [],
        artifactViewers: [],
      },
      runtime: { ui: 'sandbox' },
      trusted: false,
    },
  } as unknown as PluginRecord;
}

const insightPanel = {
  id: 'insights',
  title: 'Insights',
  icon: 'Puzzle',
  entry: 'ui/panel.html',
  dock: 'right',
  tab: true,
};

const insightPage = {
  id: 'insights-page',
  title: 'Insights',
  icon: 'Puzzle',
  entry: 'ui/panel.html',
  dock: 'right',
  tab: false,
};

function mount(panels: Array<Record<string, unknown>> = [insightPanel]) {
  setPluginSnapshot({
    plugins: [record(panels)],
    safeMode: false,
    pluginsEnabled: true,
    allowTrusted: false,
    devMode: false,
    configFingerprint: 'test',
  });
}

beforeEach(() => {
  cleanup();
  usePluginUiPrefs.setState({ ...EMPTY_PREFS });
  useUiStore.setState({
    layoutMode: 'chat',
    pluginDockTab: { chat: PANEL_KEY, code: null, agent: null },
    pluginDockTabOrder: { chat: [], code: [], agent: [] },
    pluginDockClosed: { chat: false, code: false, agent: false },
  });
});

describe('PluginDockPanel', () => {
  it('renders the plugin tab inside the chat dock strip next to the host tab', () => {
    mount();
    const { container } = render(<PluginDockPanel layout="chat" tabKey={PANEL_KEY} />);

    expect(screen.getByRole('tablist', { name: 'Abas do painel direito' })).toBeTruthy();
    // Host "Artefatos" tab plus exactly one plugin tab.
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Artefatos' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Insights' }).getAttribute('aria-selected')).toBe('true');

    // The dock shell owns the width instead of stealing the whole chat row.
    const aside = container.querySelector('aside');
    expect(aside).toBeTruthy();
    expect(aside?.style.width).not.toBe('');
    expect(aside?.getAttribute('data-plugin-dock')).toBe(PANEL_KEY);
  });

  it('renders a panel declared twice only once', () => {
    mount([insightPanel, { ...insightPanel, order: 20 }]);
    render(<PluginDockPanel layout="chat" tabKey={PANEL_KEY} />);
    expect(screen.getAllByRole('tab', { name: 'Insights' })).toHaveLength(1);
  });

  it('reorders dock plugin tabs with Alt+Arrow and persists the order per layout', () => {
    mount([insightPanel, { ...insightPanel, id: 'other', title: 'Other' }]);
    render(<PluginDockPanel layout="chat" tabKey={PANEL_KEY} />);

    act(() => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Insights' }), {
        key: 'ArrowRight',
        altKey: true,
      });
    });

    const pluginTabs = screen
      .getAllByRole('tab')
      .filter((node) => node.getAttribute('aria-label') !== 'Artefatos');
    expect(pluginTabs.map((node) => node.textContent)).toEqual(['Other', 'Insights']);
    expect(useUiStore.getState().pluginDockTabOrder.chat).toEqual([
      'com.acme.insights:panel:other',
      PANEL_KEY,
    ]);
  });

  it('returns to the artifacts dock from the host tab', () => {
    mount();
    render(<PluginDockPanel layout="chat" tabKey={PANEL_KEY} />);
    screen.getByRole('tab', { name: 'Artefatos' }).click();
    expect(useUiStore.getState().pluginDockTab.chat).toBeNull();
  });

  it('keeps a page header for takeover panels and dismisses them', () => {
    mount([insightPage]);
    render(<PluginDockPanel layout="chat" tabKey={PAGE_KEY} takeover />);

    // No strip: a takeover panel is not a tab of the dock.
    expect(screen.queryByRole('tablist')).toBeNull();
    screen.getByRole('button', { name: 'Voltar' }).click();
    expect(useUiStore.getState().pluginDockClosed.chat).toBe(true);
  });

  it('renders nothing for an unknown tab key', () => {
    mount();
    const { container } = render(<PluginDockPanel layout="chat" tabKey="missing:panel:x" />);
    expect(container.childElementCount).toBe(0);
  });
});
