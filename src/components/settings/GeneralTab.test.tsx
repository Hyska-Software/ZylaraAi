// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Settings } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    saveSettings: mocks.saveSettings,
  },
}));

// Imported after the mock above.
import { GeneralTab } from '@/components/settings/GeneralTab';
import { useAppStore, useUiStore } from '@/lib/store';
import { i18n, setLanguage } from '@/lib/i18n';

afterEach(async () => {
  cleanup();
  await setLanguage('pt-BR', { persist: false });
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
    borderRadiusEnabled: true,
    chatExecutionAnimationEnabled: true,
    locale: 'pt-BR',
    defaultProvider: 'opencode-go',
    defaultModel: 'deepseek-v4.1-flash',
    reasoningDefault: 'max',
    systemPrompt: '',
    webSearchEnabled: true,
    fileCreationEnabled: true,
    sendKey: 'enter',
    showTokenUsage: true,
    reduceMotion: false,
    thinkingCollapsedByDefault: false,
    detailedAgentStepsEnabled: false,
    fontScale: 1,
    includeAttachments: true,
    autoTitle: true,
    codeExecutionEnabled: false,
    codeTimeoutSecs: 120,
    codePythonPath: '',
    codeNodePath: '',
    skillsPanelEnabled: true,
    disabledSkills: [],
    ...overrides,
  };
}

function thinkingSwitch(): HTMLButtonElement {
  return screen.getByRole('switch', {
    name: 'Raciocínio recolhido por padrão',
  }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
  }));
  useAppStore.setState({ settings: settings() });
  useUiStore.setState({
    theme: 'light',
    settingsOpen: true,
    enabledLayouts: { chat: true, code: true, agent: true },
  });
});

describe('GeneralTab — raciocínio recolhido por padrão', () => {
  it('mostra o switch desmarcado por padrão na seção Comportamento', () => {
    render(<GeneralTab />);

    expect(screen.getByText('Comportamento')).toBeTruthy();
    expect(screen.getByText('Raciocínio recolhido por padrão')).toBeTruthy();
    expect(
      screen.getByText(/O bloco de raciocínio e passos do agente começa fechado/),
    ).toBeTruthy();
    expect(thinkingSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('salva thinkingCollapsedByDefault: true ao ligar o switch', async () => {
    render(<GeneralTab />);

    fireEvent.click(thinkingSwitch());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ thinkingCollapsedByDefault: true }),
      );
    });
    expect(useAppStore.getState().settings.thinkingCollapsedByDefault).toBe(true);
  });

  it('com o setting ativo aparece marcado e clicar salva false', async () => {
    useAppStore.setState({
      settings: settings({ thinkingCollapsedByDefault: true }),
    });

    render(<GeneralTab />);

    expect(thinkingSwitch().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(thinkingSwitch());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ thinkingCollapsedByDefault: false }),
      );
    });
    expect(useAppStore.getState().settings.thinkingCollapsedByDefault).toBe(false);
  });
});

describe('GeneralTab — passos detalhados do agente', () => {
  function detailedStepsSwitch(): HTMLButtonElement {
    return screen.getByRole('switch', {
      name: 'Passos detalhados do agente',
    }) as HTMLButtonElement;
  }

  it('is off by default and describes the compact chat view', () => {
    render(<GeneralTab />);

    expect(screen.getByText('Passos detalhados do agente')).toBeTruthy();
    expect(
      screen.getByText(/linha do tempo expandida com detalhes por chamada/),
    ).toBeTruthy();
    expect(detailedStepsSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('saves detailedAgentStepsEnabled when toggled', async () => {
    render(<GeneralTab />);

    fireEvent.click(detailedStepsSwitch());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ detailedAgentStepsEnabled: true }),
      );
    });
    expect(useAppStore.getState().settings.detailedAgentStepsEnabled).toBe(true);
  });

  it('shows checked when enabled and saves false when turned off', async () => {
    useAppStore.setState({
      settings: settings({ detailedAgentStepsEnabled: true }),
    });

    render(<GeneralTab />);
    expect(detailedStepsSwitch().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(detailedStepsSwitch());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ detailedAgentStepsEnabled: false }),
      );
    });
  });
});

describe('GeneralTab — layouts visíveis', () => {
  it('mostra os três layouts habilitados por padrão na seção Layouts', () => {
    render(<GeneralTab />);

    expect(screen.getByText('Layouts')).toBeTruthy();
    for (const name of ['Layout Chat', 'Layout Code', 'Layout Agentes']) {
      const control = screen.getByRole('switch', { name });
      expect(control.getAttribute('aria-checked')).toBe('true');
      expect((control as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it('desabilita um layout sem salvar settings no backend', () => {
    render(<GeneralTab />);

    fireEvent.click(screen.getByRole('switch', { name: 'Layout Code' }));

    expect(useUiStore.getState().enabledLayouts.code).toBe(false);
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it('não permite desligar o último layout ativo', () => {
    useUiStore.setState({ enabledLayouts: { chat: true, code: false, agent: false } });

    render(<GeneralTab />);

    expect((screen.getByRole('switch', { name: 'Layout Chat' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('switch', { name: 'Layout Code' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});


describe('GeneralTab — interface language', () => {
  it('offers the three languages and persists the chosen locale', async () => {
    render(<GeneralTab />);

    const select = screen.getByRole('combobox', {
      name: 'Idioma da interface',
    }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['en', 'pt-BR', 'es']);

    fireEvent.change(select, { target: { value: 'es' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'es' }),
      );
    });
    expect(i18n.language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('GeneralTab — bandeja do sistema', () => {
  it('comes enabled and saves closeToTray when turned off', async () => {
    useAppStore.setState({ settings: settings({ closeToTray: true }) });

    render(<GeneralTab />);

    const control = screen.getByRole('switch', {
      name: 'Continuar em segundo plano na bandeja do sistema ao fechar a janela',
    });
    expect(control.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(control);

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ closeToTray: false }),
      );
    });
    expect(useAppStore.getState().settings.closeToTray).toBe(false);
  });
});

describe('GeneralTab — limite da compactação', () => {
  it('mostra 85% por padrão e salva a nova porcentagem', async () => {
    render(<GeneralTab />);

    expect(screen.getByText('Contexto')).toBeTruthy();
    const slider = screen.getByRole('slider', {
      name: 'Limite da compactação automática',
    }) as HTMLInputElement;
    expect(slider.value).toBe('85');
    expect(screen.getByText('85%')).toBeTruthy();

    fireEvent.change(slider, { target: { value: '70' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ compactThresholdPercent: 70 }),
      );
    });
  });
});
