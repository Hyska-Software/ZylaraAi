// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Settings, SkillContent, SkillSummary } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  getSkills: vi.fn(),
  setSkillEnabled: vi.fn(),
  deleteSkill: vi.fn(),
  getSkillContent: vi.fn(),
  listSkillVersions: vi.fn(),
  openSkillsDir: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSkills: mocks.getSkills,
    setSkillEnabled: mocks.setSkillEnabled,
    deleteSkill: mocks.deleteSkill,
    getSkillContent: mocks.getSkillContent,
    listSkillVersions: mocks.listSkillVersions,
    openSkillsDir: mocks.openSkillsDir,
    getSettings: mocks.getSettings,
  },
}));

// Imported after the mock above.
import { SkillsView } from '@/components/skills';
import { useAppStore, useUiStore } from '@/lib/store';

afterEach(() => cleanup());

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

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'office-docx',
    description: 'Criar documentos Word (.docx) com script Python stdlib.',
    source: 'bundled',
    enabled: true,
    deletable: false,
    ...overrides,
  };
}

function skillContent(overrides: Partial<SkillContent> = {}): SkillContent {
  return {
    name: 'office-docx',
    description: 'Criar documentos Word (.docx) com script Python stdlib.',
    source: 'bundled',
    dir: 'C:\\zylara\\skills-bundled\\office-docx',
    content:
      '# Office DOCX\n\nUse o script `make_docx.py` para gerar o documento.\n\n- passo um\n- passo dois',
    ...overrides,
  };
}

function skillList(): SkillSummary[] {
  return [
    skill(),
    skill({
      name: 'relatorios',
      description: 'Padrão da empresa para relatórios internos.',
      source: 'user',
      deletable: true,
    }),
    skill({
      name: 'git-helper',
      description: 'Fluxo de revisão de código do repositório compartilhado.',
      source: 'agents',
    }),
    skill({
      name: 'codex-review',
      description: 'Checklist de revisão usado pelo Codex.',
      source: 'codex',
    }),
    skill({
      name: 'claude-notes',
      description: 'Notas de arquitetura do repositório do Claude.',
      source: 'claude',
    }),
    skill({
      name: 'opencode-plan',
      description: 'Plano de implementação do OpenCode.',
      source: 'opencode',
    }),
  ];
}

/** Simulates the backend's persisted `disabled_skills` after each mutation. */
let disabledSkills: string[] = [];

function backendSettings(): Settings {
  return settings({ disabledSkills: [...disabledSkills] });
}

function skillSwitch(name: string): HTMLButtonElement {
  return screen.getByRole('switch', { name: `Ativar skill ${name}` }) as HTMLButtonElement;
}

/** Row of a skill: the list item that owns its enable switch (raw name identity). */
function rowFor(name: string): HTMLElement | undefined {
  const toggle = screen.queryByRole('switch', { name: `Ativar skill ${name}` });
  return toggle?.closest('li') ?? undefined;
}

function renderView() {
  return render(<SkillsView />);
}

beforeEach(() => {
  vi.resetAllMocks();
  disabledSkills = [];
  mocks.getSkills.mockResolvedValue(skillList());
  mocks.getSettings.mockImplementation(async () => ({ settings: backendSettings(), keys: [] }));
  mocks.setSkillEnabled.mockImplementation(async (name: string, enabled: boolean) => {
    disabledSkills = enabled
      ? disabledSkills.filter((entry) => entry !== name)
      : [...new Set([...disabledSkills, name])];
    return skillList().map((entry) => (entry.name === name ? { ...entry, enabled } : entry));
  });
  mocks.deleteSkill.mockImplementation(async (name: string) => {
    disabledSkills = disabledSkills.filter((entry) => entry !== name);
    return skillList().filter((entry) => entry.name !== name);
  });
  mocks.openSkillsDir.mockResolvedValue(undefined);
  mocks.getSkillContent.mockResolvedValue(skillContent());
  mocks.listSkillVersions.mockResolvedValue([]);
  useAppStore.setState({ settings: settings() });
  useUiStore.setState({ activeView: 'skills', settingsOpen: false });
});

