import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { forwardRef } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useReduceMotion } from './hooks';
import { AgentAvatarDialog } from '@/components/agents/AgentAvatarDialog';
import { AgentWorkspace } from '@/components/agents/AgentWorkspace';
import { ChatView } from '@/components/chat/ChatView';
import { SubagentChatView } from '@/components/agent/SubagentChatView';
import {
  CodeCommitHistoryView,
  CodeDiffView,
  CodeFileSplitView,
  CodeFileView,
  CodePlanView,
  CodeSessionHeader,
  CodeWelcomeScreen,
  GitHubIssueView,
  GitHubIssuesView,
  GitHubPullRequestView,
  GitHubPullRequestsView,
  GoalDialog,
  GoalPanel,
  TerminalPanel,
} from '@/components/code';
import { LibraryView } from '@/components/library';
import { PluginsView } from '@/components/plugins/PluginsView';
import { PluginPageHost } from '@/components/plugins/ui/PluginPageHost';
import { SkillsView } from '@/components/skills';
import { useChatStore, useUiStore } from '@/lib/store';
import { usePluginRegistry } from '@/lib/plugins/registry';
import { LayoutTopRow } from './LayoutTopRow';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { ComponentSlot } from '@/components/plugins/ui/Slot';
import type { PluginComponent } from '@/lib/plugins/ui/types';
import { cn } from '@/lib/utils';

/** Host center workbench of the Code layout. A trusted plugin can replace it and
 * still receive the host tree as `children`. */
function CodeWorkbenchFallback({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const PANEL_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Animated wrapper for the mutually exclusive center views. The chat region
 * stays mounted outside the `AnimatePresence` (draft/scroll/`aria-controls`).
 * On exit the surface is taken out of flow so the next view (or the chat) can
 * occupy its space while the old one fades on top.
 */
const AnimatedPanel = forwardRef<
  HTMLDivElement,
  {
    /** Optional inner key; AnimatePresence tracks the React `key` on this wrapper. */
    viewKey?: string;
    reduceMotion: boolean;
    className?: string;
    children: ReactNode;
  }
>(function AnimatedPanel({ viewKey, reduceMotion, className, children }, ref) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      ref={ref}
      key={viewKey}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: PANEL_EASE }}
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        !isPresent && 'pointer-events-none',
        className,
      )}
    >
      {children}
    </motion.div>
  );
});

/**
 * Center column of the application shell.
 *
 * The Chat and Code layouts share the exact same `ChatView` instance (and its
 * `Composer`), so switching layouts keeps the draft, attachments and scroll
 * position (docs/goals/chat-code-layout/PLAN.md §3.3). Only the chrome around
 * it changes: the Code session header/tabs are inserted above the conversation,
 * and each layout has its own page state (Chat: `activeView`, Code: `codeView`).
 *
 * Biblioteca (`library`) only exists in the Chat layout — the Code workbench
 * deliberately has no library page (PLAN §3.2/§3.5).
 */
