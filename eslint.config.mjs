import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/*
 * Architecture rules. Documented in docs/architecture/monorepo.md and docs/architecture/backend.md.
 * Never weaken a rule to make an import pass: change the design instead, or write an ADR.
 */

// ---------------------------------------------------------------------------------------------------------
// Workspace-level rules
// ---------------------------------------------------------------------------------------------------------

const DEEP_IMPORT = {
  group: ['@agentos/*/*'],
  message: 'Import workspace packages through their public entry point only (no deep imports).',
};

// Only workspace *packages* are importable; applications (api, web, any future worker or scheduler) never are.
// This is an allowlist so a new app cannot be imported by accident. Adding a shared package means adding it
// here, which is deliberate friction (spec: extract shared code only with multiple consumers).
const IMPORTABLE_WORKSPACE_PACKAGES = ['contracts', 'config', 'logger', 'queue'];
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

// The browser app must never depend on database, cache or queue packages.
const WEB_FORBIDDEN = {
  group: ['@prisma/*', 'prisma', 'ioredis', 'redis', 'pg', 'bullmq'],
  message: 'apps/web must not depend on database or infrastructure packages. Use the API.',
};

// ---------------------------------------------------------------------------------------------------------
// apps/web: layers   app -> features -> shared   (arrows mean "may import")
// ---------------------------------------------------------------------------------------------------------

