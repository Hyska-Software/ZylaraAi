// @vitest-environment jsdom
/**
 * Regressão de integração do Thinking do layout Code (task-4).
 *
 * Monta o transcript REAL do layout Code — `ChatView` sem mock de
 * `MessageList`/`AgentSteps`, e o `Composer` real — para provar que o bloco
 * "Thinking" renderiza o raciocínio como Markdown (variante `thinking`) e que as
 * diferenças do Code continuam: linha por chamada do harness (`ToolCallRow`) e
 * chrome próprio (header/abas e composer do Code). Por fim, troca o
 * `layoutMode` e prova que o conteúdo do transcript não depende do chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatMessage, Conversation, ToolCallRecord } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  // `useWorkspaces`/`CodeSessionHeader` (layout Code).
  listWorkspaces: vi.fn(),
  getWorkspace: vi.fn(),
  setWorkspaceTrusted: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  addWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  setConversationWorkspace: vi.fn(),
  openWorkspaceInExplorer: vi.fn(),
  getCodeSessionState: vi.fn(),
  // Composer/lojas.
  searchWorkspaceFiles: vi.fn(),
  compactSession: vi.fn(),
  setPlanMode: vi.fn(),
  setPermissionMode: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  listArtifacts: vi.fn(),
  getConversation: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// Imported after the mocks above.
import { useAppStore, useChatStore, useCodeStore, useUiStore } from '@/lib/store';
import { ChatView } from '@/components/chat/ChatView';
import { CodeSessionHeader } from './CodeSessionHeader';
import { CodeWelcomeScreen } from './CodeWelcomeScreen';
import { __resetWorkspacesForTests } from './useWorkspaces';

/** Instante inicial da seleção (a suíte inteira roda sobre um catálogo estático). */
const INITIAL_SELECTION = useAppStore.getState().selection;

/**
 * Raciocínio como o harness persiste: Markdown bruto por passo, sem pré-processar
 * (docs/MARKDOWN.md §4). Negrito, lista, código inline e cerca cercada.
 */
const REASONING = [
  '**Analisando** o repositório.',
  '',
  '- leu `src/app.ts`',
  '- rodou os testes',
  '',
  '```ts',
  'export const total = 2;',
  '```',
].join('\n');

function userMessage(conversationId: string): ChatMessage {
  return {
    id: 'user-1',
    conversationId,
    role: 'user',
    content: 'Corrija o build.',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 1,
  };
}

function harnessTool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result: string,
): ToolCallRecord {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
    result,
    status: 'done',
  };
}

function assistantMessage(conversationId: string): ChatMessage {
  return {
    id: 'assistant-1',
    conversationId,
    role: 'assistant',
    content: 'Pronto — ajustei o arquivo e os testes passaram.',
    reasoning: REASONING,
    status: 'complete',
    // Tools do harness de código: o layout Code mostra uma linha por chamada.
    toolCalls: [
      harnessTool('call-read', 'read_file', { path: 'src/app.ts' }, 'export const app = true;'),
      harnessTool(
        'call-run',
        'run_command',
        { command: 'pnpm test' },
        '[exit code: 0]\n(duração: 2100 ms)\nTest Files 12 passed',
      ),
    ],
    citations: [],
    attachments: [],
    trace: [{ reasoning: REASONING, toolCalls: 2 }],
    modelId: 'deepseek-v4.1-flash',
    providerId: 'opencode-go',
    usage: { durationMs: 4_000 },
    createdAt: 2,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-code',
    title: 'Corrigir o build',
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    providerId: 'opencode-go',
    modelId: 'deepseek-v4.1-flash',
    messageCount: 2,
    mode: 'code',
    workspaceId: 'ws-1',
    permissionMode: 'edit',
    ...overrides,
  };
}

/** Semeia a conversa ativa e o estado de UI do layout Code. */
function seed(active: Conversation = conversation()): Conversation {
  useChatStore.setState({
    conversations: [active],
    activeId: active.id,
    activeIdByLayout: { chat: null, code: active.id, agent: null },
    messagesByConversation: {
      [active.id]: [userMessage(active.id), assistantMessage(active.id)],
    },
    streaming: null,
    loadingConversationId: null,
    pendingAttachments: [],
    error: null,
    errorCode: null,
    errorHint: null,
  });
  useUiStore.setState({
    layoutMode: 'code',
    codeView: 'session',
    activeWorkspaceId: 'ws-1',
    settingsOpen: false,
  });
  useCodeStore.setState({ byConversation: {} });
  return active;
}

