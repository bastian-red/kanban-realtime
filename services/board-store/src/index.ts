/**
 * The Prisma adapter for `services/board-ops`'s repository port.
 *
 * It lives in its own package rather than inside `apps/api` because **two
 * processes need it**. The REST API and the Socket.io gateway both call
 * `moveCard` directly -- the gateway does not forward to the API, so a drag costs
 * one hop instead of two -- and an adapter that lived inside one app would have to
 * be reached into by the other, or copied. Copied is the real risk: the row lock,
 * the conditional update and the raw-column mapping below are exactly the three
 * things that would drift, and each of them drifting means the two transports
 * disagree about a write while both of their test suites stay green.
 *
 * Everything interesting about a move lives in `board-ops`; this file is the part
 * that cannot be tested without a database, and it is deliberately kept to that.
 * Two things in it are not mechanical, and both are the reason the port has the
 * shape it does.
 *
 * **`SELECT ... FOR UPDATE`.** Prisma has no way to express a row lock through
 * the typed client, so `listCards({ forUpdate: true })` drops to `$queryRaw`. The
 * lock serialises two concurrent moves into the same list, so the second reads
 * the list as the first left it.
 *
 * How much that matters was measured rather than assumed, and the measurement
 * corrected the assumption. Removing the lock entirely and firing 50 simultaneous
 * moves into one gap (with a 60-connection pool, so they really are simultaneous)
 * still produced 50 successes, 50 distinct keys and zero retries. The reason is
 * arithmetic: `fractional-indexing-jittered` picks from a jitter range of
 * `floor(62^3 / 5)` = 47,665 values, so the expected number of collisions among
 * 50 writers in one gap is C(50,2)/47665 ~= 0.026. The jitter is doing the work;
 * the lock is not what makes concurrent drags safe.
 *
 * The lock is kept for the two things it *is* load-bearing for, neither of which
 * is key collision: the `reconciled` flag (whether the client's two neighbours
 * are still adjacent) is only meaningful against a stable read, and any future
 * check that counts the destination's cards -- a WIP limit enforced on the server
 * rather than displayed -- is a read-modify-write that races without it.
 *
 * The consequence for testing is the important part. A real collision is rare by
 * construction, so a test that waited for one would be a test that passes for the
 * wrong reason nearly every run. The retry path is therefore exercised
 * deterministically in the gate lane, by `MemoryRepository`'s `collideOnce` and
 * `collideAlways`, and the integration lane asserts the property that actually
 * matters at scale: N simultaneous moves, N distinct positions, no card lost.
 *
 * **The conditional update.** `moveCard` and `updateCard` write with
 * `WHERE version = $expected` and report a miss as `null`. `updateMany` is what
 * makes that possible in Prisma -- `update` throws `P2025` when its `where`
 * matches nothing, and a thrown "record not found" cannot be told apart from a
 * genuinely deleted card. `updateMany` returns a count, and a count of zero is
 * exactly "somebody else got there first".
 */
import type { ActivityRow, BoardRepository, BoardTx, MemberRow, NewActivity } from '@kan/board-ops';
import type { BoardRole, Prisma, PrismaClient } from '@kan/db';

import { toCardRow, toListRow, type RawCard, type RawList } from './rows';

export * from './rows';
export * from './read';

/** The transaction handle Prisma hands to the callback of `$transaction`. */
type Tx = Prisma.TransactionClient;

export interface BoardStoreOptions {
  /**
   * The activity rows a transaction appended, handed over **after it committed**.
   *
   * This exists so a write can be broadcast live without `services/board-ops`
   * knowing that broadcasts exist. Every operation there appends an activity row
   * inside its transaction and returns only the card or list it changed, which is
   * the right shape for a domain layer -- but it leaves the caller with no way to
   * emit "Ana moved Fix login to Doing" except by re-reading the feed after every
   * drag.
   *
   * The timing is the whole point, and it is why this is on the adapter rather
   * than on `BoardTx`. A hook fired from inside `appendActivity` would announce
   * writes that then roll back: `moveCard`'s retry loop discards a whole
   * transaction on a position collision and runs it again, so a per-append hook
   * would broadcast the losing attempt and then broadcast the winning one, and
   * every reader would see the card move twice. `$transaction` resolving is the
   * commit, and only then does this fire.
   *
   * It must not throw. A broadcast failure cannot be allowed to fail a write that
   * is already durable, so anything thrown here is caught and dropped.
   */
  onActivity?: (rows: readonly ActivityRow[]) => void;
}

