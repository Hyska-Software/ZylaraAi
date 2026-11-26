import { describe, expect, it } from 'vitest';

import {
  catalogCost,
  sessionCostFromMessages,
  usageBuckets,
  type CostLookup,
} from '../sessionCost';
import type {
  ChatMessage,
  CostInfo,
  ToolCallRecord,
  ToolPresentation,
  UsageInfo,
} from '../types';

const PARENT_MODEL: CostInfo = { input: 1, output: 10, cache_read: 0.1, cache_write: 1.25 };
const CHILD_MODEL: CostInfo = { input: 2, output: 20 };

function assistant(usage: UsageInfo, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: '',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    providerId: 'p-parent',
    modelId: 'm-parent',
    usage,
    createdAt: 0,
    ...overrides,
  };
}

function subagentCall(usage: UsageInfo, providerId = 'p-child', modelId = 'm-child'): ToolCallRecord {
  const presentation: ToolPresentation = {
    kind: 'subagent',
    description: 'Scout',
    subagentType: 'explore',
    providerId,
    modelId,
    usage,
  };
  return {
    id: 'call-1',
    name: 'task',
    arguments: '{}',
    status: 'done',
    presentation,
  };
}

const lookupBoth: CostLookup = (providerId, modelId) => {
  if (providerId === 'p-parent' || modelId === 'm-parent') return PARENT_MODEL;
  if (providerId === 'p-child' || modelId === 'm-child') return CHILD_MODEL;
  return null;
};

describe('usageBuckets', () => {
  it('normalizes inclusive input and cache counters (OpenAI/gateway)', () => {
    expect(
      usageBuckets({
        inputTokens: 12_000,
        outputTokens: 300,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 7_000,
        uncachedInputTokens: 1_000,
        cacheReported: true,
      }),
    ).toEqual({ input: 1_000, cacheRead: 4_000, cacheWrite: 7_000, output: 300 });
  });

  it('keeps the Anthropic tail as the uncached prompt', () => {
    expect(
      usageBuckets({
        inputTokens: 50,
        outputTokens: 120,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 2_000,
        uncachedInputTokens: 50,
        cacheReported: true,
      }),
    ).toEqual({ input: 50, cacheRead: 1_000, cacheWrite: 2_000, output: 120 });
  });

  it('treats a legacy payload without cache counters as fully uncached', () => {
    expect(usageBuckets({ inputTokens: 900, outputTokens: 100 })).toEqual({
      input: 900,
      cacheRead: 0,
      cacheWrite: 0,
      output: 100,
    });
  });

  it('derives the uncached prompt from cached_tokens on legacy payloads', () => {
    expect(usageBuckets({ inputTokens: 1_000, cachedTokens: 400, outputTokens: 10 })).toEqual({
      input: 600,
      cacheRead: 400,
      cacheWrite: 0,
      output: 10,
    });
  });

  it('returns zeros for missing usage', () => {
    expect(usageBuckets(null)).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });
});

