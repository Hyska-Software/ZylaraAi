import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function tabbablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

export interface PopoverContentProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  containerClassName?: string;
}

/**
 * Floating panel anchored to a trigger (Radix Popover under the hood).
 *
 * Unlike `DropdownMenuContent`, the content is not a menu: it is a free-form
 * panel, which is what the model selector needs (search field + two-pane list).
 * Motion follows DESIGN §11 (fade + scale, ~180ms) and is disabled by
 * `motion-reduce`.
 *
 * Radix mounts its content inside a `FocusScope` with `loop: true` even in the
 * non-modal popover, which wraps Tab at the edges and traps keyboard users
 * inside the panel. The capture handler below lets Tab leave the panel at the
 * first/last tabbable element by stopping the event before Radix's document
 * listener sees it (DESIGN §12: focus must not be trapped).
 */
export const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    {
      className,
      align = 'start',
      sideOffset = 6,
      collisionPadding = 10,
      onKeyDownCapture,
      ...props
    },
    ref,
  ) {
    const handleKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDownCapture?.(event);
      if (event.defaultPrevented) return;
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;

      const container = event.currentTarget;
      const tabbables = tabbablesIn(container);
      if (!tabbables.length) return;

      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const leaving = event.shiftKey ? active === first || active === container : active === last;
      if (!leaving) return;

      // Stop Radix's FocusScope from wrapping focus back into the panel; the
      // browser then moves focus to the next element outside the popover.
      event.stopPropagation();
    };

    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          onKeyDownCapture={handleKeyDownCapture}
          className={cn(
            'z-[65] overflow-hidden rounded-xl bg-surface-raised p-0 text-foreground shadow-xl outline-none',
            'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out motion-reduce:animate-none',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  },
);
