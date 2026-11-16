import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeSessionState, GoalView } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  getCodeSessionState: vi.fn(),
  setPlanMode: vi.fn(),
  setCreatorMode: vi.fn(),
  setPermissionMode: vi.fn(),
  respondApproval: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  listGoalRounds: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

// Imported after the mocks above.
import { toast } from 'sonner';
import { emptyCodeSession, useCodeStore } from '../codeStore';

function sessionState(overrides: Partial<CodeSessionState> = {}): CodeSessionState {
  return {
    conversationId: 'c-1',
    permissionMode: 'edit',
    planMode: false,
    todos: [],
    jobs: [],
    approvals: [],
    ...overrides,
  };
}

function seed(): void {
  useCodeStore.setState({ byConversation: { 'c-1': emptyCodeSession('c-1') } });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCodeStore.setState({ byConversation: {} });
});

describe('codeStore — eventos de sessão', () => {
  it('não cria estado de código para turn_started de uma conversa sem sessão', () => {
    useCodeStore.getState().applyEvent('chat-1', {
      type: 'turn_started',
      turnId: 'turn-1',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
    });
    expect(useCodeStore.getState().byConversation['chat-1']).toBeUndefined();
  });
});

describe('codeStore — ações de plano/aprovação (Fase 0)', () => {
  it('setPlanMode é otimista: o chip liga antes do IPC e confirma com o snapshot', async () => {
    seed();
    let resolveSnapshot: (value: CodeSessionState) => void = () => undefined;
    mocks.setPlanMode.mockReturnValue(
      new Promise<CodeSessionState>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = useCodeStore.getState().setPlanMode('c-1', true);
    // Otimista: estado da UI muda antes da resposta do backend.
    expect(useCodeStore.getState().byConversation['c-1'].planMode).toBe(true);

    resolveSnapshot(sessionState({ planMode: true }));
    await expect(pending).resolves.toBe(true);
    expect(mocks.setPlanMode).toHaveBeenCalledWith('c-1', true);
    expect(useCodeStore.getState().byConversation['c-1'].planMode).toBe(true);
  });

  it('setPlanMode faz rollback e mostra toast quando o backend falha', async () => {
    seed();
    mocks.setPlanMode.mockRejectedValue(new Error('negado'));

    await expect(useCodeStore.getState().setPlanMode('c-1', true)).resolves.toBe(false);

    expect(useCodeStore.getState().byConversation['c-1'].planMode).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      'Não foi possível alterar o modo Plano',
      expect.objectContaining({ description: 'Error: negado' }),
    );
  });

  it('setCreatorMode é otimista e confirma com o snapshot', async () => {
    seed();
    let resolveSnapshot: (value: CodeSessionState) => void = () => undefined;
    mocks.setCreatorMode.mockReturnValue(
      new Promise<CodeSessionState>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = useCodeStore.getState().setCreatorMode('c-1', true);
    expect(useCodeStore.getState().byConversation['c-1'].creatorMode).toBe(true);

    resolveSnapshot(sessionState({ creatorMode: true }));
    await expect(pending).resolves.toBe(true);
    expect(mocks.setCreatorMode).toHaveBeenCalledWith('c-1', true);
    expect(useCodeStore.getState().byConversation['c-1'].creatorMode).toBe(true);
  });

  it('setCreatorMode faz rollback quando o backend falha', async () => {
    seed();
    mocks.setCreatorMode.mockRejectedValue(new Error('negado'));

    await expect(useCodeStore.getState().setCreatorMode('c-1', true)).resolves.toBe(false);

    expect(useCodeStore.getState().byConversation['c-1'].creatorMode).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      'Não foi possível alterar o modo Criador de plugins',
      expect.objectContaining({ description: 'Error: negado' }),
    );
  });

  it('respondApproval encaminha choice/planMarkdown e sincroniza o snapshot do plano', async () => {
    seed();
    mocks.respondApproval.mockResolvedValue(true);
    mocks.getCodeSessionState.mockResolvedValue(
      sessionState({ planMode: false, permissionMode: 'review' }),
    );

    const ok = await useCodeStore.getState().respondApproval('c-1', 'apr-1', 'approved', {
      choice: 'approve_review',
      planMarkdown: '## Plano revisado',
    });

    expect(ok).toBe(true);
    expect(mocks.respondApproval).toHaveBeenCalledWith('apr-1', 'approved', {
      scope: null,
      feedback: null,
      choice: 'approve_review',
      planMarkdown: '## Plano revisado',
    });
    // Decisão de plano muda modo/permissão: snapshot é recarregado.
    expect(mocks.getCodeSessionState).toHaveBeenCalledWith('c-1');
    expect(useCodeStore.getState().byConversation['c-1'].permissionMode).toBe('review');
  });

  it('respondApproval trata aprovação morta (false) com toast + refresh', async () => {
    seed();
    mocks.respondApproval.mockResolvedValue(false);
    mocks.getCodeSessionState.mockResolvedValue(sessionState());

    const ok = await useCodeStore.getState().respondApproval('c-1', 'apr-1', 'denied', {
      feedback: 'ajuste',
    });

    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      'Esta aprovação já não está disponível',
      expect.anything(),
    );
    expect(mocks.getCodeSessionState).toHaveBeenCalledWith('c-1');
  });
});