/**
 * Centro do layout real: `WorkspaceCenter` monta o `ChatView` compartilhado e só
 * troca o welcome (Code no modo Code, nativo no Chat). O painel tem o mesmo id
 * usado pelo `aria-controls` das abas do header (`code-session-panel`).
 */
function CodeTranscript() {
  const layoutMode = useUiStore((state) => state.layoutMode);
  return (
    <div id="code-session-panel" role="region" aria-label="Conversa">
      <ChatView welcome={layoutMode === 'code' ? <CodeWelcomeScreen /> : undefined} />
    </div>
  );
}

/**
 * Header agregado do bloco Thinking: no layout Code o tempo inclui ferramentas e
 * comandos ("Trabalhou por …"); no Chat o bloco resume o raciocínio do modelo
 * ("Pensou por …") — diferença de copy por layout (task-6).
 */
const thinkingHeader = (): HTMLElement =>
  screen.getByRole('button', { name: /Trabalhou por 4s/ });

/** O mesmo bloco já no layout Chat (copy de raciocínio). */
const chatThinkingHeader = (): HTMLElement =>
  screen.getByRole('button', { name: /Pensou por 4s/ });

/** Expands the outer timeline and the reasoning row (closed by default). */
async function openThinking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(thinkingHeader());
  await user.click(screen.getByRole('button', { name: 'Pensou' }));
}

/** Itens da lista Markdown do raciocínio (o `getByText` não atravessa o `<code>`). */
function bulletTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('ul li')).map((item) => item.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  // This regression asserts the detailed timeline, now an opt-in preference.
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings, detailedAgentStepsEnabled: true },
  });
  mocks.listWorkspaces.mockResolvedValue([]);
  mocks.getWorkspace.mockResolvedValue(null);
  mocks.getCodeSessionState.mockResolvedValue(null);
  mocks.listConversations.mockResolvedValue([]);
  mocks.listArtifacts.mockResolvedValue([]);
  mocks.searchWorkspaceFiles.mockResolvedValue([]);
  __resetWorkspacesForTests();
  // jsdom não implementa rolagem de elemento; o ChatView rola o transcript.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  __resetWorkspacesForTests();
  useAppStore.setState({
    providers: [],
    auth: [],
    keys: [],
    selection: INITIAL_SELECTION,
    settings: { ...useAppStore.getState().settings, detailedAgentStepsEnabled: false },
  });
  useUiStore.setState({
    layoutMode: 'chat',
    codeView: 'session',
    activeWorkspaceId: null,
    settingsOpen: false,
    artifacts: [],
  });
  useChatStore.setState({
    conversations: [],
    activeId: null,
    activeIdByLayout: { chat: null, code: null, agent: null },
    messagesByConversation: {},
    streaming: null,
    loadingConversationId: null,
    pendingAttachments: [],
    error: null,
    errorCode: null,
    errorHint: null,
  });
  useCodeStore.setState({ byConversation: {} });
});

