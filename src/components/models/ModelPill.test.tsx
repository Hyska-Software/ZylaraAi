// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { toast } from 'sonner';
import { TooltipProvider } from '@/components/ui';
import { ModelPill } from '@/components/models/ModelPill';
import { catalog, isCuratedProvider } from '@/lib/catalog';
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

// The store persists the selection through the settings command; there is no
// Tauri IPC in jsdom, so the call stays pending (the pill never awaits it).
const apiMocks = vi.hoisted(() => ({
  saveSettings: vi.fn(() => new Promise(() => {})),
  setConversationModel: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: apiMocks }));

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

afterEach(() => cleanup());

const GO = 'opencode-go';
const ZEN = 'opencode-zen';
const CURRENT_MODEL = 'deepseek-v4.1-flash';

const GO_MODELS = catalog.providers.find((provider) => provider.id === GO)?.models ?? [];
const ZEN_MODELS = catalog.providers.find((provider) => provider.id === ZEN)?.models ?? [];
/** The compact pill hides models the gateway reports as unavailable. */
const GO_AVAILABLE_COUNT = GO_MODELS.filter((model) => model.status !== 'unavailable').length;
const ZEN_COUNT = ZEN_MODELS.filter((model) => model.status !== 'unavailable').length;
// Curated providers are always offered by the selector; the fixtures only
// configure Go/Zen, so "all providers" is the curated set.
const SELECTOR_PROVIDERS = catalog.providers.filter((provider) => isCuratedProvider(provider.id));
const ALL_AVAILABLE_COUNT = SELECTOR_PROVIDERS.reduce(
  (total, provider) =>
    total + provider.models.filter((model) => model.status !== 'unavailable').length,
  0,
);

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'modelo' : 'modelos'}`;
}

function closedMarkup(element: ReactElement): string {
  return renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);
}

function renderPill(element: ReactElement = <ModelPill />) {
  return render(<TooltipProvider>{element}</TooltipProvider>);
}

function modelTrigger(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /^Selecionar modelo\. Atual:/,
  }) as HTMLButtonElement;
}

function thinkingTrigger(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /^Selecionar modo de pensamento\. Atual:/,
  }) as HTMLButtonElement;
}

async function openModelStage(user: UserEvent) {
  await user.click(modelTrigger());
  return screen.findByRole('dialog', { name: 'Selecionar modelo' });
}

/** Opens the compact provider dropdown and picks a provider (or All). */
async function selectProvider(
  user: UserEvent,
  dialog: HTMLElement,
  name: string,
) {
  await user.click(within(dialog).getByRole('button', { name: 'Provedor' }));
  await user.click(await screen.findByRole('menuitemradio', { name }));
}

async function openThinkingStage(user: UserEvent) {
  await user.click(thinkingTrigger());
  return screen.findByRole('dialog', { name: 'Selecionar modelo' });
}

function optionById(id: string | null): HTMLElement | undefined {
  if (!id) return undefined;
  return document.getElementById(id) ?? undefined;
}

function messageFor(conversationId: string): ChatMessage {
  return {
    id: 'msg-1',
    conversationId,
    role: 'user',
    content: 'Olá',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 1,
  };
}

/** Locks the model by pretending the active conversation already has messages. */
function lockModelOnConversation(conversationId = 'conv-1') {
  useChatStore.setState({
    activeId: conversationId,
    conversations: [
      {
        id: conversationId,
        title: 'Conversa de teste',
        createdAt: 1,
        updatedAt: 1,
        pinned: false,
        providerId: GO,
        modelId: CURRENT_MODEL,
        messageCount: 1,
      },
    ],
    messagesByConversation: { [conversationId]: [messageFor(conversationId)] },
  });
}

function modelLockedTrigger(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /^Modelo bloqueado nesta conversa\. Atual:/,
  }) as HTMLButtonElement;
}

function streamingLockedTrigger(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /^Troca de modelo indisponível durante a resposta\. Atual:/,
  }) as HTMLButtonElement;
}

/** A session born in the Code layout: its model can change between turns. */
function codeSession(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-code',
    title: 'Sessão de código',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    providerId: GO,
    modelId: CURRENT_MODEL,
    messageCount: 1,
    mode: 'code',
    ...overrides,
  };
}

/** Opens a started Code session and records the per-session model persistence. */
function startCodeSession(session: Conversation = codeSession()): Conversation {
  useUiStore.setState({ layoutMode: 'code' });
  useChatStore.setState({
    activeId: session.id,
    conversations: [session],
    messagesByConversation: { [session.id]: [messageFor(session.id)] },
    streaming: null,
  });
  apiMocks.setConversationModel.mockImplementation(
    async (conversationId: string, providerId: string, modelId: string) => ({
      ...session,
      id: conversationId,
      providerId,
      modelId,
    }),
  );
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.setConversationModel.mockReset();
  useAppStore.setState({
    providers: catalog.providers,
    selection: {
      providerId: GO,
      modelId: CURRENT_MODEL,
      reasoning: { mode: 'effort', effort: 'high' },
    },
    favorites: ['glm-5.3-flash', 'claude-haiku-5-5'],
    keys: [
      { providerId: GO, hasKey: true, source: 'settings' },
      { providerId: ZEN, hasKey: false, source: 'none' },
    ],
    settings: {
      ...useAppStore.getState().settings,
      defaultProvider: GO,
      defaultModel: CURRENT_MODEL,
      reasoningSliderEnabled: false,
    },
  });
  useUiStore.setState({ modelPickerOpen: false, settingsOpen: false, layoutMode: 'chat' });
  useChatStore.setState({
    conversations: [],
    activeId: null,
    messagesByConversation: {},
    streaming: null,
  });
});

describe('ModelPill (closed state)', () => {
  it('shows the current model, the thinking label and the dialog affordances', () => {
    const html = closedMarkup(<ModelPill providerId={GO} modelId={CURRENT_MODEL} />);

    expect(html).toContain('DeepSeek V4.1 Flash');
    expect(html).toContain('aria-label="Selecionar modelo. Atual: DeepSeek V4.1 Flash"');
    expect(html).toContain(
      'aria-label="Selecionar modo de pensamento. Atual: Alto"',
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('Alto');
  });

  it('caps the model/effort labels and collapses them in narrow containers', () => {
    renderPill(
      <ModelPill
        providerId={GO}
        modelId={CURRENT_MODEL}
        reasoning={{ mode: 'effort', effort: 'max' }}
      />,
    );

    // Visible names have a hard cap and leave the pill in narrow composers;
    // the full text stays in the accessible name and native title.
    const nameSpan = screen.getByText('DeepSeek V4.1 Flash');
    expect(nameSpan.className).toContain('max-w-36');
    expect(nameSpan.className).toContain('@max-[42rem]:hidden');
    const effortSpan = screen.getByText('Máximo');
    expect(effortSpan.className).toContain('max-w-32');
    expect(effortSpan.className).toContain('@max-[42rem]:hidden');
    expect(modelTrigger().getAttribute('title')).toBe('DeepSeek V4.1 Flash');
    expect(thinkingTrigger().getAttribute('title')).toBe('Máximo');
  });

  it('renders only the trigger when closed (no popover content)', () => {
    const html = closedMarkup(<ModelPill providerId={GO} modelId={CURRENT_MODEL} />);

    expect(html).not.toContain('Ver todos os modelos');
    expect(html).not.toContain('Buscar modelos');
    expect(html).not.toContain('role="dialog"');
  });

  it('uses the effort label from the reasoning override', () => {
    const html = closedMarkup(
      <ModelPill
        providerId={GO}
        modelId={CURRENT_MODEL}
        reasoning={{ mode: 'effort', effort: 'max' }}
      />,
    );

    expect(html).toContain('Selecionar modo de pensamento. Atual: Máximo');
  });

  it('marks models without reasoning control with "Padrão" and a tooltip', () => {
    const html = closedMarkup(
      <ModelPill providerId={GO} modelId="mimo-v2.6-flash" reasoning={null} />,
    );

    expect(html).toContain('MiMo-V2.6-Flash');
    expect(html).toContain('Atual: Padrão');
    expect(html).toContain('Este modelo não expõe controle de raciocínio');
    // The whole thinking segment is disabled for those models.
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Selecionar modo de pensamento/);
  });

  it('renders the compact variant with the smaller pill height', () => {
    const html = closedMarkup(
      <ModelPill providerId={GO} modelId="glm-5.3-flash" compact />,
    );

    expect(html).toContain('GLM-5.3-Flash');
    expect(html).toContain('h-7');
    expect(html).not.toContain('h-8');
  });
});

describe('ModelPill (model step)', () => {
  it('opens a compact searchable model stage without details before interaction', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    const search = within(dialog).getByRole('combobox', { name: 'Buscar modelos' });
    await waitFor(() => expect(document.activeElement).toBe(search));

    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(search.getAttribute('aria-controls')).toBe(
      within(dialog).getByRole('listbox', { name: 'Modelos' }).id,
    );
    expect(search.getAttribute('aria-activedescendant')).toBe(
      within(dialog).getByRole('option', { name: 'DeepSeek V4.1 Flash' }).id,
    );

    // Provider dropdown with key dot + model count.
    const providerTrigger = within(dialog).getByRole('button', { name: 'Provedor' });
    expect(providerTrigger.textContent).toContain('Go');
    expect(providerTrigger.getAttribute('title')).toBe('Chave configurada');
    expect(within(dialog).getByText(countLabel(GO_AVAILABLE_COUNT))).toBeTruthy();

    // Groups: favorites first, then the families.
    expect(within(dialog).getByText('Favoritos')).toBeTruthy();
    // Group header (not row text): the LobeHub `<title>DeepSeek</title>` of the
    // brand glyph also matches the family label, so query the group by role.
    expect(within(dialog).getByRole('group', { name: 'DeepSeek' })).toBeTruthy();
    expect(within(dialog).getByText('GLM')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /Ver todos os modelos/ })).toBeTruthy();

    // Details are a tooltip-like bubble: hidden until a row is hovered/focused.
    expect(within(dialog).queryByRole('group', { name: 'Detalhes do modelo' })).toBeNull();
    expect(within(dialog).queryByText('Contexto')).toBeNull();
  });

  it('filters locally by family and shows the empty state with "Limpar busca"', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    const search = within(dialog).getByRole('combobox', { name: 'Buscar modelos' });

    await user.type(search, 'glm');
    // Global results show the provider name inside each row.
    expect(await within(dialog).findByRole('option', { name: /^GLM-5\.1/ })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: /^DeepSeek V4 Pro/ })).toBeNull();

    await user.clear(search);
    await user.type(search, 'zzzz-nao-existe');
    const emptyTitle = await within(dialog).findByText('Nenhum modelo encontrado');
    const emptyState = emptyTitle.parentElement as HTMLElement;

    await user.click(within(emptyState).getByRole('button', { name: 'Limpar busca' }));
    expect(await within(dialog).findByRole('option', { name: 'DeepSeek V4 Pro' })).toBeTruthy();
  });

  it('searches every provider globally and replaces the switch with the provider label', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    const search = within(dialog).getByRole('combobox', { name: 'Buscar modelos' });

    await user.type(search, 'opus');

    expect(await within(dialog).findByText('Zen · Claude')).toBeTruthy();
    expect(within(dialog).getByText('Go + Zen + ChatGPT + Anthropic + Gemini')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Provedor' })).toBeNull();
    expect(
      within(dialog)
        .getAllByRole('option')
        .some((option) => option.textContent?.includes('Claude Opus')),
    ).toBe(true);
    // Global rows expose the provider short name.
    expect(within(dialog).getAllByText('Zen').length).toBeGreaterThan(0);
  });

  it('opção Todos lista modelos de todos os provedores com o provedor em cada linha', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await selectProvider(user, dialog, 'Todos os provedores');

    expect(
      within(dialog).getByRole('button', { name: 'Provedor' }).textContent,
    ).toContain('Todos os provedores');
    expect(within(dialog).getAllByRole('option')).toHaveLength(ALL_AVAILABLE_COUNT);
    expect(within(dialog).getByText(countLabel(ALL_AVAILABLE_COUNT))).toBeTruthy();
    for (const provider of ['Zen', 'ChatGPT', 'Anthropic', 'Gemini']) {
      expect(within(dialog).getAllByText(provider).length).toBeGreaterThan(0);
    }
  });

  it('switches the list between Go and Zen', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await selectProvider(user, dialog, 'Zen');

    expect(await within(dialog).findByRole('option', { name: 'Claude Fable 5' })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: 'GLM-5.3-Flash' })).toBeNull();
    expect(
      within(dialog).getByRole('button', { name: 'Provedor' }).textContent,
    ).toContain('Zen');
    expect(within(dialog).getByText(countLabel(ZEN_COUNT))).toBeTruthy();
  });

  it('shows the floating details bubble when a model row is hovered', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    expect(within(dialog).queryByRole('group', { name: 'Detalhes do modelo' })).toBeNull();

    await user.hover(within(dialog).getByRole('option', { name: 'Claude Haiku 5.5' }));

    const details = await within(dialog).findByRole('group', { name: 'Detalhes do modelo' });
    expect(within(details).getByText('Claude Haiku 5.5', { selector: 'h3' })).toBeTruthy();
    expect(within(details).getByText(/OpenCode Go · claude-haiku-5-5/)).toBeTruthy();
    expect(within(details).getByText('Contexto')).toBeTruthy();
    expect(within(details).getByText('Saída máx.')).toBeTruthy();
    expect(within(details).getByText('Custo (1M tok.)')).toBeTruthy();
    expect(within(details).getByText(/Pensamento/)).toBeTruthy();

    // The popover stays open; the bubble does not replace the list.
    expect(screen.getByRole('dialog', { name: 'Selecionar modelo' })).toBeTruthy();
    expect(within(dialog).getByRole('listbox', { name: 'Modelos' })).toBeTruthy();
  });

  it('shows the bubble on keyboard navigation and updates it between rows', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    const search = within(dialog).getByRole('combobox', { name: 'Buscar modelos' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(within(dialog).queryByRole('group', { name: 'Detalhes do modelo' })).toBeNull();

    await user.keyboard('{ArrowDown}');
    const details = await within(dialog).findByRole('group', { name: 'Detalhes do modelo' });
    const firstRow = within(details).getByText(/OpenCode Go · /).textContent;

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(within(details).getByText(/OpenCode Go · /).textContent).not.toBe(firstRow);
    });

    await user.hover(within(dialog).getByRole('option', { name: 'Claude Haiku 5.5' }));
    await waitFor(() => {
      expect(within(details).getByText(/OpenCode Go · claude-haiku-5-5/)).toBeTruthy();
    });
  });

  it('keeps the bubble open while the pointer is over it and hides it on leave', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.hover(within(dialog).getByRole('option', { name: 'DeepSeek V4.1 Flash' }));
    const details = await within(dialog).findByRole('group', { name: 'Detalhes do modelo' });

    // Moving from the list into the bubble must not hide it.
    await user.hover(details);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(within(dialog).getByRole('group', { name: 'Detalhes do modelo' })).toBeTruthy();

    await user.unhover(details);
    await waitFor(() =>
      expect(within(dialog).queryByRole('group', { name: 'Detalhes do modelo' })).toBeNull(),
    );
  });

  it('hides the bubble when the popover closes or switches to the thinking step', async () => {
    const user = userEvent.setup();
    renderPill();

    let dialog = await openModelStage(user);
    await user.hover(within(dialog).getByRole('option', { name: 'DeepSeek V4.1 Flash' }));
    expect(await within(dialog).findByRole('group', { name: 'Detalhes do modelo' })).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    dialog = await openModelStage(user);
    await user.hover(within(dialog).getByRole('option', { name: 'GLM-5.3-Flash' }));
    expect(await within(dialog).findByRole('group', { name: 'Detalhes do modelo' })).toBeTruthy();

    await user.click(within(dialog).getByRole('option', { name: 'GLM-5.3-Flash' }));
    expect(await screen.findByText('Modo de pensamento')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Detalhes do modelo' })).toBeNull();
  });

  it('toggles a favorite from the details bubble', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.hover(within(dialog).getByRole('option', { name: 'DeepSeek V4.1 Flash' }));
    const details = await within(dialog).findByRole('group', { name: 'Detalhes do modelo' });

    await user.click(
      within(details).getByRole('button', { name: 'Favoritar DeepSeek V4.1 Flash' }),
    );

    // Favorites are now stored as providerId:modelId pairs.
    expect(useAppStore.getState().favorites).toContain(`${GO}:${CURRENT_MODEL}`);
    expect(useAppStore.getState().favorites).not.toContain(CURRENT_MODEL);

    const updated = within(dialog).getByRole('group', { name: 'Detalhes do modelo' });
    const pressed = within(updated).getByRole('button', {
      name: 'Remover DeepSeek V4.1 Flash dos favoritos',
    });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the missing-key warning in the bubble and opens provider settings', async () => {
    useAppStore.setState({
      keys: [{ providerId: GO, hasKey: false, source: 'none' }],
    });
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.hover(within(dialog).getByRole('option', { name: 'DeepSeek V4.1 Flash' }));
    const details = await within(dialog).findByRole('group', { name: 'Detalhes do modelo' });
    expect(within(details).getByText(/Sem chave de API para OpenCode Go/)).toBeTruthy();

    await user.click(within(details).getByRole('button', { name: 'Configurar' }));

    expect(useUiStore.getState().settingsOpen).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens the full picker from the footer when onClick is provided', async () => {
    const user = userEvent.setup();
    const onOpenFullPicker = vi.fn();
    renderPill(<ModelPill onClick={onOpenFullPicker} />);

    const dialog = await openModelStage(user);
    await user.click(within(dialog).getByRole('button', { name: /Ver todos os modelos/ }));

    expect(onOpenFullPicker).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('falls back to the UI store when no onClick is provided', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.click(within(dialog).getByRole('button', { name: /Ver todos os modelos/ }));

    expect(useUiStore.getState().modelPickerOpen).toBe(true);
  });

  it('switches between the two steps from the segments without closing', async () => {
    const user = userEvent.setup();
    renderPill();

    await openModelStage(user);
    await user.click(thinkingTrigger());
    expect(await screen.findByText('Modo de pensamento')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Selecionar modelo' })).toBeTruthy();

    await user.click(modelTrigger());
    expect(await screen.findByRole('combobox', { name: 'Buscar modelos' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Selecionar modelo' })).toBeTruthy();
  });

  it('closes when clicking outside the popover', async () => {
    const user = userEvent.setup();
    renderPill();

    await openModelStage(user);
    await user.click(document.body);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('supports Arrow/Home/End/Enter/Escape from the search field', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    const search = within(dialog).getByRole('combobox', { name: 'Buscar modelos' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    const initial = search.getAttribute('aria-activedescendant');
    expect(initial).toBeTruthy();

    const options = within(dialog).getAllByRole('option');
    await user.keyboard('{End}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[options.length - 1].id);
    expect(optionById(search.getAttribute('aria-activedescendant'))?.textContent).toContain(
      'Omen Alpha',
    );

    await user.keyboard('{Home}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[0].id);

    await user.keyboard('{ArrowDown}');
    expect(search.getAttribute('aria-activedescendant')).toBe(options[1].id);

    await user.keyboard('{Enter}');
    expect(useAppStore.getState().selection.modelId).toBe('glm-5.3-flash');
    expect(await screen.findByText('Modo de pensamento')).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(modelTrigger()));
  });
});

describe('ModelPill (thinking step)', () => {
  it('continues in the same popover after picking a reasoning model and applies the mode', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.click(within(dialog).getByRole('option', { name: 'GLM-5.3-Flash' }));

    expect(await screen.findByText('Modo de pensamento')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Buscar modelos' })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Modo de pensamento' })).toBeTruthy();
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: GO,
      modelId: 'glm-5.3-flash',
    });

    await user.click(screen.getByRole('option', { name: /^Máximo/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'max',
    });
  });

  it('advances to the thinking step when picking the already selected model', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.click(within(dialog).getByRole('option', { name: 'DeepSeek V4.1 Flash' }));

    expect(await screen.findByText('Modo de pensamento')).toBeTruthy();
    expect(screen.getByRole('option', { name: /^Alto/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('closes without a thinking step for models without reasoning control', async () => {
    const user = userEvent.setup();
    renderPill();

    const dialog = await openModelStage(user);
    await user.click(within(dialog).getByRole('option', { name: 'MiMo-V2.6-Flash' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Modo de pensamento')).toBeNull();
    expect(useAppStore.getState().selection.modelId).toBe('mimo-v2.6-flash');
  });

  it('opens the thinking step directly from the ✦ segment and goes back to the list', async () => {
    const user = userEvent.setup();
    renderPill();

    await openThinkingStage(user);

    expect(screen.getByText('Modo de pensamento')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Modo de pensamento' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Buscar modelos' })).toBeNull();
    expect(screen.getByRole('option', { name: /^Alto/ }).getAttribute('aria-selected')).toBe(
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Voltar para a lista de modelos' }));

    expect(await screen.findByRole('combobox', { name: 'Buscar modelos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ver todos os modelos/ })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Selecionar modelo' })).toBeTruthy();
  });

  it('applies a thinking mode picked from the ✦ shortcut and closes', async () => {
    const user = userEvent.setup();
    renderPill();

    await openThinkingStage(user);
    await user.click(screen.getByRole('option', { name: /^Desligado/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAppStore.getState().selection.reasoning).toEqual({ mode: 'off' });
  });

  it('navigates and applies a thinking mode with the keyboard', async () => {
    const user = userEvent.setup();
    renderPill();

    await openThinkingStage(user);
    const listbox = screen.getByRole('listbox', { name: 'Modo de pensamento' });
    await waitFor(() => expect(document.activeElement).toBe(listbox));

    const current = screen.getByRole('option', { name: /^Alto/ });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(current.id);

    await user.keyboard('{ArrowDown}');
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /^Máximo/ }).id,
    );

    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'max',
    });
  });

  it('keeps the popover open while dragging and commits on release', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, reasoningSliderEnabled: true },
    });
    const user = userEvent.setup();
    renderPill();

    await openThinkingStage(user);

    expect(screen.queryByRole('listbox', { name: 'Modo de pensamento' })).toBeNull();
    const slider = screen.getByRole('slider', { name: 'Nível de pensamento' });
    fireEvent.change(slider, { target: { value: '3' } });

    // Dragging only previews: the popover stays open and the selection is untouched.
    expect(screen.getByRole('dialog', { name: 'Selecionar modelo' })).toBeTruthy();
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'high',
    });

    fireEvent.pointerUp(slider);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'max',
    });
  });
});

describe('ModelPill (model locked)', () => {
  it('blocks the model segment after the conversation starts', async () => {
    lockModelOnConversation();
    const user = userEvent.setup();
    renderPill();

    const trigger = modelLockedTrigger();
    expect(trigger.getAttribute('aria-label')).toBe(
      `Modelo bloqueado nesta conversa. Atual: DeepSeek V4.1 Flash`,
    );
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBeNull();
    expect(trigger.getAttribute('title')).toBe(i18n.t(MODEL_LOCKED_DESCRIPTION));
    expect(trigger.disabled).toBe(false);
    expect(trigger.querySelector('svg.lucide-lock')).toBeTruthy();
    expect(trigger.querySelector('svg.lucide-chevron-down')).toBeNull();

    await user.click(trigger);

    // Clicking does not open the picker; it explains why instead.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(toast.info).toHaveBeenCalledWith(i18n.t(MODEL_LOCKED_TITLE), {
      description: i18n.t(MODEL_LOCKED_DESCRIPTION),
    });
  });

  it('keeps the thinking segment working while the model is locked', async () => {
    lockModelOnConversation();
    const user = userEvent.setup();
    renderPill();

    const thinking = thinkingTrigger();
    expect(thinking.disabled).toBe(false);

    await user.click(thinking);
    expect(await screen.findByText('Modo de pensamento')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Modo de pensamento' })).toBeTruthy();
    // No way back to the model list while the model is locked.
    expect(screen.queryByRole('combobox', { name: 'Buscar modelos' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Voltar para a lista de modelos' }),
    ).toBeNull();

    await user.click(screen.getByRole('option', { name: /^Máximo/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useAppStore.getState().selection.reasoning).toEqual({
      mode: 'effort',
      effort: 'max',
    });
  });

  it('opens the model step when the active conversation is empty', async () => {
    useChatStore.setState({
      activeId: 'conv-empty',
      conversations: [
        {
          id: 'conv-empty',
          title: 'Nova conversa',
          createdAt: 1,
          updatedAt: 1,
          pinned: false,
          providerId: GO,
          modelId: CURRENT_MODEL,
          messageCount: 0,
        },
      ],
      messagesByConversation: { 'conv-empty': [] },
    });
    const user = userEvent.setup();
    renderPill();

    expect(modelTrigger().getAttribute('aria-disabled')).toBeNull();
    const dialog = await openModelStage(user);
    expect(within(dialog).getByRole('listbox', { name: 'Modelos' })).toBeTruthy();
  });

  it('opens the model step when there is no active conversation', async () => {
    const user = userEvent.setup();
    renderPill();

    expect(useChatStore.getState().activeId).toBeNull();
    expect(modelTrigger().getAttribute('aria-disabled')).toBeNull();
    const dialog = await openModelStage(user);
    expect(within(dialog).getByRole('combobox', { name: 'Buscar modelos' })).toBeTruthy();
  });

  it('closes the model step if the conversation starts while it is open', async () => {
    const user = userEvent.setup();
    renderPill();

    await openModelStage(user);
    expect(screen.getByRole('dialog', { name: 'Selecionar modelo' })).toBeTruthy();

    act(() => {
      useChatStore.setState({
        streaming: {
          turnId: 'turn-1',
          conversationId: 'conv-1',
          assistantId: 'assistant-1',
          userMessageId: null,
          phase: 'starting',
          step: 0,
          startedAt: 1,
          turnKind: 'user',
        },
      });
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(streamingLockedTrigger()).toBeTruthy();
  });

  it('switches the model of a started Code session through chooseModel', async () => {
    startCodeSession();
    const user = userEvent.setup();
    renderPill();

    const trigger = modelTrigger();
    expect(trigger.getAttribute('aria-disabled')).toBeNull();
    expect(trigger.querySelector('svg.lucide-lock')).toBeNull();

    const dialog = await openModelStage(user);
    await user.click(within(dialog).getByRole('option', { name: 'MiMo-V2.6-Flash' }));

    await waitFor(() =>
      expect(apiMocks.setConversationModel).toHaveBeenCalledWith(
        'conv-code',
        GO,
        'mimo-v2.6-flash',
      ),
    );
    // The pair is a session property: persisted on the conversation, while the
    // configured defaults stay untouched.
    await waitFor(() =>
      expect(useChatStore.getState().conversations[0]).toMatchObject({
        providerId: GO,
        modelId: 'mimo-v2.6-flash',
      }),
    );
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: GO,
      modelId: 'mimo-v2.6-flash',
    });
    expect(apiMocks.saveSettings).not.toHaveBeenCalled();
  });

  it('explains the streaming lock in the Code layout with the specific copy', async () => {
    startCodeSession();
    useChatStore.setState({
      streaming: {
        turnId: 'turn-1',
        conversationId: 'conv-code',
        assistantId: 'assistant-1',
        userMessageId: null,
        phase: 'text',
        step: 1,
        startedAt: 1,
        turnKind: 'user',
      },
    });
    const user = userEvent.setup();
    renderPill();

    const trigger = streamingLockedTrigger();
    expect(trigger.getAttribute('aria-label')).toBe(
      'Troca de modelo indisponível durante a resposta. Atual: DeepSeek V4.1 Flash',
    );
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
    expect(trigger.getAttribute('title')).toBe(i18n.t(MODEL_STREAMING_LOCKED_DESCRIPTION));
    expect(trigger.querySelector('svg.lucide-lock')).toBeTruthy();

    await user.click(trigger);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(i18n.t(MODEL_STREAMING_LOCKED_TITLE), {
      description: i18n.t(MODEL_STREAMING_LOCKED_DESCRIPTION),
    });
  });
});

describe('ModelPill (disabled)', () => {
  it('disables both segments when the disabled prop is set', () => {
    renderPill(<ModelPill disabled />);

    expect(modelTrigger().disabled).toBe(true);
    expect(thinkingTrigger().disabled).toBe(true);
  });

  it('disables the thinking segment for models without reasoning control', () => {
    renderPill(<ModelPill providerId={GO} modelId="mimo-v2.6-flash" reasoning={null} />);

    expect(thinkingTrigger().disabled).toBe(true);
    expect(thinkingTrigger().getAttribute('title')).toBe(
      'Este modelo não expõe controle de raciocínio',
    );
    expect(modelTrigger().disabled).toBe(false);
  });
});
