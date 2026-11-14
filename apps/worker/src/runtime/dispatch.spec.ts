import { defineJob } from '@agentos/contracts';
import type { Logger } from '@agentos/logger';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type JobLike, JobFailure, type StuckHandlerInfo, createDispatcher } from './dispatch';
import { type JobContext, PermanentJobError, defineProcessor } from './processor';
import { ProcessorRegistry } from './registry';

const SECRET = 'hunter2-payload-secret';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** Lets already-queued promise callbacks run (a yield to the event loop, not a timing assumption). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const echoJob = defineJob({
  queue: 'system',
  type: 'test.echo',
  version: 1,
  payload: z.object({ text: z.string(), count: z.number().int().default(1) }),
});

/** A logger fake that records every call, so tests can assert what was (and was not) logged. */
function fakeLogger() {
  const calls: { level: string; fields: unknown; msg: string }[] = [];
  const logger: Record<string, unknown> = {};
  for (const level of ['info', 'warn', 'error', 'fatal', 'debug']) {
    logger[level] = (fields: unknown, msg: string) => calls.push({ level, fields, msg });
  }
  logger.child = () => logger;
  return { logger: logger as unknown as Logger, calls };
}

const envelope = (overrides: Record<string, unknown> = {}) => ({
  type: 'test.echo',
  version: 1,
  correlationId: 'corr-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  payload: { text: 'hello' },
  ...overrides,
});

const job = (data: unknown, extra: Partial<JobLike> = {}): JobLike => ({
  id: 'job-1',
  name: 'test.echo',
  data,
  attemptsMade: 0,
  queueName: 'system',
  opts: { attempts: 3 },
  ...extra,
});

function setup(
  handler: (payload: { text: string; count: number }, ctx: JobContext) => unknown = () => undefined,
  jobTimeoutMs = 1_000,
  extra: Partial<Parameters<typeof createDispatcher>[0]> = {},
) {
  const registry = new ProcessorRegistry().register(defineProcessor(echoJob, handler as never));
  const shutdown = new AbortController();
  const { logger, calls } = fakeLogger();
  const dispatch = createDispatcher({
    registry,
    logger,
    jobTimeoutMs,
    shutdownSignal: shutdown.signal,
    ...extra,
  });
  return { dispatch, calls, shutdown };
}

async function failureOf(promise: Promise<unknown>): Promise<JobFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JobFailure);
    return error as JobFailure;
  }
  throw new Error('expected the job to fail');
}

describe('successful execution', () => {
  it('runs the handler with the validated payload (defaults applied) and a full context', async () => {
    const handler = vi.fn();
    const { dispatch } = setup(handler);
    await dispatch(job(envelope(), { attemptsMade: 0 }));

    const [payload, ctx] = handler.mock.calls[0] as [unknown, JobContext];
    expect(payload).toEqual({ text: 'hello', count: 1 });
    expect(ctx).toMatchObject({
      jobId: 'job-1',
      queue: 'system',
      type: 'test.echo',
      version: 1,
      correlationId: 'corr-1',
      attempt: 1,
      maxAttempts: 3,
      isLastAttempt: false,
    });
    expect(ctx.signal.aborted).toBe(false);
  });

  it('numbers attempts from BullMQ and knows the last one', async () => {
    const handler = vi.fn();
    const { dispatch } = setup(handler);
    await dispatch(job(envelope(), { attemptsMade: 2 }));
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ attempt: 3, maxAttempts: 3, isLastAttempt: true });
  });

  it('logs one completion line with duration and never the payload', async () => {
    const { dispatch, calls } = setup();
    await dispatch(job(envelope({ payload: { text: SECRET } })));
    expect(calls.map((c) => c.msg)).toEqual(['job completed']);
    expect(calls[0]?.fields).toMatchObject({ durationMs: expect.any(Number) });
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('supports synchronous handlers', async () => {
    const { dispatch } = setup(() => 'sync result');
    await expect(dispatch(job(envelope()))).resolves.toBeUndefined();
  });
});

