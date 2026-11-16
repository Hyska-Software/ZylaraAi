/**
 * Composer-console do modo Code (docs/goals/code-harness/WORKBENCH.md §6/§12).
 *
 * `@` menciona arquivos do workspace (`api.searchWorkspaceFiles`); `/` abre o
 * catálogo de comandos abaixo. Ações `invoke` só chamam contratos já
 * existentes — quando a fase do backend ainda não existe, o Composer degrada
 * com um toast honesto em vez de fingir que executou.
 *
 * The catalog stores **keys**, never rendered copy: `filterSlashCommands`
 * resolves them for the active language, so the menu and the inserted fill text
 * follow a runtime language change. `id`, `command` and `invoke` stay stable.
 */
import { t } from '@/lib/i18n';
import {
  commandDescription,
  commandLabel,
  commandSlashName,
  runPluginCommand,
} from '@/lib/plugins/host';
import { getPluginRegistryState } from '@/lib/plugins/registry';

/** Stable group ids (labels are resolved through `SLASH_GROUP_LABEL_KEYS`). */
export type SlashCommandGroup =
  | 'session'
  | 'plan'
  | 'goal'
  | 'creator'
  | 'git'
  | 'context'
  | 'project'
  | 'plugins';

/** Grupo labels (literal keys; never built from the id at runtime). */
export const SLASH_GROUP_LABEL_KEYS: Record<SlashCommandGroup, string> = {
  session: 'composer:slash.groups.session',
  plan: 'composer:slash.groups.plan',
  goal: 'composer:slash.groups.goal',
  creator: 'composer:slash.groups.creator',
  git: 'composer:slash.groups.git',
  context: 'composer:slash.groups.context',
  project: 'composer:slash.groups.project',
  plugins: 'composer:slash.groups.plugins',
};

/** Ações diretas suportadas nesta fase (sem backend novo). */
export type SlashInvoke =
  | 'compact'
  | 'commit'
  | 'permissoes'
  | 'novo'
  | 'limpar'
  | 'plan-on'
  | 'plan-off'
  | 'creator-on'
  | 'creator-off';

/**
 * Chip de intenção do `/goal`: o usuário escolhe o comando, o composer mostra
 * um chip removível e a mensagem digitada é enviada **como está** (sem prompt
 * automático). O `TurnPayload.goalRequest` diz ao harness para injetar a
 * instrução de criação no runtime context; o agente já conhece a tool `goal`.
 */
export function requestGoalCreation(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('zylara:goal-intent'));
}

export interface SlashCommand {
  id: string;
  /** Texto exibido no menu, incluindo a barra (ex.: `/compact`). */
  command: string;
  /** Translation keys for the visible copy. */
  titleKey: string;
  descriptionKey: string;
  group: SlashCommandGroup;
  /**
   * `fill` insere texto; `invoke` executa uma ação; `intent` ativa um chip de
   * intenção no composer (ex.: `/goal`) sem alterar a mensagem do usuário.
   */
  action: 'fill' | 'invoke' | 'intent';
  /** Translation key of the text inserted when `action === 'fill'`. */
  fillKey?: string;
  /** Ação executada quando `action === 'invoke'`. */
  invoke?: SlashInvoke;
  /** Plugin commands execute their own action (resolved at runtime). */
  run?: () => void | Promise<void>;
}

