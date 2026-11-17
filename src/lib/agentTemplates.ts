import { t } from './i18n';
import type { AgentAvatar, AgentCapabilities, PermissionMode } from './types';
import { DEFAULT_AGENT_CAPABILITIES } from './agentDefaults';
import type { PluginTemplateView } from './plugins/types';

/** A curated starting point for the Agentes layout. Templates are local,
 * versioned with the app and never grant capabilities beyond the factory
 * defaults: a template can only restrict them. */
export interface AgentTemplate {
  id: string;
  nameKey: string;
  roleKey: string;
  descriptionKey: string;
  avatar: AgentAvatar;
  departmentKey: string;
  instructionsKey: string;
  starterKeys: string[];
  capabilities?: Partial<AgentCapabilities>;
  memoryEnabled?: boolean;
  /** Default permission mode for agents created from this template. */
  permissionMode?: PermissionMode;
  /** Texts of a plugin-contributed template (already resolved). */
  literal?: PluginTemplateTexts;
}

/** Pre-resolved texts of a plugin template. */
export interface PluginTemplateTexts {
  name: string;
  role: string;
  description: string;
  department: string;
  instructions: string;
  starters: string[];
  pluginName: string;
  pluginId: string;
  /** Template id inside the plugin package (the gallery key is `pluginId:id`). */
  templateId: string;
}

export interface LocalizedAgentTemplate {
  id: string;
  name: string;
  role: string;
  description: string;
  avatar: AgentAvatar;
  department: string;
  instructions: string;
  starters: string[];
  capabilities?: Partial<AgentCapabilities>;
  memoryEnabled?: boolean;
  permissionMode?: PermissionMode;
  /** Origin of a plugin-contributed template. */
  plugin?: { id: string; name: string } | null;
  /** Backend reference sent when creating the agent (`agent.template` audit). */
  template?: { pluginId: string; templateId: string } | null;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'assistant',
    nameKey: 'templates.assistant.name',
    roleKey: 'templates.assistant.role',
    descriptionKey: 'templates.assistant.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'mascot', expression: 'neutral', color: 'blue', face: 'white' },
    departmentKey: 'departments.general',
    instructionsKey: 'templates.assistant.instructions',
    starterKeys: ['templates.assistant.starter.0', 'templates.assistant.starter.1'],
  },
  {
    id: 'researcher',
    nameKey: 'templates.researcher.name',
    roleKey: 'templates.researcher.role',
    descriptionKey: 'templates.researcher.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'circle', expression: 'happy', color: 'teal', face: 'white' },
    departmentKey: 'departments.research',
    instructionsKey: 'templates.researcher.instructions',
    starterKeys: ['templates.researcher.starter.0', 'templates.researcher.starter.1'],
  },
  {
    id: 'engineer',
    nameKey: 'templates.engineer.name',
    roleKey: 'templates.engineer.role',
    descriptionKey: 'templates.engineer.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'rounded', expression: 'smug', color: 'purple', face: 'white' },
    departmentKey: 'departments.engineering',
    instructionsKey: 'templates.engineer.instructions',
    starterKeys: ['templates.engineer.starter.0', 'templates.engineer.starter.1'],
  },
  {
    id: 'reviewer',
    nameKey: 'templates.reviewer.name',
    roleKey: 'templates.reviewer.role',
    descriptionKey: 'templates.reviewer.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'diamond', expression: 'neutral', color: 'orange', face: 'white' },
    departmentKey: 'departments.quality',
    instructionsKey: 'templates.reviewer.instructions',
    starterKeys: ['templates.reviewer.starter.0', 'templates.reviewer.starter.1'],
  },
  {
    id: 'writer',
    nameKey: 'templates.writer.name',
    roleKey: 'templates.writer.role',
    descriptionKey: 'templates.writer.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'drop', expression: 'happy', color: 'pink', face: 'white' },
    departmentKey: 'departments.content',
    instructionsKey: 'templates.writer.instructions',
    starterKeys: ['templates.writer.starter.0', 'templates.writer.starter.1'],
  },
  {
    id: 'ops',
    nameKey: 'templates.ops.name',
    roleKey: 'templates.ops.role',
    descriptionKey: 'templates.ops.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'hex', expression: 'neutral', color: 'green', face: 'white' },
    departmentKey: 'departments.operations',
    instructionsKey: 'templates.ops.instructions',
    starterKeys: ['templates.ops.starter.0', 'templates.ops.starter.1'],
  },
  {
    id: 'analyst',
    nameKey: 'templates.analyst.name',
    roleKey: 'templates.analyst.role',
    descriptionKey: 'templates.analyst.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'blob', expression: 'sleepy', color: 'yellow', face: 'black' },
    departmentKey: 'departments.data',
    instructionsKey: 'templates.analyst.instructions',
    starterKeys: ['templates.analyst.starter.0', 'templates.analyst.starter.1'],
  },
  {
    id: 'support',
    nameKey: 'templates.support.name',
    roleKey: 'templates.support.role',
    descriptionKey: 'templates.support.description',
    avatar: { kind: 'mascot', shape: 'mascot', body: 'bubble', expression: 'grin', color: 'coral', face: 'white' },
    departmentKey: 'departments.support',
    instructionsKey: 'templates.support.instructions',
    starterKeys: ['templates.support.starter.0', 'templates.support.starter.1'],
  },
];

