import { describe, expect, it, vi } from 'vitest';

import { BoardBroadcast, toListHeader, type RoomEmitter } from './broadcast';
import type { Card } from './contracts/board';
import {
  SERVER_EVENTS,
  activityAppendedSchema,
  boardRenamedSchema,
  cardArchivedSchema,
  cardCreatedSchema,
  cardMovedSchema,
  cardUpdatedSchema,
  listArchivedSchema,
  listCreatedSchema,
  listMovedSchema,
  listUpdatedSchema,
  memberChangedSchema,
  presenceChangedSchema,
} from './contracts/events';
import { boardRoom } from './rooms';

interface Sent {
  room: string;
  event: string;
  payload: unknown;
}

/** A recorder shaped like both socket.io's Server and the redis Emitter. */
function recorder(): { emitter: RoomEmitter; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    emitter: {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          sent.push({ room, event, payload });
          return true;
        },
      }),
    },
  };
}

const BOARD = 'clx0board00000000000';

const card = (overrides: Partial<Card> = {}): Card => ({
  id: 'clx0card000000000000',
  listId: 'clx0list000000000000',
  title: 'Fix login',
  description: null,
  position: 'a0',
  version: 4,
  dueOn: null,
  assigneeId: null,
  labels: [],
  createdAt: '2026-08-09T10:00:00.000Z',
  updatedAt: '2026-08-09T10:05:00.000Z',
  ...overrides,
});

const listRow = {
  id: 'clx0list000000000000',
  boardId: BOARD,
  name: 'Doing',
  position: 'a0',
  wipLimit: 3,
};

describe('toListHeader', () => {
  it('computes the WIP words from the count and the limit', () => {
    expect(toListHeader(listRow, 3).wip).toEqual({ state: 'at', label: 'At limit 3/3' });
    expect(toListHeader(listRow, 1).wip).toEqual({ state: 'under', label: '1/3' });
    expect(toListHeader({ ...listRow, wipLimit: null }, 7).wip).toEqual({
      state: 'none',
      label: '7 cards',
    });
  });

  it('carries no cards', () => {
    // The header exists precisely so a rename cannot ship a stale card array and
    // undo a drag that landed a millisecond earlier on every other screen.
    expect(toListHeader(listRow, 0)).not.toHaveProperty('cards');
  });
});

