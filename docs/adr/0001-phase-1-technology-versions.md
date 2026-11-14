# ADR-0001: Technology versions and tooling choices

**Status:** Accepted (Phase 1.1)
**Context:** The architecture spec fixes the stack (NestJS, React/Vite, Nx + pnpm) but not versions or supporting
libraries. Several npm `latest` majors at implementation time (Nest 12, TypeScript 7, Vite 8, Vitest 5) are very
recent; the foundation should not also be a migration exercise.

## Decisions

| Choice                                                                                          | Reason                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS 11, Vite 7, Vitest 3, TypeScript 5.8, Nx 21, ESLint 9, antd 5, React 19                  | Stable majors with well-understood behaviour. Upgrade deliberately, one at a time.                                                             |
| pnpm 11.5.2 pinned via `packageManager`                                                         | Reproducible installs; lockfile (`pnpm-lock.yaml`) is committed.                                                                               |
| Zod 4 for contracts, API env validation and web env validation                                  | One schema language validates requests, types responses, validates config and generates OpenAPI (`z.toJSONSchema`). Spec ADR-008 asks for Zod. |
| Custom `ZodValidationPipe` + `createZodDto` instead of `class-validator` or `nestjs-zod`        | Avoids a second schema language and an extra dependency (about 40 lines).                                                                      |
| `tsup` for `packages/contracts` (CJS + ESM + d.ts)                                              | NestJS runs CommonJS, Vite consumes ESM; one build serves both.                                                                                |
| `unplugin-swc` + `@swc/core` (API tests only)                                                   | Vitest/esbuild does not emit decorator metadata, which NestJS DI needs.                                                                        |
| `pino` + `pino-http` + `nestjs-pino` (+ `pino-pretty` dev only)                                 | Structured JSON logs, request logging, redaction; standard for Nest.                                                                           |
| `@nestjs/swagger`                                                                               | OpenAPI/Swagger UI required by the phase.                                                                                                      |
| `supertest`                                                                                     | HTTP-level e2e tests against the real Nest pipeline.                                                                                           |
| React Router, Ant Design, TanStack Query, Zustand                                               | Named by the spec/phase for the web app. Zustand holds client-only UI state; TanStack Query holds server state.                                |
| Nx tags (`type:*`, `scope:*`) in package.json                                                   | Enforce dependency direction via ESLint.                                                                                                       |
| Prisma 6.19.3 (`prisma`, `@prisma/client`), exact pins                                          | PostgreSQL ORM named by the spec; last major with the classic generator. See ADR-0003.                                                         |
| `ioredis` 5.10.1, exact pin                                                                     | Redis client; the version BullMQ 5.x depends on, so a later BullMQ phase adds no second copy. See ADR-0003.                                    |
| `express` 5.2.1, exact pin (devDependency of `apps/api`)                                        | Used only to test the logging pipeline against a real Express app; same version Nest's adapter already installs. See ADR-0004.                 |
| `i18next` 27.1.1, `react-i18next` 18.0.1 (exact pins, `apps/web`)                               | Persian/English UI with per-feature namespaces and type-checked keys. See ADR-0005.                                                            |
| Docker images `pgvector/pgvector:pg17` (PostgreSQL 17.11) and `redis:7.4-alpine` (Redis 7.4.12) | PostgreSQL with pgvector as selected by the spec; Redis for cache and ephemeral state only.                                                    |

## Consequences

- Dependency upgrades are explicit follow-up tasks.
- Libraries needed by later phases (Prisma, BullMQ, ioredis, dotenv-cli, ...) are deliberately absent; see
  branch `phase-1-foundation` for the previous choices.
- `@agentos/config` and `@agentos/logger` packages from the earlier build were folded into `apps/api` because
  there is a single consumer (see ADR-0002).

## Version audit (Phase 1.1 verification)

The specification and ADRs name technologies but pin **no versions**, so nothing below deviates from a documented
version. "Latest" is what npm tagged `latest` on the audit date (2026-11-14).

