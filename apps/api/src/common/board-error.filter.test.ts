import { BoardOpError } from '@kan/board-ops';
import { type ArgumentsHost, Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { BoardErrorFilter, type BoardErrorBody } from './board-error.filter';

function capture(): {
  host: ArgumentsHost;
  status: () => number | undefined;
  body: () => BoardErrorBody | undefined;
} {
  let status: number | undefined;
  let body: BoardErrorBody | undefined;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: BoardErrorBody) {
      body = payload;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, status: () => status, body: () => body };
}

describe('BoardErrorFilter', () => {
  it.each([
    ['STALE', 409],
    ['CONFLICT', 409],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['INVALID', 400],
    ['RATE_LIMITED', 429],
  ] as const)('maps %s to %i', (code, expected) => {
    const { host, status } = capture();
    new BoardErrorFilter().catch(new BoardOpError(code, 'because'), host);
    expect(status()).toBe(expected);
  });

  it('sends the code in the body, not only the status', () => {
    // STALE and CONFLICT share a 409, and they mean different things to a client:
    // one says refetch that card, the other says the write genuinely could not be
    // placed. Without the code in the body the client would have to match on
    // prose to tell them apart.
    const { host, body } = capture();
    new BoardErrorFilter().catch(new BoardOpError('STALE', 'Card changed'), host);
    expect(body()).toEqual({ code: 'STALE', message: 'Card changed' });
  });

  it('withholds the message of an INTERNAL error', () => {
    // The only code whose message is written for us rather than for the person
    // who triggered it. Everything else is a sentence somebody is meant to read.
    //
    // The logger is silenced for this one case. It is doing its job -- a 500 must
    // be logged in full -- but a red stack trace in the middle of a passing suite
    // reads as a failure, and a test output nobody trusts is a test output nobody
    // reads.
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { host, status, body } = capture();
    new BoardErrorFilter().catch(new BoardOpError('INTERNAL', 'connection string: secret'), host);
    expect(status()).toBe(500);
    expect(body()?.message).toBe('Something went wrong.');
    expect(body()?.message).not.toContain('secret');
    expect(body()?.code).toBe('INTERNAL');
    // And it IS logged: withholding it from the client must not mean losing it.
    expect(logged).toHaveBeenCalledWith('connection string: secret', expect.any(String));
    logged.mockRestore();
  });
});
