// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ModelInfo } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  api: {
    saveSettings: vi.fn(),
    getSettings: vi.fn(),
  },
}));

import { useAppStore } from '@/lib/store';
import { ThinkingSelector } from './ThinkingSelector';

afterEach(() => cleanup());

const model: ModelInfo = {
  id: 'selector-test',
  name: 'Selector Test',
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

function setSliderEnabled(enabled: boolean): void {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings, reasoningSliderEnabled: enabled },
  });
}

beforeEach(() => setSliderEnabled(false));

describe('ThinkingSelector — opt-in slider', () => {
  it('keeps the segmented control when the setting is off', () => {
    render(
      <ThinkingSelector
        model={model}
        value={{ mode: 'effort', effort: 'medium' }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Modo de pensamento' })).toBeTruthy();
  });

  it('replaces it with the slider when the setting is on', () => {
    setSliderEnabled(true);
    const onChange = vi.fn();
    render(
      <ThinkingSelector
        model={model}
        value={{ mode: 'effort', effort: 'medium' }}
        onChange={onChange}
      />,
    );

    const slider = screen.getByRole('slider', { name: 'Nível de pensamento' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Médio');
    expect(screen.queryByRole('radiogroup')).toBeNull();

    fireEvent.change(slider, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith({ mode: 'effort', effort: 'max' });
  });
});
