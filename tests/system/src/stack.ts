import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QueueProducer, createRedisConnection, type Redis } from '@agentos/queue';
import { Queue } from 'bullmq';

const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE_FILE = join(REPO_ROOT, 'infrastructure/compose/docker-compose.yml');

/** Only projects whose name starts with this are ever deleted (volumes included). A developer's `agentos` project never is. */
export const THROWAWAY_PREFIX = 'agentos-systest-';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The environment for `docker compose`. Compose gives SHELL environment variables priority over `--env-file`, and task runners
 * such as Nx load the repository `.env` (the developer's ports and passwords) into every task's environment. Left in place,
 * those values silently override the throwaway stack's generated ones, so the "isolated" stack would publish on the developer's
 * ports with the developer's credentials. Every variable the project's configuration defines is therefore removed here.
 */
function composeEnvironment(): NodeJS.ProcessEnv {
  const names = new Set(['AGENTOS_NETWORK', 'DATABASE_URL', 'REDIS_URL']);
  for (const match of readFileSync(join(REPO_ROOT, '.env.example'), 'utf8').matchAll(
    /^#?\s*([A-Z][A-Z0-9_]*)=/gm,
  )) {
    names.add(match[1] as string);
  }
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!names.has(key) && !key.startsWith('COMPOSE_')) clean[key] = value;
  }
  return clean;
}

