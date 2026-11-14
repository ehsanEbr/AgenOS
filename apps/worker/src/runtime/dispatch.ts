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
 *  - timeout    the handler exceeded the job timeout. Retried (the first execution may still be running: idempotency matters).
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

export interface DispatcherOptions {
  registry: ProcessorRegistry;
  logger: Logger;
  jobTimeoutMs: number;
  /** Aborted when the worker is force-stopped; handlers see it through `ctx.signal`. */
  shutdownSignal: AbortSignal;
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
export function createDispatcher({ registry, logger, jobTimeoutMs, shutdownSignal }: DispatcherOptions) {
  return async function dispatch(job: JobLike): Promise<void> {
    const startedAt = performance.now();
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const jobId = job.id === undefined ? 'unknown' : String(job.id);
    let log = logger.child({ queue: job.queueName, jobId, attempt, maxAttempts });

    const fail = (failure: JobFailure, error?: unknown): never => {
      const final = failure.failureClass === 'permanent' || attempt >= maxAttempts;
      const fields = {
        failureClass: failure.failureClass,
        reason: failure.reason,
        willRetry: failure.failureClass !== 'aborted' && !final,
        durationMs: Math.round(performance.now() - startedAt),
        ...(error instanceof Error && failure.reason === 'handler_error' ? { errorName: error.name } : {}),
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
    const controller = new AbortController();
    const onShutdown = () => controller.abort(shutdownSignal.reason ?? new Error('shutdown'));
    if (shutdownSignal.aborted) onShutdown();
    else shutdownSignal.addEventListener('abort', onShutdown, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`job exceeded ${jobTimeoutMs} ms`));
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

    try {
      // Never start a handler for a job whose worker is already being force-stopped.
      controller.signal.throwIfAborted();

      // Rejects when the signal aborts, so a handler that ignores the signal cannot hold a concurrency slot forever.
      // (It may keep running in the background: handlers should honor ctx.signal, and must be idempotent regardless.)
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      await Promise.race([Promise.resolve().then(() => processor.handle(payload.data, context)), aborted]);
      log.info({ durationMs: Math.round(performance.now() - startedAt) }, 'job completed');
    } catch (error) {
      if (timedOut) {
        return fail(new JobFailure('timeout', 'timeout', `no result within ${jobTimeoutMs} ms`), error);
      }
      if (shutdownSignal.aborted) return fail(new JobFailure('aborted', 'shutdown'), error);
      if (error instanceof PermanentJobError) {
        return fail(new JobFailure('permanent', 'handler_permanent_error', trim(error.message)), error);
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail(new JobFailure('transient', 'handler_error', trim(message)), error);
    } finally {
      clearTimeout(timer);
      shutdownSignal.removeEventListener('abort', onShutdown);
    }
  };
}
