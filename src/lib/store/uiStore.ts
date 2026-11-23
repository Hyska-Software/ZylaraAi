import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_LAYOUT_VISIBILITY,
  enabledLayoutModes,
  firstEnabledLayout,
  sanitizeLayoutVisibility,
  type LayoutVisibility,
} from '../layoutModes';
import { DEFAULT_SETTINGS_TAB, isSettingsTabId, type SettingsTabId } from '../settingsTabs';
import { applyThemeMode } from '../theme/apply';
import type { AgentInput, Artifact, ThemeMode } from '../types';

/**
 * Main content surface. `skills` and `library` replace the chat column (the
 * sidebar stays visible), so their management never opens as a modal —
 * docs/FILES.md §7.4 and docs/goals/library-page/PLAN.md.
 */
export type MainView = 'chat' | 'skills' | 'library' | 'plugins';

/**
 * Application layout mode. `chat` is the classic conversation app; `code` is
 * the coding-agent workbench (Paseo-inspired) introduced by
 * docs/goals/chat-code-layout/PLAN.md. The mode is persisted and switched from
 * the title bar.
 */
export type LayoutMode = 'chat' | 'code' | 'agent';

/** Plugin-owned center page active in one layout. */
export interface PluginPageTarget {
  pluginId: string;
  pageId: string;
}

/**
 * Center surface inside the Agentes layout when no agent/channel is selected.
 * Volatile: `stats` and `routines` never survive an app restart.
 */
export type AgentView = 'team' | 'stats' | 'routines' | 'plugins';

/** Dialog de criação/edição de agente (volátil). */
export type AgentEditorState =
  | { mode: 'create'; draft?: AgentInput }
  | { mode: 'edit'; agentId: string };

/**
 * Surface shown inside the Code layout's center column. The Code workbench has
 * its own view state so switching layouts never loses the Chat surface's page
 * (Biblioteca/Skills) and vice versa. `diff` mostra o diff de um arquivo em uma
 * aba central (WORKBENCH §7.2); `file` mostra a prévia de um arquivo do
 * workspace na mesma faixa de abas (código, imagem ou PDF); `plan` mostra o
 * plano aprovado da sessão em Markdown na mesma faixa (ver `codePlanTab`);
 * `goal` mostra o painel do objetivo persistente (docs/goals/code-goals);
 * `subagent` mostra o chat read-only de um subagente em uma aba própria;
 * `prs`/`issues` mostram as listas do GitHub e `pr`/`issue` cada item aberto.
 * Os alvos vivem em `codeDiffTab`/`codeFileTab`/`codePlanTab`/`codeSubagentTab`
 * e nos campos `codePullRequest*`/`codeIssue*`.
 */
export type CodeView =
  | 'session'
  | 'skills'
  | 'plugins'
  | 'diff'
  | 'commits'
  | 'file'
  | 'plan'
  | 'goal'
  | 'subagent'
  | 'terminal'
  | 'prs'
  | 'pr'
  | 'issues'
  | 'issue';

/** Views válidas do centro (usado por `setCodeView` e pelas abas). */
const CODE_VIEWS: readonly CodeView[] = [
  'session',
  'skills',
  'plugins',
  'diff',
  'commits',
  'file',
  'plan',
  'goal',
  'subagent',
  'terminal',
  'prs',
  'pr',
  'issues',
  'issue',
];

/** Diff aberto como aba central (alvo é volátil; não persiste entre sessões). */
export interface CodeDiffTab {
  workspaceId: string;
  path: string;
  /** `true` = diff do index (`git diff --cached`). */
  staged: boolean;
  /** Diff já conhecido pelo journal da sessão (evita a chamada de API). */
  knownDiff?: string | null;
  /** Ref base de uma comparação (`get_file_diff_at`); ausente = working tree. */
  base?: string | null;
}

/**
 * Arquivo aberto como aba central (alvo volátil; não persiste entre sessões).
 * A prévia inline do painel Arquivos foi substituída por estas abas: cada
 * clique na árvore abre (ou ativa) uma aba e o conteúdo é carregado por
 * `read_workspace_file`.
 */
export interface CodeFileTab {
  workspaceId: string;
  /** Caminho relativo ao workspace, sempre com `/`. */
  path: string;
}

/** Chave estável de uma aba de arquivo (workspace + caminho relativo). */
export function codeFileTabKey(tab: CodeFileTab): string {
  return `${tab.workspaceId}\u0000${tab.path}`;
}

/**
 * Plano aprovado aberto como aba central (volátil, como as abas de arquivo).
 * Guarda o Markdown no momento da abertura; a visualização reusa o `FilePreview`
 * (Documento ⇄ Código), igual à prévia de um `.md` da filetree.
 */
export interface CodePlanTab {
  conversationId: string;
  /** Markdown congelado no momento em que "Ver plano" foi acionado. */
  markdown: string;
  /** Rótulo curto da aba (default: "Plano"). */
  title?: string;
  updatedAt: number;
}

/**
 * Read-only child chat opened as a center tab. The `conversationId` is the
 * stable identity (same child opened from the task row or the Subagents list
 * maps to the same tab); `taskCallId` locates the live state while running.
 */
export interface CodeSubagentTab {
  conversationId: string;
  taskCallId: string;
  subagentType: string;
  description: string;
  providerId?: string | null;
  modelId?: string | null;
  effort?: string | null;
  prompt?: string | null;
}

/** Stable key for a subagent tab (deduplicates the same child transcript). */
export function codeSubagentTabKey(tab: CodeSubagentTab): string {
  const conversation = tab.conversationId.trim();
  return conversation.length > 0 ? conversation : tab.taskCallId.trim();
}

/** Lista de pull requests do workspace aberta como aba central. */
export interface CodePullRequestsTab {
  workspaceId: string;
}

/** Lista de issues do workspace aberta como aba central. */
export interface CodeIssuesTab {
  workspaceId: string;
}

/** Pull request aberto como aba central (uma aba por PR, como os arquivos). */
export interface CodePullRequestTab {
  workspaceId: string;
  number: number;
  /** Título congelado na abertura; o detalhe recarrega o resto. */
  title: string;
}

/** Issue aberta como aba central (uma aba por issue). */
export interface CodeIssueTab {
  workspaceId: string;
  number: number;
  title: string;
}

/** Chave estável de uma aba de PR/issue (workspace + número). */
export function codeRepoItemTabKey(tab: { workspaceId: string; number: number }): string {
  return `${tab.workspaceId}\u0000${tab.number}`;
}

/** Tabs of the Code right panel (Arquivos | Alterações). */
export type CodePanelTab = 'files' | 'changes' | 'terminal';

/** Factory order of the Code right panel tabs (used when no order is stored). */
export const CODE_PANEL_TAB_ORDER_DEFAULT: readonly CodePanelTab[] = [
  'files',
  'changes',
  'terminal',
];

