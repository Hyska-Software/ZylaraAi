// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const skillsRoot = join(repoRoot, 'src-tauri', 'skills');
const readJson = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));

const PLUGIN_SKILLS = readdirSync(skillsRoot)
  .filter((name) => name.startsWith('plugin-'))
  .sort();

const skillBody = (name: string) => readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');

const allBodies = () => PLUGIN_SKILLS.map((name) => skillBody(name)).join('\n');

const REQUIRED_ACTIONS = [
  'openView',
  'openPage',
  'openPanel',
  'openPanelTab',
  'setLayout',
  'openSettings',
  'setVariant',
  'setPreset',
  'insertDraft',
  'openExternal',
  'execute',
];

const REQUIRED_RPC = [
  'ping',
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.list',
  'settings.get',
  'settings.set',
  'settings.all',
  'secrets.has',
  'secrets.names',
  'net.request',
  'chat.read',
  'chat.list',
  'log',
  'notify',
  'opener.open',
  'clipboard.read',
  'fs.read',
  'fs.write',
  'fs.list',
];

const REQUIRED_HOST_MEMBERS = [
  'registerPlugin',
  'registerComponent',
  'registerView',
  'registerPanel',
  'registerSlot',
  'registerSettingsTab',
  'registerArtifactViewer',
  'replaceComponent',
  'wrapComponent',
  'replaceShell',
  'addGlobalCss',
  'registerToolHandler',
  'registerCommandHandler',
  'registerSlot',
  'replace',
  'wrap',
  'registerVariant',
  'registerPreset',
  'registerPage',
  'registerPanelTab',
  'registerSettingsTab',
  'registerNav',
  'registerGenuiComponent',
  'addCss',
  'openPage',
  'openPanelTab',
  'closePanelTab',
  'setLayout',
  'openSettings',
  'toast',
  'inspect',
  'openView',
  'openPanel',
  'closeOverlays',
  'layoutMode',
  'stores',
  'notify',
  'log',
];

const FORBIDDEN = [
  'data/plugin-contract.json',
  'data/plugin-manifest.schema.json',
  'docs/PLUGINS.md',
  'plugins/fixtures',
  'scripts/plugin/cli.mjs',
  'packages/create-zylara-plugin',
];

describe('bundled plugin skills', () => {
  it('keeps the generated blocks current', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/build-plugin-skills.mjs', '--check'], {
        cwd: repoRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('has valid frontmatter, names and sizes', () => {
    for (const name of PLUGIN_SKILLS) {
      const body = skillBody(name).replaceAll('\r\n', '\n');
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? '';
      const declared = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
      const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? '';
      expect(declared, `${name} name`).toBe(name);
      expect(description.length, `${name} description`).toBeGreaterThan(0);
      expect(description.length, `${name} description cap`).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(body), `${name} body cap`).toBeLessThanOrEqual(512 * 1024);
    }
  });

  it('does not point the agent at repository documentation or scripts', () => {
    const body = allBodies();
    for (const forbidden of FORBIDDEN) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('covers every contract id and recipe value', () => {
    const body = allBodies();
    const contract = readJson('data/plugin-contract.json');
    const reservedSlots = new Set<string>(contract.reservedSlots ?? []);
    const ids = [
      ...(contract.slots ?? [])
        .filter((entry: { id: string }) => !reservedSlots.has(entry.id))
        .map((entry: { id: string }) => entry.id),
      ...(contract.components ?? []).map((entry: { id: string }) => entry.id),
      ...(contract.permissions ?? []).map((entry: { id: string }) => entry.id),
      ...(contract.events ?? []).map((entry: { name: string }) => entry.name),
    ];
    for (const id of ids) expect(body, `missing contract id ${id}`).toContain(id);
    for (const [key, values] of Object.entries(contract.styleRecipes ?? {})) {
      expect(body, `missing recipe key ${key}`).toContain(key);
      for (const value of values as string[]) expect(body, `missing recipe value ${value}`).toContain(value);
    }
  });

  it('covers the manifest schema fields', () => {
    const schema = readJson('data/plugin-manifest.schema.json');
    const body = allBodies();
    for (const field of Object.keys(schema.properties ?? {})) {
      expect(body, `missing manifest field ${field}`).toContain(field);
    }
  });

  it('covers every GenUI component type', () => {
    const genui = readJson('data/genui-contract.json');
    const body = allBodies();
    for (const component of genui.components ?? []) {
      expect(body, `missing GenUI type ${component.type}`).toContain(component.type);
    }
  });

  it('covers actions, RPC and trusted host members', () => {
    const body = allBodies();
    for (const action of REQUIRED_ACTIONS) expect(body, action).toContain(action);
    for (const rpc of REQUIRED_RPC) expect(body, rpc).toContain(rpc);
    for (const member of REQUIRED_HOST_MEMBERS) expect(body, member).toContain(member);
  });

  it('keeps every plugin skill readable by read_skill', () => {
    for (const name of PLUGIN_SKILLS) {
      expect(statSync(join(skillsRoot, name, 'SKILL.md')).isFile()).toBe(true);
    }
  });
});
