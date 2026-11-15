import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// Integration tests use the REAL Redis from `pnpm infra:up` (repository .env, or the process environment in CI; real
// environment variables win). Every test uses its own queue prefix inside logical database 15 and removes its keys
// afterwards, so tests are isolated from each other and from development data.
function loadDotEnv(): Record<string, string> {
  try {
    return parseEnv(readFileSync(resolve(__dirname, '../../.env'), 'utf8')) as Record<string, string>;
  } catch {
    return {}; // no .env file: variables must come from the environment
  }
}

const processEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export default defineConfig({
  test: {
    include: ['test/**/*.int.spec.ts'],
    env: { ...loadDotEnv(), ...processEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
