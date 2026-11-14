import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const DEEP_IMPORT = {
  group: ['@agentos/*/*'],
  message: 'Import workspace packages through their public entry point only (no deep imports).',
};

// Only workspace *packages* are importable; applications (api, web, any future worker or scheduler) never are.
// This is an allowlist so a new app cannot be imported by accident. Adding a shared package means adding it
// here, which is deliberate friction (spec: extract shared code only with multiple consumers).
const IMPORTABLE_WORKSPACE_PACKAGES = ['contracts'];
const NO_APP_IMPORT = {
  group: ['@agentos/*', ...IMPORTABLE_WORKSPACE_PACKAGES.map((name) => `!@agentos/${name}`)],
  message: 'Applications cannot be imported. Share code through a package (e.g. @agentos/contracts).',
};

// Contracts are consumed by both web and api, so they may not depend on any framework or infrastructure.
const CONTRACTS_FORBIDDEN = {
  group: [
    '@nestjs/*',
    'react',
    'react-*',
    'react/*',
    'antd',
    '@ant-design/*',
    '@tanstack/*',
    'zustand',
    '@prisma/*',
    'prisma',
    'ioredis',
    'bullmq',
    'express',
    'pino',
    'pino-*',
  ],
  message: 'packages/contracts must stay free of framework and infrastructure dependencies (zod only).',
};

// Backend domain modules expose a public index; others may not reach into their internals.
const MODULE_INTERNALS_MESSAGE =
  'Import another module through its index (e.g. "../config"), never its internal files.';
// From outside modules/: "<...>/modules/<name>/<file>".
const MODULE_INTERNALS_FROM_OUTSIDE = { group: ['**/modules/*/*'], message: MODULE_INTERNALS_MESSAGE };
// From inside a module: "../<sibling>/<file>" (but not "../../common/...", which starts with "../..").
const MODULE_INTERNALS_FROM_SIBLING = { regex: '^\\.\\./[^/.][^/]*/.+', message: MODULE_INTERNALS_MESSAGE };

// Infrastructure drivers are confined to their own API module so domain code never depends on them
// (and Prisma types never leak into other modules or into packages/contracts).
const PRISMA_ONLY_IN_DATABASE_MODULE = {
  group: ['@prisma/*', 'prisma', 'prisma/*'],
  message: 'Prisma may only be imported inside apps/api/src/modules/database.',
};
const IOREDIS_ONLY_IN_REDIS_MODULE = {
  group: ['ioredis', 'ioredis/*'],
  message: 'ioredis may only be imported inside apps/api/src/modules/redis.',
};

// The browser app must never depend on database, cache or queue packages.
const WEB_FORBIDDEN = {
  group: ['@prisma/*', 'prisma', 'ioredis', 'redis', 'pg', 'bullmq'],
  message: 'apps/web must not depend on database or infrastructure packages. Use the API.',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.nx/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { patterns: [DEEP_IMPORT, NO_APP_IMPORT] }],
    },
  },
  {
    // Project-level dependency direction (ADR-005). Also reports circular project dependencies.
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          depConstraints: [
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib'] },
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib'] },
            // The frontend may only use shared contracts, never backend code (ADR-008).
            { sourceTag: 'scope:web', onlyDependOnLibsWithTags: ['scope:shared'] },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            { sourceTag: 'scope:backend', onlyDependOnLibsWithTags: ['scope:shared', 'scope:backend'] },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [DEEP_IMPORT, NO_APP_IMPORT, CONTRACTS_FORBIDDEN] }],
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DEEP_IMPORT,
            NO_APP_IMPORT,
            MODULE_INTERNALS_FROM_OUTSIDE,
            PRISMA_ONLY_IN_DATABASE_MODULE,
            IOREDIS_ONLY_IN_REDIS_MODULE,
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DEEP_IMPORT,
            NO_APP_IMPORT,
            MODULE_INTERNALS_FROM_OUTSIDE,
            MODULE_INTERNALS_FROM_SIBLING,
            PRISMA_ONLY_IN_DATABASE_MODULE,
            IOREDIS_ONLY_IN_REDIS_MODULE,
          ],
        },
      ],
    },
  },
  {
    // The two infrastructure modules may import their own driver (and not the other's).
    files: ['apps/api/src/modules/database/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DEEP_IMPORT,
            NO_APP_IMPORT,
            MODULE_INTERNALS_FROM_OUTSIDE,
            MODULE_INTERNALS_FROM_SIBLING,
            IOREDIS_ONLY_IN_REDIS_MODULE,
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/redis/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DEEP_IMPORT,
            NO_APP_IMPORT,
            MODULE_INTERNALS_FROM_OUTSIDE,
            MODULE_INTERNALS_FROM_SIBLING,
            PRISMA_ONLY_IN_DATABASE_MODULE,
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-imports': ['error', { patterns: [DEEP_IMPORT, NO_APP_IMPORT, WEB_FORBIDDEN] }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
