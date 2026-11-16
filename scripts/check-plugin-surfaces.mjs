#!/usr/bin/env node
/**
 * Contract-surface parity: every "live" slot/component must be mounted by the
 * host, and every reserved id must stay unmounted. A surface becomes available
 * by mounting it and removing its id from the reserved arrays together.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readdirFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'target' || entry === '__tests__') continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...readdirFiles(path));
    else if (entry.endsWith('.tsx')) files.push(path);
  }
  return files;
}

function literalMatches(text, pattern) {
  const ids = new Set();
  for (const match of text.matchAll(pattern)) ids.add(match[1]);
  return ids;
}

export function checkPluginSurfaces(root = resolve(here, '..')) {
  const contract = JSON.parse(
    readFileSync(join(root, 'data', 'plugin-contract.json'), 'utf8'),
  );
  const source = [
    ...readdirFiles(join(root, 'src', 'components')),
    join(root, 'src', 'App.tsx'),
  ]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const mountedSlots = new Set([
    ...literalMatches(source, /<Slot\b[^>]*?\bname="([a-z][a-zA-Z0-9._-]+)"/gs),
    ...literalMatches(source, /<PluginSlot\b[^>]*?\bslot="([a-z][a-zA-Z0-9._-]+)"/gs),
  ]);
  const mountedComponents = literalMatches(
    source,
    /<ComponentSlot\b[^>]*?\bname="([a-z][a-zA-Z0-9._-]+)"/gs,
  );
  const reservedSlots = new Set(contract.reservedSlots ?? []);
  const reservedComponents = new Set(contract.reservedComponents ?? []);
  const allSlots = new Set((contract.slots ?? []).map((slot) => slot.id));
  const allComponents = new Set(
    (contract.components ?? []).map((component) => component.id),
  );
  const errors = [];

  for (const id of allSlots) {
    const mounted = mountedSlots.has(id);
    if (!mounted && !reservedSlots.has(id)) errors.push(`live slot is not mounted: ${id}`);
    if (mounted && reservedSlots.has(id)) errors.push(`reserved slot is mounted: ${id}`);
  }
  for (const id of allComponents) {
    const mounted = mountedComponents.has(id);
    if (!mounted && !reservedComponents.has(id)) errors.push(`live component is not mounted: ${id}`);
    if (mounted && reservedComponents.has(id)) errors.push(`reserved component is mounted: ${id}`);
  }
  for (const id of mountedSlots) {
    if (!allSlots.has(id)) errors.push(`mounted slot is not in the contract: ${id}`);
  }
  for (const id of mountedComponents) {
    if (!allComponents.has(id)) errors.push(`mounted component is not in the contract: ${id}`);
  }
  return { ok: errors.length === 0, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = checkPluginSurfaces();
  if (!result.ok) {
    console.error('plugin-surfaces: contract drift');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('plugin-surfaces: ok');
}
