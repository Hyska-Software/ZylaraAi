import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Code,
  Download,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash,
  Unlink,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { filterConversationsForLayout } from '@/lib/conversations';
import { usePluginUi } from '@/lib/plugins/ui/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { navEntries, openNavTarget } from '@/lib/plugins/ui/nav';
import { SidebarNavItem } from './SidebarNavItem';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { Slot } from '@/components/plugins/ui/Slot';
import { useAppStore, useChatStore, useUiStore } from '@/lib/store';
import type { Conversation } from '@/lib/types';
import { cn, groupConversations, modKey } from '@/lib/utils';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Kbd,
  SortableList,
  sortableDropClass,
} from '@/components/ui';
import type { SortableListApi } from '@/components/ui';
import { useIsCompact } from './hooks';

export interface SidebarProps {
  className?: string;
  /** Present when the sidebar is rendered as an overlay drawer (< 1024px). */
  onClose?: () => void;
}

interface MenuEntryProps {
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

function MenuEntry({ icon, children, danger, onSelect }: MenuEntryProps) {
  return (
    <DropdownMenu.Item
      onSelect={() => onSelect()}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] outline-none',
        danger
          ? 'text-danger data-[highlighted]:bg-danger-soft'
          : 'text-foreground data-[highlighted]:bg-surface-hover',
      )}
    >
      <span className={cn('shrink-0', danger ? 'text-danger' : 'text-foreground-subtle')}>{icon}</span>
      {children}
    </DropdownMenu.Item>
  );
}

interface ConversationRowProps {
  conversation: Conversation;
  active: boolean;
  renaming: boolean;
  renameValue: string;
  sortable: SortableListApi;
  onSelect: () => void;
  onStartRename: () => void;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onTogglePin: () => void;
  /** Shares the Chat session with the Code layout (or removes that link). */
  onToggleCodeLink: () => void;
  onExport: () => void;
  onDelete: () => void;
}

