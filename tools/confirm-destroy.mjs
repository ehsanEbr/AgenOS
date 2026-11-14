#!/usr/bin/env node
// Guard for the destructive infrastructure command. Requires typing "destroy" (or passing --yes).
import { createInterface } from 'node:readline/promises';

if (process.argv.includes('--yes')) process.exit(0);

if (!process.stdin.isTTY) {
  console.error('Refusing to continue without an interactive confirmation. Re-run with --yes to force.');
  process.exit(1);
}

console.log(
  'This permanently erases the local PostgreSQL and Redis data volumes (all databases and cached data).',
);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Type "destroy" to continue: ');
rl.close();
if (answer.trim() !== 'destroy') {
  console.log('Aborted. Nothing was erased.');
  process.exit(1);
}
