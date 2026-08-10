/**
 * An in-memory `BoardRepository`, for the gate lane.
 *
 * What it is for: running the permission matrix, the bounds arithmetic and the
 * retry policy tens of thousands of times in milliseconds, with no container and
 * no network. Those are the parts of this service that are genuinely
 * decision-heavy, and they deserve a suite that is cheap enough to run on every
 * commit.
 *
 * What it is **not** for, and this is the important half: it does not stand in
 * for Postgres. It cannot refuse a duplicate position the way a unique index
 * does, it cannot serialise two transactions, and a test that asserted "the
 * database rejected this" against this class would be asserting on its own fake.
 * Those live in the integration lane against the real thing. This file's job is
 * to be a plausible *sequence of rows*, not a plausible database.
 *
 * It does model two things faithfully, because the logic under test depends on
 * them:
 *
 *   - The conditional update. `moveCard`/`updateCard` return null when the
 *     version does not match, exactly as the SQL does, so the STALE path is
 *     reachable here.
 *   - The unique position index, as an opt-in (`collideOnce`, `collideAlways`).
 *     Not because the fake should enforce it, but because the retry loop is a
 *     branch that would otherwise never execute in the gate lane, and an
 *     untested retry loop is a retry loop that infinite-loops the first time it
 *     runs in production.
 */
import type { ActivityType, BoardRole } from '@kan/db';

import type {
  ActivityRow,
  BoardRepository,
  BoardTx,
  CardRow,
  LabelRow,
  ListRow,
  MemberRow,
  NewActivity,
} from './ports';

export interface MemorySeed {
  boardId: string;
  members: { userId: string; name?: string; email?: string; role: BoardRole }[];
  lists: {
    id: string;
    name: string;
    position: string;
    wipLimit?: number | null;
    archivedAt?: Date | null;
    cards: {
      id: string;
      title: string;
      position: string;
      version?: number;
      archivedAt?: Date | null;
      assigneeId?: string | null;
      dueOn?: Date | null;
      description?: string | null;
      labelIds?: string[];
    }[];
  }[];
  /** The board's own labels. A card may only be given one of these. */
  labels?: { id: string; name: string; colorSlot?: number }[];
  /**
   * Labels belonging to some *other* board, reachable by id but not attachable.
   *
   * They exist in the fake so the cross-board test has something real to point
   * at: a label id that resolves fine and still must be refused.
   */
  foreignLabels?: { id: string; name: string; boardId: string }[];
}

/**
 * How the fake should behave when asked to write a position.
 *
 * `collideOnce` makes the first write of any position fail with a shape that
 * `isPositionCollision` recognises, so the retry loop runs exactly once and the
 * test can assert it recovered. `collideAlways` makes every write fail, which is
 * how the attempt ceiling gets tested without waiting for an unlikely event.
 */
export interface MemoryOptions {
  collideOnce?: boolean;
  collideAlways?: boolean;
}

