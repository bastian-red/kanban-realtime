/**
 * Moving a card. The one operation this whole project is about.
 *
 * A drag has to survive three different kinds of concurrency, and they are three
 * different mechanisms because they fail in three different ways:
 *
 * 1. **Two people drop a card into the same gap.** Both clients name the same two
 *    neighbours. `services/ordering` generates a *jittered* key per request, so
 *    the two get different keys and both land. Without jitter both would compute
 *    the identical key and one drag would be rejected for no reason the user can
 *    see.
 *
 * 2. **The jitter collides anyway.** Rare, not impossible. Postgres refuses the
 *    second insert on `UNIQUE (list_id, position)` with 23505, and the loop below
 *    re-jitters and tries again, up to `maxAttempts`. The unique index is what
 *    makes the collision *observable*: without it both writes succeed, two cards
 *    share a position, and the column's order becomes whatever the planner
 *    returned -- wrong everywhere and an error nowhere.
 *
 * 3. **Somebody edited the card while it was being dragged.** Fractional indexing
 *    has nothing to say about this: both writers target the same row rather than
 *    competing for a gap between rows. The per-card `version` is the guard, and a
 *    mismatch is `STALE`.
 *
 * On top of those, the read of the destination list is taken `FOR UPDATE`. That
 * turns most of case 2 into case "the second writer waits and then sees the truth"
 * -- the lock is the primary mechanism and the retry is the backstop, not the
 * other way round. A version with only the retry works and does more writes under
 * load; a version with only the lock deadlocks less obviously but still races
 * across two gateway replicas, because the lock is per-transaction and the two
 * replicas are two transactions. Both are needed.
 */
import { keyBetween, sortByPosition } from '@kan/ordering';
import { isPositionCollision } from '@kan/db';
import { can } from '@kan/shared';

import { conflict, forbidden, invalid, notFound, stale } from './errors';
import type { BoardRepository, BoardTx, CardRow } from './ports';

export interface MoveCardInput {
  boardId: string;
  cardId: string;
  actorId: string;
  expectedVersion: number;
  toListId: string;
  /** The client's view of where it dropped. Neighbours, never a position. */
  afterCardId: string | null;
  beforeCardId: string | null;
}

export interface MoveCardResult {
  card: CardRow;
  fromListId: string;
  /** How many attempts the move took. 1 when the first key was accepted. */
  attempts: number;
  /**
   * True when the client's two neighbours were no longer adjacent.
   *
   * The move still happened, at the place the user pointed relative to the list
   * as it actually is. The flag is what lets the caller tell the client "your
   * view was behind, take the broadcast as authoritative" instead of leaving it
   * to notice that its optimistic placement and the server's disagree.
   */
  reconciled: boolean;
}

export interface MoveOptions {
  /**
   * How many times to re-jitter after a unique violation.
   *
   * From MOVE_RETRY_ATTEMPTS. The ceiling exists so a genuinely stuck move fails
   * with a named error instead of spinning: an unbounded retry loop under
   * contention is an outage, not a fix.
   */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

export async function moveCard(
  repository: BoardRepository,
  input: MoveCardInput,
  options: MoveOptions = {},
): Promise<MoveCardResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw invalid(`MOVE_RETRY_ATTEMPTS must be a positive integer, got ${maxAttempts}`);
  }

  // The permission check happens once, before the transaction, and its result is
  // not cached anywhere: a role change lands as a database write, so the next
  // move re-reads it. Checking inside the retry loop would re-query the role on
  // every attempt for an answer that cannot change within one call.
  const role = await repository.memberRole(input.boardId, input.actorId);
  if (!can(role, 'card.move')) {
    throw forbidden(
      role === null
        ? 'You are not a member of this board.'
        : `A ${role.toLowerCase()} may not move cards on this board.`,
    );
  }

  let lastCollision: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await repository.withTransaction(async (tx) => {
        const result = await attemptMove(tx, input);
        return { ...result, attempts: attempt };
      });
    } catch (error) {
      // Only a position collision is retryable. A STALE, a FORBIDDEN or a
      // malformed key must surface immediately: re-jittering a key cannot fix a
      // version mismatch, and looping over one would report a CONFLICT that
      // blames concurrency for a bug in the caller.
      if (!isPositionCollision(error)) throw error;
      lastCollision = error;
    }
  }

  throw conflict(
    `Could not place the card after ${maxAttempts} attempts. ` +
      'Either this gap is under extraordinary contention or something is generating ' +
      `positions without jitter. Last error: ${describe(lastCollision)}`,
  );
}

