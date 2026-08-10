import { PrismaClient } from '../generated/client';

export * from '../generated/client';
export { PrismaClient };

/**
 * Error codes the services branch on.
 *
 * Two vocabularies, and confusing them fails silently rather than loudly.
 * Prisma's typed client reports its **own** codes -- `P2002` for a unique
 * violation -- while `$queryRaw` and `$executeRaw` surface the underlying
 * Postgres **SQLSTATE**, `23505`. A guard that checks only the SQLSTATE compiles,
 * type-checks, and never fires against an ordinary `create()`.
 *
 * For this app the consequence is the whole concurrency design. `moveCard()`
 * inserts a fractional index and retries when the unique index on
 * `(list_id, position)` rejects it, and the retry only happens if the catch
 * recognises the violation. A guard that misses one vocabulary turns a
 * recoverable collision -- two people dropping a card into the same gap in the
 * same millisecond -- into a 500 on the exact path the project exists to handle.
 */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

/**
 * Names of the invariants declared in `20260807121000_board_invariants` and by
 * Prisma's own `@@unique` attributes.
 *
 * Code that catches a constraint violation matches on these rather than on the
 * message text. Postgres error messages are localised and reworded between
 * versions, so a service that greps them breaks on an upgrade, in production, at
 * the exact moment it is trying to report a different error.
 *
 * The two `..._position_key` names are the load-bearing ones: they are what makes
 * a collision *observable*. Without them two cards silently share a position and
 * the board's order becomes whatever the query planner produced, which is not an
 * error anywhere and is wrong everywhere.
 */
export const CARD_POSITION_UNIQUE = 'cards_list_id_position_key';
export const LIST_POSITION_UNIQUE = 'lists_board_id_position_key';
export const CARD_POSITION_FORMAT = 'cards_position_format';
export const LIST_POSITION_FORMAT = 'lists_position_format';
export const LIST_WIP_LIMIT_POSITIVE = 'lists_wip_limit_positive';
export const BOARD_ONE_OWNER = 'board_members_one_owner_per_board';
export const BOARD_MEMBER_UNIQUE = 'board_members_board_id_user_id_key';
export const LABEL_NAME_UNIQUE = 'labels_board_id_name_key';
export const USER_EMAIL_UNIQUE = 'users_email_key';

interface PgError {
  code?: string;
  message?: string;
  meta?: { constraint?: unknown; target?: unknown; message?: unknown; cause?: unknown };
}

function asError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null ? (err as PgError) : null;
}

/**
 * The constraint an error is about.
 *
 * Prisma reports it three different ways depending on how the write was made:
 * `meta.constraint` for raw SQL, `meta.target` as a string or as an array of
 * column names for the typed client. Normalising here means every call site asks
 * one question instead of three.
 *
 * The array form matters for this schema specifically. A `card.update()` that
 * trips the position index reports `meta.target: ['list_id', 'position']`, not
 * the index name, so a caller comparing against `cards_list_id_position_key`
 * would never match. `matches()` below uses `includes` for that reason, and the
 * constants above are named so that the column-name join is a substring of them.
 */
function constraintName(err: PgError): string {
  const constraint = err.meta?.constraint;
  if (typeof constraint === 'string') return constraint;
  if (Array.isArray(constraint)) return constraint.join(',');
  const target = err.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return typeof err.message === 'string' ? err.message : '';
}

/**
 * The SQLSTATE Postgres reported, wherever Prisma happened to put it.
 *
 * There is a third place. When Prisma has no typed code for a constraint kind it
 * raises a `PrismaClientUnknownRequestError` whose `code` is `undefined` and
 * whose message is the raw connector text:
 *
 *   Error occurred during query execution:
 *   ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(
 *     PostgresError { code: "23514", message: "new row for relation \"cards\"
 *     violates check constraint \"cards_position_format\"", ... }) })
 *
 * The SQLSTATE is right there, one level of quoting down. Reading it is not
 * message-grepping in the sense this file warns against: `code: "23514"` is a
 * stable, machine-written field name and a numeric code, not a localised
 * sentence, and the constraint name it is matched against comes from the same
 * structure.
 */
function codeOf(err: PgError): string | null {
  if (typeof err.code === 'string') return err.code;
  if (typeof err.message !== 'string') return null;
  return /\bcode:\s*"([0-9A-Z]{5})"/.exec(err.message)?.[1] ?? null;
}

function hasCode(err: PgError, ...codes: string[]): boolean {
  const code = codeOf(err);
  return code !== null && codes.includes(code);
}

function matches(err: PgError, constraint?: string): boolean {
  if (constraint === undefined) return true;
  const name = constraintName(err);
  if (name.includes(constraint)) return true;
  // The column-name form: `meta.target` is ['list_id', 'position'], joined above
  // to 'list_id,position'. Prisma's own index name is
  // 'cards_list_id_position_key', so ask whether every column named appears in
  // the constraint being tested for. This is what makes a caller able to write
  // `isUniqueViolation(err, CARD_POSITION_UNIQUE)` and have it fire for a write
  // made through the typed client as well as through raw SQL.
  return name.length > 0 && name.split(',').every((part) => constraint.includes(part));
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PRISMA_UNIQUE_VIOLATION, PG_UNIQUE_VIOLATION) && matches(error, constraint);
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return (
    hasCode(error, PRISMA_FOREIGN_KEY_VIOLATION, PG_FOREIGN_KEY_VIOLATION) &&
    matches(error, constraint)
  );
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PG_CHECK_VIOLATION) && matches(error, constraint);
}

/** A write that expected an existing row and did not find one. */
export function isNotFound(err: unknown): boolean {
  const error = asError(err);
  return error !== null && hasCode(error, PRISMA_NOT_FOUND);
}

/**
 * A position collision, specifically.
 *
 * This is the predicate `moveCard()`'s retry loop is built on, and it is
 * deliberately narrower than `isUniqueViolation`. Retrying is only correct for a
 * position collision: re-jittering the key and trying again resolves it. Retrying
 * a duplicate board member, or a duplicate label name, would loop until the
 * attempt ceiling and then report a conflict the user could have been told about
 * immediately.
 */
export function isPositionCollision(err: unknown): boolean {
  return (
    isUniqueViolation(err, CARD_POSITION_UNIQUE) || isUniqueViolation(err, LIST_POSITION_UNIQUE)
  );
}

/**
 * Any violation that means "someone else got there first", as opposed to "the
 * request was malformed".
 *
 * The distinction matters at the HTTP boundary: the first is a 409 the user can
 * act on, the second is a 400. Collapsing them into a 500 is how a second person
 * joining a board becomes a support ticket.
 */
export function isConflict(err: unknown): boolean {
  return isUniqueViolation(err);
}