| Technology                 | Declared range                                               | Locked                                                                                | npm latest     | Note                                                                                                         |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| Node.js                    | `>=22.12.0` (engines)                                        | CI: `22.x`; dev machine 22.14.0                                                       | -              | Meets Vite 7 (`^20.19 \|\| >=22.12`) and Nest 11 (`>=20`).                                                   |
| pnpm                       | `pnpm@11.5.2` (packageManager)                               | 11.5.2                                                                                | -              | CI action `pnpm/action-setup@v6` reads this field.                                                           |
| TypeScript                 | `~5.8.3`                                                     | 5.8.3 (single copy, enforced by `overrides`)                                          | 7.0.2          | See "TypeScript" below.                                                                                      |
| NestJS                     | `^11.1.0`                                                    | 11.2.9 (`common`, `core`, `platform-express`, `testing`); swagger 11.4.8; cli 11.0.24 | 12.5.0         | One major behind latest.                                                                                     |
| Nx                         | `^21.2.0`                                                    | 21.6.11                                                                               | 24.0.6         | Three majors behind latest.                                                                                  |
| Vite                       | `^7.0.0`                                                     | 7.3.8                                                                                 | 8.3.8          | `@vitejs/plugin-react` 5.2.0 supports Vite 4-8.                                                              |
| Vitest                     | `^3.2.0`                                                     | 3.2.7                                                                                 | 5.1.0          | Supports Vite 7.                                                                                             |
| React / React DOM          | `^19.1.0`                                                    | 19.3.1                                                                                | 19.3.1         | Current.                                                                                                     |
| Ant Design                 | `6.7.0` (exact; was `^5.26.0`)                               | 6.7.0 (`@ant-design/icons` 6.3.4, exact)                                              | 6.7.0          | **Upgraded in Phase 1.4**, see ADR-0005. The "Ant Design 5 versus 6" notes below describe the earlier state. |
| React Router               | `react-router` 7.18.5 (exact; was `react-router-dom ^7.6.0`) | 7.18.5                                                                                | 8.5.1          | Switched package in Phase 1.4 (ADR-0005); staying on v7.                                                     |
| TanStack Query             | `^5.80.0`                                                    | 5.107.1                                                                               | 5.107.1        | Current.                                                                                                     |
| Zustand                    | `^5.0.0`                                                     | 5.1.0                                                                                 | -              |                                                                                                              |
| Zod                        | `^4.0.0` in all three projects                               | 4.6.7 (single copy)                                                                   | 4.6.7          | Current.                                                                                                     |
| ESLint / typescript-eslint | `^9.30.0` / `^8.35.0`                                        | 9.39.5 / 8.72.2                                                                       | ESLint 10.14.0 | ESLint 9 is deprecated upstream; plan an upgrade (see limitations).                                          |

Compatibility: `pnpm install` reports no unmet peer dependencies. Lockfile contains one copy of React, Zod, Vite,
Vitest, Ant Design and TypeScript.

### TypeScript

`@nestjs/cli` (used by `nest build`) and `tsup` (d.ts generation) each pulled their own TypeScript 5.9.3 while
`tsc --noEmit` used 5.8.3, so the code was type-checked and compiled with different compilers. `overrides:
typescript: ~5.8.3` in `pnpm-workspace.yaml` forces a single version. Staying below 6/7 is deliberate:
typescript-eslint 8.x supports `<6.1`, and TypeScript 7 changes the toolchain.

### Ant Design 5 versus 6

Neither the specification nor any ADR mentions Ant Design 6; the specification says only "Ant Design". Ant Design 5 was
chosen in this phase because it was the established, best-documented major at decision time, **not**
because of a compatibility problem. Ant Design 6.7.0 is now `latest` and requires React >= 18, which is satisfied.

Evidence from a throwaway spike (not merged): bumping `antd` to `^6.7.0` and `@ant-design/icons` to `^6.0.0` with no
source changes passed web typecheck, all 11 web tests and the production build. This is jsdom-level evidence only;
visual differences were not reviewed. The web app uses just Alert, Button, ConfigProvider, Layout, Menu, Result, Spin,
Tag and Typography, so migrating now is cheap and gets more expensive with every feature built on top.
**Open decision for the maintainers:** stay on 5 (current) or move to 6 before Phase 1.2 adds UI.

### React Router

The specification says "React Router". Version 7 is used via the `react-router-dom` compatibility package, which
re-exports `react-router`. Importing from `react-router` directly is the forward path; it is a mechanical change
deferred to avoid unrelated refactoring.
