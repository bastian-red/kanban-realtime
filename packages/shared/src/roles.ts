/**
 * Who may do what to a board.
 *
 * One table, in the one package every side imports. The API enforces it, the
 * realtime gateway enforces it before a socket event reaches services/board-ops,
 * and the web app reads it to decide whether a card is draggable at all. Three
 * enforcement points and one definition: a role that gains a capability gains it
 * everywhere at once, and a UI that offers an action the server will refuse
 * becomes impossible to write by accident.
 *
 * The alternative -- an `if (role === 'VIEWER')` at each call site -- is how a
 * viewer ends up able to move a card over the socket while the REST route refuses
 * them, because the two checks were written three weeks apart.
 *
 * Deliberately pure data with no I/O: `can()` is a lookup, so it is safe to call
 * inside a render, inside a hot socket handler, and inside a Postgres
 * transaction.
 */

/**
 * The three roles, ordered from most to least powerful.
 *
 * Uppercase because these values are also the Postgres enum
 * (`packages/db/prisma/schema.prisma`), and a case difference between the
 * database and the contract is a bug that only appears once a real row exists.
 */
export const BOARD_ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const;

export type BoardRole = (typeof BOARD_ROLES)[number];

/**
 * Every distinct thing a member can attempt.
 *
 * Named for the intent rather than for the HTTP route or the socket event, so one
 * capability covers both transports. `card.move` is the same permission whether
 * it arrives as `PATCH /cards/:id/move` or as a `card.move` socket event, and it
 * must be, because both land in the same `moveCard()`.
 */
export const BOARD_OPERATIONS = [
  'board.read',
  'board.rename',
  'board.delete',
  'board.manageMembers',
  'list.create',
  'list.rename',
  'list.move',
  'list.archive',
  'card.create',
  'card.update',
  'card.move',
  'card.archive',
  'activity.read',
  'presence.join',
] as const;

export type BoardOperation = (typeof BOARD_OPERATIONS)[number];

/**
 * The matrix, written out in full rather than derived from a rank.
 *
 * A rank comparison (`roleRank[role] >= roleRank[required]`) is shorter and is
 * the wrong shape: it makes every capability strictly nested, so the first
 * permission that does not follow the hierarchy -- an owner who may not be
 * removed from their own board, an editor allowed to archive but not delete --
 * has to be special-cased outside the model that was supposed to hold all of it.
 * Spelling out fourteen operations three times costs nothing and reads as the
 * specification it is.
 *
 * Frozen, not merely typed `readonly`: this table is imported by a React tree and
 * handed to callers by `operationsFor`, and `readonly` is erased at runtime. One
 * `.push()` in a component -- or in a caller that thought it owned the array it
 * was given -- would grant a permission process-wide, to every request the
 * process goes on to serve. `Object.freeze` makes that a TypeError instead, and
 * these modules are ESM, so it throws rather than failing silently.
 */
const MATRIX: Readonly<Record<BoardRole, readonly BoardOperation[]>> = Object.freeze({
  OWNER: Object.freeze([
    'board.read',
    'board.rename',
    'board.delete',
    'board.manageMembers',
    'list.create',
    'list.rename',
    'list.move',
    'list.archive',
    'card.create',
    'card.update',
    'card.move',
    'card.archive',
    'activity.read',
    'presence.join',
  ] as const),
  EDITOR: Object.freeze([
    'board.read',
    'list.create',
    'list.rename',
    'list.move',
    'list.archive',
    'card.create',
    'card.update',
    'card.move',
    'card.archive',
    'activity.read',
    'presence.join',
  ] as const),
  // A viewer is present, not passive. They join the board room and appear in the
  // presence roster, because "four people are looking at this board" is true of
  // the person reviewing it as much as of the person dragging cards, and a
  // reviewer who is invisible gets talked over.
  VIEWER: Object.freeze(['board.read', 'activity.read', 'presence.join'] as const),
});

/**
 * Pre-built sets, so `can()` is a hash lookup rather than a linear scan.
 *
 * Written out per role rather than derived with `Object.fromEntries`, which
 * returns `{ [k: string]: ... }` and has to be cast back to a `Record<BoardRole,
 * ...>` -- a cast that would keep compiling if a role were dropped from
 * BOARD_ROLES, leaving `can()` to return false for it forever. Three explicit
 * keys means a fourth role is a compile error here.
 */
const ALLOWED: Readonly<Record<BoardRole, ReadonlySet<BoardOperation>>> = Object.freeze({
  OWNER: new Set<BoardOperation>(MATRIX.OWNER),
  EDITOR: new Set<BoardOperation>(MATRIX.EDITOR),
  VIEWER: new Set<BoardOperation>(MATRIX.VIEWER),
});

/**
 * May a member with this role perform this operation?
 *
 * `role` is typed as `BoardRole | null` because "not a member of this board" is
 * the common case at the edge, not an exceptional one: an unauthenticated socket,
 * a link to somebody else's board, a member who was removed while their tab was
 * open. Making the caller narrow that first is how a null slips through as
 * "truthy enough" and grants everything.
 */
export function can(role: BoardRole | null | undefined, operation: BoardOperation): boolean {
  if (!role) return false;
  return ALLOWED[role]?.has(operation) ?? false;
}

/** Every operation a role may perform. Used by the API to tell the client what to render. */
export function operationsFor(role: BoardRole): readonly BoardOperation[] {
  return MATRIX[role];
}

/** Is this string one of the three roles? The parse step at any untyped boundary. */
export function isBoardRole(value: unknown): value is BoardRole {
  return typeof value === 'string' && (BOARD_ROLES as readonly string[]).includes(value);
}
