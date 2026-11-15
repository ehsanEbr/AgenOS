import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('defaults to the same-origin API path and a 15 s timeout', () => {
    expect(parseEnv({})).toEqual({ apiBaseUrl: '/api/v1', apiTimeoutMs: 15_000, isDev: false });
    expect(parseEnv({ VITE_API_BASE_URL: '  ' }).apiBaseUrl).toBe('/api/v1');
  });

  it('normalizes a trailing slash', () => {
    expect(parseEnv({ VITE_API_BASE_URL: 'https://api.example.test/api/v1/' }).apiBaseUrl).toBe(
      'https://api.example.test/api/v1',
    );
  });

  it('parses the timeout from text and rejects unreasonable values', () => {
    expect(parseEnv({ VITE_API_TIMEOUT_MS: '30000' }).apiTimeoutMs).toBe(30_000);
    expect(() => parseEnv({ VITE_API_TIMEOUT_MS: '10' })).toThrow('VITE_API_TIMEOUT_MS');
    expect(() => parseEnv({ VITE_API_TIMEOUT_MS: 'soon' })).toThrow('VITE_API_TIMEOUT_MS');
  });

  it('rejects non-string base URLs', () => {
    expect(() => parseEnv({ VITE_API_BASE_URL: 42 })).toThrow('Invalid web environment configuration');
  });
});
