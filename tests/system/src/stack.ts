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
function composeEnvironment(injectAfterSanitizing: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Besides everything documented in .env.example: the variables scripts and this harness set themselves.
  const names = new Set([
    'AGENTOS_NETWORK',
    'AGENTOS_IMAGE_TAG',
    'GIT_REVISION',
    'DATABASE_URL',
    'REDIS_URL',
  ]);
  for (const match of readFileSync(join(REPO_ROOT, '.env.example'), 'utf8').matchAll(
    /^#?\s*([A-Z][A-Z0-9_]*)=/gm,
  )) {
    names.add(match[1] as string);
  }
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!names.has(key) && !key.startsWith('COMPOSE_')) clean[key] = value;
  }
  // Only the isolation guard's own fault-injection test uses this (see StackOptions.injectAfterSanitizing).
  return { ...clean, ...injectAfterSanitizing };
}

/** Image tag used by the system tests. Developers' images are tagged `local`; the two never share an image. */
export const TEST_IMAGE_TAG = 'systest';
export const APP_IMAGES = ['agentos-api', 'agentos-worker', 'agentos-web'] as const;
const REVISION_LABEL = 'org.opencontainers.image.revision';

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
  /**
   * FAULT INJECTION ONLY. Variables added to the environment of `docker compose` AFTER the ambient environment was sanitized,
   * to simulate a leak the sanitizing missed. Used solely by the test that proves the isolation guard aborts.
   */
  injectAfterSanitizing?: Record<string, string>;
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
  readonly redisPassword: string;
  private readonly postgresPassword: string;
  ports = { api: 0, web: 0, postgres: 0, redis: 0 };
  readonly prefix = 'systest';
  readonly workerName = 'systest-worker';
  private connection?: Redis;
  private queueHandle?: Queue;
  private producerHandle?: QueueProducer;

  private constructor(
    private readonly options: StackOptions,
    passwords: { redis: string; postgres: string },
  ) {
    this.redisPassword = passwords.redis;
    this.postgresPassword = passwords.postgres;
  }

  static async create(options: StackOptions = {}): Promise<Stack> {
    const stack = new Stack(options, {
      redis: options.env?.REDIS_PASSWORD ?? randomBytes(16).toString('hex'),
      postgres: options.env?.POSTGRES_PASSWORD ?? randomBytes(16).toString('hex'),
    });
    try {
      stack.ports = {
        api: await freePort(),
        web: await freePort(),
        postgres: await freePort(),
        redis: await freePort(),
      };
      const lines = {
        POSTGRES_USER: 'agentos',
        POSTGRES_PASSWORD: stack.postgresPassword,
        POSTGRES_DB: 'agentos',
        POSTGRES_PORT: String(stack.ports.postgres),
        REDIS_PASSWORD: stack.redisPassword,
        REDIS_PORT: String(stack.ports.redis),
        API_PORT: String(stack.ports.api),
        WEB_PORT: String(stack.ports.web),
        AGENTOS_NETWORK: `${stack.project}-net`,
        AGENTOS_IMAGE_TAG: TEST_IMAGE_TAG, // never the developer's `local` images
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
      await stack.assertIsolated(); // `compose config` only: no container, network, volume or port exists yet
      return stack;
    } catch (error) {
      // Never leave the generated credentials behind when creation is aborted.
      rmSync(stack.dir, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Fails the run if Compose resolves anything other than the throwaway values this harness generated (ports, network,
   * credentials, project). A leak from the ambient environment (see composeEnvironment) must stop the test, never run it
   * against a developer's ports or credentials. Values are never printed.
   */
  private async assertIsolated(): Promise<void> {
    const result = await this.compose(['config', '--format', 'json']);
    // Never echo compose output here: it contains the resolved environment, i.e. credentials.
    if (result.code !== 0)
      throw new Error('compose config failed (output withheld: it may contain credentials)');
    const config = JSON.parse(result.stdout) as {
      name?: string;
      networks?: Record<string, { name?: string }>;
      services?: Record<
        string,
        {
          image?: string;
          environment?: Record<string, string>;
          ports?: Array<{ published?: string | number }>;
        }
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
    if (config.services?.postgres?.environment?.POSTGRES_PASSWORD !== this.postgresPassword)
      problems.push('postgres password');
    for (const [service, image] of [
      ['api', 'agentos-api'],
      ['migrate', 'agentos-api'],
      ['worker', 'agentos-worker'],
      ['web', 'agentos-web'],
    ] as const) {
      if (config.services?.[service]?.image !== `${image}:${TEST_IMAGE_TAG}`)
        problems.push(`${service} image`);
    }
    if (problems.length > 0) {
      // Names the project and the kind of setting only, never a value.
      throw new Error(
        `system-test isolation broken (project ${this.project}): Compose resolved different ${problems.join(', ')} ` +
          'than the harness generated (an ambient environment variable is overriding the throwaway configuration)',
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
      env: composeEnvironment(this.options.injectAfterSanitizing),
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

  /** The ID of the image a service's container was created from (to prove the tests ran on the verified images). */
  async containerImageId(service: string): Promise<string> {
    const result = await run('docker', [
      'inspect',
      '--format',
      '{{.Image}}',
      await this.containerId(service),
    ]);
    if (result.code !== 0) throw new Error(`docker inspect failed: ${result.stderr}`);
    return result.stdout.trim();
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

/** The commit the working tree is at: `<sha>`, or `<sha>-dirty` when there are uncommitted changes. */
export async function currentRevision(): Promise<string> {
  const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('cannot determine the current git revision');
  const dirty = (await run('git', ['status', '--porcelain'])).stdout.trim().length > 0;
  return dirty ? `${head}-dirty` : head;
}

export interface ImageRecord {
  reference: string;
  id: string;
  created: string;
  /** The `org.opencontainers.image.revision` label: the commit the image was built from. */
  revision: string;
}

/** Reads the three application images with the given tag. Throws if one does not exist. */
export async function inspectImages(tag: string = TEST_IMAGE_TAG): Promise<ImageRecord[]> {
  const references = APP_IMAGES.map((name) => `${name}:${tag}`);
  const result = await run('docker', ['image', 'inspect', ...references]);
  if (result.code !== 0) throw new Error(`missing image(s) among ${references.join(', ')}: build them first`);
  const found = JSON.parse(result.stdout) as Array<{
    Id: string;
    Created: string;
    RepoTags: string[];
    Config?: { Labels?: Record<string, string> | null };
  }>;
  return references.map((reference) => {
    const image = found.find((entry) => entry.RepoTags.includes(reference));
    if (!image) throw new Error(`image ${reference} not found`);
    return {
      reference,
      id: image.Id,
      created: image.Created,
      revision: image.Config?.Labels?.[REVISION_LABEL] ?? 'none',
    };
  });
}

/**
 * Provenance rule: every application image must have been built from the revision being tested. An image built by anything
 * else (a developer's `pnpm stack:up`, an older commit, an image with no label) is rejected, never silently reused.
 * @returns problems; empty means every image is from `expectedRevision`
 */
export function checkProvenance(records: ImageRecord[], expectedRevision: string): string[] {
  const problems: string[] = [];
  for (const name of APP_IMAGES) {
    const record = records.find((r) => r.reference.startsWith(`${name}:`));
    if (!record) problems.push(`${name}: no image`);
    else if (record.revision !== expectedRevision) {
      problems.push(`${record.reference}: built from "${record.revision}", expected "${expectedRevision}"`);
    }
  }
  return problems;
}

/** Verifies the existing test images against the current revision (used on its own when the build is skipped). */
export async function verifyImageProvenance(): Promise<ImageRecord[]> {
  const records = await inspectImages();
  const problems = checkProvenance(records, await currentRevision());
  if (problems.length > 0) {
    throw new Error(`image provenance check failed:\n  ${problems.join('\n  ')}`);
  }
  return records;
}

/**
 * Builds the three application images for the CURRENT commit under the test tag, then verifies their provenance.
 * Built one target at a time, with a retry for a transient network error (the retry resumes from completed layers).
 * (An earlier version blamed "DeadlineExceeded" on concurrent builds; the real cause was the local DNS resolver intermittently
 * returning addresses that do not serve Docker Hub, see docs/architecture/docker-compose.md.)
 */
export async function buildImages(): Promise<ImageRecord[]> {
  const revision = await currentRevision();
  const buildDir = mkdtempSync(join(tmpdir(), 'agentos-systest-build-'));
  const envFile = join(buildDir, 'env');
  // Images are built without secrets; the placeholder passwords only satisfy Compose's "required variable" checks.
  writeFileSync(
    envFile,
    `POSTGRES_PASSWORD=build-only\nREDIS_PASSWORD=build-only\nAGENTOS_IMAGE_TAG=${TEST_IMAGE_TAG}\nGIT_REVISION=${revision}\n`,
    { mode: 0o600 },
  );
  const build = (service: string) =>
    run(
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
        service,
      ],
      { timeoutMs: 1_500_000, env: composeEnvironment() },
    );

  try {
    for (const service of ['api', 'worker', 'web']) {
      let result = await build(service);
      if (result.code !== 0) result = await build(service);
      if (result.code !== 0)
        throw new Error(`image build failed for ${service}:\n${result.stderr.slice(-3000)}`);
    }
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
  return verifyImageProvenance();
}
