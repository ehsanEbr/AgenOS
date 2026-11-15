import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  booleanSchema,
  csvSchema,
  logLevelSchema,
  nodeEnvSchema,
  parseConfig,
  postgresUrlSchema,
  redactUrl,
  redisUrlSchema,
} from './index';

const schema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  REDIS_URL: redisUrlSchema,
  LIST: csvSchema.default([]),
});

describe('parseConfig', () => {
  it('applies defaults and parses values', () => {
    const cfg = parseConfig(schema, { REDIS_URL: 'redis://:pw@127.0.0.1:6379', LIST: 'a, b,' });
    expect(cfg).toMatchObject({ NODE_ENV: 'development', LOG_LEVEL: 'info', LIST: ['a', 'b'] });
  });

  it('names the failing variables and never echoes their values', () => {
    try {
      parseConfig(schema, { REDIS_URL: 'http://user:super-secret@host', LOG_LEVEL: 'loud-secret' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const message = (e as ConfigError).message;
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('LOG_LEVEL');
      expect(message).not.toContain('super-secret');
      expect(message).not.toContain('loud-secret');
    }
  });
});

describe('url schemas', () => {
  it('accepts the expected schemes only', () => {
    expect(redisUrlSchema.safeParse('redis://localhost:6379').success).toBe(true);
    expect(redisUrlSchema.safeParse('rediss://localhost:6380').success).toBe(true);
    expect(redisUrlSchema.safeParse('http://localhost').success).toBe(false);
    expect(postgresUrlSchema.safeParse('postgres://u:p@h/db').success).toBe(true);
    expect(postgresUrlSchema.safeParse('mysql://u:p@h/db').success).toBe(false);
  });
});

describe('redactUrl', () => {
  it('keeps protocol, host and port and drops credentials, path and query', () => {
    expect(redactUrl('redis://default:hunter2@cache.internal:6380/3?x=y')).toBe(
      'redis://cache.internal:6380',
    );
  });

  it('does not echo input it cannot parse', () => {
    expect(redactUrl('not a url with hunter2')).toBe('(invalid url)');
  });
});

describe('booleanSchema', () => {
  it('accepts exactly "true" and "false"', () => {
    expect(booleanSchema.parse('true')).toBe(true);
    expect(booleanSchema.parse('false')).toBe(false);
  });

  it('rejects anything else, so a typo cannot silently mean "off" or "on"', () => {
    for (const value of ['ture', 'TRUE', '1', '0', 'yes', '', ' true'])
      expect(booleanSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});
