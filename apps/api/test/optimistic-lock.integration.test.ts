import type { Card } from '@kan/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  boot,
  cleanUp,
  createBoard,
  createUser,
  readList,
  type Harness,
  type TestBoard,
  type TestUser,
} from './harness';

/**
 * The optimistic lock, against a real database.
 *
 * This is the failure fractional indexing has nothing to say about. Two people
 * competing for a *gap between* cards are handled by jittered keys and a unique
 * index (see `concurrency.integration.test.ts`); two people editing the *same
 * card* are competing for one row, and without a version column the second write
 * wins silently -- the first person's change disappears with no error, no conflict
 * marker and nothing in the activity feed to explain it. Their browser still shows
 * what they typed, because their own optimistic update succeeded.
 *
 * The mechanism is `UPDATE ... WHERE version = $expected` via `updateMany`, which
 * returns a count rather than throwing. `update` would throw `P2025` for a
 * no-match, and a thrown "record not found" cannot be told apart from a card
 * somebody actually deleted -- so the two would produce the same error and the
 * client could not tell a conflict from a deletion.
 */
describe('the per-card optimistic lock', () => {
  let harness: Harness;
  let owner: TestUser;
  let board: TestBoard;
  let card: Card;

  beforeAll(async () => {
    harness = await boot();
    owner = await createUser(harness.prisma, 'editor');
    board = await createBoard(harness, owner, ['Todo', 'Doing']);

    const created = await harness.http
      .post(`/boards/${board.id}/cards`)
      .set('Authorization', owner.auth)
      .send({ listId: board.lists[0]!.id, title: 'Contended card' })
      .expect(201);
    card = created.body as Card;
  });

  afterAll(async () => {
    await cleanUp(harness.prisma, [owner]);
    await harness.close();
  });

  it('lets exactly one of two simultaneous edits win', async () => {
    // Both sent with the same `expectedVersion`, both in flight at once. This is
    // two people who opened the card at the same moment.
    const [left, right] = await Promise.all([
      harness.http
        .patch(`/boards/${board.id}/cards/${card.id}`)
        .set('Authorization', owner.auth)
        .send({ expectedVersion: card.version, title: 'Left wins' }),
      harness.http
        .patch(`/boards/${board.id}/cards/${card.id}`)
        .set('Authorization', owner.auth)
        .send({ expectedVersion: card.version, title: 'Right wins' }),
    ]);

    const statuses = [left.status, right.status].sort();
    // 409 is the HTTP shape of `STALE`. Both succeeding is the bug this exists
    // for: a lost update with nothing anywhere to notice it.
    expect(statuses, `got ${statuses.join(' and ')}`).toEqual([200, 409]);

    const winner = left.status === 200 ? left : right;
    const list = await readList(harness, board, owner, board.lists[0]!.id);
    const stored = list.cards.find((entry) => entry.id === card.id);

    expect(stored?.title).toBe((winner.body as Card).title);
    // Exactly one increment, not two. A version that moved twice would mean both
    // writes landed and one silently overwrote the other.
    expect(stored?.version).toBe(card.version + 1);
  });

  it('refuses a stale move with STALE rather than moving the card anyway', async () => {
    const list = await readList(harness, board, owner, board.lists[0]!.id);
    const current = list.cards.find((entry) => entry.id === card.id)!;

    const response = await harness.http
      .patch(`/boards/${board.id}/cards/${current.id}/move`)
      .set('Authorization', owner.auth)
      .send({
        // One behind. This is a client whose view of the card predates somebody
        // else's edit.
        expectedVersion: current.version - 1,
        toListId: board.lists[1]!.id,
        afterCardId: null,
        beforeCardId: null,
      })
      .expect(409);

    expect(JSON.stringify(response.body)).toMatch(/changed/i);

    // And it did not move. A refusal that still wrote would be worse than no
    // check at all, because the client would have been told to refetch.
    const after = await readList(harness, board, owner, board.lists[0]!.id);
    expect(after.cards.map((entry) => entry.id)).toContain(current.id);
  });

  it('distinguishes a conflict from a card that is gone', async () => {
    // The reason the repository uses `updateMany` and a count rather than
    // `update` and a P2025: a thrown "record not found" would make these two
    // indistinguishable, and the client's correct response differs -- refetch the
    // card, or resync the whole board.
    const gone = await harness.http
      .patch(`/boards/${board.id}/cards/clx000000000000000000/move`)
      .set('Authorization', owner.auth)
      .send({
        expectedVersion: 0,
        toListId: board.lists[1]!.id,
        afterCardId: null,
        beforeCardId: null,
      });

    expect(gone.status).toBe(404);
  });

  it('increments the version on every write, so the lock cannot be reused', async () => {
    const before = (await readList(harness, board, owner, board.lists[0]!.id)).cards.find(
      (entry) => entry.id === card.id,
    )!;

    await harness.http
      .patch(`/boards/${board.id}/cards/${card.id}`)
      .set('Authorization', owner.auth)
      .send({ expectedVersion: before.version, title: 'Bumped' })
      .expect(200);

    // The same version a second time must now fail. A version that did not move
    // would let one stale client keep writing forever.
    await harness.http
      .patch(`/boards/${board.id}/cards/${card.id}`)
      .set('Authorization', owner.auth)
      .send({ expectedVersion: before.version, title: 'Bumped again' })
      .expect(409);
  });
});
