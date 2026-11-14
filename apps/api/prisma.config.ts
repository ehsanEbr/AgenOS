import path from 'node:path';
import { defineConfig } from 'prisma/config';

// With a prisma.config.ts, Prisma no longer loads .env files itself. Load the repository-level .env
// (if present) so `pnpm db:*` works locally; in CI/production the variables come from the environment.
try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
} catch {
  // No .env file: rely on variables already present in the environment.
}

export default defineConfig({
  schema: path.join('prisma', 'schema'),
  migrations: { path: path.join('prisma', 'migrations') },
});
