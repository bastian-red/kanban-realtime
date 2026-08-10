/**
 * The socket protocol.
 *
 * One schema per event, imported by the client, the gateway and the tests. There
 * are no hand-written duplicates anywhere: `eslint.config.mjs` has a rule that
 * fails a string literal matching an event name inside `e2e/**`, precisely so a
 * spec cannot quietly wait for `'card.move'` after the gateway started emitting
 * `'card.moved'`. That spec would hang until the timeout and report "the board
 * did not update", which is a sentence about the product and a lie about the
 * cause.
 *
 * Three shapes hold across the whole protocol:
 *
 * 1. **Every client event is acknowledged.** Socket.io acks are the transport's
 *    own request/response, and a fire-and-forget mutation has nowhere to report
 *    `STALE` or `FORBIDDEN`. The client applies the move optimistically and
 *    reconciles against the ack; without one it can only guess.
 * 2. **The server never echoes an intent, only a result.** The client asks to put
 *    a card between two neighbours; the broadcast carries the authoritative
 *    position the server generated. If the two disagree the client takes the
 *    server's, which is what makes convergence a property rather than a hope.
 * 3. **Failures are typed codes, not messages.** `STALE` drives a refetch,
 *    `FORBIDDEN` an explanation, `RATE_LIMITED` a backoff. A client that has to
 *    match on prose to tell them apart breaks the first time the prose improves.
 */
import { z } from 'zod';

import {
  activitySchema,
  boardSchema,
  cardSchema,
  listHeaderSchema,
  listSchema,
  memberSchema,
  moveCardSchema,
  moveListSchema,
  updateCardSchema,
} from './board';
import { boardNameSchema, idSchema, instantSchema, listNameSchema } from './primitives';

/**
 * Event names, as constants.
 *
 * `as const` and exported, so `socket.on(SERVER_EVENTS.cardMoved, ...)` is a
 * typo-proof reference and a rename is a compiler error rather than a silent
 * no-op. A socket listener for an event nobody emits is the quietest bug in this
 * whole codebase: nothing throws, nothing logs, the board just stops moving.
 */
export const CLIENT_EVENTS = {
  boardJoin: 'board.join',
  boardLeave: 'board.leave',
  listCreate: 'list.create',
  listRename: 'list.rename',
  listMove: 'list.move',
  listArchive: 'list.archive',
  cardCreate: 'card.create',
  cardUpdate: 'card.update',
  cardMove: 'card.move',
  cardArchive: 'card.archive',
  presencePing: 'presence.ping',
} as const;

export const SERVER_EVENTS = {
  boardState: 'board.state',
  // Renaming a board is a REST call, not a socket one -- there is no
  // `board.rename` in CLIENT_EVENTS, because it happens on the boards list where
  // no socket is open. It still has to reach everybody who has the board open,
  // which is what makes this the one event only `apps/api` ever emits, through
  // the Redis emitter rather than through a Socket.io server it does not run.
  boardRenamed: 'board.renamed',
  listCreated: 'list.created',
  listUpdated: 'list.updated',
  listMoved: 'list.moved',
  listArchived: 'list.archived',
  cardCreated: 'card.created',
  cardUpdated: 'card.updated',
  cardMoved: 'card.moved',
  cardArchived: 'card.archived',
  memberChanged: 'member.changed',
  activityAppended: 'activity.appended',
  presenceChanged: 'presence.changed',
  // `server.error`, not the bare `error`. Two reasons, both concrete:
  //
  //   - Socket.io gives `error` its own meaning on the manager and around the
  //     connection lifecycle, so a custom event by that name is a name shared
  //     with the library. It works until it does not, and when it does not the
  //     symptom is an error handler that fires for something that was never an
  //     application error.
  //   - Every other event here is `subject.verb`. The gateway's per-socket rate
  //     limiter and the eslint rule that keeps literals out of e2e/ both key off
  //     that shape, and one exception is an exception each of them has to carry.
  error: 'server.error',
} as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];
export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

// --- Failures ---------------------------------------------------------------

