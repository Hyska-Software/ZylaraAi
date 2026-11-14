/**
 * Widgets de integração do harness de código no chat/Code layout.
 *
 * Os cards em `src/components/agent/**` são puramente apresentacionais; este
 * arquivo é o container que lê o `codeStore` (aprovações/plano/tarefas/jobs) e
 * envia as decisões pelo `api` — mantendo o `ChatView` livre de regras de
 * sessão (docs/goals/code-harness/WORKBENCH.md §5).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ApprovalCard,
  AskUserCard,
  CacheHitChip,
  ContextMeter,
  GoalAttentionCard,
  PlanCard,
  type ApprovalDecisionOptions,
  type PlanAction,
} from '@/components/agent';
import { goalNeedsAttention } from '@/lib/goalRunner';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui';
import { catalogCost, sessionCostFromMessages } from '@/lib/sessionCost';
import { useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import { useCacheStore } from '@/lib/store/cacheStore';
import type {
  ApprovalDecision,
  ApprovalRequest,
  GoalView,
  PlanApprovalChoice,
  PlanView,
} from '@/lib/types';

/** Motivo que impede criar um novo Goal sem sobrescrever o atual. */
function goalExecutionBlocker(goal: GoalView | null | undefined): string | null {
  if (!goal || goal.status === 'completed') return null;
  const status =
    goal.status === 'active'
      ? t('code:goal.adjective.active')
      : goal.status === 'paused'
        ? t('code:goal.adjective.paused')
        : t('code:goal.adjective.blocked');
  return t('code:cards.goalBlocker', { status });
}

/**
 * Aprovações, plano e perguntas da sessão de código ativa.
 *
 * Tarefas não moram mais aqui: o `TodoCard` fixo no fim do transcript era
 * duplicado com as apresentações da timeline (F-08). O estado atual vive no
 * popover "Plano e tarefas" do composer.
 */
export function CodeSessionCards({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('code');
  const session = useCodeStore((state) => state.byConversation[conversationId]);
  const respondApproval = useCodeStore((state) => state.respondApproval);
  const respondQuestion = useCodeStore((state) => state.respondQuestion);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const [responding, setResponding] = useState<string | null>(null);
  /** Ação do objetivo aplicando (dispensa duplo clique nas ações do card). */
  const [goalBusy, setGoalBusy] = useState(false);
  /** Guard síncrono contra duplo submit (o estado do React é assíncrono). */
  const submittingRef = useRef<string | null>(null);

  if (!session) return null;
  const planApprovals = session.approvals.filter((approval) => approval.tool === 'submit_plan');
  const otherApprovals = session.approvals.filter((approval) => approval.tool !== 'submit_plan');
  const goal = session.goal;
  const goalBlocker = goalExecutionBlocker(goal);
  /* Card de atenção do objetivo (PLAN §10.5): só para estados que exigem decisão
     humana e enquanto esta revisão não foi dispensada pelo usuário. */
  const showGoalAttention = Boolean(
    goal && goalNeedsAttention(goal) && goal.revision !== session.dismissedGoalRevision,
  );
  if (
    planApprovals.length === 0 &&
    otherApprovals.length === 0 &&
    session.questions.length === 0 &&
    !showGoalAttention
  ) {
    return null;
  }

  const applyGoalAction = async (run: () => Promise<unknown>) => {
    if (goalBusy) return;
    setGoalBusy(true);
    try {
      await run();
    } finally {
      setGoalBusy(false);
    }
  };

  const decide = async (
    approval: ApprovalRequest,
    decision: ApprovalDecision,
    options?: ApprovalDecisionOptions & {
      choice?: PlanApprovalChoice | null;
    },
  ) => {
    // Duplo clique / dois listeners no mesmo gate: só a primeira decisão vale.
    if (submittingRef.current) return;
    submittingRef.current = approval.id;
    setResponding(approval.id);
    try {
      // O store faz o refresh e o toast quando o backend responde `false`
      // (aprovação já resolvida/expirada) — ver `codeStore.respondApproval`.
      await respondApproval(conversationId, approval.id, decision, {
        scope: options?.scope ?? null,
        feedback: options?.feedback ?? null,
        choice: options?.choice ?? null,
      });
    } finally {
      submittingRef.current = null;
      setResponding(null);
    }
  };

  const handlePlanAction = (
    approval: ApprovalRequest,
    action: PlanAction,
    feedback?: string,
  ) => {
    if (action === 'keep_planning') {
      void decide(approval, 'denied', {
        feedback: feedback?.trim() || t('code:cards.keepPlanning'),
      });
      return;
    }
    const choice: PlanApprovalChoice =
      action === 'approve_goal'
        ? 'approve_goal'
        : action === 'approve_review'
          ? 'approve_review'
          : 'approve_run';
    void decide(approval, 'approved', { choice });
  };

  const announcement =
    planApprovals.length > 0
      ? t('code:cards.announcement.plan')
      : otherApprovals.length > 0
        ? t('code:cards.announcement.approval')
        : session.questions.length > 0
          ? t('code:cards.announcement.question')
          : '';

  return (
    <div className="mt-3 flex flex-col gap-3">
      {announcement ? (
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      ) : null}
      {otherApprovals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          responding={responding === approval.id}
          onDecide={(decision, options) => {
            void decide(approval, decision, options);
          }}
        />
      ))}
      {planApprovals.map((approval) => {
        const plan: PlanView = {
          state: 'reviewing',
          markdown: approval.preview ?? '',
          updatedAt: approval.createdAt,
          feedback: null,
        };
        return (
          <PlanCard
            key={approval.id}
            plan={plan}
            busy={responding === approval.id}
            goalBlockedReason={goalBlocker}
            onAction={(action, feedback) => handlePlanAction(approval, action, feedback)}
          />
        );
      })}
      {session.questions.map((request) => {
        const assistance = request.questions.find(
          (question) => question.header === 'computer_desktop' || question.header === 'computer_browser',
        );
        return (
          <div key={request.id} className="flex flex-col gap-2">
            <AskUserCard
              questions={request.questions.map((question) => ({
                id: question.id,
                question: question.question,
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.description ?? undefined,
                })),
                multi: question.multiSelect ?? false,
                allowFreeText: !assistance,
              }))}
              onSubmit={(answers) => {
                void respondQuestion(
                  conversationId,
                  request.id,
                  answers.map((answer) => ({
                    questionId: answer.questionId,
                    selected: answer.selected,
                    custom: answer.freeText ?? null,
                  })),
                  false,
                );
              }}
              onSkip={() => {
                void respondQuestion(conversationId, request.id, [], true);
              }}
            />
            {assistance && layoutMode === 'agent' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => {
                  const ui = useUiStore.getState();
                  ui.setAgentRightPanel('agent');
                  ui.setAgentPanelTab(assistance.header === 'computer_browser' ? 'browser' : 'screen');
                  ui.setAgentPanelOpen(true);
                }}>{t('code:cards.openEnvironment')}</Button>
                <span className="text-[11px] text-foreground-muted">{t('code:cards.assistHint')}</span>
              </div>
            ) : null}
          </div>
        );
      })}
      {showGoalAttention && goal ? (
        <GoalAttentionCard
          goal={goal}
          busy={goalBusy}
          onResume={() =>
            void applyGoalAction(() =>
              useCodeStore.getState().updateGoal(conversationId, 'resume'),
            )
          }
          onExtend={() =>
            useUiStore.getState().openGoalDialog({ conversationId, mode: 'edit' })
          }
          onComplete={() =>
            void applyGoalAction(() =>
              useCodeStore.getState().updateGoal(conversationId, 'complete'),
            )
          }
          onReopen={() =>
            void applyGoalAction(() =>
              useCodeStore.getState().updateGoal(conversationId, 'reopen'),
            )
          }
          onOpen={() => useUiStore.getState().openCodeGoal()}
          onDismiss={() =>
            useCodeStore.getState().dismissGoalAttention(conversationId, goal.revision)
          }
        />
      ) : null}
    </div>
  );
}

