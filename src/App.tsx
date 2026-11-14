import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Toaster, toast } from 'sonner';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen } from '@tauri-apps/api/event';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspaceCenter } from '@/components/layout/WorkspaceCenter';
import { AgentSidebar } from '@/components/agents/AgentSidebar';
import { AgentPanel } from '@/components/agents/AgentPanel';
import { CodePanel, CodeSidebar } from '@/components/code';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { TrayPromptDialog } from '@/components/settings/TrayPromptDialog';
import { ModelPickerDialog } from '@/components/models/ModelPickerDialog';
import { ArtifactPanel } from '@/components/artifacts/ArtifactPanel';
import { SourcesPanel } from '@/components/chat/SourcesPanel';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { TooltipProvider } from '@/components/ui';
import { useAgentStore, useAppStore, useChatStore, useThemeStore, useUiStore } from '@/lib/store';
import { t } from '@/lib/i18n';
import { api } from '@/lib/api';
import { SIDE_PANEL_DOCK_MIN_VIEWPORT, useViewportWidth } from '@/lib/sidePanel';
import { resolveHotkey, type HotkeyCommand } from '@/lib/hotkeys';
import { ComputerControlBanner } from '@/components/computer/ComputerControlBanner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SplashScreen } from '@/components/SplashScreen';
import type {
  AgentRoutineRunEvent,
  AgentTaskUpdatedEvent,
  TurnEventBusPayload,
} from '@/lib/types';
import { useUpdateCheck } from '@/components/layout/useUpdateCheck';

/** Ensures bootstrap runs once even under React StrictMode double-effects. */
let bootstrapPromise: Promise<void> | null = null;

function bootstrap(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const ui = useUiStore.getState();
    ui.applyTheme();
    await useAppStore.getState().init();
    const settings = useAppStore.getState().settings;
    if (settings.theme !== useUiStore.getState().theme) {
      useUiStore.getState().setTheme(settings.theme);
    }
    applyFontScale(settings.fontScale);
    await useThemeStore.getState().init();
    await useChatStore.getState().init();
    await useAgentStore.getState().initialize();
    // A webview reload must reattach turns that kept running in Rust before a
    // persisted FIFO decides that a thread is idle.
    await useChatStore.getState().reattachTurns();
    // Persisted message FIFOs resume in every layout; each conversation starts
    // on its own once it is idle.
    await useChatStore.getState().drainMessageQueues();
  })();
  return bootstrapPromise;
}

function applyFontScale(scale: number) {
  const safe = Number.isFinite(scale) ? Math.min(1.3, Math.max(0.85, scale)) : 1;
  document.documentElement.style.fontSize = `${(16 * safe).toFixed(2)}px`;
}

/** Runs the command resolved by `lib/hotkeys`. */
function runHotkey(command: HotkeyCommand, event: KeyboardEvent): void {
  const ui = useUiStore.getState();
  const chat = useChatStore.getState();
  event.preventDefault();
  switch (command) {
    case 'toggle-command-palette':
      ui.setCommandPaletteOpen(!ui.commandPaletteOpen);
      break;
    case 'toggle-sidebar':
      ui.toggleSidebar();
      break;
    case 'new-conversation':
      if (ui.layoutMode === 'agent') {
        const agentId = ui.activeAgentId;
        if (agentId) void chat.startNewConversation('agent', { agentId });
      } else {
        void chat.startNewConversation();
      }
      break;
    case 'new-code-session':
      window.dispatchEvent(new CustomEvent('zylara:code-new-session'));
      break;
    case 'open-center-terminal':
      window.dispatchEvent(new CustomEvent('zylara:code-new-terminal'));
      break;
    case 'open-settings':
      ui.openSettings();
      break;
    case 'close-overlays':
      ui.closeAllOverlays();
      ui.closeArtifactPanel();
      ui.closeSourcesPanel();
      break;
    case 'return-to-chat':
      // In the Code layout, Escape/“return” only leaves the Skills page; the
      // Chat layout is a separate surface the user switches explicitly.
      if (ui.layoutMode === 'code' && ui.codeView === 'skills') {
        ui.setCodeView('session');
        break;
      }
      if (ui.layoutMode === 'agent') {
        if (chat.activeId) {
          chat.clearActiveConversation();
        } else {
          ui.setActiveAgentId(null);
        }
        break;
      }
      ui.setLayoutMode('chat');
      ui.setActiveView('chat');
      ui.setCodeView('session');
      break;
    case 'stop-streaming':
      void chat.stop();
      break;
    case 'focus-composer':
      window.dispatchEvent(new CustomEvent('zylara:focus-composer'));
      break;
    default:
      break;
  }
}

