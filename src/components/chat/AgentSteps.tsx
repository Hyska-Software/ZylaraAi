import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  Bot,
  BookOpen,
  Brain,
  ChevronDown,
  ClipboardCheck,
  FilePenLine,
  FilePlus,
  FileSearch,
  FileText,
  FolderOpen,
  GitBranch,
  HelpCircle,
  Library,
  ListChecks,
  ListTodo,
  Play,
  Search,
  ShieldCheck,
  SquareTerminal,
  Target,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useReduceMotion } from '@/components/layout/hooks';
import { Spinner } from '@/components/ui';
import {
  buildAgentResponseBlocks,
  buildAgentTrace,
  countTraceTools,
  describeTraceActivity,
  hasTraceReasoning,
  type AgentResponseBlock,
  type AgentTraceEntry,
  type PageLink,
  type ToolGroup,
} from '@/lib/agentTrace';
import { useAppStore, useUiStore } from '@/lib/store';
import type { ChatMessage } from '@/lib/types';
import { cn, formatDuration, formatThinkingDuration, truncate } from '@/lib/utils';
import { openExternalUrl } from './external';
import { Markdown } from './Markdown';
import { ToolCallRow } from './ToolCallRow';

export type AgentStepsPhase = 'starting' | 'queued' | 'reasoning' | 'text' | 'tool' | 'retrying';

export interface AgentStepsProps {
  message: ChatMessage;
  /** The assistant is currently streaming this turn. */
  streaming: boolean;
  /** Current streaming phase (used by the live header). */
  phase: AgentStepsPhase | null;
  /** Turn start timestamp, used by the live counter. */
  startedAt?: number | null;
  className?: string;
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  web_search: Search,
  fetch_url: FileText,
  create_file: FilePlus,
  validate_ui: ShieldCheck,
  run_code: SquareTerminal,
  list_skills: BookOpen,
  read_skill: BookOpen,
  list_artifacts: Library,
  read_artifact: FileSearch,
  /* harness de código */
  read_file: FileText,
  read_tool_output: FileSearch,
  list_dir: FolderOpen,
  search_files: Search,
  search_text: Search,
  write_file: FilePenLine,
  edit_file: FilePenLine,
  run_command: SquareTerminal,
  run_checks: ClipboardCheck,
  todo_write: ListTodo,
  submit_plan: ListChecks,
  ask_user: HelpCircle,
  task: Bot,
  job_list: Play,
  job_output: Play,
  job_kill: Play,
  git_status: GitBranch,
  git_diff: GitBranch,
  git_log: GitBranch,
  /* objetivo persistente (docs/goals/code-goals/PLAN.md §10.5) */
  goal: Target,
};

const MAX_DOMAINS = 5;
const MAX_PAGE_CHIPS = 6;
const MAX_FILE_CHIPS = 4;

/** Tools do harness de código: uma linha por chamada (ver `ToolCallRow`). */
const CODE_TOOL_NAMES = new Set([
  'read_file',
  'read_tool_output',
  'list_dir',
  'search_files',
  'search_text',
  'write_file',
  'edit_file',
  'run_command',
  'run_checks',
  'todo_write',
  'submit_plan',
  'ask_user',
  'task',
  'job_list',
  'job_output',
  'job_kill',
  'git_status',
  'git_diff',
  'git_log',
  'validate_ui',
]);

/** Live counter while the turn streams (500ms tick). */
function useLiveElapsed(active: boolean, startedAt?: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      setElapsed(null);
      return undefined;
    }
    const start = startedAt ?? Date.now();
    const update = () => setElapsed(Math.max(0, Date.now() - start));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [active, startedAt]);

  return elapsed;
}

interface ReasoningRowProps {
  text: string;
  streaming: boolean;
  /** Row label; the per-response transcript uses "Reasoning". */
  label?: string;
  /** Model time of the step, shown next to the label when known. */
  durationMs?: number | null;
}

/**
 * One reasoning block of the agent timeline. Like a tool row, the raw
 * reasoning is a detail: it starts collapsed and expands on demand, so long
 * chain-of-thought blocks never dominate the transcript.
 */
