import type { SessionInfo, User } from '@agentos/contracts';
import type { SessionRecord } from '../domain/session';
import type { UserRecord } from '../domain/user';

/** Domain records to the public contract shapes. The only place ids, dates and statuses become wire values. */
export function toUserDto(user: UserRecord): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toSessionInfo(session: SessionRecord): SessionInfo {
  return {
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.absoluteExpiresAt.toISOString(),
    idleExpiresAt: session.idleExpiresAt.toISOString(),
  };
}

/** The address rate limiting is keyed by. Express already applied the trusted-proxy rules to `request.ip`. */
export function clientOf(request: {
  ip?: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const userAgent = request.headers['user-agent'];
  return {
    address: request.ip ?? 'unknown',
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}
