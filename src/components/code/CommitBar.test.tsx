// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkspaceGitStatus } from '@/lib/types';
import { useAppStore } from '@/lib/store';

const mocks = vi.hoisted(() => ({
  gitLog: vi.fn(),
  suggestCommitMessage: vi.fn(),
  gitCommit: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('sonner', () => ({ toast: toastMocks }));

import { CommitBar, formatCommitDate, shortHash } from './CommitBar';

function status(overrides: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    isRepo: true,
    root: 'H:/projeto',
    branch: 'main',
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

const commits = [
  { hash: 'abc1234def5678', subject: 'Corrige contador', author: 'Ana', date: '2026-01-02T10:00:00Z' },
  { hash: 'def5678abc1234', subject: 'Adiciona testes', author: 'Bia', date: '2026-01-01T10:00:00Z' },
];

const message = () => screen.getByRole('textbox', { name: 'Mensagem do commit' }) as HTMLTextAreaElement;
const commitButton = () => screen.getByRole('button', { name: 'Commit' });

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    selection: { providerId: 'opencode-go', modelId: 'hy4-flash-free', reasoning: null },
  });
  mocks.gitLog.mockResolvedValue([]);
  mocks.suggestCommitMessage.mockResolvedValue('Mensagem sugerida pela IA');
  mocks.gitCommit.mockResolvedValue(status());
});

