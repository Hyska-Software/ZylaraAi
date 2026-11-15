/**
 * Single source of truth for the command palette catalog
 * (docs/COMMAND_PALETTE.md §5). Availability is resolved here: context-only
 * commands are simply absent when they cannot run, so the palette never offers
 * a dead end.
 */
import {
  Activity,
  ArrowLeft,
  Bot,
  Braces,
  Code,
  Copy,
  Download,
  FilePlus,
  FileText,
  FolderOpen,
  Globe,
  Library,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  PanelLeft,
  Pin,
  PinOff,
  Plug,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  SunMoon,
  Terminal,
  TextCursorInput,
  Trash2,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { requestCacheDiagnostics } from '@/components/agent/cacheDiagnosticsRequest';
import { api } from '@/lib/api';
import { conversationCitations } from '@/lib/citations';
import { t } from '@/lib/i18n';
import { SETTINGS_TABS } from '@/lib/settingsTabs';
import { SETTINGS_TAB_ICONS } from '@/components/settings/tabIcons';
import { pluginIcon } from '@/lib/plugins/icons';
import {
  commandDescription,
  commandLabel,
  openPluginView,
  runPluginCommand,
} from '@/lib/plugins/host';
import {
  pluginLabel,
  pluginViewsForSurface,
  usePluginRegistry,
  type ResolvedView,
} from '@/lib/plugins/registry';
import { usePluginStore } from '@/lib/plugins/store';
import {
  modelLockCopy,
  modelLockReason,
  resolveDark,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import type { ModelLockReason } from '@/lib/store';
import type { SettingsTabId } from '@/lib/settingsTabs';
import type { ChatMessage } from '@/lib/types';
import type { PaletteAction } from '@/lib/palette/types';
import { copyText, modKey, truncate } from '@/lib/utils';

/** Copy shared by the settings tab commands (DESIGN §9). */
function settingsTabDescription(id: SettingsTabId): string {
  switch (id) {
    case 'general':
      return t('palette:settingsTabDescriptions.general');
    case 'themes':
      return t('palette:settingsTabDescriptions.themes');
    case 'terminal':
      return t('palette:settingsTabDescriptions.terminal');
    case 'providers':
      return t('palette:settingsTabDescriptions.providers');
    case 'model':
      return t('palette:settingsTabDescriptions.model');
    case 'instructions':
      return t('palette:settingsTabDescriptions.instructions');
    case 'tools':
      return t('palette:settingsTabDescriptions.tools');
    case 'plugins':
      return t('palette:settingsTabDescriptions.plugins');
    case 'agents':
      return t('palette:settingsTabDescriptions.agents');
    case 'data':
      return t('palette:settingsTabDescriptions.data');
    case 'about':
      return t('palette:settingsTabDescriptions.about');
    default:
      return t('palette:settingsTabDescriptions.plugins');
  }
}

function lastAssistantMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
}

function currentActiveMessages(): ChatMessage[] {
  const chat = useChatStore.getState();
  return chat.activeId ? (chat.messagesByConversation[chat.activeId] ?? []) : [];
}

async function copyLastAnswer(): Promise<void> {
  const last = lastAssistantMessage(currentActiveMessages());
  if (!last) {
    toast.info(t('palette:toasts.noAnswer'));
    return;
  }
  const ok = await copyText(last.content);
  if (ok) toast.success(t('palette:toasts.answerCopied'));
  else toast.error(t('palette:toasts.copyFailed'));
}

async function exportActiveConversation(format: 'markdown' | 'json'): Promise<void> {
  const conversationId = useChatStore.getState().activeId;
  if (!conversationId) {
    toast.info(t('palette:toasts.noConversation'));
    return;
  }
  try {
    const path = await api.exportConversation(conversationId, format);
    if (path) toast.success(t('palette:toasts.exported'), { description: path });
  } catch (error) {
    toast.error(t('palette:toasts.exportFailed'), { description: String(error) });
  }
}

function setTheme(theme: 'light' | 'dark' | 'system'): void {
  const ui = useUiStore.getState();
  ui.setTheme(theme);
  void useAppStore.getState().saveSettings({ theme });
}

function toggleTheme(): void {
  setTheme(resolveDark(useUiStore.getState().theme) ? 'light' : 'dark');
}

function toggleSetting(
  key: 'webSearchEnabled' | 'fileCreationEnabled' | 'codeExecutionEnabled',
  toolLabel: string,
): void {
  const app = useAppStore.getState();
  const next = !app.settings[key];
  void app.saveSettings({ [key]: next });
  toast.success(
    next
      ? t('palette:toasts.toolEnabled', { tool: toolLabel })
      : t('palette:toasts.toolDisabled', { tool: toolLabel }),
  );
}

function focusComposer(): void {
  const ui = useUiStore.getState();
  // The composer lives in the single ChatView instance shared by both layouts;
  // when another surface replaces the conversation, go back to it first and
  // focus once the composer is visible again.
  const hidden =
    ui.layoutMode === 'code' ? ui.codeView !== 'session' : ui.activeView !== 'chat';
  if (!hidden) {
    window.dispatchEvent(new CustomEvent('zylara:focus-composer'));
    return;
  }
  if (ui.layoutMode === 'code') ui.setCodeView('session');
  else ui.setActiveView('chat');
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('zylara:focus-composer'));
  }, 0);
}

