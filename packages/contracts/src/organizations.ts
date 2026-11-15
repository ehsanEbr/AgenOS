import { z } from 'zod';
import { emailSchema } from './identity';
import { organizationRoleSchema } from './permissions';
import { idSchema, isoDateTimeSchema } from './primitives';

/*
 * Organization contracts (ADR-0010): organizations and the memberships that tie users to them. These schemas validate requests on the
 * API and type responses in the web app; they contain no framework code.
 */

export const organizationNameSchema = z.string().trim().min(1).max(100);

export const organizationSchema = z.object({
  id: idSchema,
  name: z.string(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Organization = z.infer<typeof organizationSchema>;

/** An organization as seen by one of its members: it carries THAT member's role. */
export const organizationWithRoleSchema = organizationSchema.extend({ role: organizationRoleSchema });
export type OrganizationWithRole = z.infer<typeof organizationWithRoleSchema>;

export const createOrganizationRequestSchema = z.object({ name: organizationNameSchema });
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;

export const updateOrganizationRequestSchema = z.object({ name: organizationNameSchema });
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;

/** A member of an organization. The email is shown only to members of that organization (decision 8). */
export const memberSchema = z.object({
  userId: idSchema,
  email: z.string(),
  displayName: z.string(),
  role: organizationRoleSchema,
  joinedAt: isoDateTimeSchema,
});
export type Member = z.infer<typeof memberSchema>;

/** Adds an EXISTING user, by email. There are no invitations in this phase (ADR-0010, decision 2). */
export const addMemberRequestSchema = z.object({
  email: emailSchema,
  role: organizationRoleSchema,
});
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>;

export const updateMemberRequestSchema = z.object({ role: organizationRoleSchema });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

/** Stable error codes the organizations API uses, so clients can switch on them. */
export const ORGANIZATION_ERROR_CODES = {
  /** Also the answer for an organization that exists but the caller does not belong to: the two are indistinguishable. */
  organizationNotFound: 'organization_not_found',
  /** A member of the organization lacks the permission the route needs. */
  forbidden: 'forbidden',
  memberNotFound: 'member_not_found',
  userNotFound: 'user_not_found',
  alreadyMember: 'already_member',
  /** The change would leave the organization without an owner. */
  lastOwner: 'last_owner',
} as const;
