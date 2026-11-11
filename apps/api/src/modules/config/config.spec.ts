import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig } from './config';

describe('loadApiConfig', () => {
  it('applies safe defaults', () => {
    const cfg = loadApiConfig({});
    expect(cfg).toMatchObject({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 3000,
      CORS_ORIGINS: [],
    });
  });

  it('parses and coerces values', () => {
    const cfg = loadApiConfig({ API_PORT: '8080', CORS_ORIGINS: 'http://a.test, http://b.test,' });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('fails fast naming the variable but not its value', () => {
    try {
      loadApiConfig({ API_PORT: 'secret-not-a-port' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain('API_PORT');
      expect((e as ConfigError).message).not.toContain('secret-not-a-port');
    }
  });
});
