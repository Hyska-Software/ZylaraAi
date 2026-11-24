import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDocsModels,
  assertLiveModels,
  decodeEntities,
  LIVE_MODEL_SOURCES,
  parseDocsModels,
  parseLiveModels,
  protocolForEndpoint,
  protocolForLiveApi,
} from '../catalog-sources.mjs';

const TABLE = `
<table>
  <tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr>
  <tr>
    <td>Gemini 4 Argon</td>
    <td><code>gemini-4-argon</code></td>
    <td><code>https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon</code></td>
    <td>@ai-sdk/google</td>
  </tr>
  <tr>
    <td>Hy4</td>
    <td><code>hy4</code></td>
    <td><code>https://opencode.ai/inference/go/openai/v1/chat/completions</code></td>
    <td>@ai-sdk/openai-compatible</td>
  </tr>
  <tr>
    <td>Crouton Alpha Free</td>
    <td><code>crouton-alpha-free</code></td>
    <td><code>https://opencode.ai/inference/go/openai/v1/responses</code></td>
    <td>@ai-sdk/openai</td>
  </tr>
  <tr>
    <td>Claude Haiku 5.5</td>
    <td><code>claude-haiku-5-5</code></td>
    <td><code>https://opencode.ai/inference/go/anthropic/v1/messages</code></td>
    <td>@ai-sdk/anthropic</td>
  </tr>
  <tr>
    <td>Duplicate</td>
    <td><code>hy4</code></td>
    <td><code>https://opencode.ai/inference/go/openai/v1/responses</code></td>
    <td>@ai-sdk/openai</td>
  </tr>
  <tr>
    <td>Broken</td>
    <td><code>Not A Model Id</code></td>
    <td><code>https://opencode.ai/inference/go/openai/v1/chat/completions</code></td>
    <td>@ai-sdk/openai-compatible</td>
  </tr>
  <tr>
    <td>No endpoint</td>
    <td><code>no-endpoint</code></td>
    <td>—</td>
    <td>@ai-sdk/openai-compatible</td>
  </tr>
</table>`;

test('parses the docs table and maps each endpoint to its wire protocol', () => {
  const models = parseDocsModels(TABLE);
  assert.deepEqual(
    models.map((model) => [model.id, model.protocol]),
    [
      ['gemini-4-argon', 'google'],
      ['hy4', 'openai-chat'],
      ['crouton-alpha-free', 'openai-responses'],
      ['claude-haiku-5-5', 'anthropic'],
    ],
  );
  assert.equal(models[0].name, 'Gemini 4 Argon');
});

test('maps every gateway endpoint and rejects unknown ones', () => {
  assert.equal(protocolForEndpoint('/openai/v1/chat/completions'), 'openai-chat');
  assert.equal(protocolForEndpoint('/openai/v1/responses'), 'openai-responses');
  assert.equal(protocolForEndpoint('/anthropic/v1/messages'), 'anthropic');
  assert.equal(protocolForEndpoint('/google/v1beta/models/{model}'), 'google');
  assert.equal(protocolForEndpoint('/v1/models'), null);
  assert.equal(protocolForEndpoint(''), null);
});

test('decodes numeric and named entities from the docs markup', () => {
  assert.equal(decodeEntities('A &amp; B &#39;x&#x27; &nbsp; &#x1F600;'), "A & B 'x'   😀");
  assert.equal(decodeEntities('&unknown; &#x110000;'), '&unknown; &#x110000;');
});

