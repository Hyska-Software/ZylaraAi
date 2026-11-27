// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { useAppStore } from '@/lib/store';
import { applyBorderRadius } from '@/lib/theme/apply';
import { ComposerActivity } from './ComposerActivity';

function setBorderRadiusEnabled(enabled: boolean): void {
  useAppStore.setState((state) => ({
    settings: { ...state.settings, borderRadiusEnabled: enabled },
  }));
}

function renderActivity(radius: string): void {
  render(
    <div style={{ borderTopLeftRadius: radius }}>
      <ComposerActivity active reduceMotion={false} />
    </div>,
  );
}

function orbitRect(): SVGRectElement {
  return screen.getByTestId('composer-orbit').querySelector('rect') as SVGRectElement;
}

beforeEach(() => {
  setBorderRadiusEnabled(true);
  document.documentElement.classList.remove('flat-borders');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: 80,
    width: 400,
    height: 80,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.classList.remove('flat-borders');
  setBorderRadiusEnabled(true);
});

describe('ComposerActivity', () => {
  it('follows the composer radius, including an explicitly square corner', () => {
    renderActivity('12px');
    expect(orbitRect().getAttribute('rx')).toBe('11.25');
  });

  it('draws a square orbit when corner radius is disabled', () => {
    setBorderRadiusEnabled(false);
    renderActivity('0px');

    expect(orbitRect().getAttribute('rx')).toBe('0');
    expect(orbitRect().getAttribute('ry')).toBe('0');
  });

  it('re-measures when the corner-radius setting changes during a turn', async () => {
    renderActivity('12px');
    expect(orbitRect().getAttribute('rx')).toBe('11.25');

    // The app applies the CSS class in an effect after the child measures.
    await act(async () => {
      setBorderRadiusEnabled(false);
      applyBorderRadius(false);
    });
    await waitFor(() => expect(orbitRect().getAttribute('rx')).toBe('0'));

    await act(async () => {
      setBorderRadiusEnabled(true);
      applyBorderRadius(true);
    });
    await waitFor(() => expect(orbitRect().getAttribute('rx')).toBe('11.25'));
  });
});
