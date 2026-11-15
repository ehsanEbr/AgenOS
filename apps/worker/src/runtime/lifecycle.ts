/**
 * The worker host's life cycle as an explicit state machine, so "is it ready?" has one precise answer and impossible
 * transitions are bugs that throw, not states the process drifts into.
 *
 *   created ──► starting ──► running ──► draining ──► stopped
 *                  │            │            ▲
 *                  ▼            ▼            │
 *                failed ────────┴────────────┘ (cleanup, then stopped)
 *
 *  created   nothing connected yet
 *  starting  connecting to Redis, creating BullMQ workers. NOT ready.
 *  running   workers are consuming. Ready only while the Redis connection is also up (see WorkerHost.isReady).
 *  draining  shutdown requested: no new jobs are taken, active jobs may finish (within the grace period)
 *  stopped   everything closed; terminal
 *  failed    startup (or a fatal error) failed; resources are being released
 */
export type HostState = 'created' | 'starting' | 'running' | 'draining' | 'stopped' | 'failed';

const ALLOWED: Readonly<Record<HostState, readonly HostState[]>> = {
  created: ['starting', 'stopped'],
  starting: ['running', 'failed', 'draining'],
  running: ['draining', 'failed'],
  draining: ['stopped'],
  failed: ['stopped'],
  stopped: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: HostState, to: HostState) {
    super(`Illegal worker state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export type StateListener = (state: HostState, previous: HostState) => void;

export class Lifecycle {
  private current: HostState = 'created';
  private readonly listeners = new Set<StateListener>();

  get state(): HostState {
    return this.current;
  }

  canTransitionTo(next: HostState): boolean {
    return ALLOWED[this.current].includes(next);
  }

  transition(next: HostState): void {
    if (!this.canTransitionTo(next)) throw new IllegalTransitionError(this.current, next);
    const previous = this.current;
    this.current = next;
    this.listeners.forEach((listener) => listener(next, previous));
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
