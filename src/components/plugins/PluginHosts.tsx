/**
 * Host-rendered plugin surfaces: slots, views, side panels, settings tabs and
 * artifact viewers. Trusted components come from the registry; everything else
 * runs in the sandboxed `zplugin` iframe.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Puzzle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  pluginLabel,
  usePluginRegistry,
  type ResolvedArtifactViewer,
} from '@/lib/plugins/registry';
import { PluginFrame, reportPluginFailure } from '@/lib/plugins/frame';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
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

export function PluginSettingsTabPanel({ tabKey }: { tabKey: string }) {
  const { t } = useTranslation('plugins');
  const registry = usePluginRegistry();
  const enabled = usePluginUiPrefs((state) => state.enabled);
  if (!enabled) return null;
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