/** A catalog entry with its copy resolved for the active language. */
export interface SlashCommandView extends SlashCommand {
  title: string;
  description: string;
  fill: string | null;
  groupLabel: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'plan',
    command: '/plan',
    titleKey: 'composer:slash.commands.plan.title',
    descriptionKey: 'composer:slash.commands.plan.description',
    group: 'plan',
    action: 'fill',
    fillKey: 'composer:slash.commands.plan.fill',
    // `fill` + `invoke`: ativa o modo (o texto continua sendo a instrução).
    invoke: 'plan-on',
  },
  {
    id: 'plan-off',
    command: '/plan off',
    titleKey: 'composer:slash.commands.planOff.title',
    descriptionKey: 'composer:slash.commands.planOff.description',
    group: 'plan',
    action: 'invoke',
    invoke: 'plan-off',
  },
  {
    id: 'goal',
    command: '/goal',
    titleKey: 'composer:slash.commands.goal.title',
    descriptionKey: 'composer:slash.commands.goal.description',
    group: 'goal',
    action: 'intent',
  },
  {
    id: 'creator',
    command: '/creator',
    titleKey: 'composer:slash.commands.creator.title',
    descriptionKey: 'composer:slash.commands.creator.description',
    group: 'creator',
    action: 'invoke',
    invoke: 'creator-on',
  },
  {
    id: 'creator-off',
    command: '/creator off',
    titleKey: 'composer:slash.commands.creatorOff.title',
    descriptionKey: 'composer:slash.commands.creatorOff.description',
    group: 'creator',
    action: 'invoke',
    invoke: 'creator-off',
  },
  {
    id: 'permissoes',
    command: '/permissoes',
    titleKey: 'composer:slash.commands.permissions.title',
    descriptionKey: 'composer:slash.commands.permissions.description',
    group: 'session',
    action: 'invoke',
    invoke: 'permissoes',
  },
  {
    id: 'novo',
    command: '/novo',
    titleKey: 'composer:slash.commands.new.title',
    descriptionKey: 'composer:slash.commands.new.description',
    group: 'session',
    action: 'invoke',
    invoke: 'novo',
  },
  {
    id: 'limpar',
    command: '/limpar',
    titleKey: 'composer:slash.commands.clear.title',
    descriptionKey: 'composer:slash.commands.clear.description',
    group: 'session',
    action: 'invoke',
    invoke: 'limpar',
  },
  {
    id: 'compact',
    command: '/compact',
    titleKey: 'composer:slash.commands.compact.title',
    descriptionKey: 'composer:slash.commands.compact.description',
    group: 'context',
    action: 'invoke',
    invoke: 'compact',
  },
  {
    id: 'commit',
    command: '/commit',
    titleKey: 'composer:slash.commands.commit.title',
    descriptionKey: 'composer:slash.commands.commit.description',
    group: 'git',
    action: 'invoke',
    invoke: 'commit',
  },
  {
    id: 'test',
    command: '/test',
    titleKey: 'composer:slash.commands.test.title',
    descriptionKey: 'composer:slash.commands.test.description',
    group: 'project',
    action: 'fill',
    fillKey: 'composer:slash.commands.test.fill',
  },
  {
    id: 'review',
    command: '/review',
    titleKey: 'composer:slash.commands.review.title',
    descriptionKey: 'composer:slash.commands.review.description',
    group: 'project',
    action: 'fill',
    fillKey: 'composer:slash.commands.review.fill',
  },
  {
    id: 'init',
    command: '/init',
    titleKey: 'composer:slash.commands.init.title',
    descriptionKey: 'composer:slash.commands.init.description',
    group: 'project',
    action: 'fill',
    fillKey: 'composer:slash.commands.init.fill',
  },
];

/** Resolves the catalog copy for the active language. */
export function localizeSlashCommand(entry: SlashCommand): SlashCommandView {
  return {
    ...entry,
    title: t(entry.titleKey),
    description: t(entry.descriptionKey),
    fill: entry.fillKey ? t(entry.fillKey) : null,
    groupLabel: t(SLASH_GROUP_LABEL_KEYS[entry.group]),
  };
}

/** Normalized built-in slash names used to detect plugin conflicts. */
export function builtinSlashCommandNames(): string[] {
  return SLASH_COMMANDS.map((entry) => entry.command.toLowerCase());
}

/** Filtro tolerante (sem caixa) por comando, título ou descrição. */
export function filterSlashCommands(query: string): SlashCommandView[] {
  const localized = SLASH_COMMANDS.map(localizeSlashCommand);
  const builtins = new Set(localized.map((entry) => entry.command.toLowerCase()));
  const pluginCommands: SlashCommandView[] = getPluginRegistryState().commands
    .filter((resolved) => !builtins.has(commandSlashName(resolved).toLowerCase()))
    .map(
    (resolved) => {
      const title = commandLabel(resolved);
      const description = commandDescription(resolved);
      const command = commandSlashName(resolved);
      return {
        id: `plugin:${resolved.key}`,
        command,
        titleKey: '',
        descriptionKey: '',
        group: 'plugins',
        action: 'invoke',
        title,
        description,
        fill: null,
        groupLabel: t(SLASH_GROUP_LABEL_KEYS.plugins),
        run: () => runPluginCommand(resolved),
      };
    },
  );
  const all = [...localized, ...pluginCommands];
  const needle = query.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((entry) => {
    const haystack = `${entry.command} ${entry.title} ${entry.description}`.toLowerCase();
    return haystack.includes(needle);
  });
}
