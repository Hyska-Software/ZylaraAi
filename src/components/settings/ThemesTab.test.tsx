// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  confirm: vi.fn(),
  listThemes: vi.fn(),
  installTheme: vi.fn(),
  uninstallTheme: vi.fn(),
  getThemeAsset: vi.fn(),
  openThemesDir: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mocks.open,
  confirm: mocks.confirm,
}));

vi.mock('@/lib/api', () => ({
  api: {
    listThemes: mocks.listThemes,
    installTheme: mocks.installTheme,
    uninstallTheme: mocks.uninstallTheme,
    getThemeAsset: mocks.getThemeAsset,
    openThemesDir: mocks.openThemesDir,
    saveSettings: mocks.saveSettings,
  },
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

import { ThemesTab } from '@/components/settings/ThemesTab';
import { useAppStore, useThemeStore, useUiStore } from '@/lib/store';
import type { Settings, ThemeInfo } from '@/lib/types';

const BUILTIN: ThemeInfo = {
  id: 'zylara',
  name: 'Zylara',
  version: '',
  author: '',
  description: '',
  builtIn: true,
  light: { tokens: {}, wallpaper: null },
  dark: { tokens: {}, wallpaper: null },
  fonts: { sans: null, mono: null },
};

const OCEAN: ThemeInfo = {
  id: 'ocean',
  name: 'Ocean',
  version: '1.0.0',
  author: 'Jane',
  description: 'Deep blue.',
  builtIn: false,
  light: {
    tokens: {
      background: '#ffffff',
      surface: '#f5f8ff',
      foreground: '#0a1020',
      accent: '#2563eb',
      success: '#16a34a',
      danger: '#dc2626',
    },
    wallpaper: null,
  },
  dark: {
    tokens: {
      background: '#071018',
      surface: '#0b1624',
      foreground: '#e8f0ff',
      accent: '#60a5fa',
      success: '#4ade80',
      danger: '#f87171',
    },
    wallpaper: null,
  },
  fonts: { sans: null, mono: null },
};

const AURORA: ThemeInfo = {
  id: 'aurora',
  name: 'Aurora',
  version: '1.0.0',
  author: 'Zylara',
  description: 'Cool teal and indigo over airy surfaces.',
  builtIn: true,
  light: {
    tokens: {
      background: '#f5fbff',
      surface: '#eaf4fb',
      foreground: '#0a1b2a',
      accent: '#0f766e',
      success: '#15803d',
      danger: '#dc2626',
    },
    wallpaper: null,
  },
  dark: {
    tokens: {
      background: '#07141c',
      surface: '#050e14',
      foreground: '#e6f7f5',
      accent: '#2dd4bf',
      success: '#4ade80',
      danger: '#f87171',
    },
    wallpaper: null,
  },
  fonts: { sans: null, mono: null },
};

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...useAppStore.getState().settings, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
    auth: [],
    secretsError: null,
  }));
  mocks.uninstallTheme.mockResolvedValue([BUILTIN]);
  mocks.listThemes.mockResolvedValue([OCEAN]);
  useAppStore.setState({ settings: settings({ themeId: 'zylara' }) });
  useUiStore.setState({ theme: 'light', settingsOpen: true });
  useThemeStore.setState({
    themes: [BUILTIN, OCEAN],
    activeId: 'zylara',
    ready: true,
    error: null,
  });
});

afterEach(() => cleanup());

describe('ThemesTab', () => {
  it('renders the built-in theme and installed packages', () => {
    render(<ThemesTab />);

    expect(screen.getByText('Zylara')).toBeTruthy();
    expect(screen.getByText('Ocean')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remover o tema Zylara' })).toBeNull();
  });

  it('renders bundled built-ins with swatches and no remove action', () => {
    useThemeStore.setState({ themes: [BUILTIN, AURORA, OCEAN] });
    render(<ThemesTab />);

    expect(screen.getByText('Aurora')).toBeTruthy();
    expect(
      screen.getByText('Verde-azulado e índigo sobre superfícies claras e frias.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remover o tema Aurora' })).toBeNull();
  });

  it('activates a theme and persists its id', async () => {
    const user = userEvent.setup();
    render(<ThemesTab />);

    const card = screen.getByText('Ocean').closest('article');
    expect(card).not.toBeNull();
    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Usar' }));

    await waitFor(() => expect(useThemeStore.getState().activeId).toBe('ocean'));
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: 'ocean' }),
    );
  });

  it('disables border radius and persists the preference', async () => {
    const user = userEvent.setup();
    render(<ThemesTab />);

    const control = screen.getByRole('switch', { name: 'Alternar bordas arredondadas' });
    expect(control.getAttribute('aria-checked')).toBe('true');
    await user.click(control);

    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ borderRadiusEnabled: false }),
    );
  });

  it('installs a package through the file dialog', async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue('C:/tmp/ocean.zip');
    mocks.installTheme.mockResolvedValue({ theme: OCEAN, replaced: false });
    render(<ThemesTab />);

    await user.click(screen.getByRole('button', { name: /Instalar tema/ }));

    await waitFor(() => expect(mocks.installTheme).toHaveBeenCalledWith('C:/tmp/ocean.zip'));
    expect(mocks.listThemes).toHaveBeenCalled();
  });

  it('removes the active theme and falls back to Zylara', async () => {
    const user = userEvent.setup();
    mocks.confirm.mockResolvedValue(true);
    useThemeStore.setState({ activeId: 'ocean' });
    render(<ThemesTab />);

    await user.click(screen.getByRole('button', { name: 'Remover o tema Ocean' }));

    await waitFor(() => expect(mocks.uninstallTheme).toHaveBeenCalledWith('ocean'));
    await waitFor(() => expect(useThemeStore.getState().activeId).toBe('zylara'));
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: 'zylara' }),
    );
  });

  it('renders a plugin theme with a badge and without a remove action', async () => {
    const user = userEvent.setup();
    const pluginTheme: ThemeInfo = {
      ...OCEAN,
      id: 'plugin-0123456789abcdef',
      name: 'Acme paper',
      author: 'Acme',
      description: 'Paper palette.',
      pluginId: 'com.acme.notes',
      pluginName: 'Acme Notes',
    };
    useThemeStore.setState({
      hostThemes: [BUILTIN, OCEAN],
      pluginThemes: [pluginTheme],
      themes: [BUILTIN, OCEAN, pluginTheme],
      activeId: 'zylara',
      ready: true,
    });

    render(<ThemesTab />);

    expect(screen.getByText('Acme paper')).toBeTruthy();
    expect(screen.getByText('Plugin')).toBeTruthy();
    expect(screen.getByText(/Do plugin Acme Notes/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Remover o tema Acme paper' }),
    ).toBeNull();

    const card = screen.getByText('Acme paper').closest('article');
    await user.click(within(card as HTMLElement).getByRole('button', { name: 'Usar' }));

    await waitFor(() =>
      expect(useThemeStore.getState().activeId).toBe(pluginTheme.id),
    );
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ themeId: pluginTheme.id }),
    );
  });
});
