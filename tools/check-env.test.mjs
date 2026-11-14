import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkEnvironment, parseConfigSchema, parseEnvExample } from './check-env.mjs';

const repo = join(import.meta.dirname, '..');
const FILES = [
  '.env.example',
  'package.json',
  'infrastructure/compose/docker-compose.yml',
  'infrastructure/docker/Dockerfile',
  'apps/api/src/modules/config/config.ts',
  'apps/worker/src/config.ts',
  'apps/web/src/shared/config/env.ts',
  'apps/web/.env.example',
];

const created = [];
/** A copy of the real configuration files with `edits` applied: { file: [[from, to], ...] }. */
function variant(edits = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-env-'));
  created.push(dir);
  for (const file of FILES) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, file), target);
  }
  for (const [file, replacements] of Object.entries(edits)) {
    let text = readFileSync(join(dir, file), 'utf8');
    for (const [from, to] of replacements) {
      assert.ok(text.includes(from), `fixture edit target not found in ${file}: ${from}`);
      text = text.replace(from, to);
    }
    writeFileSync(join(dir, file), text);
  }
  return dir;
}
after(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const problemsOf = (edits) => checkEnvironment(variant(edits));

describe('the real repository', () => {
  it('is consistent', () => {
    assert.deepEqual(checkEnvironment(repo), []);
  });
});

describe('detects drift between the places that describe the same variables', () => {
  it('a variable an app reads that .env.example does not document', () => {
    const problems = problemsOf({ '.env.example': [['WORKER_CONCURRENCY=5', '# removed']] });
    assert.ok(
      problems.some((p) => p.includes('worker reads WORKER_CONCURRENCY')),
      problems.join('\n'),
    );
  });

  it('a Compose default that contradicts .env.example', () => {
    const problems = problemsOf({
      'infrastructure/compose/docker-compose.yml': [['${WORKER_CONCURRENCY:-5}', '${WORKER_CONCURRENCY:-9}']],
    });
    assert.ok(
      problems.some((p) => p.includes('WORKER_CONCURRENCY') && p.includes('"9"')),
      problems.join('\n'),
    );
  });

  it('a variable Compose references that nobody documented', () => {
    const problems = problemsOf({
      'infrastructure/compose/docker-compose.yml': [['${WEB_PORT:-5173}', '${SECRET_WEB_PORT:-5173}']],
    });
    assert.ok(
      problems.some((p) => p.includes('SECRET_WEB_PORT')),
      problems.join('\n'),
    );
  });

  it('a variable sent to a container whose application does not read it (a typo would be ignored silently)', () => {
    const problems = problemsOf({
      'infrastructure/compose/docker-compose.yml': [
        ['WORKER_NAME: ${WORKER_NAME:-worker}', 'WORKER_NAMEE: ${WORKER_NAME:-worker}'],
      ],
    });
    assert.ok(
      problems.some((p) => p.includes('WORKER_NAMEE')),
      problems.join('\n'),
    );
  });

  it('the worker receiving database credentials (it has no database access)', () => {
    const problems = problemsOf({
      'infrastructure/compose/docker-compose.yml': [
        [
          '      WORKER_HEALTH_FILE: /tmp/worker-health.json',
          '      WORKER_HEALTH_FILE: /tmp/worker-health.json\n      DATABASE_URL: postgresql://x@postgres/db',
        ],
      ],
    });
    assert.ok(
      problems.some((p) => p.includes('worker receives DATABASE_URL')),
      problems.join('\n'),
    );
  });

  it('a required variable the container is not given', () => {
    const problems = problemsOf({
      'infrastructure/compose/docker-compose.yml': [['      API_PORT: 3000\n', '']],
    });
    // API_PORT has a default, so it is optional: still consistent. Removing REDIS_URL (required) must be reported.
    assert.deepEqual(problems, []);
    const missing = problemsOf({
      'infrastructure/compose/docker-compose.yml': [['  REDIS_URL: redis://', '  REDIS_URLL: redis://']],
    });
    assert.ok(
      missing.some((p) => p.includes('does not provide required REDIS_URL')),
      missing.join('\n'),
    );
  });

  it('connection URLs that disagree with the component variables', () => {
    const problems = problemsOf({ '.env.example': [['POSTGRES_DB=agentos', 'POSTGRES_DB=other']] });
    assert.ok(
      problems.some((p) => p.includes('DATABASE_URL database differs')),
      problems.join('\n'),
    );
  });
});

describe('secrets and operational invariants', () => {
  it('rejects a real-looking password in .env.example', () => {
    const problems = problemsOf({
      '.env.example': [
        ['POSTGRES_PASSWORD=change-me-postgres', 'POSTGRES_PASSWORD=Sup3rS3cretValue'],
        ['postgresql://agentos:change-me-postgres@', 'postgresql://agentos:Sup3rS3cretValue@'],
      ],
    });
    assert.ok(
      problems.some((p) => p.includes('POSTGRES_PASSWORD must be a "change-me-..." placeholder')),
      problems.join('\n'),
    );
  });

  it('rejects a Docker stop timeout that would kill the worker before it finished draining', () => {
    const problems = problemsOf({
      'infrastructure/compose/docker-compose.yml': [['stop_grace_period: 40s', 'stop_grace_period: 20s']],
    });
    assert.ok(
      problems.some((p) => p.includes('must exceed WORKER_SHUTDOWN_GRACE_MS')),
      problems.join('\n'),
    );
  });

  it('rejects a Dockerfile whose pnpm differs from the repository', () => {
    const problems = problemsOf({
      'infrastructure/docker/Dockerfile': [['ARG PNPM_VERSION=11.5.2', 'ARG PNPM_VERSION=10.0.0']],
    });
    assert.ok(
      problems.some((p) => p.includes('PNPM_VERSION')),
      problems.join('\n'),
    );
  });
});

describe('parsers', () => {
  it('parseEnvExample separates active keys, commented examples and duplicates', () => {
    const parsed = parseEnvExample('A=1\n# B=2\n# prose, not a variable\nA=3\n');
    assert.deepEqual([...parsed.active], [['A', '3']]);
    assert.deepEqual([...parsed.commented], ['B']);
    assert.deepEqual(parsed.duplicates, ['A']);
  });

  it('parseConfigSchema marks variables without a default or optional() as required', () => {
    const vars = parseConfigSchema(
      "export const s = z.object({\n  A: z.string(),\n  B: z.string().default('x'),\n  C: z.string().optional(),\n});",
    );
    assert.deepEqual(vars, [
      { name: 'A', required: true },
      { name: 'B', required: false },
      { name: 'C', required: false },
    ]);
  });
});
