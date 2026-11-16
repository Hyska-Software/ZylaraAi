#!/usr/bin/env node
/**
 * zylara-plugin — fixture/reference CLI for the Zylara plugin format.
 *
 * Commands:
 *   init <dir> [id]                 scaffold a sandboxed plugin and a test key
 *   pack <dir> [out] [--key key.pem] [--key-id id] [--publisher id]
 *   verify <file.zplugin>
 *   registry <dir> --base-url <url> --key key.pem [--key-id id] [--out file]
 *   dev <dir>                       validate an unpacked folder (load it from
 *                                   Zylara → Plugins → Load unpacked)
 *
 * The format is intentionally simple: a ZIP with `manifest.json` and an
 * optional detached `META-INF/signature.json`. The signature covers a canonical
 * digest of file contents, not raw ZIP bytes, so any ZIP writer can produce
 * identical signatures. This is the reference implementation used by fixtures.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const SIGNATURE_PATH = 'META-INF/signature.json';
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function fail(message) {
  console.error(`zylara-plugin: ${message}`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafePath(path) {
  if (!path || path.length > 240 || path.includes('\\') || path.includes('\0') || path.includes(':')) {
    fail(`unsafe path: ${path}`);
  }
  if (path.startsWith('/') || path.startsWith('./')) fail(`path must be relative: ${path}`);
  for (const component of path.split('/')) {
    if (!component || component === '.' || component === '..') fail(`unsafe path: ${path}`);
    if (component.endsWith('.') || component.endsWith(' ')) fail(`unsafe Windows path: ${path}`);
    if (RESERVED.has(component.split('.')[0].toUpperCase())) fail(`reserved Windows name: ${path}`);
  }
}

function collectFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink not allowed: ${path}`);
    if (entry.isDirectory()) {
      collectFiles(root, path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(root, path).split(sep).join('/');
    assertSafePath(relativePath);
    // Signing material is kept next to the unpacked source, never shipped.
    if (/^META-INF\/publisher\.(pem|pub)$/i.test(relativePath)) continue;
    out.push([relativePath, readFileSync(path)]);
  }
  return out;
}

function normalizeFiles(files) {
  return files
    .filter(([path]) => path !== SIGNATURE_PATH)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function packageDigest(files) {
  const hash = createHash('sha256');
  for (const [path, bytes] of normalizeFiles(files)) {
    hash.update(path);
    hash.update(Buffer.from([0]));
    hash.update(sha256(bytes));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function signatureFor(files, keyPath, keyId, publisherId) {
  const privateKey = readFileSync(keyPath, 'utf8');
  const publicKey = generatePublicKey(privateKey);
  const packageHash = packageDigest(files);
  const signature = sign(null, Buffer.from(packageHash, 'utf8'), privateKey);
  return {
    schemaVersion: 1,
    algorithm: 'ed25519',
    publisherId,
    keyId,
    publicKey: publicKey.toString('base64'),
    signature: signature.toString('base64'),
    packageHash,
    signedAt: Date.now(),
  };
}

function generatePublicKey(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'der' })
    .subarray(-32);
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP writer (stored entries, no external dependency)         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date = new Date()) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

function writeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosTime();
  for (const [path, bytes] of files) {
    const name = Buffer.from(path, 'utf8');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function readZip(path) {
  const buffer = readFileSync(path);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail('not a ZIP file');
  const entries = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const files = [];
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) fail('invalid central directory');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) fail(`invalid local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (method !== 0) fail(`unsupported compression method ${method} for ${name}`);
    files.push([name, buffer.subarray(dataStart, dataStart + compressed)]);
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

function readManifest(files) {
  const entry = files.find(([path]) => path === 'manifest.json');
  if (!entry) fail('package has no manifest.json');
  try {
    return JSON.parse(entry[1].toString('utf8'));
  } catch (error) {
    fail(`invalid manifest.json: ${error.message}`);
  }
}

function cmdInit(args) {
  const dir = resolve(args[0] ?? 'my-plugin');
  const id = args[1] ?? 'com.example.my-plugin';
  const idParts = id.split('.');
  const publisherId = idParts.length >= 3 ? idParts[1] : idParts[0];
  mkdirSync(join(dir, 'ui'), { recursive: true });
  mkdirSync(join(dir, 'backend'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'example'), { recursive: true });
  mkdirSync(join(dir, 'locales'), { recursive: true });
  mkdirSync(join(dir, 'META-INF'), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(dir, 'META-INF', 'publisher.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(join(dir, 'META-INF', 'publisher.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(
    join(dir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id,
        name: 'My plugin',
        version: '1.0.0',
        description: 'A sandboxed Zylara plugin.',
        author: 'Example',
        apiVersion: 1,
        engines: { zylara: '>=0.10.0 <1.0.0' },
        publisher: { id: publisherId, name: 'Example', keyId: 'example-2026' },
        permissions: ['ui.slot:chat.composer.toolbar', 'ui.view', 'ui.command', 'storage'],
        contributes: {
          ui: {
            slots: [{ slot: 'chat.composer.toolbar', entry: 'ui/toolbar.html', title: 'My plugin' }],
            views: [
              {
                id: 'main',
                title: 'My plugin',
                surface: 'chat',
                location: 'sidebar',
                entry: 'ui/page.html',
              },
            ],
            commands: [
              {
                id: 'open',
                title: 'Open my plugin',
                command: 'my-plugin',
                action: { kind: 'openView', target: 'main' },
              },
            ],
          },
          locales: ['locales'],
        },
        runtime: { ui: 'sandbox' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, 'ui', 'page.html'),
    '<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;color:var(--foreground);background:var(--background);padding:16px}</style><body><h1>My plugin</h1><p id="status">Connecting…</p><script src="/@zylara/sdk.js"></script><script>ZylaraPlugin.on(\'init\',()=>{document.getElementById(\'status\').textContent=\'Connected to Zylara.\';ZylaraPlugin.resize()})</script></body>\n',
  );
  writeFileSync(
    join(dir, 'ui', 'toolbar.html'),
    '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:12px system-ui;color:var(--foreground);background:transparent}button{height:26px;border:1px solid var(--border);border-radius:8px;background:var(--surface-raised);color:var(--foreground);padding:0 8px}</style><body><button id="hello">My plugin</button><script src="/@zylara/sdk.js"></script><script>document.getElementById(\'hello\').onclick=()=>ZylaraPlugin.rpc(\'notify\',{title:\'Hello from my plugin\'})</script></body>\n',
  );
  writeFileSync(join(dir, 'locales', 'en.json'), '{"views":{"main":"My plugin"}}\n');
  writeFileSync(
    join(dir, 'skills', 'example', 'SKILL.md'),
    '---\nname: example\ndescription: Example skill shipped by my-plugin.\n---\n# Example skill\n\nUse this skill as a template.\n',
  );
  writeFileSync(join(dir, 'README.md'), `# ${id}\n\nRun \`pnpm plugin:contract\` after changing the contract, then:\n\n\`zylara-plugin pack . --key META-INF/publisher.pem --publisher ${publisherId}\`\n`);
  console.log(`created ${dir}`);
  console.log('Pack it with: node scripts/plugin/cli.mjs pack . --key META-INF/publisher.pem');
}

function cmdPack(args) {
  const dir = resolve(args[0] ?? '.');
  const flags = parseFlags(args.slice(1));
  const out = flags._[0] ?? join(dirname(dir), `${basename(dir)}.zplugin`);
  const keyPath = flags.key ? resolve(flags.key) : null;
  const files = normalizeFiles(collectFiles(dir));
  const manifest = readManifest(files);
  if (!manifest.id) fail('manifest.id is required');
  const keyId = flags['key-id'] ?? manifest.publisher?.keyId ?? 'dev-2026';
  const publisherId = flags.publisher ?? manifest.publisher?.id ?? 'dev';
  if (keyPath) {
    if (!existsSync(keyPath)) fail(`key not found: ${keyPath}`);
    const signature = signatureFor(files, keyPath, keyId, publisherId);
    files.push([SIGNATURE_PATH, Buffer.from(`${JSON.stringify(signature, null, 2)}\n`)]);
    const zip = writeZip([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(out, zip);
    console.log(`packed signed ${manifest.id}@${manifest.version} → ${out}`);
    console.log(`sha256 ${sha256(zip)}`);
  } else {
    const zip = writeZip(files);
    writeFileSync(out, zip);
    console.log(`packed UNSIGNED ${manifest.id}@${manifest.version} → ${out}`);
    console.log('unsigned packages install only in developer mode');
  }
}

function cmdVerify(args) {
  const path = resolve(args[0] ?? '');
  const files = normalizeFiles(readZip(path));
  const manifest = readManifest(files);
  const signatureFile = readZip(path).find(([entry]) => entry === SIGNATURE_PATH);
  if (!signatureFile) {
    console.log(`unsigned: ${manifest.id}@${manifest.version}`);
    process.exitCode = 2;
    return;
  }
  const signature = JSON.parse(signatureFile[1].toString('utf8'));
  if (signature.algorithm !== 'ed25519') fail('unsupported signature algorithm');
  const digest = packageDigest(files);
  if (digest !== signature.packageHash) fail('package hash mismatch');
  const publicKey = Buffer.from(signature.publicKey, 'base64');
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    publicKey,
  ]);
  const valid = cryptoVerify(
    null,
    Buffer.from(digest, 'utf8'),
    { key: spki, format: 'der', type: 'spki' },
    Buffer.from(signature.signature, 'base64'),
  );
  if (!valid) fail('signature does not match');
  console.log(`verified ${manifest.id}@${manifest.version} (${signature.publisherId}/${signature.keyId})`);
  console.log(`sha256 ${sha256(readFileSync(path))}`);
}

function cmdDev(args) {
  const dir = resolve(args[0] ?? '.');
  const files = normalizeFiles(collectFiles(dir));
  const manifest = readManifest(files);
  console.log(`unpacked ${manifest.id}@${manifest.version} is structurally valid`);
  console.log('In Zylara: Settings → Plugins → Developer mode, then Plugins → Load unpacked.');
}

function cmdRegistry(args) {
  const dir = resolve(args[0] ?? '.');
  const flags = parseFlags(args.slice(1));
  const keyPath = flags.key ? resolve(flags.key) : null;
  if (!keyPath) fail('registry requires --key <publisher.pem>');
  const baseUrl = (flags['base-url'] ?? 'https://example.invalid').replace(/\/$/, '');
  const channel = flags.channel ?? 'stable';
  const packageUrl = (entry) =>
    baseUrl === '' ? entry : `${baseUrl}/${encodeURIComponent(entry)}`;
  const plugins = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.zplugin')) continue;
    const path = join(dir, entry);
    const files = normalizeFiles(readZip(path));
    const manifest = readManifest(files);
    const signatureEntry = readZip(path).find(([name]) => name === SIGNATURE_PATH);
    if (!signatureEntry) fail(`${entry} is unsigned`);
    const signature = JSON.parse(signatureEntry[1].toString('utf8'));
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      publisher: {
        id: manifest.publisher.id,
        name: manifest.publisher.name,
        keyId: signature.keyId,
        publicKey: signature.publicKey,
      },
      summary: manifest.description ?? '',
      description: manifest.description ?? '',
      packageUrl: packageUrl(entry),
      packageSha256: sha256(readFileSync(path)),
      packageSize: statSync(path).size,
      minAppVersion: '0.11.0',
      channel,
      permissions: manifest.permissions ?? [],
      yanked: false,
      publishedAt: new Date().toISOString(),
    });
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id));
  const payload = {
    schemaVersion: 1,
    name: flags.name ?? 'Local plugin registry',
    generatedAt: new Date().toISOString(),
    plugins,
    revoked: [],
  };
  const canonical = canonicalJson(payload);
  const digest = sha256(Buffer.from(canonical, 'utf8'));
  const signature = sign(null, Buffer.from(digest, 'utf8'), readFileSync(keyPath));
  const publicKey = generatePublicKey(readFileSync(keyPath, 'utf8'));
  const output = {
    ...payload,
    signature: {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: flags['key-id'] ?? 'registry-2026',
      publicKey: publicKey.toString('base64'),
      signature: signature.toString('base64'),
    },
  };
  const out = flags.out ? resolve(flags.out) : join(dir, 'registry.json');
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`wrote ${out} (${plugins.length} plugins)`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function cmdBuild(args) {
  const flags = parseFlags(args);
  if (!flags._[0]) fail('build requires a plugin directory');
  cmdPack(args);
}

function cmdSign(args) {
  const path = resolve(args[0] ?? '');
  if (!path || !existsSync(path)) fail('sign requires an existing .zplugin package');
  const flags = parseFlags(args.slice(1));
  const keyPath = flags.key ? resolve(flags.key) : null;
  if (!keyPath) fail('sign requires --key <publisher.pem>');
  const files = normalizeFiles(readZip(path));
  const manifest = readManifest(files);
  const output = flags.out
    ? resolve(flags.out)
    : path.replace(/\.zplugin$/i, '') + '.signed.zplugin';
  const signature = signatureFor(
    files,
    keyPath,
    flags['key-id'] ?? manifest.publisher?.keyId ?? 'dev-2026',
    flags.publisher ?? manifest.publisher?.id ?? 'dev',
  );
  files.push([SIGNATURE_PATH, Buffer.from(`${JSON.stringify(signature, null, 2)}\n`)]);
  writeFileSync(
    output,
    writeZip([...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
  );
  console.log(`signed ${manifest.id}@${manifest.version} → ${output}`);
  console.log(`sha256 ${sha256(readFileSync(output))}`);
}

function cmdPublish(args) {
  const path = resolve(args[0] ?? '');
  if (!existsSync(path)) fail('publish requires an existing .zplugin package');
  const flags = parseFlags(args.slice(1));
  const registryDir = flags.registry ? resolve(flags.registry) : null;
  if (!registryDir) fail('publish requires --registry <directory>');
  if (!flags.key) fail('publish requires --key <registry-private.pem>');
  const files = readZip(path);
  if (!files.some(([entry]) => entry === SIGNATURE_PATH)) {
    fail('refusing to publish an unsigned package');
  }
  mkdirSync(registryDir, { recursive: true });
  const target = join(registryDir, basename(path));
  if (resolve(target) !== path) copyFileSync(path, target);
  const registryArgs = [
    registryDir,
    '--key',
    resolve(flags.key),
    '--key-id',
    flags['key-id'] ?? 'registry-2026',
    '--base-url',
    flags['base-url'] ?? '',
    '--out',
    join(registryDir, 'registry.json'),
  ];
  if (flags.channel) registryArgs.push('--channel', flags.channel);
  cmdRegistry(registryArgs);
  console.log(`published ${basename(path)} to ${registryDir}`);
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = value;
    index += 1;
  }
  return flags;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'init':
    cmdInit(rest);
    break;
  case 'pack':
    cmdPack(rest);
    break;
  case 'build':
    cmdBuild(rest);
    break;
  case 'sign':
    cmdSign(rest);
    break;
  case 'publish':
    cmdPublish(rest);
    break;
  case 'verify':
    cmdVerify(rest);
    break;
  case 'registry':
    cmdRegistry(rest);
    break;
  case 'dev':
    cmdDev(rest);
    break;
  default:
    console.log(`zylara-plugin <command>

  init <dir> [id]
  build <dir> [out] [--key key.pem] [--key-id id] [--publisher id]
  pack <dir> [out] [--key key.pem] [--key-id id] [--publisher id]
  sign <file.zplugin> --key key.pem [--key-id id] [--publisher id] [--out file]
  verify <file.zplugin>
  publish <file.zplugin> --registry <dir> --key registry.pem [--channel stable]
  registry <dir> --base-url <url> --key key.pem [--key-id id] [--out file]
  dev <dir>
`);
    process.exitCode = command ? 1 : 0;
}
