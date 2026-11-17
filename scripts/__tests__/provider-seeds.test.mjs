import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODEL_CAP,
  endpointsFor,
  EXTRA_PROVIDERS,
  PROVIDER_CATEGORIES,
  validateProviderSeeds,
} from '../provider-seeds.mjs';

const REQUIRED_IDS = [
  'deepseek',
  'groq',
  'openrouter',
  'xai',
  'mistral',
  'moonshot',
  'zai',
  'minimax',
  'together',
  'fireworks',
  'cerebras',
  'nvidia',
  'deepinfra',
  'siliconflow',
  'sambanova',
  'scaleway',
  'vercel-ai-gateway',
  'novita',
  'inception',
  'venice',
  'stepfun',
];

test('the shipped seed table is structurally valid', () => {
  assert.deepEqual(validateProviderSeeds(), []);
});

test('ships every API-key provider the "See more" dialog expects', () => {
  const ids = new Set(EXTRA_PROVIDERS.map((seed) => seed.id));
  assert.deepEqual([...ids].sort(), [...REQUIRED_IDS].sort());
  for (const seed of EXTRA_PROVIDERS) {
    assert.ok(seed.name, seed.id);
    assert.ok(seed.shortName, seed.id);
    assert.ok(seed.description, seed.id);
    assert.ok(seed.consoleUrl.startsWith('https://'), seed.id);
    assert.ok(seed.docsUrl.startsWith('https://'), seed.id);
    assert.ok(PROVIDER_CATEGORIES.includes(seed.category), seed.id);
  }
});

test('endpoints pair the provider protocol with the model-list probe', () => {
  for (const seed of EXTRA_PROVIDERS) {
    const endpoints = endpointsFor(seed);
    assert.equal(endpoints.models, '/models', seed.id);
    assert.equal(endpoints[seed.protocol], '/chat/completions', seed.id);
    // A provider without its chat path cannot be selected in the UI.
    assert.equal(Object.keys(endpoints).length, 2, seed.id);
  }
});

test('model cap stays small enough for the bundled catalog', () => {
  assert.ok(DEFAULT_MODEL_CAP > 0 && DEFAULT_MODEL_CAP <= 40);
});

test('validation rejects duplicated ids, bad urls, env names and categories', () => {
  const base = {
    id: 'acme',
    name: 'Acme',
    shortName: 'Acme',
    description: 'Acme gateway.',
    baseUrl: 'https://api.acme.dev/v1',
    consoleUrl: 'https://acme.dev/keys',
    docsUrl: 'https://acme.dev/docs',
    protocol: 'openai-chat',
    authEnv: 'ACME_API_KEY',
    mdProviderId: 'acme',
    category: 'host',
  };

  assert.deepEqual(validateProviderSeeds([base]), []);
  assert.match(validateProviderSeeds([{ ...base, id: 'Acme Gateway' }]).join(), /kebab-case/);
  assert.match(validateProviderSeeds([base, { ...base }]).join(), /duplicated/);
  assert.match(validateProviderSeeds([{ ...base, baseUrl: 'http://api.acme.dev/v1' }]).join(), /https/);
  assert.match(validateProviderSeeds([{ ...base, baseUrl: 'https://api.acme.dev/v1/' }]).join(), /end with/);
  assert.match(validateProviderSeeds([{ ...base, authEnv: 'acme-key' }]).join(), /env-var/);
  assert.match(validateProviderSeeds([{ ...base, protocol: 'grpc' }]).join(), /unknown protocol/);
  assert.match(validateProviderSeeds([{ ...base, category: 'other' }]).join(), /unknown category/);
  assert.match(validateProviderSeeds([{ ...base, name: '   ' }]).join(), /missing name/);
});
