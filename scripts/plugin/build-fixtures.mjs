#!/usr/bin/env node
/**
 * Rebuilds the committed plugin fixtures from their unpacked folders. The
 * signing keys are test-only fixtures; never reuse them for a real publisher.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = join(root, 'plugins', 'fixtures');
const cli = join(root, 'scripts', 'plugin', 'cli.mjs');

const packages = [
  {
    folder: join(fixtures, 'sandbox-demo'),
    file: join(fixtures, 'sandbox-demo-1.2.0.zplugin'),
    key: join(fixtures, 'sandbox-demo', 'META-INF', 'publisher.pem'),
    publisher: 'acme',
  },
  {
    folder: join(fixtures, 'trusted-demo'),
    file: join(fixtures, 'trusted-demo-1.0.0.zplugin'),
    key: join(fixtures, 'trusted-demo', 'META-INF', 'publisher.pem'),
    publisher: 'acme',
  },
  {
    folder: join(fixtures, 'provider-demo'),
    file: join(fixtures, 'provider-demo-1.0.0.zplugin'),
    key: join(fixtures, 'provider-demo', 'META-INF', 'publisher.pem'),
    publisher: 'acme',
  },
  {
    folder: join(fixtures, 'modes-demo'),
    file: join(fixtures, 'modes-demo-1.0.0.zplugin'),
    key: join(fixtures, 'sandbox-demo', 'META-INF', 'publisher.pem'),
    publisher: 'acme',
  },
];

for (const entry of packages) {
  execFileSync(
    process.execPath,
    [cli, 'pack', entry.folder, entry.file, '--key', entry.key, '--key-id', 'acme-fixture-2026', '--publisher', entry.publisher],
    { stdio: 'inherit' },
  );
  execFileSync(process.execPath, [cli, 'verify', entry.file], { stdio: 'inherit' });
}

const registryKey = join(fixtures, 'registry-fixture.pem');
if (!existsSync(registryKey)) {
  console.error('registry-fixture.pem is missing; regenerate the fixture key explicitly.');
  process.exit(1);
}
execFileSync(
  process.execPath,
  [
    cli,
    'registry',
    fixtures,
    '--base-url',
    '',
    '--key',
    registryKey,
    '--key-id',
    'registry-fixture-2026',
    '--name',
    'Zylara fixtures',
    '--out',
    join(fixtures, 'registry.json'),
  ],
  { stdio: 'inherit' },
);
