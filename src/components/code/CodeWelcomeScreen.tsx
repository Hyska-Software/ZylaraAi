import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bug,
  CodeXml,
  FlaskConical,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui';
import { Slot } from '@/components/plugins/ui/Slot';
import { useReduceMotion } from '@/components/layout/hooks';
import { useUiStore } from '@/lib/store';
import type { Workspace } from '@/lib/types';
import { useWorkspaces } from './useWorkspaces';

const EASE_OUT_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const SUGGESTIONS = [
  {
    icon: CodeXml,
    titleKey: 'code:welcome.suggestion.explain.title',
    descriptionKey: 'code:welcome.suggestion.explain.description',
    promptKey: 'code:welcome.suggestion.explain.prompt',
  },
  {
    icon: Bug,
    titleKey: 'code:welcome.suggestion.bug.title',
    descriptionKey: 'code:welcome.suggestion.bug.description',
    promptKey: 'code:welcome.suggestion.bug.prompt',
  },
  {
    icon: FlaskConical,
    titleKey: 'code:welcome.suggestion.tests.title',
    descriptionKey: 'code:welcome.suggestion.tests.description',
    promptKey: 'code:welcome.suggestion.tests.prompt',
  },
] as const;

/** Fills the composer through the same event the Chat welcome screen uses. */
function fillComposer(text: string): void {
  window.dispatchEvent(new CustomEvent<string>('zylara:suggest', { detail: text }));
}

function folderIcon(workspace: Workspace): LucideIcon {
  return workspace.git ? FolderGit2 : Folder;
}

interface WorkspaceRecentsProps {
  workspaces: Workspace[];
  disabled: boolean;
  onSelect: (workspace: Workspace) => void;
}