/**
 * Why a request was refused, as a closed set the client can branch on.
 *
 * - `STALE`        the card changed under you. Refetch that card, replay nothing.
 * - `FORBIDDEN`    your role does not allow this. Do not retry; tell the person.
 * - `NOT_FOUND`    the card, list or board is gone. Resync the board.
 * - `INVALID`      the payload failed its schema. A bug in the client, not a race.
 * - `CONFLICT`     the ordering key could not be allocated within
 *                  MOVE_RETRY_ATTEMPTS. Genuinely rare; a retry is reasonable.
 * - `RATE_LIMITED` too many events on this socket. Back off.
 * - `INTERNAL`     everything else. The only code that is allowed to be vague,
 *                  and the only one whose message is not shown to the user.
 */
export const errorCodeSchema = z.enum([
  'STALE',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const socketErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  /** Which event failed, so a client with several in flight can tell them apart. */
  event: z.string().optional(),
});

/**
 * The ack envelope.
 *
 * A discriminated union on `ok` rather than "data is present or an error is": the
 * union makes the failure branch impossible to forget, because TypeScript will
 * not let the success field be read until `ok` has been checked.
 */
export function ackSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: socketErrorSchema }),
  ]);
}

/** The ack for an event whose success carries nothing but the fact of it. */
export const emptyAckSchema = ackSchema(z.object({}).strict());

export type Ack<T> =
  { ok: true; data: T } | { ok: false; error: z.infer<typeof socketErrorSchema> };

// --- Handshake --------------------------------------------------------------

/**
 * What the client puts in `io(url, { auth })`.
 *
 * The token is the same HS256 service token the REST client carries, minted by
 * the web app for the signed-in session (`apps/web/lib/service-token.ts`). One
 * secret, three verifiers: the web app mints, the API and the gateway check. That
 * is why AUTH_SECRET is not optional in `scripts/dev.sh` -- a missing one does not
 * merely break sign-in, it makes every socket handshake fail, which presents as a
 * board that renders and never moves.
 */
export const handshakeAuthSchema = z.object({
  token: z.string().min(1),
});

// --- Client -> server payloads ---------------------------------------------

export const boardJoinSchema = z.object({ boardId: idSchema });
export const boardLeaveSchema = z.object({ boardId: idSchema });

export const listCreatePayloadSchema = z.object({
  boardId: idSchema,
  name: listNameSchema,
  afterListId: idSchema.nullable().optional(),
});

export const listRenamePayloadSchema = z.object({
  boardId: idSchema,
  listId: idSchema,
  name: listNameSchema,
});

export const listMovePayloadSchema = moveListSchema.extend({
  boardId: idSchema,
  listId: idSchema,
});

export const listArchivePayloadSchema = z.object({
  boardId: idSchema,
  listId: idSchema,
});

export const cardCreatePayloadSchema = z.object({
  boardId: idSchema,
  listId: idSchema,
  title: z.string().min(1).max(200),
  afterCardId: idSchema.nullable().optional(),
});

export const cardUpdatePayloadSchema = updateCardSchema.extend({
  boardId: idSchema,
  cardId: idSchema,
});

export const cardMovePayloadSchema = moveCardSchema.extend({
  boardId: idSchema,
  cardId: idSchema,
});

export const cardArchivePayloadSchema = z.object({
  boardId: idSchema,
  cardId: idSchema,
  expectedVersion: z.number().int().min(0),
});

/**
 * The presence heartbeat.
 *
 * Carries the board rather than relying on the socket's rooms, because a socket
 * can be in several boards at once (two tabs, one connection is not the case
 * today, but a browser that reuses one socket for two boards is a supported
 * shape) and a heartbeat has to say which roster it refreshes.
 */
export const presencePingPayloadSchema = z.object({
  boardId: idSchema,
  /**
   * What the person is doing, for the presence chip's *word*.
   *
   * Presence cannot be colour alone, and "who is here" is less useful than "who
   * is here and doing something". `dragging` is set while a pointer or keyboard
   * drag is in flight, which is what lets another reader see "Ana, moving a card"
   * rather than a swatch that means nothing.
   */
  activity: z.enum(['viewing', 'editing', 'dragging']).default('viewing'),
});

// --- Server -> client payloads ---------------------------------------------

/** The whole board. Same schema as `GET /boards/:id`; see the note in board.ts. */
export const boardStateSchema = boardSchema;

/**
 * Both carry a list **header**, not a list with its cards.
 *
 * See `listHeaderSchema`. Shipping `cards` on a rename would let the renaming
 * process's snapshot overwrite everyone else's card array, silently undoing a
 * drag that landed a millisecond earlier on every screen but the mover's.
 */
