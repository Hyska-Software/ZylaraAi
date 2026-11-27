/**
 * View model for the chat "thinking timeline" (agent steps).
 *
 * The harness persists a compact trace (`ChatMessage.trace`): one entry per
 * agent-loop step with the reasoning it produced and how many tool calls it
 * requested. Tool calls themselves live in `ChatMessage.toolCalls`, in
 * chronological order, so the timeline can be rebuilt exactly after a reload.
 *
 * Messages created before the trace existed fall back to a single block with
 * the whole persisted reasoning, followed by adjacent tool calls grouped by
 * tool.
 *
 * Reasoning is kept as the **raw Markdown** emitted by the model: one entry per
 * step, trimmed only at the edges. It is rendered by `Markdown` with
 * `variant="thinking"` (docs/MARKDOWN.md §4), so splitting paragraphs or
 * stripping list markers here would corrupt lists, fences, tables and math.
 */
import { t } from './i18n';
import type { ChatMessage, ToolCallRecord, TraceStep } from './types';
import { hostnameOf, safeJsonParse, truncate } from './utils';

export interface PageLink {
  title: string;
  url: string;
}

export type ToolGroupStatus = 'running' | 'done' | 'error';

/** One visual row of tool activity inside the timeline. */
export interface ToolGroup {
  name: string;
  tools: ToolCallRecord[];
  status: ToolGroupStatus;
  /** Human readable row label, e.g. "Encontrou 8 páginas web". */
  label: string;
  /** Result count behind the label (search results, pages, files, …). */
  total: number;
  /** Domains found by `web_search` (rendered as source avatars). */
  domains: string[];
  /** Pages opened by `fetch_url` (rendered as link chips). */
  pages: PageLink[];
  /** Artifact names created by `create_file`. */
  files: string[];
  /** Readable error messages of the calls that failed. */
  errors: string[];
}

export type AgentTraceEntry =
  | { kind: 'reasoning'; text: string; durationMs?: number | null }
  | { kind: 'tools'; group: ToolGroup };

const MAX_ERROR_CHARS = 220;

/**
 * Builds the ordered timeline of reasoning blocks and tool groups for one
 * assistant message.
 *
 * Each trace step produces **one** `reasoning` entry with its raw Markdown
 * (trimmed only at the edges), followed by the tool groups of the calls that
 * step requested. The reasoning text must stay byte-identical between renders:
 * `Markdown` is memoized on `content`.
 */
export function buildAgentTrace(
  message: Pick<ChatMessage, 'reasoning' | 'toolCalls' | 'trace'>,
): AgentTraceEntry[] {
  const tools = message.toolCalls ?? [];
  const steps = message.trace ?? [];
  const entries: AgentTraceEntry[] = [];
  let cursor = 0;

  if (steps.length > 0) {
    for (const step of steps) {
      const reasoning = step.reasoning?.trim() ?? '';
      if (reasoning) {
        entries.push({
          kind: 'reasoning',
          text: reasoning,
          durationMs: step.durationMs ?? null,
        });
      }
      const count = Math.max(0, Math.floor(step.toolCalls ?? 0));
      const stepTools = tools.slice(cursor, cursor + count);
      cursor += count;
      pushToolGroups(entries, stepTools);
    }
  } else {
    // Legacy messages (persisted before the trace contract) have no step
    // boundaries: the whole reasoning is a single Markdown block.
    const reasoning = message.reasoning?.trim() ?? '';
    if (reasoning) entries.push({ kind: 'reasoning', text: reasoning });
    pushToolGroups(entries, tools);
    cursor = tools.length;
  }

  // Defensive: calls the trace did not account for must never disappear.
  if (cursor < tools.length) pushToolGroups(entries, tools.slice(cursor));

  return entries;
}

/** Total number of tool calls rendered by the timeline. */
export function countTraceTools(entries: AgentTraceEntry[]): number {
  return entries.reduce(
    (total, entry) => (entry.kind === 'tools' ? total + entry.group.tools.length : total),
    0,
  );
}

/** One rendered row of the compact, scrollable Chat turn view. */
export type CompactTurnRow =
  | {
      id: string;
      kind: 'reasoning';
      /** Raw Markdown, kept so expanding the row still shows the full step. */
      text: string;
      /** Existing localized verb/activity phrase — never a new tool name. */
      label: string;
      /** One-line preview used by the compact row. */
      detail: string | null;
    }
  | {
      id: string;
      kind: 'tool';
      /** Full record so plugin slots receive the same owner as the detailed view. */
      tool: ToolCallRecord;
      toolName: string;
      /** Verb only, for the compact row header. */
      verb: string;
      /** Full existing label (verb + detail), used for accessibility. */
      label: string;
      detail: string | null;
      status: ToolCallRecord['status'];
    };

/** Call counts behind the compact Chat header. Reasoning is not a tool call. */
export interface CompactTurnSummary {
  commands: number;
  reads: number;
  searches: number;
  other: number;
}

const COMPACT_COMMAND_TOOLS = new Set(['run_command']);
const COMPACT_READ_TOOLS = new Set(['read_file', 'read_tool_output']);
const COMPACT_SEARCH_TOOLS = new Set(['web_search', 'search_files', 'search_text']);

/**
 * Flattens a trace into one row per reasoning block and per tool call, in the
 * original order. Adjacent groups are expanded so every action stays visible in
 * the scrollable list; no result page or output is counted here.
 */
export function buildCompactTurnRows(entries: AgentTraceEntry[]): CompactTurnRow[] {
  const rows: CompactTurnRow[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'reasoning') {
      rows.push({
        id: `reasoning-${index}`,
        kind: 'reasoning',
        text: entry.text,
        label: t('chat:trace.thought'),
        detail: oneLinePreview(entry.text, 96),
      });
      return;
    }
    for (const tool of entry.group.tools) {
      const meta = describeCodeTool(tool);
      const verb = meta.detail ? meta.verb : toolActivityLabel(tool.name);
      const detail = meta.detail ?? toolPreview(tool);
      rows.push({
        id: tool.id,
        kind: 'tool',
        tool,
        toolName: tool.name,
        verb,
        label: meta.detail ? meta.label : verb,
        detail,
        status: tool.status,
      });
    }
  });
  return rows;
}

