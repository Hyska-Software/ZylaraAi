// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  PluginSidebarTabHost,
  PluginSidebarTabStrip,
} from '@/components/plugins/ui/PluginSidebarTabHost';
import { setPluginSnapshot } from '@/lib/plugins/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { useUiStore } from '@/lib/store/uiStore';
import type { PluginRecord } from '@/lib/plugins/types';

const TAB_KEY = 'com.acme.notes:sidebar:notes';

function record(): PluginRecord {
  return {
    id: 'com.acme.notes',
    name: 'Acme Notes',
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
      {
        id: 'ui.sidebar',
        granted: true,
        risk: 'low',
        scoped: false,
        description: '',
        trustedOnly: false,
      },
    ],
    tools: [],
    prompt: '',
    promptChars: 0,
    skillRoots: [],
    locales: [],
    manifest: {
      schemaVersion: 2,
      id: 'com.acme.notes',
      name: 'Acme Notes',
      version: '1.0.0',
      description: '',
      author: '',
      apiVersion: 2,
      engines: {},
      publisher: { id: 'acme', name: 'Acme' },
      permissions: ['ui.sidebar'],
      contributes: {
        ui: {
          slots: [],
          views: [],
          nav: [],
          sidebarTabs: [
            {
              id: 'notes',
              title: 'Notes',
              icon: 'Library',
              sidebars: ['chat'],
              entry: 'ui/tab.html',
              order: 10,
            },
          ],
          panels: [],
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

function secondRecord(): PluginRecord {
  const copy = JSON.parse(JSON.stringify(record())) as PluginRecord;
  copy.id = 'com.acme.second';
  copy.name = 'Acme Second';
  copy.manifest.id = copy.id;
  copy.manifest.name = copy.name;
  const tab = copy.manifest.contributes.ui.sidebarTabs?.[0];
  if (tab) {
    tab.id = 'second';
    tab.title = 'Second';
  }
  return copy;
}

beforeEach(() => {
  cleanup();
  useUiStore.setState({
    pluginSidebarTab: { chat: null, code: null, agent: null },
    pluginSidebarTabOrder: { chat: [], code: [], agent: [] },
  });
  usePluginUiPrefs.setState({ enabled: true, disabled: [] });
  setPluginSnapshot({
    plugins: [record()],
    safeMode: false,
    pluginsEnabled: true,
    allowTrusted: false,
    devMode: false,
    configFingerprint: 'test',
  });
});

describe('PluginSidebarTabStrip', () => {
  it('lists the contributed tab for its sidebar and opens it', () => {
    render(<PluginSidebarTabStrip layout="chat" />);
    const tab = screen.getByRole('tab', { name: 'Notes' });
    tab.click();
    expect(useUiStore.getState().pluginSidebarTab.chat).toBe(TAB_KEY);
  });

  it('ignores layouts the tab does not declare', () => {
    const { container } = render(<PluginSidebarTabStrip layout="code" />);
    expect(container.childElementCount).toBe(0);
  });

  it('reorders plugin tabs with Alt+Arrow and persists the order per layout', () => {
    setPluginSnapshot({
      plugins: [record(), secondRecord()],
      safeMode: false,
      pluginsEnabled: true,
      allowTrusted: false,
      devMode: false,
      configFingerprint: 'test',
    });
    render(<PluginSidebarTabStrip layout="chat" />);

    act(() => {
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Notes' }), {
        key: 'ArrowRight',
        altKey: true,
      });
    });

    expect(screen.getAllByRole('tab').map((node) => node.textContent)).toEqual([
      'Second',
      'Notes',
    ]);
    expect(useUiStore.getState().pluginSidebarTabOrder.chat).toEqual([
      'com.acme.second:sidebar:second',
      TAB_KEY,
    ]);
    expect(useUiStore.getState().pluginSidebarTabOrder.code).toEqual([]);
  });
});

describe('PluginSidebarTabHost', () => {
  it('renders nothing until a tab is selected', () => {
    const { container } = render(<PluginSidebarTabHost layout="chat" />);
    expect(container.childElementCount).toBe(0);
  });

  it('renders the sandboxed tab body once selected', async () => {
    const { container } = render(<PluginSidebarTabHost layout="chat" />);
    useUiStore.getState().setPluginSidebarTab('chat', TAB_KEY);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
  });
});
