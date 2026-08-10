/**
 * Creating, editing and archiving cards, and the same for lists.
 *
 * Everything here shares the shape `moveCard` establishes and for the same
 * reasons, so the notes are short: check the permission once against the matrix
 * in `@kan/shared`, do the work in one transaction, append an activity row inside
 * that transaction, return the row the caller broadcasts.
 *
 * The one thing worth reading is `updateCard`'s treatment of `expectedVersion`,
 * and the one thing worth noticing is what is *not* here: no `setPosition`. A
 * position is only ever produced by `services/ordering` inside `moveCard`, which
 * is what makes "the server owns the ordering key" a property of the code rather
 * than a convention.
 */
import { keyBetween, sortByPosition } from '@kan/ordering';
import { isPositionCollision } from '@kan/db';
import { can } from '@kan/shared';

import { conflict, forbidden, invalid, notFound, stale } from './errors';
import type { BoardOperation } from './operations';
import type { BoardRepository, BoardTx, CardRow, ListRow } from './ports';

const DEFAULT_MAX_ATTEMPTS = 5;

async function requirePermission(
  repository: BoardRepository,
  boardId: string,
  actorId: string,
  operation: BoardOperation,
): Promise<void> {
  const role = await repository.memberRole(boardId, actorId);
  if (!can(role, operation)) {
    throw forbidden(
      role === null
        ? 'You are not a member of this board.'
        : `A ${role.toLowerCase()} may not do that on this board.`,
    );
  }
}

/**
 * Run a unit of work that allocates a position, retrying on a collision.
 *
 * The same policy as `moveCard`'s loop, extracted because creating a card at the
 * top of a busy column races exactly as hard as moving one there. Only a position
 * collision is retried; everything else propagates immediately.
 */
async function withPositionRetry<T>(
  repository: BoardRepository,
  maxAttempts: number,
  work: (tx: BoardTx) => Promise<T>,
): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await repository.withTransaction(work);
    } catch (error) {
      if (!isPositionCollision(error)) throw error;
      last = error;
    }
  }
  throw conflict(
    `Could not allocate a position after ${maxAttempts} attempts. ` +
      `Last error: ${last instanceof Error ? last.message : String(last)}`,
  );
}

export interface CreateCardInput {
  boardId: string;
  listId: string;
  actorId: string;
  title: string;
  description?: string | null;
  dueOn?: Date | null;
  assigneeId?: string | null;
  labelIds?: readonly string[];
  afterCardId?: string | null;
}

export async function createCard(
  repository: BoardRepository,
  input: CreateCardInput,
  options: { maxAttempts?: number } = {},
): Promise<CardRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'card.create');

  return withPositionRetry(repository, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, async (tx) => {
    const list = await tx.findList(input.listId);
    if (!list || list.archivedAt !== null) throw notFound('That list no longer exists.');
    if (list.boardId !== input.boardId) throw invalid('That list belongs to a different board.');

    const siblings = sortByPosition(
      (await tx.listCards(input.listId, { forUpdate: true })).filter(
        (card) => card.archivedAt === null,
      ),
    );

    // Default is the end of the list, which is where "add a card" puts one. A
    // named `afterCardId` is honoured, and an unknown one is refused rather than
    // silently appended -- the caller's view is stale and appending would put the
    // card somewhere they did not ask for.
    let lower: string | null;
    let upper: string | null;
    if (input.afterCardId === undefined || input.afterCardId === null) {
      lower = siblings.length > 0 ? siblings.at(-1)!.position : null;
      upper = null;
    } else {
      const index = siblings.findIndex((card) => card.id === input.afterCardId);
      if (index === -1) throw invalid('The card you asked to insert after is not in that list.');
      lower = siblings[index]!.position;
      upper = siblings[index + 1]?.position ?? null;
    }

    const card = await tx.insertCard({
      listId: input.listId,
      title: input.title,
      position: keyBetween(lower, upper),
      description: input.description,
      dueOn: input.dueOn,
      assigneeId: input.assigneeId,
    });

    // Labels after the insert, because the join rows need the card's id. Same
    // transaction, so a rejected label id rolls the card back rather than leaving
    // a card that exists with labels the caller asked for and did not get.
    if (input.labelIds !== undefined) {
      await applyLabels(tx, input.boardId, card.id, input.labelIds);
    }

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'CARD_CREATED',
      subject: card.title,
      detail: list.name,
    });

    return card;
  });
}

/**
 * Attach exactly these labels, refusing any that are not this board's.
 *
 * The refusal is the point. `labelIds` comes from a client, and a label id is
 * just a cuid: without the board check, a caller who is an editor on board A
 * could attach board B's label to their own card by pasting its id, and the
 * board B label would then render on a board its owners never touched. The read
 * path joins through `CardLabel` and would show it.
 *
 * Duplicates are collapsed rather than rejected. `["a", "a"]` means the same
 * card state as `["a"]`, and the unique index on (card_id, label_id) would turn
 * an honest double-click into a 500.
 */