function ReasoningRow({ text, streaming, label, durationMs = null }: ReasoningRowProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const title = label ?? t('trace.thought');
  const duration =
    durationMs != null && durationMs >= 1000 ? formatThinkingDuration(durationMs) : null;
  return (
    <li className="min-w-0">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 items-start gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-hover/60">
          <Brain
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-foreground-subtle"
          />
          <Collapsible.Trigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-x-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="text-[12px] font-semibold text-foreground">
                {duration
                  ? t('trace.labelWithDuration', { label: title, duration })
                  : title}
              </span>
              {streaming ? <Spinner size="xs" className="text-foreground-subtle" /> : null}
              <ChevronDown
                aria-hidden
                className={cn(
                  'ml-auto size-3.5 shrink-0 text-foreground-subtle transition-transform duration-150',
                  open && 'rotate-180',
                )}
              />
            </button>
          </Collapsible.Trigger>
        </div>
        <Collapsible.Content>
          <div className="ml-[26px] mt-1">
            <Markdown content={text} variant="thinking" streaming={streaming} />
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
}

/**
 * Rows of a trace block: reasoning lines (collapsed Markdown) interleaved with
 * one row per harness tool call or an aggregated row for Chat tools.
 */
function TraceEntryRows({
  entries,
  streaming,
  phase,
  showReasoningDuration = false,
}: {
  entries: AgentTraceEntry[];
  streaming: boolean;
  phase: AgentStepsPhase | null;
  /** Per-response groups label the step time ("Raciocínio 2s"); Chat doesn't. */
  showReasoningDuration?: boolean;
}) {
  const lastReasoningIndex = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].kind === 'reasoning') return index;
    }
    return -1;
  }, [entries]);

  const { t } = useTranslation('chat');

  return (
    <ol className="flex flex-col gap-1">
      {entries.map((entry, index) => {
        if (entry.kind === 'reasoning') {
          // Reasoning is Markdown (docs/MARKDOWN.md §4) rendered by the
          // compact/muted `Markdown` variant. The streaming caret belongs
          // only to the last block while the model is thinking; the row
          // itself starts collapsed like a tool row.
          return (
            <ReasoningRow
              key={`reasoning-${index}`}
              text={entry.text}
              label={showReasoningDuration ? t('trace.reasoning') : undefined}
              durationMs={showReasoningDuration ? (entry.durationMs ?? null) : null}
              streaming={streaming && phase === 'reasoning' && index === lastReasoningIndex}
            />
          );
        }

        // Tools do harness: detalhe por chamada (verbo + alvo + status +
        // diff/saída sob demanda), como o "Think/Edit/Pwsh" do DSH.
        if (CODE_TOOL_NAMES.has(entry.group.name)) {
          return (
            <Fragment key={`tools-${index}`}>
              {entry.group.tools.map((tool) => (
                <ToolCallRow
                  key={tool.id}
                  tool={tool}
                  icon={TOOL_ICONS[tool.name] ?? Wrench}
                />
              ))}
            </Fragment>
          );
        }

        return (
          <li
            key={`tools-${index}`}
            className="flex min-w-0 items-start gap-2.5 rounded-lg px-1.5 py-1"
          >
            <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
              <ToolMarker group={entry.group} />
            </span>
            <ToolActivity group={entry.group} />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The "thinking space" of an assistant turn (DESIGN §6.3): a single
 * collapsible timeline that interleaves the model's reasoning with the steps
 * it took (web searches, pages read, files created), replacing the old
 * stand-alone reasoning block and tool cards.
 */
export function AgentSteps({ message, streaming, phase, startedAt, className }: AgentStepsProps) {
  const { t, i18n } = useTranslation('chat');
  const reduceMotion = useReduceMotion();
  // `buildAgentTrace` resolves localized labels, so the language is a dependency.
  const entries = useMemo(
    () => buildAgentTrace(message),
    [message.reasoning, message.toolCalls, message.trace, i18n.language],
  );
  const hasReasoning = hasTraceReasoning(entries);
  const toolCount = countTraceTools(entries);
  const running = entries.some(
    (entry) => entry.kind === 'tools' && entry.group.status === 'running',
  );
  const liveElapsed = useLiveElapsed(streaming, startedAt);

  // Decisão de UX (2026-10): os cards de apresentação das tools (`file_change`,
  // `todos`, `plan`, `job`, `answers`) **não** são mais renderizados no
  // transcript. O bloco "Thinking" já mostra o que o agente está fazendo e os
  // estados de plano/tarefas/jobs vivem no popover do composer
  // (`CodeSessionControls`), evitando duplicação e poluição do chat.

  // Auto-open while the agent works and collapse once the answer is ready
  // (same behavior as the previous reasoning block; the user can reopen).
  // Layout Agentes: o bloco de pensamento/trabalho começa fechado por padrão,
  // independentemente da preferência global. O usuário ainda pode expandir.
  // Layout Code: o tempo do turno inclui ferramentas e comandos, então o
  // título agregado fala em "Trabalhou por …". No Chat o bloco resume apenas o
  // raciocínio do modelo → "Pensou por …" (DESIGN §6.3).
  const layoutMode = useUiStore((state) => state.layoutMode);
  const collapsedByDefault =
    useAppStore((state) => state.settings.thinkingCollapsedByDefault) ||
    layoutMode === 'agent';
  const [open, setOpen] = useState(() => (collapsedByDefault ? false : streaming));
  const wasStreaming = useRef(streaming);
  const previousLayout = useRef(layoutMode);
  useEffect(() => {
    if (layoutMode === 'agent' && previousLayout.current !== 'agent') {
      setOpen(false);
    }
    previousLayout.current = layoutMode;
  }, [layoutMode]);
  useEffect(() => {
    const was = wasStreaming.current;
    wasStreaming.current = streaming;
    if (collapsedByDefault) return;
    if (streaming) setOpen(true);
    else if (was) setOpen(false);
  }, [streaming, collapsedByDefault]);

  // Per-response transcript (Code and Agentes): intermediate narration from
  // the trace becomes normal body text and the work after it is collapsed
  // into "Usou N …" groups. Chat keeps the single thinking block above the
  // answer; legacy messages without `trace[].text` fall back to it too.
  const blocks = useMemo(
    () => buildAgentResponseBlocks(message),
    [message.toolCalls, message.trace, i18n.language],
  );
  const segmented =
    layoutMode !== 'chat' && blocks.some((block) => block.kind === 'text');
  if (segmented) {
    return (
      <SegmentedTimeline
        blocks={blocks}
        streaming={streaming}
        phase={phase}
        collapsedByDefault={collapsedByDefault}
        turnDurationMs={message.usage?.durationMs ?? null}
        className={className}
      />
    );
  }

  const visible = entries.length > 0 || (streaming && phase !== 'text');
  if (!visible) return null;

  const working = streaming && phase !== 'text';
  const duration = formatThinkingDuration(
    streaming ? liveElapsed : (message.usage?.durationMs ?? null),
  );
  const title = working
    ? running && phase === 'tool'
      ? t('trace.toolsRunning')
      : t('trace.thinking')
    : hasReasoning
      ? duration
        ? t(layoutMode === 'code' ? 'trace.workedFor' : 'trace.thoughtFor', { duration })
        : t('trace.reasoning')
      : toolCount > 0
        ? t('trace.steps', { count: toolCount })
        : t('trace.reasoning');
  const shimmer = working && !reduceMotion;

  return (
    <div className={className}>
      <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-3">
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className={cn(
            'group/steps flex items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] font-medium text-foreground-muted',
            'transition-colors duration-150 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
        >
          <Brain
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              streaming ? 'text-accent' : 'text-foreground-subtle',
            )}
          />
          <span
            className={cn(
              shimmer &&
                'bg-linear-to-r from-foreground-muted via-foreground to-foreground-muted bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer',
            )}
          >
            {title}
          </span>
          {working && liveElapsed !== null ? (
            <span className="text-[12px] font-normal tabular-nums text-foreground-subtle">
              · {formatDuration(liveElapsed)}
            </span>
          ) : null}
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-foreground-subtle transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div
          className={cn(
            'mt-2.5 pl-0.5',
            !streaming && 'max-h-80 overflow-y-auto overscroll-contain pr-1',
          )}
        >
          <TraceEntryRows entries={entries} streaming={streaming} phase={phase} />
        </div>
      </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}

/**
 * Per-response transcript (layouts Code and Agentes): the model's narration as
 * body Markdown, each followed by a collapsed group with the execution that
 * happened until the next narration (DESIGN §6.3).
 */
function SegmentedTimeline({
  blocks,
  streaming,
  phase,
  collapsedByDefault,
  turnDurationMs,
  className,
}: {
  blocks: AgentResponseBlock[];
  streaming: boolean;
  phase: AgentStepsPhase | null;
  collapsedByDefault: boolean;
  /** Total turn time, shown on the last execution line once it ends. */
  turnDurationMs: number | null;
  className?: string;
}) {
  let lastExecution = -1;
  blocks.forEach((block, index) => {
    if (block.kind === 'execution') lastExecution = index;
  });

  return (
    <div className={className}>
      {blocks.map((block, index) =>
        block.kind === 'text' ? (
          <div key={`text-${index}`} className="mb-3">
            <Markdown content={block.text} />
          </div>
        ) : (
          <ExecutionGroup
            key={`exec-${index}`}
            entries={block.entries}
            durationMs={block.durationMs}
            turnDurationMs={turnDurationMs}
            isLast={index === lastExecution}
            streaming={streaming}
            phase={phase}
            live={streaming && index === lastExecution && phase !== 'text'}
            collapsedByDefault={collapsedByDefault}
          />
        ),
      )}
    </div>
  );
}

interface ExecutionGroupProps {
  entries: AgentTraceEntry[];
  /** Work time of this stretch (model steps + tool calls). */
  durationMs: number;
  /** Total turn time, shown on the last line once the turn ends. */
  turnDurationMs: number | null;
  isLast: boolean;
  streaming: boolean;
  phase: AgentStepsPhase | null;
  /** Current (last) execution group of a streaming turn. */
  live: boolean;
  collapsedByDefault: boolean;
}

/**
 * One execution line of the per-response transcript. While its stretch runs it
 * shows the live activity ("Analisando a solicitação · …", "Executando
 * comandos · …"); once done it summarizes the work as "Trabalhou por …". Its
 * rows are the reasoning/tool entries in chronological order.
 */
function ExecutionGroup({
  entries,
  durationMs,
  turnDurationMs,
  isLast,
  streaming,
  phase,
  live,
  collapsedByDefault,
}: ExecutionGroupProps) {
  const { t } = useTranslation('chat');
  const reduceMotion = useReduceMotion();
  const activity = live ? describeTraceActivity(entries) : null;
  const hasTools = entries.some(
    (entry) => entry.kind === 'tools' && entry.group.tools.length > 0,
  );
  const running = entries.some(
    (entry) => entry.kind === 'tools' && entry.group.status === 'running',
  );
  const detailsId = useId();
  const [open, setOpen] = useState(() => !collapsedByDefault && live);
  const wasLive = useRef(live);
  useEffect(() => {
    const was = wasLive.current;
    wasLive.current = live;
    if (collapsedByDefault) {
      if (!live && was) setOpen(false);
      return;
    }
    if (live) setOpen(true);
    else if (was) setOpen(false);
  }, [live, collapsedByDefault]);

  // The last line closes the turn, so it reports the whole turn time; earlier
  // stretches report their own work time.
  const elapsed = isLast ? (turnDurationMs ?? durationMs) : durationMs;
  const finishedDuration = elapsed > 0 ? formatThinkingDuration(elapsed) : null;
  const finishedLabel = finishedDuration
    ? t('trace.workedFor', { duration: finishedDuration })
    : hasTools
      ? t('trace.worked')
      : t('trace.reasoned');
  const label = live ? (activity?.label ?? t('trace.working')) : finishedLabel;
  const preview = live ? (activity?.preview ?? null) : null;
  const ActiveIcon =
    activity?.kind === 'tool' ? (TOOL_ICONS[activity.toolName ?? ''] ?? Wrench) : null;
  const shimmer = live && !reduceMotion;

  return (
    <div className="mb-3">
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger asChild>
          <button
            type="button"
            aria-controls={detailsId}
            className={cn(
              'group/execution flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-[13px] font-medium text-foreground-muted',
              'transition-colors duration-150 hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            )}
          >
            {live ? (
              ActiveIcon ? (
                <ActiveIcon
                  aria-hidden
                  className={cn(
                    'size-3.5 shrink-0',
                    running ? 'text-accent' : 'text-foreground-subtle',
                  )}
                />
              ) : (
                <Spinner size="xs" className="text-accent" />
              )
            ) : hasTools ? (
              <Wrench aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
            ) : (
              <Brain aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
            )}
            <span
              className={cn(
                'shrink-0',
                shimmer &&
                  'bg-linear-to-r from-foreground-muted via-foreground to-foreground-muted bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer',
              )}
            >
              {label}
            </span>
            {preview ? (
              <>
                <span aria-hidden className="shrink-0 text-foreground-subtle">
                  ·
                </span>
                <span className="min-w-0 truncate text-[12px] font-normal text-foreground-subtle">
                  {preview}
                </span>
              </>
            ) : null}
            <ChevronDown
              aria-hidden
              className={cn(
                'ml-auto size-3.5 shrink-0 text-foreground-subtle transition-transform duration-150',
                open && 'rotate-180',
              )}
            />
          </button>
        </Collapsible.Trigger>

        <Collapsible.Content>
          <div
            id={detailsId}
            className={cn(
              'mt-2.5 pl-0.5',
              !streaming && 'max-h-80 overflow-y-auto overscroll-contain pr-1',
            )}
          >
            <TraceEntryRows
              entries={entries}
              streaming={streaming && live}
              phase={phase}
              showReasoningDuration
            />
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}

function ToolMarker({ group }: { group: ToolGroup }): ReactNode {
  if (group.status === 'running') {
    return <Spinner size="xs" className="text-foreground-subtle" />;
  }
  if (group.status === 'error') {
    return <TriangleAlert className="size-3.5 text-danger" />;
  }
  const Icon = TOOL_ICONS[group.name] ?? Wrench;
  return <Icon className="size-3.5 text-foreground-subtle" />;
}

function ToolActivity({ group }: { group: ToolGroup }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] leading-relaxed text-foreground-muted">{group.label}</span>
        {group.domains.length > 0 ? <DomainSources domains={group.domains} /> : null}
      </div>

      {group.errors.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {group.errors.map((error, index) => (
            <li key={index} className="break-words text-[12px] leading-relaxed text-danger">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      {group.pages.length > 0 ? <PageLinks pages={group.pages} /> : null}
      {group.files.length > 0 ? <FileChips files={group.files} /> : null}
    </div>
  );
}

/** Source avatars (one letter per domain) — reads like a row of favicons. */
function DomainSources({ domains }: { domains: string[] }) {
  const { t } = useTranslation('chat');
  const visible = domains.slice(0, MAX_DOMAINS);
  const hidden = domains.length - visible.length;
  return (
    <span
      role="img"
      aria-label={t('trace.sourcesAria', { domains: domains.join(', ') })}
      className="flex items-center gap-1"
    >
      <span aria-hidden className="flex items-center -space-x-1">
        {visible.map((domain) => (
          <span
            key={domain}
            title={domain}
            className="flex size-4 items-center justify-center rounded-full bg-accent-soft text-[8px] font-semibold uppercase leading-none text-accent"
          >
            {domain.charAt(0)}
          </span>
        ))}
      </span>
      {hidden > 0 ? (
        <span className="text-[10px] tabular-nums text-foreground-subtle">+{hidden}</span>
      ) : null}
    </span>
  );
}

/** Pages read by `fetch_url`: dashed-underline links that open in the browser. */
function PageLinks({ pages }: { pages: PageLink[] }) {
  const { t } = useTranslation('chat');
  const visible = pages.slice(0, MAX_PAGE_CHIPS);
  const hidden = pages.length - visible.length;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      {visible.map((page) => (
        <button
          key={page.url}
          type="button"
          onClick={() => void openExternalUrl(page.url)}
          title={page.url}
          aria-label={t('trace.openPageAria', { title: page.title })}
          className={cn(
            'group/page flex max-w-full items-center gap-1 border-b border-dashed border-border-strong pb-px text-left',
            'text-[12px] font-medium text-foreground-muted transition-colors duration-150',
            ' hover:text-foreground',
            'focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
        >
          <span className="min-w-0 truncate">{truncate(page.title, 72)}</span>
          <ArrowUpRight
            aria-hidden
            className="size-3 shrink-0 opacity-60 transition-opacity group-hover/page:opacity-100"
          />
        </button>
      ))}
      {hidden > 0 ? (
        <span className="text-[11px] tabular-nums text-foreground-subtle">+{hidden}</span>
      ) : null}
    </div>
  );
}

/** Artifact names created by `create_file` (the artifact card is rendered below). */
function FileChips({ files }: { files: string[] }) {
  const visible = files.slice(0, MAX_FILE_CHIPS);
  const hidden = files.length - visible.length;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {visible.map((file) => (
        <span
          key={file}
          title={file}
          className="flex h-6 max-w-60 items-center gap-1.5 rounded-full bg-surface px-2 text-[11px] text-foreground-muted"
        >
          <FileText aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
          <span className="truncate">{truncate(file, 48)}</span>
        </span>
      ))}
      {hidden > 0 ? (
        <span className="text-[11px] tabular-nums text-foreground-subtle">+{hidden}</span>
      ) : null}
    </div>
  );
}
