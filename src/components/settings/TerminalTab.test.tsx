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
import { TerminalTab } from '@/components/settings/TerminalTab';
import { useAppStore } from '@/lib/store';
import { setLanguage } from '@/lib/i18n';

afterEach(async () => {
  cleanup();
  await setLanguage('pt-BR', { persist: false });
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
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
    fontScale: 1,
    terminalFontFamily: '',
    terminalFontSize: 12,
    includeAttachments: true,
    autoTitle: true,
    codeExecutionEnabled: false,
    codeTimeoutSecs: 120,
    codePythonPath: '',
    codeNodePath: '',
    skillsPanelEnabled: true,
    disabledSkills: [],
    codeDefaultPermissionMode: 'autonomous',
    closeToTray: true,
    closeToTrayPrompted: false,
    ...overrides,
  };
}

function familyInput(): HTMLInputElement {
  return screen.getByRole('textbox', {
    name: 'Família da fonte do terminal',
  }) as HTMLInputElement;
}

function sizeSlider(): HTMLInputElement {
  return screen.getByRole('slider', {
    name: 'Tamanho da fonte do terminal',
  }) as HTMLInputElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
  }));
  useAppStore.setState({ settings: settings() });
});

describe('TerminalTab — tipografia do terminal', () => {
  it('mostra a aparência atual do terminal', () => {
    render(<TerminalTab />);

    expect(screen.getByText('Aparência do terminal')).toBeTruthy();
    expect(familyInput().value).toBe('');
    expect(familyInput().getAttribute('placeholder')).toBe('JetBrains Mono Variable');
    expect(sizeSlider().value).toBe('12');
    expect(screen.getByText('12px')).toBeTruthy();
  });

  it('salva a família da fonte sem espaços ao sair do campo', async () => {
    render(<TerminalTab />);

    fireEvent.change(familyInput(), { target: { value: '  Fira Code  ' } });
    fireEvent.blur(familyInput());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ terminalFontFamily: 'Fira Code' }),
      );
    });
    expect(useAppStore.getState().settings.terminalFontFamily).toBe('Fira Code');
  });

  it('limpar o campo volta a usar o JetBrains Mono embutido', async () => {
    useAppStore.setState({ settings: settings({ terminalFontFamily: 'Fira Code' }) });

    render(<TerminalTab />);

    fireEvent.change(familyInput(), { target: { value: '' } });
    fireEvent.blur(familyInput());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ terminalFontFamily: '' }),
      );
    });
    expect(useAppStore.getState().settings.terminalFontFamily).toBe('');
  });

  it('salva o tamanho escolhido no slider', async () => {
    render(<TerminalTab />);

    fireEvent.change(sizeSlider(), { target: { value: '18' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ terminalFontSize: 18 }),
      );
    });
    expect(useAppStore.getState().settings.terminalFontSize).toBe(18);
    expect(screen.getByText('18px')).toBeTruthy();
  });
});
