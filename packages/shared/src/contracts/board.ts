/**
 * The board, as it crosses the wire.
 *
 * These schemas are the contract between `apps/web`, `apps/api` and
 * `apps/realtime`. All three import them; none reaches into another's internals.
 * The API validates requests with them, the gateway validates socket payloads
 * with them, and the web app parses responses with them -- so a field renamed on
 * one side fails a typecheck on the other rather than rendering `undefined` in
 * production.
 *
 * The one shape worth reading twice is the **move intent**. A move is not "set
 * position to X": the client does not get to choose the key, because two clients
 * choosing at the same moment is the collision this project is about. The client
 * says which card, into which list, between which two neighbours; the server
 * computes the key. See `moveCardSchema` below.
 */
import { z } from 'zod';

import {
  boardNameSchema,
  boardRoleSchema,
  calendarDaySchema,
  cardTitleSchema,
  idSchema,
  instantSchema,
  listNameSchema,
  positionSchema,
  versionSchema,
  wipLimitSchema,
} from './primitives';

// --- Auth ------------------------------------------------------------------

export const credentialsSchema = z.object({
  email: z.string().email().max(320),
  // Length only. A composition rule ("one symbol, one digit") measurably pushes
  // people toward `Password1!`, and NIST 800-63B has recommended against them
  // since 2017. Length is the property that matters.
  password: z.string().min(10).max(200),
});

export const signupSchema = credentialsSchema.extend({
  name: z.string().min(1).max(120),
  timeZone: z.string().min(1).max(64).optional(),
});

export const sessionUserSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  name: z.string(),
  /**
   * The reader's zone, stored per user rather than read from the browser.
   *
   * "Is this card overdue?" is a question about the reader's calendar day, and
   * the server renders the board. A zone taken from the request would make the
   * same board show a different badge to the same person on their phone.
   */
  timeZone: z.string(),
});

// --- People on a board ------------------------------------------------------

export const memberSchema = z.object({
  userId: idSchema,
  name: z.string(),
  email: z.string().email(),
  role: boardRoleSchema,
  /**
   * Two initials, computed once on the server.
   *
   * Presence is not allowed to be colour alone, so every avatar carries initials
   * as well as a swatch. Computing them here rather than in the component means
   * the roster, the activity feed and the presence bar cannot disagree about what
   * a person's initials are.
   */
  initials: z.string().min(1).max(2),
});

export const addMemberSchema = z.object({
  email: z.string().email().max(320),
  role: boardRoleSchema,
});

export const updateMemberSchema = z.object({ role: boardRoleSchema });

// --- Cards and lists --------------------------------------------------------

export const labelSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  /**
   * An index into the board's palette, not a hex colour.
   *
   * A colour chosen by a user is a colour nobody checked against the background,
   * and this project's stylesheet is contrast-gated. A slot lets the palette stay
   * the stylesheet's business, and it lets dark mode pick a different value for
   * the same label without rewriting a row.
   */
  colorSlot: z.number().int().min(0).max(7),
});

export const cardSchema = z.object({
  id: idSchema,
  listId: idSchema,
  title: cardTitleSchema,
  description: z.string().max(4000).nullable(),
  position: positionSchema,
  version: versionSchema,
  dueOn: calendarDaySchema.nullable(),
  assigneeId: idSchema.nullable(),
  labels: z.array(labelSchema),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});

/**
 * The WIP state of a list, as a machine value **and** the words for it.
 *
 * The words travel with the state on purpose. Colour is never the only channel
 * in this project, and "at limit 5/5" has to read identically in the column
 * header, in a screen reader and in the socket broadcast. A client that derived
 * its own wording from `state` would be a second implementation of the rule, and
 * the first one to drift renders a limit nobody can see.
 *
 * `none` is a real state, not a null: a list with no limit shows a plain count.
 */
export const wipSchema = z.object({
  state: z.enum(['none', 'under', 'at', 'over']),
  label: z.string().min(1),
});

export type WipState = z.infer<typeof wipSchema>['state'];

/**
 * How full a list is against its limit, as a state **and** the word for it.
 *
 * It lives here, beside the schema it produces, rather than in
 * `services/board-ops` where it started, because three places need the same
 * answer and only one of them is a server: the read path computes it for the
 * board payload, the gateway computes it for the `list.created` broadcast, and
 * the web app recomputes it while a drag is still in flight -- an optimistic move
 * changes a column's count before any server has said so, and a header that only
 * updates on the ack reads as a lag the product does not have.
 *
 * A client that derived its own wording from `state` would be a second
 * implementation of this rule, and the first one to drift renders a limit nobody
 * can see. `services/board-ops` re-exports this so its existing callers are
 * unchanged.
 */