/** Counts tool calls by family for the finished compact header. */
export function summarizeCompactTurn(entries: AgentTraceEntry[]): CompactTurnSummary {
  const summary: CompactTurnSummary = { commands: 0, reads: 0, searches: 0, other: 0 };
  for (const entry of entries) {
    if (entry.kind !== 'tools') continue;
    for (const tool of entry.group.tools) {
      if (COMPACT_COMMAND_TOOLS.has(tool.name)) summary.commands += 1;
      else if (COMPACT_READ_TOOLS.has(tool.name)) summary.reads += 1;
      else if (COMPACT_SEARCH_TOOLS.has(tool.name)) summary.searches += 1;
      else summary.other += 1;
    }
  }
  return summary;
}

/** True when the timeline has at least one reasoning block. */
export function hasTraceReasoning(entries: AgentTraceEntry[]): boolean {
  return entries.some((entry) => entry.kind === 'reasoning');
}

/** True when the trace carries narration from intermediate steps. */
export function hasTraceText(trace?: TraceStep[] | null): boolean {
  return (trace ?? []).some((step) => (step.text?.trim() ?? '').length > 0);
}

/**
 * One block of the per-response transcript (layouts Code and Agentes): either
 * the model's narration, rendered as normal Markdown in the message body, or
 * the execution that happened after it (reasoning + tool calls), rendered as a
 * collapsed activity line.
 */
export type AgentResponseBlock =
  | { kind: 'text'; text: string }
  | { kind: 'execution'; entries: AgentTraceEntry[]; durationMs: number };

/**
 * Builds the chronological blocks of an assistant turn, splitting the trace at
 * every intermediate narration. Entries accumulate until a narration arrives,
 * so each text is followed by the work done before the next one. The final
 * answer text is not part of the trace and stays in `ChatMessage.content`.
 *
 * Each execution block also carries the work time of its stretch: the model
 * time of its steps plus the execution time of its tool calls (used by the
 * finished "Trabalhou por …" line). A step's provider time belongs to the
 * stretch that produced it — before its narration — even when the model did
 * not expose reasoning; only the tool calls it requested run after the text.
 */
export function buildAgentResponseBlocks(
  message: Pick<ChatMessage, 'reasoning' | 'toolCalls' | 'trace'>,
): AgentResponseBlock[] {
  const tools = message.toolCalls ?? [];
  const steps = message.trace ?? [];
  const blocks: AgentResponseBlock[] = [];
  let pending: AgentTraceEntry[] = [];
  let pendingDuration = 0;
  let cursor = 0;

  const flush = () => {
    // A step that only narrated (hidden reasoning) still spent model time;
    // keep it as an execution block even when it has no visible rows.
    if (pending.length > 0 || pendingDuration > 0) {
      blocks.push({ kind: 'execution', entries: pending, durationMs: pendingDuration });
    }
    pending = [];
    pendingDuration = 0;
  };

  for (const step of steps) {
    const stepDuration = Math.max(0, step.durationMs ?? 0);
    let credited = false;
    const reasoning = step.reasoning?.trim() ?? '';
    if (reasoning) {
      pending.push({
        kind: 'reasoning',
        text: reasoning,
        durationMs: step.durationMs ?? null,
      });
      pendingDuration += stepDuration;
      credited = true;
    }
    const text = step.text?.trim() ?? '';
    if (text) {
      // The provider time of this step produced the narration, so it belongs
      // to the stretch before it, not to the tools that run afterwards.
      if (!credited) {
        pendingDuration += stepDuration;
        credited = true;
      }
      flush();
      blocks.push({ kind: 'text', text });
    }
    const count = Math.max(0, Math.floor(step.toolCalls ?? 0));
    const stepTools = tools.slice(cursor, cursor + count);
    cursor += count;
    if (stepTools.length > 0) {
      if (!credited) pendingDuration += stepDuration;
      for (const group of groupTools(stepTools)) {
        pending.push({ kind: 'tools', group });
        for (const tool of group.tools) pendingDuration += toolExecutionMs(tool);
      }
    }
  }

  // Defensive: calls the trace did not account for must never disappear.
  for (const group of groupTools(tools.slice(cursor))) {
    pending.push({ kind: 'tools', group });
    for (const tool of group.tools) pendingDuration += toolExecutionMs(tool);
  }
  flush();

  return blocks;
}

/** Time the tool itself ran (start → finish), when both ends are known. */
function toolExecutionMs(tool: ToolCallRecord): number {
  if (tool.startedAt == null || tool.finishedAt == null) return 0;
  return Math.max(0, tool.finishedAt - tool.startedAt);
}

/** Short tool family keys used by the live activity fallback. */
const TOOL_FAMILY_KEYS: Record<string, string> = {
  run_command: 'chat:trace.families.shell',
  run_checks: 'chat:trace.families.checks',
  read_file: 'chat:trace.families.read',
  read_tool_output: 'chat:trace.families.read',
  list_dir: 'chat:trace.families.list',
  search_files: 'chat:trace.families.search',
  search_text: 'chat:trace.families.search',
  write_file: 'chat:trace.families.edit',
  edit_file: 'chat:trace.families.edit',
  todo_write: 'chat:trace.families.tasks',
  submit_plan: 'chat:trace.families.plan',
  ask_user: 'chat:trace.families.question',
  task: 'chat:trace.families.subagent',
  job_list: 'chat:trace.families.jobs',
  job_output: 'chat:trace.families.jobs',
  job_kill: 'chat:trace.families.jobs',
  git_status: 'chat:trace.families.git',
  git_diff: 'chat:trace.families.git',
  git_log: 'chat:trace.families.git',
  goal: 'chat:trace.families.goal',
  validate_ui: 'chat:trace.families.ui',
  web_search: 'chat:trace.families.web',
  fetch_url: 'chat:trace.families.pages',
  create_file: 'chat:trace.families.files',
  run_code: 'chat:trace.families.code',
  list_skills: 'chat:trace.families.skills',
  read_skill: 'chat:trace.families.skills',
  list_artifacts: 'chat:trace.families.artifacts',
  read_artifact: 'chat:trace.families.artifacts',
};

