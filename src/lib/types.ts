/**
 * IPC contract with the Rust backend.
 *
 * Every interface here mirrors a struct in `src-tauri/src/domain.rs` (and the
 * catalog in `data/catalog.json`). Keep both sides in sync.
 */
import type { AppLocale } from './i18n/languages';

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export type WireProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google';
export type ModelStatus = 'stable' | 'beta' | 'free' | 'unavailable';

export interface ReasoningOptionToggle {
  type: 'toggle';
}
export interface ReasoningOptionEffort {
  type: 'effort';
  values: string[];
}
export interface ReasoningOptionBudget {
  type: 'budget_tokens';
  min?: number;
  max?: number;
}
export type ReasoningOption =
  | ReasoningOptionToggle
  | ReasoningOptionEffort
  | ReasoningOptionBudget;

export interface Modalities {
  input: string[];
  output: string[];
}

export interface CostInfo {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: unknown[];
}

export type CacheMode = 'auto' | 'explicit' | 'none';

/** Prompt-cache capabilities of a provider/route or a model override. */
export interface CacheInfo {
  mode: CacheMode;
  /** null/ausente = desconhecido (request fora da meta de hit%). */
  minTokens?: number | null;
  blockTokens?: number | null;
  ttlOptions?: string[];
  supportsKey?: boolean;
  supportsRetention?: boolean;
  supportsExplicitBreakpoints?: boolean;
  reportsRead?: boolean;
  reportsWrite?: boolean;
  source?: 'family-default' | 'probe' | 'docs' | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  protocols: WireProtocol[];
  reasoning: boolean;
  reasoningOptions: ReasoningOption[];
  attachment: boolean;
  modalities: Modalities;
  contextWindow: number;
  maxOutput: number;
  cost?: CostInfo | null;
  releaseDate?: string | null;
  knowledge?: string | null;
  openWeights: boolean;
  description?: string | null;
  tags: string[];
  status: ModelStatus;
  /** Capabilities inferred because the model came from the account list. */
  estimated?: boolean;
  /** Override de cache por modelo (sobre o default do provedor). */
  cache?: CacheInfo | null;
}

/** How a provider is authenticated. Defaults to `api-key` for older catalogs. */
export type ProviderAuth = 'api-key' | 'oauth';

/**
 * Wire-request constraints. `chatgpt-plan` applies the OpenAI plan-usage
 * restrictions (store:false, no max_output_tokens/temperature, instructions
 * only); `standard` sends the full neutral body.
 */
export type RequestProfile = 'standard' | 'chatgpt-plan';

export interface RequestProfiles {
  oauth?: RequestProfile;
  apiKey?: RequestProfile;
}

export interface OAuthProviderInfo {
  issuer: string;
  discoveryUrl?: string;
  registrationClientId: string;
  agentNameHint: string;
  resource: string;
  scopes: string[];
  planUsageScope: string;
  callbackPath: string;
  loopbackHost: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  shortName: string;
  description: string;
  baseUrl: string;
  consoleUrl: string;
  endpoints: Record<string, string>;
  /**
   * Static headers sent with every request of the provider (no credentials).
   * Today: `anthropic-version` for the direct Anthropic API.
   */
  headers?: Record<string, string>;
  authEnv: string;
  /** Header carrying the API key (`authorization` by default). */
  authHeader?: string;
  /** Prefix before the key (`Bearer ` by default; empty for x-goog-api-key). */
  authPrefix?: string;
  defaultModelId: string;
  auth?: ProviderAuth;
  requestProfiles?: RequestProfiles;
  oauth?: OAuthProviderInfo | null;
  models: ModelInfo[];
  notes: string[];
  /** Capacidades de cache do provedor/rota (default por protocolo/família). */
  cache?: CacheInfo | null;
}

export interface CatalogFile {
  version: number;
  generatedAt: string;
  sources: Record<string, unknown>;
  providers: ProviderInfo[];
}

/* ------------------------------------------------------------------ */
/* Conversations & messages                                            */
/* ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled' | 'incomplete';
export type ToolCallStatus = 'running' | 'done' | 'error';

export interface ToolImageRef {
  mimeType: string;
  path: string;
  width?: number;
  height?: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result?: string | null;
  status: ToolCallStatus;
  summary?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  /**
   * Apresentação estruturada do resultado (diff, lista de tarefas, plano, job,
   * aprovação) usada pelos cards do harness de código e persistida no DB.
   * JSON opaco versionado por `kind` - ver docs/goals/code-harness/TOOLS.md §1.1.
   */
  presentation?: ToolPresentation | null;
  /** Screenshots devolvidos pela tool (caminho no app-data, sem base64 no DB). */
  images?: ToolImageRef[];
}

/* ------------------------------------------------------------------ */
/* Harness de código (docs/goals/code-harness/)                        */
/* ------------------------------------------------------------------ */

export type TurnProfile = 'chat' | 'code';

export type PermissionMode = 'read_only' | 'edit' | 'review' | 'autonomous';

export type RiskClass =
  | 'read'
  | 'write'
  | 'shell'
  | 'outside'
  | 'secret'
  | 'destroy'
  | 'network'
  | 'computer'
  | 'ask';

export type ApprovalScope = 'session' | 'workspace' | 'global';

export type ApprovalDecision = 'approved' | 'denied' | 'cancelled' | 'expired';

export interface ApprovalOption {
  id: string;
  label: string;
  scope?: ApprovalScope | null;
}

export type ApprovalDetail =
  | { kind: 'command'; command: string; workdir: string }
  | { kind: 'paths'; paths: string[]; change: string }
  | { kind: 'secret'; path: string }
  | { kind: 'outside'; path: string }
  | {
      kind: 'computer_action';
      action: string;
      target: string;
      screenshotPath?: string | null;
      textLength?: number | null;
      sensitive?: boolean;
    }
  | { kind: 'other'; text: string };

/** Pedido de aprovação mostrado no card da timeline (`approval_requested`). */
export interface ApprovalRequest {
  id: string;
  /** Sessão que pediu a aprovação. */
  conversationId?: string;
  toolCallId: string;
  tool: string;
  title: string;
  detail: ApprovalDetail;
  risk: RiskClass;
  preview?: string | null;
  options: ApprovalOption[];
  createdAt: number;
}

/** Regra "sempre permitir/negar" persistida (`approval_rules`). */
export interface ApprovalRule {
  id: string;
  scope: ApprovalScope;
  scopeId?: string | null;
  tool: string;
  matcher: 'exact' | 'prefix' | 'glob';
  pattern: string;
  decision: ApprovalDecision;
  createdAt: number;
}

/* ---- perguntas estruturadas ao usuário (`ask_user`) ---- */

export interface AskOption {
  label: string;
  description?: string | null;
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string | null;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskUserRequest {
  id: string;
  conversationId: string;
  toolCallId: string;
  questions: AskQuestion[];
  createdAt: number;
}

export interface AskUserAnswer {
  questionId: string;
  selected: string[];
  custom?: string | null;
}

export interface AskUserResponse {
  requestId: string;
  answers: AskUserAnswer[];
  skipped: boolean;
}

/** Estado git do workspace (branch/upstream/contadores). */
export interface GitInfo {
  root: string;
  branch: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  staged?: number;
  unstaged?: number;
  untracked?: number;
}

/** Workspace = pasta do usuário (git opcional) que agrupa sessões de código. */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number | null;
  pinned?: boolean;
  /** Posição manual dentro da seção da sidebar (0 = ordem por recência). */
  sortOrder?: number;
  trusted?: boolean;
  git?: GitInfo | null;
}

export interface ProjectCheckInfo {
  id: string;
  label: string;
  command: string;
}

export interface ProjectInfo {
  kind: string;
  name?: string | null;
  checks: ProjectCheckInfo[];
  /** Ecosystems with detected checks, including nested manifests (e.g. rust in src-tauri). */
  checkedEcosystems?: string[];
}

