import type { Board, Card, ListHeader } from '@kan/shared';
import { describe, expect, it } from 'vitest';

import { applyOptimisticMove, cardOf, listOf, neighboursFor, reduce } from './board-state';

/**
 * Positions are base62 fractional indices and are compared as bytes. The
 * literals below are chosen so `'a0' < 'a1' < 'a2'` holds under plain `<`, which
 * is the same comparison Postgres's C collation and `sortByPosition` make.
 */
const card = (
  id: string,
  listId: string,
  position: string,
  overrides: Partial<Card> = {},
): Card => ({
  id,
  listId,
  title: `Card ${id}`,
  description: null,
  position,
  version: 1,
  dueOn: null,
  assigneeId: null,
  labels: [],
  createdAt: '2026-08-09T09:00:00.000Z',
  updatedAt: '2026-08-09T09:00:00.000Z',
  ...overrides,
});

const header = (id: string, position: string, wipLimit: number | null = null): ListHeader => ({
  id,
  boardId: 'b1',
  name: `List ${id}`,
  position,
  wipLimit,
  wip: { state: 'none', label: '0 cards' },
});

function board(): Board {
  return {
    id: 'b1',
    name: 'Sprint 12',
    role: 'EDITOR',
    updatedAt: '2026-08-09T09:00:00.000Z',
    members: [
      { userId: 'u1', role: 'OWNER', name: 'Ana Ruiz', email: 'ana@kan.local', initials: 'AR' },
    ],
    labels: [],
    lists: [
      {
        ...header('l1', 'a0', 3),
        wip: { state: 'under', label: '2/3' },
        cards: [card('c1', 'l1', 'a0'), card('c2', 'l1', 'a1')],
      },
      {
        ...header('l2', 'a1'),
        wip: { state: 'none', label: '1 cards' },
        cards: [card('c3', 'l2', 'a0')],
      },
    ],
  };
}

const ids = (b: Board, listId: string): string[] =>
  b.lists.find((list) => list.id === listId)?.cards.map((c) => c.id) ?? [];

describe('board.state', () => {
  it('replaces everything and re-sorts by position', () => {
    // The payload arrives sorted from the server, but a client that trusted that
    // would be trusting a query plan. Sorting here is one line and removes the
    // question.
    const scrambled: Board = {
      ...board(),
      lists: [
        { ...header('l2', 'a1'), cards: [card('c3', 'l2', 'a1'), card('c4', 'l2', 'a0')] },
        { ...header('l1', 'a0'), cards: [] },
      ],
    };

    const next = reduce(board(), { type: 'board.state', board: scrambled });

    expect(next.lists.map((list) => list.id)).toEqual(['l1', 'l2']);
    expect(ids(next, 'l2')).toEqual(['c4', 'c3']);
  });

  it('recomputes the WIP words from the cards it was given', () => {
    // The server sends them too, but this is the one event that can arrive after
    // arbitrary local optimistic state, and a header disagreeing with the column
    // under it is the exact thing the words exist to prevent.
    const next = reduce(board(), {
      type: 'board.state',
      board: {
        ...board(),
        lists: [{ ...header('l1', 'a0', 3), cards: [card('c1', 'l1', 'a0')] }],
      },
    });
    expect(next.lists[0]?.wip).toEqual({ state: 'under', label: '1/3' });
  });
});

