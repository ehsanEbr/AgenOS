import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { withTimeout } from '../../../common/with-timeout';
import { RedisService } from '../../redis';
import { authenticationUnavailable, tooManyAttempts } from '../application/errors';
import type { Throttle } from '../application/ports';
import { THROTTLE_RULES, type ThrottleScope } from '../domain/throttle-policy';

/** A Redis round trip that takes longer than this is treated as "unavailable": sign-in must fail closed quickly, not hang. */
const COMMAND_TIMEOUT_MS = 2_000;

/**
 * Rate-limit counters in Redis (ephemeral by design; PostgreSQL stays the source of truth for everything else).
 *
 * - Keys carry a SHA-256 of the subject (an email, a client address, a user id), never the raw value.
 * - Every method FAILS CLOSED: if Redis cannot answer, it throws `authentication_unavailable` (503), so an outage can never turn into
 *   unlimited attempts. Only operations that need the limiter use it; session validation does not.
 */
export class RedisThrottle implements Throttle {
  private readonly logger = new Logger(RedisThrottle.name);

  constructor(
    private readonly redis: RedisService,
    private readonly prefix: string,
  ) {}

  async ensureWithinLimit(scope: ThrottleScope, subject: string): Promise<void> {
    const key = this.key(scope, subject);
    const [count, ttlMs] = await this.unavailableIfFails(async () => {
      const results = await this.redis.client.multi().get(key).pttl(key).exec();
      return [Number(results?.[0]?.[1] ?? 0), Number(results?.[1]?.[1] ?? -1)] as const;
    });
    if (count >= THROTTLE_RULES[scope].max) {
      const retryAfter = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : THROTTLE_RULES[scope].windowSeconds;
      throw tooManyAttempts(retryAfter);
    }
  }

  async hit(scope: ThrottleScope, subject: string): Promise<{ exhausted: boolean }> {
    const key = this.key(scope, subject);
    const rule = THROTTLE_RULES[scope];
    const count = await this.unavailableIfFails(async () => {
      // EXPIRE ... NX sets the window only on the first event, so the window does not slide while attempts continue.
      const results = await this.redis.client.multi().incr(key).expire(key, rule.windowSeconds, 'NX').exec();
      const reply = results?.[0];
      if (!reply || reply[0]) throw reply?.[0] ?? new Error('empty reply');
      return Number(reply[1]);
    });
    return { exhausted: count === rule.max };
  }

  async reset(scope: ThrottleScope, subject: string): Promise<void> {
    await this.unavailableIfFails(() => this.redis.client.del(this.key(scope, subject)));
  }

  private key(scope: ThrottleScope, subject: string): string {
    return `${this.prefix}:${scope}:${createHash('sha256').update(subject, 'utf8').digest('hex')}`;
  }

  private async unavailableIfFails<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(operation(), COMMAND_TIMEOUT_MS, 'Redis rate limit');
    } catch (error) {
      // The error class only: driver messages can contain connection details.
      this.logger.warn(`The rate limiter is unavailable (${error instanceof Error ? error.name : 'error'})`);
      throw authenticationUnavailable();
    }
  }
}
