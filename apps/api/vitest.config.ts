import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so NestJS decorator metadata (constructor injection) is emitted under Vitest.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.e2e.spec.ts'],
    // Unit tests never reach real infrastructure: these URLs point at a closed port and carry no real secrets.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?schema=public',
      REDIS_URL: 'redis://:test@127.0.0.1:1',
    },
  },
});