function openSkills(): void {
  const ui = useUiStore.getState();
  if (ui.layoutMode === 'code') ui.setCodeView('skills');
  else ui.setActiveView('skills');
}

function openArtifacts(): void {
  const ui = useUiStore.getState();
  if (!ui.artifacts.length) {
    toast.info(t('palette:toasts.noArtifacts'));
    return;
  }
  ui.openArtifactList();
}

/**
 * Biblioteca commands (PLAN §4.3): the view replaces the chat column, so the
 * palette closes, the view mounts and only then is the native picker requested
 * through the `zylara:library-import` event (one tick later, when the listener
 * is already attached).
 */
function openLibrary(): void {
  useUiStore.getState().setActiveView('library');
}

function importFilesToLibrary(): void {
  useUiStore.getState().setActiveView('library');
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('zylara:library-import'));
  }, 0);
}

function openSources(): void {
  const count = conversationCitations(currentActiveMessages()).length;
  if (count === 0) {
    toast.info(t('palette:toasts.noSources'));
    return;
  }
  useUiStore.getState().openSourcesPanel();
}

function openDataDir(): void {
  void api.openDataDir().catch((error: unknown) => {
    toast.error(t('palette:toasts.openDataDirFailed'), { description: String(error) });
  });
}

function openSkillsDir(): void {
  void api.openSkillsDir().catch((error: unknown) => {
    toast.error(t('palette:toasts.openSkillsDirFailed'), { description: String(error) });
  });
}

function refreshCatalog(): void {
  void useAppStore
    .getState()
    .refreshCatalog()
    .then(() => {
      const error = useAppStore.getState().error;
      if (error) {
        toast.error(t('palette:toasts.catalogFailed'), { description: error });
        return;
      }
      toast.success(t('palette:toasts.catalogUpdated'));
    });
}

function togglePinnedConversation(): void {
  const chat = useChatStore.getState();
  const conversation = chat.conversations.find((entry) => entry.id === chat.activeId);
  if (!conversation) return;
  void chat.togglePinned(conversation.id);
  toast.success(
    conversation.pinned
      ? t('palette:toasts.conversationUnpinned')
      : t('palette:toasts.conversationPinned'),
    {
      description: truncate(conversation.title, 60),
    },
  );
}

function switchModel(reason: ModelLockReason | null): void {
  if (reason) {
    const copy = modelLockCopy(reason);
    toast.info(copy.title, { description: copy.description });
    return;
  }
  useUiStore.getState().setModelPickerOpen(true);
}

/**
 * Builds the palette commands for the current context. Reading every dependency
 * through selectors keeps the palette reactive (streaming start/stop, new
 * attachments, theme/tool changes, conversation switch).
 */