async function applyLabels(
  tx: BoardTx,
  boardId: string,
  cardId: string,
  labelIds: readonly string[],
): Promise<void> {
  const requested = [...new Set(labelIds)];
  if (requested.length === 0) {
    await tx.setCardLabels(cardId, []);
    return;
  }

  const known = new Set((await tx.listLabels(boardId)).map((label) => label.id));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw invalid(
      unknown.length === 1
        ? 'That label does not belong to this board.'
        : `${unknown.length} of those labels do not belong to this board.`,
    );
  }

  await tx.setCardLabels(cardId, requested);
}

export interface UpdateCardInput {
  boardId: string;
  cardId: string;
  actorId: string;
  expectedVersion: number;
  title?: string;
  description?: string | null;
  dueOn?: Date | null;
  assigneeId?: string | null;
  labelIds?: readonly string[];
}

export async function updateCard(
  repository: BoardRepository,
  input: UpdateCardInput,
): Promise<CardRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'card.update');

  return repository.withTransaction(async (tx) => {
    const existing = await tx.findCard(input.cardId);
    if (!existing || existing.archivedAt !== null) throw notFound('That card no longer exists.');

    const list = await tx.findList(existing.listId);
    if (!list || list.boardId !== input.boardId) {
      throw invalid('That card belongs to a different board.');
    }

    /**
     * The optimistic lock, and the reason it is a hard requirement rather than a
     * courtesy.
     *
     * Two people open the same card and both edit the title. Without the version
     * check the second write wins and the first person's change disappears with
     * no error, no conflict marker and nothing in the activity feed to explain
     * it -- their browser still shows what they typed, because their own optimistic
     * update succeeded. This is the failure fractional indexing cannot help with:
     * both writers are aiming at the same row, not competing for a gap between
     * rows.
     *
     * Checked here for the message and enforced by the conditional update below
     * for the race. See the same pairing in move.ts.
     */
    if (existing.version !== input.expectedVersion) {
      throw stale(
        `Somebody else edited this card (you had version ${input.expectedVersion}, it is now ${existing.version}).`,
      );
    }

    const updated = await tx.updateCard({
      cardId: input.cardId,
      expectedVersion: input.expectedVersion,
      title: input.title,
      description: input.description,
      dueOn: input.dueOn,
      assigneeId: input.assigneeId,
    });
    if (!updated) throw stale('Somebody else edited this card. Refresh and try again.');

    // Read the old set before replacing it, so the activity row can say "labels"
    // only when they actually changed. Sending the same three labels back is a
    // no-op edit and should not produce a feed entry claiming otherwise.
    let labelsChanged = false;
    if (input.labelIds !== undefined) {
      const before = new Set((await tx.cardLabels(input.cardId)).map((label) => label.id));
      const after = new Set(input.labelIds);
      labelsChanged = before.size !== after.size || [...after].some((id) => !before.has(id));
      await applyLabels(tx, input.boardId, input.cardId, input.labelIds);
    }

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'CARD_UPDATED',
      subject: updated.title,
      detail: describeChange(existing, input, labelsChanged),
    });

    return updated;
  });
}

/**
 * What changed, in words, for the activity feed.
 *
 * "Ana updated Fix login" is a row nobody learns anything from. Naming the field
 * is what makes the feed answer the question people actually bring to it, which
 * is "who moved my due date".
 */
function describeChange(
  before: CardRow,
  input: UpdateCardInput,
  labelsChanged = false,
): string | null {
  const changes: string[] = [];
  if (input.title !== undefined && input.title !== before.title) {
    changes.push(`renamed from "${before.title}"`);
  }
  if (input.description !== undefined && input.description !== before.description) {
    changes.push('description');
  }
  if (input.dueOn !== undefined)
    changes.push(input.dueOn === null ? 'due date cleared' : 'due date');
  if (input.assigneeId !== undefined) {
    changes.push(input.assigneeId === null ? 'unassigned' : 'assignee');
  }
  if (labelsChanged) changes.push('labels');
  return changes.length > 0 ? changes.join(', ') : null;
}

export async function archiveCard(
  repository: BoardRepository,
  input: { boardId: string; cardId: string; actorId: string; expectedVersion: number },
): Promise<CardRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'card.archive');

  return repository.withTransaction(async (tx) => {
    const existing = await tx.findCard(input.cardId);
    if (!existing || existing.archivedAt !== null) throw notFound('That card no longer exists.');

    const list = await tx.findList(existing.listId);
    if (!list || list.boardId !== input.boardId) {
      throw invalid('That card belongs to a different board.');
    }

    const archived = await tx.archiveCard({
      cardId: input.cardId,
      expectedVersion: input.expectedVersion,
    });
    if (!archived) {
      throw stale('Somebody else changed this card while you were archiving it.');
    }

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'CARD_ARCHIVED',
      // The title is stored on the row rather than joined at read time, which is
      // what lets an archived card still have a legible history.
      subject: archived.title,
      detail: list.name,
    });

    return archived;
  });
}

export interface CreateListInput {
  boardId: string;
  actorId: string;
  name: string;
  wipLimit?: number | null;
  afterListId?: string | null;
}

