#!/usr/bin/env node
// Creates .env from .env.example with freshly generated random passwords, or - when .env already exists - ADDS the variables
// it is missing (new passwords and URLs introduced by a later version) without changing any value you already have.
// Never prints secrets.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Placeholder in .env.example -> the variable whose value replaces it. */
export const PLACEHOLDERS = {
  'change-me-postgres': 'POSTGRES_PASSWORD',
  'change-me-redis': 'REDIS_PASSWORD',
  'change-me-migrate': 'POSTGRES_MIGRATE_PASSWORD',
  'change-me-app': 'POSTGRES_APP_PASSWORD',
};

/** URL-safe, so it is valid inside connection strings. */
export const generateSecret = () => randomBytes(24).toString('hex');

/** `KEY=value` lines (active, not commented) as a Map. */
export function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/**
 * A DATABASE_*_URL taken from .env.example uses the example's host, port, database and (for the admin URL) superuser name.
 * For an existing .env, point it at the developer's own: the port, database and superuser already in their POSTGRES_* values.
 */
function adaptDatabaseUrl(name, value, current) {
  try {
    const url = new URL(value);
    const port = current.get('POSTGRES_PORT');
    const database = current.get('POSTGRES_DB');
    const superuser = current.get('POSTGRES_USER');
    if (port) url.port = port;
    if (database) url.pathname = `/${database}`;
    if (name === 'DATABASE_ADMIN_URL' && superuser) url.username = superuser;
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Pure core of the script.
 *   example   text of .env.example
 *   existing  text of the current .env, or undefined when there is none
 * Returns the new file content plus what changed (variable NAMES only, never values) and the secrets that were generated.
 */
export function buildEnv({ example, existing, generate = generateSecret }) {
  const generated = [];
  const current = existing === undefined ? new Map() : parseEnv(existing);

  // The value that replaces each placeholder: the password already in .env if there is one (so derived URLs agree with it),
  // otherwise a fresh secret.
  const replacement = {};
  for (const [placeholder, variable] of Object.entries(PLACEHOLDERS)) {
    const present = current.get(variable);
    if (present !== undefined && present !== '') {
      replacement[placeholder] = present;
    } else {
      replacement[placeholder] = generate();
      generated.push(replacement[placeholder]);
    }
  }
  const fill = (line) =>
    Object.entries(replacement)
      // Longest placeholder first: "change-me-postgres" must not clobber a longer placeholder that starts with it.
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((text, [placeholder, value]) => text.replaceAll(placeholder, value), line);

  if (existing === undefined) {
    return { content: fill(example), created: true, added: [], migrated: [], generated };
  }

  // Existing file: append what is missing, keep every existing line exactly as it is.
  const exampleLines = example.split(/\r?\n/);
  const added = [];
  const missing = [];
  for (const [index, line] of exampleLines.entries()) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match && !current.has(match[1])) {
      added.push(match[1]);
      // Carry the comment block directly above the variable along, so the appended text stays understandable.
      let start = index;
      while (start > 0 && exampleLines[start - 1].startsWith('#')) start -= 1;
      missing.push({ start, index });
    }
  }

  let content = existing;
  const migrated = [];

  // A .env from before the database roles were separated points the API at the superuser. That value is derivable and known to
  // be the shipped default, so it is replaced; anything else the developer wrote is respected.
  const databaseUrl = current.get('DATABASE_URL');
  const superuser = current.get('POSTGRES_USER');
  const superuserPassword = current.get('POSTGRES_PASSWORD');
  if (databaseUrl !== undefined && superuser !== undefined && superuserPassword !== undefined) {
    try {
      const url = new URL(databaseUrl);
      if (
        decodeURIComponent(url.username) === superuser &&
        decodeURIComponent(url.password) === superuserPassword
      ) {
        url.username = 'agentos_api';
        url.password = replacement['change-me-app'];
        content = content.replace(/^DATABASE_URL=.*$/m, () => `DATABASE_URL=${url.toString()}`);
        migrated.push('DATABASE_URL');
      }
    } catch {
      // not a URL: leave it alone, the API's own validation will say so
    }
  }

  if (missing.length > 0) {
    const chunks = [];
    let covered = -1;
    for (const { start, index } of missing) {
      const from = Math.max(start, covered + 1);
      const lines = exampleLines.slice(from, index + 1).map((line) => {
        const filled = fill(line);
        const match = /^(DATABASE_[A-Z_]*URL)=(.*)$/.exec(filled);
        return match ? `${match[1]}=${adaptDatabaseUrl(match[1], match[2], current)}` : filled;
      });
      chunks.push(lines.join('\n'));
      covered = index;
    }
    content = `${content.replace(/\s*$/, '')}\n\n${chunks.join('\n')}\n`;
  }
  return { content, created: false, added, migrated, generated };
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const target = resolve(root, '.env');
  const example = readFileSync(resolve(root, '.env.example'), 'utf8');
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const result = buildEnv({ example, existing });

  // On GitHub Actions, register the generated values as masked BEFORE anything else can print them: any later log line that
  // contains one (a connection string in an error message, for instance) is replaced by *** in the job log.
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const secret of result.generated) console.log(`::add-mask::${secret}`);
  }

  if (result.created) {
    // The 'wx' flag fails if the file appeared in the meantime, so a race cannot overwrite someone's .env.
    writeFileSync(target, result.content, { flag: 'wx', mode: 0o600 });
    console.log('Created .env with generated local passwords (git-ignored). Next: pnpm infra:up');
    return;
  }
  if (result.added.length === 0 && result.migrated.length === 0) {
    console.log('.env already exists and is complete; leaving it untouched.');
    return;
  }
  writeFileSync(target, result.content, { mode: 0o600 });
  console.log('.env already exists; kept every existing value.');
  if (result.added.length > 0) console.log(`  added missing variables: ${result.added.join(', ')}`);
  if (result.migrated.length > 0)
    console.log(
      `  switched ${result.migrated.join(', ')} from the database superuser to the API role (the API no longer runs as a superuser).`,
    );
  console.log(
    'Next: pnpm infra:up (provisions the database roles on your existing data volume; no data is touched)',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
