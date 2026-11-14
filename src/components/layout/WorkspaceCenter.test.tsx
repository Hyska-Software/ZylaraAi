// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/chat/ChatView', () => ({
  ChatView: ({ welcome }: { welcome?: unknown }) => (
    <div data-testid="chat-view">{welcome ? <div data-testid="custom-welcome" /> : null}</div>
  ),
}));

vi.mock('@/components/code', () => ({
  CodeSessionHeader: () => <div data-testid="code-session-header" />,
  CodeWelcomeScreen: () => <div data-testid="code-welcome" />,
  CodeCommitHistoryView: ({ target }: { target: { revision: string | null } }) => (
    <div data-testid="code-commits-view">{target.revision ?? 'lista'}</div>
  ),
  CodeDiffView: ({ target }: { target: { path: string } }) => (
    <div data-testid="code-diff-view">{target.path}</div>
  ),
  CodeFileView: ({ target, className }: { target: { path: string }; className?: string }) => (
    <div data-testid="code-file-view" className={className}>
      {target.path}
    </div>
  ),
  CodePlanView: ({ tab }: { tab: { markdown: string } }) => (
    <div data-testid="code-plan-view">{tab.markdown}</div>
  ),
  GoalPanel: ({ conversationId, className }: { conversationId: string; className?: string }) => (
    <section
      id="code-goal-panel"
      role="region"
      aria-label="Objetivo da sessão"
      className={className}
      data-testid="goal-panel"
    >
      {conversationId}
    </section>
  ),
  GoalDialog: ({
    conversationId,
    mode,
    onClose,
  }: {
    conversationId: string;
    mode: 'create' | 'edit';
    onClose: () => void;
  }) => (
    <div data-testid="goal-dialog">
      <span>{`${mode}:${conversationId}`}</span>
      <button type="button" onClick={onClose}>
        Fechar diálogo do objetivo
      </button>
    </div>
  ),
  TerminalPanel: ({
    conversationId,
    surface,
    showTabStrip,
    className,
  }: {
    conversationId?: string | null;
    surface?: string;
    showTabStrip?: boolean;
    className?: string;
  }) => (
    <div
      data-testid="terminal-panel"
      data-surface={surface}
      data-tabstrip={String(showTabStrip)}
      className={className}
    >
      {conversationId ?? 'sem-sessao'}
    </div>
  ),
  GitHubPullRequestsView: ({ tab }: { tab: { workspaceId: string } }) => (
    <div data-testid="github-prs-view">{tab.workspaceId}</div>
  ),
  GitHubPullRequestView: ({ tab }: { tab: { workspaceId: string; number: number } }) => (
    <div data-testid="github-pr-view">
      {tab.workspaceId}#{tab.number}
    </div>
  ),
  GitHubIssuesView: ({ tab }: { tab: { workspaceId: string } }) => (
    <div data-testid="github-issues-view">{tab.workspaceId}</div>
  ),
  GitHubIssueView: ({ tab }: { tab: { workspaceId: string; number: number } }) => (
    <div data-testid="github-issue-view">
      {tab.workspaceId}#{tab.number}
    </div>
  ),
}));

vi.mock('@/components/agent/SubagentChatView', () => ({
  SubagentChatView: ({ target }: { target: { description: string } }) => (
    <div data-testid="subagent-chat-view">{target.description}</div>
  ),
}));

vi.mock('@/components/skills', () => ({
  SkillsView: ({ onBack, backLabel }: { onBack?: () => void; backLabel?: string }) => (
    <div data-testid="skills-view">
      <button type="button" onClick={onBack}>
        {backLabel}
      </button>
    </div>
  ),
}));

vi.mock('@/components/library', () => ({
  LibraryView: () => <div data-testid="library-view" />,
}));

import { useChatStore, useUiStore } from '@/lib/store';
import { WorkspaceCenter } from './WorkspaceCenter';

