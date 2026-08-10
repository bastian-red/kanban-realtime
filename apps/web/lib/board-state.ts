import type { Board, Card, CardMoved, ListHeader, Member } from '@kan/shared';
import { wipStateFor } from '@kan/shared';

/**
 * The board, as the browser holds it, and every way the server can change it.
 *
 * This file is a pure function over a `Board`. That is the whole design: the
 * board component holds no logic beyond calling `reduce`, so the interesting
 * behaviour -- what a `card.moved` from somebody else does to a column you are
 * mid-drag in, what happens when two events arrive out of order, what an
 * optimistic move looks like before the ack -- is tested in milliseconds with no
 * browser, no socket and no database.
 *
 * Three rules run through all of it.
 *
 * **The server's order wins, and it is expressed as `position`.** Every server
 * event carries the authoritative fractional index, and applying one re-sorts the
 * affected list by it. The client never invents a position: it cannot, because
 * generating a key that sorts between two others is `services/ordering`'s job and
 * a second implementation of it in the browser would be a second thing to get
 * wrong.
 *
 * **An optimistic move is an index, not a position.** When you drop a card, the
 * card is spliced into the destination array at the index you dropped it -- with
 * its stale `position` untouched -- so the board redraws instantly. The `position`
 * only becomes true when `card.moved` comes back, and applying that event
 * re-sorts. This is what the protocol means by "the client applies the move
 * optimistically and reconciles against the ack": the two placements can disagree
 * for one round trip, and the server's is the one that survives.
 *
 * **A stale event is ignored, not applied.** Cards carry a `version`, and it only
 * goes up. An event describing a version older than the one already in hand is a
 * message that overtook a newer one on a different Redis connection, and applying
 * it would move a card backwards for one reader and nobody else.
 */

export type BoardEvent =
  | { type: 'board.state'; board: Board }
  | { type: 'board.renamed'; name: string }
  | { type: 'member.changed'; members: Member[] }
  | { type: 'list.created'; list: ListHeader }
  | { type: 'list.updated'; list: ListHeader }
  | { type: 'list.moved'; listId: string; position: string }
  | { type: 'list.archived'; listId: string }
  | { type: 'card.created'; card: Card }
  | { type: 'card.updated'; card: Card }
  | { type: 'card.moved'; move: CardMoved }
  | { type: 'card.archived'; cardId: string; listId: string }
  /**
   * This client's own drop, before the server has agreed to it.
   *
   * A member of the same union as the server events, and dispatched through the
   * same reducer, because it has to be applied in order with them: a `card.moved`
   * from somebody else that lands between the drop and its ack must be applied on
   * top of the optimistic placement, not to the board as it was before the drag.
   *
   * It is emphatically **not** a `board.state` carrying an optimistically moved
   * board, which is how this was written first. `board.state` re-sorts every
   * column by `position`, and the whole point of the optimistic move is that the
   * card's position is still the old one -- so the re-sort put the card straight
   * back where it came from and the board did not move until the round trip
   * completed. Silent, and exactly the lag the optimistic path exists to remove.
   */
  | { type: 'optimistic.move'; move: OptimisticMove };

/** Ascending byte order, matching Postgres's C collation and `sortByPosition`. */
const byPosition = <T extends { position: string }>(items: readonly T[]): T[] =>
  [...items].sort((left, right) =>
    left.position < right.position ? -1 : left.position > right.position ? 1 : 0,
  );

/** A list with its WIP words recomputed from the cards it now holds. */
function withWip(list: Board['lists'][number]): Board['lists'][number] {
  return { ...list, wip: wipStateFor(list.cards.length, list.wipLimit) };
}

/** Every list, with the one matching `listId` replaced by `change(list)`. */
function mapList(
  board: Board,
  listId: string,
  change: (list: Board['lists'][number]) => Board['lists'][number],
): Board {
  let touched = false;
  const lists = board.lists.map((list) => {
    if (list.id !== listId) return list;
    touched = true;
    return withWip(change(list));
  });
  // An event for a list this client has never heard of is dropped rather than
  // creating an empty column. It means a `list.created` was missed, and the
  // board's next resync is what fixes that -- inventing a column here would
  // render one with no name and no position.
  return touched ? { ...board, lists } : board;
}

/** The list a card currently sits in, by id. */
export function listOf(board: Board, cardId: string): Board['lists'][number] | undefined {
  return board.lists.find((list) => list.cards.some((card) => card.id === cardId));
}

export function cardOf(board: Board, cardId: string): Card | undefined {
  for (const list of board.lists) {
    const card = list.cards.find((entry) => entry.id === cardId);
    if (card) return card;
  }
  return undefined;
}

/** Drop a card from wherever it is, in every list, and return the board. */
function removeCard(board: Board, cardId: string): Board {
  return {
    ...board,
    lists: board.lists.map((list) =>
      list.cards.some((card) => card.id === cardId)
        ? withWip({ ...list, cards: list.cards.filter((card) => card.id !== cardId) })
        : list,
    ),
  };
}

/**
 * Apply one server event.
 *
 * Always returns a board. An event that cannot be applied -- an unknown list, a
 * card the client does not hold, a version that has already been passed --
 * returns the board unchanged rather than throwing, because the alternative is a
 * socket message taking down the page.
 */
