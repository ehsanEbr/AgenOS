import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
