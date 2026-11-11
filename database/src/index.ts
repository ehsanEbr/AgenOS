import { PrismaClient } from '@prisma/client';

export { PrismaClient, Prisma, SystemJobStatus } from '@prisma/client';
export type { SystemJob } from '@prisma/client';

/** Creates a client bound to an explicit connection string (no implicit env lookup). */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
