import type { AuditEvent } from '@agentos/contracts';
import type { DatabaseClient } from '../../database';

/** An event that has been validated against the contracts and given its identity, time of record and correlation id. */
export type AuditEntry = AuditEvent & {
  readonly id: string;
  readonly correlationId: string | null;
};

/**
 * Port of the audit store. It can append and nothing else: there is no update, no delete and (in Phase 2) no read, so the
 * application has no code path that could alter the trail. The privileges and triggers in the database enforce the same rule.
 */
export interface AuditRepository {
  /** Inserts one entry through the given handle, so it commits or rolls back together with the change it records. */
  append(entry: AuditEntry, db: DatabaseClient): Promise<void>;
}

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
