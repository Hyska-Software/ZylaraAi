import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const NAMESPACES = [
  'common', 'chat', 'composer', 'models', 'settings', 'code', 'agents',
  'artifacts', 'library', 'palette', 'genui', 'installer', 'plugins',
];
const PLURAL = /(_|\.)(zero|one|two|few|many|other)$/;

function flatten(value, prefix = '') {
  const out = new Map();
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      for (const [key, text] of flatten(entry, `${prefix}[${index}]`)) out.set(key, text);
    });
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const next = prefix ? `${prefix}.${key}` : key;
      for (const [child, text] of flatten(entry, next)) out.set(child, text);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

function normalizeKey(key) {
  return key.replace(PLURAL, '');
}

function placeholders(text, pattern) {
  return [...String(text).matchAll(pattern)].map((match) => match[1]).sort();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

const errors = [];

const languageSource = await readFile(
  path.join(ROOT, 'src/lib/i18n/languages.ts'),
  'utf8',
);
const tsCodes = [...languageSource.matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]);
const rustSource = await readFile(path.join(ROOT, 'src-tauri/src/i18n.rs'), 'utf8');
const rustCodes = [...rustSource.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1]);
const dirs = (await readdir(path.join(ROOT, 'src/locales'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expected = [...tsCodes].sort();
if (JSON.stringify(dirs) !== JSON.stringify(expected)) {
  errors.push(`locale dirs ${dirs.join(',')} != registry ${expected.join(',')}`);
}
if (JSON.stringify([...rustCodes].sort()) !== JSON.stringify(expected)) {
  errors.push(`Rust LANGUAGES ${rustCodes.join(',')} != TS registry ${expected.join(',')}`);
}

for (const ns of NAMESPACES) {
  const base = flatten(await readJson(path.join(ROOT, `src/locales/en/${ns}.json`)));
  const baseKeys = new Map([...base].map(([key, text]) => [normalizeKey(key), text]));
  for (const code of tsCodes.filter((entry) => entry !== 'en')) {
    const catalog = flatten(await readJson(path.join(ROOT, `src/locales/${code}/${ns}.json`)));
    const keys = new Map([...catalog].map(([key, text]) => [normalizeKey(key), text]));
    for (const [key, text] of baseKeys) {
      if (!keys.has(key)) errors.push(`${code}/${ns}: missing ${key}`);
      if (typeof text === 'string' && text.length === 0) errors.push(`en/${ns}: empty ${key}`);
      if (!keys.has(key)) continue;
      const translated = keys.get(key);
      if (typeof translated === 'string' && translated.length === 0) {
        errors.push(`${code}/${ns}: empty ${key}`);
      }
      if (
        typeof translated === 'string' &&
        JSON.stringify(placeholders(text, /\{\{(\w+)\}\}/g)) !==
          JSON.stringify(placeholders(translated, /\{\{(\w+)\}\}/g))
      ) {
        errors.push(`${code}/${ns}: placeholders differ for ${key}`);
      }
    }
    for (const key of keys.keys()) {
      if (!baseKeys.has(key)) errors.push(`${code}/${ns}: extra ${key}`);
    }
  }
}

async function backendCatalog(code) {
  const main = await readJson(path.join(ROOT, `src-tauri/locales/${code}.json`));
  const tools = await readJson(path.join(ROOT, `src-tauri/locales/${code}/tools.json`));
  return { ...main, ...tools };
}

const backendEn = flatten(await backendCatalog('en'));
const backendBase = new Map([...backendEn].map(([key, text]) => [normalizeKey(key), text]));
for (const code of ['pt-BR', 'es']) {
  const catalog = flatten(await backendCatalog(code));
  const keys = new Map([...catalog].map(([key, text]) => [normalizeKey(key), text]));
  for (const [key, text] of backendBase) {
    if (!keys.has(key)) errors.push(`backend ${code}: missing ${key}`);
    if (!keys.has(key)) continue;
    const translated = keys.get(key);
    if (typeof translated === 'string' && translated.length === 0) {
      errors.push(`backend ${code}: empty ${key}`);
    }
    if (
      typeof translated === 'string' &&
      JSON.stringify(placeholders(text, /\{(\w+)\}/g)) !==
        JSON.stringify(placeholders(translated, /\{(\w+)\}/g))
    ) {
      errors.push(`backend ${code}: placeholders differ for ${key}`);
    }
  }
  for (const key of keys.keys()) {
    if (!backendBase.has(key)) errors.push(`backend ${code}: extra ${key}`);
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

for (const file of await walk(path.join(ROOT, 'src-tauri/src'))) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(
    /(?:crate::)?i18n::t(?:_args|_count)?\(\s*"([^"]+)"/g,
  )) {
    const key = match[1];
    if (!backendBase.has(key)) {
      errors.push(`${path.relative(ROOT, file)}: unknown i18n key ${key}`);
    }
  }
}


const englishKeys = new Set();
for (const ns of NAMESPACES) {
  const catalog = flatten(await readJson(path.join(ROOT, `src/locales/en/${ns}.json`)));
  for (const key of catalog.keys()) {
    englishKeys.add(normalizeKey(key));
    englishKeys.add(`${ns}:${normalizeKey(key)}`);
  }
}

async function walkSource(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['locales', 'i18n', '__tests__', 'node_modules'].includes(entry.name)) continue;
      out.push(...(await walkSource(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

for (const file of await walkSource(path.join(ROOT, 'src'))) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  const source = await readFile(file, 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(match[1]);
  for (const match of source.matchAll(/i18nKey\s*=\s*["']([^"']+)["']/g)) keys.add(match[1]);
  for (const key of keys) {
    if (!key.includes('.') || key.startsWith('zylara:') || key.includes('://')) continue;
    const withoutNs = key.includes(':') ? key.split(':').slice(1).join(':') : key;
    if (
      !englishKeys.has(key) &&
      !englishKeys.has(withoutNs) &&
      !englishKeys.has(normalizeKey(withoutNs))
    ) {
      errors.push(`${relative}: unknown translation key ${key}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`i18n check failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('i18n catalogs are in parity.');
