import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  type IconButtonSize,
} from '@/components/ui';
import { LAYOUT_MODES } from '@/lib/layoutModes';
import { useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export interface LayoutModeSwitchProps {
  className?: string;
  /** Button height; sidebar rows are 36px in Chat/Code and 32px in Agents. */
  size?: IconButtonSize;
  /** Called after switching so a compact drawer can dismiss itself. */
  onSelect?: () => void;
}

/**
 * Icon-only layout selector for the sidebar footer: the trigger shows the
 * current layout's icon and opens a plain list of icon-only items. Labels stay
 * in `aria-label`/`title` for screen readers and tooltips. The choice is
 * persisted with the rest of the UI state. With a single enabled layout there
 * is nothing to switch, so the control disappears.
 */
export function LayoutModeSwitch({ className, size = 'md', onSelect }: LayoutModeSwitchProps) {
  const { t } = useTranslation('common');
  const layoutMode = useUiStore((state) => state.layoutMode);
  const enabledLayouts = useUiStore((state) => state.enabledLayouts);
  const setLayoutMode = useUiStore((state) => state.setLayoutMode);

  const visibleModes = LAYOUT_MODES.filter((mode) => enabledLayouts[mode.value]);
  if (visibleModes.length <= 1) return null;

  const current = LAYOUT_MODES.find((mode) => mode.value === layoutMode) ?? visibleModes[0];
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t('layouts.groupAria')}
          title={t(current.titleKey)}
          size={size}
          variant="ghost"
          className={cn('shrink-0', className)}
        >
          <CurrentIcon aria-hidden className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" aria-label={t('layouts.menuLabel')} className="min-w-0">
        {visibleModes.map(({ value, labelKey, titleKey, icon: Icon }) => {
          const active = layoutMode === value;
          return (
            <DropdownMenuItem
              key={value}
              aria-label={t(labelKey)}
              title={t(titleKey)}
              aria-current={active ? 'true' : undefined}
              onSelect={() => {
                setLayoutMode(value);
                onSelect?.();
              }}
              icon={<Icon aria-hidden className="size-4" />}
              className={cn(
                'size-8 justify-center p-0 [&>span]:hidden',
                active && 'bg-accent-soft text-accent [&_svg]:text-accent',
              )}
            />
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
