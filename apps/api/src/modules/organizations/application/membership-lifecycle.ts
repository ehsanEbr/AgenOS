import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { DatabaseClient } from '../../database';

/**
 * What the organizations module tells a participant when a membership ends (ADR-0011, decision 3).
 *
 * Organizations OWNS the workflow of ending a membership; a participant owns the cleanup of ITS OWN records that depend on it (the
 * projects module owns the project memberships). The dependency points from the participant to this module: `organizations` defines the
 * interface and the registry and imports nothing from the participants.
 */
export interface MembershipRemoval {
  readonly organizationId: string;
  /** The user whose membership ends. */
  readonly userId: string;
  readonly membershipId: string;
  /** Who is removing them (the user themselves when leaving). */
  readonly actorUserId: string;
}

export interface MembershipRemovalParticipant {
  /** Stable identifier, used in errors and logs. Unique among participants. */
  readonly name: string;
  /**
   * Called inside the removal's transaction, after the membership is locked and the removal is authorized, and BEFORE the membership row is
   * deleted (the foreign keys are `RESTRICT`, checked immediately). Do all work, including audit events, with the given `tx`: never open a
   * transaction of your own and never swallow a failure; any exception rolls the whole removal back. Take no lock above your own rows
   * (ADR-0011 decision 9, rule R3).
   */
  onMembershipRemoved(removal: MembershipRemoval, tx: DatabaseClient): Promise<void>;
}

/**
 * The registry of removal participants. Registration is allowed while the application starts (`onModuleInit` of the participant's
 * module) and the set is SEALED when bootstrap completes, so it cannot change while requests are being served. Participants run in
 * registration order.
 */
@Injectable()
export class MembershipLifecycle implements OnApplicationBootstrap {
  private readonly registered: MembershipRemovalParticipant[] = [];
  private sealed = false;

  registerRemovalParticipant(participant: MembershipRemovalParticipant): void {
    if (this.sealed)
      throw new Error(
        `Membership removal participant "${participant.name}" was registered after application bootstrap: the registry is sealed`,
      );
    if (this.isRegistered(participant.name))
      throw new Error(`A membership removal participant named "${participant.name}" is already registered`);
    this.registered.push(participant);
  }

  isRegistered(name: string): boolean {
    return this.registered.some((participant) => participant.name === name);
  }

  /** In registration order. Used only by `MembershipService`. */
  participants(): readonly MembershipRemovalParticipant[] {
    return [...this.registered];
  }

  onApplicationBootstrap(): void {
    this.sealed = true;
  }
}
