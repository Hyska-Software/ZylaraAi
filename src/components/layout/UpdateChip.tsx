/**
 * Update indicator of the app chrome (DESIGN §5): a compact pill at the end of
 * the layout's 40px chrome row, immediately before the window controls.
 *
 * It is the always-visible surface for an available release and also carries
 * live feedback while the download runs. Clicking it opens the full panel with
 * notes, size/platform, download progress and the install action.
 */
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { canSelfInstall, useUpdateStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { UpdatePopoverBody } from './UpdatePanel';

type Tone = 'accent' | 'neutral' | 'success' | 'danger';

const TONES: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent',
  neutral: 'bg-surface-hover text-foreground-muted hover:text-foreground',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
};

export function UpdateChip() {
  const { t } = useTranslation('common');
  const info = useUpdateStore((state) => state.info);
  const phase = useUpdateStore((state) => state.phase);
  const managed = useUpdateStore((state) => state.managed);
  const progress = useUpdateStore((state) => state.progress);
  const manualCheck = useUpdateStore((state) => state.manualCheck);
  const errorScope = useUpdateStore((state) => state.errorScope);
  const open = useUpdateStore((state) => state.open);
  const setOpen = useUpdateStore((state) => state.setOpen);

  const visible =
    Boolean(info?.available) ||
    (manualCheck && phase === 'checking') ||
    (phase === 'error' && errorScope === 'download');
  if (!visible) return null;

  const percent = Math.round(progress?.percent ?? 0);
  let tone: Tone = 'accent';
  let label = info
    ? t('shell.update.available', { version: info.latestVersion })
    : t('shell.update.checking');
  let title = info
    ? t('shell.update.availableTitle', { version: info.latestVersion })
    : t('shell.update.checkingTitle');
  let Icon = ArrowUpCircle;
  let spin = false;

  switch (phase) {
    case 'checking':
      // A silent refresh of a known release keeps the "available" pill; only a
      // manual check without a known version shows the checking state.
      if (info) break;
      tone = 'neutral';
      label = t('shell.update.checking');
      title = t('shell.update.checkingTitle');
      Icon = Loader2;
      spin = true;
      break;
    case 'downloading':
      tone = 'accent';
      label = t('shell.update.downloading', { percent });
      title = t('shell.update.downloadingTitle', { percent });
      Icon = Download;
      break;
    case 'verifying':
      tone = 'neutral';
      label = t('shell.update.verifying');
      title = t('shell.update.verifyingTitle');
      Icon = ShieldCheck;
      break;
    case 'ready':
      tone = 'success';
      label = t('shell.update.ready', { version: info?.latestVersion ?? '' });
      title = t('shell.update.readyTitle', { version: info?.latestVersion ?? '' });
      Icon = CheckCircle2;
      break;
    case 'installing':
      tone = 'accent';
      if (canSelfInstall(managed, info?.asset?.kind)) {
        label = t('shell.update.installingManaged');
        title = t('shell.update.installingManagedTitle');
      } else {
        label = t('shell.update.installing');
        title = t('shell.update.installingTitle');
      }
      Icon = Loader2;
      spin = true;
      break;
    case 'error':
      tone = 'danger';
      label = t('shell.update.error');
      title = t('shell.update.error');
      Icon = AlertTriangle;
      break;
    default:
      break;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={title}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'no-drag relative flex h-7 shrink-0 items-center gap-1.5 overflow-hidden rounded-full px-2.5',
            'text-[11.5px] font-medium leading-none tracking-tight transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
            'motion-reduce:transition-none',
            TONES[tone],
          )}
        >
          <Icon
            aria-hidden
            className={cn('size-3.5 shrink-0', spin && 'animate-spin motion-reduce:animate-none')}
            strokeWidth={1.75}
          />
          <span className="hidden whitespace-nowrap lg:inline">{label}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 opacity-60" strokeWidth={2} />
          {phase === 'downloading' ? (
            <span aria-hidden className="absolute inset-x-1.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-accent/20">
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-200 ease-out motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-label={t('shell.update.popoverAria')}
        className="w-[360px] p-4"
      >
        <UpdatePopoverBody onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
