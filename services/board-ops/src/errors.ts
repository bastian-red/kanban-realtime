/**
 * The failures a board operation can report.
 *
 * Typed codes, not messages, and the same set the socket protocol uses
 * (`errorCodeSchema` in packages/shared). That is the point: the REST controller
 * maps a code to an HTTP status and the gateway puts the same code in an ack, so
 * a client handles a stale move identically whichever transport it arrived on.
 * A service that threw prose would force each transport to invent its own
 * mapping, and they would disagree.
 */
import type { ErrorCode } from '@kan/shared';

export class BoardOpError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'BoardOpError';
    this.code = code;
  }
}

/** The reader's role does not allow this. Do not retry; tell the person. */
export const forbidden = (message: string): BoardOpError => new BoardOpError('FORBIDDEN', message);

/** The board, list or card is gone. The client should resync. */
export const notFound = (message: string): BoardOpError => new BoardOpError('NOT_FOUND', message);

/**
 * The card changed under the caller.
 *
 * The client's correct response is to refetch that card and *not* replay the
 * edit: replaying is how one person's title silently overwrites another's a
 * second time.
 */
export const stale = (message: string): BoardOpError => new BoardOpError('STALE', message);

/**
 * The ordering key could not be allocated within MOVE_RETRY_ATTEMPTS.
 *
 * Distinct from STALE on purpose. STALE means "your view was old"; CONFLICT means
 * "your view was fine and the database kept saying no", which under jittered keys
 * is rare enough to be worth surfacing as its own thing -- if it starts appearing
 * in logs, either the retry ceiling is too low or something is generating keys
 * without jitter.
 */
export const conflict = (message: string): BoardOpError => new BoardOpError('CONFLICT', message);

/** The request itself is wrong: a stale neighbour pair, a card from another board. */
export const invalid = (message: string): BoardOpError => new BoardOpError('INVALID', message);
