/**
 * Host-rendered plugin surfaces: slots, views, side panels, settings tabs and
 * artifact viewers. Trusted components come from the registry; everything else
 * runs in the sandboxed `zplugin` iframe.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Puzzle, X } from 'lucide-react';

import { useChatStore, useUiStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { usePluginStore } from '@/lib/plugins/store';
import {
  pluginLabel,
  usePluginRegistry,
  viewByKey,
  panelByKey,
  type ResolvedArtifactViewer,
} from '@/lib/plugins/registry';
import { PluginFrame, reportPluginFailure } from '@/lib/plugins/frame';
import { Slot } from './ui/Slot';
import type { ArtifactContent } from '@/lib/types';
import type { PluginRecord } from '@/lib/plugins/types';

function PluginBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
      <Puzzle aria-hidden className="size-2.5" strokeWidth={2} />
      plugin
    </span>
  );
}

class PluginContributionBoundary extends Component<
  { plugin: PluginRecord; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[plugin ${this.props.plugin.name}] contribution crashed`, error, info.componentStack);
    reportPluginFailure(
      this.props.plugin,
      `PLUGIN_CONTRIBUTION_CRASHED: ${error.message}`,
    );
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="rounded-lg bg-danger-soft/40 px-3 py-2 text-[12px] text-danger"
      >
        {t('plugins:errors.renderFailed', { name: this.props.plugin.name })}
      </div>
    );
  }
}

export function PluginSlot({
  slot,
  context,
  className,
  compact = false,
  onlyPluginId,
}: {
  slot: string;
  context?: Record<string, unknown>;
  className?: string;
  compact?: boolean;
  onlyPluginId?: string;
}) {
  return (
    <Slot
      name={slot}
      owner={context}
      className={className}
      compact={compact}
      variant="row"
      onlyPluginId={onlyPluginId}
    />
  );
}

export function PluginPageHeader({
  title,
  subtitle,
  pluginId,
  onClose,
}: {
  title: string;
  subtitle: string;
  pluginId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('plugins');
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex size-8 items-center justify-center rounded-lg text-foreground-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t('host.back')}
        title={t('host.back')}
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[13px] font-semibold text-foreground">{title}</h1>
          <PluginBadge />
        </div>
        <p className="truncate text-[11px] text-foreground-subtle">{subtitle}</p>
      </div>
      <PluginSlot
        slot="plugins.detail.actions"
        className="shrink-0"
        compact
        onlyPluginId={pluginId}
      />
    </header>
  );
}

export function PluginViewHost() {
  const { t } = useTranslation('plugins');
  const active = usePluginStore((state) => state.activeView);
  const close = usePluginStore((state) => state.closeOverlays);
  usePluginRegistry();
  const conversationId = useChatStore((state) => state.activeId);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const resolved = viewByKey(active ? `${active.pluginId}:${active.id}` : null);
  if (!active || !resolved) return null;
  const { plugin, view } = resolved;
  if (view.surface !== 'global' && view.surface !== layoutMode) return null;
  const title = pluginLabel(plugin, view.titleKey, view.title);
  const subtitle = pluginLabel(plugin, view.descriptionKey, view.description ?? plugin.name);
  const context = { conversationId, layoutMode, pluginId: plugin.id, viewId: view.id };
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-plugin-view={resolved.key}>
      <PluginPageHeader
        title={title}
        subtitle={subtitle}
        pluginId={plugin.id}
        onClose={close}
      />
      <div className="min-h-0 flex-1">
        {resolved.component ? (
          (() => {
            const Component = resolved.component;
            return (
              <PluginContributionBoundary plugin={plugin}>
                <Component
                  plugin={plugin}
                  view={view}
                  context={context}
                  className="h-full min-h-0"
                />
              </PluginContributionBoundary>
            );
          })()
        ) : view.entry ? (
          <PluginFrame
            plugin={plugin}
            entry={view.entry}
            kind="view"
            title={title}
            context={context}
            className="h-full min-h-0"
            maxHeight={100_000}
            minHeight={320}
          />
        ) : (
          <div className="p-6 text-[13px] text-foreground-muted">
            {t('host.viewUnavailable')}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-3 py-2">
        <PluginSlot
          slot="plugins.detail.actions"
          context={{ ...context, pluginId: plugin.id }}
          compact
          onlyPluginId={plugin.id}
        />
      </div>
    </div>
  );
}

export function PluginPanelHost() {
  const { t } = useTranslation('plugins');
  const active = usePluginStore((state) => state.activePanel);
  const close = usePluginStore((state) => state.closeOverlays);
  usePluginRegistry();
  const conversationId = useChatStore((state) => state.activeId);
  const layoutMode = useUiStore((state) => state.layoutMode);
  const resolved = panelByKey(active ? `${active.pluginId}:${active.id}` : null);
  if (!active || !resolved) return null;
  const { plugin, panel } = resolved;
  const title = pluginLabel(plugin, panel.titleKey, panel.title);
  const context = { conversationId, layoutMode, pluginId: plugin.id, panelId: panel.id };
  return (
    <aside
      className="relative flex h-full min-h-0 w-[340px] max-w-[45vw] shrink-0 flex-col border-l border-border bg-surface"
      aria-label={title}
      data-plugin-panel={resolved.key}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] font-semibold text-foreground">{title}</h2>
          <p className="truncate text-[10.5px] text-foreground-subtle">{plugin.name}</p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={t('host.close')}
          title={t('host.close')}
          className="inline-flex size-7 items-center justify-center rounded-md text-foreground-muted hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X aria-hidden className="size-4" strokeWidth={2} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {resolved.component ? (
          (() => {
            const Component = resolved.component;
            return (
              <PluginContributionBoundary plugin={plugin}>
                <Component plugin={plugin} panel={panel} context={context} className="h-full" />
              </PluginContributionBoundary>
            );
          })()
        ) : panel.entry ? (
          <PluginFrame
            plugin={plugin}
            entry={panel.entry}
            kind="panel"
            title={title}
            context={context}
            className="h-full"
            maxHeight={100_000}
            minHeight={320}
          />
        ) : (
          <div className="p-4 text-[12px] text-foreground-muted">{t('host.panelUnavailable')}</div>
        )}
      </div>
    </aside>
  );
}

export function PluginSettingsTabPanel({ tabKey }: { tabKey: string }) {
  const { t } = useTranslation('plugins');
  const registry = usePluginRegistry();
  const tab = registry.settingsTabs.find((candidate) => candidate.key === tabKey);
  if (!tab) {
    return (
      <div className="text-[12px] text-foreground-muted">{t('host.settingsUnavailable')}</div>
    );
  }
  if (tab.component) {
    const Component = tab.component;
    return (
      <PluginContributionBoundary plugin={tab.plugin}>
        <Component plugin={tab.plugin} tab={tab.tab} context={{ tabKey }} />
      </PluginContributionBoundary>
    );
  }
  if (!tab.tab.entry) {
    return <div className="text-[12px] text-foreground-muted">{t('host.settingsUnavailable')}</div>;
  }
  return (
    <PluginFrame
      plugin={tab.plugin}
      entry={tab.tab.entry}
      kind="settings"
      title={pluginLabel(tab.plugin, tab.tab.titleKey, tab.tab.title)}
      context={{ tabKey }}
      minHeight={280}
      maxHeight={900}
    />
  );
}

export function PluginArtifactViewer({
  viewer,
  content,
  className,
  showArtifactActions,
}: {
  viewer: ResolvedArtifactViewer;
  content: ArtifactContent;
  className?: string;
  showArtifactActions?: boolean;
}) {
  const { plugin, component } = viewer;
  const context = {
    artifact: {
      id: content.artifact.id,
      name: content.artifact.name,
      mimeType: content.artifact.mimeType,
      kind: content.artifact.kind,
      size: content.artifact.size,
      language: content.artifact.language,
    },
    content: content.content?.slice(0, 200_000) ?? '',
    showArtifactActions,
  };
  if (component) {
    const Component = component;
    return (
      <PluginContributionBoundary plugin={plugin}>
        <Component
          plugin={plugin}
          artifact={context.artifact}
          content={content}
          className={className}
        />
      </PluginContributionBoundary>
    );
  }
  if (!viewer.viewer.entry) return null;
  return (
    <PluginFrame
      plugin={plugin}
      entry={viewer.viewer.entry}
      kind="artifact"
      title={viewer.viewer.title}
      context={context}
      className={cn('min-h-[240px]', className)}
      maxHeight={100_000}
      minHeight={240}
    />
  );
}
