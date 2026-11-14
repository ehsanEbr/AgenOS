import { defineConfig } from 'vitest/config';

// System tests drive Docker. They are slow by nature (image builds, container restarts), so the timeouts are generous and
// files run one after another: each file owns a complete, throwaway Compose project.
export default defineConfig({
  test: {
    include: ['test/**/*.system.spec.ts'],
    globalSetup: ['./global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