/**
 * The Prisma-backed repository.
 *
 * The constructor takes `PrismaClient` itself rather than a hand-written
 * interface: the point is to accept `apps/api`'s `PrismaService` (which extends
 * it) and `apps/realtime`'s bare client without either of them knowing about the
 * other.
 */
export class PrismaBoardRepository implements BoardRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: BoardStoreOptions = {},
  ) {}

  async memberRole(boardId: string, userId: string): Promise<BoardRole | null> {
    const membership = await this.prisma.boardMember.findUnique({
      where: { boardId_userId: { boardId, userId } },
      select: { role: true },
    });
    return membership?.role ?? null;
  }

  async members(boardId: string): Promise<MemberRow[]> {
    const rows = await this.prisma.boardMember.findMany({
      where: { boardId },
      select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      orderBy: { user: { name: 'asc' } },
    });
    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      name: row.user.name,
      email: row.user.email,
    }));
  }

  async withTransaction<T>(work: (tx: BoardTx) => Promise<T>): Promise<T> {
    // Collected per call, not per instance. `moveCard` runs this whole method
    // again on a position collision, and the discarded attempt's rows have to be
    // discarded with it -- a shared buffer would replay the losing attempt's
    // activity alongside the winning one.
    const appended: ActivityRow[] = [];

    const result = await this.prisma.$transaction(async (tx) => work(wrap(tx, appended)), {
      // A move takes a row lock and does three statements. Five seconds is far
      // more than it needs and far less than the default 5s wait + 5s timeout
      // would let a pathological case hold the lock for. The point of naming it
      // is that a move which cannot get its lock fails as a timeout somebody can
      // read, rather than piling up connections.
      timeout: 5_000,
      maxWait: 5_000,
    });

    // Reached only when `$transaction` resolved, which is the commit.
    if (appended.length > 0 && this.options.onActivity) {
      try {
        this.options.onActivity(appended);
      } catch {
        // Deliberately swallowed. The rows are durable; a listener that throws
        // must not turn a committed move into a failed request the caller is
        // invited to retry.
      }
    }

    return result;
  }
}