export interface WorkspaceContext {
  workspace: Workspace;
  project?: ProjectInfo | null;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export type PlanState = 'inactive' | 'planning' | 'reviewing' | 'approved';

/** Ação escolhida no gate de aprovação do plano (`respond_approval.choice`). */
export type PlanApprovalChoice = 'approve_run' | 'approve_review' | 'approve_goal';

export interface PlanView {
  state: PlanState;
  markdown?: string | null;
  /** Feedback do usuário após "Continuar planejando" (persistido no backend). */
  feedback?: string | null;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Objetivos (Goal) do layout Code (docs/goals/code-goals/PLAN.md)      */
/* ------------------------------------------------------------------ */

/** Origem de um turno/mensagem de usuário (`user` = default retrocompatível). */
export type TurnKind = 'user' | 'goal_round';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'blocked';

export type GoalPauseReason = 'user' | 'error' | 'max_rounds' | 'stalled' | 'interrupted';

export type GoalOrigin = 'user' | 'agent';

/** Estado completo do objetivo (espelho camelCase de `GoalView` no Rust). */
export interface GoalView {
  title: string;
  objective: string;
  status: GoalStatus;
  /** Continuar sozinho após cada turno bem-sucedido. */
  autoContinue: boolean;
  rounds: number;
  maxRounds: number;
  revision: number;
  origin: GoalOrigin;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
  lastRoundAt?: number | null;
  lastNote?: string | null;
  pauseReason?: GoalPauseReason | null;
  pauseDetail?: string | null;
  blockerReason?: string | null;
  blockerStreak?: number;
  stalledRounds?: number;
  tokens?: number;
  cost?: number;
}

/** Registro de uma rodada do objetivo. */
export interface GoalRound {
  index: number;
  turnId: string;
  startedAt: number;
  endedAt?: number | null;
  /** `done` | `cancelled` | `error` | `interrupted` (ausente = em andamento). */
  outcome?: string | null;
  durationMs?: number | null;
  tokens?: number | null;
  cost?: number | null;
  filesChanged?: number;
  note?: string | null;
}

/** Resposta do preflight `goal_can_continue`. */
export interface GoalContinuation {
  ok: boolean;
  reason?: string | null;
  goal?: GoalView | null;
}

export interface CreateGoalInput {
  objective: string;
  title?: string | null;
  maxRounds?: number | null;
  autoContinue?: boolean | null;
}

export interface UpdateGoalInput {
  title?: string | null;
  objective?: string | null;
  maxRounds?: number | null;
  summary?: string | null;
  reason?: string | null;
}

/** Ações da UI sobre o objetivo (`update_goal`). */
export type GoalAction =
  | 'edit'
  | 'arm'
  | 'disarm'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'reopen'
  | 'block'
  | 'delete';

export type FileChangeKind = 'created' | 'modified' | 'deleted' | 'renamed';

/** Alteração de um arquivo (card de tool / evento `file_changed`). */
export interface FileChange {
  path: string;
  kind: FileChangeKind;
  added?: number;
  removed?: number;
  diff?: string | null;
}

export interface FileChangeSummary {
  path: string;
  kind: FileChangeKind;
  added?: number;
  removed?: number;
  /** `session` (journal do agente), `git` (working tree) ou `both`. */
  origin?: 'session' | 'git' | 'both' | null;
  staged?: boolean;
}

export interface ChangesSummary {
  turnId?: string | null;
  files: FileChangeSummary[];
  added?: number;
  removed?: number;
}

/** Quebra estimada do contexto (tokens) para o medidor/popover. */
export interface ContextBreakdown {
  systemPrompt: number;
  toolDefinitions: number;
  messages: number;
}

/** Medidor de contexto do turno/sessão. */
export interface ContextStats {
  used: number;
  window: number;
  outputCap: number;
  percent: number;
  compacted?: number;
  messages?: number;
  /** Ausente em payloads antigos persistidos antes do breakdown. */
  breakdown?: ContextBreakdown;
}

export type JobStatus = 'running' | 'done' | 'failed' | 'killed';

/** Terminal PTY aberto na sessão de código (layout Code). */
export interface TerminalInfo {
  id: string;
  conversationId: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
}

export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; code?: number | null };

export interface JobView {
  id: string;
  command: string;
  status: JobStatus;
  startedAt: number;
  durationMs?: number;
  exitCode?: number | null;
  outputPreview?: string | null;
}

/** Apresentação de tool persistida no `ToolCallRecord.presentation`. */
export type ToolPresentation =
  | { kind: 'file_change'; path: string; change: FileChangeKind; added: number; removed: number; diff?: string | null }
  | { kind: 'changes'; turnId?: string | null; files: FileChangeSummary[]; added: number; removed: number }
  | { kind: 'todos'; items: TodoItem[] }
  /**
   * Plano flat (`TOOLS.md` §1.1): o backend emite o `PlanView` achatado com
   * `kind`. O renderer normaliza payloads antigos (sem `markdown`) sem quebrar.
   */
  | { kind: 'plan'; state: PlanState; markdown?: string | null; feedback?: string | null; updatedAt?: number }
  /**
   * Objetivo flat (mesmo padrão do plano): o backend achata o `GoalView` com
   * `kind`. Payloads antigos/malformados degradam sem derrubar o card.
   */
  | ({ kind: 'goal' } & GoalView)
  | { kind: 'job'; job: JobView }
  | { kind: 'answers'; answers: AskUserAnswer[]; skipped: boolean }
  /** Structured result counts so the renderer never parses translated prose. */
  | { kind: 'search'; total: number }
  | { kind: 'artifact_list'; returned: number; total: number }
  | {
      kind: 'subagent';
      description: string;
      subagentType: string;
      conversationId?: string | null;
      providerId?: string | null;
      modelId?: string | null;
      effort?: string | null;
      steps?: number;
      durationMs?: number;
      usage?: UsageInfo;
    }
  | { kind: 'output'; lines?: number | null; spillId?: string | null }
  | { kind: 'terminal'; sessionId: string; title: string };

/** Snapshot completo da sessão de código (`get_code_session_state`). */
export interface CodeSessionState {
  conversationId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  plan?: PlanView | null;
  /** Objetivo persistente da sessão (ausente em snapshots antigos). */
  goal?: GoalView | null;
  todos: TodoItem[];
  workspace?: Workspace | null;
  project?: ProjectInfo | null;
  context?: ContextStats | null;
  changes?: ChangesSummary | null;
  /** Alterações do turno mais recente (subconjunto de `changes`). */
  lastTurnChanges?: ChangesSummary | null;
  jobs: JobView[];
  approvals: ApprovalRequest[];
  questions?: AskUserRequest[];
}

/** Entrada da árvore de arquivos do workspace (`list_workspace_files`). */
export interface WorkspaceFileEntry {
  /** Caminho relativo ao workspace, sempre com `/`. */
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  /** Tamanho em bytes (arquivos). */
  size?: number;
  /** Estado no git: `M`/`A`/`D`/`U`/`?`/vazio. */
  gitStatus?: string | null;
  /** Filhos (quando a entrada é um diretório expandido). */
  children?: WorkspaceFileEntry[];
}

/** Conteúdo de um arquivo do workspace para prévia read-only (aba central). */
export interface WorkspaceFileContent {
  path: string;
  text: string;
  /** `true` quando o backend truncou o conteúdo textual. */
  truncated: boolean;
  /** Tamanho total em bytes. */
  size: number;
  /** Binário: nenhum texto é enviado. */
  binary?: boolean;
  /** Encoding detectado quando não UTF-8. */
  encoding?: string | null;
  /**
   * MIME inferido pela extensão para prévias binárias suportadas (imagem/PDF).
   * Ausente para arquivos textuais e binários sem prévia.
   */
  mimeType?: string | null;
  /**
   * Payload base64 (sem o prefixo `data:`) de imagens/PDF até o limite inline
   * de prévia; usado pelo visualizador da aba central.
   */
  dataBase64?: string | null;
  /** Payload binário omitido por exceder o limite de prévia inline. */
  previewOmitted?: boolean;
}

/** Entrada para criar/editar uma regra de aprovação. */
export interface ApprovalRuleInput {
  scope: ApprovalScope;
  scopeId?: string | null;
  /** Sessão/workspace de origem (para resolver o escopo no backend). */
  conversationId?: string | null;
  tool: string;
  matcher: 'exact' | 'prefix' | 'glob';
  pattern: string;
  decision: ApprovalDecision;
}

/** Arquivo no status do git (painel Alterações). */
export interface WorkspaceGitFile {
  path: string;
  status: string;
}

/** Status do git de um workspace (working tree + staged). */
export interface WorkspaceGitStatus {
  isRepo: boolean;
  root?: string | null;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  staged: WorkspaceGitFile[];
  unstaged: WorkspaceGitFile[];
  untracked: string[];
  conflicted: string[];
}

/** One branch of the repository: local (`main`) or remote-tracking (`origin/main`). */
export interface WorkspaceGitBranch {
  /** `main` for a local branch, `origin/main` for a remote-tracking one. */
  name: string;
  /** `true` for `refs/heads/*`. */
  local: boolean;
  /** Remote name (e.g. `origin`) when `local` is `false`. */
  remote?: string | null;
  /** `true` for the branch checked out in this working tree. */
  current: boolean;
  /** Configured upstream (`origin/main`). */
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  /** `true` when the configured upstream no longer exists. */
  gone?: boolean;
  /** Subject of the tip commit. */
  subject?: string;
  author?: string;
  /** Committer date of the tip commit, in seconds since the Unix epoch. */
  committedAt?: number;
}

/** Branch list of a workspace: local names plus the full entries. */
export interface WorkspaceGitBranches {
  current?: string | null;
  /** Local branch names (branch-comparison filter). */
  branches: string[];
  /** Local and remote-tracking branches with commit metadata. */
  all: WorkspaceGitBranch[];
}

/** Alvo do commit: tudo, somente o índice ou os caminhos selecionados. */
export type CommitTarget = 'all' | 'staged' | 'selection';

/** Snapshot da árvore + status git usado pelo refresh do painel Code. */
export interface WorkspaceTreeSnapshot {
  files: WorkspaceFileEntry[];
  /** Filhos frescos dos diretórios carregados sob demanda (chave = path relativo). */
  dirs: Record<string, WorkspaceFileEntry[]>;
  gitStatus: WorkspaceGitStatus;
}

/* ------------------------------------------------------------------ */
/* GitHub — pull requests e issues                                     */
/* ------------------------------------------------------------------ */

/** Conta exposta pela API: login/scopes apenas, nunca o token. */
export interface GitHubAccount {
  authenticated: boolean;
  login?: string | null;
  /** `settings`, `env`, `gh-cli` ou `none`. */
  source: string;
  scopes: string[];
}

/** Repositório resolvido a partir do remote git do workspace. */
export interface GitHubRepoInfo {
  host: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch?: string | null;
  canPush: boolean;
  /** Ações GraphQL (draft ⇄ ready) só existem no github.com. */
  graphql: boolean;
}

/** Estado da conexão do workspace com o GitHub. */
export interface GitHubConnectionView {
  account: GitHubAccount;
  repo?: GitHubRepoInfo | null;
  /** Motivo localizado quando o repositório não pode ser usado. */
  message?: string | null;
}

export interface GitHubUser {
  login: string;
  avatarUrl?: string | null;
  htmlUrl?: string | null;
}

export interface GitHubLabel {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface GitHubMilestone {
  number: number;
  title: string;
  state: string;
  openIssues: number;
  closedIssues: number;
  dueOn?: string | null;
}

export interface GitHubChecksSummary {
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'none';
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  author: GitHubUser;
  headRef: string;
  headSha: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  comments: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: GitHubLabel[];
  htmlUrl: string;
  crossRepository: boolean;
}

export interface GitHubPullRequestList {
  items: GitHubPullRequestSummary[];
  page: number;
  perPage: number;
  hasNext: boolean;
}

export interface GitHubComment {
  id: number;
  author: GitHubUser;
  body: string;
  createdAt: string;
  updatedAt?: string | null;
  htmlUrl?: string | null;
  authorAssociation?: string | null;
}

export interface GitHubReview {
  id: number;
  author: GitHubUser;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | string;
  body: string;
  submittedAt?: string | null;
}

export interface GitHubPullRequestDetail {
  summary: GitHubPullRequestSummary;
  body: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  mergedAt?: string | null;
  mergedBy?: GitHubUser | null;
  requestedReviewers: GitHubUser[];
  assignees: GitHubUser[];
  milestone?: GitHubMilestone | null;
  nodeId?: string | null;
  checks: GitHubChecksSummary;
  reviews: GitHubReview[];
  comments: GitHubComment[];
}

export interface GitHubPullRequestFile {
  path: string;
  previousPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null;
  /** Patch omitido pela API (binário/grande) ou cortado pelo orçamento. */
  truncated: boolean;
}

export interface GitHubPullRequestFiles {
  files: GitHubPullRequestFile[];
  truncated: boolean;
}

export interface GitHubPullRequestCommit {
  sha: string;
  message: string;
  author: string;
  authorLogin?: string | null;
  avatarUrl?: string | null;
  date?: string | null;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | string | null;
  author: GitHubUser;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: GitHubLabel[];
  assignees: GitHubUser[];
  milestone?: string | null;
  htmlUrl: string;
}

export interface GitHubIssueList {
  items: GitHubIssueSummary[];
  page: number;
  perPage: number;
  hasNext: boolean;
}

export interface GitHubIssueDetail {
  summary: GitHubIssueSummary;
  body: string;
  locked: boolean;
  closedAt?: string | null;
  milestone?: GitHubMilestone | null;
  comments: GitHubComment[];
}

export interface GitHubMergeResult {
  merged: boolean;
  message: string;
  sha?: string | null;
}

export type GitHubItemState = 'open' | 'closed' | 'all';
export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';
export type GitHubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface GitHubPullRequestFilter {
  state?: GitHubItemState;
  search?: string;
  label?: string;
  author?: string;
  assignee?: string;
  /** `owner:branch` (REST `head`); search receives the bare branch. */
  head?: string;
  base?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

export interface GitHubIssueFilter {
  state?: GitHubItemState;
  search?: string;
  label?: string;
  assignee?: string;
  author?: string;
  milestone?: string;
  /** Title used by `/search/issues` (`milestone:` takes the name, not the id). */
  milestoneTitle?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

/** Lote coalescido de mudanças de arquivo do workspace. */
export interface WorkspaceChangedEvent {
  workspaceId: string;
  /** Caminhos relativos ao workspace (sempre `/`). */
  paths: string[];
  /** O watcher perdeu/truncou eventos: recarregar a raiz e todos os diretórios carregados. */
  overflow: boolean;
}

/** Um arquivo alterado entre uma branch (merge-base) e a working tree. */
export interface WorkspaceGitCompareFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}

/** Resultado da comparação de uma branch com a working tree. */
export interface WorkspaceGitCompare {
  base: string;
  mergeBase: string;
  files: WorkspaceGitCompareFile[];
}

/** Commit recente para o painel. */
export interface WorkspaceGitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/** Um arquivo alterado por um commit (patch completo por arquivo). */
export interface WorkspaceCommitFile {
  path: string;
  oldPath?: string | null;
  /** `A` | `M` | `D` | `R` | `C` | `T`. */
  status: string;
  added: number;
  removed: number;
  binary: boolean;
  diff: string;
}

/** Commit completo para a aba de histórico do Code (metadados + arquivos). */
export interface WorkspaceCommitDetail {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: WorkspaceCommitFile[];
  truncated: boolean;
}


export interface Citation {
  id: string;
  title: string;
  url: string;
  snippet?: string | null;
  siteName?: string | null;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'code' | 'csv' | 'json' | 'unknown';
  textPreview?: string | null;
  pageCount?: number | null;
  width?: number | null;
  height?: number | null;
}

/** Anexo + payload, mesma forma de `ArtifactContent` (prévia no diálogo). */
export interface AttachmentContent {
  attachment: AttachmentInfo;
  content?: string | null;
  dataBase64?: string | null;
}

/**
 * One step of the agent loop (ARCHITECTURE §8): the reasoning the model
 * produced before acting and how many tool calls that step requested. The
 * calls themselves stay in `ChatMessage.toolCalls`, in chronological order, so
 * the count is enough to slice them back into the step that produced them.
 *
 * Persisted with the message and replayed by the thinking timeline; messages
 * from before the trace existed have no entries and fall back to a heuristic.
 */
export interface TraceStep {
  /** Visible reasoning of this step (`null` when the model emitted none). */
  reasoning?: string | null;
  /**
   * Visible narration emitted by this step before it requested tools. It is
   * absent on the final-answer step: that text lives in `ChatMessage.content`,
   * so the trace never duplicates the answer.
   */
  text?: string | null;
  /** Duration of this step's provider request, in milliseconds. */
  durationMs?: number | null;
  /** Number of tool calls produced by this step. */
  toolCalls: number;
}

export interface UsageInfo {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  /** Tokens read from the prompt cache (normalized across protocols). */
  cacheReadTokens?: number | null;
  /** Tokens written to the prompt cache by this request. */
  cacheWriteTokens?: number | null;
  /** Input tokens neither read from nor written to the cache. */
  uncachedInputTokens?: number | null;
  /** True when the provider reported cache counters. */
  cacheReported?: boolean;
  totalTokens?: number | null;
  cost?: number | null;
  durationMs?: number | null;
}

/** Live state of a `task` child, keyed by the parent tool-call id. */
export interface SubagentLiveState {
  taskCallId: string;
  conversationId: string;
  subagentType: string;
  description: string;
  prompt: string;
  providerId: string;
  modelId: string;
  effort?: string | null;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  steps: number;
  text: string;
  reasoning: string;
  trace: TraceStep[];
  toolCalls: ToolCallRecord[];
  usage?: UsageInfo;
  durationMs?: number;
  error?: string | null;
}

export type CacheState =
  | 'cold'
  | 'warming'
  | 'stable'
  | 'degraded'
  | 'unsupported'
  | 'provider_policy';

export type CacheBreakReason =
  | 'first_request'
  | 'system_prompt'
  | 'tool_definitions'
  | 'history_rewrite'
  | 'head_trim'
  | 'compaction'
  | 'model_switch'
  | 'protocol_fallback'
  | 'attachments'
  | 'config_change'
  | 'ttl_expired'
  | 'provider_policy';

/** One cache sample per provider request (wire request). */
export interface CacheSample {
  turnId: string;
  step: number;
  providerId: string;
  modelId: string;
  protocol: string;
  epoch: number;
  inputTotal: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
  /** Provider-reported hit percent; null when the provider did not report cache. */
  hitPercent?: number | null;
  /** Theoretical ceiling `P/(P+Δ)` for this request. */
  ceilingPercent?: number | null;
  prefixTokensEst?: number;
  deltaTokensEst?: number;
  eligible: boolean;
  excludedReason?: string | null;
  state: CacheState;
  breakReason?: CacheBreakReason | null;
  breakDetail?: string | null;
  /** Raw provider usage block (trimmed) for the diagnostics panel. */
  rawUsage?: unknown;
  at: number;
}

/** Aggregated cache view of a conversation/turn. */
export interface CacheStats {
  hitPercent?: number | null;
  sessionHitPercent?: number | null;
  steadyHitPercent?: number | null;
  ceilingPercent?: number | null;
  inputTotal: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
  eligible: boolean;
  excludedReason?: string | null;
  state: CacheState;
  epoch?: number;
  samples?: number;
  minCacheableTokens?: number | null;
  ttlSeconds?: number | null;
  breakReason?: CacheBreakReason | null;
  breakDetail?: string | null;
  providerPolicy?: string | null;
  at: number;
  savingsUsd?: number | null;
}

/** Snapshot returned by `get_cache_stats`. */
export interface CacheStatsView {
  conversationId: string;
  current?: CacheStats | null;
  session?: CacheStats | null;
  epoch: number;
  recent?: CacheSample[];
}

/** Terminal failure persisted on an assistant message. */
export interface MessageError {
  message: string;
  code?: string | null;
  hint?: string | null;
  /** A manual retry may succeed (transient/network/timeout/auth). */
  retryable: boolean;
  /** Provider-requested wait (`Retry-After`). */
  retryAfterMs?: number | null;
  /** Provider requests made by the failed step (0 = none attempted). */
  attempts: number;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  reasoning?: string | null;
  status: MessageStatus;
  toolCalls: ToolCallRecord[];
  citations: Citation[];
  attachments: AttachmentInfo[];
  /** Agent loop trace (thinking timeline). Absent on legacy/non-agent turns. */
  trace?: TraceStep[];
  modelId?: string | null;
  providerId?: string | null;
  usage?: UsageInfo | null;
  createdAt: number;
  /** Opaque replay payload captured from the provider (never rendered). */
  providerState?: unknown;
  /**
   * Origem da mensagem: `user` (default) ou `goal_round` (rodada automática do
   * objetivo). Só tem significado em mensagens de usuário.
   */
  origin?: TurnKind;
  /** Terminal failure persisted by the harness (survives reloads). */
  error?: MessageError | null;
  /**
   * Ponto de retomada do turno: presente quando ele parou sem concluir (erro do
   * provedor, Stop, app fechado). A UI oferece **Continuar**, que retoma do
   * mesmo passo nesta mesma mensagem.
   */
  resumeState?: ResumeState | null;
}

/** Motivo do ponto de retomada (espelha `domain::ResumeReason`). */
export type ResumeReason =
  | 'running'
  | 'provider_error'
  | 'route'
  | 'cancelled'
  | 'app_closed'
  | 'incomplete';

/**
 * Metadado do loop interrompido. O conteúdo do turno (texto, raciocínio, trace,
 * tool calls, uso e replay do provedor) já vive na própria mensagem.
 */
export interface ResumeState {
  version: number;
  turnId: string;
  /** Último passo executado; a retomada continua em `step + 1`. */
  step: number;
  turnKind: TurnKind;
  profile: TurnProfile;
  reason: ResumeReason;
  detail?: string | null;
  reasoning?: ReasoningSelection | null;
  /** Opções efetivas do turno interrompido (só as públicas). */
  options: TurnOptions;
  stopContinuations: number;
  updatedAt: number;
}

/** Origem de uma sessão: o layout onde ela foi criada. */
export type ConversationMode = 'chat' | 'code' | 'agent';

export interface AgentCapabilities {
  webSearch: boolean;
  fileAccess: boolean;
  codeExecution: boolean;
  /** Delegação de tarefas para outros agentes. */
  delegation?: boolean;
  /** Criação/edição das próprias rotinas. */
  automation?: boolean;
  /** Memória compartilhada entre agentes. */
  sharedMemory?: boolean;
  /** Escrita de skills do usuário. */
  skillsWrite?: boolean;
  /** Criação de novos agentes pela tool create_agent. */
  createAgents?: boolean;
  /** Computer use visual (screenshot + input). */
  computerUse?: boolean;
  /** Captura de tela sem input. */
  screenCapture?: boolean;
  /** Browser controlado por CDP. */
  browserUse?: boolean;
  /** Permite override de execução Docker por agente. */
  dockerExecution?: boolean;
  /** `null` herda todas as skills habilitadas; `[]` não usa nenhuma. */
  skills: string[] | null;
  tools: string[] | null;
  mcpServers: string[] | null;
}

export type ComputerEnvironment =
  | 'auto'
  | 'private_desktop'
  | 'this_computer'
  | 'browser'
  | 'off';

export type AgentAvatarShape = 'mascot' | 'circle' | 'rounded' | 'square';
export type AgentAvatarFace = 'white' | 'black';
export type AgentAvatarBody =
  | 'mascot'
  | 'circle'
  | 'bubble'
  | 'rounded'
  | 'square'
  | 'drop'
  | 'blob'
  | 'hex'
  | 'diamond'
  | 'star';
export type AgentAvatarExpression =
  | 'neutral'
  | 'happy'
  | 'grin'
  | 'wink'
  | 'surprised'
  | 'angry'
  | 'sad'
  | 'sleepy'
  | 'smug'
  | 'dizzy';
export type AgentAvatarColor =
  | 'green'
  | 'blue'
  | 'red'
  | 'orange'
  | 'purple'
  | 'teal'
  | 'pink'
  | 'yellow'
  | 'emerald'
  | 'coral'
  | 'gray'
  | 'silver';

/** Visual identity of an agent: built-in mascot, uploaded image or legacy emoji. */
export type AgentAvatar = (
  | {
      kind: 'mascot';
      body: AgentAvatarBody;
      expression: AgentAvatarExpression;
      color: AgentAvatarColor;
      face: AgentAvatarFace;
    }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'emoji'; value: string }
) & { shape: AgentAvatarShape };

export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  avatar: AgentAvatar;
  department: string;
  pinned: boolean;
  sortOrder: number;
  providerId: string;
  modelId: string;
  /** Backup route used when the primary route has no model/credential. */
  fallbackProviderId?: string | null;
  fallbackModelId?: string | null;
  reasoning: ReasoningSelection | null;
  instructions: string;
  promptVersion: number;
  starters: string[];
  capabilities: AgentCapabilities;
  memoryEnabled: boolean;
  memoryRevision?: number;
  /** Optional workspace for Code-profile turns (files/shell/approvals). */
  workspaceId: string | null;
  permissionMode: PermissionMode;
  /** Optional Docker image override (requires capability dockerExecution). */
  dockerImage?: string | null;
  /** Where this persona uses the computer/browser. */
  computerEnvironment?: ComputerEnvironment;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  threadCount: number;
  lastActiveAt: number | null;
}

export interface AgentInput {
  name: string;
  role: string;
  description: string;
  avatar: AgentAvatar;
  department: string;
  providerId: string;
  modelId: string;
  fallbackProviderId?: string | null;
  fallbackModelId?: string | null;
  reasoning: ReasoningSelection | null;
  instructions: string;
  starters: string[];
  capabilities: AgentCapabilities;
  memoryEnabled: boolean;
  workspaceId: string | null;
  permissionMode: PermissionMode;
  dockerImage?: string | null;
  computerEnvironment?: ComputerEnvironment;
}

export interface AgentChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface AgentRevision {
  agentId: string;
  before: AgentInput;
  after: AgentInput;
  changes: AgentChange[];
}

export type AgentMemoryKind = 'fact' | 'preference' | 'procedure' | 'note';

export interface AgentMemory {
  id: string;
  agentId: string;
  kind: AgentMemoryKind;
  content: string;
  sourceConversationId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMemoryInput {
  kind: AgentMemoryKind;
  content: string;
  sourceConversationId?: string | null;
  pinned?: boolean;
}

export interface AgentSharedMemory {
  id: string;
  sourceAgentId: string | null;
  sourceAgentName: string | null;
  sourceConversationId: string | null;
  kind: AgentMemoryKind;
  content: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentChannel {
  id: string;
  name: string;
  kind?: 'channel' | 'dm';
  /** Agent that answers first and may delegate work to other members. */
  leaderAgentId?: string | null;
  /** Posição manual na seção Canais (0 = ordem por recência). */
  sortOrder?: number;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export interface AgentChannelInput {
  name: string;
  memberIds: string[];
  leaderAgentId?: string | null;
}

export interface AgentChannelMessage {
  id: string;
  channelId: string;
  role: 'user' | 'agent' | 'system';
  agentId: string | null;
  content: string;
  attachments: AttachmentInfo[];
  createdAt: number;
}

export interface AgentChannelPostResult {
  messages: AgentChannelMessage[];
  errors: string[];
}

export interface AgentInboxItem {
  id: string;
  recipientAgentId: string;
  senderAgentId: string | null;
  senderUser: boolean;
  channelId: string;
  channelName: string;
  messageId: string;
  senderName: string;
  messageContent: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface AgentInboxCount {
  channelId: string;
  pending: number;
}

export type AgentTaskStatus =
  | 'queued'
  | 'accepted'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'review'
  | 'handoff_pending'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'declined';

export interface DockerStatus {
  available: boolean;
  serverVersion: string | null;
  images: string[];
  error: string | null;
}

export interface DockerDaemonStatus {
  running: boolean;
  started: boolean;
  serverVersion: string | null;
}

export interface DockerImageInfo {
  image: string;
  id: string;
  architecture: string;
}

export interface AgentTask {
  id: string;
  channelId: string | null;
  parentTaskId: string | null;
  ownerAgentId: string;
  createdByAgentId: string | null;
  createdByUser: boolean;
  title: string;
  brief: string;
  acceptance: string;
  status: AgentTaskStatus;
  priority: number;
  maxTurns: number;
  maxTokens: number;
  maxCost: number;
  deadlineAt: number | null;
  conversationId: string | null;
  originConversationId: string | null;
  workspaceId?: string | null;
  retryCount?: number;
  result: string | null;
  resultArtifactIds: string[];
  leaseUntil: number | null;
  handoffCount: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTaskInput {
  toAgentId: string;
  title: string;
  brief: string;
  acceptance?: string;
  channelId?: string | null;
  parentTaskId?: string | null;
  workspaceId?: string | null;
  maxTurns?: number;
  maxTokens?: number;
  maxCost?: number;
  deadlineMinutes?: number;
}

export interface AgentTaskEvent {
  id: string;
  taskId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  payload: unknown;
  createdAt: number;
}

export interface AgentTaskDetail {
  task: AgentTask;
  events: AgentTaskEvent[];
}

export interface AgentTaskUpdatedEvent {
  taskId: string;
  ownerAgentId: string;
  status: string;
  title: string;
  originConversationId?: string | null;
}

export interface AgentUsage {
  agentId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  lastUsedAt: number | null;
}

export interface UsageStatsTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  lastUsedAt: number | null;
}

export interface ModelUsageStats {
  providerId: string;
  modelId: string;
  turns: number;
  totalTokens: number;
  cost: number;
}

export interface DailyUsageStats {
  /** Local day in `YYYY-MM-DD`. */
  day: string;
  totalTokens: number;
}

export interface UsageStats {
  totals: UsageStatsTotals;
  byModel: ModelUsageStats[];
  byDay: DailyUsageStats[];
}

export interface AgentRoutine {
  id: string;
  agentId: string;
  title: string;
  prompt: string;
  scheduleKind: 'interval' | 'daily';
  intervalMinutes: number;
  hour: number;
  minute: number;
  /** Bitmask: Monday=1 … Sunday=64; 127 = every day. Used by daily routines. */
  daysOfWeek: number;
  enabled: boolean;
  conversationId: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  triggerKind: 'schedule' | 'event';
  eventKind: 'channel.message' | 'task.status' | '';
  eventFilterJson: string;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRoutineInput {
  title: string;
  prompt: string;
  scheduleKind: 'interval' | 'daily';
  intervalMinutes: number;
  hour: number;
  minute: number;
  /** Bitmask: Monday=1 … Sunday=64; 127 = every day. Used by daily routines. */
  daysOfWeek: number;
  enabled: boolean;
  triggerKind: 'schedule' | 'event';
  eventKind: 'channel.message' | 'task.status' | '';
  eventFilterJson: string;
}

export interface AgentRoutineRunEvent {
  routineId: string;
  agentId: string;
  conversationId: string | null;
  title: string;
  status: string;
  error: string | null;
  eventKind?: string | null;
  eventId?: string | null;
}

export interface AgentRoutineRun {
  id: string;
  routineId: string;
  conversationId: string | null;
  status: string;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface McpServerSummary {
  name: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface McpStatus {
  servers: McpServerSummary[];
  tools: Array<{ server: string; name: string; wireName: string }>;
}

export interface AgentThreadCursor {
  updatedAt: number;
  id: string;
}

export interface AgentThreadPage {
  items: Conversation[];
  nextCursor: AgentThreadCursor | null;
  hasMore: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** Posição manual dentro da seção da sidebar (0 = ordem por recência). */
  sortOrder?: number;
  providerId: string;
  modelId: string;
  messageCount: number;
  preview?: string | null;
  /**
   * Layout onde a sessão nasceu. O backend sempre envia; opcional no tipo para
   * fixtures/payloads antigos (tratados como `chat` por `lib/conversations`).
   */
  mode?: ConversationMode;
  /**
   * Sessão do Chat adicionada ao layout Code: aparece e é compartilhada nos
   * dois modos. Só faz sentido para `mode === 'chat'`.
   */
  codeLinked?: boolean;
  /** Workspace de código da sessão (ausente = sem workspace). */
  workspaceId?: string | null;
  /** Motor do agente: `zylara` (nativo); `acp:<agente>` é futuro. */
  agentKind?: string;
  /** Modo de permissão da sessão de código (o Chat ignora). */
  permissionMode?: PermissionMode;
  /** Parent session when this row is a retained subagent transcript. */
  parentConversationId?: string | null;
  /** `task` call that spawned this retained subagent transcript. */
  subagentTaskCallId?: string | null;
  /** Subagent kind (`explore` | `review` | `general`). */
  subagentType?: string | null;
  /** Persona dona da conversa (`mode === 'agent'`); ausente em Chat/Code. */
  agentId?: string | null;
  /** Shared channel that owns this hidden agent thread. */
  channelId?: string | null;
  /** Task that owns this hidden agent thread. */
  taskId?: string | null;
  /** Primary conversation of the agent persona; always pinned at the top. */
  isMain?: boolean;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ChatMessage[];
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

export type ReasoningMode = 'off' | 'effort' | 'budget';

export interface ReasoningSelection {
  mode: ReasoningMode;
  effort?: string | null;
  budget?: number | null;
}

export interface TurnOptions {
  webSearch: boolean;
  createFiles: boolean;
  /** Execução de código (`run_code`); o backend ainda aplica o gate global. */
  runCode: boolean;
  systemPromptOverride?: string | null;
  regenerate?: boolean;
}

export interface TurnPayload {
  conversationId: string;
  content: string;
  attachmentIds: string[];
  providerId: string;
  modelId: string;
  reasoning?: ReasoningSelection | null;
  options: TurnOptions;
  /** Perfil do turno; ausente = `chat` (retrocompatível). */
  profile?: TurnProfile;
  /** `user` (default) ou `goal_round` (rodada automática de um objetivo). */
  turnKind?: TurnKind;
  /**
   * O usuário pediu um objetivo pelo fluxo `/goal` (chip no composer). O turno
   * continua humano; o runtime context instrui o agente a chamar a tool `goal`.
   * Ausente/false = turno normal.
   */
  goalRequest?: boolean;
  turnId?: string | null;
  /**
   * Continua um turno interrompido em vez de começar outro: id da mensagem
   * assistant que carrega o ponto de retomada. O backend reusa essa linha (mesmos
   * cards de tool call) e retoma o loop no passo seguinte.
   */
  resumeAssistantMessageId?: string | null;
}

export interface ActiveTurnInfo {
  turnId: string;
  conversationId: string;
  startedAt: number;
}

export interface TurnEventRecord {
  turnId: string;
  seq: number;
  event: TurnEvent;
}

export interface TurnEventBusPayload {
  turnId: string;
  seq: number;
  conversationId: string;
  event: TurnEvent;
}

export interface ComputerSession {
  id: string;
  agentId: string | null;
  conversationId: string;
  backend: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
}

export interface ComputerPreview {
  dataUrl: string;
  width: number;
  height: number;
  backend: 'local' | 'docker';
  activeWindow: string;
  paused: boolean;
  takenOver: boolean;
  controlTarget: string;
  sessionId: string | null;
  capturedAt: number;
}

export interface ComputerControlTarget {
  kind: 'local' | 'vnc' | 'browser';
  url: string | null;
  generation: string | null;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserStatus {
  running: boolean;
  port: number | null;
  executable: string | null;
  profileDir: string | null;
  downloadDir: string | null;
  tabs: BrowserTab[];
  activeTab: string | null;
}

export interface BrowserFrame {
  dataUrl: string;
  url: string;
  title: string;
  width: number;
  height: number;
  capturedAt: number;
}

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value: string;
  disabled: boolean;
  backendNodeId: number;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserElement[];
  screenshot: string | null;
  width: number;
  height: number;
  capturedAt: number;
}

export interface ComputerActionRecord {
  id: string;
  sessionId: string;
  agentId: string | null;
  conversationId: string;
  turnId: string;
  tool: string;
  action: string;
  target: unknown;
  approvalScope: string | null;
  decision: string | null;
  result: string;
  errorCode: string | null;
  errorMessage: string | null;
  redactedTextLen: number | null;
  policyRule: string | null;
  initiator: string | null;
  createdAt: number;
  endedAt: number | null;
}

export interface TurnResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  usage?: UsageInfo | null;
  error?: MessageError | null;
  conversation?: Conversation | null;
}

export type TurnEvent =
  | { type: 'turn_started'; turnId: string; userMessageId: string; assistantMessageId: string }
  | { type: 'step_started'; step: number }
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: 'transient' | 'auth_refresh';
      code?: string;
    }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'reasoning_done' }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_started'; toolCall: ToolCallRecord }
  | { type: 'tool_call_executing'; id: string; startedAt: number }
  | { type: 'tool_call_args'; id: string; delta: string }
  | {
      type: 'tool_call_finished';
      id: string;
      status: 'done' | 'error';
      result: string;
      summary?: string;
      citations?: Citation[];
      presentation?: ToolPresentation | null;
      finishedAt?: number;
    }
  | { type: 'artifact_created'; artifact: Artifact }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'cache_stats'; sample: CacheSample }
  | { type: 'message_updated'; message: ChatMessage }
  | { type: 'title_updated'; conversationId: string; title: string }
  | { type: 'done'; result: TurnResult }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; code?: string; hint?: string; retryable?: boolean; attempts?: number }
  /* -------- harness de código (docs/goals/code-harness/HARNESS.md §12) -------- */
  | { type: 'approval_requested'; approval: ApprovalRequest }
  | { type: 'approval_resolved'; approvalId: string; decision: ApprovalDecision; scope?: ApprovalScope }
  | { type: 'tool_progress'; id: string; stream?: 'stdout' | 'stderr'; delta: string }
  | { type: 'file_changed'; change: FileChange }
  | { type: 'workspace_changes'; summary: ChangesSummary }
  | { type: 'todos_updated'; todos: TodoItem[] }
  | { type: 'plan_updated'; plan: PlanView }
  | { type: 'goal_updated'; goal: GoalView }
  | { type: 'context_stats'; stats: ContextStats }
  | { type: 'compacted'; messages: number; tokensFreed: number }
  | { type: 'job_updated'; job: JobView }
  | { type: 'profile_changed'; profile: TurnProfile; permissionMode: PermissionMode; planMode: boolean }
  | { type: 'question_requested'; request: AskUserRequest }
  | { type: 'question_resolved'; requestId: string; answers: AskUserAnswer[]; skipped: boolean }
  | {
      type: 'subagent_started';
      taskCallId: string;
      conversationId: string;
      subagentType: string;
      description: string;
      prompt: string;
      providerId: string;
      modelId: string;
      effort?: string | null;
    }
  | { type: 'subagent_event'; taskCallId: string; event: TurnEvent }
  | {
      type: 'subagent_finished';
      taskCallId: string;
      conversationId?: string | null;
      status: 'done' | 'error' | 'cancelled';
      usage?: UsageInfo;
      durationMs: number;
      error?: string | null;
    };

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

export type ArtifactKind =
  | 'markdown'
  | 'code'
  | 'text'
  | 'html'
  | 'csv'
  | 'json'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'audio'
  | 'video'
  | 'archive'
  | 'binary';

export interface Artifact {
  id: string;
  /** `null` = arquivo enviado pelo usuário direto à Biblioteca (sem conversa). */
  conversationId: string | null;
  messageId?: string | null;
  name: string;
  mimeType: string;
  kind: ArtifactKind;
  language?: string | null;
  size: number;
  createdAt: number;
  /**
   * Marcado pelo usuário na página Biblioteca. Opcional no contrato para que
   * payloads/fixtures antigos continuem tipando (o backend sempre envia).
   */
  favorite?: boolean;
}

/**
 * Artefato + origem, como devolvido por `list_library_artifacts`: os campos de
 * `Artifact` ficam no topo (`serde(flatten)`) e `conversationTitle` é `null`
 * para arquivos enviados direto à biblioteca (sem conversa).
 */
export interface LibraryArtifact extends Artifact {
  conversationTitle?: string | null;
}

/** Miniatura PNG gerada no backend para os cards de imagem da Biblioteca. */
export interface ArtifactThumbnail {
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
}

export interface ArtifactContent {
  artifact: Artifact;
  content?: string | null;
  dataBase64?: string | null;
}

/* ------------------------------------------------------------------ */
/* Previews / code environment / skills                                */
/* ------------------------------------------------------------------ */

export interface SheetPreview {
  name: string;
  rows: string[][];
  truncated: boolean;
}

export interface SlidePreview {
  index: number;
  texts: string[];
  notes?: string | null;
}

/** Entrada de um arquivo compactado (prévia de ZIP). */
export interface ArchiveEntryPreview {
  name: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
}

/**
 * Prévia estruturada de artefatos binários. PDF, áudio e vídeo usam o payload
 * base64 de `get_artifact_content` (pdf.js/player nativo); imagens ganham
 * metadados e payload convertido quando o formato não abre no WebView (TIFF);
 * ZIP vira listagem e binários sem prévia mostram os primeiros bytes (hexdump).
 */
export type ArtifactPreview =
  | { kind: 'docx'; html: string }
  | { kind: 'xlsx'; sheets: SheetPreview[] }
  | { kind: 'pptx'; slides: SlidePreview[] }
  | {
      kind: 'image';
      /** MIME do payload exibido (o original ou `image/png` após conversão). */
      mime: string;
      width?: number | null;
      height?: number | null;
      /** Presente apenas quando o formato original foi convertido para PNG. */
      dataBase64?: string | null;
    }
  | {
      kind: 'archive';
      format: string;
      entries: ArchiveEntryPreview[];
      totalEntries: number;
      truncated: boolean;
    }
  | { kind: 'binary'; format: string; previewBase64: string; previewBytes: number }
  | { kind: 'unsupported'; reason: string };

export interface InterpreterInfo {
  path: string;
  version: string;
  /** settings | path */
  source: string;
}

export interface CodePackageStatus {
  name: string;
  available: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  /** bundled | user | agents | codex | claude | opencode */
  source: string;
  /** `false` quando a skill está desativada nas configurações. */
  enabled: boolean;
  /** Só skills do Zylara (`user`) podem ser excluídas; externas são somente leitura. */
  deletable: boolean;
}

/**
 * Conteúdo de uma skill para a pré-visualização em Markdown na gestão de skills:
 * o corpo do `SKILL.md` (Markdown após o frontmatter) e os metadados que o modal
 * exibe no cabeçalho. O diretório vem absoluto apenas para referência (a interface
 * nunca escreve nele).
 */
export interface SkillContent {
  name: string;
  description: string;
  /** bundled | user | agents | codex | claude | opencode */
  source: string;
  /** Caminho absoluto do diretório da skill (contém o `SKILL.md`). */
  dir: string;
  /** Corpo do `SKILL.md` (Markdown, sem o frontmatter). */
  content: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  content: string;
  overwrite: boolean;
}

export interface SkillVersion {
  file: string;
  savedAt: number;
}

export interface CodeEnvironmentStatus {
  enabled: boolean;
  python?: InterpreterInfo | null;
  node?: InterpreterInfo | null;
  packages: CodePackageStatus[];
  installHint: string;
  skills: SkillSummary[];
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark' | 'system';

/** Palette of one theme variant; keys are CSS custom-property suffixes. */
export interface ThemeVariant {
  /** e.g. `{ background: '#fff', 'surface-raised': '#fafafa' }`. */
  tokens: Record<string, string>;
  /** Relative asset path inside the theme directory, or null. */
  wallpaper: string | null;
}

/** Bundled font files, relative to the theme directory. */
export interface ThemeFontPaths {
  sans: string | null;
  mono: string | null;
}

/** Installed (or built-in) theme returned by `list_themes`. */
export interface ThemeInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  builtIn: boolean;
  light: ThemeVariant;
  dark: ThemeVariant;
  fonts: ThemeFontPaths;
}

export interface ThemeInstallResult {
  theme: ThemeInfo;
  replaced: boolean;
}

export type CacheTtl = '5m' | '1h';

/** Preferências de cache de prompt (docs/goals/prompt-cache/PLAN.md §5.4). */
export interface CacheSettings {
  /** Mostra o selo de cache; não desliga a medição. */
  showIndicator: boolean;
  anthropicTtl: CacheTtl;
  /** null/ausente = adapter decide; ex.: 'in_memory' | '24h'. */
  openaiRetention?: string | null;
}

export interface Settings {
  theme: ThemeMode;
  /** Installed theme id; independent of the light/dark/system mode. */
  themeId: string;
  locale: AppLocale;
  defaultProvider: string;
  defaultModel: string;
  reasoningDefault: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';
  systemPrompt: string;
  webSearchEnabled: boolean;
  fileCreationEnabled: boolean;
  sendKey: 'enter' | 'ctrl+enter';
  showTokenUsage: boolean;
  reduceMotion: boolean;
  /**
   * Mantém o bloco de raciocínio/passos (`AgentSteps`) recolhido por padrão:
   * ele começa fechado e não abre sozinho durante o streaming. O usuário ainda
   * pode expandi-lo manualmente a qualquer momento.
   */
  thinkingCollapsedByDefault: boolean;
  fontScale: number;
  /** Custom font stack for the code terminal; empty = theme mono (`--font-mono`). */
  terminalFontFamily?: string;
  /** Terminal font size in px (8–32). */
  terminalFontSize?: number;
  includeAttachments: boolean;
  autoTitle: boolean;
  /** Opt-in: permite ao agente executar código (`run_code`). */
  codeExecutionEnabled: boolean;
  /** Tempo máximo de uma execução de código (segundos). */
  codeTimeoutSecs: number;
  /** Interpretador Python explícito; vazio = auto-detecção. */
  codePythonPath: string;
  /** Interpretador Node explícito; vazio = auto-detecção. */
  codeNodePath: string;
  /** Mostra o item "Skills" na barra lateral. */
  skillsPanelEnabled: boolean;
  /** Nomes de skills desativadas; o agente as ignora. */
  disabledSkills: string[];
  /* ---- harness de código (docs/goals/code-harness/PLAN.md §7) ---- */
  /** Permite ao agente executar comandos de shell (`run_command`). */
  shellEnabled?: boolean;
  /** `local` (máquina do usuário) ou `docker` para os comandos do Code. */
  executionEnvironment?: 'local' | 'docker';
  /** Imagem usada quando `executionEnvironment === 'docker'`. */
  dockerImage?: string;
  /** Onde o computer use roda (`auto` por padrão; o agente pode sobrescrever). */
  computerEnvironment?: ComputerEnvironment;
  /** Allowlist de hosts do navegador (vazio = todos os hosts públicos). */
  browserAllowedDomains?: string[];
  /** Denylist de hosts do navegador. */
  browserBlockedDomains?: string[];
  /** Allowlist de apps do desktop (processo/classe). Vazio = todos. */
  computerAllowedApps?: string[];
  /** Apps do desktop sempre negados. */
  computerBlockedApps?: string[];
  /** Permite localhost/RFC1918 no navegador (desenvolvimento local). */
  browserAllowPrivateHosts?: boolean;
  /** Permite navegador em rotinas/tarefas sem canal de aprovação. */
  computerAllowUnattendedBrowser?: boolean;
  /** Permite rede no contêiner Docker (padrão: desligado). */
  dockerNetwork?: boolean;
  /** Limite de memória do sandbox Docker (MB). */
  dockerMemoryMb?: number;
  /** Limite de CPU do sandbox Docker. */
  dockerCpus?: number;
  /** Limite de PIDs do sandbox Docker. */
  dockerPidsLimit?: number;
  /** Monta o rootfs do contêiner como somente leitura. */
  dockerReadOnlyRoot?: boolean;
  /** Turnos simultâneos no app inteiro. */
  maxConcurrentTurns?: number;
  /** Turnos simultâneos por agente. */
  maxConcurrentTurnsPerAgent?: number;
  /** Mensagens máximas na fila de uma thread. */
  maxQueueLengthPerThread?: number;
  /** Limite diário de custo por agente (USD); `null` desliga. */
  agentDailyCostLimitUsd?: number | null;
  /** Imagem Docker do computer use gráfico. */
  computerDockerImage?: string;
  /** Nome do container do computer use gráfico. */
  computerDockerContainer?: string;
  /** Máximo de ações de computer use por turno. */
  computerMaxActionsPerTurn?: number;
  /** Máximo de ações de computer use por agente em uma hora. */
  computerMaxActionsPerHour?: number;
  /** Compacta o contexto automaticamente quando a janela aperta. */
  autoCompact?: boolean;
  /** Retenção dos arquivos de spill, em dias. */
  spillRetentionDays?: number;
  /** Tempo máximo para responder uma aprovação (segundos). */
  approvalTimeoutSecs?: number;
  /** Notificações do sistema no fim de turnos em segundo plano. */
  notificationsEnabled?: boolean;
  /** Notificar aprovações pedidas em segundo plano. */
  notificationsApprovals?: boolean;
  /** Notificar perguntas feitas em segundo plano. */
  notificationsQuestions?: boolean;
  /** Notificar conclusão de turnos de agente em segundo plano. */
  notificationsCompletions?: boolean;
  /** Notificar tarefas que precisam de uma pessoa. */
  notificationsTasks?: boolean;
  /** Não perturbe: mantém só os avisos in-app da Atividade. */
  notificationsDnd?: boolean;
  /** Keep running in the system tray when the window is closed. */
  closeToTray?: boolean;
  /** False until the one-time first-run prompt has been answered. */
  closeToTrayPrompted?: boolean;
  /** Modo de permissão inicial de novas sessões do Code (padrão: Autônomo). */
  codeDefaultPermissionMode?: PermissionMode;
  /** Confia automaticamente em workspaces abertos antes. */
  trustWorkspacesByDefault?: boolean;
  /**
   * Onde o diff de um arquivo abre ao clicar em Alterações: `tab` (aba do
   * chat, padrão de fábrica) ou `panel` (inline no painel direito).
   */
  diffOpenMode?: 'tab' | 'panel';
  /** Preferências de cache de prompt (backend sempre envia). */
  cache?: CacheSettings;
  /** Deadline entre conexão e headers da resposta, em segundos. */
  providerHeadersTimeoutSecs?: number;
  /** Deadline do primeiro evento SSE com dados, em segundos. */
  providerFirstEventTimeoutSecs?: number;
  /** Gap máximo entre eventos SSE com dados, em segundos. */
  providerIdleTimeoutSecs?: number;
  /** Deadline absoluto do stream, em segundos (0 desliga). */
  providerTotalTimeoutSecs?: number;
  /** Tentativas extras após a primeira (0 desliga o retry automático). */
  providerMaxRetries?: number;
  providerRetryBaseDelayMs?: number;
  providerRetryMaxDelayMs?: number;
  /** Orçamento de espera dos retries de um passo (0 = sem teto). */
  providerRetryMaxElapsedMs?: number;
  /** Maior espera aceita de `Retry-After` antes de devolver o erro. */
  providerRetryAfterCapMs?: number;
}

export interface ProviderKeyStatus {
  providerId: string;
  hasKey: boolean;
  masked?: string | null;
  source: 'settings' | 'env' | 'opencode-cli' | 'chatgpt' | 'none';
  /** api-key | oauth */
  mode?: ProviderAuth;
}

/** Two-phase ChatGPT login attempt handle. */
export interface LoginChallenge {
  attemptId: string;
  authUrl: string;
  expiresAt: number;
  /** False when the backend could not hand the URL to the system browser. */
  browserOpened: boolean;
  /** Sanitized opener failure (never includes the authorization URL). */
  browserError?: string | null;
}

export type ProviderAuthState =
  | 'signed-in'
  | 'signed-out'
  | 'reauth-required'
  | 'plan-disabled';

/** Auth state of one provider; never contains credential material. */
export interface ProviderAuthStatus {
  providerId: string;
  mode: ProviderAuth;
  state: ProviderAuthState;
  accountLabel?: string | null;
  planUsage: boolean;
  expiresAt?: number | null;
  scopes: string[];
  clientIdMasked?: string | null;
  hostIdMasked?: string | null;
  hint?: string | null;
}

export interface SettingsView {
  settings: Settings;
  keys: ProviderKeyStatus[];
  auth?: ProviderAuthStatus[];
  secretsError?: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  platform: string;
  startedAt: number;
  dataDir: string;
}

/* ------------------------------------------------------------------ */
/* Atualizações (GitHub release feed + instalador)                     */
/* ------------------------------------------------------------------ */

export type UpdateAssetKind = 'setup' | 'dmg' | 'appimage' | 'deb' | 'rpm';

export type ManagedInstallMode = 'managed' | 'manual';

/** How the running Zylara was installed and whether it can replace itself. */
export interface ManagedUpdateStatus {
  mode: ManagedInstallMode;
  installPath?: string | null;
  installedVersion?: string | null;
  /** True only when the marker and the running path were validated. */
  supported: boolean;
  reason?: string | null;
}

export type ManagedInstallStatus = 'installed' | 'rolledBack' | 'failed';

/** Outcome written by the managed update helper and shown after restart. */
export interface ManagedInstallResult {
  version: string;
  status: ManagedInstallStatus;
  message?: string | null;
  completedAt: number;
}

/** Release artifact selected for the current platform. */
export interface UpdateAsset {
  name: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  /** Ex.: "Windows x64", "macOS (Apple Silicon)", "Linux x64 · AppImage". */
  platformLabel: string;
  kind: UpdateAssetKind;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseName: string;
  releasedAt?: string | null;
  htmlUrl: string;
  /** `null` quando a release não tem instalador para esta plataforma. */
  asset?: UpdateAsset | null;
  checkedAt: number;
  /** Resultado em cache exibido após uma falha de verificação. */
  stale?: boolean;
}

export interface UpdatePreferences {
  /** Verifica ao abrir e a cada hora enquanto o app estiver aberto. */
  autoCheck: boolean;
  lastCheckAt?: number | null;
  /** Versão ignorada pelo usuário; uma versão mais nova volta a aparecer. */
  skippedVersion?: string | null;
  /** Última versão que já gerou um aviso (toast). */
  notifiedVersion?: string | null;
}

export interface DownloadedUpdate {
  version: string;
  path: string;
  size: number;
  sha256: string;
}

export interface UpdateStatus {
  currentVersion: string;
  preferences: UpdatePreferences;
  info?: UpdateInfo | null;
  download?: DownloadedUpdate | null;
  managed: ManagedUpdateStatus;
  lastInstall?: ManagedInstallResult | null;
}

export interface UpdateNotes {
  notes?: string | null;
  releasedAt?: string | null;
  htmlUrl: string;
}

export interface UpdateDownloadResult {
  cancelled: boolean;
  download?: DownloadedUpdate | null;
}

export type UpdateEvent =
  | { kind: 'started'; name: string; total: number }
  | {
      kind: 'progress';
      received: number;
      total: number;
      percent: number;
      bytesPerSec: number;
    }
  | { kind: 'verifying' }
  | { kind: 'done'; download: DownloadedUpdate }
  | { kind: 'cancelled' };

export interface ProviderValidation {
  providerId: string;
  ok: boolean;
  message?: string | null;
  latencyMs?: number | null;
  models: number;
}

export interface CatalogView {
  catalog: CatalogFile;
  keys: ProviderKeyStatus[];
  auth?: ProviderAuthStatus[];
  remoteRefreshedAt?: number | null;
}

/* ------------------------------------------------------------------ */
/* UI-only helpers                                                     */
/* ------------------------------------------------------------------ */

export interface ModelSelection {
  providerId: string;
  modelId: string;
  reasoning: ReasoningSelection | null;
}

export interface ConversationGroup {
  label: string;
  conversations: Conversation[];
}
