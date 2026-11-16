import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useUiStore } from '@/lib/store';
import { isSettingsTabId, SETTINGS_TABS } from '@/lib/settingsTabs';
import { pluginIcon } from '@/lib/plugins/icons';
import { pluginLabel, usePluginRegistry } from '@/lib/plugins/registry';
import { usePluginUiPrefs } from '@/lib/plugins/ui/prefs';
import { PluginSettingsTabPanel } from '@/components/plugins/PluginHosts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { AboutTab } from './AboutTab';
import { AgentsTab } from './AgentsTab';
import { DataTab } from './DataTab';
import { GeneralTab } from './GeneralTab';
import { InstructionsTab } from './InstructionsTab';
import { ModelTab } from './ModelTab';
import { PluginsTab } from './PluginsTab';
import { ProvidersTab } from './ProvidersTab';
import { SETTINGS_TAB_ICONS } from './tabIcons';
import { TerminalTab } from './TerminalTab';
import { ThemesTab } from './ThemesTab';
import { DesignTab } from './DesignTab';
import { ToolsTab } from './ToolsTab';

/**
 * Settings dialog (DESIGN §9): 860×600, vertical tabs on the left and a
 * scrollable content column on the right. Every change is saved automatically.
 *
 * The active tab lives in `useUiStore` so the command palette can open the
 * dialog straight on "Configurações › Ferramentas" (docs/COMMAND_PALETTE.md).
 */
export function SettingsDialog() {
  const { t } = useTranslation('settings');
  const { t: common } = useTranslation('common');
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const tab = useUiStore((state) => state.settingsTab);
  const setTab = useUiStore((state) => state.setSettingsTab);
  const registry = usePluginRegistry();
  const pluginUiEnabled = usePluginUiPrefs((state) => state.enabled);
  const pluginTabs = pluginUiEnabled ? registry.settingsTabs : [];
  const active = SETTINGS_TABS.find((entry) => entry.id === tab);
  const activePluginTab = pluginTabs.find(
    (entry) => `plugin:${entry.key}` === tab,
  );
  const headerLabel = active
    ? t(active.labelKey)
    : activePluginTab
      ? pluginLabel(activePluginTab.plugin, activePluginTab.tab.titleKey, activePluginTab.tab.title)
      : t('tabs.general');

  useEffect(() => {
    if (!open || active || activePluginTab) return;
    setTab('general');
  }, [open, active, activePluginTab, setTab]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showClose={false}
        className="h-[600px] w-[860px] max-w-[calc(100vw-2rem)] gap-0 p-0"
        aria-describedby={undefined}
      >
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isSettingsTabId(value)) setTab(value);
          }}
          orientation="vertical"
          className="flex min-h-0 flex-1"
        >
          <div className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
            <div className="px-4 pb-3 pt-5">
              <DialogTitle className="text-[15px]">{t('dialog.title')}</DialogTitle>
              <DialogDescription className="mt-0.5 text-[11px]">
                {t('dialog.description')}
              </DialogDescription>
            </div>
            <TabsList variant="sidebar" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {SETTINGS_TABS.map(({ id, labelKey }) => {
                const Icon = SETTINGS_TAB_ICONS[id];
                return (
                  <TabsTrigger key={id} value={id} variant="sidebar">
                    <Icon aria-hidden className="size-4" />
                    {t(labelKey)}
                  </TabsTrigger>
                );
              })}
              {pluginTabs.map((entry) => {
                const Icon = pluginIcon(entry.tab.icon);
                return (
                  <TabsTrigger
                    key={`plugin:${entry.key}`}
                    value={`plugin:${entry.key}`}
                    variant="sidebar"
                  >
                    <Icon aria-hidden className="size-4" />
                    {pluginLabel(entry.plugin, entry.tab.titleKey, entry.tab.title)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <div className="border-t border-border p-2">
              <Button variant="ghost" size="sm" className="w-full justify-center" onClick={() => setOpen(false)}>
                {common('actions.close')}
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
              <span className="text-[13px] font-semibold tracking-tight text-foreground">
                {headerLabel}
              </span>
              <span className="text-[11px] text-foreground-subtle">{t('dialog.autoSave')}</span>
            </div>
            <div className="min-h-0 flex-1">
              <ScrollArea className="h-full" type="auto">
                <div className="px-6 py-5">
                  <TabsContent value="general">
                    <GeneralTab />
                  </TabsContent>
                  <TabsContent value="themes">
                    <ThemesTab />
                  </TabsContent>
                  <TabsContent value="design">
                    <DesignTab />
                  </TabsContent>
                  <TabsContent value="terminal">
                    <TerminalTab />
                  </TabsContent>
                  <TabsContent value="providers">
                    <ProvidersTab />
                  </TabsContent>
                  <TabsContent value="model">
                    <ModelTab />
                  </TabsContent>
                  <TabsContent value="instructions">
                    <InstructionsTab />
                  </TabsContent>
                  <TabsContent value="tools">
                    <ToolsTab />
                  </TabsContent>
                  <TabsContent value="plugins">
                    <PluginsTab />
                  </TabsContent>
                  <TabsContent value="agents">
                    <AgentsTab />
                  </TabsContent>
                  <TabsContent value="data">
                    <DataTab />
                  </TabsContent>
                  <TabsContent value="about">
                    <AboutTab />
                  </TabsContent>
                  {pluginTabs.map((entry) => (
                    <TabsContent key={`plugin:${entry.key}`} value={`plugin:${entry.key}`}>
                      <PluginSettingsTabPanel tabKey={entry.key} />
                    </TabsContent>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export default SettingsDialog;