describe('SkillsView — carregamento e listagem', () => {
  it('renderiza como view principal, com título, descrição e regiões acessíveis', async () => {
    renderView();

    expect(screen.getByRole('region', { name: 'Gerenciamento de skills' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
    expect(screen.getByText(/Instruções e scripts que o agente pode consultar/)).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Zylara' })).toBeTruthy();
  });

  it('move o foco para a view ao montar', async () => {
    renderView();
    await screen.findByRole('region', { name: 'Zylara' });

    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Gerenciamento de skills' }),
    );
  });

  it('mostra o carregamento enquanto busca as skills', () => {
    mocks.getSkills.mockReturnValue(new Promise(() => undefined));

    renderView();

    expect(screen.getByText('Carregando skills…')).toBeTruthy();
  });

  it('agrupa por origem na ordem canônica, com contagem, badge e nota de somente leitura', async () => {
    renderView();
    await screen.findByRole('region', { name: 'Zylara' });

    // Section order follows the precedence documented in FILES §7.2/§7.4.
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Zylara',
      'Agentes',
      'Codex',
      'Claude',
      'OpenCode',
      'Embutidas',
    ]);

    const zylara = screen.getByRole('region', { name: 'Zylara' });
    expect(within(zylara).getByText('1')).toBeTruthy();
    expect(within(zylara).getByText('Do Zylara')).toBeTruthy();
    expect(within(zylara).getByText('relatorios')).toBeTruthy();

    expect(within(screen.getByRole('region', { name: 'Embutidas' })).getByText('Embutida')).toBeTruthy();
    expect(rowFor('git-helper')?.textContent).toContain('Agentes');
    expect(rowFor('codex-review')?.textContent).toContain('Codex');
    expect(rowFor('claude-notes')?.textContent).toContain('Claude');
    expect(rowFor('opencode-plan')?.textContent).toContain('OpenCode');

    // The four external repositories are read-only; disable still allowed.
    expect(screen.getAllByText('Somente leitura')).toHaveLength(4);
    expect(screen.getAllByText(/desative para o agente ignorar/i)).toHaveLength(4);
  });

  it('mostra o estado vazio quando não há skills', async () => {
    mocks.getSkills.mockResolvedValue([]);

    renderView();

    expect(await screen.findByText('Nenhuma skill encontrada')).toBeTruthy();
  });

  it('mostra erro e permite tentar novamente', async () => {
    mocks.getSkills
      .mockRejectedValueOnce(new Error('backend offline'))
      .mockResolvedValueOnce(skillList());

    renderView();

    expect(await screen.findByText('Não foi possível carregar as skills')).toBeTruthy();
    expect(screen.getByText('backend offline')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));

    expect(await screen.findByRole('region', { name: 'Zylara' })).toBeTruthy();
    expect(mocks.getSkills).toHaveBeenCalledTimes(2);
  });

  it('continua visível quando o item da sidebar está desativado nas configurações', async () => {
    useAppStore.setState({ settings: settings({ skillsPanelEnabled: false }) });

    renderView();

    expect(await screen.findByRole('region', { name: 'Zylara' })).toBeTruthy();
    expect(useUiStore.getState().activeView).toBe('skills');
  });
});

