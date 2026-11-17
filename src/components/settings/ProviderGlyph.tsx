import { fallbackInitials } from '@/lib/modelIcons';
import { PROVIDER_ICON_SVG } from '@/lib/providerIconAssets';
import { PROVIDER_ICON_LABELS, providerIconFor } from '@/lib/providerIcons';
import { pluginIcon } from '@/lib/plugins/icons';
import { cn } from '@/lib/utils';

export interface ProviderGlyphProps {
  providerId: string;
  /** Used for the initials fallback when the provider has no brand mark. */
  name?: string | null;
  size?: number;
  className?: string;
  /** Tooltip; defaults to the brand label of the resolved mark. */
  title?: string;
  /** Declarative icon name (plugin/user provider); falls back to initials. */
  icon?: string | null;
}

/**
 * Provider brand glyph (mono LobeHub mark tinted by `currentColor`) or the
 * provider name initials when the collection has no mark for it. Always
 * decorative: the provider name is rendered next to it.
 */
export function ProviderGlyph({
  providerId,
  name,
  size = 20,
  className,
  title,
  icon: iconName,
}: ProviderGlyphProps) {
  const icon = providerIconFor(providerId);
  // A contributed icon (lucide name from `contributes.providers[].icon` or a
  // user-defined provider) wins over the bundled brand map.
  const Contributed = iconName ? pluginIcon(iconName) : null;

  if (Contributed) {
    return (
      <span
        aria-hidden
        title={title}
        style={{ width: size, height: size }}
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center text-foreground',
          className,
        )}
      >
        <Contributed aria-hidden style={{ width: size, height: size }} strokeWidth={1.75} />
      </span>
    );
  }

  if (icon) {
    return (
      <span
        aria-hidden
        title={title ?? PROVIDER_ICON_LABELS[icon]}
        style={{ fontSize: size }}
        className={cn(
          'inline-flex shrink-0 select-none items-center justify-center text-foreground [&>svg]:block',
          className,
        )}
        // Trusted internal constant (bundled LobeHub SVG, MIT): never user input.
        dangerouslySetInnerHTML={{ __html: PROVIDER_ICON_SVG[icon] }}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={title}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.44)),
      }}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-md bg-surface-hover font-semibold uppercase leading-none tracking-tight text-foreground-muted',
        className,
      )}
    >
      {fallbackInitials(name, providerId)}
    </span>
  );
}