// `react-router-dom` is the legacy re-export package; import from `react-router`.
const NO_ROUTER_DOM = {
  group: ['react-router-dom'],
  message: 'Import from "react-router" (react-router-dom is the legacy package).',
};
// shared/ is the bottom layer: it knows nothing about features or the app shell.
const SHARED_NO_UPWARD = {
  regex: '(^|/)(features|app)(/|$)',
  message:
    'shared/ must not import from features/ or app/. Shared code cannot depend on the things that depend on it.',
};
// features/ may use shared/, never the app layer.
const FEATURE_NO_APP = {
  regex: '(^|/)app(/|$)',
  message: 'features/ must not import from app/. The app composes features, not the other way round.',
};
// The app layer reaches a feature only through its public index.ts (never "features/x/components/...").
const APP_FEATURE_PUBLIC_ONLY = {
  regex: '(^|/)features/[^/]+/(?!index$).+',
  message: 'Import a feature through its public entry (features/<name>), not its internal files.',
};
const NO_DIRECT_FETCH = {
  name: 'fetch',
  message:
    'Do not call fetch directly. Use apiRequest from shared/api/client (timeouts, cancellation, contract validation).',
};
const NO_IMPORT_META_ENV = {
  selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
  message: 'Read configuration through "env" from shared/config/env. Only that file touches import.meta.env.',
};
// ADR-0012 D4 (rule 5): private data is fetched only through the session-gated observer path (hooks built on useQuery /
// useInfiniteQuery). The imperative client methods ignore the gate, and cache writes could repopulate purged data, so they belong
// to features/auth alone (the session probe and the transition block, which touch only the public roots).
const IMPERATIVE_QUERY_METHODS = [
  'fetchQuery',
  'prefetchQuery',
  'ensureQueryData',
  'fetchInfiniteQuery',
  'prefetchInfiniteQuery',
  'ensureInfiniteQueryData',
  'refetchQueries',
  'setQueryData',
  'setQueriesData',
];
const NO_IMPERATIVE_QUERY_CALLS = {
  selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=/^(${IMPERATIVE_QUERY_METHODS.join('|')})$/]`,
  message:
    'Do not fetch or write query data imperatively: private data is fetched only through useQuery/useInfiniteQuery hooks, which the session gate covers (ADR-0012 D4). Only features/auth may use this call, and only for the public session and health roots.',
};

// ---------------------------------------------------------------------------------------------------------
// apps/api: module boundaries
// ---------------------------------------------------------------------------------------------------------

// Backend modules expose a public index.ts; others may not reach into their internals.
const MODULE_INTERNALS_MESSAGE =
  'Import another module through its index (e.g. "../config"), never its internal files.';
// From outside modules/: "<...>/modules/<name>/<file>".
const MODULE_INTERNALS_FROM_OUTSIDE = { group: ['**/modules/*/*'], message: MODULE_INTERNALS_MESSAGE };
// From inside a module: "../<sibling>/<file>" (but not "../../common/...", which starts with "../..").
const MODULE_INTERNALS_FROM_SIBLING = { regex: '^\\.\\./[^/.][^/]*/.+', message: MODULE_INTERNALS_MESSAGE };

// Drivers are confined: Prisma lives in modules/database and in the infrastructure layer of domain modules (their
// repositories); ioredis lives only in modules/redis. Everything else reaches data through those.
const PRISMA_RESTRICTED = {
  group: ['@prisma/*', 'prisma', 'prisma/*'],
  message:
    "Prisma may only be imported in modules/database and in a domain module's infrastructure layer (repositories).",
};
const IOREDIS_RESTRICTED = {
  group: ['ioredis', 'ioredis/*', 'bullmq', 'bullmq/*'],
  message:
    'ioredis may only be imported inside apps/api/src/modules/redis, and the API never imports bullmq (it produces jobs through @agentos/queue).',
};
// Same rule for the redis module itself, which may use ioredis but still not BullMQ.
const BULLMQ_NOT_IN_API = {
  group: ['bullmq', 'bullmq/*'],
  message: 'The API produces jobs through @agentos/queue and never imports bullmq directly.',
};

// ---------------------------------------------------------------------------------------------------------
// apps/worker: runtime (framework-free worker host) and processors (the jobs it runs). docs/architecture/workers.md
// ---------------------------------------------------------------------------------------------------------

const WORKER_FORBIDDEN = {
  group: ['@nestjs/*', 'express', '@prisma/*', 'prisma', 'prisma/*', 'react', 'react-*', 'antd', 'pg'],
  message:
    'The worker is framework-free and has no database access: no NestJS, HTTP framework or Prisma. If a job needs the database, stop and write an ADR first.',
};
// A worker is a separate deployable: it never reaches into another application's sources by path either.
const NO_OTHER_APP_SOURCES = {
  group: ['**/apps/api/**', '**/apps/web/**'],
  message:
    'Applications do not import each other. Share code through a package (@agentos/contracts, @agentos/queue).',
};
const WORKER_BULLMQ_ONLY_IN_RUNTIME = {
  group: ['bullmq', 'bullmq/*', 'ioredis', 'ioredis/*'],
  message:
    'BullMQ and ioredis are confined to apps/worker/src/runtime (and packages/queue). Processors receive plain typed payloads and a JobContext.',
};
const WORKER_IORED_NOT_IN_RUNTIME = {
  group: ['ioredis', 'ioredis/*'],
  message:
    'Create Redis connections with createRedisConnection from @agentos/queue; ioredis is confined to packages/queue.',
};
// The runtime is generic and reusable: it must not know the process entry, the environment, or any concrete job.
const RUNTIME_NO_UPWARD = {
  regex: '^\\.\\./(processors|app|main|run|config|health|healthcheck)(/|$)',
  message:
    'The worker runtime is generic: it must not import processors, config, app or main. Processors and configuration are handed in (see WorkerHostOptions).',
};
// Processors use the runtime only through its public API.
const PROCESSORS_RUNTIME_PUBLIC_ONLY = {
  regex: '^\\.\\./runtime/.+',
  message: 'Import the runtime through its public entry ("../runtime"), not its internal files.',
};
const PROCESSORS_NO_ENTRY = {
  regex: '^\\.\\./(app|main|run|config|health|healthcheck)(/|$)',
  message:
    'Processors must not import the process entry or configuration. They receive everything through their JobContext.',
};

// Infrastructure modules (config, database, redis) are leaves: they never depend on business or sibling modules,
// except that database and redis may use config.
const INFRA_MODULE_NO_SIBLINGS = {
  regex: '^\\.\\./[^/.][^/]*(/.*)?$',
  message: 'Infrastructure modules must not depend on other modules.',
};
const INFRA_MODULE_ONLY_CONFIG = {
  regex: '^\\.\\./(?!config(/|$))[^/.][^/]*(/.*)?$',
  message: 'Infrastructure modules must not depend on other modules (only on ../config).',
};

// ---------------------------------------------------------------------------------------------------------
// apps/api: layers inside a domain module (domain / application / infrastructure / presentation)
// Direction: presentation -> application -> domain <- infrastructure
// ---------------------------------------------------------------------------------------------------------

const FRAMEWORK_AND_DRIVERS = [
  '@nestjs/*',
  'express',
  'nestjs-pino',
  'pino',
  'pino-http',
  '@prisma/*',
  'prisma',
  'ioredis',
  'bullmq',
];
const importsLayer = (...layers) => ({
  regex: `(^|/)(${layers.join('|')})(/|$)`,
  message: `This layer must not import from: ${layers.join(', ')}. Dependencies point inwards (presentation -> application -> domain; infrastructure -> domain).`,
});
const DOMAIN_PURE = {
  group: FRAMEWORK_AND_DRIVERS,
  message: 'The domain layer is plain TypeScript: no NestJS, HTTP, Prisma or Redis imports.',
};
const NO_INFRA_MODULES = {
  regex: '(^|/)(database|redis)(/|$)',
  message:
    'Do not import the database or redis modules here. Use a repository port (domain) or a repository (infrastructure).',
};
const APPLICATION_NO_DRIVER_ACCESS = {
  group: ['**/database', '**/redis'],
  importNames: ['PrismaService', 'RedisService'],
  message:
    'Application services use repositories and TransactionRunner, never PrismaService/RedisService directly.',
};
const NO_DRIVERS = {
  group: ['@prisma/*', 'prisma', 'ioredis', 'bullmq', 'express'],
  message: 'Drivers and Express are not allowed in this layer.',
};

const restrict = (...patterns) => ['error', { patterns }];
const BASE = [DEEP_IMPORT, NO_APP_IMPORT];
const API_MODULE_BASE = [...BASE, MODULE_INTERNALS_FROM_OUTSIDE, MODULE_INTERNALS_FROM_SIBLING];
// Inside layered folders (domain/, application/, ...) the number of "../" to reach a sibling module depends on folder
// depth, so a regex cannot tell it from an import inside the same module. tools/check-module-boundaries.mjs enforces
// "sibling modules only through index.ts" for every depth and runs as part of `lint`.
const LAYERED_MODULE_BASE = [...BASE, MODULE_INTERNALS_FROM_OUTSIDE];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.nx/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': restrict(...BASE),
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
    rules: { 'no-restricted-imports': restrict(...BASE, CONTRACTS_FORBIDDEN) },
  },

  // ---- apps/api -------------------------------------------------------------------------------------------
  {
    // Files outside modules/ (bootstrap, common, app.module, main): no drivers at all.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...BASE,
        MODULE_INTERNALS_FROM_OUTSIDE,
        PRISMA_RESTRICTED,
        IOREDIS_RESTRICTED,
      ),
    },
  },
  {
    // Default for every module: no drivers; reach siblings only through their index.
    files: ['apps/api/src/modules/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: { 'no-restricted-imports': restrict(...API_MODULE_BASE, PRISMA_RESTRICTED, IOREDIS_RESTRICTED) },
  },
  {
    files: ['apps/api/src/modules/config/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...API_MODULE_BASE,
        PRISMA_RESTRICTED,
        IOREDIS_RESTRICTED,
        INFRA_MODULE_NO_SIBLINGS,
      ),
    },
  },
  {
    files: ['apps/api/src/modules/database/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(...API_MODULE_BASE, IOREDIS_RESTRICTED, INFRA_MODULE_ONLY_CONFIG),
    },
  },
  {
    files: ['apps/api/src/modules/redis/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...API_MODULE_BASE,
        PRISMA_RESTRICTED,
        BULLMQ_NOT_IN_API,
        INFRA_MODULE_ONLY_CONFIG,
      ),
    },
  },
  // Layers of a domain module. They apply only to modules that choose to have these folders.
  {
    files: ['apps/api/src/modules/*/domain/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...LAYERED_MODULE_BASE,
        DOMAIN_PURE,
        importsLayer('application', 'infrastructure', 'presentation'),
        NO_INFRA_MODULES,
      ),
    },
  },
  {
    files: ['apps/api/src/modules/*/application/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...LAYERED_MODULE_BASE,
        NO_DRIVERS,
        importsLayer('infrastructure', 'presentation'),
        APPLICATION_NO_DRIVER_ACCESS,
      ),
    },
  },
  {
    files: ['apps/api/src/modules/*/infrastructure/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    // Persistence adapters: the one place in a domain module where Prisma is allowed.
    rules: {
      'no-restricted-imports': restrict(
        ...LAYERED_MODULE_BASE,
        IOREDIS_RESTRICTED,
        importsLayer('presentation'),
      ),
    },
  },
  {
    files: ['apps/api/src/modules/*/presentation/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...LAYERED_MODULE_BASE,
        NO_DRIVERS,
        importsLayer('infrastructure'),
        NO_INFRA_MODULES,
      ),
    },
  },

  // ---- apps/worker ----------------------------------------------------------------------------------------
  {
    // Whole application (tests included): framework-free, no database, no cross-application imports.
    files: ['apps/worker/**/*.ts'],
    rules: { 'no-restricted-imports': restrict(...BASE, WORKER_FORBIDDEN, NO_OTHER_APP_SOURCES) },
  },
  {
    files: ['apps/worker/src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...BASE,
        WORKER_FORBIDDEN,
        NO_OTHER_APP_SOURCES,
        WORKER_IORED_NOT_IN_RUNTIME,
      ),
    },
  },
  {
    files: ['apps/worker/src/runtime/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    // bullmq is allowed here (and only here); everything else above still applies.
    rules: {
      'no-restricted-imports': restrict(
        ...BASE,
        WORKER_FORBIDDEN,
        NO_OTHER_APP_SOURCES,
        WORKER_IORED_NOT_IN_RUNTIME,
        RUNTIME_NO_UPWARD,
      ),
    },
  },
  {
    files: ['apps/worker/src/processors/**/*.ts', 'apps/worker/src/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...BASE,
        WORKER_FORBIDDEN,
        NO_OTHER_APP_SOURCES,
        WORKER_BULLMQ_ONLY_IN_RUNTIME,
      ),
    },
  },
  {
    files: ['apps/worker/src/processors/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-imports': restrict(
        ...BASE,
        WORKER_FORBIDDEN,
        NO_OTHER_APP_SOURCES,
        WORKER_BULLMQ_ONLY_IN_RUNTIME,
        PROCESSORS_RUNTIME_PUBLIC_ONLY,
        PROCESSORS_NO_ENTRY,
      ),
    },
  },

  // ---- tests/system ---------------------------------------------------------------------------------------
  {
    // Black-box tests of the running stack. They talk to containers over HTTP / Redis and may use bullmq to inspect jobs, but
    // like the worker they never import an application's sources, a framework or the database client.
    files: ['tests/system/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(...BASE, WORKER_FORBIDDEN, NO_OTHER_APP_SOURCES),
    },
  },

  // ---- shared backend packages ----------------------------------------------------------------------------
  {
    files: ['packages/config/**/*.ts', 'packages/logger/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(...BASE, {
        group: [
          '@nestjs/*',
          '@prisma/*',
          'prisma',
          'ioredis',
          'bullmq',
          'react',
          'react-*',
          'express',
          '@agentos/queue',
        ],
        message: 'config and logger are leaf packages: they depend on zod / pino only.',
      }),
    },
  },
  {
    files: ['packages/queue/**/*.ts'],
    rules: {
      'no-restricted-imports': restrict(...BASE, {
        group: ['@nestjs/*', '@prisma/*', 'prisma', 'react', 'react-*', 'express', 'pino', 'pino-*'],
        message: 'packages/queue must stay framework-free: BullMQ, ioredis, zod and @agentos/contracts only.',
      }),
    },
  },

  // ---- apps/web -------------------------------------------------------------------------------------------
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-restricted-imports': restrict(...BASE, WEB_FORBIDDEN, NO_ROUTER_DOM),
      'no-restricted-globals': ['error', NO_DIRECT_FETCH],
      'no-restricted-syntax': ['error', NO_IMPORT_META_ENV, NO_IMPERATIVE_QUERY_CALLS],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['apps/web/src/shared/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict(...BASE, WEB_FORBIDDEN, NO_ROUTER_DOM, SHARED_NO_UPWARD) },
  },
  {
    files: ['apps/web/src/features/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrict(...BASE, WEB_FORBIDDEN, NO_ROUTER_DOM, FEATURE_NO_APP) },
  },
  {
    files: ['apps/web/src/app/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrict(...BASE, WEB_FORBIDDEN, NO_ROUTER_DOM, APP_FEATURE_PUBLIC_ONLY),
    },
  },
  {
    // The session core: the one place allowed to use the imperative query calls (public roots only; see NO_IMPERATIVE_QUERY_CALLS).
    files: ['apps/web/src/features/auth/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', NO_IMPORT_META_ENV] },
  },
  {
    // The API client is the one place allowed to call fetch; env.ts the one place allowed to read import.meta.env.
    files: ['apps/web/src/shared/api/client.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['apps/web/src/shared/config/env.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests may stub fetch and import across layers (they are not part of the layered architecture).
    files: ['apps/web/**/*.spec.{ts,tsx}', 'apps/web/src/test/**/*.{ts,tsx}'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-syntax': 'off' },
  },
);
