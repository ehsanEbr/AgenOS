import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig } from './config';

const infra = {
  DATABASE_URL: 'postgresql://user:db-secret@127.0.0.1:5432/app?schema=public',
  REDIS_URL: 'redis://:redis-secret@127.0.0.1:6379',
};

describe('loadApiConfig', () => {
  it('applies safe defaults for non-infrastructure settings', () => {
    const cfg = loadApiConfig(infra);
    expect(cfg).toMatchObject({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      CORS_ORIGINS: [],
    });
  });

  it('parses and coerces values', () => {
    const cfg = loadApiConfig({ ...infra, API_PORT: '8080', CORS_ORIGINS: 'http://a.test, http://b.test,' });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(cfg.DATABASE_URL).toBe(infra.DATABASE_URL);
  });

  it('accepts postgres:// and rediss:// schemes', () => {
    expect(
      loadApiConfig({
        DATABASE_URL: 'postgres://u:p@db.internal/app',
        REDIS_URL: 'rediss://:p@cache.internal:6380',
      }),
    ).toBeTruthy();
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    try {
      loadApiConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues.join(' ')).toMatch(/DATABASE_URL/);
      expect((e as ConfigError).issues.join(' ')).toMatch(/REDIS_URL/);
    }
  });

  it('rejects URLs with the wrong scheme', () => {
    expect(() => loadApiConfig({ ...infra, DATABASE_URL: 'mysql://u:p@127.0.0.1/app' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadApiConfig({ ...infra, REDIS_URL: 'http://127.0.0.1:6379' })).toThrow(/REDIS_URL/);
  });

  it('fails fast naming the variable but never echoing credentials', () => {
    try {
      loadApiConfig({
        DATABASE_URL: 'mysql://user:db-secret@127.0.0.1/app',
        REDIS_URL: infra.REDIS_URL,
        API_PORT: 'x-secret',
      });
      expect.unreachable();
    } catch (e) {
      const message = (e as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('API_PORT');
      expect(message).not.toContain('db-secret');
      expect(message).not.toContain('x-secret');
    }
  });
});
