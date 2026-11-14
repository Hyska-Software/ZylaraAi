/**
 * Shared "open a terminal" flows of the Code layout.
 *
 * The terminal list is global (it survives switching session/workspace), but a
 * PTY still needs a folder to run in. `openTerminal` uses the active session's
 * workspace — or, without one, seeds a Code session from the workspace selected
 * in the sidebar (same flow as the central strip). `openWorkspaceTerminal` is
 * the sidebar menu path: it opens the shell straight in the project, so the
 * user gets a terminal tab without creating a conversation first. Without a
 * folder the user gets the friendly `TERMINAL_NO_WORKSPACE` copy instead of a
 * failed spawn.
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
  return terminalManager.open({ conversationId: target }, surface);
}

/**
 * Opens a terminal bound to a workspace folder, with no session attached.
 *
 * Used by the workspace context menu: the PTY runs in the project path, the
 * center switches to the terminal and the tab joins the session tab strip. The
 * workspace is also selected in the sidebar so the app keeps showing the
 * project the shell belongs to.
 */
export async function openWorkspaceTerminal(
  workspaceId: string,
  surface: TerminalSurface = 'center',
): Promise<string | null> {
  useUiStore.getState().setActiveWorkspace(workspaceId);
  const terminalId = await terminalManager.open({ workspaceId }, surface);
  if (terminalId) {
    useUiStore.getState().setCodeView('terminal');
    return terminalId;
  }
  const error = terminalManager.getSnapshot(surface).error;
  if (error) toast.error(error.message, { description: error.detail });
  return null;
}