describe('CodeTranscriptThinking — Thinking em Markdown no layout Code', () => {
  it('renderiza o raciocínio como Markdown e mantém as linhas por chamada do Code', async () => {
    const user = userEvent.setup();
    seed();
    const { container } = render(<CodeTranscript />);

    // Transcript real, sem mocks de MessageList/AgentSteps.
    expect(screen.getByRole('log')).toBeTruthy();
    expect(screen.getByText('Pronto — ajustei o arquivo e os testes passaram.')).toBeTruthy();

    // Composer REAL na variante do Code (aria-label e copy próprias).
    const composer = screen.getByRole('textbox', { name: 'Tarefa para o agente' });
    expect(composer.getAttribute('placeholder')).toBe(
      'Descreva a tarefa… @ para arquivos, / para comandos',
    );

    // O bloco "Thinking" começa recolhido e, no Code, anuncia o turno inteiro
    // ("Trabalhou por …") — não a copy de raciocínio do Chat.
    expect(thinkingHeader()).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pensou por 4s/ })).toBeNull();
    expect(screen.queryByText('Pensou')).toBeNull();
    expect(screen.queryByText('Analisando')).toBeNull();

    await openThinking(user);

    // Markdown de verdade dentro do raciocínio (nada de marcador vazando).
    expect(container.querySelector('strong')?.textContent).toBe('Analisando');
    const bullets = bulletTexts(container);
    expect(bullets).toContain('leu src/app.ts');
    expect(bullets).toContain('rodou os testes');
    expect(screen.getByText('ts')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
    expect(container.textContent).toContain('export const total = 2;');
    expect(container.textContent).not.toContain('**Analisando**');
    expect(container.textContent).not.toContain('```ts');

    // Prosa do raciocínio na variante compacta/muted; resposta na variante default.
    expect(container.querySelectorAll('.zylara-prose--thinking')).toHaveLength(1);
    expect(container.querySelectorAll('.zylara-prose')).toHaveLength(2);

    // Diferença do layout mantida: uma linha por chamada (ToolCallRow), com
    // rótulos pt-BR — não os resumos agrupados do Chat.
    expect(screen.getByRole('listitem', { name: 'Leu src/app.ts' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Executou pnpm test' })).toBeTruthy();
    expect(screen.queryByText(/páginas web/)).toBeNull();

    // A saída do comando continua disponível sob demanda.
    const commandRow = screen.getByRole('listitem', { name: 'Executou pnpm test' });
    await user.click(within(commandRow).getByRole('button', { expanded: false }));
    expect(screen.getByText('Test Files 12 passed')).toBeTruthy();
  });

  it('mantém o chrome do Code (header, abas e controles do composer) acima do transcript', async () => {
    const user = userEvent.setup();
    seed();
    render(
      <div className="flex h-full min-h-0 flex-col">
        <CodeSessionHeader />
        <CodeTranscript />
      </div>,
    );

    // Header/abas do Code continuam montados (o conteúdo abaixo é o transcript).
    expect(screen.getByRole('heading', { name: 'Corrigir o build' })).toBeTruthy();
    const tab = screen.getByRole('tab', { name: 'Corrigir o build' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('aria-controls')).toBe('code-session-panel');
    // Controles de sessão que só existem no composer do Code.
    expect(screen.getByRole('button', { name: 'Modo de permissão: Editar' })).toBeTruthy();

    await openThinking(user);
    expect(screen.getByText('Analisando').tagName).toBe('STRONG');
    expect(screen.getByRole('listitem', { name: 'Leu src/app.ts' })).toBeTruthy();
  });

  it('troca Code ⇄ Chat sem perder o Thinking em Markdown (sessão compartilhada)', async () => {
    const user = userEvent.setup();
    // Sessão do Chat adicionada ao Code: visível nos dois layouts.
    seed(
      conversation({
        id: 'conv-shared',
        title: 'Sessão compartilhada',
        mode: 'chat',
        codeLinked: true,
      }),
    );
    const { container } = render(<CodeTranscript />);

    expect(screen.getByRole('textbox', { name: 'Tarefa para o agente' })).toBeTruthy();
    await openThinking(user);
    expect(screen.getByText('Analisando').tagName).toBe('STRONG');

    // Mesma instância de ChatView; só o chrome (composer) muda.
    act(() => {
      useUiStore.setState({ layoutMode: 'chat' });
    });

    expect(screen.getByRole('textbox', { name: 'Mensagem para o Zylara' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Tarefa para o agente' })).toBeNull();

    // A copy do mesmo bloco acompanha o layout: Chat volta a "Pensou por …".
    expect(chatThinkingHeader()).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Trabalhou por 4s/ })).toBeNull();

    // O transcript e o bloco expandido continuam intactos.
    expect(screen.getByRole('log')).toBeTruthy();
    expect(screen.getByText('Analisando').tagName).toBe('STRONG');
    expect(bulletTexts(container)).toContain('leu src/app.ts');
    expect(screen.getByRole('listitem', { name: 'Leu src/app.ts' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Executou pnpm test' })).toBeTruthy();
    expect(container.querySelector('.zylara-prose--thinking')).toBeTruthy();
    expect(container.textContent).toContain('export const total = 2;');
  });

  it('mantém a separação de sessões do Code e restaura o Thinking ao voltar', async () => {
    const user = userEvent.setup();
    seed();
    const { container } = render(<CodeTranscript />);

    await openThinking(user);
    expect(screen.getByText('Analisando').tagName).toBe('STRONG');

    // Sessão nascida no Code não vaza para o Chat: a diferença de chrome é
    // também a separação de sessões documentada (lib/conversations).
    act(() => {
      useUiStore.setState({ layoutMode: 'chat' });
    });
    expect(screen.getByText('Como posso ajudar?')).toBeTruthy();
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.queryByText('Analisando')).toBeNull();
    expect(screen.queryByRole('button', { name: /Trabalhou por 4s/ })).toBeNull();

    // Ao voltar ao Code, o transcript remonta com o mesmo raciocínio em Markdown
    // e o header agregado do Code.
    act(() => {
      useUiStore.setState({ layoutMode: 'code' });
    });
    expect(thinkingHeader()).toBeTruthy();
    await openThinking(user);
    expect(screen.getByText('Analisando').tagName).toBe('STRONG');
    expect(bulletTexts(container)).toContain('leu src/app.ts');
    expect(screen.getByRole('listitem', { name: 'Leu src/app.ts' })).toBeTruthy();
  });
});
