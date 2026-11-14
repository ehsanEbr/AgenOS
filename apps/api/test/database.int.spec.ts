import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiErrorSchema } from '@agentos/contracts';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap/configure-app';
import { APP_CONFIG, type ApiConfig, loadApiConfig } from '../src/modules/config';
import {
  DatabaseModule,
  PrismaService,
  TransactionIsolationLevel,
  TransactionRunner,
} from '../src/modules/database';
import { type IsolatedDatabase, createIsolatedDatabase } from './support/isolated-database';

// Requires the Docker Compose stack: `pnpm setup:env && pnpm infra:up`.
// Table-creating tests run in a throwaway database (see support/isolated-database.ts), never in the dev database.

describe('transactions (integration: real PostgreSQL, throwaway database)', () => {
  let isolated: IsolatedDatabase;
  let prisma: PrismaService;
  let runner: TransactionRunner;

  const count = async () => {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*) AS n FROM tx_probe');
    return Number(rows[0]?.n);
  };

  beforeAll(async () => {
    isolated = await createIsolatedDatabase(loadApiConfig().DATABASE_URL);
    prisma = new PrismaService({ DATABASE_URL: isolated.url } as ApiConfig);
    await prisma.onModuleInit();
    await prisma.$executeRawUnsafe('CREATE TABLE tx_probe (id int PRIMARY KEY, note text NOT NULL)');
    runner = new TransactionRunner(prisma);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await isolated?.drop();
  });

  it('commits when the callback resolves', async () => {
    await runner.run(async (tx) => {
      await tx.$executeRawUnsafe("INSERT INTO tx_probe VALUES (1, 'committed')");
    });
    expect(await count()).toBe(1);
  });

  it('rolls back every statement and re-throws the original error when the callback throws', async () => {
    const rule = new Error('business rule violated');
    await expect(
      runner.run(async (tx) => {
        await tx.$executeRawUnsafe("INSERT INTO tx_probe VALUES (2, 'first')");
        await tx.$executeRawUnsafe("INSERT INTO tx_probe VALUES (3, 'second')");
        throw rule;
      }),
    ).rejects.toBe(rule);
    expect(await count()).toBe(1); // neither 2 nor 3 persisted
  });

  it('rolls back when a statement fails midway (atomicity)', async () => {
    await expect(
      runner.run(async (tx) => {
        await tx.$executeRawUnsafe("INSERT INTO tx_probe VALUES (4, 'ok')");
        await tx.$executeRawUnsafe("INSERT INTO tx_probe VALUES (1, 'duplicate key')");
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(1);
  });

  it('does not make work done outside the transaction part of it', async () => {
    await expect(
      runner.run(async () => {
        await prisma.$executeRawUnsafe("INSERT INTO tx_probe VALUES (5, 'used root client, not tx')");
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await count()).toBe(2); // statement on the root client was NOT rolled back: always use `tx`
    await prisma.$executeRawUnsafe('DELETE FROM tx_probe WHERE id = 5');
  });

  it('rolls back and fails when the transaction exceeds its timeout', async () => {
    await expect(
      runner.run(
        async (tx) => {
          await tx.$executeRawUnsafe("INSERT INTO tx_probe VALUES (6, 'slow')");
          await tx.$queryRawUnsafe('SELECT pg_sleep(2)');
        },
        { timeoutMs: 300 },
      ),
    ).rejects.toThrow();
    expect(await count()).toBe(1);
  });

  it('applies the requested isolation level', async () => {
    const level = await runner.run(
      async (tx) =>
        (await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>('SHOW transaction_isolation'))[0],
      { isolationLevel: TransactionIsolationLevel.Serializable },
    );
    expect(level?.transaction_isolation).toBe('serializable');
  });
});

describe('error handling and lifecycle (integration)', () => {
  @Controller('test-db')
  class DatabaseProbeController {
    constructor(private readonly prisma: PrismaService) {}

    @Get('query')
    async query() {
      return this.prisma.$queryRaw`SELECT 1 AS ok`.then(() => ({ ok: true }));
    }
  }

  async function createApp(databaseUrl: string) {
    const config: ApiConfig = { ...loadApiConfig(), DATABASE_URL: databaseUrl };
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DatabaseModule],
      controllers: [DatabaseProbeController],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(config)
      .compile();
    const app = moduleRef.createNestApplication({ bufferLogs: true });
    configureApp(app, config);
    await app.init();
    return app;
  }

  let app: INestApplication | undefined;
  afterAll(async () => {
    await app?.close();
  });

  it('a request that hits an unreachable database gets 503 database_unavailable and leaks nothing', async () => {
    app = await createApp('postgresql://nobody:hunter2@127.0.0.1:1/none?schema=public');
    const res = await request(app.getHttpServer()).get('/api/v1/test-db/query').expect(503);
    expect(apiErrorSchema.parse(res.body).code).toBe('database_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|127\.0\.0\.1|nobody/);
    await app.close();
    app = undefined;
  });

  it('the same request succeeds against the real database', async () => {
    app = await createApp(loadApiConfig().DATABASE_URL);
    await request(app.getHttpServer()).get('/api/v1/test-db/query').expect(200, { ok: true });
  });

  it('disconnects Prisma exactly once even if the application is closed twice', async () => {
    const second = await createApp(loadApiConfig().DATABASE_URL);
    const disconnect = vi.spyOn(second.get(PrismaService), '$disconnect');
    await second.close();
    await second.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
