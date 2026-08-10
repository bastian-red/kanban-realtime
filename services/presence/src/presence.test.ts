import { beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';

import {
  assertPresenceConfig,
  PresenceConfigError,
  presenceLabel,
  PresenceStore,
  presenceSummary,
} from './index';

/**
 * A hash-only fake Redis.
 *
 * Same reasoning as `MemoryRepository` in board-ops: this exists so the *logic*
 * -- collapsing connections to people, picking the strongest activity, the TTL
 * arithmetic -- can be tested exhaustively and instantly. It does not stand in for
 * Redis. That a key actually expires, and that two gateway replicas see one
 * roster, is the integration lane's job against a real server.
 *
 * It is deliberately not a general Redis mock: five methods, no pattern matching,
 * no eviction. A fake with more surface than the code uses is a second
 * implementation to keep correct.
 */
class FakeRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly expiries = new Map<string, number>();

  private hash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  multi(): {
    hset: (key: string, field: string, value: string) => ReturnType<FakeRedis['multi']>;
    expire: (key: string, seconds: number) => ReturnType<FakeRedis['multi']>;
    exec: () => Promise<void>;
  } {
    const chain = {
      hset: (key: string, field: string, value: string) => {
        this.hash(key).set(field, value);
        return chain;
      },
      expire: (key: string, seconds: number) => {
        this.expiries.set(key, seconds);
        return chain;
      },
      exec: async () => undefined,
    };
    return chain;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.hash(key);
    let removed = 0;
    for (const field of fields) if (hash.delete(field)) removed += 1;
    return removed;
  }

  async del(key: string): Promise<number> {
    return this.hashes.delete(key) ? 1 : 0;
  }
}

const CONFIG = { heartbeatSeconds: 10, ttlSeconds: 25 };
const ANA = { userId: 'user_ana', name: 'Ana Ruiz' };
const BRUNO = { userId: 'user_bruno', name: 'Bruno Salas' };

let redis: FakeRedis;
let clock: number;
let store: PresenceStore;

beforeEach(() => {
  redis = new FakeRedis();
  clock = Date.parse('2026-03-09T12:00:00.000Z');
  store = new PresenceStore(redis as unknown as Redis, CONFIG, () => clock);
});

describe('the roster', () => {
  it('lists everybody who has heartbeated', async () => {
    await store.touch('b1', 'socket_1', ANA);
    await store.touch('b1', 'socket_2', BRUNO);

    const roster = await store.roster('b1');
    expect(roster.map((member) => member.name)).toEqual(['Ana Ruiz', 'Bruno Salas']);
  });

  it('carries initials and a colour slot, never a colour alone', async () => {
    // The design rule this project is held to. Computed in the store rather than
    // in a component so the presence bar, the member list and the activity feed
    // cannot disagree about the same person.
    await store.touch('b1', 'socket_1', ANA);
    const [member] = await store.roster('b1');
    expect(member?.initials).toBe('AR');
    expect(member?.colorSlot).toBeGreaterThanOrEqual(0);
    expect(member?.colorSlot).toBeLessThan(8);
  });

  it('counts two tabs as one person with two connections', async () => {
    // Keyed by socket, not by user. Keyed by user, closing one tab would remove
    // somebody from the roster while they are still looking at the board in the
    // other one.
    await store.touch('b1', 'socket_1', ANA);
    await store.touch('b1', 'socket_2', ANA);

    const roster = await store.roster('b1');
    expect(roster).toHaveLength(1);
    expect(roster[0]?.connections).toBe(2);
  });

  it("reports the strongest activity across a person's connections", async () => {
    // One idle tab and one mid-drag. Taking the most recent heartbeat instead
    // would make the chip flicker between states every heartbeat for as long as
    // both tabs are open.
    await store.touch('b1', 'socket_1', ANA, 'viewing');
    await store.touch('b1', 'socket_2', ANA, 'dragging');
    expect((await store.roster('b1'))[0]?.activity).toBe('dragging');

    clock += 1000;
    await store.touch('b1', 'socket_1', ANA, 'viewing');
    expect((await store.roster('b1'))[0]?.activity).toBe('dragging');
  });

  it('is ordered by name, not by arrival', async () => {
    // A roster that reorders itself whenever a heartbeat lands is a row of
    // avatars that shuffle while you are looking at them, which moves the one you
    // were about to click.
    await store.touch('b1', 's1', BRUNO);
    await store.touch('b1', 's2', ANA);
    expect((await store.roster('b1')).map((member) => member.name)).toEqual([
      'Ana Ruiz',
      'Bruno Salas',
    ]);
  });

  it('keeps boards separate', async () => {
    await store.touch('b1', 's1', ANA);
    await store.touch('b2', 's2', BRUNO);
    expect((await store.roster('b1')).map((member) => member.userId)).toEqual(['user_ana']);
    expect((await store.roster('b2')).map((member) => member.userId)).toEqual(['user_bruno']);
  });
});

