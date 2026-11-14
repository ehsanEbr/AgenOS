import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * A TCP proxy in front of Redis that tests can cut and restore. It simulates a network partition or a Redis restart for
 * the worker under test without touching Docker (so the test is deterministic and runs anywhere), while the REAL Redis keeps
 * running behind it and keeps the queue's data.
 *
 *   worker --> RedisProxy --> real Redis      cut():     existing connections are destroyed, new ones are refused
 *                                             restore(): new connections are accepted again
 */
export class RedisProxy {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  /** Starts listening on an ephemeral local port and returns that port. */
  async start(): Promise<number> {
    await this.listen(0);
    return this.port;
  }

  /** Destroys every open connection and refuses new ones until `restore()`. */
  async cut(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.sockets.forEach((socket) => socket.destroy());
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Accepts connections again on the SAME port, so clients that are reconnecting find it. */
  async restore(): Promise<void> {
    await this.listen(this.port);
  }

  async close(): Promise<void> {
    await this.cut();
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((client) => {
        const upstream = connect(this.target);
        this.sockets.add(client).add(upstream);
        const closeBoth = () => {
          client.destroy();
          upstream.destroy();
          this.sockets.delete(client);
          this.sockets.delete(upstream);
        };
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('error', closeBoth).on('close', closeBoth);
        upstream.on('error', closeBoth).on('close', closeBoth);
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }
}
