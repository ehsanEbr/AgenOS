import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiTarget = process.env.VITE_DEV_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev: the browser talks to Vite, which forwards /api to the NestJS API.
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  build: {
    sourcemap: true,
    // The UI library is the bulk of the initial download; see docs/architecture/frontend.md ("Performance").
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Vendor code is split by package family so it caches independently of application code. The function form
        // matters: the object form would also drag every dependency of antd (including react-dom) into the antd chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|react-router|scheduler)\//.test(
              id,
            )
          )
            return 'react';
          if (
            /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(antd|@ant-design|@rc-component|rc-[\w-]+)\//.test(
              id,
            )
          )
            return 'antd';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
    css: false,
    // Vitest's 5 s default is too short for a test that renders the whole application in jsdom on a hosted CI runner (the first hosted
    // run timed out several of them). A test that hangs still fails; a healthy one on a slow machine does not. Slower tests say so
    // themselves (see the tiers in the heavy router specs).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
