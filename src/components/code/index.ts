/**
 * Code workbench (docs/goals/chat-code-layout/PLAN.md): the Chat | Code toggle
 * lives in the title bar; these are the surfaces that only exist in the Code
 * layout. A partir do harness de código (docs/goals/code-harness/WORKBENCH.md),
 * a sidebar/cabeçalho/welcome usam workspaces reais do backend.
 */
export { CodeSidebar } from './CodeSidebar';
export type { CodeSidebarProps } from './CodeSidebar';

export { AddChatSessionDialog } from './AddChatSessionDialog';
export type { AddChatSessionDialogProps } from './AddChatSessionDialog';

export { CodeSessionHeader } from './CodeSessionHeader';

export { CodePanel } from './CodePanel';

export { TerminalPanel } from './TerminalPanel';
export type { TerminalPanelProps } from './TerminalPanel';

export { CodeWelcomeScreen } from './CodeWelcomeScreen';

export { CodeDiffView } from './CodeDiffView';
export type { CodeDiffViewProps } from './CodeDiffView';

export { CodeFileView } from './CodeFileView';
export type { CodeFileViewProps } from './CodeFileView';

export { CodeEditor } from './CodeEditor';
export type { CodeEditorProps, CodeEditorHandle } from './CodeEditor';

export { EditorFindBar } from './EditorFindBar';
export type { EditorFindBarProps } from './EditorFindBar';

export { EditorHeader } from './EditorHeader';
export type { EditorHeaderProps } from './EditorHeader';

export { UnsavedChangesDialog } from './UnsavedChangesDialog';
export type { UnsavedChangesDialogProps } from './UnsavedChangesDialog';

export { useFileEditor } from './useFileEditor';
export type { FileEditorApi, UseFileEditorOptions } from './useFileEditor';

export { useCodeFileClose } from './useCodeFileClose';
export type { FileCloseController, PendingFileClose } from './useCodeFileClose';

export { saveEditorBuffer } from './saveBuffer';

export { CodeFileSplitView } from './CodeFileSplitView';
export type { CodeFileSplitViewProps } from './CodeFileSplitView';

export { CodePlanView } from './CodePlanView';
export type { CodePlanViewProps } from './CodePlanView';

export { GoalPanel } from './GoalPanel';
export type { GoalPanelProps } from './GoalPanel';

export { GoalDialog } from './GoalDialog';
export type { GoalDialogProps } from './GoalDialog';

export { CodeTurnSummary } from './CodeTurnSummary';
export type { CodeTurnSummaryProps } from './CodeTurnSummary';

export { CodeCommitHistoryView } from './CodeCommitHistoryView';
export type { CodeCommitHistoryViewProps, CodeCommitsTabTarget } from './CodeCommitHistoryView';

export {
  GitHubIssueView,
  GitHubIssuesView,
  GitHubPullRequestsView,
  GitHubPullRequestView,
} from './github';
export type {
  GitHubIssueViewProps,
  GitHubIssuesViewProps,
  GitHubNewIssueDialogProps,
  GitHubNewPullRequestDialogProps,
  GitHubPullRequestsViewProps,
  GitHubPullRequestViewProps,
} from './github';

export { WorkspaceTrustDialog } from './WorkspaceTrustDialog';
export type { WorkspaceTrustDialogProps } from './WorkspaceTrustDialog';

export {
  useWorkspaces,
  NO_WORKSPACE_KEY,
  openFolder,
  startSessionInWorkspace,
  reloadWorkspaces,
} from './useWorkspaces';
export type { UseWorkspacesResult, OpenFolderOptions, PendingWorkspaceTrust } from './useWorkspaces';
