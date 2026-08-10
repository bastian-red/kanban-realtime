/**
 * The Socket.io gateway.
 *
 * Three things about this process are load-bearing, and none of them is the event
 * routing.
 *
 * **It calls `services/board-ops` directly.** A drag that arrives here executes
 * the same `moveCard`, against the same repository, taking the same row lock and
 * enforcing the same permission matrix, as a drag that arrives at the REST API.
 * The alternative -- the gateway forwarding to the API over HTTP -- would double
 * the latency of the one interaction this product is judged on and would give the
 * two transports two chances to disagree about a write.
 *
 * **It is horizontally scalable, and that is the whole point of the project.**
 * `@socket.io/redis-adapter` over two dedicated connections is what makes N
 * replicas one logical server: a broadcast on this process reaches sockets held
 * by every other one. `infra/docker-compose.yml` runs a second replica on 4101
 * and `scripts/integration.sh` proves delivery across the two -- with a single
 * process that assertion is vacuous, because both clients would sit on the same
 * in-memory adapter and pass whether or not Redis were involved at all.
 *
 * **The handshake verifies the same token the REST client carries.** One
 * `AUTH_SECRET`, three processes: the web app mints, the API and this both check.
 * There is no socket session and no handshake cookie, which is what lets a client
 * reconnect to a different replica mid-drag without anything being transferred.
 *
 * Rooms are per board (`@kan/shared`'s `boardRoom`), never per user. A person
 * with two tabs is two sockets in one room, and presence collapses them back to
 * one person on the way out.
 */
import { createAdapter } from '@socket.io/redis-adapter';
import {
  archiveCard,
  archiveList,
  createCard,
  createList,
  moveCard,
  moveList,
  notFound,
  updateCard,
  updateList,
} from '@kan/board-ops';
import { hydrateCard, PrismaBoardRepository, readBoard, toActivity } from '@kan/board-store';
import { PresenceStore } from '@kan/presence';
import type { PresenceActivity } from '@kan/shared';
import {
  BoardBroadcast,
  boardIdFromRoom,
  boardRoom,
  CLIENT_EVENTS,
  SERVER_EVENTS,
  boardJoinSchema,
  boardLeaveSchema,
  cardArchivePayloadSchema,
  cardCreatePayloadSchema,
  cardMovePayloadSchema,
  cardUpdatePayloadSchema,
  handshakeAuthSchema,
  listArchivePayloadSchema,
  listCreatePayloadSchema,
  listMovePayloadSchema,
  listRenamePayloadSchema,
  presencePingPayloadSchema,
  toListHeader,
  wireDayToUtc,
} from '@kan/shared';
import { verifyServiceToken, type TokenUser } from '@kan/shared/server';
import type { PrismaClient } from '@kan/db';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';

import type { RealtimeConfig } from './config';
import { handler, type DispatchDeps } from './dispatch';
import { SocketRateLimiter } from './rate-limit';

/** What the handshake proved, parked on the socket for its lifetime. */
declare module 'socket.io' {
  interface SocketData {
    user: TokenUser;
    limiter: SocketRateLimiter;
  }
}

export interface GatewayDeps {
  io: Server;
  prisma: PrismaClient;
  pub: Redis;
  sub: Redis;
  config: RealtimeConfig;
  log: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}