describe('expiry', () => {
  it('forgets a client that stops heartbeating', async () => {
    await store.touch('b1', 'socket_1', ANA);
    expect(await store.roster('b1')).toHaveLength(1);

    clock += (CONFIG.ttlSeconds - 1) * 1000;
    expect(await store.roster('b1')).toHaveLength(1);

    clock += 2000;
    expect(await store.roster('b1')).toHaveLength(0);
  });

  it('keeps a client that keeps heartbeating', async () => {
    await store.touch('b1', 'socket_1', ANA);
    for (let beat = 0; beat < 10; beat += 1) {
      clock += CONFIG.heartbeatSeconds * 1000;
      await store.touch('b1', 'socket_1', ANA);
      expect(await store.roster('b1')).toHaveLength(1);
    }
  });

  it('survives one dropped heartbeat, which is why the TTL is over 2x', async () => {
    // The concrete reason for `assertPresenceConfig`. At a TTL of exactly 2x the
    // heartbeat, this test would evict Ana at the moment the second beat is due,
    // and a presence bar that drops people on one lost packet is worse than one
    // that is a few seconds stale.
    await store.touch('b1', 'socket_1', ANA);
    clock += CONFIG.heartbeatSeconds * 2 * 1000;
    expect(await store.roster('b1')).toHaveLength(1);
  });

  it('sweeps the expired field rather than only hiding it', async () => {
    await store.touch('b1', 'socket_1', ANA);
    clock += (CONFIG.ttlSeconds + 1) * 1000;
    await store.roster('b1');
    // Read-path sweep: a board nobody reads does not need an accurate roster,
    // and a background timer would need leader election across replicas to avoid
    // N copies of the same sweep.
    expect(await redis.hgetall('presence:b1')).toEqual({});
  });

  it('drops a field it cannot parse', async () => {
    // A truncated write, or a field written by an older version of this code.
    // Unparseable is indistinguishable from expired here, and keeping it would
    // leave a ghost on the board forever.
    redis.hashes.set('presence:b1', new Map([['socket_bad', 'not json']]));
    expect(await store.roster('b1')).toHaveLength(0);
    expect(await redis.hgetall('presence:b1')).toEqual({});
  });

  it('refreshes the key TTL on every write, so an active board never expires', async () => {
    await store.touch('b1', 'socket_1', ANA);
    expect(redis.expiries.get('presence:b1')).toBe(CONFIG.ttlSeconds * 4);
  });
});

describe('leaving', () => {
  it('removes one connection and keeps the other', async () => {
    await store.touch('b1', 'socket_1', ANA);
    await store.touch('b1', 'socket_2', ANA);
    await store.leave('b1', 'socket_1');

    const roster = await store.roster('b1');
    expect(roster).toHaveLength(1);
    expect(roster[0]?.connections).toBe(1);
  });

  it('is safe to call for a socket that was never there', async () => {
    // Disconnect handlers run on paths that did not necessarily run the join, and
    // a throw here would take the socket's teardown with it.
    await expect(store.leave('b1', 'never')).resolves.toBeUndefined();
  });
});

describe('assertPresenceConfig', () => {
  it('accepts a TTL comfortably over twice the heartbeat', () => {
    expect(() => assertPresenceConfig({ heartbeatSeconds: 10, ttlSeconds: 25 })).not.toThrow();
  });

  it('refuses a TTL at or below 2x, naming both values', () => {
    expect(() => assertPresenceConfig({ heartbeatSeconds: 10, ttlSeconds: 20 })).toThrow(
      PresenceConfigError,
    );
    expect(() => assertPresenceConfig({ heartbeatSeconds: 10, ttlSeconds: 15 })).toThrow(
      /must be more than twice/,
    );
  });

  it('refuses non-positive values', () => {
    expect(() => assertPresenceConfig({ heartbeatSeconds: 0, ttlSeconds: 25 })).toThrow(
      PresenceConfigError,
    );
    expect(() => assertPresenceConfig({ heartbeatSeconds: 10, ttlSeconds: -1 })).toThrow(
      PresenceConfigError,
    );
  });

  it('is enforced by the constructor, not merely available', () => {
    expect(
      () => new PresenceStore(redis as unknown as Redis, { heartbeatSeconds: 10, ttlSeconds: 20 }),
    ).toThrow(PresenceConfigError);
  });
});

describe('the words beside the avatars', () => {
  const member = {
    userId: 'user_ana',
    name: 'Ana Ruiz',
    initials: 'AR',
    colorSlot: 3,
    connections: 1,
    lastSeenAt: '2026-03-09T12:00:00.000Z',
  };

  it('names the person and what they are doing', () => {
    expect(presenceLabel({ ...member, activity: 'viewing' })).toBe('Ana Ruiz, viewing');
    expect(presenceLabel({ ...member, activity: 'editing' })).toBe('Ana Ruiz, editing');
    expect(presenceLabel({ ...member, activity: 'dragging' })).toBe('Ana Ruiz, moving a card');
  });

  it('mentions extra tabs, because two dots for one person is confusing', () => {
    expect(presenceLabel({ ...member, activity: 'viewing', connections: 2 })).toBe(
      'Ana Ruiz, viewing, 2 tabs',
    );
  });

  it('summarises the board in a sentence', () => {
    expect(presenceSummary([])).toBe('Nobody else is on this board');
    expect(presenceSummary([{ ...member, activity: 'viewing' }])).toBe(
      '1 other person on this board',
    );
    expect(
      presenceSummary([
        { ...member, activity: 'viewing' },
        { ...member, userId: 'b', name: 'Bruno Salas', activity: 'viewing' },
      ]),
    ).toBe('2 other people on this board');
  });

  it('says who is dragging, which is the state colour alone would carry', () => {
    expect(
      presenceSummary([
        { ...member, activity: 'dragging' },
        { ...member, userId: 'b', name: 'Bruno Salas', activity: 'viewing' },
      ]),
    ).toBe('2 other people on this board, Ana Ruiz moving a card');
  });

  it('never produces an empty string', () => {
    for (const activity of ['viewing', 'editing', 'dragging'] as const) {
      expect(presenceLabel({ ...member, activity }).length).toBeGreaterThan(0);
    }
    expect(presenceSummary([]).length).toBeGreaterThan(0);
  });
});
