import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileQuestion,
  Files,
  List,
  PanelRight,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { PluginSlot } from '@/components/plugins/PluginHosts';
import { t as translate } from '@/lib/i18n';
import { formatDateTime } from '@/lib/i18n/format';
import type { ArtifactContent } from '@/lib/types';
import { cn, formatBytes } from '@/lib/utils';
import {
  SIDE_PANEL_WIDTH_MIN,
  SIDE_PANEL_WIDTH_STEP,
  useUiStore,
  type SidePanelMode,
} from '@/lib/store';
import { useSidePanelResize } from '@/lib/sidePanel';
import { PanelResizer } from '@/components/layout/PanelResizer';
import { Badge, Button, IconButton, Spinner, Tooltip } from '@/components/ui';
import { artifactKindMeta } from './kinds';
import { ArtifactPreview } from './ArtifactPreview';
import { ArtifactList } from './ArtifactList';

interface SidePanelModeButtonProps {
  mode: SidePanelMode;
  canDock: boolean;
  onToggle: () => void;
}

/**
 * Header action that flips the side panel between overlay (floating over the
 * chat) and docked (splitting the row with it). DESIGN §5/§12: `aria-pressed`
 * marks the docked state and the button is disabled while the window is too
 * narrow to honor the docked layout.
 */
function SidePanelModeButton({ mode, canDock, onToggle }: SidePanelModeButtonProps) {
  const { t } = useTranslation('artifacts');
  const docked = mode === 'docked';
  const label = t(docked ? 'artifacts:panel.dockedTooltip' : 'artifacts:panel.overlayTooltip');
  const disabled = !canDock && !docked;
  const tooltip = disabled ? t('artifacts:panel.dockDisabledTooltip') : label;
  const button = (
    <IconButton label={label} size="sm" active={docked} disabled={disabled} onClick={onToggle}>
      <PanelRight className="size-4" />
    </IconButton>
  );

  return (
    <Tooltip content={tooltip} side="bottom">
      {/* Disabled buttons swallow pointer events: hover a wrapper so the
          "aumente a janela" hint stays discoverable. */}
      {disabled ? <span className="inline-flex">{button}</span> : button}
    </Tooltip>
  );
}

/**
 * Canvas-like side panel for artifacts (DESIGN §5/§11): slide-in from the right,
 * with two store-driven views — the conversation artifact list and a single
 * artifact preview (kind-aware, with navigation, save/open/delete actions).
 * Visibility is driven by `useUiStore`.
 */
