// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import type { AcpRegistryAgent, CatalogView } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  acpListRegistry: vi.fn(),
  acpRefreshRegistry: vi.fn(),
  acpInstallAgent: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { AcpRegistryDialog } from '@/components/settings/AcpRegistryDialog';
import { setLanguage } from '@/lib/i18n';
import { useAppStore } from '@/lib/store/appStore';

function registryAgent(id: string, name: string, overrides: Partial<AcpRegistryAgent> = {}) {
  return {
    id,
    name,
    version: '1.0.0',
    description: `${name} description`,
    license: 'MIT',
    repository: `https://example.com/${id}`,
    distributions: ['binary'],
    platforms: ['windows-x86_64'],
    installed: false,
    supported: true,
    ...overrides,
  };
}

function catalogView(): CatalogView {
  return {
    catalog: { version: 1, generatedAt: '', sources: {}, providers: [] },
    keys: [],
    auth: [],
    acpAgents: [],
  };
}

beforeEach(async () => {
  await setLanguage('en', { persist: false });
  cleanup();
  vi.clearAllMocks();
  mocks.acpListRegistry.mockImplementation(async () => useAppStore.getState().acpRegistry);
  mocks.acpRefreshRegistry.mockResolvedValue([]);
  mocks.getCatalog.mockResolvedValue(catalogView());
  mocks.acpInstallAgent.mockResolvedValue({
    id: 'acp__alpha',
    registryId: 'alpha',
    name: 'Alpha Agent',
    version: '1.0.0',
    description: '',
    kind: 'binary',
    command: 'alpha',
    args: [],
    envNames: [],
    trusted: false,
    enabled: true,
    authState: 'unknown',
    modelCount: 1,
    supportsFs: false,
    supportsTerminal: false,
    supportsElicitation: false,
  });
  useAppStore.setState({ acpRegistry: [], acpAgents: [], error: null });
});

afterEach(() => cleanup());

describe('AcpRegistryDialog', () => {
  it('filters the registry by name and id', async () => {
    useAppStore.setState({
      acpRegistry: [registryAgent('alpha', 'Alpha Agent'), registryAgent('beta', 'Beta Agent')],
    });
    const user = userEvent.setup();
    render(<AcpRegistryDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText('Alpha Agent')).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Search agents' }), 'beta');

    expect(screen.getByText('Beta Agent')).toBeTruthy();
    expect(screen.queryByText('Alpha Agent')).toBeNull();
    expect(mocks.acpListRegistry).toHaveBeenCalledTimes(1);
  });

  it('requires explicit command consent before installing', async () => {
    useAppStore.setState({ acpRegistry: [registryAgent('alpha', 'Alpha Agent')] });
    const user = userEvent.setup();
    render(<AcpRegistryDialog open onOpenChange={() => {}} />);
    const install = await screen.findByRole('button', { name: 'Install' });
    expect((install as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('checkbox', { name: /reviewed the command/i }));
    expect((install as HTMLButtonElement).disabled).toBe(false);
    await user.click(install);

    await waitFor(() => expect(mocks.acpInstallAgent).toHaveBeenCalledWith('alpha', true));
    expect(toast.success).toHaveBeenCalledWith('Alpha Agent installed');
  });

  it('shows why an unsupported agent cannot be installed', async () => {
    useAppStore.setState({
      acpRegistry: [
        registryAgent('alpha', 'Alpha Agent', {
          supported: false,
          installReason: 'no-windows-build',
        }),
      ],
    });
    render(<AcpRegistryDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText('Not available on this platform')).toBeTruthy();
    expect(screen.getByText('Reason: no-windows-build')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(mocks.acpInstallAgent).not.toHaveBeenCalled();
  });
});
