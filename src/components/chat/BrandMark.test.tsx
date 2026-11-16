// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ api: {} }));

import { BUILTIN_THEME_ID, useThemeStore } from '@/lib/store/themeStore';
import { BRAND_MARK_BOX, BRAND_MARK_PATHS } from './brandMarkArt';
import { BrandMark } from './BrandMark';

afterEach(() => cleanup());
beforeEach(() => useThemeStore.setState({ activeId: BUILTIN_THEME_ID }));

/** Installed theme that is not the app default. */
const CUSTOM_THEME_ID = 'ocean';

function image(): HTMLImageElement {
  const img = document.querySelector('img');
  expect(img).not.toBeNull();
  return img as HTMLImageElement;
}

function mark(): SVGSVGElement {
  const svg = document.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg as SVGSVGElement;
}

function paths(): SVGPathElement[] {
  return Array.from(mark().querySelectorAll('path'));
}

describe('BrandMark', () => {
  it('usa o símbolo sem fundo por padrão, preservando a proporção da arte', () => {
    render(<BrandMark size={24} />);
    const img = image();

    expect(img.getAttribute('src')).toBe('/brand/zylara-mark.svg');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.style.height).toBe('24px');
    // Largura automática: o SVG carrega a proporção da arte (5189×4904).
    expect(img.style.width).toBe('auto');
  });

  it('usa o ícone oficial completo quando a variante é tile', () => {
    render(<BrandMark variant="tile" size={40} />);
    const img = image();

    expect(img.getAttribute('src')).toBe('/brand/zylara-tile.svg');
    expect(img.style.width).toBe('40px');
    expect(img.style.height).toBe('40px');
  });

  it('anima apenas quando animated está ligado', () => {
    const { rerender } = render(<BrandMark />);
    expect(image().className).not.toContain('animate-pulse-soft');

    rerender(<BrandMark animated />);
    expect(image().className).toContain('animate-pulse-soft');
  });

  it('mantém a altura pedida em qualquer variante', () => {
    render(
      <>
        <BrandMark size={22} />
        <BrandMark variant="tile" size={72} />
      </>,
    );
    const [symbol, tile] = Array.from(document.querySelectorAll('img'));
    expect(symbol.style.height).toBe('22px');
    expect(tile.style.height).toBe('72px');
  });

  it('pinta a marca com os tokens do tema ativo fora do tema padrão', () => {
    useThemeStore.setState({ activeId: CUSTOM_THEME_ID });
    render(<BrandMark size={32} />);

    expect(document.querySelector('img')).toBeNull();
    const svg = mark();
    expect(svg.getAttribute('viewBox')).toBe(
      `${BRAND_MARK_BOX.x} ${BRAND_MARK_BOX.y} ${BRAND_MARK_BOX.width} ${BRAND_MARK_BOX.height}`,
    );
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('height')).toBe('32');
    expect(Number(svg.getAttribute('width'))).toBeCloseTo(
      (32 * BRAND_MARK_BOX.width) / BRAND_MARK_BOX.height,
      1,
    );

    const layers = paths();
    expect(layers.map((path) => path.getAttribute('d'))).toEqual(
      BRAND_MARK_PATHS.map((path) => path.d),
    );
    // Accent body, background cut-outs and foreground eye.
    expect(layers.filter((path) => path.classList.contains('fill-accent'))).toHaveLength(3);
    expect(layers.filter((path) => path.classList.contains('fill-background'))).toHaveLength(7);
    expect(layers.filter((path) => path.classList.contains('fill-foreground'))).toHaveLength(1);
  });

  it('mantém a arte oficial quando a cor da marca é forçada', () => {
    useThemeStore.setState({ activeId: CUSTOM_THEME_ID });
    render(<BrandMark tint="brand" />);

    expect(document.querySelector('svg')).toBeNull();
    expect(image().getAttribute('src')).toBe('/brand/zylara-mark.svg');
  });

  it('não recolore o ícone completo do tile', () => {
    useThemeStore.setState({ activeId: CUSTOM_THEME_ID });
    render(<BrandMark variant="tile" size={40} />);

    expect(image().getAttribute('src')).toBe('/brand/zylara-tile.svg');
  });

  it('aplica a cor também nos temas embutidos e nos contribuídos por plugins', () => {
    // Bundled themes (aurora…) and plugin contributions (`plugin-<16 hex>`,
    // src/lib/plugins/themes.ts) are not the default theme, so both are tinted.
    for (const id of ['aurora', 'plugin-0123456789abcdef']) {
      useThemeStore.setState({ activeId: id });
      const { unmount } = render(<BrandMark size={24} />);

      expect(document.querySelector('img')).toBeNull();
      expect(paths()).toHaveLength(BRAND_MARK_PATHS.length);
      expect(paths()[0].classList.contains('fill-accent')).toBe(true);

      unmount();
    }
  });

  it('acompanha a troca de tema sem remontar', () => {
    render(<BrandMark />);
    expect(image().getAttribute('src')).toBe('/brand/zylara-mark.svg');

    act(() => useThemeStore.setState({ activeId: CUSTOM_THEME_ID }));
    expect(document.querySelector('img')).toBeNull();
    expect(mark()).not.toBeNull();

    act(() => useThemeStore.setState({ activeId: BUILTIN_THEME_ID }));
    expect(document.querySelector('svg')).toBeNull();
    expect(image().getAttribute('src')).toBe('/brand/zylara-mark.svg');
  });
});
