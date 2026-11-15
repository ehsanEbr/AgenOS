import type { Member, Organization, OrganizationWithRole } from '@agentos/contracts';
import type { MemberView } from '../application/membership.service';
import type { MembershipOfUser, OrganizationRecord } from '../domain/organization';

/** Domain records to the public contract shapes. The only place dates become wire values. */
export function toOrganizationDto(organization: OrganizationRecord): Organization {
  return {
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

export function toOrganizationWithRoleDto({ organization, role }: MembershipOfUser): OrganizationWithRole {
  return { ...toOrganizationDto(organization), role };
}

export function toMemberDto({ membership, user }: MemberView): Member {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: membership.role,
    joinedAt: membership.createdAt.toISOString(),
  };
}
