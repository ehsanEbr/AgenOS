import { z } from 'zod';
import { organizationRoleSchema, projectRoleSchema } from './permissions';
import { idSchema } from './primitives';

/*
 * Audit events (ADR-0010, decision 6). Every audited action is listed here with a STRICT schema for its metadata, so an event
 * can only carry ids, counts and enum values: there is no free-form payload, hence no way to put a password, token or other secret
 * in the audit trail by accident. Each domain adds its actions next to these as its phase arrives (projects: step 2.3).
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
  z.object({
    // A signed-in caller who could not prove the CURRENT password (for example someone holding a stolen session). Written like a failed
    // sign-in: in its own short transaction, never replacing the response. `rate_limited` is written once, by the failure that used the
    // attempt budget up; refusals after that are not recorded again. No password, hash or token is ever part of it.
    action: z.literal('auth.password_change_failed'),
    resourceType: z.literal('user'),
    result: failure,
    metadata: z.object({ reason: z.enum(['wrong_current_password', 'rate_limited']) }).strict(),
    ...common,
  }),
  // --- Organizations and memberships (step 2.2). `organizationId` is the organization; `resourceId` the organization or the membership. ---
  z.object({
    action: z.literal('organization.created'),
    resourceType: z.literal('organization'),
    result: success,
    metadata: none,
    ...common,
  }),
  z.object({
    action: z.literal('organization.updated'),
    resourceType: z.literal('organization'),
    result: success,
    /** Names of the fields that changed, never their values. */
    metadata: z.object({ changedFields: z.array(z.enum(['name'])).min(1) }).strict(),
    ...common,
  }),
  z.object({
    action: z.literal('membership.added'),
    resourceType: z.literal('membership'),
    result: success,
    metadata: z.object({ userId: idSchema, role: organizationRoleSchema }).strict(),
    ...common,
  }),
  z.object({
    // `self` is true when the member left on their own.
    action: z.literal('membership.removed'),
    resourceType: z.literal('membership'),
    result: success,
    metadata: z.object({ userId: idSchema, role: organizationRoleSchema, self: z.boolean() }).strict(),
    ...common,
  }),
  z.object({
    action: z.literal('membership.role_changed'),
    resourceType: z.literal('membership'),
    result: success,
    metadata: z
      .object({ userId: idSchema, previousRole: organizationRoleSchema, role: organizationRoleSchema })
      .strict(),
    ...common,
  }),
  z.object({
    // Emitted IN ADDITION to membership.added / role_changed whenever a user becomes an owner.
    action: z.literal('organization.owner_granted'),
    resourceType: z.literal('membership'),
    result: success,
    metadata: z.object({ userId: idSchema }).strict(),
    ...common,
  }),
  z.object({
    // Emitted IN ADDITION to membership.removed / role_changed whenever a user stops being an owner.
    action: z.literal('organization.owner_revoked'),
    resourceType: z.literal('membership'),
    result: success,
    metadata: z.object({ userId: idSchema }).strict(),
    ...common,
  }),
  // --- Projects and project members (step 2.3). `projectId` is the project; `resourceId` the project or the project_member row. ---
  z.object({
    // Written once for every project, in the same transaction as the creator's project_member.added.
    action: z.literal('project.created'),
    resourceType: z.literal('project'),
    result: success,
    metadata: none,
    ...common,
  }),
  z.object({
    // Field names only, never the new values.
    action: z.literal('project.updated'),
    resourceType: z.literal('project'),
    result: success,
    metadata: z.object({ changedFields: z.array(z.enum(['name', 'description'])).min(1) }).strict(),
    ...common,
  }),
  z.object({
    // Only when the state really changed: a repeated archive writes nothing.
    action: z.literal('project.archived'),
    resourceType: z.literal('project'),
    result: success,
    metadata: none,
    ...common,
  }),
  z.object({
    action: z.literal('project.restored'),
    resourceType: z.literal('project'),
    result: success,
    metadata: none,
    ...common,
  }),
  z.object({
    // Written exactly once for every project_member row ever created. `origin` tells the creator's automatic initial grant apart from an
    // explicit add without relying on event order.
    action: z.literal('project_member.added'),
    resourceType: z.literal('project_member'),
    result: success,
    metadata: z
      .object({ userId: idSchema, role: projectRoleSchema, origin: z.enum(['added', 'project_created']) })
      .strict(),
    ...common,
  }),
  z.object({
    action: z.literal('project_member.role_changed'),
    resourceType: z.literal('project_member'),
    result: success,
    metadata: z
      .object({ userId: idSchema, previousRole: projectRoleSchema, role: projectRoleSchema })
      .strict(),
    ...common,
  }),
  z.object({
    // `organization_membership_removed`: the user's organization membership ended and the cleanup removed this row in the same transaction.
    action: z.literal('project_member.removed'),
    resourceType: z.literal('project_member'),
    result: success,
    metadata: z
      .object({
        userId: idSchema,
        role: projectRoleSchema,
        reason: z.enum(['removed', 'organization_membership_removed']),
      })
      .strict(),
    ...common,
  }),
]);

/** What a caller passes to `AuditRecorder.record` (defaults not yet applied). */
export type AuditEventInput = z.input<typeof auditEventSchema>;
export type AuditEvent = z.output<typeof auditEventSchema>;
export type AuditAction = AuditEvent['action'];
export const AUDIT_ACTIONS = auditEventSchema.options.map((option) => option.shape.action.value);
