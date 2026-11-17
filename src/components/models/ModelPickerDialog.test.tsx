// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui';
import { ModelPickerDialog } from '@/components/models/ModelPickerDialog';
import { isCuratedProvider, providers } from '@/lib/catalog';
import { modelSupportsVision } from '@/lib/modelMenu';
import type { ChatMessage, Conversation } from '@/lib/types';
import {
  MODEL_LOCKED_DESCRIPTION,
  MODEL_LOCKED_TITLE,
  MODEL_STREAMING_LOCKED_DESCRIPTION,
  MODEL_STREAMING_LOCKED_TITLE,
  useAppStore,
  useChatStore,
  useUiStore,
} from '@/lib/store';
import { i18n } from '@/lib/i18n';

// No Tauri IPC in jsdom: the settings write stays pending (fire-and-forget) and
// the per-session model persistence is asserted through its mock.
const apiMocks = vi.hoisted(() => ({
  saveSettings: vi.fn(() => new Promise(() => {})),
  setConversationModel: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMocks }));

const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMocks }));

afterEach(() => cleanup());

const CURRENT_PROVIDER = 'opencode-go';
const CURRENT_MODEL = 'deepseek-v4.1-flash';
const FAVORITES = ['glm-5.3-flash', 'deepseek-v4.1-flash', 'claude-haiku-5-5', 'gpt-6-luna'];

// The selector lists curated providers plus the ones with a credential; the
// fixtures only configure Go/Zen, so the curated set is the expected catalogue.
const CATALOG_PROVIDERS = providers().filter((provider) => isCuratedProvider(provider.id));
const GO_MODELS = CATALOG_PROVIDERS.find((provider) => provider.id === CURRENT_PROVIDER)?.models ?? [];
const ZEN_MODELS = CATALOG_PROVIDERS.find((provider) => provider.id === 'opencode-zen')?.models ?? [];
const GO_COUNT = GO_MODELS.length;
const ZEN_COUNT = ZEN_MODELS.length;
const ALL_COUNT = CATALOG_PROVIDERS.reduce(
  (total, provider) => total + provider.models.length,
  0,
);
const GO_VISION_COUNT = GO_MODELS.filter(modelSupportsVision).length;
const GO_FREE_COUNT = GO_MODELS.filter((model) => model.status === 'free').length;
const GO_VISION_FREE_COUNT = GO_MODELS.filter(
  (model) => model.status === 'free' && modelSupportsVision(model),
).length;

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.setConversationModel.mockReset();
  useUiStore.setState({ modelPickerOpen: true, settingsOpen: false, layoutMode: 'chat' });
  // Every test starts before the first message, so the model is still editable.
  useChatStore.setState({
    activeId: null,
    conversations: [],
    messagesByConversation: {},
    streaming: null,
  });
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

function modelCount(): number {
  const node = screen.getByText(/^\d+ modelos?$/);
  return Number.parseInt(node.textContent ?? '0', 10);
}

async function renderDialog() {
  render(
    <TooltipProvider>
      <ModelPickerDialog />
    </TooltipProvider>,
  );
  return screen.findByRole('dialog');
}

async function renderOpenDialog() {
  await renderDialog();
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

function selectedModelName(): string | undefined {
  const { providerId, modelId } = useAppStore.getState().selection;
  return providers()
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => model.id === modelId)?.name;
}

/** Starts a conversation with messages, which locks the model selection. */
function lockConversation(overrides: Partial<Conversation> = {}): Conversation {
  const conversation: Conversation = {
    id: 'conv-locked',
    title: 'Conversa em andamento',
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    pinned: false,
    providerId: CURRENT_PROVIDER,
    modelId: CURRENT_MODEL,
    messageCount: 2,
    preview: 'Olá',
    ...overrides,
  };
  const messages: ChatMessage[] = [
    {
      id: 'message-1',
      conversationId: conversation.id,
      role: 'user',
      content: 'Olá',
      status: 'complete',
      toolCalls: [],
      citations: [],
      attachments: [],
      createdAt: Date.now() - 1000,
    },
    {
      id: 'message-2',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Oi! Como posso ajudar?',
      status: 'complete',
      toolCalls: [],
      citations: [],
      attachments: [],
      createdAt: Date.now() - 500,
    },
  ];
  useChatStore.setState({
    activeId: conversation.id,
    conversations: [conversation],
    messagesByConversation: { [conversation.id]: messages },
    streaming: null,
  });
  return conversation;
}

