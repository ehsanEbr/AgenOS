import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { AuditRecorder } from '../../audit';
import type { DatabaseClient } from '../../database';
import {
  MembershipLifecycle,
  type MembershipRemoval,
  type MembershipRemovalParticipant,
} from '../../organizations';
import { PROJECT_MEMBER_REPOSITORY, type ProjectMemberRepository } from './ports';

/**
 * The projects side of ending an organization membership (ADR-0011, decision 3). When a user's organization membership is removed (by
 * an administrator, or by the user leaving), the organizations module calls this inside the removal's transaction, before it deletes
 * the membership row, and it removes that user's project memberships in that organization.
 *
 *  - It uses the transaction it is given: the deletes and the `project_member.removed` events commit with the removal or not at all.
 *  - A failure is not caught: it rolls the whole removal back, the membership stays.
 *  - It ignores whether a project is archived (a user who left loses access to archived projects too).
 *  - It takes NO project lock, only deletes its own rows (lock order rule R3).
 *
 * Registration happens while the application starts, and a check at bootstrap refuses to start if it did not take (so the foreign key
 * backstop is never the normal way a removal ends).
 */
@Injectable()
export class ProjectMembershipCleanup
  implements MembershipRemovalParticipant, OnModuleInit, OnApplicationBootstrap
{
  readonly name = 'projects.project-membership-cleanup';

  constructor(
    @Inject(PROJECT_MEMBER_REPOSITORY) private readonly members: ProjectMemberRepository,
    private readonly audit: AuditRecorder,
    private readonly lifecycle: MembershipLifecycle,
  ) {}

  onModuleInit(): void {
    this.lifecycle.registerRemovalParticipant(this);
  }

  /** Runs after every module's `onModuleInit`: the application does not start with Projects enabled and its cleanup not registered. */
  onApplicationBootstrap(): void {
    if (!this.lifecycle.isRegistered(this.name))
      throw new Error(
        `The projects module is enabled but its membership removal participant "${this.name}" is not registered with the organizations module. ` +
          'Organization members could not be removed without orphaning their project memberships, so the application refuses to start.',
      );
  }

  async onMembershipRemoved(removal: MembershipRemoval, tx: DatabaseClient): Promise<void> {
    const removed = await this.members.deleteAllOfUserInOrganization(
      removal.organizationId,
      removal.userId,
      tx,
    );
    for (const row of removed)
      await this.audit.record(
        {
          action: 'project_member.removed',
          resourceType: 'project_member',
          result: 'success',
          actorUserId: removal.actorUserId,
          organizationId: removal.organizationId,
          projectId: row.projectId,
          resourceId: row.id,
          metadata: { userId: removal.userId, role: row.role, reason: 'organization_membership_removed' },
        },
        tx,
      );
  }
}
