import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const ACCENT = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;
const PT_WORDS =
  /\b(não|arquivo|pasta|sessão|usuário|permissão|mensagem|provedor|agente|tarefa|conclu|alteraç|comando|salvar|abrir|buscar|necessári|inválid|disponível|nenhum|você|padrão|ferramenta)\w*/i;

let allowlist = [];
try {
  allowlist = JSON.parse(await readFile(path.join(ROOT, 'scripts/i18n-allowlist.json'), 'utf8'));
} catch {
  allowlist = [];
}
const allowed = new Set(
  allowlist
    .filter((entry) => entry.file.startsWith('src-tauri/'))
    .map((entry) => `${entry.file}\u0000${entry.text}`),
);

// Model-facing prompts/tool guidance and developer benchmarks are intentionally
// not UI copy; the scanner focuses on the audited user-facing modules.
const SKIP = [
  /src-tauri\/src\/tools\//,
  /src-tauri\/src\/harness\/prompt\.rs$/,
  /src-tauri\/src\/harness\/code\/prompt\.rs$/,
  /src-tauri\/src\/harness\/code\/context\.rs$/,
  /src-tauri\/src\/harness\/cache\/bench\.rs$/,
  /src-tauri\/src\/harness\/completion\.rs$/, // multilingual unfinished-work markers, never UI copy
  /src-tauri\/src\/tools\/genui\/(normalize|lint|fixtures)\.rs$/,
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

function stripComments(source) {
  let out = '';
  let index = 0;
  let depth = 0;
  while (index < source.length) {
    if (source.startsWith('//', index) && depth === 0) {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (depth > 0) {
      if (source.startsWith('*/', index)) {
        depth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

function stripTests(source) {
  const marker = source.search(/#\[cfg\(test\)\]\s*mod\s+tests\s*\{/);
  return marker < 0 ? source : source.slice(0, marker);
}

const problems = [];
for (const file of await walk(path.join(ROOT, 'src-tauri/src'))) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  if (SKIP.some((pattern) => pattern.test(relative))) continue;
  const source = stripTests(stripComments(await readFile(file, 'utf8')));
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\b(tracing|log|debug|info|warn|error|trace|eprintln|println)!\s*\(/.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const text = match[1];
      const key = `${relative}\u0000${text}`;
      if (allowed.has(key)) continue;
      if (/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(text)) continue;
      if (ACCENT.test(text) || PT_WORDS.test(text)) {
        problems.push(`${relative}:${index + 1}  ${text.slice(0, 100)}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`rust copy check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('no unlocalized Rust UI copy found.');