/** Human family of a tool (e.g. `run_command` → "Shell"). */
export function toolFamilyLabel(name: string): string {
  const key = TOOL_FAMILY_KEYS[name];
  return key ? t(key) : name.replace(/_/g, ' ');
}

/** Present-tense status phrase keys of a running tool call. */
const TOOL_ACTIVITY_KEYS: Record<string, string> = {
  run_command: 'chat:trace.activity.run_command',
  run_checks: 'chat:trace.activity.run_checks',
  read_file: 'chat:trace.activity.read_file',
  read_tool_output: 'chat:trace.activity.read_tool_output',
  list_dir: 'chat:trace.activity.list_dir',
  search_files: 'chat:trace.activity.search_files',
  search_text: 'chat:trace.activity.search_text',
  write_file: 'chat:trace.activity.write_file',
  edit_file: 'chat:trace.activity.edit_file',
  todo_write: 'chat:trace.activity.todo_write',
  submit_plan: 'chat:trace.activity.submit_plan',
  ask_user: 'chat:trace.activity.ask_user',
  task: 'chat:trace.activity.task',
  job_list: 'chat:trace.activity.job_list',
  job_output: 'chat:trace.activity.job_output',
  job_kill: 'chat:trace.activity.job_kill',
  git_status: 'chat:trace.activity.git_status',
  git_diff: 'chat:trace.activity.git_diff',
  git_log: 'chat:trace.activity.git_log',
  goal: 'chat:trace.activity.goal',
  validate_ui: 'chat:trace.activity.validate_ui',
  web_search: 'chat:trace.activity.web_search',
  fetch_url: 'chat:trace.activity.fetch_url',
  create_file: 'chat:trace.activity.create_file',
  run_code: 'chat:trace.activity.run_code',
  list_skills: 'chat:trace.activity.list_skills',
  read_skill: 'chat:trace.activity.read_skill',
  list_artifacts: 'chat:trace.activity.list_artifacts',
  read_artifact: 'chat:trace.activity.read_artifact',
};

/** Present-tense status phrase of a tool (fallback to its family). */
export function toolActivityLabel(name: string): string {
  const key = TOOL_ACTIVITY_KEYS[name];
  return key
    ? t(key)
    : t('chat:trace.activity.fallback', { family: toolFamilyLabel(name) });
}

/** What the agent is doing right now, for the collapsed execution line. */
export interface TraceActivity {
  kind: 'reasoning' | 'tool';
  /** Status phrase, e.g. "Analisando a solicitação" / "Executando comandos". */
  label: string;
  /** One-line preview of the reasoning or of the tool target. */
  preview: string | null;
  /** Tool name when the activity is a tool call. */
  toolName?: string;
  /** True while the tool call is still running. */
  running: boolean;
}

/**
 * Resolves the latest activity of an execution block: the running tool wins
 * over a finished one, and a trailing reasoning block means the model is
 * analyzing before its next action.
 */
export function describeTraceActivity(entries: AgentTraceEntry[]): TraceActivity | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  if (last.kind === 'reasoning') {
    return {
      kind: 'reasoning',
      label: t('chat:trace.analyzing'),
      preview: oneLinePreview(last.text),
      running: true,
    };
  }
  const tools = last.group.tools;
  const tool =
    [...tools].reverse().find((call) => call.status === 'running') ?? tools[tools.length - 1];
  if (!tool) return null;
  return {
    kind: 'tool',
    label: toolActivityLabel(tool.name),
    preview: toolPreview(tool),
    toolName: tool.name,
    running: tool.status === 'running',
  };
}

/** Collapses Markdown/line breaks into a single preview line. */
function oneLinePreview(text: string, maxChars = 220): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? truncate(flat, maxChars) : null;
}

/** Target of a tool call (command, path, query, URL…), one line. */
function toolPreview(tool: ToolCallRecord): string | null {
  const detail = describeCodeTool(tool).detail;
  if (detail) return oneLinePreview(detail);
  const args = safeJsonParse<Record<string, unknown>>(tool.arguments, {});
  for (const key of ['command', 'path', 'url', 'query', 'pattern', 'name', 'prompt', 'description']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return oneLinePreview(value);
  }
  return tool.summary ? oneLinePreview(tool.summary) : null;
}

function pushToolGroups(entries: AgentTraceEntry[], tools: ToolCallRecord[]): void {
  for (const group of groupTools(tools)) entries.push({ kind: 'tools', group });
}

/** Groups adjacent calls of the same tool, keeping the original order. */
function groupTools(tools: ToolCallRecord[]): ToolGroup[] {
  const groups: ToolCallRecord[][] = [];
  for (const tool of tools) {
    const current = groups[groups.length - 1];
    if (current && current[0].name === tool.name) current.push(tool);
    else groups.push([tool]);
  }
  return groups.map(buildToolGroup);
}

