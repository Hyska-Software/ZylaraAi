#!/usr/bin/env node
/**
 * zylara-plugin review — CI gate for `.zplugin` packages.
 *
 * Usage:
 *   node scripts/plugin/review.mjs <file.zplugin> [more.zplugin] [--json]
 *
 * Checks ZIP paths, manifest shape, declared permissions against the canonical
 * contract, publisher signature/key binding, binary payloads and a small
 * heuristic set of dangerous shell/JS patterns. Exit 1 on security errors;
 * exit 0 with `reviewRequired: true` for trusted/high-risk or binary packages
 * unless `--allow-high-risk` is passed.
 *
 * This is a deterministic static review, not an antivirus. Native binaries and
 * trusted plugins still require manual review.
 */
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const contract = JSON.parse(
  readFileSync(resolve(root, 'data', 'plugin-contract.json'), 'utf8'),
);
const PERMISSIONS = new Map(contract.permissions.map((entry) => [entry.id, entry]));
const SIGNATURE_PATH = 'META-INF/signature.json';
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.node', '.so', '.dylib', '.wasm', '.bin', '.msi', '.scr', '.com', '.bat', '.cmd', '.ps1',
]);
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const SUSPICIOUS = [
  /powershell(?:\.exe)?\s+-(?:enc|encodedcommand)/i,
  /cmd(?:\.exe)?\s+\/c/i,
  /base64\s+-d/i,
  /eval\s*\(\s*atob\s*\(/i,
  /child_process/,
  /process\.binding/,
  /require\s*\(\s*['"]node:(?:child_process|fs)['"]\s*\)/,
];

function fail(message) {
  console.error(`zylara-plugin review: ${message}`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeName(name) {
  if (!name || name.length > 240 || name.includes('\\') || name.includes('\0') || name.includes(':')) {
    throw new Error(`unsafe ZIP path: ${name}`);
  }
  if (name.startsWith('/') || name.startsWith('./')) {
    throw new Error(`absolute/dot ZIP path: ${name}`);
  }
  for (const component of name.split('/')) {
    if (!component || component === '.' || component === '..') throw new Error(`unsafe ZIP path: ${name}`);
    if (component.endsWith('.') || component.endsWith(' ')) throw new Error(`Windows-unsafe ZIP path: ${name}`);
    if (RESERVED.has(component.split('.')[0].toUpperCase())) throw new Error(`reserved ZIP name: ${name}`);
  }
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
  if (eocd < 0) throw new Error('not a ZIP file');
  const entries = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const files = [];
  const directories = new Set();
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('invalid ZIP central directory');
    const madeBy = buffer.readUInt16LE(pointer + 4);
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const uncompressed = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const external = buffer.readUInt32LE(pointer + 38);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new Error(`encrypted ZIP entry: ${name}`);
    if ((madeBy >> 8) === 3 && (external & 0o170000) === 0o120000) {
      throw new Error(`symlink ZIP entry: ${name}`);
    }
    try {
      assertSafeName(name);
    } catch (error) {
      throw new Error(error.message);
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`invalid local header: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressed);
    let bytes;
    if (method === 0) {
      bytes = payload;
    } else if (method === 8) {
      try {
        bytes = inflateRawSync(payload, { maxOutputLength: 64 * 1024 * 1024 });
      } catch (error) {
        throw new Error(`invalid deflate entry ${name}: ${error.message}`);
      }
    } else {
      throw new Error(`unsupported compression method ${method} for ${name}`);
    }
    if (bytes.length !== uncompressed) throw new Error(`size mismatch for ${name}`);
    if (name.endsWith('/')) {
      directories.add(name.replace(/\/$/, ''));
    } else {
      files.push([name, bytes]);
    }
  }
  const names = new Set(files.map(([name]) => name));
  for (const directory of directories) {
    if (names.has(directory)) throw new Error(`file/directory collision: ${directory}`);
  }
  return files;
}

function canonicalDigest(files) {
  const hash = createHash('sha256');
  for (const [name, bytes] of files
    .filter(([name]) => name !== SIGNATURE_PATH)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    hash.update(name);
    hash.update(Buffer.from([0]));
    hash.update(sha256(bytes));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function verifySignature(files, manifest) {
  const entry = files.find(([name]) => name === SIGNATURE_PATH);
  if (!entry) throw new Error('package is unsigned');
  let signature;
  try {
    signature = JSON.parse(entry[1].toString('utf8'));
  } catch (error) {
    throw new Error(`invalid signature JSON: ${error.message}`);
  }
  if (signature.algorithm !== 'ed25519') throw new Error('unsupported signature algorithm');
  if (signature.publisherId !== manifest.publisher?.id) {
    throw new Error('signature publisher does not match manifest publisher');
  }
  if (signature.keyId !== manifest.publisher?.keyId) {
    throw new Error('signature keyId does not match manifest keyId');
  }
  const digest = canonicalDigest(files);
  if (digest !== signature.packageHash) throw new Error('package hash mismatch');
  const publicKey = Buffer.from(signature.publicKey, 'base64');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
  const valid = cryptoVerify(
    null,
    Buffer.from(digest, 'utf8'),
    { key: spki, format: 'der', type: 'spki' },
    Buffer.from(signature.signature, 'base64'),
  );
  if (!valid) throw new Error('signature does not match');
  createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return signature;
}

function reviewOne(path, options) {
  const files = readZip(path);
  const manifestFile = files.find(([name]) => name === 'manifest.json');
  if (!manifestFile) throw new Error('manifest.json is missing');
  let manifest;
  try {
    manifest = JSON.parse(manifestFile[1].toString('utf8'));
  } catch (error) {
    throw new Error(`invalid manifest.json: ${error.message}`);
  }
  if (![1, 2].includes(manifest.schemaVersion)) throw new Error('unsupported schemaVersion');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id ?? '')) throw new Error('invalid plugin id');
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version ?? '')) throw new Error('invalid version');
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const permissionRisks = [];
  for (const permission of permissions) {
    const base = permission.split(':')[0];
    const spec = PERMISSIONS.get(base);
    if (!spec) throw new Error(`unknown permission: ${permission}`);
    permissionRisks.push({ id: permission, risk: spec.risk, trustedOnly: Boolean(spec.trustedOnly) });
  }
  const signature = verifySignature(files, manifest);
  const binaries = files
    .filter(([name]) => BINARY_EXTENSIONS.has(extname(name).toLowerCase()))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) }));
  const suspicious = [];
  for (const [name, bytes] of files) {
    if (bytes.length > 2 * 1024 * 1024) continue;
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (SUSPICIOUS.some((pattern) => pattern.test(text))) suspicious.push(name);
  }
  const highRisk = permissionRisks.some(
    (permission) => permission.risk === 'high' || permission.risk === 'critical',
  );
  const trusted = manifest.trusted === true || manifest.runtime?.ui === 'trusted';
  const reviewRequired = trusted || highRisk || binaries.length > 0;
  const errors = [];
  if (binaries.length > 0 && !options.allowBinaries) {
    errors.push('native/binary payloads require explicit review');
  }
  if (reviewRequired && !options.allowHighRisk) {
    errors.push('trusted/high-risk permissions require manual review');
  }
  return {
    file: path,
    ok: errors.length === 0,
    reviewRequired,
    plugin: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      publisher: manifest.publisher,
      trusted,
      permissions: permissionRisks,
    },
    signature: {
      keyId: signature.keyId,
      publisherId: signature.publisherId,
      packageHash: signature.packageHash,
      verified: true,
    },
    binaries,
    suspicious,
    errors,
  };
}

function extname(path) {
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(index);
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const allowHighRisk = args.includes('--allow-high-risk');
const allowBinaries = args.includes('--allow-binaries');
const paths = args.filter((argument) => !argument.startsWith('--'));
if (paths.length === 0) fail('pass at least one .zplugin package');

const reports = [];
let failed = false;
for (const path of paths) {
  try {
    const report = reviewOne(resolve(path), { allowHighRisk, allowBinaries });
    reports.push(report);
    if (!report.ok) failed = true;
  } catch (error) {
    failed = true;
    reports.push({ file: path, ok: false, error: error.message });
  }
}

if (json) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const report of reports) {
    console.log(`${report.ok ? 'PASS' : 'REVIEW'} ${report.file}`);
    if (report.error) {
      console.log(`  error: ${report.error}`);
      continue;
    }
    console.log(
      `  ${report.plugin.id}@${report.plugin.version} publisher ${report.plugin.publisher.id}/${report.signature.keyId}`,
    );
    const risky = report.plugin.permissions.filter(
      (permission) => permission.risk === 'high' || permission.risk === 'critical',
    );
    if (risky.length) {
      console.log(`  high-risk permissions: ${risky.map((permission) => permission.id).join(', ')}`);
    }
    if (report.binaries.length) {
      console.log(`  binaries: ${report.binaries.map((binary) => binary.path).join(', ')}`);
    }
    if (report.suspicious.length) {
      console.log(`  suspicious text: ${report.suspicious.join(', ')}`);
    }
    for (const error of report.errors) console.log(`  error: ${error}`);
  }
}
process.exitCode = failed ? 1 : 0;
