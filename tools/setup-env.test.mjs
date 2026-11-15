import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildEnv, parseEnv } from './setup-env.mjs';

const example = readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8');

// Deterministic "random" secrets, distinguishable from each other.
const counter = () => {
  let n = 0;
  return () => `secret${(n += 1)}`;
};

// What a .env looked like before the database roles were separated: the API connected as the superuser.
const legacyEnv = [
  'NODE_ENV=development',
  'POSTGRES_USER=agentos',
  'POSTGRES_PASSWORD=oldpgsecret',
  'POSTGRES_DB=mydb',
  'POSTGRES_PORT=5544',
  'DATABASE_URL=postgresql://agentos:oldpgsecret@127.0.0.1:5544/mydb?schema=public',
  'REDIS_PASSWORD=oldredissecret',
  'REDIS_PORT=6379',
  'REDIS_URL=redis://:oldredissecret@127.0.0.1:6379',
  '',
].join('\n');

test('a new .env has every placeholder replaced and the API connecting as its own role', () => {
  const result = buildEnv({ example, existing: undefined, generate: counter() });
  assert.equal(result.created, true);
  assert.doesNotMatch(result.content, /change-me/);
  const env = parseEnv(result.content);
  assert.equal(new Set(result.generated).size, 4, 'four distinct generated secrets');
  const api = new URL(env.get('DATABASE_URL'));
  assert.equal(api.username, 'agentos_api');
  assert.equal(api.password, env.get('POSTGRES_APP_PASSWORD'));
  const migrate = new URL(env.get('DATABASE_MIGRATE_URL'));
  assert.equal(migrate.username, 'agentos_migrate');
  assert.equal(migrate.password, env.get('POSTGRES_MIGRATE_PASSWORD'));
  const admin = new URL(env.get('DATABASE_ADMIN_URL'));
  assert.equal(admin.username, env.get('POSTGRES_USER'));
  assert.equal(admin.password, env.get('POSTGRES_PASSWORD'));
  assert.notEqual(env.get('POSTGRES_APP_PASSWORD'), env.get('POSTGRES_MIGRATE_PASSWORD'));
  assert.notEqual(env.get('POSTGRES_APP_PASSWORD'), env.get('POSTGRES_PASSWORD'));
});

test('an existing .env keeps every existing line byte for byte and only gains what is missing', () => {
  const result = buildEnv({ example, existing: legacyEnv, generate: counter() });
  assert.equal(result.created, false);
  for (const name of [
    'DATABASE_ADMIN_URL',
    'DATABASE_MIGRATE_URL',
    'POSTGRES_APP_PASSWORD',
    'POSTGRES_MIGRATE_PASSWORD',
  ])
    assert.ok(result.added.includes(name), `added ${name}`);
  assert.ok(!result.added.includes('POSTGRES_PASSWORD'), 'a variable that exists is never "added"');
  assert.ok(!result.added.includes('DATABASE_URL'));
  // Every line of the old file that is not the migrated DATABASE_URL is still present, unchanged.
  for (const line of legacyEnv.split('\n').filter((l) => l && !l.startsWith('DATABASE_URL='))) {
    assert.ok(result.content.split('\n').includes(line), `kept: ${line.split('=')[0]}`);
  }
  assert.doesNotMatch(result.content, /change-me/);
});

test("the appended URLs use the developer's own port and database, and the passwords that already exist", () => {
  const env = parseEnv(buildEnv({ example, existing: legacyEnv, generate: counter() }).content);
  const admin = new URL(env.get('DATABASE_ADMIN_URL'));
  assert.equal(admin.port, '5544');
  assert.equal(admin.pathname, '/mydb');
  assert.equal(admin.password, 'oldpgsecret', 'the admin URL reuses the existing superuser password');
  const migrate = new URL(env.get('DATABASE_MIGRATE_URL'));
  assert.equal(migrate.port, '5544');
  assert.equal(migrate.pathname, '/mydb');
  assert.equal(migrate.password, env.get('POSTGRES_MIGRATE_PASSWORD'));
});

test('a legacy DATABASE_URL that logs in as the superuser is switched to the API role, keeping host, port and database', () => {
  const result = buildEnv({ example, existing: legacyEnv, generate: counter() });
  assert.deepEqual(result.migrated, ['DATABASE_URL']);
  const env = parseEnv(result.content);
  const api = new URL(env.get('DATABASE_URL'));
  assert.equal(api.username, 'agentos_api');
  assert.equal(api.password, env.get('POSTGRES_APP_PASSWORD'));
  assert.equal(api.port, '5544');
  assert.equal(api.pathname, '/mydb');
  assert.equal(api.search, '?schema=public');
});

test('a DATABASE_URL the developer wrote themselves is respected', () => {
  const custom = legacyEnv.replace(
    /^DATABASE_URL=.*$/m,
    'DATABASE_URL=postgresql://someone:theirs@db.internal:5432/other',
  );
  const result = buildEnv({ example, existing: custom, generate: counter() });
  assert.deepEqual(result.migrated, []);
  assert.equal(
    parseEnv(result.content).get('DATABASE_URL'),
    'postgresql://someone:theirs@db.internal:5432/other',
  );
});

test('an already complete .env is left exactly as it is', () => {
  const complete = buildEnv({ example, existing: undefined, generate: counter() }).content;
  const again = buildEnv({ example, existing: complete, generate: counter() });
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.migrated, []);
  assert.equal(again.content, complete);
});

test('placeholders are replaced independently: a longer placeholder is never clobbered by a shorter one', () => {
  const env = parseEnv(buildEnv({ example, existing: undefined, generate: counter() }).content);
  const passwords = [
    env.get('POSTGRES_PASSWORD'),
    env.get('REDIS_PASSWORD'),
    env.get('POSTGRES_MIGRATE_PASSWORD'),
    env.get('POSTGRES_APP_PASSWORD'),
  ];
  assert.equal(new Set(passwords).size, 4);
  for (const value of passwords) assert.match(value, /^secret\d+$/);
});
