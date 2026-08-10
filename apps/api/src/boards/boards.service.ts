/**
 * The read path, and the thin shell around the write path.
 *
 * Writes are not implemented here: they are `services/board-ops`, called with the
 * repository this module provides. That is the point of the whole arrangement --
 * `apps/realtime` calls the same functions with the same repository, so a drag
 * that arrives over a socket and a drag that arrives over HTTP execute the same
 * code, take the same lock, and enforce the same permission. Duplicating even the
 * permission check here would be one more place for the two transports to
 * disagree.
 *
 * The board read is not here either, for the same reason: `board.join` answers
 * with the same payload `GET /boards/:id` returns, so `readBoard` lives in
 * `@kan/board-store` and both processes call it. What is left in this file is the
 * queries only the REST surface has -- the boards list and the activity feed --
 * and the broadcasts every write owes to whoever has the board open.
 */
import {
  archiveCard as archiveCardOp,
  archiveList as archiveListOp,
  createCard as createCardOp,
  createList as createListOp,
  moveCard as moveCardOp,
  moveList as moveListOp,
  updateCard as updateCardOp,
  updateList as updateListOp,
} from '@kan/board-ops';
import type { ActivityRow, ListRow } from '@kan/board-ops';
import {
  hydrateCard,
  PrismaBoardRepository,
  readBoard,
  toActivity,
  toContractType,
} from '@kan/board-store';
import type {
  Activity,
  ActivityPage,
  Board,
  BoardRole,
  BoardSummary,
  Card,
  Member,
} from '@kan/shared';
import { can, initialsOf, toListHeader } from '@kan/shared';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { TokenUser } from '../common/service-token.guard';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEmitter } from '../realtime/realtime.emitter';