beforeEach(() => {
  useUiStore.setState({
    layoutMode: 'chat',
    codeView: 'session',
    activeView: 'chat',
    codeDiffTab: null,
    codeCommitsTab: null,
    codeFileTab: null,
    codePlanTab: null,
    codeSubagentTabs: [],
    codeSubagentTab: null,
    codePullRequestsTab: null,
    codePullRequestTabs: [],
    codePullRequestTab: null,
    codeIssuesTab: null,
    codeIssueTabs: [],
    codeIssueTab: null,
    codeGoalOpen: false,
    goalDialog: null,
  });
  useChatStore.setState({ activeId: null });
});

afterEach(() => {
  cleanup();
});

describe('WorkspaceCenter — modo Chat', () => {
  it('shows the conversation by default', () => {
    render(<WorkspaceCenter />);

    expect(screen.getByTestId('chat-view')).toBeTruthy();
    expect(screen.queryByTestId('code-session-header')).toBeNull();
    expect(screen.queryByTestId('skills-view')).toBeNull();
    expect(screen.queryByTestId('library-view')).toBeNull();
    // Chat uses the native chat welcome, not the Code one.
    expect(screen.queryByTestId('custom-welcome')).toBeNull();
  });

  it('replaces the conversation with Skills but keeps the chat mounted', () => {
    useUiStore.setState({ activeView: 'skills' });
    render(<WorkspaceCenter />);

    const chat = screen.getByTestId('chat-view');
    expect(chat.parentElement?.className).toContain('hidden');
    expect(screen.getByRole('button', { name: 'Voltar ao chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao chat' }));

    expect(useUiStore.getState().activeView).toBe('chat');
  });

  it('shows the Biblioteca only in the Chat layout', () => {
    useUiStore.setState({ activeView: 'library' });
    render(<WorkspaceCenter />);

    expect(screen.getByTestId('library-view')).toBeTruthy();
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });
});

describe('WorkspaceCenter — modo Code', () => {
  it('shows the session header and the Code welcome above the shared chat', () => {
    useUiStore.setState({ layoutMode: 'code' });
    render(<WorkspaceCenter />);

    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('chat-view')).toBeTruthy();
    expect(screen.getByTestId('custom-welcome')).toBeTruthy();
    expect(screen.queryByTestId('library-view')).toBeNull();
  });

  it('opens the existing Skills page with the Code back label', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'skills' });
    render(<WorkspaceCenter />);

    // The session header stays mounted (hidden) so the open tabs survive.
    const header = screen.getByTestId('code-session-header');
    expect(header.parentElement?.className).toContain('hidden');
    expect(header.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Voltar à sessão' }));

    expect(useUiStore.getState().codeView).toBe('session');
  });

  it('never renders the Biblioteca, even with a stale activeView', () => {
    useUiStore.setState({ layoutMode: 'code', activeView: 'library' });
    render(<WorkspaceCenter />);

    expect(screen.queryByTestId('library-view')).toBeNull();
    expect(screen.getByTestId('chat-view')).toBeTruthy();
  });

  it('mostra o diff como aba central, mantém header e chat montados', () => {
    useUiStore.setState({
      layoutMode: 'code',
      codeView: 'diff',
      codeDiffTab: {
        workspaceId: 'ws-1',
        path: 'src/app.ts',
        staged: false,
        knownDiff: '@@ -1 +1 @@\n-a\n+b',
      },
    });

    render(<WorkspaceCenter />);

    expect(screen.getByTestId('code-diff-view').textContent).toContain('src/app.ts');
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    // O chat compartilhado continua montado (estado preservado), só oculto.
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
    expect(screen.getByTestId('code-session-header').parentElement?.className).not.toContain(
      'hidden',
    );
  });
  it('mostra o terminal central sem desmontar o chat', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'terminal' });
    useChatStore.setState({ activeId: 'c-1' });

    render(<WorkspaceCenter />);

    const terminal = screen.getByTestId('terminal-panel');
    expect(terminal.getAttribute('data-surface')).toBe('center');
    expect(terminal.getAttribute('data-tabstrip')).toBe('false');
    expect(terminal.textContent).toBe('c-1');
    // Same contract as the other center views: header visible, chat mounted hidden.
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('code-session-header').parentElement?.className).not.toContain(
      'hidden',
    );
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });

  it('mostra o terminal central mesmo sem sessão ativa', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'terminal' });
    useChatStore.setState({ activeId: null });

    render(<WorkspaceCenter />);

    const terminal = screen.getByTestId('terminal-panel');
    expect(terminal.getAttribute('data-surface')).toBe('center');
    // Global terminal list: no session is needed to look at open terminals.
    expect(terminal.textContent).toBe('sem-sessao');
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });

  it('keeps the same chat instance when switching layouts', () => {
    render(<WorkspaceCenter />);
    const chat = screen.getByTestId('chat-view');
    expect(chat).toBeTruthy();

    act(() => useUiStore.getState().setLayoutMode('code'));

    expect(screen.getByTestId('chat-view')).toBe(chat);
    expect(screen.getByTestId('custom-welcome')).toBeTruthy();
  });
});