function buildToolGroup(tools: ToolCallRecord[]): ToolGroup {
  const name = tools[0]?.name ?? '';
  const status = groupStatus(tools);
  const errors = tools
    .filter((tool) => tool.status === 'error')
    .map(toolError)
    .filter((message) => message.length > 0);

  switch (name) {
    case 'web_search':
      return searchGroup(tools, status, errors);
    case 'fetch_url':
      return fetchGroup(tools, status, errors);
    case 'create_file':
      return fileGroup(tools, status, errors);
    case 'validate_ui':
      return validationGroup(tools, status, errors);
    case 'run_code':
      return codeGroup(tools, status, errors);
    case 'list_skills':
      return skillsListGroup(tools, status, errors);
    case 'read_skill':
      return readSkillGroup(tools, status, errors);
    case 'list_artifacts':
      return artifactsListGroup(tools, status, errors);
    case 'read_artifact':
      return readArtifactGroup(tools, status, errors);
    /* ---- harness de código (docs/goals/code-harness/WORKBENCH.md §5.2) ---- */
    case 'read_file':
    case 'list_dir':
    case 'search_files':
    case 'search_text':
      return readCodeGroup(tools, status, errors);
    case 'write_file':
    case 'edit_file':
      return writeCodeGroup(tools, status, errors);
    case 'run_command':
      return commandCodeGroup(tools, status, errors);
    case 'run_checks':
      return checksCodeGroup(tools, status, errors);
    case 'todo_write':
      return todoCodeGroup(tools, status, errors);
    case 'submit_plan':
      return planCodeGroup(tools, status, errors);
    case 'goal':
      return goalCodeGroup(tools, status, errors);
    case 'ask_user':
      return askCodeGroup(tools, status, errors);
    case 'task':
      return subagentCodeGroup(tools, status, errors);
    case 'job_list':
    case 'job_output':
    case 'job_kill':
      return jobCodeGroup(tools, status, errors);
    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return gitCodeGroup(tools, status, errors);
    case 'read_tool_output':
      return readOutputCodeGroup(tools, status, errors);
    default:
      return {
        name,
        tools,
        status,
        label: defaultLabel(name, tools.length, status),
        total: tools.length,
        domains: [],
        pages: [],
        files: [],
        errors,
      };
  }
}

function groupStatus(tools: ToolCallRecord[]): ToolGroupStatus {
  if (tools.some((tool) => tool.status === 'running')) return 'running';
  if (tools.some((tool) => tool.status === 'error')) return 'error';
  return 'done';
}

function searchGroup(tools: ToolCallRecord[], status: ToolGroupStatus, errors: string[]): ToolGroup {
  const pages = uniquePages(tools.flatMap(searchResults));
  const summaryTotal = tools.reduce((sum, tool) => sum + (summaryResultCount(tool) ?? 0), 0);
  const total = pages.length || summaryTotal;
  const domains = uniqueDomains(pages);
  const base = { name: 'web_search', tools, status, total, domains, pages: [], files: [], errors };
  if (status === 'running') {
    return { ...base, label: t('chat:trace.group.web_search.running') };
  }
  if (total > 0) {
    return { ...base, label: t('chat:trace.group.web_search.found', { count: total }) };
  }
  return {
    ...base,
    label: errors.length
      ? t('chat:trace.group.web_search.failed')
      : t('chat:trace.group.web_search.empty'),
  };
}

function fetchGroup(tools: ToolCallRecord[], status: ToolGroupStatus, errors: string[]): ToolGroup {
  const pages = uniquePages(tools.map(pageOf).filter((page): page is PageLink => page !== null));
  const total = pages.length || tools.length;
  const base = { name: 'fetch_url', tools, status, total, domains: [], pages, files: [], errors };
  if (status === 'running') {
    return { ...base, label: t('chat:trace.group.fetch_url.running', { count: total }) };
  }
  if (pages.length > 0) {
    return { ...base, label: t('chat:trace.group.fetch_url.read', { count: pages.length }) };
  }
  return {
    ...base,
    label:
      tools.length > 1
        ? t('chat:trace.group.fetch_url.failed', { count: tools.length })
        : t('chat:trace.group.fetch_url.failed', { count: 1 }),
  };
}

function fileGroup(tools: ToolCallRecord[], status: ToolGroupStatus, errors: string[]): ToolGroup {
  const files = uniqueStrings(tools.map(createdFileName).filter((name): name is string => !!name));
  const total = files.length || tools.length;
  const base = { name: 'create_file', tools, status, total, domains: [], pages: [], files, errors };
  if (status === 'running') {
    return { ...base, label: t('chat:trace.group.create_file.running', { count: total }) };
  }
  if (files.length > 0) {
    return {
      ...base,
      label: t('chat:trace.group.create_file.created', { count: files.length }),
    };
  }
  return { ...base, label: t('chat:trace.group.create_file.failed') };
}

function validationGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const base = {
    name: 'validate_ui',
    tools,
    status,
    total: tools.length,
    domains: [],
    pages: [],
    files: [],
    errors,
  };
  if (status === 'running') return { ...base, label: t('chat:trace.group.validate_ui.running') };
  if (status === 'error') return { ...base, label: t('chat:trace.group.validate_ui.failed') };
  return {
    ...base,
    label: t('chat:trace.group.validate_ui.done', { count: tools.length }),
  };
}

/**
 * `run_code` rows: the harness summary looks like "python · 2 arquivos · 1.2s".
 * The duration is dropped (the timeline header already shows the total time) and
 * the remaining detail is appended to the done label so the user knows what ran.
 */
function codeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const base = {
    name: 'run_code',
    tools,
    status,
    total: tools.length,
    domains: [],
    pages: [],
    files: [],
    errors,
  };
  if (status === 'running') return { ...base, label: t('chat:trace.group.run_code.running') };
  if (status === 'error') return { ...base, label: t('chat:trace.group.run_code.failed') };
  const detail = codeSummaryDetail(tools[tools.length - 1]?.summary);
  return {
    ...base,
    label: detail
      ? t('chat:trace.group.run_code.doneWithDetail', { detail })
      : t('chat:trace.group.run_code.done'),
  };
}

function skillsListGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const base = {
    name: 'list_skills',
    tools,
    status,
    total: tools.length,
    domains: [],
    pages: [],
    files: [],
    errors,
  };
  if (status === 'running') return { ...base, label: t('chat:trace.group.list_skills.running') };
  if (status === 'error') return { ...base, label: t('chat:trace.group.list_skills.failed') };
  return { ...base, label: t('chat:trace.group.list_skills.done') };
}

function readSkillGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const names = uniqueStrings(
    tools.map(readSkillName).filter((name): name is string => name !== null),
  );
  const base = {
    name: 'read_skill',
    tools,
    status,
    total: tools.length,
    domains: [],
    pages: [],
    files: [],
    errors,
  };
  if (status === 'error') return { ...base, label: t('chat:trace.group.read_skill.failed') };
  if (status === 'running') {
    if (names.length === 1) {
      return { ...base, label: t('chat:trace.group.read_skill.runningNamed', { name: names[0] }) };
    }
    if (names.length > 1) {
      return {
        ...base,
        label: t('chat:trace.group.read_skill.runningMany', { count: names.length }),
      };
    }
    return { ...base, label: t('chat:trace.group.read_skill.running') };
  }
  if (names.length === 1) {
    return { ...base, label: t('chat:trace.group.read_skill.doneNamed', { name: names[0] }) };
  }
  if (names.length > 1) {
    return { ...base, label: t('chat:trace.group.read_skill.doneMany', { count: names.length }) };
  }
  return { ...base, label: t('chat:trace.group.read_skill.done') };
}

/**
 * `list_artifacts` rows: the harness summary is "{returned} artefatos" or
 * "{returned} de {total} artefatos" ("nenhum artefato" when the library is
 * empty). Only the returned count belongs in the label.
 */
function artifactsListGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const counts = tools.map((tool) => summaryArtifactCount(tool));
  const parsed = counts.filter((count): count is number => count !== null);
  const total = parsed.length > 0 ? parsed.reduce((sum, count) => sum + count, 0) : tools.length;
  const base = {
    name: 'list_artifacts',
    tools,
    status,
    total,
    domains: [],
    pages: [],
    files: [],
    errors,
  };
  if (status === 'running') {
    return { ...base, label: t('chat:trace.group.list_artifacts.running') };
  }
  if (status === 'error') {
    return { ...base, label: t('chat:trace.group.list_artifacts.failed') };
  }
  if (parsed.length === 0) return { ...base, label: t('chat:trace.group.list_artifacts.done') };
  if (total === 0) return { ...base, label: t('chat:trace.group.list_artifacts.empty') };
  return {
    ...base,
    label: t('chat:trace.group.list_artifacts.found', { count: total }),
  };
}

/**
 * `read_artifact` rows: the summary is "{nome} · {total} caracteres" (or
 * "{nome} · binário"), so the file name is its first segment. Calls by id carry
 * no name in the summary path, so `arguments.name` is the fallback. File chips
 * list only the artifacts that were actually read.
 */
function readArtifactGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const names = uniqueStrings(
    tools
      .filter((tool) => tool.status !== 'error')
      .map(readArtifactName)
      .filter((name): name is string => name !== null),
  );
  const base = {
    name: 'read_artifact',
    tools,
    status,
    total: names.length || tools.length,
    domains: [],
    pages: [],
    files: names,
    errors,
  };
  if (status === 'error') {
    return { ...base, label: t('chat:trace.group.read_artifact.failed') };
  }
  if (status === 'running') {
    if (names.length === 1) {
      return {
        ...base,
        label: t('chat:trace.group.read_artifact.runningNamed', { name: names[0] }),
      };
    }
    if (names.length > 1) {
      return {
        ...base,
        label: t('chat:trace.group.read_artifact.runningMany', { count: names.length }),
      };
    }
    return { ...base, label: t('chat:trace.group.read_artifact.running') };
  }
  if (names.length === 1) {
    return {
      ...base,
      label: t('chat:trace.group.read_artifact.doneNamed', { name: names[0] }),
    };
  }
  if (names.length > 1) {
    return {
      ...base,
      label: t('chat:trace.group.read_artifact.doneMany', { count: names.length }),
    };
  }
  return { ...base, label: t('chat:trace.group.read_artifact.done') };
}

/**
 * Returned artifact count of a `list_artifacts` call: the structured
 * presentation is authoritative, so translated prose is never parsed. Only
 * legacy messages (without a presentation) fall back to the summary text.
 */
function summaryArtifactCount(tool: ToolCallRecord): number | null {
  const presentation = tool.presentation;
  if (presentation?.kind === 'artifact_list') return presentation.returned;
  const raw = tool.summary?.trim();
  if (!raw) return null;
  if (/^nenhum\b/i.test(raw)) return 0;
  const match = raw.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function readArtifactName(tool: ToolCallRecord): string | null {
  const raw = tool.summary?.trim();
  if (raw) {
    const [first, ...rest] = raw.split(' · ');
    const name = first?.trim() ?? '';
    if (rest.length > 0 && name.length > 0) return truncate(name, 80);
  }
  const args = safeJsonParse<{ name?: unknown } | null>(tool.arguments, null);
  if (!args || typeof args !== 'object' || typeof args.name !== 'string') return null;
  const name = args.name.trim();
  return name ? truncate(name, 80) : null;
}

/** Short detail of a `run_code` summary: drops the duration segment. */
function codeSummaryDetail(summary?: string | null): string | null {
  const raw = summary?.trim();
  if (!raw) return null;
  const parts = raw
    .split('·')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !isDurationPart(part));
  if (parts.length === 0) return null;
  return truncate(parts.slice(0, 2).join(' · '), 80);
}

function isDurationPart(part: string): boolean {
  return /^\d+(?:[.,]\d+)?\s*(?:ms|s|seg|segs|segundos?|min|mins|minutos?)$/i.test(part);
}

function readSkillName(tool: ToolCallRecord): string | null {
  const args = safeJsonParse<{ name?: unknown } | null>(tool.arguments, null);
  if (!args || typeof args !== 'object' || typeof args.name !== 'string') return null;
  const name = args.name.trim();
  return name ? truncate(name, 64) : null;
}

function defaultLabel(name: string, count: number, status: ToolGroupStatus): string {
  const readable = name.replace(/_/g, ' ');
  if (status === 'running') return t('chat:trace.group.default.running', { name: readable });
  if (status === 'error') return t('chat:trace.group.default.failed', { name: readable });
  return t('chat:trace.group.default.done', { count, name: readable });
}

