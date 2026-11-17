/**
 * Chips of the harness modes contributed by plugins.
 *
 * The available list comes from the plugin snapshot (`snapshot.modes`) and the
 * active state from the backend session store, so a mode toggled in one layout
 * shows up in the other. A mode is active when it was turned on, or when it is
 * `defaultOn` and never turned off.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Tooltip } from '@/components/ui';
import { api } from '@/lib/api';
import { pluginIcon } from '@/lib/plugins/icons';
import { usePluginStore } from '@/lib/plugins/store';
import type { PluginModesView, PluginModeView } from '@/lib/plugins/types';
import { cn } from '@/lib/utils';

export interface PluginModeChipsProps {
  conversationId: string | null;
  /** Turn profile the composer belongs to (`chat` or `code`). */
  profile: 'chat' | 'code';
  className?: string;
}

function isActive(state: PluginModesView, mode: PluginModeView): boolean {
  if (state.on.includes(mode.key)) return true;
  return mode.defaultOn && !state.off.includes(mode.key);
}

export function PluginModeChips({ conversationId, profile, className }: PluginModeChipsProps) {
  const { t } = useTranslation('composer');
  const modes = usePluginStore((state) => state.snapshot.modes) ?? [];
  const [state, setState] = useState<PluginModesView>({ on: [], off: [] });
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId || typeof api.pluginModesState !== 'function') {
      setState({ on: [], off: [] });
      return () => {
        cancelled = true;
      };
    }
    api
      .pluginModesState(conversationId)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState({ on: [], off: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // A slash command or another layout can toggle a mode; the backend event keeps
  // the chips in sync without a manual reload.
  useEffect(() => {
    if (!conversationId) return undefined;
    const onChanged = () => {
      if (typeof api.pluginModesState !== 'function') return;
      api
        .pluginModesState(conversationId)
        .then((next) => setState(next))
        .catch(() => {
          /* the chips keep the last known state */
        });
    };
    window.addEventListener('zylara:plugin-mode-changed', onChanged);
    return () => window.removeEventListener('zylara:plugin-mode-changed', onChanged);
  }, [conversationId]);

  const visible = modes.filter(
    (mode) => mode.profiles.length === 0 || mode.profiles.includes(profile),
  );
  if (!conversationId || visible.length === 0) return null;

  const toggle = async (mode: PluginModeView) => {
    if (pending || typeof api.setPluginMode !== 'function') return;
    setPending(mode.key);
    try {
      const next = await api.setPluginMode(conversationId, mode.key, !isActive(state, mode));
      setState(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      {visible.map((mode) => {
        const active = isActive(state, mode);
        const Icon = pluginIcon(mode.icon);
        const label = mode.title;
        return (
          <Tooltip
            key={mode.key}
            content={mode.description || t('pluginMode.tooltip', { name: mode.pluginName })}
            side="top"
          >
            <button
              type="button"
              aria-label={t('pluginMode.toggle', { name: label })}
              aria-pressed={active}
              disabled={pending === mode.key}
              onClick={() => void toggle(mode)}
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5',
                'text-[12px] font-medium transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                'disabled:pointer-events-none disabled:opacity-60',
                active
                  ? 'bg-accent-soft text-foreground hover:bg-accent-soft/80'
                  : 'bg-surface text-foreground-muted hover:text-foreground',
                className,
              )}
            >
              <Icon
                aria-hidden
                className={cn('size-3.5 shrink-0', active ? 'text-accent' : 'text-foreground-subtle')}
                strokeWidth={1.75}
              />
              <span>{label}</span>
            </button>
          </Tooltip>
        );
      })}
    </>
  );
}
