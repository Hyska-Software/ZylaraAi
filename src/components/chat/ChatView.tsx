import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import { MessageQueueBar } from './MessageQueueBar';
import { CodeSessionCards } from '@/components/code/CodeAgentWidgets';
import { Composer } from '@/components/composer/Composer';
import { useReduceMotion } from '@/components/layout/hooks';
import { providerSupportsPlan } from '@/lib/catalog';
import { isConversationVisibleIn } from '@/lib/conversations';
import { selectActiveMessages, useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import type { ChatMessage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { LoadingSkeleton } from './LoadingSkeleton';
import { MessageList } from './MessageList';
import { TurnErrorBanner } from './TurnErrorBanner';
import { planUsageUrl } from './turnError';
import { WelcomeScreen } from './WelcomeScreen';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { resolvePluginComponent, usePluginRegistry, type PluginComponent } from '@/lib/plugins/registry';

/** Distance from the bottom (px) still considered "reading the latest message". */
const BOTTOM_THRESHOLD = 96;

/** Stable empty list for the hidden/stale-session guard (avoids new arrays). */
const NO_MESSAGES: ChatMessage[] = [];

/** True when the turn that produced the last assistant message ended in error. */
function lastAssistantFailed(messages: ChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    // Partial text + failure keeps `status = complete`; the persisted error is
    // the authoritative signal.
    return message.status === 'error' || message.error != null;
  }
  return false;
}

/**
 * Chat column: scrollable conversation with smart auto-scroll, the welcome
 * screen for empty conversations and the composer pinned to the bottom.
 *
 * The Code layout renders this same instance in its center column and only
 * swaps the empty state (`welcome`), so the composer draft and the scroll
 * position survive switching layouts (PLAN §3.3).
 */
export function ChatView({ welcome }: { welcome?: ReactNode } = {}) {
  const { t } = useTranslation('chat');
  const pluginRegistry = usePluginRegistry();
  const activeMessages = useChatStore(selectActiveMessages);
  const activeId = useChatStore((state) => state.activeId);
  const conversations = useChatStore((state) => state.conversations);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const streaming = useChatStore((state) => state.streaming);
  const loadingConversationId = useChatStore((state) => state.loadingConversationId);
  // T4.4a: classified turn errors drive the banner above the composer.
  const errorCode = useChatStore((state) => state.errorCode);
  const errorHint = useChatStore((state) => state.errorHint);
  // Defense in depth: the store keeps one active session per layout and
  // `enterLayout` switches it before paint. If a stale `activeId` still points
  // to a session of the other layout (devtools, future action, race), the chat
  // must show the welcome state instead of leaking the other layout's transcript.
  const activeConversation = activeId
    ? conversations.find((conversation) => conversation.id === activeId)
    : undefined;
  const activeVisible =
    activeId === null ||
    activeConversation === undefined ||
    isConversationVisibleIn(activeConversation, layoutMode);
  const messages = activeVisible ? activeMessages : NO_MESSAGES;
  const selectedProvider = useAppStore((state) =>
    state.providers.find((provider) => provider.id === state.selection.providerId),
  );
  const selectedAuth = useAppStore((state) => state.authStatus(state.selection.providerId));
  const openSettings = useUiStore((state) => state.openSettings);
  const reduceMotion = useReduceMotion();

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Aprovações/perguntas e plano são estado da sessão (codeStore), não
  // mensagens: o transcript tem de rolar até o gate quando ele aparece
  // (WORKBENCH §9 — antes o card ficava fora da viewport e a revisão expirava).
  // O gate não depende do layout: um pedido pendente precisa continuar
  // operável mesmo se a UI trocar de layout no meio do turno.
  const pendingGateCount = useCodeStore((state) => {
    if (!activeId) return 0;
    const session = state.byConversation[activeId];
    if (!session) return 0;
    return session.approvals.length + session.questions.length;
  });
  const planUpdatedAt = useCodeStore((state) =>
    activeId ? (state.byConversation[activeId]?.plan?.updatedAt ?? 0) : 0,
  );
  const lastGateRef = useRef(0);
  const lastPlanRef = useRef(0);
  /** Sessão dos contadores acima (troca de sessão reinicia a comparação). */
  const gateSessionRef = useRef<string | null>(null);

  const loading = loadingConversationId !== null && loadingConversationId === activeId;
  const planProvider = Boolean(
    providerSupportsPlan(selectedProvider) &&
      selectedAuth?.state === 'signed-in' &&
      selectedAuth.planUsage,
  );
  // Only the turn that produced the current conversation's last error can show
  // the banner: navigating to another conversation must not inherit it.
  const showTurnError = errorCode !== null && lastAssistantFailed(messages);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nearBottom = distance < BOTTOM_THRESHOLD;
    atBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
  }, []);

  /* Follow streaming output only while the user is parked at the bottom. */
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom('auto');
  }, [messages, scrollToBottom]);

  /* Always start a conversation at its latest message. */
  useEffect(() => {
    atBottomRef.current = true;
    scrollToBottom('auto');
  }, [activeId, scrollToBottom]);

  /* Scroll to the approval/plan gate as soon as it appears. */
  useEffect(() => {
    if (gateSessionRef.current !== activeId) {
      gateSessionRef.current = activeId;
      lastGateRef.current = 0;
      lastPlanRef.current = 0;
    }
    const gateIncreased = pendingGateCount > lastGateRef.current;
    const planChanged = planUpdatedAt !== 0 && planUpdatedAt !== lastPlanRef.current;
    lastGateRef.current = pendingGateCount;
    lastPlanRef.current = planUpdatedAt;
    if (!gateIncreased && !planChanged) return;
    atBottomRef.current = true;
    scrollToBottom(reduceMotion ? 'auto' : 'smooth');
  }, [activeId, pendingGateCount, planUpdatedAt, reduceMotion, scrollToBottom]);

  /* Sending a message (or regenerating) pulls the view back to the bottom. */
  useEffect(() => {
    const onScrollBottom = () => {
      atBottomRef.current = true;
      scrollToBottom(reduceMotion ? 'auto' : 'smooth');
    };
    window.addEventListener('zylara:scroll-bottom', onScrollBottom);
    return () => window.removeEventListener('zylara:scroll-bottom', onScrollBottom);
  }, [reduceMotion, scrollToBottom]);

  const Welcome = resolvePluginComponent(
    'chat.welcome',
    WelcomeScreen as unknown as PluginComponent,
  );
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="pointer-events-none absolute inset-x-0 top-1 z-10 flex justify-center px-3">
        <PluginSlot
          slot="chat.header.actions"
          context={{ conversationId: activeId ?? undefined }}
          compact
          className="pointer-events-auto"
        />
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {loading ? (
          <LoadingSkeleton />
        ) : messages.length === 0 && pendingGateCount === 0 ? (
          <div className="flex min-h-full items-center justify-center">
            {welcome ?? <Welcome pluginRegistryRevision={pluginRegistry.revision} />}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-6 pb-10 pt-6">
            {messages.length > 0 ? <MessageList messages={messages} streaming={streaming} /> : null}
            {activeId && (layoutMode === 'code' || pendingGateCount > 0) ? (
              // Aprovação/pergunta pendente deve continuar visível e operável
              // mesmo se o usuário trocar para o layout Chat no meio do turno
              // (senão o gate fica escondido e o turno bloqueia até o timeout).
              <CodeSessionCards conversationId={activeId} />
            ) : null}
          </div>
        )}
      </div>

      <div className="relative z-10 shrink-0 px-4 pb-3">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-linear-to-t from-background via-background/90 to-transparent"
        />
        <div className="relative mx-auto w-full max-w-3xl">
          {/* Jobs em background vivem no popover do composer (CodeSessionControls),
              junto de plano/tarefas; não há mais faixa acima do composer. */}
          {activeId ? <MessageQueueBar conversationId={activeId} /> : null}
          {showTurnError ? (
            <TurnErrorBanner
              code={errorCode}
              hint={errorHint}
              planProvider={planProvider}
              usageUrl={planUsageUrl(selectedProvider)}
              onOpenProviders={() => openSettings('providers')}
            />
          ) : null}
          <Composer />
        </div>
      </div>

      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-32 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => scrollToBottom(reduceMotion ? 'auto' : 'smooth')}
            aria-label={t('chatView.jumpToLatest')}
            className={cn(
              'pointer-events-auto flex size-9 items-center justify-center rounded-full ',
              'bg-surface-raised text-foreground-muted shadow-md',
              'transition-colors duration-150 hover:bg-surface-hover hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            )}
          >
            <ArrowDown className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