export default function App() {
  const { t: translate } = useTranslation('common');
  const ready = useAppStore((state) => state.ready);
  const initializing = useAppStore((state) => state.initializing);
  const error = useAppStore((state) => state.error);
  const theme = useUiStore((state) => state.theme);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const codePanelOpen = useUiStore((state) => state.codePanelOpen);
  const agentPanelOpen = useUiStore((state) => state.agentPanelOpen);
  const agentRightPanel = useUiStore((state) => state.agentRightPanel);
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const artifactPanelOpen = useUiStore((state) => state.artifactPanelOpen);
  const sourcesPanelOpen = useUiStore((state) => state.sourcesPanelOpen);
  const activeConversation = useChatStore((state) => {
    const id = state.activeId;
    return id ? state.conversations.find((conversation) => conversation.id === id) : undefined;
  });
  const agentWorkspaceSession =
    layoutMode === 'agent' &&
    activeConversation?.mode === 'agent' &&
    Boolean(activeConversation.workspaceId);
  // AgentThreadHeader owns the computer-use status for its conversation; the
  // floating banner remains for every other thread/layout (fail-safe).
  const agentThreadHeaderVisible =
    layoutMode === 'agent' &&
    !activeChannelId &&
    activeConversation?.mode === 'agent' &&
    !activeConversation.channelId &&
    activeConversation.agentId === activeAgentId;
  const agentPanelVisible =
    layoutMode === 'agent' &&
    (Boolean(activeAgentId) || Boolean(activeChannelId)) &&
    !artifactPanelOpen &&
    !sourcesPanelOpen;
  const agentWorkspacePanel =
    agentPanelVisible && agentWorkspaceSession && agentRightPanel === 'workspace';
  const viewportWidth = useViewportWidth();
  const settingsTheme = useAppStore((state) => state.settings.theme);
  const fontScale = useAppStore((state) => state.settings.fontScale);
  const reduceMotion = useAppStore((state) => state.settings.reduceMotion);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void bootstrap();
  }, []);

  // Keep the backend settings in sync with theme changes coming from the UI.
  useEffect(() => {
    if (!ready) return;
    if (theme !== settingsTheme) {
      void useAppStore.getState().saveSettings({ theme });
    }
  }, [ready, theme, settingsTheme]);

  // Follow the OS theme while "system" is selected.
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => useThemeStore.getState().apply();
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [theme]);

  useEffect(() => {
    applyFontScale(fontScale);
  }, [fontScale]);

  // Automatic update checks (hydrate the cached release immediately, check
  // once the bootstrap is done and then every hour while the app is open).
  useUpdateCheck(ready);

  // Routine runs happen in the Rust scheduler, outside the renderer. Refresh
  // the conversation list and surface the outcome without stealing the active
  // thread.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentRoutineRunEvent>('zylara:agent-routine-run', (event) => {
      if (disposed) return;
      const run = event.payload;
      if (run.status === 'ok') {
        toast.success(t('common:shell.app.routineDone', { title: run.title }), {
          description: t('common:shell.app.routineDoneDescription'),
        });
      } else if (run.status === 'error' || run.status === 'blocked') {
        toast.error(t('common:shell.app.routineFailed', { title: run.title }), {
          description: run.error ?? undefined,
        });
      }
      window.dispatchEvent(new CustomEvent('zylara:agent-routine-run', { detail: run }));
      void useChatStore.getState().refreshConversations();
      void useAgentStore.getState().refresh();
      if (
        run.status !== 'queued' &&
        run.status !== 'running' &&
        run.conversationId &&
        useChatStore.getState().activeId === run.conversationId
      ) {
        void useChatStore.getState().openConversation(run.conversationId);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bridge unavailable outside Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Delegated tasks run in Rust. Refresh the task board/listeners without
  // stealing the active thread; task detail opens on demand.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const seen = new Set<string>();
    const ATTENTION = new Set([
      'waiting_input',
      'waiting_approval',
      'handoff_pending',
      'review',
      'done',
      'failed',
      'declined',
    ]);
    void listen<AgentTaskUpdatedEvent>('zylara:agent-task-updated', (event) => {
      if (disposed) return;
      window.dispatchEvent(
        new CustomEvent('zylara:agent-task-updated', { detail: event.payload }),
      );
      if (event.payload.originConversationId) {
        void useChatStore
          .getState()
          .reloadConversation(event.payload.originConversationId);
      }
      void useChatStore.getState().refreshConversations();
      void useAgentStore.getState().refresh();
      const settings = useAppStore.getState().settings;
      const status = event.payload.status;
      if (
        settings.notificationsEnabled === false ||
        settings.notificationsDnd === true ||
        settings.notificationsTasks === false ||
        !ATTENTION.has(status)
      ) {
        return;
      }
      const key = `${event.payload.taskId}:${status}`;
      if (seen.has(key)) return;
      seen.add(key);
      void (async () => {
        let conversationId: string | null = null;
        let agentId: string | null = event.payload.ownerAgentId;
        try {
          const detail = await api.getAgentTask(event.payload.taskId);
          conversationId = detail.task.conversationId;
          agentId = detail.task.ownerAgentId;
        } catch {
          /* the task may have been deleted; the toast still explains it */
        }
        const ui = useUiStore.getState();
        const focused =
          typeof document !== 'undefined' &&
          document.hasFocus() &&
          ui.layoutMode === 'agent' &&
          useChatStore.getState().activeId === conversationId;
        if (focused) return;
        const title =
          status === 'done'
            ? t('common:shell.app.taskDone')
            : status === 'failed' || status === 'declined'
              ? t('common:shell.app.taskFailed')
              : status === 'handoff_pending'
                ? t('common:shell.app.taskHandoff')
                : t('common:shell.app.taskNeedsYou');
        toast.info(title, {
          description: event.payload.title,
          action: conversationId
            ? {
                label: t('common:actions.open'),
                onClick: () => {
                  useUiStore.getState().setLayoutMode('agent');
                  if (agentId) useUiStore.getState().setActiveAgentId(agentId);
                  void useChatStore.getState().openConversation(conversationId!);
                },
              }
            : undefined,
        });
        void api.notifyDesktop(title, event.payload.title);
      })();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bridge unavailable outside Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Shared channel messages are appended by user posts, task results and the
  // `send_message` tool. Mirror the Rust event on the renderer bus.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ agentId: string; name: string }>('zylara:agent-created', (event) => {
      if (disposed) return;
      window.dispatchEvent(new CustomEvent('zylara:agent-created', { detail: event.payload }));
      void useAgentStore.getState().refresh();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bridge unavailable outside Tauri */
      });
    void listen<{ channelId: string }>('zylara:agent-channel-updated', (event) => {
      if (disposed) return;
      window.dispatchEvent(
        new CustomEvent('zylara:agent-channel-updated', { detail: event.payload }),
      );
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bridge unavailable outside Tauri */
      });
    void listen<{ channelId: string; recipientAgentId: string }>(
      'zylara:agent-inbox-updated',
      (event) => {
        if (disposed) return;
        window.dispatchEvent(
          new CustomEvent('zylara:agent-inbox-updated', { detail: event.payload }),
        );
        void useAgentStore.getState().refresh();
      },
    )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bridge unavailable outside Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Global turn bus: turns reattached after a webview reload keep streaming
  // even though their original invoke Channel is gone.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<TurnEventBusPayload>('zylara:turn-event', (event) => {
      if (disposed) return;
      void useChatStore.getState().handleTurnEvent(event.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bridge unavailable outside Tauri */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Chat and Code have separate session lists; switching layouts restores each
  // layout's own active session instead of leaking the other one.
  useLayoutEffect(() => {
    if (!ready) return;
    void useChatStore.getState().enterLayout(layoutMode);
  }, [layoutMode, ready]);

  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    if (!error) return;
    toast.error(t('common:shell.app.errorTitle'), { description: error });
    useAppStore.getState().setError(null);
  }, [error]);

  // Global keyboard shortcuts. The decision itself is pure (lib/hotkeys), so
  // precedence (palette ownership, Esc cascade, editable targets) is unit-tested.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();
      const command = resolveHotkey(event, {
        layoutMode: ui.layoutMode,
        commandPaletteOpen: ui.commandPaletteOpen,
        modelPickerOpen: ui.modelPickerOpen,
        settingsOpen: ui.settingsOpen,
        artifactPanelOpen: ui.artifactPanelOpen,
        sourcesPanelOpen: ui.sourcesPanelOpen,
        // The Chat views only own Escape while the Chat layout is active; in
        // the Code layout a stale `activeView` must not hijack Esc (the Code
        // Skills page has its own `codeSkillsView` flag).
        skillsView: ui.layoutMode === 'chat' && ui.activeView === 'skills',
        libraryView: ui.layoutMode === 'chat' && ui.activeView === 'library',
        codeSkillsView: ui.layoutMode === 'code' && ui.codeView === 'skills',
        streaming: useChatStore.getState().streaming !== null,
      });
      if (command) runHotkey(command, event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Native file drag & drop -> attachments (chat) or library upload.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const dispatchLibraryDrag = (active: boolean) => {
      window.dispatchEvent(new CustomEvent('zylara:library-drag', { detail: { active } }));
    };
    try {
      const webview = getCurrentWebview();
      void webview
        .onDragDropEvent((event) => {
          if (disposed) return;
          // The Biblioteca page replaces the chat column: a drop there imports
          // files into the user library instead of attaching them to the
          // composer (library-page PLAN §2.6). The view owns the import. It only
          // exists in the Chat layout (docs/goals/chat-code-layout/PLAN §3.5).
          const uiState = useUiStore.getState();
          if (uiState.layoutMode === 'chat' && uiState.activeView === 'library') {
            if (event.payload.type === 'drop') {
              dispatchLibraryDrag(false);
              const paths = event.payload.paths ?? [];
              if (paths.length) {
                window.dispatchEvent(
                  new CustomEvent('zylara:library-drop', { detail: { paths } }),
                );
              }
            } else if (event.payload.type === 'enter' || event.payload.type === 'over') {
              dispatchLibraryDrag(true);
            } else if (event.payload.type === 'leave') {
              dispatchLibraryDrag(false);
            }
            return;
          }
          if (event.payload.type === 'drop') {
            const paths = event.payload.paths ?? [];
            if (paths.length) {
              if (uiState.layoutMode === 'agent' && uiState.activeChannelId) {
                // The channel composer owns its own attachments; the chat
                // composer is not mounted in the Agentes layout.
                window.dispatchEvent(
                  new CustomEvent('zylara:channel-drop', { detail: { paths } }),
                );
              } else {
                void useChatStore.getState().addAttachments(paths);
              }
            }
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {
          /* drag & drop unsupported outside Tauri */
        });
    } catch {
      /* ignore */
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!ready && initializing) {
    return <SplashScreen />;
  }

  return (
    <TooltipProvider delayDuration={280}>
      <ErrorBoundary>
        <AppShell
          sidebar={
            layoutMode === 'code' ? (
              (context) => <CodeSidebar {...context} />
            ) : layoutMode === 'agent' ? (
              (context) => <AgentSidebar {...context} />
            ) : undefined
          }
          sidebarLabel={
            layoutMode === 'code'
              ? translate('shell.labels.sessions')
              : layoutMode === 'agent'
                ? translate('shell.labels.agents')
                : translate('shell.labels.conversations')
          }
          rightPanel={
            layoutMode === 'code' ? (
              <CodePanel />
            ) : agentPanelVisible ? (
              agentWorkspacePanel ? (
                <CodePanel />
              ) : (
                <AgentPanel />
              )
            ) : (
              <>
                <ArtifactPanel />
                <SourcesPanel />
              </>
            )
          }
          // The Code panel only docks from this width up (see CodePanel); the
          // chat mirrors that with its top-right corner.
          rightPanelOpen={
            (layoutMode === 'code' ||
              (agentPanelVisible &&
                (agentWorkspacePanel ? codePanelOpen : agentPanelOpen))) &&
            viewportWidth >= SIDE_PANEL_DOCK_MIN_VIEWPORT
          }
        >
          <WorkspaceCenter />
        </AppShell>
        <TrayPromptDialog />
        <SettingsDialog />
        <ModelPickerDialog />
        <CommandPalette />
        <ComputerControlBanner
          hideConversationId={agentThreadHeaderVisible ? activeConversation?.id ?? null : null}
        />
      </ErrorBoundary>
      <Toaster
        position="bottom-right"
        theme="system"
        closeButton
        toastOptions={{
          classNames: {
            toast:
              'rounded-xl bg-surface-raised text-foreground shadow-lg text-[13px]',
            description: 'text-foreground-muted',
          },
        }}
      />
    </TooltipProvider>
  );
}