describe('codeStore — ações do objetivo', () => {
  const goal = (overrides: Partial<GoalView> = {}): GoalView => ({
    title: 'Objetivo',
    objective: 'Concluir a refatoração.',
    status: 'active',
    autoContinue: true,
    rounds: 1,
    maxRounds: 25,
    revision: 2,
    origin: 'user',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

  it('createGoal aplica o snapshot autoritativo com o objetivo', async () => {
    seed();
    mocks.createGoal.mockResolvedValue(sessionState({ goal: goal() }));

    const ok = await useCodeStore.getState().createGoal('c-1', {
      objective: 'Concluir a refatoração.',
    });

    expect(ok).toBe(true);
    expect(mocks.createGoal).toHaveBeenCalledWith('c-1', { objective: 'Concluir a refatoração.' });
    expect(useCodeStore.getState().byConversation['c-1'].goal?.title).toBe('Objetivo');
  });

  it('updateGoal("pause") é otimista e confirma com snapshot', async () => {
    seed();
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), goal: goal() } },
    });
    let resolveSnapshot: (value: CodeSessionState) => void = () => undefined;
    mocks.updateGoal.mockReturnValue(
      new Promise<CodeSessionState>((resolve) => {
        resolveSnapshot = resolve;
      }),
    );

    const pending = useCodeStore.getState().updateGoal('c-1', 'pause');
    expect(useCodeStore.getState().byConversation['c-1'].goal?.status).toBe('paused');

    resolveSnapshot(sessionState({ goal: goal({ status: 'paused', autoContinue: false }) }));
    await expect(pending).resolves.toBe(true);
    expect(mocks.updateGoal).toHaveBeenCalledWith('c-1', 'pause', null, 2);
    expect(useCodeStore.getState().byConversation['c-1'].goal?.autoContinue).toBe(false);
  });

  it('updateGoal faz rollback e refresh no CAS desatualizado', async () => {
    seed();
    useCodeStore.setState({
      byConversation: { 'c-1': { ...emptyCodeSession('c-1'), goal: goal() } },
    });
    mocks.updateGoal.mockRejectedValue(new Error('GOAL_STALE_REVISION: revisão 1 ≠ 2'));
    mocks.getCodeSessionState.mockResolvedValue(sessionState({ goal: goal({ revision: 3 }) }));

    await expect(useCodeStore.getState().updateGoal('c-1', 'pause')).resolves.toBe(false);

    expect(toast.error).toHaveBeenCalledWith('O objetivo mudou em outra ação', expect.anything());
    expect(mocks.getCodeSessionState).toHaveBeenCalledWith('c-1');
  });

  it('loadGoalRounds carrega o histórico e trata erro', async () => {
    seed();
    mocks.listGoalRounds.mockResolvedValue([
      { index: 1, turnId: 't1', startedAt: 1, outcome: 'done' },
    ]);
    await useCodeStore.getState().loadGoalRounds('c-1');
    expect(useCodeStore.getState().byConversation['c-1'].goalRounds).toHaveLength(1);

    mocks.listGoalRounds.mockRejectedValue(new Error('falhou'));
    await useCodeStore.getState().loadGoalRounds('c-1');
    expect(useCodeStore.getState().byConversation['c-1'].goalRoundsError).toBe('Error: falhou');
  });

  it('dismissGoalAttention e setGoalStarting são estado de UI local', () => {
    seed();
    useCodeStore.getState().dismissGoalAttention('c-1', 7);
    useCodeStore.getState().setGoalStarting('c-1', true);
    const session = useCodeStore.getState().byConversation['c-1'];
    expect(session.dismissedGoalRevision).toBe(7);
    expect(session.goalStarting).toBe(true);
  });
});
