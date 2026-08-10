/**
 * The repository port.
 *
 * `services/board-ops` is where the write path lives, and it is imported by two
 * processes: `apps/api` (a REST mutation) and `apps/realtime` (a socket event).
 * One `moveCard`, one permission check, one hop per drag -- rather than the
 * gateway forwarding to the API, which would double the latency of the one
 * interaction the product is judged on.
 *
 * It talks to Postgres through this interface rather than through Prisma
 * directly, for one reason that pays for itself immediately: the permission
 * matrix, the retry policy and the ordering arithmetic are the interesting part,
 * and they can then be tested exhaustively against an in-memory repository in the
 * gate lane -- 3 roles x 14 operations in milliseconds, with no container. What
 * that lane *cannot* prove is that Postgres refuses a duplicate position, so the
 * integration lane runs the same functions against the real thing. Two lanes,
 * one implementation, no mocks of the database's own guarantees.
 *
 * The port is deliberately thin and boring. It exposes rows, not behaviour: no
 * `moveCardAndRecordActivity`, because then the logic under test would live in
 * the adapter and the fake would be a second implementation of it.
 */
import type { ActivityType, BoardRole } from '@kan/db';

export interface CardRow {
  id: string;
  listId: string;
  title: string;
  description: string | null;
  position: string;
  version: number;
  dueOn: Date | null;
  assigneeId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListRow {
  id: string;
  boardId: string;
  name: string;
  position: string;
  wipLimit: number | null;
  archivedAt: Date | null;
}

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: BoardRole;
}

export interface LabelRow {
  id: string;
  boardId: string;
  name: string;
  colorSlot: number;
}

export interface ActivityRow {
  id: string;
  boardId: string;
  actorId: string;
  type: ActivityType;
  subject: string;
  detail: string | null;
  createdAt: Date;
}

export interface NewActivity {
  boardId: string;
  actorId: string;
  type: ActivityType;
  subject: string;
  detail: string | null;
}

/**
 * What a transaction can do.
 *
 * Split from `BoardRepository` so a caller cannot accidentally start a nested
 * transaction from inside one: `withTransaction` hands out a `BoardTx`, and
 * `BoardTx` has no `withTransaction`. Nested transactions in Prisma silently
 * become savepoints or hang depending on the adapter, and a move that hangs
 * holding a row lock takes the whole column with it.
 */
export interface BoardTx {
  findCard(cardId: string): Promise<CardRow | null>;
  findList(listId: string): Promise<ListRow | null>;

  /**
   * The cards of a list, ordered by position, excluding archived ones.
   *
   * `forUpdate` takes a row lock (`SELECT ... FOR UPDATE`). The move path uses it
   * on the destination list: without the lock, two concurrent moves read the same
   * neighbours, compute keys against the same gap and race. With it, the second
   * waits and then reads the list as the first left it -- so the jitter is a
   * second line of defence rather than the only one.
   */
  listCards(listId: string, options?: { forUpdate?: boolean }): Promise<CardRow[]>;
  listLists(boardId: string, options?: { forUpdate?: boolean }): Promise<ListRow[]>;

  /**
   * Write a card's new position and list, but only if its version still matches.
   *
   * Returns null when the version has moved on, which the caller turns into
   * `STALE`. This is a conditional update rather than a read-then-write for the
   * usual reason: between the read and the write, somebody else's move lands, and
   * a service-layer comparison would not notice.
   */
  moveCard(input: {
    cardId: string;
    expectedVersion: number;
    toListId: string;
    position: string;
  }): Promise<CardRow | null>;

  updateCard(input: {
    cardId: string;
    expectedVersion: number;
    title?: string;
    description?: string | null;
    dueOn?: Date | null;
    assigneeId?: string | null;
  }): Promise<CardRow | null>;

  insertCard(input: {
    listId: string;
    title: string;
    position: string;
    description?: string | null;
    dueOn?: Date | null;
    assigneeId?: string | null;
  }): Promise<CardRow>;

  /**
   * The board's labels, for validating what a caller asked to attach.
   *
   * Scoped to the board rather than fetched by id. `labelIds` arrives from a
   * client, and looking each one up by id alone would happily attach a label
   * belonging to a board the caller cannot read -- a cross-board write dressed up
   * as a card edit. Reading the board's own set and intersecting is the check.
   */
  listLabels(boardId: string): Promise<LabelRow[]>;

  /**
   * Replace a card's labels with exactly this set.
   *
   * Replace, not add. The client sends the labels the card should end up with,
   * which is what a checkbox group produces; an additive call would make removing
   * a label impossible without a second verb. Passing an empty array clears them.
   */
  setCardLabels(cardId: string, labelIds: readonly string[]): Promise<void>;

  /** The labels currently on a card, so an edit can report what actually changed. */
  cardLabels(cardId: string): Promise<LabelRow[]>;

  archiveCard(input: { cardId: string; expectedVersion: number }): Promise<CardRow | null>;

  insertList(input: {
    boardId: string;
    name: string;
    position: string;
    wipLimit: number | null;
  }): Promise<ListRow>;

  updateList(input: {
    listId: string;
    name?: string;
    wipLimit?: number | null;
  }): Promise<ListRow | null>;

  moveList(input: { listId: string; position: string }): Promise<ListRow | null>;

  archiveList(listId: string): Promise<ListRow | null>;

  appendActivity(activity: NewActivity): Promise<ActivityRow>;
}

export interface BoardRepository {
  /** The reader's role on this board, or null when they are not a member. */
  memberRole(boardId: string, userId: string): Promise<BoardRole | null>;

  members(boardId: string): Promise<MemberRow[]>;

  /**
   * Run a unit of work in one Postgres transaction.
   *
   * Every mutation in this service goes through one. A move reads the
   * destination's neighbours, writes the card and appends an activity row: three
   * statements that must not be observable half-done, because the broadcast that
   * follows tells every other client the move happened.
   */
  withTransaction<T>(work: (tx: BoardTx) => Promise<T>): Promise<T>;
}
