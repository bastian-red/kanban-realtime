/**
 * A health check that checks the thing that actually breaks here.
 *
 * The API's `/health` pings Postgres and Redis, and for the API that is enough:
 * if both answer, every route can serve. The gateway has a third failure mode
 * that neither of those probes can see, and it is the one that matters most.
 *
 * **A gateway whose pub/sub is dead still works, locally.** Sockets stay
 * connected. Drags still land in Postgres. The two people who happen to be on
 * *this* replica still see each other. What stops is delivery to every other
 * replica -- silently, with no error anywhere, because publishing to Redis is
 * fire-and-forget and there is nothing to fail. A liveness probe reports green
 * for as long as the process is alive, and the product is broken for everyone
 * whose colleague landed on a different replica.
 *
 * So this probe **round-trips a nonce through the adapter's own two connections**:
 * publish on the pub client, wait for it on the sub client. That exercises both
 * directions of the exact pair the adapter uses, which is what the failure is
 * about. Pinging Redis proves only that a third connection can reach the server.
 *
 * The nonce goes on a channel beside the adapter's rather than on it. Writing an
 * unparseable message onto `socket.io#/#` would be handed to the adapter's own
 * decoder on every replica, and a health check that makes other processes log
 * errors is a health check people turn off.
 */
import { randomUUID } from 'node:crypto';

import type { HealthCheck, RealtimeHealth } from '@kan/shared';
import type { PrismaClient } from '@kan/db';
import type { Redis } from 'ioredis';

/** How long a single dependency probe may take before it is called a failure. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * The health channel, derived from the adapter's key.
 *
 * `socket.io` is `@socket.io/redis-adapter`'s default `key`, and this repo does
 * not override it. Deriving the name here rather than hardcoding a second literal
 * means a future custom key moves both together.
 */
export const ADAPTER_KEY = 'socket.io';
export const HEALTH_CHANNEL = `${ADAPTER_KEY}#health`;

export interface HealthDeps {
  prisma: PrismaClient;
  /** The adapter's publishing connection. */
  pub: Redis;
  /** The adapter's subscribing connection. Must not be used for commands. */
  sub: Redis;
  version: string;
  /** When this process became able to serve traffic. */
  startedAt: number;
  counts: () => { connectedSockets: number; rooms: number };
}

export async function checkHealth(deps: HealthDeps): Promise<RealtimeHealth> {
  // Concurrently: three sequential 2-second timeouts make a fully dead stack take
  // six seconds to report, and a health endpoint that is slow when things are
  // broken is the one that gets its timeout raised until it means nothing.
  const checks = await Promise.all([
    timed('postgres', async () => {
      // `SELECT 1` rather than a count: it proves the connection and the
      // credentials without its cost depending on how big the board has become.
      await deps.prisma.$queryRaw`SELECT 1`;
    }),
    timed('redis', () => deps.pub.ping()),
    timed('adapter', () => roundTrip(deps.pub, deps.sub)),
  ]);

  const { connectedSockets, rooms } = deps.counts();

  return {
    status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
    version: deps.version,
    uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    checks,
    // What turns a green tick into something diagnosable. A gateway with zero
    // sockets after a deploy is either idle or unreachable, and that number is
    // the first question anybody asks.
    connectedSockets,
    rooms,
  };
}

/**
 * Publish a nonce and wait to receive it.
 *
 * Subscribes for the duration rather than keeping a permanent subscription,
 * because a permanently subscribed health channel would deliver every replica's
 * nonce to every other replica -- N^2 messages a probe interval, forever, to
 * learn nothing extra.
 *
 * The listener is removed in `finally` whatever happens. Without that, a probe
 * that times out leaves its handler attached and the next one resolves on the
 * previous nonce.
 */
export async function roundTrip(pub: Redis, sub: Redis): Promise<void> {
  const nonce = randomUUID();

  let onMessage: ((channel: string, message: string) => void) | undefined;
  try {
    await sub.subscribe(HEALTH_CHANNEL);
    const received = new Promise<void>((resolve) => {
      onMessage = (channel, message) => {
        if (channel === HEALTH_CHANNEL && message === nonce) resolve();
      };
      sub.on('message', onMessage);
    });

    await pub.publish(HEALTH_CHANNEL, nonce);
    await received;
  } finally {
    if (onMessage) sub.off('message', onMessage);
    // Unsubscribing can fail if the connection dropped mid-probe, which is the
    // case this whole function exists to detect. The probe's own failure is the
    // report; this must not overwrite it with a different error.
    await sub.unsubscribe(HEALTH_CHANNEL).catch(() => undefined);
  }
}

/**
 * Run a probe with a name, a timeout and a latency.
 *
 * The timeout is not decoration. A dependency that is *slow* rather than down is
 * the harder failure: without a deadline the health check waits as long as the
 * dependency does, so the monitor times out with no body, and the one artefact
 * that would have said which dependency was at fault never arrives.
 */
export async function timed(name: string, probe: () => Promise<unknown>): Promise<HealthCheck> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { name, status: 'ok', latencyMs: Date.now() - startedAt, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Without this the timer keeps the event loop alive for two seconds after a
    // fast success, which makes `/health` the reason a process takes two seconds
    // to exit on SIGTERM.
    if (timer) clearTimeout(timer);
  }
}