export async function createList(
  repository: BoardRepository,
  input: CreateListInput,
  options: { maxAttempts?: number } = {},
): Promise<ListRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'list.create');
  if (input.wipLimit !== undefined && input.wipLimit !== null && input.wipLimit < 1) {
    // Refused here as well as by the CHECK constraint, so the caller gets a
    // sentence rather than a 23514 they have to decode.
    throw invalid('A WIP limit must be at least 1. Leave it unset for no limit.');
  }

  return withPositionRetry(repository, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, async (tx) => {
    const existing = sortByPosition(
      (await tx.listLists(input.boardId, { forUpdate: true })).filter(
        (list) => list.archivedAt === null,
      ),
    );

    let lower: string | null;
    let upper: string | null;
    if (input.afterListId === undefined || input.afterListId === null) {
      lower = existing.length > 0 ? existing.at(-1)!.position : null;
      upper = null;
    } else {
      const index = existing.findIndex((list) => list.id === input.afterListId);
      if (index === -1) throw invalid('The list you asked to insert after is not on that board.');
      lower = existing[index]!.position;
      upper = existing[index + 1]?.position ?? null;
    }

    const list = await tx.insertList({
      boardId: input.boardId,
      name: input.name,
      position: keyBetween(lower, upper),
      wipLimit: input.wipLimit ?? null,
    });

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'LIST_CREATED',
      subject: list.name,
      detail: null,
    });

    return list;
  });
}

export async function updateList(
  repository: BoardRepository,
  input: {
    boardId: string;
    listId: string;
    actorId: string;
    name?: string;
    wipLimit?: number | null;
  },
): Promise<ListRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'list.rename');
  if (input.wipLimit !== undefined && input.wipLimit !== null && input.wipLimit < 1) {
    throw invalid('A WIP limit must be at least 1. Leave it unset for no limit.');
  }

  return repository.withTransaction(async (tx) => {
    const existing = await tx.findList(input.listId);
    if (!existing || existing.archivedAt !== null) throw notFound('That list no longer exists.');
    if (existing.boardId !== input.boardId)
      throw invalid('That list belongs to a different board.');

    const updated = await tx.updateList({
      listId: input.listId,
      name: input.name,
      wipLimit: input.wipLimit,
    });
    if (!updated) throw notFound('That list no longer exists.');

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'LIST_RENAMED',
      subject: updated.name,
      detail:
        input.name !== undefined && input.name !== existing.name ? `was "${existing.name}"` : null,
    });

    return updated;
  });
}

export async function moveList(
  repository: BoardRepository,
  input: {
    boardId: string;
    listId: string;
    actorId: string;
    afterListId: string | null;
    beforeListId: string | null;
  },
  options: { maxAttempts?: number } = {},
): Promise<ListRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'list.move');

  return withPositionRetry(repository, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, async (tx) => {
    const existing = await tx.findList(input.listId);
    if (!existing || existing.archivedAt !== null) throw notFound('That list no longer exists.');
    if (existing.boardId !== input.boardId)
      throw invalid('That list belongs to a different board.');

    const siblings = sortByPosition(
      (await tx.listLists(input.boardId, { forUpdate: true })).filter(
        (list) => list.archivedAt === null && list.id !== input.listId,
      ),
    );

    const afterIndex =
      input.afterListId === null ? -1 : siblings.findIndex((list) => list.id === input.afterListId);
    if (input.afterListId !== null && afterIndex === -1) {
      throw invalid('The list you dropped this after is no longer on that board.');
    }
    const lower = afterIndex === -1 ? null : siblings[afterIndex]!.position;
    const upper = siblings[afterIndex + 1]?.position ?? null;

    const moved = await tx.moveList({ listId: input.listId, position: keyBetween(lower, upper) });
    if (!moved) throw notFound('That list no longer exists.');

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'LIST_MOVED',
      subject: moved.name,
      detail: null,
    });

    return moved;
  });
}

export async function archiveList(
  repository: BoardRepository,
  input: { boardId: string; listId: string; actorId: string },
): Promise<ListRow> {
  await requirePermission(repository, input.boardId, input.actorId, 'list.archive');

  return repository.withTransaction(async (tx) => {
    const existing = await tx.findList(input.listId);
    if (!existing || existing.archivedAt !== null) throw notFound('That list no longer exists.');
    if (existing.boardId !== input.boardId)
      throw invalid('That list belongs to a different board.');

    const archived = await tx.archiveList(input.listId);
    if (!archived) throw notFound('That list no longer exists.');

    await tx.appendActivity({
      boardId: input.boardId,
      actorId: input.actorId,
      type: 'LIST_ARCHIVED',
      subject: archived.name,
      detail: null,
    });

    return archived;
  });
}

/**
 * How full a list is against its limit, as a state and a word.
 *
 * Re-exported, not defined here. It moved to `@kan/shared` beside the `wipSchema`
 * it produces, because the web app needs the same answer while a drag is still in
 * flight -- an optimistic move changes a column's count before any server has
 * said so -- and a client deriving its own wording from `state` would be a second
 * implementation of the rule. Callers inside this service are unchanged.
 */
export { wipStateFor } from '@kan/shared';
export type { WipState } from '@kan/shared';
