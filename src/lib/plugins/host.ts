/**
 * Declarative contribution execution shared by slots, the palette and the
 * composer slash menu.
 */
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useUiStore } from '@/lib/store/uiStore';
import { usePluginStore } from './store';
import {
  panelByKey,
  pluginHasPermission,
  pluginLabel,
  viewByKey,
  type ResolvedCommand,
  type ResolvedSlot,
} from './registry';
import type { PluginAction, PluginRecord, ViewContribution } from './types';

export interface PluginActionContext {
  conversationId?: string | null;
  draft?: string;
}

function switchLayoutForSurface(surface: ViewContribution['surface']): void {
  const ui = useUiStore.getState();
  if (surface === 'global') return;
  if (surface === 'chat' && ui.layoutMode !== 'chat') ui.setLayoutMode('chat');
  if (surface === 'code' && ui.layoutMode !== 'code') ui.setLayoutMode('code');
  if (surface === 'agent' && ui.layoutMode !== 'agent') ui.setLayoutMode('agent');
}

export function openPluginView(plugin: PluginRecord, viewId: string): void {
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
  switchLayoutForSurface(view.view.surface);
  usePluginStore.getState().openView(plugin.id, viewId);
}

export function openPluginPanel(plugin: PluginRecord, panelId: string): void {
  const key = `${plugin.id}:${panelId}`;
  if (!panelByKey(key)) {
    toast.error(t('plugins:errors.panelMissing', { id: panelId }));
    return;
  }
  if (!pluginHasPermission(plugin, 'ui.panel')) {
    toast.error(t('plugins:errors.permissionDenied', { permission: 'ui.panel' }));
    return;
  }
  usePluginStore.getState().openPanel(plugin.id, panelId);
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

export function runSlotAction(entry: ResolvedSlot): void {
  if (!entry.slot.action) return;
  void runPluginAction(entry.plugin, entry.slot.action);
}

export function slotLabel(entry: ResolvedSlot): string {
  return pluginLabel(
    entry.plugin,
    entry.slot.titleKey,
    entry.slot.title ?? entry.plugin.name,
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