describe('malformed jobs fail permanently and safely', () => {
  it.each([
    ['null data', null],
    ['a string', 'not an envelope'],
    ['an array', []],
    ['missing type', envelope({ type: undefined })],
    ['bad type', envelope({ type: 'NOT VALID' })],
    ['missing version', envelope({ version: undefined })],
    ['bad correlation id', envelope({ correlationId: 'has spaces\nand newline' })],
    ['bad timestamp', envelope({ createdAt: 'yesterday' })],
  ])('%s -> permanent invalid_envelope, handler never runs', async (_name, data) => {
    const handler = vi.fn();
    const { dispatch, calls } = setup(handler);
    const failure = await failureOf(dispatch(job(data)));
    expect(failure).toMatchObject({ failureClass: 'permanent', reason: 'invalid_envelope' });
    expect(handler).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({ level: 'error', msg: 'job failed permanently' });
  });

  it('does not echo submitted values in the failure message (it is stored in Redis and logged)', async () => {
    const { dispatch, calls } = setup();
    const failure = await failureOf(dispatch(job(envelope({ correlationId: SECRET + ' bad' }))));
    expect(failure.message).not.toContain(SECRET);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('unknown job type -> permanent unknown_type', async () => {
    const { dispatch } = setup();
    const failure = await failureOf(dispatch(job(envelope({ type: 'test.other' }))));
    expect(failure).toMatchObject({ failureClass: 'permanent', reason: 'unknown_type' });
  });

  it('unsupported payload version -> permanent, and says which versions are supported', async () => {
    const { dispatch } = setup();
    const failure = await failureOf(dispatch(job(envelope({ version: 2 }))));
    expect(failure).toMatchObject({ failureClass: 'permanent', reason: 'unsupported_version' });
    expect(failure.message).toContain('supported: 1');
  });

  it('invalid payload -> permanent, naming the field but not the value', async () => {
    const handler = vi.fn();
    const { dispatch, calls } = setup(handler);
    const failure = await failureOf(dispatch(job(envelope({ payload: { text: 42, count: SECRET } }))));
    expect(failure).toMatchObject({ failureClass: 'permanent', reason: 'invalid_payload' });
    expect(failure.message).toContain('text');
    expect(failure.message).not.toContain(SECRET);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('handler failures are classified', () => {
  it('an ordinary error is transient and retried while attempts remain', async () => {
    const { dispatch, calls } = setup(() => {
      throw new Error('database is down');
    });
    const failure = await failureOf(dispatch(job(envelope(), { attemptsMade: 0 })));
    expect(failure).toMatchObject({ failureClass: 'transient', reason: 'handler_error' });
    expect(failure.message).toContain('database is down');
    expect(calls.at(-1)).toMatchObject({
      level: 'warn',
      msg: 'job attempt failed; it will be retried',
      fields: { failureClass: 'transient', willRetry: true, errorName: 'Error' },
    });
  });

  it('the same error on the last attempt is logged as final', async () => {
    const { dispatch, calls } = setup(() => {
      throw new Error('still down');
    });
    await failureOf(dispatch(job(envelope(), { attemptsMade: 2 })));
    expect(calls.at(-1)).toMatchObject({
      level: 'error',
      msg: 'job failed permanently',
      fields: { willRetry: false },
    });
  });

  it('PermanentJobError is permanent and final on the first attempt', async () => {
    const { dispatch, calls } = setup(() => {
      throw new PermanentJobError('entity no longer exists');
    });
    const failure = await failureOf(dispatch(job(envelope(), { attemptsMade: 0 })));
    expect(failure).toMatchObject({ failureClass: 'permanent', reason: 'handler_permanent_error' });
    expect(calls.at(-1)?.fields).toMatchObject({ willRetry: false });
  });

  it('a rejected promise and a thrown non-Error are both contained', async () => {
    const rejecting = setup(() => Promise.reject(new Error('async failure')));
    expect(await failureOf(rejecting.dispatch(job(envelope())))).toMatchObject({ failureClass: 'transient' });

    const throwingString = setup(() => {
      throw 'a string was thrown';
    });
    expect(await failureOf(throwingString.dispatch(job(envelope())))).toMatchObject({
      failureClass: 'transient',
    });
  });

  it('truncates very long error messages before they are stored', async () => {
    const { dispatch } = setup(() => {
      throw new Error('x'.repeat(5_000));
    });
    const failure = await failureOf(dispatch(job(envelope())));
    expect(failure.message.length).toBeLessThan(400);
  });

  it('never logs the payload on failures either', async () => {
    const { dispatch, calls } = setup(() => {
      throw new Error('boom');
    });
    await failureOf(dispatch(job(envelope({ payload: { text: SECRET } }))));
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });
});

describe('timeout and shutdown', () => {
  it('aborts the signal at the timeout but does NOT give up on a handler that ignores it: the attempt ends when the handler does', async () => {
    const release = deferred();
    const aborted = deferred();
    let seenSignal: AbortSignal | undefined;
    const { dispatch, calls } = setup(async (_payload, ctx) => {
      seenSignal = ctx.signal;
      ctx.signal.addEventListener('abort', () => aborted.resolve());
      await release.promise; // ignores the signal
    }, 30);

    let settled = false;
    const outcome = failureOf(dispatch(job(envelope())));
    void outcome.then(() => (settled = true));
    await aborted.promise; // the timeout fired
    await tick();
    expect(seenSignal?.aborted).toBe(true);
    expect(settled).toBe(false); // still pending: BullMQ has not been told anything, so it cannot retry yet

    release.resolve(); // the handler really ends (successfully, but late)
    const failure = await outcome;
    expect(failure).toMatchObject({ failureClass: 'timeout', reason: 'timeout' });
    expect(calls.at(-1)?.fields).toMatchObject({
      failureClass: 'timeout',
      willRetry: true,
      lateOutcome: 'resolved',
    });
  });

  it.each([
    ['an ordinary error', new Error('boom'), 'timeout'],
    ['a PermanentJobError', new PermanentJobError('gone'), 'timeout'],
  ] as const)(
    'a handler that fails with %s after its timeout is still a retryable timeout',
    async (_name, error, expectedClass) => {
      const release = deferred();
      const aborted = deferred();
      const { dispatch, calls } = setup(async (_payload, ctx) => {
        ctx.signal.addEventListener('abort', () => aborted.resolve());
        await release.promise;
        throw error;
      }, 30);
      const outcome = failureOf(dispatch(job(envelope())));
      await aborted.promise;
      release.resolve();
      expect(await outcome).toMatchObject({ failureClass: expectedClass, reason: 'timeout' });
      expect(calls.at(-1)?.fields).toMatchObject({ willRetry: true, lateOutcome: 'rejected' });
    },
  );

  it('reports a handler that is still running abortGraceMs after the timeout, once, and keeps holding the job', async () => {
    const release = deferred();
    const stuck = deferred<StuckHandlerInfo>();
    const onStuckHandler = vi.fn((info: StuckHandlerInfo) => stuck.resolve(info));
    const { dispatch, calls } = setup(() => release.promise, 20, { abortGraceMs: 20, onStuckHandler });

    let settled = false;
    const outcome = failureOf(dispatch(job(envelope(), { id: '42' })));
    void outcome.then(() => (settled = true));

    expect(await stuck.promise).toMatchObject({
      jobId: '42',
      queue: 'system',
      type: 'test.echo',
      attempt: 1,
    });
    await tick();
    expect(settled).toBe(false); // reported, but never released
    expect(calls.some((c) => c.level === 'error' && c.msg.includes('ignored its abort signal'))).toBe(true);

    release.resolve();
    await outcome;
    expect(onStuckHandler).toHaveBeenCalledTimes(1);
  });

  it('does not report a handler that ends within the abort grace period, and survives a throwing callback', async () => {
    const notExpected = vi.fn();
    const cooperative = setup(
      (_payload, ctx) =>
        new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)),
        ),
      20,
      { abortGraceMs: 5_000, onStuckHandler: notExpected },
    );
    await failureOf(cooperative.dispatch(job(envelope())));
    expect(notExpected).not.toHaveBeenCalled(); // it stopped promptly

    const release = deferred();
    const onStuckHandler = vi.fn(() => {
      release.resolve(); // let the handler end as soon as it has been reported...
      throw new Error('callback bug'); // ...and make the callback fail
    });
    const faulty = setup(() => release.promise, 20, { abortGraceMs: 20, onStuckHandler });
    expect(await failureOf(faulty.dispatch(job(envelope())))).toMatchObject({ failureClass: 'timeout' });
    expect(onStuckHandler).toHaveBeenCalledTimes(1); // it threw, and dispatch still completed normally
  });

  it('a force-stop after the timeout releases the dispatcher even though the handler never ends', async () => {
    const aborted = deferred();
    const { dispatch, shutdown } = setup(
      (_payload, ctx) => {
        ctx.signal.addEventListener('abort', () => aborted.resolve());
        return new Promise(() => undefined);
      },
      20,
      { abortGraceMs: 60_000 },
    );
    const outcome = failureOf(dispatch(job(envelope())));
    await aborted.promise; // timed out; the handler ignores it
    shutdown.abort(new Error('worker is shutting down'));
    expect(await outcome).toMatchObject({ failureClass: 'aborted', reason: 'shutdown' });
  });

  it('lets a cooperative handler observe the abort and stop', async () => {
    let stopped = false;
    const { dispatch } = setup((_payload, ctx) => {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          stopped = true;
          reject(ctx.signal.reason);
        });
      });
    }, 30);
    await failureOf(dispatch(job(envelope())));
    expect(stopped).toBe(true);
  });

  it('a force-stop during execution is "aborted": not retried by this attempt, left for redelivery', async () => {
    const { dispatch, calls, shutdown } = setup(() => new Promise(() => undefined), 10_000);
    const running = failureOf(dispatch(job(envelope())));
    shutdown.abort(new Error('worker is shutting down'));

    const failure = await running;
    expect(failure).toMatchObject({ failureClass: 'aborted', reason: 'shutdown' });
    expect(calls.at(-1)).toMatchObject({ level: 'warn', fields: { willRetry: false } });
    expect(calls.at(-1)?.msg).toContain('redelivered');
  });

  it('does not start a handler once shutdown has already been forced', async () => {
    const handler = vi.fn(() => new Promise(() => undefined));
    const { dispatch, shutdown } = setup(handler, 10_000);
    shutdown.abort(new Error('shutting down'));
    const failure = await failureOf(dispatch(job(envelope())));
    expect(failure.failureClass).toBe('aborted');
  });
});