/** Keeps a stored panel order inside the known ids, appending what is missing. */
export function normalizeCodePanelTabOrder(value: unknown): CodePanelTab[] {
  const valid = new Set<CodePanelTab>(CODE_PANEL_TAB_ORDER_DEFAULT);
  const order: CodePanelTab[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string' || !valid.has(entry as CodePanelTab)) continue;
      const tab = entry as CodePanelTab;
      if (!order.includes(tab)) order.push(tab);
    }
  }
  for (const tab of CODE_PANEL_TAB_ORDER_DEFAULT) {
    if (!order.includes(tab)) order.push(tab);
  }
  return order;
}

/** Keeps a stored open-tab subset valid, preserving order (empty is allowed). */
export function normalizeCodePanelOpenTabs(value: unknown): CodePanelTab[] {
  if (!Array.isArray(value)) return [...CODE_PANEL_TAB_ORDER_DEFAULT];
  const valid = new Set<CodePanelTab>(CODE_PANEL_TAB_ORDER_DEFAULT);
  const open: CodePanelTab[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !valid.has(entry as CodePanelTab)) continue;
    const tab = entry as CodePanelTab;
    if (!open.includes(tab)) open.push(tab);
  }
  return open;
}

/** Neighbour of a closed tab, searched forward then backward in the strip order. */
function neighbourCodePanelTab(
  order: readonly CodePanelTab[],
  wasOpen: readonly CodePanelTab[],
  closed: CodePanelTab,
): CodePanelTab | null {
  const remaining = order.filter((tab) => wasOpen.includes(tab) && tab !== closed);
  const index = order.indexOf(closed);
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(index + step) % order.length];
    if (candidate && remaining.includes(candidate)) return candidate;
  }
  return remaining[0] ?? null;
}

/** Trims, drops empties and dedupes a persisted tab order list. */
function normalizeTabOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const order: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || order.includes(id)) continue;
    order.push(id);
  }
  return order;
}

/** Tabs of the agent right sidebar. */
export type AgentPanelTab = 'screen' | 'routines' | 'browser' | 'data';

/** Which panel owns the agent layout's right dock. */
export type AgentRightPanel = 'agent' | 'workspace';

/**
 * Diálogo de criação/edição do objetivo (docs/goals/code-goals/PLAN.md §10.4).
 * Volátil: abre pelo pill do composer, pelo card de atenção ou por `/goal`.
 */
export interface GoalDialogState {
  conversationId: string;
  mode: 'create' | 'edit';
}

/**
 * Surface shown by the artifact side panel: the generated-artifact list (the
 * "+" affordance in the chat and the command palette) or a single preview
 * (clicking an artifact card).
 */
export type ArtifactPanelView = 'list' | 'preview';

/**
 * How the right side panel shares space with the chat: `overlay` floats above
 * the conversation (classic drawer); `docked` splits the row so the chat
 * reflows. The docked layout only applies on wide windows — `lib/sidePanel.ts`
 * owns the responsive fallback to overlay.
 */
export type SidePanelMode = 'overlay' | 'docked';

/**
 * Sidebar width bounds (px). The user resizes the sidebar by dragging its right
 * edge (`components/layout/SidebarResizer`); the value is persisted with the
 * rest of the UI state and clamped on read/write. docs/DESIGN.md §5.
 */
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 272;
/** Width change per arrow key press on the resize handle. */
export const SIDEBAR_WIDTH_STEP = 16;

