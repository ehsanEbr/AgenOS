import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadWorkerConfig } from './index';

const valid = {
  DATABASE_URL: 'postgresql://u:secret-pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadApiConfig', () => {
  it('applies defaults and parses CORS origins', () => {
    const cfg = loadApiConfig({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test,' });
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('coerces the port', () => {
    expect(loadApiConfig({ ...valid, API_PORT: '8080' }).API_PORT).toBe(8080);
  });

  it('reports invalid variables without leaking values', () => {
    try {
      loadApiConfig({ DATABASE_URL: 'not a url with secret-pass', REDIS_URL: valid.REDIS_URL });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain('DATABASE_URL');
      expect((e as ConfigError).message).not.toContain('secret-pass');
    }
  });
});

describe('loadWorkerConfig', () => {
  it('defaults concurrency', () => {
    expect(loadWorkerConfig(valid).WORKER_CONCURRENCY).toBe(5);
  });
});
