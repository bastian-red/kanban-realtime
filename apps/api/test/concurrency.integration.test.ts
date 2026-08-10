import { CARD_POSITION_UNIQUE } from '@kan/db';
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
 * The concurrency proof.
 *
 * This is the property the whole project exists for, and it cannot be proven
 * anywhere else. The gate lane runs `moveCard` against `MemoryRepository`, which
 * is a JavaScript object: it can be made to *simulate* a collision (and is,
 * deterministically, via `collideOnce`), but it cannot refuse a duplicate the way
 * a unique index does, and it has no row locks. What is under test here is
 * Postgres's behaviour and the retry loop's response to it.
 *
 * The mechanism has three parts and they fail differently:
 *
 *   1. `services/ordering` generates a **jittered** key, so two clients naming
 *      the same two neighbours usually get different keys and both land.
 *   2. When the jitter collides anyway, `UNIQUE (list_id, position)` refuses the
 *      second write and `moveCard` re-jitters, up to `MOVE_RETRY_ATTEMPTS`.
 *   3. `SELECT ... FOR UPDATE` on the destination serialises the reads, so the
 *      `reconciled` flag is computed against a stable view.
 *
 * Without (2)'s unique index the collision is not an error anywhere: two cards
 * silently share a position and the column's order becomes whatever the planner
 * returned. That is the failure this file is really about -- wrong everywhere and
 * an error nowhere -- so the index's existence is asserted directly as well.
 */
describe('twenty simultaneous moves into one gap', () => {
  let harness: Harness;
  let owner: TestUser;
  let board: TestBoard;
  let cards: Card[];

  const CARD_COUNT = 20;

  beforeAll(async () => {
    harness = await boot();
    owner = await createUser(harness.prisma, 'racer');
    board = await createBoard(harness, owner, ['Source', 'Target']);

    // Twenty cards in the source column, and two in the target so there is a real
    // gap between two neighbours to compete for -- an empty column has no gap and
    // every key would be generated against `null, null`, which is a different
    // (easier) case.
    for (let index = 0; index < CARD_COUNT; index += 1) {
      await harness.http
        .post(`/boards/${board.id}/cards`)
        .set('Authorization', owner.auth)
        .send({ listId: board.lists[0]!.id, title: `Card ${index}` })
        .expect(201);
    }
    for (const title of ['Anchor top', 'Anchor bottom']) {
      await harness.http
        .post(`/boards/${board.id}/cards`)
        .set('Authorization', owner.auth)
        .send({ listId: board.lists[1]!.id, title })
        .expect(201);
    }

    cards = (await readList(harness, board, owner, board.lists[0]!.id)).cards;
    expect(cards).toHaveLength(CARD_COUNT);
  });

  afterAll(async () => {
    await cleanUp(harness.prisma, [owner]);
    await harness.close();
  });

  it('lands every card, on a distinct position, with nothing lost', async () => {
    const target = await readList(harness, board, owner, board.lists[1]!.id);
    const [top, bottom] = target.cards;

    // All twenty fired before any is awaited. `Promise.all` over already-started
    // requests is what makes them simultaneous; a `for await` loop would test
    // twenty sequential moves, which is not a race and would pass without any of
    // the mechanism above.
    const responses = await Promise.all(
      cards.map((card) =>
        harness.http
          .patch(`/boards/${board.id}/cards/${card.id}/move`)
          .set('Authorization', owner.auth)
          .send({
            expectedVersion: card.version,
            toListId: board.lists[1]!.id,
            afterCardId: top!.id,
            beforeCardId: bottom!.id,
          }),
      ),
    );

    const refused = responses.filter((response) => response.status !== 200);
    expect(
      refused.map((response) => `${response.status} ${JSON.stringify(response.body)}`),
      'every move into a contended gap must succeed; a refusal means the retry ceiling was hit',
    ).toEqual([]);

    const after = await readList(harness, board, owner, board.lists[1]!.id);

    // Nothing lost: the two anchors plus every card that moved.
    expect(after.cards).toHaveLength(CARD_COUNT + 2);

    // Every position distinct. This is what the unique index buys, and without it
    // this assertion is the only thing that would ever notice.
    const positions = after.cards.map((card) => card.position);
    expect(new Set(positions).size, `duplicate positions: ${positions.join(', ')}`).toBe(
      positions.length,
    );

    // And the order is total: what the API returned is what sorting the positions
    // as bytes produces. Postgres's C collation and `sortByPosition` have to agree
    // with each other, or the server and the client render different boards.
    const sorted = [...positions].sort();
    expect(positions).toEqual(sorted);

    // Every card landed strictly between the two anchors, which is where they
    // were all told to go.
    const ids = after.cards.map((card) => card.id);
    expect(ids[0]).toBe(top!.id);
    expect(ids.at(-1)).toBe(bottom!.id);

    // The source column is empty, so no card was quietly left behind by a move
    // that reported success.
    const source = await readList(harness, board, owner, board.lists[0]!.id);
    expect(source.cards).toEqual([]);
  });

  it('has the unique index the retry loop depends on', async () => {
    // Asserted directly, because its absence is silent. Every test above would
    // still pass with the index dropped -- the duplicate-position check would be
    // the only one to fail, and only if the jitter happened to collide during that
    // run, which is a coin flip weighted about 47,000 to 1 against.
    const rows = await harness.prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'cards' AND indexname = ${CARD_POSITION_UNIQUE}
    `;
    expect(rows, `${CARD_POSITION_UNIQUE} is missing from the cards table`).toHaveLength(1);
  });

  it('refuses a duplicate position outright, rather than accepting two', async () => {
    // The index doing its job, observed. A board-ops call cannot produce this --
    // it re-jitters and succeeds -- so the write is made underneath it.
    const list = await readList(harness, board, owner, board.lists[1]!.id);
    const [first, second] = list.cards;

    await expect(
      harness.prisma.card.update({
        where: { id: second!.id },
        data: { position: first!.position },
      }),
    ).rejects.toThrow();
  });
});
