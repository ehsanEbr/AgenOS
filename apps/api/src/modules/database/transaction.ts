import { Prisma, type PrismaClient } from '@prisma/client';

/*
 * Framework-free on purpose (no NestJS imports): if a worker process ever needs the database, this file and
 * prisma-errors.ts can move into a shared package unchanged. See docs/architecture/backend.md.
 */

/**
 * The handle repositories use to run queries. It is either the root client or the client bound to an open
 * transaction, so a repository method works in both situations:
 *
 *   find(id: string, db: DatabaseClient = this.prisma) { return db.agent.findUnique({ where: { id } }); }
 */
export type DatabaseClient = Prisma.TransactionClient;

export const TransactionIsolationLevel = Prisma.TransactionIsolationLevel;
export type TransactionIsolationLevel = Prisma.TransactionIsolationLevel;

export interface TransactionOptions {
  /** How long to wait to START the transaction (connection pool pressure). Default 2000 ms. */
  maxWaitMs?: number;
  /** How long the transaction may RUN before it is rolled back. Default 5000 ms. */
  timeoutMs?: number;
  /** Defaults to the PostgreSQL default (READ COMMITTED). Raise it deliberately, per use case. */
  isolationLevel?: TransactionIsolationLevel;
}

export const DEFAULT_TRANSACTION_OPTIONS = { maxWaitMs: 2_000, timeoutMs: 5_000 } as const;

/**
 * Runs `fn` in one interactive transaction: it commits if `fn` resolves and rolls back if it throws (the error is
 * re-thrown unchanged). Every statement that must be atomic has to use the `tx` handle, not another client.
 */
export function runInTransaction<T>(
  client: Pick<PrismaClient, '$transaction'>,
  fn: (tx: DatabaseClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  return client.$transaction(fn, {
    maxWait: options.maxWaitMs ?? DEFAULT_TRANSACTION_OPTIONS.maxWaitMs,
    timeout: options.timeoutMs ?? DEFAULT_TRANSACTION_OPTIONS.timeoutMs,
    isolationLevel: options.isolationLevel,
  });
}
