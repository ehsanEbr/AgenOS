import { Inject, Injectable } from '@nestjs/common';
import { canonicalizeEmail } from '@agentos/contracts';
import type { UserStatus } from '../domain/user';
import { USER_REPOSITORY, type UserRepository } from './ports';

/** What other modules may know about a user. Plain data: no credentials, no Prisma type. */
export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
}

/**
 * The public way for other modules to look a user up (ADR-0010, decision 1). It exposes the Identity-owned facts and nothing
 * else, so no module needs to reach into Identity's repositories or tables.
 */
@Injectable()
export class UserDirectory {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async findById(id: string): Promise<UserSummary | null> {
    return summarize(await this.users.findById(id));
  }

  async findByEmail(email: string): Promise<UserSummary | null> {
    return summarize(await this.users.findByEmail(canonicalizeEmail(email)));
  }
}

function summarize(
  user: { id: string; email: string; displayName: string; status: UserStatus } | null,
): UserSummary | null {
  return user && { id: user.id, email: user.email, displayName: user.displayName, status: user.status };
}
