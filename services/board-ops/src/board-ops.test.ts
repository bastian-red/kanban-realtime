import { beforeEach, describe, expect, it } from 'vitest';

import {
  archiveCard,
  archiveList,
  BoardOpError,
  createCard,
  createList,
  MemoryRepository,
  type MemorySeed,
  moveCard,
  moveList,
  updateCard,
  updateList,
  wipStateFor,
} from './index';

const BOARD = 'board_1';

function seed(): MemorySeed {
  return {
    boardId: BOARD,
    members: [
      { userId: 'owner', name: 'Ana Ruiz', role: 'OWNER' },
      { userId: 'editor', name: 'Bruno Salas', role: 'EDITOR' },
      { userId: 'viewer', name: 'Carla Ortiz', role: 'VIEWER' },
    ],
    lists: [
      {
        id: 'todo',
        name: 'Todo',
        position: 'a1',
        cards: [
          { id: 'c1', title: 'First', position: 'a1' },
          { id: 'c2', title: 'Second', position: 'a2' },
          { id: 'c3', title: 'Third', position: 'a3' },
        ],
      },
      { id: 'doing', name: 'Doing', position: 'a2', wipLimit: 2, cards: [] },
      { id: 'gone', name: 'Archived', position: 'a3', archivedAt: new Date(), cards: [] },
    ],
    labels: [
      { id: 'lab_bug', name: 'Bug', colorSlot: 0 },
      { id: 'lab_design', name: 'Design', colorSlot: 1 },
    ],
    // Belongs to board_2. Resolvable by id, and still not attachable here.
    foreignLabels: [{ id: 'lab_other', name: 'Someone else’s', boardId: 'board_2' }],
  };
}

let repository: MemoryRepository;

beforeEach(() => {
  repository = new MemoryRepository(seed());
});

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof BoardOpError) return error.code;
    throw error;
  }
  throw new Error('expected the operation to be refused, but it succeeded');
};

describe('moving a card', () => {
  it('places it between the neighbours the client named', async () => {
    const result = await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c3',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'todo',
      afterCardId: 'c1',
      beforeCardId: 'c2',
    });

    expect(repository.order('todo')).toEqual(['c1', 'c3', 'c2']);
    expect(result.fromListId).toBe('todo');
    expect(result.attempts).toBe(1);
    expect(result.reconciled).toBe(false);
    // The version is bumped by the write, so a second edit carrying the old one
    // is now stale. That is the whole mechanism.
    expect(result.card.version).toBe(1);
  });

  it('moves a card to the top of another list', async () => {
    await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c2',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'doing',
      afterCardId: null,
      beforeCardId: null,
    });
    expect(repository.order('doing')).toEqual(['c2']);
    expect(repository.order('todo')).toEqual(['c1', 'c3']);
  });

  it('records what happened, with the destination named', async () => {
    await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'doing',
      afterCardId: null,
      beforeCardId: null,
    });
    const [activity] = repository.activities;
    expect(activity?.type).toBe('CARD_MOVED');
    expect(activity?.subject).toBe('First');
    expect(activity?.detail).toBe('to Doing');
  });

  it('says "within" rather than "to" for a reorder inside one list', async () => {
    await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'todo',
      afterCardId: 'c2',
      beforeCardId: 'c3',
    });
    expect(repository.activities[0]?.detail).toBe('within Todo');
  });

  it('never lets a card be its own neighbour', async () => {
    // Moving a card to where it already is. If the card were left in the sibling
    // set, the bounds would be its own position on both sides and `keyBetween`
    // would refuse them as non-ascending -- a no-op drag would throw.
    await expect(
      moveCard(repository, {
        boardId: BOARD,
        cardId: 'c2',
        actorId: 'editor',
        expectedVersion: 0,
        toListId: 'todo',
        afterCardId: 'c1',
        beforeCardId: 'c3',
      }),
    ).resolves.toBeDefined();
    expect(repository.order('todo')).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('a stale client view', () => {
  it('is reported when the named neighbours are no longer adjacent', async () => {
    // Somebody inserted c3 between c1 and c2 while this client was dragging. The
    // move still lands after c1 -- that is where the user pointed -- but the
    // caller is told its view was behind so it can trust the broadcast rather
    // than its own optimistic placement.
    await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c3',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'todo',
      afterCardId: 'c1',
      beforeCardId: 'c2',
    });

    const result = await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c2',
      actorId: 'owner',
      expectedVersion: 0,
      toListId: 'todo',
      // This client still believes c2 follows c1 directly.
      afterCardId: 'c1',
      beforeCardId: 'c2',
    });

    expect(result.reconciled).toBe(true);
    // And it landed where the user pointed: immediately after c1, ahead of the
    // card that arrived in the meantime.
    expect(repository.order('todo')).toEqual(['c1', 'c2', 'c3']);
  });

  it('refuses when the card they dropped below is gone', async () => {
    // "Put it after X" has no meaning without X. Guessing would put the card
    // somewhere the user never pointed, which is worse than an error they can act
    // on.
    expect(
      await codeOf(
        moveCard(repository, {
          boardId: BOARD,
          cardId: 'c1',
          actorId: 'editor',
          expectedVersion: 0,
          toListId: 'todo',
          afterCardId: 'card-that-never-existed',
          beforeCardId: null,
        }),
      ),
    ).toBe('INVALID');
  });
});

