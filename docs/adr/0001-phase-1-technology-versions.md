# ADR-0001: Technology versions and tooling choices

**Status:** Accepted (Phase 1.1)
**Context:** The architecture spec fixes the stack (NestJS, React/Vite, Nx + pnpm) but not versions or supporting
libraries. Several npm `latest` majors at implementation time (Nest 12, TypeScript 7, Vite 8, Vitest 5) are very
recent; the foundation should not also be a migration exercise.

## Decisions

| Choice                                                                                   | Reason                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS 11, Vite 7, Vitest 3, TypeScript 5.8, Nx 21, ESLint 9, antd 5, React 19           | Stable majors with well-understood behaviour. Upgrade deliberately, one at a time.                                                             |
| pnpm 11.5.2 pinned via `packageManager`                                                  | Reproducible installs; lockfile (`pnpm-lock.yaml`) is committed.                                                                               |
| Zod 4 for contracts, API env validation and web env validation                           | One schema language validates requests, types responses, validates config and generates OpenAPI (`z.toJSONSchema`). Spec ADR-008 asks for Zod. |
| Custom `ZodValidationPipe` + `createZodDto` instead of `class-validator` or `nestjs-zod` | Avoids a second schema language and an extra dependency (about 40 lines).                                                                      |
| `tsup` for `packages/contracts` (CJS + ESM + d.ts)                                       | NestJS runs CommonJS, Vite consumes ESM; one build serves both.                                                                                |
| `unplugin-swc` + `@swc/core` (API tests only)                                            | Vitest/esbuild does not emit decorator metadata, which NestJS DI needs.                                                                        |
| `pino` + `pino-http` + `nestjs-pino` (+ `pino-pretty` dev only)                          | Structured JSON logs, request logging, redaction; standard for Nest.                                                                           |
| `@nestjs/swagger`                                                                        | OpenAPI/Swagger UI required by the phase.                                                                                                      |
| `supertest`                                                                              | HTTP-level e2e tests against the real Nest pipeline.                                                                                           |
| React Router, Ant Design, TanStack Query, Zustand                                        | Named by the spec/phase for the web app. Zustand holds client-only UI state; TanStack Query holds server state.                                |
| Nx tags (`type:*`, `scope:*`) in package.json                                            | Enforce dependency direction via ESLint.                                                                                                       |

## Consequences

- Dependency upgrades are explicit follow-up tasks.
- Libraries needed by later phases (Prisma, BullMQ, ioredis, dotenv-cli, ...) are deliberately absent; see
  branch `phase-1-foundation` for the previous choices.
- `@agentos/config` and `@agentos/logger` packages from the earlier build were folded into `apps/api` because
  there is a single consumer (see ADR-0002).
