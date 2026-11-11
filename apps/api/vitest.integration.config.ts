import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Integration tests need the docker compose stack (PostgreSQL + Redis): `pnpm infra:up`.
// No worker runs here; the worker side of the flow is covered in apps/agent-worker.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.spec.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