export function templateCapabilities(template: AgentTemplate): AgentCapabilities {
  return { ...DEFAULT_AGENT_CAPABILITIES, ...template.capabilities };
}

/** Plugin templates as gallery entries. Capabilities can only narrow the
 * defaults, exactly like the bundled templates. */
export function pluginAgentTemplates(
  templates: readonly PluginTemplateView[],
): AgentTemplate[] {
  return templates.map((template) => ({
    id: template.key,
    nameKey: '',
    roleKey: '',
    descriptionKey: '',
    avatar: {
      kind: 'mascot',
      shape: 'mascot',
      body: 'mascot',
      expression: 'neutral',
      color: 'purple',
      face: 'white',
    },
    departmentKey: '',
    instructionsKey: '',
    starterKeys: [],
    capabilities: template.capabilities as Partial<AgentCapabilities>,
    memoryEnabled: false,
    permissionMode: (template.permissionMode ?? undefined) as PermissionMode | undefined,
    literal: {
      name: template.name,
      role: template.role || template.pluginName,
      description: template.description,
      department: template.pluginName,
      instructions: template.instructions,
      starters: template.starters,
      pluginName: template.pluginName,
      pluginId: template.pluginId,
      templateId: template.id,
    },
  }));
}

/**
 * Resolves a template in the active language. The switch keeps keys literal so
 * the catalog parity gate can see every string the templates use.
 */
export function localizedAgentTemplate(template: AgentTemplate): LocalizedAgentTemplate {
  const base = {
    id: template.id,
    avatar: template.avatar,
    capabilities: template.capabilities,
    memoryEnabled: template.memoryEnabled,
    permissionMode: template.permissionMode,
    plugin: template.literal
      ? { id: template.literal.pluginId, name: template.literal.pluginName }
      : null,
    template: template.literal
      ? {
          pluginId: template.literal.pluginId,
          templateId: template.literal.templateId,
        }
      : null,
  };
  if (template.literal) {
    return {
      ...base,
      name: template.literal.name,
      role: template.literal.role,
      description: template.literal.description,
      department: template.literal.department,
      instructions: template.literal.instructions,
      starters: template.literal.starters,
    };
  }
  switch (template.id) {
    case 'assistant':
      return {
        ...base,
        name: t('agents:templates.assistant.name'),
        role: t('agents:templates.assistant.role'),
        description: t('agents:templates.assistant.description'),
        department: t('agents:departments.general'),
        instructions: t('agents:templates.assistant.instructions'),
        starters: [
          t('agents:templates.assistant.starter.0'),
          t('agents:templates.assistant.starter.1'),
        ],
      };
    case 'researcher':
      return {
        ...base,
        name: t('agents:templates.researcher.name'),
        role: t('agents:templates.researcher.role'),
        description: t('agents:templates.researcher.description'),
        department: t('agents:departments.research'),
        instructions: t('agents:templates.researcher.instructions'),
        starters: [
          t('agents:templates.researcher.starter.0'),
          t('agents:templates.researcher.starter.1'),
        ],
      };
    case 'engineer':
      return {
        ...base,
        name: t('agents:templates.engineer.name'),
        role: t('agents:templates.engineer.role'),
        description: t('agents:templates.engineer.description'),
        department: t('agents:departments.engineering'),
        instructions: t('agents:templates.engineer.instructions'),
        starters: [
          t('agents:templates.engineer.starter.0'),
          t('agents:templates.engineer.starter.1'),
        ],
      };
    case 'reviewer':
      return {
        ...base,
        name: t('agents:templates.reviewer.name'),
        role: t('agents:templates.reviewer.role'),
        description: t('agents:templates.reviewer.description'),
        department: t('agents:departments.quality'),
        instructions: t('agents:templates.reviewer.instructions'),
        starters: [
          t('agents:templates.reviewer.starter.0'),
          t('agents:templates.reviewer.starter.1'),
        ],
      };
    case 'writer':
      return {
        ...base,
        name: t('agents:templates.writer.name'),
        role: t('agents:templates.writer.role'),
        description: t('agents:templates.writer.description'),
        department: t('agents:departments.content'),
        instructions: t('agents:templates.writer.instructions'),
        starters: [
          t('agents:templates.writer.starter.0'),
          t('agents:templates.writer.starter.1'),
        ],
      };
    case 'ops':
      return {
        ...base,
        name: t('agents:templates.ops.name'),
        role: t('agents:templates.ops.role'),
        description: t('agents:templates.ops.description'),
        department: t('agents:departments.operations'),
        instructions: t('agents:templates.ops.instructions'),
        starters: [t('agents:templates.ops.starter.0'), t('agents:templates.ops.starter.1')],
      };
    case 'analyst':
      return {
        ...base,
        name: t('agents:templates.analyst.name'),
        role: t('agents:templates.analyst.role'),
        description: t('agents:templates.analyst.description'),
        department: t('agents:departments.data'),
        instructions: t('agents:templates.analyst.instructions'),
        starters: [
          t('agents:templates.analyst.starter.0'),
          t('agents:templates.analyst.starter.1'),
        ],
      };
    case 'support':
    default:
      return {
        ...base,
        name: t('agents:templates.support.name'),
        role: t('agents:templates.support.role'),
        description: t('agents:templates.support.description'),
        department: t('agents:departments.support'),
        instructions: t('agents:templates.support.instructions'),
        starters: [
          t('agents:templates.support.starter.0'),
          t('agents:templates.support.starter.1'),
        ],
      };
  }
}