describe('WorkspaceCenter — histórico de commits', () => {
  it('mostra a aba de commits no centro mantendo header e chat montados', () => {
    useUiStore.setState({
      layoutMode: 'code',
      codeView: 'commits',
      codeCommitsTab: { workspaceId: 'ws-1', revision: null },
    });

    render(<WorkspaceCenter />);

    expect(screen.getByTestId('code-commits-view').textContent).toContain('lista');
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });
});

describe('WorkspaceCenter — aba central de plano', () => {
  it('mostra o plano aprovado no centro mantendo header e chat montados', () => {
    useUiStore.setState({
      layoutMode: 'code',
      codeView: 'plan',
      codePlanTab: {
        conversationId: 'c-1',
        markdown: '# Plano aprovado',
        title: 'Plano',
        updatedAt: 1,
      },
    });

    render(<WorkspaceCenter />);

    const panel = screen.getByRole('region', { name: 'Plano aprovado da sessão' });
    expect(panel.id).toBe('code-plan-panel');
    expect(screen.getByTestId('code-plan-view').textContent).toContain('# Plano aprovado');
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });
});

describe('WorkspaceCenter — aba central de arquivo', () => {
  it('mostra o arquivo no centro com header visível e chat montado/oculto', () => {
    useUiStore.setState({
      layoutMode: 'code',
      codeView: 'file',
      codeFileTab: { workspaceId: 'ws-1', path: 'src/app.ts' },
    });

    render(<WorkspaceCenter />);

    const panel = screen.getByRole('region', { name: 'Arquivo src/app.ts' });
    expect(panel.id).toBe('code-file-panel');
    expect(panel.className).toContain('flex');
    expect(panel.className).toContain('min-h-0');
    expect(panel.className).toContain('flex-1');

    const fileView = screen.getByTestId('code-file-view');
    expect(fileView.textContent).toContain('src/app.ts');
    expect(fileView.className).toContain('flex');
    expect(fileView.className).toContain('min-h-0');
    expect(fileView.className).toContain('flex-1');

    // O header das sessões continua montado/visível para trocar de aba.
    const header = screen.getByTestId('code-session-header');
    expect(header.parentElement?.className).not.toContain('hidden');
    expect(header.parentElement?.getAttribute('aria-hidden')).toBeNull();

    // O chat compartilhado segue montado (estado preservado), só oculto.
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
    expect(screen.queryByTestId('library-view')).toBeNull();
  });

  it('volta ao chat quando codeView é file sem alvo aberto', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'file' });

    render(<WorkspaceCenter />);

    expect(screen.queryByTestId('code-file-view')).toBeNull();
    expect(screen.getByTestId('chat-view').parentElement?.className).not.toContain('hidden');
  });
});

