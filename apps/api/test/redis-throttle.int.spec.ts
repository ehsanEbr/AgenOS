import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppError } from '../src/common/app-error';
import { type ApiConfig, loadApiConfig } from '../src/modules/config';
import { THROTTLE_RULES } from '../src/modules/identity/domain/throttle-policy';
import { RedisThrottle } from '../src/modules/identity/infrastructure/redis-throttle';
import { RedisService } from '../src/modules/redis';

// Requires `pnpm infra:up`. Keys live under a unique prefix in logical database 15 and are removed afterwards.

function redisUrl(base: string, database = '/15'): string {
  const parsed = new URL(base);
  parsed.pathname = database;
  return parsed.toString();
}

const prefix = `it:${randomBytes(4).toString('hex')}:throttle`;
let redis: RedisService;
let throttle: RedisThrottle;
const subject = () => `subject-${randomBytes(4).toString('hex')}@example.com`;

beforeAll(async () => {
  redis = new RedisService({ REDIS_URL: redisUrl(loadApiConfig().REDIS_URL) } as ApiConfig);
  await redis.onModuleInit();
  throttle = new RedisThrottle(redis, prefix);
});

afterAll(async () => {
  const keys = await redis.client.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.client.del(...keys);
  await redis.onModuleDestroy();
});

const keyOf = (scope: string, value: string) =>
  `${prefix}:${scope}:${createHash('sha256').update(value).digest('hex')}`;

describe('RedisThrottle (real Redis)', () => {
  it('counts events, reports exhaustion on exactly the event that uses the budget up, and then refuses with Retry-After', async () => {
    const who = subject();
    const { max } = THROTTLE_RULES['password-account'];
    await throttle.ensureWithinLimit('password-account', who); // nothing counted yet: allowed

    const exhausted: boolean[] = [];
    for (let i = 0; i < max + 2; i++) exhausted.push((await throttle.hit('password-account', who)).exhausted);
    expect(exhausted.filter(Boolean)).toHaveLength(1);
    expect(exhausted.indexOf(true)).toBe(max - 1);

    const refusal = (await throttle
      .ensureWithinLimit('password-account', who)
      .catch((e: unknown) => e)) as AppError;
    expect(refusal).toMatchObject({ kind: 'rate_limited', code: 'too_many_attempts' });
    expect(refusal.retryAfterSeconds).toBeGreaterThan(0);
    expect(refusal.retryAfterSeconds).toBeLessThanOrEqual(THROTTLE_RULES['password-account'].windowSeconds);
  });

  it('keeps the budget per subject and per scope', async () => {
    const [a, b] = [subject(), subject()];
    for (let i = 0; i < THROTTLE_RULES['password-account'].max; i++)
      await throttle.hit('password-account', a);
    await expect(throttle.ensureWithinLimit('password-account', a)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    await expect(throttle.ensureWithinLimit('password-account', b)).resolves.toBeUndefined();
    await expect(throttle.ensureWithinLimit('signin-account', a)).resolves.toBeUndefined();
  });

  it('stores only a SHA-256 of the subject in the key, never the email or address itself', async () => {
    const who = subject();
    await throttle.hit('signin-account', who);
    const keys = await redis.client.keys(`${prefix}:signin-account:*`);
    expect(keys).toContain(keyOf('signin-account', who));
    for (const key of keys) expect(key).not.toContain(who);
  });

  it('starts the window with the first event and does not slide it while attempts continue', async () => {
    const who = subject();
    await throttle.hit('signin-address', who);
    const first = await redis.client.pttl(keyOf('signin-address', who));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(THROTTLE_RULES['signin-address'].windowSeconds * 1000);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await throttle.hit('signin-address', who);
    const second = await redis.client.pttl(keyOf('signin-address', who));
    expect(second).toBeLessThan(first); // a second event did NOT reset the window to its full length
  });

  it('forgives an account when it is reset', async () => {
    const who = subject();
    for (let i = 0; i < THROTTLE_RULES['signin-account'].max; i++) await throttle.hit('signin-account', who);
    await expect(throttle.ensureWithinLimit('signin-account', who)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    await throttle.reset('signin-account', who);
    await expect(throttle.ensureWithinLimit('signin-account', who)).resolves.toBeUndefined();
  });

  it('fails CLOSED when Redis is unreachable: every operation answers authentication_unavailable, promptly', async () => {
    const dead = new RedisService({ REDIS_URL: 'redis://:nothing@127.0.0.1:1/15' } as ApiConfig);
    await dead.onModuleInit();
    try {
      const broken = new RedisThrottle(dead, prefix);
      for (const operation of [
        () => broken.ensureWithinLimit('signin-account', 'x'),
        () => broken.hit('signin-account', 'x'),
        () => broken.reset('signin-account', 'x'),
      ]) {
        const started = Date.now();
        await expect(operation()).rejects.toMatchObject({
          kind: 'unavailable',
          code: 'authentication_unavailable',
        });
        expect(Date.now() - started).toBeLessThan(4_000);
      }
    } finally {
      await dead.onModuleDestroy();
    }
  });
});
