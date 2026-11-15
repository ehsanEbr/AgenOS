import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type AuditEventInput, auditEventSchema } from '@agentos/contracts';
import { currentCorrelationId } from '../../../common/request-context';
import type { DatabaseClient } from '../../database';
import { AUDIT_REPOSITORY, type AuditRepository } from './audit-repository';

/**
 * The only way to write to the audit trail (ADR-0010, decision 6).
 *
 *   await this.transactions.run(async (tx) => {
 *     await this.users.create(user, tx);
 *     await this.audit.record({ action: 'auth.registered', ... }, tx);   // commits or rolls back with the change
 *   });
 *
 * An event is validated against the contract first: its metadata can only hold ids, counts and enum values, so a credential or
 * token cannot be recorded by accident. A failure to append propagates, and the surrounding transaction rolls the change back.
 */
@Injectable()
export class AuditRecorder {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepository) {}

  async record(event: AuditEventInput, tx: DatabaseClient): Promise<void> {
    const validated = auditEventSchema.parse(event);
    await this.repository.append(
      { ...validated, id: randomUUID(), correlationId: currentCorrelationId() ?? null },
      tx,
    );
  }
}
