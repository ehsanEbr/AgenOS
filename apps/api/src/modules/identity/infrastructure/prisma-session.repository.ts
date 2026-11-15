import { Injectable } from '@nestjs/common';
import type { Session, User } from '@prisma/client';
import { type DatabaseClient, PrismaService } from '../../database';
import type { NewSession, SessionRepository, SessionWithUser } from '../application/ports';
import type { SessionRecord } from '../domain/session';
import type { UserRecord } from '../domain/user';

function toSessionRecord(row: Session): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
    userAgent: row.userAgent,
  };
}

function toUserRecord(row: User): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(session: NewSession, db: DatabaseClient): Promise<SessionRecord> {
    return toSessionRecord(
      await db.session.create({
        data: {
          userId: session.userId,
          tokenHash: session.tokenHash,
          userAgent: session.userAgent,
          createdAt: session.now,
          lastSeenAt: session.now,
          idleExpiresAt: session.idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
        },
      }),
    );
  }

  async findByTokenHash(
    tokenHash: string,
    db: DatabaseClient = this.prisma,
  ): Promise<SessionWithUser | null> {
    const row = await db.session.findUnique({ where: { tokenHash }, include: { user: true } });
    return row && { session: toSessionRecord(row), user: toUserRecord(row.user) };
  }

  async touch(
    id: string,
    lastSeenAt: Date,
    idleExpiresAt: Date,
    db: DatabaseClient = this.prisma,
  ): Promise<void> {
    await db.session.updateMany({ where: { id, revokedAt: null }, data: { lastSeenAt, idleExpiresAt } });
  }

  async revoke(id: string, at: Date, db: DatabaseClient): Promise<boolean> {
    const result = await db.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
    return result.count > 0;
  }

  async revokeAllForUser(
    userId: string,
    at: Date,
    db: DatabaseClient,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        // Only sessions that could still be used are worth revoking (and counting).
        idleExpiresAt: { gt: at },
        absoluteExpiresAt: { gt: at },
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: at },
    });
    return result.count;
  }

  async rotateToken(id: string, newTokenHash: string, db: DatabaseClient): Promise<void> {
    await db.session.update({ where: { id }, data: { tokenHash: newTokenHash }, select: { id: true } });
  }
}
