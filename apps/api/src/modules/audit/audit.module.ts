import { Module } from '@nestjs/common';
import { AUDIT_REPOSITORY } from './application/audit-repository';
import { AuditRecorder } from './application/audit-recorder';
import { PrismaAuditRepository } from './infrastructure/prisma-audit.repository';

/** The audit trail: append-only, written inside the transaction of the change it records. */
@Module({
  providers: [AuditRecorder, { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository }],
  exports: [AuditRecorder],
})
export class AuditModule {}