function wrap(tx: Tx, appended: ActivityRow[]): BoardTx {
  return {
    async findCard(cardId) {
      return tx.card.findUnique({ where: { id: cardId } });
    },

    async findList(listId) {
      return tx.list.findUnique({ where: { id: listId } });
    },

    async listCards(listId, options) {
      if (!options?.forUpdate) {
        return tx.card.findMany({ where: { listId }, orderBy: { position: 'asc' } });
      }
      /**
       * The row lock. `$queryRaw` because Prisma cannot express `FOR UPDATE`.
       *
       * The tagged template is parameterised -- `${listId}` becomes a bind
       * parameter, not string concatenation -- so this is not an injection site.
       * Column names are quoted and snake_cased because raw SQL bypasses Prisma's
       * `@map`, and the result is cast back through `toCardRow` rather than
       * trusted, because a raw query returns whatever the database calls the
       * columns.
       */
      const rows = await tx.$queryRaw<RawCard[]>`
        SELECT id, list_id, title, description, position, version,
               due_on, assignee_id, archived_at, created_at, updated_at
        FROM cards
        WHERE list_id = ${listId}
        ORDER BY position ASC
        FOR UPDATE
      `;
      return rows.map(toCardRow);
    },

    async listLists(boardId, options) {
      if (!options?.forUpdate) {
        return tx.list.findMany({ where: { boardId }, orderBy: { position: 'asc' } });
      }
      const rows = await tx.$queryRaw<RawList[]>`
        SELECT id, board_id, name, position, wip_limit, archived_at
        FROM lists
        WHERE board_id = ${boardId}
        ORDER BY position ASC
        FOR UPDATE
      `;
      return rows.map(toListRow);
    },

    async moveCard({ cardId, expectedVersion, toListId, position }) {
      // updateMany, not update: `update` throws P2025 when the where clause
      // matches nothing, and a thrown "not found" cannot be told apart from a
      // card somebody actually deleted. A count of zero is unambiguous.
      const result = await tx.card.updateMany({
        where: { id: cardId, version: expectedVersion },
        data: { listId: toListId, position, version: { increment: 1 } },
      });
      if (result.count === 0) return null;
      return tx.card.findUnique({ where: { id: cardId } });
    },

    async updateCard({ cardId, expectedVersion, title, description, dueOn, assigneeId }) {
      const data: Prisma.CardUpdateManyMutationInput = { version: { increment: 1 } };
      // Each field is applied only when the caller sent it. `undefined` means
      // "not part of this edit" and `null` means "clear it", and collapsing the
      // two would make every partial update wipe the fields it did not mention.
      if (title !== undefined) data.title = title;
      if (description !== undefined) data.description = description;
      if (dueOn !== undefined) data.dueOn = dueOn;

      const result = await tx.card.updateMany({
        where: { id: cardId, version: expectedVersion },
        // assigneeId is a relation scalar, so it goes through the unchecked input
        // rather than the mutation input above.
        data: assigneeId === undefined ? data : { ...data, assigneeId },
      });
      if (result.count === 0) return null;
      return tx.card.findUnique({ where: { id: cardId } });
    },

    async insertCard({ listId, title, position, description, dueOn, assigneeId }) {
      return tx.card.create({
        data: {
          listId,
          title,
          position,
          // `?? null` rather than a conditional spread, because the columns are
          // nullable with no default: "the caller said nothing" and "the caller
          // said empty" are the same new card.
          description: description ?? null,
          dueOn: dueOn ?? null,
          assigneeId: assigneeId ?? null,
        },
      });
    },

    async listLabels(boardId) {
      return tx.label.findMany({
        where: { boardId },
        select: { id: true, boardId: true, name: true, colorSlot: true },
        orderBy: { name: 'asc' },
      });
    },

    async cardLabels(cardId) {
      const rows = await tx.cardLabel.findMany({
        where: { cardId },
        select: { label: { select: { id: true, boardId: true, name: true, colorSlot: true } } },
      });
      return rows.map((row) => row.label);
    },

    /**
     * Replace the set: delete what is there, insert what was asked for.
     *
     * Delete-then-insert rather than a diff. The set is at most eight rows
     * (`labelIds` is `.max(8)`), so computing the difference saves one statement
     * and costs a branch that can be wrong; and both statements are inside the
     * caller's transaction, so no reader ever sees the empty moment between them.
     *
     * `createMany` with no `skipDuplicates`: the caller has already collapsed
     * duplicates, and leaving the flag off means a genuine double-insert surfaces
     * as a unique violation instead of being swallowed.
     */
    async setCardLabels(cardId, labelIds) {
      await tx.cardLabel.deleteMany({ where: { cardId } });
      if (labelIds.length === 0) return;
      await tx.cardLabel.createMany({
        data: labelIds.map((labelId) => ({ cardId, labelId })),
      });
    },

    async archiveCard({ cardId, expectedVersion }) {
      const result = await tx.card.updateMany({
        where: { id: cardId, version: expectedVersion },
        data: { archivedAt: new Date(), version: { increment: 1 } },
      });
      if (result.count === 0) return null;
      return tx.card.findUnique({ where: { id: cardId } });
    },

    async insertList({ boardId, name, position, wipLimit }) {
      return tx.list.create({ data: { boardId, name, position, wipLimit } });
    },

    async updateList({ listId, name, wipLimit }) {
      const data: Prisma.ListUpdateInput = {};
      if (name !== undefined) data.name = name;
      if (wipLimit !== undefined) data.wipLimit = wipLimit;
      return tx.list.update({ where: { id: listId }, data });
    },

    async moveList({ listId, position }) {
      return tx.list.update({ where: { id: listId }, data: { position } });
    },

    async archiveList(listId) {
      return tx.list.update({ where: { id: listId }, data: { archivedAt: new Date() } });
    },

    async appendActivity(activity: NewActivity): Promise<ActivityRow> {
      const row = await tx.activity.create({ data: activity });
      // Buffered, not announced. See `BoardStoreOptions.onActivity`: this
      // statement is inside a transaction that may still roll back.
      appended.push(row);
      return row;
    },
  };
}
