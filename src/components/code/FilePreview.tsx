import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  CircleAlert,
  Copy,
  ExternalLink,
  FileExclamationPoint,
  FileQuestionMark,
  FileWarning,
  RefreshCw,
  WrapText,
} from 'lucide-react';
import { Badge, Button, IconButton, SegmentedControl, Spinner, Tooltip } from '@/components/ui';
import { Markdown } from '@/components/chat/Markdown';
import { buildInlineDiff, type InlineDiff } from '@/lib/diff';
import { languageLabel, normalizeLanguage, prism, SYNTAX_THEME } from '@/lib/highlight';
import { useUiStore } from '@/lib/store';
import { cn, copyText, formatBytes } from '@/lib/utils';
import type { WorkspaceFileContent } from '@/lib/types';
import { Highlight } from 'prism-react-renderer';
import { toast } from 'sonner';
import { FileIcon } from './FileIcon';
import { FilePreviewImage } from './FilePreviewImage';
import { FilePreviewPdf } from './FilePreviewPdf';

export interface FilePreviewProps {
  /** File content returned by `api.readWorkspaceFile`. */
  content?: WorkspaceFileContent | null;
  loading?: boolean;
  error?: string | null;
  /** Unified diff of the working tree against HEAD; rendered as inline marks. */
  diff?: string | null;
  /** True while the diff is being loaded (header indicator). */
  diffLoading?: boolean;
  /** Diff load failure; the file content still renders. */
  diffError?: string | null;
  /** Opens the file in the user's external editor (container owns the action). */
  onOpenExternal?: (path: string) => void;
  /** Re-reads the file from the backend (reload button in the header / retry). */
  onReload?: () => void;
  className?: string;
}

/** Modo do ramo Markdown: documento renderizado (padrão) ou fonte. */
type MarkdownViewMode = 'document' | 'code';

const INLINE_TONE_BG = {
  added: 'bg-success-soft',
  modified: 'bg-warning-soft',
} as const;

/** Maps a path extension to a Prism language id. */
export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? path;
  const lowered = name.toLowerCase();
  if (lowered === 'dockerfile' || lowered === 'containerfile') return 'docker';
  if (lowered === 'makefile') return 'makefile';
  if (lowered.startsWith('.env')) return 'ini';
  const dot = lowered.lastIndexOf('.');
  if (dot < 0) return 'text';
  return normalizeLanguage(lowered.slice(dot + 1));
}

/**
 * Read-only workspace file preview for the Code center tab (WORKBENCH §7.1).
 *
 * Renders highlighted source with line numbers (shared Prism instance of
 * `src/lib/highlight`); images and PDFs get the real visualização (checkerboard
 * image viewer / pdf.js), and binary, oversized-preview (`previewOmitted`) and
 * unsupported-format files keep honest cards. Copy path, "abrir no editor
 * externo" and the optional reload live in the header; both external actions
 * are delegated to the container.
 */
