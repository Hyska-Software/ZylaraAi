import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Play } from 'lucide-react';
import { toast } from 'sonner';

import { Button, Input, Spinner, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { DEFAULT_COMPUTER_DOCKER_IMAGE, isDockerDaemonError } from '@/lib/computerDocker';
import { useAppStore } from '@/lib/store';
import { SettingRow, SettingsBlock, SettingsSection } from './shared';

/**
 * Global settings of the Agentes layout: concurrency/queue, budget,
 * notifications, browser/desktop policy and the private Docker desktop.
 * Per-persona settings (model, instructions, workspace, capabilities) stay in
 * the agent editor.
 */
export function AgentsTab() {
  const { t } = useTranslation('settings');
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const [maxConcurrentTurns, setMaxConcurrentTurns] = useState(
    settings.maxConcurrentTurns ?? 10,
  );
  const [maxConcurrentPerAgent, setMaxConcurrentPerAgent] = useState(
    settings.maxConcurrentTurnsPerAgent ?? 1,
  );
  const [maxQueueLength, setMaxQueueLength] = useState(
    settings.maxQueueLengthPerThread ?? 20,
  );
  const [costLimit, setCostLimit] = useState(
    settings.agentDailyCostLimitUsd != null ? String(settings.agentDailyCostLimitUsd) : '',
  );
  const [computerDockerImage, setComputerDockerImage] = useState(
    settings.computerDockerImage ?? DEFAULT_COMPUTER_DOCKER_IMAGE,
  );
  const [computerImageBusy, setComputerImageBusy] = useState(false);
  const [computerDaemonBusy, setComputerDaemonBusy] = useState(false);
  // Set when a download failed because the engine is not running: the fix is
  // starting Docker, not retrying the pull.
  const [computerDaemonDown, setComputerDaemonDown] = useState(false);
  const [dockerBusy, setDockerBusy] = useState(false);

  useEffect(
    () => setMaxConcurrentTurns(settings.maxConcurrentTurns ?? 10),
    [settings.maxConcurrentTurns],
  );
  useEffect(
    () => setMaxConcurrentPerAgent(settings.maxConcurrentTurnsPerAgent ?? 1),
    [settings.maxConcurrentTurnsPerAgent],
  );
  useEffect(
    () => setMaxQueueLength(settings.maxQueueLengthPerThread ?? 20),
    [settings.maxQueueLengthPerThread],
  );
  useEffect(
    () =>
      setCostLimit(
        settings.agentDailyCostLimitUsd != null
          ? String(settings.agentDailyCostLimitUsd)
          : '',
      ),
    [settings.agentDailyCostLimitUsd],
  );
  useEffect(
    () =>
      setComputerDockerImage(
        settings.computerDockerImage ?? DEFAULT_COMPUTER_DOCKER_IMAGE,
      ),
    [settings.computerDockerImage],
  );

  /** Downloads the graphical image, reporting whether the engine is the blocker. */
  const pullComputerImage = async (image: string) => {
    setComputerImageBusy(true);
    setComputerDaemonDown(false);
    try {
      await api.dockerPullImage(image);
      toast.success(t('agents.computer.downloaded'), { description: image });
    } catch (error) {
      const message = String(error);
      const daemonDown = isDockerDaemonError(message);
      setComputerDaemonDown(daemonDown);
      toast.error(
        daemonDown ? t('agents.computer.daemonDown') : t('agents.computer.downloadFailed'),
        { description: message },
      );
    } finally {
      setComputerImageBusy(false);
    }
  };

  /** Starts Docker Desktop (the backend waits for the engine) and retries the pull. */
  const startComputerDaemon = async () => {
    setComputerDaemonBusy(true);
    try {
      await api.dockerStartDaemon();
      setComputerDaemonDown(false);
      const image = computerDockerImage.trim();
      if (image) await pullComputerImage(image);
    } catch (error) {
      toast.error(t('agents.computer.startDockerError'), {
        description: String(error),
      });
    } finally {
      setComputerDaemonBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-xl bg-surface px-3 py-2 text-[11px] leading-relaxed text-foreground-muted">
        {t('agents.intro')}
      </p>

      <SettingsSection title={t('agents.queue.title')} description={t('agents.queue.description')}>
        <SettingRow
          vertical
          label={t('agents.queue.global.label')}
          description={t('agents.queue.global.description', { count: maxConcurrentTurns })}
        >
          <Input
            type="number"
            min={1}
            max={32}
            value={maxConcurrentTurns}
            aria-label={t('agents.queue.global.aria')}
            onChange={(event) => setMaxConcurrentTurns(Number(event.target.value) || 1)}
            onBlur={() =>
              void saveSettings({
                maxConcurrentTurns: Math.max(1, Math.min(32, maxConcurrentTurns)),
              })
            }
          />
        </SettingRow>
        <SettingRow
          vertical
          label={t('agents.queue.perAgent.label')}
          description={t('agents.queue.perAgent.description')}
        >
          <Input
            type="number"
            min={1}
            max={4}
            value={maxConcurrentPerAgent}
            aria-label={t('agents.queue.perAgent.aria')}
            onChange={(event) => setMaxConcurrentPerAgent(Number(event.target.value) || 1)}
            onBlur={() =>
              void saveSettings({
                maxConcurrentTurnsPerAgent: Math.max(1, Math.min(4, maxConcurrentPerAgent)),
              })
            }
          />
        </SettingRow>
        <SettingRow
          vertical
          label={t('agents.queue.queueLength.label')}
          description={t('agents.queue.queueLength.description')}
        >
          <Input
            type="number"
            min={1}
            max={100}
            value={maxQueueLength}
            aria-label={t('agents.queue.queueLength.aria')}
            onChange={(event) => setMaxQueueLength(Number(event.target.value) || 1)}
            onBlur={() =>
              void saveSettings({
                maxQueueLengthPerThread: Math.max(1, Math.min(100, maxQueueLength)),
              })
            }
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('agents.budget.title')} description={t('agents.budget.description')}>
        <SettingRow
          vertical
          label={t('agents.budget.dailyLimit.label')}
          description={t('agents.budget.dailyLimit.description')}
        >
          <Input
            value={costLimit}
            inputMode="decimal"
            placeholder={t('agents.budget.dailyLimit.placeholder')}
            aria-label={t('agents.budget.dailyLimit.aria')}
            onChange={(event) => setCostLimit(event.target.value)}
            onBlur={() => {
              const value = Number(costLimit.replace(',', '.'));
              void saveSettings({
                agentDailyCostLimitUsd:
                  costLimit.trim() && Number.isFinite(value) && value > 0 ? value : null,
              });
            }}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t('agents.notifications.title')}
        description={t('agents.notifications.description')}
      >
        <SettingRow
          label={t('agents.notifications.enabled.label')}
          description={t('agents.notifications.enabled.description')}
        >
          <Switch
            checked={settings.notificationsEnabled ?? true}
            onCheckedChange={(checked) => void saveSettings({ notificationsEnabled: checked })}
            aria-label={t('agents.notifications.enabled.aria')}
          />
        </SettingRow>

        <SettingRow
          label={t('agents.notifications.dnd.label')}
          description={t('agents.notifications.dnd.description')}
        >
          <Switch
            checked={settings.notificationsDnd ?? false}
            onCheckedChange={(checked) => void saveSettings({ notificationsDnd: checked })}
            aria-label={t('agents.notifications.dnd.aria')}
          />
        </SettingRow>

        <div className="grid gap-3 sm:grid-cols-2">
          <SettingRow
            label={t('agents.notifications.approvals.label')}
            description={t('agents.notifications.approvals.description')}
          >
            <Switch
              checked={settings.notificationsApprovals ?? true}
              onCheckedChange={(checked) =>
                void saveSettings({ notificationsApprovals: checked })
              }
              aria-label={t('agents.notifications.approvals.aria')}
            />
          </SettingRow>
          <SettingRow
            label={t('agents.notifications.questions.label')}
            description={t('agents.notifications.questions.description')}
          >
            <Switch
              checked={settings.notificationsQuestions ?? true}
              onCheckedChange={(checked) =>
                void saveSettings({ notificationsQuestions: checked })
              }
              aria-label={t('agents.notifications.questions.aria')}
            />
          </SettingRow>
          <SettingRow
            label={t('agents.notifications.completions.label')}
            description={t('agents.notifications.completions.description')}
          >
            <Switch
              checked={settings.notificationsCompletions ?? true}
              onCheckedChange={(checked) =>
                void saveSettings({ notificationsCompletions: checked })
              }
              aria-label={t('agents.notifications.completions.aria')}
            />
          </SettingRow>
          <SettingRow
            label={t('agents.notifications.tasks.label')}
            description={t('agents.notifications.tasks.description')}
          >
            <Switch
              checked={settings.notificationsTasks ?? true}
              onCheckedChange={(checked) => void saveSettings({ notificationsTasks: checked })}
              aria-label={t('agents.notifications.tasks.aria')}
            />
          </SettingRow>
        </div>
      </SettingsSection>

      <SettingsSection title={t('agents.browser.title')} description={t('agents.browser.description')}>
        <SettingRow
          vertical
          label={t('agents.browser.allowed.label')}
          description={t('agents.browser.allowed.description')}
        >
          <Input
            defaultValue={(settings.browserAllowedDomains ?? []).join(', ')}
            aria-label={t('agents.browser.allowed.aria')}
            placeholder={t('agents.browser.allowed.placeholder')}
            onBlur={(event) =>
              void saveSettings({
                browserAllowedDomains: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </SettingRow>
        <SettingRow
          vertical
          label={t('agents.browser.blocked.label')}
          description={t('agents.browser.blocked.description')}
        >
          <Input
            defaultValue={(settings.browserBlockedDomains ?? []).join(', ')}
            aria-label={t('agents.browser.blocked.aria')}
            placeholder={t('agents.browser.blocked.placeholder')}
            onBlur={(event) =>
              void saveSettings({
                browserBlockedDomains: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label={t('agents.browser.privateHosts.label')}
          description={t('agents.browser.privateHosts.description')}
        >
          <Switch
            checked={settings.browserAllowPrivateHosts ?? true}
            onCheckedChange={(checked) =>
              void saveSettings({ browserAllowPrivateHosts: checked })
            }
            aria-label={t('agents.browser.privateHosts.aria')}
          />
        </SettingRow>
        <SettingRow
          label={t('agents.browser.routines.label')}
          description={t('agents.browser.routines.description')}
        >
          <Switch
            checked={settings.computerAllowUnattendedBrowser ?? false}
            onCheckedChange={(checked) =>
              void saveSettings({ computerAllowUnattendedBrowser: checked })
            }
            aria-label={t('agents.browser.routines.aria')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t('agents.desktopApps.title')}
        description={t('agents.desktopApps.description')}
      >
        <SettingRow
          vertical
          label={t('agents.desktopApps.allowed.label')}
          description={t('agents.desktopApps.allowed.description')}
        >
          <Input
            defaultValue={(settings.computerAllowedApps ?? []).join(', ')}
            aria-label={t('agents.desktopApps.allowed.aria')}
            placeholder={t('agents.desktopApps.allowed.placeholder')}
            onBlur={(event) =>
              void saveSettings({
                computerAllowedApps: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </SettingRow>
        <SettingRow
          vertical
          label={t('agents.desktopApps.blocked.label')}
          description={t('agents.desktopApps.blocked.description')}
        >
          <Input
            defaultValue={(settings.computerBlockedApps ?? []).join(', ')}
            aria-label={t('agents.desktopApps.blocked.aria')}
            placeholder={t('agents.desktopApps.blocked.placeholder')}
            onBlur={(event) =>
              void saveSettings({
                computerBlockedApps: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title={t('agents.computer.title')}
        description={t('agents.computer.description')}
      >
        <SettingRow
          vertical
          label={t('agents.computer.image.label')}
          description={t('agents.computer.image.description')}
        >
          <div className="flex flex-col gap-2">
            <Input
              value={computerDockerImage}
              maxLength={200}
              aria-label={t('agents.computer.image.aria')}
              placeholder={DEFAULT_COMPUTER_DOCKER_IMAGE}
              onChange={(event) => setComputerDockerImage(event.target.value)}
              onBlur={() => {
                const value = computerDockerImage.trim();
                if (value && value !== settings.computerDockerImage) {
                  void saveSettings({ computerDockerImage: value });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const value = computerDockerImage.trim();
                  if (value && value !== settings.computerDockerImage) {
                    void saveSettings({ computerDockerImage: value });
                  }
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={computerImageBusy || !computerDockerImage.trim()}
                aria-label={t('agents.computer.downloadAria')}
                onClick={() => {
                  const image = computerDockerImage.trim();
                  if (!image) return;
                  if (image !== settings.computerDockerImage) {
                    void saveSettings({ computerDockerImage: image });
                  }
                  void pullComputerImage(image);
                }}
              >
                {computerImageBusy ? (
                  <Spinner className="mr-1.5 size-3.5" />
                ) : (
                  <Download className="mr-1.5 size-3.5" />
                )}
                {t('agents.computer.download')}
              </Button>
              {computerDaemonDown ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={computerDaemonBusy || computerImageBusy}
                  aria-label={t('agents.computer.startDocker')}
                  onClick={() => void startComputerDaemon()}
                >
                  {computerDaemonBusy ? (
                    <Spinner className="mr-1.5 size-3.5" />
                  ) : (
                    <Play className="mr-1.5 size-3.5" />
                  )}
                  {computerDaemonBusy
                    ? t('agents.computer.startingDocker')
                    : t('agents.computer.startDocker')}
                </Button>
              ) : null}
              {computerDockerImage.trim() !== DEFAULT_COMPUTER_DOCKER_IMAGE ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={computerImageBusy}
                  onClick={() => {
                    setComputerDockerImage(DEFAULT_COMPUTER_DOCKER_IMAGE);
                    void saveSettings({ computerDockerImage: DEFAULT_COMPUTER_DOCKER_IMAGE });
                  }}
                >
                  {t('agents.computer.usePublished')}
                </Button>
              ) : null}
            </div>
          </div>
        </SettingRow>
        <SettingRow
          vertical
          label={t('agents.computer.container.label')}
          description={t('agents.computer.container.description')}
        >
          <Input
            defaultValue={settings.computerDockerContainer ?? 'zylara-computer'}
            maxLength={80}
            aria-label={t('agents.computer.container.aria')}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value) void saveSettings({ computerDockerContainer: value });
            }}
          />
        </SettingRow>
        <div className="grid gap-3 sm:grid-cols-2">
          <SettingRow
            vertical
            label={t('agents.computer.actionsPerTurn.label')}
            description={t('agents.computer.actionsPerTurn.description')}
          >
            <Input
              type="number"
              min={1}
              max={200}
              defaultValue={settings.computerMaxActionsPerTurn ?? 20}
              aria-label={t('agents.computer.actionsPerTurn.aria')}
              onBlur={(event) => {
                const value = Math.max(1, Math.min(200, Number(event.target.value) || 20));
                void saveSettings({ computerMaxActionsPerTurn: value });
              }}
            />
          </SettingRow>
          <SettingRow
            vertical
            label={t('agents.computer.actionsPerHour.label')}
            description={t('agents.computer.actionsPerHour.description')}
          >
            <Input
              type="number"
              min={1}
              max={2000}
              defaultValue={settings.computerMaxActionsPerHour ?? 120}
              aria-label={t('agents.computer.actionsPerHour.aria')}
              onBlur={(event) => {
                const value = Math.max(1, Math.min(2_000, Number(event.target.value) || 120));
                void saveSettings({ computerMaxActionsPerHour: value });
              }}
            />
          </SettingRow>
        </div>
        <SettingsBlock>
          <div className="flex gap-2.5 rounded-xl bg-warning-soft p-3">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <p className="text-[11px] leading-relaxed text-warning">{t('agents.computer.warning')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={dockerBusy}
              onClick={() => {
                setDockerBusy(true);
                void api
                  .dockerCleanup()
                  .then((count) =>
                    toast.success(
                      count === 0
                        ? t('agents.computer.cleanupNone')
                        : t('agents.computer.cleanupRemoved', { count }),
                    ),
                  )
                  .catch((error) =>
                    toast.error(t('agents.computer.cleanupFailed'), {
                      description: String(error),
                    }),
                  )
                  .finally(() => setDockerBusy(false));
              }}
            >
              {t('agents.computer.cleanup')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void api
                  .platformDiagnostics()
                  .then((diagnostics) =>
                    toast.info(t('agents.computer.diagnosticsTitle', { version: diagnostics.version }), {
                      description: t('agents.computer.diagnosticsBody', {
                        turns: diagnostics.activeTurns.length,
                        tasks: diagnostics.openTasks,
                        sessions: diagnostics.activeComputerSessions,
                      }),
                    }),
                  )
                  .catch((error) =>
                    toast.error(t('agents.computer.diagnosticsFailed'), {
                      description: String(error),
                    }),
                  );
              }}
            >
              {t('agents.computer.diagnostics')}
            </Button>
          </div>
        </SettingsBlock>
      </SettingsSection>
    </div>
  );
}