describe('BoardBroadcast', () => {
  it('sends into that board’s room', () => {
    const { emitter, sent } = recorder();
    new BoardBroadcast(emitter).cardCreated(BOARD, card());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.room).toBe(boardRoom(BOARD));
    expect(sent[0]?.event).toBe(SERVER_EVENTS.cardCreated);
  });

  it('builds card.moved from the card and the list it left', () => {
    // The asymmetry that matters: after the write the card knows where it IS, and
    // only the operation's result remembers where it WAS. A payload that took
    // both from the card would tell the receiving client to remove the card from
    // the column it just arrived in, which reads as the card vanishing.
    const { emitter, sent } = recorder();
    const moved = card({ listId: 'clx0list000000000002', position: 'a1' });

    new BoardBroadcast(emitter).cardMoved(BOARD, {
      card: moved,
      fromListId: 'clx0list000000000001',
    });

    expect(sent[0]?.payload).toEqual({
      cardId: moved.id,
      fromListId: 'clx0list000000000001',
      toListId: 'clx0list000000000002',
      position: 'a1',
      version: 4,
      movedAt: '2026-08-09T10:05:00.000Z',
    });
  });

  it('reports a failed emit instead of throwing at the caller', () => {
    // The write already committed. Throwing here would turn a successful move
    // into a 500 the user is told to retry, and the retry would move it twice.
    const onFailure = vi.fn();
    const broken: RoomEmitter = {
      to: () => ({
        emit: () => {
          throw new Error('Stream isn’t writeable and enableOfflineQueue options is false');
        },
      }),
    };

    const broadcast = new BoardBroadcast(broken, { onFailure });
    expect(() => broadcast.cardCreated(BOARD, card())).not.toThrow();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toBe(SERVER_EVENTS.cardCreated);
    expect(onFailure.mock.calls[0]?.[1]).toBe(BOARD);
  });

  it('swallows a failure silently when no handler was given', () => {
    const broken: RoomEmitter = {
      to: () => ({
        emit: () => {
          throw new Error('down');
        },
      }),
    };
    expect(() => new BoardBroadcast(broken).cardCreated(BOARD, card())).not.toThrow();
  });

  /**
   * Every method, against the schema of the event it claims to emit.
   *
   * This is the test that makes the class worth having. The gateway and the API
   * both call these methods and neither validates what comes out; a payload that
   * does not satisfy its own schema is delivered, parsed by the client, and
   * throws in a reconcile path several hundred milliseconds and one process away
   * from the line that built it.
   */
  it('emits a payload that satisfies its own schema, for every method', () => {
    const { emitter, sent } = recorder();
    const broadcast = new BoardBroadcast(emitter);
    const header = toListHeader(listRow, 0);

    broadcast.boardRenamed(BOARD, 'Renamed board');
    broadcast.listCreated(BOARD, header);
    broadcast.listUpdated(BOARD, header);
    broadcast.listMoved(BOARD, header);
    broadcast.listArchived(BOARD, header.id);
    broadcast.cardCreated(BOARD, card());
    broadcast.cardUpdated(BOARD, card());
    broadcast.cardMoved(BOARD, { card: card(), fromListId: 'clx0list000000000001' });
    broadcast.cardArchived(BOARD, card());
    broadcast.memberChanged(BOARD, [
      {
        userId: 'clx0user000000000000',
        name: 'Ana Ruiz',
        email: 'ana@kan.local',
        role: 'EDITOR',
        initials: 'AR',
      },
    ]);
    broadcast.activityAppended(BOARD, {
      id: 'clx0act0000000000000',
      boardId: BOARD,
      type: 'card.moved',
      actorId: 'clx0user000000000000',
      actorName: 'Ana Ruiz',
      subject: 'Fix login',
      detail: 'To Doing',
      createdAt: '2026-08-09T10:05:00.000Z',
    });
    broadcast.presenceChanged(BOARD, [
      {
        userId: 'clx0user000000000000',
        name: 'Ana Ruiz',
        initials: 'AR',
        colorSlot: 3,
        activity: 'dragging',
        connections: 2,
        lastSeenAt: '2026-08-09T10:05:00.000Z',
      },
    ]);

    const schemas = {
      [SERVER_EVENTS.boardRenamed]: boardRenamedSchema,
      [SERVER_EVENTS.listCreated]: listCreatedSchema,
      [SERVER_EVENTS.listUpdated]: listUpdatedSchema,
      [SERVER_EVENTS.listMoved]: listMovedSchema,
      [SERVER_EVENTS.listArchived]: listArchivedSchema,
      [SERVER_EVENTS.cardCreated]: cardCreatedSchema,
      [SERVER_EVENTS.cardUpdated]: cardUpdatedSchema,
      [SERVER_EVENTS.cardMoved]: cardMovedSchema,
      [SERVER_EVENTS.cardArchived]: cardArchivedSchema,
      [SERVER_EVENTS.memberChanged]: memberChangedSchema,
      [SERVER_EVENTS.activityAppended]: activityAppendedSchema,
      [SERVER_EVENTS.presenceChanged]: presenceChangedSchema,
    };

    expect(sent).toHaveLength(12);
    for (const entry of sent) {
      expect(entry.room).toBe(boardRoom(BOARD));
      const schema = schemas[entry.event];
      expect(schema, `${entry.event} has no schema in this test`).toBeDefined();
      const parsed = schema!.safeParse(entry.payload);
      expect(
        parsed.success,
        `${entry.event}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
    }

    // Exactly the broadcastable half of the protocol. `board.state` is a reply to
    // a join rather than a broadcast, and `server.error` goes to one socket, so
    // neither belongs here -- but every other name must have a method, or a write
    // exists that nobody is told about.
    const covered = new Set(sent.map((entry) => entry.event));
    const expected = Object.values(SERVER_EVENTS).filter(
      (name) => name !== SERVER_EVENTS.boardState && name !== SERVER_EVENTS.error,
    );
    expect([...covered].sort()).toEqual([...expected].sort());
  });
});
