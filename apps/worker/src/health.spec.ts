import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@agentos/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthFile, type HealthSnapshot, STALE_AFTER_INTERVALS, evaluateHealth } from './health';
import type { HostStatus } from './runtime';

const NOW = 1_700_000_000_000;
const INTERVAL = 5_000;
const alive = () => true;
const dead = () => false;

const snapshot = (overrides: Partial<HealthSnapshot> = {}): string =>
  JSON.stringify({
    pid: 123,
    state: 'running',
    ready: true,
    redis: 'ready',
    activeJobs: 0,
    updatedAt: NOW - 1_000,
    intervalMs: INTERVAL,
    ...overrides,
  } satisfies HealthSnapshot);

describe('evaluateHealth: a heartbeat is evidence only while everything about it is fresh', () => {
  it('is healthy only when the writer is alive, the heartbeat is fresh and the worker is ready', () => {
    expect(evaluateHealth(snapshot(), NOW, alive)).toEqual({ healthy: true, reason: 'ready' });
  });

  it('is unhealthy before the worker has written anything', () => {
    expect(evaluateHealth(undefined, NOW, alive)).toMatchObject({
      healthy: false,
      reason: expect.stringContaining('no health file'),
    });
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['an array', '[]'],
    ['missing fields', JSON.stringify({ pid: 1 })],
    ['wrong types', snapshot({ ready: 'yes' as unknown as boolean })],
  ])('is unhealthy for a file that is %s', (_name, raw) => {
    expect(evaluateHealth(raw, NOW, alive).healthy).toBe(false);
  });

  it('is unhealthy when the process that wrote the file is gone, however fresh and ready the file claims to be', () => {
    const verdict = evaluateHealth(snapshot({ ready: true, updatedAt: NOW }), NOW, dead);
    expect(verdict).toMatchObject({ healthy: false, reason: expect.stringContaining('not running') });
  });

  it('treats a stale "ready" as no evidence at all (a hung worker stops writing)', () => {
    const justFresh = NOW - INTERVAL * STALE_AFTER_INTERVALS;
    const justStale = justFresh - 1;
    expect(evaluateHealth(snapshot({ updatedAt: justFresh }), NOW, alive).healthy).toBe(true);
    expect(evaluateHealth(snapshot({ updatedAt: justStale }), NOW, alive)).toMatchObject({
      healthy: false,
      reason: expect.stringContaining('stale'),
    });
  });

  it.each(['starting', 'draining', 'stopped', 'failed'])('is unhealthy while the state is %s', (state) => {
    expect(evaluateHealth(snapshot({ state, ready: false }), NOW, alive)).toMatchObject({
      healthy: false,
      reason: expect.stringContaining(`state=${state}`),
    });
  });

  it('reports lost Redis connectivity as not ready even though the process is running', () => {
    expect(evaluateHealth(snapshot({ ready: false, redis: 'reconnecting' }), NOW, alive).reason).toContain(
      'redis=reconnecting',
    );
  });
});

describe('HealthFile', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  const setup = (initial: Partial<HostStatus> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentos-health-'));
    dirs.push(dir);
    const path = join(dir, 'worker-health.json');
    const status: HostStatus = {
      state: 'starting',
      ready: false,
      redis: 'connecting',
      activeJobs: 0,
      ...initial,
    };
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const file = new HealthFile(path, { status: () => status }, logger, INTERVAL);
    const read = () => JSON.parse(readFileSync(path, 'utf8')) as HealthSnapshot;
    return { file, path, status, read, warn };
  };

  it('writes the current state at start and again on every refresh, so a state change is visible at once', () => {
    const { file, status, read } = setup();
    file.start();
    expect(read()).toMatchObject({ pid: process.pid, state: 'starting', ready: false, intervalMs: INTERVAL });

    Object.assign(status, { state: 'running', ready: true, redis: 'ready' });
    file.refresh();
    expect(read()).toMatchObject({ state: 'running', ready: true });

    Object.assign(status, { state: 'draining', ready: false }); // shutdown began
    file.refresh();
    expect(read()).toMatchObject({ state: 'draining', ready: false });
    file.stop();
  });

  it('leaves no temporary files behind and removes the file on stop', () => {
    const { file, path } = setup();
    file.start();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    file.stop();
    expect(existsSync(path)).toBe(false);
  });

  it('does not throw when the file cannot be written, and warns only once', () => {
    const { file, warn } = setup();
    const broken = new HealthFile(
      join(tmpdir(), 'agentos-no-such-dir', 'x', 'h.json'),
      { status: () => ({ state: 'running', ready: true, redis: 'ready', activeJobs: 0 }) },
      { warn } as unknown as Logger,
    );
    expect(() => {
      broken.refresh();
      broken.refresh();
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    file.stop();
  });

  it('a snapshot written by the real process is judged healthy by evaluateHealth', () => {
    const { file, path } = setup({ state: 'running', ready: true, redis: 'ready' });
    file.start();
    const verdict = evaluateHealth(readFileSync(path, 'utf8'), Date.now(), alive);
    expect(verdict.healthy).toBe(true);
    file.stop();
  });
});