export function ArtifactPanel() {
  const { t } = useTranslation('artifacts');
  const open = useUiStore((state) => state.artifactPanelOpen);
  const panelView = useUiStore((state) => state.artifactPanelView);
  const artifacts = useUiStore((state) => state.artifacts);
  const activeId = useUiStore((state) => state.activeArtifactId);
  const setActiveArtifact = useUiStore((state) => state.setActiveArtifact);
  const setArtifactPanelView = useUiStore((state) => state.setArtifactPanelView);
  const closeArtifactPanel = useUiStore((state) => state.closeArtifactPanel);

  // Shared width/layout state (DESIGN §5): the hook previews the drag locally,
  // commits on release and resolves the responsive overlay/docked layout.
  const {
    layout,
    mode: sidePanelMode,
    setMode,
    onResize,
    onResizeEnd,
    onReset,
  } = useSidePanelResize();

  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  const artifact = artifacts.find((entry) => entry.id === activeId) ?? null;
  const meta = artifact ? artifactKindMeta(artifact.kind) : null;
  const ArtifactIcon = meta?.icon ?? FileQuestion;
  // A preview without an active artifact falls back to the list, so the panel
  // never shows an empty/stale preview surface.
  const mode = panelView === 'preview' && artifact ? 'preview' : 'list';
  const toggleSidePanelMode = () => setMode(sidePanelMode === 'docked' ? 'overlay' : 'docked');

  // Move focus into the panel when it opens (and when the list preview swaps),
  // so keyboard users can reach the actions of the new view.
  useEffect(() => {
    if (!open) return;
    const handle = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(handle);
  }, [open, mode]);

  const index = artifact ? artifacts.findIndex((entry) => entry.id === artifact.id) : -1;

  useEffect(() => {
    setConfirmDelete(false);
    if (!open || !activeId) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    api
      .getArtifactContent(activeId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setError(translate('artifacts:panel.noContent'));
          return;
        }
        setContent(result);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeId]);

  const navigate = (delta: number) => {
    if (!artifact || artifacts.length < 2) return;
    const next = artifacts[(index + delta + artifacts.length) % artifacts.length];
    if (next) setActiveArtifact(next.id);
  };

  const handleSave = async () => {
    if (!artifact) return;
    try {
      const path = await api.saveArtifact(artifact.id, artifact.name);
      if (path) toast.success(translate('artifacts:card.saveSuccess'), { description: path });
    } catch (saveError) {
      toast.error(translate('artifacts:card.saveError'), {
        description: saveError instanceof Error ? saveError.message : String(saveError),
      });
    }
  };

  const handleOpen = async () => {
    if (!artifact) return;
    try {
      await api.openArtifact(artifact.id);
    } catch (openError) {
      toast.error(translate('artifacts:card.openError'), {
        description: openError instanceof Error ? openError.message : String(openError),
      });
    }
  };

  const handleDelete = async () => {
    if (!artifact) return;
    setBusy(true);
    try {
      await api.deleteArtifact(artifact.id);
      const rest = useUiStore.getState().artifacts.filter((entry) => entry.id !== artifact.id);
      useUiStore.getState().setArtifacts(rest);
      if (rest.length) {
        useUiStore.getState().setActiveArtifact(rest[0].id);
      } else {
        closeArtifactPanel();
      }
      toast.success(translate('artifacts:panel.deleteSuccess'));
      setConfirmDelete(false);
    } catch (deleteError) {
      toast.error(translate('artifacts:panel.deleteError'), {
        description: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label={t('artifacts:panel.ariaLabel')}
      aria-hidden={!open || undefined}
      inert={!open}
      style={{
        width: layout.width,
        // Closed docked panel: hide structurally (inline) so two surfaces can
        // never end up side by side, regardless of utility-class merging.
        ...(layout.docked && !open ? { display: 'none' } : null),
      }}
      className={cn(
        layout.docked
          ? 'relative z-10 flex h-full shrink-0 flex-col border-l border-border bg-surface-raised outline-none'
          : 'absolute inset-y-0 right-0 z-40 flex max-w-[92vw] flex-col border-l border-border bg-surface-raised shadow-2xl outline-none',
        layout.docked
          ? !open && 'hidden'
          : cn(
              'transition-transform duration-[240ms] ease-[var(--ease-out-soft)] motion-reduce:transition-none',
              open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
            ),
      )}
    >
      {mode === 'preview' && artifact && meta ? (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', meta.tone)}>
              <ArtifactIcon aria-hidden className="size-4" strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[13px] font-semibold tracking-tight text-foreground">
                {artifact.name}
              </h2>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-foreground-subtle">
                <Badge tone="muted">{meta.label}</Badge>
                <span className="tabular-nums">{formatBytes(artifact.size)}</span>
                {artifact.language ? <span>· {artifact.language}</span> : null}
              </div>
            </div>
            <div className="flex min-w-0 shrink-0 items-center gap-1">
              <PluginSlot
                slot="artifact.preview.toolbar"
                context={{
                  artifactId: artifact.id,
                  artifactKind: artifact.kind,
                  mimeType: artifact.mimeType,
                }}
                compact
              />
              <PluginSlot slot="right.panel.header" compact />
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip content={t('artifacts:panel.viewList')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.viewListLabel')}
                  size="sm"
                  onClick={() => setArtifactPanelView('list')}
                >
                  <List className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('artifacts:panel.previous')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.previous')}
                  size="sm"
                  onClick={() => navigate(-1)}
                  disabled={artifacts.length < 2}
                >
                  <ChevronLeft className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('artifacts:panel.next')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.next')}
                  size="sm"
                  onClick={() => navigate(1)}
                  disabled={artifacts.length < 2}
                >
                  <ChevronRight className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('artifacts:panel.saveAs')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.saveAs')}
                  size="sm"
                  onClick={() => void handleSave()}
                >
                  <Download className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('artifacts:panel.openExternal')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.openExternal')}
                  size="sm"
                  onClick={() => void handleOpen()}
                >
                  <ExternalLink className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('artifacts:panel.delete')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.deleteLabel')}
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="hover:text-danger"
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </Tooltip>
              <SidePanelModeButton
                mode={sidePanelMode}
                canDock={layout.canDock}
                onToggle={toggleSidePanelMode}
              />
              <Tooltip content={t('artifacts:panel.close')} side="bottom">
                <IconButton
                  label={t('artifacts:panel.closeLabel')}
                  size="sm"
                  onClick={closeArtifactPanel}
                >
                  <X className="size-4" />
                </IconButton>
              </Tooltip>
            </div>
          </header>

          {confirmDelete ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-danger-soft px-3 py-2 text-[12px] text-danger">
              <AlertTriangle aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 leading-snug">
                {t('artifacts:panel.deleteConfirm', { name: artifact.name })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
                {t('common:actions.cancel')}
              </Button>
              <Button size="sm" variant="danger" loading={busy} onClick={() => void handleDelete()}>
                {t('artifacts:panel.delete')}
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            {loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-2">
                <Spinner
                  size="md"
                  className="text-accent"
                  label={t('artifacts:panel.loadingLabel')}
                />
                <span className="text-xs text-foreground-muted">{t('artifacts:panel.loading')}</span>
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <AlertTriangle aria-hidden className="size-5 text-danger" />
                <p className="text-[13px] font-medium text-foreground">
                  {t('artifacts:panel.loadErrorTitle')}
                </p>
                <p className="text-xs leading-relaxed text-foreground-muted">{error}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (activeId) {
                      setLoading(true);
                      api
                        .getArtifactContent(activeId)
                        .then((result) => {
                          setContent(result);
                          setError(result ? null : t('artifacts:panel.noContent'));
                        })
                        .catch((retryError: unknown) =>
                          setError(retryError instanceof Error ? retryError.message : String(retryError)),
                        )
                        .finally(() => setLoading(false));
                    }
                  }}
                >
                  {t('artifacts:panel.retry')}
                </Button>
              </div>
            ) : content ? (
              <ArtifactPreview content={content} />
            ) : null}
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2 text-[11px] text-foreground-subtle">
            <span className="tabular-nums">
              {index >= 0
                ? t('artifacts:panel.count', {
                    current: index + 1,
                    total: artifacts.length,
                    count: artifacts.length,
                  })
                : t('artifacts:panel.countUnknown', { count: artifacts.length })}
            </span>
            <span>
              {t('artifacts:panel.createdAt', {
                date: formatDateTime(artifact.createdAt),
              })}
            </span>
          </footer>
        </>
      ) : (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-foreground-muted">
              <Files aria-hidden className="size-4" strokeWidth={1.9} />
            </span>
            <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-foreground">
              {t('artifacts:panel.title')}
            </h2>
            <Badge
              tone="muted"
              size="md"
              title={t('artifacts:panel.listCount', { count: artifacts.length })}
              className="tabular-nums"
            >
              {artifacts.length}
            </Badge>
            <SidePanelModeButton
              mode={sidePanelMode}
              canDock={layout.canDock}
              onToggle={toggleSidePanelMode}
            />
            <Tooltip content={t('artifacts:panel.close')} side="bottom">
              <IconButton
                label={t('artifacts:panel.closeLabel')}
                size="sm"
                onClick={closeArtifactPanel}
              >
                <X className="size-4" />
              </IconButton>
            </Tooltip>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
            <ArtifactList artifacts={artifacts} activeId={activeId} />
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2 text-[11px] text-foreground-subtle">
            <span className="tabular-nums">
              {t('artifacts:panel.listCount', { count: artifacts.length })}
            </span>
            {artifacts.length ? <span>{t('artifacts:panel.listHint')}</span> : null}
          </footer>
        </>
      )}

      {/* Out of flow, over the left edge: never covers the list or the scrollbar.
          The containing block comes from the panel itself (`absolute` in overlay
          mode, whose AppShell row is `relative`; `relative` when docked), so no
          conflicting `relative` is needed. */}
      <PanelResizer
        side="end"
        value={layout.width}
        min={SIDE_PANEL_WIDTH_MIN}
        max={layout.maxWidth}
        step={SIDE_PANEL_WIDTH_STEP}
        label={t('artifacts:panel.resize')}
        className="absolute inset-y-0 -left-2 z-10"
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        onReset={onReset}
      />
    </aside>
  );
}

export default ArtifactPanel;
