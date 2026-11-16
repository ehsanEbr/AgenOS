import { Inject, Injectable } from '@nestjs/common';
import type { ProjectRole } from '@agentos/contracts';
import { AuditRecorder } from '../../audit';
import { type DatabaseClient, TransactionRunner } from '../../database';
import { UserDirectory, type UserSummary } from '../../identity';
import { MembershipDirectory } from '../../organizations';
import { isArchived, type ProjectMemberRecord } from '../domain/project';
import type { ProjectContext } from '../domain/project-context';
import {
  alreadyProjectMember,
  organizationMemberNotFound,
  projectArchived,
  projectMemberNotFound,
} from './errors';
import { ProjectAccess } from './project-access';
import type { ProjectEventBody } from './project.service';
import {
  PROJECT_MEMBER_REPOSITORY,
  type PageOf,
  type PageRequest,
  type ProjectMemberRepository,
} from './ports';

/** A project membership with the identity facts about the member (read through the public `UserDirectory`). */
export interface ProjectMemberView {
  readonly member: ProjectMemberRecord;
  readonly user: UserSummary;
}

/**
 * The members of ONE project: list, add, change a role, remove (ADR-0011).
 *
 * Every CHANGE is one transaction that follows the lock order of ADR-0011 decision 9:
 *   L2  take the project lock and re-check the actor from the database (`ProjectAccess.begin`);
 *   L3  adding only: hold the target's organization membership (`FOR SHARE`), ONE row and never the actor's (rule R2);
 *   L4  write the project_member row, then its audit event.
 * An archived project accepts no member change. Nothing here takes an organization-level lock.
 */
@Injectable()
export class ProjectMemberService {
  constructor(
    @Inject(PROJECT_MEMBER_REPOSITORY) private readonly members: ProjectMemberRepository,
    private readonly access: ProjectAccess,
    private readonly directory: MembershipDirectory,
    private readonly users: UserDirectory,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditRecorder,
  ) {}

  async list(context: ProjectContext, page: PageRequest): Promise<PageOf<ProjectMemberView>> {
    const result = await this.members.list(context.scope, page);
    return { total: result.total, items: await this.withUsers(result.items) };
  }

  /**
   * Adds an existing member of the project's organization, by user id. A user who does not exist and a user who is not a member of the
   * organization give the same answer, so this is not an oracle for accounts.
   */
  async add(
    context: ProjectContext,
    input: { userId: string; projectRole: ProjectRole },
  ): Promise<ProjectMemberView> {
    const member = await this.transactions.run(async (tx) => {
      const fresh = await this.access.begin(context, 'project.member.manage', tx); // L2
      if (isArchived(fresh.project)) throw projectArchived();
      // L3: the target's organization membership, held (FOR SHARE) until this transaction ends. A removal of that membership either
      // finished before (nothing is inserted: 404) or waits for us and then cleans up the row we are about to write.
      if (!(await this.directory.holdMember(fresh.tenant.organizationId, input.userId, tx)))
        throw organizationMemberNotFound();
      if (await this.members.find(fresh.scope, input.userId, tx)) throw alreadyProjectMember();
      const created = await this.members.add(
        fresh.scope,
        { userId: input.userId, role: input.projectRole },
        tx,
      ); // L4
      await this.record(
        fresh.tenant.userId,
        fresh.project.organizationId,
        fresh.project.id,
        created.id,
        {
          action: 'project_member.added',
          resourceType: 'project_member',
          metadata: { userId: created.userId, role: created.role, origin: 'added' },
        },
        tx,
      );
      return created;
    });
    return this.view(member);
  }

  async changeRole(context: ProjectContext, userId: string, role: ProjectRole): Promise<ProjectMemberView> {
    const member = await this.transactions.run(async (tx) => {
      const fresh = await this.access.begin(context, 'project.member.manage', tx);
      if (isArchived(fresh.project)) throw projectArchived();
      const current = await this.members.find(fresh.scope, userId, tx);
      if (!current) throw projectMemberNotFound();
      if (current.role === role) return current; // nothing changes, nothing is recorded
      const updated = await this.members.setRole(fresh.scope, userId, role, tx);
      await this.record(
        fresh.tenant.userId,
        fresh.project.organizationId,
        fresh.project.id,
        updated.id,
        {
          action: 'project_member.role_changed',
          resourceType: 'project_member',
          metadata: { userId, previousRole: current.role, role },
        },
        tx,
      );
      return updated;
    });
    return this.view(member);
  }

  async remove(context: ProjectContext, userId: string): Promise<void> {
    await this.transactions.run(async (tx) => {
      const fresh = await this.access.begin(context, 'project.member.manage', tx);
      if (isArchived(fresh.project)) throw projectArchived();
      const current = await this.members.find(fresh.scope, userId, tx);
      if (!current) throw projectMemberNotFound();
      if (!(await this.members.remove(fresh.scope, userId, tx))) throw projectMemberNotFound(); // removed by a concurrent cleanup
      await this.record(
        fresh.tenant.userId,
        fresh.project.organizationId,
        fresh.project.id,
        current.id,
        {
          action: 'project_member.removed',
          resourceType: 'project_member',
          metadata: { userId, role: current.role, reason: 'removed' },
        },
        tx,
      );
    });
  }

  private record(
    actorUserId: string,
    organizationId: string,
    projectId: string,
    resourceId: string,
    event: ProjectEventBody,
    tx: DatabaseClient,
  ): Promise<void> {
    return this.audit.record(
      { ...event, result: 'success', actorUserId, organizationId, projectId, resourceId },
      tx,
    );
  }

  private async view(member: ProjectMemberRecord): Promise<ProjectMemberView> {
    const [view] = await this.withUsers([member]);
    if (!view) throw projectMemberNotFound();
    return view;
  }

  private async withUsers(members: ProjectMemberRecord[]): Promise<ProjectMemberView[]> {
    const users = new Map(
      (await this.users.findByIds(members.map((member) => member.userId))).map((user) => [user.id, user]),
    );
    // A project membership always has a user (the membership foreign key); the filter only keeps the types honest.
    return members.flatMap((member) => {
      const user = users.get(member.userId);
      return user ? [{ member, user }] : [];
    });
  }
}
