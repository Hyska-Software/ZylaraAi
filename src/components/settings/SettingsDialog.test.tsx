// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  api: {
    openDataDir: vi.fn(),
    resetAppData: vi.fn(),
    getCodeEnvironment: vi.fn().mockResolvedValue(null),
  },
}));

import { SettingsDialog } from './SettingsDialog';
import { useUiStore } from '@/lib/store';

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

beforeEach(() => {
  useUiStore.setState({ settingsOpen: true, settingsTab: 'data' });
});

afterEach(() => {
  cleanup();
});

describe('SettingsDialog — aba controlada pelo uiStore (deep-link da paleta)', () => {
  it('renders a larger dialog clamped to the window', () => {
    render(<SettingsDialog />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('w-[min(1120px,calc(100vw-2rem))]');
    expect(dialog.className).toContain('h-[min(780px,calc(100dvh-2rem))]');
  });

  it('opens on the tab requested by the store', () => {
    render(<SettingsDialog />);

    expect(tab('Dados').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Pasta de dados')).not.toBeNull();
  });

  it('follows external tab changes (paleta abrindo em Configurações › Ferramentas)', () => {
    render(<SettingsDialog />);

    act(() => {
      useUiStore.getState().setSettingsTab('tools');
    });

    expect(tab('Ferramentas').getAttribute('aria-selected')).toBe('true');
  });

  it('writes the selected tab back to the store', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(tab('Sobre'));

    expect(useUiStore.getState().settingsTab).toBe('about');
  });

  it('opens the Agentes tab with the agent settings sections', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(tab('Agentes'));

    expect(useUiStore.getState().settingsTab).toBe('agents');
    expect(await screen.findByText('Desktop privado (computer use)')).not.toBeNull();
  });

  it('opens the Terminal tab with the terminal appearance sections', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(tab('Terminal'));

    expect(useUiStore.getState().settingsTab).toBe('terminal');
    expect(await screen.findByText('Aparência do terminal')).not.toBeNull();
  });

  it('opens the Editor tab with the file viewer settings', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(tab('Editor'));

    expect(useUiStore.getState().settingsTab).toBe('editor');
    expect(await screen.findByText('Visualizador de arquivos')).not.toBeNull();
  });

  it('opens the Experimental tab with the opt-in switches', async () => {
    const user = userEvent.setup();
    render(<SettingsDialog />);

    await user.click(tab('Experimental'));

    expect(useUiStore.getState().settingsTab).toBe('experimental');
    expect(await screen.findByText('Recursos experimentais')).not.toBeNull();
  });
});