describe('cards', () => {
  it('inserts a created card in position order, not at the end', () => {
    const next = reduce(board(), { type: 'card.created', card: card('c0', 'l1', 'Zz') });
    // 'Zz' < 'a0' in byte order: uppercase sorts before lowercase.
    expect(ids(next, 'l1')).toEqual(['c0', 'c1', 'c2']);
  });

  it('ignores a created card it already holds', () => {
    // The creator applies its own broadcast too. Without this a card appears
    // twice for the person who made it and once for everybody else.
    const next = reduce(board(), { type: 'card.created', card: card('c1', 'l1', 'a0') });
    expect(ids(next, 'l1')).toEqual(['c1', 'c2']);
  });

  it('updates a card in place', () => {
    const next = reduce(board(), {
      type: 'card.updated',
      card: card('c1', 'l1', 'a0', { title: 'Renamed', version: 2 }),
    });
    expect(cardOf(next, 'c1')?.title).toBe('Renamed');
    expect(cardOf(next, 'c1')?.version).toBe(2);
  });

  it('ignores an update describing an older version', () => {
    // Two gateway replicas publish through Redis, and nothing guarantees the
    // order two messages reach one browser. Applying the older one reverts an
    // edit on one screen and nowhere else, which is the least reproducible bug
    // this app could have.
    const ahead = reduce(board(), {
      type: 'card.updated',
      card: card('c1', 'l1', 'a0', { title: 'Newer', version: 5 }),
    });
    const next = reduce(ahead, {
      type: 'card.updated',
      card: card('c1', 'l1', 'a0', { title: 'Older', version: 3 }),
    });
    expect(cardOf(next, 'c1')?.title).toBe('Newer');
  });

  it('keeps an updated card in the list the board says it is in', () => {
    // The card moved between the update being produced and it arriving. The move
    // is the newer fact about where it lives; the update is about its fields.
    const moved = reduce(board(), {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        fromListId: 'l1',
        toListId: 'l2',
        position: 'a2',
        version: 2,
        movedAt: '2026-08-09T09:01:00.000Z',
      },
    });
    const next = reduce(moved, {
      type: 'card.updated',
      card: card('c1', 'l1', 'a0', { title: 'Renamed', version: 3 }),
    });

    expect(ids(next, 'l2')).toContain('c1');
    expect(ids(next, 'l1')).not.toContain('c1');
    expect(cardOf(next, 'c1')?.title).toBe('Renamed');
  });

  it('ignores an update for a card it does not hold', () => {
    const next = reduce(board(), { type: 'card.updated', card: card('nope', 'l1', 'a5') });
    expect(next).toEqual(board());
  });

  it('archives by removing the card from wherever it is', () => {
    const next = reduce(board(), { type: 'card.archived', cardId: 'c1', listId: 'l1' });
    expect(ids(next, 'l1')).toEqual(['c2']);
  });

  it('recomputes the WIP words after every card change', () => {
    const next = reduce(board(), { type: 'card.archived', cardId: 'c1', listId: 'l1' });
    expect(next.lists[0]?.wip).toEqual({ state: 'under', label: '1/3' });

    const filled = reduce(next, { type: 'card.created', card: card('c9', 'l1', 'b0') });
    const fuller = reduce(filled, { type: 'card.created', card: card('c8', 'l1', 'b1') });
    expect(fuller.lists[0]?.wip).toEqual({ state: 'at', label: 'At limit 3/3' });
  });
});

describe('card.moved', () => {
  const move = (overrides: Partial<Board> = {}) =>
    reduce(
      { ...board(), ...overrides },
      {
        type: 'card.moved',
        move: {
          cardId: 'c1',
          fromListId: 'l1',
          toListId: 'l2',
          position: 'a05',
          version: 2,
          movedAt: '2026-08-09T09:02:00.000Z',
        },
      },
    );

  it('takes the card out of its old list and puts it in the new one, in order', () => {
    const next = move();
    expect(ids(next, 'l1')).toEqual(['c2']);
    // 'a0' < 'a05' < 'a1'
    expect(ids(next, 'l2')).toEqual(['c3', 'c1']);
    expect(cardOf(next, 'c1')?.listId).toBe('l2');
    expect(cardOf(next, 'c1')?.position).toBe('a05');
    expect(cardOf(next, 'c1')?.version).toBe(2);
  });

  it('removes the card from wherever the client thinks it is, not from fromListId', () => {
    // The receiving client may be behind: the card may already have been moved
    // once more by somebody else. Trusting `fromListId` would leave a duplicate
    // behind in a column the card left two events ago.
    const behind = reduce(board(), {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        fromListId: 'l1',
        toListId: 'l2',
        position: 'a3',
        version: 2,
        movedAt: '2026-08-09T09:01:00.000Z',
      },
    });

    const next = reduce(behind, {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        // Stale: this client already has the card in l2.
        fromListId: 'l1',
        toListId: 'l1',
        position: 'a5',
        version: 3,
        movedAt: '2026-08-09T09:03:00.000Z',
      },
    });

    expect(ids(next, 'l2')).toEqual(['c3']);
    expect(ids(next, 'l1')).toEqual(['c2', 'c1']);
  });

  it('ignores a move describing an older version', () => {
    const ahead = move();
    const next = reduce(ahead, {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        fromListId: 'l2',
        toListId: 'l1',
        position: 'a9',
        version: 1,
        movedAt: '2026-08-09T09:00:30.000Z',
      },
    });
    expect(cardOf(next, 'c1')?.listId).toBe('l2');
  });

  it('drops the card when the destination column is not on this client', () => {
    // The column was archived, or the client joined before it existed. Rendering
    // a card in a column that is not there is not an option, and the next
    // board.state restores it.
    const next = reduce(board(), {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        fromListId: 'l1',
        toListId: 'gone',
        position: 'a0',
        version: 2,
        movedAt: '2026-08-09T09:02:00.000Z',
      },
    });
    expect(cardOf(next, 'c1')).toBeUndefined();
    expect(ids(next, 'l1')).toEqual(['c2']);
  });

  it('updates the WIP words on both the source and the destination', () => {
    const next = move();
    expect(next.lists.find((list) => list.id === 'l1')?.wip).toEqual({
      state: 'under',
      label: '1/3',
    });
    expect(next.lists.find((list) => list.id === 'l2')?.wip).toEqual({
      state: 'none',
      label: '2 cards',
    });
  });
});

