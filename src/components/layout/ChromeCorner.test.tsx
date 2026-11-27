// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const windowMock = vi.hoisted(() => {
  let maximized = false;
  return {
    isMaximized: vi.fn(async () => maximized),
    minimize: vi.fn(async () => undefined),
    maximize: vi.fn(async () => {
      maximized = true;
    }),
    unmaximize: vi.fn(async () => {
      maximized = false;
    }),
    close: vi.fn(async () => undefined),
    onResized: vi.fn(async () => () => undefined),
    reset: () => {
      maximized = false;
    },
  };
});

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowMock }));

// Imported after the mock.
import {
  ChromeCorner,
  ChromeCornerProvider,
  CHROME_CORNER_RESERVE,
  WindowControls,
  useChromeCornerReserve,
} from './ChromeCorner';
import {
  closeWindow,
  minimizeWindow,
  toggleMaximizeWindow,
  useWindowDragProps,
  useWindowMaximized,
} from './windowChrome';

function ReserveProbe({ role }: { role: 'center' | 'dock' }) {
  return <span data-testid={`reserve-${role}`}>{useChromeCornerReserve(role)}</span>;
}

/** Row that spreads the drag props, mirroring the real chrome rows. */
function DragRow() {
  const drag = useWindowDragProps();
  const maximized = useWindowMaximized();
  return (
    <div {...drag} data-testid="drag-row">
      <span data-testid="maximized">{String(maximized)}</span>
      <button type="button">Tab</button>
    </div>
  );
}

beforeEach(() => {
  windowMock.reset();
  windowMock.minimize.mockClear();
  windowMock.maximize.mockClear();
  windowMock.unmaximize.mockClear();
  windowMock.close.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('windowChrome', () => {
  it('minimiza e fecha pela API da janela, sem quebrar fora do Tauri', async () => {
    minimizeWindow();
    closeWindow();
    expect(windowMock.minimize).toHaveBeenCalledTimes(1);
    expect(windowMock.close).toHaveBeenCalledTimes(1);
  });

  it('alterna maximizar/restaurar conforme o estado atual', async () => {
    await expect(toggleMaximizeWindow()).resolves.toBe(true);
    expect(windowMock.maximize).toHaveBeenCalledTimes(1);

    await expect(toggleMaximizeWindow()).resolves.toBe(false);
    expect(windowMock.unmaximize).toHaveBeenCalledTimes(1);
  });

  it('maximiza no duplo clique de uma área de arrasto', async () => {
    render(<DragRow />);

    fireEvent.doubleClick(screen.getByTestId('drag-row'));
    await waitFor(() => expect(windowMock.maximize).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('maximized').textContent).toBe('true'));
  });

  it('não maximiza quando o duplo clique cai em um controle interativo', async () => {
    render(<DragRow />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Tab' }));
    expect(windowMock.maximize).not.toHaveBeenCalled();
    expect(windowMock.unmaximize).not.toHaveBeenCalled();
  });
});

describe('ChromeCorner', () => {
  it('mantém os três controles nativos com os mesmos rótulos', async () => {
    render(
      <ChromeCornerProvider docked={false}>
        <ChromeCorner />
      </ChromeCornerProvider>,
    );

    await waitFor(() => expect(windowMock.isMaximized).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Minimizar' })).toBeTruthy();
    // Maximize/restore are the same button; the shared state is restored from
    // the window on mount, so wait for the settled label.
    expect(
      await screen.findByRole('button', { name: /^(Maximizar|Restaurar)$/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fechar' })).toBeTruthy();
  });

  it('usa os mesmos handlers dos controles da janela', async () => {
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'Minimizar' }));
    expect(windowMock.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Maximizar' }));
    await waitFor(() => expect(windowMock.maximize).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(windowMock.close).toHaveBeenCalledTimes(1);
  });

  it('troca o rótulo para "Restaurar" quando a janela está maximizada', async () => {
    render(<WindowControls />);

    fireEvent.click(await screen.findByRole('button', { name: 'Maximizar' }));

    expect(await screen.findByRole('button', { name: 'Restaurar' })).toBeTruthy();
  });

  it('reserva a pegada do canto apenas na superfície mais à direita', () => {
    const { rerender } = render(
      <ChromeCornerProvider docked={false}>
        <ReserveProbe role="center" />
        <ReserveProbe role="dock" />
      </ChromeCornerProvider>,
    );

    expect(screen.getByTestId('reserve-center').textContent).toBe(CHROME_CORNER_RESERVE);
    expect(screen.getByTestId('reserve-dock').textContent).toBe(CHROME_CORNER_RESERVE);

    // Docked panel: the dock strip owns the corner, so the center row stops
    // reserving the space and keeps it for its own controls.
    rerender(
      <ChromeCornerProvider docked>
        <ReserveProbe role="center" />
        <ReserveProbe role="dock" />
      </ChromeCornerProvider>,
    );

    expect(screen.getByTestId('reserve-center').textContent).toBe('');
    expect(screen.getByTestId('reserve-dock').textContent).toBe(CHROME_CORNER_RESERVE);
  });
});

describe('ChromeCorner — estado compartilhado', () => {
  it('um único assinante alimenta todos os controles', async () => {
    function Pair() {
      const [mountSecond, setMountSecond] = useState(false);
      return (
        <>
          <WindowControls />
          <button type="button" onClick={() => setMountSecond(true)}>
            add
          </button>
          {mountSecond ? <WindowControls /> : null}
        </>
      );
    }

    render(<Pair />);
    await waitFor(() => expect(windowMock.onResized).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(windowMock.onResized).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'Minimizar' })).toHaveLength(2);
  });
});
