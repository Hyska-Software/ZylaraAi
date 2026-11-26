import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalizeRegistry,
  checkSnapshot,
  serializeRegistry,
} from '../build-acp-registry.mjs';

const SNAPSHOT = path.resolve(import.meta.dirname, '..', '..', 'data', 'acp-registry.json');
const ID_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const agent = (overrides = {}) => ({
  id: 'example-acp',
  name: 'Example',
  version: '1.2.3',
  description: 'An example agent',
  distribution: { npx: { package: 'example@1.2.3' } },
  ...overrides,
});

test('committed snapshot is canonical and covers the real registry', () => {
  const raw = fs.readFileSync(SNAPSHOT, 'utf8');
  const snapshot = checkSnapshot(SNAPSHOT);
  assert.equal(raw, serializeRegistry(snapshot));
  assert.equal(snapshot.version, '1.0.0');
  assert.ok(snapshot.agents.length >= 40, `only ${snapshot.agents.length} agents`);
  assert.ok(raw.endsWith('\n'));

  const ids = snapshot.agents.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of snapshot.agents) {
    assert.match(entry.id, ID_RE, entry.id);
    assert.match(entry.version, SEMVER_RE, entry.id);
    assert.ok(entry.name && typeof entry.name === 'string', entry.id);
    assert.ok(entry.distribution && typeof entry.distribution === 'object', entry.id);
    assert.ok(Object.keys(entry.distribution).length > 0, entry.id);
    for (const [target, binary] of Object.entries(entry.distribution.binary ?? {})) {
      assert.ok(target, entry.id);
      assert.ok(binary.archive.startsWith('https://'), `${entry.id}/${target}`);
      assert.ok(binary.cmd, `${entry.id}/${target}`);
      if (binary.sha256 !== undefined) assert.match(binary.sha256, /^[0-9a-f]{64}$/);
    }
    for (const method of ['npx', 'uvx']) {
      const dist = entry.distribution[method];
      if (dist) assert.ok(dist.package, entry.id);
    }
  }
});

test('canonicalization is deterministic and independent of input key order', () => {
  const snapshot = canonicalizeRegistry({
    agents: [
      agent({
        id: 'z-agent',
        distribution: {
          npx: { package: 'z@1.0.0', env: { Z_VAR: '2', A_VAR: '1' }, args: ['--acp'] },
        },
      }),
      agent({ id: 'a-agent', version: '2.0.0-beta.1' }),
    ],
    version: '1.0.0',
  });
  assert.deepEqual(snapshot.agents.map((entry) => entry.id), ['a-agent', 'z-agent']);
  const npx = snapshot.agents[1].distribution.npx;
  assert.deepEqual(Object.keys(npx.env), ['A_VAR', 'Z_VAR']);
  assert.deepEqual(npx.args, ['--acp']);

  const reversed = canonicalizeRegistry({
    version: '1.0.0',
    agents: [
      agent({
        id: 'a-agent',
        version: '2.0.0-beta.1',
      }),
      agent({
        id: 'z-agent',
        distribution: {
          npx: { args: ['--acp'], env: { A_VAR: '1', Z_VAR: '2' }, package: 'z@1.0.0' },
        },
      }),
    ],
  });
  assert.equal(serializeRegistry(snapshot), serializeRegistry(reversed));
});

test('binary targets are sorted and sha256 is normalized to lowercase', () => {
  const result = canonicalizeRegistry({
    version: '1.0.0',
    agents: [
      agent({
        distribution: {
          binary: {
            'windows-x86_64': { cmd: 'agent.exe', archive: 'https://host/a.zip', sha256: 'AB'.repeat(32) },
            'linux-x86_64': { cmd: './agent', archive: 'https://host/a.tar.gz' },
          },
        },
      }),
    ],
  });
  const binary = result.agents[0].distribution.binary;
  assert.deepEqual(Object.keys(binary), ['linux-x86_64', 'windows-x86_64']);
  assert.equal(binary['windows-x86_64'].sha256, 'ab'.repeat(32));
});

test('validation rejects malformed entries without ever writing a file', () => {
  assert.throws(() => canonicalizeRegistry({ version: '1.0.0', agents: {} }), /agents/);
  assert.throws(() => canonicalizeRegistry({ agents: [agent()] }), /version/);
  assert.throws(() => canonicalizeRegistry({ version: '1.0.0', agents: [null] }), /agents\[0\]/);
  assert.throws(() => canonicalizeRegistry({ version: '1.0.0', agents: [agent({ id: 'Bad_ID' })] }), /id is invalid/);
  assert.throws(() => canonicalizeRegistry({ version: '1.0.0', agents: [agent({ version: '1.2' })] }), /not semver/);
  assert.throws(() => canonicalizeRegistry({ version: '1.0.0', agents: [agent({ distribution: {} })] }), /no distribution/);
  assert.throws(
    () => canonicalizeRegistry({ version: '1.0.0', agents: [agent({ distribution: { npx: {} } })] }),
    /package/,
  );
  assert.throws(
    () => canonicalizeRegistry({
      version: '1.0.0',
      agents: [agent({ distribution: { binary: { 'windows-x86_64': { archive: 'https://host/a.zip' } } } })],
    }),
    /cmd/,
  );
  assert.throws(
    () => canonicalizeRegistry({ version: '1.0.0', agents: [agent(), agent()] }),
    /duplicate/,
  );
});

test('checkSnapshot rejects a non-canonical file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-registry-'));
  try {
    const file = path.join(dir, 'acp-registry.json');
    fs.writeFileSync(file, `${JSON.stringify({ version: '1.0.0', agents: [agent()] }, null, 2)}`);
    assert.throws(() => checkSnapshot(file), /not canonical/);
    fs.writeFileSync(file, serializeRegistry(canonicalizeRegistry({ version: '1.0.0', agents: [agent()] })));
    assert.equal(checkSnapshot(file).agents.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