export function wipStateFor(count: number, limit: number | null): z.infer<typeof wipSchema> {
  if (limit === null) return { state: 'none', label: `${count} cards` };
  if (count > limit) return { state: 'over', label: `Over limit ${count}/${limit}` };
  if (count === limit) return { state: 'at', label: `At limit ${count}/${limit}` };
  return { state: 'under', label: `${count}/${limit}` };
}

/**
 * A list without its cards.
 *
 * This is the shape the `list.created` and `list.updated` broadcasts carry, and
 * the reason is a race rather than bandwidth. A rename is a write about the
 * column header; if the broadcast shipped `cards` too, every other client would
 * replace its card array with whatever the renaming process happened to read --
 * which is a snapshot from before the drag that landed a millisecond earlier.
 * The rename would silently undo the move on every screen but the mover's.
 *
 * A newly created list has no cards by construction, so the same shape serves
 * both events, and neither can carry a card array that is already stale.
 */
export const listHeaderSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  name: listNameSchema,
  position: positionSchema,
  wipLimit: wipLimitSchema,
  /** Computed by `wipStateFor` in services/board-ops, never by the client. */
  wip: wipSchema,
});

export const listSchema = listHeaderSchema.extend({
  /** Ordered by `position`, ascending. The server sorts; the client never re-sorts. */
  cards: z.array(cardSchema),
});

export const boardSummarySchema = z.object({
  id: idSchema,
  name: boardNameSchema,
  role: boardRoleSchema,
  memberCount: z.number().int().nonnegative(),
  cardCount: z.number().int().nonnegative(),
  updatedAt: instantSchema,
});

/**
 * A whole board in one payload.
 *
 * This is what `GET /boards/:id` returns and what the gateway sends as
 * `board.state` on join, and it is deliberately the same schema for both. A
 * client that reconnects mid-session replaces its state wholesale rather than
 * trying to reconcile a diff against a stale tree, and having one shape means the
 * page that was server-rendered and the page that just resynced are byte-for-byte
 * the same kind of object.
 */
export const boardSchema = z.object({
  id: idSchema,
  name: boardNameSchema,
  /** The reader's own role, so the UI knows what to offer before it renders. */
  role: boardRoleSchema,
  lists: z.array(listSchema),
  members: z.array(memberSchema),
  /**
   * Every label this board defines, not only the ones currently in use.
   *
   * The cards carry their own labels, so this looks redundant until you try to
   * render a picker: a label nobody has applied yet appears on no card, and a
   * client that derived the set from the cards could never offer it. It is also
   * what makes `labelIds` on a write usable without a second round trip.
   */
  labels: z.array(labelSchema),
  updatedAt: instantSchema,
});

export const createBoardSchema = z.object({ name: boardNameSchema });
export const renameBoardSchema = z.object({ name: boardNameSchema });

export const createListSchema = z.object({
  name: listNameSchema,
  wipLimit: wipLimitSchema.optional(),
  /**
   * Where to put it, as neighbours rather than as a key. Same reasoning as
   * `moveCardSchema`: the server owns the ordering key.
   */
  afterListId: idSchema.nullable().optional(),
});

export const updateListSchema = z.object({
  name: listNameSchema.optional(),
  wipLimit: wipLimitSchema.optional(),
});

export const createCardSchema = z.object({
  listId: idSchema,
  title: cardTitleSchema,
  description: z.string().max(4000).nullable().optional(),
  dueOn: calendarDaySchema.nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
  labelIds: z.array(idSchema).max(8).optional(),
  afterCardId: idSchema.nullable().optional(),
});

/**
 * Editing a card's content.
 *
 * `expectedVersion` is required, not optional. An optional lock is not a lock:
 * the first caller that forgets it silently gets last-write-wins, and it is
 * always the caller written in a hurry. Position is absent on purpose -- moving
 * is a different operation with different conflict rules, and mixing the two
 * would let a title edit reorder the board.
 */
/**
 * Archiving a card, which is a write like any other and takes the same lock.
 *
 * A body with one field rather than a bare `POST`, because "archive the card I
 * was looking at" and "archive whatever that card has become" are different
 * requests. Somebody else may have moved it to Done and renamed it since the
 * button was rendered.
 */
