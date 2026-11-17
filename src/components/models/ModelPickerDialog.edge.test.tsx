// @vitest-environment jsdom
/**
 * Verificação independente (task-5) — casos adversariais do `ModelPickerDialog`.
 *
 * Complementa `ModelPickerDialog.test.tsx` (dono: ui-dialog) sem repetir seus
 * cenários: catálogo Zen completo, busca de 1 letra com contagem coerente,
 * query gigante/emoji/espaços, acentos com provedor injetado, modelos
 * indisponível/sem raciocínio/só-orçamento/esforço+orçamento, seleção e provedor
 * degenerados (fantasma/vazio), Home/End, setas entre abas e reancoragem do
 * destaque ao filtrar (Enter confirma o destaque, não a prévia antiga).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui';
import { ModelPickerDialog } from '@/components/models/ModelPickerDialog';
import { catalog, isCuratedProvider } from '@/lib/catalog';
import { modelMatchesQuery } from '@/lib/modelMenu';
import type { ModelInfo, ProviderInfo } from '@/lib/types';
import { useAppStore, useUiStore } from '@/lib/store';

afterEach(() => cleanup());

const CURRENT_PROVIDER = 'opencode-go';
const CURRENT_MODEL = 'deepseek-v4.1-flash';
const FAVORITES = ['glm-5.3-flash', 'deepseek-v4.1-flash', 'claude-haiku-5-5', 'gpt-6-luna'];

// Curated providers are always offered; the fixtures only configure Go/Zen, so
// the selector catalogue is exactly this set.
const SELECTOR_PROVIDERS = catalog.providers.filter((provider) => isCuratedProvider(provider.id));
const GO_MODELS = SELECTOR_PROVIDERS.find((provider) => provider.id === CURRENT_PROVIDER)?.models ?? [];
const ZEN_MODELS = SELECTOR_PROVIDERS.find((provider) => provider.id === 'opencode-zen')?.models ?? [];
const GO_COUNT = GO_MODELS.length;
const ZEN_COUNT = ZEN_MODELS.length;
/** Every model whose provider/name/id/etc. contains the single letter "o". */
const TOTAL_MATCHING_O = SELECTOR_PROVIDERS.reduce(
  (total, provider) =>
    total + provider.models.filter((model) => modelMatchesQuery(model, provider, 'o')).length,
  0,
);

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'modelo' : 'modelos'}`;
}

beforeEach(() => {
  useUiStore.setState({ modelPickerOpen: true, settingsOpen: false });
  useAppStore.setState({
    providers: [],
    selection: {
      providerId: CURRENT_PROVIDER,
      modelId: CURRENT_MODEL,
      reasoning: { mode: 'effort', effort: 'max' },
    },
    favorites: [...FAVORITES],
    keys: [
      { providerId: 'opencode-go', hasKey: true, source: 'settings' },
      { providerId: 'opencode-zen', hasKey: true, source: 'settings' },
    ],
  });
});

function searchField(): HTMLInputElement {
  return screen.getByRole('combobox', { name: 'Buscar modelos' }) as HTMLInputElement;
}

function modelCount(): string {
  return screen.getByText(/^\d+ modelos?$/).textContent ?? '';
}

function activeOption(): HTMLElement | null {
  const id = searchField().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

async function renderOpenDialog() {
  render(
    <TooltipProvider>
      <ModelPickerDialog />
    </TooltipProvider>,
  );
  await screen.findByRole('dialog');
  await waitFor(() => expect(document.activeElement).toBe(searchField()));
}

/** Opens the provider dropdown and picks a provider (or All). */
async function selectProvider(
  user: UserEvent,
  name: string,
) {
  await user.click(screen.getByRole('button', { name: 'Provedores' }));
  await user.click(await screen.findByRole('menuitemradio', { name }));
}

/** Catalog stand-in with a single provider; used to inject hostile/dirty data. */
function providerWith(models: ProviderInfo['models']): ProviderInfo {
  const base = catalog.providers[0];
  return { ...base, id: 'cosmico', name: 'Provedor Cósmico', shortName: 'Cósmico', models };
}

function modelWith(overrides: Partial<ModelInfo>): ModelInfo {
  return { ...catalog.providers[0].models[0], ...overrides };
}

describe('ModelPickerDialog (edge) — reancoragem do destaque', () => {
  it('Enter sem navegar confirma o primeiro resultado destacado da busca', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'glm');
    await waitFor(() => {
      const highlighted = activeOption();
      expect(highlighted).toBeTruthy();
      expect(highlighted?.textContent).toContain('GLM-5.1');
    });

    await user.keyboard('{Enter}');

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'opencode-go',
      modelId: 'glm-5.1',
    });
  });

  it('filtro que esconde a prévia reancora o destaque e o Enter confirma o destaque', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Grátis' }));

    await waitFor(() => {
      const highlighted = activeOption();
      expect(highlighted).toBeTruthy();
      expect(highlighted?.getAttribute('aria-disabled')).toBeNull();
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 3 }).textContent).not.toBe('DeepSeek V4.1 Flash'),
    );
    const previewName = screen.getByRole('heading', { level: 3 }).textContent;

    // Devolve o foco à busca antes de confirmar pelo teclado.
    await user.click(searchField());
    await user.keyboard('{Enter}');

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    const selection = useAppStore.getState().selection;
    const selected = catalog.providers
      .find((provider) => provider.id === selection.providerId)
      ?.models.find((model) => model.id === selection.modelId);
    expect(selected?.name).toBe(previewName);
  });

  it('filtros sem nenhum resultado mostram o estado vazio e "Limpar busca e filtros" restaura', async () => {
    useAppStore.setState({ favorites: [] });
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Favoritos' }));

    expect(screen.getByText('Nenhum modelo encontrado')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Favoritos' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Limpar busca e filtros' }));

    expect(screen.getAllByRole('option')).toHaveLength(GO_COUNT);
    expect(modelCount()).toBe(countLabel(GO_COUNT));
    expect(screen.getByRole('button', { name: 'Favoritos' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});

describe('ModelPickerDialog (edge) — catálogo grande e busca hostil', () => {
  it('catálogo Zen completo e busca de 1 letra com contagem/ids coerentes', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await selectProvider(user, 'Zen');

    const zenOptions = screen.getAllByRole('option');
    expect(zenOptions).toHaveLength(ZEN_COUNT);
    expect(modelCount()).toBe(countLabel(ZEN_COUNT));
    expect(new Set(zenOptions.map((option) => option.id)).size).toBe(ZEN_COUNT);

    await user.type(searchField(), 'o');

    // 1 letra casa nos quatro provedores enquanto todos tiverem "o" no nome.
    expect(screen.getAllByRole('option')).toHaveLength(TOTAL_MATCHING_O);
    expect(modelCount()).toBe(countLabel(TOTAL_MATCHING_O));
    // A busca global repete slugs (Zen × Anthropic), mas o id qualificado do
    // option (providerId:modelId) continua único.
    expect(new Set(screen.getAllByRole('option').map((option) => option.id)).size).toBe(
      TOTAL_MATCHING_O,
    );
    expect(screen.getByText('Todos os provedores')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Provedores' })).toBeNull();
    // O destaque é reancorado no primeiro resultado e aponta para um id real.
    expect(activeOption()).toBeTruthy();
    expect(activeOption()?.getAttribute('aria-disabled')).toBeNull();
  });

  it('query gigante, só espaços e emoji não quebram a busca', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.click(searchField());
    await user.paste('a'.repeat(3000));

    expect(screen.getByText('Nenhum modelo encontrado')).toBeTruthy();
    expect(modelCount()).toBe('0 modelos');
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Limpar busca e filtros' }));
    expect(screen.getAllByRole('option')).toHaveLength(GO_COUNT);

    await user.type(searchField(), '    ');
    expect(screen.getByRole('button', { name: 'Provedores' })).toBeTruthy();
    expect(modelCount()).toBe(countLabel(GO_COUNT));
    expect(screen.queryByText('Todos os provedores')).toBeNull();

    await user.clear(searchField());
    await user.type(searchField(), '🚀');
    expect(screen.getByText('Nenhum modelo encontrado')).toBeTruthy();
  });

  it('busca ignora maiúsculas e acentos (provedor injetado com "Céu Profundo Ômega")', async () => {
    const model = modelWith({
      id: 'ceu-profundo',
      name: 'Céu Profundo Ômega',
      family: 'custom',
      description: 'Modelo Órbita para testes de normalização',
      tags: ['vision'],
      reasoningOptions: [],
      status: 'stable',
    });
    useAppStore.setState({
      providers: [providerWith([model])],
      selection: { providerId: 'cosmico', modelId: 'ceu-profundo', reasoning: null },
      keys: [{ providerId: 'cosmico', hasKey: true, source: 'settings' }],
    });
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'CEU PROFUNDO');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(modelCount()).toBe('1 modelo');
    expect(screen.getByRole('option', { name: /Céu Profundo Ômega/ })).toBeTruthy();

    await user.clear(searchField());
    await user.type(searchField(), 'órbita');
    expect(screen.getAllByRole('option')).toHaveLength(1);

    await user.clear(searchField());
    await user.type(searchField(), '🚀');
    expect(screen.getByText('Nenhum modelo encontrado')).toBeTruthy();
  });
});

describe('ModelPickerDialog (edge) — estados de modelo e provedor', () => {
  it('modelo indisponível: aria-disabled, motivo no badge de status e CTA bloqueado', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'mimo-v2.5-pro');
    await user.keyboard('{ArrowDown}');

    expect(screen.getByRole('heading', { name: 'MiMo-V2.5-Pro' })).toBeTruthy();
    expect(screen.getByRole('option', { name: /MiMo-V2\.5-Pro/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    // O motivo fica no title do badge de status (tooltip nativa, acessível).
    const statusBadges = screen.getAllByText('Indisponível');
    expect(
      statusBadges.some((badge) =>
        (badge.getAttribute('title') ?? '').includes('Indisponível no gateway'),
      ),
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Usar este modelo' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('modelo sem controle de raciocínio: nota no painel, nenhum controle e commit com reasoning nulo', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'MiMo-V2.6-Flash');

    // A busca global acha a variante Go e a Zen (Free); clique na Go para a prévia.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    const goOption = options.find((option) => !(option.textContent ?? '').includes('Free'));
    expect(goOption).toBeTruthy();
    await user.click(goOption as HTMLElement);
    expect(screen.getByRole('heading', { name: 'MiMo-V2.6-Flash' })).toBeTruthy();

    expect(
      screen.getByText(/Este modelo não expõe controle de raciocínio/),
    ).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(
      (screen.getByRole('button', { name: 'Usar este modelo' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(useAppStore.getState().selection).toEqual({
      providerId: 'opencode-go',
      modelId: 'mimo-v2.6-flash',
      reasoning: null,
    });
  });

  it('modelo só com orçamento: slider presente e interação aplica o orçamento no commit', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'claude-haiku-4-5');
    // O mesmo slug existe no Zen e na API Anthropic: escolhe a variante do Zen.
    const haikuOptions = screen.getAllByRole('option');
    expect(haikuOptions).toHaveLength(2);
    const haikuZen = haikuOptions.find((option) => (option.textContent ?? '').includes('Zen'));
    expect(haikuZen).toBeTruthy();
    await user.click(haikuZen as HTMLElement);

    const slider = screen.getByRole('slider', {
      name: 'Orçamento de raciocínio em tokens',
    }) as HTMLInputElement;
    expect(slider.min).toBe('1024');
    expect(slider.max).toBe('65536');
    expect(screen.getByText('8.192 tokens')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    fireEvent.change(slider, { target: { value: '16384' } });

    await waitFor(() => expect(screen.getByText('16.384 tokens')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(useAppStore.getState().selection).toEqual({
      providerId: 'opencode-zen',
      modelId: 'claude-haiku-4-5',
      reasoning: { mode: 'budget', budget: 16384 },
    });
  });

  it('modelo com esforços + orçamento: "Orçamento" revela o slider e o commit aplica budget', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'claude-opus-4-6');
    // Mesmo slug no Zen e na Anthropic: a variante do Zen é a que tem budget.
    const opusOptions = screen.getAllByRole('option');
    expect(opusOptions).toHaveLength(2);
    const opusZen = opusOptions.find((option) => (option.textContent ?? '').includes('Zen'));
    expect(opusZen).toBeTruthy();
    await user.click(opusZen as HTMLElement);

    expect(screen.getByRole('heading', { name: 'Claude Opus 4.6' })).toBeTruthy();
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'Alto' })).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Orçamento' }));

    expect(
      screen.getByRole('slider', { name: 'Orçamento de raciocínio em tokens' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(useAppStore.getState().selection).toEqual({
      providerId: 'opencode-zen',
      modelId: 'claude-opus-4-6',
      reasoning: { mode: 'budget', budget: 8192 },
    });
  });

  it('seleção fora do catálogo (id fantasma) abre no provedor padrão sem quebrar', async () => {
    useAppStore.setState({
      selection: { providerId: 'desaparecido', modelId: 'fantasma', reasoning: null },
    });
    await renderOpenDialog();

    expect(screen.getByRole('heading', { name: 'DeepSeek V4.1 Flash' })).toBeTruthy();
    expect(screen.queryByText('Em uso')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(GO_COUNT);
    expect(
      (screen.getByRole('button', { name: 'Usar este modelo' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('provedor sem modelos: estado vazio, CTA desabilitado e Esc fecha', async () => {
    const base = catalog.providers[0];
    useAppStore.setState({
      providers: [{ ...base, models: [] }],
      selection: { providerId: base.id, modelId: 'fantasma', reasoning: null },
    });
    await renderOpenDialog();
    const user = userEvent.setup();

    expect(screen.getByText('Nenhum modelo disponível')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Provedores' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Usar este modelo' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Sem busca/filtros não há o que limpar: o botão não é oferecido.
    expect(screen.queryByRole('button', { name: 'Limpar busca e filtros' })).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
  });
});

describe('ModelPickerDialog (edge) — teclado', () => {
  it('Home/End navegam a lista e atualizam a prévia sem perder o aria-activedescendant', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();
    const options = screen.getAllByRole('option');

    await user.keyboard('{End}');
    expect(activeOption()).toBeTruthy();
    expect(activeOption()?.id).toBe(options[options.length - 1].id);

    await user.keyboard('{Home}');
    expect(activeOption()).toBeTruthy();
    expect(activeOption()?.id).toBe(options[0].id);
  });

  it('dropdown de provedor navega por teclado e troca a contagem', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Provedores' });
    expect(trigger.textContent).toContain('Go');

    await user.click(trigger);
    await user.keyboard('{ArrowDown}');
    expect(document.querySelector('[role="menuitemradio"][data-highlighted]')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(trigger.textContent).toContain('Go');

    await selectProvider(user, 'Zen');
    expect(screen.getByRole('button', { name: 'Provedores' }).textContent).toContain('Zen');
    expect(modelCount()).toBe(countLabel(ZEN_COUNT));
  });
});