/* ------------------------------------------------------------------ */
/* Tools do harness de código (rótulos pt-BR)                          */
/* ------------------------------------------------------------------ */

function codeArgs(tool: ToolCallRecord): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(tool.arguments ?? '', null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function codeArg(tool: ToolCallRecord, key: string): string | null {
  const value = codeArgs(tool)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function codePaths(tools: ToolCallRecord[]): string[] {
  return uniqueStrings(
    tools
      .map((tool) => codeArg(tool, 'path') ?? codeArg(tool, 'file'))
      .filter((path): path is string => Boolean(path)),
  );
}

function harnessGroup(
  name: string,
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
  label: string,
  files: string[] = [],
): ToolGroup {
  return { name, tools, status, label, total: tools.length, domains: [], pages: [], files, errors };
}

function firstPattern(tools: ToolCallRecord[]): string | null {
  const pattern = tools.map((tool) => codeArg(tool, 'pattern')).find(Boolean) ?? null;
  return pattern ? truncate(pattern, 48) : null;
}

function readCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const name = tools[0]?.name ?? 'read_file';
  const paths = codePaths(tools);
  const first = paths[0] ?? null;
  const pattern = firstPattern(tools);
  let label: string;
  if (name === 'list_dir') {
    if (status === 'running') {
      label = first
        ? t('chat:trace.group.list_dir.runningPath', { path: first })
        : t('chat:trace.group.list_dir.running');
    } else if (status === 'error') {
      label = first
        ? t('chat:trace.group.list_dir.failedPath', { path: first })
        : t('chat:trace.group.list_dir.failed');
    } else {
      label = first
        ? t('chat:trace.group.list_dir.donePath', { path: first })
        : t('chat:trace.group.list_dir.done');
    }
  } else if (name === 'search_files' || name === 'search_text') {
    if (status === 'running') {
      label = pattern
        ? t('chat:trace.group.search_text.runningPattern', { pattern })
        : t('chat:trace.group.search_text.running');
    } else if (status === 'error') {
      label = t('chat:trace.group.search_text.failed');
    } else {
      label = pattern
        ? t('chat:trace.group.search_text.donePattern', { pattern })
        : t('chat:trace.group.search_text.done');
    }
  } else if (status === 'running') {
    label = first
      ? t('chat:trace.group.read_file.runningPath', { path: first })
      : t('chat:trace.group.read_file.running');
  } else if (status === 'error') {
    label = first
      ? t('chat:trace.group.read_file.failedPath', { path: first })
      : t('chat:trace.group.read_file.failed');
  } else if (paths.length > 1) {
    label = t('chat:trace.group.read_file.done', { count: paths.length });
  } else {
    label = first
      ? t('chat:trace.group.read_file.done_one', { path: first })
      : t('chat:trace.group.read_file.done');
  }
  return harnessGroup(name, tools, status, errors, label);
}

function writeCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const paths = codePaths(tools);
  const first = paths[0] ?? null;
  let label: string;
  if (status === 'running') {
    label = first
      ? t('chat:trace.group.write_file.runningPath', { path: first })
      : t('chat:trace.group.write_file.running');
  } else if (status === 'error') {
    label = first
      ? t('chat:trace.group.write_file.failedPath', { path: first })
      : t('chat:trace.group.write_file.failed');
  } else if (paths.length > 1) {
    label = t('chat:trace.group.write_file.done', { count: paths.length });
  } else {
    label = first
      ? t('chat:trace.group.write_file.done_one', { path: first })
      : t('chat:trace.group.write_file.done');
  }
  return harnessGroup(tools[0]?.name ?? 'write_file', tools, status, errors, label, paths);
}

function commandCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const command = tools.map((tool) => codeArg(tool, 'command')).find(Boolean) ?? null;
  const short = command ? truncate(command, 64) : null;
  let label: string;
  if (status === 'running') {
    label = short
      ? t('chat:trace.group.run_command.runningCommand', { command: short })
      : t('chat:trace.group.run_command.running');
  } else if (status === 'error') {
    label = short
      ? t('chat:trace.group.run_command.failedCommand', { command: short })
      : t('chat:trace.group.run_command.failed');
  } else {
    label = short
      ? t('chat:trace.group.run_command.doneCommand', { command: short })
      : t('chat:trace.group.run_command.done');
  }
  return harnessGroup('run_command', tools, status, errors, label);
}

function checksCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const label =
    status === 'running'
      ? t('chat:trace.group.run_checks.running')
      : status === 'error'
        ? t('chat:trace.group.run_checks.failed')
        : t('chat:trace.group.run_checks.done');
  return harnessGroup('run_checks', tools, status, errors, label);
}

function todoCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const label =
    status === 'running'
      ? t('chat:trace.group.todo_write.running')
      : status === 'error'
        ? t('chat:trace.group.todo_write.failed')
        : t('chat:trace.group.todo_write.done');
  return harnessGroup('todo_write', tools, status, errors, label);
}

function planPresentationState(tool: ToolCallRecord): string | null {
  const presentation = tool.presentation;
  if (!presentation || presentation.kind !== 'plan') return null;
  return presentation.state ?? null;
}

function planCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const state = [...tools].reverse().map(planPresentationState).find(Boolean) ?? null;
  const feedback = [...tools]
    .reverse()
    .map((tool) => (tool.presentation?.kind === 'plan' ? tool.presentation.feedback : null))
    .find(Boolean);
  let label: string;
  if (status === 'running') label = t('chat:trace.group.submit_plan.running');
  else if (status === 'error')
    label = feedback
      ? t('chat:trace.group.submit_plan.failedFeedback')
      : t('chat:trace.group.submit_plan.failed');
  else if (state === 'approved') label = t('chat:trace.group.submit_plan.approved');
  else if (state === 'reviewing')
    label = feedback
      ? t('chat:trace.group.submit_plan.reviewingFeedback')
      : t('chat:trace.group.submit_plan.reviewing');
  else label = t('chat:trace.group.submit_plan.proposed');
  return harnessGroup('submit_plan', tools, status, errors, label);
}

