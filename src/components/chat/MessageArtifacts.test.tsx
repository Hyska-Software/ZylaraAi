// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Artifact } from '@/lib/types';
import { useUiStore } from '@/lib/store';
import { MessageArtifacts } from './MessageArtifacts';

// The card only reaches the Tauri surface when its save button is clicked.
vi.mock('@/lib/api', () => ({
  api: { saveArtifact: vi.fn() },
}));

function artifact(index: number, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: `artifact-${index}`,
    conversationId: 'conv-1',
    messageId: 'assistant-1',
    name: `artefato-${index}.md`,
    mimeType: 'text/markdown',
    kind: 'markdown',
    language: 'markdown',
    size: 120 * index,
    createdAt: index,
    ...overrides,
  };
}

/** Cards are the direct children of the inline grid (the component's contract). */
function inlineCards(container: HTMLElement): HTMLElement[] {
  const grid = container.querySelector<HTMLElement>('[class*="sm:grid-cols-2"]');
  return grid ? (Array.from(grid.children) as HTMLElement[]) : [];
}

function renderedNames(container: HTMLElement): (string | undefined)[] {
  return inlineCards(container).map((card) => card.textContent?.match(/[\w-]+\.md/)?.[0]);
}

function resetUi(): void {
  useUiStore.setState({
    artifactPanelOpen: false,
    artifactPanelView: 'list',
    sourcesPanelOpen: false,
    activeArtifactId: null,
    artifacts: [],
  });
}

beforeEach(resetUi);
afterEach(() => cleanup());

describe('MessageArtifacts', () => {
  it('renders every artifact inline and no "ver todos" button when the list is short', () => {
    const { container } = render(<MessageArtifacts artifacts={[artifact(1), artifact(2)]} />);

    expect(inlineCards(container)).toHaveLength(2);
    expect(screen.getByText('artefato-1.md')).toBeTruthy();
    expect(screen.getByText('artefato-2.md')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ver todos/ })).toBeNull();
  });

  it('caps the inline grid at four cards and shows the full count on the "+" button', () => {
    const artifacts = Array.from({ length: 7 }, (_, index) => artifact(index + 1));
    const { container } = render(<MessageArtifacts artifacts={artifacts} />);

    expect(inlineCards(container)).toHaveLength(4);
    expect(screen.getByText('Ver todos (7)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver todos os 7 artefatos gerados' })).toBeTruthy();

    for (const hidden of ['artefato-5.md', 'artefato-6.md', 'artefato-7.md']) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
  });

  it('opens the artifact list in the side panel when the "+" button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <MessageArtifacts artifacts={Array.from({ length: 7 }, (_, index) => artifact(index + 1))} />,
    );

    await user.click(screen.getByRole('button', { name: 'Ver todos os 7 artefatos gerados' }));

    expect(useUiStore.getState().artifactPanelOpen).toBe(true);
    expect(useUiStore.getState().artifactPanelView).toBe('list');
  });

  it('opens the preview and closes the sources panel when a card is clicked', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ sourcesPanelOpen: true });
    render(<MessageArtifacts artifacts={[artifact(1)]} />);

    await user.click(screen.getByRole('button', { name: 'Abrir' }));

    expect(useUiStore.getState()).toMatchObject({
      artifactPanelOpen: true,
      artifactPanelView: 'preview',
      activeArtifactId: 'artifact-1',
      sourcesPanelOpen: false,
    });
  });

  it('orders defensively by createdAt and then id before cutting the inline list', () => {
    const shuffled = [artifact(3), artifact(1), artifact(4), artifact(2)];
    const { container } = render(<MessageArtifacts artifacts={shuffled} />);
    expect(renderedNames(container)).toEqual([
      'artefato-1.md',
      'artefato-2.md',
      'artefato-3.md',
      'artefato-4.md',
    ]);

    const tiedA = artifact(9, { id: 'artifact-a', createdAt: 5, name: 'arquivo-a.md' });
    const tiedB = artifact(9, { id: 'artifact-b', createdAt: 5, name: 'arquivo-b.md' });
    const tie = render(<MessageArtifacts artifacts={[tiedB, tiedA]} />);
    expect(renderedNames(tie.container)).toEqual(['arquivo-a.md', 'arquivo-b.md']);
    tie.unmount();
  });

  it('renders nothing when the message has no artifacts', () => {
    const { container } = render(<MessageArtifacts artifacts={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