describe('WorkspaceCenter - aba central de subagente', () => {
  it('mostra o chat do subagente no centro mantendo header e chat montados', () => {
    useUiStore.setState({
      layoutMode: 'code',
      codeView: 'subagent',
      codeSubagentTabs: [
        {
          conversationId: 'child-1',
          taskCallId: 'task-1',
          subagentType: 'review',
          description: 'Revisar o diff',
        },
      ],
      codeSubagentTab: {
        conversationId: 'child-1',
        taskCallId: 'task-1',
        subagentType: 'review',
        description: 'Revisar o diff',
      },
    });

    render(<WorkspaceCenter />);

    expect(screen.getByTestId('subagent-chat-view').textContent).toBe('Revisar o diff');
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });
});

describe('WorkspaceCenter - superfícies do GitHub', () => {
  it('renderiza as listas e os detalhes no centro e oculta a conversa', () => {
    useUiStore.setState({
      layoutMode: 'code',
      codeView: 'prs',
      codePullRequestsTab: { workspaceId: 'ws-1' },
    });

    render(<WorkspaceCenter />);

    expect(screen.getByTestId('github-prs-view').textContent).toBe('ws-1');
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');

    act(() => {
      useUiStore.getState().openCodePullRequest({ workspaceId: 'ws-1', number: 42, title: 'PR' });
    });
    expect(screen.getByTestId('github-pr-view').textContent).toBe('ws-1#42');
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');

    act(() => {
      useUiStore.getState().openCodeIssues('ws-1');
    });
    expect(screen.getByTestId('github-issues-view').textContent).toBe('ws-1');
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');

    act(() => {
      useUiStore.getState().openCodeIssue({ workspaceId: 'ws-1', number: 9, title: 'Issue' });
    });
    expect(screen.getByTestId('github-issue-view').textContent).toBe('ws-1#9');
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });
});

describe('WorkspaceCenter - aba central de objetivo', () => {
  it('mostra o GoalPanel no centro com header e chat montados/ocultos', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'goal', codeGoalOpen: true });
    useChatStore.setState({ activeId: 'c-1' });

    render(<WorkspaceCenter />);

    // O GoalPanel é dono da region/id (sem wrapper duplicado no WorkspaceCenter).
    const panel = screen.getByRole('region', { name: 'Objetivo da sessão' });
    expect(panel.id).toBe('code-goal-panel');
    expect(panel.textContent).toContain('c-1');
    expect(screen.getByTestId('code-session-header')).toBeTruthy();
    expect(screen.getByTestId('chat-view').parentElement?.className).toContain('hidden');
  });

  it('sem sessão ativa volta para o chat em vez de um painel fantasma', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'goal', codeGoalOpen: true });
    useChatStore.setState({ activeId: null });

    render(<WorkspaceCenter />);

    expect(screen.queryByTestId('goal-panel')).toBeNull();
    expect(screen.getByTestId('chat-view').parentElement?.className).not.toContain('hidden');
  });

  it('não renderiza o painel do objetivo fora da view goal', () => {
    useUiStore.setState({ layoutMode: 'code', codeView: 'session' });
    useChatStore.setState({ activeId: 'c-1' });

    render(<WorkspaceCenter />);

    expect(screen.queryByTestId('goal-panel')).toBeNull();
    expect(screen.getByTestId('chat-view').parentElement?.className).not.toContain('hidden');
  });

  it('monta o GoalDialog quando o uiStore pede e fecha pelo onClose', () => {
    useUiStore.setState({
      layoutMode: 'code',
      goalDialog: { conversationId: 'c-1', mode: 'edit' },
    });

    render(<WorkspaceCenter />);

    expect(screen.getByTestId('goal-dialog').textContent).toContain('edit:c-1');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar diálogo do objetivo' }));
    expect(useUiStore.getState().goalDialog).toBeNull();
  });

  it('não monta o diálogo quando goalDialog é null', () => {
    useUiStore.setState({ layoutMode: 'code', goalDialog: null });

    render(<WorkspaceCenter />);

    expect(screen.queryByTestId('goal-dialog')).toBeNull();
  });
});
