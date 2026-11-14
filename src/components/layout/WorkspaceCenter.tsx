import { useTranslation } from 'react-i18next';
import { AgentAvatarDialog } from '@/components/agents/AgentAvatarDialog';
import { AgentWorkspace } from '@/components/agents/AgentWorkspace';
import { ChatView } from '@/components/chat/ChatView';
import { SubagentChatView } from '@/components/agent/SubagentChatView';
import {
  CodeCommitHistoryView,
  CodeDiffView,
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
import { SkillsView } from '@/components/skills';
import { useChatStore, useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';

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
  const codePlanTab = useUiStore((state) => state.codePlanTab);
  const codeCommitsTab = useUiStore((state) => state.codeCommitsTab);
  const codeSubagentTab = useUiStore((state) => state.codeSubagentTab);
  const codePullRequestsTab = useUiStore((state) => state.codePullRequestsTab);
  const codePullRequestTab = useUiStore((state) => state.codePullRequestTab);
  const codeIssuesTab = useUiStore((state) => state.codeIssuesTab);
  const codeIssueTab = useUiStore((state) => state.codeIssueTab);
  const selectCodeCommit = useUiStore((state) => state.selectCodeCommit);
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const setCodeView = useUiStore((state) => state.setCodeView);
  const goalDialog = useUiStore((state) => state.goalDialog);
  const closeGoalDialog = useUiStore((state) => state.closeGoalDialog);
  /** Sessão ativa no Code (dona do objetivo exibido no painel central). */
  const activeId = useChatStore((state) => state.activeId);

  if (layoutMode === 'agent') {
    return (
      <>
        <AgentWorkspace />
        <AgentAvatarDialog />
      </>
    );
  }

  const isCode = layoutMode === 'code';
  const showSkills = isCode ? codeView === 'skills' : activeView === 'skills';
  const showLibrary = !isCode && activeView === 'library';
  const showDiff = isCode && codeView === 'diff' && codeDiffTab !== null;
  const showFile = isCode && codeView === 'file' && codeFileTab !== null;
  const showPlan = isCode && codeView === 'plan' && codePlanTab !== null;
  const showGoal = isCode && codeView === 'goal' && activeId !== null;
  const showCommits = isCode && codeView === 'commits' && codeCommitsTab !== null;
  const showSubagent = isCode && codeView === 'subagent' && codeSubagentTab !== null;
  const showTerminal = isCode && codeView === 'terminal';
  const showPullRequests = isCode && codeView === 'prs' && codePullRequestsTab !== null;
  const showPullRequest = isCode && codeView === 'pr' && codePullRequestTab !== null;
  const showIssues = isCode && codeView === 'issues' && codeIssuesTab !== null;
  const showIssue = isCode && codeView === 'issue' && codeIssueTab !== null;
  const showChat =
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

  return (
    <div className="flex h-full min-h-0 flex-col">
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
        {isCode ? <CodeSessionHeader /> : null}
      </div>

      <div
        id="code-session-panel"
        role="region"
        aria-label={t('shell.workspace.conversationRegion')}
        className={cn('min-h-0 flex-1 flex-col', showChat ? 'flex' : 'hidden')}
      >
        <ChatView welcome={isCode ? <CodeWelcomeScreen /> : undefined} />
      </div>

      {showTerminal ? (
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
      ) : null}

      {showSubagent && codeSubagentTab ? (
        <div
          id="code-subagent-panel"
          role="region"
          aria-label={t('shell.workspace.subagentRegion', { description: codeSubagentTab.description })}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SubagentChatView target={codeSubagentTab} />
        </div>
      ) : null}

      {showCommits && codeCommitsTab ? (
        <div
          id="code-commits-panel"
          role="region"
          aria-label={t('shell.workspace.commitsRegion')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CodeCommitHistoryView target={codeCommitsTab} onSelect={selectCodeCommit} />
        </div>
      ) : null}

      {showDiff && codeDiffTab ? (
        <div
          id="code-diff-panel"
          role="region"
          aria-label={t('shell.workspace.diffRegion', { path: codeDiffTab.path })}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CodeDiffView target={codeDiffTab} className="flex min-h-0 flex-1 flex-col" />
        </div>
      ) : null}

      {showFile && codeFileTab ? (
        <div
          id="code-file-panel"
          role="region"
          aria-label={t('shell.workspace.fileRegion', { path: codeFileTab.path })}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CodeFileView target={codeFileTab} className="flex min-h-0 flex-1 flex-col" />
        </div>
      ) : null}

      {showPlan && codePlanTab ? (
        <div
          id="code-plan-panel"
          role="region"
          aria-label={t('shell.workspace.planRegion')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CodePlanView tab={codePlanTab} className="flex min-h-0 flex-1 flex-col" />
        </div>
      ) : null}

      {/* Objetivo persistente da sessão (docs/goals/code-goals/PLAN.md §10.3):
          o `GoalPanel` é dono da region/id (`code-goal-panel`) e do scroll; aqui
          ele só ocupa o centro no lugar da conversa. */}
      {showGoal && activeId ? <GoalPanel conversationId={activeId} /> : null}

      {showPullRequests && codePullRequestsTab ? (
        <div
          id="code-prs-panel"
          role="region"
          aria-label={t('code:github.prs.title')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <GitHubPullRequestsView key={codePullRequestsTab.workspaceId} tab={codePullRequestsTab} />
        </div>
      ) : null}

      {showPullRequest && codePullRequestTab ? (
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
      ) : null}

      {showIssues && codeIssuesTab ? (
        <div
          id="code-issues-panel"
          role="region"
          aria-label={t('code:github.issues.title')}
          className="flex min-h-0 flex-1 flex-col"
        >
          <GitHubIssuesView key={codeIssuesTab.workspaceId} tab={codeIssuesTab} />
        </div>
      ) : null}

      {showIssue && codeIssueTab ? (
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
      ) : null}

      {showSkills ? (
        <SkillsView
          onBack={() => (isCode ? setCodeView('session') : setActiveView('chat'))}
          backLabel={isCode ? t('shell.workspace.backToSession') : t('shell.workspace.backToChat')}
        />
      ) : null}

      {showLibrary ? <LibraryView /> : null}

      {/* Diálogo de criação/edição do objetivo, aberto pelo pill do composer,
          pelo card de atenção, pelo `/goal` ou pelo painel central. */}
      {goalDialog ? (
        <GoalDialog
          conversationId={goalDialog.conversationId}
          mode={goalDialog.mode}
          onClose={closeGoalDialog}
        />
      ) : null}
    </div>
  );
}