describe('lists', () => {
  it('inserts a created list in position order', () => {
    const next = reduce(board(), { type: 'list.created', list: header('l0', 'Zz') });
    expect(next.lists.map((list) => list.id)).toEqual(['l0', 'l1', 'l2']);
    expect(next.lists[0]?.cards).toEqual([]);
  });

  it('ignores a created list it already holds', () => {
    const next = reduce(board(), { type: 'list.created', list: header('l1', 'a0') });
    expect(next.lists).toHaveLength(2);
  });

  it('applies a header update without touching the cards', () => {
    // The whole reason `list.updated` carries a header rather than a list. If it
    // shipped cards, a rename would replace everyone else's column with the
    // renamer's snapshot -- silently undoing a drag that landed a millisecond
    // earlier.
    const next = reduce(board(), {
      type: 'list.updated',
      list: { ...header('l1', 'a0', 3), name: 'Doing' },
    });
    expect(next.lists[0]?.name).toBe('Doing');
    expect(ids(next, 'l1')).toEqual(['c1', 'c2']);
  });

  it('re-sorts on a list move', () => {
    const next = reduce(board(), { type: 'list.moved', listId: 'l1', position: 'a9' });
    expect(next.lists.map((list) => list.id)).toEqual(['l2', 'l1']);
  });

  it('removes an archived list and the cards in it', () => {
    const next = reduce(board(), { type: 'list.archived', listId: 'l1' });
    expect(next.lists.map((list) => list.id)).toEqual(['l2']);
    expect(cardOf(next, 'c1')).toBeUndefined();
  });

  it('ignores an event for a list it does not hold rather than inventing a column', () => {
    const next = reduce(board(), { type: 'list.updated', list: header('ghost', 'a5') });
    expect(next.lists.map((list) => list.id)).toEqual(['l1', 'l2']);
  });
});

describe('board and members', () => {
  it('renames', () => {
    expect(reduce(board(), { type: 'board.renamed', name: 'Sprint 13' }).name).toBe('Sprint 13');
  });

  it('replaces the whole roster rather than merging a delta', () => {
    // `member.changed` carries the roster, not a change to it: a client that
    // missed one delta while backgrounded would otherwise show a ghost forever.
    const next = reduce(board(), { type: 'member.changed', members: [] });
    expect(next.members).toEqual([]);
  });
});

describe('applyOptimisticMove', () => {
  it('splices by index and leaves the position stale', () => {
    // The card is drawn where it was dropped immediately; `position` stays wrong
    // until `card.moved` arrives and re-sorts. Generating a fractional key here
    // would be a second implementation of services/ordering in the browser.
    const next = applyOptimisticMove(board(), { cardId: 'c1', toListId: 'l2', toIndex: 0 });

    expect(ids(next, 'l2')).toEqual(['c1', 'c3']);
    expect(cardOf(next, 'c1')?.position).toBe('a0');
    expect(cardOf(next, 'c1')?.listId).toBe('l2');
  });

  it('reorders within one column', () => {
    const next = applyOptimisticMove(board(), { cardId: 'c1', toListId: 'l1', toIndex: 1 });
    expect(ids(next, 'l1')).toEqual(['c2', 'c1']);
  });

  it('clamps an index past the end of a column that shrank underneath the drag', () => {
    const next = applyOptimisticMove(board(), { cardId: 'c1', toListId: 'l2', toIndex: 99 });
    expect(ids(next, 'l2')).toEqual(['c3', 'c1']);
  });

  it('is a no-op for a card or a column that is gone', () => {
    expect(applyOptimisticMove(board(), { cardId: 'gone', toListId: 'l2', toIndex: 0 })).toEqual(
      board(),
    );
    expect(applyOptimisticMove(board(), { cardId: 'c1', toListId: 'gone', toIndex: 0 })).toEqual(
      board(),
    );
  });

  it('is undone by the server’s own broadcast', () => {
    // The reconciliation the protocol is built around: the optimistic index and
    // the server's position can disagree for one round trip, and the server wins.
    const optimistic = applyOptimisticMove(board(), { cardId: 'c1', toListId: 'l2', toIndex: 0 });
    const reconciled = reduce(optimistic, {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        fromListId: 'l1',
        toListId: 'l2',
        // The server put it after c3, not before it.
        position: 'a5',
        version: 2,
        movedAt: '2026-08-09T09:02:00.000Z',
      },
    });
    expect(ids(reconciled, 'l2')).toEqual(['c3', 'c1']);
  });

  it('recomputes the WIP words, so a column reads as full while the drag is in flight', () => {
    const next = applyOptimisticMove(board(), { cardId: 'c3', toListId: 'l1', toIndex: 2 });
    expect(next.lists.find((list) => list.id === 'l1')?.wip).toEqual({
      state: 'at',
      label: 'At limit 3/3',
    });
  });
});