test('rejects an empty or truncated docs page', () => {
  assert.throws(() => assertDocsModels([], 'Go'), /tabela de modelos inesperada/);
  assert.throws(() => assertDocsModels([{ id: 'one' }], 'Go'), /1 linhas/);
  const ten = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}` }));
  assert.equal(assertDocsModels(ten, 'Go'), ten);
});

const PRICING_TABLE = `
<table>
  <tr><th>Model</th><th>Model ID</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th></tr>
  <tr><td>HungerG Free</td><td>hungerg-free</td><td>Free</td><td>Free</td><td>-</td><td>-</td></tr>
  <tr><td>LongCat 2.5</td><td><code>longcat-2.5</code></td><td>$0.10</td><td>$0.20</td><td>-</td><td>-</td></tr>
</table>
<table>
  <tr><th>Plan</th><th>Price</th></tr>
  <tr><td>Go</td><td>$10/month</td></tr>
</table>
<table>
  <tr><th>Model</th><th>Data retention</th></tr>
  <tr><td>HungerG Free</td><td>30 days</td></tr>
</table>`;

test('parses pricing-style docs tables without an endpoint column', () => {
  assert.deepEqual(
    parseDocsModels(PRICING_TABLE).map((model) => [model.id, model.name, model.protocol ?? null]),
    [
      ['hungerg-free', 'HungerG Free', null],
      ['longcat-2.5', 'LongCat 2.5', null],
    ],
  );
  // The original endpoint table keeps working, including protocol mapping.
  assert.equal(parseDocsModels(TABLE).length, 4);
  assert.equal(parseDocsModels(PRICING_TABLE)[0].endpoint, null);
});

test('accepts a small but valid docs table instead of treating it as an error page', () => {
  const rows = parseDocsModels(PRICING_TABLE);
  assert.equal(assertDocsModels(rows, 'Go').length, 2);
});

const LIVE_MODELS = {
  object: 'list',
  data: [
    {
      id: 'hungerg-free',
      type: 'chat',
      name: 'HungerG Free',
      api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } },
      modalities: { input: ['text', 'image/jpeg'], output: ['text'] },
      capabilities: { reasoning: { supported: true } },
      limit: { context: 1000000, output: 65536 },
      cost: { text: { input: { price: 0 }, output: { price: 0 } } },
      release_date: '2026-11-24',
    },
    {
      id: 'gemini-4-argon',
      type: 'chat',
      name: 'Gemini 4 Argon',
      api: { 'generate-content': {}, interactions: {} },
      modalities: { input: ['text'], output: ['text'] },
    },
    {
      id: 'text-embedding-3-small',
      type: 'embedding',
      api: { embeddings: {} },
      modalities: { output: ['embedding'] },
    },
    { id: 'jev-1.14', type: 'decision', api: { systemone: {} }, modalities: { output: ['decision'] } },
    { id: 'Not A Model Id', type: 'chat', api: { 'chat-completions': {} } },
  ],
};

test('parses live model lists and keeps only chat models on supported protocols', () => {
  assert.deepEqual(
    parseLiveModels(LIVE_MODELS).map((model) => [model.id, model.protocols]),
    [
      ['hungerg-free', ['openai-chat']],
      ['gemini-4-argon', ['google']],
    ],
  );
  assert.equal(parseLiveModels(LIVE_MODELS)[0].raw.name, 'HungerG Free');
  assert.equal(protocolForLiveApi('responses'), 'openai-responses');
  assert.equal(protocolForLiveApi('messages'), 'anthropic');
  assert.equal(protocolForLiveApi('systemone'), null);
  assert.equal(protocolForLiveApi('interactions'), null);
});

test('rejects empty or truncated live model lists', () => {
  assert.throws(() => assertLiveModels([], 'Go'), /lista de modelos inesperada/);
  assert.throws(() => assertLiveModels([{ id: 'one' }], 'Go'), /1 linhas/);
  const ten = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}` }));
  assert.equal(assertLiveModels(ten, 'Go'), ten);
});

test('exposes credential-free live model endpoints for both gateways', () => {
  assert.deepEqual(
    LIVE_MODEL_SOURCES.map((source) => [source.provider, source.url]),
    [
      ['go', 'https://opencode.ai/inference/go/v1/models'],
      ['zen', 'https://opencode.ai/inference/v1/models'],
    ],
  );
});
