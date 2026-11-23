import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type DropPosition = 'before' | 'after';

export type SortableOrientation = 'vertical' | 'horizontal';

interface DropTarget {
  id: string;
  position: DropPosition;
}

interface ItemRect {
  id: string;
  start: number;
  end: number;
  crossStart: number;
  crossEnd: number;
}

export interface SortableItemProps {
  ref: (element: HTMLElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  'aria-keyshortcuts': string;
  'aria-describedby': string;
}

export interface SortableDropProps {
  'data-drop'?: DropPosition;
  'data-dragging'?: 'true';
}

export interface SortableListApi {
  disabled: boolean;
  orientation: SortableOrientation;
  containerRef: RefObject<HTMLDivElement | null>;
  itemProps: (id: string) => SortableItemProps;
  dropProps: (id: string) => SortableDropProps;
}

export interface SortableListProps {
  ids: string[];
  label: string;
  itemLabel?: (id: string) => string;
  disabled?: boolean;
  /** Layout axis of the list; tabs use `horizontal`. */
  orientation?: SortableOrientation;
  /** Items at the start that cannot be dragged or crossed. */
  lockedCount?: number;
  onReorder: (ids: string[]) => void;
  children: (api: SortableListApi) => ReactNode;
}

const DRAG_THRESHOLD = 5;
const EDGE = 24;
const SCROLL_STEP = 8;
const LIFT_SCALE = 1.03;
const LIFT_DURATION = 140;
const SETTLE_DURATION = 180;
const LIFT_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Both the OS preference and the app setting (`html.reduce-motion`, App.tsx). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  return query?.matches === true || document.documentElement.classList.contains('reduce-motion');
}

/** WAAPI is unavailable in jsdom; animation is purely decorative, so skip it. */
function animateElement(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  if (typeof element.animate !== 'function' || prefersReducedMotion()) return null;
  try {
    return element.animate(keyframes, options);
  } catch {
    return null;
  }
}

/** Drop line + dimmed source row, applied to each row wrapper. */
export const sortableDropClass = cn(
  'relative',
  'data-[dragging=true]:opacity-40',
  'transition-opacity duration-150 motion-reduce:transition-none',
  'before:opacity-0 after:opacity-0 before:transition-opacity after:transition-opacity before:duration-150 after:duration-150',
  'data-[drop=before]:before:opacity-100 data-[drop=after]:after:opacity-100',
  'data-[drop=before]:before:pointer-events-none data-[drop=before]:before:absolute data-[drop=before]:before:inset-x-1 data-[drop=before]:before:-top-px data-[drop=before]:before:h-0.5 data-[drop=before]:before:rounded-full data-[drop=before]:before:bg-accent',
  'data-[drop=after]:after:pointer-events-none data-[drop=after]:after:absolute data-[drop=after]:after:inset-x-1 data-[drop=after]:after:-bottom-px data-[drop=after]:after:h-0.5 data-[drop=after]:after:rounded-full data-[drop=after]:after:bg-accent',
);

/** Horizontal variant for tab strips: the drop line is a vertical bar. */
export const sortableDropClassHorizontal = cn(
  'relative',
  'data-[dragging=true]:opacity-40',
  'transition-opacity duration-150 motion-reduce:transition-none',
  'before:opacity-0 after:opacity-0 before:transition-opacity after:transition-opacity before:duration-150 after:duration-150',
  'data-[drop=before]:before:opacity-100 data-[drop=after]:after:opacity-100',
  'data-[drop=before]:before:pointer-events-none data-[drop=before]:before:absolute data-[drop=before]:before:inset-y-1 data-[drop=before]:before:-left-0.5 data-[drop=before]:before:w-0.5 data-[drop=before]:before:rounded-full data-[drop=before]:before:bg-accent',
  'data-[drop=after]:after:pointer-events-none data-[drop=after]:after:absolute data-[drop=after]:after:inset-y-1 data-[drop=after]:after:-right-0.5 data-[drop=after]:after:w-0.5 data-[drop=after]:after:rounded-full data-[drop=after]:after:bg-accent',
);

