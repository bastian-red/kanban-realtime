/**
 * Who is on a board right now.
 *
 * Presence is the one piece of state in this product that is deliberately **not**
 * in Postgres. It is worthless a minute after it is written, every heartbeat
 * rewrites it, and it has to be shared by several gateway replicas -- which is
 * the definition of what Redis is for. Putting it in Postgres would mean a write
 * per client per ten seconds, forever, to a table nobody would ever read
 * historically.
 *
 * ---------------------------------------------------------------------------
 * The data structure, and why it is not a Set
 *
 * One Redis **hash** per board, `presence:<boardId>`, one field per *connection*:
 *
 *   HSET presence:b1 <socketId> '{"userId":...,"activity":"dragging","at":...}'
 *
 * Keyed by socket, not by user, because a person with two tabs open is one person
 * with two connections. Keyed by user, closing one tab would remove them from the
 * roster while they are still looking at the board in the other. `roster()`
 * collapses connections back to people and reports the count, which is also what
 * the presence chip shows.
 *
 * ---------------------------------------------------------------------------
 * Expiry: a per-field timestamp, not a per-key TTL
 *
 * Redis expires keys, not hash fields (`HEXPIRE` exists only from Redis 7.4, and
 * the compose file pins redis:7-alpine, which is 7.2). So each field carries the
 * instant it was last refreshed and `roster()` filters out anything older than
 * the TTL. That has a real advantage over the obvious alternative -- one key per
 * connection with `SET ... EX` -- which is that reading the roster is one `HGETALL`
 * rather than a `SCAN` over a keyspace, and `SCAN` under a hundred boards is the
 * kind of thing that looks fine until it is not.
 *
 * The whole key still gets a TTL, refreshed on every write. That is the garbage
 * collector: a board everybody left leaves a hash with a few dead fields in it,
 * and without a key TTL those hashes accumulate for as long as the process runs.
 *
 * ---------------------------------------------------------------------------
 * Why the sweep is not a background job
 *
 * Stale fields are removed on read (`roster` deletes what it filtered out) rather
 * than by a timer. A timer would need leader election across replicas to avoid N
 * copies of the same sweep, and a board nobody is reading does not need its
 * roster to be accurate -- there is nobody to be wrong in front of.
 */
import type { Redis } from 'ioredis';
import {
  initialsOf,
  type PresenceActivity,
  type PresenceMember,
  presenceColorSlot,
} from '@kan/shared';

export interface PresenceConfig {
  /** How often a client refreshes its entry. From PRESENCE_HEARTBEAT_SECONDS. */
  heartbeatSeconds: number;
  /**
   * How long an entry survives without a refresh. From PRESENCE_TTL_SECONDS.
   *
   * Deliberately more than twice the heartbeat: at exactly 2x, one dropped packet
   * evicts somebody who is still looking at the board, and a presence bar that
   * flickers is worse than one that is a few seconds stale.
   */
  ttlSeconds: number;
}

export interface PresenceIdentity {
  userId: string;
  name: string;
}

interface StoredEntry {
  userId: string;
  name: string;
  activity: PresenceActivity;
  /** Epoch milliseconds of the last heartbeat. */
  at: number;
}

export class PresenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresenceConfigError';
  }
}

export function assertPresenceConfig(config: PresenceConfig): void {
  if (config.heartbeatSeconds <= 0 || config.ttlSeconds <= 0) {
    throw new PresenceConfigError('Presence heartbeat and TTL must both be positive.');
  }
  if (config.ttlSeconds <= config.heartbeatSeconds * 2) {
    throw new PresenceConfigError(
      `PRESENCE_TTL_SECONDS (${config.ttlSeconds}) must be more than twice ` +
        `PRESENCE_HEARTBEAT_SECONDS (${config.heartbeatSeconds}). At or below 2x, a single ` +
        'dropped heartbeat evicts somebody who is still on the board.',
    );
  }
}

const keyFor = (boardId: string): string => `presence:${boardId}`;

export class PresenceStore {
  private readonly redis: Redis;
  private readonly config: PresenceConfig;
  /** Injectable clock, so the TTL can be tested without waiting for it. */
  private readonly now: () => number;

  constructor(redis: Redis, config: PresenceConfig, now: () => number = Date.now) {
    assertPresenceConfig(config);
    this.redis = redis;
    this.config = config;
    this.now = now;
  }

