#!/usr/bin/env node
// Creates .env from .env.example with freshly generated random passwords.
// Never overwrites an existing .env, and never prints secrets.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, '.env');
const example = resolve(root, '.env.example');

if (existsSync(target)) {
  console.log('.env already exists; leaving it untouched.');
  process.exit(0);
}

const secret = () => randomBytes(24).toString('hex'); // URL-safe, so it is valid inside connection strings
const postgresPassword = secret();
const redisPassword = secret();

const content = readFileSync(example, 'utf8')
  .replaceAll('change-me-postgres', postgresPassword)
  .replaceAll('change-me-redis', redisPassword);

// The 'wx' flag fails if the file appeared in the meantime, so a race cannot overwrite someone's .env.
writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
console.log('Created .env with generated local passwords (git-ignored). Next: pnpm infra:up');