@Injectable()
export class BoardsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PrismaBoardRepository) private readonly repository: PrismaBoardRepository,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(RealtimeEmitter) private readonly realtime: RealtimeEmitter,
  ) {}

  /** Every board this person is a member of. Not every board. */
  async listBoards(userId: string): Promise<BoardSummary[]> {
    const memberships = await this.prisma.boardMember.findMany({
      where: { userId },
      select: {
        role: true,
        board: {
          select: {
            id: true,
            name: true,
            updatedAt: true,
            _count: { select: { members: true } },
            // Archived cards are excluded as well as archived lists. Filtering
            // only the list leaves a card that was archived individually counted
            // forever, so the summary disagrees with the board the person then
            // opens -- and the board view filters `archivedAt: null` at both
            // levels. Two different definitions of "how many cards" is the bug.
            lists: {
              where: { archivedAt: null },
              select: { _count: { select: { cards: { where: { archivedAt: null } } } } },
            },
          },
        },
      },
      orderBy: { board: { updatedAt: 'desc' } },
    });

    return memberships.map((membership) => ({
      id: membership.board.id,
      name: membership.board.name,
      role: membership.role,
      memberCount: membership.board._count.members,
      cardCount: membership.board.lists.reduce((total, list) => total + list._count.cards, 0),
      updatedAt: membership.board.updatedAt.toISOString(),
    }));
  }

  /**
   * A whole board in one query.
   *
   * One round trip with nested selects rather than a query per list. A board with
   * twelve columns is twelve extra round trips otherwise, on the one request that
   * decides how fast the app feels, and the ordering has to be right in every one
   * of them.
   *
   * `orderBy: position` at both levels, ascending, byte order. Postgres compares
   * these with the C collation and `services/ordering`'s `sortByPosition` uses
   * plain `<`, so all three agree. A `localeCompare` anywhere in that chain would
   * make the server and the client render different orders for the same data.
   */
  async getBoard(boardId: string, userId: string): Promise<Board> {
    // The query itself is `@kan/board-store`, because the gateway answers
    // `board.join` with this same payload. Two copies of it were two chances to
    // order a column differently or format a due date differently, and the only
    // symptom would be one browser tab disagreeing with another.
    //
    // 404, not 403, for a board they are not a member of: `readBoard` collapses
    // "no such board" and "not a member" into one null for exactly that reason. A
    // 403 confirms the board exists, which turns id enumeration into a membership
    // oracle.
    const board = await readBoard(this.prisma, boardId, userId);
    if (!board) throw new NotFoundException('That board does not exist.');
    return board;
  }

  async createBoard(userId: string, name: string): Promise<BoardSummary> {
    // The board and its OWNER membership in one transaction. A board with no
    // owner is unreachable -- there is no `owner_id` column, the owner IS the
    // membership -- so the two must not be separable.
    const board = await this.prisma.$transaction(async (tx) => {
      const created = await tx.board.create({
        data: { name, members: { create: { userId, role: 'OWNER' } } },
      });
      await tx.activity.create({
        data: { boardId: created.id, actorId: userId, type: 'BOARD_CREATED', subject: name },
      });
      return created;
    });

    return {
      id: board.id,
      name: board.name,
      role: 'OWNER',
      memberCount: 1,
      cardCount: 0,
      updatedAt: board.updatedAt.toISOString(),
    };
  }

  /**
   * `role: 'OWNER'` below is not an assumption. `board.rename` is an owner-only
   * operation in the matrix (`packages/shared/src/roles.ts`), so `require` has
   * already refused every other role by the time the write happens. If the matrix
   * ever grants rename to an editor, this returns the wrong role -- which is why
   * the test asserts the two agree rather than trusting this comment.
   */
  async renameBoard(boardId: string, actor: TokenUser, name: string): Promise<BoardSummary> {
    await this.require(boardId, actor.id, 'board.rename');
    const { board, activity } = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.board.update({ where: { id: boardId }, data: { name } });
      const row = await tx.activity.create({
        data: { boardId, actorId: actor.id, type: 'BOARD_RENAMED', subject: name },
      });
      return { board: updated, activity: row };
    });

    // Renaming happens on the boards list, where the renamer has no socket open,
    // so this is the one broadcast that only ever originates in the API. Anybody
    // with the board open sees the new title without reloading.
    this.realtime.boardRenamed(boardId, board.name);
    this.realtime.activityAppended(boardId, toActivity(activity, actor.name));

    // Both counts, read the same way `listBoards` reads them. This returned
    // `cardCount: 0` unconditionally, so renaming a board with forty cards
    // answered "0" and any client that trusted the response redrew an empty
    // summary until the next full refetch.
    const [memberCount, cardCount] = await Promise.all([
      this.prisma.boardMember.count({ where: { boardId } }),
      this.prisma.card.count({
        where: { archivedAt: null, list: { boardId, archivedAt: null } },
      }),
    ]);

    return {
      id: board.id,
      name: board.name,
      role: 'OWNER',
      memberCount,
      cardCount,
      updatedAt: board.updatedAt.toISOString(),
    };
  }

  async members(boardId: string, userId: string): Promise<Member[]> {
    await this.require(boardId, userId, 'board.read');
    const rows = await this.repository.members(boardId);
    return rows.map((row) => ({ ...row, initials: initialsOf(row.name) }));
  }

  async addMember(
    boardId: string,
    actor: TokenUser,
    email: string,
    role: 'OWNER' | 'EDITOR' | 'VIEWER',
  ): Promise<Member[]> {
    const actorId = actor.id;
    await this.require(boardId, actorId, 'board.manageMembers');
    if (role === 'OWNER') {
      // The partial unique index would refuse this anyway, as a 23505 the caller
      // would have to decode. Refusing here says what the product actually means:
      // ownership is transferred, not granted alongside.
      throw new ForbiddenException(
        'A board has exactly one owner. Transfer ownership rather than adding a second.',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) throw new NotFoundException('Nobody with that email has an account.');

    const activity = await this.prisma.$transaction(async (tx) => {
      await tx.boardMember.upsert({
        where: { boardId_userId: { boardId, userId: user.id } },
        // An upsert rather than a create: adding somebody who is already a member
        // with a different role is what "change their role" looks like from the
        // outside, and refusing it with a 409 helps nobody.
        create: { boardId, userId: user.id, role },
        update: { role },
      });
      return tx.activity.create({
        data: { boardId, actorId, type: 'MEMBER_ADDED', subject: email, detail: role },
      });
    });

    return this.announceMembers(boardId, actor, activity);
  }

  /**
   * Change a member's role.
   *
   * Separate from `addMember` despite the upsert there also being able to do it,
   * because this one has to refuse a case that one cannot reach: demoting the
   * owner. `board_members_one_owner_per_board` guarantees there is exactly one
   * OWNER row, so demoting it would leave the board with none -- and there is no
   * `owner_id` column to fall back on, so the board would be permanently
   * unmanageable by anyone.
   */
  async updateMemberRole(
    boardId: string,
    actor: TokenUser,
    userId: string,
    role: BoardRole,
  ): Promise<Member[]> {
    const actorId = actor.id;
    await this.require(boardId, actorId, 'board.manageMembers');

    const existing = await this.prisma.boardMember.findUnique({
      where: { boardId_userId: { boardId, userId } },
      select: { role: true, user: { select: { email: true } } },
    });
    if (!existing) throw new NotFoundException('That person is not a member of this board.');

    if (existing.role === 'OWNER') {
      throw new ForbiddenException(
        'The owner’s role cannot be changed. Transfer ownership instead.',
      );
    }
    if (role === 'OWNER') {
      throw new ForbiddenException(
        'A board has exactly one owner. Transfer ownership rather than adding a second.',
      );
    }
    if (existing.role === role) return this.members(boardId, actorId);

    const activity = await this.prisma.$transaction(async (tx) => {
      await tx.boardMember.update({
        where: { boardId_userId: { boardId, userId } },
        data: { role },
      });
      return tx.activity.create({
        data: {
          boardId,
          actorId,
          type: 'MEMBER_ROLE_CHANGED',
          subject: existing.user.email,
          detail: `${existing.role} to ${role}`,
        },
      });
    });

    return this.announceMembers(boardId, actor, activity);
  }

  /**
   * Remove a member.
   *
   * The owner is refused for the same reason as above. Removing yourself is
   * allowed for everyone else: "leave this board" is a real thing to want, and
   * routing it through a separate endpoint would duplicate this check.
   */
  async removeMember(boardId: string, actor: TokenUser, userId: string): Promise<Member[]> {
    const actorId = actor.id;
    await this.require(boardId, actorId, 'board.manageMembers');

    const existing = await this.prisma.boardMember.findUnique({
      where: { boardId_userId: { boardId, userId } },
      select: { role: true, user: { select: { email: true } } },
    });
    if (!existing) throw new NotFoundException('That person is not a member of this board.');
    if (existing.role === 'OWNER') {
      throw new ForbiddenException('The owner cannot be removed from their own board.');
    }

    const activity = await this.prisma.$transaction(async (tx) => {
      await tx.boardMember.delete({ where: { boardId_userId: { boardId, userId } } });
      return tx.activity.create({
        data: {
          boardId,
          actorId,
          type: 'MEMBER_REMOVED',
          subject: existing.user.email,
          detail: existing.role,
        },
      });
    });

    return this.announceMembers(boardId, actor, activity);
  }

  /**
   * The roster, broadcast and returned.
   *
   * All three membership writes end here rather than each doing their own emit,
   * because the event is the same one -- `member.changed` carries the whole
   * roster, not a delta -- and a client that missed one delta while backgrounded
   * would otherwise show a ghost member forever.
   *
   * The read happens after the commit, so the roster it broadcasts is the roster
   * the database has, not the one this method believes it wrote.
   */
  private async announceMembers(
    boardId: string,
    actor: TokenUser,
    activity: ActivityRow,
  ): Promise<Member[]> {
    const members = await this.members(boardId, actor.id);
    this.realtime.memberChanged(boardId, members);
    this.realtime.activityAppended(boardId, toActivity(activity, actor.name));
    return members;
  }

  /**
   * Delete a board and everything under it.
   *
   * A hard delete, unlike a card or a list, which are archived. The distinction is
   * the product's: an archived card is meant to be findable again, and a deleted
   * board is meant to be gone. The cascade in the schema removes the lists, cards,
   * labels, memberships and activity rows with it.
   *
   * `activities.actor_id` is `onDelete: Restrict`, but that protects the *user*
   * row, not this: the activity rows go because their `board_id` cascades, and
   * the actors themselves are untouched.
   */
  async deleteBoard(boardId: string, userId: string): Promise<{ id: string }> {
    await this.require(boardId, userId, 'board.delete');
    await this.prisma.board.delete({ where: { id: boardId } });
    return { id: boardId };
  }

  /**
   * The activity feed, newest first, paginated by a keyset cursor.
   *
   * The cursor is `(createdAt, id)` and not `createdAt` alone. Two rows written in
   * one transaction share a timestamp to microsecond precision -- a move writes
   * one and a create writes another in the same millisecond routinely -- and a
   * cursor on the timestamp alone either repeats a row or skips one at every page
   * boundary. The composite index in the invariants migration exists to make this
   * ordering an index scan.
   */
  async activity(
    boardId: string,
    userId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ActivityPage> {
    await this.require(boardId, userId, 'activity.read');
    const take = Math.min(limit ?? this.config.activityPageSize, 100);
    const decoded = decodeCursor(cursor);

    const rows = await this.prisma.activity.findMany({
      where: {
        boardId,
        ...(decoded
          ? {
              OR: [
                { createdAt: { lt: decoded.createdAt } },
                { createdAt: decoded.createdAt, id: { lt: decoded.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than asked for, so "is there another page" is a fact rather than
      // a guess. Returning a cursor when the next page is empty makes the client
      // render a "load more" that does nothing.
      take: take + 1,
      select: {
        id: true,
        boardId: true,
        type: true,
        subject: true,
        detail: true,
        createdAt: true,
        actorId: true,
        actor: { select: { name: true } },
      },
    });

    const page = rows.slice(0, take);
    const last = page.at(-1);

    return {
      items: page.map((row): Activity => ({
        id: row.id,
        boardId: row.boardId,
        // The database enum is SCREAMING_SNAKE and the contract is dotted
        // lowercase, because the contract is also the socket event vocabulary.
        // Converted at this one boundary rather than stored twice.
        type: toContractType(row.type),
        actorId: row.actorId,
        actorName: row.actor.name,
        subject: row.subject,
        detail: row.detail,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  // --- The write path, delegated in full -----------------------------------

  /**
   * A repository whose committed activity rows are broadcast as they land.
   *
   * A fresh instance per write, not the injected singleton, and the reason is
   * `actor.name`. The activity feed's live line is "Ana moved Fix login to
   * Doing", and the actor's name is the one part of that sentence the writing
   * transaction does not have -- `ActivityRow` carries `actor_id` and nothing
   * else. Closing over the caller's token here means no join on the hot path of
   * every drag; a singleton hook would have to look the name up per event, in
   * both this process and the gateway.
   *
   * The instance is a wrapper over the shared `PrismaService`, holding no
   * connection and no state, so building one per request costs an object.
   */
  private storeFor(boardId: string, actor: TokenUser): PrismaBoardRepository {
    return new PrismaBoardRepository(this.prisma, {
      onActivity: (rows) => {
        for (const row of rows) {
          this.realtime.activityAppended(boardId, toActivity(row, actor.name));
        }
      },
    });
  }

  /**
   * Every card-returning write goes through `hydrate`, and that is not tidiness.
   *
   * `services/board-ops` returns a `CardRow`: the database row, with `dueOn` as a
   * `Date` and no labels, because the domain layer does not know or care what the
   * wire looks like. Returning that row directly produced a response that did not
   * satisfy `cardSchema` -- `dueOn` came out as `2026-09-01T00:00:00.000Z` where
   * the contract says `2026-09-01`, and `labels` was absent entirely.
   *
   * That was invisible over REST for as long as nobody validated the response,
   * and it would not have stayed invisible: the client applies a move
   * optimistically and reconciles against the ack, and the gateway broadcasts the
   * same object to everybody else. A payload that fails `cardSchema.parse` at
   * that moment either throws in the reconcile path or gets waved through with a
   * cast, and the second is how a `Date` ends up rendered as an ISO string in a
   * due badge.
   *
   * One function, used by the read path and every write path, is what keeps the
   * two from drifting again.
   */
  createCard = async (actor: TokenUser, input: CardInput<typeof createCardOp>): Promise<Card> => {
    const card = await this.hydrate(
      await createCardOp(this.storeFor(input.boardId, actor), withActor(input, actor), {
        maxAttempts: this.config.moveRetryAttempts,
      }),
    );
    this.realtime.cardCreated(input.boardId, card);
    return card;
  };

  updateCard = async (actor: TokenUser, input: CardInput<typeof updateCardOp>): Promise<Card> => {
    const card = await this.hydrate(
      await updateCardOp(this.storeFor(input.boardId, actor), withActor(input, actor)),
    );
    this.realtime.cardUpdated(input.boardId, card);
    return card;
  };

  /**
   * The move keeps its envelope; only the card inside it is hydrated.
   *
   * `fromListId` and `reconciled` are not decoration. The receiving client has to
   * remove the card from where *it* thinks it is, which may not be where the
   * mover thought it was, and `reconciled` is how a client learns its optimistic
   * placement was computed against a stale view and must defer to the server's.
   * Returning a bare card would throw both away.
   */
  moveCard = async (
    actor: TokenUser,
    input: CardInput<typeof moveCardOp>,
  ): Promise<{ card: Card; fromListId: string; attempts: number; reconciled: boolean }> => {
    const result = await moveCardOp(this.storeFor(input.boardId, actor), withActor(input, actor), {
      maxAttempts: this.config.moveRetryAttempts,
    });
    const hydrated = { ...result, card: await this.hydrate(result.card) };
    this.realtime.cardMoved(input.boardId, hydrated);
    return hydrated;
  };

  archiveCard = async (actor: TokenUser, input: CardInput<typeof archiveCardOp>): Promise<Card> => {
    const card = await this.hydrate(
      await archiveCardOp(this.storeFor(input.boardId, actor), withActor(input, actor)),
    );
    this.realtime.cardArchived(input.boardId, card);
    return card;
  };

  /**
   * A domain row, as the wire shape.
   *
   * The label read is a second query rather than something threaded back through
   * `board-ops`, and that is deliberate: making every operation return its labels
   * would put a presentation concern into the port that `MemoryRepository` also
   * has to implement. It is one indexed lookup on `(card_id)` against a join
   * table with at most eight rows per card.
   */
  private hydrate = (row: Parameters<typeof hydrateCard>[1]): Promise<Card> =>
    hydrateCard(this.prisma, row);

  /**
   * The list writes broadcast a **header**, and the card count comes from a count
   * query rather than from the row.
   *
   * A `ListRow` has no cards on it, and the protocol's header carries `wip` --
   * the words "At limit 3/5" that the column renders. Guessing zero would tell
   * every other client that a renamed column had just emptied.
   */
  createList = async (
    actor: TokenUser,
    input: CardInput<typeof createListOp>,
  ): Promise<ListRow> => {
    const list = await createListOp(this.storeFor(input.boardId, actor), withActor(input, actor), {
      maxAttempts: this.config.moveRetryAttempts,
    });
    // A list that was just created has no cards. Counting would be a round trip
    // to learn a number the operation guarantees.
    this.realtime.listCreated(input.boardId, toListHeader(list, 0));
    return list;
  };

  updateList = async (
    actor: TokenUser,
    input: CardInput<typeof updateListOp>,
  ): Promise<ListRow> => {
    const list = await updateListOp(this.storeFor(input.boardId, actor), withActor(input, actor));
    this.realtime.listUpdated(input.boardId, toListHeader(list, await this.cardCount(list.id)));
    return list;
  };

  moveList = async (actor: TokenUser, input: CardInput<typeof moveListOp>): Promise<ListRow> => {
    const list = await moveListOp(this.storeFor(input.boardId, actor), withActor(input, actor), {
      maxAttempts: this.config.moveRetryAttempts,
    });
    this.realtime.listMoved(input.boardId, list);
    return list;
  };

  archiveList = async (
    actor: TokenUser,
    input: CardInput<typeof archiveListOp>,
  ): Promise<ListRow> => {
    const list = await archiveListOp(this.storeFor(input.boardId, actor), withActor(input, actor));
    this.realtime.listArchived(input.boardId, list.id);
    return list;
  };

  /** Live cards in a list, for the WIP words on a broadcast header. */
  private cardCount(listId: string): Promise<number> {
    return this.prisma.card.count({ where: { listId, archivedAt: null } });
  }

  private async require(
    boardId: string,
    userId: string,
    operation: Parameters<typeof can>[1],
  ): Promise<void> {
    const role = await this.repository.memberRole(boardId, userId);
    if (!can(role, operation)) {
      if (role === null) throw new NotFoundException('That board does not exist.');
      throw new ForbiddenException(`A ${role.toLowerCase()} may not do that on this board.`);
    }
  }
}

/**
 * The cursor: base64url of `<iso>|<id>`.
 *
 * Opaque on purpose. A cursor a client can construct is a cursor a client will
 * construct, and then the ordering it encodes becomes part of the contract and
 * cannot be changed. Base64url rather than base64 because it travels in a query
 * string and `+` there is a space.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  if (separator === -1) return null;
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  // A malformed cursor returns the first page rather than throwing. It is
  // attacker-controlled input on a read route, and a 500 from a hand-edited query
  // string is a worse outcome than starting over.
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

/**
 * A board-ops input with `actorId` supplied by the caller's token.
 *
 * The controllers used to build `actorId: user.id` into every input by hand, next
 * to a `@CurrentUser()` they already held. That is one more place a handler can
 * pass the wrong id -- and the id decides the permission check and the name on
 * every activity line, so the wrong one is not a cosmetic mistake. Taking the
 * whole token and filling the field here makes it impossible to get wrong and
 * impossible to forget.
 */
type CardInput<Op extends (repository: never, input: never, options?: never) => unknown> = Omit<
  Parameters<Op>[1],
  'actorId'
> & { boardId: string };

const withActor = <T extends { boardId: string }>(
  input: T,
  actor: TokenUser,
): T & { actorId: string } => ({ ...input, actorId: actor.id });
