import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ImageRecord, Stack, checkProvenance, run } from '../src/stack';

/*
 * Tests of the harness itself: the protections that keep a system test away from a developer's environment and away from images it
 * did not build. They run Docker CLI commands (`compose config`, `ps`) but start nothing.
 */

const harnessTempDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('agentos-systest-'));

/** Resources Docker holds for a Compose project: containers (any state), networks and volumes. */
async function resourcesOf(
  project: string,
): Promise<{ containers: string; networks: string; volumes: string }> {
  const containers = await run('docker', [
    'ps',
    '-a',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
  ]);
  const networks = await run('docker', ['network', 'ls', '-q', '--filter', `name=${project}`]);
  const volumes = await run('docker', ['volume', 'ls', '-q', '--filter', `name=${project}`]);
  return {
    containers: containers.stdout.trim(),
    networks: networks.stdout.trim(),
    volumes: volumes.stdout.trim(),
  };
}

describe('isolation guard: fault injection', () => {
  afterEach(() => vi.restoreAllMocks());

  // Each of these, leaking in AFTER the environment was sanitized, would point the "throwaway" stack at a developer's setting.
  const faults: Array<[string, string]> = [
    ['POSTGRES_PORT', '5432'],
    ['REDIS_PORT', '6379'],
    ['API_PORT', '3000'],
    ['WEB_PORT', '5173'],
    ['AGENTOS_NETWORK', 'agentos-net'],
    ['AGENTOS_IMAGE_TAG', 'local'],
    ['REDIS_PASSWORD', 'leaked-redis-secret-7f3a'],
    ['POSTGRES_PASSWORD', 'leaked-postgres-secret-7f3a'],
    ['POSTGRES_MIGRATE_PASSWORD', 'leaked-migrate-secret-7f3a'],
    ['POSTGRES_APP_PASSWORD', 'leaked-app-secret-7f3a'],
  ];

  it.each(faults)(
    'aborts BEFORE anything is created when %s leaks in, and prints no credential',
    async (name, leakedValue) => {
      const generated = {
        REDIS_PASSWORD: 'generated-redis-secret-91bd',
        POSTGRES_PASSWORD: 'generated-postgres-secret-91bd',
        POSTGRES_MIGRATE_PASSWORD: 'generated-migrate-secret-91bd',
        POSTGRES_APP_PASSWORD: 'generated-app-secret-91bd',
      };
      const secrets = [...Object.values(generated), leakedValue];

      // Everything the harness (or anything it spawns) might print, captured to prove no secret appears.
      let printed = '';
      const capture = (chunk: unknown) => {
        printed += String(chunk);
        return true;
      };
      vi.spyOn(process.stdout, 'write').mockImplementation(capture);
      vi.spyOn(process.stderr, 'write').mockImplementation(capture);
      const tempBefore = harnessTempDirs();

      let error: unknown;
      try {
        await Stack.create({ env: generated, injectAfterSanitizing: { [name]: leakedValue } });
      } catch (caught) {
        error = caught;
      }
      vi.restoreAllMocks();

      // 1. It aborted, with the guard's own message, naming the kind of setting but not its value.
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('system-test isolation broken');
      const project = /project (agentos-systest-[0-9a-f]+)/.exec(message)?.[1];
      expect(project).toBeDefined();

      // 2. No credential, generated or leaked, appears in the error or in anything printed.
      for (const secret of secrets) {
        expect(message).not.toContain(secret);
        expect(printed).not.toContain(secret);
      }

      // 3. Nothing was created: no container, network or volume exists for that project, and its credentials file is gone.
      expect(await resourcesOf(project as string)).toEqual({ containers: '', networks: '', volumes: '' });
      expect(harnessTempDirs().filter((dir) => !tempBefore.includes(dir))).toEqual([]);
    },
  );

  it('does not abort a correct configuration (the guard has no false positive)', async () => {
    const stack = await Stack.create();
    try {
      expect(stack.ports.redis).toBeGreaterThan(0);
    } finally {
      await stack.destroy(); // nothing was started: this only removes the temp credentials
    }
  });
});

describe('ambient environment pollution is neutralized (the Nx / developer .env scenario)', () => {
  it('ignores developer ports, passwords, network and image tag present in process.env, and restores the environment', async () => {
    const pollution: Record<string, string> = {
      POSTGRES_PORT: '5432',
      REDIS_PORT: '6379',
      API_PORT: '3000',
      WEB_PORT: '5173',
      REDIS_PASSWORD: 'ambient-redis-secret-c0de',
      POSTGRES_PASSWORD: 'ambient-postgres-secret-c0de',
      POSTGRES_MIGRATE_PASSWORD: 'ambient-migrate-secret-c0de',
      POSTGRES_APP_PASSWORD: 'ambient-app-secret-c0de',
      DATABASE_ADMIN_URL: 'postgresql://agentos:ambient-admin-secret@127.0.0.1:5432/agentos',
      AGENTOS_NETWORK: 'agentos-net',
      AGENTOS_IMAGE_TAG: 'local',
      GIT_REVISION: 'ambient-revision',
      COMPOSE_PROJECT_NAME: 'agentos',
    };
    const original = Object.fromEntries(Object.keys(pollution).map((key) => [key, process.env[key]]));
    Object.assign(process.env, pollution);
    try {
      const stack = await Stack.create(); // would throw "isolation broken" if any ambient value won
      try {
        expect([5432, 6379, 3000, 5173]).not.toContain(stack.ports.redis);
        expect(stack.project.startsWith('agentos-systest-')).toBe(true); // not the ambient "agentos"
      } finally {
        await stack.destroy();
      }
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const [key, value] of Object.entries(original)) expect(process.env[key]).toBe(value); // restored exactly
  });
});

describe('image provenance rule', () => {
  const REVISION = 'a'.repeat(40);
  const record = (name: string, revision: string): ImageRecord => ({
    reference: `${name}:systest`,
    id: `sha256:${name}`,
    created: '2026-01-01T00:00:00Z',
    revision,
  });
  const all = (revision: string) =>
    ['agentos-api', 'agentos-worker', 'agentos-web'].map((n) => record(n, revision));

  it('accepts images that were all built from the revision under test', () => {
    expect(checkProvenance(all(REVISION), REVISION)).toEqual([]);
  });

  it('rejects a stale image, an image with no revision label (e.g. a developer build) and a missing image', () => {
    const stale = all(REVISION);
    stale[1] = record('agentos-worker', 'b'.repeat(40));
    expect(checkProvenance(stale, REVISION)).toEqual([expect.stringContaining('agentos-worker:systest')]);

    const unlabeled = all(REVISION);
    unlabeled[0] = record('agentos-api', 'none');
    expect(checkProvenance(unlabeled, REVISION)).toEqual([expect.stringContaining('built from "none"')]);

    expect(checkProvenance(all(REVISION).slice(0, 2), REVISION)).toEqual(['agentos-web: no image']);
  });

  it('treats a dirty working tree as different from the clean commit', () => {
    expect(checkProvenance(all(REVISION), `${REVISION}-dirty`)).toHaveLength(3);
  });
});
