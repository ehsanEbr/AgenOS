import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSACTION_OPTIONS, TransactionIsolationLevel, runInTransaction } from './transaction';
import { TransactionRunner } from './transaction-runner';
import type { PrismaService } from './prisma.service';

function fakeClient() {
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ marker: 'tx' }));
  return { client: { $transaction } as never, $transaction };
}

describe('runInTransaction', () => {
  it('passes the transaction handle to the callback and returns its result', async () => {
    const { client } = fakeClient();
    await expect(runInTransaction(client, async (tx) => ({ got: tx }))).resolves.toEqual({
      got: { marker: 'tx' },
    });
  });

  it('applies explicit default wait/timeout limits', async () => {
    const { client, $transaction } = fakeClient();
    await runInTransaction(client, async () => undefined);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: DEFAULT_TRANSACTION_OPTIONS.maxWaitMs,
      timeout: DEFAULT_TRANSACTION_OPTIONS.timeoutMs,
      isolationLevel: undefined,
    });
  });

  it('honours per-call options', async () => {
    const { client, $transaction } = fakeClient();
    await runInTransaction(client, async () => undefined, {
      maxWaitMs: 100,
      timeoutMs: 250,
      isolationLevel: TransactionIsolationLevel.Serializable,
    });
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 100,
      timeout: 250,
      isolationLevel: 'Serializable',
    });
  });

  it('re-throws the callback error unchanged so Prisma rolls back', async () => {
    const boom = new Error('rule violated');
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
    await expect(runInTransaction({ $transaction } as never, async () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
  });
});

describe('TransactionRunner', () => {
  it('delegates to the shared Prisma client', async () => {
    const { client, $transaction } = fakeClient();
    const runner = new TransactionRunner(client as unknown as PrismaService);
    await runner.run(async () => 'done');
    expect($transaction).toHaveBeenCalledOnce();
  });
});