async function attemptMove(
  tx: BoardTx,
  input: MoveCardInput,
): Promise<{ card: CardRow; fromListId: string; reconciled: boolean }> {
  const card = await tx.findCard(input.cardId);
  if (!card || card.archivedAt !== null) throw notFound('That card no longer exists.');

  const destination = await tx.findList(input.toListId);
  if (!destination || destination.archivedAt !== null) {
    throw notFound('That list no longer exists.');
  }
  // A card may only move within its own board. Without this a caller who knows
  // two ids could move a card into a list on a board they are a member of, from
  // one they are not -- the permission check above only covered `input.boardId`.
  if (destination.boardId !== input.boardId) {
    throw invalid('That list belongs to a different board.');
  }
  const origin = await tx.findList(card.listId);
  if (!origin || origin.boardId !== input.boardId) {
    throw invalid('That card belongs to a different board.');
  }

  // Version checked here as well as in the conditional update. The update is what
  // makes it safe; this is what makes the error honest, because the update
  // returning null could also mean the row was deleted, and telling somebody
  // their edit was stale when the card was actually archived sends them to look
  // for a card that is gone.
  if (card.version !== input.expectedVersion) {
    throw stale(
      `This card changed while you were moving it (you had version ${input.expectedVersion}, it is now ${card.version}).`,
    );
  }

  // FOR UPDATE on the destination: see the header. The card being moved is
  // excluded from the neighbour set -- a card cannot be its own neighbour, and
  // leaving it in makes a no-op move ask for a key between the card and itself,
  // which `keyBetween` correctly refuses as non-ascending bounds.
  const siblings = (await tx.listCards(input.toListId, { forUpdate: true })).filter(
    (sibling) => sibling.id !== card.id && sibling.archivedAt === null,
  );

  const { lower, upper, reconciled } = resolveBounds(siblings, input);
  const position = keyBetween(lower, upper);

  const moved = await tx.moveCard({
    cardId: card.id,
    expectedVersion: input.expectedVersion,
    toListId: input.toListId,
    position,
  });
  // The row was there a moment ago with this version, so a null here means
  // another writer committed between the read and the write. That is the race the
  // conditional update exists for.
  if (!moved) {
    throw stale('This card changed while you were moving it. Refresh and try again.');
  }

  await tx.appendActivity({
    boardId: input.boardId,
    actorId: input.actorId,
    type: 'CARD_MOVED',
    // The title as it is *now*, stored on the row. The feed is a record of what
    // happened, so renaming the card later must not rewrite this sentence.
    subject: moved.title,
    detail: origin.id === destination.id ? `within ${destination.name}` : `to ${destination.name}`,
  });

  return { card: moved, fromListId: card.listId, reconciled };
}

/**
 * Turn the client's neighbour intent into bounds, refusing a stale view.
 *
 * The client sends "after A, before B". By the time the server reads the list, A
 * and B may no longer be adjacent -- somebody inserted between them -- or one of
 * them may be gone. Two policies are possible and only one is defensible:
 *
 *   - Trust the pair and generate between A and B anyway. The card lands in the
 *     right *region*, and the person who inserted between them has their card
 *     silently jumped over. Cheap, and wrong in a way nobody can see.
 *   - Resolve the pair against the list as it is now: honour the neighbour the
 *     client named, and take the other bound from the current list. The card
 *     lands where the user pointed, relative to what is actually there.
 *
 * The second is what this does. `afterCardId` is authoritative when present,
 * because that is the card the user dropped below, and the upper bound is
 * recomputed as whatever now follows it.
 */
function resolveBounds(
  siblings: readonly CardRow[],
  input: MoveCardInput,
): { lower: string | null; upper: string | null; reconciled: boolean } {
  const ordered = sortByPosition(siblings);

  const afterIndex =
    input.afterCardId === null ? -1 : ordered.findIndex((card) => card.id === input.afterCardId);
  if (input.afterCardId !== null && afterIndex === -1) {
    // The card they dropped below is no longer in this list. Refusing is right:
    // "put it after X" has no meaning without X, and guessing would place it
    // somewhere the user did not point.
    throw invalid('The card you dropped this below is no longer in that list. Refresh and retry.');
  }

  const lower = afterIndex === -1 ? null : ordered[afterIndex]!.position;
  // The upper bound is whatever follows the lower bound *now*, which is not
  // necessarily `input.beforeCardId`. That is what makes a card somebody else
  // inserted between the two neighbours respected rather than jumped over.
  const next = ordered[afterIndex + 1];
  const upper = next ? next.position : null;

  // And this is what `beforeCardId` is for. The client sends both neighbours so
  // the server can tell "the top of the list" from "these two were adjacent when
  // I looked". When the card that actually follows is not the one the client
  // named, its view was behind: the move still lands where the user pointed, and
  // the caller is told to treat the broadcast as authoritative rather than
  // trusting its own optimistic placement.
  const actualNextId = next ? next.id : null;
  const reconciled = input.beforeCardId !== actualNextId;

  return { lower, upper, reconciled };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
