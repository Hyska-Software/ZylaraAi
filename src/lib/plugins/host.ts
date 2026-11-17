/**
 * Declarative contribution execution shared by slots, the palette and the
 * composer slash menu.
 */
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useChatStore } from '@/lib/store';
import { useUiStore } from '@/lib/store/uiStore';
import { pluginUiState } from './ui/registry';
import { usePluginUiPrefs } from './ui/prefs';
import { runPluginHostAction } from './ui/hostActions';
import {
  panelByKey,
  pluginHasPermission,
  pluginLabel,
  viewByKey,
  type ResolvedCommand,
} from './registry';
import type { PluginAction, PluginRecord, ViewContribution } from './types';

export interface PluginActionContext {
  conversationId?: string | null;
  draft?: string;
}

function switchLayoutForSurface(surface: ViewContribution['surface'] | undefined): void {
  const ui = useUiStore.getState();
  if (!surface || surface === 'global') return;
  if (surface === 'chat' && ui.layoutMode !== 'chat') ui.setLayoutMode('chat');
  if (surface === 'code' && ui.layoutMode !== 'code') ui.setLayoutMode('code');
  if (surface === 'agent' && ui.layoutMode !== 'agent') ui.setLayoutMode('agent');
}

export function openPluginView(
  plugin: PluginRecord,
  viewId: string,
  layout?: 'chat' | 'code' | 'agent' | null,
): void {
  const key = `${plugin.id}:${viewId}`;
  const view = viewByKey(key);
  if (!view) {
    toast.error(t('plugins:errors.viewMissing', { id: viewId }));
    return;
  }
  if (!pluginHasPermission(plugin, 'ui.view')) {
    toast.error(t('plugins:errors.permissionDenied', { permission: 'ui.view' }));
    return;
  }
  const page = pluginUiState().pages.find(
    (entry) => entry.pluginId === plugin.id && entry.pageId === viewId,
  );
  const current = useUiStore.getState().layoutMode;
  const targetLayout =
    layout ??
    (page && page.layouts.includes(current) ? current : page?.layouts[0]) ??
    undefined;
  if (targetLayout) useUiStore.getState().setLayoutMode(targetLayout);
  else switchLayoutForSurface(view.view.surface);
  useUiStore.getState().openPluginPage({ pluginId: plugin.id, pageId: viewId }, targetLayout);
}

export function openPluginPanel(
  plugin: PluginRecord,
  panelId: string,
  layout?: 'chat' | 'code' | 'agent' | null,
): void {
  const key = `${plugin.id}:${panelId}`;
  if (!panelByKey(key)) {
    toast.error(t('plugins:errors.panelMissing', { id: panelId }));
    return;
  }
  if (!pluginHasPermission(plugin, 'ui.panel')) {
    toast.error(t('plugins:errors.permissionDenied', { permission: 'ui.panel' }));
    return;
  }
  const tab = pluginUiState().panelTabs.find(
    (entry) => entry.pluginId === plugin.id && entry.tabId === panelId,
  );
  if (tab) useUiStore.getState().openPluginDockTab(tab.key, layout ?? undefined);
}

