import type { PermissionKey, ProjectRole, ProjectStatus } from '@agentos/contracts';

export interface ProjectRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProjectMemberRecord {
  readonly id: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly createdAt: Date;
}

/** A project together with the caller's EXPLICIT role on it (`null` for access through organization owner/admin alone). */
export interface ProjectView {
  readonly project: ProjectRecord;
  readonly projectRole: ProjectRole | null;
}

export type ProjectPermissionSet = ReadonlySet<PermissionKey>;

/** An archived project is read-only: it can be read and restored, nothing else (ADR-0011, decision 2). */
export const isArchived = (project: Pick<ProjectRecord, 'status'>): boolean => project.status === 'archived';

/** The fields of a project update that really change something, by name (never by value: this goes to the audit trail). */
export function changedProjectFields(
  current: Pick<ProjectRecord, 'name' | 'description'>,
  changes: { readonly name?: string; readonly description?: string | null },
): ('name' | 'description')[] {
  const changed: ('name' | 'description')[] = [];
  if (changes.name !== undefined && changes.name !== current.name) changed.push('name');
  if (changes.description !== undefined && changes.description !== current.description)
    changed.push('description');
  return changed;
}
