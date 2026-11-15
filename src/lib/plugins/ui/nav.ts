/** Sidebar navigation registry for the three layouts. */
import { useAppStore } from '@/lib/store/appStore';
import { useUiStore, type LayoutMode, type PluginPageTarget } from '@/lib/store/uiStore';
import { t } from '@/lib/i18n';

import type { NavEntry } from './types';

export interface HostNavEntry {
  key: string;
  layouts: LayoutMode[];
  order: number;
  page: string;
  icon: string;
  titleKey: string;
  ariaLabelKey?: string;
  visible?: () => boolean;
}

const skillsVisible = () => useAppStore.getState().settings.skillsPanelEnabled;

export const HOST_NAV: HostNavEntry[] = [
  {
    key: 'host:library',
    layouts: ['chat'],
    order: 20,
    page: 'library',
    icon: 'Library',
    titleKey: 'shell.sidebar.library',
    ariaLabelKey: 'shell.sidebar.openLibrary',
  },
  {
    key: 'host:plugins-chat',
    layouts: ['chat'],
    order: 30,
    page: 'plugins',
    icon: 'Plug',
    titleKey: 'shell.sidebar.plugins',
    ariaLabelKey: 'shell.sidebar.openPlugins',
  },
  {
    key: 'host:skills-chat',
    layouts: ['chat'],
    order: 40,
    page: 'skills',
    icon: 'Sparkles',
    titleKey: 'shell.sidebar.skills',
    ariaLabelKey: 'shell.sidebar.manageSkills',
    visible: skillsVisible,
  },
  {
    key: 'host:plugins-code',
    layouts: ['code'],
    order: 30,
    page: 'plugins',
    icon: 'Plug',
    titleKey: 'shell.sidebar.plugins',
    ariaLabelKey: 'code:sidebar.plugins',
  },
  {
    key: 'host:skills-code',
    layouts: ['code'],
    order: 40,
    page: 'skills',
    icon: 'Sparkles',
    titleKey: 'shell.sidebar.skills',
    ariaLabelKey: 'code:sidebar.skills',
    visible: skillsVisible,
  },
  {
    key: 'host:plugins-agent',
    layouts: ['agent'],
    order: 30,
    page: 'plugins',
    icon: 'Plug',
    titleKey: 'agents:sidebar.plugins',
  },
  {
    key: 'host:team-agent',
    layouts: ['agent'],
    order: 60,
    page: 'team',
    icon: 'Bot',
    titleKey: 'agents:sidebar.team',
  },
  {
    key: 'host:routines-agent',
    layouts: ['agent'],
    order: 70,
    page: 'routines',
    icon: 'ListChecks',
    titleKey: 'agents:panel.tabs.routines',
  },
];

export interface NavLists {
  hidden?: Record<LayoutMode, string[]>;
  order?: Record<LayoutMode, string[]>;
}

export function navEntries(
  layout: LayoutMode,
  pluginEntries: readonly NavEntry[],
  lists: NavLists = {},
): NavEntry[] {
  const hidden = new Set(lists.hidden?.[layout] ?? []);
  const host: NavEntry[] = HOST_NAV.filter(
    (entry) => entry.layouts.includes(layout) && (entry.visible?.() ?? true),
  ).map((entry) => ({
    key: entry.key,
    source: 'host',
    pluginId: null,
    plugin: null,
    id: entry.key,
    title: t(entry.titleKey),
    titleKey: entry.titleKey,
    ariaLabel: entry.ariaLabelKey ? t(entry.ariaLabelKey) : null,
    icon: entry.icon,
    page: entry.page,
    layouts: entry.layouts,
    order: entry.order,
    badge: null,
  }));
  const merged = [
    ...host,
    ...pluginEntries.filter(
      (entry) =>
        entry.source === 'plugin' &&
        entry.layouts.includes(layout) &&
        !hidden.has(entry.key),
    ),
  ].filter((entry) => !hidden.has(entry.key));
  const order = lists.order?.[layout] ?? [];
  const rank = new Map(order.map((key, index) => [key, index]));
  return merged.sort((left, right) => {
    const leftRank = rank.get(left.key);
    const rightRank = rank.get(right.key);
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
    }
    return left.order - right.order || left.key.localeCompare(right.key);
  });
}

export function openNavTarget(entry: NavEntry): void {
  const ui = useUiStore.getState();
  if (entry.source === 'plugin' && entry.pluginId) {
    const target: PluginPageTarget = { pluginId: entry.pluginId, pageId: entry.page };
    ui.openPluginPage(target, entry.layouts[0] ?? ui.layoutMode);
    if (entry.layouts.length === 1) ui.setLayoutMode(entry.layouts[0]);
    return;
  }
  const layout = entry.layouts[0] ?? ui.layoutMode;
  ui.setLayoutMode(layout);
  if (layout === 'code') {
    if (entry.page === 'plugins') ui.setCodeView('plugins');
    else if (entry.page === 'skills') ui.setCodeView('skills');
    else ui.setCodeView('session');
    return;
  }
  if (layout === 'agent') {
    if (entry.page === 'plugins') ui.setAgentView('plugins');
    else if (entry.page === 'routines') ui.setAgentView('routines');
    else if (entry.page === 'stats') ui.setAgentView('stats');
    else ui.setAgentView('team');
    return;
  }
  if (entry.page === 'library' || entry.page === 'skills' || entry.page === 'plugins') {
    ui.setActiveView(entry.page);
  } else {
    ui.setActiveView('chat');
  }
}
