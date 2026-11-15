import type { OrganizationRole } from '@agentos/contracts';

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MembershipRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly createdAt: Date;
}

/** An organization together with the role of one particular member in it. */
export interface MembershipOfUser {
  readonly organization: OrganizationRecord;
  readonly role: OrganizationRole;
}
