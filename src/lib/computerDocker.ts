/** Published graphical image used by the private desktop (computer use). */
export const DEFAULT_COMPUTER_DOCKER_IMAGE =
  'ghcr.io/hyska-software/zylara-computer:latest';

/**
 * Backend codes meaning "the Docker engine is not reachable" — a stopped
 * Docker Desktop, not a missing/private image. The fix is to start the engine,
 * so the UI offers that action instead of the registry hints.
 */
export function isDockerDaemonError(error: string): boolean {
  return (
    error.includes('DOCKER_DAEMON_UNAVAILABLE') ||
    error.includes('DOCKER_DAEMON_START_TIMEOUT') ||
    error.includes('DOCKER_DAEMON_LAUNCH_FAILED') ||
    error.includes('COMPUTER_DOCKER_DAEMON_DOWN')
  );
}