export function FilePreview({
  content,
  loading,
  error,
  diff,
  diffLoading,
  diffError,
  onOpenExternal,
  onReload,
  className,
}: FilePreviewProps) {
  const { t } = useTranslation('code');
  const markdownViewOptions = [
    { value: 'document', label: t('code:preview.markdown.document') },
    { value: 'code', label: t('code:preview.markdown.code') },
  ];
  const [copied, setCopied] = useState(false);
  /** Ramo Markdown: documento renderizado por padrão, estado local à aba. */
  const [mdView, setMdView] = useState<MarkdownViewMode>('document');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Quebra de linha é uma preferência GLOBAL do workbench (persistida no
     `uiStore`): vale para todas as abas de arquivo, não só para a atual. */
  const codeFileWrap = useUiStore((state) => state.codeFileWrap);
  const setCodeFileWrap = useUiStore((state) => state.setCodeFileWrap);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /* A new file resets the transient "copiado" feedback and the Markdown mode
     (each aba always starts at Documento). */
  useEffect(() => {
    setCopied(false);
    setMdView('document');
  }, [content?.path]);

  const path = content?.path ?? '';
  const language = useMemo(() => {
    const detected = languageForPath(path);
    // Missing grammar → plain text with an honest label (same rule as DiffView).
    return prism.languages[detected] ? detected : 'text';
  }, [path]);
  const lines = useMemo(() => {
    const text = content?.text ?? '';
    return text.length ? text.replace(/\r\n?/g, '\n').split('\n') : [];
  }, [content?.text]);
  const inline = useMemo(
    () => (diff ? buildInlineDiff(diff, lines.length) : null),
    [diff, lines.length],
  );

  const handleCopyPath = async () => {
    if (!path) return;
    const ok = await copyText(path);
    if (!ok) {
      toast.error(t('code:preview.copyError'));
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  if (loading) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="h-3 w-40 animate-pulse rounded bg-surface-hover motion-reduce:animate-none" />
          <Spinner size="xs" label={t('code:preview.loading')} className="ml-auto" />
        </div>
        <div aria-hidden className="flex-1 space-y-2 p-3">
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <div
              key={row}
              className="h-3 animate-pulse rounded bg-surface-hover motion-reduce:animate-none"
              style={{ width: `${90 - row * 8}%` }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          'flex h-full min-h-0 flex-col items-center justify-center gap-2 px-6 py-8 text-center',
          className,
        )}
      >
        <span className="flex size-9 items-center justify-center rounded-xl bg-danger-soft text-danger">
          <CircleAlert aria-hidden className="size-4" strokeWidth={1.75} />
        </span>
        <p className="text-[12.5px] font-medium text-foreground">{t('code:preview.errorTitle')}</p>
        <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">{error}</p>
        {onReload ? (
          <Button size="sm" variant="secondary" className="mt-1" onClick={onReload}>
            {t('common:actions.retry')}
          </Button>
        ) : null}
      </div>
    );
  }

  if (!content) {
    return (
      <div
        className={cn(
          'flex h-full min-h-0 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center',
          className,
        )}
      >
        <FileQuestionMark aria-hidden className="size-5 text-foreground-subtle" strokeWidth={1.75} />
        <p className="text-[12.5px] font-medium text-foreground">{t('code:preview.noneTitle')}</p>
        <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">
          {t('code:preview.noneDescription')}
        </p>
      </div>
    );
  }

  const mimeType = content.mimeType?.trim().toLowerCase() ?? '';
  const payload = content.dataBase64 ?? '';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const headerActionProps = {
    path: content.path,
    copied,
    onCopy: () => void handleCopyPath(),
    onOpenExternal,
    onReload,
  };
  const headerActions = <HeaderActions {...headerActionProps} />;
  /* A quebra de linha só faz sentido no ramo de texto/código: imagem, PDF,
     binário e prévia omitida não ganham o botão. */
  const textHeaderActions = (
    <HeaderActions
      {...headerActionProps}
      wrap={codeFileWrap}
      onToggleWrap={() => setCodeFileWrap(!codeFileWrap)}
    />
  );
  /* `.md`/`.markdown`/`.mdx` (mapa de `src/lib/highlight/languages.ts`) podem
     alternar entre o documento renderizado e a fonte; o padrão é Documento. */
  const isMarkdown = language === 'markdown';
  const showMarkdownDocument = isMarkdown && mdView === 'document';
  /* Marks need the source lines: the rendered document has none, and a
     truncated preview can end before the diff's line numbers. The summary
     still shows in both cases. */
  const inlineMarks = !showMarkdownDocument && !content.truncated ? inline : null;

  /* Imagem com payload: o visualizador real (xadrez, zoom, fit/1:1). */
  if (isImage && payload) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <PreviewHeader path={content.path}>{headerActions}</PreviewHeader>
        <FilePreviewImage
          path={content.path}
          mimeType={mimeType}
          dataBase64={payload}
          className="min-h-0 flex-1"
        />
      </div>
    );
  }

  /* PDF com payload: pdf.js (páginas + zoom) dentro da mesma aba. */
  if (isPdf && payload) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <PreviewHeader path={content.path}>
          <Badge tone="neutral" size="sm" className="shrink-0">
            PDF
          </Badge>
          {headerActions}
        </PreviewHeader>
        <FilePreviewPdf path={content.path} dataBase64={payload} className="min-h-0 flex-1" />
      </div>
    );
  }

  /* Payload binário omitido por tamanho: cartão honesto, sem prometer prévia. */
  if (content.previewOmitted) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <PreviewHeader path={content.path}>{headerActions}</PreviewHeader>
        <PreviewNotice
          icon={<FileWarning aria-hidden className="size-4" strokeWidth={1.75} />}
          title={t('code:preview.omitted.title')}
          description={t('code:preview.omitted.description', { size: formatBytes(content.size) })}
        />
      </div>
    );
  }

  /* Imagem/PDF conhecidos sem payload: formato sem prévia no visualizador.
     Quando o backend manda texto (ex.: SVG pelo caminho de texto), o ramo de
     código abaixo continua sendo o honesto — não escondemos o conteúdo. */
  if ((isImage || isPdf) && !content.text) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <PreviewHeader path={content.path}>{headerActions}</PreviewHeader>
        <PreviewNotice
          icon={<FileWarning aria-hidden className="size-4" strokeWidth={1.75} />}
          title={t('code:preview.unsupported.title')}
          description={t('code:preview.unsupported.description', { size: formatBytes(content.size) })}
        />
      </div>
    );
  }

  if (content.binary) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <PreviewHeader path={content.path}>{headerActions}</PreviewHeader>
        <PreviewNotice
          icon={<FileExclamationPoint aria-hidden className="size-4" strokeWidth={1.75} />}
          title={t('code:preview.binary.title')}
          description={t('code:preview.binary.description', { size: formatBytes(content.size) })}
        />
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <PreviewHeader path={content.path}>
        {isMarkdown ? (
          <SegmentedControl
            size="sm"
            ariaLabel={t('code:preview.markdown.modeAria')}
            options={markdownViewOptions}
            value={mdView}
            onChange={(value) => setMdView(value === 'code' ? 'code' : 'document')}
            className="shrink-0"
          />
        ) : (
          <>
            <Badge tone="neutral" size="sm" className="shrink-0 font-mono">
              {languageLabel(language)}
            </Badge>
            <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
              {t('code:preview.lineInfo', { count: lines.length, size: formatBytes(content.size) })}
            </span>
          </>
        )}
        <DiffSummary inline={inline} loading={diffLoading} error={diffError} />
        {showMarkdownDocument ? headerActions : textHeaderActions}
      </PreviewHeader>

      {content.encoding && !/^utf-?8$/i.test(content.encoding) ? (
        <p
          role="note"
          className="shrink-0 border-b border-warning/30 bg-warning-soft px-3 py-1.5 text-[11.5px] text-warning"
        >
          {t('code:preview.encoding', { encoding: content.encoding })}
        </p>
      ) : null}

      {content.truncated ? (
        <p
          role="note"
          className="shrink-0 border-b border-border bg-surface px-3 py-1.5 text-[11.5px] text-foreground-muted"
        >
          {t('code:preview.truncated', { size: formatBytes(content.size) })}
        </p>
      ) : null}

      {showMarkdownDocument ? (
        content.text.trim().length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-[12px] text-foreground-muted">
            {t('code:preview.markdownEmpty')}
          </div>
        ) : (
          <div
            role="region"
            aria-label={t('code:preview.markdownRegion')}
            className="min-h-0 flex-1 overflow-auto bg-background"
          >
            {/* Mesmo pipeline GFM/KaTeX + sanitização da conversa. */}
            <div className="mx-auto w-full max-w-3xl px-6 py-5">
              <Markdown content={content.text} />
            </div>
          </div>
        )
      ) : lines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 py-8 text-center text-[12px] text-foreground-muted">
          {t('code:preview.emptyFile')}
        </div>
      ) : (
        <div
          className={cn(
            'min-h-0 flex-1 bg-background',
            /* Com quebra ligada não existe rolagem horizontal: a linha quebra
               dentro do espaço. Desligada, a rolagem horizontal é a esperada. */
            codeFileWrap ? 'overflow-y-auto overflow-x-hidden' : 'overflow-auto',
          )}
        >
          <Highlight prism={prism} theme={SYNTAX_THEME} language={language} code={content.text}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre
                aria-label={t('code:preview.contentAria', { path: content.path })}
                className="min-w-full py-2 font-mono text-[12px] leading-[1.7]"
              >
                {tokens.map((line, lineIndex) => {
                  const lineProps = getLineProps({ line });
                  const lineNumber = lineIndex + 1;
                  const tone = inlineMarks?.lineTones.get(lineNumber);
                  const toneClass = tone ? INLINE_TONE_BG[tone] : undefined;
                  const removedCount = inlineMarks?.deletions.get(lineNumber);
                  const toneLabel =
                    tone === 'added'
                      ? t('code:preview.diff.addedLine')
                      : tone === 'modified'
                        ? t('code:preview.diff.modifiedLine')
                        : undefined;
                  return (
                    <Fragment key={lineIndex}>
                      {removedCount ? <DeletedLines count={removedCount} /> : null}
                      <div
                        {...lineProps}
                        data-diff-tone={tone}
                        className={cn(
                          lineProps.className,
                          'flex min-h-[20px] items-start',
                          toneClass,
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'sticky left-0 flex w-14 shrink-0 select-none items-center',
                            /* Mesmo fundo da linha para o gutter não cortar a faixa. */
                            toneClass ?? 'bg-background',
                          )}
                        >
                          <span
                            title={toneLabel}
                            className={cn(
                              'flex w-4 shrink-0 justify-center text-[11px] font-semibold',
                              tone === 'added'
                                ? 'text-success'
                                : tone === 'modified'
                                  ? 'text-warning'
                                  : undefined,
                            )}
                          >
                            {tone === 'added' ? '+' : tone === 'modified' ? '~' : ''}
                          </span>
                          <span className="w-10 shrink-0 pr-3 text-right text-[11px] tabular-nums text-foreground-subtle">
                            {lineNumber}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'min-w-0 pr-4',
                            /* Wrap global: a linha quebra dentro do espaço (sem
                               rolagem horizontal); desligado mantém `pre`. */
                            codeFileWrap
                              ? 'flex-1 whitespace-pre-wrap break-words'
                              : 'whitespace-pre',
                          )}
                        >
                          {line.map((token, tokenIndex) => (
                            <span key={tokenIndex} {...getTokenProps({ token })} />
                          ))}
                        </span>
                      </div>
                    </Fragment>
                  );
                })}
                {inlineMarks?.deletions.get(lines.length + 1) ? (
                  <DeletedLines
                    count={inlineMarks.deletions.get(lines.length + 1) ?? 0}
                  />
                ) : null}
              </pre>
            )}
          </Highlight>
        </div>
      )}
    </div>
  );
}