export function usePaletteActions(): PaletteAction[] {
  const { t: tPalette } = useTranslation('palette');
  const { t: tSettings } = useTranslation('settings');
  const conversations = useChatStore((state) => state.conversations);
  const activeId = useChatStore((state) => state.activeId);
  const messages = useChatStore((state) =>
    state.activeId ? state.messagesByConversation[state.activeId] : undefined,
  );
  const streaming = useChatStore((state) => state.streaming !== null);
  const pendingAttachments = useChatStore((state) => state.pendingAttachments);

  const settings = useAppStore((state) => state.settings);
  const theme = useUiStore((state) => state.theme);
  const activeView = useUiStore((state) => state.activeView);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const enabledLayouts = useUiStore((state) => state.enabledLayouts);
  const activeAgentId = useUiStore((state) => state.activeAgentId);
  const openAgentEditor = useUiStore((state) => state.openAgentEditor);
  const codeView = useUiStore((state) => state.codeView);
  const artifacts = useUiStore((state) => state.artifacts);
  const pluginRegistry = usePluginRegistry();
  const pluginSafeMode = usePluginStore((state) => state.snapshot.safeMode);
  // Chat locks the model of a started conversation; a Code session can switch it
  // between turns (a running turn locks it in every layout).
  const lockReason = useChatStore((state) => modelLockReason(state, layoutMode));

  const activeConversation = conversations.find((entry) => entry.id === activeId);
  const activeMessages = messages ?? [];
  const lastAssistant = lastAssistantMessage(activeMessages);
  const lastUser = [...activeMessages].reverse().find((message) => message.role === 'user');
  const citations = conversationCitations(activeMessages);
  const dark = resolveDark(theme);
  const lockCopy = lockReason ? modelLockCopy(lockReason) : null;
  const actions: PaletteAction[] = [];

  /* -------- Conversas -------- */
  actions.push({
    id: 'nova-conversa',
    group: 'conversas',
    label:
      layoutMode === 'code'
        ? tPalette('actions.newConversation.codeLabel')
        : layoutMode === 'agent'
          ? tPalette('actions.newConversation.agentLabel')
          : tPalette('actions.newConversation.chatLabel'),
    description:
      layoutMode === 'code'
        ? tPalette('actions.newConversation.codeDescription')
        : layoutMode === 'agent'
          ? tPalette('actions.newConversation.agentDescription')
          : tPalette('actions.newConversation.chatDescription'),
    icon: MessageSquarePlus,
    shortcut: `${modKey}+N`,
    keywords:
      layoutMode === 'code'
        ? tPalette('actions.newConversation.codeKeywords')
        : layoutMode === 'agent'
          ? tPalette('actions.newConversation.agentKeywords')
          : tPalette('actions.newConversation.chatKeywords'),
    run: () => {
      if (layoutMode === 'code') {
        void useChatStore.getState().startNewConversation('code');
        return;
      }
      if (layoutMode === 'agent') {
        const agentId = useUiStore.getState().activeAgentId;
        if (agentId) void useChatStore.getState().startNewConversation('agent', { agentId });
        return;
      }
      // A Chat session is created in the Chat namespace; make sure its layout
      // is the visible one.
      useUiStore.getState().setLayoutMode('chat');
      void useChatStore.getState().startNewConversation('chat');
    },
  });

  if (activeConversation) {
    actions.push({
      id: 'fixar-conversa',
      group: 'conversas',
      label: activeConversation.pinned
        ? tPalette('actions.pinConversation.unpinLabel')
        : tPalette('actions.pinConversation.pinLabel'),
      description: truncate(activeConversation.title, 72),
      icon: activeConversation.pinned ? PinOff : Pin,
      keywords: tPalette('actions.pinConversation.keywords'),
      run: togglePinnedConversation,
    });
    actions.push({
      id: 'exportar-markdown',
      group: 'conversas',
      label: tPalette('actions.exportMarkdown.label'),
      description: tPalette('actions.exportMarkdown.description'),
      icon: Download,
      keywords: tPalette('actions.exportMarkdown.keywords'),
      run: () => void exportActiveConversation('markdown'),
    });
    actions.push({
      id: 'exportar-json',
      group: 'conversas',
      label: tPalette('actions.exportJson.label'),
      description: tPalette('actions.exportJson.description'),
      icon: Braces,
      keywords: tPalette('actions.exportJson.keywords'),
      run: () => void exportActiveConversation('json'),
    });
  }

  if (lastAssistant) {
    actions.push({
      id: 'copiar-ultima-resposta',
      group: 'conversas',
      label: tPalette('actions.copyLastAnswer.label'),
      description: tPalette('actions.copyLastAnswer.description'),
      icon: Copy,
      keywords: tPalette('actions.copyLastAnswer.keywords'),
      run: () => void copyLastAnswer(),
    });
  }

  if (pendingAttachments.length > 0) {
    actions.push({
      id: 'limpar-anexos',
      group: 'conversas',
      label: tPalette('actions.clearAttachments.label'),
      description:
        pendingAttachments.length === 1
          ? tPalette('actions.clearAttachments.descriptionOne', {
              count: pendingAttachments.length,
            })
          : tPalette('actions.clearAttachments.descriptionOther', {
              count: pendingAttachments.length,
            }),
      icon: Trash2,
      keywords: tPalette('actions.clearAttachments.keywords'),
      run: () => {
        useChatStore.getState().clearAttachments();
        toast.success(t('palette:toasts.attachmentsRemoved'));
      },
    });
  }

  if (streaming) {
    actions.push({
      id: 'parar-resposta',
      group: 'conversas',
      label: tPalette('actions.stopResponse.label'),
      description: tPalette('actions.stopResponse.description'),
      icon: Square,
      keywords: tPalette('actions.stopResponse.keywords'),
      run: () => void useChatStore.getState().stop(),
    });
  } else if (lastAssistant && lastUser) {
    actions.push({
      id: 'regenerar-resposta',
      group: 'conversas',
      label: tPalette('actions.regenerateResponse.label'),
      description: tPalette('actions.regenerateResponse.description'),
      icon: RotateCcw,
      keywords: tPalette('actions.regenerateResponse.keywords'),
      run: () => void useChatStore.getState().regenerate(),
    });
  }

  /* -------- Navegação -------- */
  // A hidden layout is unreachable, so the palette never offers it.
  const alternateLayout = layoutMode === 'chat' ? 'code' : 'chat';
  if (enabledLayouts[alternateLayout]) {
    actions.push({
      id: layoutMode === 'chat' ? 'modo-code' : 'modo-chat',
      group: 'navegacao',
      label:
        layoutMode === 'chat'
          ? tPalette('actions.modeCode.label')
          : tPalette('actions.modeChat.label'),
      description:
        layoutMode === 'chat'
          ? tPalette('actions.modeCode.description')
          : tPalette('actions.modeChat.description'),
      icon: layoutMode === 'chat' ? Code : MessageSquare,
      keywords:
        layoutMode === 'chat'
          ? tPalette('actions.modeCode.keywords')
          : tPalette('actions.modeChat.keywords'),
      run: () => useUiStore.getState().setLayoutMode(alternateLayout),
    });
  }

  if (layoutMode !== 'agent' && enabledLayouts.agent) {
    actions.push({
      id: 'modo-agentes',
      group: 'navegacao',
      label: tPalette('actions.modeAgents.label'),
      description: tPalette('actions.modeAgents.description'),
      icon: Bot,
      keywords: tPalette('actions.modeAgents.keywords'),
      run: () => useUiStore.getState().setLayoutMode('agent'),
    });
  } else {
    actions.push({
      id: 'novo-agente',
      group: 'navegacao',
      label: tPalette('actions.newAgent.label'),
      description: tPalette('actions.newAgent.description'),
      icon: Bot,
      keywords: tPalette('actions.newAgent.keywords'),
      run: () => openAgentEditor({ mode: 'create' }),
    });
    if (activeAgentId) {
      actions.push({
        id: 'editar-agente',
        group: 'navegacao',
        label: tPalette('actions.editAgent.label'),
        description: tPalette('actions.editAgent.description'),
        icon: Bot,
        keywords: tPalette('actions.editAgent.keywords'),
        run: () => openAgentEditor({ mode: 'edit', agentId: activeAgentId }),
      });
    }
  }

  actions.push({
    id: 'focar-composer',
    group: 'navegacao',
    label: tPalette('actions.focusComposer.label'),
    description: tPalette('actions.focusComposer.description'),
    icon: TextCursorInput,
    shortcut: `${modKey}+J`,
    keywords: tPalette('actions.focusComposer.keywords'),
    run: focusComposer,
  });

  // Diagnóstico de cache (F5.4): painel completo da conversa ativa. Fica perto
  // dos comandos do Code porque o indicador nasce no medidor de contexto.
  if (activeConversation) {
    actions.push({
      id: 'diagnostico-cache',
      group: 'navegacao',
      label: tPalette('actions.cacheDiagnostics.label'),
      description: tPalette('actions.cacheDiagnostics.description'),
      icon: Activity,
      keywords: tPalette('actions.cacheDiagnostics.keywords'),
      run: requestCacheDiagnostics,
    });
  }
  actions.push({
    id: 'alternar-sidebar',
    group: 'navegacao',
    label: tPalette('actions.toggleSidebar.label'),
    description: tPalette('actions.toggleSidebar.description'),
    icon: PanelLeft,
    shortcut: `${modKey}+B`,
    keywords: tPalette('actions.toggleSidebar.keywords'),
    run: () => useUiStore.getState().toggleSidebar(),
  });

  // Artifacts/library/sources are Chat-layout surfaces: the Code workbench
  // replaces them with its Arquivos/Alterações panel, so the commands are
  // simply absent there (never a dead end — COMMAND_PALETTE §5).
  if (layoutMode === 'chat') {
    actions.push({
      id: 'abrir-artefatos',
      group: 'navegacao',
      label: tPalette('actions.openArtifacts.label'),
      description: artifacts.length
        ? artifacts.length === 1
          ? tPalette('actions.openArtifacts.descriptionOne', { count: artifacts.length })
          : tPalette('actions.openArtifacts.descriptionOther', { count: artifacts.length })
        : tPalette('actions.openArtifacts.descriptionEmpty'),
      icon: FileText,
      keywords: tPalette('actions.openArtifacts.keywords'),
      run: openArtifacts,
    });
    actions.push({
      id: 'abrir-fontes',
      group: 'navegacao',
      label: tPalette('actions.openSources.label'),
      description: citations.length
        ? citations.length === 1
          ? tPalette('actions.openSources.descriptionOne', { count: citations.length })
          : tPalette('actions.openSources.descriptionOther', { count: citations.length })
        : tPalette('actions.openSources.descriptionEmpty'),
      icon: Globe,
      keywords: tPalette('actions.openSources.keywords'),
      run: openSources,
    });
    actions.push({
      id: 'abrir-biblioteca',
      group: 'navegacao',
      label: tPalette('actions.openLibrary.label'),
      description: tPalette('actions.openLibrary.description'),
      icon: Library,
      keywords: tPalette('actions.openLibrary.keywords'),
      run: openLibrary,
    });
    actions.push({
      id: 'enviar-arquivos-biblioteca',
      group: 'navegacao',
      label: tPalette('actions.importLibrary.label'),
      description: tPalette('actions.importLibrary.description'),
      icon: Upload,
      keywords: tPalette('actions.importLibrary.keywords'),
      run: importFilesToLibrary,
    });
  }

  if (settings.skillsPanelEnabled) {
    actions.push({
      id: 'gerenciar-skills',
      group: 'navegacao',
      label: tPalette('actions.manageSkills.label'),
      description: tPalette('actions.manageSkills.description'),
      icon: Sparkles,
      keywords: tPalette('actions.manageSkills.keywords'),
      run: openSkills,
    });
    actions.push({
      id: 'abrir-pasta-skills',
      group: 'navegacao',
      label: tPalette('actions.openSkillsFolder.label'),
      description: tPalette('actions.openSkillsFolder.description'),
      icon: FolderOpen,
      keywords: tPalette('actions.openSkillsFolder.keywords'),
      run: openSkillsDir,
    });
  }

  if (layoutMode === 'code') {
    if (codeView === 'skills') {
      actions.push({
        id: 'voltar-a-sessao',
        group: 'navegacao',
        label: tPalette('actions.backToSession.label'),
        description: tPalette('actions.backToSession.description'),
        icon: ArrowLeft,
        keywords: tPalette('actions.backToSession.keywords'),
        run: () => useUiStore.getState().setCodeView('session'),
      });
    }
  } else if (activeView === 'skills' || activeView === 'library') {
    actions.push({
      id: 'voltar-ao-chat',
      group: 'navegacao',
      label: tPalette('actions.backToChat.label'),
      description:
        activeView === 'library'
          ? tPalette('actions.backToChat.descriptionLibrary')
          : tPalette('actions.backToChat.descriptionSkills'),
      icon: ArrowLeft,
      keywords: tPalette('actions.backToChat.keywords'),
      run: () => useUiStore.getState().setActiveView('chat'),
    });
  }

  actions.push({
    id: 'trocar-modelo',
    group: 'navegacao',
    label: lockCopy ? lockCopy.title : tPalette('actions.switchModel.label'),
    description: lockCopy
      ? lockCopy.description
      : tPalette('actions.switchModel.description'),
    icon: lockCopy ? Lock : Sparkles,
    keywords: tPalette('actions.switchModel.keywords'),
    run: () => switchModel(lockReason),
  });

  /* -------- Ferramentas -------- */
  actions.push({
    id: 'busca-web',
    group: 'ferramentas',
    label: settings.webSearchEnabled
      ? tPalette('actions.webSearch.disableLabel')
      : tPalette('actions.webSearch.enableLabel'),
    description: settings.webSearchEnabled
      ? tPalette('actions.webSearch.enabledDescription')
      : tPalette('actions.webSearch.disabledDescription'),
    icon: Globe,
    keywords: tPalette('actions.webSearch.keywords'),
    checked: settings.webSearchEnabled,
    run: () => toggleSetting('webSearchEnabled', t('palette:tools.webSearch')),
  });
  actions.push({
    id: 'criar-arquivos',
    group: 'ferramentas',
    label: settings.fileCreationEnabled
      ? tPalette('actions.fileCreation.disableLabel')
      : tPalette('actions.fileCreation.enableLabel'),
    description: settings.fileCreationEnabled
      ? tPalette('actions.fileCreation.enabledDescription')
      : tPalette('actions.fileCreation.disabledDescription'),
    icon: FilePlus,
    keywords: tPalette('actions.fileCreation.keywords'),
    checked: settings.fileCreationEnabled,
    run: () => toggleSetting('fileCreationEnabled', t('palette:tools.fileCreation')),
  });
  actions.push({
    id: 'executar-codigo',
    group: 'ferramentas',
    label: settings.codeExecutionEnabled
      ? tPalette('actions.codeExecution.disableLabel')
      : tPalette('actions.codeExecution.enableLabel'),
    description: settings.codeExecutionEnabled
      ? tPalette('actions.codeExecution.enabledDescription')
      : tPalette('actions.codeExecution.disabledDescription'),
    icon: Terminal,
    keywords: tPalette('actions.codeExecution.keywords'),
    checked: settings.codeExecutionEnabled,
    run: () => toggleSetting('codeExecutionEnabled', t('palette:tools.codeExecution')),
  });

  /* -------- Aparência -------- */
  actions.push({
    id: 'alternar-tema',
    group: 'aparencia',
    label: tPalette('actions.toggleTheme.label'),
    description: tPalette('actions.toggleTheme.description', {
      theme: t(dark ? 'palette:themes.dark' : 'palette:themes.light'),
      next: t(dark ? 'palette:themes.light' : 'palette:themes.dark'),
    }),
    icon: SunMoon,
    keywords: tPalette('actions.toggleTheme.keywords'),
    run: toggleTheme,
  });
  actions.push({
    id: 'tema-sistema',
    group: 'aparencia',
    label: tPalette('actions.systemTheme.label'),
    description: tPalette('actions.systemTheme.description'),
    icon: Monitor,
    keywords: tPalette('actions.systemTheme.keywords'),
    checked: theme === 'system',
    run: () => setTheme('system'),
  });

  /* -------- Configurações -------- */
  actions.push({
    id: 'abrir-configuracoes',
    group: 'configuracoes',
    label: tPalette('actions.openSettings.label'),
    description: tPalette('actions.openSettings.description'),
    icon: Settings,
    shortcut: `${modKey}+,`,
    keywords: tPalette('actions.openSettings.keywords'),
    run: () => useUiStore.getState().openSettings(),
  });
  for (const tab of SETTINGS_TABS) {
    actions.push({
      id: `config-${tab.id}`,
      group: 'configuracoes',
      label: tSettings('dialog.openTab', { tab: tSettings(tab.labelKey) }),
      description: settingsTabDescription(tab.id),
      icon: SETTINGS_TAB_ICONS[tab.id],
      keywords: `${tPalette('actions.openSettings.keywords')} ${tSettings(tab.labelKey)}`,
      run: () => useUiStore.getState().openSettings(tab.id),
    });
  }

  for (const tab of pluginRegistry.settingsTabs) {
    const label = pluginLabel(tab.plugin, tab.tab.titleKey, tab.tab.title);
    actions.push({
      id: `config-plugin-${tab.key}`,
      group: 'configuracoes',
      label: tSettings('dialog.openTab', { tab: label }),
      description: tab.plugin.name,
      icon: pluginIcon(tab.tab.icon),
      keywords: `${tPalette('actions.openSettings.keywords')} ${label} plugin`,
      run: () =>
        useUiStore
          .getState()
          .openSettings(`plugin:${tab.key}` as SettingsTabId),
    });
  }

  /* -------- Sistema -------- */
  actions.push({
    id: 'abrir-pasta-dados',
    group: 'sistema',
    label: tPalette('actions.openDataFolder.label'),
    description: tPalette('actions.openDataFolder.description'),
    icon: FolderOpen,
    keywords: tPalette('actions.openDataFolder.keywords'),
    run: openDataDir,
  });
  actions.push({
    id: 'recarregar-catalogo',
    group: 'sistema',
    label: tPalette('actions.refreshCatalog.label'),
    description: tPalette('actions.refreshCatalog.description'),
    icon: RefreshCw,
    keywords: tPalette('actions.refreshCatalog.keywords'),
    run: refreshCatalog,
  });

  actions.push({
    id: 'abrir-plugins',
    group: 'plugins',
    label: tPalette('actions.openPlugins.label'),
    description: pluginSafeMode
      ? tPalette('actions.openPlugins.safeModeDescription')
      : tPalette('actions.openPlugins.description'),
    icon: Plug,
    keywords: tPalette('actions.openPlugins.keywords'),
    run: () => {
      usePluginStore.getState().closeOverlays();
      useUiStore.getState().setLayoutMode('chat');
      useUiStore.getState().setActiveView('plugins');
    },
  });
  actions.push({
    id: 'instalar-plugin-arquivo',
    group: 'plugins',
    label: tPalette('actions.installPluginFile.label'),
    description: tPalette('actions.installPluginFile.description'),
    icon: Upload,
    keywords: tPalette('actions.installPluginFile.keywords'),
    run: () => {
      useUiStore.getState().setLayoutMode('chat');
      useUiStore.getState().setActiveView('plugins');
      window.setTimeout(
        () => window.dispatchEvent(new CustomEvent('zylara:plugin-install-file')),
        0,
      );
    },
  });
  for (const view of pluginViewsForSurface(layoutMode, 'sidebar')) {
    const label = pluginLabel(view.plugin, view.view.titleKey, view.view.title);
    actions.push({
      id: `plugin-view-${view.key}`,
      group: 'plugins',
      label,
      description: view.plugin.name,
      icon: pluginIcon(view.view.icon),
      keywords: `${view.plugin.name} plugin`,
      run: () => openPluginView(view.plugin, view.view.id),
    });
  }
  for (const command of pluginRegistry.commands) {
    actions.push({
      id: `plugin-command-${command.key}`,
      group: 'plugins',
      label: commandLabel(command),
      description: commandDescription(command),
      icon: pluginIcon(command.command.icon),
      keywords: `${command.plugin.name} ${command.command.keywords ?? ''} plugin`,
      run: () => void runPluginCommand(command, { conversationId: activeId }),
    });
  }

  return actions;
}
