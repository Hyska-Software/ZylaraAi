// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMocks }));

import { ExperimentalTab } from './ExperimentalTab';
import { useAppStore } from '@/lib/store';
import type { Settings } from '@/lib/types';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    pluginsEnabled: true,
    reasoningSliderEnabled: false,
    enabledExperimentalFeatures: {},
    ...overrides,
  } as unknown as Settings;
}

beforeEach(() => {
  apiMocks.saveSettings.mockReset();
  apiMocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
    auth: [],
  }));
  apiMocks.getCatalog.mockReset();
  apiMocks.getCatalog.mockResolvedValue({ catalog: { providers: [] }, keys: [], auth: [] });
  useAppStore.setState({ ready: true, settings: settings(), providers: [] });
});

afterEach(cleanup);

describe('ExperimentalTab', () => {
  it('lists only experimental features with accessible switches', () => {
    render(<ExperimentalTab />);

    expect(screen.getByRole('note', { name: 'Experimental' })).toBeTruthy();
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    expect(screen.getByRole('switch', { name: 'Agentes ACP' })).toBeTruthy();
    expect(screen.getByText('Recursos experimentais')).toBeTruthy();
  });

  it('persists a new opt-in in the flag map and refreshes the catalog for ACP', async () => {
    const user = userEvent.setup();
    render(<ExperimentalTab />);

    await user.click(screen.getByRole('switch', { name: 'Agentes ACP' }));

    expect(apiMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabledExperimentalFeatures: { acpAgents: true } }),
    );
    expect(apiMocks.getCatalog).toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Agentes ACP' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('keeps a legacy field in sync when toggling the reasoning slider', async () => {
    const user = userEvent.setup();
    render(<ExperimentalTab />);

    await user.click(screen.getByRole('switch', { name: 'Controle de raciocínio' }));

    expect(apiMocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningSliderEnabled: true,
        enabledExperimentalFeatures: expect.objectContaining({ reasoningSlider: true }),
      }),
    );
  });
});
