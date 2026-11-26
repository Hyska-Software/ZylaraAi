import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui';
import { ProviderGlyph } from '@/components/settings/ProviderGlyph';
import { keyStatusFor } from '@/lib/modelMenu';
import { cn } from '@/lib/utils';
import type { ProviderAuthStatus, ProviderInfo, ProviderKeyStatus } from '@/lib/types';
import { authStatusFor, providerAuthenticated, providerTabTitle } from './providerAuth';

/** Sentinel value for "all providers" in the provider dropdown. */
export const ALL_PROVIDERS = 'all';

export interface ProviderSelectProps {
  providers: ProviderInfo[];
  /** Provider id or [`ALL_PROVIDERS`]. */
  value: string;
  onChange: (value: string) => void;
  keys: ProviderKeyStatus[];
  auth: ProviderAuthStatus[];
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

function ProviderDot({ authenticated }: { authenticated: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        authenticated ? 'bg-success' : 'bg-border-strong',
      )}
    />
  );
}

/**
 * Provider dropdown shared by the compact pill and the full picker.
 *
 * Replaces the old tab/segmented row so the catalogue can offer an explicit
 * "All providers" scope without turning the header into a five-way segmented
 * control. Every option still carries the provider auth dot and title.
 */
export function ProviderSelect({
  providers,
  value,
  onChange,
  keys,
  auth,
  size = 'md',
  ariaLabel,
  className,
}: ProviderSelectProps) {
  const { t } = useTranslation('models');
  const compact = size === 'sm';
  const selected = providers.find((provider) => provider.id === value);
  const selectedKey = selected ? keyStatusFor(keys, selected.id) : undefined;
  const selectedAuth = selected ? authStatusFor(auth, selected.id) : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? t('picker.providersAria')}
          title={
            selected
              ? `${providerTabTitle(selected, selectedKey, selectedAuth)}${
                  selected.transport === 'acp' ? ` · ${t('picker.acpTitle')}` : ''
                }`
              : t('picker.allProviders')
          }
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-surface-hover',
            'font-medium text-foreground transition-colors duration-150 motion-reduce:transition-none',
            'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            compact ? 'h-7 px-2 text-[12px]' : 'h-8 px-2.5 text-[12.5px]',
            className,
          )}
        >
          {selected ? (
            <ProviderGlyph
              providerId={selected.id}
              name={selected.name}
              iconSvg={selected.iconSvg}
              size={16}
            />
          ) : null}
          <span className="truncate">
            {selected?.shortName ?? t('picker.allProviders')}
          </span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value={ALL_PROVIDERS}>
            {t('picker.allProviders')}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {providers.map((provider) => {
            const providerKey = keyStatusFor(keys, provider.id);
            const providerAuthStatus = authStatusFor(auth, provider.id);
            return (
              <DropdownMenuRadioItem
                key={provider.id}
                value={provider.id}
                title={`${providerTabTitle(provider, providerKey, providerAuthStatus)}${
                  provider.transport === 'acp' ? ` · ${t('picker.acpTitle')}` : ''
                }`}
              >
                <ProviderGlyph
                  providerId={provider.id}
                  name={provider.name}
                  iconSvg={provider.iconSvg}
                  size={16}
                />
                <span className="truncate">{provider.shortName}</span>
                {provider.transport === 'acp' ? (
                  <span className="rounded bg-accent-soft px-1 text-[9px] font-semibold uppercase text-accent">
                    {t('picker.acpBadge')}
                  </span>
                ) : null}
                <ProviderDot
                  authenticated={providerAuthenticated(providerKey, providerAuthStatus)}
                />
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
