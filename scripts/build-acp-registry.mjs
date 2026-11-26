#!/usr/bin/env node
/**
 * Bundles an offline snapshot of the official ACP Registry for first launch.
 *
 * Usage:
 *   node scripts/build-acp-registry.mjs          # fetch + rewrite data/acp-registry.json
 *   node scripts/build-acp-registry.mjs --check  # validate the committed file, no network
 *
 * The output is canonical: agents sorted by id, object keys in a fixed order,
 * sha256 lowercased, two-space indentation and a trailing newline. Re-running
 * the builder against an unchanged registry leaves the file byte-identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'acp-registry.json');
export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const ID_RE = /^[a-z][a-z0-9-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function invalid(message) {
  throw new Error(message);
}

function stringField(value, label, { required = false, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (required) invalid(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  if (!allowEmpty && value.length === 0) invalid(`${label} must not be empty`);
  return value;
}

function stringArray(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value.map((item, index) => stringField(item, `${label}[${index}]`, { allowEmpty: true }));
}

function stringMap(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) invalid(`${label} has an unsafe key: ${key}`);
    out[key] = stringField(value[key], `${label}.${key}`, { allowEmpty: true });
  }
  return out;
}

function packageDist(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  const out = { package: stringField(value.package, `${label}.package`, { required: true }) };
  const args = stringArray(value.args, `${label}.args`);
  if (args?.length) out.args = args;
  const env = stringMap(value.env, `${label}.env`);
  if (env && Object.keys(env).length) out.env = env;
  return out;
}

function canonicalAgent(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`agents[${index}] must be an object`);
  const id = stringField(raw.id, `agents[${index}].id`, { required: true });
  if (!ID_RE.test(id)) invalid(`agents[${index}].id is invalid: ${id}`);
  const version = stringField(raw.version, `${id}.version`, { required: true });
  if (!SEMVER_RE.test(version)) invalid(`${id}.version is not semver-like: ${version}`);

  const out = {
    id,
    name: stringField(raw.name, `${id}.name`, { required: true }),
    version,
    description: stringField(raw.description, `${id}.description`) ?? '',
  };
  const optional = {
    repository: raw.repository,
    website: raw.website,
    authors: raw.authors,
    license: raw.license,
    license_url: raw.license_url,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (key === 'authors') {
      const authors = stringArray(value, `${id}.authors`);
      if (authors?.length) out.authors = authors;
    } else {
      const text = stringField(value, `${id}.${key}`);
      if (text !== undefined) out[key] = text;
    }
  }
  const icon = stringField(raw.icon, `${id}.icon`);
  if (icon !== undefined) out.icon = icon;

  const distribution = raw.distribution;
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
    invalid(`${id}.distribution must be an object`);
  }
  const canonicalDistribution = {};
  if (distribution.binary !== undefined) {
    if (!distribution.binary || typeof distribution.binary !== 'object' || Array.isArray(distribution.binary)) {
      invalid(`${id}.distribution.binary must be an object`);
    }
    const binary = {};
    for (const target of Object.keys(distribution.binary).sort()) {
      const entry = distribution.binary[target];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalid(`${id}.distribution.binary.${target} must be an object`);
      }
      const binaryEntry = {
        archive: stringField(entry.archive, `${id}.${target}.archive`, { required: true }),
      };
      const sha = stringField(entry.sha256, `${id}.${target}.sha256`);
      if (sha !== undefined) binaryEntry.sha256 = sha.toLowerCase();
      binaryEntry.cmd = stringField(entry.cmd, `${id}.${target}.cmd`, { required: true });
      const args = stringArray(entry.args, `${id}.${target}.args`);
      if (args?.length) binaryEntry.args = args;
      const env = stringMap(entry.env, `${id}.${target}.env`);
      if (env && Object.keys(env).length) binaryEntry.env = env;
      binary[target] = binaryEntry;
    }
    if (Object.keys(binary).length) canonicalDistribution.binary = binary;
  }
  for (const method of ['npx', 'uvx']) {
    if (distribution[method] !== undefined) canonicalDistribution[method] = packageDist(distribution[method], `${id}.distribution.${method}`);
  }
  if (!Object.keys(canonicalDistribution).length) invalid(`${id} has no distribution`);
  out.distribution = canonicalDistribution;
  return out;
}

/** Validates and returns the canonical, deterministic representation. */
export function canonicalizeRegistry(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('registry must be an object');
  const version = stringField(payload.version, 'registry.version', { required: true });
  if (!Array.isArray(payload.agents)) invalid('registry.agents must be an array');
  const seen = new Set();
  const agents = payload.agents.map(canonicalAgent);
  for (const agent of agents) {
    if (seen.has(agent.id)) invalid(`duplicate registry id: ${agent.id}`);
    seen.add(agent.id);
  }
  agents.sort((a, b) => a.id.localeCompare(b.id));
  return { version, agents };
}

export function serializeRegistry(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Reads the committed file and proves it is already canonical. */
export function checkSnapshot(file = OUT_FILE) {
  const raw = fs.readFileSync(file, 'utf8');
  const canonical = serializeRegistry(canonicalizeRegistry(JSON.parse(raw)));
  if (raw !== canonical) throw new Error(`${file} is not canonical (regenerate with build-acp-registry.mjs)`);
  return JSON.parse(canonical);
}

async function build() {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: 'application/json', 'user-agent': 'Zylara/0.15.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status} ${response.statusText}`);
  const snapshot = serializeRegistry(canonicalizeRegistry(await response.json()));
  const previous = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (previous === snapshot) {
    console.log(`acp-registry unchanged (${JSON.parse(snapshot).agents.length} agents)`);
    return;
  }
  const temp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(temp, snapshot);
  fs.renameSync(temp, OUT_FILE);
  console.log(`wrote ${OUT_FILE} (${JSON.parse(snapshot).agents.length} agents)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    try {
      const snapshot = checkSnapshot();
      console.log(`acp-registry OK (${snapshot.agents.length} agents)`);
    } catch (error) {
      console.error(`acp-registry check failed: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    build().catch((error) => {
      console.error(`acp-registry build failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
