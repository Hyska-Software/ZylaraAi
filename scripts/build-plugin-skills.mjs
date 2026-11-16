#!/usr/bin/env node
/**
 * Generates the factual blocks of the bundled plugin skills from the canonical
 * contract, manifest schema, GenUI contract and theme-token allowlist.
 *
 * Hand-written prose lives outside the markers; this script only replaces the
 * generated section so the agent never has to read repository files.
 *
 *   node scripts/build-plugin-skills.mjs          # write
 *   node scripts/build-plugin-skills.mjs --check  # fail when stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const contract = readJson('data/plugin-contract.json');
const manifestSchema = readJson('data/plugin-manifest.schema.json');
const genui = readJson('data/genui-contract.json');
const themeTokens = readJson('data/theme-tokens.json');

const SKILLS = {
  manifest: 'src-tauri/skills/plugin-manifest/SKILL.md',
  ui: 'src-tauri/skills/plugin-ui/SKILL.md',
  genui: 'src-tauri/skills/plugin-genui/SKILL.md',
  agent: 'src-tauri/skills/plugin-agent/SKILL.md',
  package: 'src-tauri/skills/plugin-package/SKILL.md',
};

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ')} |`),
  ].join('\n');
}

function list(values) {
  return values.length ? values.join(', ') : '—';
}

function slotRows() {
  return (contract.slots ?? []).map((slot) => [
    `\`${slot.id}\``,
    slot.kind,
    slot.scope,
    list(slot.layouts),
    list(slot.modes),
    list(slot.props),
    slot.description ?? '',
  ]);
}

function componentRows() {
  return (contract.components ?? []).map((component) => [
    `\`${component.id}\``,
    list(component.layouts),
    list(component.variants ?? []),
    list(component.props ?? []),
    Object.keys(component.builtinRecipes ?? {}).join(', ') || '—',
  ]);
}

function permissionRows() {
  return (contract.permissions ?? []).map((permission) => [
    `\`${permission.id}\``,
    permission.scoped ? 'yes' : 'no',
    permission.trustedOnly ? 'yes' : 'no',
    permission.risk,
    permission.description,
  ]);
}

function eventRows() {
  return (contract.events ?? []).map((event) => [
    `\`${event.name}\``,
    list(event.props ?? []),
    event.description ?? '',
  ]);
}

function limitRows() {
  return Object.entries(contract.limits ?? {}).map(([key, value]) => [`\`${key}\``, value]);
}

function uiLimitRows() {
  return Object.entries(contract.uiLimits ?? {}).map(([key, value]) => [`\`${key}\``, value]);
}

function recipeRows() {
  return Object.entries(contract.styleRecipes ?? {}).map(([key, values]) => [
    `\`${key}\``,
    list(values.map((value) => `\`${value}\``)),
  ]);
}

function themeRows() {
  return [
    ...(themeTokens.required ?? []).map((token) => [`\`--${token}\``, 'required']),
    ...(themeTokens.optionalColor ?? []).map((token) => [`\`--${token}\``, 'optional color']),
    ...(themeTokens.optionalLength ?? []).map((token) => [`\`--${token}\``, 'optional length']),
  ];
}

function genuiProps(component) {
  const entries = Object.entries(component.props ?? {});
  if (entries.length === 0) return '—';
  return entries
    .map(([name, spec]) => {
      const type = spec.type ?? 'value';
      const values = Array.isArray(spec.values) ? ` (${spec.values.join('/')})` : '';
      const max = spec.maxChars ? ` ≤${spec.maxChars}` : '';
      return `\`${name}\`: ${type}${values}${max}`;
    })
    .join('; ');
}

function genuiBlock() {
  const rows = (genui.components ?? []).map((component) => [
    `\`${component.type}\``,
    component.kind,
    component.category,
    component.summary,
    genuiProps(component),
  ]);
  const rules = (genui.rules ?? []).map((rule) => [rule.severity, rule.message, rule.prompt ?? rule.hint ?? '']);
  return [
    '### GenUI components',
    '',
    table(['Type', 'Kind', 'Category', 'Summary', 'Props'], rows),
    '',
    '### GenUI rules',
    '',
    table(['Severity', 'Rule', 'Prompt guidance'], rules),
    '',
    '### GenUI limits',
    '',
    '```json',
    JSON.stringify(genui.limits ?? {}, null, 2),
    '```',
  ].join('\n');
}

function contractBlock(kind) {
  const sections = [];
  if (kind === 'manifest' || kind === 'ui') {
    sections.push(
      '### Layouts',
      '',
      list((contract.layouts ?? []).map((value) => `\`${value}\``)),
      '',
      '### Host pages',
      '',
      list((contract.hostPages ?? []).map((value) => `\`${value}\``)),
      '',
      '### Slots',
      '',
      table(['Slot', 'Kind', 'Scope', 'Layouts', 'Modes', 'Props', 'Description'], slotRows()),
      '',
      '### Components',
      '',
      table(['Component', 'Layouts', 'Variants', 'Props', 'Built-in recipes'], componentRows()),
      '',
      '### Style recipe enums',
      '',
      table(['Recipe key', 'Allowed values'], recipeRows()),
    );
  }
  if (kind === 'manifest' || kind === 'agent') {
    sections.push(
      '### Permissions',
      '',
      table(['Permission', 'Scoped', 'Trusted only', 'Risk', 'Description'], permissionRows()),
      '',
      '### Events',
      '',
      table(['Event', 'Props', 'Description'], eventRows()),
      '',
      '### Limits',
      '',
      table(['Limit', 'Value'], limitRows()),
      '',
      '### UI limits',
      '',
      table(['UI limit', 'Value'], uiLimitRows()),
    );
  }
  if (kind === 'ui') {
    sections.push(
      '### Theme tokens',
      '',
      table(['Token', 'Class'], themeRows()),
      '',
      '### Icons accepted by declarative contributions',
      '',
      '`Plug`, `Puzzle`, `Sparkles`, `GitBranch`, `Globe`, `Database`, `Terminal`, `PanelRight`, `LayoutGrid`, `Wand2`, `Bot`, `Zap`, `ListChecks`, `Library`. Unknown icons fall back to `Puzzle`.',
    );
  }
  return sections.join('\n');
}

function manifestSchemaBlock() {
  return ['```json', JSON.stringify(manifestSchema, null, 2), '```'].join('\n');
}

function limitsBlock() {
  return [
    '### Package limits',
    '',
    table(['Limit', 'Value'], limitRows()),
    '',
    '### UI limits',
    '',
    table(['UI limit', 'Value'], uiLimitRows()),
  ].join('\n');
}

const BLOCKS = {
  [SKILLS.manifest]: {
    contract: () => contractBlock('manifest'),
    'manifest-schema': manifestSchemaBlock,
  },
  [SKILLS.ui]: {
    contract: () => contractBlock('ui'),
  },
  [SKILLS.genui]: {
    genui: genuiBlock,
  },
  [SKILLS.agent]: {
    contract: () => contractBlock('agent'),
  },
  [SKILLS.package]: {
    limits: limitsBlock,
  },
};

function replaceBlock(source, file, name, body) {
  const begin = `<!-- BEGIN GENERATED:${name} -->`;
  const end = `<!-- END GENERATED:${name} -->`;
  const beginIndex = source.indexOf(begin);
  const endIndex = source.indexOf(end);
  if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
    throw new Error(`${file}: missing generated markers for ${name}`);
  }
  if (source.indexOf(begin, beginIndex + 1) >= 0 || source.indexOf(end, endIndex + 1) >= 0) {
    throw new Error(`${file}: duplicated generated markers for ${name}`);
  }
  return `${source.slice(0, beginIndex + begin.length)}\n${body}\n${source.slice(endIndex)}`;
}

const check = process.argv.includes('--check');
let failed = false;
for (const [file, blocks] of Object.entries(BLOCKS)) {
  const path = join(root, file);
  const original = readFileSync(path, 'utf8');
  let next = original;
  for (const [name, build] of Object.entries(blocks)) {
    next = replaceBlock(next, file, name, build());
  }
  if (next === original) {
    console.log(`plugin-skills: ${file} up to date`);
    continue;
  }
  if (check) {
    failed = true;
    console.error(`plugin-skills: ${file} is stale (run node scripts/build-plugin-skills.mjs)`);
  } else {
    writeFileSync(path, next, 'utf8');
    console.log(`plugin-skills: wrote ${file}`);
  }
}
if (failed) process.exit(1);
