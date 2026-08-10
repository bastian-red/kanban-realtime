import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  boardSchema,
  cardSchema,
  listSchema,
  moveCardSchema,
  updateCardSchema,
  wipSchema,
} from './board';
import {
  ackSchema,
  cardMovePayloadSchema,
  cardMovedSchema,
  CLIENT_EVENTS,
  emptyAckSchema,
  errorCodeSchema,
  handshakeAuthSchema,
  presenceChangedSchema,
  presencePingPayloadSchema,
  SERVER_EVENTS,
} from './events';
import { healthSchema, realtimeHealthSchema } from './health';
import { positionSchema, versionSchema, wipLimitSchema } from './primitives';

const CARD = {
  id: 'clx_card_1',
  listId: 'clx_list_1',
  title: 'Fix login',
  description: null,
  position: 'a1',
  version: 3,
  dueOn: null,
  assigneeId: null,
  labels: [],
  createdAt: '2026-03-09T12:00:00.000Z',
  updatedAt: '2026-03-09T12:00:00.000Z',
};

describe('a position is a string, and the schema says so', () => {
  it('accepts a base62 fractional index', () => {
    for (const value of ['a0', 'a1', 'Zz', 'a0V', 'aaaaaaaa1']) {
      expect(positionSchema.parse(value)).toBe(value);
    }
  });

  it('rejects a number, which is the mistake this whole design avoids', () => {
    // An integer position forces a renumber of every following row on each
    // insert, and two clients renumbering at once is precisely the conflict this
    // project exists to prevent. The contract refuses the shape outright so the
    // idea cannot creep back in one endpoint at a time.
    expect(positionSchema.safeParse(3).success).toBe(false);
    expect(positionSchema.safeParse(3.5).success).toBe(false);
  });

  it('rejects an empty or malformed key rather than letting it sort first', () => {
    // An empty position does not error at read time: it sorts before everything
    // and silently degrades the board to insertion order, which is the failure
    // nobody notices until a card is in the wrong place. Mirrored by
    // CHECK (position ~ '^[a-zA-Z0-9]+$') in the board_invariants migration.
    for (const value of ['', ' ', 'a 1', 'a-1', 'a.1', 'a/1', '-1']) {
      expect(positionSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('the optimistic lock is not optional', () => {
  it('refuses an update with no expectedVersion', () => {
    // An optional lock is not a lock: the first caller that forgets it gets
    // last-write-wins, and it is always the caller written in a hurry.
    const result = updateCardSchema.safeParse({ title: 'New title' });
    expect(result.success).toBe(false);
  });

  it('refuses a move with no expectedVersion', () => {
    const result = moveCardSchema.safeParse({
      toListId: 'clx_list_2',
      afterCardId: null,
      beforeCardId: null,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a negative or fractional version', () => {
    expect(versionSchema.safeParse(-1).success).toBe(false);
    expect(versionSchema.safeParse(1.5).success).toBe(false);
    expect(versionSchema.parse(0)).toBe(0);
  });
});

describe('a move is an intent, never a position', () => {
  it('has no position field to send', () => {
    // The client says which neighbours; the server generates the key, with
    // jitter, so two clients dropping into the same gap get different keys. A
    // client-supplied position would make them identical by construction.
    const withPosition = moveCardSchema.safeParse({
      expectedVersion: 1,
      toListId: 'clx_list_2',
      afterCardId: null,
      beforeCardId: null,
      position: 'a5',
    });
    expect(withPosition.success).toBe(true);
    if (withPosition.success) {
      expect(withPosition.data).not.toHaveProperty('position');
    }
  });

  it('requires both neighbours, so a stale client view is detectable', () => {
    // Sending only `afterCardId` would leave the server unable to tell "top of
    // the list" from "the client thinks these two are adjacent and they are not".
    expect(
      moveCardSchema.safeParse({ expectedVersion: 1, toListId: 'l2', afterCardId: null }).success,
    ).toBe(false);
    expect(
      moveCardSchema.safeParse({
        expectedVersion: 1,
        toListId: 'l2',
        afterCardId: null,
        beforeCardId: null,
      }).success,
    ).toBe(true);
  });

  it('carries the origin list in the broadcast', () => {
    // The receiving client has to remove the card from where *it* thinks it is,
    // which may not be where the mover thought it was.
    const moved = cardMovedSchema.parse({
      cardId: 'clx_card_1',
      fromListId: 'clx_list_1',
      toListId: 'clx_list_2',
      position: 'a2',
      version: 4,
      movedAt: '2026-03-09T12:00:01.000Z',
    });
    expect(moved.fromListId).toBe('clx_list_1');
    expect(moved.position).toBe('a2');
  });
});

describe('the ack envelope', () => {
  const ack = ackSchema(cardSchema);

  it('parses a success', () => {
    const parsed = ack.parse({ ok: true, data: CARD });
    expect(parsed.ok).toBe(true);
  });

  it('parses a failure with a typed code', () => {
    const parsed = ack.parse({
      ok: false,
      error: { code: 'STALE', message: 'Card changed', event: CLIENT_EVENTS.cardMove },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('STALE');
  });

  it('refuses an envelope that carries both, or neither', () => {
    // The discriminated union is what makes the failure branch impossible to
    // forget. A loose object with two optional fields would let a client read
    // `data` without checking `ok` and get undefined at runtime.
    expect(ack.safeParse({ ok: true }).success).toBe(false);
    expect(ack.safeParse({ data: CARD }).success).toBe(false);
    expect(ack.safeParse({ ok: false }).success).toBe(false);
  });

  it('refuses an unknown error code', () => {
    // Codes drive behaviour: STALE refetches, FORBIDDEN explains, RATE_LIMITED
    // backs off. An unrecognised code must fail parsing rather than fall through
    // to a default that silently retries something the server refused.
    expect(errorCodeSchema.safeParse('WHOOPS').success).toBe(false);
    expect(emptyAckSchema.safeParse({ ok: true, data: {} }).success).toBe(true);
  });
});

describe('event names exist once', () => {
  it('has no name in both directions', () => {
    // `card.move` is what the client sends; `card.moved` is what the server
    // broadcasts. If one name appeared in both maps, a client echo would look
    // like a server broadcast and every mutation would apply twice.
    const client = new Set<string>(Object.values(CLIENT_EVENTS));
    const server = new Set<string>(Object.values(SERVER_EVENTS));
    const both = [...client].filter((name) => server.has(name));
    expect(both).toEqual([]);
  });

  it('has no duplicate values within either direction', () => {
    for (const map of [CLIENT_EVENTS, SERVER_EVENTS]) {
      const values = Object.values(map);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('names every event as `subject.verb`', () => {
    // The gateway rate-limits and routes by prefix, and eslint.config.mjs bans
    // hand-typed literals matching this shape inside e2e/ so specs import the
    // constants instead. Both depend on the convention holding.
    for (const name of [...Object.values(CLIENT_EVENTS), ...Object.values(SERVER_EVENTS)]) {
      expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });
});

describe('presence', () => {
  it('defaults an activity-less ping to viewing', () => {
    const parsed = presencePingPayloadSchema.parse({ boardId: 'clx_board_1' });
    expect(parsed.activity).toBe('viewing');
  });

  it('carries the whole roster, not a delta', () => {
    // A client that missed one join/leave delta while backgrounded would show a
    // ghost forever. Sending the state rather than the transition makes
    // reconnection free.
    const parsed = presenceChangedSchema.parse({
      boardId: 'clx_board_1',
      members: [
        {
          userId: 'clx_user_1',
          name: 'Ana Ruiz',
          initials: 'AR',
          colorSlot: 4,
          activity: 'dragging',
          connections: 2,
          lastSeenAt: '2026-03-09T12:00:00.000Z',
        },
      ],
    });
    expect(parsed.members[0]!.connections).toBe(2);
  });

  it('requires initials on every roster entry', () => {
    // The design rule: presence is never colour alone. A roster entry with a
    // colour slot and no initials would render a swatch nobody can identify, so
    // the contract refuses it rather than leaving it to a component.
    const result = presenceChangedSchema.safeParse({
      boardId: 'clx_board_1',
      members: [
        {
          userId: 'clx_user_1',
          name: 'Ana Ruiz',
          colorSlot: 4,
          activity: 'viewing',
          connections: 1,
          lastSeenAt: '2026-03-09T12:00:00.000Z',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a colour slot outside the palette', () => {
    expect(
      presenceChangedSchema.safeParse({
        boardId: 'b',
        members: [
          {
            userId: 'u',
            name: 'n',
            initials: 'N',
            colorSlot: 8,
            activity: 'viewing',
            connections: 1,
            lastSeenAt: '2026-03-09T12:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('the socket handshake', () => {
  it('requires a token', () => {
    expect(handshakeAuthSchema.safeParse({}).success).toBe(false);
    expect(handshakeAuthSchema.safeParse({ token: '' }).success).toBe(false);
    expect(handshakeAuthSchema.safeParse({ token: 'ey.J.x' }).success).toBe(true);
  });
});

describe('a WIP limit of zero is not a limit', () => {
  it('accepts null and positive integers only', () => {
    expect(wipLimitSchema.parse(null)).toBeNull();
    expect(wipLimitSchema.parse(5)).toBe(5);
    // Zero would mean a list nothing may enter, which is a closed list, and the
    // product has archiving for that. Mirrored by
    // CHECK (wip_limit IS NULL OR wip_limit > 0).
    expect(wipLimitSchema.safeParse(0).success).toBe(false);
    expect(wipLimitSchema.safeParse(-1).success).toBe(false);
    expect(wipLimitSchema.safeParse(2.5).success).toBe(false);
  });
});

describe('health', () => {
  const BASE = {
    status: 'ok' as const,
    version: '0.1.0',
    uptimeSeconds: 12.5,
    checks: [{ name: 'redis', status: 'ok' as const, latencyMs: 1.2, detail: null }],
  };

  it('is one envelope for both services', () => {
    expect(healthSchema.parse(BASE).status).toBe('ok');
    expect(realtimeHealthSchema.parse(BASE).connectedSockets).toBeUndefined();
  });

  it('lets the gateway add its socket counts without a second schema', () => {
    const parsed = realtimeHealthSchema.parse({ ...BASE, connectedSockets: 3, rooms: 2 });
    expect(parsed.connectedSockets).toBe(3);
    // And the shared envelope still parses it, which is what lets the /status
    // page render one component for both services.
    expect(healthSchema.safeParse({ ...BASE, connectedSockets: 3 }).success).toBe(true);
  });

  it('refuses a status outside ok/degraded', () => {
    expect(healthSchema.safeParse({ ...BASE, status: 'green' }).success).toBe(false);
  });
});

describe('the card payload', () => {
  it('round-trips through JSON unchanged', () => {
    // The wire is JSON, so anything the schema accepts must survive
    // stringify/parse. A Date here instead of an ISO string would pass a naive
    // schema and come back as a string on the other side.
    const parsed = cardSchema.parse(CARD);
    expect(cardSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('rejects a timestamp that is not an instant', () => {
    expect(cardSchema.safeParse({ ...CARD, createdAt: '2026-03-09' }).success).toBe(false);
  });

  it('validates a move payload the gateway receives', () => {
    const payload = cardMovePayloadSchema.parse({
      boardId: 'clx_board_1',
      cardId: 'clx_card_1',
      expectedVersion: 3,
      toListId: 'clx_list_2',
      afterCardId: 'clx_card_9',
      beforeCardId: null,
    });
    expect(payload.boardId).toBe('clx_board_1');
  });

  it('is the same schema whether it arrived by HTTP or by socket', () => {
    // cardMovePayloadSchema extends moveCardSchema rather than restating it, so
    // the REST route and the socket handler cannot drift into accepting
    // different things and landing in the same moveCard().
    const rest = moveCardSchema.parse({
      expectedVersion: 3,
      toListId: 'l2',
      afterCardId: null,
      beforeCardId: null,
    });
    const socket = cardMovePayloadSchema.parse({ ...rest, boardId: 'b1', cardId: 'c1' });
    expect(socket.toListId).toBe(rest.toListId);
    expect(socket.expectedVersion).toBe(rest.expectedVersion);
  });
});

describe('ackSchema is generic over its payload', () => {
  it('validates the wrapped data, not just the envelope', () => {
    const ack = ackSchema(z.object({ count: z.number().int() }));
    expect(ack.safeParse({ ok: true, data: { count: 2 } }).success).toBe(true);
    expect(ack.safeParse({ ok: true, data: { count: 'two' } }).success).toBe(false);
  });
});

describe('the whole board payload', () => {
  /**
   * The biggest response in the API, and until now the only one no test parsed.
   *
   * `getBoard` builds this object by hand from a nested Prisma select, so every
   * field is a place the mapping can silently disagree with the contract. A field
   * added to `boardSchema` and not to the service produces a response that fails
   * validation in the client rather than here, which is the wrong end.
   */
  const BOARD = {
    id: 'clx_board_1',
    name: 'Product launch',
    role: 'OWNER',
    lists: [
      {
        id: 'clx_list_1',
        boardId: 'clx_board_1',
        name: 'In progress',
        position: 'a1',
        wipLimit: 3,
        wip: { state: 'under', label: '1/3' },
        cards: [CARD],
      },
    ],
    members: [
      {
        userId: 'clx_user_1',
        name: 'Ana Ruiz',
        email: 'ana@kanban.local',
        role: 'OWNER',
        initials: 'AR',
      },
    ],
    labels: [{ id: 'clx_label_1', name: 'Bug', colorSlot: 0 }],
    updatedAt: '2026-03-09T12:00:00.000Z',
  };

  it('round-trips a full board', () => {
    expect(boardSchema.parse(BOARD)).toEqual(BOARD);
  });

  it('carries the board palette, not only the labels already in use', () => {
    // A label nobody has applied appears on no card, so a client deriving the set
    // from `lists[].cards[].labels` could never offer it in a picker. The card
    // below deliberately has none while the board has one.
    expect(BOARD.lists[0]?.cards[0]?.labels).toEqual([]);
    expect(boardSchema.parse(BOARD).labels).toHaveLength(1);
  });

  it('refuses a board with the labels field missing', () => {
    const { labels: _labels, ...withoutLabels } = BOARD;
    expect(boardSchema.safeParse(withoutLabels).success).toBe(false);
  });

  it('refuses a colour slot outside the palette', () => {
    // Mirrors CHECK (color_slot BETWEEN 0 AND 7) in the invariants migration. A
    // slot of 8 indexes past the stylesheet and renders an unstyled chip.
    const outside = { ...BOARD, labels: [{ id: 'clx_label_1', name: 'Bug', colorSlot: 8 }] };
    expect(boardSchema.safeParse(outside).success).toBe(false);
  });
});

describe('a WIP state always carries its words', () => {
  it('refuses a list with no wip block', () => {
    // The design rule, enforced by the contract rather than by review. `state`
    // alone would let a client render the limit as colour and nothing else.
    const list = {
      id: 'clx_list_1',
      boardId: 'clx_board_1',
      name: 'In progress',
      position: 'a1',
      wipLimit: 3,
      cards: [],
    };
    expect(listSchema.safeParse(list).success).toBe(false);
    expect(listSchema.safeParse({ ...list, wip: { state: 'under', label: '0/3' } }).success).toBe(
      true,
    );
  });

  it('refuses an empty label', () => {
    expect(wipSchema.safeParse({ state: 'at', label: '' }).success).toBe(false);
  });

  it('refuses a state outside the four', () => {
    expect(wipSchema.safeParse({ state: 'nearly', label: '4/5' }).success).toBe(false);
  });

  it('treats "no limit" as a state rather than a null', () => {
    // A list without a limit still has a WIP block, showing a plain count. Making
    // the whole field nullable would push a branch into every consumer.
    expect(wipSchema.parse({ state: 'none', label: '6 cards' }).state).toBe('none');
  });
});
