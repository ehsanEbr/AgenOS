import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests talk to REAL PostgreSQL and Redis from `pnpm infra:up`, using the repository .env
// (or the process environment in CI; real environment variables win). They only run read-only/namespaced
// operations: `SELECT 1`, and Redis keys under a unique `it:` prefix inside logical database 15, which
// they remove afterwards.
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
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.spec.ts'],
    env: { ...loadDotEnv(), ...processEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
