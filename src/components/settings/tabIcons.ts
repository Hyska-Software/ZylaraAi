/**
 * Icons for the settings tabs. Presentation-only mapping kept next to the
 * settings components so both `SettingsDialog` and the command palette use the
 * same icon per tab (ids/labels live in `lib/settingsTabs`).
 */
import {
  Bot,
  Database,
  FileCode2,
  FlaskConical,
  Info,
  KeyRound,
  Palette,
  Plug,
  ScrollText,
  Settings2,
  Sparkles,
  SquareTerminal,
  Wand2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { BuiltinSettingsTabId } from '@/lib/settingsTabs';

export type SettingsTabIconMap = Record<BuiltinSettingsTabId, LucideIcon>;

export const SETTINGS_TAB_ICONS: SettingsTabIconMap = {
  general: Settings2,
  themes: Palette,
  design: Wand2,
  terminal: SquareTerminal,
  editor: FileCode2,
  providers: KeyRound,
  model: Sparkles,
  instructions: ScrollText,
  tools: Wrench,
  plugins: Plug,
  agents: Bot,
  data: Database,
  experimental: FlaskConical,
  about: Info,
};