describe('SkillsView — ativar/desativar', () => {
  it('chama setSkillEnabled, recarrega os settings e atualiza o switch', async () => {
    renderView();

    const toggle = await screen.findByRole('switch', { name: 'Ativar skill office-docx' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.setSkillEnabled).toHaveBeenCalledWith('office-docx', false));
    // The command persists disabled_skills on the backend: the renderer must
    // reload settings so a later saveSettings cannot overwrite the change.
    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledTimes(1));
    expect(mocks.setSkillEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getSettings.mock.invocationCallOrder[0] ?? 0,
    );
    expect(useAppStore.getState().settings.disabledSkills).toContain('office-docx');

    await waitFor(() =>
      expect(skillSwitch('office-docx').getAttribute('aria-checked')).toBe('false'),
    );
    expect(rowFor('office-docx')?.textContent).toContain('Desativada');
    expect(screen.getByText('Skills desativadas não são usadas pelo agente.')).toBeTruthy();
  });

  it('permite desativar uma skill externa (somente leitura)', async () => {
    renderView();

    const toggle = await screen.findByRole('switch', { name: 'Ativar skill git-helper' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.setSkillEnabled).toHaveBeenCalledWith('git-helper', false));
    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(skillSwitch('git-helper').getAttribute('aria-checked')).toBe('false'),
    );
    expect(rowFor('git-helper')?.textContent).toContain('Desativada');
    // Read-only: never a delete action, even disabled.
    expect(screen.queryByRole('button', { name: 'Excluir skill git-helper' })).toBeNull();
  });

  it('mantém o switch anterior quando a atualização falha', async () => {
    mocks.setSkillEnabled.mockRejectedValueOnce(new Error('falha ao salvar'));

    renderView();
    const toggle = await screen.findByRole('switch', { name: 'Ativar skill office-docx' });
    fireEvent.click(toggle);

    await waitFor(() => expect(mocks.setSkillEnabled).toHaveBeenCalled());
    expect(skillSwitch('office-docx').getAttribute('aria-checked')).toBe('true');
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });
});

describe('SkillsView — exclusão', () => {
  it('só oferece excluir para skills do Zylara', async () => {
    renderView();

    await screen.findByRole('region', { name: 'Zylara' });

    expect(screen.getByRole('button', { name: 'Excluir skill relatorios' })).toBeTruthy();
    for (const name of ['office-docx', 'git-helper', 'codex-review', 'claude-notes', 'opencode-plan']) {
      expect(screen.queryByRole('button', { name: `Excluir skill ${name}` })).toBeNull();
    }
  });

  it('pede confirmação inline e exclui a skill do Zylara', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Excluir skill relatorios' }));

    expect(screen.getByText('Excluir?')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Confirmar exclusão de relatorios' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(mocks.deleteSkill).toHaveBeenCalledWith('relatorios'));
    await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('relatorios')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Zylara' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Agentes' })).toBeTruthy();
  });

  it('cancela a exclusão sem chamar a API', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Excluir skill relatorios' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(mocks.deleteSkill).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Excluir skill relatorios' })).toBeTruthy();
  });
});