/** Keeps a sidebar width inside the supported range; invalid input falls back to the default. */
export function clampSidebarWidth(width: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

/**
 * Right side panel (artifacts and sources share the same surface) width bounds.
 * Resized by dragging its left edge (`components/layout/PanelResizer`), also
 * persisted and clamped on read/write. docs/DESIGN.md §5.
 */
export const SIDE_PANEL_WIDTH_MIN = 360;
export const SIDE_PANEL_WIDTH_MAX = 900;
export const SIDE_PANEL_WIDTH_DEFAULT = 480;
/** Width change per arrow key press on the resize handle. */
export const SIDE_PANEL_WIDTH_STEP = 16;

/** Keeps a side panel width inside the supported range; invalid input falls back to the default. */
export function clampSidePanelWidth(width: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDE_PANEL_WIDTH_DEFAULT;
  return Math.min(SIDE_PANEL_WIDTH_MAX, Math.max(SIDE_PANEL_WIDTH_MIN, Math.round(width)));
}

interface UiState {
  theme: ThemeMode;
  /** Active application layout (Chat | Code | Agentes) — persisted (PLAN §2). */
  layoutMode: LayoutMode;
  /** Which layouts the title-bar switcher offers (persisted; at least one is always enabled). */
  enabledLayouts: LayoutVisibility;
  /** Agente selecionado no layout Agentes (persistido). */
  activeAgentId: string | null;
  /** Canal compartilhado selecionado (`null` = nenhum). */
  activeChannelId: string | null;
  /** Centro do layout Agentes sem agente/canal selecionado (volátil). */
  agentView: AgentView;
  /** Filter of the central routines page (`null` = all agents; volatile). */
  agentRoutinesAgentId: string | null;
  /** Diálogo de criação/edição de agente (volátil). */
  agentEditor: AgentEditorState | null;
  /** Quick avatar editor: agent id or `null` (volatile). */
  agentAvatarEditor: string | null;
  /** Center surface inside the Code layout; reset to `session` on demand. */
  codeView: CodeView;
  /** Diff aberto como aba central (`null` = nenhum; pode ficar em segundo plano). */
  codeDiffTab: CodeDiffTab | null;
  /** Arquivos abertos nas abas centrais, na ordem de abertura (volátil). */
  codeFileTabs: CodeFileTab[];
  /** Aba de arquivo ativa (`null` = nenhuma; sempre presente em `codeFileTabs`). */
  codeFileTab: CodeFileTab | null;
  /** Plano aprovado exibido como aba central (`null` = nenhum/aba fechada). */
  codePlanTab: CodePlanTab | null;
  /** Subagent chats abertos como abas centrais, na ordem de abertura. */
  codeSubagentTabs: CodeSubagentTab[];
  /** Aba ativa de subagente (`null` = nenhuma; sempre presente na lista). */
  codeSubagentTab: CodeSubagentTab | null;
  /** Lista de pull requests do workspace aberta como aba central. */
  codePullRequestsTab: CodePullRequestsTab | null;
  /** Pull requests abertos como abas centrais, na ordem de abertura. */
  codePullRequestTabs: CodePullRequestTab[];
  /** Aba ativa de pull request (`null` = nenhuma; sempre presente na lista). */
  codePullRequestTab: CodePullRequestTab | null;
  /** Lista de issues do workspace aberta como aba central. */
  codeIssuesTab: CodeIssuesTab | null;
  /** Issues abertas como abas centrais, na ordem de abertura. */
  codeIssueTabs: CodeIssueTab[];
  /** Aba ativa de issue (`null` = nenhuma; sempre presente na lista). */
  codeIssueTab: CodeIssueTab | null;
  /** Aba "Objetivo" aberta no centro (volátil, como a do plano). */
  codeGoalOpen: boolean;
  /** Diálogo de criação/edição do objetivo (`null` = fechado). */
  goalDialog: GoalDialogState | null;
  /** Quebra de linha dos arquivos — global, persistida e aplicada a todas as abas. */
  codeFileWrap: boolean;
  /** Aba central de histórico de commits (`null` = fechada). */
  codeCommitsTab: { workspaceId: string; revision: string | null } | null;
  /** Whether the Code layout shows its right panel (Arquivos/Alterações). */
  codePanelOpen: boolean;
  /** Active tab of the Code right panel (last selected when all tabs are closed). */
  codePanelTab: CodePanelTab;
  /** Subset of panel tabs currently open (middle click closes, "+" reopens). */
  codePanelOpenTabs: CodePanelTab[];
  /** Persisted order of the Code right panel tabs (drag-and-drop). */
  codePanelTabOrder: CodePanelTab[];
  /** Persisted order of the movable center tabs (sessions + center terminals). */
  codeTabOrder: string[];
  /** Whether the agent layout shows its right sidebar. */
  agentPanelOpen: boolean;
  /** Active tab of the agent right sidebar. */
  agentPanelTab: AgentPanelTab;
  /** Which panel owns the agent right dock (agent sidebar or workspace tools). */
  agentRightPanel: AgentRightPanel;
  /** Workspace ativo do layout Code (`null` = nenhum/nenhuma pasta aberta). */
  activeWorkspaceId: string | null;
  /**
   * Abas de sessão abertas por workspace (`workspaceId -> conversationIds`).
   * Persistido para o Code restaurar as abas ao reabrir o app (limitação da
   * fase 1 resolvida em docs/goals/code-harness/WORKBENCH.md §4).
   */
  openSessionsByWorkspace: Record<string, string[]>;
  sidebarOpen: boolean;
  /** Persisted width of the desktop sidebar, in px (docs/DESIGN.md §5). */
  sidebarWidth: number;
  settingsOpen: boolean;
  /** Active tab of the settings dialog, shared with the command palette. */
  settingsTab: SettingsTabId;
  modelPickerOpen: boolean;
  commandPaletteOpen: boolean;
  artifactPanelOpen: boolean;
  artifactPanelView: ArtifactPanelView;
  /** Side panel listing every source (citation) used in the conversation. */
  sourcesPanelOpen: boolean;
  /** Persisted width of the right side panel (artifacts/sources), in px. */
  sidePanelWidth: number;
  /** Persisted layout preference of the right side panel (see SidePanelMode). */
  sidePanelMode: SidePanelMode;
  activeView: MainView;
  /** Plugin page open in each layout (null = the layout's host page). */
  pluginPages: Record<LayoutMode, PluginPageTarget | null>;
  /** Plugin dock tab active in each layout (null = the host dock tab). */
  pluginDockTab: Record<LayoutMode, string | null>;
  /** Plugin sidebar content tab open in each layout (null = none). */
  pluginSidebarTab: Record<LayoutMode, string | null>;
  /** A takeover panel was explicitly dismissed in this layout. */
  pluginDockClosed: Record<LayoutMode, boolean>;
  activeArtifactId: string | null;
  artifacts: Artifact[];

  setTheme: (theme: ThemeMode) => void;
  /** Switches the whole application between the Chat, Code and Agentes layouts. */
  setLayoutMode: (mode: LayoutMode) => void;
  /**
   * Shows/hides a layout button. Refuses to hide the last enabled layout, and
   * moves the active layout to the first remaining one when the hidden layout
   * was the current one.
   */
  setLayoutEnabled: (mode: LayoutMode, enabled: boolean) => void;
  setActiveAgentId: (agentId: string | null) => void;
  setActiveChannelId: (channelId: string | null) => void;
  /** Switches the Agentes center between the team page, usage stats and routines. */
  setAgentView: (view: AgentView) => void;
  /** Opens the central routines page with an optional agent filter. */
  openAgentRoutines: (agentId: string | null) => void;
  setAgentRoutinesAgentId: (agentId: string | null) => void;
  openAgentEditor: (target: AgentEditorState) => void;
  closeAgentEditor: () => void;
  openAgentAvatarEditor: (agentId: string) => void;
  closeAgentAvatarEditor: () => void;
  /** Switches the Code center between the agent session and the Skills page. */
  setCodeView: (view: CodeView) => void;
  /** Abre o diff de um arquivo como aba central (codeView vira diff). */
  openCodeDiff: (target: CodeDiffTab) => void;
  /** Fecha a aba de diff; se ela era a ativa, volta para a sessão. */
  closeCodeDiff: () => void;
  /** Abre (ou ativa) o arquivo em uma aba central (acumula abas; codeView vira file). */
  openCodeFile: (target: CodeFileTab) => void;
  /**
   * Fecha a aba do arquivo (por padrão, a ativa). Se a aba fechada era a ativa,
   * ativa a vizinha; sem abas restantes, o centro volta para a sessão.
   */
  closeCodeFile: (target?: CodeFileTab) => void;
  /** Abre (ou atualiza) o plano aprovado em uma aba central (`codeView` vira plan). */
  openCodePlan: (target: CodePlanTab) => void;
  /** Fecha a aba do plano; se ela era a ativa, volta para a sessão. */
  closeCodePlan: () => void;
  /**
   * Opens a subagent chat tab. Returns `exists` (and focuses the existing tab)
   * when the same child conversation is already open.
   */
  openCodeSubagent: (target: CodeSubagentTab) => 'opened' | 'exists';
  /** Closes one subagent tab (default: the active one). */
  closeCodeSubagent: (target?: CodeSubagentTab) => void;
  /** Abre (ou ativa) a aba da lista de pull requests do workspace. */
  openCodePullRequests: (workspaceId: string) => void;
  /** Fecha a aba da lista de pull requests; volta para a sessão se era a ativa. */
  closeCodePullRequests: () => void;
  /** Abre (ou ativa) um pull request em uma aba central própria. */
  openCodePullRequest: (target: CodePullRequestTab) => void;
  /** Fecha a aba do PR (por padrão, a ativa) e ativa a vizinha. */
  closeCodePullRequest: (target?: CodePullRequestTab) => void;
  /** Abre (ou ativa) a aba da lista de issues do workspace. */
  openCodeIssues: (workspaceId: string) => void;
  /** Fecha a aba da lista de issues; volta para a sessão se era a ativa. */
  closeCodeIssues: () => void;
  /** Abre (ou ativa) uma issue em uma aba central própria. */
  openCodeIssue: (target: CodeIssueTab) => void;
  /** Fecha a aba da issue (por padrão, a ativa) e ativa a vizinha. */
  closeCodeIssue: (target?: CodeIssueTab) => void;
  /** Abre a aba central "Objetivo" (`codeView` vira goal). */
  openCodeGoal: () => void;
  /** Fecha a aba do objetivo; se ela era a ativa, volta para a sessão. */
  closeCodeGoal: () => void;
  /** Abre o diálogo de criação/edição do objetivo. */
  openGoalDialog: (target: GoalDialogState) => void;
  /** Fecha o diálogo do objetivo. */
  closeGoalDialog: () => void;
  /** Liga/desliga a quebra de linha de todas as abas de arquivo (persistida). */
  setCodeFileWrap: (enabled: boolean) => void;
  /** Abre a aba de histórico de commits (lista do workspace). */
  openCodeCommits: (workspaceId: string) => void;
  /** Mostra um commit (`null` volta para a lista). */
  selectCodeCommit: (revision: string | null) => void;
  /** Fecha a aba de commits; se ela era a ativa, volta para a sessão. */
  closeCodeCommits: () => void;
  setCodePanelOpen: (open: boolean) => void;
  toggleCodePanel: () => void;
  setCodePanelTab: (tab: CodePanelTab) => void;
  /** Opens (or activates) a Code right panel tab. */
  openCodePanelTab: (tab: CodePanelTab) => void;
  /** Closes a Code right panel tab, activating a neighbour when needed. */
  closeCodePanelTab: (tab: CodePanelTab) => void;
  /** Persists the drag-and-drop order of the Code right panel tabs. */
  setCodePanelTabOrder: (order: readonly CodePanelTab[]) => void;
  /** Persists the drag-and-drop order of the movable center tabs. */
  setCodeTabOrder: (order: readonly string[]) => void;
  setAgentPanelOpen: (open: boolean) => void;
  toggleAgentPanel: () => void;
  setAgentPanelTab: (tab: AgentPanelTab) => void;
  setAgentRightPanel: (panel: AgentRightPanel) => void;
  /** Define o workspace ativo do layout Code (persistido). */
  setActiveWorkspace: (workspaceId: string | null) => void;
  /** Abre (ou ativa) uma aba de sessão dentro de um workspace. */
  openWorkspaceSession: (workspaceId: string, conversationId: string) => void;
  /** Fecha uma aba de sessão; devolve o id vizinho sugerido (ou `null`). */
  closeWorkspaceSession: (workspaceId: string, conversationId: string) => string | null;
  /** Substitui a lista de abas de um workspace (sincronização com o backend). */
  setWorkspaceSessions: (workspaceId: string, conversationIds: string[]) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  /** Clamps to `SIDEBAR_WIDTH_MIN`…`SIDEBAR_WIDTH_MAX` and persists the width. */
  setSidebarWidth: (width: number) => void;
  /** Clamps to `SIDE_PANEL_WIDTH_MIN`…`SIDE_PANEL_WIDTH_MAX` and persists the width. */
  setSidePanelWidth: (width: number) => void;
  /** Persists the overlay/docked preference (responsive fallback lives in lib/sidePanel). */
  setSidePanelMode: (mode: SidePanelMode) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Opens the settings dialog, optionally jumping straight to a tab. */
  openSettings: (tab?: SettingsTabId) => void;
  setSettingsTab: (tab: SettingsTabId) => void;
  setModelPickerOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  /** Switches the main content between the chat and the skills manager. */
  setActiveView: (view: MainView) => void;
  /** Opens a plugin page in one layout (default: the active layout). */
  openPluginPage: (target: PluginPageTarget, layout?: LayoutMode) => void;
  /** Closes the plugin page of one layout (default: the active layout). */
  closePluginPage: (layout?: LayoutMode) => void;
  /** Opens a plugin dock tab in one layout (default: the active layout). */
  openPluginDockTab: (key: string, layout?: LayoutMode) => void;
  /** Closes the plugin dock tab of one layout (default: the active layout). */
  closePluginDockTab: (layout?: LayoutMode) => void;
  /** Dismisses a takeover panel for one layout (default: the active layout). */
  dismissPluginDockTakeover: (layout?: LayoutMode) => void;
  /** Opens/closes a plugin content tab inside a layout sidebar. */
  setPluginSidebarTab: (layout: LayoutMode, key: string | null) => void;
  /** Opens the panel on the artifact preview (or the list when there is none). */
  openArtifactPanel: (artifactId?: string | null) => void;
  /** Opens the panel on the generated-artifact list. */
  openArtifactList: () => void;
  closeArtifactPanel: () => void;
  setArtifactPanelView: (view: ArtifactPanelView) => void;
  /** Opens the side panel listing every source used in the conversation. */
  openSourcesPanel: () => void;
  closeSourcesPanel: () => void;
  setActiveArtifact: (artifactId: string | null) => void;
  setArtifacts: (artifacts: Artifact[]) => void;
  addArtifact: (artifact: Artifact) => void;
  closeAllOverlays: () => void;
  applyTheme: () => void;
}

/** Aba central aberta no centro (todas convivem na faixa de abas). */
type CentralCodeView = Extract<
  CodeView,
  | 'diff'
  | 'file'
  | 'commits'
  | 'plan'
  | 'goal'
  | 'subagent'
  | 'prs'
  | 'pr'
  | 'issues'
  | 'issue'
>;

/**
 * Fechar uma aba central em **segundo plano** (o usuário está lendo outra aba)
 * não pode puxar o centro para a sessão. A view só volta para `session` quando
 * a aba fechada era a que estava ativa; caso contrário, permanece na atual.
 */
function keepCenterViewUnlessActive(
  state: UiState,
  closed: CentralCodeView,
): Pick<UiState, 'codeView'> {
  return { codeView: state.codeView === closed ? 'session' : state.codeView };
}

/**
 * Canonical artifact order, identical to `db::list_artifacts`
 * (`ORDER BY created_at, id`). Keeping it here means the live events, the
 * backend reconciliation and the chat cards never disagree about the order.
 */
export function sortArtifacts(artifacts: Artifact[]): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const artifact of artifacts) byId.set(artifact.id, artifact);
  return [...byId.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveDark(theme: ThemeMode): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark());
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      layoutMode: 'chat',
      enabledLayouts: { ...DEFAULT_LAYOUT_VISIBILITY },
      activeAgentId: null,
      activeChannelId: null,
      agentView: 'team',
      agentRoutinesAgentId: null,
      agentEditor: null,
      agentAvatarEditor: null,
      codeView: 'session',
      codeDiffTab: null,
      codeFileTabs: [],
      codeFileTab: null,
      codePlanTab: null,
      codeSubagentTabs: [],
      codeSubagentTab: null,
      codePullRequestsTab: null,
      codePullRequestTabs: [],
      codePullRequestTab: null,
      codeIssuesTab: null,
      codeIssueTabs: [],
      codeIssueTab: null,
      codeGoalOpen: false,
      goalDialog: null,
      codeFileWrap: false,
      codeCommitsTab: null,
      codePanelOpen: true,
      codePanelTab: 'changes',
      codePanelOpenTabs: [...CODE_PANEL_TAB_ORDER_DEFAULT],
      codePanelTabOrder: [...CODE_PANEL_TAB_ORDER_DEFAULT],
      codeTabOrder: [],
      agentPanelOpen: true,
      agentPanelTab: 'screen',
      agentRightPanel: 'agent',
      activeWorkspaceId: null,
      openSessionsByWorkspace: {},
      sidebarOpen: true,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      settingsOpen: false,
      settingsTab: DEFAULT_SETTINGS_TAB,
      modelPickerOpen: false,
      commandPaletteOpen: false,
      artifactPanelOpen: false,
      artifactPanelView: 'list',
      sourcesPanelOpen: false,
      sidePanelWidth: SIDE_PANEL_WIDTH_DEFAULT,
      sidePanelMode: 'overlay',
      activeView: 'chat',
      pluginPages: { chat: null, code: null, agent: null },
      pluginSidebarTab: { chat: null, code: null, agent: null },
      pluginDockTab: { chat: null, code: null, agent: null },
      pluginDockClosed: { chat: false, code: false, agent: false },
      activeArtifactId: null,
      artifacts: [],

      setTheme: (theme) => {
        set({ theme });
        get().applyTheme();
      },
      setLayoutMode: (mode) => {
        const layoutMode: LayoutMode =
          mode === 'code' ? 'code' : mode === 'agent' ? 'agent' : 'chat';
        // A hidden layout is unreachable from every entry point (switch, palette,
        // notifications), so the pill never has to render an inactive segment.
        if (!get().enabledLayouts[layoutMode]) return;
        set({ layoutMode });
      },
      setLayoutEnabled: (mode, enabled) => {
        const { enabledLayouts, layoutMode } = get();
        if (enabledLayouts[mode] === enabled) return;
        const next = { ...enabledLayouts, [mode]: enabled };
        const remaining = enabledLayoutModes(next);
        // Never hide the last visible layout: the switcher would disappear and
        // Settings would be the only way back, with no active mode to fall to.
        if (remaining.length === 0) return;
        set({
          enabledLayouts: next,
          layoutMode:
            !enabled && layoutMode === mode ? (remaining[0] ?? 'chat') : layoutMode,
        });
      },
      setActiveAgentId: (activeAgentId) =>
        set((state) => ({
          activeAgentId,
          activeChannelId: activeAgentId ? null : state.activeChannelId,
          agentView: activeAgentId ? 'team' : state.agentView,
        })),
      setActiveChannelId: (activeChannelId) =>
        set((state) => ({
          activeChannelId,
          activeAgentId: activeChannelId ? null : state.activeAgentId,
          agentView: activeChannelId ? 'team' : state.agentView,
        })),
      setAgentView: (agentView) =>
        set((state) => ({
          agentView,
          pluginPages: { ...state.pluginPages, agent: null },
        })),
      openAgentRoutines: (agentRoutinesAgentId) =>
        set({ agentView: 'routines', agentRoutinesAgentId }),
      setAgentRoutinesAgentId: (agentRoutinesAgentId) => set({ agentRoutinesAgentId }),
      openAgentEditor: (agentEditor) => set({ agentEditor }),
      closeAgentEditor: () => set({ agentEditor: null }),
      openAgentAvatarEditor: (agentAvatarEditor) => set({ agentAvatarEditor }),
      closeAgentAvatarEditor: () => set({ agentAvatarEditor: null }),
      setCodeView: (codeView) =>
        set((state) => ({
          codeView: CODE_VIEWS.includes(codeView) ? codeView : 'session',
          pluginPages: { ...state.pluginPages, code: null },
        })),
      openCodeDiff: (codeDiffTab) => set({ codeDiffTab, codeView: 'diff' }),
      closeCodeDiff: () =>
        set((state) => ({ codeDiffTab: null, ...keepCenterViewUnlessActive(state, 'diff') })),
      openCodeFile: (target) =>
        set((state) => {
          const key = codeFileTabKey(target);
          const alreadyOpen = state.codeFileTabs.some((tab) => codeFileTabKey(tab) === key);
          return {
            /* Abrir outro arquivo ADICIONA uma aba (não substitui a atual); abrir
               um arquivo já aberto apenas o ativa. */
            codeFileTabs: alreadyOpen ? state.codeFileTabs : [...state.codeFileTabs, target],
            codeFileTab: target,
            codeView: 'file',
          };
        }),
      closeCodeFile: (target) =>
        set((state) => {
          const closing = target ?? state.codeFileTab;
          if (!closing) return {};
          const closingKey = codeFileTabKey(closing);
          const index = state.codeFileTabs.findIndex((tab) => codeFileTabKey(tab) === closingKey);
          if (index < 0) return {};
          const remaining = state.codeFileTabs.filter((_, tabIndex) => tabIndex !== index);
          const activeKey = state.codeFileTab ? codeFileTabKey(state.codeFileTab) : null;
          if (activeKey !== closingKey) {
            /* Aba em segundo plano: mantém a ativa e a view atual. */
            return { codeFileTabs: remaining };
          }
          /* Aba ativa: vizinha da direita e, na falta dela, a da esquerda. */
          const neighbor = remaining[Math.min(index, remaining.length - 1)] ?? null;
          return {
            codeFileTabs: remaining,
            codeFileTab: neighbor,
            codeView: neighbor === null && state.codeView === 'file' ? 'session' : state.codeView,
          };
        }),
      openCodePlan: (target) =>
        set({
          codePlanTab: {
            ...target,
            markdown: target.markdown,
          },
          codeView: 'plan',
        }),
      closeCodePlan: () =>
        set((state) => ({ codePlanTab: null, ...keepCenterViewUnlessActive(state, 'plan') })),
      openCodeSubagent: (target) => {
        const key = codeSubagentTabKey(target);
        if (!key) return 'exists';
        const existing = get().codeSubagentTabs.find(
          (tab) => codeSubagentTabKey(tab) === key,
        );
        if (existing) {
          const updated: CodeSubagentTab = {
            ...existing,
            ...target,
            taskCallId: target.taskCallId || existing.taskCallId,
            subagentType: target.subagentType || existing.subagentType,
            description: target.description || existing.description,
            providerId: target.providerId ?? existing.providerId,
            modelId: target.modelId ?? existing.modelId,
            effort: target.effort ?? existing.effort,
            prompt: target.prompt ?? existing.prompt,
          };
          set((state) => ({
            codeSubagentTabs: state.codeSubagentTabs.map((tab) =>
              codeSubagentTabKey(tab) === key ? updated : tab,
            ),
            codeSubagentTab: updated,
            codeView: 'subagent',
          }));
          return 'exists';
        }
        set((state) => ({
          codeSubagentTabs: [...state.codeSubagentTabs, target],
          codeSubagentTab: target,
          codeView: 'subagent',
        }));
        return 'opened';
      },
      closeCodeSubagent: (target) =>
        set((state) => {
          const closing = target ?? state.codeSubagentTab;
          if (!closing) return {};
          const closingKey = codeSubagentTabKey(closing);
          const index = state.codeSubagentTabs.findIndex(
            (tab) => codeSubagentTabKey(tab) === closingKey,
          );
          if (index < 0) return {};
          const remaining = state.codeSubagentTabs.filter(
            (_, tabIndex) => tabIndex !== index,
          );
          const activeKey = state.codeSubagentTab
            ? codeSubagentTabKey(state.codeSubagentTab)
            : null;
          if (activeKey !== closingKey) {
            return { codeSubagentTabs: remaining };
          }
          const neighbor = remaining[Math.min(index, remaining.length - 1)] ?? null;
          return {
            codeSubagentTabs: remaining,
            codeSubagentTab: neighbor,
            codeView:
              neighbor === null && state.codeView === 'subagent'
                ? 'session'
                : state.codeView,
          };
        }),
      openCodePullRequests: (workspaceId) =>
        set({ codePullRequestsTab: { workspaceId }, codeView: 'prs' }),
      closeCodePullRequests: () =>
        set((state) => ({
          codePullRequestsTab: null,
          ...keepCenterViewUnlessActive(state, 'prs'),
        })),
      openCodePullRequest: (target) =>
        set((state) => {
          const key = codeRepoItemTabKey(target);
          const alreadyOpen = state.codePullRequestTabs.some(
            (tab) => codeRepoItemTabKey(tab) === key,
          );
          return {
            codePullRequestTabs: alreadyOpen
              ? state.codePullRequestTabs.map((tab) =>
                  codeRepoItemTabKey(tab) === key ? target : tab,
                )
              : [...state.codePullRequestTabs, target],
            codePullRequestTab: target,
            codeView: 'pr',
          };
        }),
      closeCodePullRequest: (target) =>
        set((state) => {
          const closing = target ?? state.codePullRequestTab;
          if (!closing) return {};
          const closingKey = codeRepoItemTabKey(closing);
          const index = state.codePullRequestTabs.findIndex(
            (tab) => codeRepoItemTabKey(tab) === closingKey,
          );
          if (index < 0) return {};
          const remaining = state.codePullRequestTabs.filter(
            (_, tabIndex) => tabIndex !== index,
          );
          const activeKey = state.codePullRequestTab
            ? codeRepoItemTabKey(state.codePullRequestTab)
            : null;
          if (activeKey !== closingKey) {
            return { codePullRequestTabs: remaining };
          }
          const neighbor = remaining[Math.min(index, remaining.length - 1)] ?? null;
          return {
            codePullRequestTabs: remaining,
            codePullRequestTab: neighbor,
            codeView:
              neighbor === null && state.codeView === 'pr' ? 'session' : state.codeView,
          };
        }),
      openCodeIssues: (workspaceId) =>
        set({ codeIssuesTab: { workspaceId }, codeView: 'issues' }),
      closeCodeIssues: () =>
        set((state) => ({
          codeIssuesTab: null,
          ...keepCenterViewUnlessActive(state, 'issues'),
        })),
      openCodeIssue: (target) =>
        set((state) => {
          const key = codeRepoItemTabKey(target);
          const alreadyOpen = state.codeIssueTabs.some(
            (tab) => codeRepoItemTabKey(tab) === key,
          );
          return {
            codeIssueTabs: alreadyOpen
              ? state.codeIssueTabs.map((tab) =>
                  codeRepoItemTabKey(tab) === key ? target : tab,
                )
              : [...state.codeIssueTabs, target],
            codeIssueTab: target,
            codeView: 'issue',
          };
        }),
      closeCodeIssue: (target) =>
        set((state) => {
          const closing = target ?? state.codeIssueTab;
          if (!closing) return {};
          const closingKey = codeRepoItemTabKey(closing);
          const index = state.codeIssueTabs.findIndex(
            (tab) => codeRepoItemTabKey(tab) === closingKey,
          );
          if (index < 0) return {};
          const remaining = state.codeIssueTabs.filter((_, tabIndex) => tabIndex !== index);
          const activeKey = state.codeIssueTab ? codeRepoItemTabKey(state.codeIssueTab) : null;
          if (activeKey !== closingKey) {
            return { codeIssueTabs: remaining };
          }
          const neighbor = remaining[Math.min(index, remaining.length - 1)] ?? null;
          return {
            codeIssueTabs: remaining,
            codeIssueTab: neighbor,
            codeView:
              neighbor === null && state.codeView === 'issue' ? 'session' : state.codeView,
          };
        }),
      openCodeGoal: () => set({ codeGoalOpen: true, codeView: 'goal' }),
      closeCodeGoal: () =>
        set((state) => ({ codeGoalOpen: false, ...keepCenterViewUnlessActive(state, 'goal') })),
      openGoalDialog: (goalDialog) => set({ goalDialog }),
      closeGoalDialog: () => set({ goalDialog: null }),
      setCodeFileWrap: (codeFileWrap) => set({ codeFileWrap }),
      openCodeCommits: (workspaceId) =>
        set({ codeCommitsTab: { workspaceId, revision: null }, codeView: 'commits' }),
      selectCodeCommit: (revision) =>
        set((state) => ({
          codeCommitsTab: state.codeCommitsTab
            ? { ...state.codeCommitsTab, revision }
            : state.codeCommitsTab,
          codeView: 'commits',
        })),
      closeCodeCommits: () =>
        set((state) => ({ codeCommitsTab: null, ...keepCenterViewUnlessActive(state, 'commits') })),
      setCodePanelOpen: (codePanelOpen) => set({ codePanelOpen }),
      toggleCodePanel: () => set((state) => ({ codePanelOpen: !state.codePanelOpen })),
      setCodePanelTab: (tab) => get().openCodePanelTab(tab),
      openCodePanelTab: (tab) =>
        set((state) => {
          const target: CodePanelTab =
            tab === 'files' || tab === 'terminal' ? tab : 'changes';
          const openTabs = state.codePanelOpenTabs.includes(target)
            ? state.codePanelOpenTabs
            : [...state.codePanelOpenTabs, target].sort(
                (a, b) =>
                  state.codePanelTabOrder.indexOf(a) - state.codePanelTabOrder.indexOf(b),
              );
          return {
            codePanelOpenTabs: openTabs,
            codePanelTab: target,
            pluginDockTab: { ...state.pluginDockTab, code: null },
            pluginPages: { ...state.pluginPages, code: null },
          };
        }),
      closeCodePanelTab: (tab) =>
        set((state) => {
          const target: CodePanelTab =
            tab === 'files' || tab === 'terminal' ? tab : 'changes';
          const openTabs = state.codePanelOpenTabs.filter((entry) => entry !== target);
          const active =
            state.codePanelTab === target
              ? neighbourCodePanelTab(state.codePanelTabOrder, state.codePanelOpenTabs, target) ??
                state.codePanelTab
              : state.codePanelTab;
          return { codePanelOpenTabs: openTabs, codePanelTab: active };
        }),
      setCodePanelTabOrder: (order) =>
        set({ codePanelTabOrder: normalizeCodePanelTabOrder(order) }),
      setCodeTabOrder: (order) => set({ codeTabOrder: normalizeTabOrder(order) }),
      setAgentPanelOpen: (agentPanelOpen) => set({ agentPanelOpen }),
      toggleAgentPanel: () => set((state) => ({ agentPanelOpen: !state.agentPanelOpen })),
      setAgentPanelTab: (agentPanelTab) =>
        set((state) => ({
          agentPanelTab: ['screen', 'routines', 'browser', 'data'].includes(agentPanelTab)
            ? agentPanelTab
            : 'screen',
          pluginDockTab: { ...state.pluginDockTab, agent: null },
          pluginPages: { ...state.pluginPages, agent: null },
        })),
      setAgentRightPanel: (agentRightPanel) =>
        set((state) => ({
          agentRightPanel: agentRightPanel === 'workspace' ? 'workspace' : 'agent',
          pluginPages: { ...state.pluginPages, agent: null },
        })),
      setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),
      openWorkspaceSession: (workspaceId, conversationId) =>
        set((state) => {
          const current = state.openSessionsByWorkspace[workspaceId] ?? [];
          const next = current.includes(conversationId) ? current : [...current, conversationId];
          return {
            openSessionsByWorkspace: { ...state.openSessionsByWorkspace, [workspaceId]: next },
          };
        }),
      closeWorkspaceSession: (workspaceId, conversationId) => {
        const state = get();
        const current = state.openSessionsByWorkspace[workspaceId] ?? [];
        const index = current.indexOf(conversationId);
        if (index < 0) return null;
        const next = current.filter((id) => id !== conversationId);
        const neighbor = next[Math.min(index, next.length - 1)] ?? null;
        set({
          openSessionsByWorkspace: { ...state.openSessionsByWorkspace, [workspaceId]: next },
        });
        return neighbor;
      },
      setWorkspaceSessions: (workspaceId, conversationIds) =>
        set((state) => ({
          openSessionsByWorkspace: {
            ...state.openSessionsByWorkspace,
            [workspaceId]: [...new Set(conversationIds)],
          },
        })),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth: clampSidebarWidth(sidebarWidth) }),
      setSidePanelWidth: (sidePanelWidth) => set({ sidePanelWidth: clampSidePanelWidth(sidePanelWidth) }),
      setSidePanelMode: (sidePanelMode) => set({ sidePanelMode }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      openSettings: (tab) =>
        set((state) => ({
          settingsOpen: true,
          settingsTab: tab && isSettingsTabId(tab) ? tab : state.settingsTab,
        })),
      setSettingsTab: (settingsTab) =>
        set({ settingsTab: isSettingsTabId(settingsTab) ? settingsTab : DEFAULT_SETTINGS_TAB }),
      setModelPickerOpen: (modelPickerOpen) => set({ modelPickerOpen }),
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      setActiveView: (activeView) =>
        set((state) => ({
          activeView,
          pluginPages: { ...state.pluginPages, chat: null },
        })),
      openPluginPage: (target, layout) =>
        set((state) => {
          const targetLayout = layout ?? state.layoutMode;
          return {
            pluginPages: { ...state.pluginPages, [targetLayout]: target },
          };
        }),
      closePluginPage: (layout) =>
        set((state) => {
          const targetLayout = layout ?? state.layoutMode;
          return {
            pluginPages: { ...state.pluginPages, [targetLayout]: null },
          };
        }),
      openPluginDockTab: (key, layout) =>
        set((state) => {
          const targetLayout = layout ?? state.layoutMode;
          const pluginDockTab = { ...state.pluginDockTab, [targetLayout]: key };
          const pluginDockClosed = {
            ...state.pluginDockClosed,
            [targetLayout]: false,
          };
          if (targetLayout === 'chat') {
            return { pluginDockTab, pluginDockClosed, artifactPanelOpen: true, sourcesPanelOpen: false };
          }
          if (targetLayout === 'code') return { pluginDockTab, pluginDockClosed, codePanelOpen: true };
          return { pluginDockTab, pluginDockClosed, agentPanelOpen: true, agentRightPanel: 'agent' };
        }),
      closePluginDockTab: (layout) =>
        set((state) => {
          const targetLayout = layout ?? state.layoutMode;
          return {
            pluginDockTab: { ...state.pluginDockTab, [targetLayout]: null },
          };
        }),
      setPluginSidebarTab: (layout, key) =>
        set((state) => ({
          pluginSidebarTab: { ...state.pluginSidebarTab, [layout]: key },
        })),
      dismissPluginDockTakeover: (layout) =>
        set((state) => {
          const targetLayout = layout ?? state.layoutMode;
          return {
            pluginDockClosed: { ...state.pluginDockClosed, [targetLayout]: true },
          };
        }),
      openArtifactPanel: (artifactId) =>
        set((state) => {
          const active = (typeof artifactId === 'string' ? artifactId : null) ?? state.activeArtifactId;
          const pluginDockTab = { ...state.pluginDockTab, chat: null };
          if (active) {
            return { artifactPanelOpen: true, artifactPanelView: 'preview', activeArtifactId: active, sourcesPanelOpen: false, pluginDockTab };
          }
          return { artifactPanelOpen: true, artifactPanelView: 'list', sourcesPanelOpen: false, pluginDockTab };
        }),
      openArtifactList: () =>
        set((state) => ({
          artifactPanelOpen: true,
          artifactPanelView: 'list',
          sourcesPanelOpen: false,
          pluginDockTab: { ...state.pluginDockTab, chat: null },
        })),
      closeArtifactPanel: () => set({ artifactPanelOpen: false }),
      openSourcesPanel: () =>
        set((state) => ({
          sourcesPanelOpen: true,
          artifactPanelOpen: false,
          pluginDockTab: { ...state.pluginDockTab, chat: null },
        })),
      closeSourcesPanel: () => set({ sourcesPanelOpen: false }),
      setArtifactPanelView: (view) =>
        set((state) => {
          if (view === 'list') return { artifactPanelView: 'list' };
          const active =
            state.artifacts.find((artifact) => artifact.id === state.activeArtifactId) ??
            state.artifacts[state.artifacts.length - 1];
          if (!active) return { artifactPanelView: 'list' };
          return { artifactPanelView: 'preview', activeArtifactId: active.id };
        }),
      setActiveArtifact: (activeArtifactId) =>
        set((state) => {
          if (!activeArtifactId) {
            return { activeArtifactId: null, artifactPanelView: 'list', artifactPanelOpen: state.artifactPanelOpen };
          }
          return { activeArtifactId, artifactPanelOpen: true, artifactPanelView: 'preview', sourcesPanelOpen: false };
        }),
      setArtifacts: (artifacts) =>
        set((state) => {
          const next = sortArtifacts(artifacts);
          const activeArtifactId =
            state.activeArtifactId && next.some((artifact) => artifact.id === state.activeArtifactId)
              ? state.activeArtifactId
              : null;
          // A preview whose artifact disappeared falls back to the list, so the
          // panel never stays on a stale/removed artifact.
          const artifactPanelView =
            state.artifactPanelView === 'preview' && !activeArtifactId
              ? 'list'
              : state.artifactPanelView;
          return { artifacts: next, activeArtifactId, artifactPanelView };
        }),
      addArtifact: (artifact) =>
        set((state) => ({
          artifacts: sortArtifacts([...state.artifacts, artifact]),
        })),
      closeAllOverlays: () =>
        set({
          settingsOpen: false,
          modelPickerOpen: false,
          commandPaletteOpen: false,
          sourcesPanelOpen: false,
          goalDialog: null,
        }),
      applyTheme: () => {
        applyThemeMode(resolveDark(get().theme));
      },
    }),
    {
      name: 'zylara.ui',
      partialize: (state) => ({
        theme: state.theme,
        layoutMode: state.layoutMode,
        enabledLayouts: state.enabledLayouts,
        activeAgentId: state.activeAgentId,
        activeChannelId: state.activeChannelId,
        codePanelOpen: state.codePanelOpen,
        codePanelOpenTabs: state.codePanelOpenTabs,
        codePanelTabOrder: state.codePanelTabOrder,
        codeTabOrder: state.codeTabOrder,
        agentPanelOpen: state.agentPanelOpen,
        agentPanelTab: state.agentPanelTab,
        agentRightPanel: state.agentRightPanel,
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        sidePanelWidth: state.sidePanelWidth,
        sidePanelMode: state.sidePanelMode,
        activeWorkspaceId: state.activeWorkspaceId,
        openSessionsByWorkspace: state.openSessionsByWorkspace,
        codeFileWrap: state.codeFileWrap,
        pluginPages: state.pluginPages,
        pluginDockTab: state.pluginDockTab,
      }),
      /**
       * Rehydrated layouts may carry an out-of-range width (manually edited
       * storage, older versions, future bounds). Clamp on merge so the first
       * paint already uses a sane value instead of waiting for the next drag.
       */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<UiState>;
        const validWorkspaceId = (value: unknown): string | null =>
          typeof value === 'string' && value.trim().length > 0 ? value : null;
        const validSessions = (value: unknown): Record<string, string[]> => {
          if (!value || typeof value !== 'object') return {};
          const mapped: Record<string, string[]> = {};
          for (const [workspaceId, ids] of Object.entries(value as Record<string, unknown>)) {
            if (!Array.isArray(ids)) continue;
            const clean = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (clean.length > 0) mapped[workspaceId] = [...new Set(clean)];
          }
          return mapped;
        };
        const enabledLayouts = sanitizeLayoutVisibility(stored.enabledLayouts);
        const codePanelOpenTabs = normalizeCodePanelOpenTabs(stored.codePanelOpenTabs);
        const codePanelTab =
          codePanelOpenTabs.length > 0 && !codePanelOpenTabs.includes(current.codePanelTab)
            ? codePanelOpenTabs[0] ?? current.codePanelTab
            : current.codePanelTab;
        const storedLayoutMode: LayoutMode =
          stored.layoutMode === 'code'
            ? 'code'
            : stored.layoutMode === 'agent'
              ? 'agent'
              : 'chat';
        return {
          ...current,
          ...stored,
          layoutMode: enabledLayouts[storedLayoutMode]
            ? storedLayoutMode
            : firstEnabledLayout(enabledLayouts),
          enabledLayouts,
          activeAgentId: validWorkspaceId(stored.activeChannelId)
            ? null
            : validWorkspaceId(stored.activeAgentId),
          activeChannelId: validWorkspaceId(stored.activeChannelId),
          codePanelOpen:
            typeof stored.codePanelOpen === 'boolean' ? stored.codePanelOpen : current.codePanelOpen,
          codePanelTab,
          codePanelOpenTabs,
          codePanelTabOrder: normalizeCodePanelTabOrder(stored.codePanelTabOrder),
          codeTabOrder: normalizeTabOrder(stored.codeTabOrder),
          agentPanelOpen:
            typeof stored.agentPanelOpen === 'boolean'
              ? stored.agentPanelOpen
              : current.agentPanelOpen,
          agentPanelTab: ['screen', 'routines', 'browser', 'data'].includes(
            stored.agentPanelTab as string,
          )
            ? (stored.agentPanelTab as AgentPanelTab)
            : current.agentPanelTab,
          agentRightPanel:
            stored.agentRightPanel === 'workspace' ? 'workspace' : current.agentRightPanel,
          sidebarWidth: clampSidebarWidth(stored.sidebarWidth ?? current.sidebarWidth),
          sidePanelWidth: clampSidePanelWidth(stored.sidePanelWidth ?? current.sidePanelWidth),
          sidePanelMode: stored.sidePanelMode === 'docked' ? 'docked' : 'overlay',
          activeWorkspaceId: validWorkspaceId(stored.activeWorkspaceId),
          openSessionsByWorkspace: validSessions(stored.openSessionsByWorkspace),
          codeFileWrap:
            typeof stored.codeFileWrap === 'boolean' ? stored.codeFileWrap : current.codeFileWrap,
        };
      },
    },
  ),
);

/**
 * The artifact and sources panels share the same surface, so both can never be
 * visible at once: in the docked layout that renders two columns side by side
 * and squeezes the chat between them. Every store action already closes the
 * sibling panel; this guard keeps the invariant even if the state is mutated
 * from somewhere else (stale HMR module, devtools, a future action that forgets
 * the rule). Keep whichever panel was opened last, or close the artifact panel
 * when both were already open.
 */
useUiStore.subscribe((state, previous) => {
  if (!state.artifactPanelOpen || !state.sourcesPanelOpen) return;
  const sourcesJustOpened = !previous.sourcesPanelOpen;
  useUiStore.setState(
    sourcesJustOpened ? { artifactPanelOpen: false } : { sourcesPanelOpen: false },
  );
});
