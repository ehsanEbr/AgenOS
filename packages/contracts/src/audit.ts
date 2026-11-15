import { z } from 'zod';
import { idSchema } from './primitives';

/*
 * Audit events (ADR-0010, decision 6). Every audited action is listed here with a STRICT schema for its metadata, so an event
 * can only carry ids, counts and enum values: there is no free-form payload, hence no way to put a password, token or other secret
 * in the audit trail by accident. Later phases add their actions (organizations, memberships, projects) next to these.
 */

const none = z.object({}).strict();

const common = {
  /** The user who acted; null when there is none (for example a failed sign-in for an unknown address is not recorded at all). */
  actorUserId: idSchema.nullable().default(null),
  organizationId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  resourceId: idSchema.nullable().default(null),
};

const success = z.literal('success');
const failure = z.literal('failure');

export const auditEventSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('auth.registered'),
    resourceType: z.literal('user'),
    result: success,
    /** `true` for the first user of an empty instance. */
    metadata: z.object({ bootstrap: z.boolean() }).strict(),
    ...common,
  }),
  z.object({
    action: z.literal('auth.login_succeeded'),
    resourceType: z.literal('session'),
    result: success,
    metadata: z.object({ delivery: z.enum(['cookie', 'token']) }).strict(),
    ...common,
  }),
  z.object({
    // Recorded only for an EXISTING account; unknown addresses are counted in Redis and logged, never stored.
    action: z.literal('auth.login_failed'),
    resourceType: z.literal('user'),
    result: failure,
    metadata: none,
    ...common,
  }),
  z.object({
    // Written once when an account first crosses the failure threshold in a window, not on every refused request.
    action: z.literal('auth.login_throttled'),
    resourceType: z.literal('user'),
    result: failure,
    metadata: z.object({ scope: z.enum(['account', 'address']) }).strict(),
    ...common,
  }),
  z.object({
    action: z.literal('auth.logout'),
    resourceType: z.literal('session'),
    result: success,
    metadata: none,
    ...common,
  }),
  z.object({
    action: z.literal('auth.logout_all'),
    resourceType: z.literal('user'),
    result: success,
    metadata: z.object({ revokedSessions: z.number().int().min(0) }).strict(),
    ...common,
  }),
  z.object({
    action: z.literal('auth.password_changed'),
    resourceType: z.literal('user'),
    result: success,
    metadata: z.object({ revokedOtherSessions: z.number().int().min(0) }).strict(),
    ...common,
  }),
]);

/** What a caller passes to `AuditRecorder.record` (defaults not yet applied). */
export type AuditEventInput = z.input<typeof auditEventSchema>;
export type AuditEvent = z.output<typeof auditEventSchema>;
export type AuditAction = AuditEvent['action'];
export const AUDIT_ACTIONS = auditEventSchema.options.map((option) => option.shape.action.value);