/** Cartão central honesto para binário/omitido/sem prévia (mesma moldura do binário). */
function PreviewNotice({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <span className="flex size-9 items-center justify-center rounded-xl bg-surface-hover text-foreground-muted">
        {icon}
      </span>
      <p className="text-[12.5px] font-medium text-foreground">{title}</p>
      <p className="max-w-64 text-[12px] leading-relaxed text-foreground-muted">{description}</p>
    </div>
  );
}

/** Header indicator for the inline diff: loading, failure or +N/−M. */
function DiffSummary({
  inline,
  loading,
  error,
}: {
  inline: InlineDiff | null;
  loading?: boolean;
  error?: string | null;
}) {
  const { t } = useTranslation('code');
  if (loading) return <Spinner size="xs" label={t('code:preview.diff.loading')} />;
  if (error) {
    return (
      <span
        role="img"
        aria-label={t('code:preview.diff.error')}
        title={error}
        className="inline-flex shrink-0 items-center text-warning"
      >
        <CircleAlert aria-hidden className="size-3.5" strokeWidth={1.75} />
      </span>
    );
  }
  if (!inline || inline.added + inline.removed === 0) return null;
  return (
    <span
      aria-label={t('code:preview.diff.summaryAria', {
        added: inline.added,
        removed: inline.removed,
      })}
      className="shrink-0 text-[11.5px] tabular-nums"
    >
      <span aria-hidden className="text-success">+{inline.added}</span>{' '}
      <span aria-hidden className="text-danger">−{inline.removed}</span>
    </span>
  );
}