/** "Workspaces recentes" — reabre uma pasta já registrada sem criar sessão. */
function WorkspaceRecents({ workspaces, disabled, onSelect }: WorkspaceRecentsProps) {
  const { t } = useTranslation('code');
  return (
    <section aria-labelledby="code-recent-workspaces" className="mt-8 w-full">
      <h2
        id="code-recent-workspaces"
        className="text-left text-[11px] font-medium uppercase tracking-wide text-foreground-subtle"
      >
        {t('code:welcome.recents')}
      </h2>
      <div role="list" className="mt-2 flex flex-col gap-1.5">
        {workspaces.map((workspace) => {
          const Icon = folderIcon(workspace);
          return (
            <div key={workspace.id} role="listitem">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(workspace)}
                className={
                  'flex w-full min-w-0 items-center gap-2.5 rounded-xl bg-surface px-3 py-2 text-left ' +
                  'transition-colors duration-150 hover:bg-surface-hover ' +
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ' +
                  'disabled:cursor-not-allowed disabled:opacity-60'
                }
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-foreground-muted">
                  <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {workspace.name}
                  </span>
                  <span
                    className="mt-0.5 block truncate font-mono text-[11px] leading-relaxed text-foreground-subtle"
                    title={workspace.path}
                  >
                    {workspace.path}
                  </span>
                </span>
                {workspace.git ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-foreground-subtle">
                    <GitBranch aria-hidden className="size-3" strokeWidth={1.75} />
                    <span className="max-w-24 truncate">{workspace.git.branch}</span>
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Empty center of the Code layout (docs/goals/code-harness/WORKBENCH.md §8.1).
 *
 * Sem workspace o Code não é um chat solto: é a tela de abertura de pasta, com
 * a lista de workspaces recentes (dados reais do backend). Com workspace ativo,
 * mostra o caminho/branch e as sugestões de tarefa que preenchem o composer
 * (sem enviar nada).
 */
export function CodeWelcomeScreen() {
  const { t } = useTranslation('code');
  const reduceMotion = useReduceMotion();
  const activeWorkspaceId = useUiStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useUiStore((state) => state.setActiveWorkspace);
  const { workspaces, loading, loaded, error, openFolder } = useWorkspaces();
  const [opening, setOpening] = useState(false);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const recents = activeWorkspace
    ? workspaces.filter((workspace) => workspace.id !== activeWorkspace.id)
    : workspaces;

  useEffect(() => {
    if (!activeWorkspace) return;
    /* The composer stays mounted when switching Chat ↔ Code; focusing it keeps
       the Code welcome keyboard-first like the Chat one. */
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('zylara:focus-composer'));
    });
    return () => cancelAnimationFrame(frame);
  }, [activeWorkspace]);

  const handleOpenFolder = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openFolder();
    } finally {
      setOpening(false);
    }
  };

  const loadingList = loading && !loaded;
  const ActiveIcon = activeWorkspace ? folderIcon(activeWorkspace) : FolderOpen;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 pb-8 pt-10 text-center sm:pt-14">
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE_OUT_SOFT }}
        className="flex size-14 items-center justify-center rounded-2xl bg-surface-raised text-accent shadow-sm"
      >
        <ActiveIcon aria-hidden className="size-7" strokeWidth={1.75} />
      </motion.div>

      {activeWorkspace ? (
        <>
          <h1 className="mt-5 text-[28px] font-semibold tracking-tight text-foreground">
            {t('code:welcome.active.title')}
          </h1>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-foreground-muted">
            {t('code:welcome.active.description')}
          </p>

          <div className="mt-4 flex max-w-full items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-[12px] text-foreground-muted">
            <ActiveIcon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="truncate font-medium text-foreground">{activeWorkspace.name}</span>
            {activeWorkspace.git ? (
              <>
                <span aria-hidden className="text-foreground-subtle">
                  ·
                </span>
                <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="max-w-40 truncate">{activeWorkspace.git.branch}</span>
                {activeWorkspace.git.dirty ? (
                  <>
                    <span
                      aria-hidden
                      title={t('code:welcome.dirty')}
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                    />
                    <span className="sr-only">{t('code:welcome.dirty')}</span>
                  </>
                ) : null}
              </>
            ) : null}
            <span aria-hidden className="text-foreground-subtle">
              ·
            </span>
            <span className="max-w-56 truncate font-mono text-[11px]" title={activeWorkspace.path}>
              {activeWorkspace.path}
            </span>
          </div>

          <div className="mt-8 grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
            {SUGGESTIONS.map((suggestion, index) => {
              const Icon = suggestion.icon;
              return (
                <motion.button
                  key={suggestion.titleKey}
                  type="button"
                  onClick={() => fillComposer(t(suggestion.promptKey))}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.24,
                    delay: reduceMotion ? 0 : 0.04 * index,
                    ease: EASE_OUT_SOFT,
                  }}
                  className={
                    'group flex h-full flex-col items-start gap-2 rounded-2xl bg-surface px-3.5 py-3.5 text-left ' +
                    'transition-colors duration-150 hover:bg-surface-hover ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
                  }
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-foreground-muted transition-colors duration-150 group-hover:text-accent">
                    <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-foreground">
                      {t(suggestion.titleKey)}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-foreground-muted">
                      {t(suggestion.descriptionKey)}
                    </span>
                  </span>
                </motion.button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <h1 className="mt-5 text-[28px] font-semibold tracking-tight text-foreground">
            {t('code:welcome.noFolder.title')}
          </h1>
          <p className="mt-2 max-w-md text-[14px] leading-relaxed text-foreground-muted">
            {t('code:welcome.noFolder.description')}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {loadingList ? (
              <Button variant="secondary" size="md" loading>
                {t('code:welcome.loadingWorkspaces')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                loading={opening}
                leftIcon={<FolderOpen className="size-4" />}
                onClick={() => void handleOpenFolder()}
              >
                {t('code:welcome.openFolder')}
              </Button>
            )}
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-4 flex max-w-md items-start gap-1.5 rounded-lg bg-danger-soft px-3 py-2 text-left text-[12px] leading-relaxed text-danger"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              <span>{t('code:welcome.loadError', { error })}</span>
            </p>
          ) : null}

          {recents.length > 0 ? (
            <WorkspaceRecents
              workspaces={recents.slice(0, 4)}
              disabled={opening}
              onSelect={(workspace) => setActiveWorkspace(workspace.id)}
            />
          ) : null}

          {!loadingList && recents.length === 0 ? (
            <p className="mt-6 max-w-md text-[12px] leading-relaxed text-foreground-subtle">
              {t('code:welcome.empty')}
            </p>
          ) : null}
        </>
      )}
      <Slot
        name="code.welcome.actions"
        owner={{ workspaceId: activeWorkspace?.id ?? null }}
      />
    </div>
  );
}

export default CodeWelcomeScreen;
