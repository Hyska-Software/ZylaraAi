// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SortableList, sortableDropClass, sortableDropClassHorizontal } from './sortable-list';

function rect(top: number, height = 32, left = 0, right = 240): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right,
    width: right - left,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

interface HarnessProps {
  initial?: string[];
  lockedCount?: number;
  disabled?: boolean;
  onReorder?: (ids: string[]) => void;
  onClick?: (id: string) => void;
}

function Harness({
  initial = ['a', 'b', 'c'],
  lockedCount = 0,
  disabled = false,
  onReorder = vi.fn(),
  onClick = vi.fn(),
}: HarnessProps) {
  const [ids, setIds] = useState(initial);
  return (
    <SortableList
      ids={ids}
      label="Itens"
      lockedCount={lockedCount}
      disabled={disabled}
      onReorder={(next) => {
        onReorder(next);
        setIds(next);
      }}
    >
      {(sortable) => (
        <div ref={sortable.containerRef} data-testid="container" className="flex flex-col">
          {ids.map((id) => (
            <div
              key={id}
              {...sortable.dropProps(id)}
              data-testid={`row-${id}`}
              className={sortableDropClass}
            >
              <button
                type="button"
                {...sortable.itemProps(id)}
                data-testid={`item-${id}`}
                onClick={() => onClick(id)}
              >
                {id}
              </button>
            </div>
          ))}
        </div>
      )}
    </SortableList>
  );
}

interface HorizontalHarnessProps {
  initial?: string[];
  disabled?: boolean;
  onReorder?: (ids: string[]) => void;
}

function HorizontalHarness({
  initial = ['a', 'b', 'c'],
  disabled = false,
  onReorder = vi.fn(),
}: HorizontalHarnessProps) {
  const [ids, setIds] = useState(initial);
  return (
    <SortableList
      ids={ids}
      label="Abas"
      orientation="horizontal"
      disabled={disabled}
      onReorder={(next) => {
        onReorder(next);
        setIds(next);
      }}
    >
      {(sortable) => (
        <div ref={sortable.containerRef} data-testid="h-container" role="tablist" className="flex">
          {ids.map((id) => (
            <div
              key={id}
              {...sortable.dropProps(id)}
              data-testid={`h-row-${id}`}
              className={sortableDropClassHorizontal}
            >
              <button
                type="button"
                role="tab"
                {...sortable.itemProps(id)}
                data-testid={`h-item-${id}`}
              >
                {id}
              </button>
            </div>
          ))}
        </div>
      )}
    </SortableList>
  );
}

function stubHorizontalLayout(ids = ['a', 'b', 'c']) {
  const container = screen.getByTestId('h-container');
  container.getBoundingClientRect = () => rect(0, 32, 0, 300);
  ids.forEach((id, index) => {
    const item = screen.getByTestId(`h-item-${id}`);
    item.getBoundingClientRect = () => rect(0, 32, index * 100, index * 100 + 80);
  });
}

function stubLayout(ids = ['a', 'b', 'c']) {
  const container = screen.getByTestId('container');
  container.getBoundingClientRect = () => rect(0, 32 * ids.length, 0, 240);
  ids.forEach((id, index) => {
    const item = screen.getByTestId(`item-${id}`);
    item.getBoundingClientRect = () => rect(index * 32);
  });
}

function drag(id: string, fromY: number, toY: number, x = 100) {
  fireEvent.pointerDown(screen.getByTestId(`item-${id}`), {
    button: 0,
    clientX: x,
    clientY: fromY,
  });
  fireEvent.pointerMove(window, { clientX: x, clientY: toY });
  fireEvent.pointerUp(window, { clientX: x, clientY: toY });
}

afterEach(() => cleanup());

describe('SortableList', () => {
  it('reorders with Alt+ArrowDown', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByTestId('item-b'), { key: 'ArrowDown', altKey: true });

    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('drops a row after another row with the pointer', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    stubLayout();

    fireEvent.pointerDown(screen.getByTestId('item-a'), {
      button: 0,
      clientX: 100,
      clientY: 5,
    });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 55 });
    expect(screen.getByTestId('row-c').getAttribute('data-drop')).toBe('before');
    fireEvent.pointerUp(window, { clientX: 100, clientY: 55 });

    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('ignores drops outside the container width', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    stubLayout();

    fireEvent.pointerDown(screen.getByTestId('item-a'), {
      button: 0,
      clientX: 100,
      clientY: 5,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 55 });
    expect(screen.getByTestId('row-b').getAttribute('data-drop')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 400, clientY: 55 });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores drops over another section vertically', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    stubLayout();

    fireEvent.pointerDown(screen.getByTestId('item-a'), {
      button: 0,
      clientX: 100,
      clientY: 5,
    });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 200 });
    expect(screen.getByTestId('row-c').getAttribute('data-drop')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 100, clientY: 200 });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('does not drag or cross the locked prefix', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} lockedCount={1} />);
    stubLayout();

    drag('a', 5, 55);
    expect(onReorder).not.toHaveBeenCalled();

    drag('b', 40, 5);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores pointer reorder when disabled', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} disabled />);
    stubLayout();

    drag('a', 5, 55);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('suppresses the click that follows a drag', () => {
    const onClick = vi.fn();
    render(<Harness onClick={onClick} />);
    stubLayout();

    drag('a', 5, 55);
    fireEvent.click(screen.getByTestId('item-a'));
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('item-b'));
    expect(onClick).toHaveBeenCalledWith('b');
  });
});

