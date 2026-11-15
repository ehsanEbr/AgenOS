import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { DatabaseClient } from '../../database';
import type { AuditEntry, AuditRepository } from '../application/audit-repository';

/**
 * Appends with INSERT only. `createMany` is used on purpose instead of `create`: `create` asks for the inserted row back
 * (RETURNING), which PostgreSQL only allows with SELECT privilege, and the application role is deliberately given INSERT alone.
 */
@Injectable()
export class PrismaAuditRepository implements AuditRepository {
  async append(entry: AuditEntry, db: DatabaseClient): Promise<void> {
    await db.auditLog.createMany({
      data: [
        {
          id: entry.id,
          actorUserId: entry.actorUserId,
          organizationId: entry.organizationId,
          projectId: entry.projectId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          result: entry.result,
          correlationId: entry.correlationId,
          metadata: entry.metadata as Prisma.InputJsonObject,
        },
      ],
    });
  }
}
