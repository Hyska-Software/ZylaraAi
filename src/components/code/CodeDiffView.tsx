/**
 * Diff de um arquivo como **aba central** do layout Code (WORKBENCH §7.2).
 *
 * O alvo vem do `uiStore` (`codeDiffTab`): workspace + path + staged e, quando o
 * journal da sessão já conhece o diff, o texto (sem chamada de API). A aba pode
 * ser fechada pelo X do tab strip ou trocando de sessão; o comportamento padrão
 * é configurável em Configurações → Ferramentas (`diffOpenMode`).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, RefreshCw } from 'lucide-react';

import { IconButton, Spinner, Tooltip } from '@/components/ui';
import { Slot } from '@/components/plugins/ui/Slot';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { CodeDiffTab } from '@/lib/store';
import { DiffView } from './DiffView';

export interface CodeDiffViewProps {
  target: CodeDiffTab;
  className?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return t('code:codeDiff.error');
}

export function CodeDiffView({ target, className }: CodeDiffViewProps) {
  const { t: translate } = useTranslation('code');
  const [diff, setDiff] = useState(target.knownDiff ?? '');
  const [loading, setLoading] = useState(target.knownDiff == null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (target.knownDiff != null) {
      setDiff(target.knownDiff);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const text = target.base
        ? await api.getFileDiffAt(target.workspaceId, target.path, target.base)
        : await api.getFileDiff(target.workspaceId, target.path, target.staged);
      setDiff(text ?? '');
    } catch (loadError) {
      setError(describeError(loadError));
    } finally {
      setLoading(false);
    }
  }, [target.base, target.knownDiff, target.path, target.staged, target.workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={className}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground-muted">
          {target.staged ? translate('code:codeDiff.staged') : translate('code:codeDiff.label')}
          {target.base ? ` · ${target.base.slice(0, 7)}` : ''}
        </span>
        {loading ? <Spinner size="xs" label={translate('code:codeDiff.loading')} /> : null}
        <Tooltip content={translate('code:codeDiff.reload')} side="bottom">
          <IconButton label={translate('code:codeDiff.reload')} size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Slot name="code.diff.toolbar" owner={{ layout: 'code' }} />
      </div>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border bg-danger-soft px-3 py-2 text-[11.5px] text-danger"
        >
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{error}</span>
        </div>
      ) : null}
      <DiffView
        path={target.path}
        diff={diff}
        loading={loading}
        error={error}
        className="min-h-0 flex-1"
      />
    </div>
  );
}

export default CodeDiffView;
