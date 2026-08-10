/**
 * The one Redis connection in the process, and the rule that every caller relies
 * on: **it never throws.**
 *
 * Redis holds two things here, and neither of them is the source of truth. It
 * holds the rate-limit counters and it holds the monthly report cache, which is a
 * copy of numbers that live in Postgres. So an unreachable Redis has exactly one
 * correct behaviour: the report is computed from the database instead of being
 * read from the cache, and the request succeeds. Turning a cache miss into a 500
 * takes an outage in the least important dependency and makes it an outage in the
 * product.
 *
 * Two ioredis settings make that possible, and both are non-default:
 *
 * **`enableOfflineQueue: false`.** By default ioredis queues commands while the
 * connection is down and replays them when it comes back, so a `GET` against a
 * dead server does not fail, it *hangs* until the socket returns. A hung request
 * is worse than a failed one: the caller has no error to degrade on, and the
 * whole point of this file is to have one.
 *
 * **`maxRetriesPerRequest: 1`.** The default is 20, which turns one dead lookup
 * into twenty round trips of waiting before the rejection arrives.
 *
 * The `error` listener is not optional either. An ioredis client with no listener
 * on `error` re-emits as an unhandled `'error'` event, and Node takes the process
 * down with it. A cache being unreachable must not be able to kill the API.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';

@Injectable()
export class RedisService implements OnModuleDestroy {
  /**
   * Exposed for `ThrottlerStorageRedisService`, which takes an ioredis instance.
   *
   * Sharing one connection rather than letting the throttler open its own means
   * one place decides the offline behaviour, one place logs the outage, and one
   * socket is closed on shutdown.
   */
  readonly client: Redis;

  private readonly logger = new Logger(RedisService.name);
  /** The last transport failure, so `/health` can say *why* rather than "fail". */
  private lastError: string | null = null;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.client = new Redis(config.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      // Keep reconnecting, with a ceiling. A cache that gives up permanently
      // after a restart of the Redis container is a cache that needs the API
      // restarted too, which is a worse operational story than a few seconds of
      // uncached reads.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });

    this.client.on('error', (error: unknown) => {
      this.lastError = describe(error);
      // `debug`, not `error`: a Redis outage produces one of these per reconnect
      // attempt, and at error level it buries every other line in the log. The
      // health endpoint is where an outage is meant to be visible.
      this.logger.debug(`Redis: ${this.lastError}`);
    });

    this.client.on('ready', () => {
      this.lastError = null;
      this.logger.log('Connected to Redis');
    });
  }

  /** Round trip to the server. Throws, because `/health` wants the failure. */
  async ping(): Promise<string> {
    return this.client.ping();
  }

  /** The most recent transport error, for the health check's `detail`. */
  lastFailure(): string | null {
    return this.lastError;
  }

  /** A cached value, or null when there is none *or* Redis is unreachable. */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      return this.degrade('GET', key, error, null);
    }
  }

  /** Store with a TTL. Returns whether it was actually stored. */
  async setEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
      return true;
    } catch (error) {
      return this.degrade('SET', key, error, false);
    }
  }

  /**
   * `INCR`, returning the new value, or null when Redis is unreachable.
   *
   * Null is the signal that a version bump did not happen, which matters: the
   * cache entry written under the old version stays readable until its TTL
   * expires. That is the one correctness cost of a Redis outage in this app, it
   * is bounded by `REPORT_CACHE_TTL_SECONDS`, and it is the reason the TTL exists
   * at all given the version counter would otherwise make it redundant.
   */
  async incr(key: string): Promise<number | null> {
    try {
      return await this.client.incr(key);
    } catch (error) {
      return this.degrade('INCR', key, error, null);
    }
  }

  /**
   * The current value of a counter as an integer, defaulting to 0.
   *
   * A missing key and an unreachable server both read as 0, deliberately. Both
   * mean "there is no version to trust", and both lead to the same behaviour: the
   * lookup below will miss and the report is computed from Postgres.
   */
  async readCounter(key: string): Promise<number> {
    const raw = await this.get(key);
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  async onModuleDestroy(): Promise<void> {
    // `disconnect` rather than `quit`: quit waits for a reply from a server that
    // may be the reason we are shutting down.
    this.client.disconnect();
  }

  private degrade<T>(command: string, key: string, error: unknown, fallback: T): T {
    this.lastError = describe(error);
    this.logger.warn(`Redis ${command} ${key} failed, serving uncached: ${this.lastError}`);
    return fallback;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
