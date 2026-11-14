/**
 * Typed wrappers around the Tauri command surface (`src-tauri/src/commands/`).
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  Agent,
  AgentAvatar,
  AgentChannel,
  AgentChannelInput,
  AgentChannelMessage,
  AgentChannelPostResult,
  AgentInboxCount,
  AgentInput,
  AgentMemory,
  AgentMemoryInput,
  AgentSharedMemory,
  AgentRevision,
  AgentRoutine,
  AgentRoutineRun,
  AgentTask,
  AgentTaskDetail,
  AgentTaskInput,
  AgentRoutineInput,
  AgentThreadCursor,
  AgentUsage,
  UsageStats,
  AgentThreadPage,
  ActiveTurnInfo,
  AppInfo,
  ComputerActionRecord,
  ComputerControlTarget,
  ComputerPreview,
  ComputerSession,
  BrowserFrame,
  BrowserSnapshot,
  BrowserStatus,
  BrowserTab,
  ApprovalDecision,
  ApprovalRule,
  ApprovalRuleInput,
  ApprovalScope,
  Artifact,
  ArtifactContent,
  ArtifactPreview,
  ArtifactThumbnail,
  AskUserAnswer,
  McpStatus,
  AttachmentContent,
  AttachmentInfo,
  CatalogView,
  CacheStatsView,
  CodeEnvironmentStatus,
  CodeSessionState,
  CommitTarget,
  Conversation,
  ConversationDetail,
  ConversationMode,
  CreateGoalInput,
  DockerDaemonStatus,
  DockerImageInfo,
  DockerStatus,
  FileChange,
  GitHubAccount,
  GitHubComment,
  GitHubConnectionView,
  GitHubIssueDetail,
  GitHubIssueFilter,
  GitHubIssueList,
  GitHubIssueSummary,
  GitHubLabel,
  GitHubMergeMethod,
  GitHubMergeResult,
  GitHubMilestone,
  GitHubPullRequestCommit,
  GitHubPullRequestDetail,
  GitHubPullRequestFiles,
  GitHubPullRequestFilter,
  GitHubPullRequestList,
  GitHubPullRequestSummary,
  GitHubReview,
  GitHubReviewEvent,
  GitHubUser,
  GoalAction,
  GoalContinuation,
  GoalRound,
  JobView,
  LibraryArtifact,
  LoginChallenge,
  PermissionMode,
  PlanApprovalChoice,
  ProviderAuthStatus,
  ProviderValidation,
  Settings,
  SettingsView,
  SkillContent,
  SkillDraft,
  SkillSummary,
  SkillVersion,
  TerminalEvent,
  TerminalInfo,
  ThemeInfo,
  ThemeInstallResult,
  TurnEvent,
  TurnEventRecord,
  TurnPayload,
  TurnResult,
  UpdateDownloadResult,
  UpdateEvent,
  UpdateGoalInput,
  UpdateNotes,
  UpdateStatus,
  Workspace,
  WorkspaceCommitDetail,
  WorkspaceContext,
  WorkspaceFileContent,
  WorkspaceFileEntry,
  WorkspaceGitCommit,
  WorkspaceGitCompare,
  WorkspaceGitBranches,
  WorkspaceGitStatus,
  WorkspaceTreeSnapshot,
} from './types';

export const api = {
  /* -------- app / settings -------- */
  appInfo: () => invoke<AppInfo>('app_info'),
  getSettings: () => invoke<SettingsView>('get_settings'),
  saveSettings: (settings: Settings) => invoke<SettingsView>('save_settings', { settings }),
  setProviderKey: (providerId: string, key: string | null) =>
    invoke<SettingsView>('set_provider_key', { providerId, key }),
  validateProvider: (providerId: string) =>
    invoke<ProviderValidation>('validate_provider', { providerId }),
  openDataDir: () => invoke<void>('open_data_dir'),
  resetAppData: () => invoke<void>('reset_app_data'),
  listThemes: () => invoke<ThemeInfo[]>('list_themes'),
  installTheme: (path: string) => invoke<ThemeInstallResult>('install_theme', { path }),
  uninstallTheme: (themeId: string) => invoke<ThemeInfo[]>('uninstall_theme', { themeId }),
  getThemeAsset: (themeId: string, asset: string) =>
    invoke<string>('get_theme_asset', { themeId, asset }),
  openThemesDir: () => invoke<void>('open_themes_dir'),
  getCodeEnvironment: () => invoke<CodeEnvironmentStatus>('get_code_environment'),
  notifyDesktop: (title: string, body: string) =>
    invoke<boolean>('notify_desktop', { title, body }),
  dockerStatus: () => invoke<DockerStatus>('docker_status'),
  dockerPullImage: (image: string) => invoke<string>('docker_pull_image', { image }),
  dockerStartDaemon: () => invoke<DockerDaemonStatus>('docker_start_daemon'),
  dockerValidateImage: (image: string) =>
    invoke<DockerImageInfo>('docker_validate_image', { image }),
  dockerCleanup: () => invoke<number>('docker_cleanup'),
  openSkillsDir: () => invoke<void>('open_skills_dir'),

  /* -------- atualizações -------- */
  updateStatus: () => invoke<UpdateStatus>('update_status'),
  checkForUpdate: (force = false) =>
    invoke<UpdateStatus>('check_for_update', { force }),
  getUpdateNotes: (version: string) =>
    invoke<UpdateNotes>('get_update_notes', { version }),
  downloadUpdate: (version: string, onEvent: (event: UpdateEvent) => void) => {
    const channel = new Channel<UpdateEvent>();
    channel.onmessage = onEvent;
    return invoke<UpdateDownloadResult>('download_update', { version, onEvent: channel });
  },
  cancelUpdateDownload: () => invoke<void>('cancel_update_download'),
  installUpdate: (version: string) => invoke<void>('install_update', { version }),
  revealUpdate: (version: string) => invoke<void>('reveal_update', { version }),
  setUpdatePreferences: (autoCheck: boolean) =>
    invoke<UpdateStatus>('set_update_preferences', { autoCheck }),
  skipUpdateVersion: (version: string | null) =>
    invoke<UpdateStatus>('skip_update_version', { version }),
  markUpdateNotified: (version: string) =>
    invoke<void>('mark_update_notified', { version }),
  acknowledgeUpdateResult: () => invoke<void>('acknowledge_update_result'),

  /* -------- skills (gestão) -------- */
  getSkills: () => invoke<SkillSummary[]>('get_skills'),
  setSkillEnabled: (name: string, enabled: boolean) =>
    invoke<SkillSummary[]>('set_skill_enabled', { name, enabled }),
  deleteSkill: (name: string) => invoke<SkillSummary[]>('delete_skill', { name }),
  getSkillContent: (name: string) => invoke<SkillContent>('get_skill_content', { name }),
  saveSkill: (draft: SkillDraft) => invoke<SkillContent>('save_skill', { draft }),
  listSkillVersions: (name: string) =>
    invoke<SkillVersion[]>('list_skill_versions', { name }),

  /* -------- catalog -------- */
  getCatalog: () => invoke<CatalogView>('get_catalog'),
  refreshCatalog: () => invoke<CatalogView>('refresh_catalog'),
  listRemoteModels: (providerId: string) =>
    invoke<string[]>('list_remote_models', { providerId }),
  refreshProviderModels: (providerId: string) =>
    invoke<CatalogView>('refresh_provider_models', { providerId }),

  /* -------- OpenAI ChatGPT plan auth (two-phase login) -------- */
  openaiLoginStart: (providerId: string, forceConsent = false) =>
    invoke<LoginChallenge>('openai_login_start', { providerId, forceConsent }),
  openaiLoginWait: (attemptId: string) =>
    invoke<ProviderAuthStatus>('openai_login_wait', { attemptId }),
  openaiLoginCancel: (attemptId: string) =>
    invoke<void>('openai_login_cancel', { attemptId }),
  openaiSignOut: (providerId: string) =>
    invoke<ProviderAuthStatus>('openai_sign_out', { providerId }),
  openaiAuthStatus: () => invoke<ProviderAuthStatus[]>('openai_auth_status'),

  /* -------- conversations -------- */
  listConversations: () => invoke<Conversation[]>('list_conversations'),
  listSubagentConversations: (parentId: string) =>
    invoke<Conversation[]>('list_subagent_conversations', { parentId }),
  createConversation: (
    title?: string,
    providerId?: string,
    modelId?: string,
    mode?: ConversationMode,
    agentId?: string,
  ) =>
    invoke<Conversation>('create_conversation', {
      title: title ?? null,
      providerId: providerId ?? null,
      modelId: modelId ?? null,
      mode: mode ?? null,
      agentId: agentId ?? null,
    }),
  listAgents: (includeArchived = false) =>
    invoke<Agent[]>('list_agents', { includeArchived }),
  getAgent: (agentId: string) => invoke<Agent>('get_agent', { agentId }),
  createAgent: (input: AgentInput) => invoke<Agent>('create_agent', { input }),
  updateAgent: (agentId: string, input: AgentInput) =>
    invoke<Agent>('update_agent', { agentId, input }),
  setAgentAvatar: (agentId: string, avatar: AgentAvatar) =>
    invoke<Agent>('set_agent_avatar', { agentId, avatar }),
  importAgentAvatarImage: (path: string) =>
    invoke<string>('import_agent_avatar_image', { path }),
  setAgentPinned: (agentId: string, pinned: boolean) =>
    invoke<Agent>('set_agent_pinned', { agentId, pinned }),
  reorderAgents: (ids: string[]) => invoke<void>('reorder_agents', { ids }),
  archiveAgent: (agentId: string) => invoke<Agent>('archive_agent', { agentId }),
  restoreAgent: (agentId: string) => invoke<Agent>('restore_agent', { agentId }),
  deleteAgent: (agentId: string) => invoke<void>('delete_agent', { agentId }),
  duplicateAgent: (agentId: string) => invoke<Agent>('duplicate_agent', { agentId }),
  exportAgent: (agentId: string) => invoke<string | null>('export_agent', { agentId }),
  importAgent: () => invoke<Agent | null>('import_agent'),
  suggestAgent: (prompt: string, providerId: string, modelId: string) =>
    invoke<AgentInput>('suggest_agent', { prompt, providerId, modelId }),
  reviseAgent: (agentId: string, prompt: string, providerId: string, modelId: string) =>
    invoke<AgentRevision>('revise_agent', { agentId, prompt, providerId, modelId }),
  listAgentThreads: (
    agentId: string,
    cursor?: AgentThreadCursor | null,
    limit?: number,
  ) =>
    invoke<AgentThreadPage>('list_agent_threads', {
      agentId,
      cursor: cursor ?? null,
      limit: limit ?? null,
    }),
  listAgentMemories: (agentId: string) =>
    invoke<AgentMemory[]>('list_agent_memories', { agentId }),
  createAgentMemory: (agentId: string, input: AgentMemoryInput) =>
    invoke<AgentMemory>('create_agent_memory', { agentId, input }),
  updateAgentMemory: (agentId: string, memoryId: string, input: AgentMemoryInput) =>
    invoke<AgentMemory>('update_agent_memory', { agentId, memoryId, input }),
  deleteAgentMemory: (agentId: string, memoryId: string) =>
    invoke<void>('delete_agent_memory', { agentId, memoryId }),
  clearAgentMemories: (agentId: string) =>
    invoke<number>('clear_agent_memories', { agentId }),
  listSharedAgentMemories: () =>
    invoke<AgentSharedMemory[]>('list_shared_agent_memories'),
  deleteSharedAgentMemory: (memoryId: string) =>
    invoke<void>('delete_shared_agent_memory', { memoryId }),
  getAgentUsage: (agentId: string) =>
    invoke<AgentUsage>('get_agent_usage', { agentId }),
  listAgentUsage: () => invoke<AgentUsage[]>('list_agent_usage'),
  getUsageStats: (since: number | null) =>
    invoke<UsageStats>('get_usage_stats', { since }),
  listAgentRoutines: (agentId: string) =>
    invoke<AgentRoutine[]>('list_agent_routines', { agentId }),
  listAllAgentRoutines: () => invoke<AgentRoutine[]>('list_all_agent_routines'),
  listAgentRoutineRuns: (routineId: string, limit?: number) =>
    invoke<AgentRoutineRun[]>('list_agent_routine_runs', {
      routineId,
      limit: limit ?? null,
    }),
  createAgentRoutine: (agentId: string, input: AgentRoutineInput) =>
    invoke<AgentRoutine>('create_agent_routine', { agentId, input }),
  updateAgentRoutine: (routineId: string, input: AgentRoutineInput) =>
    invoke<AgentRoutine>('update_agent_routine', { routineId, input }),
  setAgentRoutineEnabled: (routineId: string, enabled: boolean) =>
    invoke<AgentRoutine>('set_agent_routine_enabled', { routineId, enabled }),
  deleteAgentRoutine: (routineId: string) =>
    invoke<void>('delete_agent_routine', { routineId }),
  runAgentRoutineNow: (routineId: string) =>
    invoke<AgentRoutine>('run_agent_routine_now', { routineId }),
  listAgentTasks: (filter?: {
    status?: string;
    ownerAgentId?: string;
    channelId?: string;
  }) =>
    invoke<AgentTask[]>('list_agent_tasks', {
      status: filter?.status ?? null,
      ownerAgentId: filter?.ownerAgentId ?? null,
      channelId: filter?.channelId ?? null,
    }),
  getAgentTask: (taskId: string) => invoke<AgentTaskDetail>('get_agent_task', { taskId }),
  createAgentTask: (input: AgentTaskInput) =>
    invoke<AgentTask>('create_agent_task', { input }),
  cancelAgentTask: (taskId: string) => invoke<AgentTask>('cancel_agent_task', { taskId }),
  resumeAgentTask: (taskId: string) => invoke<AgentTask>('resume_agent_task', { taskId }),
  reassignAgentTask: (taskId: string, toAgentId: string) =>
    invoke<AgentTask>('reassign_agent_task', { taskId, toAgentId }),
  runAgentTaskNow: (taskId: string) => invoke<AgentTask>('run_agent_task_now', { taskId }),
  listAgentChannels: () => invoke<AgentChannel[]>('list_agent_channels'),
  reorderAgentChannels: (ids: string[]) => invoke<void>('reorder_agent_channels', { ids }),
  createAgentChannel: (input: AgentChannelInput) =>
    invoke<AgentChannel>('create_agent_channel', { input }),
  updateAgentChannel: (channelId: string, input: AgentChannelInput) =>
    invoke<AgentChannel>('update_agent_channel', { channelId, input }),
  deleteAgentChannel: (channelId: string) =>
    invoke<void>('delete_agent_channel', { channelId }),
  listAgentChannelMessages: (channelId: string) =>
    invoke<AgentChannelMessage[]>('list_agent_channel_messages', { channelId }),
  listAgentChannelInboxCounts: () =>
    invoke<AgentInboxCount[]>('list_agent_channel_inbox_counts'),
  postAgentChannelMessage: (channelId: string, content: string, attachmentIds: string[]) =>
    invoke<AgentChannelPostResult>('post_agent_channel_message', {
      channelId,
      content,
      attachmentIds,
    }),
  mcpStatus: () => invoke<McpStatus>('mcp_status'),
  getConversation: (id: string) =>
    invoke<ConversationDetail | null>('get_conversation', { id }),
  /** Cache telemetry aggregate for the context-meter indicator. */
  getCacheStats: (conversationId: string, limit?: number) =>
    invoke<CacheStatsView>('get_cache_stats', { conversationId, limit }),
  renameConversation: (id: string, title: string) =>
    invoke<void>('rename_conversation', { id, title }),
  deleteConversation: (id: string) => invoke<void>('delete_conversation', { id }),
  setConversationPinned: (id: string, pinned: boolean) =>
    invoke<void>('set_conversation_pinned', { id, pinned }),
  reorderConversations: (ids: string[]) => invoke<void>('reorder_conversations', { ids }),
  /** Compartilha uma sessão do Chat com o layout Code (ou remove o vínculo). */
  setConversationCodeLinked: (id: string, linked: boolean) =>
    invoke<Conversation>('set_conversation_code_linked', { id, linked }),
  /**
   * Sessões do Code: persiste o par provedor/modelo da sessão (o modelo pode ser
   * trocado no meio da conversa nesse layout). O Chat mantém o modelo travado
   * após a primeira mensagem; o backend recusa sessão nativa do Chat e turno em
   * andamento.
   */
  setConversationModel: (conversationId: string, providerId: string, modelId: string) =>
    invoke<Conversation>('set_conversation_model', { conversationId, providerId, modelId }),
  searchConversations: (query: string) =>
    invoke<Conversation[]>('search_conversations', { query }),
  truncateConversation: (conversationId: string, fromMessageId: string) =>
    invoke<void>('truncate_conversation', { conversationId, fromMessageId }),
  exportConversation: (id: string, format: 'markdown' | 'json' = 'markdown') =>
    invoke<string | null>('export_conversation', { id, format }),

  /* -------- attachments -------- */
  importAttachments: (paths: string[]) =>
    invoke<AttachmentInfo[]>('import_attachments', { paths }),
  importClipboardAttachments: () =>
    invoke<AttachmentInfo[]>('import_clipboard_attachments'),
  getAttachmentContent: (id: string) =>
    invoke<AttachmentContent | null>('get_attachment_content', { id }),
  getAttachmentPreview: (id: string) =>
    invoke<ArtifactPreview | null>('get_attachment_preview', { id }),
  getAttachmentThumbnail: (id: string) =>
    invoke<ArtifactThumbnail | null>('get_attachment_thumbnail', { id }),
  deleteAttachment: (id: string) => invoke<void>('delete_attachment', { id }),

  /* -------- artifacts -------- */
  listArtifacts: (conversationId: string) =>
    invoke<Artifact[]>('list_artifacts', { conversationId }),
  /** Biblioteca do usuário: todos os artefatos (todas as conversas + enviados). */
  listLibraryArtifacts: () => invoke<LibraryArtifact[]>('list_library_artifacts'),
  /** Importa arquivos do disco para a biblioteca (sem conversa associada). */
  importLibraryFiles: (paths: string[]) =>
    invoke<Artifact[]>('import_library_files', { paths }),
  /** Renomeia o arquivo no disco + metadados; devolve o artefato atualizado. */
  renameArtifact: (id: string, name: string) =>
    invoke<Artifact>('rename_artifact', { id, name }),
  setArtifactFavorite: (id: string, favorite: boolean) =>
    invoke<Artifact>('set_artifact_favorite', { id, favorite }),
  /** Miniatura PNG (≤512 px) para os cards de imagem; `null` se não houver. */
  getArtifactThumbnail: (id: string) =>
    invoke<ArtifactThumbnail | null>('get_artifact_thumbnail', { id }),
  getArtifactContent: (id: string) =>
    invoke<ArtifactContent | null>('get_artifact_content', { id }),
  getArtifactPreview: (id: string) =>
    invoke<ArtifactPreview | null>('get_artifact_preview', { id }),
  saveArtifact: (id: string, suggestedName?: string) =>
    invoke<string | null>('save_artifact', { id, suggestedName: suggestedName ?? null }),
  openArtifact: (id: string) => invoke<void>('open_artifact', { id }),
  deleteArtifact: (id: string) => invoke<void>('delete_artifact', { id }),

  /* -------- turn streaming -------- */
  cancelTurn: (turnId: string) => invoke<boolean>('cancel_turn', { turnId }),
  cancelAllTurns: () => invoke<number>('cancel_all_turns'),
  cancelConversation: (conversationId: string) =>
    invoke<number>('cancel_conversation', { conversationId }),
  listActiveTurns: () => invoke<ActiveTurnInfo[]>('list_active_turns'),
  listTurnEvents: (turnId: string, afterSeq?: number) =>
    invoke<TurnEventRecord[]>('list_turn_events', {
      turnId,
      afterSeq: afterSeq ?? null,
    }),
  listComputerActions: (conversationId?: string | null, limit?: number) =>
    invoke<ComputerActionRecord[]>('list_computer_actions', {
      conversationId: conversationId ?? null,
      limit: limit ?? null,
    }),
  listComputerSessions: (conversationId: string) =>
    invoke<ComputerSession[]>('list_computer_sessions', { conversationId }),
  listActiveComputerSessions: () =>
    invoke<ComputerSession[]>('list_active_computer_sessions'),
  stopComputerSession: (conversationId: string) =>
    invoke<void>('stop_computer_session', { conversationId }),
  stopAllComputerSessions: () => invoke<number>('stop_all_computer_sessions'),
  computerScreenshotPreview: (path: string) =>
    invoke<string>('computer_screenshot_preview', { path }),
  toolImagePreview: (path: string) =>
    invoke<string>('tool_image_preview', { path }),
  computerPreview: (conversationId: string) =>
    invoke<ComputerPreview>('computer_preview', { conversationId }),
  computerOpenStream: (conversationId: string, interactive: boolean) =>
    invoke<string>('computer_open_stream', { conversationId, interactive }),
  computerControlStatus: (conversationId: string) =>
    invoke<{ paused: boolean; takenOver: boolean; target: string; generation: string | null }>('computer_control_status', { conversationId }),
  computerStartLocalStream: (conversationId: string, streamId: string, onFrame: (frame: { dataUrl: string; width: number; height: number; capturedAt: number }) => void) => {
    const channel = new Channel<{ dataUrl: string; width: number; height: number; capturedAt: number }>();
    channel.onmessage = onFrame;
    return invoke<void>('computer_start_local_stream', { conversationId, streamId, onFrame: channel });
  },
  computerStopLocalStream: (streamId: string) => invoke<void>('computer_stop_local_stream', { streamId }),
  setComputerPaused: (conversationId: string, paused: boolean) =>
    invoke<void>('set_computer_paused', { conversationId, paused }),
  computerTakeControl: (conversationId: string) =>
    invoke<ComputerControlTarget>('computer_take_control', { conversationId }),
  releaseComputerControl: (conversationId: string, expectedTarget: 'desktop' | 'browser', generation?: string | null) =>
    invoke<void>('release_computer_control', { conversationId, expectedTarget, generation: generation ?? null }),
  browserSessionStatus: (conversationId: string) =>
    invoke<BrowserStatus>('browser_session_status', { conversationId }),
  browserSessionOpen: (conversationId: string, url?: string | null) =>
    invoke<BrowserStatus>('browser_session_open', { conversationId, url: url ?? null }),
  browserSessionClose: (conversationId: string) =>
    invoke<boolean>('browser_session_close', { conversationId }),
  browserTabs: (conversationId: string) =>
    invoke<BrowserTab[]>('browser_tabs', { conversationId }),
  browserNewTab: (conversationId: string, generation: string, url?: string | null) =>
    invoke<BrowserTab>('browser_new_tab', { conversationId, generation, url: url ?? null }),
  browserCloseTab: (conversationId: string, tabId: string, generation: string) =>
    invoke<void>('browser_close_tab', { conversationId, tabId, generation }),
  browserActivateTab: (conversationId: string, tabId: string, generation: string) =>
    invoke<void>('browser_activate_tab', { conversationId, tabId, generation }),
  browserNavigate: (conversationId: string, url: string, generation: string, tabId?: string | null) =>
    invoke<string>('browser_navigate', { conversationId, tabId: tabId ?? null, url, generation }),
  browserHistory: (
    conversationId: string,
    action: 'back' | 'forward' | 'reload',
    generation: string,
    tabId?: string | null,
  ) => invoke<void>('browser_history', { conversationId, tabId: tabId ?? null, action, generation }),
  browserFrame: (conversationId: string, tabId?: string | null) =>
    invoke<BrowserFrame>('browser_frame', { conversationId, tabId: tabId ?? null }),
  browserStartStream: (conversationId: string, tabId: string | null, streamId: string, onFrame: (frame: BrowserFrame) => void) => {
    const channel = new Channel<BrowserFrame>();
    channel.onmessage = onFrame;
    return invoke<void>('browser_start_stream', { conversationId, tabId, streamId, onFrame: channel });
  },
  browserStopStream: (streamId: string) => invoke<void>('browser_stop_stream', { streamId }),
  browserHumanInput: (conversationId: string, tabId: string | null, kind: 'mouse' | 'key', params: Record<string, string | number | boolean>, generation: string) =>
    invoke<void>('browser_human_input', { conversationId, tabId, kind, params, generation }),
  browserClickAt: (
    conversationId: string,
    x: number,
    y: number,
    generation: string,
    tabId?: string | null,
  ) =>
    invoke<void>('browser_click_at', {
      conversationId,
      tabId: tabId ?? null,
      x,
      y,
      generation,
    }),
  browserPressKey: (conversationId: string, key: string, generation: string, tabId?: string | null) =>
    invoke<void>('browser_press_key', {
      conversationId,
      tabId: tabId ?? null,
      key,
      generation,
    }),
  browserInsertText: (conversationId: string, text: string, generation: string, tabId?: string | null) =>
    invoke<void>('browser_insert_text', {
      conversationId,
      tabId: tabId ?? null,
      text,
      generation,
    }),
  browserSnapshot: (conversationId: string, tabId?: string | null) =>
    invoke<BrowserSnapshot>('browser_snapshot', { conversationId, tabId: tabId ?? null }),
  browserTakeControl: (conversationId: string) =>
    invoke<ComputerControlTarget>('browser_take_control', { conversationId }),
  platformDiagnostics: () =>
    invoke<{
      version: string;
      activeTurns: Array<{ turnId: string; conversationId: string; startedAt: number }>;
      activeComputerSessions: number;
      openTasks: number;
      tasksByStatus: Record<string, number>;
      generatedAt: number;
    }>('platform_diagnostics'),

  /* -------- workspace (harness de código) -------- */
  /** Abre o seletor nativo de pasta e devolve o caminho escolhido (null = cancelado). */
  pickWorkspaceFolder: () => invoke<string | null>('pick_workspace_folder'),
  /** Registra/abre uma pasta como workspace (cria a linha no DB). */
  addWorkspace: (path: string, trusted = false) =>
    invoke<Workspace>('add_workspace', { path, trusted }),
  listWorkspaces: () => invoke<Workspace[]>('list_workspaces'),
  reorderWorkspaces: (ids: string[]) => invoke<void>('reorder_workspaces', { ids }),
  getWorkspace: (id: string) => invoke<WorkspaceContext | null>('get_workspace_context', { id }),
  renameWorkspace: (id: string, name: string) =>
    invoke<Workspace>('rename_workspace', { id, name }),
  removeWorkspace: (id: string) => invoke<void>('remove_workspace', { id }),
  setWorkspaceTrusted: (id: string, trusted: boolean) =>
    invoke<Workspace>('set_workspace_trusted', { id, trusted }),
  setConversationWorkspace: (conversationId: string, workspaceId: string | null) =>
    invoke<Conversation>('set_conversation_workspace', { conversationId, workspaceId }),
  openWorkspaceInExplorer: (id: string) => invoke<void>('open_workspace_in_explorer', { id }),
  listWorkspaceFiles: (workspaceId: string, path = '.', depth = 2) =>
    invoke<WorkspaceFileEntry[]>('list_workspace_files', { workspaceId, path, depth }),
  refreshWorkspaceTree: (workspaceId: string, extraDirs: string[] = []) =>
    invoke<WorkspaceTreeSnapshot>('refresh_workspace_tree', { workspaceId, extraDirs }),
  watchWorkspace: (workspaceId: string) =>
    invoke<void>('watch_workspace', { workspaceId }),
  unwatchWorkspace: (workspaceId: string) =>
    invoke<void>('unwatch_workspace', { workspaceId }),
  searchWorkspaceFiles: (workspaceId: string, query: string, limit = 50) =>
    invoke<string[]>('search_workspace_files', { workspaceId, query, limit }),
  readWorkspaceFile: (workspaceId: string, path: string) =>
    invoke<WorkspaceFileContent>('read_workspace_file', { workspaceId, path }),

  /* -------- sessão de código -------- */
  getCodeSessionState: (conversationId: string) =>
    invoke<CodeSessionState>('get_code_session_state', { conversationId }),
  setPermissionMode: (conversationId: string, mode: PermissionMode) =>
    invoke<CodeSessionState>('set_permission_mode', { conversationId, mode }),
  setPlanMode: (conversationId: string, planMode: boolean) =>
    invoke<CodeSessionState>('set_plan_mode', { conversationId, planMode }),
  respondApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    options?: {
      scope?: ApprovalScope | null;
      feedback?: string | null;
      /** Escolha do gate do plano (`approve_run` | `approve_review` | `approve_goal`). */
      choice?: PlanApprovalChoice | null;
      /** Markdown revisado pelo usuário antes de aprovar o plano. */
      planMarkdown?: string | null;
    },
  ) =>
    invoke<boolean>('respond_approval', {
      approvalId,
      decision,
      scope: options?.scope ?? null,
      feedback: options?.feedback ?? null,
      choice: options?.choice ?? null,
      planMarkdown: options?.planMarkdown ?? null,
    }),
  listApprovalRules: (conversationId: string) =>
    invoke<ApprovalRule[]>('list_approval_rules', { conversationId }),
  saveApprovalRule: (input: ApprovalRuleInput) =>
    invoke<ApprovalRule>('save_approval_rule', { input }),
  deleteApprovalRule: (id: string) => invoke<void>('delete_approval_rule', { id }),
  getWorkspaceChanges: (conversationId: string) =>
    invoke<FileChange[]>('get_workspace_changes', { conversationId }),
  getFileDiff: (workspaceId: string, path: string, staged = false) =>
    invoke<string>('get_file_diff', { workspaceId, path, staged }),
  getFileDiffHead: (workspaceId: string, path: string) =>
    invoke<string>('get_file_diff_head', { workspaceId, path }),
  getFileDiffAt: (workspaceId: string, path: string, base: string) =>
    invoke<string>('get_file_diff_at', { workspaceId, path, base }),
  revertFile: (conversationId: string, path: string) =>
    invoke<boolean>('revert_file', { conversationId, path }),
  revertTurn: (conversationId: string, turnId: string) =>
    invoke<boolean>('revert_turn', { conversationId, turnId }),
  compactSession: (conversationId: string) => invoke<boolean>('compact_session', { conversationId }),

  /* -------- objetivo (Goal) da sessão de código -------- */
  createGoal: (conversationId: string, input: CreateGoalInput) =>
    invoke<CodeSessionState>('create_goal', { conversationId, input }),
  updateGoal: (
    conversationId: string,
    action: GoalAction,
    input?: UpdateGoalInput | null,
    expectedRevision?: number | null,
  ) =>
    invoke<CodeSessionState>('update_goal', {
      conversationId,
      action,
      input: input ?? null,
      expectedRevision: expectedRevision ?? null,
    }),
  listGoalRounds: (conversationId: string, limit = 100) =>
    invoke<GoalRound[]>('list_goal_rounds', { conversationId, limit }),
  goalCanContinue: (conversationId: string, auto = true) =>
    invoke<GoalContinuation>('goal_can_continue', { conversationId, auto }),

  respondQuestion: (requestId: string, answers: AskUserAnswer[], skipped = false) =>
    invoke<boolean>('respond_question', { requestId, answers, skipped }),

  /* -------- terminal PTY (layout Code) -------- */
  openTerminal: (
    conversationId: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ) => {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke<TerminalInfo>('open_terminal', {
      conversationId,
      cols,
      rows,
      onEvent: channel,
    });
  },
  writeTerminal: (id: string, data: string) =>
    invoke<void>('write_terminal', { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    invoke<void>('resize_terminal', { id, cols, rows }),
  closeTerminal: (id: string) => invoke<boolean>('close_terminal', { id }),
  killTerminal: (id: string) => invoke<void>('kill_terminal', { id }),
  listTerminals: (conversationId: string) =>
    invoke<TerminalInfo[]>('list_terminals', { conversationId }),

  /* -------- git (painel) -------- */
  gitStatus: (workspaceId: string) => invoke<WorkspaceGitStatus>('git_status', { workspaceId }),
  gitFetch: (workspaceId: string) => invoke<WorkspaceGitStatus>('git_fetch', { workspaceId }),
  gitPull: (workspaceId: string) => invoke<WorkspaceGitStatus>('git_pull', { workspaceId }),
  gitPush: (workspaceId: string) => invoke<WorkspaceGitStatus>('git_push', { workspaceId }),
  gitDiff: (workspaceId: string, paths: string[], staged = false) =>
    invoke<string>('git_diff', { workspaceId, paths, staged }),
  gitStage: (workspaceId: string, paths: string[]) =>
    invoke<WorkspaceGitStatus>('git_stage', { workspaceId, paths }),
  gitStageAll: (workspaceId: string) =>
    invoke<WorkspaceGitStatus>('git_stage_all', { workspaceId }),
  gitUnstage: (workspaceId: string, paths: string[]) =>
    invoke<WorkspaceGitStatus>('git_unstage', { workspaceId, paths }),
  gitUnstageAll: (workspaceId: string) =>
    invoke<WorkspaceGitStatus>('git_unstage_all', { workspaceId }),
  gitDiscard: (workspaceId: string, paths: string[]) =>
    invoke<WorkspaceGitStatus>('git_discard', { workspaceId, paths }),
  gitCommit: (workspaceId: string, message: string, target: CommitTarget, paths?: string[]) =>
    invoke<WorkspaceGitStatus>('git_commit', {
      workspaceId,
      message,
      target,
      paths: paths ?? null,
    }),
  gitBranches: (workspaceId: string) =>
    invoke<WorkspaceGitBranches>('git_branches', { workspaceId }),
  gitCompare: (workspaceId: string, base: string) =>
    invoke<WorkspaceGitCompare>('git_compare', { workspaceId, base }),
  gitSwitchBranch: (workspaceId: string, branch: string) =>
    invoke<WorkspaceGitStatus>('git_switch_branch', { workspaceId, branch }),
  gitCreateBranch: (workspaceId: string, name: string, startPoint?: string | null) =>
    invoke<WorkspaceGitStatus>('git_create_branch', {
      workspaceId,
      name,
      startPoint: startPoint ?? null,
    }),
  gitLog: (workspaceId: string, limit = 20) =>
    invoke<WorkspaceGitCommit[]>('git_log', { workspaceId, limit }),
  gitCommitDetail: (workspaceId: string, revision: string) =>
    invoke<WorkspaceCommitDetail>('git_commit_detail', { workspaceId, revision }),
  suggestCommitMessage: (workspaceId: string, target: CommitTarget, paths?: string[]) =>
    invoke<string>('suggest_commit_message', {
      workspaceId,
      target,
      paths: paths ?? null,
    }),

  /* -------- GitHub (pull requests e issues) -------- */
  githubAccount: () => invoke<GitHubAccount>('github_account'),
  githubSetToken: (token: string, workspaceId?: string | null) =>
    invoke<GitHubAccount>('github_set_token', { token, workspaceId: workspaceId ?? null }),
  githubClearToken: () => invoke<GitHubAccount>('github_clear_token'),
  githubConnection: (workspaceId: string) =>
    invoke<GitHubConnectionView>('github_connection', { workspaceId }),
  githubListPullRequests: (workspaceId: string, filter?: GitHubPullRequestFilter) =>
    invoke<GitHubPullRequestList>('github_list_pull_requests', {
      workspaceId,
      filter: filter ?? null,
    }),
  githubPullRequest: (workspaceId: string, number: number) =>
    invoke<GitHubPullRequestDetail>('github_pull_request', { workspaceId, number }),
  githubPullRequestFiles: (workspaceId: string, number: number) =>
    invoke<GitHubPullRequestFiles>('github_pull_request_files', { workspaceId, number }),
  githubPullRequestCommits: (workspaceId: string, number: number) =>
    invoke<GitHubPullRequestCommit[]>('github_pull_request_commits', { workspaceId, number }),
  githubListIssues: (workspaceId: string, filter?: GitHubIssueFilter) =>
    invoke<GitHubIssueList>('github_list_issues', { workspaceId, filter: filter ?? null }),
  githubIssue: (workspaceId: string, number: number) =>
    invoke<GitHubIssueDetail>('github_issue', { workspaceId, number }),
  githubLabels: (workspaceId: string) =>
    invoke<GitHubLabel[]>('github_labels', { workspaceId }),
  githubAssignableUsers: (workspaceId: string) =>
    invoke<GitHubUser[]>('github_assignable_users', { workspaceId }),
  githubMilestones: (workspaceId: string) =>
    invoke<GitHubMilestone[]>('github_milestones', { workspaceId }),
  githubBranches: (workspaceId: string) => invoke<string[]>('github_branches', { workspaceId }),
  githubCreatePullRequest: (
    workspaceId: string,
    payload: { title: string; head: string; base: string; body?: string | null; draft?: boolean | null },
  ) =>
    invoke<GitHubPullRequestSummary>('github_create_pull_request', {
      workspaceId,
      title: payload.title,
      head: payload.head,
      base: payload.base,
      body: payload.body ?? null,
      draft: payload.draft ?? null,
    }),
  githubUpdatePullRequest: (
    workspaceId: string,
    number: number,
    patch: {
      title?: string | null;
      body?: string | null;
      stateValue?: 'open' | 'closed' | null;
      base?: string | null;
    },
  ) =>
    invoke<GitHubPullRequestSummary>('github_update_pull_request', {
      workspaceId,
      number,
      title: patch.title ?? null,
      body: patch.body ?? null,
      stateValue: patch.stateValue ?? null,
      base: patch.base ?? null,
    }),
  githubMergePullRequest: (
    workspaceId: string,
    number: number,
    options: {
      method?: GitHubMergeMethod;
      commitTitle?: string | null;
      commitMessage?: string | null;
      /** Expected head SHA; the merge fails if the branch moved. */
      sha?: string | null;
      deleteBranch?: boolean;
    } = {},
  ) =>
    invoke<GitHubMergeResult>('github_merge_pull_request', {
      workspaceId,
      number,
      method: options.method ?? null,
      commitTitle: options.commitTitle ?? null,
      commitMessage: options.commitMessage ?? null,
      sha: options.sha ?? null,
      deleteBranch: options.deleteBranch ?? null,
    }),
  githubRequestReviewers: (workspaceId: string, number: number, reviewers: string[]) =>
    invoke<void>('github_request_reviewers', { workspaceId, number, reviewers }),
  githubMarkPullRequestReady: (workspaceId: string, nodeId: string) =>
    invoke<void>('github_mark_pull_request_ready', { workspaceId, nodeId }),
  githubSubmitReview: (
    workspaceId: string,
    number: number,
    event: GitHubReviewEvent,
    body?: string | null,
  ) =>
    invoke<GitHubReview>('github_submit_review', {
      workspaceId,
      number,
      event,
      body: body ?? null,
    }),
  githubCheckoutPullRequest: (workspaceId: string, number: number) =>
    invoke<string>('github_checkout_pull_request', { workspaceId, number }),
  githubCreateIssue: (
    workspaceId: string,
    payload: {
      title: string;
      body?: string | null;
      labels?: string[];
      assignees?: string[];
    },
  ) =>
    invoke<GitHubIssueSummary>('github_create_issue', {
      workspaceId,
      title: payload.title,
      body: payload.body ?? null,
      labels: payload.labels ?? null,
      assignees: payload.assignees ?? null,
    }),
  githubUpdateIssue: (
    workspaceId: string,
    number: number,
    patch: {
      title?: string | null;
      body?: string | null;
      stateValue?: 'open' | 'closed' | null;
      stateReason?: 'completed' | 'not_planned' | null;
      labels?: string[];
      assignees?: string[];
      milestone?: number | null;
      clearMilestone?: boolean;
    },
  ) =>
    invoke<GitHubIssueSummary>('github_update_issue', {
      workspaceId,
      number,
      title: patch.title ?? null,
      body: patch.body ?? null,
      stateValue: patch.stateValue ?? null,
      stateReason: patch.stateReason ?? null,
      labels: patch.labels ?? null,
      assignees: patch.assignees ?? null,
      milestone: patch.milestone ?? null,
      clearMilestone: patch.clearMilestone ?? false,
    }),
  githubAddComment: (workspaceId: string, number: number, body: string) =>
    invoke<GitHubComment>('github_add_comment', { workspaceId, number, body }),
  githubUpdateComment: (workspaceId: string, commentId: number, body: string) =>
    invoke<GitHubComment>('github_update_comment', { workspaceId, commentId, body }),
  githubDeleteComment: (workspaceId: string, commentId: number) =>
    invoke<void>('github_delete_comment', { workspaceId, commentId }),
  githubSetLabels: (workspaceId: string, number: number, labels: string[]) =>
    invoke<GitHubLabel[]>('github_set_labels', { workspaceId, number, labels }),
  githubSetAssignees: (workspaceId: string, number: number, assignees: string[]) =>
    invoke<GitHubIssueSummary>('github_set_assignees', { workspaceId, number, assignees }),

  /* -------- jobs (processos em background) -------- */
  listJobs: (conversationId: string) => invoke<JobView[]>('list_jobs', { conversationId }),
  getJobOutput: (jobId: string, cursor = 0) =>
    invoke<{ output: string; nextCursor: number; job: JobView }>('get_job_output', {
      jobId,
      cursor,
    }),
  killJob: (jobId: string) => invoke<JobView>('kill_job', { jobId }),

  /**
   * Starts a turn. The promise resolves with the persisted user/assistant
   * messages when the turn ends; live events arrive on `zylara:turn-event`.
   */
  runTurn: (payload: TurnPayload) => invoke<TurnResult>('run_turn', { payload }),
};

export type Api = typeof api;
