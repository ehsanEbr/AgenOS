#!/usr/bin/env node
// Keeps the environment configuration of the whole system consistent. Four places describe the same variables and drift
// apart silently when nobody checks: the application config schemas (what the code reads), `.env.example` (what a developer is
// told), the Docker Compose file (what containers receive) and the Dockerfile (what the images are built with).
//
//   node tools/check-env.mjs            checks the repository
//
// It reads files only (no Docker, no network), so it runs on every OS in `pnpm check:architecture`.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** Parses KEY=value lines. Returns active keys and the keys that appear only as commented-out examples ("# KEY=value"). */
export function parseEnvExample(text) {
  const active = new Map();
  const commented = new Set();
  const duplicates = [];
  for (const line of text.split(/\r?\n/)) {
    const active_ = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (active_) {
      if (active.has(active_[1])) duplicates.push(active_[1]);
      active.set(active_[1], active_[2]);
      continue;
    }
    const commented_ = /^#\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (commented_) commented.add(commented_[1]);
  }
  return { active, commented, duplicates };
}

/**
 * Reads the variables a zod `z.object({ NAME: ..., })` config schema declares, by a simple textual scan (the schemas are written
 * in a regular style). A variable is REQUIRED when its definition has neither `.default(` nor `.optional(`.
 */
export function parseConfigSchema(source) {
  const start = source.indexOf('z.object({');
  if (start === -1) return [];
  const body = source.slice(start);
  const keyPattern = /^ {2}([A-Z][A-Z0-9_]*):/gm;
  const hits = [...body.matchAll(keyPattern)];
  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : body.indexOf('\n});', hit.index);
    const definition = body.slice(hit.index, end === -1 ? undefined : end);
    return { name: hit[1], required: !/\.default\(|\.optional\(/.test(definition) };
  });
}

const placeholder = /^change-me(-[a-z]+)?$/;

