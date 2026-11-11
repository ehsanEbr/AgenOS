import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('defaults to the same-origin API path', () => {
    expect(parseEnv({}).apiBaseUrl).toBe('/api/v1');
    expect(parseEnv({ VITE_API_BASE_URL: '  ' }).apiBaseUrl).toBe('/api/v1');
  });

  it('normalizes a trailing slash', () => {
    expect(parseEnv({ VITE_API_BASE_URL: 'https://api.example.test/api/v1/' }).apiBaseUrl).toBe(
      'https://api.example.test/api/v1',
    );
  });

  it('rejects non-string values', () => {
    expect(() => parseEnv({ VITE_API_BASE_URL: 42 })).toThrow('Invalid web environment configuration');
  });
});
