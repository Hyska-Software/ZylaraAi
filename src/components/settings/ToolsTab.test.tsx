// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CodeEnvironmentStatus, Settings } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  getCodeEnvironment: vi.fn(),
  openSkillsDir: vi.fn(),
  dockerPullImage: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    saveSettings: mocks.saveSettings,
    getCodeEnvironment: mocks.getCodeEnvironment,
    openSkillsDir: mocks.openSkillsDir,
    dockerPullImage: mocks.dockerPullImage,
  },
}));

// Imported after the mock above.
import { i18n } from '@/lib/i18n';
import { AUTONOMOUS_MODE_WARNING_KEY } from '@/lib/permissionModes';

const AUTONOMOUS_MODE_WARNING = i18n.t('code:permissions.autonomousWarning');
import { ToolsTab } from '@/components/settings/ToolsTab';
import { useAppStore, useUiStore } from '@/lib/store';

afterEach(() => cleanup());

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
    borderRadiusEnabled: true,
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

function codeEnvironment(overrides: Partial<CodeEnvironmentStatus> = {}): CodeEnvironmentStatus {
  return {
    enabled: true,
    python: { path: 'C:\\Python312\\python.exe', version: '3.12.4', source: 'path' },
    node: {
      path: 'C:\\Program Files\\nodejs\\node.exe',
      version: 'v24.20.0',
      source: 'settings',
    },
    packages: [
      { name: 'python-docx', available: true },
      { name: 'openpyxl', available: false },
    ],
    installHint: 'pip install python-docx openpyxl',
    skills: [
      {
        name: 'office-docx',
        description: 'Criar documentos Word (.docx) com script Python stdlib.',
        source: 'bundled',
        enabled: true,
        deletable: false,
      },
      {
        name: 'relatorios',
        description: 'Padrão da empresa para relatórios internos.',
        source: 'user',
        enabled: false,
        deletable: true,
      },
      {
        name: 'git-helper',
        description: 'Fluxo de revisão de código do repositório compartilhado.',
        source: 'agents',
        enabled: true,
        deletable: false,
      },
    ],
    ...overrides,
  };
}

function timeoutSlider(): HTMLInputElement {
  return screen.getByLabelText('Tempo limite de execução') as HTMLInputElement;
}

function codeSwitch(): HTMLButtonElement {
  return screen.getByRole('switch', { name: 'Ativar execução de código' }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
  }));
  // Keep the environment pending by default: tab tests that do not care about
  // it must not get asynchronous state updates.
  mocks.getCodeEnvironment.mockReturnValue(new Promise(() => undefined));
  mocks.openSkillsDir.mockResolvedValue(undefined);
  useAppStore.setState({ settings: settings() });
  useUiStore.setState({ activeView: 'chat', settingsOpen: false });
});

describe('ToolsTab — execução', () => {
  it('não expõe limites de passos nem temperatura', () => {
    render(<ToolsTab />);

    expect(screen.queryByText('Máximo de passos')).toBeNull();
    expect(screen.queryByText('Personalizar temperatura')).toBeNull();
  });
});

describe('ToolsTab — execução de código', () => {
  it('mostra o aviso de risco e liga a execução de código', async () => {
    render(<ToolsTab />);

    expect(screen.getByText(/não é um sandbox de sistema/)).toBeTruthy();
    expect(codeSwitch().getAttribute('aria-checked')).toBe('false');

    fireEvent.click(codeSwitch());

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeExecutionEnabled: true }),
      );
    });
    expect(useAppStore.getState().settings.codeExecutionEnabled).toBe(true);
  });

  it('salva o tempo limite de execução ao soltar o slider', async () => {
    render(<ToolsTab />);

    const slider = timeoutSlider();
    expect(slider.value).toBe('120');
    expect(slider.min).toBe('10');
    expect(slider.max).toBe('600');
    expect(slider.step).toBe('10');
    expect(screen.getByText(/após 120 segundos/)).toBeTruthy();

    fireEvent.change(slider, { target: { value: '300' } });
    fireEvent.pointerUp(slider);

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeTimeoutSecs: 300 }),
      );
    });
    expect(useAppStore.getState().settings.codeTimeoutSecs).toBe(300);
    expect(screen.getByText(/após 300 segundos/)).toBeTruthy();
  });
});

describe('ToolsTab — sandbox de comandos', () => {
  it('salva o ambiente Docker, a imagem e a opção de rede', async () => {
    render(<ToolsTab />);
    fireEvent.change(screen.getByLabelText('Ambiente de execução dos comandos do agente'), {
      target: { value: 'docker' },
    });
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ executionEnvironment: 'docker' }),
      ),
    );

    const image = await screen.findByLabelText('Imagem Docker dos comandos do agente');
    fireEvent.change(image, { target: { value: 'python:3.12' } });
    fireEvent.blur(image);
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ dockerImage: 'python:3.12' }),
      ),
    );

    fireEvent.click(
      screen.getByRole('switch', { name: 'Permitir rede no contêiner Docker' }),
    );
    await waitFor(() =>
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ dockerNetwork: true }),
      ),
    );
  });
});

