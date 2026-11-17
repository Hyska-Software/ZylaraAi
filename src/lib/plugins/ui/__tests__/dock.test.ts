import { describe, expect, it } from 'vitest';

import { dockTabsForLayout, isRedundantDockTabAction } from '@/lib/plugins/ui/dock';
import type { PanelTabSpec, SlotContribution } from '@/lib/plugins/ui/types';

const plugin = { id: 'com.acme.insights', name: 'Session Insights' } as never;

function tab(overrides: Partial<PanelTabSpec> = {}): PanelTabSpec {
  return {
    key: 'com.acme.insights:panel:insights',
    plugin,
    pluginId: 'com.acme.insights',
    source: 'manifest',
    order: 100,
    priority: 100,
    layouts: ['chat', 'code', 'agent'],
    tabId: 'insights',
    title: 'Insights',
    titleKey: null,
    icon: 'Puzzle',
    entry: 'ui/panel.html',
    component: null,
    takeover: false,
    ...overrides,
  };
}

function slot(overrides: Partial<SlotContribution> = {}): SlotContribution {
  return {
    key: 'com.acme.insights:slot:tabs',
    plugin,
    pluginId: 'com.acme.insights',
    source: 'manifest',
    order: 100,
    priority: 100,
    layouts: ['code'],
    slot: 'code.panel.tabs',
    entryId: 'tabs',
    kind: 'list',
    keyMatch: null,
    component: null,
    entry: null,
    action: { kind: 'openPanelTab', target: 'insights' },
    title: 'Insights',
    titleKey: null,
    icon: 'Puzzle',
    when: null,
    ...overrides,
  };
}

describe('dockTabsForLayout', () => {
  it('keeps the tabs that declare the layout and hides takeover panels', () => {
    const code = dockTabsForLayout([tab(), tab({ key: 'x:panel:page', tabId: 'page', takeover: true })], 'code');
    expect(code.map((entry) => entry.tabId)).toEqual(['insights']);
    expect(dockTabsForLayout([tab({ layouts: ['chat'] })], 'code')).toEqual([]);
  });

  it('drops tabs disabled by the user', () => {
    expect(dockTabsForLayout([tab()], 'code', ['com.acme.insights:panel:insights'])).toEqual([]);
  });

  it('renders a panel declared twice only once', () => {
    const tabs = dockTabsForLayout([tab(), tab({ order: 20 })], 'code');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.order).toBe(100);
  });

  it('prefers the trusted registration of the same panel', () => {
    const trusted = tab({
      key: 'com.acme.insights:ui:panel:insights:1',
      source: 'trusted',
      entry: null,
      component: () => null,
      order: 300,
    });
    const tabs = dockTabsForLayout([tab(), trusted], 'code');
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.source).toBe('trusted');
    expect(tabs[0]?.component).toBe(trusted.component);
  });

  it('orders different panels by contribution order', () => {
    const tabs = dockTabsForLayout(
      [tab({ tabId: 'b', key: 'p:panel:b', order: 200 }), tab({ tabId: 'a', key: 'p:panel:a', order: 10 })],
      'code',
    );
    expect(tabs.map((entry) => entry.tabId)).toEqual(['a', 'b']);
  });
});

describe('isRedundantDockTabAction', () => {
  const tabs = [tab()];

  it('flags a button that only opens a tab already in the strip', () => {
    expect(isRedundantDockTabAction(slot(), tabs)).toBe(true);
    expect(
      isRedundantDockTabAction(slot({ action: { kind: 'openPanel', target: 'insights' } }), tabs),
    ).toBe(true);
  });

  it('keeps actions that target another plugin or another destination', () => {
    expect(
      isRedundantDockTabAction(slot({ pluginId: 'com.other:panel:insights' }), tabs),
    ).toBe(false);
    expect(
      isRedundantDockTabAction(slot({ action: { kind: 'openPanelTab', target: 'other' } }), tabs),
    ).toBe(false);
  });

  it('keeps real content contributions and unrelated actions', () => {
    expect(isRedundantDockTabAction(slot({ entry: 'ui/tabs.html', action: null }), tabs)).toBe(false);
    expect(
      isRedundantDockTabAction(slot({ action: { kind: 'openPage', target: 'insights' } }), tabs),
    ).toBe(false);
    expect(isRedundantDockTabAction(slot({ action: null }), tabs)).toBe(false);
  });
});
