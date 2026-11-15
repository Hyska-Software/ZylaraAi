/** Error isolation for one plugin contribution. */
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { t } from '@/lib/i18n';
import { reportPluginFailure } from '@/lib/plugins/frame';
import type { PluginRecord } from '@/lib/plugins/types';

interface PluginBoundaryProps {
  plugin: PluginRecord;
  fallback?: ReactNode;
  children: ReactNode;
}

interface PluginBoundaryState {
  failed: boolean;
}

export class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  state: PluginBoundaryState = { failed: false };

  static getDerivedStateFromError(): PluginBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[plugin ${this.props.plugin.name}] contribution crashed`,
      error,
      info.componentStack,
    );
    reportPluginFailure(
      this.props.plugin,
      `PLUGIN_CONTRIBUTION_CRASHED: ${error.message}`,
    );
  }

  render() {
    if (this.state.failed) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div role="alert" className="rounded-lg bg-danger-soft/40 px-3 py-2 text-[12px] text-danger">
          {t('plugins:errors.renderFailed', { name: this.props.plugin.name })}
        </div>
      );
    }
    return this.props.children;
  }
}