  /**
   * Record or refresh a connection.
   *
   * The same call for "joined" and "still here": a heartbeat is an upsert, so a
   * client that reconnects to a different replica needs no special handling, and
   * a missed join followed by a heartbeat is self-healing.
   */
  async touch(
    boardId: string,
    socketId: string,
    identity: PresenceIdentity,
    activity: PresenceActivity = 'viewing',
  ): Promise<void> {
    const entry: StoredEntry = {
      userId: identity.userId,
      name: identity.name,
      activity,
      at: this.now(),
    };
    const key = keyFor(boardId);
    // Pipelined: the field write and the key TTL are one round trip. They do not
    // need to be atomic with each other -- a key that briefly lacks a TTL is
    // harmless, and the next heartbeat sets it again.
    await this.redis
      .multi()
      .hset(key, socketId, JSON.stringify(entry))
      // Generous relative to the field TTL: the key only has to outlive the last
      // field, and refreshing it on every write means an active board's hash
      // never expires under its own users.
      .expire(key, this.config.ttlSeconds * 4)
      .exec();
  }

  /** Remove one connection. Called on disconnect, which is the common case. */
  async leave(boardId: string, socketId: string): Promise<void> {
    await this.redis.hdel(keyFor(boardId), socketId);
  }

  /**
   * Who is on the board, collapsed to people.
   *
   * Sweeps expired fields as a side effect: see the header for why that is on the
   * read path rather than in a timer.
   */
  async roster(boardId: string): Promise<PresenceMember[]> {
    const key = keyFor(boardId);
    const raw = await this.redis.hgetall(key);

    const cutoff = this.now() - this.config.ttlSeconds * 1000;
    const expired: string[] = [];
    const live: StoredEntry[] = [];

    for (const [socketId, value] of Object.entries(raw)) {
      let entry: StoredEntry | null = null;
      try {
        entry = JSON.parse(value) as StoredEntry;
      } catch {
        // A field written by an older version of this code, or a truncated write.
        // Unparseable is indistinguishable from expired for our purposes, and
        // keeping it would leave a ghost on the board forever.
        expired.push(socketId);
        continue;
      }
      if (!entry || typeof entry.at !== 'number' || entry.at < cutoff) {
        expired.push(socketId);
        continue;
      }
      live.push(entry);
    }

    if (expired.length > 0) {
      // Fire and forget would be wrong here: if this fails, the next read simply
      // sweeps again. Awaiting keeps the error visible to the caller's logging
      // rather than becoming an unhandled rejection that takes the gateway down.
      await this.redis.hdel(key, ...expired);
    }

    return collapse(live);
  }

  /** Everything about one board, for a hard reset. Used by tests and by the seed. */
  async clear(boardId: string): Promise<void> {
    await this.redis.del(keyFor(boardId));
  }
}

/**
 * Connections to people.
 *
 * Two rules that are design decisions rather than details:
 *
 * - **The strongest activity wins.** Somebody with two tabs, one idle and one
 *   mid-drag, is "dragging". Taking the most recent heartbeat instead would make
 *   the chip flicker between states at the heartbeat interval for as long as both
 *   tabs are open.
 * - **Order is by name, not by arrival.** A roster that reorders itself every
 *   time somebody's heartbeat lands is a row of avatars that shuffle while you
 *   are looking at them, which makes the one you were about to click move.
 */
function collapse(entries: readonly StoredEntry[]): PresenceMember[] {
  const rank: Record<PresenceActivity, number> = { viewing: 0, editing: 1, dragging: 2 };
  const byUser = new Map<string, PresenceMember>();

  for (const entry of entries) {
    const existing = byUser.get(entry.userId);
    if (!existing) {
      byUser.set(entry.userId, {
        userId: entry.userId,
        name: entry.name,
        // Computed here rather than in the component, so the presence bar, the
        // member list and the activity feed cannot disagree about the same
        // person's initials or colour. Presence is never colour alone.
        initials: initialsOf(entry.name),
        colorSlot: presenceColorSlot(entry.userId),
        activity: entry.activity,
        connections: 1,
        lastSeenAt: new Date(entry.at).toISOString(),
      });
      continue;
    }
    byUser.set(entry.userId, {
      ...existing,
      connections: existing.connections + 1,
      activity: rank[entry.activity] > rank[existing.activity] ? entry.activity : existing.activity,
      lastSeenAt:
        entry.at > Date.parse(existing.lastSeenAt)
          ? new Date(entry.at).toISOString()
          : existing.lastSeenAt,
    });
  }

  return [...byUser.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The words beside the avatars.
 *
 * Re-exported, not defined here. They moved to `@kan/shared` because the browser
 * renders them and this package imports `ioredis`: a web bundle that reached for
 * `presenceLabel` would pull a Redis client into it. Same reasoning as
 * `wipStateFor`. The wording has to be one implementation or the chip's tooltip,
 * its accessible name and the live region drift apart.
 */
export { presenceLabel, presenceSummary } from '@kan/shared';
