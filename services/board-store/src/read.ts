/**
 * Reading a whole board, and turning a row into its wire shape.
 *
 * Both live here rather than in the REST API because **two processes serve a
 * board**. `GET /boards/:id` renders the first paint; `board.join` over the
 * socket answers with `board.state`, which is the same payload for the same
 * contract. When those were going to be two queries, they were two chances to
 * order a column differently, filter archived cards differently, or format a due
 * date differently -- and a reader would only notice by having one browser tab
 * disagree with another.
 *
 * `toCard` is the sharper case. It used to exist twice inside the API alone, once
 * on the read path and once on the write path, and the two disagreed: the read
 * path rendered `dueOn` as a calendar day and the write path returned a raw
 * `Date`, so the same card came back in two shapes depending on how you asked for
 * it. One function, used by every path in both processes, is what stops that from
 * happening a third time.
 */
import type { ActivityRow, CardRow } from '@kan/board-ops';
import type { PrismaClient } from '@kan/db';
import type { Activity, Board, BoardRole, Card, Label, List, Member } from '@kan/shared';
import { can, fromUtcDate, initialsOf, wipStateFor } from '@kan/shared';

/**
 * A domain row as the wire shape.
 *
 * `dueOn` is a `date` column, so Prisma hands back UTC midnight and the calendar
 * day it stands for comes from `fromUtcDate`, which reads it with UTC accessors
 * and returns the branded `CalendarDay`. Any local accessor -- `getDate()`,
 * `toLocaleDateString()` -- files a card due 1 March under 28 February for a
 * reader west of UTC, and the bug only appears for some readers, which is how it
 * survives review. `.toISOString().slice(0, 10)` is correct and was what this
 * did, but it produces a bare `string`: routing it through the helper is what
 * makes the contract's brand true rather than cast.
 */
export function toCard(row: CardRow, labels: Label[]): Card {
  return {
    id: row.id,
    listId: row.listId,
    title: row.title,
    description: row.description,
    position: row.position,
    version: row.version,
    dueOn: row.dueOn ? fromUtcDate(row.dueOn) : null,
    assigneeId: row.assigneeId,
    labels,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A whole board in one query, or null when the reader may not see it.
 *
 * Null covers "no such board" and "not a member" as one answer on purpose. A
 * caller that could tell them apart would be handing out a membership oracle:
 * respond 403 to a board that exists and 404 to one that does not, and id
 * enumeration tells an outsider which boards are real.
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
export async function readBoard(
  prisma: PrismaClient,
  boardId: string,
  userId: string,
): Promise<Board | null> {
  const membership = await prisma.boardMember.findUnique({
    where: { boardId_userId: { boardId, userId } },
    select: { role: true },
  });
  const role: BoardRole | null = membership?.role ?? null;
  if (!can(role, 'board.read')) return null;

  const board = await prisma.board.findUnique({
    where: { id: boardId },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      // The board's whole palette, in the same round trip. A picker needs the
      // labels nobody has applied yet, and those appear on no card.
      labels: {
        orderBy: { name: 'asc' },
        select: { id: true, name: true, colorSlot: true },
      },
      lists: {
        where: { archivedAt: null },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          boardId: true,
          name: true,
          position: true,
          wipLimit: true,
          cards: {
            where: { archivedAt: null },
            orderBy: { position: 'asc' },
            select: {
              id: true,
              listId: true,
              title: true,
              description: true,
              position: true,
              version: true,
              dueOn: true,
              assigneeId: true,
              createdAt: true,
              updatedAt: true,
              labels: {
                select: { label: { select: { id: true, name: true, colorSlot: true } } },
              },
            },
          },
        },
      },
      members: {
        orderBy: { user: { name: 'asc' } },
        select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      },
    },
  });
  if (!board) return null;

  return {
    id: board.id,
    name: board.name,
    role: role!,
    updatedAt: board.updatedAt.toISOString(),
    members: board.members.map((member): Member => ({
      userId: member.userId,
      role: member.role,
      name: member.user.name,
      email: member.user.email,
      // Computed on the server so the presence bar, the member list and the
      // activity feed cannot disagree about the same person's initials.
      initials: initialsOf(member.user.name),
    })),
    lists: board.lists.map((list): List => ({
      id: list.id,
      boardId: list.boardId,
      name: list.name,
      position: list.position,
      wipLimit: list.wipLimit,
      // Computed here, with the words, rather than left to the client. Colour
      // is never the only channel in this project, and "at limit 5/5" has to
      // read identically in the column header, in a screen reader and in the
      // socket broadcast.
      wip: wipStateFor(list.cards.length, list.wipLimit),
      cards: list.cards.map((card) =>
        toCard(
          { ...card, archivedAt: null },
          card.labels.map((join) => join.label),
        ),
      ),
    })),
    labels: board.labels,
  };
}

/**
 * A card's labels, ordered by name.
 *
 * A second query rather than something threaded back through `board-ops`, and
 * that is deliberate: making every operation return its labels would put a
 * presentation concern into the repository port that the in-memory fake also has
 * to implement. It is one indexed lookup on `(card_id)` against a join table with
 * at most eight rows per card.
 */
export async function readCardLabels(prisma: PrismaClient, cardId: string): Promise<Label[]> {
  const joins = await prisma.cardLabel.findMany({
    where: { cardId },
    select: { label: { select: { id: true, name: true, colorSlot: true } } },
    orderBy: { label: { name: 'asc' } },
  });
  return joins.map((join) => join.label);
}

/** A domain row as the wire shape, with its labels read from the database. */
export async function hydrateCard(prisma: PrismaClient, row: CardRow): Promise<Card> {
  return toCard(row, await readCardLabels(prisma, row.id));
}

/**
 * The database enum, as the dotted lowercase name the contract uses.
 *
 * Two vocabularies rather than one because the contract's name is also the socket
 * event vocabulary, and Postgres enums are conventionally SCREAMING_SNAKE. The
 * conversion happens at this one boundary rather than the value being stored
 * twice: a column holding `card.moved` would be a column whose values are a
 * protocol, and renaming the event would need a migration.
 */
const CONTRACT_TYPE = {
  BOARD_CREATED: 'board.created',
  BOARD_RENAMED: 'board.renamed',
  MEMBER_ADDED: 'member.added',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  LIST_CREATED: 'list.created',
  LIST_RENAMED: 'list.renamed',
  LIST_MOVED: 'list.moved',
  LIST_ARCHIVED: 'list.archived',
  CARD_CREATED: 'card.created',
  CARD_UPDATED: 'card.updated',
  CARD_MOVED: 'card.moved',
  CARD_ARCHIVED: 'card.archived',
} as const;

export function toContractType(type: keyof typeof CONTRACT_TYPE): Activity['type'] {
  return CONTRACT_TYPE[type];
}

/**
 * A committed activity row as the wire shape, with the actor's display name.
 *
 * The name is a parameter rather than a join, and both processes pass it from the
 * caller's service token. This runs once per board mutation in each of them, so a
 * join here would be a query per drag, forever, to learn something the request
 * already carried.
 */
export function toActivity(row: ActivityRow, actorName: string): Activity {
  return {
    id: row.id,
    boardId: row.boardId,
    type: toContractType(row.type),
    actorId: row.actorId,
    actorName,
    subject: row.subject,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}
