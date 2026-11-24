#!/usr/bin/env node
/**
 * Refreshes the public catalog inputs and rebuilds `data/catalog.json`.
 *
 * Runs automatically before every app/renderer build (`pnpm build`,
 * `pnpm build:fast` used by `tauri build`, and `pnpm app:build`). It covers
 * every provider that can be refreshed without credentials:
 *  - OpenCode Go / Zen: official docs tables and the public `/v1/models` lists
 *    (ids, names, wire protocol, live capabilities and pricing)
 *  - OpenAI / Anthropic / Google: models.dev (capabilities, limits, pricing, families)
 *
 * Account-specific model lists (OpenAI/Anthropic) stay a runtime concern: they
 * need the user's credential and are merged by the app after sign-in/key save.
 *
 * Network or parse failures are non-fatal by default: the working `.research`
 * inputs and the committed catalog stay untouched, so builds work offline.
 * Use `--strict` to turn those failures into a non-zero exit.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  assertDocsModels,
  assertLiveModels,
  DOC_SOURCES,
  LIVE_MODEL_SOURCES,
  MODELS_DEV_URL,
  parseDocsModels,
  parseLiveModels,
} from './catalog-sources.mjs';

const root = path.resolve(import.meta.dirname, '..');
const research = path.join(root, '.research');
const docsDir = path.join(research, 'docs');
const catalogFile = path.join(root, 'data', 'catalog.json');
const buildScript = path.join(root, 'scripts', 'build-catalog.mjs');

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const offline = args.has('--offline');

function log(message) {
  console.log(`[catalog] ${message}`);
}

function warn(message) {
  console.warn(`[catalog] ${message}`);
}

function writeAtomic(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function writeIfChanged(file, content) {
  try {
    if (readFileSync(file, 'utf8') === content) return false;
  } catch {
    // Missing file: write it below.
  }
  writeAtomic(file, content);
  return true;
}

async function fetchText(url, accept, timeoutMs) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': 'Zylara-catalog/1.0',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function validateModelsDev(value) {
  const required = ['opencode-go', 'opencode', 'openai', 'anthropic', 'google'];
  const missing = required.filter(
    (provider) => !value[provider]?.models || Object.keys(value[provider].models).length === 0,
  );
  if (missing.length) {
    throw new Error(`models.dev sem provedores esperados: ${missing.join(', ')}`);
  }
  return value;
}

function catalogSummary() {
  try {
    const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
    return catalog.providers.map((provider) => `${provider.id}=${provider.models.length}`).join(' ');
  } catch {
    return 'data/catalog.json ilegível';
  }
}

async function refreshInputs() {
  const failures = [];
  for (const source of DOC_SOURCES) {
    try {
      const html = await fetchText(source.url, 'text/html,application/xhtml+xml', 60_000);
      const models = assertDocsModels(parseDocsModels(html), source.label);
      writeIfChanged(path.join(docsDir, `${source.provider}.html`), html);
      writeIfChanged(
        path.join(research, `docs-${source.provider}.json`),
        `${JSON.stringify(models, null, 1)}\n`,
      );
      log(`${source.provider}: ${models.length} modelos`);
    } catch (error) {
      failures.push(`${source.label}: ${error.message}`);
    }
  }

  for (const source of LIVE_MODEL_SOURCES) {
    try {
      const raw = await fetchText(source.url, 'application/json', 60_000);
      const models = assertLiveModels(parseLiveModels(JSON.parse(raw)), source.provider);
      writeIfChanged(
        path.join(research, `${source.provider}-models-live.json`),
        `${JSON.stringify(models.map((model) => model.raw), null, 1)}\n`,
      );
      log(`${source.provider} live: ${models.length} modelos`);
    } catch (error) {
      failures.push(`${source.provider} live: ${error.message}`);
    }
  }

  try {
    const raw = await fetchText(MODELS_DEV_URL, 'application/json', 120_000);
    const parsed = validateModelsDev(JSON.parse(raw));
    const providers = ['opencode-go', 'opencode', 'openai', 'anthropic']
      .map((provider) => `${provider}=${Object.keys(parsed[provider].models).length}`)
      .join(' ');
    writeIfChanged(path.join(research, 'models-dev.json'), `${JSON.stringify(parsed, null, 1)}\n`);
    log(`models.dev: ${providers}`);
  } catch (error) {
    failures.push(`models.dev: ${error.message}`);
  }

  return failures;
}

function inputsReady() {
  return ['docs-go.json', 'docs-zen.json', 'models-dev.json'].every((file) =>
    existsSync(path.join(research, file)),
  );
}

function main() {
  if (process.env.ZYLARA_SKIP_CATALOG_SYNC === '1') {
    log('sync pulado (ZYLARA_SKIP_CATALOG_SYNC=1)');
    return;
  }

  const run = async () => {
    const failures = offline ? ['modo --offline: fontes não foram baixadas'] : await refreshInputs();
    if (failures.length) {
      for (const failure of failures) warn(failure);
    }
    if (!inputsReady()) {
      warn('inputs públicos incompletos; mantendo data/catalog.json atual');
      if (strict || !existsSync(catalogFile)) process.exitCode = 1;
      return;
    }

    log('regenerando data/catalog.json');
    const result = spawnSync(process.execPath, [buildScript], { cwd: root, stdio: 'inherit' });
    if (result.error) {
      warn(`build-catalog falhou: ${result.error.message}; catálogo anterior preservado`);
      if (strict) process.exitCode = 1;
      return;
    }
    if (result.status !== 0) {
      warn(`build-catalog saiu com ${result.status}; catálogo anterior preservado`);
      if (strict) process.exitCode = 1;
      return;
    }
    log(`pronto: ${catalogSummary()}`);
  };

  run().catch((error) => {
    warn(`falha inesperada: ${error.stack ?? error.message}; catálogo anterior preservado`);
    if (strict) process.exitCode = 1;
  });
}

main();