/** Rótulo do grupo `goal` a partir da apresentação flat persistida. */
function goalCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const goal = [...tools]
    .reverse()
    .map((tool) => (tool.presentation?.kind === 'goal' ? tool.presentation : null))
    .find(Boolean);
  let label: string;
  if (status === 'running') label = t('chat:trace.group.goal.running');
  else if (status === 'error') label = t('chat:trace.group.goal.failed');
  else if (goal?.status === 'completed') label = t('chat:trace.group.goal.completed');
  else if (goal?.status === 'blocked') label = t('chat:trace.group.goal.blocked');
  else if (goal?.status === 'paused') label = t('chat:trace.group.goal.paused');
  else label = t('chat:trace.group.goal.progressed');
  return harnessGroup('goal', tools, status, errors, label);
}


function askCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const label =
    status === 'running'
      ? t('chat:trace.group.ask_user.running')
      : status === 'error'
        ? t('chat:trace.group.ask_user.failed')
        : t('chat:trace.group.ask_user.done');
  return harnessGroup('ask_user', tools, status, errors, label);
}

/** Localized label for the subagent kind; `task` without a type uses `explore`. */
function subagentKindLabel(type: string | null | undefined): string {
  switch (type) {
    case 'review':
      return t('chat:trace.subagentKind.review');
    case 'general':
      return t('chat:trace.subagentKind.general');
    case 'worker':
      return t('chat:trace.subagentKind.worker');
    case 'explore':
    default:
      return t('chat:trace.subagentKind.explore');
  }
}

function subagentCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const type =
    tools
      .map((tool) => codeArg(tool, 'subagent_type'))
      .find(Boolean) ?? null;
  const kind = subagentKindLabel(type);
  const label =
    status === 'running'
      ? t('chat:trace.group.task.running')
      : status === 'error'
        ? t('chat:trace.group.task.failed')
        : t('chat:trace.group.task.done', { kind });
  return harnessGroup('task', tools, status, errors, label);
}

function jobCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const name = tools[0]?.name ?? 'job_list';
  const label =
    status === 'running'
      ? t('chat:trace.group.job_list.running')
      : status === 'error'
        ? t('chat:trace.group.job_list.failed')
        : name === 'job_kill'
          ? t('chat:trace.group.job_list.kill')
          : name === 'job_output'
            ? t('chat:trace.group.job_list.output')
            : t('chat:trace.group.job_list.list');
  return harnessGroup(name, tools, status, errors, label);
}

function gitCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const name = tools[0]?.name ?? 'git_status';
  const label =
    status === 'running'
      ? t('chat:trace.group.git_status.running')
      : status === 'error'
        ? t('chat:trace.group.git_status.failed')
        : name === 'git_diff'
          ? t('chat:trace.group.git_status.diff')
          : name === 'git_log'
            ? t('chat:trace.group.git_status.log')
            : t('chat:trace.group.git_status.status');
  return harnessGroup(name, tools, status, errors, label);
}

function readOutputCodeGroup(
  tools: ToolCallRecord[],
  status: ToolGroupStatus,
  errors: string[],
): ToolGroup {
  const label =
    status === 'running'
      ? t('chat:trace.group.read_tool_output.running')
      : status === 'error'
        ? t('chat:trace.group.read_tool_output.failed')
        : t('chat:trace.group.read_tool_output.done');
  return harnessGroup('read_tool_output', tools, status, errors, label);
}

/**
 * Rótulo por **chamada** de tool do harness de código. A timeline de execução
 * do "Thinking" renderiza uma linha por chamada (verbo + alvo + status) em vez
 * do card agregado; `label` mantém o texto completo para leitores de tela/testes.
 */
export interface CodeToolLabel {
  verb: string;
  detail: string | null;
  label: string;
}