describe('ToolsTab — ambiente de código', () => {
  it('mostra o carregamento enquanto verifica o ambiente', () => {
    render(<ToolsTab />);

    expect(screen.getByText('Verificando ambiente…')).toBeTruthy();
  });

  it('lista interpretadores, pacotes, instalação e skills', async () => {
    mocks.getCodeEnvironment.mockResolvedValue(codeEnvironment());

    render(<ToolsTab />);

    expect(await screen.findByText('3.12.4 · detectado no PATH')).toBeTruthy();
    expect(screen.getByText('C:\\Python312\\python.exe')).toBeTruthy();
    expect(screen.getByText('v24.20.0 · caminho configurado')).toBeTruthy();
    expect(screen.getByText('python-docx')).toBeTruthy();
    expect(screen.getByText('openpyxl')).toBeTruthy();
    expect(screen.getByText('pip install python-docx openpyxl')).toBeTruthy();
    // Skills: contagem total e por origem (incluindo externas) + rótulos.
    expect(screen.getByText('3 skills')).toBeTruthy();
    expect(screen.getByText('1 do Zylara')).toBeTruthy();
    expect(screen.getByText('1 externa')).toBeTruthy();
    expect(screen.getByText('1 embutida')).toBeTruthy();
    expect(screen.getByText('Documentos Word')).toBeTruthy();
    expect(screen.getByText(/Cria documentos Word/)).toBeTruthy();
    expect(screen.getByText('relatorios')).toBeTruthy();
    expect(screen.getByText(/Padrão da empresa/)).toBeTruthy();
    expect(screen.getByText('git-helper')).toBeTruthy();
    expect(screen.getByText(/Fluxo de revisão/)).toBeTruthy();
    expect(screen.getByText('Agentes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir pasta de skills' })).toBeTruthy();
  });

  it('recarrega o ambiente ao clicar em verificar novamente', async () => {
    mocks.getCodeEnvironment.mockResolvedValue(codeEnvironment());

    render(<ToolsTab />);
    expect(await screen.findByText('3.12.4 · detectado no PATH')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));

    await waitFor(() => expect(mocks.getCodeEnvironment).toHaveBeenCalledTimes(2));
  });

  it('mostra o erro e permite verificar novamente', async () => {
    mocks.getCodeEnvironment
      .mockRejectedValueOnce(new Error('comando indisponível'))
      .mockResolvedValueOnce(codeEnvironment());

    render(<ToolsTab />);

    expect(await screen.findByText('Não foi possível verificar o ambiente')).toBeTruthy();
    expect(screen.getByText('comando indisponível')).toBeTruthy();
    expect(screen.getByText(/Não foi possível carregar as skills/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Verificar novamente' }));

    expect(await screen.findByText('3.12.4 · detectado no PATH')).toBeTruthy();
    expect(mocks.getCodeEnvironment).toHaveBeenCalledTimes(2);
  });

  it('mostra estados vazios quando nada é detectado', async () => {
    mocks.getCodeEnvironment.mockResolvedValue(
      codeEnvironment({ python: null, node: null, packages: [], installHint: '', skills: [] }),
    );

    render(<ToolsTab />);

    expect(await screen.findByText('Nenhuma skill encontrada.')).toBeTruthy();
    expect(screen.getByText('0 skills')).toBeTruthy();
    expect(screen.queryByText(/externa/)).toBeNull();
    expect(screen.getByText('Nenhum pacote opcional verificado.')).toBeTruthy();
    expect(screen.getAllByText('Não encontrado')).toHaveLength(2);
  });

  it('abre a pasta de skills', async () => {
    mocks.getCodeEnvironment.mockResolvedValue(codeEnvironment());

    render(<ToolsTab />);
    await screen.findByText('3.12.4 · detectado no PATH');

    fireEvent.click(screen.getByRole('button', { name: 'Abrir pasta de skills' }));

    await waitFor(() => expect(mocks.openSkillsDir).toHaveBeenCalledTimes(1));
  });
});

describe('ToolsTab — painel de skills', () => {
  it('salva a preferência do painel de skills na barra lateral', async () => {
    render(<ToolsTab />);

    const toggle = screen.getByRole('switch', {
      name: 'Mostrar painel de skills na barra lateral',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ skillsPanelEnabled: false }),
      );
    });
    expect(useAppStore.getState().settings.skillsPanelEnabled).toBe(false);
  });

  it('leva ao gerenciamento de skills como view principal e fecha as configurações', async () => {
    mocks.getCodeEnvironment.mockResolvedValue(codeEnvironment());
    useUiStore.setState({ activeView: 'chat', settingsOpen: true });

    render(<ToolsTab />);
    await screen.findByText('3.12.4 · detectado no PATH');

    fireEvent.click(screen.getByRole('button', { name: 'Gerenciar skills' }));

    expect(useUiStore.getState().activeView).toBe('skills');
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  it('marca as skills desativadas na lista', async () => {
    mocks.getCodeEnvironment.mockResolvedValue(codeEnvironment());

    render(<ToolsTab />);

    expect(await screen.findByText('Desativada')).toBeTruthy();
    expect(screen.getAllByText('Desativada')).toHaveLength(1);
  });
});