describe('the optimistic move as a reducer action', () => {
  it('splices by index and is not re-sorted away', () => {
    // The bug this case exists for: the drop was first dispatched as a
    // `board.state` carrying an optimistically moved board. `board.state`
    // re-sorts every column by `position`, and the optimistic card still has its
    // OLD position -- so the card snapped back before the browser painted, and
    // the board did not move until the round trip finished. Silent, and exactly
    // the lag the optimistic path exists to remove.
    const optimistic = reduce(board(), {
      type: 'optimistic.move',
      move: { cardId: 'c1', toListId: 'l2', toIndex: 0 },
    });
    expect(ids(optimistic, 'l2')).toEqual(['c1', 'c3']);

    const viaBoardState = reduce(board(), {
      type: 'board.state',
      board: applyOptimisticMove(board(), { cardId: 'c1', toListId: 'l2', toIndex: 0 }),
    });
    // The old shape, kept as the contrast: 'a0' sorts after nothing, so c1 lands
    // first here by luck of its position rather than by where it was dropped.
    // Change c1's target index and the two disagree, which is the point.
    const droppedLast = reduce(board(), {
      type: 'optimistic.move',
      move: { cardId: 'c1', toListId: 'l2', toIndex: 1 },
    });
    expect(ids(droppedLast, 'l2')).toEqual(['c3', 'c1']);
    expect(ids(viaBoardState, 'l2')).toEqual(['c1', 'c3']);
  });

  it('still gives way to the server’s broadcast', () => {
    const optimistic = reduce(board(), {
      type: 'optimistic.move',
      move: { cardId: 'c1', toListId: 'l2', toIndex: 0 },
    });
    const reconciled = reduce(optimistic, {
      type: 'card.moved',
      move: {
        cardId: 'c1',
        fromListId: 'l1',
        toListId: 'l2',
        position: 'a5',
        version: 2,
        movedAt: '2026-08-09T09:02:00.000Z',
      },
    });
    expect(ids(reconciled, 'l2')).toEqual(['c3', 'c1']);
  });
});

describe('neighboursFor', () => {
  it('names the cards either side of the drop', () => {
    expect(neighboursFor(board(), 'c3', 'l1', 1)).toEqual({
      afterCardId: 'c1',
      beforeCardId: 'c2',
    });
  });

  it('names nothing before the first slot and nothing after the last', () => {
    expect(neighboursFor(board(), 'c3', 'l1', 0)).toEqual({
      afterCardId: null,
      beforeCardId: 'c1',
    });
    expect(neighboursFor(board(), 'c3', 'l1', 2)).toEqual({
      afterCardId: 'c2',
      beforeCardId: null,
    });
  });

  it('never names the moving card as its own neighbour', () => {
    // Within one column this is the whole difficulty: dropping c1 one slot down
    // must say "after c2", not "after c1", or the server is asked to put a card
    // after itself.
    expect(neighboursFor(board(), 'c1', 'l1', 1)).toEqual({
      afterCardId: 'c2',
      beforeCardId: null,
    });
  });

  it('names nothing for a column that is gone', () => {
    expect(neighboursFor(board(), 'c1', 'gone', 0)).toEqual({
      afterCardId: null,
      beforeCardId: null,
    });
  });
});

describe('listOf', () => {
  it('finds the column a card is in', () => {
    expect(listOf(board(), 'c3')?.id).toBe('l2');
    expect(listOf(board(), 'gone')).toBeUndefined();
  });
});