export const listCreatedSchema = z.object({ list: listHeaderSchema });
export const listUpdatedSchema = z.object({ list: listHeaderSchema });
export const listMovedSchema = z.object({
  listId: idSchema,
  position: listSchema.shape.position,
});
export const listArchivedSchema = z.object({ listId: idSchema });

export const cardCreatedSchema = z.object({ card: cardSchema });
export const cardUpdatedSchema = z.object({ card: cardSchema });

/**
 * The authoritative result of a move.
 *
 * Carries `fromListId` as well as the destination because the receiving client
 * has to remove the card from wherever it currently thinks it is, which may not
 * be where the mover thought it was either. Carries the new `version` so a client
 * that had the card open can keep editing without a round trip, and carries the
 * server-generated `position` -- never the one the client hoped for.
 */
export const cardMovedSchema = z.object({
  cardId: idSchema,
  fromListId: idSchema,
  toListId: idSchema,
  position: cardSchema.shape.position,
  version: cardSchema.shape.version,
  movedAt: instantSchema,
});

export const cardArchivedSchema = z.object({
  cardId: idSchema,
  listId: idSchema,
});

export const memberChangedSchema = z.object({
  boardId: idSchema,
  members: z.array(memberSchema),
});

export const boardRenamedSchema = z.object({
  boardId: idSchema,
  name: boardNameSchema,
});

export const activityAppendedSchema = z.object({ activity: activitySchema });

/**
 * Who is on the board right now.
 *
 * The whole roster, not a join/leave delta. A roster of at most a few dozen
 * people is a handful of bytes, and a client that missed one delta while its tab
 * was backgrounded would otherwise show a ghost forever. Sending the state rather
 * than the transition makes reconnection free.
 */
export const presenceMemberSchema = z.object({
  userId: idSchema,
  name: z.string(),
  initials: z.string().min(1).max(2),
  /** A slot in the board's presence palette, not a colour. Same reason as labels. */
  colorSlot: z.number().int().min(0).max(7),
  activity: z.enum(['viewing', 'editing', 'dragging']),
  /** How many sockets this person has open. Two tabs is one person, not two. */
  connections: z.number().int().positive(),
  lastSeenAt: instantSchema,
});

export const presenceChangedSchema = z.object({
  boardId: idSchema,
  members: z.array(presenceMemberSchema),
});

// --- Inferred types ---------------------------------------------------------

export type SocketError = z.infer<typeof socketErrorSchema>;
export type HandshakeAuth = z.infer<typeof handshakeAuthSchema>;
export type BoardJoin = z.infer<typeof boardJoinSchema>;
export type BoardLeave = z.infer<typeof boardLeaveSchema>;
export type ListCreatePayload = z.infer<typeof listCreatePayloadSchema>;
export type ListRenamePayload = z.infer<typeof listRenamePayloadSchema>;
export type ListMovePayload = z.infer<typeof listMovePayloadSchema>;
export type ListArchivePayload = z.infer<typeof listArchivePayloadSchema>;
export type CardCreatePayload = z.infer<typeof cardCreatePayloadSchema>;
export type CardUpdatePayload = z.infer<typeof cardUpdatePayloadSchema>;
export type CardMovePayload = z.infer<typeof cardMovePayloadSchema>;
export type CardArchivePayload = z.infer<typeof cardArchivePayloadSchema>;
export type PresencePingPayload = z.infer<typeof presencePingPayloadSchema>;
export type BoardState = z.infer<typeof boardStateSchema>;
export type ListCreated = z.infer<typeof listCreatedSchema>;
export type ListUpdated = z.infer<typeof listUpdatedSchema>;
export type ListMoved = z.infer<typeof listMovedSchema>;
export type ListArchived = z.infer<typeof listArchivedSchema>;
export type CardCreated = z.infer<typeof cardCreatedSchema>;
export type CardUpdated = z.infer<typeof cardUpdatedSchema>;
export type CardMoved = z.infer<typeof cardMovedSchema>;
export type CardArchived = z.infer<typeof cardArchivedSchema>;
export type MemberChanged = z.infer<typeof memberChangedSchema>;
export type BoardRenamed = z.infer<typeof boardRenamedSchema>;
export type ActivityAppended = z.infer<typeof activityAppendedSchema>;
export type PresenceMember = z.infer<typeof presenceMemberSchema>;
export type PresenceChanged = z.infer<typeof presenceChangedSchema>;
export type PresenceActivity = PresenceMember['activity'];