/**
 * A started session born in the Code layout: unlike Chat, it keeps the model
 * switchable between turns, persisting the pair on the session itself.
 */
function startCodeSession(): Conversation {
  useUiStore.setState({ layoutMode: 'code' });
  const conversation = lockConversation({
    id: 'conv-code',
    title: 'Sessão de código',
    mode: 'code',
  });
  apiMocks.setConversationModel.mockImplementation(
    async (conversationId: string, providerId: string, modelId: string) => ({
      ...conversation,
      id: conversationId,
      providerId,
      modelId,
    }),
  );
  return conversation;
}

describe('ModelPickerDialog', () => {
  it('abre com título, busca focada e o modelo atual marcado como "Em uso"', async () => {
    await renderOpenDialog();

    expect(screen.getByRole('heading', { name: 'Selecionar modelo' })).toBeTruthy();
    expect(screen.getByText('Em uso')).toBeTruthy();

    const search = searchField();
    expect(search.getAttribute('role')).toBe('combobox');
    expect(search.getAttribute('aria-expanded')).toBe('true');

    const listbox = screen.getByRole('listbox', { name: 'Modelos do provedor' });
    expect(search.getAttribute('aria-controls')).toBe(listbox.id);

    const current = screen.getByRole('option', { name: /DeepSeek V4\.1 Flash/ });
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current.getAttribute('aria-disabled')).toBeNull();
    expect(search.getAttribute('aria-activedescendant')).toBe(current.id);
  });

  it('busca global encontra modelos de todos os provedores', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'opus');

    expect(screen.getByText('Todos os provedores')).toBeTruthy();
    // Zen e Anthropic expõem o mesmo slug: os dois grupos aparecem na busca.
    expect(screen.getAllByText('Zen · Claude').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Anthropic · Claude').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option', { name: /Claude Opus 5\.5/ })).toHaveLength(2);
    // 6 variantes no Zen + 6 na Anthropic.
    expect(modelCount()).toBe(12);
    // The provider dropdown gives way to the global-search label.
    expect(screen.queryByRole('button', { name: 'Provedores' })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Resultados da busca de modelos' })).toBeTruthy();
  });

  it('alterna de provedor pelo dropdown e move a prévia para o modelo padrão', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    const providerTrigger = screen.getByRole('button', { name: 'Provedores' });
    expect(providerTrigger.textContent).toContain('Go');
    expect(providerTrigger.getAttribute('title')).toBe('Chave configurada');
    expect(modelCount()).toBe(GO_COUNT);

    await selectProvider(user, 'Zen');

    expect(screen.getByRole('button', { name: 'Provedores' }).textContent).toContain('Zen');
    expect(modelCount()).toBe(ZEN_COUNT);
    // O Zen não tem Omen Alpha (exclusivo do Go).
    expect(screen.queryByRole('option', { name: /Omen Alpha/ })).toBeNull();
    // A prévia passa para o modelo padrão do provedor.
    expect(screen.getByRole('heading', { name: 'GPT 6 Luna' })).toBeTruthy();
  });

  it('opção Todos lista todos os modelos com o provedor em cada linha', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await selectProvider(user, 'Todos os provedores');

    expect(screen.getByRole('button', { name: 'Provedores' }).textContent).toContain(
      'Todos os provedores',
    );
    expect(modelCount()).toBe(ALL_COUNT);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(ALL_COUNT);
    const texts = options.map((option) => option.textContent ?? '');
    expect(texts.some((text) => text.includes('ChatGPT'))).toBe(true);
    expect(texts.some((text) => text.includes('Zen'))).toBe(true);
    expect(texts.some((text) => text.includes('Anthropic'))).toBe(true);
    expect(texts.some((text) => text.includes('Gemini'))).toBe(true);
  });

  it('filtros de capability reduzem a lista e combinam entre si', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    expect(modelCount()).toBe(GO_COUNT);

    const vision = screen.getByRole('button', { name: 'Visão' });
    await user.click(vision);
    expect(vision.getAttribute('aria-pressed')).toBe('true');
    expect(modelCount()).toBe(GO_VISION_COUNT);

    const free = screen.getByRole('button', { name: 'Grátis' });
    await user.click(free);
    expect(free.getAttribute('aria-pressed')).toBe('true');
    // Visão + Grátis: apenas os modelos gratuitos com suporte a imagem.
    expect(modelCount()).toBe(GO_VISION_FREE_COUNT);
    expect(screen.getByRole('option', { name: /LongCat 2\.5 Preview Free/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Beam Free/ })).toBeNull();

    // Desligando "Visão", "Grátis" sozinho mostra o Beam Free.
    await user.click(vision);
    expect(vision.getAttribute('aria-pressed')).toBe('false');
    expect(modelCount()).toBe(GO_FREE_COUNT);
    expect(screen.getByRole('option', { name: /Beam Free/ })).toBeTruthy();
  });

  it('mostra o estado vazio e limpa busca e filtros', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Grátis' }));
    await user.click(searchField());
    await user.type(searchField(), 'modelo-inexistente');

    expect(screen.getByText('Nenhum modelo encontrado')).toBeTruthy();
    expect(screen.queryByRole('option')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Limpar busca e filtros' }));

    expect(searchField().value).toBe('');
    expect(screen.getByRole('button', { name: 'Grátis' }).getAttribute('aria-pressed')).toBe('false');
    expect(modelCount()).toBe(GO_COUNT);
  });

  it('clique na linha atualiza a prévia e "Usar este modelo" confirma e fecha', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('option', { name: /GLM-5\.3-Flash/ }));

    // Prévia mudou; a seleção só muda no commit.
    expect(screen.getByRole('heading', { name: 'GLM-5.3-Flash' })).toBeTruthy();
    expect(screen.queryByText('Em uso')).toBeNull();
    expect(useAppStore.getState().selection.modelId).toBe(CURRENT_MODEL);

    const useButton = screen.getByRole('button', { name: 'Usar este modelo' }) as HTMLButtonElement;
    expect(useButton.disabled).toBe(false);
    await user.click(useButton);

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().selection.providerId).toBe('opencode-go');
    expect(useAppStore.getState().selection.modelId).toBe('glm-5.3-flash');
  });

  it('duplo-clique na linha confirma direto', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.dblClick(screen.getByRole('option', { name: /Claude Haiku 5\.5/ }));

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(useAppStore.getState().selection.modelId).toBe('claude-haiku-5-5');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Enter na busca confirma a prévia ativa', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    const search = searchField();
    await user.click(search);
    await user.keyboard('{ArrowDown}');

    const activeId = search.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const activeOption = document.getElementById(activeId as string);
    expect(activeOption).toBeTruthy();
    const activeText = activeOption?.textContent ?? '';
    // A prévia acompanha a navegação por teclado.
    const previewName = screen.getByRole('heading', { level: 3 }).textContent ?? '';
    expect(previewName).not.toBe('DeepSeek V4.1 Flash');
    expect(activeText).toContain(previewName);

    await user.keyboard('{Enter}');

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(selectedModelName()).toBe(previewName);
  });

  it('modelo indisponível fica aria-disabled e não pode ser confirmado', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'mimo-v2.5-pro');
    // Seta: o único resultado (indisponível) vira prévia para mostrar o motivo.
    await user.keyboard('{ArrowDown}');

    const unavailable = screen.getByRole('option', { name: /MiMo-V2\.5-Pro/ });
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('heading', { name: 'MiMo-V2.5-Pro' })).toBeTruthy();

    const useButton = screen.getByRole('button', { name: 'Usar este modelo' }) as HTMLButtonElement;
    expect(useButton.disabled).toBe(true);

    // Clique não altera prévia nem seleção.
    await user.click(unavailable);
    expect(screen.getByRole('heading', { name: 'MiMo-V2.5-Pro' })).toBeTruthy();
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(useAppStore.getState().selection.modelId).toBe(CURRENT_MODEL);

    // Enter na busca também não confirma um modelo indisponível.
    await user.keyboard('{Enter}');
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
  });

  it('aviso de chave ausente abre Configurações e fecha o dialog', async () => {
    useAppStore.setState({
      keys: [
        { providerId: 'opencode-go', hasKey: false, source: 'none' },
        { providerId: 'opencode-zen', hasKey: true, source: 'settings' },
      ],
    });
    await renderOpenDialog();
    const user = userEvent.setup();

    expect(screen.getByRole('button', { name: 'Provedores' }).getAttribute('title')).toBe(
      'Sem chave de API',
    );
    expect(screen.getByText(/Sem chave de API para OpenCode Go/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Configurar' }));

    await waitFor(() => expect(useUiStore.getState().settingsOpen).toBe(true));
    expect(useUiStore.getState().modelPickerOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc limpa a busca antes de fechar', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    const search = searchField();
    await user.type(search, 'glm');
    expect(search.value).toBe('glm');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(search.value).toBe(''));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(modelCount()).toBe(GO_COUNT);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reabrir o dialog reseta busca, filtros e prévia', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.type(searchField(), 'glm');
    await user.click(screen.getByRole('button', { name: 'Visão' }));
    // O foco foi para o chip de filtro: volta para a busca antes de navegar.
    await user.click(searchField());
    await user.keyboard('{ArrowDown}');
    const previewName = screen.getByRole('heading', { level: 3 }).textContent ?? '';
    expect(previewName).not.toBe('DeepSeek V4.1 Flash');

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    act(() => useUiStore.getState().setModelPickerOpen(true));
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(searchField()));

    expect(searchField().value).toBe('');
    expect(screen.getByRole('button', { name: 'Visão' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('heading', { name: 'DeepSeek V4.1 Flash' })).toBeTruthy();
    expect(screen.getByText('Em uso')).toBeTruthy();
    expect(modelCount()).toBe(GO_COUNT);
  });

  it('mudar o modo de pensamento altera a prévia e o commit aplica o reasoning', async () => {
    await renderOpenDialog();
    const user = userEvent.setup();

    const dialog = screen.getByRole('dialog');
    const max = within(dialog).getByRole('radio', { name: 'Máximo' });
    expect(max.getAttribute('aria-checked')).toBe('true');

    await user.click(within(dialog).getByRole('radio', { name: 'Alto' }));
    expect(
      within(dialog).getByRole('radio', { name: 'Alto' }).getAttribute('aria-checked'),
    ).toBe('true');
    // A prévia continua no mesmo modelo — ainda não houve commit.
    expect(useAppStore.getState().selection.reasoning).toEqual({ mode: 'effort', effort: 'max' });

    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(useAppStore.getState().selection.modelId).toBe(CURRENT_MODEL);
    expect(useAppStore.getState().selection.reasoning).toEqual({ mode: 'effort', effort: 'high' });
  });
});

describe('ModelPickerDialog (modelo bloqueado após iniciar a conversa)', () => {
  it('mostra o aviso e o modelo em uso no lugar do seletor', async () => {
    lockConversation();
    await renderDialog();

    expect(screen.getByRole('heading', { name: i18n.t(MODEL_LOCKED_TITLE) })).toBeTruthy();
    expect(screen.getByText(i18n.t(MODEL_LOCKED_DESCRIPTION))).toBeTruthy();
    // Resumo do modelo em uso (avatar + nome + provedor).
    expect(screen.getByText('DeepSeek V4.1 Flash')).toBeTruthy();
    expect(screen.getByText('OpenCode Go')).toBeTruthy();
    expect(
      screen.getByText(
        'Você pode ajustar o modo de pensamento pelo botão ✦ no composer.',
      ),
    ).toBeTruthy();

    // Nada de seletor: sem busca, lista, dropdown ou confirmação.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Provedores' })).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Usar este modelo' })).toBeNull();
    expect(screen.queryByText('Em uso')).toBeNull();
  });

  it('"Fechar" recebe o foco inicial e fecha o dialog', async () => {
    lockConversation();
    await renderDialog();
    const user = userEvent.setup();

    const close = screen.getByRole('button', { name: 'Fechar' });
    await waitFor(() => expect(document.activeElement).toBe(close));

    await user.click(close);

    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useAppStore.getState().selection.modelId).toBe(CURRENT_MODEL);
  });

  it('bloqueia também durante o streaming, mesmo sem conversa carregada', async () => {
    useChatStore.setState({
      activeId: null,
      streaming: {
        turnId: 'turn-1',
        conversationId: 'conv-streaming',
        assistantId: 'assistant-1',
        userMessageId: null,
        phase: 'starting',
        step: 1,
        startedAt: Date.now(),
        turnKind: 'user',
      },
    });
    await renderDialog();

    expect(screen.getByRole('heading', { name: i18n.t(MODEL_STREAMING_LOCKED_TITLE) })).toBeTruthy();
    expect(screen.getByText(i18n.t(MODEL_STREAMING_LOCKED_DESCRIPTION))).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('não bloqueia quando a conversa com mensagens não está ativa', async () => {
    lockConversation();
    useChatStore.setState({ activeId: null });

    await renderOpenDialog();

    expect(screen.getByRole('heading', { name: 'Selecionar modelo' })).toBeTruthy();
    expect(screen.getByText('Em uso')).toBeTruthy();
  });

  it('mostra o id quando o modelo da seleção não existe no catálogo', async () => {
    lockConversation();
    useAppStore.setState({
      selection: { providerId: 'desaparecido', modelId: 'fantasma', reasoning: null },
    });

    await renderDialog();

    expect(screen.getByRole('heading', { name: i18n.t(MODEL_LOCKED_TITLE) })).toBeTruthy();
    expect(screen.getByText('fantasma')).toBeTruthy();
    expect(screen.getByText('desaparecido')).toBeTruthy();
  });
});

describe('ModelPickerDialog (troca de modelo na sessão do Code)', () => {
  it('abre o seletor completo e persiste o par na sessão do Code', async () => {
    startCodeSession();
    await renderOpenDialog();
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: 'Selecionar modelo' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: i18n.t(MODEL_LOCKED_TITLE) })).toBeNull();
    expect(searchField()).toBeTruthy();

    await user.click(screen.getByRole('option', { name: /GLM-5\.3-Flash/ }));
    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));

    await waitFor(() =>
      expect(apiMocks.setConversationModel).toHaveBeenCalledWith(
        'conv-code',
        CURRENT_PROVIDER,
        'glm-5.3-flash',
      ),
    );
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useChatStore.getState().conversations[0].modelId).toBe('glm-5.3-flash');
    expect(useAppStore.getState().selection.modelId).toBe('glm-5.3-flash');
    // The pair is a session property: the configured defaults stay untouched.
    expect(apiMocks.saveSettings).not.toHaveBeenCalled();
  });

  it('troca de provedor no meio da conversa: dropdown Zen, modelo do Zen e commit na sessão', async () => {
    startCodeSession();
    await renderOpenDialog();
    const user = userEvent.setup();

    // Sai do Go (rota atual da sessão) para o Zen e escolhe um modelo daquele provedor.
    await selectProvider(user, 'Zen');
    await user.click(await screen.findByRole('option', { name: /Claude Haiku 5\.5/ }));
    expect(screen.getByRole('heading', { name: 'Claude Haiku 5.5' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));

    await waitFor(() =>
      expect(apiMocks.setConversationModel).toHaveBeenCalledWith(
        'conv-code',
        'opencode-zen',
        'claude-haiku-5-5',
      ),
    );
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
    // A conversa e a seleção passam para o par novo; os padrões não mudam.
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      providerId: 'opencode-zen',
      modelId: 'claude-haiku-5-5',
    });
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: 'opencode-zen',
      modelId: 'claude-haiku-5-5',
    });
    expect(apiMocks.saveSettings).not.toHaveBeenCalled();
  });

  it('não fecha o dialog quando o commit é recusado pelo backend', async () => {
    startCodeSession();
    apiMocks.setConversationModel.mockRejectedValueOnce(new Error('turno em andamento'));
    await renderOpenDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('option', { name: /GLM-5\.3-Flash/ }));
    await user.click(screen.getByRole('button', { name: 'Usar este modelo' }));

    await waitFor(() => expect(apiMocks.setConversationModel).toHaveBeenCalled());
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        'Não foi possível alterar o modelo',
        expect.objectContaining({ description: 'turno em andamento' }),
      ),
    );
    // The dialog stays open so the user sees the toast, and the selection reverts.
    expect(useUiStore.getState().modelPickerOpen).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(useAppStore.getState().selection.modelId).toBe(CURRENT_MODEL);
  });

  it('bloqueia durante o streaming na sessão do Code com a copy específica', async () => {
    startCodeSession();
    useChatStore.setState({
      streaming: {
        turnId: 'turn-1',
        conversationId: 'conv-code',
        assistantId: 'assistant-1',
        userMessageId: null,
        phase: 'text',
        step: 1,
        startedAt: Date.now(),
        turnKind: 'user',
      },
    });
    await renderDialog();
    const user = userEvent.setup();

    expect(screen.getByRole('heading', { name: i18n.t(MODEL_STREAMING_LOCKED_TITLE) })).toBeTruthy();
    expect(screen.getByText(i18n.t(MODEL_STREAMING_LOCKED_DESCRIPTION))).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Usar este modelo' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(useUiStore.getState().modelPickerOpen).toBe(false));
  });
});
