/**
 * The values every other contract is built from.
 *
 * Kept in their own module because both the REST DTOs and the socket protocol
 * import them, and a shape defined twice is a shape that drifts. A card's
 * `position` in particular has to mean the same thing to a `PATCH` body and to a
 * `card.moved` broadcast, or the client reconciling one against the other will
 * disagree with itself.
 */
import { z } from 'zod';

import { day, type CalendarDay } from '../time/day';

/** A cuid from the database. Never parsed for structure, only for presence. */
export const idSchema = z.string().min(1).max(64);

/**
 * `YYYY-MM-DD`, parsed into the branded `CalendarDay`.
 *
 * The brand is produced **here**, at the boundary that validates it, rather than
 * cast at each call site. That is the whole point of a brand: `CalendarDay` means
 * "this string has been checked", and a `value as CalendarDay` sprinkled through
 * the API and the board component is a claim nobody verified. Parsing once and
 * carrying the type means `Card['dueOn']` is `CalendarDay | null` everywhere, and
 * `dueFor(card.dueOn, today)` needs no cast in either process.
 *
 * `day()` rather than the regex alone, because the regex is the cheap half: it
 * accepts `2026-02-31` and `2026-13-01`, and a due date of 31 February reaching a
 * `date` column is a write Postgres refuses several layers from here.
 */
export const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar day, YYYY-MM-DD')
  .refine((value) => {
    try {
      day(value);
      return true;
    } catch {
      return false;
    }
  }, 'That day does not exist in that month')
  .transform((value): CalendarDay => day(value));

/**
 * A fractional index: the ordering key of a card inside a list, or of a list
 * inside a board.
 *
 * This is a **string**, and the constraint below is the contract's whole point.
 * Fractional indexing (services/ordering) works by finding a key that sorts
 * between two others -- `a0` and `a1` have `a0V` between them -- which is only
 * possible in a densely ordered set. Integers are not densely ordered, so an
 * integer `position` forces a renumber of every following row on each insert, and
 * two clients renumbering at once is exactly the conflict this project exists to
 * avoid.
 *
 * Base62 and non-empty, matching the `CHECK (position ~ '^[a-zA-Z0-9]+$')` in the
 * `board_invariants` migration. An empty or malformed key does not error: it
 * sorts first or last and silently degrades the board to insertion order, which
 * is the failure nobody notices until a card is in the wrong place.
 *
 * The 200-character ceiling is not arbitrary either. Keys grow by about one
 * character each time a card is dropped into the same gap, so a pathological
 * insert loop grows them without bound; at 200 the ordering is still correct but
 * something is wrong upstream, and a bounded column is better than an unbounded
 * one in a hot index.
 */
export const positionSchema = z
  .string()
  .min(1, 'A position may not be empty: an empty key silently sorts first')
  .max(200)
  .regex(/^[a-zA-Z0-9]+$/, 'A position is a base62 fractional index, not a number');

/**
 * The optimistic-lock counter on a card.
 *
 * Every mutation carries the version the client believes it is editing. The
 * server rejects a mismatch with `STALE` rather than overwriting, which is what
 * stops two people editing one card's title from silently losing a change --
 * something fractional indexing has nothing to say about, because both edits
 * target the same row rather than competing for a gap between rows.
 */
export const versionSchema = z.number().int().min(0);

export const boardRoleSchema = z.enum(['OWNER', 'EDITOR', 'VIEWER']);

/** An ISO 8601 instant, as JSON carries it. Activity happens at a moment. */
export const instantSchema = z.string().datetime({ offset: true });

export const cardTitleSchema = z.string().min(1).max(200);
export const listNameSchema = z.string().min(1).max(80);
export const boardNameSchema = z.string().min(1).max(120);

/**
 * A work-in-progress limit on a list.
 *
 * Nullable for "no limit", and strictly positive when set: a limit of zero means
 * a list nothing may enter, which is not a limit, it is a closed list, and the
 * product has archiving for that. Mirrored by
 * `CHECK (wip_limit IS NULL OR wip_limit > 0)` in the schema, because a client
 * check is a suggestion.
 */
export const wipLimitSchema = z.number().int().positive().max(999).nullable();