describe('SortableList (horizontal)', () => {
  it('drops a tab after another tab along the X axis', () => {
    const onReorder = vi.fn();
    render(<HorizontalHarness onReorder={onReorder} />);
    stubHorizontalLayout();

    fireEvent.pointerDown(screen.getByTestId('h-item-a'), {
      button: 0,
      clientX: 40,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 10 });
    expect(screen.getByTestId('h-row-c').getAttribute('data-drop')).toBe('after');
    fireEvent.pointerUp(window, { clientX: 250, clientY: 10 });

    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('ignores drops outside the strip height', () => {
    const onReorder = vi.fn();
    render(<HorizontalHarness onReorder={onReorder} />);
    stubHorizontalLayout();

    fireEvent.pointerDown(screen.getByTestId('h-item-a'), {
      button: 0,
      clientX: 40,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 200 });
    expect(screen.getByTestId('h-row-c').getAttribute('data-drop')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 250, clientY: 200 });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores drops beyond the strip width', () => {
    const onReorder = vi.fn();
    render(<HorizontalHarness onReorder={onReorder} />);
    stubHorizontalLayout();

    fireEvent.pointerDown(screen.getByTestId('h-item-a'), {
      button: 0,
      clientX: 40,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 10 });
    expect(screen.getByTestId('h-row-b').getAttribute('data-drop')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 400, clientY: 10 });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('reorders with Alt+ArrowRight and exposes the horizontal shortcut', () => {
    const onReorder = vi.fn();
    render(<HorizontalHarness onReorder={onReorder} />);

    const item = screen.getByTestId('h-item-b');
    expect(item.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowLeft Alt+ArrowRight');

    fireEvent.keyDown(item, { key: 'ArrowRight', altKey: true });

    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('ignores pointer reorder when disabled', () => {
    const onReorder = vi.fn();
    render(<HorizontalHarness onReorder={onReorder} disabled />);
    stubHorizontalLayout();

    fireEvent.pointerDown(screen.getByTestId('h-item-a'), {
      button: 0,
      clientX: 40,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 10 });

    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('SortableList motion', () => {
  const originalAnimate = Element.prototype.animate;
  let animateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    animateSpy = vi.fn(
      (_keyframes: Keyframe[], _options?: KeyframeAnimationOptions) =>
        ({ cancel: vi.fn(), finished: Promise.resolve() }) as unknown as Animation,
    );
    Element.prototype.animate = animateSpy as unknown as typeof Element.prototype.animate;
  });

  afterEach(() => {
    Element.prototype.animate = originalAnimate;
    document.documentElement.classList.remove('reduce-motion');
  });

  it('lifts the dragged row, follows the pointer and clears the styles on drop', () => {
    render(<Harness />);
    stubLayout();
    const item = screen.getByTestId('item-a');

    fireEvent.pointerDown(item, { button: 0, clientX: 100, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 112, clientY: 22 });

    expect(item.style.translate).toBe('12px 17px');
    expect(item.style.willChange).toContain('translate');
    expect(animateSpy).toHaveBeenCalled();

    fireEvent.pointerUp(window, { clientX: 112, clientY: 22 });
    expect(item.style.translate).toBe('');
    expect(item.style.willChange).toBe('');
  });

  it('interpolates the reflow after a keyboard reorder', () => {
    const positions: Record<string, number> = { a: 0, b: 32, c: 64 };
    render(
      <Harness
        onReorder={(next) => {
          next.forEach((id, index) => {
            positions[id] = index * 32;
          });
        }}
      />,
    );
    screen.getByTestId('container').getBoundingClientRect = () => rect(0, 96, 0, 240);
    for (const id of ['a', 'b', 'c']) {
      const item = screen.getByTestId(`item-${id}`);
      item.getBoundingClientRect = () => rect(positions[id]);
    }

    fireEvent.keyDown(screen.getByTestId('item-b'), { key: 'ArrowDown', altKey: true });

    const frames = animateSpy.mock.calls.map((call) => call[0]);
    expect(frames.some((frame) => JSON.stringify(frame).includes('translate3d'))).toBe(true);
  });

  it('skips lift and reflow animations when motion is reduced', () => {
    document.documentElement.classList.add('reduce-motion');
    render(<Harness />);
    stubLayout();
    const item = screen.getByTestId('item-a');

    fireEvent.pointerDown(item, { button: 0, clientX: 100, clientY: 5 });
    fireEvent.pointerMove(window, { clientX: 112, clientY: 22 });

    expect(animateSpy).not.toHaveBeenCalled();
    expect(item.style.translate).toBe('');

    fireEvent.pointerUp(window, { clientX: 112, clientY: 22 });
  });
});
