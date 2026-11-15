/**
 * Icon whitelist for declarative plugin contributions. A manifest can only
 * select a name from `data/plugin-contract.json`; anything else falls back.
 */
import {
  Bot,
  Database,
  GitBranch,
  Globe,
  LayoutGrid,
  ListChecks,
  PanelRight,
  Plug,
  Puzzle,
  Sparkles,
  Terminal,
  Wand2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { pluginIconName, type PluginIconName } from './contract';

export const PLUGIN_ICONS: Record<PluginIconName, LucideIcon> = {
  Plug,
  Puzzle,
  Sparkles,
  GitBranch,
  Globe,
  Database,
  Terminal,
  PanelRight,
  LayoutGrid,
  Wand2,
  Bot,
  Zap,
  ListChecks,
};

export function pluginIcon(value: string | null | undefined): LucideIcon {
  return PLUGIN_ICONS[pluginIconName(value)];
}
