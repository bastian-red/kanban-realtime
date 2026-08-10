/**
 * Events per minute, per socket.
 *
 * In process memory, not in Redis, and that is the opposite of the choice the
 * REST API makes -- it keeps its counters in Redis so N replicas do not multiply
 * every limit by N. The difference is what is being limited. An HTTP client
 * spreads its requests across replicas behind a load balancer, so a per-process
 * counter there means the limit is whatever the balancer feels like. A **socket
 * lives on exactly one replica** for its whole life: every event it will ever
 * send arrives at this process. A Redis round trip per event would add a network
 * hop to the one interaction the product is judged on, to count something only
 * this process can see.
 *
 * A sliding window rather than a fixed one. A fixed window resets on the minute,
 * so a client can send the whole budget at 59.9s and the whole budget again at
 * 60.1s -- twice the limit in 200ms, which is exactly the burst the limit exists
 * to stop.
 *
 * Timestamps are kept in a plain array. The budget is a few hundred entries at
 * most, and a ring buffer here would be a data structure protecting against a
 * cost that is already bounded by the limit itself.
 */

export interface RateLimiterOptions {
  /** Events allowed per window. From SOCKET_EVENT_RATE_LIMIT. */
  limit: number;
  /** Window length in milliseconds. One minute, matching the API's buckets. */
  windowMs?: number;
  /** Injectable clock, so the window can be tested without waiting a minute. */
  now?: () => number;
}

export const DEFAULT_WINDOW_MS = 60_000;

export class SocketRateLimiter {
  private readonly hits: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error(`SOCKET_EVENT_RATE_LIMIT must be a positive integer, got ${options.limit}`);
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record an event and say whether it is allowed.
   *
   * Refused events are **not** recorded. Recording them would let a client that
   * is already over the limit hold itself over it indefinitely by continuing to
   * send -- the window would never drain, and a burst would turn into a permanent
   * block rather than a one-minute one.
   */
  take(): boolean {
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length > 0 && this.hits[0]! <= cutoff) this.hits.shift();

    if (this.hits.length >= this.limit) return false;
    this.hits.push(this.now());
    return true;
  }

  /** How many events remain in the current window. For the refusal message. */
  remaining(): number {
    const cutoff = this.now() - this.windowMs;
    const live = this.hits.filter((at) => at > cutoff).length;
    return Math.max(0, this.limit - live);
  }
}