describe('CommitBar', () => {
  it('renders the target selector, counters and the message field', () => {
    render(<CommitBar workspaceId="ws-1" added={12} removed={3} hasChanges />);
    expect(screen.getByRole('combobox', { name: 'Alvo do commit' })).toBeTruthy();
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('−3')).toBeTruthy();
    expect(message()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sugerir mensagem' })).toBeTruthy();
  });

  it('uses the sidebar surface so the footer blends with the right panel', () => {
    const { container } = render(<CommitBar workspaceId="ws-1" hasChanges />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bg-surface');
    expect(root.className).not.toContain('bg-surface-raised');
  });

  it('disables the commit without a message and explains why', () => {
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(commitButton().getAttribute('title')).toBe('Escreva a mensagem do commit');
  });

  it('creates the commit and reports success with the short hash', async () => {
    mocks.gitLog.mockResolvedValueOnce([]).mockResolvedValue(commits);
    const onCommitted = vi.fn();
    const onRefresh = vi.fn();
    render(
      <CommitBar workspaceId="ws-1" hasChanges onCommitted={onCommitted} onRefresh={onRefresh} />,
    );
    await waitFor(() => expect(mocks.gitLog).toHaveBeenCalled());

    fireEvent.change(message(), { target: { value: 'Corrige o contador' } });
    expect((commitButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(commitButton());

    await waitFor(() =>
      expect(mocks.gitCommit).toHaveBeenCalledWith(
        'ws-1',
        'Corrige o contador',
        'all',
        undefined,
      ),
    );
    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('Commit criado (abc1234)'));
    expect(onCommitted).toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
    expect(message().value).toBe('');
  });

  it('commits the prepared index for the staged target', async () => {
    mocks.gitLog.mockResolvedValue(commits);
    render(<CommitBar workspaceId="ws-1" hasChanges stagedPaths={['src/a.ts']} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Alvo do commit' }), {
      target: { value: 'staged' },
    });
    fireEvent.change(message(), { target: { value: 'Commit preparado' } });
    fireEvent.click(commitButton());

    await waitFor(() =>
      expect(mocks.gitCommit).toHaveBeenCalledWith(
        'ws-1',
        'Commit preparado',
        'staged',
        undefined,
      ),
    );
  });

  it('sends selected paths only for the selection target', async () => {
    mocks.gitLog.mockResolvedValue(commits);
    render(<CommitBar workspaceId="ws-1" hasChanges selectedPaths={['src/b.ts']} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Alvo do commit' }), {
      target: { value: 'selection' },
    });
    fireEvent.change(message(), { target: { value: 'Commit selecionado' } });
    fireEvent.click(commitButton());

    await waitFor(() =>
      expect(mocks.gitCommit).toHaveBeenCalledWith(
        'ws-1',
        'Commit selecionado',
        'selection',
        ['src/b.ts'],
      ),
    );
  });

  it('fills the message with the AI suggestion', async () => {
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    await waitFor(() => expect(message().value).toBe('Mensagem sugerida pela IA'));
    expect(mocks.suggestCommitMessage).toHaveBeenCalledWith(
      'ws-1',
      'all',
      undefined,
      'opencode-go',
      'hy4-flash-free',
    );
  });

  it('follows the active model selection when suggesting', async () => {
    useAppStore.setState({
      selection: { providerId: 'anthropic', modelId: 'claude-haiku-5-5', reasoning: null },
    });
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    await waitFor(() =>
      expect(mocks.suggestCommitMessage).toHaveBeenCalledWith(
        'ws-1',
        'all',
        undefined,
        'anthropic',
        'claude-haiku-5-5',
      ),
    );
  });

  it('suggests using the staged target', async () => {
    render(<CommitBar workspaceId="ws-1" hasChanges stagedPaths={['src/a.ts']} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Alvo do commit' }), {
      target: { value: 'staged' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    await waitFor(() =>
      expect(mocks.suggestCommitMessage).toHaveBeenCalledWith(
        'ws-1',
        'staged',
        undefined,
        'opencode-go',
        'hy4-flash-free',
      ),
    );
    expect(message().value).toBe('Mensagem sugerida pela IA');
  });

  it('suggests using the selection target paths', async () => {
    render(<CommitBar workspaceId="ws-1" hasChanges selectedPaths={['src/b.ts']} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Alvo do commit' }), {
      target: { value: 'selection' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    await waitFor(() =>
      expect(mocks.suggestCommitMessage).toHaveBeenCalledWith(
        'ws-1',
        'selection',
        ['src/b.ts'],
        'opencode-go',
        'hy4-flash-free',
      ),
    );
  });

  it('disables the suggestion when there is nothing to describe', () => {
    render(<CommitBar workspaceId="ws-1" hasChanges={false} />);
    const suggest = screen.getByRole('button', {
      name: 'Sugerir mensagem',
    }) as HTMLButtonElement;
    expect(suggest.disabled).toBe(true);
    expect(suggest.getAttribute('title')).toBe('Nenhuma alteração para commitar');
  });

  it('ignores a suggestion that arrives after the workspace changes', async () => {
    let resolveSuggestion!: (value: string) => void;
    mocks.suggestCommitMessage.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveSuggestion = resolve;
      }),
    );
    const { rerender } = render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    rerender(<CommitBar workspaceId="ws-2" hasChanges />);
    await act(async () => {
      resolveSuggestion('Mensagem antiga');
    });
    expect(message().value).toBe('');
  });

  it('does not overwrite text typed while the suggestion is pending', async () => {
    let resolveSuggestion!: (value: string) => void;
    mocks.suggestCommitMessage.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveSuggestion = resolve;
      }),
    );
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    fireEvent.change(message(), { target: { value: 'Minha mensagem' } });
    await act(async () => {
      resolveSuggestion('Mensagem da IA');
    });
    expect(message().value).toBe('Minha mensagem');
  });

  it('shows an inline error when the suggestion fails', async () => {
    mocks.suggestCommitMessage.mockRejectedValueOnce(new Error('Nenhum modelo disponível'));
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.click(screen.getByRole('button', { name: 'Sugerir mensagem' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nenhum modelo disponível');
  });

  it('keeps the message and toasts when the commit fails', async () => {
    mocks.gitCommit.mockRejectedValueOnce(new Error('nada preparado'));
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.change(message(), { target: { value: 'Tentativa' } });
    fireEvent.click(commitButton());

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('nada preparado'));
    expect(message().value).toBe('Tentativa');
  });

  it('shows the recent commits history with short hash, author and date', async () => {
    mocks.gitLog.mockResolvedValue(commits);
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Commits recentes \(2\)/ })).toBeTruthy());
    const toggle = screen.getByRole('button', { name: /Commits recentes/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Commits recentes')).toBeTruthy();
    expect(screen.getByText('abc1234')).toBeTruthy();
    expect(screen.getByText('Corrige contador')).toBeTruthy();
    expect(screen.getByText(/Ana/)).toBeTruthy();
  });

  it('shows the honest empty history state', async () => {
    render(<CommitBar workspaceId="ws-1" hasChanges />);
    fireEvent.click(screen.getByRole('button', { name: /Commits recentes/ }));
    expect(await screen.findByText('Sem commits ainda')).toBeTruthy();
  });

  it('blocks the commit outside a git repository', () => {
    render(<CommitBar workspaceId="ws-1" isRepo={false} hasChanges />);
    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(commitButton().getAttribute('title')).toBe('Não é um repositório Git');
    expect(mocks.gitLog).not.toHaveBeenCalled();
  });

  it('honors an extra blocked reason (merge conflicts)', () => {
    render(
      <CommitBar
        workspaceId="ws-1"
        hasChanges
        blockedReason="Resolva os conflitos de merge antes de commitar"
      />,
    );
    expect(commitButton().getAttribute('title')).toBe(
      'Resolva os conflitos de merge antes de commitar',
    );
  });
});

describe('CommitBar helpers', () => {
  it('shortens hashes and formats dates', () => {
    expect(shortHash('abc1234def5678')).toBe('abc1234');
    expect(formatCommitDate('2026-01-02T10:00:00Z')).toContain('jan');
    expect(formatCommitDate('data-invalida')).toBe('data-invalida');
  });

  it('exports a status fixture shape used by the container', () => {
    expect(status().isRepo).toBe(true);
  });
});
