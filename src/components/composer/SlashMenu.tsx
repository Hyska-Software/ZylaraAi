import { useTranslation } from 'react-i18next';
import { CornerDownLeft, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SlashCommandGroup, SlashCommandView } from './commands';

export const SLASH_LISTBOX_ID = 'composer-slash-listbox';

export function slashOptionId(index: number): string {
  return `composer-slash-option-${index}`;
}

export interface SlashMenuProps {
  /** Comandos já filtrados pela query digitada depois de `/`. */
  commands: SlashCommandView[];
  activeIndex: number;
  onSelect: (command: SlashCommandView) => void;
  onHoverIndex: (index: number) => void;
}

const GROUP_ORDER: SlashCommandGroup[] = [
  'session',
  'plan',
  'goal',
  'creator',
  'git',
  'context',
  'project',
  'plugins',
];

/**
 * Listbox de comandos `/` do modo Code (WORKBENCH §12). Os grupos preservam a
 * ordem do catálogo; `aria-activedescendant` no textarea aponta para o id da
 * opção ativa.
 */
export function SlashMenu({ commands, activeIndex, onSelect, onHoverIndex }: SlashMenuProps) {
  const { t } = useTranslation('composer');
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: commands
      .map((command, index) => ({ command, index }))
      .filter((entry) => entry.command.group === group),
  })).filter((entry) => entry.items.length > 0);

  return (
    <div className="w-full">
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
        <Terminal aria-hidden className="size-3.5 shrink-0 text-foreground-subtle" strokeWidth={1.75} />
        <p className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
          {t('slash.header')}
        </p>
        <span className="flex items-center gap-1 text-[10.5px] text-foreground-subtle">
          <CornerDownLeft aria-hidden className="size-3" strokeWidth={1.75} />
          Enter
        </span>
      </div>

      {commands.length === 0 ? (
        <p className="px-2.5 py-2 text-[12px] leading-relaxed text-foreground-muted">
          {t('slash.empty')}
        </p>
      ) : (
        <div
          role="listbox"
          id={SLASH_LISTBOX_ID}
          aria-label={t('slash.listAria')}
          className="max-h-72 overflow-y-auto overscroll-contain p-1"
        >
          {grouped.map(({ group, items }) => (
            <div key={group} role="presentation">
              <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
                {items[0]?.command.groupLabel ?? ''}
              </p>
              {items.map(({ command, index }) => {
                const active = index === activeIndex;
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    id={slashOptionId(index)}
                    aria-selected={active}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => onHoverIndex(index)}
                    onClick={() => onSelect(command)}
                    className={cn(
                      'flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left',
                      'transition-colors duration-100',
                      active ? 'bg-surface-active' : 'hover:bg-surface-hover',
                    )}
                  >
                    <span className="mt-0.5 flex min-w-0 flex-1 items-start gap-2">
                      <span
                        className={cn(
                          'shrink-0 font-mono text-[12px] leading-5',
                          active ? 'text-accent' : 'text-foreground-muted',
                        )}
                      >
                        {command.command}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-medium text-foreground">
                          {command.title}
                        </span>
                        <span className="block truncate text-[11px] leading-relaxed text-foreground-subtle">
                          {command.description}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SlashMenu;
