/**
 * Shared "open a terminal" flow of the Code layout.
 *
 * The terminal list is global (it survives switching session/workspace), but a
 * PTY still needs a folder to run in: the active session's workspace is used
 * when there is one, otherwise the workspace selected in the sidebar seeds a
 * Code session (same flow as the central strip). Without a workspace the user
 * gets the friendly `TERMINAL_NO_WORKSPACE` copy instead of a failed spawn.
 */
import { toast } from 'sonner';

import { t } from '@/lib/i18n';
import { useChatStore, useUiStore } from '@/lib/store';
import { terminalManager, type TerminalSurface } from './terminalManager';
import { startSessionInWorkspace } from './useWorkspaces';

/** Opens one terminal on `surface`; `conversationId` is the session to inherit. */
export async function openTerminal(
  surface: TerminalSurface,
  conversationId?: string | null,
): Promise<string | null> {
  let target = conversationId ?? useChatStore.getState().activeId ?? null;
  if (!target) {
    const workspaceId = useUiStore.getState().activeWorkspaceId;
    if (!workspaceId) {
      toast.error(t('code:terminal.error.noWorkspace'));
      return null;
    }
    useUiStore.getState().setActiveWorkspace(workspaceId);
    target = await startSessionInWorkspace(workspaceId);
    if (!target) return null;
  }
  return terminalManager.open(target, surface);
}
