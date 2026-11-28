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

import { EditorTab } from './EditorTab';
import { useAppStore, useUiStore } from '@/lib/store';
import { setLanguage } from '@/lib/i18n';

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
    fontScale: 1,
    terminalFontFamily: '',
    terminalFontSize: 12,
    editorTheme: 'app',
    editorFontFamily: '',
    editorFontSize: 12,
    editorLineHeight: 1.7,
    editorTabSize: 2,
    editorLineNumbers: true,
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

function slider(name: string): HTMLInputElement {
  return screen.getByRole('slider', { name }) as HTMLInputElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
  }));
  useAppStore.setState({ settings: settings() });
  useUiStore.setState({ codeFileWrap: false });
});

afterEach(async () => {
  cleanup();
  await setLanguage('pt-BR', { persist: false });
});

describe('EditorTab — file viewer preferences', () => {
  it('shows the current typography and palette', () => {
    render(<EditorTab />);

    expect(screen.getByText('Visualizador de arquivos')).toBeTruthy();
    expect(screen.getByText('Leitura')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Seguir o app' }).getAttribute('data-state')).toBe('checked');
    expect(
      (screen.getByRole('textbox', { name: 'Família da fonte do visualizador de arquivos' }) as HTMLInputElement).value,
    ).toBe('');
    expect(slider('Tamanho da fonte do visualizador de arquivos').value).toBe('12');
    expect(slider('Altura da linha do visualizador de arquivos').value).toBe('1.7');
    expect(slider('Largura da tabulação do visualizador de arquivos').value).toBe('2');
    expect(
      screen.getByRole('switch', {
        name: 'Mostrar números de linha nas visualizações de arquivo e diff',
      }).getAttribute('data-state'),
    ).toBe('checked');
  });

  it('saves the viewer theme mode', async () => {
    render(<EditorTab />);

    fireEvent.click(screen.getByRole('radio', { name: 'Escuro' }));

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorTheme: 'dark' }),
      );
    });
  });

  it('commits a custom font family on blur', async () => {
    render(<EditorTab />);
    const input = screen.getByRole('textbox', {
      name: 'Família da fonte do visualizador de arquivos',
    });

    fireEvent.change(input, { target: { value: '  Fira Code, monospace  ' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorFontFamily: 'Fira Code, monospace' }),
      );
    });
  });

  it('saves clamped typography values from the sliders', async () => {
    render(<EditorTab />);

    fireEvent.change(slider('Tamanho da fonte do visualizador de arquivos'), { target: { value: '18' } });
    fireEvent.change(slider('Altura da linha do visualizador de arquivos'), { target: { value: '2' } });
    fireEvent.change(slider('Largura da tabulação do visualizador de arquivos'), { target: { value: '4' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorFontSize: 18 }),
      );
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorLineHeight: 2 }),
      );
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorTabSize: 4 }),
      );
    });
  });

  it('saves the line-number switch and toggles the shared wrap preference', async () => {
    render(<EditorTab />);

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Mostrar números de linha nas visualizações de arquivo e diff',
      }),
    );
    fireEvent.click(
      screen.getByRole('switch', { name: 'Quebrar linhas longas nas visualizações de arquivo' }),
    );

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorLineNumbers: false }),
      );
    });
    expect(useUiStore.getState().codeFileWrap).toBe(true);
  });

  it('saves the indentation preferences', async () => {
    render(<EditorTab />);

    fireEvent.click(screen.getByRole('switch', { name: 'Indentar com espaços' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Fechar colchetes e aspas automaticamente' }));

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorInsertSpaces: false }),
      );
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorAutoCloseBrackets: false }),
      );
    });
  });

  it('saves the auto save mode and its delay', async () => {
    render(<EditorTab />);

    fireEvent.click(screen.getByRole('radio', { name: 'Após uma pausa' }));

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorAutoSave: 'delay' }),
      );
    });

    fireEvent.change(slider('Atraso do salvamento automático'), { target: { value: '1500' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorAutoSaveDelay: 1500 }),
      );
    });
  });

  it('saves the formatting switches and the highlight preferences', async () => {
    render(<EditorTab />);

    fireEvent.click(screen.getByRole('switch', { name: 'Remover espaços ao final ao salvar' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Inserir uma nova linha final ao salvar' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Realçar a sintaxe no editor' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Ativar ligaduras da fonte no editor' }));

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorTrimTrailingWhitespace: true }),
      );
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorInsertFinalNewline: false }),
      );
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorHighlight: false }),
      );
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ editorFontLigatures: true }),
      );
    });
  });

  it('restores the editor defaults', async () => {
    useAppStore.setState({
      settings: settings({
        editorAutoSave: 'blur',
        editorTrimTrailingWhitespace: true,
        editorHighlight: false,
      }),
    });
    render(<EditorTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar padrões do editor' }));

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          editorAutoSave: 'off',
          editorTrimTrailingWhitespace: false,
          editorHighlight: true,
        }),
      );
    });
  });
});
