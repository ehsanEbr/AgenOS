# ADR-0001: Phase 1 technology versions and tooling choices

**Status:** Accepted (Phase 1)
**Context:** The architecture spec fixes the stack (NestJS, React/Vite, Prisma, BullMQ, Nx + pnpm) but not versions
or the supporting libraries. Several npm `latest` majors at implementation time (Nest 12, Prisma 8 RC, TypeScript 7,
Vite 8, Vitest 5) are very recent; the foundation should not also be a migration exercise.

## Decisions

| Choice                                                                         | Reason                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| NestJS 11, Prisma 6, Vite 7, Vitest 3, TypeScript 5.8, Nx 21, ESLint 9, antd 5 | Stable majors with well-understood behaviour. Upgrade deliberately, one at a time.                                               |
| Zod 4 as the contract language (`packages/contracts`)                          | One schema validates requests, types responses and generates the OpenAPI document (`z.toJSONSchema`). Spec ADR-008 asks for Zod. |
| Custom `ZodValidationPipe` instead of `class-validator`/`nestjs-zod`           | Avoids a second schema language and an extra dependency.                                                                         |
| `tsup` for `packages/*` and `database` (CJS + ESM + d.ts)                      | NestJS/worker run CommonJS, Vite consumes ESM; one build serves both.                                                            |
| `unplugin-swc` + `@swc/core` (API tests only)                                  | Vitest/esbuild does not emit decorator metadata, which NestJS DI needs.                                                          |
| `pino` + `nestjs-pino`                                                         | Structured JSON logs, request logging, redaction; standard for Nest.                                                             |
| `ioredis`                                                                      | Required by BullMQ; also used for readiness checks.                                                                              |
| `dotenv-cli` (database package)                                                | Prisma CLI commands read the root `.env`. Apps use Node's `--env-file`.                                                          |
| `supertest`                                                                    | HTTP-level integration tests against the real Nest pipeline.                                                                     |
| `pgvector/pgvector` Postgres image                                             | Spec selects pgvector; using the image now avoids a later image swap.                                                            |
| Nx tags (`type:*`, `scope:*`) in package.json                                  | Enforce web -> shared-only and lib -> lib-only dependencies via ESLint.                                                          |

## Consequences

- Dependency upgrades are explicit follow-up tasks (Prisma 7 requires `prisma.config.ts` and driver changes).
- Supporting dependencies are listed here so later additions can be compared against this baseline.
