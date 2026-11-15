import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Logger } from '@agentos/logger';
import type { HostStatus } from './runtime';

/*
 * Process health for supervisors that cannot call into the process (Docker `HEALTHCHECK`, systemd watchdog scripts).
 *
 * The worker has no HTTP server on purpose. Instead, while health reporting is enabled (`WORKER_HEALTH_FILE`), the process
 * rewrites ONE small JSON file every few seconds with its current state, and a separate command (`healthcheck.ts`) judges it.
 * The file is never trusted on its own, because a file outlives the process that wrote it. `evaluateHealth` therefore requires
 * ALL of: the writing process is still alive, the heartbeat is fresh, and the worker says it is ready. A crashed worker (stale
 * file, dead pid), a hung event loop (no more heartbeats) and a shutting-down worker (`ready: false`) are all reported unhealthy.
 */

export const HEARTBEAT_INTERVAL_MS = 5_000;
/** A heartbeat older than this many intervals is treated as "the process stopped reporting". */
export const STALE_AFTER_INTERVALS = 3;

export interface HealthSnapshot {
  pid: number;
  /** Lifecycle state of the host: created, starting, running, draining, failed, stopped. */
  state: string;
  /** True only while running AND connected to Redis. The same definition as `WorkerHost.isReady`. */
  ready: boolean;
  /** ioredis connection status, for diagnosis. */
  redis: string;
  activeJobs: number;
  /** Epoch milliseconds of this snapshot. */
  updatedAt: number;
  /** How often the process promises to write a new snapshot. */
  intervalMs: number;
}

export interface HealthVerdict {
  healthy: boolean;
  /** One line for `docker inspect` / operators. Never contains secrets: the snapshot holds none. */
  reason: string;
}

export function evaluateHealth(
  raw: string | undefined,
  now: number,
  isProcessAlive: (pid: number) => boolean,
): HealthVerdict {
  if (raw === undefined)
    return { healthy: false, reason: 'no health file: the worker has not started reporting' };

  let snapshot: Partial<HealthSnapshot>;
  try {
    snapshot = JSON.parse(raw) as Partial<HealthSnapshot>;
  } catch {
    return { healthy: false, reason: 'health file is not valid JSON' };
  }
  const { pid, updatedAt, intervalMs, ready, state, redis } = snapshot;
  if (
    typeof pid !== 'number' ||
    typeof updatedAt !== 'number' ||
    typeof intervalMs !== 'number' ||
    typeof ready !== 'boolean' ||
    typeof state !== 'string'
  ) {
    return { healthy: false, reason: 'health file has an unexpected shape' };
  }

  if (!isProcessAlive(pid))
    return { healthy: false, reason: `the process that wrote the health file (pid ${pid}) is not running` };

  const ageMs = now - updatedAt;
  if (ageMs > intervalMs * STALE_AFTER_INTERVALS) {
    return {
      healthy: false,
      reason: `stale heartbeat: last report ${Math.round(ageMs / 1000)} s ago (the worker may be hung)`,
    };
  }
  if (!ready) return { healthy: false, reason: `not ready (state=${state}, redis=${String(redis)})` };
  return { healthy: true, reason: 'ready' };
}

/** Writes the snapshot atomically (temp file + rename) so a reader never sees half a file. */
function writeAtomically(path: string, snapshot: HealthSnapshot): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o644 });
  renameSync(temp, path);
}

export interface HealthSource {
  status(): HostStatus;
}

/**
 * Keeps the health file current while the process is alive. `refresh()` is called by the entry point at every state change
 * that must be visible at once (in particular when shutdown begins: a draining worker must stop being ready immediately, not up
 * to one interval later). `stop()` removes the file; if the process is killed instead, the dead pid / stale heartbeat is what
 * the checker sees.
 */
export class HealthFile {
  private timer?: NodeJS.Timeout;
  private failedBefore = false;

  constructor(
    private readonly path: string,
    private readonly source: HealthSource,
    private readonly logger: Logger,
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {}

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref(); // the heartbeat must never keep the process alive
  }

  refresh(): void {
    const status = this.source.status();
    try {
      writeAtomically(this.path, {
        pid: process.pid,
        state: status.state,
        ready: status.ready,
        redis: status.redis,
        activeJobs: status.activeJobs,
        updatedAt: Date.now(),
        intervalMs: this.intervalMs,
      });
      this.failedBefore = false;
    } catch (error) {
      // A health file that cannot be written must not take the worker down; the checker will see the heartbeat go stale.
      if (!this.failedBefore) {
        this.logger.warn(
          { errorName: error instanceof Error ? error.name : 'Error' },
          'cannot write the health file',
        );
      }
      this.failedBefore = true;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      rmSync(this.path, { force: true });
    } catch {
      // best effort: a leftover file is judged stale/dead by the checker
    }
  }
}
