import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { type DatabaseClient, PrismaService, isUniqueConstraintViolation } from '../../database';
import { emailTaken } from '../application/errors';
import type { NewUser, UserRepository } from '../application/ports';
import type { UserRecord } from '../domain/user';

/** Arbitrary but fixed key of the advisory lock that serializes registrations (see `lockRegistration`). */
const REGISTRATION_LOCK_KEY = 7_364_201_901n;

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
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string, db: DatabaseClient = this.prisma): Promise<UserRecord | null> {
    const row = await db.user.findUnique({ where: { email } });
    return row && toUserRecord(row);
  }

  async findById(id: string, db: DatabaseClient = this.prisma): Promise<UserRecord | null> {
    const row = await db.user.findUnique({ where: { id } });
    return row && toUserRecord(row);
  }

  async hasAnyUser(db: DatabaseClient = this.prisma): Promise<boolean> {
    return (await db.user.findFirst({ select: { id: true } })) !== null;
  }

  async lockRegistration(db: DatabaseClient): Promise<void> {
    // Held until the surrounding transaction ends. A second registration waits here, then sees the first user.
    // `pg_advisory_xact_lock` returns `void`, a column type Prisma cannot read back, so wrap it in a query that returns an integer.
    await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${REGISTRATION_LOCK_KEY})) AS registration_lock`;
  }

  async create(user: NewUser, db: DatabaseClient): Promise<UserRecord> {
    try {
      return toUserRecord(
        await db.user.create({ data: { email: user.email, displayName: user.displayName } }),
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw emailTaken();
      throw error;
    }
  }

  async findPasswordHash(userId: string, db: DatabaseClient = this.prisma): Promise<string | null> {
    const row = await db.credential.findUnique({ where: { userId }, select: { passwordHash: true } });
    return row?.passwordHash ?? null;
  }

  async createCredential(userId: string, passwordHash: string, db: DatabaseClient): Promise<void> {
    await db.credential.create({ data: { userId, passwordHash }, select: { userId: true } });
  }

  async updatePasswordHash(userId: string, passwordHash: string, db: DatabaseClient): Promise<void> {
    await db.credential.update({ where: { userId }, data: { passwordHash }, select: { userId: true } });
  }
}
