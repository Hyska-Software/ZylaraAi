// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyCodeSession, useCodeStore } from '@/lib/store';
import { useCacheStore } from '@/lib/store/cacheStore';
import type { ContextStats } from '@/lib/types';
import { ChatContextMeterChip } from './ChatContextMeterChip';

const CONVERSATION_ID = 'conv-chat';

function makeStats(overrides: Partial<ContextStats> = {}): ContextStats {
  return {
    used: 2_000,
    window: 100_000,
    outputCap: 32_000,
    percent: 2,
    messages: 3,
    breakdown: { systemPrompt: 1_000, toolDefinitions: 0, messages: 1_000 },
    ...overrides,
  };
}

function seed(stats: ContextStats | null): void {
  useCodeStore.setState({
    byConversation: {
      [CONVERSATION_ID]: { ...emptyCodeSession(CONVERSATION_ID), context: stats },
    },
  });
}

function trigger(percent = 2): HTMLElement {
  return screen.getByRole('button', { name: `Contexto usado: ${percent}%` });
}

beforeEach(() => {
  useCodeStore.setState({ byConversation: {} });
  useCacheStore.getState().reset();
});

afterEach(cleanup);

describe('ChatContextMeterChip', () => {
  it('não renderiza nada antes de existir estatística de contexto', () => {
    const { container } = render(<ChatContextMeterChip conversationId={CONVERSATION_ID} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('mostra o anel circular com o percentual e abre os detalhes ao clicar', async () => {
    const { container } = render(<ChatContextMeterChip conversationId={CONVERSATION_ID} />);
    expect(container.firstChild).toBeNull();

    act(() => seed(makeStats()));

    const button = trigger();
    expect(button.textContent).toContain('2%');
    // Trilho + arco do anel; o arco é decorativo e o botão é o gatilho acessível.
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.className).toContain('h-8');

    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Detalhes do contexto' });
    expect(within(dialog).getByText('2% do contexto usado')).toBeTruthy();
    expect(within(dialog).getByRole('progressbar', { name: 'Contexto usado' })).toBeTruthy();
    expect(within(dialog).queryByText(/Cache de prompt/)).toBeNull();
  });

  it('atualiza o indicador quando chega um novo context_stats', () => {
    render(<ChatContextMeterChip conversationId={CONVERSATION_ID} />);
    act(() => seed(makeStats()));
    expect(trigger()).toBeTruthy();

    act(() => seed(makeStats({ used: 78_000, percent: 78 })));

    expect(trigger(78).textContent).toContain('78%');
    expect(screen.queryByRole('button', { name: 'Contexto usado: 2%' })).toBeNull();
  });

  it('não depende do indicador de cache nem das amostras de cache', () => {
    useCacheStore.setState({
      byConversation: {
        [CONVERSATION_ID]: {
          current: null,
          session: null,
          epoch: 0,
          samples: [],
          lastBreak: null,
          restored: true,
        },
      },
    });
    render(<ChatContextMeterChip conversationId={CONVERSATION_ID} />);

    act(() => seed(makeStats({ percent: 44 })));

    expect(trigger(44)).toBeTruthy();
  });

  it('ignora estatísticas de outra conversa', () => {
    useCodeStore.setState({
      byConversation: {
        other: { ...emptyCodeSession('other'), context: makeStats() },
      },
    });
    const { container } = render(<ChatContextMeterChip conversationId={CONVERSATION_ID} />);

    expect(container.firstChild).toBeNull();
  });
});