describe('the optimistic lock', () => {
  it('rejects a move carrying an old version', async () => {
    await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'doing',
      afterCardId: null,
      beforeCardId: null,
    });

    // A second client that loaded the board before that move still thinks the
    // card is at version 0.
    expect(
      await codeOf(
        moveCard(repository, {
          boardId: BOARD,
          cardId: 'c1',
          actorId: 'owner',
          expectedVersion: 0,
          toListId: 'todo',
          afterCardId: null,
          beforeCardId: null,
        }),
      ),
    ).toBe('STALE');
  });

  it('rejects a second concurrent title edit at the same version', async () => {
    // The failure fractional indexing cannot help with: both writers aim at the
    // same row. Exactly one wins, and the loser is told rather than silently
    // overwritten.
    const first = await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      title: 'Edited by Bruno',
    });
    expect(first.title).toBe('Edited by Bruno');

    expect(
      await codeOf(
        updateCard(repository, {
          boardId: BOARD,
          cardId: 'c1',
          actorId: 'owner',
          expectedVersion: 0,
          title: 'Edited by Ana',
        }),
      ),
    ).toBe('STALE');

    // And the winner's text is what survived.
    expect(repository.activities.filter((row) => row.type === 'CARD_UPDATED')).toHaveLength(1);
  });

  it('leaves nothing behind when a move is refused', async () => {
    // Atomicity: a refused move must not have appended an activity row. A feed
    // that records moves that did not happen is worse than no feed.
    await codeOf(
      moveCard(repository, {
        boardId: BOARD,
        cardId: 'c1',
        actorId: 'editor',
        expectedVersion: 99,
        toListId: 'doing',
        afterCardId: null,
        beforeCardId: null,
      }),
    );
    expect(repository.activities).toHaveLength(0);
    expect(repository.order('todo')).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('the retry loop', () => {
  it('recovers from a single position collision', async () => {
    repository.setOptions({ collideOnce: true });

    const result = await moveCard(repository, {
      boardId: BOARD,
      cardId: 'c3',
      actorId: 'editor',
      expectedVersion: 0,
      toListId: 'doing',
      afterCardId: null,
      beforeCardId: null,
    });

    // Two attempts, one successful move, one card in the destination. The second
    // attempt must not have left the first attempt's activity row behind either.
    expect(result.attempts).toBe(2);
    expect(repository.order('doing')).toEqual(['c3']);
    expect(repository.activities).toHaveLength(1);
  });

  it('gives up with CONFLICT rather than spinning forever', async () => {
    repository.setOptions({ collideAlways: true });

    expect(
      await codeOf(
        moveCard(
          repository,
          {
            boardId: BOARD,
            cardId: 'c3',
            actorId: 'editor',
            expectedVersion: 0,
            toListId: 'doing',
            afterCardId: null,
            beforeCardId: null,
          },
          { maxAttempts: 3 },
        ),
      ),
    ).toBe('CONFLICT');

    // Exactly the ceiling, not one more and not forever. An unbounded retry loop
    // under contention is an outage, not a fix.
    expect(repository.transactions).toBe(3);
  });

  it('does not retry anything that is not a position collision', async () => {
    // A STALE cannot be fixed by re-jittering a key. Retrying it would burn the
    // whole attempt budget and then report a CONFLICT, blaming concurrency for a
    // version mismatch the caller could have been told about immediately.
    expect(
      await codeOf(
        moveCard(repository, {
          boardId: BOARD,
          cardId: 'c1',
          actorId: 'editor',
          expectedVersion: 42,
          toListId: 'doing',
          afterCardId: null,
          beforeCardId: null,
        }),
      ),
    ).toBe('STALE');
    expect(repository.transactions).toBe(1);
  });

  it('refuses a nonsensical attempt ceiling', async () => {
    expect(
      await codeOf(
        moveCard(
          repository,
          {
            boardId: BOARD,
            cardId: 'c1',
            actorId: 'editor',
            expectedVersion: 0,
            toListId: 'doing',
            afterCardId: null,
            beforeCardId: null,
          },
          { maxAttempts: 0 },
        ),
      ),
    ).toBe('INVALID');
  });
});

describe('the permission matrix, through the real operations', () => {
  /**
   * Not a re-test of `can()` -- packages/shared already covers 3 roles x 14
   * operations. This asserts the *wiring*: that each function asks about the
   * operation it actually performs. A `createCard` that checked `card.update`
   * would pass every test in the shared package and let a viewer... well, nothing,
   * because both are editor-level. Which is exactly why the interesting cases are
   * the ones where the answers differ by role.
   */
  const attempts: Record<string, (actor: string) => Promise<unknown>> = {
    'card.move': (actor) =>
      moveCard(repository, {
        boardId: BOARD,
        cardId: 'c1',
        actorId: actor,
        expectedVersion: 0,
        toListId: 'doing',
        afterCardId: null,
        beforeCardId: null,
      }),
    'card.create': (actor) =>
      createCard(repository, { boardId: BOARD, listId: 'todo', actorId: actor, title: 'New' }),
    'card.update': (actor) =>
      updateCard(repository, {
        boardId: BOARD,
        cardId: 'c1',
        actorId: actor,
        expectedVersion: 0,
        title: 'Renamed',
      }),
    'card.archive': (actor) =>
      archiveCard(repository, { boardId: BOARD, cardId: 'c1', actorId: actor, expectedVersion: 0 }),
    'list.create': (actor) =>
      createList(repository, { boardId: BOARD, actorId: actor, name: 'New' }),
    'list.rename': (actor) =>
      updateList(repository, { boardId: BOARD, listId: 'todo', actorId: actor, name: 'Renamed' }),
    'list.move': (actor) =>
      moveList(repository, {
        boardId: BOARD,
        listId: 'doing',
        actorId: actor,
        afterListId: null,
        beforeListId: null,
      }),
    'list.archive': (actor) =>
      archiveList(repository, { boardId: BOARD, listId: 'todo', actorId: actor }),
  };

  for (const [operation, attempt] of Object.entries(attempts)) {
    it(`lets an editor ${operation}`, async () => {
      await expect(attempt('editor')).resolves.toBeDefined();
    });

    it(`refuses a viewer ${operation}`, async () => {
      expect(await codeOf(attempt('viewer'))).toBe('FORBIDDEN');
    });

    it(`refuses a stranger ${operation}`, async () => {
      // Not a member at all: a shared link, or somebody removed while their tab
      // was open. `can()` takes `BoardRole | null` precisely so this is a denial
      // and not a crash.
      expect(await codeOf(attempt('nobody'))).toBe('FORBIDDEN');
    });
  }

  it('refuses before touching the database', async () => {
    await codeOf(attempts['card.move']!('viewer'));
    // The permission check runs before `withTransaction`, so a refused operation
    // costs no transaction at all. A check inside the transaction would take row
    // locks on behalf of somebody who is not allowed to be there.
    expect(repository.transactions).toBe(0);
    expect(repository.activities).toHaveLength(0);
  });

  it('names the role in the refusal', async () => {
    try {
      await attempts['card.move']!('viewer');
    } catch (error) {
      expect((error as Error).message).toMatch(/viewer may not/i);
    }
    try {
      await attempts['card.move']!('nobody');
    } catch (error) {
      expect((error as Error).message).toMatch(/not a member/i);
    }
  });
});

describe('cross-board access', () => {
  it('refuses to move a card into a list on another board', async () => {
    // The permission check covered `input.boardId`. Without this check, somebody
    // who knows two ids could move a card out of a board they are not a member of
    // and into one they are.
    // Control: the identical call against the board that owns those rows works,
    // so the refusal below is about the board and not about the request.
    const other = new MemoryRepository({ ...seed(), boardId: 'board_2' });
    await expect(
      moveCard(other, {
        boardId: 'board_2',
        cardId: 'c1',
        actorId: 'editor',
        expectedVersion: 0,
        toListId: 'doing',
        afterCardId: null,
        beforeCardId: null,
      }),
    ).resolves.toBeDefined();

    expect(
      await codeOf(
        moveCard(repository, {
          boardId: 'board_2',
          cardId: 'c1',
          actorId: 'editor',
          expectedVersion: 0,
          toListId: 'todo',
          afterCardId: null,
          beforeCardId: null,
        }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('refuses an archived list as a destination', async () => {
    expect(
      await codeOf(
        moveCard(repository, {
          boardId: BOARD,
          cardId: 'c1',
          actorId: 'editor',
          expectedVersion: 0,
          toListId: 'gone',
          afterCardId: null,
          beforeCardId: null,
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('creating', () => {
  it('appends a card to the end by default', async () => {
    const card = await createCard(repository, {
      boardId: BOARD,
      listId: 'todo',
      actorId: 'editor',
      title: 'Fourth',
    });
    expect(repository.order('todo')).toEqual(['c1', 'c2', 'c3', card.id]);
  });

  it('inserts after a named card', async () => {
    const card = await createCard(repository, {
      boardId: BOARD,
      listId: 'todo',
      actorId: 'editor',
      title: 'Between',
      afterCardId: 'c1',
    });
    expect(repository.order('todo')).toEqual(['c1', card.id, 'c2', 'c3']);
  });

  it('refuses an unknown anchor rather than silently appending', async () => {
    expect(
      await codeOf(
        createCard(repository, {
          boardId: BOARD,
          listId: 'todo',
          actorId: 'editor',
          title: 'Nowhere',
          afterCardId: 'not-a-card',
        }),
      ),
    ).toBe('INVALID');
  });

  it('refuses a WIP limit of zero with a sentence, not a 23514', async () => {
    expect(
      await codeOf(
        createList(repository, { boardId: BOARD, actorId: 'editor', name: 'Blocked', wipLimit: 0 }),
      ),
    ).toBe('INVALID');
  });

  it('keeps the description, due date and assignee it was given', async () => {
    // All three were accepted by `createCardSchema` and dropped by the handler,
    // which destructured three fields out of a seven-field body. A card created
    // with a due date came back without one and nothing said so.
    const dueOn = new Date('2026-04-01T00:00:00.000Z');
    const card = await createCard(repository, {
      boardId: BOARD,
      listId: 'todo',
      actorId: 'editor',
      title: 'With everything',
      description: 'A real description.',
      dueOn,
      assigneeId: 'editor',
    });

    expect(card.description).toBe('A real description.');
    expect(card.dueOn).toEqual(dueOn);
    expect(card.assigneeId).toBe('editor');
  });
});

describe('labels', () => {
  it('attaches the labels a new card was created with', async () => {
    const card = await createCard(repository, {
      boardId: BOARD,
      listId: 'todo',
      actorId: 'editor',
      title: 'Labelled',
      labelIds: ['lab_bug', 'lab_design'],
    });
    expect(repository.labelsOn(card.id)).toEqual(['lab_bug', 'lab_design']);
  });

  it('refuses a label belonging to another board', async () => {
    // The cross-board write. A label id is just a cuid, so without the board
    // check an editor here could paste board_2's label id and have it render on
    // a board whose owners never touched it.
    expect(
      await codeOf(
        createCard(repository, {
          boardId: BOARD,
          listId: 'todo',
          actorId: 'editor',
          title: 'Stolen label',
          labelIds: ['lab_other'],
        }),
      ),
    ).toBe('INVALID');
  });

  it('does not leave the card behind when a label is refused', async () => {
    // The atomicity that matters here. Labels are written after the insert
    // because the join rows need the card's id, so a rejected label has to take
    // the card with it -- otherwise the caller gets an error and a card.
    const before = repository.order('todo');
    await codeOf(
      createCard(repository, {
        boardId: BOARD,
        listId: 'todo',
        actorId: 'editor',
        title: 'Should not survive',
        labelIds: ['lab_bug', 'lab_other'],
      }),
    );
    expect(repository.order('todo')).toEqual(before);
  });

  it('replaces the set on update rather than adding to it', async () => {
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      labelIds: ['lab_bug', 'lab_design'],
    });
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 1,
      labelIds: ['lab_design'],
    });
    // Additive semantics would leave lab_bug here, and removing a label would
    // then be impossible without a second verb.
    expect(repository.labelsOn('c1')).toEqual(['lab_design']);
  });

  it('clears them when given an empty array', async () => {
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      labelIds: ['lab_bug'],
    });
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 1,
      labelIds: [],
    });
    expect(repository.labelsOn('c1')).toEqual([]);
  });

  it('leaves them alone when the field is absent', async () => {
    // `undefined` means "not part of this edit". Collapsing it with `[]` would
    // make every title edit silently strip the card's labels.
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      labelIds: ['lab_bug'],
    });
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 1,
      title: 'Renamed only',
    });
    expect(repository.labelsOn('c1')).toEqual(['lab_bug']);
  });

  it('collapses a repeated id instead of failing on the unique index', async () => {
    const card = await createCard(repository, {
      boardId: BOARD,
      listId: 'todo',
      actorId: 'editor',
      title: 'Double clicked',
      labelIds: ['lab_bug', 'lab_bug'],
    });
    expect(repository.labelsOn(card.id)).toEqual(['lab_bug']);
  });

  it('records a label change in the activity feed, and a no-op change not at all', async () => {
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 0,
      labelIds: ['lab_bug'],
    });
    expect(repository.activities.at(-1)?.detail).toBe('labels');

    // The same set again is not a change, and a feed row claiming otherwise
    // teaches the reader to distrust the feed.
    await updateCard(repository, {
      boardId: BOARD,
      cardId: 'c1',
      actorId: 'editor',
      expectedVersion: 1,
      labelIds: ['lab_bug'],
    });
    expect(repository.activities.at(-1)?.detail).toBeNull();
  });

  it('refuses a viewer trying to label a card', async () => {
    expect(
      await codeOf(
        updateCard(repository, {
          boardId: BOARD,
          cardId: 'c1',
          actorId: 'viewer',
          expectedVersion: 0,
          labelIds: ['lab_bug'],
        }),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('archiving', () => {
  it('takes the card out of the list without deleting it', async () => {
    await archiveCard(repository, {
      boardId: BOARD,
      cardId: 'c2',
      actorId: 'editor',
      expectedVersion: 0,
    });
    expect(repository.order('todo')).toEqual(['c1', 'c3']);
    // The activity row still names it, because the title was stored on the row
    // rather than joined at read time.
    expect(repository.activities[0]?.subject).toBe('Second');
  });

  it('refuses to archive a card twice', async () => {
    await archiveCard(repository, {
      boardId: BOARD,
      cardId: 'c2',
      actorId: 'editor',
      expectedVersion: 0,
    });
    expect(
      await codeOf(
        archiveCard(repository, {
          boardId: BOARD,
          cardId: 'c2',
          actorId: 'editor',
          expectedVersion: 1,
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('leaves an archived card out of the neighbour set', async () => {
    // An archived card still holds its (list_id, position) row. If it were
    // treated as a neighbour, a drop "after the last card" would aim at a card
    // nobody can see.
    await archiveCard(repository, {
      boardId: BOARD,
      cardId: 'c3',
      actorId: 'editor',
      expectedVersion: 0,
    });
    const card = await createCard(repository, {
      boardId: BOARD,
      listId: 'todo',
      actorId: 'editor',
      title: 'Last',
    });
    expect(repository.order('todo')).toEqual(['c1', 'c2', card.id]);
  });
});

describe('wipStateFor', () => {
  // Colour is never the only channel: every state ships with the words that name
  // it, so a component cannot render the state without them.
  it.each([
    [0, null, 'none', '0 cards'],
    [3, null, 'none', '3 cards'],
    [1, 3, 'under', '1/3'],
    [3, 3, 'at', 'At limit 3/3'],
    [4, 3, 'over', 'Over limit 4/3'],
  ])('reads %i against %j as %s (%s)', (count, limit, state, label) => {
    expect(wipStateFor(count, limit)).toEqual({ state, label });
  });

  it('never returns an empty label', () => {
    for (const limit of [null, 1, 5]) {
      for (let count = 0; count < 8; count += 1) {
        expect(wipStateFor(count, limit).label.length).toBeGreaterThan(0);
      }
    }
  });
});
