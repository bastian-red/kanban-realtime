/**
 * Ordering keys for cards and lists.
 *
 * This is the smallest package in the repo and the one the concurrency story
 * rests on. Everything here is pure: no I/O, no clock, no database. The only
 * non-determinism is the jitter, which is the point.
 *
 * ---------------------------------------------------------------------------
 * Why a string and not an integer
 *
 * If `position` is an integer, inserting a card between positions 3 and 4 means
 * renumbering every card below it. That is O(n) writes for one drag, it takes a
 * lock on rows nobody touched, and -- the part that matters here -- two clients
 * renumbering the same column at the same time produce two different, both
 * plausible, orders.
 *
 * A fractional index is a base62 string that sorts lexicographically: between
 * 'a0' and 'a1' there is 'a0V', and between 'a0' and 'a0V' there is 'a0H'. The
 * set is densely ordered, so there is always a key between any two keys, and
 * inserting touches exactly one row.
 *
 * ---------------------------------------------------------------------------
 * Why jitter
 *
 * `generateKeyBetween` is deterministic: the same two neighbours always produce
 * the same key. That is a problem the moment two people drag a card into the same
 * gap at the same moment -- both clients ask for a key between 'a0' and 'a1',
 * both get 'a0V', and the second insert fails on `UNIQUE (list_id, position)`.
 * The unique index is doing its job; the generator is the one being naive.
 *
 * `generateJitteredKeyBetween` adds a bounded random offset, so the two calls get
 * two different keys and both writes succeed with both cards in the gap. The
 * unique index remains as the backstop for the case where even the jitter
 * collides, which is rare rather than impossible -- see MOVE_RETRY_ATTEMPTS in
 * services/board-ops.
 *
 * ---------------------------------------------------------------------------
 * Library choice
 *
 * `fractional-indexing-jittered@1` (CC0, zero dependencies, ~70 KB), not
 * `fractional-indexing@4`.
 *
 * The obvious choice is rocicorp's `fractional-indexing`: 563 stars, actively
 * maintained, and the reference implementation of this algorithm. It has no
 * jitter. Adding jitter on top looks trivial -- append a few random base62
 * characters -- and is not: appending to a key that happens to be a prefix of the
 * upper bound produces a key that sorts *after* it, silently, in a way no test
 * that only checks "a < k" would catch. The jittered package handles exactly that
 * (`paddingNeededForJitter` pads the key until a jitter suffix cannot reach the
 * upper bound), and it ships both CommonJS and ESM, which suits a workspace that
 * compiles to CommonJS. That second point is a convenience rather than the
 * decider it was originally taken to be: `require(esm)` was backported to Node
 * 20.19, so an ESM-only dependency would load fine on the Node this repo runs and
 * would only throw on 20.0-20.18, which `engines` still admits. See the interop
 * test in ordering.test.ts for the measured version of that.
 *
 * Its weakness is real and worth naming: 45 stars, one maintainer, last pushed
 * January 2025. That is why `ordering.test.ts` property-tests the *behaviour*
 * rather than trusting the package -- ten thousand random interleaved inserts
 * asserting a total order, and two thousand calls into one gap asserting they
 * differ. If a future version regressed, the gate lane goes red here rather than
 * the board going subtly wrong in production.
 */
import {
  generateJitteredKeyBetween,
  generateKeyBetween,
  generateNJitteredKeysBetween,
} from 'fractional-indexing-jittered';

/** Anything with a fractional index. Lists and cards both qualify. */
export interface Positioned {
  readonly position: string;
}

export class OrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderingError';
  }
}

/**
 * The character set positions are drawn from, and the shape the database
 * enforces.
 *
 * Mirrored by `CHECK (position ~ '^[a-zA-Z0-9]+$')` in the board_invariants
 * migration and by `positionSchema` in packages/shared. Three copies of one rule
 * is two too many in general; here each is a different layer's last chance to
 * refuse, and the migration's comment explains what an empty key silently does.
 */
export const POSITION_PATTERN = /^[a-zA-Z0-9]+$/;

/**
 * The ceiling at which a column should be rebalanced.
 *
 * Keys grow as cards are repeatedly dropped into the same gap: each insert
 * between two adjacent keys adds roughly one character. Ten thousand random
 * interleaved inserts reach length 11 (measured, not estimated -- see the
 * property test), so 40 is far beyond any organic board and is reached only by a
 * loop. It is a signal, not a limit: `needsRebalance` reports it, and the
 * database's own ceiling is 200.
 */
export const REBALANCE_LENGTH = 40;

export function isPosition(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && POSITION_PATTERN.test(value);
}

function assertBound(value: string | null, label: string): void {
  if (value === null) return;
  if (!isPosition(value)) {
    throw new OrderingError(
      `${label} bound is not a position: ${JSON.stringify(value)}. ` +
        'An empty or malformed key sorts first and silently reorders the list.',
    );
  }
}

