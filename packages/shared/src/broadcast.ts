/**
 * Turning a write into a broadcast, once, for both processes that do writes.
 *
 * The gateway holds a `socket.io` `Server`; the REST API holds a
 * `@socket.io/redis-emitter` `Emitter` and no server at all. Those are different
 * objects from different packages, but the call they need is the same shape --
 * `.to(room).emit(name, payload)` -- so this module takes that shape as an
 * interface and neither imports socket.io nor drags it into the browser bundle.
 *
 * Why it is shared rather than written twice: **a REST move and a socket move are
 * the same write**, and they must produce the same event, in the same room, with
 * the same payload. Two implementations of that mapping disagree eventually, and
 * the way this one fails is silent -- the other client simply never updates,
 * which is indistinguishable from a dropped connection.
 *
 * So the methods take *domain objects* and build the wire payload here. A caller
 * that had to assemble `{ cardId, fromListId, toListId, position, version,
 * movedAt }` itself is a caller that can put the destination list in `fromListId`,
 * and the receiving client would then remove the card from the column it just
 * arrived in.
 *
 * Every method is fire-and-forget by design. A broadcast that fails must not fail
 * the write that already committed: the row is in Postgres, and a client that
 * missed the event resyncs on its next reconnect. `onFailure` exists so the caller
 * can log that rather than swallow it.
 */
import type { Activity, Card, ListHeader, Member, Wip } from './contracts/board';
import { wipStateFor } from './contracts/board';
import { SERVER_EVENTS } from './contracts/events';
import type { PresenceMember } from './contracts/events';
import { boardRoom } from './rooms';

/**
 * The one method both emitters have.
 *
 * Structural rather than nominal on purpose: `socket.io`'s `Server` and
 * `@socket.io/redis-emitter`'s `Emitter` both satisfy it, and neither package is
 * a dependency of `@kan/shared`.
 */
export interface RoomEmitter {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/**
 * A list row as either process has it after a write.
 *
 * Structural, because the real type is `ListRow` in `services/board-ops`, and
 * `board-ops` imports this package -- taking the import the other way would be a
 * cycle. The fields named here are the ones the wire shape needs and nothing
 * more.
 */
export interface ListRowLike {
  id: string;
  boardId: string;
  name: string;
  position: string;
  wipLimit: number | null;
}

/**
 * A row plus its card count, as the header the protocol carries.
 *
 * The count is a parameter rather than read from the row because the two callers
 * know it from different places -- the gateway has just written the list and
 * knows it is empty, the API has the board's cards in hand -- and inventing a
 * query here would put a database round trip inside a broadcast.
 */
export function toListHeader(row: ListRowLike, cardCount: number): ListHeader {
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    position: row.position,
    wipLimit: row.wipLimit,
    wip: wipStateFor(cardCount, row.wipLimit) as Wip,
  };
}

export interface BoardBroadcastOptions {
  /**
   * Called when an emit throws.
   *
   * Not optional in practice: the API's Redis client runs with
   * `enableOfflineQueue: false`, so publishing while Redis is down rejects rather
   * than hanging, and an unhandled rejection there would take a process down over
   * a message nobody needed.
   */
  onFailure?: (event: string, boardId: string, error: unknown) => void;
}

export class BoardBroadcast {
  constructor(
    private readonly emitter: RoomEmitter,
    private readonly options: BoardBroadcastOptions = {},
  ) {}

  boardRenamed(boardId: string, name: string): void {
    this.send(SERVER_EVENTS.boardRenamed, boardId, { boardId, name });
  }

  listCreated(boardId: string, list: ListHeader): void {
    this.send(SERVER_EVENTS.listCreated, boardId, { list });
  }

  listUpdated(boardId: string, list: ListHeader): void {
    this.send(SERVER_EVENTS.listUpdated, boardId, { list });
  }

  /**
   * Only the id and the new position.
   *
   * A moved list keeps its name, its limit and its cards, and re-sending them
   * would let this process's snapshot overwrite a rename that landed in between.
   */
  listMoved(boardId: string, list: Pick<ListHeader, 'id' | 'position'>): void {
    this.send(SERVER_EVENTS.listMoved, boardId, { listId: list.id, position: list.position });
  }

  listArchived(boardId: string, listId: string): void {
    this.send(SERVER_EVENTS.listArchived, boardId, { listId });
  }

  cardCreated(boardId: string, card: Card): void {
    this.send(SERVER_EVENTS.cardCreated, boardId, { card });
  }

  cardUpdated(boardId: string, card: Card): void {
    this.send(SERVER_EVENTS.cardUpdated, boardId, { card });
  }

  /**
   * `fromListId` comes from the caller and `toListId` from the card.
   *
   * That asymmetry is the point. After the write the card knows where it *is*;
   * only the operation's result remembers where it *was*, and the receiving
   * client needs both -- it has to remove the card from wherever it currently
   * thinks it is, which may not be where the mover thought it was either.
   */
  cardMoved(boardId: string, result: { card: Card; fromListId: string }): void {
    this.send(SERVER_EVENTS.cardMoved, boardId, {
      cardId: result.card.id,
      fromListId: result.fromListId,
      toListId: result.card.listId,
      position: result.card.position,
      version: result.card.version,
      movedAt: result.card.updatedAt,
    });
  }

  cardArchived(boardId: string, card: Pick<Card, 'id' | 'listId'>): void {
    this.send(SERVER_EVENTS.cardArchived, boardId, { cardId: card.id, listId: card.listId });
  }

  memberChanged(boardId: string, members: readonly Member[]): void {
    this.send(SERVER_EVENTS.memberChanged, boardId, { boardId, members });
  }

  activityAppended(boardId: string, activity: Activity): void {
    this.send(SERVER_EVENTS.activityAppended, boardId, { activity });
  }

  presenceChanged(boardId: string, members: readonly PresenceMember[]): void {
    this.send(SERVER_EVENTS.presenceChanged, boardId, { boardId, members });
  }

  /**
   * The single place a room name is computed and a failure is contained.
   *
   * `try`/`catch` around a synchronous `emit` is not superstition: the redis
   * emitter publishes into an ioredis client that throws when the connection is
   * down and the offline queue is disabled, which is exactly how this repo
   * configures it.
   */
  private send(event: string, boardId: string, payload: unknown): void {
    try {
      this.emitter.to(boardRoom(boardId)).emit(event, payload);
    } catch (error) {
      this.options.onFailure?.(event, boardId, error);
    }
  }
}
