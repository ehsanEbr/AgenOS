import { defineConfig } from 'vitest/config';

// Needs the docker compose stack (PostgreSQL + Redis) with migrations applied: `pnpm infra:up && pnpm db:deploy`.
export default defineConfig({
  test: {
    include: ['test/**/*.int.spec.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
