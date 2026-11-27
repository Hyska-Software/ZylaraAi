import { useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export interface ComposerActivityProps {
  /** A turn is running: the ring is visible and the trail orbits. */
  active: boolean;
  /** Removes the orbit; the full static accent border carries the state. */
  reduceMotion: boolean;
}

interface Box {
  width: number;
  height: number;
  /** Outer border radius of the composer, in CSS pixels. */
  radius: number;
}

/** `rounded-3xl` at the default 16px root size. */
const DEFAULT_RADIUS = 32;

/**
 * Full-perimeter execution indicator for the composer.
 *
 * The SVG is one continuous stroke on the composer border. A conic alpha mask
 * cuts that stroke into a single trail: the head is solid accent and the tail
 * dissolves smoothly into the surface. There are no dash layers, so the effect
 * always reads as one soft highlight instead of separate trails.
 */
export function ComposerActivity({ active, reduceMotion }: ComposerActivityProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const chatExecutionAnimationEnabled = useAppStore(
    (state) => state.settings.chatExecutionAnimationEnabled,
  );
  const staticRing = reduceMotion || !chatExecutionAnimationEnabled;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // The font-scale setting changes the rem-based `rounded-3xl`; read the
      // used radius instead of assuming 2rem so the trail follows the corners.
      const parent = host.parentElement;
      const computed = parent ? window.getComputedStyle(parent) : null;
      const measuredRadius = computed
        ? Number.parseFloat(computed.borderTopLeftRadius)
        : Number.NaN;
      const radius =
        Number.isFinite(measuredRadius) && measuredRadius > 0
          ? measuredRadius
          : DEFAULT_RADIUS;
      setBox((previous) =>
        previous &&
        previous.width === rect.width &&
        previous.height === rect.height &&
        previous.radius === radius
          ? previous
          : { width: rect.width, height: rect.height, radius },
      );
    };

    measure();
    // jsdom (unit tests) does not implement ResizeObserver; the initial measure
    // is enough for the component to render there.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
    // Re-measure when a turn starts so a font-scale change is picked up even if
    // the composer box happened to keep the same size.
  }, [active]);

  const orbitRadius = box ? Math.max(0, box.radius - 0.75) : 0;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-testid="composer-activity"
      data-active={active ? 'true' : 'false'}
      data-motion={staticRing ? 'reduced' : 'orbit'}
      className={cn(
        'composer-orbit-mask pointer-events-none absolute -inset-px z-0',
        'transition-opacity duration-300 ease-[var(--ease-out-soft)]',
        active ? 'opacity-100' : 'opacity-0',
        !staticRing && 'composer-orbit-animate',
        staticRing && 'composer-orbit-static',
        !active && 'composer-orbit-paused',
      )}
    >
      {box ? (
        <svg
          data-testid="composer-orbit"
          className="absolute inset-0 size-full"
          viewBox={`0 0 ${box.width} ${box.height}`}
        >
          {/*
           * One continuous stroke on the border centerline. The conic mask in
           * globals.css fades its alpha from transparent to accent, so there is
           * exactly one trail: a bright head and a long, soft tail.
           */}
          <rect
            x={0.75}
            y={0.75}
            width={Math.max(0, box.width - 1.5)}
            height={Math.max(0, box.height - 1.5)}
            rx={orbitRadius}
            ry={orbitRadius}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      ) : null}
    </div>
  );
}
