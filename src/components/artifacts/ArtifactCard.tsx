import { Download, ExternalLink } from 'lucide-react';
import { Slot } from '@/components/plugins/ui/Slot';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { api } from '@/lib/api';
import { t as translate } from '@/lib/i18n';
import type { Artifact } from '@/lib/types';
import { cn, formatBytes } from '@/lib/utils';
import { useUiStore } from '@/lib/store';
import { Button, IconButton, Tooltip } from '@/components/ui';
import { artifactKindMeta } from './kinds';

export interface ArtifactCardProps {
  artifact: Artifact;
  /** Overrides the default action (open the artifact panel). */
  onOpen?: (artifact: Artifact) => void;
  compact?: boolean;
  /** Highlights the artifact currently open in the side panel list. */
  active?: boolean;
  className?: string;
}

async function saveArtifact(artifact: Artifact) {
  try {
    const path = await api.saveArtifact(artifact.id, artifact.name);
    if (path) toast.success(translate('artifacts:card.saveSuccess'), { description: path });
  } catch (error) {
    toast.error(translate('artifacts:card.saveError'), {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

async function openArtifactExternally(artifact: Artifact) {
  try {
    // The command delegates to tauri-plugin-opener (ShellExecute on Windows,
    // open on macOS, xdg-open on Linux) using the stored artifact path.
    await api.openArtifact(artifact.id);
  } catch (error) {
    toast.error(translate('artifacts:card.openError'), {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Compact artifact card (DESIGN §6.3/§11): kind icon on a colored tile, name
 * (13px), "kind · size" subtitle (11px) and the preview / default-app / save
 * actions. Used inline in the chat flow and in the panel list (`compact`).
 */
export function ArtifactCard({
  artifact,
  onOpen,
  compact = false,
  active = false,
  className,
}: ArtifactCardProps) {
  const { t } = useTranslation('artifacts');
  const meta = artifactKindMeta(artifact.kind);
  const Icon = meta.icon;

  const open = () => {
    if (onOpen) {
      onOpen(artifact);
      return;
    }
    useUiStore.getState().setActiveArtifact(artifact.id);
  };

  const handleSave = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void saveArtifact(artifact);
  };

  const handleOpenExternal = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void openArtifactExternally(artifact);
  };

  return (
    <div
      data-active={active || undefined}
      className={cn(
        'group/artifact flex min-w-0 items-center gap-2.5 rounded-xl bg-surface-hover p-2',
        'transition-colors duration-150 hover:bg-surface-hover',
        active && ' bg-accent-soft/60 hover:bg-accent-soft/70',
        compact && 'gap-2 p-1.5',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg',
          meta.tone,
          compact && 'size-7 rounded-md',
        )}
      >
        <Icon className={cn('size-4', compact && 'size-3.5')} strokeWidth={1.9} />
      </span>

      <button
        type="button"
        onClick={open}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'min-w-0 flex-1 rounded-lg text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        )}
      >
        <span className="block truncate text-[13px] font-medium leading-snug text-foreground decoration-border-strong underline-offset-2 group-hover/artifact:underline">
          {artifact.name}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-snug text-foreground-muted tabular-nums">
          {t('artifacts:card.subtitle', { kind: meta.label, size: formatBytes(artifact.size) })}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="secondary" onClick={open}>
          {t('artifacts:card.open')}
        </Button>
        <Tooltip content={t('artifacts:panel.openExternal')} side="top">
          <IconButton
            label={t('artifacts:card.openExternalNamed', { name: artifact.name })}
            size="sm"
            onClick={handleOpenExternal}
          >
            <ExternalLink className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('artifacts:card.saveAs')} side="top">
          <IconButton
            label={t('artifacts:card.saveNamed', { name: artifact.name })}
            size="sm"
            onClick={handleSave}
          >
            <Download className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Slot
          name="artifact.card.actions"
          owner={{ artifactId: artifact.id, artifactKind: artifact.kind }}
        />
      </div>
    </div>
  );
}
