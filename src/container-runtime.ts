/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Probe the daemon. Returns true if reachable. */
function probeContainerRuntime(timeoutMs: number): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: timeoutMs,
    });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_BOOT_TIMEOUT_MS = 45_000;
const DOCKER_BOOT_POLL_INTERVAL_MS = 1_500;

/**
 * On macOS, attempt to launch Docker Desktop and wait for the daemon.
 * Returns true if the daemon is reachable within the timeout.
 */
// Helper backend processes (NOT the Docker.app GUI). When the GUI dies but these
// linger, `open -a Docker` no-ops because macOS thinks Docker is already running.
const DOCKER_ORPHAN_PATTERNS = ['com.docker.backend', 'com.docker.build'];

function reapDockerOrphans(): void {
  let pids: string[] = [];
  try {
    const out = execSync(`pgrep -f '${DOCKER_ORPHAN_PATTERNS.join('|')}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    pids = out.trim().split('\n').filter(Boolean);
  } catch {
    // pgrep exits 1 when no matches — that's the no-orphans case
  }

  if (pids.length === 0) {
    logger.warn('No orphan Docker processes found, proceeding to launch');
    return;
  }

  logger.warn(
    { count: pids.length, pids },
    `Found ${pids.length} orphan Docker backend processes, killing`,
  );
  try {
    execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'pipe' });
  } catch (err) {
    logger.error({ err }, 'Failed to kill some orphan Docker processes');
  }
}

function tryLaunchDockerDesktop(): boolean {
  if (os.platform() !== 'darwin') return false;

  reapDockerOrphans();
  logger.warn('Launching Docker Desktop');
  try {
    spawn('open', ['-a', 'Docker'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch (err) {
    logger.error({ err }, 'Failed to invoke `open -a Docker`');
    return false;
  }

  const start = Date.now();
  while (Date.now() - start < DOCKER_BOOT_TIMEOUT_MS) {
    // Sync sleep so we block the startup path until the daemon is ready.
    execSync(`sleep ${DOCKER_BOOT_POLL_INTERVAL_MS / 1000}`);
    if (probeContainerRuntime(5_000)) {
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
      logger.info({ elapsedSec }, 'Docker daemon ready');
      return true;
    }
  }
  return false;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (probeContainerRuntime(10_000)) {
    logger.debug('Container runtime already running');
    return;
  }

  logger.warn('docker info failed — attempting recovery');
  if (tryLaunchDockerDesktop()) return;

  const err = new Error(
    `Docker daemon did not become ready within ${DOCKER_BOOT_TIMEOUT_MS / 1000}s`,
  );
  logger.error(
    { err, timeoutMs: DOCKER_BOOT_TIMEOUT_MS },
    'Giving up on Docker daemon — failing fast to avoid launchd retry storm',
  );
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 5000 });
  } catch (probeErr) {
    logger.error(
      { err: probeErr },
      'Final docker info probe (for diagnostics)',
    );
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
  }
  throw new Error('Container runtime is required but failed to start', {
    cause: err,
  });
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
