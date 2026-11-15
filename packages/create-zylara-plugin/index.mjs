#!/usr/bin/env node
/**
 * create-zylara-plugin <directory> [plugin.id]
 *
 * Copies a real sandboxed plugin template (iframe UI, hidden backend, skill and
 * signed-package workflow), generates a local Ed25519 publisher key and prints
 * the exact build commands. No network access is required.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] ?? 'my-plugin');
const pluginId = process.argv[3] ?? 'com.example.my-plugin';

if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(pluginId)) {
  console.error(`create-zylara-plugin: invalid plugin id "${pluginId}"`);
  process.exit(1);
}
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`create-zylara-plugin: ${target} already exists and is not empty`);
  process.exit(1);
}

mkdirSync(join(target, 'META-INF'), { recursive: true });
cpSync(join(root, 'template'), target, {
  recursive: true,
  filter: (source) => !source.endsWith('.pem') && !source.endsWith('.pub'),
});

const name = pluginId.split(/[.-]/).at(-1) ?? 'plugin';
const replace = (path) => {
  const file = join(target, path);
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replaceAll('__PLUGIN_ID__', pluginId)
      .replaceAll('__PLUGIN_NAME__', name),
  );
};
replace('manifest.json');
replace('README.md');
replace('ui/page.html');
replace('ui/toolbar.html');
replace('backend/index.html');
replace('locales/en.json');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(
  join(target, 'META-INF', 'publisher.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
);
writeFileSync(
  join(target, 'META-INF', 'publisher.pub'),
  publicKey.export({ type: 'spki', format: 'pem' }),
);

// Fail early if the generated private key cannot be read back.
createPublicKey(createPrivateKey(readFileSync(join(target, 'META-INF', 'publisher.pem'))));

console.log(`Created ${pluginId} in ${target}`);
console.log('Next:');
console.log(`  node ../../scripts/plugin/cli.mjs dev ${target}`);
console.log(
  `  node ../../scripts/plugin/cli.mjs build ${target} ${name}.zplugin --key ${target}/META-INF/publisher.pem --key-id dev-2026 --publisher example`,
);
