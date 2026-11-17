import { describe, expect, it } from 'vitest';

import {
  PLUGIN_PERMISSIONS,
  PLUGIN_RESERVED_PERMISSIONS,
} from '@/lib/plugins/contract';
import { pluginHasPermission } from '@/lib/plugins/registry';
import type { PluginPermissionView, PluginRecord } from '@/lib/plugins/types';

/** Every declared permission must name where the host enforces it. Keeping the
 * table next to the test fails the suite when the contract grows a permission
 * without an implementation. */
const ENFORCED: Record<string, string> = {
  'ui.slot': 'manifest `ui.slot:<slot>` + Slot contribution filter',
  'ui.view': 'registry page projection',
  'ui.nav': 'registry nav projection',
  'ui.panel': 'registry dock-tab projection',
  'ui.settings': 'registry settings-tab projection',
  'ui.command': 'registry command projection + host `execute`',
  'ui.artifact': 'registry artifact-viewer projection',
  'ui.sidebar': 'registry sidebar-tab projection',
  'ui.variant': 'trusted `ui.variant` + registry variants',
  'ui.preset': 'host `setPreset` action',
  'ui.genui': 'plugin genui components registry',
  'ui.override': '`ComponentSlot` override gate',
  'ui.css.global': 'trusted `addCss`/`addGlobalCss`',
  'ui.shell': 'trusted `replaceShell`',
  'ui.theme': 'theme projection + plugin-wide grant gate',
  commands: 'host `execute` action',
  hotkeys: 'manifest hotkey declaration',
  settings: 'broker `settings.*`',
  'agent.tools': 'tool catalog + dispatch (Rust)',
  'agent.prompt': 'prompt block (Rust)',
  'agent.skills': 'skill roots (Rust)',
  'agent.modes': 'mode registry (Rust)',
  'agent.templates': 'template registry (Rust)',
  'chat.read': 'broker `chat.read` (Rust)',
  'chat.write': 'broker `chat.draft` (Rust)',
  'fs.read': 'broker `fs.read` (Rust)',
  'fs.write': 'broker `fs.write` (Rust)',
  net: 'broker `net.request` (Rust)',
  'secrets.use': 'broker `secrets.*` (Rust)',
  'secrets.read': 'broker `secrets.read` (Rust)',
  storage: 'broker `storage.*` (Rust)',
  events: 'renderer event bridge scope check',
  'clipboard.read': 'broker `clipboard.read` (Rust)',
  notifications: 'broker `notify` (Rust)',
  opener: 'broker `opener.open` + host `openExternal`',
  providers: 'plugin provider registry (Rust)',
  'unsafe.renderer': 'manifest trusted gate + trusted loader',
};

function record(permissions: Array<{ id: string; granted: boolean }>): PluginRecord {
  return {
    id: 'com.acme.notes',
    name: 'Acme Notes',
    permissions: permissions.map(
      (permission) =>
        ({
          id: permission.id,
          granted: permission.granted,
          risk: 'low',
          scoped: permission.id.includes(':'),
          description: '',
          trustedOnly: false,
        }) satisfies PluginPermissionView,
    ),
  } as unknown as PluginRecord;
}

describe('permission matrix', () => {
  it('declares an enforcement site for every permission in the contract', () => {
    const declared = PLUGIN_PERMISSIONS.map((permission) => permission.id).sort();
    const documented = Object.keys(ENFORCED).sort();
    expect(documented).toEqual(declared);
  });

  it('keeps reserved permissions out of the declared catalog', () => {
    const declared = new Set(PLUGIN_PERMISSIONS.map((permission) => permission.id));
    for (const reserved of PLUGIN_RESERVED_PERMISSIONS) {
      expect(declared.has(reserved)).toBe(false);
    }
  });

  it('denies an ungranted permission', () => {
    const plugin = record([{ id: 'ui.view', granted: false }]);
    expect(pluginHasPermission(plugin, 'ui.view')).toBe(false);
  });

  it('accepts exact, scoped and wildcard grants', () => {
    const exact = record([{ id: 'ui.slot:palette.actions', granted: true }]);
    expect(pluginHasPermission(exact, 'ui.slot:palette.actions')).toBe(true);
    expect(pluginHasPermission(exact, 'ui.slot:chat.header.actions')).toBe(false);
    const wildcard = record([{ id: 'net:*', granted: true }]);
    expect(pluginHasPermission(wildcard, 'net:api.example.com')).toBe(true);
    const provider = record([{ id: 'providers', granted: true }]);
    expect(pluginHasPermission(provider, 'providers')).toBe(true);
    expect(pluginHasPermission(provider, 'storage')).toBe(false);
  });
});
