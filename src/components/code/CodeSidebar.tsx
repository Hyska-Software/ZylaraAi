import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Plug,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  SquareTerminal,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Kbd,
  SortableList,
  Spinner,
  sortableDropClass,
} from '@/components/ui';
import type { SortableListApi } from '@/components/ui';
import { api } from '@/lib/api';
import { localeLowerCase } from '@/lib/i18n/format';
import { pluginIcon } from '@/lib/plugins/icons';
import { pluginLabel, pluginViewsForSurface, usePluginRegistry } from '@/lib/plugins/registry';
import { openPluginView } from '@/lib/plugins/host';
import { usePluginStore } from '@/lib/plugins/store';
import {
  selectConversationStream,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import { filterConversationsForLayout } from '@/lib/conversations';
import type { Conversation, Workspace } from '@/lib/types';
import { cn, compareConversationPosition, copyText, modKey } from '@/lib/utils';
import { useIsCompact } from '@/components/layout/hooks';
import { AddChatSessionDialog } from './AddChatSessionDialog';
import { terminalManager } from './terminalManager';
import { openWorkspaceTerminal } from './terminalOpen';
import { NO_WORKSPACE_KEY, useWorkspaces } from './useWorkspaces';

export interface CodeSidebarProps {
  className?: string;
  /** Present when the sidebar is rendered as an overlay drawer (< 1024px). */
  onClose?: () => void;
}

interface SidebarActionProps {
  icon: ReactNode;
  label: string;
  /** Accessible name; defaults to the visible label. */
  ariaLabel?: string;
  /** Marks the entry as the current page (Skills view). */
  current?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  onSelect: () => void;
}

/** Compact Paseo-style action row (PLAN §3.2). */
function SidebarAction({
  icon,
  label,
  ariaLabel,
  current,
  disabled,
  trailing,
  onSelect,
}: SidebarActionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={ariaLabel}
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      className={cn(
        'mx-3 mt-1 flex h-8 items-center gap-2 rounded-lg px-2 text-[13px]',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:pointer-events-none disabled:opacity-50',
        current
          ? 'bg-surface-active text-foreground'
          : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
      )}
    >
      <span className={cn('shrink-0', current ? 'text-accent' : 'text-foreground-subtle')}>{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {trailing ? (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">{trailing}</span>
      ) : null}
    </button>
  );
}

/** Sessions rendered per workspace before the "show more" control (WORKBENCH §3). */
const SESSIONS_PAGE_SIZE = 10;

interface SessionRowProps {
  conversation: Conversation;
  active: boolean;
  /** Chat session explicitly added to the Code layout (docs/goals/chat-code-sessions). */
  shared: boolean;
  sortable: SortableListApi;
  onSelect: () => void;
  onTogglePin: () => void;
  onStartRename: () => void;
  onExport: () => void;
  /** Only meaningful for shared sessions ("Remover do Code"). */
  onRemoveFromCode: () => void;
  onDelete: () => void;
}

/**
 * One real Code session row. A conversation with an active turn (foreground or
 * background) shows a spinner in the row-actions slot — the same one the "…"
 * menu uses, which is painted above it and fades it out on hover; the active row
 * is still distinguished by its surface and `aria-current`.
 */
function SessionRow({
  conversation,
  active,
  shared,
  sortable,
  onSelect,
  onTogglePin,
  onStartRename,
  onExport,
  onRemoveFromCode,
  onDelete,
}: SessionRowProps) {
  const { t } = useTranslation('code');
  const running = useChatStore(
    (state) => selectConversationStream(state, conversation.id) !== null,
  );
  return (
    <div
      {...sortable.dropProps(conversation.id)}
      className={cn('group relative flex items-center', sortableDropClass)}
    >
      <button
        type="button"
        {...sortable.itemProps(conversation.id)}
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        aria-label={
          shared
            ? t('code:sidebar.session.sharedAria', { title: conversation.title })
            : conversation.title
        }
        title={conversation.title}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 pr-8 text-left text-[13px]',
          'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          !sortable.disabled && 'cursor-grab active:cursor-grabbing',
          active
            ? 'bg-surface-active text-foreground'
            : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
        )}
      >
        {conversation.pinned ? (
          <Pin aria-hidden className="size-3 shrink-0 text-foreground-subtle" strokeWidth={1.75} />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
        {shared ? (
          <span
            title={t('code:sidebar.session.sharedTitle')}
            className="ml-auto flex shrink-0 items-center gap-1 text-foreground-subtle"
          >
            <MessageSquare aria-hidden className="size-3.5" strokeWidth={1.75} />
            <span className="text-[10px] font-medium leading-none">{t('code:sidebar.session.fromChat')}</span>
          </span>
        ) : null}
      </button>

      {/* The running turn reuses the row-actions slot: the "…" trigger is painted
          above this spinner and fades it out on hover (≥ lg). Below that width the
          trigger is always visible, so it hides its glyph instead of stacking two
          icons on the same spot. */}
      {running ? (
        <span className="pointer-events-none absolute right-1 top-1/2 z-0 flex size-6 -translate-y-1/2 items-center justify-center text-accent transition-opacity duration-150 lg:group-hover:opacity-0 motion-reduce:transition-none">
          <Spinner size="xs" label={t('code:sidebar.session.running')} />
        </span>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('code:sidebar.session.options', { title: conversation.title })}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'absolute right-1 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md',
              'text-foreground-subtle transition-colors duration-150 hover:bg-surface-active hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100 lg:data-[state=open]:opacity-100',
            )}
          >
            <Ellipsis className={cn('size-4', running && 'hidden lg:block')} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem
            icon={
              conversation.pinned ? (
                <PinOff className="size-3.5" />
              ) : (
                <Pin className="size-3.5" />
              )
            }
            onSelect={onTogglePin}
          >
            {conversation.pinned
              ? t('code:sidebar.session.unpin')
              : t('code:sidebar.session.pin')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Pencil className="size-3.5" />} onSelect={onStartRename}>
            {t('code:sidebar.session.rename')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Download className="size-3.5" />} onSelect={onExport}>
            {t('code:sidebar.session.export')}
          </DropdownMenuItem>
          {shared ? (
            <DropdownMenuItem icon={<Unlink className="size-3.5" />} onSelect={onRemoveFromCode}>
              {t('code:sidebar.session.removeFromCode')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="danger" icon={<Trash2 className="size-3.5" />} onSelect={onDelete}>
            {t('code:sidebar.session.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function workspaceIcon(workspace: Workspace) {
  return workspace.git ? FolderGit2 : Folder;
}

interface WorkspaceMenuProps {
  workspace: Workspace;
  onNewSession: () => void;
  onOpenTerminal: () => void;
  onRename: () => void;
  onOpenExplorer: () => void;
  onCopyPath: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}

/** Menu de contexto de um workspace (WORKBENCH §3): ações reais, sem becos. */
function WorkspaceMenu({
  workspace,
  onNewSession,
  onOpenTerminal,
  onRename,
  onOpenExplorer,
  onCopyPath,
  onRefresh,
  onRemove,
}: WorkspaceMenuProps) {
  const { t } = useTranslation('code');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('code:sidebar.workspace.optionsAria', { name: workspace.name })}
          title={t('code:sidebar.workspace.optionsTitle')}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
            'transition-colors duration-150 hover:bg-surface-active hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            'lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100 lg:data-[state=open]:opacity-100',
          )}
        >
          <Ellipsis aria-hidden className="size-4" strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="max-w-48 truncate normal-case tracking-normal text-foreground-muted">
          {workspace.name}
        </DropdownMenuLabel>
        <DropdownMenuItem icon={<SquarePen className="size-4" />} onSelect={onNewSession}>
          {t('code:sidebar.workspace.newSession')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<SquareTerminal className="size-4" />} onSelect={onOpenTerminal}>
          {t('code:sidebar.workspace.openTerminal')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<RefreshCw className="size-4" />} onSelect={onRefresh}>
          {t('code:sidebar.workspace.refresh')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<ExternalLink className="size-4" />} onSelect={onOpenExplorer}>
          {t('code:sidebar.workspace.openExplorer')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Copy className="size-4" />} onSelect={onCopyPath}>
          {t('code:sidebar.workspace.copyPath')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Folder className="size-4" />} onSelect={onRename}>
          {t('code:sidebar.workspace.rename')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" icon={<Trash2 className="size-4" />} onSelect={onRemove}>
          {t('code:sidebar.workspace.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface WorkspaceRowProps {
  workspace: Workspace;
  sessions: Conversation[];
  active: boolean;
  expanded: boolean;
  activeConversationId: string | null;
  /** Rows rendered for this workspace before the "show more" control. */
  sessionLimit: number;
  /** Reveals the next page of sessions. */
  onLoadMore: () => void;
  sortable: SortableListApi;
  sessionsDisabled: boolean;
  onReorderSessions: (ids: string[]) => void;
  onToggle: () => void;
  onSelect: () => void;
  onNewSession: () => void;
  onOpenTerminal: () => void;
  onRename: () => void;
  onOpenExplorer: () => void;
  onCopyPath: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  onOpenConversation: (conversation: Conversation) => void;
  onSessionPin: (conversation: Conversation) => void;
  onSessionRename: (conversation: Conversation) => void;
  onSessionExport: (conversation: Conversation) => void;
  onSessionRemoveFromCode: (conversation: Conversation) => void;
  onSessionDelete: (conversation: Conversation) => void;
}

function WorkspaceRow({
  workspace,
  sessions,
  active,
  expanded,
  activeConversationId,
  sessionLimit,
  onLoadMore,
  sortable,
  sessionsDisabled,
  onReorderSessions,
  onToggle,
  onSelect,
  onNewSession,
  onOpenTerminal,
  onRename,
  onOpenExplorer,
  onCopyPath,
  onRefresh,
  onRemove,
  onOpenConversation,
  onSessionPin,
  onSessionRename,
  onSessionExport,
  onSessionRemoveFromCode,
  onSessionDelete,
}: WorkspaceRowProps) {
  const { t } = useTranslation('code');
  const Icon = workspaceIcon(workspace);
  const branch = workspace.git?.branch;
  const canExpand = sessions.length > 0;
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const sessionsListId = useId();
  const activeIndex = activeConversationId
    ? sessions.findIndex((conversation) => conversation.id === activeConversationId)
    : -1;
  /** The active session is always revealed, even past the current page. */
  const visibleCount = Math.min(sessions.length, Math.max(sessionLimit, activeIndex + 1));
  const visibleSessions = sessions.slice(0, visibleCount);
  const hiddenCount = sessions.length - visibleCount;

  const handleLoadMore = () => {
    onLoadMore();
    // The control unmounts on the last page: keep keyboard focus inside the group.
    if (hiddenCount <= SESSIONS_PAGE_SIZE) toggleRef.current?.focus();
  };

  return (
    <div
      {...sortable.dropProps(workspace.id)}
      className={cn('rounded-lg', sortableDropClass)}
    >
      <div className="group flex h-8 min-w-0 items-center gap-0.5 rounded-lg pr-0.5">
        <button
          ref={toggleRef}
          type="button"
          aria-label={
            canExpand
              ? expanded
                ? t('code:sidebar.workspace.collapse', { name: workspace.name })
                : t('code:sidebar.workspace.expand', { name: workspace.name })
              : t('code:sidebar.workspace.noSessions', { name: workspace.name })
          }
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
          onClick={onToggle}
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
            'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          {expanded && canExpand ? (
            <ChevronDown aria-hidden className="size-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.75} />
          )}
        </button>

        <button
          type="button"
          {...sortable.itemProps(workspace.id)}
          onClick={onSelect}
          aria-current={active ? 'true' : undefined}
          aria-label={workspace.name}
          title={`${workspace.name} — ${workspace.path}`}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[13px]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            !sortable.disabled && 'cursor-grab active:cursor-grabbing',
            active
              ? 'text-foreground'
              : 'text-foreground-muted hover:bg-surface-hover hover:text-foreground',
          )}
        >
          <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate font-medium">{workspace.name}</span>
          {branch ? (
            <span className="flex min-w-0 shrink items-center gap-0.5 text-[10.5px] text-foreground-subtle">
              <GitBranch aria-hidden className="size-2.5 shrink-0" strokeWidth={1.75} />
              <span className="max-w-16 truncate">{branch}</span>
              {workspace.git?.dirty ? (
                <span
                  aria-hidden
                  title={t('code:sidebar.workspace.dirty')}
                  className="size-1 shrink-0 rounded-full bg-warning"
                />
              ) : null}
            </span>
          ) : null}
          {workspace.trusted === false ? (
            <span
              title={t('code:sidebar.workspace.untrustedTitle')}
              className="shrink-0 rounded bg-warning-soft px-1 text-[9.5px] font-medium uppercase tracking-wide text-warning"
            >
              {t('code:sidebar.workspace.readOnlyBadge')}
            </span>
          ) : null}
          <span
            aria-hidden
            title={t('code:sidebar.sessions', { count: sessions.length })}
            className="ml-auto shrink-0 text-[10px] tabular-nums text-foreground-subtle"
          >
            {sessions.length}
          </span>
        </button>

        <WorkspaceMenu
          workspace={workspace}
          onNewSession={onNewSession}
          onOpenTerminal={onOpenTerminal}
          onRename={onRename}
          onOpenExplorer={onOpenExplorer}
          onCopyPath={onCopyPath}
          onRefresh={onRefresh}
          onRemove={onRemove}
        />
      </div>

      {expanded && canExpand ? (
        <div className="mb-1 ml-4 mt-0.5 border-l border-border pl-1.5">
          <SortableList
            ids={visibleSessions.map((conversation) => conversation.id)}
            label={t('code:sidebar.workspace.sessionsAria', { name: workspace.name })}
            itemLabel={(id) => sessions.find((conversation) => conversation.id === id)?.title ?? id}
            disabled={sessionsDisabled}
            // Rows hidden by the page limit keep their relative order after the
            // reordered window, so the persisted positions never collide.
            onReorder={(ids) =>
              onReorderSessions([
                ...ids,
                ...sessions.slice(visibleSessions.length).map((conversation) => conversation.id),
              ])
            }
          >
            {(sessionSortable) => (
              <div
                ref={sessionSortable.containerRef}
                id={sessionsListId}
                className="flex flex-col gap-0.5"
              >
                {visibleSessions.map((conversation) => (
                  <SessionRow
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeConversationId}
                    shared={conversation.codeLinked === true}
                    sortable={sessionSortable}
                    onSelect={() => onOpenConversation(conversation)}
                    onTogglePin={() => onSessionPin(conversation)}
                    onStartRename={() => onSessionRename(conversation)}
                    onExport={() => onSessionExport(conversation)}
                    onRemoveFromCode={() => onSessionRemoveFromCode(conversation)}
                    onDelete={() => onSessionDelete(conversation)}
                  />
                ))}
              </div>
            )}
          </SortableList>
          {hiddenCount > 0 ? (
            <button
              type="button"
              aria-controls={sessionsListId}
              onClick={handleLoadMore}
              className={cn(
                'mt-0.5 flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11.5px]',
                'text-foreground-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              )}
            >
              <ChevronDown aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">
                {t('code:sidebar.workspace.loadMore', { count: hiddenCount })}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {expanded && !canExpand ? (
        <p className="mb-1 ml-6 text-[11px] leading-relaxed text-foreground-subtle">
          {t('code:sidebar.workspace.emptySessions')}
        </p>
      ) : null}
    </div>
  );
}

interface RenameWorkspaceDialogProps {
  workspace: Workspace | null;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function RenameWorkspaceDialog({
  workspace,
  value,
  busy,
  onChange,
  onCancel,
  onConfirm,
}: RenameWorkspaceDialogProps) {
  const { t } = useTranslation('code');
  if (!workspace) return null;
  return (
    <Dialog open onOpenChange={(next) => (!next && !busy ? onCancel() : undefined)}>
      <DialogContent size="sm" className="gap-0">
        <DialogHeader>
          <DialogTitle>{t('code:sidebar.renameWorkspace.title')}</DialogTitle>
          <DialogDescription>
            {t('code:sidebar.renameWorkspace.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-4">
          <Input
            autoFocus
            aria-label={t('code:sidebar.renameWorkspace.nameAria')}
            value={value}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onConfirm();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || value.trim().length === 0}
            loading={busy}
            onClick={onConfirm}
          >
            {t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Filtros do cabeçalho da lista de workspaces (WORKBENCH §3). */
type WorkspaceFilter = 'all' | 'git' | 'no-git' | 'untrusted' | 'with-sessions' | 'empty';

const WORKSPACE_FILTERS = [
  { id: 'all', labelKey: 'code:sidebar.filters.all' },
  { id: 'git', labelKey: 'code:sidebar.filters.git' },
  { id: 'no-git', labelKey: 'code:sidebar.filters.noGit' },
  { id: 'untrusted', labelKey: 'code:sidebar.filters.untrusted' },
  { id: 'with-sessions', labelKey: 'code:sidebar.filters.withSessions' },
  { id: 'empty', labelKey: 'code:sidebar.filters.empty' },
] as const;

function normalizeSearch(value: string): string {
  return localeLowerCase(value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).trim();
}

/** Botão de ícone compacto do cabeçalho da seção (32px de área de toque via padding). */
function SectionIconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ? true : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-6 items-center justify-center rounded-md transition-colors duration-150',
        'text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-surface-hover text-foreground',
      )}
    >
      {children}
    </button>
  );
}

interface RemoveWorkspaceDialogProps {
  workspace: Workspace | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function RemoveWorkspaceDialog({ workspace, busy, onCancel, onConfirm }: RemoveWorkspaceDialogProps) {
  const { t } = useTranslation('code');
  if (!workspace) return null;
  return (
    <Dialog open onOpenChange={(next) => (!next && !busy ? onCancel() : undefined)}>
      <DialogContent size="sm" className="gap-0">
        <DialogHeader>
          <DialogTitle>{t('code:sidebar.removeWorkspace.title')}</DialogTitle>
          <DialogDescription>
            <Trans
              ns="code"
              i18nKey="sidebar.removeWorkspace.description"
              values={{ path: workspace.path }}
              components={{ path: <span className="font-mono text-[11.5px]" /> }}
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="danger" size="sm" loading={busy} onClick={onConfirm}>
            {t('code:sidebar.removeWorkspace.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Code layout sidebar (WORKBENCH §3): ações compactas, a seção **Workspaces**
 * real (pastas do backend) com sessões agrupadas por workspace, o grupo
 * "Sem workspace" para sessões da fase 1 e o rodapé existente.
 *
 * Nada de dado falso: vazio/erro/carregando são estados explícitos e as ações
 * só existem quando o backend suporta (abrir pasta, renomear, remover sem
 * apagar a pasta, abrir no Explorer, copiar caminho).
 */
export function CodeSidebar({ className, onClose }: CodeSidebarProps) {
  const { t } = useTranslation('code');
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const codeView = useUiStore((state) => state.codeView);
  const setCodeView = useUiStore((state) => state.setCodeView);
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const activeWorkspaceId = useUiStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useUiStore((state) => state.setActiveWorkspace);
  const appInfo = useAppStore((state) => state.appInfo);
  const skillsPanelEnabled = useAppStore((state) => state.settings.skillsPanelEnabled);
  const pluginView = usePluginStore((state) => state.activeView);
  usePluginRegistry();
  const codePluginViews = pluginViewsForSurface('code', 'sidebar');
  const isCompact = useIsCompact();

  const {
    workspaces,
    loading: workspacesLoading,
    loaded: workspacesLoaded,
    error: workspacesError,
    reload,
    openFolder,
    startSession,
    rename,
    reorder,
    remove,
    refreshContext,
  } = useWorkspaces();

  const [addSessionOpen, setAddSessionOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceFilter>('all');
  const [renameTarget, setRenameTarget] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Workspace | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [renameSessionTarget, setRenameSessionTarget] = useState<Conversation | null>(null);
  const [renameSessionValue, setRenameSessionValue] = useState('');
  const [renameSessionBusy, setRenameSessionBusy] = useState(false);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<Conversation | null>(null);
  const [deleteSessionBusy, setDeleteSessionBusy] = useState(false);
  /** Extra session pages revealed per workspace ("show more" under the group). */
  const [sessionPages, setSessionPages] = useState<Record<string, number>>({});

  /* Ações da sessão (mesmo menu das conversas no layout Chat). */
  const handleSessionPin = (conversation: Conversation) => {
    void useChatStore.getState().togglePinned(conversation.id);
  };

  const handleSessionRenameStart = (conversation: Conversation) => {
    setRenameSessionTarget(conversation);
    setRenameSessionValue(conversation.title);
  };

  const handleSessionRenameConfirm = async () => {
    const target = renameSessionTarget;
    const title = renameSessionValue.trim();
    if (!target || !title) return;
    setRenameSessionBusy(true);
    try {
      await useChatStore.getState().renameConversation(target.id, title);
      setRenameSessionTarget(null);
    } finally {
      setRenameSessionBusy(false);
    }
  };

  const handleSessionExport = async (conversation: Conversation) => {
    try {
      const path = await api.exportConversation(conversation.id, 'markdown');
      if (path) toast.success(t('code:sidebar.toast.exportSuccess'), { description: path });
    } catch (error) {
      toast.error(t('code:sidebar.toast.exportError'), { description: String(error) });
    }
  };

  const handleSessionRemoveFromCode = async (conversation: Conversation) => {
    const ok = await useChatStore.getState().setConversationCodeLinked(conversation.id, false);
    if (!ok) {
      toast.error(t('code:sidebar.toast.removeFromCodeError'));
      return;
    }
    await terminalManager.closeConversation(conversation.id);
    toast.success(t('code:sidebar.toast.removeFromCodeSuccess'), {
      description: t('code:sidebar.toast.removeFromCodeDescription'),
    });
  };

  const handleSessionDeleteConfirm = async () => {
    const target = deleteSessionTarget;
    if (!target) return;
    setDeleteSessionBusy(true);
    try {
      await useChatStore.getState().deleteConversation(target.id);
      await terminalManager.closeConversation(target.id);
      setDeleteSessionTarget(null);
    } finally {
      setDeleteSessionBusy(false);
    }
  };

  const handleLoadMoreSessions = (workspaceId: string) => {
    setSessionPages((current) => ({
      ...current,
      [workspaceId]: (current[workspaceId] ?? 1) + 1,
    }));
  };

  const codeConversations = useMemo(
    () => filterConversationsForLayout(conversations, 'code'),
    [conversations],
  );

  const workspaceIds = useMemo(
    () => new Set(workspaces.map((workspace) => workspace.id)),
    [workspaces],
  );

  /** Sessões por workspace + sessões sem workspace (ou de workspace removido). */
  const { sessionsByWorkspace, unassignedSessions } = useMemo(() => {
    const byWorkspace = new Map<string, Conversation[]>();
    const unassigned: Conversation[] = [];
    for (const conversation of codeConversations) {
      const workspaceId = conversation.workspaceId;
      if (workspaceId && workspaceIds.has(workspaceId)) {
        const list = byWorkspace.get(workspaceId) ?? [];
        list.push(conversation);
        byWorkspace.set(workspaceId, list);
      } else {
        unassigned.push(conversation);
      }
    }
    for (const list of byWorkspace.values()) {
      list.sort(compareConversationPosition);
    }
    unassigned.sort(compareConversationPosition);
    return { sessionsByWorkspace: byWorkspace, unassignedSessions: unassigned };
  }, [codeConversations, workspaceIds]);

  /** Pesquisa + filtros reais do cabeçalho "Workspaces" (nome, caminho, branch,
   * título de sessão; com/sem git, não confiáveis, com/sem sessões). */
  const normalizedQuery = normalizeSearch(workspaceQuery);
  const visibleWorkspaces = useMemo(() => {
    const sessionsOf = (workspaceId: string) => sessionsByWorkspace.get(workspaceId) ?? [];
    return workspaces.filter((workspace) => {
      const sessions = sessionsOf(workspace.id);
      if (normalizedQuery) {
        const haystack = [
          workspace.name,
          workspace.path,
          workspace.git?.branch ?? '',
          ...sessions.map((session) => session.title),
        ]
          .map(normalizeSearch)
          .join(' ');
        if (!haystack.includes(normalizedQuery)) return false;
      }
      switch (workspaceFilter) {
        case 'git':
          return workspace.git != null;
        case 'no-git':
          return workspace.git == null;
        case 'untrusted':
          return workspace.trusted === false;
        case 'with-sessions':
          return sessions.length > 0;
        case 'empty':
          return sessions.length === 0;
        default:
          return true;
      }
    });
  }, [workspaces, sessionsByWorkspace, normalizedQuery, workspaceFilter]);

  const visibleUnassignedSessions = useMemo(() => {
    if (!normalizedQuery) return unassignedSessions;
    return unassignedSessions.filter((session) =>
      normalizeSearch(session.title).includes(normalizedQuery),
    );
  }, [unassignedSessions, normalizedQuery]);

  const hasWorkspaceFilters = workspaceFilter !== 'all' || normalizedQuery.length > 0;
  const clearWorkspaceFilters = () => {
    setWorkspaceFilter('all');
    setWorkspaceQuery('');
    setWorkspaceSearchOpen(false);
  };

  const isExpanded = (workspaceId: string) => !collapsed.has(workspaceId);

  const toggleWorkspace = (workspaceId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const openConversation = (conversation: Conversation) => {
    useUiStore.getState().setCodeView('session');
    void useChatStore.getState().openConversation(conversation.id);
    useUiStore
      .getState()
      .openWorkspaceSession(conversation.workspaceId ?? NO_WORKSPACE_KEY, conversation.id);
    if (isCompact) onClose?.();
  };

  const handleNewAgent = async () => {
    if (creatingSession || openingFolder) return;
    useUiStore.getState().setCodeView('session');
    if (activeWorkspaceId) {
      setCreatingSession(true);
      try {
        await startSession(activeWorkspaceId);
      } finally {
        setCreatingSession(false);
      }
      if (isCompact) onClose?.();
      return;
    }
    // Sem workspace ativo o fluxo honesto é abrir uma pasta (WORKBENCH §8.1).
    setOpeningFolder(true);
    try {
      const workspace = await openFolder();
      if (workspace && isCompact) onClose?.();
    } finally {
      setOpeningFolder(false);
    }
  };

  const handleOpenFolder = async () => {
    if (openingFolder) return;
    setOpeningFolder(true);
    try {
      const workspace = await openFolder();
      if (workspace) {
        useUiStore.getState().setCodeView('session');
        if (isCompact) onClose?.();
      }
    } finally {
      setOpeningFolder(false);
    }
  };

  const handleNewSessionIn = async (workspace: Workspace) => {
    useUiStore.getState().setCodeView('session');
    setActiveWorkspace(workspace.id);
    await startSession(workspace.id);
    if (isCompact) onClose?.();
  };

  /**
   * Opens a terminal in the workspace folder without creating a session: the
   * PTY runs in the project path and its tab joins the central tab strip.
   */
  const handleOpenTerminalIn = async (workspace: Workspace) => {
    const terminalId = await openWorkspaceTerminal(workspace.id);
    if (terminalId && isCompact) onClose?.();
  };

  const handleSelectWorkspace = (workspace: Workspace) => {
    setActiveWorkspace(workspace.id);
    if (collapsed.has(workspace.id)) toggleWorkspace(workspace.id);
  };

  const handleOpenExplorer = async (workspace: Workspace) => {
    try {
      await api.openWorkspaceInExplorer(workspace.id);
    } catch (error) {
      toast.error(t('code:sidebar.toast.explorerError'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleCopyPath = async (workspace: Workspace) => {
    if (await copyText(workspace.path)) toast.success(t('code:sidebar.toast.pathCopied'));
    else toast.error(t('code:sidebar.toast.copyPathError'));
  };

  const handleStartRename = (workspace: Workspace) => {
    setRenameTarget(workspace);
    setRenameValue(workspace.name);
  };

  const handleConfirmRename = async () => {
    if (!renameTarget || renameBusy) return;
    setRenameBusy(true);
    try {
      await rename(renameTarget, renameValue);
      setRenameTarget(null);
    } finally {
      setRenameBusy(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget || removeBusy) return;
    setRemoveBusy(true);
    try {
      await remove(removeTarget);
      setRemoveTarget(null);
    } finally {
      setRemoveBusy(false);
    }
  };

  const handleAddSession = () => {
    setAddSessionOpen(true);
  };

  const handleSearch = () => {
    setCommandPaletteOpen(true);
  };

  const handleSkills = () => {
    setCodeView('skills');
    if (isCompact) onClose?.();
  };

  const handlePlugins = () => {
    usePluginStore.getState().closeOverlays();
    setCodeView('plugins');
    if (isCompact) onClose?.();
  };

  const handleOpenSettings = () => {
    setSettingsOpen(true);
    if (isCompact) onClose?.();
  };

  return (
    <aside
      aria-label={t('code:sidebar.aria')}
      className={cn('flex h-full w-full min-w-0 flex-col bg-surface', className)}
    >
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3">
        <Button
          variant="secondary"
          size="md"
          onClick={() => void handleNewAgent()}
          loading={creatingSession || openingFolder}
          leftIcon={<SquarePen className="size-4" />}
          className="h-9 flex-1 justify-start rounded-xl px-3 text-[13px] font-medium"
        >
          {t('code:sidebar.newSession')}
        </Button>
        {onClose ? (
          <IconButton label={t('code:sidebar.close')} size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        ) : null}
      </div>

      <SidebarAction
        icon={<FolderPlus className="size-4" />}
        label={t('code:sidebar.openFolder')}
        disabled={openingFolder}
        onSelect={() => void handleOpenFolder()}
      />
      <SidebarAction
        icon={<MessageSquarePlus className="size-4" />}
        label={t('code:sidebar.addChat')}
        ariaLabel={t('code:sidebar.addChat')}
        onSelect={handleAddSession}
      />
      <SidebarAction
        icon={<Search className="size-4" />}
        label={t('code:sidebar.searchAction')}
        trailing={
          <>
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </>
        }
        onSelect={handleSearch}
      />
      <SidebarAction
        icon={<Plug className="size-4" />}
        label={t('code:sidebar.plugins')}
        ariaLabel={t('code:sidebar.plugins')}
        current={codeView === 'plugins'}
        onSelect={handlePlugins}
      />
      {skillsPanelEnabled ? (
        <SidebarAction
          icon={<Sparkles className="size-4" />}
          label={t('code:sidebar.skills')}
          ariaLabel={t('code:sidebar.skills')}
          current={codeView === 'skills'}
          onSelect={handleSkills}
        />
      ) : null}

      {codePluginViews.map((view) => {
        const Icon = pluginIcon(view.view.icon);
        const label = pluginLabel(view.plugin, view.view.titleKey, view.view.title);
        return (
          <SidebarAction
            key={view.key}
            icon={<Icon className="size-4" />}
            label={label}
            ariaLabel={label}
            current={
              pluginView?.pluginId === view.plugin.id && pluginView.id === view.view.id
            }
            onSelect={() => {
              openPluginView(view.plugin, view.view.id);
              if (isCompact) onClose?.();
            }}
          />
        );
      })}

      <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
        <section
          aria-labelledby="code-workspaces-heading"
          className="flex min-h-0 flex-1 flex-col border-t border-border px-2 pb-1 pt-3"
        >
          <div className="flex items-center justify-between gap-1">
            <h2
              id="code-workspaces-heading"
              className="px-1 text-[11px] font-medium tracking-tight text-foreground-subtle"
            >
              {t('code:sidebar.workspacesHeading')}
            </h2>
            <div className="flex items-center gap-0.5">
              <SectionIconButton
                label={t('code:sidebar.searchWorkspaces')}
                active={workspaceSearchOpen || normalizedQuery.length > 0}
                onClick={() => {
                  if (workspaceSearchOpen) {
                    setWorkspaceSearchOpen(false);
                    setWorkspaceQuery('');
                  } else {
                    setWorkspaceSearchOpen(true);
                  }
                }}
              >
                <Search aria-hidden className="size-3.5" strokeWidth={1.75} />
              </SectionIconButton>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('code:sidebar.filter')}
                    title={t('code:sidebar.filter')}
                    aria-pressed={workspaceFilter !== 'all' ? true : undefined}
                    className={cn(
                      'flex size-6 items-center justify-center rounded-md transition-colors duration-150',
                      'text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                      workspaceFilter !== 'all' && 'bg-surface-hover text-foreground',
                    )}
                  >
                    <SlidersHorizontal aria-hidden className="size-3.5" strokeWidth={1.75} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuLabel>{t('code:sidebar.filter')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={workspaceFilter}
                    onValueChange={(value) => setWorkspaceFilter(value as WorkspaceFilter)}
                  >
                    {WORKSPACE_FILTERS.map((filter) => (
                      <DropdownMenuRadioItem key={filter.id} value={filter.id}>
                        {t(filter.labelKey)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  {hasWorkspaceFilters ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem icon={<X className="size-4" />} onSelect={clearWorkspaceFilters}>
                        {t('code:sidebar.clearFilters')}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <SectionIconButton
                label={t('code:sidebar.addWorkspace')}
                disabled={openingFolder}
                onClick={() => void handleOpenFolder()}
              >
                <FolderPlus aria-hidden className="size-3.5" strokeWidth={1.75} />
              </SectionIconButton>
            </div>
          </div>

          {workspaceSearchOpen ? (
            <div className="relative mt-1.5">
              <Input
                autoFocus
                value={workspaceQuery}
                onChange={(event) => setWorkspaceQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setWorkspaceQuery('');
                    setWorkspaceSearchOpen(false);
                  }
                }}
                aria-label={t('code:sidebar.searchAria')}
                placeholder={t('code:sidebar.searchPlaceholder')}
                className="h-7 rounded-md pr-7 text-[12px]"
              />
              {workspaceQuery ? (
                <button
                  type="button"
                  aria-label={t('code:sidebar.clearSearch')}
                  onClick={() => setWorkspaceQuery('')}
                  className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-foreground-subtle hover:text-foreground"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}

          {hasWorkspaceFilters ? (
            <p className="mt-1 px-1 text-[10.5px] tabular-nums text-foreground-subtle">
              {t('code:sidebar.count', { visible: visibleWorkspaces.length, total: workspaces.length })}
            </p>
          ) : null}

          <div className="mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
            {workspacesLoading && !workspacesLoaded ? (
              <div
                role="status"
                aria-label={t('code:sidebar.loading')}
                className="flex flex-col gap-2 px-1 py-2"
              >
                {[0, 1].map((index) => (
                  <div
                    key={index}
                    className="h-8 animate-pulse rounded-lg bg-surface-hover motion-reduce:animate-none"
                  />
                ))}
              </div>
            ) : workspacesError ? (
              <div role="alert" className="px-1 py-2">
                <p className="text-[12px] leading-relaxed text-danger">
                  {t('code:sidebar.loadError')}
                </p>
                <p className="mt-1 break-words text-[11px] leading-relaxed text-foreground-subtle">
                  {workspacesError}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  leftIcon={<RefreshCw className="size-3.5" />}
                  onClick={() => void reload()}
                >
                  {t('common:actions.retry')}
                </Button>
              </div>
            ) : workspaces.length === 0 ? (
              <div className="px-1 py-2">
                <p className="text-[12.5px] font-medium text-foreground-muted">
                  {t('code:sidebar.empty.title')}
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-foreground-subtle">
                  {t('code:sidebar.empty.description')}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  disabled={openingFolder}
                  loading={openingFolder}
                  leftIcon={<FolderOpen className="size-3.5" />}
                  onClick={() => void handleOpenFolder()}
                >
                  {t('code:sidebar.openFolderCta')}
                </Button>
              </div>
            ) : visibleWorkspaces.length === 0 ? (
              <div className="px-1 py-2">
                <p className="text-[12.5px] font-medium text-foreground-muted">
                  {t('code:sidebar.noResults.title')}
                </p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-foreground-subtle">
                  {t('code:sidebar.noResults.description')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  leftIcon={<X className="size-3.5" />}
                  onClick={clearWorkspaceFilters}
                >
                  {t('code:sidebar.clearFilters')}
                </Button>
              </div>
            ) : (
              <SortableList
                ids={visibleWorkspaces.map((workspace) => workspace.id)}
                label={t('code:sidebar.workspacesHeading')}
                itemLabel={(id) => workspaces.find((workspace) => workspace.id === id)?.name ?? id}
                disabled={hasWorkspaceFilters}
                onReorder={(ids) => void reorder(ids)}
              >
                {(sortable) => (
                  <div ref={sortable.containerRef} className="flex flex-col gap-0.5">
                    {visibleWorkspaces.map((workspace) => (
                      <WorkspaceRow
                        key={workspace.id}
                        workspace={workspace}
                        sessions={sessionsByWorkspace.get(workspace.id) ?? []}
                        active={workspace.id === activeWorkspaceId}
                        expanded={isExpanded(workspace.id)}
                        activeConversationId={activeId}
                        sessionLimit={
                          normalizedQuery
                            ? Number.POSITIVE_INFINITY
                            : (sessionPages[workspace.id] ?? 1) * SESSIONS_PAGE_SIZE
                        }
                        onLoadMore={() => handleLoadMoreSessions(workspace.id)}
                        sortable={sortable}
                        sessionsDisabled={hasWorkspaceFilters}
                        onReorderSessions={(ids) =>
                          void useChatStore.getState().reorderConversations(ids)
                        }
                        onToggle={() => toggleWorkspace(workspace.id)}
                        onSelect={() => handleSelectWorkspace(workspace)}
                        onNewSession={() => void handleNewSessionIn(workspace)}
                        onOpenTerminal={() => void handleOpenTerminalIn(workspace)}
                        onRename={() => handleStartRename(workspace)}
                        onOpenExplorer={() => void handleOpenExplorer(workspace)}
                        onCopyPath={() => void handleCopyPath(workspace)}
                        onRefresh={() => void refreshContext(workspace.id)}
                        onRemove={() => setRemoveTarget(workspace)}
                        onOpenConversation={openConversation}
                        onSessionPin={handleSessionPin}
                        onSessionRename={handleSessionRenameStart}
                        onSessionExport={(conversation) => void handleSessionExport(conversation)}
                        onSessionRemoveFromCode={(conversation) =>
                          void handleSessionRemoveFromCode(conversation)
                        }
                        onSessionDelete={setDeleteSessionTarget}
                      />
                    ))}
                  </div>
                )}
              </SortableList>
            )}
          </div>
        </section>

        {visibleUnassignedSessions.length > 0 ? (
          <section
            aria-labelledby="code-unassigned-heading"
            className="shrink-0 border-t border-border px-2 pb-1 pt-2"
          >
            <div className="flex h-7 min-w-0 items-center gap-0.5 px-1">
              <button
                type="button"
                aria-label={
                  unassignedCollapsed
                    ? t('code:sidebar.expandUnassigned')
                    : t('code:sidebar.collapseUnassigned')
                }
                aria-expanded={!unassignedCollapsed}
                aria-controls="code-unassigned-sessions"
                onClick={() => setUnassignedCollapsed((current) => !current)}
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle',
                  'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                )}
              >
                {unassignedCollapsed ? (
                  <ChevronRight aria-hidden className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <ChevronDown aria-hidden className="size-3.5" strokeWidth={1.75} />
                )}
              </button>
              <h2
                id="code-unassigned-heading"
                className="min-w-0 truncate text-[11px] font-medium tracking-tight text-foreground-subtle"
              >
                {t('code:sidebar.unassigned')}
              </h2>
            </div>
            <div
              id="code-unassigned-sessions"
              hidden={unassignedCollapsed}
              className="mt-1 max-h-44 overflow-y-auto overscroll-contain pb-1"
            >
              <SortableList
                ids={visibleUnassignedSessions.map((conversation) => conversation.id)}
                label={t('code:sidebar.unassigned')}
                itemLabel={(id) =>
                  visibleUnassignedSessions.find((conversation) => conversation.id === id)?.title ?? id
                }
                disabled={normalizedQuery.length > 0}
                onReorder={(ids) => void useChatStore.getState().reorderConversations(ids)}
              >
                {(sortable) => (
                  <div ref={sortable.containerRef} className="flex flex-col gap-0.5">
                    {visibleUnassignedSessions.map((conversation) => (
                      <SessionRow
                        key={conversation.id}
                        conversation={conversation}
                        active={conversation.id === activeId}
                        shared={conversation.codeLinked === true}
                        sortable={sortable}
                        onSelect={() => openConversation(conversation)}
                        onTogglePin={() => handleSessionPin(conversation)}
                        onStartRename={() => handleSessionRenameStart(conversation)}
                        onExport={() => void handleSessionExport(conversation)}
                        onRemoveFromCode={() => void handleSessionRemoveFromCode(conversation)}
                        onDelete={() => setDeleteSessionTarget(conversation)}
                      />
                    ))}
                  </div>
                )}
              </SortableList>
            </div>
          </section>
        ) : null}
      </div>

      <div className="border-t border-border px-2 py-2">
        <button
          type="button"
          onClick={handleOpenSettings}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-[13px] text-foreground-muted',
            'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
        >
          <Settings className="size-4" />
          <span>{t('code:sidebar.settings')}</span>
          <span className="ml-auto text-[11px] tabular-nums text-foreground-subtle">
            {appInfo?.version ? `v${appInfo.version}` : ''}
          </span>
        </button>
      </div>

      <AddChatSessionDialog
        open={addSessionOpen}
        onOpenChange={setAddSessionOpen}
        onAdded={() => {
          // The compact drawer must reveal the session it just opened.
          if (isCompact) onClose?.();
        }}
      />

      <RenameWorkspaceDialog
        workspace={renameTarget}
        value={renameValue}
        busy={renameBusy}
        onChange={setRenameValue}
        onCancel={() => !renameBusy && setRenameTarget(null)}
        onConfirm={() => void handleConfirmRename()}
      />
      <RemoveWorkspaceDialog
        workspace={removeTarget}
        busy={removeBusy}
        onCancel={() => !removeBusy && setRemoveTarget(null)}
        onConfirm={() => void handleConfirmRemove()}
      />
      <Dialog
        open={renameSessionTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renameSessionBusy) setRenameSessionTarget(null);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('code:sidebar.renameSession.title')}</DialogTitle>
          </DialogHeader>
          <div className="px-6 py-2">
            <Input
              autoFocus
              value={renameSessionValue}
              onChange={(event) => setRenameSessionValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleSessionRenameConfirm();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  if (!renameSessionBusy) setRenameSessionTarget(null);
                }
              }}
              aria-label={t('code:sidebar.renameSession.aria')}
              placeholder={t('code:sidebar.renameSession.placeholder')}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={renameSessionBusy}
              onClick={() => setRenameSessionTarget(null)}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={renameSessionBusy || renameSessionValue.trim().length === 0}
              loading={renameSessionBusy}
              onClick={() => void handleSessionRenameConfirm()}
            >
              {t('common:actions.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteSessionTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteSessionBusy) setDeleteSessionTarget(null);
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('code:sidebar.deleteSession.title')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="px-6 pb-4">
            {deleteSessionTarget
              ? t('code:sidebar.deleteSession.description', { title: deleteSessionTarget.title })
              : t('code:sidebar.deleteSession.descriptionNoTitle')}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={deleteSessionBusy}
              onClick={() => setDeleteSessionTarget(null)}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleteSessionBusy}
              onClick={() => void handleSessionDeleteConfirm()}
            >
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

export default CodeSidebar;