export function reduce(board: Board, event: BoardEvent): Board {
  switch (event.type) {
    case 'board.state':
      // The whole board, re-sorted. This is what a join and a forced resync both
      // deliver, and it is the only event that discards local optimistic state --
      // which is the point of having it.
      return {
        ...event.board,
        lists: byPosition(event.board.lists).map((list) =>
          withWip({ ...list, cards: byPosition(list.cards) }),
        ),
      };

    case 'board.renamed':
      return { ...board, name: event.name };

    case 'member.changed':
      return { ...board, members: event.members };

    case 'list.created': {
      // Idempotent: the creator applies its own broadcast too, and a list added
      // twice would render two identical columns competing for one position.
      if (board.lists.some((list) => list.id === event.list.id)) return board;
      return {
        ...board,
        lists: byPosition([...board.lists, { ...event.list, cards: [] }]),
      };
    }

    case 'list.updated':
      // The header only. `list.updated` deliberately carries no cards, so a
      // rename cannot ship a stale card array and undo a drag that landed a
      // millisecond earlier on every screen but the renamer's.
      return mapList(board, event.list.id, (list) => ({
        ...list,
        ...event.list,
        cards: list.cards,
      }));

    case 'list.moved': {
      const moved = board.lists.map((list) =>
        list.id === event.listId ? { ...list, position: event.position } : list,
      );
      return { ...board, lists: byPosition(moved) };
    }

    case 'list.archived':
      return { ...board, lists: board.lists.filter((list) => list.id !== event.listId) };

    case 'card.created': {
      if (cardOf(board, event.card.id)) return board;
      return mapList(board, event.card.listId, (list) => ({
        ...list,
        cards: byPosition([...list.cards, event.card]),
      }));
    }

    case 'card.updated': {
      const existing = cardOf(board, event.card.id);
      if (!existing) return board;
      // A version that has already been passed is an event that overtook a newer
      // one. Applying it would revert somebody's edit on one screen only.
      if (event.card.version < existing.version) return board;
      // The card may have moved lists since this update was produced; keep it
      // where the board says it is rather than where the event says.
      return mapList(board, existing.listId, (list) => ({
        ...list,
        cards: byPosition(
          list.cards.map((card) =>
            card.id === event.card.id ? { ...event.card, listId: existing.listId } : card,
          ),
        ),
      }));
    }

    case 'card.moved': {
      const { move } = event;
      const existing = cardOf(board, move.cardId);
      if (!existing) return board;
      if (move.version < existing.version) return board;

      const moved: Card = {
        ...existing,
        listId: move.toListId,
        position: move.position,
        version: move.version,
        updatedAt: move.movedAt,
      };

      const without = removeCard(board, move.cardId);
      const target = without.lists.find((list) => list.id === move.toListId);
      // The destination column is not on this client -- it was archived, or the
      // client joined before it existed. Dropping the card is correct: the next
      // `board.state` restores it, and rendering a card in a column that is not
      // there is not an option.
      if (!target) return without;

      return mapList(without, move.toListId, (list) => ({
        ...list,
        cards: byPosition([...list.cards, moved]),
      }));
    }

    case 'card.archived': {
      if (!cardOf(board, event.cardId)) return board;
      return removeCard(board, event.cardId);
    }

    case 'optimistic.move':
      return applyOptimisticMove(board, event.move);

    default: {
      // Exhaustiveness: a new event added to the union without a case here is a
      // compile error, not a silent no-op at runtime.
      const never: never = event;
      return never;
    }
  }
}

export interface OptimisticMove {
  cardId: string;
  toListId: string;
  /** Where in the destination column the card was dropped, 0-based. */
  toIndex: number;
}

/**
 * The move, applied before the server has agreed to it.
 *
 * By index, not by position: see the header. The card keeps its stale
 * `position`, so this placement survives exactly until the matching `card.moved`
 * arrives and re-sorts the column -- which is the reconciliation the protocol is
 * built around.
 *
 * Returns the board unchanged when the card or the destination is unknown, so a
 * drag onto something that has just been archived is a no-op rather than a
 * crash.
 */
export function applyOptimisticMove(board: Board, move: OptimisticMove): Board {
  const card = cardOf(board, move.cardId);
  if (!card) return board;
  if (!board.lists.some((list) => list.id === move.toListId)) return board;

  const without = removeCard(board, move.cardId);
  return mapList(without, move.toListId, (list) => {
    const cards = [...list.cards];
    // Clamped rather than trusted. dnd-kit reports the index of the item being
    // hovered, and a card dropped past the end of a column that shrank under it
    // would otherwise splice at an index beyond the array.
    const index = Math.max(0, Math.min(move.toIndex, cards.length));
    cards.splice(index, 0, { ...card, listId: move.toListId });
    return { ...list, cards };
  });
}

/**
 * The neighbours a move should name, given where the card was dropped.
 *
 * The server takes neighbours rather than a position -- "put it between these two
 * cards" -- because the client's view of the column may be several events behind
 * and a position computed against a stale neighbour pair lands in the wrong gap.
 * Naming the neighbours lets the server notice the pair is no longer adjacent and
 * report `reconciled`.
 *
 * The moving card is excluded from its own neighbour search, which matters for a
 * move within one column: without that, dropping a card one slot down names the
 * card itself as the card to go after.
 */
export function neighboursFor(
  board: Board,
  cardId: string,
  toListId: string,
  toIndex: number,
): { afterCardId: string | null; beforeCardId: string | null } {
  const list = board.lists.find((entry) => entry.id === toListId);
  if (!list) return { afterCardId: null, beforeCardId: null };

  const others = list.cards.filter((card) => card.id !== cardId);
  const index = Math.max(0, Math.min(toIndex, others.length));
  return {
    afterCardId: others[index - 1]?.id ?? null,
    beforeCardId: others[index]?.id ?? null,
  };
}
