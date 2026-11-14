import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { type DatabaseClient, type TransactionOptions, runInTransaction } from './transaction';

/**
 * The API for application services to open a transaction boundary, so they never need the Prisma client itself:
 *
 *   await this.transactions.run(async (tx) => {
 *     const agent = await this.agents.create(input, tx);
 *     await this.audit.record('agent.created', agent.id, tx);
 *   });
 *
 * Rules (full version in docs/architecture/backend.md):
 * - The APPLICATION service owns the boundary; controllers and repositories do not open transactions.
 * - Pass `tx` to every repository call that must be atomic. Do not nest `run()` inside `run()`: that starts an
 *   unrelated second transaction.
 * - Keep transactions short: no HTTP calls, no waiting on Redis or user input inside `run()`.
 */
@Injectable()
export class TransactionRunner {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: DatabaseClient) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return runInTransaction(this.prisma, fn, options);
  }
}