describe('sessionCostFromMessages', () => {
  it('prices input, cache read, cache write and output per million tokens', () => {
    const cost = sessionCostFromMessages(
      [
        assistant({
          inputTokens: 1_000_000,
          uncachedInputTokens: 500_000,
          cacheReadTokens: 400_000,
          cacheWriteTokens: 100_000,
          outputTokens: 200_000,
          cacheReported: true,
        }),
      ],
      () => PARENT_MODEL,
    );

    expect(cost).not.toBeNull();
    expect(cost!.input.tokens).toBe(500_000);
    expect(cost!.input.usd).toBeCloseTo(0.5, 10);
    expect(cost!.cacheRead.usd).toBeCloseTo(0.04, 10);
    expect(cost!.cacheWrite.usd).toBeCloseTo(0.125, 10);
    expect(cost!.output.usd).toBeCloseTo(2, 10);
    expect(cost!.totalUsd).toBeCloseTo(2.665, 10);
    expect(cost!.totalTokens).toBe(1_200_000);
    expect(cost!.subagents).toBe(0);
    expect(cost!.priced).toBe(true);
    expect(cost!.unpriced).toBe(false);
  });

  it('splits subagent usage into the child model without double counting', () => {
    const childUsage: UsageInfo = { inputTokens: 300_000, outputTokens: 50_000 };
    const parentUsage: UsageInfo = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const cost = sessionCostFromMessages(
      [assistant(parentUsage, { toolCalls: [subagentCall(childUsage)] })],
      lookupBoth,
    );

    expect(cost).not.toBeNull();
    // The aggregate has each token once: parent own (1M - 300K, 100K - 50K)
    // plus the child, never the parent total plus the child again.
    expect(cost!.input.tokens).toBe(1_000_000);
    expect(cost!.output.tokens).toBe(100_000);
    // Parent own tokens priced with the parent model, child with its own.
    expect(cost!.totalUsd).toBeCloseTo(0.7 + 0.5 + 0.6 + 1, 10);
    expect(cost!.totalTokens).toBe(1_100_000);
    expect(cost!.subagents).toBe(1);
  });

  it('falls back to the input price when the catalog omits cache prices', () => {
    const cost = sessionCostFromMessages(
      [
        assistant({
          inputTokens: 2_000_000,
          uncachedInputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheReported: true,
        }),
      ],
      () => ({ input: 2, output: 8 }),
    );

    expect(cost).not.toBeNull();
    expect(cost!.cacheRead.usd).toBeCloseTo(2, 10);
    expect(cost!.cacheWrite.usd).toBeCloseTo(2, 10);
    expect(cost!.input.tokens).toBe(0);
    expect(cost!.totalUsd).toBeCloseTo(4, 10);
    expect(cost!.priced).toBe(true);
  });

  it('marks tokens without a catalog price as unpriced', () => {
    const cost = sessionCostFromMessages(
      [assistant({ inputTokens: 100, outputTokens: 50 })],
      () => null,
    );

    expect(cost).not.toBeNull();
    expect(cost!.priced).toBe(false);
    expect(cost!.unpriced).toBe(true);
    expect(cost!.totalUsd).toBe(0);
    expect(cost!.totalTokens).toBe(150);
  });

  it('prices free models as known zeros', () => {
    const cost = sessionCostFromMessages(
      [assistant({ inputTokens: 100, outputTokens: 50 })],
      () => ({ input: 0, output: 0 }),
    );

    expect(cost).not.toBeNull();
    expect(cost!.priced).toBe(true);
    expect(cost!.unpriced).toBe(false);
    expect(cost!.totalUsd).toBe(0);
  });

  it('accumulates every turn and ignores user messages without usage', () => {
    const cost = sessionCostFromMessages(
      [
        assistant({ inputTokens: 1_000_000, outputTokens: 0 }),
        {
          ...assistant({ inputTokens: 1_000_000, outputTokens: 0 }),
          id: 'u1',
          role: 'user',
          usage: null,
        },
        {
          ...assistant({ inputTokens: 1_000_000, outputTokens: 0 }),
          id: 'm2',
          toolCalls: [],
        },
      ],
      () => PARENT_MODEL,
    );

    expect(cost).not.toBeNull();
    expect(cost!.input.tokens).toBe(2_000_000);
    expect(cost!.totalUsd).toBeCloseTo(2, 10);
  });

  it('returns null when nothing was billed', () => {
    expect(sessionCostFromMessages([], () => PARENT_MODEL)).toBeNull();
    expect(
      sessionCostFromMessages(
        [assistant({ inputTokens: 0, outputTokens: 0 })],
        () => PARENT_MODEL,
      ),
    ).toBeNull();
    expect(sessionCostFromMessages([assistant({}, { usage: null })], () => PARENT_MODEL)).toBeNull();
  });
});

describe('catalogCost', () => {
  it('reads the bundled catalog when the live list has no match', () => {
    const cost = catalogCost([], 'opencode-go', 'deepseek-v4.1-flash');
    expect(cost?.input).toBe(0.12);
    expect(cost?.output).toBe(0.48);
    expect(cost?.cache_read).toBe(0.0024);
  });

  it('prefers the live merged catalog', () => {
    const cost = catalogCost(
      [
        {
          id: 'p',
          name: 'P',
          shortName: 'P',
          description: '',
          baseUrl: '',
          consoleUrl: '',
          endpoints: {},
          authEnv: '',
          notes: [],
          defaultModelId: 'm',
          models: [
            {
              id: 'm',
              name: 'M',
              family: '',
              protocols: [],
              reasoning: false,
              reasoningOptions: [],
              attachment: false,
              modalities: { input: [], output: [] },
              contextWindow: 1,
              maxOutput: 1,
              openWeights: false,
              tags: [],
              status: 'stable',
              cost: { input: 9, output: 9 },
            },
          ],
        },
      ],
      'p',
      'm',
    );
    expect(cost).toEqual({ input: 9, output: 9 });
  });

  it('returns null without a provider/model pair', () => {
    expect(catalogCost([], null, 'm')).toBeNull();
    expect(catalogCost([], 'p', undefined)).toBeNull();
  });
});