export function attachGateway(deps: GatewayDeps): void {
  const { io, prisma, pub, sub, config } = deps;

  // Two connections, and they must be two. A Redis client in subscriber mode
  // refuses every other command, so an adapter sharing one connection could
  // subscribe or publish but not both.
  io.adapter(createAdapter(pub, sub));

  const presence = new PresenceStore(pub, config.presence);
  const broadcast = new BoardBroadcast(io, {
    onFailure: (event, boardId, error) =>
      deps.logError(`broadcast ${event} for board ${boardId} failed`, error),
  });

  /**
   * The handshake.
   *
   * Middleware rather than a check inside `connection`, because a socket that has
   * not proved who it is must never reach a handler -- not even to be refused
   * there. `next(err)` closes the connection before any event listener exists.
   *
   * The failure message is deliberately one sentence for every cause. Telling a
   * client "expired" rather than "bad signature" says which half of the token to
   * keep working on.
   */
  io.use((socket, next) => {
    const auth = handshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) {
      next(new Error('This connection needs a service token.'));
      return;
    }

    const result = verifyServiceToken(auth.data.token, config.authSecret);
    if (!result.ok) {
      deps.log(`handshake refused: ${result.reason}`);
      next(new Error('Invalid or expired service token.'));
      return;
    }

    socket.data.user = result.user;
    socket.data.limiter = new SocketRateLimiter({ limit: config.socket.eventRateLimit });
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const dispatch: DispatchDeps = {
      limiter: socket.data.limiter,
      socket,
      onInternal: (event, error) => deps.logError(`${event} failed for ${user.id}`, error),
    };

    /**
     * A repository bound to this socket's user, for one event.
     *
     * The `onActivity` hook fires only after the transaction commits, which is
     * what lets the activity feed update live without `board-ops` knowing that
     * broadcasts exist. `actor.name` comes from the token rather than a join --
     * this runs on every drag.
     */
    const storeFor = (boardId: string): PrismaBoardRepository =>
      new PrismaBoardRepository(prisma, {
        onActivity: (rows) => {
          for (const row of rows) broadcast.activityAppended(boardId, toActivity(row, user.name));
        },
      });

    const retry = { maxAttempts: config.moveRetryAttempts };

    /** Refresh this connection's roster entry and tell the board who is here. */
    const touchPresence = async (boardId: string, activity: PresenceActivity): Promise<void> => {
      await presence.touch(boardId, socket.id, { userId: user.id, name: user.name }, activity);
      broadcast.presenceChanged(boardId, await presence.roster(boardId));
    };

    socket.on(
      CLIENT_EVENTS.boardJoin,
      handler(CLIENT_EVENTS.boardJoin, boardJoinSchema, dispatch, async ({ boardId }) => {
        // `readBoard` is the same query `GET /boards/:id` runs, and it collapses
        // "no such board" and "not a member" into one null so a join cannot be
        // used as a membership oracle.
        const board = await readBoard(prisma, boardId, user.id);
        if (!board) throw notFound('That board does not exist.');

        await socket.join(boardRoom(boardId));
        // The reply is an event, not the ack. `board.state` is also what a forced
        // resync sends, so a client has one code path for "here is the board"
        // rather than one for joining and another for recovering.
        socket.emit(SERVER_EVENTS.boardState, board);
        await touchPresence(boardId, 'viewing');
        return {};
      }),
    );

    socket.on(
      CLIENT_EVENTS.boardLeave,
      handler(CLIENT_EVENTS.boardLeave, boardLeaveSchema, dispatch, async ({ boardId }) => {
        await socket.leave(boardRoom(boardId));
        await presence.leave(boardId, socket.id);
        broadcast.presenceChanged(boardId, await presence.roster(boardId));
        return {};
      }),
    );

    socket.on(
      CLIENT_EVENTS.presencePing,
      handler(
        CLIENT_EVENTS.presencePing,
        presencePingPayloadSchema,
        dispatch,
        async ({ boardId, activity }) => {
          // Refuse a heartbeat for a board this socket is not in. Otherwise any
          // authenticated client could write itself into the roster of a board it
          // never joined and cannot read.
          if (!socket.rooms.has(boardRoom(boardId))) {
            throw notFound('You are not on that board.');
          }
          await touchPresence(boardId, activity);
          return {};
        },
      ),
    );

    socket.on(
      CLIENT_EVENTS.cardCreate,
      handler(CLIENT_EVENTS.cardCreate, cardCreatePayloadSchema, dispatch, async (payload) => {
        const row = await createCard(
          storeFor(payload.boardId),
          { ...payload, actorId: user.id },
          retry,
        );
        const card = await hydrateCard(prisma, row);
        broadcast.cardCreated(payload.boardId, card);
        return { card };
      }),
    );

    socket.on(
      CLIENT_EVENTS.cardUpdate,
      handler(CLIENT_EVENTS.cardUpdate, cardUpdatePayloadSchema, dispatch, async (payload) => {
        const row = await updateCard(storeFor(payload.boardId), {
          ...payload,
          actorId: user.id,
          // `YYYY-MM-DD` on the wire, UTC midnight in the `date` column. Shared
          // with the REST controller, which parses the same schema and owes the
          // same three-way conversion.
          dueOn: wireDayToUtc(payload.dueOn),
        });
        const card = await hydrateCard(prisma, row);
        broadcast.cardUpdated(payload.boardId, card);
        return { card };
      }),
    );

    socket.on(
      CLIENT_EVENTS.cardMove,
      handler(CLIENT_EVENTS.cardMove, cardMovePayloadSchema, dispatch, async (payload) => {
        const result = await moveCard(
          storeFor(payload.boardId),
          { ...payload, actorId: user.id },
          retry,
        );
        const card = await hydrateCard(prisma, result.card);
        broadcast.cardMoved(payload.boardId, { card, fromListId: result.fromListId });
        // The ack carries `reconciled`, which the broadcast has no room for: it
        // tells *this* client that its two neighbours were no longer adjacent and
        // its optimistic placement must defer to the server's.
        return { card, fromListId: result.fromListId, reconciled: result.reconciled };
      }),
    );

    socket.on(
      CLIENT_EVENTS.cardArchive,
      handler(CLIENT_EVENTS.cardArchive, cardArchivePayloadSchema, dispatch, async (payload) => {
        const row = await archiveCard(storeFor(payload.boardId), { ...payload, actorId: user.id });
        broadcast.cardArchived(payload.boardId, row);
        return { cardId: row.id, listId: row.listId };
      }),
    );

    socket.on(
      CLIENT_EVENTS.listCreate,
      handler(CLIENT_EVENTS.listCreate, listCreatePayloadSchema, dispatch, async (payload) => {
        const row = await createList(
          storeFor(payload.boardId),
          { ...payload, actorId: user.id },
          retry,
        );
        // A list that was just created has no cards. Counting would be a round
        // trip to learn a number the operation guarantees.
        const list = toListHeader(row, 0);
        broadcast.listCreated(payload.boardId, list);
        return { list };
      }),
    );

    socket.on(
      CLIENT_EVENTS.listRename,
      handler(CLIENT_EVENTS.listRename, listRenamePayloadSchema, dispatch, async (payload) => {
        const row = await updateList(storeFor(payload.boardId), { ...payload, actorId: user.id });
        const list = toListHeader(
          row,
          await prisma.card.count({ where: { listId: row.id, archivedAt: null } }),
        );
        broadcast.listUpdated(payload.boardId, list);
        return { list };
      }),
    );

    socket.on(
      CLIENT_EVENTS.listMove,
      handler(CLIENT_EVENTS.listMove, listMovePayloadSchema, dispatch, async (payload) => {
        const row = await moveList(
          storeFor(payload.boardId),
          { ...payload, actorId: user.id },
          retry,
        );
        broadcast.listMoved(payload.boardId, row);
        return { listId: row.id, position: row.position };
      }),
    );

    socket.on(
      CLIENT_EVENTS.listArchive,
      handler(CLIENT_EVENTS.listArchive, listArchivePayloadSchema, dispatch, async (payload) => {
        const row = await archiveList(storeFor(payload.boardId), { ...payload, actorId: user.id });
        broadcast.listArchived(payload.boardId, row.id);
        return { listId: row.id };
      }),
    );

    /**
     * Leaving, for every board this socket was in.
     *
     * `socket.rooms` still holds them at `disconnecting` time; by `disconnect` it
     * has been emptied, and a roster entry left behind shows a ghost on the board
     * until its TTL expires. Socket.io also puts every socket in a room named
     * after its own id, which is why the ids are filtered through
     * `boardIdFromRoom` rather than having a prefix stripped blindly.
     */
    socket.on('disconnecting', () => {
      const boards = [...socket.rooms]
        .map(boardIdFromRoom)
        .filter((boardId): boardId is string => boardId !== null);

      void (async () => {
        for (const boardId of boards) {
          try {
            await presence.leave(boardId, socket.id);
            broadcast.presenceChanged(boardId, await presence.roster(boardId));
          } catch (error) {
            // A disconnect must not be able to throw: there is nobody left to
            // tell, and an unhandled rejection here takes the process down over a
            // roster entry that expires on its own within PRESENCE_TTL_SECONDS.
            deps.logError(`presence cleanup for board ${boardId} failed`, error);
          }
        }
      })();
    });
  });
}

/** Sockets and rooms held by *this* replica, for `/health`. */
export function localCounts(io: Server): { connectedSockets: number; rooms: number } {
  let rooms = 0;
  for (const room of io.sockets.adapter.rooms.keys()) {
    if (boardIdFromRoom(room) !== null) rooms += 1;
  }
  return { connectedSockets: io.sockets.sockets.size, rooms };
}

/** Exported for the integration lane, which asserts against a real socket. */
export type GatewaySocket = Socket;
