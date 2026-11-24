// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { thinkingOptions, type ThinkingOption } from '@/lib/modelMenu';
import type { ModelInfo, ReasoningSelection } from '@/lib/types';
import { ThinkingLevelSlider, reasoningLevelColor } from './ThinkingLevelSlider';

afterEach(() => cleanup());

const model: ModelInfo = {
  id: 'level-test',
  name: 'Level Test',
  family: 'test',
  protocols: ['openai-chat'],
  reasoning: true,
  reasoningOptions: [
    { type: 'toggle' },
    { type: 'effort', values: ['low', 'medium', 'high', 'max'] },
  ],
  attachment: false,
  modalities: { input: ['text'], output: ['text'] },
  contextWindow: 8_192,
  maxOutput: 1_024,
  openWeights: false,
  tags: [],
  status: 'stable',
};

const medium: ReasoningSelection = { mode: 'effort', effort: 'medium' };

function optionFor(selection: ReasoningSelection, effort?: string): ThinkingOption {
  const id = effort ? `effort:${effort}` : 'off';
  const option = thinkingOptions(model, selection).find((entry) => entry.id === id);
  if (!option) throw new Error(`missing option ${id}`);
  return option;
}

describe('ThinkingLevelSlider', () => {
  it('renders the current level and changes color when another level is selected', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ThinkingLevelSlider model={model} value={medium} onSelect={onSelect} />,
    );

    const slider = screen.getByRole('slider', { name: 'Nível de pensamento' });
    expect(slider).toHaveProperty('value', '2');
    expect(slider.getAttribute('aria-valuetext')).toBe('Médio');
    expect(container.firstElementChild?.getAttribute('data-level-color')).toBe('var(--accent)');

    fireEvent.change(slider, { target: { value: '4' } });

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'effort:max' }));
    // The parent re-renders with the new selection; verify the new ramp color.
    const { container: updated } = render(
      <ThinkingLevelSlider
        model={model}
        value={{ mode: 'effort', effort: 'max' }}
        onSelect={onSelect}
      />,
    );
    expect(updated.firstElementChild?.getAttribute('data-level-color')).toBe('var(--danger)');
  });

  it('resets to the model default', () => {
    const onSelect = vi.fn();
    render(
      <ThinkingLevelSlider
        model={model}
        value={{ mode: 'effort', effort: 'max' }}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Redefinir o nível/ }));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'effort:medium' }));
  });

  it('exposes the back action when provided', () => {
    const onBack = vi.fn();
    render(
      <ThinkingLevelSlider model={model} value={medium} onSelect={vi.fn()} onBack={onBack} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a lista de modelos' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('maps every level to a distinct themed color', () => {
    const colors = ['low', 'medium', 'high', 'max'].map((effort) =>
      reasoningLevelColor(optionFor(medium, effort)),
    );
    expect(colors).toEqual([
      'var(--success)',
      'var(--accent)',
      'var(--warning)',
      'var(--danger)',
    ]);
    expect(new Set(colors).size).toBe(colors.length);
    expect(reasoningLevelColor(optionFor({ mode: 'off' }))).toBe('var(--border-strong)');
  });
});