describe('SkillsView — navegação e pasta', () => {
  it('volta ao chat pelo botão do header', async () => {
    renderView();
    await screen.findByRole('region', { name: 'Zylara' });

    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao chat' }));

    expect(useUiStore.getState().activeView).toBe('chat');
  });

  it('abre a pasta de skills pelo header', async () => {
    renderView();
    await screen.findByRole('region', { name: 'Zylara' });

    fireEvent.click(screen.getByRole('button', { name: 'Abrir pasta de skills' }));

    await waitFor(() => expect(mocks.openSkillsDir).toHaveBeenCalledTimes(1));
  });

  it('uses the onBack/backLabel overrides of the Code layout', async () => {
    const onBack = vi.fn();
    render(<SkillsView onBack={onBack} backLabel="Voltar à sessão" />);
    await screen.findByRole('region', { name: 'Zylara' });

    fireEvent.click(screen.getByRole('button', { name: 'Voltar à sessão' }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeView).not.toBe('chat');
  });
});

describe('SkillsView — prévia em Markdown', () => {
  it('oferece "Visualizar skill" para skills de todas as origens', async () => {
    renderView();
    await screen.findByRole('region', { name: 'Zylara' });

    for (const name of [
      'relatorios',
      'git-helper',
      'codex-review',
      'claude-notes',
      'opencode-plan',
      'office-docx',
    ]) {
      expect(screen.getByRole('button', { name: `Visualizar skill ${name}` })).toBeTruthy();
    }
    // A prévia só busca o conteúdo quando o modal é aberto.
    expect(mocks.getSkillContent).not.toHaveBeenCalled();
  });

  it('mantém a prévia disponível para skill desativada', async () => {
    mocks.getSkills.mockResolvedValue(
      skillList().map((entry) =>
        entry.name === 'git-helper' ? { ...entry, enabled: false } : entry,
      ),
    );

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill git-helper' }));

    const dialog = await screen.findByRole('dialog', { name: 'git-helper' });
    expect(within(dialog).getByText('Agentes')).toBeTruthy();
    expect(within(dialog).getByText('Desativada')).toBeTruthy();
  });

  it('mostra o carregamento enquanto o conteúdo está pendente', async () => {
    mocks.getSkillContent.mockReturnValue(new Promise(() => undefined));

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill office-docx' }));

    const dialog = await screen.findByRole('dialog', { name: 'Documentos Word' });
    expect(within(dialog).getByText('Carregando conteúdo da skill…')).toBeTruthy();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
  });

  it('busca o conteúdo e renderiza o Markdown com o pipeline do chat', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill office-docx' }));

    const dialog = await screen.findByRole('dialog', { name: 'Documentos Word' });
    expect(mocks.getSkillContent).toHaveBeenCalledWith('office-docx');

    expect(
      await within(dialog).findByRole('heading', { level: 1, name: 'Office DOCX' }),
    ).toBeTruthy();
    expect(within(dialog).getByText('make_docx.py')).toBeTruthy();
    expect(dialog.querySelector('.zylara-prose')).toBeTruthy();
    expect(
      within(dialog).getByRole('region', { name: 'Conteúdo da skill office-docx' }),
    ).toBeTruthy();
    // Cabeçalho: origem, descrição e alternância Documento | Código.
    expect(within(dialog).getByText('Embutida')).toBeTruthy();
    expect(within(dialog).getByText('Cria documentos Word (.docx).')).toBeTruthy();
    expect(
      within(dialog).getByRole('radiogroup', { name: 'Modo de visualização da skill' }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('radio', { name: 'Documento' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('mostra o erro e refaz a busca em "Tentar novamente"', async () => {
    mocks.getSkillContent
      .mockRejectedValueOnce(new Error('SKILL.md ausente'))
      .mockResolvedValueOnce(
        skillContent({ content: '## Recuperado\n\nConteúdo após a nova tentativa.' }),
      );

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill relatorios' }));

    const dialog = await screen.findByRole('dialog', { name: 'relatorios' });
    expect(
      await within(dialog).findByText('Não foi possível carregar o conteúdo da skill'),
    ).toBeTruthy();
    expect(within(dialog).getByText('SKILL.md ausente')).toBeTruthy();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));

    expect(
      await within(dialog).findByRole('heading', { level: 2, name: 'Recuperado' }),
    ).toBeTruthy();
    expect(mocks.getSkillContent).toHaveBeenCalledTimes(2);
    expect(mocks.getSkillContent).toHaveBeenLastCalledWith('relatorios');
  });

  it('alterna entre Documento e Código com o Markdown cru', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill office-docx' }));

    const dialog = await screen.findByRole('dialog', { name: 'Documentos Word' });
    expect(
      await within(dialog).findByRole('heading', { level: 1, name: 'Office DOCX' }),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Código' }));

    expect(within(dialog).queryByRole('heading', { level: 1, name: 'Office DOCX' })).toBeNull();
    expect(within(dialog).getByText('SKILL.md')).toBeTruthy();
    expect(dialog.querySelector('pre')?.textContent).toContain('# Office DOCX');
    expect(dialog.querySelector('.zylara-prose')).toBeNull();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Documento' }));

    expect(within(dialog).getByRole('heading', { level: 1, name: 'Office DOCX' })).toBeTruthy();
  });

  it('mostra o estado vazio quando a skill não tem instruções', async () => {
    mocks.getSkillContent.mockResolvedValue(skillContent({ content: '  \n\t' }));

    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill office-docx' }));

    const dialog = await screen.findByRole('dialog', { name: 'Documentos Word' });
    expect(await within(dialog).findByText('Esta skill não tem instruções.')).toBeTruthy();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
  });

  it('fecha pelo botão "Fechar" e remove o dialog', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Visualizar skill office-docx' }));

    const dialog = await screen.findByRole('dialog', { name: 'Documentos Word' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Visualizar skill office-docx' })).toBeTruthy();
  });
});