export function WorkspaceCenter() {
  const { t } = useTranslation('common');
  const layoutMode = useUiStore((state) => state.layoutMode);
  const codeView = useUiStore((state) => state.codeView);
  const codeDiffTab = useUiStore((state) => state.codeDiffTab);
  const codeFileTab = useUiStore((state) => state.codeFileTab);
  const secondaryCodeFileTab = useUiStore((state) => state.secondaryCodeFileTab);
  const codePlanTab = useUiStore((state) => state.codePlanTab);
  const codeCommitsTab = useUiStore((state) => state.codeCommitsTab);
  const codeSubagentTab = useUiStore((state) => state.codeSubagentTab);
  const codePullRequestsTab = useUiStore((state) => state.codePullRequestsTab);
  const codePullRequestTab = useUiStore((state) => state.codePullRequestTab);
  const codeIssuesTab = useUiStore((state) => state.codeIssuesTab);
  const codeIssueTab = useUiStore((state) => state.codeIssueTab);
  const selectCodeCommit = useUiStore((state) => state.selectCodeCommit);
  const activeView = useUiStore((state) => state.activeView);
  const agentView = useUiStore((state) => state.agentView);
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const activeChannelId = useUiStore((state) => state.activeChannelId);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const setCodeView = useUiStore((state) => state.setCodeView);
  const goalDialog = useUiStore((state) => state.goalDialog);
  const closeGoalDialog = useUiStore((state) => state.closeGoalDialog);
  /** Sessão ativa no Code (dona do objetivo exibido no painel central). */
  const activeId = useChatStore((state) => state.activeId);
  const pluginUiEnabled = usePluginUiPrefs((state) => state.enabled);
  const rawPluginPage = useUiStore((state) => state.pluginPages[state.layoutMode]);
  const pluginPage = pluginUiEnabled ? rawPluginPage : null;
  const reduceMotion = useReduceMotion();
  usePluginRegistry();

  const codePluginPage = layoutMode === 'code' ? pluginPage : null;
  if (pluginPage && layoutMode !== 'code') {
    // Pages that replace the chat column still get the layout chrome row, so the
    // app icon, the global actions and the window-controls corner never vanish.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <LayoutTopRow />
        <div className="min-h-0 flex-1">
          <PluginPageHost layout={layoutMode} target={pluginPage} />
        </div>
      </div>
    );
  }

  if (layoutMode === 'agent') {
    if (
      agentView === 'plugins' &&
      activeAgentId === null &&
      activeChannelId === null &&
      activeId === null
    ) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <LayoutTopRow />
          <div className="min-h-0 flex-1">
            <ComponentSlot
              name="plugins.view"
              fallback={PluginsView as unknown as PluginComponent}
            />
          </div>
        </div>
      );
    }
    return (
      <>
        <ComponentSlot
          name="agent.workspace"
          fallback={AgentWorkspace as unknown as PluginComponent}
        />
        <AgentAvatarDialog />
      </>
    );
  }

  const isCode = layoutMode === 'code';
  const centralHost = !codePluginPage;
  const showPlugins = centralHost && (isCode ? codeView === 'plugins' : activeView === 'plugins');
  const showSkills = centralHost && (isCode ? codeView === 'skills' : activeView === 'skills');
  const showLibrary = centralHost && !isCode && activeView === 'library';
  const showDiff = centralHost && isCode && codeView === 'diff' && codeDiffTab !== null;
  const showFile =
    centralHost &&
    isCode &&
    codeView === 'file' &&
    (codeFileTab !== null || secondaryCodeFileTab !== null);
  const showPlan = centralHost && isCode && codeView === 'plan' && codePlanTab !== null;
  const showGoal = centralHost && isCode && codeView === 'goal' && activeId !== null;
  const showCommits = centralHost && isCode && codeView === 'commits' && codeCommitsTab !== null;
  const showSubagent = centralHost && isCode && codeView === 'subagent' && codeSubagentTab !== null;
  const showTerminal = centralHost && isCode && codeView === 'terminal';
  const showPullRequests = centralHost && isCode && codeView === 'prs' && codePullRequestsTab !== null;
  const showPullRequest = centralHost && isCode && codeView === 'pr' && codePullRequestTab !== null;
  const showIssues = centralHost && isCode && codeView === 'issues' && codeIssuesTab !== null;
  const showIssue = centralHost && isCode && codeView === 'issue' && codeIssueTab !== null;
  const showChat =
    !codePluginPage &&
    !showPlugins &&
    !showSkills &&
    !showLibrary &&
    !showDiff &&
    !showCommits &&
    !showFile &&
    !showPlan &&
    !showGoal &&
    !showSubagent &&
    !showTerminal &&
    !showPullRequests &&
    !showPullRequest &&
    !showIssues &&
    !showIssue;
  const showHeader =
    isCode &&
    (showChat ||
      showDiff ||
      showCommits ||
      showFile ||
      showPlan ||
      showGoal ||
      showSubagent ||
      showTerminal ||
      showPullRequests ||
      showPullRequest ||
      showIssues ||
      showIssue);

  const body = (
    <>
      {/* Pages that replace the conversation column (Biblioteca, Skills, Plugins
          e páginas de plugin) still need the layout chrome row. */}
      {isCode ? (showHeader ? null : <LayoutTopRow />) : showPlugins || showSkills || showLibrary ? (
        <LayoutTopRow />
      ) : null}
      {/* Stable wrapper: the conversation below keeps its DOM position across
          layout switches (see `aria-controls` of the Code session tabs). The
          header stays mounted while the Code Skills page is open so the open
          session tabs are not lost when coming back (PLAN §3.3), and stays
          visible above the central tabs of diff/commits/file (WORKBENCH §7). */}
      <div
        className={cn('shrink-0', !showHeader && 'hidden')}
        aria-hidden={isCode && !showHeader ? true : undefined}
        inert={isCode && !showHeader ? true : undefined}
      >
        {isCode ? (
          <ComponentSlot
            name="code.session.header"
            fallback={CodeSessionHeader as unknown as PluginComponent}
          />
        ) : null}
      </div>

      <div
        id="code-session-panel"
        role="region"
        aria-label={t('shell.workspace.conversationRegion')}
        className={cn('min-h-0 flex-1 flex-col', showChat ? 'flex' : 'hidden')}
      >
        <ComponentSlot
          name="chat.view"
          fallback={ChatView as unknown as PluginComponent}
          props={{
            welcome: isCode ? (
              <ComponentSlot
                name="code.welcome"
                fallback={CodeWelcomeScreen as unknown as PluginComponent}
              />
            ) : undefined,
          }}
        />
      </div>

      {/* Mutually exclusive center views. The chat region above stays mounted;
          only these surfaces animate in/out; the outgoing one is popped out of
          layout so the next view mounts without waiting. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {codePluginPage ? (
          <AnimatedPanel key="plugin-page" reduceMotion={reduceMotion}>
            <PluginPageHost layout="code" target={codePluginPage} />
          </AnimatedPanel>
        ) : null}

        {showTerminal ? (
          <AnimatedPanel key="terminal" reduceMotion={reduceMotion}>
            <div
              id="code-terminal-panel"
              role="region"
              aria-label={t('shell.workspace.terminalRegion')}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TerminalPanel
                conversationId={activeId}
                surface="center"
                showTabStrip={false}
                autoFocus
                className="min-h-0 flex-1"
              />
            </div>
          </AnimatedPanel>
        ) : null}

        {showSubagent && codeSubagentTab ? (
          <AnimatedPanel key="subagent" reduceMotion={reduceMotion}>
            <div
              id="code-subagent-panel"
              role="region"
              aria-label={t('shell.workspace.subagentRegion', { description: codeSubagentTab.description })}
              className="flex min-h-0 flex-1 flex-col"
            >
              <SubagentChatView target={codeSubagentTab} />
            </div>
          </AnimatedPanel>
        ) : null}

        {showCommits && codeCommitsTab ? (
          <AnimatedPanel key="commits" reduceMotion={reduceMotion}>
            <div
              id="code-commits-panel"
              role="region"
              aria-label={t('shell.workspace.commitsRegion')}
              className="flex min-h-0 flex-1 flex-col"
            >
              <CodeCommitHistoryView target={codeCommitsTab} onSelect={selectCodeCommit} />
            </div>
          </AnimatedPanel>
        ) : null}

        {showDiff && codeDiffTab ? (
          <AnimatedPanel key={`diff:${codeDiffTab.path}`} reduceMotion={reduceMotion}>
            <div
              id="code-diff-panel"
              role="region"
              aria-label={t('shell.workspace.diffRegion', { path: codeDiffTab.path })}
              className="flex min-h-0 flex-1 flex-col"
            >
              <CodeDiffView target={codeDiffTab} className="flex min-h-0 flex-1 flex-col" />
            </div>
          </AnimatedPanel>
        ) : null}

        {showFile && secondaryCodeFileTab ? (
          <AnimatedPanel key={`file-split:${secondaryCodeFileTab.path}`} reduceMotion={reduceMotion}>
            <CodeFileSplitView
              primary={codeFileTab}
              secondary={secondaryCodeFileTab}
              className="flex min-h-0 flex-1 flex-col"
            />
          </AnimatedPanel>
        ) : showFile && codeFileTab ? (
          <AnimatedPanel key={`file:${codeFileTab.path}`} reduceMotion={reduceMotion}>
            <div
              id="code-file-panel"
              role="region"
              aria-label={t('shell.workspace.fileRegion', { path: codeFileTab.path })}
              className="flex min-h-0 flex-1 flex-col"
            >
              <CodeFileView target={codeFileTab} className="flex min-h-0 flex-1 flex-col" />
            </div>
          </AnimatedPanel>
        ) : null}

        {showPlan && codePlanTab ? (
          <AnimatedPanel key={`plan:${codePlanTab.title}`} reduceMotion={reduceMotion}>
            <div
              id="code-plan-panel"
              role="region"
              aria-label={t('shell.workspace.planRegion')}
              className="flex min-h-0 flex-1 flex-col"
            >
              <CodePlanView tab={codePlanTab} className="flex min-h-0 flex-1 flex-col" />
            </div>
          </AnimatedPanel>
        ) : null}

        {/* Persistent session goal (docs/goals/code-goals/PLAN.md §10.3):
            `GoalPanel` owns the region/id (`code-goal-panel`) and scrolling. */}
        {showGoal && activeId ? (
          <AnimatedPanel key={`goal:${activeId}`} reduceMotion={reduceMotion}>
            <GoalPanel conversationId={activeId} />
          </AnimatedPanel>
        ) : null}

        {showPullRequests && codePullRequestsTab ? (
          <AnimatedPanel key={`prs:${codePullRequestsTab.workspaceId}`} reduceMotion={reduceMotion}>
            <div
              id="code-prs-panel"
              role="region"
              aria-label={t('code:github.prs.title')}
              className="flex min-h-0 flex-1 flex-col"
            >
              <GitHubPullRequestsView key={codePullRequestsTab.workspaceId} tab={codePullRequestsTab} />
            </div>
          </AnimatedPanel>
        ) : null}

        {showPullRequest && codePullRequestTab ? (
          <AnimatedPanel
            key={`pr:${codePullRequestTab.workspaceId}:${codePullRequestTab.number}`}
            reduceMotion={reduceMotion}
          >
            <div
              id="code-pr-panel"
              role="region"
              aria-label={t('code:github.pr.aria', { number: codePullRequestTab.number })}
              className="flex min-h-0 flex-1 flex-col"
            >
              <GitHubPullRequestView
                key={`${codePullRequestTab.workspaceId}:${codePullRequestTab.number}`}
                tab={codePullRequestTab}
              />
            </div>
          </AnimatedPanel>
        ) : null}

        {showIssues && codeIssuesTab ? (
          <AnimatedPanel key={`issues:${codeIssuesTab.workspaceId}`} reduceMotion={reduceMotion}>
            <div
              id="code-issues-panel"
              role="region"
              aria-label={t('code:github.issues.title')}
              className="flex min-h-0 flex-1 flex-col"
            >
              <GitHubIssuesView key={codeIssuesTab.workspaceId} tab={codeIssuesTab} />
            </div>
          </AnimatedPanel>
        ) : null}

        {showIssue && codeIssueTab ? (
          <AnimatedPanel key={`issue:${codeIssueTab.workspaceId}:${codeIssueTab.number}`} reduceMotion={reduceMotion}>
            <div
              id="code-issue-panel"
              role="region"
              aria-label={t('code:github.issue.aria', { number: codeIssueTab.number })}
              className="flex min-h-0 flex-1 flex-col"
            >
              <GitHubIssueView
                key={`${codeIssueTab.workspaceId}:${codeIssueTab.number}`}
                tab={codeIssueTab}
              />
            </div>
          </AnimatedPanel>
        ) : null}

        {showPlugins ? (
          <AnimatedPanel key="plugins" reduceMotion={reduceMotion}>
            <ComponentSlot
              name="plugins.view"
              fallback={PluginsView as unknown as PluginComponent}
            />
          </AnimatedPanel>
        ) : null}

        {showSkills ? (
          <AnimatedPanel key="skills" reduceMotion={reduceMotion}>
            <SkillsView
              onBack={() => (isCode ? setCodeView('session') : setActiveView('chat'))}
              backLabel={isCode ? t('shell.workspace.backToSession') : t('shell.workspace.backToChat')}
            />
          </AnimatedPanel>
        ) : null}

        {showLibrary ? (
          <AnimatedPanel key="library" reduceMotion={reduceMotion}>
            <LibraryView />
          </AnimatedPanel>
        ) : null}
      </AnimatePresence>

      {/* Diálogo de criação/edição do objetivo, aberto pelo pill do composer,
          pelo card de atenção, pelo `/goal` ou pelo painel central. */}
      {goalDialog ? (
        <GoalDialog
          conversationId={goalDialog.conversationId}
          mode={goalDialog.mode}
          onClose={closeGoalDialog}
        />
      ) : null}
    </>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* `code.workbench` only matches in the Code layout (contract `layouts`),
          so keeping the slot mounted in every layout preserves the chat
          instance across layout switches. */}
      <ComponentSlot
        name="code.workbench"
        fallback={CodeWorkbenchFallback}
        props={{ children: body }}
      />
    </div>
  );
}
