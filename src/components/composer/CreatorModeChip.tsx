/**
 * Badge (pill) do modo Plugin Creator dentro do campo de mensagem do composer.
 *
 * O modo é persistido na sessão Code (`creator/mode`) e habilita o prompt de
 * criação de plugins + a tool `validate_plugin`. O clique desativa o modo; o
 * estado vem do `codeStore` (otimista, com rollback no erro).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Blocks } from 'lucide-react';

import { Tooltip } from '@/components/ui';
import { useCodeStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export interface CreatorModeChipProps {
  conversationId: string;
  className?: string;
}

export function CreatorModeChip({ conversationId, className }: CreatorModeChipProps) {
  const { t } = useTranslation('composer');
  const creatorMode = useCodeStore(
    (state) => state.byConversation[conversationId]?.creatorMode ?? false,
  );
  const [pending, setPending] = useState(false);

  if (!creatorMode) return null;

  const deactivate = async () => {
    if (pending) return;
    setPending(true);
    try {
      await useCodeStore.getState().setCreatorMode(conversationId, false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Tooltip content={t('creatorMode.tooltip')} side="top">
      <button
        type="button"
        aria-label={t('creatorMode.disable')}
        aria-pressed={true}
        disabled={pending}
        onClick={() => void deactivate()}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5',
          'text-[12px] font-medium text-foreground',
          'transition-colors duration-150 hover:bg-accent-soft/80',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          'disabled:pointer-events-none disabled:opacity-60',
          className,
        )}
      >
        <Blocks aria-hidden className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} />
        <span>{t('creatorMode.label')}</span>
      </button>
    </Tooltip>
  );
}
