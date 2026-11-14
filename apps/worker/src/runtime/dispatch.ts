import { jobEnvelopeSchema } from '@agentos/contracts';
import type { Logger } from '@agentos/logger';
import { type JobContext, PermanentJobError } from './processor';
import type { ProcessorRegistry } from './registry';

/** The part of a BullMQ job the dispatcher reads. Keeping it this small keeps the dispatcher independent of BullMQ and testable. */
export interface JobLike {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  readonly queueName: string;
  readonly opts: { readonly attempts?: number | undefined };
}

/**
 * How a failed execution is classified (this drives whether BullMQ retries):
 *  - permanent  retrying cannot help: malformed job, unknown type/version, invalid payload, or the handler said so. Never retried.
 *  - transient  the handler threw an ordinary error. Retried with backoff until attempts are exhausted.
 *  - timeout    the handler exceeded the job timeout. Retried, but only AFTER the handler has actually ended: the attempt is not
 *               released while the handler may still be running, so a retry can never overlap its own earlier execution.
 *  - aborted    the worker is being force-stopped. The job is NOT acknowledged or failed; it is redelivered after its lock expires.
 */
export type FailureClass = 'permanent' | 'transient' | 'timeout' | 'aborted';

export type FailureReason =
  | 'invalid_envelope'
  | 'unknown_type'
  | 'unsupported_version'
  | 'invalid_payload'
  | 'handler_permanent_error'
  | 'handler_error'
  | 'timeout'
  | 'shutdown';

/** What the dispatcher throws. Its message becomes BullMQ's `failedReason`, so it never contains payload data. */
export class JobFailure extends Error {
  constructor(
    readonly failureClass: FailureClass,
    readonly reason: FailureReason,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'JobFailure';
  }
}

/** What the runtime reports when a handler is still running long after its timeout fired and its signal aborted. */
export interface StuckHandlerInfo {
  jobId: string;
  queue: string;
  type: string;
  attempt: number;
  /** Time since the handler started. */
  runningMs: number;
}

/** How long a timed-out handler may keep running after its signal aborted before the runtime reports it as stuck. */
export const DEFAULT_ABORT_GRACE_MS = 10_000;

export interface DispatcherOptions {
  registry: ProcessorRegistry;
  logger: Logger;
  jobTimeoutMs: number;
  /** Aborted when the worker is force-stopped; handlers see it through `ctx.signal`. */
  shutdownSignal: AbortSignal;
  /** See DEFAULT_ABORT_GRACE_MS. */
  abortGraceMs?: number;
  /**
   * Called once per attempt when a handler is still running `abortGraceMs` after its timeout. The job stays held (never retried
   * beside the running handler), so the only way to make progress is to stop the process: a process exit is the one thing that
   * reliably ends arbitrary JavaScript. The worker entry point does exactly that.
   */
  onStuckHandler?: (info: StuckHandlerInfo) => void;
}

const MAX_DETAIL = 300;
const trim = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text);

/** "payload.delayMs: expected number" without echoing any submitted value. */
function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return trim(
    issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; '),
  );
}

/**
 * Turns one delivered BullMQ job into: validate envelope -> find processor -> validate payload -> run the handler with a
 * timeout. Every failure becomes a classified `JobFailure`; nothing thrown here can crash the worker process, because BullMQ
 * records a rejected processor as a failed attempt and moves on to the next job.
 * Logs one line per execution with queue, job id, type, correlation id, attempt, duration and failure class, never the payload.
 */
