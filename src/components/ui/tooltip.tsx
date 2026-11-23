import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/** Optional grouping provider; `Tooltip` already works standalone. */
export function TooltipProvider({
  children,
  delayDuration = 250,
}: {
  children: React.ReactNode;
  delayDuration?: number;
}) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration}>{children}</TooltipPrimitive.Provider>;
}

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Convenience wrapper around Radix Tooltip: pass `content` and the trigger as
 * `children`. The trigger must accept a ref (Button/IconButton do).
 */
export function Tooltip({
  content,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  delayDuration = 250,
  disabled = false,
  className,
}: TooltipProps) {
  if (disabled || content == null || content === '') return <>{children}</>;
  const trigger = React.isValidElement(children) ? children : <span>{children}</span>;

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={8}
            className={cn(
              'z-[70] max-w-64 select-none rounded-lg bg-surface-raised px-2.5 py-1.5',
              'text-xs leading-relaxed text-foreground shadow-lg',
              'data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none',
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipContent = TooltipPrimitive.Content;
export const TooltipRoot = TooltipPrimitive.Root;
