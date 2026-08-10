import { SERVER_EVENTS, type PresenceChanged } from '@kan/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boot,
  cleanUp,
  connect,
  createBoard,
  createUser,
  emit,
  REALTIME_1,
  REALTIME_2,
  type Harness,
  type TestBoard,
  type TestSocket,
  type TestUser,
} from './harness';

/**
 * Presence, against a real Redis and two real gateways.
 *
 * Three properties, none of which the gate lane can reach. `services/presence`
 * has 23 unit tests against an injected clock, and they prove the arithmetic: the
 * roster collapses connections to people, the strongest activity wins, an entry
 * older than the TTL is filtered out. What they cannot prove is that the entry is
 * in **Redis** rather than in one process's memory, and that is the whole
 * question for a gateway that runs as several replicas.
 *
 * `scripts/integration.sh` compresses the timings to a 1s heartbeat and a 3s TTL,
 * so the expiry test costs three seconds instead of twenty-five. The property
 * under test -- "the roster forgets a client that stops heartbeating" -- is
 * TTL-value-independent, and `.env.example` keeps its production shape rather
 * than being lowered to suit a test.
 */
describe('presence across replicas', () => {
  let harness: Harness;
  let ana: TestUser;
  let bruno: TestUser;
  let board: TestBoard;
  let watcher: TestSocket;

  const ttlSeconds = Number(process.env.PRESENCE_TTL_SECONDS ?? 3);

  beforeAll(async () => {
    harness = await boot();
    ana = await createUser(harness.prisma, 'ana');
    bruno = await createUser(harness.prisma, 'bruno');
    board = await createBoard(harness, ana, ['Todo']);
    await harness.http
      .post(`/boards/${board.id}/members`)
      .set('Authorization', ana.auth)
      .send({ email: bruno.email, role: 'EDITOR' })
      .expect(201);

    watcher = await connect(REALTIME_1, ana, board.id);
  });

  afterAll(async () => {
    watcher?.close();
    await cleanUp(harness.prisma, [ana, bruno]);
    await harness.close();
  });

  it('tells a client on :4100 that somebody joined on :4101', async () => {
    // The roster lives in Redis, so a join on the other replica has to reach this
    // one. If presence were per-process, this event would never arrive and the
    // board would show one person to each of two people looking at it together.
    const changed = watcher.until<PresenceChanged>(SERVER_EVENTS.presenceChanged, (roster) =>
      roster.members.some((member) => member.userId === bruno.id),
    );
    const other = await connect(REALTIME_2, bruno, board.id);

    try {
      const roster = await changed;
      expect(roster.boardId).toBe(board.id);
      expect(roster.members.map((member) => member.userId).sort()).toEqual(
        [ana.id, bruno.id].sort(),
      );
    } finally {
      other.close();
    }
  });

  it('counts two tabs as one person', async () => {
    // Keyed by socket, collapsed by user. Keyed by user instead, closing one tab
    // would remove somebody who is still looking at the board in the other.
    const secondTab = await connect(REALTIME_1, bruno, board.id);
    try {
      const changed = watcher.until<PresenceChanged>(
        SERVER_EVENTS.presenceChanged,
        (roster) =>
          (roster.members.find((member) => member.userId === bruno.id)?.connections ?? 0) >= 2,
      );
      const thirdTab = await connect(REALTIME_2, bruno, board.id);
      try {
        const roster = await changed;
        const brunoEntry = roster.members.find((member) => member.userId === bruno.id);
        expect(brunoEntry, 'bruno is not on the roster').toBeDefined();
        expect(roster.members.filter((member) => member.userId === bruno.id)).toHaveLength(1);
        expect(brunoEntry!.connections).toBeGreaterThanOrEqual(2);
      } finally {
        thirdTab.close();
      }
    } finally {
      secondTab.close();
    }
  });

  it('reports the strongest activity when one tab is dragging', async () => {
    // Two tabs, one idle and one mid-drag, is one person who is dragging. Taking
    // the most recent heartbeat instead would make the chip flicker between states
    // at the heartbeat interval for as long as both tabs are open.
    const dragging = await connect(REALTIME_2, bruno, board.id);
    try {
      // `until`, not `next`. Joining the board already broadcast a roster in
      // which bruno is `viewing`, and it can land after `connect` resolved -- so
      // `next` would capture the join's snapshot and assert against the state
      // from before the ping.
      const changed = watcher.until<PresenceChanged>(SERVER_EVENTS.presenceChanged, (roster) =>
        roster.members.some(
          (member) => member.userId === bruno.id && member.activity === 'dragging',
        ),
      );
      await emit(dragging.socket, 'presence.ping', { boardId: board.id, activity: 'dragging' });
      const roster = await changed;

      const brunoEntry = roster.members.find((member) => member.userId === bruno.id);
      expect(brunoEntry?.activity).toBe('dragging');
    } finally {
      dragging.close();
    }
  });

  it('drops somebody from the roster when their socket goes away', async () => {
    const leaver = await connect(REALTIME_2, bruno, board.id);
    // Same reason as above: the join's own roster still has bruno in it.
    const changed = watcher.until<PresenceChanged>(
      SERVER_EVENTS.presenceChanged,
      (roster) => !roster.members.some((member) => member.userId === bruno.id),
    );

    // `disconnecting`, not `disconnect`: `socket.rooms` is already empty by the
    // latter, so a handler there would not know which boards to clean up and the
    // person would linger until their TTL expired.
    leaver.close();

    const roster = await changed;
    expect(roster.members.map((member) => member.userId)).not.toContain(bruno.id);
  });

  it('expires an entry whose client stopped heartbeating without disconnecting', async () => {
    // The case a disconnect handler cannot cover: a laptop lid closing, a network
    // dropping, a process killed. Nothing tells the gateway; the entry simply
    // stops being refreshed, and `roster()` filters it out on the next read.
    //
    // Written straight into Redis rather than by connecting a socket and holding
    // it silent, because a real socket would be swept by its own disconnect
    // handler the moment the test tore it down -- proving the wrong mechanism.
    const key = `presence:${board.id}`;
    const stale = JSON.stringify({
      userId: 'ghost-user',
      name: 'Ghost',
      activity: 'viewing',
      // One second past the TTL, as of now.
      at: Date.now() - (ttlSeconds + 1) * 1000,
    });
    await harness.redis.client.hset(key, 'ghost-socket', stale);

    // A live client's read is what sweeps it. Any presence event will do; a ping
    // is the cheapest.
    const changed = watcher.until<PresenceChanged>(
      SERVER_EVENTS.presenceChanged,
      (roster) => !roster.members.some((member) => member.userId === 'ghost-user'),
    );
    await emit(watcher.socket, 'presence.ping', { boardId: board.id, activity: 'viewing' });
    const roster = await changed;

    expect(roster.members.map((member) => member.userId)).not.toContain('ghost-user');
    // Swept from Redis too, not merely filtered on the way out. Without the
    // delete, a board nobody has left accumulates dead fields forever.
    expect(await harness.redis.client.hexists(key, 'ghost-socket')).toBe(0);
  });

  it('refuses a heartbeat for a board the socket never joined', async () => {
    // Otherwise any authenticated client could write itself into the roster of a
    // board it cannot read, and everybody on that board would see a stranger.
    const outsider = await createUser(harness.prisma, 'outsider');
    const otherBoard = await createBoard(harness, outsider, ['Todo']);
    const socket = await connect(REALTIME_1, outsider, otherBoard.id);

    try {
      const refused = await emit(socket.socket, 'presence.ping', {
        boardId: board.id,
        activity: 'viewing',
      });
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe('NOT_FOUND');
    } finally {
      socket.close();
      await cleanUp(harness.prisma, [outsider]);
    }
  });
});
