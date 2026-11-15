/**
 * Bundled translation resources. English is the source-of-truth catalog; every
 * other locale must expose the same keys (enforced by `pnpm i18n:check` and
 * the catalog parity test).
 */
import enAgents from '@/locales/en/agents.json';
import enArtifacts from '@/locales/en/artifacts.json';
import enChat from '@/locales/en/chat.json';
import enCode from '@/locales/en/code.json';
import enCommon from '@/locales/en/common.json';
import enComposer from '@/locales/en/composer.json';
import enGenui from '@/locales/en/genui.json';
import enInstaller from '@/locales/en/installer.json';
import enLibrary from '@/locales/en/library.json';
import enModels from '@/locales/en/models.json';
import enPalette from '@/locales/en/palette.json';
import enPlugins from '@/locales/en/plugins.json';
import enSettings from '@/locales/en/settings.json';

import esAgents from '@/locales/es/agents.json';
import esArtifacts from '@/locales/es/artifacts.json';
import esChat from '@/locales/es/chat.json';
import esCode from '@/locales/es/code.json';
import esCommon from '@/locales/es/common.json';
import esComposer from '@/locales/es/composer.json';
import esGenui from '@/locales/es/genui.json';
import esInstaller from '@/locales/es/installer.json';
import esLibrary from '@/locales/es/library.json';
import esModels from '@/locales/es/models.json';
import esPalette from '@/locales/es/palette.json';
import esPlugins from '@/locales/es/plugins.json';
import esSettings from '@/locales/es/settings.json';

import ptAgents from '@/locales/pt-BR/agents.json';
import ptArtifacts from '@/locales/pt-BR/artifacts.json';
import ptChat from '@/locales/pt-BR/chat.json';
import ptCode from '@/locales/pt-BR/code.json';
import ptCommon from '@/locales/pt-BR/common.json';
import ptComposer from '@/locales/pt-BR/composer.json';
import ptGenui from '@/locales/pt-BR/genui.json';
import ptInstaller from '@/locales/pt-BR/installer.json';
import ptLibrary from '@/locales/pt-BR/library.json';
import ptModels from '@/locales/pt-BR/models.json';
import ptPalette from '@/locales/pt-BR/palette.json';
import ptPlugins from '@/locales/pt-BR/plugins.json';
import ptSettings from '@/locales/pt-BR/settings.json';

export const resources = {
  en: {
    common: enCommon,
    chat: enChat,
    composer: enComposer,
    models: enModels,
    settings: enSettings,
    code: enCode,
    agents: enAgents,
    artifacts: enArtifacts,
    library: enLibrary,
    palette: enPalette,
    plugins: enPlugins,
    genui: enGenui,
    installer: enInstaller,
  },
  'pt-BR': {
    common: ptCommon,
    chat: ptChat,
    composer: ptComposer,
    models: ptModels,
    settings: ptSettings,
    code: ptCode,
    agents: ptAgents,
    artifacts: ptArtifacts,
    library: ptLibrary,
    palette: ptPalette,
    plugins: ptPlugins,
    genui: ptGenui,
    installer: ptInstaller,
  },
  es: {
    common: esCommon,
    chat: esChat,
    composer: esComposer,
    models: esModels,
    settings: esSettings,
    code: esCode,
    agents: esAgents,
    artifacts: esArtifacts,
    library: esLibrary,
    palette: esPalette,
    plugins: esPlugins,
    genui: esGenui,
    installer: esInstaller,
  },
} as const;