export const archiveCardSchema = z.object({ expectedVersion: versionSchema });

export const updateCardSchema = z.object({
  expectedVersion: versionSchema,
  title: cardTitleSchema.optional(),
  description: z.string().max(4000).nullable().optional(),
  dueOn: calendarDaySchema.nullable().optional(),
  assigneeId: idSchema.nullable().optional(),
  labelIds: z.array(idSchema).max(8).optional(),
});

/**
 * A move, expressed as an intent.
 *
 * The client sends the destination as **neighbours**, never as a computed
 * position:
 *
 *   { cardId, toListId, afterCardId: 'c3', beforeCardId: 'c7' }
 *
 * A client that computed its own key would produce exactly the same key as the
 * other client dropping into the same gap at the same moment -- fractional
 * indexing is deterministic -- and the two would collide on
 * `UNIQUE (list_id, position)`. With the intent, the server generates a
 * *jittered* key per request, so two simultaneous drops into one gap get two
 * different keys and both survive. See `services/ordering`.
 *
 * Both neighbours are nullable and both are sent. `afterCardId: null` means the
 * top of the list, `beforeCardId: null` the bottom; sending both lets the server
 * detect that the client's view of the list is stale (the two cards are no longer
 * adjacent) instead of trusting it.
 */
export const moveCardSchema = z.object({
  expectedVersion: versionSchema,
  toListId: idSchema,
  afterCardId: idSchema.nullable(),
  beforeCardId: idSchema.nullable(),
});

export const moveListSchema = z.object({
  afterListId: idSchema.nullable(),
  beforeListId: idSchema.nullable(),
});

// --- Activity ---------------------------------------------------------------

/**
 * What happened, as a closed set.
 *
 * A free-text `action` column would make the feed unreadable by anything but a
 * human, and the UI needs to render an icon and a sentence per type. Adding a
 * type here is a deliberate act that fails a typecheck everywhere it must be
 * handled.
 */
export const activityTypeSchema = z.enum([
  'board.created',
  'board.renamed',
  'member.added',
  'member.role_changed',
  'member.removed',
  'list.created',
  'list.renamed',
  'list.moved',
  'list.archived',
  'card.created',
  'card.updated',
  'card.moved',
  'card.archived',
]);

export const activitySchema = z.object({
  id: idSchema,
  boardId: idSchema,
  type: activityTypeSchema,
  actorId: idSchema,
  actorName: z.string(),
  /**
   * The human-readable subject, denormalised at write time.
   *
   * "Ana moved **Fix login** to Doing" has to keep saying "Fix login" after the
   * card is renamed or archived: the feed is a record of what happened, not a
   * live join. Storing the title at the moment of the event is what makes the
   * history immutable, and it is why archiving a card does not blank its rows.
   */
  subject: z.string().max(200),
  detail: z.string().max(200).nullable(),
  createdAt: instantSchema,
});

export const activityQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const activityPageSchema = z.object({
  items: z.array(activitySchema),
  nextCursor: z.string().nullable(),
});

// --- Inferred types ---------------------------------------------------------

export type Credentials = z.infer<typeof credentialsSchema>;
export type Signup = z.infer<typeof signupSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type Member = z.infer<typeof memberSchema>;
export type AddMember = z.infer<typeof addMemberSchema>;
export type UpdateMember = z.infer<typeof updateMemberSchema>;
export type Label = z.infer<typeof labelSchema>;
export type Card = z.infer<typeof cardSchema>;
export type ListHeader = z.infer<typeof listHeaderSchema>;
export type List = z.infer<typeof listSchema>;
export type Wip = z.infer<typeof wipSchema>;
export type Board = z.infer<typeof boardSchema>;
export type BoardSummary = z.infer<typeof boardSummarySchema>;
export type CreateBoard = z.infer<typeof createBoardSchema>;
export type RenameBoard = z.infer<typeof renameBoardSchema>;
export type CreateList = z.infer<typeof createListSchema>;
export type UpdateList = z.infer<typeof updateListSchema>;
export type CreateCard = z.infer<typeof createCardSchema>;
export type UpdateCard = z.infer<typeof updateCardSchema>;
export type ArchiveCard = z.infer<typeof archiveCardSchema>;
export type MoveCard = z.infer<typeof moveCardSchema>;
export type MoveList = z.infer<typeof moveListSchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;
export type ActivityPage = z.infer<typeof activityPageSchema>;