/** Intervalo máximo entre duas leituras do custo derivado durante um turno. */
const COST_REFRESH_MS = 10_000;

/**
 * Re-render counter used to re-derive a value at least every `intervalMs`
 * while `active` (a turn is running for this conversation). Idle conversations
 * keep no timer: there is nothing to re-read until an event arrives.
 */
function useRefreshTick(active: boolean, intervalMs: number = COST_REFRESH_MS): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return tick;
}

/**
 * Medidor do header: chip compacto com anel de contexto + `%` de cache + custo
 * da sessão (USD).
 *
 * O `cacheStore` é a fonte do cache (evento `cache_stats` por request +
 * restauração via `get_cache_stats`); `Settings.cache.showIndicator` só
 * esconde o indicador, a medição continua. O custo vem das mensagens
 * persistidas (uso por turno já inclui os subagentes) e dos preços oficiais do
 * catálogo (`catalogCost`), com o catálogo vivo do `appStore` na frente do
 * snapshot embutido. Sem contexto (payload antigo ou sessão sem snapshot) o
 * chip cai para a variante cache-first; sem uso cobrado o custo fica oculto. O
 * container não esconde mais o medidor abaixo de 1024px (`hidden lg:block`
 * removido): o requisito é mostrar em tempo real, então ele encolhe/reserva
 * largura em vez de sumir.
 *
 * **Custo em tempo real**: o harness emite `usage` com o total acumulado do
 * turno a cada request que reportou uso (`emit_live_usage` em
 * `harness/mod.rs`), e o `chatStore` aplica o evento na mensagem em streaming —
 * então o `$` sobe na mesma cadência do anel de contexto e do cache. O
 * `useRefreshTick` é a rede de segurança: enquanto o turno roda, o valor
 * derivado é relido no máximo a cada 10 s, mesmo que um evento se perca.
 */
export function CodeContextMeterChip({
  conversationId,
  showCache = true,
}: {
  conversationId: string;
  /** The Agents layout only needs context, not the prompt-cache segment. */
  showCache?: boolean;
}) {
  const stats = useCodeStore((state) => state.byConversation[conversationId]?.context);
  const cache = useCacheStore((state) => state.byConversation[conversationId] ?? null);
  const showCacheIndicator = useAppStore(
    (state) => state.settings.cache?.showIndicator !== false,
  );
  const providers = useAppStore((state) => state.providers);
  const messages = useChatStore((state) => state.messagesByConversation[conversationId]);
  const turnRunning = useChatStore((state) =>
    Boolean(state.streamsByConversation[conversationId]),
  );
  const tick = useRefreshTick(turnRunning);
  const cost = useMemo(
    () =>
      sessionCostFromMessages(messages, (providerId, modelId) =>
        catalogCost(providers, providerId, modelId),
      ),
    // `tick` is deliberate: it re-reads the derived cost every `COST_REFRESH_MS`.
    [messages, providers, tick],
  );
  const cacheVisible = showCache && showCacheIndicator && cache != null;

  if (!stats) {
    if (!cacheVisible) return null;
    return (
      <div className="hidden sm:block">
        <CacheHitChip cache={cache} />
      </div>
    );
  }

  return (
    <div className="hidden sm:block">
      <ContextMeter stats={stats} cache={cacheVisible ? cache : undefined} cost={cost} />
    </div>
  );
}