export function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      {
        cwd: REPO_ROOT,
        ...(options.env === undefined ? {} : { env: options.env }),
        timeout: options.timeoutMs ?? 300_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1;
        resolveResult({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

export interface ContainerState {
  status: string; // running | exited | created | restarting | ...
  exitCode: number;
  restartCount: number;
  health: string; // healthy | unhealthy | starting | none
  startedAt: string;
  finishedAt: string;
  oomKilled: boolean;
}

export interface StackOptions {
  /** Extra variables for the Compose env file (e.g. an invalid WORKER_CONCURRENCY for a failure-path test). */
  env?: Record<string, string>;
  /**
   * Replaces the worker container's command through a throwaway Compose override file (never committed). Used to run the
   * test-only entry that contains a handler which never ends, inside the real image, under the real restart policy.
   */
  workerCommand?: string[];
}

/**
 * One complete, isolated Docker Compose project for a test file: its own name (hence its own volumes), its own network name,
 * its own random host ports and its own generated credentials. It can run next to a developer's stack without touching it.
 */
export class Stack {
  readonly project = `${THROWAWAY_PREFIX}${randomBytes(4).toString('hex')}`;
  private readonly dir = mkdtempSync(join(tmpdir(), 'agentos-systest-'));
  private readonly envFile = join(this.dir, 'env');
  private readonly overrideFile = join(this.dir, 'override.yml');
  readonly redisPassword = randomBytes(16).toString('hex');
  ports = { api: 0, web: 0, postgres: 0, redis: 0 };
  readonly prefix = 'systest';
  readonly workerName = 'systest-worker';
  private connection?: Redis;
  private queueHandle?: Queue;
  private producerHandle?: QueueProducer;

  private constructor(private readonly options: StackOptions) {}

  static async create(options: StackOptions = {}): Promise<Stack> {
    const stack = new Stack(options);
    stack.ports = {
      api: await freePort(),
      web: await freePort(),
      postgres: await freePort(),
      redis: await freePort(),
    };
    const postgresPassword = randomBytes(16).toString('hex');
    const lines = {
      POSTGRES_USER: 'agentos',
      POSTGRES_PASSWORD: postgresPassword,
      POSTGRES_DB: 'agentos',
      POSTGRES_PORT: String(stack.ports.postgres),
      REDIS_PASSWORD: stack.redisPassword,
      REDIS_PORT: String(stack.ports.redis),
      API_PORT: String(stack.ports.api),
      WEB_PORT: String(stack.ports.web),
      AGENTOS_NETWORK: `${stack.project}-net`,
      QUEUE_PREFIX: stack.prefix,
      WORKER_NAME: stack.workerName,
      // Short, test-friendly timings (the production defaults are in .env.example).
      WORKER_LOCK_DURATION_MS: '2000',
      WORKER_SHUTDOWN_GRACE_MS: '20000',
      ...options.env,
    };
    if (options.workerCommand) {
      writeFileSync(
        stack.overrideFile,
        // working_dir: the test entry is run by tsx, which is installed in apps/worker (not at the workspace root).
        `services:\n  worker:\n    working_dir: /app/apps/worker\n    command: ${JSON.stringify(options.workerCommand)}\n`,
      );
    }
    writeFileSync(
      stack.envFile,
      `${Object.entries(lines)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    );
    await stack.assertIsolated();
    return stack;
  }

  /**
   * Fails the run if Compose resolves anything other than the throwaway values this harness generated (ports, network,
   * credentials, project). A leak from the ambient environment (see composeEnvironment) must stop the test, never run it
   * against a developer's ports or credentials. Values are never printed.
   */
  private async assertIsolated(): Promise<void> {
    const result = await this.compose(['config', '--format', 'json']);
    if (result.code !== 0) throw new Error(`compose config failed: ${result.stderr.slice(-500)}`);
    const config = JSON.parse(result.stdout) as {
      name?: string;
      networks?: Record<string, { name?: string }>;
      services?: Record<
        string,
        { environment?: Record<string, string>; ports?: Array<{ published?: string | number }> }
      >;
    };
    const published = (service: string) => String(config.services?.[service]?.ports?.[0]?.published);
    const problems: string[] = [];
    if (config.name !== this.project) problems.push('project name');
    if (config.networks?.['agentos-net']?.name !== `${this.project}-net`) problems.push('network name');
    if (published('redis') !== String(this.ports.redis)) problems.push('redis port');
    if (published('postgres') !== String(this.ports.postgres)) problems.push('postgres port');
    if (published('api') !== String(this.ports.api)) problems.push('api port');
    if (published('web') !== String(this.ports.web)) problems.push('web port');
    if (config.services?.redis?.environment?.REDIS_PASSWORD !== this.redisPassword)
      problems.push('redis password');
    if (problems.length > 0) {
      throw new Error(
        `system-test isolation broken: Compose resolved different ${problems.join(', ')} than the harness generated ` +
          '(an ambient environment variable is overriding the throwaway configuration)',
      );
    }
  }

  private composeArgs(args: string[]): string[] {
    return [
      'compose',
      '-p',
      this.project,
      '--env-file',
      this.envFile,
      '-f',
      COMPOSE_FILE,
      ...(this.options.workerCommand ? ['-f', this.overrideFile] : []),
      '--profile',
      'app',
      ...args,
    ];
  }

  /** Runs `docker compose <args>` for this project. */
  compose(args: string[], timeoutMs?: number): Promise<CommandResult> {
    return run('docker', this.composeArgs(args), {
      env: composeEnvironment(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  /** `compose up -d [--wait]`; throws with the (secret-free) compose output when it fails. */
  async up(
    services: string[],
    { wait = true, noDeps = false }: { wait?: boolean; noDeps?: boolean } = {},
  ): Promise<void> {
    const result = await this.compose(
      [
        'up',
        '-d',
        ...(wait ? ['--wait', '--wait-timeout', '240'] : []),
        ...(noDeps ? ['--no-deps'] : []),
        ...services,
      ],
      420_000,
    );
    if (result.code !== 0)
      throw new Error(
        `compose up ${services.join(' ')} failed (${result.code}):\n${result.stderr.slice(-2000)}`,
      );
  }

  async containerId(service: string): Promise<string> {
    const result = await this.compose(['ps', '-a', '-q', service]);
    const id = result.stdout.trim().split(/\s+/)[0];
    if (!id) throw new Error(`no container for service ${service}`);
    return id;
  }

  async state(service: string): Promise<ContainerState> {
    const id = await this.containerId(service);
    const result = await run('docker', ['inspect', id]);
    if (result.code !== 0) throw new Error(`docker inspect failed: ${result.stderr}`);
    const info = (
      JSON.parse(result.stdout) as Array<{
        State: Record<string, unknown> & { Health?: { Status: string } };
        RestartCount: number;
      }>
    )[0];
    if (!info) throw new Error(`no inspect data for ${service}`);
    return {
      status: String(info.State.Status),
      exitCode: Number(info.State.ExitCode),
      restartCount: info.RestartCount,
      health: info.State.Health?.Status ?? 'none',
      startedAt: String(info.State.StartedAt),
      finishedAt: String(info.State.FinishedAt),
      oomKilled: Boolean(info.State.OOMKilled),
    };
  }

  /**
   * Signals a process INSIDE the container (found through the pid in the worker's heartbeat file). This is what a crash or an
   * external terminate looks like to Docker: the container's process EXITS BY ITSELF and the restart policy applies.
   * Do NOT use `docker kill` / `docker stop` for that: Docker treats them as a manual stop and never restarts the container.
   */
  async signalWorkerProcess(signal: 'SIGKILL' | 'SIGTERM'): Promise<void> {
    const script = `const {pid}=JSON.parse(require('fs').readFileSync('/tmp/worker-health.json','utf8'));process.kill(pid,'${signal}')`;
    const result = await this.exec('worker', ['node', '-e', script]);
    if (result.code !== 0)
      throw new Error(`could not signal the worker process: ${result.stderr.slice(-500)}`);
  }

  async logs(service: string): Promise<string> {
    const result = await this.compose(['logs', '--no-color', '--no-log-prefix', service]);
    return result.stdout + result.stderr;
  }

  /** Runs a command inside the running container of a service. */
  async exec(service: string, command: string[]): Promise<CommandResult> {
    return this.compose(['exec', '-T', service, ...command], 60_000);
  }

  apiUrl(path: string): string {
    return `http://127.0.0.1:${this.ports.api}${path}`;
  }
  webUrl(path: string): string {
    return `http://127.0.0.1:${this.ports.web}${path}`;
  }

  /** A Redis connection from the test process to the stack's Redis (published on a random 127.0.0.1 port). */
  redis(): Redis {
    this.connection ??= createRedisConnection(
      `redis://:${this.redisPassword}@127.0.0.1:${this.ports.redis}`,
      {
        role: 'producer',
        name: 'systest',
        onError: () => undefined, // tests stop Redis on purpose
      },
    );
    return this.connection;
  }

  producer(): QueueProducer {
    this.producerHandle ??= new QueueProducer({ connection: this.redis(), prefix: this.prefix });
    return this.producerHandle;
  }

  queue(): Queue {
    if (!this.queueHandle) {
      this.queueHandle = new Queue('system', { connection: this.redis(), prefix: this.prefix });
      this.queueHandle.on('error', () => undefined);
    }
    return this.queueHandle;
  }

  async jobState(jobId: string): Promise<string> {
    const job = await this.queue().getJob(jobId);
    return job ? job.getState() : 'missing';
  }

  /** Names of the Redis clients that belong to worker processes of this stack ("agentos:<worker name>:<pid>"). */
  async workerConnections(): Promise<string[]> {
    const list = (await this.redis().client('LIST')) as string;
    return list
      .split('\n')
      .map((line) => /(?:^|\s)name=(\S*)/.exec(line)?.[1] ?? '')
      .filter((name) => name.startsWith(`agentos:${this.workerName}:`));
  }

  /** Stops everything and deletes this project's containers, network and volumes. Refuses any project it did not create. */
  async destroy(): Promise<void> {
    if (!this.project.startsWith(THROWAWAY_PREFIX)) {
      throw new Error(
        `refusing to delete volumes of project "${this.project}": it is not a throwaway system-test project`,
      );
    }
    await this.queueHandle?.close().catch(() => undefined);
    await this.producerHandle?.close().catch(() => undefined);
    this.connection?.disconnect();
    await this.compose(['down', '--volumes', '--remove-orphans', '--timeout', '5'], 180_000);
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Whether a named volume of THIS project exists (to prove that data survived a `down`). */
  async volumeExists(name: string): Promise<boolean> {
    const result = await run('docker', [
      'volume',
      'ls',
      '--quiet',
      '--filter',
      `name=^${this.project}_${name}$`,
    ]);
    return result.stdout.trim().length > 0;
  }
}

/** Builds the application images once (BuildKit caches layers), under a build-only project name. */
export async function buildImages(): Promise<void> {
  const envFile = join(mkdtempSync(join(tmpdir(), 'agentos-systest-build-')), 'env');
  // Images are built without secrets; these placeholder values only satisfy Compose's "required variable" checks.
  writeFileSync(envFile, 'POSTGRES_PASSWORD=build-only\nREDIS_PASSWORD=build-only\n', { mode: 0o600 });
  const result = await run(
    'docker',
    [
      'compose',
      '-p',
      `${THROWAWAY_PREFIX}build`,
      '--env-file',
      envFile,
      '-f',
      COMPOSE_FILE,
      '--profile',
      'app',
      'build',
    ],
    { timeoutMs: 1_500_000 },
  );
  rmSync(envFile, { force: true });
  if (result.code !== 0) throw new Error(`image build failed:\n${result.stderr.slice(-3000)}`);
}
