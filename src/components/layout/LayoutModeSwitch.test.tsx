// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useUiStore } from '@/lib/store';
import { LayoutModeSwitch } from './LayoutModeSwitch';

beforeEach(() => {
  useUiStore.setState({
    layoutMode: 'chat',
    enabledLayouts: { chat: true, code: true, agent: true },
  });
});

afterEach(() => {
  cleanup();
});

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Modo do aplicativo' });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.findByRole('menu');
}

describe('LayoutModeSwitch', () => {
  it('shows only the current layout icon in the footer trigger', () => {
    render(<LayoutModeSwitch />);

    const button = trigger();
    expect(button.textContent).toBe('');
    expect(button.getAttribute('title')).toBe('Layout de conversa');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');

    const icon = button.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('class')).toContain('size-4');
  });

  it('lists the enabled layouts as icon-only items with accessible names and hints', async () => {
    const user = userEvent.setup();
    render(<LayoutModeSwitch />);

    const menu = await openMenu(user);
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(3);

    const expected = [
      ['Chat', 'Layout de conversa', 'true'],
      ['Code', 'Layout de código', null],
      ['Agentes', 'Layout de agentes', null],
    ];
    expected.forEach(([name, title, current], index) => {
      const item = items[index];
      expect(item.getAttribute('aria-label')).toBe(name);
      expect(item.getAttribute('title')).toBe(title);
      expect(item.getAttribute('aria-current')).toBe(current);
      expect(item.textContent).toBe('');
      expect(item.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('switches the layout mode, persists the choice and updates the trigger', async () => {
    const user = userEvent.setup();
    render(<LayoutModeSwitch />);

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Code' }));

    expect(useUiStore.getState().layoutMode).toBe('code');
    const raw = window.localStorage.getItem('zylara.ui');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as { state?: { layoutMode?: string } };
    expect(persisted.state?.layoutMode).toBe('code');
    expect(trigger().getAttribute('title')).toBe('Layout de código');
  });

  it('calls onSelect after switching so a compact drawer can close', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<LayoutModeSwitch onSelect={onSelect} />);

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Agentes' }));

    expect(useUiStore.getState().layoutMode).toBe('agent');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('hides the whole control when only one layout is enabled', () => {
    useUiStore.setState({ enabledLayouts: { chat: true, code: false, agent: false } });

    render(<LayoutModeSwitch />);

    expect(screen.queryByRole('button', { name: 'Modo do aplicativo' })).toBeNull();
  });

  it('lists only the enabled layouts', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ enabledLayouts: { chat: true, code: false, agent: true } });

    render(<LayoutModeSwitch />);

    const menu = await openMenu(user);
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Chat', 'Agentes']);
  });
});
