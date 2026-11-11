import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const DEEP_IMPORT = {
  group: ['@agentos/*/*'],
  message: 'Import workspace packages through their public entry point only (no deep imports).',
};

// Applications are deployables, not libraries: nothing may import them (Nx cannot map these names to
// projects, so the module-boundary rule alone would miss them).
const NO_APP_IMPORT = {
  group: [
    '@agentos/api',
    '@agentos/api/*',
    '@agentos/web',
    '@agentos/web/*',
    '@agentos/*-worker',
    '@agentos/*-worker/*',
  ],
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
        { patterns: [DEEP_IMPORT, NO_APP_IMPORT, MODULE_INTERNALS_FROM_OUTSIDE] },
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
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
