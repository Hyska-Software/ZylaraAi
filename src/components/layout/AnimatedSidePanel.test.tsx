// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useAppStore } from '@/lib/store';
import {
  AnimatedSidePanel,
  resolveSidePanelTransition,
  SIDE_PANEL_EASE,
} from './AnimatedSidePanel';

const previousReduceMotion = useAppStore.getState().settings.reduceMotion;

function setReduceMotion(value: boolean): void {
  useAppStore.setState((state) => ({ settings: { ...state.settings, reduceMotion: value } }));
}

function Harness({
  initialOpen = true,
  overlay = false,
  resizing = false,
}: {
  initialOpen?: boolean;
  overlay?: boolean;
  resizing?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen((current) => !current)}>
        Toggle panel
      </button>
      <AnimatedSidePanel
        open={open}
        width={420}
        label="Painel lateral"
        overlay={overlay}
        resizing={resizing}
      >
        <div>Conteúdo do painel</div>
      </AnimatedSidePanel>
    </>
  );
}

const panel = () => screen.queryByRole('complementary', { name: 'Painel lateral' });
const backdrop = () => document.querySelector('[data-side-panel="backdrop"]');

beforeEach(() => setReduceMotion(false));

afterEach(() => {
  cleanup();
  setReduceMotion(previousReduceMotion);
});

describe('AnimatedSidePanel — motion config', () => {
  it('uses the same 220ms ease-out-soft curve as the left sidebar', () => {
    expect(resolveSidePanelTransition({ reduceMotion: false, resizing: false })).toEqual({
      duration: 0.22,
      ease: SIDE_PANEL_EASE,
    });
  });

  it('has no width transition while the divider is being dragged', () => {
    expect(resolveSidePanelTransition({ reduceMotion: false, resizing: true }).duration).toBe(0);
  });

  it('disables movement when reduceMotion is active', () => {
    expect(resolveSidePanelTransition({ reduceMotion: true, resizing: false }).duration).toBe(0);
  });
});

describe('AnimatedSidePanel — docked panel', () => {
  it('renders the panel with its accessible label and fixed-width content', () => {
    render(<Harness />);

    expect(panel()).toBeTruthy();
    expect(screen.getByText('Conteúdo do painel')).toBeTruthy();
    expect(backdrop()).toBeNull();
  });

  it('keeps the panel mounted for the exit animation and removes it afterwards', async () => {
    render(<Harness />);

    act(() => {
      screen.getByRole('button', { name: 'Toggle panel' }).click();
    });

    expect(panel()).toBeTruthy();
    await waitFor(() => expect(panel()).toBeNull());
  });

  it('reopens from the collapsed state and settles at the persisted width', async () => {
    render(<Harness initialOpen={false} />);
    expect(panel()).toBeNull();

    act(() => {
      screen.getByRole('button', { name: 'Toggle panel' }).click();
    });

    expect(panel()).toBeTruthy();
    await waitFor(() => expect(panel()?.style.width).toBe('420px'));
  });
});

describe('AnimatedSidePanel — overlay panel', () => {
  it('slides in with a backdrop and removes both on close', async () => {
    render(<Harness overlay />);

    expect(panel()).toBeTruthy();
    expect(backdrop()).toBeTruthy();

    act(() => {
      screen.getByRole('button', { name: 'Toggle panel' }).click();
    });

    await waitFor(() => {
      expect(panel()).toBeNull();
      expect(backdrop()).toBeNull();
    });
  });
});
