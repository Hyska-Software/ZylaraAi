import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Copy,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { DiffView } from '@/components/code/DiffView';
import { GenUIBlock } from '@/components/genui';
import { Spinner } from '@/components/ui';
import { describeCodeTool, type CodeToolLabel } from '@/lib/agentTrace';
import { useChatStore, useUiStore, type CodeSubagentTab } from '@/lib/store';
import { api } from '@/lib/api';
import type { ToolCallRecord, ToolImageRef } from '@/lib/types';
import { cn, copyText, formatDuration } from '@/lib/utils';

export interface ToolCallRowProps {
  tool: ToolCallRecord;
  icon: LucideIcon;
  className?: string;
}

function parseExitCode(result: string | null | undefined): number | null {
  if (!result) return null;
  const match = result.match(/\[exit code:\s*(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function parseResultDuration(result: string | null | undefined): number | null {
  if (!result) return null;
  const match = result.match(/\(duração:\s*(\d+)\s*ms\)/);
  return match ? Number(match[1]) : null;
}

/** Corpo da saída sem as linhas de metadados que já viram badges na linha. */
function resultBody(result: string | null | undefined): string {
  if (!result) return '';
  return result
    .split('\n')
    .filter(
      (line) =>
        !/^\[exit code:/.test(line.trim()) && !/^\(duração:/.test(line.trim()),
    )
    .join('\n')
    .trim();
}

function fileChangeOf(tool: ToolCallRecord) {
  return tool.presentation?.kind === 'file_change' ? tool.presentation : null;
}

function taskPrompt(tool: ToolCallRecord): string | null {
  try {
    const parsed = JSON.parse(tool.arguments) as { prompt?: unknown };
    return typeof parsed.prompt === 'string' ? parsed.prompt : null;
  } catch {
    return null;
  }
}

function durationMs(tool: ToolCallRecord): number | null {
  if (tool.startedAt != null && tool.finishedAt != null) {
    return Math.max(0, tool.finishedAt - tool.startedAt);
  }
  return parseResultDuration(tool.result);
}

function ExpandedOutput({
  body,
  error,
  id,
}: {
  body: string;
  error: boolean;
  id: string;
}) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyText(body);
    if (!ok) {
      toast.error(t('tool.copyOutputFailed'));
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };
  return (
    <div
      id={id}
      className="mt-1 overflow-hidden rounded-lg bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1">
        <SquareTerminal aria-hidden className="size-3 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 text-[10.5px] font-medium uppercase tracking-wide text-foreground-subtle">
          {error ? t('tool.outputFailed') : t('tool.output')}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t('tool.copyOutput')}
          className="flex size-6 shrink-0 items-center justify-center rounded text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Copy aria-hidden className={cn('size-3', copied && 'text-success')} />
        </button>
      </div>
      <pre
        tabIndex={0}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-background p-2.5 font-mono text-[11px] leading-relaxed text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        {body}
      </pre>
    </div>
  );
}

function ToolImageThumb({ image, index }: { image: ToolImageRef; index: number }) {
  const { t } = useTranslation('chat');
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api
      .toolImagePreview(image.path)
      .then((value) => {
        if (!disposed) setSrc(value);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [image.path]);
  if (failed) {
    return (
      <span className="flex h-24 items-center justify-center rounded-lg bg-surface px-2 text-[10px] text-foreground-subtle">
        {t('tool.imageUnavailable')}
      </span>
    );
  }
  return src ? (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="block overflow-hidden rounded-lg bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      aria-label={t('tool.openScreenshot', { index: index + 1 })}
    >
      <img
        src={src}
        alt={t('tool.screenshotAlt', { index: index + 1 })}
        className="max-h-48 w-full object-contain"
      />
    </a>
  ) : (
    <span className="flex h-24 items-center justify-center rounded-lg bg-surface">
      <Spinner size="sm" />
    </span>
  );
}

function ToolImages({ images }: { images: ToolImageRef[] }) {
  if (images.length === 0) return null;
  return (
    <div className="mt-1 grid gap-2 sm:grid-cols-2">
      {images.map((image, index) => (
        <ToolImageThumb key={`${image.path}-${index}`} image={image} index={index} />
      ))}
    </div>
  );
}

/**
 * Uma linha da timeline de execução do agente (WORKBENCH §5.2).
 *
 * A linha resume a tool (verbo + alvo + status + `+N −M`/`exit code`); o detalhe
 * sob demanda mostra o diff (com syntax highlight, via `DiffView`) ou a saída do
 * comando. Falhas abrem com a saída visível por padrão.
 */
export function ToolCallRow({ tool, icon: Icon, className }: ToolCallRowProps) {
  const { t } = useTranslation('chat');
  const detailsId = useId();
  const meta: CodeToolLabel = describeCodeTool(tool);
  const change = fileChangeOf(tool);
  const diff = change?.diff?.trim() ?? '';
  const body = resultBody(tool.result);
  const exitCode = parseExitCode(tool.result);
  const duration = durationMs(tool);
  const running = tool.status === 'running';
  const failed = tool.status === 'error' || (exitCode !== null && exitCode !== 0);
  const hasDetails = Boolean(diff) || Boolean(body) || (tool.images?.length ?? 0) > 0;
  const [expanded, setExpanded] = useState(
    () => hasDetails && (tool.status === 'error' || (exitCode !== null && exitCode !== 0)),
  );
  const liveSubagent = useChatStore(
    (state) => state.streaming?.subagents?.[tool.id] ?? null,
  );
  const subagentPresentation =
    tool.presentation?.kind === 'subagent' ? tool.presentation : null;
  const genuiSource =
    tool.presentation?.kind === 'genui' && typeof tool.presentation.source === 'string'
      ? tool.presentation.source
      : null;
  const subagentConversationId =
    liveSubagent?.conversationId ?? subagentPresentation?.conversationId ?? null;

  const openSubagentChat = () => {
    if (!subagentConversationId) return;
    const target: CodeSubagentTab = {
      conversationId: subagentConversationId,
      taskCallId: liveSubagent?.taskCallId ?? tool.id,
      subagentType:
        liveSubagent?.subagentType ?? subagentPresentation?.subagentType ?? 'explore',
      description:
        liveSubagent?.description ?? subagentPresentation?.description ?? t('tool.subagentDefault'),
      providerId: liveSubagent?.providerId ?? subagentPresentation?.providerId ?? null,
      modelId: liveSubagent?.modelId ?? subagentPresentation?.modelId ?? null,
      effort: liveSubagent?.effort ?? subagentPresentation?.effort ?? null,
      prompt: liveSubagent?.prompt ?? taskPrompt(tool),
    };
    const result = useUiStore.getState().openCodeSubagent(target);
    if (result === 'exists') {
      toast.info(t('tool.subagentAlreadyOpen'));
    }
  };

  const header = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-[12px] font-semibold text-foreground">{meta.verb}</span>
      {meta.detail ? (
        <code
          title={meta.detail}
          className="min-w-0 max-w-full truncate font-mono text-[11.5px] text-foreground-muted"
        >
          {meta.detail}
        </code>
      ) : null}
      {change ? (
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
          <span className="text-success">+{change.added}</span>{' '}
          <span className="text-danger">−{change.removed}</span>
        </span>
      ) : null}
      {exitCode != null ? (
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums',
            exitCode === 0 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
          )}
        >
          exit {exitCode}
        </span>
      ) : null}
      {duration != null && duration > 0 ? (
        <span className="shrink-0 text-[10.5px] tabular-nums text-foreground-subtle">
          {formatDuration(duration)}
        </span>
      ) : null}
      {running ? <Spinner size="xs" className="text-foreground-subtle" /> : null}
      {failed ? (
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-danger" />
      ) : null}
      {hasDetails ? (
        <ChevronDown
          aria-hidden
          className={cn(
            'ml-auto size-3.5 shrink-0 text-foreground-subtle transition-transform duration-150',
            expanded && 'rotate-180',
          )}
        />
      ) : null}
    </div>
  );

  return (
    <li aria-label={meta.label} className={cn('min-w-0', className)}>
      <div
        className={cn(
          'flex min-w-0 items-start gap-2.5 rounded-lg px-1.5 py-1 transition-colors',
          hasDetails && 'hover:bg-surface-hover/60',
        )}
      >
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            failed ? 'text-danger' : 'text-foreground-subtle',
          )}
        />
        {hasDetails ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
            className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {header}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{header}</div>
        )}
      </div>

      {liveSubagent || subagentConversationId ? (
        <div className="ml-[26px] mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-foreground-muted">
          {liveSubagent ? (
            <>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  liveSubagent.status === 'running'
                    ? 'bg-accent-soft text-accent'
                    : liveSubagent.status === 'error'
                      ? 'bg-danger-soft text-danger'
                      : 'bg-success-soft text-success',
                )}
              >
                {liveSubagent.status === 'running'
                  ? t('tool.statusLive')
                  : liveSubagent.status === 'done'
                    ? t('tool.statusDone')
                    : liveSubagent.status === 'error'
                      ? t('tool.statusError')
                      : t('tool.statusCancelled')}
              </span>
              <span className="tabular-nums">{t('tool.steps', { count: liveSubagent.steps })}</span>
              {liveSubagent.usage?.totalTokens != null ? (
                <span className="tabular-nums">
                  {t('tool.tokens', { tokens: liveSubagent.usage.totalTokens })}
                </span>
              ) : null}
              {liveSubagent.effort ? (
                <span>{t('tool.effort', { effort: liveSubagent.effort })}</span>
              ) : null}
              <code className="min-w-0 truncate font-mono text-[10.5px] text-foreground-subtle">
                {liveSubagent.providerId}/{liveSubagent.modelId}
              </code>
              {liveSubagent.error ? (
                <span className="min-w-0 truncate text-danger">{liveSubagent.error}</span>
              ) : liveSubagent.text.trim() ? (
                <span className="min-w-0 max-w-[420px] truncate text-foreground-subtle">
                  {liveSubagent.text.trim().slice(-140)}
                </span>
              ) : null}
            </>
          ) : null}
          {subagentConversationId ? (
            <button
              type="button"
              onClick={openSubagentChat}
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t('tool.openChat')}
            </button>
          ) : null}
        </div>
      ) : null}

      {genuiSource ? (
        <div className="ml-[26px] mt-1 min-w-0">
          <GenUIBlock source={genuiSource} />
        </div>
      ) : null}

      {expanded && hasDetails ? (
        <div className="ml-[26px]">
          <ToolImages images={tool.images ?? []} />
          {diff ? (
            <div
              id={detailsId}
              className="mt-1 overflow-hidden rounded-lg "
            >
              <DiffView path={change?.path ?? meta.detail ?? 'diff'} diff={diff} />
            </div>
          ) : body ? (
            <ExpandedOutput id={detailsId} body={body} error={failed} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default ToolCallRow;