/** A red arrow at a deletion point; the removed text is never rendered. */
function DeletedLines({ count }: { count: number }) {
  const { t } = useTranslation('code');
  return (
    <div
      role="note"
      aria-label={t('code:preview.diff.removed', { count })}
      data-diff-deleted={count}
      className="flex min-h-[18px] items-center bg-danger-soft text-danger"
    >
      <span aria-hidden className="sticky left-0 flex w-14 shrink-0 items-center bg-danger-soft">
        <span className="flex w-4 shrink-0 justify-center">
          <ArrowRight className="size-3.5" strokeWidth={2} />
        </span>
        <span className="w-10 shrink-0 pr-3 text-right text-[10.5px] tabular-nums">−{count}</span>
      </span>
    </div>
  );
}

function PreviewHeader({ path, children }: { path: string; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <FileIcon path={path} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={path}>
        {path}
      </span>
      {children}
    </div>
  );
}

function HeaderActions({
  path,
  copied,
  onCopy,
  onOpenExternal,
  onReload,
  wrap,
  onToggleWrap,
}: {
  path: string;
  copied: boolean;
  onCopy: () => void;
  onOpenExternal?: (path: string) => void;
  onReload?: () => void;
  /** Estado global de quebra de linha (só o ramo de texto/código passa isto). */
  wrap?: boolean;
  onToggleWrap?: () => void;
}) {
  const { t } = useTranslation('code');
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {wrap !== undefined && onToggleWrap ? (
        <Tooltip
          content={wrap ? t('code:preview.wrapOn') : t('code:preview.wrap')}
          side="bottom"
        >
          <IconButton
            label={t('code:preview.wrap')}
            size="sm"
            active={wrap}
            aria-pressed={wrap}
            onClick={onToggleWrap}
          >
            <WrapText aria-hidden className="size-4" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip content={copied ? t('code:preview.pathCopied') : t('code:preview.copyPath')} side="bottom">
        <IconButton
          label={copied ? t('code:preview.pathCopied') : t('code:preview.copyPath')}
          size="sm"
          onClick={onCopy}
        >
          <Copy aria-hidden className={cn('size-3.5', copied && 'text-success')} strokeWidth={1.75} />
        </IconButton>
      </Tooltip>
      {onReload ? (
        <Tooltip content={t('code:preview.reload')} side="bottom">
          <IconButton label={t('code:preview.reload')} size="sm" onClick={onReload}>
            <RefreshCw aria-hidden className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
      ) : null}
      {onOpenExternal ? (
        <Tooltip content={t('code:preview.openExternal')} side="bottom">
          <IconButton label={t('code:preview.openExternal')} size="sm" onClick={() => onOpenExternal(path)}>
            <ExternalLink aria-hidden className="size-3.5" strokeWidth={1.75} />
          </IconButton>
        </Tooltip>
      ) : null}
    </div>
  );
}

export default FilePreview;
