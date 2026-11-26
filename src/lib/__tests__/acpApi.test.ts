// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  Channel: class {},
}));

import { api } from '@/lib/api';

describe('ACP command argument contract', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it('sends install arguments flat, matching the Rust command parameters', async () => {
    await api.acpInstallAgent('gemini-cli', true);
    expect(mocks.invoke).toHaveBeenCalledWith('acp_install_agent', {
      registryId: 'gemini-cli',
      acceptCommand: true,
    });
  });

  it('sends custom-agent arguments flat, matching the Rust command parameters', async () => {
    const input = {
      name: 'Local Agent',
      command: 'C:\\agents\\local.exe',
      args: ['--stdio'],
      env: { MODE: 'acp' },
      cwd: 'C:\\work',
    };
    await api.acpAddCustomAgent(input);
    expect(mocks.invoke).toHaveBeenCalledWith('acp_add_custom_agent', input);
  });
});