export async function runPluginAction(
  plugin: PluginRecord,
  action: PluginAction,
  context: PluginActionContext = {},
): Promise<void> {
  switch (action.kind) {
    case 'openView':
      openPluginView(plugin, action.target);
      return;
    case 'openPanel':
      openPluginPanel(plugin, action.target);
      return;
    case 'openPage':
      runPluginHostAction(plugin, 'openPage', {
        page: action.target,
        layout: action.layout ?? null,
      });
      return;
    case 'openPanelTab':
      runPluginHostAction(plugin, 'openPanelTab', {
        tab: action.target,
        layout: action.layout ?? null,
      });
      return;
    case 'setLayout':
      useUiStore.getState().setLayoutMode(action.target);
      return;
    case 'openSettings':
      useUiStore.getState().openSettings((action.target ?? undefined) as never);
      return;
    case 'setVariant': {
      if (!pluginHasPermission(plugin, 'ui.variant')) {
        toast.error(t('plugins:errors.permissionDenied', { permission: 'ui.variant' }));
        return;
      }
      const layout = useUiStore.getState().layoutMode;
      const variant = pluginUiState().variants.find(
        (entry) =>
          entry.component === action.component &&
          entry.variantId === action.target &&
          entry.pluginId === plugin.id,
      );
      usePluginUiPrefs
        .getState()
        .setVariant(
          action.component,
          layout,
          variant ? `${variant.pluginId}:${variant.variantId}` : null,
        );
      return;
    }
    case 'setPreset': {
      if (!pluginHasPermission(plugin, 'ui.preset')) {
        toast.error(t('plugins:errors.permissionDenied', { permission: 'ui.preset' }));
        return;
      }
      const layout = action.layout ?? useUiStore.getState().layoutMode;
      const preset = pluginUiState().presets.find(
        (entry) =>
          entry.pluginId === plugin.id &&
          (entry.presetId === action.target || entry.key === action.target),
      );
      if (preset) usePluginUiPrefs.getState().setPreset(layout, preset.key);
      return;
    }
    case 'toggleMode': {
      if (!pluginHasPermission(plugin, 'agent.modes')) {
        toast.error(t('plugins:errors.permissionDenied', { permission: 'agent.modes' }));
        return;
      }
      const conversationId = useChatStore.getState().activeId;
      if (!conversationId) {
        toast.error(t('plugins:errors.noConversation'));
        return;
      }
      try {
        const state = await api.pluginModesState(conversationId);
        const mode = (pluginUiState().modes ?? []).find(
          (entry) => entry.key === action.target && entry.pluginId === plugin.id,
        );
        if (!mode) return;
        const active = state.on.includes(mode.key) || (mode.defaultOn && !state.off.includes(mode.key));
        await api.setPluginMode(conversationId, mode.key, !active);
        window.dispatchEvent(
          new CustomEvent('zylara:plugin-mode-changed', {
            detail: { conversationId, mode: mode.key, active: !active },
          }),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    case 'insertDraft': {
      if (!pluginHasPermission(plugin, 'chat.write')) {
        toast.error(t('plugins:errors.permissionDenied', { permission: 'chat.write' }));
        return;
      }
      const current = context.draft ?? '';
      window.dispatchEvent(
        new CustomEvent('zylara:insert-draft', {
          detail: { text: action.text, mode: 'append', pluginId: plugin.id, current },
        }),
      );
      return;
    }
    case 'openExternal': {
      if (!pluginHasPermission(plugin, 'opener')) {
        toast.error(t('plugins:errors.permissionDenied', { permission: 'opener' }));
        return;
      }
      try {
        await api.pluginRpc(plugin.id, 'opener.open', { url: action.url });
      } catch (error) {
        toast.error(t('plugins:errors.openLinkFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    case 'execute': {
      if (!pluginHasPermission(plugin, 'commands')) {
        toast.error(t('plugins:errors.permissionDenied', { permission: 'commands' }));
        return;
      }
      window.dispatchEvent(
        new CustomEvent('zylara:plugin-command', {
          detail: {
            pluginId: plugin.id,
            method: action.method,
            params: action.params ?? {},
          },
        }),
      );
      return;
    }
  }
}

export async function runPluginCommand(
  resolved: ResolvedCommand,
  context: PluginActionContext = {},
): Promise<void> {
  await runPluginAction(resolved.plugin, resolved.command.action, context);
}

export interface SlotActionSource {
  plugin: PluginRecord;
  action?: PluginAction | null;
  title?: string | null;
  titleKey?: string | null;
}

export function runSlotAction(entry: SlotActionSource): void {
  if (!entry.action) return;
  void runPluginAction(entry.plugin, entry.action);
}

export function slotLabel(entry: SlotActionSource): string {
  return pluginLabel(
    entry.plugin,
    entry.titleKey,
    entry.title ?? entry.plugin.name,
  );
}

export function commandLabel(resolved: ResolvedCommand): string {
  return pluginLabel(
    resolved.plugin,
    resolved.command.titleKey,
    resolved.command.title,
  );
}

export function commandDescription(resolved: ResolvedCommand): string {
  return pluginLabel(
    resolved.plugin,
    resolved.command.descriptionKey,
    resolved.command.description ?? resolved.plugin.name,
  );
}

export function commandSlashName(resolved: ResolvedCommand): string {
  return resolved.command.command?.trim()
    ? resolved.command.command.trim().startsWith('/')
      ? resolved.command.command.trim()
      : `/${resolved.command.command.trim()}`
    : `/${resolved.command.id}`;
}