export function createDispatcher({
  registry,
  logger,
  jobTimeoutMs,
  shutdownSignal,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  onStuckHandler,
}: DispatcherOptions) {
  return async function dispatch(job: JobLike): Promise<void> {
    const startedAt = performance.now();
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const jobId = job.id === undefined ? 'unknown' : String(job.id);
    let log = logger.child({ queue: job.queueName, jobId, attempt, maxAttempts });

    const fail = (failure: JobFailure, error?: unknown, extra: Record<string, unknown> = {}): never => {
      const final = failure.failureClass === 'permanent' || attempt >= maxAttempts;
      const fields = {
        failureClass: failure.failureClass,
        reason: failure.reason,
        willRetry: failure.failureClass !== 'aborted' && !final,
        durationMs: Math.round(performance.now() - startedAt),
        ...(error instanceof Error && failure.reason === 'handler_error' ? { errorName: error.name } : {}),
        ...extra,
      };
      if (failure.failureClass === 'aborted')
        log.warn(fields, 'job interrupted by shutdown; it will be redelivered');
      else if (final) log.error(fields, 'job failed permanently');
      else log.warn(fields, 'job attempt failed; it will be retried');
      throw failure;
    };

    // 1. Envelope
    const parsedEnvelope = jobEnvelopeSchema.safeParse(job.data);
    if (!parsedEnvelope.success) {
      return fail(
        new JobFailure('permanent', 'invalid_envelope', describeIssues(parsedEnvelope.error.issues)),
      );
    }
    const envelope = parsedEnvelope.data;
    log = log.child({
      jobType: envelope.type,
      jobVersion: envelope.version,
      correlationId: envelope.correlationId,
    });

    // 2. Processor
    const lookup = registry.find(job.queueName, envelope.type, envelope.version);
    if (!lookup.found) {
      const detail =
        lookup.reason === 'unsupported_version'
          ? `v${envelope.version} of ${envelope.type} (supported: ${lookup.supportedVersions.join(', ')})`
          : envelope.type;
      return fail(new JobFailure('permanent', lookup.reason, detail));
    }
    const { processor } = lookup;

    // 3. Payload
    const payload = processor.definition.payload.safeParse(envelope.payload);
    if (!payload.success) {
      return fail(new JobFailure('permanent', 'invalid_payload', describeIssues(payload.error.issues)));
    }

    // 4. Execution with a timeout
    //
    // The rule that keeps executions from overlapping: THE ATTEMPT ENDS ONLY WHEN THE HANDLER HAS SETTLED. This function does
    // not return (so BullMQ neither fails nor retries the job, and keeps renewing its lock) while the handler may still be
    // running. The timeout aborts the signal and decides the attempt's classification, but it cannot stop a handler that
    // ignores the signal, and releasing the job at that moment would let a retry run beside it. The one exception is a FORCED
    // worker shutdown: the Redis connection is already gone, nothing can be acknowledged, and the job is left for redelivery.
    if (shutdownSignal.aborted) return fail(new JobFailure('aborted', 'shutdown'));

    const controller = new AbortController();
    let onForced!: () => void;
    const forced = new Promise<never>((_resolve, reject) => {
      onForced = () => {
        const reason = shutdownSignal.reason ?? new Error('worker is shutting down');
        controller.abort(reason); // tell the handler (cooperative handlers stop here)
        reject(reason); // and stop waiting for it: this worker is being torn down
      };
      shutdownSignal.addEventListener('abort', onForced, { once: true });
    });

    let timedOut = false;
    let abortedAt: number | undefined;
    let stuckTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      abortedAt = performance.now();
      controller.abort(new Error(`job exceeded ${jobTimeoutMs} ms`));
      stuckTimer = setTimeout(() => {
        log.error(
          { abortGraceMs, runningMs: Math.round(performance.now() - startedAt) },
          'handler ignored its abort signal and is still running; the job is held (not retried, so it cannot run twice at once) until the handler ends or the worker is stopped',
        );
        try {
          onStuckHandler?.({
            jobId,
            queue: job.queueName,
            type: envelope.type,
            attempt,
            runningMs: Math.round(performance.now() - startedAt),
          });
        } catch {
          // a faulty callback must never break job processing
        }
      }, abortGraceMs);
    }, jobTimeoutMs);

    const context: JobContext = {
      jobId,
      queue: job.queueName,
      type: envelope.type,
      version: envelope.version,
      correlationId: envelope.correlationId,
      attempt,
      maxAttempts,
      isLastAttempt: attempt >= maxAttempts,
      logger: log,
      signal: controller.signal,
    };

    // How the handler ended, as a value, so that "the handler failed" and "we stopped waiting for it" cannot be confused.
    type Outcome = { ok: true } | { ok: false; error: unknown };
    const handlerEnded: Promise<Outcome> = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted(); // never start a handler for a job whose worker is being force-stopped
        return processor.handle(payload.data, context);
      })
      .then(
        (): Outcome => ({ ok: true }),
        (error: unknown): Outcome => ({ ok: false, error }),
      );

    let outcome: Outcome;
    try {
      outcome = await Promise.race([handlerEnded, forced]);
    } catch {
      // Only `forced` rejects: the worker is being force-stopped. The job is not acknowledged (see forceRelease in host.ts).
      return fail(new JobFailure('aborted', 'shutdown'));
    } finally {
      clearTimeout(timer);
      clearTimeout(stuckTimer);
      shutdownSignal.removeEventListener('abort', onForced);
    }

    // The timer decides the attempt. Whether the handler then succeeded or failed (even with a PermanentJobError) is recorded
    // for the operator but does not change the classification: the attempt overran its limit, so it is a retryable timeout.
    if (timedOut) {
      return fail(
        new JobFailure('timeout', 'timeout', `no result within ${jobTimeoutMs} ms`),
        outcome.ok ? undefined : outcome.error,
        {
          lateOutcome: outcome.ok ? 'resolved' : 'rejected',
          settledAfterAbortMs: abortedAt === undefined ? 0 : Math.round(performance.now() - abortedAt),
        },
      );
    }
    if (outcome.ok) {
      log.info({ durationMs: Math.round(performance.now() - startedAt) }, 'job completed');
      return;
    }
    const { error } = outcome;
    if (error instanceof PermanentJobError) {
      return fail(new JobFailure('permanent', 'handler_permanent_error', trim(error.message)), error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(new JobFailure('transient', 'handler_error', trim(message)), error);
  };
}