function findScrollParent(
  node: HTMLElement | null,
  orientation: SortableOrientation,
): HTMLElement | null {
  const horizontal = orientation === 'horizontal';
  let current = node?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const scrollable = horizontal
      ? /(auto|scroll)/.test(style.overflowX) && current.scrollWidth > current.clientWidth
      : /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if (scrollable) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Scroller driven while dragging. The list container itself may be the scroll
 * surface (horizontal tab strips are `overflow-x-auto` on the tablist).
 */
function findDragScroller(
  container: HTMLElement | null,
  orientation: SortableOrientation,
): HTMLElement | null {
  if (!container) return null;
  const style = window.getComputedStyle(container);
  const scrollable =
    orientation === 'horizontal'
      ? /(auto|scroll)/.test(style.overflowX) && container.scrollWidth > container.clientWidth
      : /(auto|scroll)/.test(style.overflowY) && container.scrollHeight > container.clientHeight;
  return scrollable ? container : findScrollParent(container, orientation);
}

/**
 * Pointer-based sortable list (HTML5 drag is blocked by Tauri's
 * `dragDropEnabled` on Windows). It reorders only inside its own list: callers
 * render one instance per sidebar section.
 */
export function SortableList({
  ids,
  label,
  itemLabel,
  disabled = false,
  orientation = 'vertical',
  lockedCount = 0,
  onReorder,
  children,
}: SortableListProps): ReactElement {
  const { t } = useTranslation('common');
  const instructionsId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const idsRef = useRef(ids);
  const lockedRef = useRef(lockedCount);
  const disabledRef = useRef(disabled);
  const orientationRef = useRef(orientation);
  const onReorderRef = useRef(onReorder);
  const itemLabelRef = useRef(itemLabel);
  const labelRef = useRef(label);
  const dropRef = useRef<DropTarget | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const animationsRef = useRef<Set<Animation>>(new Set());
  const flipRectsRef = useRef<Map<string, DOMRect> | null>(null);

  idsRef.current = ids;
  lockedRef.current = lockedCount;
  disabledRef.current = disabled;
  orientationRef.current = orientation;
  onReorderRef.current = onReorder;
  itemLabelRef.current = itemLabel;
  labelRef.current = label;

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const trackAnimation = useCallback((animation: Animation) => {
    animationsRef.current.add(animation);
    void animation.finished
      .catch(() => undefined)
      .then(() => {
        animationsRef.current.delete(animation);
        try {
          animation.cancel();
        } catch {
          /* already cancelled */
        }
      });
  }, []);

  const cancelAnimations = useCallback(() => {
    for (const animation of animationsRef.current) {
      try {
        animation.cancel();
      } catch {
        /* already finished */
      }
    }
    animationsRef.current.clear();
  }, []);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cancelAnimations();
    },
    [cancelAnimations],
  );

  /** Snapshot visual positions before a reorder so the new layout can be
   *  interpolated (FLIP) instead of jumping. */
  const captureFlipRects = useCallback(() => {
    if (prefersReducedMotion()) return;
    const rects = new Map<string, DOMRect>();
    for (const [id, element] of elementsRef.current) {
      rects.set(id, element.getBoundingClientRect());
    }
    flipRectsRef.current = rects;
  }, []);

  useLayoutEffect(() => {
    const previous = flipRectsRef.current;
    flipRectsRef.current = null;
    if (!previous || prefersReducedMotion()) return;
    for (const [id, element] of elementsRef.current) {
      const before = previous.get(id);
      if (!before) continue;
      const after = element.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const animation = animateElement(
        element,
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: SETTLE_DURATION, easing: LIFT_EASE },
      );
      if (animation) trackAnimation(animation);
    }
  }, [ids, trackAnimation]);

  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elementsRef.current.set(id, element);
    else elementsRef.current.delete(id);
  }, []);

  const measure = useCallback((): ItemRect[] => {
    const horizontal = orientationRef.current === 'horizontal';
    const rects: ItemRect[] = [];
    for (const id of idsRef.current) {
      const element = elementsRef.current.get(id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      rects.push(
        horizontal
          ? { id, start: rect.left, end: rect.right, crossStart: rect.top, crossEnd: rect.bottom }
          : { id, start: rect.top, end: rect.bottom, crossStart: rect.left, crossEnd: rect.right },
      );
    }
    return rects;
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (disabledRef.current || event.button !== 0) return;
    const currentIds = idsRef.current;
    const index = currentIds.indexOf(id);
    if (index < 0 || index < lockedRef.current || currentIds.length < 2) return;

    suppressClickRef.current = false;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let pointerX = startX;
    let pointerY = startY;
    let started = false;
    let frame = 0;
    let rects: ItemRect[] = [];
    let scroller: HTMLElement | null = null;
    let dragElement: HTMLElement | null = null;
    let liftAnimation: Animation | null = null;

    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      /* jsdom / detached element */
    }

    const setDropState = (next: DropTarget | null) => {
      const previous = dropRef.current;
      if (previous?.id === next?.id && previous?.position === next?.position) return;
      dropRef.current = next;
      setDrop(next);
    };

    const clearDragStyle = (target: HTMLElement) => {
      target.style.translate = '';
      target.style.zIndex = '';
      target.style.willChange = '';
    };

    /** `translate` is independent of `transform`, so the WAAPI lift animation
     *  and the pointer-follow offset compose without overwriting each other. */
    const lift = () => {
      if (prefersReducedMotion()) return;
      dragElement = element;
      element.style.willChange = 'translate, transform';
      element.style.zIndex = '2';
      element.style.translate = '0px 0px';
      liftAnimation = animateElement(
        element,
        [
          { transform: 'scale(1)' },
          { transform: `scale(${LIFT_SCALE})` },
        ],
        { duration: LIFT_DURATION, easing: LIFT_EASE, fill: 'forwards' },
      );
    };

    /** Return a dropped-in-place row to rest. A reordered row is handled by
     *  the FLIP effect: its snapshot already includes the drag offset. */
    const finishDrag = (reordered: boolean) => {
      const target = dragElement;
      dragElement = null;
      liftAnimation?.cancel();
      liftAnimation = null;
      if (!target) return;
      const translate = target.style.translate || '0px 0px';
      const animation =
        !reordered &&
        animateElement(
          target,
          [
            { translate, transform: `scale(${LIFT_SCALE})` },
            { translate: '0px 0px', transform: 'scale(1)' },
          ],
          { duration: SETTLE_DURATION, easing: LIFT_EASE, fill: 'forwards' },
        );
      clearDragStyle(target);
      if (animation) trackAnimation(animation);
    };

    const updateDrop = () => {
      const container = containerRef.current;
      if (!container || rects.length === 0) {
        setDropState(null);
        return;
      }
      const horizontal = orientationRef.current === 'horizontal';
      const bounds = container.getBoundingClientRect();
      const viewport = scroller?.getBoundingClientRect() ?? bounds;
      // Along the list axis the viewport clips the drop area (scrolled list);
      // across the axis the container bounds decide.
      const start = horizontal ? bounds.left : Math.max(bounds.top, viewport.top);
      const end = horizontal ? bounds.right : Math.min(bounds.bottom, viewport.bottom);
      const crossStart = horizontal ? Math.max(bounds.top, viewport.top) : bounds.left;
      const crossEnd = horizontal ? Math.min(bounds.bottom, viewport.bottom) : bounds.right;
      const along = horizontal ? pointerX : pointerY;
      const cross = horizontal ? pointerY : pointerX;
      if (
        along < start - EDGE ||
        along > end + EDGE ||
        cross < crossStart - EDGE ||
        cross > crossEnd + EDGE
      ) {
        setDropState(null);
        return;
      }
      const candidates = rects.filter((rect) => {
        const idIndex = idsRef.current.indexOf(rect.id);
        return rect.id !== id && idIndex >= lockedRef.current;
      });
      if (candidates.length === 0) {
        setDropState(null);
        return;
      }
      const next = candidates.find(
        (rect) => rect.start + (rect.end - rect.start) / 2 > along,
      );
      setDropState(
        next
          ? { id: next.id, position: 'before' }
          : { id: candidates[candidates.length - 1].id, position: 'after' },
      );
    };

    const tick = () => {
      if (!started) return;
      if (scroller) {
        const horizontal = orientationRef.current === 'horizontal';
        const bounds = scroller.getBoundingClientRect();
        let delta = 0;
        if (horizontal) {
          if (pointerX < bounds.left + EDGE) delta = -SCROLL_STEP;
          else if (pointerX > bounds.right - EDGE) delta = SCROLL_STEP;
          if (delta !== 0) {
            const before = scroller.scrollLeft;
            scroller.scrollLeft += delta;
            if (scroller.scrollLeft !== before) {
              rects = measure();
              updateDrop();
            }
          }
        } else {
          if (pointerY < bounds.top + EDGE) delta = -SCROLL_STEP;
          else if (pointerY > bounds.bottom - EDGE) delta = SCROLL_STEP;
          if (delta !== 0) {
            const before = scroller.scrollTop;
            scroller.scrollTop += delta;
            if (scroller.scrollTop !== before) {
              rects = measure();
              updateDrop();
            }
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };

    const commit = (): boolean => {
      const target = dropRef.current;
      if (!target) return false;
      const current = idsRef.current;
      const from = current.indexOf(id);
      if (from < 0) return false;
      const remaining = current.filter((item) => item !== id);
      const targetIndex = remaining.indexOf(target.id);
      if (targetIndex < 0) return false;
      let insertAt = targetIndex + (target.position === 'after' ? 1 : 0);
      insertAt = Math.max(lockedRef.current, Math.min(insertAt, remaining.length));
      const next = [...remaining.slice(0, insertAt), id, ...remaining.slice(insertAt)];
      if (next.every((item, itemIndex) => item === current[itemIndex])) return false;
      captureFlipRects();
      onReorderRef.current(next);
      setAnnouncement(
        t('common:sortable.moved', {
          label: labelRef.current,
          item: itemLabelRef.current?.(id) ?? id,
          position: next.indexOf(id) + 1,
          total: next.length,
        }),
      );
      return true;
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onWindowKeyDown, true);
      window.removeEventListener('blur', onCancel);
      cancelAnimationFrame(frame);
      document.body.classList.remove('zylara-sortable-dragging');
      try {
        if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
      } catch {
        /* detached element */
      }
      cleanupRef.current = null;
    };

    const onMove = (moveEvent: PointerEvent) => {
      pointerX = moveEvent.clientX;
      pointerY = moveEvent.clientY;
      if (!started) {
        if (Math.hypot(pointerX - startX, pointerY - startY) < DRAG_THRESHOLD) return;
        started = true;
        rects = measure();
        scroller = findDragScroller(containerRef.current, orientationRef.current);
        document.body.classList.add('zylara-sortable-dragging');
        setDraggingId(id);
        lift();
        frame = requestAnimationFrame(tick);
      }
      if (dragElement) {
        dragElement.style.translate = `${pointerX - startX}px ${pointerY - startY}px`;
      }
      moveEvent.preventDefault();
      updateDrop();
    };

    const onUp = (upEvent: PointerEvent) => {
      pointerX = upEvent.clientX;
      pointerY = upEvent.clientY;
      const wasStarted = started;
      let reordered = false;
      if (wasStarted) {
        updateDrop();
        suppressClickRef.current = true;
      }
      cleanup();
      if (wasStarted) reordered = commit();
      finishDrag(reordered);
      setDraggingId(null);
      setDropState(null);
    };

    const onCancel = () => {
      if (started) suppressClickRef.current = true;
      cleanup();
      finishDrag(false);
      setDraggingId(null);
      setDropState(null);
    };

    const onWindowKeyDown = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      onCancel();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onWindowKeyDown, true);
    window.addEventListener('blur', onCancel);
    cleanupRef.current = cleanup;
  };

  const handleItemKeyDown = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (disabledRef.current) return;
    const horizontal = orientationRef.current === 'horizontal';
    const previousKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (!event.altKey || (event.key !== previousKey && event.key !== nextKey)) return;
    const current = idsRef.current;
    const index = current.indexOf(id);
    if (index < 0 || index < lockedRef.current) return;
    const target = event.key === previousKey ? index - 1 : index + 1;
    if (target < lockedRef.current || target >= current.length) return;
    event.preventDefault();
    event.stopPropagation();
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    captureFlipRects();
    onReorderRef.current(next);
    setAnnouncement(
      t('common:sortable.moved', {
        label: labelRef.current,
        item: itemLabelRef.current?.(id) ?? id,
        position: target + 1,
        total: current.length,
      }),
    );
  };

  const itemProps = (id: string): SortableItemProps => ({
    ref: (element) => register(id, element),
    onPointerDown: (event) => beginDrag(event, id),
    onKeyDown: (event) => handleItemKeyDown(event, id),
    onClickCapture: (event) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    'aria-keyshortcuts':
      orientation === 'horizontal' ? 'Alt+ArrowLeft Alt+ArrowRight' : 'Alt+ArrowUp Alt+ArrowDown',
    'aria-describedby': instructionsId,
  });

  const dropProps = (id: string): SortableDropProps => ({
    'data-drop': drop?.id === id ? drop.position : undefined,
    'data-dragging': draggingId === id ? 'true' : undefined,
  });

  return (
    <>
      {children({ disabled, orientation, containerRef, itemProps, dropProps })}
      <span id={instructionsId} className="sr-only">
        {t(
          orientation === 'horizontal'
            ? 'common:sortable.instructionsHorizontal'
            : 'common:sortable.instructions',
        )}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