/** The error Prisma raises for a unique violation, in the shape the guards read. */
function positionCollisionError(): Error & { code: string; meta: { target: string[] } } {
  const error = new Error(
    'Unique constraint failed on the fields: (`list_id`,`position`)',
  ) as Error & { code: string; meta: { target: string[] } };
  error.code = 'P2002';
  error.meta = { target: ['list_id', 'position'] };
  return error;
}

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}_${sequence}`;
};

export class MemoryRepository implements BoardRepository {
  readonly boardId: string;
  readonly activities: ActivityRow[] = [];
  private readonly roles = new Map<string, BoardRole>();
  private readonly people = new Map<string, { name: string; email: string }>();
  private lists: ListRow[] = [];
  private cards: CardRow[] = [];
  private labels: LabelRow[] = [];
  /** card id -> label ids. The join table, as a map. */
  private cardLabelIds = new Map<string, string[]>();
  private options: MemoryOptions;
  private collidedOnce = false;

  /** Every transaction this repository has run. The retry count is `length`. */
  transactions = 0;

  constructor(seed: MemorySeed, options: MemoryOptions = {}) {
    this.boardId = seed.boardId;
    this.options = options;

    for (const member of seed.members) {
      this.roles.set(member.userId, member.role);
      this.people.set(member.userId, {
        name: member.name ?? member.userId,
        email: member.email ?? `${member.userId}@example.test`,
      });
    }

    for (const [index, label] of (seed.labels ?? []).entries()) {
      this.labels.push({
        id: label.id,
        boardId: seed.boardId,
        name: label.name,
        colorSlot: label.colorSlot ?? index % 8,
      });
    }
    for (const label of seed.foreignLabels ?? []) {
      this.labels.push({ id: label.id, boardId: label.boardId, name: label.name, colorSlot: 0 });
    }

    const now = new Date('2026-03-09T12:00:00.000Z');
    for (const list of seed.lists) {
      this.lists.push({
        id: list.id,
        boardId: seed.boardId,
        name: list.name,
        position: list.position,
        wipLimit: list.wipLimit ?? null,
        archivedAt: list.archivedAt ?? null,
      });
      for (const card of list.cards) {
        this.cards.push({
          id: card.id,
          listId: list.id,
          title: card.title,
          description: card.description ?? null,
          position: card.position,
          version: card.version ?? 0,
          dueOn: card.dueOn ?? null,
          assigneeId: card.assigneeId ?? null,
          archivedAt: card.archivedAt ?? null,
          createdAt: now,
          updatedAt: now,
        });
        if (card.labelIds !== undefined) this.cardLabelIds.set(card.id, [...card.labelIds]);
      }
    }
  }

  /** The label ids on a card, for assertions. Sorted, so order cannot flake a test. */
  labelsOn(cardId: string): string[] {
    return [...(this.cardLabelIds.get(cardId) ?? [])].sort();
  }

  /** Change the collision behaviour mid-test, to exercise "fails then succeeds". */
  setOptions(options: MemoryOptions): void {
    this.options = options;
    this.collidedOnce = false;
  }

  /** The cards of a list in key order, for assertions. */
  order(listId: string): string[] {
    return this.cards
      .filter((card) => card.listId === listId && card.archivedAt === null)
      .sort((left, right) => (left.position < right.position ? -1 : 1))
      .map((card) => card.id);
  }

  positions(): string[] {
    return this.cards.map((card) => card.position);
  }

  async memberRole(boardId: string, userId: string): Promise<BoardRole | null> {
    if (boardId !== this.boardId) return null;
    return this.roles.get(userId) ?? null;
  }

  async members(boardId: string): Promise<MemberRow[]> {
    if (boardId !== this.boardId) return [];
    return [...this.roles].map(([userId, role]) => ({
      userId,
      role,
      name: this.people.get(userId)?.name ?? userId,
      email: this.people.get(userId)?.email ?? `${userId}@example.test`,
    }));
  }

  /**
   * Runs the work against a copy and commits it only on success.
   *
   * Not a real transaction, and it does not pretend to be one -- there is no
   * isolation level here and no second connection to be isolated from. What it
   * does model is atomicity: a `moveCard` that throws after writing the card but
   * before appending the activity must leave neither behind, and a fake that
   * mutated in place would leave the first write visible and make the retry loop
   * look like it duplicated a card.
   */
  async withTransaction<T>(work: (tx: BoardTx) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const listSnapshot = this.lists.map((list) => ({ ...list }));
    const cardSnapshot = this.cards.map((card) => ({ ...card }));
    // The join table is snapshotted too. Without this a createCard that inserts
    // the card, then throws on a label from another board, would roll the card
    // back and leave its labels behind -- and the next card to reuse that id
    // would inherit them. The whole point of the fake is that atomicity is
    // modelled, so every table it holds has to take part.
    const labelSnapshot = new Map([...this.cardLabelIds].map(([id, ids]) => [id, [...ids]]));
    const activitySnapshot = this.activities.length;

    try {
      return await work(this.tx());
    } catch (error) {
      this.lists = listSnapshot;
      this.cards = cardSnapshot;
      this.cardLabelIds = labelSnapshot;
      this.activities.length = activitySnapshot;
      throw error;
    }
  }

  private shouldCollide(): boolean {
    if (this.options.collideAlways) return true;
    if (this.options.collideOnce && !this.collidedOnce) {
      this.collidedOnce = true;
      return true;
    }
    return false;
  }

  /**
   * The transaction handle, as arrow properties.
   *
   * Every method is `name: async (...) => {}` rather than `async name() {}` so
   * that `this` is the repository, captured lexically, with no `const self =
   * this` in sight. The alias worked and read as an accident: a method shorthand
   * in an object literal gets its own `this`, so the alias was load-bearing and
   * looked incidental, which is exactly what `@typescript-eslint/no-this-alias`
   * is pointing at.
   */
  private tx(): BoardTx {
    return {
      findCard: async (cardId) => {
        const card = this.cards.find((row) => row.id === cardId);
        return card ? { ...card } : null;
      },
      findList: async (listId) => {
        const list = this.lists.find((row) => row.id === listId);
        return list ? { ...list } : null;
      },
      listCards: async (listId) => {
        return this.cards
          .filter((card) => card.listId === listId)
          .sort((left, right) => (left.position < right.position ? -1 : 1))
          .map((card) => ({ ...card }));
      },
      listLists: async (boardId) => {
        return this.lists
          .filter((list) => list.boardId === boardId)
          .sort((left, right) => (left.position < right.position ? -1 : 1))
          .map((list) => ({ ...list }));
      },
      moveCard: async ({ cardId, expectedVersion, toListId, position }) => {
        if (this.shouldCollide()) throw positionCollisionError();
        const card = this.cards.find((row) => row.id === cardId);
        // The conditional update, modelled faithfully: null when the version has
        // moved on, which is what the SQL's `WHERE version = $n` produces.
        if (!card || card.version !== expectedVersion) return null;
        card.listId = toListId;
        card.position = position;
        card.version += 1;
        card.updatedAt = new Date();
        return { ...card };
      },
      updateCard: async ({ cardId, expectedVersion, ...fields }) => {
        const card = this.cards.find((row) => row.id === cardId);
        if (!card || card.version !== expectedVersion) return null;
        if (fields.title !== undefined) card.title = fields.title;
        if (fields.description !== undefined) card.description = fields.description;
        if (fields.dueOn !== undefined) card.dueOn = fields.dueOn;
        if (fields.assigneeId !== undefined) card.assigneeId = fields.assigneeId;
        card.version += 1;
        card.updatedAt = new Date();
        return { ...card };
      },
      insertCard: async ({ listId, title, position, description, dueOn, assigneeId }) => {
        if (this.shouldCollide()) throw positionCollisionError();
        const now = new Date();
        const card: CardRow = {
          id: nextId('card'),
          listId,
          title,
          description: description ?? null,
          position,
          version: 0,
          dueOn: dueOn ?? null,
          assigneeId: assigneeId ?? null,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.cards.push(card);
        return { ...card };
      },
      listLabels: async (boardId) => {
        return this.labels
          .filter((label) => label.boardId === boardId)
          .map((label) => ({ ...label }));
      },
      cardLabels: async (cardId) => {
        const ids = new Set(this.cardLabelIds.get(cardId) ?? []);
        return this.labels.filter((label) => ids.has(label.id)).map((label) => ({ ...label }));
      },
      setCardLabels: async (cardId, labelIds) => {
        this.cardLabelIds.set(cardId, [...labelIds]);
      },
      archiveCard: async ({ cardId, expectedVersion }) => {
        const card = this.cards.find((row) => row.id === cardId);
        if (!card || card.version !== expectedVersion) return null;
        card.archivedAt = new Date();
        card.version += 1;
        return { ...card };
      },
      insertList: async ({ boardId, name, position, wipLimit }) => {
        if (this.shouldCollide()) throw positionCollisionError();
        const list: ListRow = {
          id: nextId('list'),
          boardId,
          name,
          position,
          wipLimit,
          archivedAt: null,
        };
        this.lists.push(list);
        return { ...list };
      },
      updateList: async ({ listId, name, wipLimit }) => {
        const list = this.lists.find((row) => row.id === listId);
        if (!list) return null;
        if (name !== undefined) list.name = name;
        if (wipLimit !== undefined) list.wipLimit = wipLimit;
        return { ...list };
      },
      moveList: async ({ listId, position }) => {
        if (this.shouldCollide()) throw positionCollisionError();
        const list = this.lists.find((row) => row.id === listId);
        if (!list) return null;
        list.position = position;
        return { ...list };
      },
      archiveList: async (listId) => {
        const list = this.lists.find((row) => row.id === listId);
        if (!list) return null;
        list.archivedAt = new Date();
        return { ...list };
      },
      appendActivity: async (activity: NewActivity) => {
        const row: ActivityRow = {
          id: nextId('activity'),
          createdAt: new Date(),
          ...activity,
          type: activity.type as ActivityType,
        };
        this.activities.push(row);
        return { ...row };
      },
    };
  }
}
