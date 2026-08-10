/**
 * One shape for every client event: rate limit, parse, run, acknowledge.
 *
 * Socket.io acks are the transport's own request/response, and the protocol says
 * every client event is acknowledged (`packages/shared/src/contracts/events.ts`).
 * A fire-and-forget mutation has nowhere to report `STALE` or `FORBIDDEN`, and
 * the client applies a drag optimistically and reconciles against the ack -- so
 * an unacknowledged event is a card that stays where the user dropped it whether
 * or not the server agreed.
 *
 * This file exists so that is arranged once rather than eleven times. It is also
 * the only part of the gateway's request path that can be tested without a socket
 * server, which is why the interesting decisions live here rather than in the
 * handlers:
 *
 * - **Refusals come before work.** The rate limiter is checked before the payload
 *   is parsed and long before the database is touched, because the point of a
 *   limit is to not do the work.
 * - **Failures are typed codes, never prose.** `STALE` drives a refetch,
 *   `FORBIDDEN` an explanation, `RATE_LIMITED` a backoff. A client matching on
 *   messages breaks the first time a message improves.
 * - **An unknown error never leaves the process.** Anything that is not a
 *   `BoardOpError` becomes `INTERNAL` with a fixed message, and the real one goes
 *   to the log. A Prisma error text can carry a connection string.
 * - **A missing ack is not silence.** Socket.io only passes a callback if the
 *   client sent one. When it did not, the failure is emitted as `server.error` on
 *   that socket, so a client that forgot to ack still learns it was refused
 *   rather than watching nothing happen.
 */
import { BoardOpError } from '@kan/board-ops';
import { SERVER_EVENTS, type Ack, type ErrorCode, type SocketError } from '@kan/shared';
import type { z } from 'zod';

import type { SocketRateLimiter } from './rate-limit';

/** The subset of a Socket.io socket this module needs. Keeps the tests honest. */
export interface AckSocket {
  emit(event: string, payload: unknown): unknown;
}

export type AckCallback = (response: Ack<unknown>) => void;

export interface DispatchDeps {
  limiter: SocketRateLimiter;
  socket: AckSocket;
  /** Called with the untyped cause of an INTERNAL. Never sent to the client. */
  onInternal: (event: string, error: unknown) => void;
}

/**
 * Wrap one event handler.
 *
 * The returned function is what goes into `socket.on(...)`. It takes whatever the
 * client sent and an optional ack, and it never throws: a handler that threw into
 * Socket.io's emitter would take down the connection for an error the protocol
 * has a code for.
 */
export function handler<Schema extends z.ZodTypeAny, Result>(
  event: string,
  schema: Schema,
  deps: DispatchDeps,
  run: (payload: z.infer<Schema>) => Promise<Result>,
): (raw: unknown, ack?: AckCallback) => Promise<void> {
  return async (raw: unknown, ack?: AckCallback): Promise<void> => {
    if (!deps.limiter.take()) {
      respond(deps, event, ack, {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many events on this connection. Slow down and try again.',
          event,
        },
      });
      return;
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      respond(deps, event, ack, {
        ok: false,
        // The zod issues are deliberately not forwarded. `INVALID` means a bug in
        // the client, and the client's own copy of the schema says which field --
        // it parses the same module. Shipping the issue list would make the
        // server's internal field names part of the wire contract.
        error: { code: 'INVALID', message: 'That request was not in the expected shape.', event },
      });
      return;
    }

    try {
      const data = await run(parsed.data as z.infer<Schema>);
      respond(deps, event, ack, { ok: true, data: data ?? {} });
    } catch (error) {
      respond(deps, event, ack, { ok: false, error: toSocketError(event, error, deps) });
    }
  };
}

/**
 * A thrown error as a typed refusal.
 *
 * `BoardOpError` already carries the code, and it is the same `ErrorCode` union
 * the REST filter maps to HTTP statuses -- which is the point of the domain layer
 * throwing codes rather than framework exceptions. Everything else is `INTERNAL`,
 * with a message that says nothing.
 */
export function toSocketError(event: string, error: unknown, deps: DispatchDeps): SocketError {
  if (error instanceof BoardOpError) {
    return { code: error.code satisfies ErrorCode, message: error.message, event };
  }
  deps.onInternal(event, error);
  return { code: 'INTERNAL', message: 'Something went wrong handling that.', event };
}

function respond(
  deps: DispatchDeps,
  event: string,
  ack: AckCallback | undefined,
  response: Ack<unknown>,
): void {
  if (ack) {
    ack(response);
    return;
  }
  // No callback came with the event. A success needs no announcement -- the
  // broadcast is the result -- but a refusal that nobody hears is a client stuck
  // showing an optimistic change the server rejected.
  if (!response.ok) deps.socket.emit(SERVER_EVENTS.error, response.error);
}
