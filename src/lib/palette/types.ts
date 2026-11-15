/**
 * Command palette contracts (DESIGN §10, docs/COMMAND_PALETTE.md).
 *
 * This module is the single source of truth for the palette section order and
 * for the shape of the items rendered/navigated by `CommandPalette`. The
 * command catalog itself lives in `components/palette/usePaletteActions.ts`;
 * keeping the group order here is what stops a new group from silently
 * disappearing (the v1 bug: a hardcoded `GROUP_ORDER` filtered unknown groups).
 */
import type { LucideIcon } from 'lucide-react';
import { t } from '../i18n';
import type { Conversation } from '../types';

/** Sections of the palette, in canonical display order. */
export type PaletteGroupId =
  | 'conversas'
  | 'navegacao'
  | 'ferramentas'
  | 'plugins'
  | 'aparencia'
  | 'configuracoes'
  | 'sistema';

export interface PaletteGroupDefinition {
  id: PaletteGroupId;
  /** Translation key of the section label (resolved at render time). */
  labelKey: string;
}

export const PALETTE_GROUPS: readonly PaletteGroupDefinition[] = [
  { id: 'conversas', labelKey: 'palette:groups.conversas' },
  { id: 'navegacao', labelKey: 'palette:groups.navegacao' },
  { id: 'ferramentas', labelKey: 'palette:groups.ferramentas' },
  { id: 'plugins', labelKey: 'palette:groups.plugins' },
  { id: 'aparencia', labelKey: 'palette:groups.aparencia' },
  { id: 'configuracoes', labelKey: 'palette:groups.configuracoes' },
  { id: 'sistema', labelKey: 'palette:groups.sistema' },
];

/** Canonical group order (used for tie-breaking and for the empty-query list). */
export const PALETTE_GROUP_ORDER: readonly PaletteGroupId[] = PALETTE_GROUPS.map(
  (group) => group.id,
);

export function paletteGroupLabel(id: PaletteGroupId): string {
  switch (id) {
    case 'conversas':
      return t('palette:groups.conversas');
    case 'navegacao':
      return t('palette:groups.navegacao');
    case 'ferramentas':
      return t('palette:groups.ferramentas');
    case 'plugins':
      return t('palette:groups.plugins');
    case 'aparencia':
      return t('palette:groups.aparencia');
    case 'configuracoes':
      return t('palette:groups.configuracoes');
    case 'sistema':
      return t('palette:groups.sistema');
    default:
      return id;
  }
}

/** Query scope selected by a leading prefix: `>` commands, `#` conversations. */
export type PaletteScope = 'all' | 'commands' | 'conversations';

/**
 * One executable command. Availability is resolved before the action reaches
 * the palette: context-specific commands simply are not part of the list.
 */
export interface PaletteAction {
  id: string;
  group: PaletteGroupId;
  label: string;
  description?: string;
  icon: LucideIcon;
  /** Extra searchable words that are not displayed (synonyms, English terms). */
  keywords?: string;
  /** Hint shown on the right of the row, e.g. `${modKey}+N`. */
  shortcut?: string;
  /** Renders a check mark (current theme, enabled tool toggle, …). */
  checked?: boolean;
  /** Marked for screen readers when the label alone is not explanatory. */
  ariaDescription?: string;
  run: () => void | Promise<void>;
}

/** Character ranges (in the original text) matched by the query. */
export type TextRanges = ReadonlyArray<readonly [number, number]>;

export interface PaletteCommandResult {
  kind: 'command';
  /** Unique DOM id suffix: `command-${action.id}`. */
  key: string;
  action: PaletteAction;
  labelRanges: TextRanges;
  descriptionRanges: TextRanges;
  score: number;
}

export interface PaletteConversationResult {
  kind: 'conversation';
  key: string;
  conversation: Conversation;
  titleRanges: TextRanges;
  previewRanges: TextRanges;
}

export type PaletteItem = PaletteCommandResult | PaletteConversationResult;

/** A displayed section: a label and the flattened items inside it. */
export interface PaletteSection {
  id: string;
  label: string;
  items: PaletteItem[];
  /** Conversation search in flight: render placeholder rows under the header. */
  loading?: boolean;
  /** Backend search failed and only the local title/preview matches are shown. */
  fallback?: boolean;
}