/**
 * A key strictly between two neighbours, jittered.
 *
 * `null` means "no neighbour on that side": `keyBetween(null, 'a1')` is the top
 * of a list, `keyBetween('a1', null)` the bottom, `keyBetween(null, null)` the
 * first card in an empty list.
 *
 * Throws rather than repairing when the bounds are out of order. A caller that
 * passed them backwards has a stale view of the list -- the two cards it thinks
 * are adjacent are not, or are not in that order -- and generating *some* key
 * would place the card somewhere neither the caller nor the user asked for. The
 * caller's correct response is to refuse the move and resync, which it can only
 * do if it is told.
 */
export function keyBetween(lower: string | null, upper: string | null): string {
  assertBound(lower, 'Lower');
  assertBound(upper, 'Upper');
  if (lower !== null && upper !== null && lower >= upper) {
    throw new OrderingError(
      `Bounds are not in ascending order: ${lower} >= ${upper}. ` +
        "The client's view of this list is stale; resync rather than guessing.",
    );
  }
  return generateJitteredKeyBetween(lower, upper);
}

/**
 * `count` keys in ascending order between two neighbours.
 *
 * Used by the seed and by "add several cards at once". Not by a move: a move
 * places one card, and asking for one key is what makes each move independently
 * retryable.
 */
export function keysBetween(lower: string | null, upper: string | null, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new OrderingError(`Key count must be a positive integer, got ${count}`);
  }
  assertBound(lower, 'Lower');
  assertBound(upper, 'Upper');
  if (lower !== null && upper !== null && lower >= upper) {
    throw new OrderingError(`Bounds are not in ascending order: ${lower} >= ${upper}`);
  }
  return generateNJitteredKeysBetween(lower, upper, count);
}

/**
 * The first key in an empty list.
 *
 * Deliberately **not** jittered, and this is the one place that is right. The
 * seed plants boards from this, and `scripts/seed-check.sh` asserts two seed runs
 * produce an identical digest; a jittered first key would make the seed
 * non-deterministic at its very first row. There is also nothing to collide with
 * in an empty list -- the whole reason for jitter is two clients choosing the
 * same gap, and an empty list has no gap to share. Real inserts that follow it go
 * through `keyBetween`, which does jitter.
 */
export function firstKey(): string {
  return generateKeyBetween(null, null);
}

/**
 * Sort by position, ascending, without mutating the input.
 *
 * Plain `<` on the strings, not `localeCompare`. That is not a shortcut: a locale
 * comparator is allowed to treat case, accents and digits by language-specific
 * rules, and under some locales 'a' and 'A' compare equal, which would make two
 * distinct keys sort unpredictably against each other. The keys are ASCII base62
 * and the database orders them with the C collation; the client has to agree with
 * the database or the board renders in a different order than it was stored in.
 */
export function sortByPosition<T extends Positioned>(items: readonly T[]): T[] {
  return [...items].sort((left, right) =>
    left.position < right.position ? -1 : left.position > right.position ? 1 : 0,
  );
}

/**
 * The neighbours a card would land between, given where the client dropped it.
 *
 * The client sends an intent -- "after card X, before card Y" -- and the server
 * resolves it against the list as it actually is *now*, which is the whole reason
 * the client does not compute the key itself. Returns the bounds to hand to
 * `keyBetween`.
 *
 * `items` must be the destination list's cards, already sorted, and must not
 * include the card being moved: a card cannot be its own neighbour, and leaving
 * it in makes a no-op move generate a key between the card and itself.
 */
export function boundsFor(
  items: readonly Positioned[],
  afterPosition: string | null,
  beforePosition: string | null,
): { lower: string | null; upper: string | null } {
  const sorted = sortByPosition(items);

  // Both null: the client is dropping into an empty list, or asking for the whole
  // range. Bound by the list's real ends rather than by nothing, so a concurrent
  // insert that landed first is respected.
  if (afterPosition === null && beforePosition === null) {
    return sorted.length === 0
      ? { lower: null, upper: null }
      : { lower: null, upper: sorted[0]!.position };
  }

  if (afterPosition === null) {
    return { lower: null, upper: beforePosition };
  }
  if (beforePosition === null) {
    return { lower: afterPosition, upper: null };
  }
  return { lower: afterPosition, upper: beforePosition };
}

/**
 * Have this column's keys grown long enough to be worth rebalancing?
 *
 * Rebalancing rewrites every key in the list to short, evenly spaced values. It
 * is a maintenance operation, not a hot path: it touches every row and therefore
 * conflicts with every concurrent move, which is why it is *reported* here rather
 * than triggered automatically inside a drag.
 */
export function needsRebalance(items: readonly Positioned[]): boolean {
  return items.some((item) => item.position.length >= REBALANCE_LENGTH);
}

/**
 * Fresh, evenly spaced keys for a whole column, in its current order.
 *
 * Not jittered: a rebalance is a single writer holding the list, so there is
 * nobody to collide with, and even spacing is the entire point -- jitter would
 * reintroduce the unevenness the rebalance exists to remove.
 */
export function rebalance(items: readonly Positioned[]): string[] {
  if (items.length === 0) return [];
  const keys: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < items.length; index += 1) {
    previous = generateKeyBetween(previous, null);
    keys.push(previous);
  }
  return keys;
}
