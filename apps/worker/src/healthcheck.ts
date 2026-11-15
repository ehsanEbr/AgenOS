import { readFileSync } from 'node:fs';
import { evaluateHealth } from './health';

/*
 * Health probe for supervisors (Docker `HEALTHCHECK CMD node dist/healthcheck.js`). Exit code 0 = healthy and ready, 1 = not.
 * It prints one line with the reason, which `docker inspect` keeps in the health log. It reads the heartbeat file that the
 * running worker maintains (see health.ts); it never connects to Redis itself, so a probe cannot add load or hide an outage.
 */

const path = process.env.WORKER_HEALTH_FILE;
if (!path) {
  process.stdout.write('WORKER_HEALTH_FILE is not set: health reporting is disabled for this worker\n');
  process.exit(1);
}

let raw: string | undefined;
try {
  raw = readFileSync(path, 'utf8');
} catch {
  raw = undefined;
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, but owned by someone else
  }
};

const verdict = evaluateHealth(raw, Date.now(), isProcessAlive);
process.stdout.write(`${verdict.healthy ? 'healthy' : 'unhealthy'}: ${verdict.reason}\n`);
process.exit(verdict.healthy ? 0 : 1);