function ConversationRow({
  conversation,
  active,
  renaming,
  renameValue,
  sortable,
  onSelect,
  onStartRename,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onTogglePin,
  onToggleCodeLink,
  onExport,
  onDelete,
}: ConversationRowProps) {
  const { t } = useTranslation('common');
  if (renaming) {
    return (
      <div
        {...sortable.dropProps(conversation.id)}
        className={cn('relative flex items-center', sortableDropClass)}
      >
        <input
          autoFocus
          value={renameValue}
          onChange={(event) => onRenameValueChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              onCommitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancelRename();
            }
          }}
          aria-label={t('shell.sidebar.renameAria')}
          className={cn(
            'h-8 w-full min-w-0 rounded-lg bg-background px-2',
            'text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          )}
        />
      </div>
    );
  }

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
        {conversation.pinned ? <Pin className="size-3.5 shrink-0 text-foreground-subtle" /> : null}
        <span className="truncate">{conversation.title}</span>
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={t('shell.sidebar.optionsAria')}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md',
              'text-foreground-subtle transition-colors duration-150 hover:bg-surface-active hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100 lg:data-[state=open]:opacity-100',
            )}
          >
            <Ellipsis className="size-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className={cn(
              'z-50 min-w-44 rounded-xl bg-surface-raised p-1 shadow-lg animate-fade-in',
            )}
          >
            <MenuEntry
              icon={conversation.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              onSelect={onTogglePin}
            >
              {conversation.pinned ? t('shell.menu.unpin') : t('shell.menu.pin')}
            </MenuEntry>
            <MenuEntry icon={<Pencil className="size-3.5" />} onSelect={onStartRename}>
              {t('shell.menu.rename')}
            </MenuEntry>
            <MenuEntry icon={<Download className="size-3.5" />} onSelect={onExport}>
              {t('shell.menu.export')}
            </MenuEntry>
            <MenuEntry
              icon={conversation.codeLinked ? <Unlink className="size-3.5" /> : <Code className="size-3.5" />}
              onSelect={onToggleCodeLink}
            >
              {conversation.codeLinked ? t('shell.menu.removeFromCode') : t('shell.menu.useInCode')}
            </MenuEntry>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuEntry icon={<Trash className="size-3.5" />} danger onSelect={onDelete}>
              {t('actions.delete')}
            </MenuEntry>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/** Conversation sidebar (DESIGN §5): new chat, search, grouped history and footer. */
export function Sidebar({ className, onClose }: SidebarProps) {
  const { t, i18n } = useTranslation('common');
  const conversations = useChatStore((state) => state.conversations);
  const conversationsLoading = useChatStore((state) => state.conversationsLoading);
  const activeId = useChatStore((state) => state.activeId);
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const activeView = useUiStore((state) => state.activeView);
  const pluginPages = useUiStore((state) => state.pluginPages.chat);
  const appInfo = useAppStore((state) => state.appInfo);
  const ui = usePluginUi();
  const prefs = usePluginUiPrefs();
  const isCompact = useIsCompact();
  const nav = useMemo(
    () =>
      navEntries('chat', ui.nav, {
        hidden: prefs.navHidden,
        order: prefs.navOrder,
      }),
    [ui.nav, prefs.enabled, prefs.navHidden, prefs.navOrder, i18n.language],
  );

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const cancelRenameRef = useRef(false);

  // The Chat sidebar only lists Chat sessions; Code sessions and shared
  // sessions belong to their own listing (the shared ones still live here).
  const groups = useMemo(
    () => groupConversations(filterConversationsForLayout(conversations, 'chat')),
    // Group labels are translated, so a language switch must rebuild them.
    [conversations, i18n.language],
  );

  const handleNewChat = () => {
    void useChatStore.getState().startNewConversation();
    if (isCompact) onClose?.();
  };

  const handleSelect = (id: string) => {
    void useChatStore.getState().openConversation(id);
    if (isCompact) onClose?.();
  };

  const handleStartRename = (conversation: Conversation) => {
    cancelRenameRef.current = false;
    setRenamingId(conversation.id);
    setRenameValue(conversation.title);
  };

  const handleCancelRename = () => {
    cancelRenameRef.current = true;
    setRenamingId(null);
  };

  const handleCommitRename = () => {
    const id = renamingId;
    if (!id) return;
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    const title = renameValue.trim();
    setRenamingId(null);
    const current = conversations.find((item) => item.id === id);
    if (title && title !== current?.title) {
      void useChatStore.getState().renameConversation(id, title);
    }
  };

  const handleTogglePin = (conversation: Conversation) => {
    void useChatStore.getState().togglePinned(conversation.id);
  };

  const handleToggleCodeLink = async (conversation: Conversation) => {
    const linked = conversation.codeLinked !== true;
    const ok = await useChatStore.getState().setConversationCodeLinked(conversation.id, linked);
    if (!ok) {
      toast.error(
        linked ? t('shell.toasts.codeLinkAddError') : t('shell.toasts.codeLinkRemoveError'),
      );
      return;
    }
    toast.success(
      linked ? t('shell.toasts.codeLinkAdded') : t('shell.toasts.codeLinkRemoved'),
      {
        description: linked
          ? t('shell.toasts.codeLinkAddedDescription')
          : t('shell.toasts.codeLinkRemovedDescription'),
      },
    );
  };

  const handleExport = async (conversation: Conversation) => {
    try {
      const path = await api.exportConversation(conversation.id, 'markdown');
      if (path) toast.success(t('shell.toasts.exported'), { description: path });
    } catch (error) {
      toast.error(t('shell.toasts.exportError'), { description: String(error) });
    }
  };

  const handleConfirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    await useChatStore.getState().deleteConversation(target.id);
  };

  return (
    <aside
      aria-label={t('shell.sidebar.aria')}
      className={cn('flex h-full w-full min-w-0 flex-col bg-surface', className)}
    >
      <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3">
        <Button
          variant="secondary"
          size="md"
          onClick={handleNewChat}
          leftIcon={<SquarePen className="size-4" />}
          className="h-9 flex-1 justify-start rounded-xl px-3 text-[13px] font-medium"
        >
          {t('shell.sidebar.newChat')}
        </Button>
        {onClose ? (
          <IconButton label={t('shell.sidebar.close')} size="sm" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        ) : null}
      </div>

      {/* Order comes from the plugin navigation registry (host entries first). */}
      <PluginSlot slot="chat.sidebar.header" className="px-3" compact />
      <Slot name="sidebar.nav.before" owner={{ layout: 'chat' }} />
      {nav.map((entry) => {
        const active =
          entry.source === 'plugin'
            ? pluginPages?.pluginId === entry.pluginId && pluginPages.pageId === entry.page
            : !pluginPages && activeView === entry.page;
        return (
          <SidebarNavItem
            key={entry.key}
            entry={entry}
            active={active}
            onSelect={() => {
              openNavTarget(entry);
              if (isCompact) onClose?.();
            }}
          />
        );
      })}
      <Slot name="sidebar.nav.after" owner={{ layout: 'chat' }} />

      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        className={cn(
          'mx-3 mt-1 flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-foreground-muted',
          'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        )}
      >
        <Search className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{t('shell.sidebar.search')}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {conversationsLoading && conversations.length === 0 ? (
          <div className="flex flex-col gap-2 px-1 py-3" role="status" aria-label={t('shell.sidebar.loading')}>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-7 animate-pulse rounded-lg bg-surface-hover motion-reduce:animate-none" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-relaxed text-foreground-subtle">
            {t('shell.sidebar.emptyTitle')}
            <br />
            {t('shell.sidebar.emptyHint')}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.id} aria-label={group.label} className="mb-1">
              <h2 className="px-2 pb-1 pt-3 text-[11px] font-medium text-foreground-subtle">{group.label}</h2>
              <SortableList
                ids={group.conversations.map((conversation) => conversation.id)}
                label={group.label}
                itemLabel={(id) => group.conversations.find((conversation) => conversation.id === id)?.title ?? id}
                onReorder={(ids) => void useChatStore.getState().reorderConversations(ids)}
              >
                {(sortable) => (
                  <div ref={sortable.containerRef} className="flex flex-col gap-0.5">
                    {group.conversations.map((conversation) => (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        active={conversation.id === activeId}
                        renaming={renamingId === conversation.id}
                        renameValue={renameValue}
                        sortable={sortable}
                        onSelect={() => handleSelect(conversation.id)}
                        onStartRename={() => handleStartRename(conversation)}
                        onRenameValueChange={setRenameValue}
                        onCommitRename={handleCommitRename}
                        onCancelRename={handleCancelRename}
                        onTogglePin={() => handleTogglePin(conversation)}
                        onToggleCodeLink={() => void handleToggleCodeLink(conversation)}
                        onExport={() => void handleExport(conversation)}
                        onDelete={() => setDeleteTarget(conversation)}
                      />
                    ))}
                  </div>
                )}
              </SortableList>
            </section>
          ))
        )}
      </div>

      <div className="border-t border-border px-2 py-2">
        <PluginSlot slot="chat.sidebar.footer" className="mb-1 px-1" compact />
        <button
          type="button"
          onClick={() => {
            setSettingsOpen(true);
            if (isCompact) onClose?.();
          }}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-[13px] text-foreground-muted',
            'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          )}
        >
          <Settings className="size-4" />
          <span>{t('shell.sidebar.settings')}</span>
          <span className="ml-auto text-[11px] tabular-nums text-foreground-subtle">
            {appInfo?.version ? `v${appInfo.version}` : ''}
          </span>
        </button>
      </div>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => (open ? undefined : setDeleteTarget(null))}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('shell.deleteDialog.title')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="px-6 pb-4">
            {deleteTarget
              ? t('shell.deleteDialog.description', { title: deleteTarget.title })
              : ''}
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              {t('actions.cancel')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void handleConfirmDelete()}>
              {t('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
