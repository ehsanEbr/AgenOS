import { z } from 'zod';
import { paginationQuerySchema } from './pagination';
import { projectRoleSchema } from './permissions';
import { idSchema, isoDateTimeSchema } from './primitives';

/*
 * Project contracts (ADR-0011): projects and the project memberships that give a user a role on ONE project. These schemas validate
 * requests on the API and type responses in the web app; they contain no framework code.
 */

export const projectNameSchema = z.string().trim().min(1).max(100);

/** Lower-case letters, digits and single hyphens. Unique per organization and immutable after creation. */
export const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const projectSlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(PROJECT_SLUG_PATTERN, 'Use lower-case letters, digits and hyphens');

/** Optional text. To remove a description send `null` (an empty string is not a description). */
export const projectDescriptionSchema = z.string().trim().min(1).max(2000);

export const projectStatusSchema = z.enum(['active', 'archived']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: projectStatusSchema,
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** The caller's EXPLICIT role on this project; `null` when they reach it through organization owner/admin access alone. */
  projectRole: projectRoleSchema.nullable(),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * The organization is a SELECTOR, validated against the caller's memberships by the server (a malformed or foreign id is a 404, an
 * absent one a 400). It is never trusted as authority.
 */
export const createProjectRequestSchema = z.object({
  organizationId: z.string().min(1),
  name: projectNameSchema,
  slug: projectSlugSchema,
  description: projectDescriptionSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** Name and description only: the organization and the slug are immutable and cannot be sent. */
export const updateProjectRequestSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: projectDescriptionSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'Send at least one of name and description',
  });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const PROJECT_LIST_STATUSES = ['active', 'archived', 'all'] as const;
export const listProjectsQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1),
  /** Combined with the visibility rule, never instead of it. */
  status: z.enum(PROJECT_LIST_STATUSES).default('active'),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const projectMemberSchema = z.object({
  userId: idSchema,
  email: z.string(),
  displayName: z.string(),
  role: projectRoleSchema,
  joinedAt: isoDateTimeSchema,
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

/** Adds an EXISTING member of the project's organization, by user id (the organization member list is the picker). */
export const addProjectMemberRequestSchema = z.object({
  userId: idSchema,
  projectRole: projectRoleSchema,
});
export type AddProjectMemberRequest = z.infer<typeof addProjectMemberRequestSchema>;

export const updateProjectMemberRequestSchema = z.object({ projectRole: projectRoleSchema });
export type UpdateProjectMemberRequest = z.infer<typeof updateProjectMemberRequestSchema>;

/** Stable error codes the projects API uses, so clients can switch on them. */
export const PROJECT_ERROR_CODES = {
  /** Nonexistent, belonging to another organization, and "you have no access" are indistinguishable. */
  projectNotFound: 'project_not_found',
  projectSlugTaken: 'project_slug_taken',
  /** A change was requested on an archived project (archive/restore themselves are idempotent and never raise this). */
  projectArchived: 'project_archived',
  /** The user does not exist or is not a member of the project's organization: one answer for both. */
  organizationMemberNotFound: 'organization_member_not_found',
  alreadyProjectMember: 'already_project_member',
  projectMemberNotFound: 'project_member_not_found',
} as const;
