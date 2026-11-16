/** Executes sandboxed host actions after validating the plugin's own UI. */
import { toast } from 'sonner';

import { useUiStore, type LayoutMode } from '@/lib/store/uiStore';
import { pluginHasPermission } from '@/lib/plugins/registry';
import type { PluginRecord } from '@/lib/plugins/types';
import { notifyPluginUi, pluginUiState } from './registry';

const LAYOUTS: LayoutMode[] = ['chat', 'code', 'agent'];

function openHostPage(page: string): void {
  const ui = useUiStore.getState();
  if (page === 'library' || page === 'plugins' || page === 'skills') {
    ui.setActiveView(page);
    return;
  }
  if (page === 'team' || page === 'routines' || page === 'stats') {
    ui.setAgentView(page);
    return;
  }
  if (page === 'session') {
    ui.setCodeView('session');
  }
}

export function runPluginHostAction(
  plugin: PluginRecord,
  action: string,
  params: Record<string, unknown>,
): unknown {
  const ui = useUiStore.getState();
  switch (action) {
    case 'openPage': {
      const pageId = String(params.page ?? '');
      const layoutParam = params.layout as LayoutMode | null;
      const layout = layoutParam && LAYOUTS.includes(layoutParam) ? layoutParam : ui.layoutMode;
      const page = pluginUiState().pages.find(
        (entry) => entry.pluginId === plugin.id && entry.pageId === pageId,
      );
      if (page) {
        ui.openPluginPage({ pluginId: plugin.id, pageId }, layout);
        return { ok: true };
      }
      if (['library', 'plugins', 'skills', 'team', 'routines', 'stats', 'session'].includes(pageId)) {
        openHostPage(pageId);
        return { ok: true };
      }
      throw new Error(`PLUGIN_PAGE_MISSING: ${pageId}`);
    }
    case 'openPanelTab': {
      const tabId = String(params.tab ?? '');
      const layoutParam = params.layout as LayoutMode | null;
      const layout = layoutParam && LAYOUTS.includes(layoutParam) ? layoutParam : ui.layoutMode;
      const tab = pluginUiState().panelTabs.find(
        (entry) => entry.pluginId === plugin.id && entry.tabId === tabId,
      );
      if (!tab) throw new Error(`PLUGIN_PANEL_TAB_MISSING: ${tabId}`);
      ui.openPluginDockTab(tab.key, layout);
      return { ok: true };
    }
    case 'closePanelTab':
      ui.closePluginDockTab();
      return { ok: true };
    case 'setLayout': {
      const layout = params.layout as LayoutMode;
      if (!LAYOUTS.includes(layout)) throw new Error(`PLUGIN_LAYOUT_INVALID: ${layout}`);
      ui.setLayoutMode(layout);
      return { ok: true };
    }
    case 'openSettings':
      ui.openSettings(typeof params.tab === 'string' ? (params.tab as never) : undefined);
      return { ok: true };
    case 'toast': {
      const title = String(params.title ?? plugin.name);
      toast.info(title, {
        description: typeof params.body === 'string' && params.body ? params.body : undefined,
      });
      return { ok: true };
    }
    case 'setBadge': {
      if (!pluginHasPermission(plugin, 'ui.nav')) {
        throw new Error('PLUGIN_PERMISSION_DENIED: ui.nav');
      }
      const navId = String(params.id ?? '');
      const nav = pluginUiState().nav.find(
        (entry) => entry.pluginId === plugin.id && entry.id === navId,
      );
      if (!nav) throw new Error(`PLUGIN_NAV_MISSING: ${navId}`);
      nav.badge = typeof params.badge === 'string' ? params.badge : null;
      notifyPluginUi();
      return { ok: true };
    }
    default:
      throw new Error(`PLUGIN_HOST_ACTION_UNKNOWN: ${action}`);
  }
}
