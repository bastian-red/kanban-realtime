/**
 * A health check that actually checks.
 *
 * The failure mode this file exists to prevent is a `/health` that returns
 * `{"status":"ok"}` because the process is running, in front of a database that
 * has been unreachable for an hour. Every dependency the API cannot serve a
 * request without is exercised for real: a round trip to Postgres and a round
 * trip to Redis. A dependency that is only listed is a dependency that is not
 * checked.
 *
 * The two are not equal, and the status reflects that. Postgres down means no
 * route can answer. Redis down means rate limiting fails open and the presence
 * roster is empty -- the board still loads and cards still move, so the API is
 * degraded rather than dead. Both still answer 503, because "degraded" is the
 * strongest word `healthSchema` has and a monitor that sees 200 will not page
 * anybody.
 *
 * The gateway's `/health` does strictly more than this one: it also round-trips a
 * nonce through the Socket.io Redis adapter. See apps/realtime for why a
 * liveness-only probe misses the failure that matters most there.
 *
 * Each check is timed and given its own `detail`, because "which one" is the
 * first question anybody asks and a bare boolean does not answer it.
 */
import type { Health } from '@kan/shared';
import { Inject, Injectable } from '@nestjs/common';

import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

type Check = Health['checks'][number];

/** How long a single dependency probe may take before it is called a failure. */
const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  /**
   * When this process became able to serve traffic.
   *
   * Captured here rather than read from `process.uptime()`, which counts from
   * when Node started -- including the seconds spent connecting to Postgres and
   * compiling. The number a reader wants is "how long has this been up", and the
   * two differ by exactly the interval where it was not.
   */
  private readonly startedAt = Date.now();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async check(): Promise<Health> {
    // Concurrently: two sequential 2-second timeouts make a fully dead stack take
    // four seconds to report, and a health endpoint that is slow when things are
    // broken is the one that gets its timeout raised until it means nothing.
    const checks = await Promise.all([this.postgres(), this.redisCheck()]);

    return {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      version: this.config.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  private postgres(): Promise<Check> {
    // `SELECT 1` rather than a count: it proves the connection and the credentials
    // without its cost depending on how big the board has become.
    return timed('postgres', async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  private redisCheck(): Promise<Check> {
    // `PING` for the same reason. `RedisService` is configured never to queue
    // commands offline, so this rejects promptly instead of hanging until the
    // socket returns -- which is the whole point of having a timeout here at all.
    return timed('redis', async () => {
      await this.redis.client.ping();
    });
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
async function timed(name: string, probe: () => Promise<unknown>): Promise<Check> {
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
