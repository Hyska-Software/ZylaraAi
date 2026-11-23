// @vitest-environment jsdom
import { Globe } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolsToggle } from './ToolsToggle';

const LABEL = 'Web search';

function renderToggle(active = false, onToggle = vi.fn()): ReturnType<typeof vi.fn> {
  render(<ToolsToggle icon={Globe} label={LABEL} active={active} onToggle={onToggle} />);
  return onToggle;
}

describe('ToolsToggle', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders only the icon, keeping the label as accessible name and tooltip', () => {
    renderToggle(true);
    const button = screen.getByRole('button', { name: LABEL });

    expect(button.textContent?.trim()).toBe('');
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe(LABEL);
    expect(button.getAttribute('title')).toBe(LABEL);
  });

  it('exposes the active state and toggles on click', () => {
    const onToggle = renderToggle(false);
    const button = screen.getByRole('button', { name: LABEL });

    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
