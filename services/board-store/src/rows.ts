/**
 * The shape `$queryRaw` returns, and the conversion back to the port's rows.
 *
 * Separated from the repository because this is the only part of a database
 * adapter that can be tested without a database, and it is also the part that has
 * been wrong: raw SQL bypasses Prisma's `@map`, so the columns come back
 * snake_cased and untyped, and a field renamed in `schema.prisma` changes nothing
 * here until a query returns `undefined` several layers away.
 */
import type { CardRow, ListRow } from '@kan/board-ops';

export interface RawCard {
  id: string;
  list_id: string;
  title: string;
  description: string | null;
  position: string;
  version: number | bigint;
  due_on: Date | null;
  assignee_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RawList {
  id: string;
  board_id: string;
  name: string;
  position: string;
  wip_limit: number | bigint | null;
  archived_at: Date | null;
}

/**
 * `version` is normalised through `Number` rather than passed along.
 *
 * It is an `int4` today and comes back as a JS number, so this looks redundant.
 * It is not: a raw query against a `bigint` column hands back a `BigInt`, and
 * `10n === 10` is `false`. The optimistic lock compares this value against
 * `expectedVersion`, so widening the column would make every version check fail
 * silently -- every edit rejected as STALE, with nothing in the schema diff to
 * suggest why. One `Number()` makes the column type a free choice.
 */
export const toCardRow = (row: RawCard): CardRow => ({
  id: row.id,
  listId: row.list_id,
  title: row.title,
  description: row.description,
  position: row.position,
  version: Number(row.version),
  dueOn: row.due_on,
  assigneeId: row.assignee_id,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toListRow = (row: RawList): ListRow => ({
  id: row.id,
  boardId: row.board_id,
  name: row.name,
  position: row.position,
  // Same reasoning as `version`, plus one of its own: `null` must survive as
  // `null`. `Number(null)` is 0, and a WIP limit of 0 is a list nothing may enter
  // -- the exact state the CHECK constraint refuses and the product uses
  // archiving for. The explicit null branch is what keeps "no limit" from
  // becoming "limit zero".
  wipLimit: row.wip_limit === null ? null : Number(row.wip_limit),
  archivedAt: row.archived_at,
});