export function describeCodeTool(tool: ToolCallRecord): CodeToolLabel {
  const make = (verb: string, detail: string | null = null): CodeToolLabel => ({
    verb,
    detail,
    label: detail
      ? t('chat:trace.toolLabel', { verb, detail })
      : t('chat:trace.toolLabelPlain', { verb }),
  });
  const path = codeArg(tool, 'path') ?? codeArg(tool, 'file');
  const command = codeArg(tool, 'command');
  const pattern = codeArg(tool, 'pattern');
  const query = codeArg(tool, 'query');
  const presentation = tool.presentation;
  const fileChange = presentation?.kind === 'file_change' ? presentation : null;
  const failed = tool.status === 'error';

  switch (tool.name) {
    case 'read_file':
      return make(t('chat:trace.verb.read'), path);
    case 'list_dir':
      return make(t('chat:trace.verb.list'), path);
    case 'search_files':
    case 'search_text': {
      const term = pattern ?? query;
      return make(
        t('chat:trace.verb.search'),
        term ? `“${truncate(term, 64)}”` : null,
      );
    }
    case 'write_file':
    case 'edit_file': {
      const verb =
        fileChange?.change === 'created'
          ? t('chat:trace.verb.created')
          : fileChange?.change === 'deleted'
            ? t('chat:trace.verb.deleted')
            : fileChange?.change === 'renamed'
              ? t('chat:trace.verb.renamed')
              : t('chat:trace.verb.changed');
      return make(verb, path ?? fileChange?.path ?? null);
    }
    case 'run_command':
      return make(
        t('chat:trace.verb.command'),
        command ? truncate(command, 96) : null,
      );
    case 'run_checks':
      return make(
        failed ? t('chat:trace.verb.checksFailed') : t('chat:trace.verb.checksDone'),
      );
    case 'todo_write':
      return make(
        failed ? t('chat:trace.verb.todoFailed') : t('chat:trace.verb.todoDone'),
      );
    case 'goal': {
      const goal = presentation?.kind === 'goal' ? presentation : null;
      if (failed) return make(t('chat:trace.verb.goalFailed'));
      if (goal?.status === 'completed') return make(t('chat:trace.verb.goalCompleted'));
      if (goal?.status === 'blocked') return make(t('chat:trace.verb.goalBlocked'));
      if (goal?.status === 'paused') return make(t('chat:trace.verb.goalPaused'));
      return make(t('chat:trace.verb.goalProgressed'));
    }
    case 'submit_plan': {
      const plan = presentation?.kind === 'plan' ? presentation : null;
      if (failed) {
        return make(
          plan?.feedback
            ? t('chat:trace.verb.planNotApproved')
            : t('chat:trace.verb.planFailed'),
        );
      }
      if (plan?.state === 'approved') return make(t('chat:trace.verb.planApproved'));
      if (plan?.state === 'reviewing') {
        return make(
          plan.feedback
            ? t('chat:trace.verb.planRevised')
            : t('chat:trace.verb.planSentForReview'),
        );
      }
      return make(t('chat:trace.verb.planProposed'));
    }
    case 'ask_user':
      return make(
        failed
          ? t('chat:trace.verb.askFailed')
          : tool.status === 'running'
            ? t('chat:trace.verb.askRunning')
            : t('chat:trace.verb.askDone'),
      );
    case 'task': {
      const kind = subagentKindLabel(codeArg(tool, 'subagent_type'));
      return make(
        failed
          ? t('chat:trace.verb.taskFailed')
          : t('chat:trace.verb.taskDone', { kind }),
      );
    }
    case 'job_list':
      return make(
        failed ? t('chat:trace.verb.jobsFailed') : t('chat:trace.verb.jobsDone'),
      );
    case 'job_output':
      return make(
        failed
          ? t('chat:trace.verb.jobOutputFailed')
          : t('chat:trace.verb.jobOutputDone'),
      );
    case 'job_kill':
      return make(
        failed ? t('chat:trace.verb.jobKillFailed') : t('chat:trace.verb.jobKillDone'),
      );
    case 'git_status':
      return make(
        failed
          ? t('chat:trace.verb.gitStatusFailed')
          : t('chat:trace.verb.gitStatusDone'),
      );
    case 'git_diff':
      return make(
        failed ? t('chat:trace.verb.gitDiffFailed') : t('chat:trace.verb.gitDiffDone'),
      );
    case 'git_log':
      return make(
        failed ? t('chat:trace.verb.gitLogFailed') : t('chat:trace.verb.gitLogDone'),
      );
    case 'read_tool_output':
      return make(
        failed
          ? t('chat:trace.verb.readOutputFailed')
          : t('chat:trace.verb.readOutputDone'),
      );
    case 'validate_ui':
      return make(
        failed ? t('chat:trace.verb.uiFailed') : t('chat:trace.verb.uiDone'),
      );
    default: {
      const name = tool.name.replace(/_/g, ' ');
      return make(
        failed
          ? t('chat:trace.verb.defaultFailed', { name })
          : t('chat:trace.verb.defaultDone', { name }),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tool payload parsing                                                */
/* ------------------------------------------------------------------ */

interface SearchPayload {
  results?: Array<{ title?: unknown; url?: unknown }>;
}

function searchResults(tool: ToolCallRecord): PageLink[] {
  const parsed = safeJsonParse<SearchPayload | null>(tool.result ?? '', null);
  if (!parsed || !Array.isArray(parsed.results)) return [];
  return parsed.results
    .filter((result) => typeof result?.url === 'string' && /^https?:\/\//i.test(result.url))
    .map((result) => {
      const url = String(result.url);
      const title = typeof result.title === 'string' ? result.title.trim() : '';
      return { title: title || hostnameOf(url), url };
    });
}

/**
 * Result count of a `web_search` call: the structured presentation is
 * authoritative. Legacy messages (without one) fall back to the summary text.
 */
function summaryResultCount(tool: ToolCallRecord): number | null {
  const presentation = tool.presentation;
  if (presentation?.kind === 'search') return presentation.total;
  const raw = tool.summary?.trim();
  if (!raw) return null;
  if (/^nenhum\b/i.test(raw)) return 0;
  const match = raw.match(/(\d+)\s+resultados?/i) ?? raw.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

interface FetchPayload {
  url?: unknown;
  title?: unknown;
}

function pageOf(tool: ToolCallRecord): PageLink | null {
  // A failed fetch never counts as a page that was read.
  if (tool.status === 'error') return null;
  const parsed = safeJsonParse<FetchPayload | null>(tool.result ?? '', null);
  if (parsed && typeof parsed.url === 'string' && /^https?:\/\//i.test(parsed.url)) {
    const url = parsed.url;
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    return { title: title || summaryTitle(tool.summary) || hostnameOf(url), url };
  }
  const args = safeJsonParse<{ url?: unknown }>(tool.arguments, {});
  if (typeof args.url === 'string' && /^https?:\/\//i.test(args.url)) {
    return {
      title: summaryTitle(tool.summary) || hostnameOf(args.url),
      url: args.url,
    };
  }
  return null;
}

function summaryTitle(summary?: string | null): string | null {
  const title = summary?.split(' · ')[0]?.trim();
  return title ? title : null;
}

function createdFileName(tool: ToolCallRecord): string | null {
  if (tool.status === 'error') return null;
  const fromSummary = summaryTitle(tool.summary);
  if (fromSummary) return fromSummary;
  const args = safeJsonParse<{ name?: unknown }>(tool.arguments, {});
  return typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;
}

function toolError(tool: ToolCallRecord): string {
  const raw = (tool.result ?? tool.summary ?? '').trim();
  if (!raw) return '';
  const message = raw.replace(/^error:\s*/i, '').split('\n')[0]?.trim() ?? '';
  return truncate(message, MAX_ERROR_CHARS);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function uniquePages(pages: PageLink[]): PageLink[] {
  const seen = new Set<string>();
  const unique: PageLink[] = [];
  for (const page of pages) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    unique.push(page);
  }
  return unique;
}

function uniqueDomains(pages: PageLink[]): string[] {
  return uniqueStrings(pages.map((page) => hostnameOf(page.url)).filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
