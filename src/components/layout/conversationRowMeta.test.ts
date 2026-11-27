import { describe, expect, it } from 'vitest';
import { t } from '@/lib/i18n';
import type { ChatMessage, Conversation, MessageStatus, ToolCallRecord } from '@/lib/types';
import {
  conversationRowActivity,
  conversationRowModel,
  conversationRowStatus,
  conversationRowTime,
} from './conversationRowMeta';
import type { ConversationRowTone } from './conversationRowMeta';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    title: 'Row title',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    providerId: 'opencode-go',
    modelId: 'glm-5.3-flash',
    messageCount: 1,
    ...overrides,
  };
}

describe('conversationRowStatus', () => {
  it('maps persisted terminal statuses to their sidebar labels and tones', () => {
    const cases: Array<[MessageStatus, string, ConversationRowTone]> = [
      ['complete', 'rowStatusFinished', 'success'],
      ['error', 'rowStatusFailed', 'danger'],
      ['cancelled', 'rowStatusCancelled', 'muted'],
      ['incomplete', 'rowStatusIncomplete', 'warning'],
      ['streaming', 'rowStatusRunning', 'accent'],
    ];
    for (const [status, key, tone] of cases) {
      const row = conversationRowStatus(conversation({ lastStatus: status }));
      expect(row.label).toBe(t(`common:shell.sidebar.${key}`));
      expect(row.tone).toBe(tone);
      expect(row.spinner).toBe(false);
    }
  });

  it('shows New for an empty conversation without a persisted status', () => {
    expect(conversationRowStatus(conversation({ messageCount: 0 }))).toEqual({
      label: t('common:shell.sidebar.rowStatusNew'),
      tone: 'muted',
      spinner: false,
    });
  });

  it('falls back to Finished for a non-empty conversation on older backends', () => {
    expect(conversationRowStatus(conversation({ messageCount: 2 }))).toEqual({
      label: t('common:shell.sidebar.rowStatusFinished'),
      tone: 'success',
      spinner: false,
    });
  });

  it('lets an active turn override the persisted status', () => {
    const row = conversationRowStatus(conversation({ lastStatus: 'error' }), {
      assistantId: 'a-1',
      phase: 'tool',
    });
    expect(row.label).toBe(t('common:shell.sidebar.rowStatusRunning'));
    expect(row.tone).toBe('accent');
    expect(row.spinner).toBe(true);
  });
});

describe('conversationRowActivity', () => {
  const tool: ToolCallRecord = {
    id: 'tool-1',
    name: 'read_file',
    arguments: JSON.stringify({ path: 'docs/AGENTS.md' }),
    status: 'running',
  };
  const message: ChatMessage = {
    id: 'a-1',
    conversationId: 'c-1',
    role: 'assistant',
    content: '',
    status: 'streaming',
    toolCalls: [tool],
    citations: [],
    attachments: [],
    createdAt: 1,
  };

  it('shows the running tool label for an active turn', () => {
    const text = conversationRowActivity(
      conversation({ preview: 'analisa o projeto' }),
      { assistantId: 'a-1', phase: 'tool' },
      [message],
    );
    expect(text).toContain('docs/AGENTS.md');
    expect(text).not.toContain('analisa o projeto');
  });

  it('falls back to the preview when idle', () => {
    expect(conversationRowActivity(conversation({ preview: 'Visão geral' }), null, undefined)).toBe(
      'Visão geral',
    );
  });

  it('uses an explicit empty hint for empty conversations', () => {
    expect(conversationRowActivity(conversation(), null, undefined)).toBe(
      t('common:shell.sidebar.rowNoActivity'),
    );
  });
});

describe('conversationRowTime', () => {
  it('shows a short "now" label for fresh rows', () => {
    expect(conversationRowTime(Date.now() - 1_000)).toBe(t('common:shell.sidebar.rowTimeNow'));
  });

  it('shows clock time for other conversations from today', () => {
    const today = new Date();
    today.setHours(0, 1, 0, 0);
    expect(conversationRowTime(today.getTime())).toMatch(/^\d{2}:\d{2}$/);
  });

  it('uses relative time for older rows', () => {
    expect(conversationRowTime(Date.now() - 3 * 24 * 60 * 60_000)).toMatch(/\d/);
  });
});

describe('conversationRowModel', () => {
  it('resolves the session model through the catalog', () => {
    expect(
      conversationRowModel(conversation({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' })),
    ).toEqual({ family: 'claude', name: 'Claude Haiku 4.5' });
  });

  it('prefers the last assistant model when messages are loaded', () => {
    const assistant: ChatMessage = {
      id: 'a-1',
      conversationId: 'c-1',
      role: 'assistant',
      content: '',
      status: 'complete',
      toolCalls: [],
      citations: [],
      attachments: [],
      modelId: 'gpt-6-luna',
      providerId: 'openai',
      createdAt: 2,
    };
    const model = conversationRowModel(
      conversation({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' }),
      [assistant],
    );
    expect(model.family).toBe('gpt');
    expect(model.name).toContain('GPT');
  });

  it('keeps an unknown model usable for the initials fallback', () => {
    expect(conversationRowModel(conversation({ providerId: 'custom', modelId: 'my-model' }))).toEqual({
      family: 'custom',
      name: 'my-model',
    });
  });
});
