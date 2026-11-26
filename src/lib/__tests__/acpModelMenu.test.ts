import { describe, expect, it } from 'vitest';

import {
  modelKey,
  parseModelKey,
  selectorProviders,
  selectionKey,
} from '@/lib/modelMenu';
import type { ModelInfo, ProviderInfo, ProviderAuthStatus, ProviderKeyStatus } from '@/lib/types';

const MODEL: ModelInfo = {
  id: 'default',
  name: 'Agent default',
  family: 'default',
  protocols: ['acp'],
  reasoning: false,
  reasoningOptions: [],
  attachment: false,
  modalities: { input: ['text'], output: ['text'] },
  contextWindow: 128_000,
  maxOutput: 8_192,
  openWeights: false,
  tags: [],
  status: 'stable',
};

function provider(
  id: string,
  acp: ProviderInfo['acp'],
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id,
    name: id,
    shortName: id,
    description: '',
    baseUrl: '',
    consoleUrl: '',
    endpoints: {},
    authEnv: '',
    defaultModelId: MODEL.id,
    models: [MODEL],
    notes: [],
    transport: acp ? 'acp' : 'http',
    auth: acp ? 'acp' : 'api-key',
    origin: acp ? 'acp' : null,
    acp,
    ...overrides,
  };
}

const IDs = (providers: ProviderInfo[]) => providers.map((entry) => entry.id);

describe('selectorProviders — ACP', () => {
  const http = provider('acme', undefined);

  it('offers an installed ACP agent without an API key or account token', () => {
    const agent = provider('acp__cursor', {
      agentId: 'acp__cursor',
      registryId: 'cursor',
      version: '1.0.0',
      kind: 'binary',
      authState: 'auth_required',
      trusted: true,
      installed: true,
      enabled: true,
    });
    expect(IDs(selectorProviders([http, agent], [], []))).toEqual(['acp__cursor']);
  });

  it('hides disabled and removed agents, but keeps an active one even if auth failed', () => {
    const broken = provider(
      'acp__broken',
      {
        agentId: 'acp__broken',
        registryId: 'broken',
        version: '1',
        kind: 'binary',
        authState: 'error',
        trusted: false,
        installed: true,
        enabled: false,
      },
    );
    const removed = provider(
      'acp__removed',
      {
        agentId: 'acp__removed',
        registryId: 'removed',
        version: '1',
        kind: 'npx',
        authState: 'ready',
        trusted: true,
        installed: false,
        enabled: true,
      },
    );
    expect(IDs(selectorProviders([broken, removed], [], []))).toEqual([]);
    // The active agent stays reachable so the user can retry its sign-in.
    expect(
      IDs(
        selectorProviders(
          [{ ...broken, acp: { ...broken.acp!, enabled: true, authState: 'error' } }],
          [],
          [],
        ),
      ),
    ).toEqual(['acp__broken']);
  });

  it('keeps the shared key/selection semantics for ACP model ids', () => {
    const key = modelKey('acp__cursor', 'gpt-5');
    expect(key).toBe('acp__cursor:gpt-5');
    expect(parseModelKey(key)).toEqual({ providerId: 'acp__cursor', modelId: 'gpt-5' });
    expect(
      selectionKey({ providerId: 'acp__cursor', modelId: 'gpt-5', reasoning: null }),
    ).toBe(key);
    const httpKeys: ProviderKeyStatus[] = [{ providerId: 'acme', hasKey: true, source: 'settings' }];
    const httpAuth: ProviderAuthStatus[] = [];
    expect(IDs(selectorProviders([http], httpKeys, httpAuth))).toEqual(['acme']);
  });
});