/** @returns {string[]} human-readable problems; empty means consistent */
export function checkEnvironment(root) {
  const problems = [];
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const need = (path) => {
    if (existsSync(join(root, path))) return true;
    problems.push(`${path} is missing`);
    return false;
  };
  if (
    ![
      '.env.example',
      'infrastructure/compose/docker-compose.yml',
      'apps/api/src/modules/config/config.ts',
      'apps/worker/src/config.ts',
    ].every(need)
  ) {
    return problems;
  }

  const example = parseEnvExample(read('.env.example'));
  const documented = (name) => example.active.has(name) || example.commented.has(name);
  for (const name of example.duplicates) problems.push(`.env.example defines ${name} more than once`);

  // 1. Every variable an application reads is documented, and Compose provides the ones an app cannot start without.
  const schemas = {
    api: parseConfigSchema(read('apps/api/src/modules/config/config.ts')),
    worker: parseConfigSchema(read('apps/worker/src/config.ts')),
  };
  for (const [app, vars] of Object.entries(schemas)) {
    if (vars.length === 0)
      problems.push(
        `could not read the ${app} config schema (tools/check-env.mjs expects a z.object({ NAME: ... }) block)`,
      );
    for (const { name } of vars) {
      if (!documented(name)) problems.push(`${app} reads ${name} but .env.example does not document it`);
    }
  }

  // 2. Compose: every ${VAR} it references is documented; defaults agree with .env.example; containers only receive variables
  //    their application reads (a typo would be silently ignored otherwise), and all REQUIRED ones.
  const composeText = read('infrastructure/compose/docker-compose.yml');
  const compose = parseYaml(composeText, { merge: true });
  const composeDefaults = new Map();
  for (const match of composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::([-?])([^}]*))?\}/g)) {
    const [, name, op, value] = match;
    if (name === 'AGENTOS_NETWORK') continue; // system tests override the network name; not a developer setting
    if (!documented(name))
      problems.push(`docker-compose.yml references \${${name}} but .env.example does not document it`);
    if (op === '-') composeDefaults.set(name, value);
  }
  for (const [name, fallback] of composeDefaults) {
    const declared = example.active.get(name);
    if (declared !== undefined && declared !== fallback) {
      problems.push(
        `${name}: docker-compose.yml defaults to "${fallback}" but .env.example says "${declared}"`,
      );
    }
  }
  for (const [service, app] of [
    ['api', 'api'],
    ['worker', 'worker'],
  ]) {
    const environment = compose.services?.[service]?.environment;
    if (!environment) {
      problems.push(`docker-compose.yml: service ${service} has no environment`);
      continue;
    }
    const known = new Set(schemas[app].map((v) => v.name));
    for (const name of Object.keys(environment)) {
      if (!known.has(name))
        problems.push(
          `docker-compose.yml: ${service} receives ${name}, which the ${app} config does not read`,
        );
    }
    for (const { name, required } of schemas[app]) {
      if (required && !(name in environment))
        problems.push(`docker-compose.yml: ${service} does not provide required ${name}`);
    }
  }

  // 3. The connection URLs agree with the component variables they were derived from.
  const url = (name) => {
    try {
      return new URL(example.active.get(name) ?? '');
    } catch {
      problems.push(`.env.example: ${name} is not a valid URL`);
      return undefined;
    }
  };
  const db = url('DATABASE_URL');
  if (db) {
    const want = {
      user: example.active.get('POSTGRES_USER'),
      password: example.active.get('POSTGRES_PASSWORD'),
      db: example.active.get('POSTGRES_DB'),
      port: example.active.get('POSTGRES_PORT'),
    };
    if (decodeURIComponent(db.username) !== want.user)
      problems.push('DATABASE_URL user differs from POSTGRES_USER');
    if (decodeURIComponent(db.password) !== want.password)
      problems.push('DATABASE_URL password differs from POSTGRES_PASSWORD');
    if (db.pathname.slice(1) !== want.db) problems.push('DATABASE_URL database differs from POSTGRES_DB');
    if (db.port !== want.port) problems.push('DATABASE_URL port differs from POSTGRES_PORT');
  }
  const redis = url('REDIS_URL');
  if (redis) {
    if (decodeURIComponent(redis.password) !== example.active.get('REDIS_PASSWORD'))
      problems.push('REDIS_URL password differs from REDIS_PASSWORD');
    if (redis.port !== example.active.get('REDIS_PORT'))
      problems.push('REDIS_URL port differs from REDIS_PORT');
  }

  // 4. Secrets: .env.example holds placeholders only.
  for (const name of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
    const value = example.active.get(name);
    if (value === undefined || !placeholder.test(value))
      problems.push(`.env.example: ${name} must be a "change-me-..." placeholder, never a real credential`);
  }
  for (const [name, value] of example.active) {
    if (/PASSWORD|SECRET|TOKEN|KEY/.test(name) && !placeholder.test(value))
      problems.push(`.env.example: ${name} looks like a secret but is not a placeholder`);
    if (/^[a-z]+:\/\/[^/@\s]*:[^/@\s]+@/.test(value) && !value.includes('change-me'))
      problems.push(`.env.example: ${name} embeds credentials that are not placeholders`);
  }

  // 5. The worker's Docker stop timeout must exceed its shutdown grace period, or Docker kills it mid-drain.
  const stop = String(compose.services?.worker?.stop_grace_period ?? '');
  const stopSeconds = /^(\d+)s$/.exec(stop)?.[1];
  const graceMs = Number(
    example.active.get('WORKER_SHUTDOWN_GRACE_MS') ?? composeDefaults.get('WORKER_SHUTDOWN_GRACE_MS'),
  );
  if (!stopSeconds)
    problems.push('docker-compose.yml: worker needs a stop_grace_period in whole seconds (e.g. 40s)');
  else if (Number(stopSeconds) * 1000 <= graceMs) {
    problems.push(
      `docker-compose.yml: worker stop_grace_period (${stop}) must exceed WORKER_SHUTDOWN_GRACE_MS (${graceMs} ms)`,
    );
  }
  if (
    composeDefaults.get('WORKER_SHUTDOWN_GRACE_MS') !== undefined &&
    Number(composeDefaults.get('WORKER_SHUTDOWN_GRACE_MS')) !== graceMs
  ) {
    problems.push('WORKER_SHUTDOWN_GRACE_MS differs between docker-compose.yml and .env.example');
  }

  // 6. Dockerfile toolchain matches the repository's.
  if (existsSync(join(root, 'infrastructure/docker/Dockerfile'))) {
    const dockerfile = read('infrastructure/docker/Dockerfile');
    const manifest = JSON.parse(read('package.json'));
    const pnpm = /^pnpm@(.+)$/.exec(manifest.packageManager ?? '')?.[1];
    const dockerPnpm = /^ARG PNPM_VERSION=(.+)$/m.exec(dockerfile)?.[1];
    if (pnpm !== dockerPnpm)
      problems.push(
        `Dockerfile PNPM_VERSION (${dockerPnpm}) differs from package.json packageManager (${pnpm})`,
      );
    const node = /^ARG NODE_VERSION=(\d+)\.(\d+)/m.exec(dockerfile);
    const minimum = /(\d+)\.(\d+)/.exec(manifest.engines?.node ?? '');
    if (
      !node ||
      !minimum ||
      Number(node[1]) < Number(minimum[1]) ||
      (Number(node[1]) === Number(minimum[1]) && Number(node[2]) < Number(minimum[2]))
    ) {
      problems.push(
        `Dockerfile NODE_VERSION is older than package.json engines.node (${manifest.engines?.node})`,
      );
    }
  }

  // 7. Web: every VITE_ variable the app reads is documented in its own .env.example.
  if (
    existsSync(join(root, 'apps/web/src/shared/config/env.ts')) &&
    existsSync(join(root, 'apps/web/.env.example'))
  ) {
    const webExample = parseEnvExample(read('apps/web/.env.example'));
    for (const name of new Set(read('apps/web/src/shared/config/env.ts').match(/VITE_[A-Z0-9_]+/g) ?? [])) {
      if (!webExample.active.has(name) && !webExample.commented.has(name))
        problems.push(`apps/web reads ${name} but apps/web/.env.example does not document it`);
    }
  }

  return problems;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const problems = checkEnvironment(root);
  if (problems.length > 0) {
    console.error('Environment configuration is inconsistent:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('Environment configuration OK: schemas, .env.example, Compose and Dockerfile agree.');
}
