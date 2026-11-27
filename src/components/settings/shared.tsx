import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div>
        <h3 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{description}</p>
        ) : null}
      </div>
      <div className="rounded-xl bg-surface px-4 py-2">
        {children}
      </div>
    </section>
  );
}

/** Settings section whose whole header toggles the visibility of its content. */
export function CollapsibleSettingsSection({
  title,
  description,
  children,
  defaultOpen = false,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full items-start gap-2 rounded-lg py-0.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold tracking-tight text-foreground">
              {title}
            </span>
            {description ? (
              <span className="mt-0.5 block text-xs leading-relaxed text-foreground-muted">
                {description}
              </span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-4 shrink-0 text-foreground-muted transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </button>
      </h3>
      <div id={contentId} hidden={!open} className="rounded-xl bg-surface px-4 py-2">
        {children}
      </div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
  vertical = false,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  vertical?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex gap-6 py-3',
        vertical ? 'flex-col items-stretch' : 'flex-wrap items-center justify-between',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{description}</p>
        ) : null}
      </div>
      {children ? (
        <div className={cn('shrink-0', vertical ? 'w-full' : 'max-w-[340px]')}>{children}</div>
      ) : null}
    </div>
  );
}

/** Free-form block inside a SettingsSection (already separated by dividers). */
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('py-3', className)}>{children}</div>;
}
