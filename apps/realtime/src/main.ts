/**
 * The gateway process.
 *
 * The boot sequence has one property worth stating, and it is the same one the
 * API's `main.ts` states: **every reason this process will not work is discovered
 * before it accepts a connection.** `loadConfig` refuses a malformed variable,
 * `assertBootable` refuses a value whose shape is fine and whose meaning is not,
 * Prisma connects eagerly, and both Redis connections are awaited. A gateway that
 * starts and then fails on the first handshake presents to a user as a board that
 * renders and never moves, which is the hardest symptom in this product to trace.
 *
 * `/health` is served by this process's own HTTP server rather than by a second
 * one, because Socket.io needs an HTTP server anyway and a health check on a
 * different port is a health check that can pass while the port people actually
 * use is wedged.
 */
import { createServer } from 'node:http';

import { PrismaClient } from '@kan/db';
import Redis from 'ioredis';
import { Server } from 'socket.io';

import { assertBootable } from './boot';
import { ConfigError, loadConfig } from './config';
import { attachGateway, localCounts } from './gateway';
import { checkHealth } from './health';

/**
 * `console.warn`, not `console.log`.
 *
 * The gateway has no Nest logger and does not need one -- it writes eight lines
 * in its whole life, all at boot or shutdown. `no-console` allows `warn` and
 * `error` because those go to stderr, which is where a process without a log
 * shipper should put anything a human is meant to read: stdout on a socket server
 * belongs to whatever a future reader decides to pipe it into.
 */
const log = (message: string): void => {
  console.warn(`[realtime] ${message}`);
};

const logError = (message: string, error: unknown): void => {
  console.error(`[realtime] ${message}: ${error instanceof Error ? error.message : String(error)}`);
};

/**
 * A Redis connection for the adapter.
 *
 * `enableOfflineQueue` stays **on** here, unlike the API's client, and the
 * difference is what each connection is for. The API's Redis holds rate-limit
 * counters and a cache, so a command issued while the connection is down must
 * fail fast and let the request degrade. These two carry broadcasts: queueing a
 * publish through a two-second reconnect delivers the card movement late, and
 * failing it drops the movement for every other replica permanently.
 *
 * The `error` listener is not optional. An ioredis client with no listener on
 * `error` re-emits as an unhandled `'error'` event and Node takes the process
 * down with it -- so a momentary Redis blip would kill every socket this replica
 * holds.
 */
function redisFor(url: string, role: string): Redis {
  const client = new Redis(url, {
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  client.on('error', (error: unknown) => {
    // `debug`-level in spirit: a Redis outage produces one of these per reconnect
    // attempt, and at error level it buries every other line in the log. /health
    // is where an outage is meant to be visible.
    logError(`redis (${role})`, error);
  });
  return client;
}

async function bootstrap(): Promise<void> {
  // Loaded before anything is constructed, on purpose: a bad variable is one
  // printed line rather than a stack trace from inside a client's constructor.
  const config = loadConfig();
  assertBootable(config);

  const prisma = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
    log: config.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
  });
  // Eagerly. Prisma connects lazily on the first query otherwise, which means an
  // unreachable database shows up as one failed drag rather than as a process
  // that refused to start.
  await prisma.$connect();
  log('connected to Postgres');

  // Two connections, and they must be two: a Redis client in subscriber mode
  // refuses every other command, so one connection could subscribe or publish but
  // not both. `duplicate()` rather than a second `new Redis(...)` so the options
  // cannot drift apart.
  const pub = redisFor(config.redisUrl, 'pub');
  const sub = pub.duplicate();
  sub.on('error', (error: unknown) => logError('redis (sub)', error));
  await Promise.all([pub.ping(), sub.ping()]);
  log('connected to Redis (pub and sub)');

  const startedAt = Date.now();
  const http = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.split('?')[0] === '/health') {
      void checkHealth({
        prisma,
        pub,
        sub,
        version: config.version,
        startedAt,
        counts: () => localCounts(io),
      }).then((health) => {
        const body = JSON.stringify(health);
        // The code follows `status` because a container runtime cannot parse
        // JSON; the body names the failing check because a bare 503 does not say
        // which dependency died. Both readers are real: HEALTHCHECK reads the
        // code, scripts/dev-smoke.sh reads the body.
        response.writeHead(health.status === 'ok' ? 200 : 503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(body);
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  const io = new Server(http, {
    // The browser talks to this process directly, unlike the API, so it does have
    // an origin to allow -- and exactly one.
    cors: { origin: config.appBaseUrl, credentials: true },
    // A card's title, description and move intent are all well under 1 KB. The
    // ceiling stops a single client from pinning a replica with a payload nobody
    // asked for.
    maxHttpBufferSize: config.socket.maxPayloadBytes,
    // Slightly more than twice the presence heartbeat, for the same reason the
    // presence TTL is: at exactly 2x, one dropped packet disconnects somebody who
    // is still looking at the board.
    pingTimeout: config.presence.heartbeatSeconds * 2_500,
  });

  attachGateway({ io, prisma, pub, sub, config, log, logError });

  http.listen(config.port, '0.0.0.0', () => {
    log(`gateway ${config.version} listening on http://0.0.0.0:${config.port} (${config.nodeEnv})`);
  });

  /**
   * Shutdown, in the order that loses the least.
   *
   * `io.close()` first, so connected clients get a disconnect they can reconnect
   * from rather than a dropped TCP connection they discover on their next drag.
   * Redis last, because the `disconnecting` handlers above still need it to clear
   * their presence entries.
   */
  const shutdown = (signal: string): void => {
    log(`${signal} received, shutting down`);
    void (async () => {
      await io.close();
      await prisma.$disconnect();
      pub.disconnect();
      sub.disconnect();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // The message names the variable and the stack names this file, so the stack
    // is noise.
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
