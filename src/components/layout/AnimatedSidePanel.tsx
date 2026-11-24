import { type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { cn } from '@/lib/utils';
import { useReduceMotion } from './hooks';

/** Same easing as the desktop sidebar and the other shell transitions. */
export const SIDE_PANEL_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SIDE_PANEL_DURATION = 0.22;

export interface SidePanelMotionOptions {
  reduceMotion: boolean;
  /** True while the resize handle is being dragged. */
  resizing?: boolean;
}

export function resolveSidePanelTransition({ reduceMotion, resizing }: SidePanelMotionOptions) {
  return {
    duration: reduceMotion || resizing ? 0 : SIDE_PANEL_DURATION,
    ease: SIDE_PANEL_EASE,
  };
}

function PanelContent({ width, children }: { width: number; children: ReactNode }) {
  const isPresent = useIsPresent();
  return (
    <div className="flex h-full flex-col" style={{ width }} inert={!isPresent}>
      {children}
    </div>
  );
}

export interface AnimatedSidePanelProps {
  open: boolean;
  /** Effective panel width, already clamped by the responsive layout. */
  width: number;
  label: string;
  children: ReactNode;
  /** Narrow windows use a fixed slide-in drawer instead of a docked column. */
  overlay?: boolean;
  /** Suppresses the width transition while the panel is being resized. */
  resizing?: boolean;
  /** Overlay backdrop click, owned by the panel's store action. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * Right sidebar with the same enter/exit motion as the left desktop sidebar
 * (AppShell): docked panels animate width 0 ↔ width, overlay panels slide from
 * the right behind a fading backdrop. Width changes during a drag are instant.
 */
export function AnimatedSidePanel({
  open,
  width,
  label,
  children,
  overlay = false,
  resizing = false,
  onDismiss,
  className,
}: AnimatedSidePanelProps) {
  const reduceMotion = useReduceMotion();
  const transition = resolveSidePanelTransition({ reduceMotion, resizing });
  const offset = reduceMotion ? 0 : width;

  const panel = (
    <motion.aside
      key="panel"
      aria-label={label}
      initial={overlay ? { x: offset, opacity: reduceMotion ? 1 : 0 } : { width: 0 }}
      animate={overlay ? { x: 0, opacity: 1 } : { width }}
      exit={overlay ? { x: offset, opacity: reduceMotion ? 1 : 0 } : { width: 0 }}
      transition={transition}
      style={overlay ? { width } : undefined}
      className={cn(
        'z-50 flex h-full shrink-0 flex-col bg-surface',
        overlay ? 'fixed inset-y-0 right-0 shadow-2xl' : 'relative z-10',
        className,
      )}
    >
      <PanelContent width={width}>{children}</PanelContent>
    </motion.aside>
  );

  return (
    <AnimatePresence initial={false}>
      {!open
        ? null
        : overlay
          ? [
              <motion.div
                key="backdrop"
                data-side-panel="backdrop"
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18 }}
                onClick={onDismiss}
                className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm"
              />,
              panel,
            ]
          : [panel]}
    </AnimatePresence>
  );
}
