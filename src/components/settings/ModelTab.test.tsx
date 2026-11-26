// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatMessage, Conversation, Settings } from '@/lib/types';

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    saveSettings: mocks.saveSettings,
  },
}));

// Imported after the mock above.
import { ModelTab } from '@/components/settings/ModelTab';
import { useAppStore, useChatStore, useUiStore } from '@/lib/store';

afterEach(() => cleanup());

const GO = 'opencode-go';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: 'system',
    themeId: 'zylara',
    borderRadiusEnabled: true,
    locale: 'pt-BR',
    defaultProvider: GO,
    defaultModel: 'glm-5.3-flash',
    reasoningDefault: 'high',
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

const conversation: Conversation = {
  id: 'conv-1',
  title: 'Conversa em andamento',
  createdAt: 1,
  updatedAt: 2,
  pinned: false,
  providerId: GO,
  modelId: 'deepseek-v4.1-flash',
  messageCount: 2,
};

const messages: ChatMessage[] = [
  {
    id: 'm1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Oi',
    status: 'complete',
    toolCalls: [],
    citations: [],
    attachments: [],
    createdAt: 1,
  },
];

function setStartedConversation(overrides: Partial<Conversation> = {}): void {
  const started = { ...conversation, ...overrides };
  useChatStore.setState({
    conversations: [started],
    activeId: started.id,
    messagesByConversation: { [started.id]: messages },
    streaming: null,
    loadingConversationId: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveSettings.mockImplementation(async (next: Settings) => ({
    settings: next,
    keys: [],
  }));
  useAppStore.setState({
    providers: [],
    settings: settings(),
    selection: {
      providerId: GO,
      modelId: 'deepseek-v4.1-flash',
      reasoning: { mode: 'effort', effort: 'max' },
    },
  });
  useChatStore.setState({
    conversations: [],
    activeId: null,
    messagesByConversation: {},
    streaming: null,
    loadingConversationId: null,
  });
  useUiStore.setState({ layoutMode: 'chat' });
});

describe('ModelTab — started conversation', () => {
  const STARTED_WARNING =
    /A conversa atual já foi iniciada\. As alterações abaixo valem apenas para as próximas conversas\./;

  it('updates only the default model (not the active selection) when a conversation is started', async () => {
    setStartedConversation();
    const user = userEvent.setup();
    render(<ModelTab />);

    expect(screen.getByText(STARTED_WARNING)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Modelo padrão'), 'claude-haiku-5-5');

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalled();
    });
    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-haiku-5-5', defaultProvider: GO }),
    );
    // The active conversation keeps its model.
    expect(useAppStore.getState().selection).toMatchObject({
      providerId: GO,
      modelId: 'deepseek-v4.1-flash',
    });
  });

  it('never changes a started Code session from this screen', async () => {
    useUiStore.setState({ layoutMode: 'code' });
    setStartedConversation({ mode: 'code' });
    const user = userEvent.setup();
    render(<ModelTab />);

    expect(screen.getByText(STARTED_WARNING)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Modelo padrão'), 'claude-haiku-5-5');

    await waitFor(() => {
      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultModel: 'claude-haiku-5-5' }),
      );
    });
    // Code sessions persist their model on the session itself (composer/palette),
    // so the settings tab must leave both the conversation and the selection alone.
    expect(useChatStore.getState().conversations[0]).toMatchObject({
      providerId: GO,
      modelId: 'deepseek-v4.1-flash',
    });
    expect(useAppStore.getState().selection.modelId).toBe('deepseek-v4.1-flash');
  });

  it('also changes the composer selection when there is no started conversation', async () => {
    const user = userEvent.setup();
    render(<ModelTab />);

    expect(screen.queryByText(STARTED_WARNING)).toBeNull();

    await user.selectOptions(screen.getByLabelText('Modelo padrão'), 'claude-haiku-5-5');

    await waitFor(() => {
      expect(useAppStore.getState().selection.modelId).toBe('claude-haiku-5-5');
    });
  });

  it('leaves the sliding level selector opt-in to the Experimental tab', () => {
    render(<ModelTab />);

    expect(
      screen.queryByRole('switch', {
        name: 'Ativar seletor deslizante de nível de pensamento',
      }),
    ).toBeNull();
  });
});
