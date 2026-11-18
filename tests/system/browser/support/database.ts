import { createHash } from 'node:crypto';
import { run } from '../../src/stack';
import type { StackInfo } from './stack-info';

/*
 * One statement the API has no endpoint for: ending a session on the server, as if its idle time had run out. It runs in the postgres
 * container of THIS run's throwaway stack (found by its Compose project label), as the migration role, with the stack's generated
 * password. Nothing here can reach another project's containers or a developer's database.
 */

const containers = new Map<string, string>();

async function postgresContainer(project: string): Promise<string> {
  const known = containers.get(project);
  if (known) return known;
  const result = await run('docker', [
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'label=com.docker.compose.service=postgres',
  ]);
  const id = result.stdout.trim().split(/\s+/)[0];
  if (!id) throw new Error(`no postgres container for project ${project}`);
  containers.set(project, id);
  return id;
}

async function sql(stack: StackInfo, statement: string): Promise<string> {
  if (!stack.project.startsWith('agentos-systest-')) {
    throw new Error(
      `refusing to touch project "${stack.project}": it is not a throwaway system-test project`,
    );
  }
  const result = await run('docker', [
    'exec',
    '-e',
    `PGPASSWORD=${stack.migratePassword}`,
    await postgresContainer(stack.project),
    'psql',
    '-h',
    '127.0.0.1',
    '-U',
    'agentos_migrate',
    '-d',
    'agentos',
    '-tAc',
    statement,
  ]);
  if (result.code !== 0) throw new Error(`psql failed (${result.code}): ${result.stderr.slice(-500)}`);
  return result.stdout.trim();
}

/**
 * Lets the session behind this cookie value run out on the server (its idle limit is in the past). The row is found by the SHA-256 of the
 * token, which is how the API stores sessions; the token itself is never stored. The very next request with that cookie is `401`.
 */
export async function expireSession(stack: StackInfo, sessionCookieValue: string): Promise<void> {
  const hash = createHash('sha256').update(decodeURIComponent(sessionCookieValue), 'utf8').digest('hex');
  const changed = await sql(
    stack,
    `WITH changed AS (UPDATE identity.session SET idle_expires_at = now() - interval '1 minute' WHERE token_hash = '${hash}' RETURNING 1) SELECT count(*) FROM changed`,
  );
  if (changed !== '1') throw new Error(`expected to expire exactly one session, expired ${changed}`);
}