describe('ToolsTab — sessões de código', () => {
  const permissionSelect = (): HTMLSelectElement =>
    screen.getByRole('combobox', {
      name: 'Modo de permissão padrão das novas sessões do Code',
    }) as HTMLSelectElement;

  it('novas sessões do Code começam em Autônomo por padrão', () => {
    render(<ToolsTab />);

    const select = permissionSelect();
    expect(select.value).toBe('autonomous');
    // Opções do chip de permissão, da mais restrita à mais ampla.
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'read_only',
      'review',
      'edit',
      'autonomous',
    ]);
  });

  it('reflete o modo padrão configurado nas settings', () => {
    useAppStore.setState({ settings: settings({ codeDefaultPermissionMode: 'review' }) });

    render(<ToolsTab />);

    expect(permissionSelect().value).toBe('review');
  });

  it('avisa que o padrão Autônomo não pede confirmação e esconde o aviso fora dele', async () => {
    render(<ToolsTab />);

    expect(screen.getByText(AUTONOMOUS_MODE_WARNING)).toBeTruthy();

    fireEvent.change(permissionSelect(), { target: { value: 'read_only' } });

    await waitFor(() => {
      expect(useAppStore.getState().settings.codeDefaultPermissionMode).toBe('read_only');
    });
    expect(screen.queryByText(AUTONOMOUS_MODE_WARNING)).toBeNull();
  });

  it('salva o modo escolhido para as próximas sessões do Code', async () => {
    render(<ToolsTab />);

    fireEvent.change(permissionSelect(), { target: { value: 'read_only' } });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ codeDefaultPermissionMode: 'read_only' }),
      );
    });
    expect(useAppStore.getState().settings.codeDefaultPermissionMode).toBe('read_only');
  });

  it('abre o diff em uma aba do chat por padrão', () => {
    render(<ToolsTab />);

    const select = screen.getByRole('combobox', { name: 'Onde abrir o diff dos arquivos' }) as HTMLSelectElement;
    expect(select.value).toBe('tab');
    expect(screen.getByRole('option', { name: 'Em uma aba do chat (padrão)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'No painel lateral' })).toBeTruthy();
  });

  it('salva a preferência de abrir o diff no painel lateral', async () => {
    render(<ToolsTab />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Onde abrir o diff dos arquivos' }), {
      target: { value: 'panel' },
    });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ diffOpenMode: 'panel' }),
      );
    });
    expect(useAppStore.getState().settings.diffOpenMode).toBe('panel');
  });
});

describe('ToolsTab — cache de prompt', () => {
  it('mostra a seção com indicador, TTL da Anthropic e retenção da OpenAI', () => {
    render(<ToolsTab />);

    expect(screen.getByText('Cache de prompt')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Mostrar indicador de cache' })).toBeTruthy();
    expect(screen.getByLabelText('TTL do cache da Anthropic')).toBeTruthy();
    expect(screen.getByLabelText('Retenção do cache da OpenAI')).toBeTruthy();
  });

  it('reflete os valores atuais de Settings.cache', () => {
    useAppStore.setState({
      settings: settings({
        cache: { showIndicator: false, anthropicTtl: '5m', openaiRetention: '24h' },
      }),
    });
    render(<ToolsTab />);

    expect(
      screen.getByRole('switch', { name: 'Mostrar indicador de cache' }).getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    expect(
      (screen.getByLabelText('TTL do cache da Anthropic') as HTMLSelectElement).value,
    ).toBe('5m');
    expect(
      (screen.getByLabelText('Retenção do cache da OpenAI') as HTMLSelectElement).value,
    ).toBe('24h');
  });

  it('liga/desliga o indicador salvando o objeto CacheSettings completo', async () => {
    render(<ToolsTab />);

    fireEvent.click(screen.getByRole('switch', { name: 'Mostrar indicador de cache' }));

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          cache: { showIndicator: false, anthropicTtl: '1h', openaiRetention: null },
        }),
      );
    });
    expect(useAppStore.getState().settings.cache?.showIndicator).toBe(false);
  });

  it('salva o TTL do cache da Anthropic', async () => {
    render(<ToolsTab />);

    fireEvent.change(screen.getByLabelText('TTL do cache da Anthropic'), {
      target: { value: '5m' },
    });

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          cache: expect.objectContaining({ anthropicTtl: '5m' }),
        }),
      );
    });
  });

  it('salva a retenção da OpenAI (auto = null)', async () => {
    render(<ToolsTab />);

    const retention = screen.getByLabelText('Retenção do cache da OpenAI');
    fireEvent.change(retention, { target: { value: '24h' } });
    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          cache: expect.objectContaining({ openaiRetention: '24h' }),
        }),
      );
    });

    fireEvent.change(retention, { target: { value: 'auto' } });
    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          cache: expect.objectContaining({ openaiRetention: null }),
        }),
      );
    });
  });
});