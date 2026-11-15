import type { Project } from '@agentos/contracts';
import type { ProjectView } from '../domain/project';

/** Domain records to the public contract shapes. The only place dates become wire values. */
export function toProjectDto({ project, projectRole }: ProjectView): Project {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    description: project.description,
    status: project.status,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    projectRole,
  };
}
