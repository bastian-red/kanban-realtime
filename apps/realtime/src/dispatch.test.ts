import { BoardOpError, forbidden, stale } from '@kan/board-ops';
import { SERVER_EVENTS, ackSchema, socketErrorSchema, type Ack } from '@kan/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { handler, type AckSocket, type DispatchDeps } from './dispatch';
import { SocketRateLimiter } from './rate-limit';

const EVENT = 'card.move';
const payloadSchema = z.object({ cardId: z.string().min(1) });

function deps(
  limit = 100,
): DispatchDeps & { emitted: Array<[string, unknown]>; internals: unknown[] } {
  const emitted: Array<[string, unknown]> = [];
  const internals: unknown[] = [];
  const socket: AckSocket = {
    emit: (event, payload) => {
      emitted.push([event, payload]);
      return true;
    },
  };
  return {
    limiter: new SocketRateLimiter({ limit }),
    socket,
    onInternal: (_event, error) => internals.push(error),
    emitted,
    internals,
  };
}

/** Collects the ack the handler produced. */
function collector(): { ack: (response: Ack<unknown>) => void; responses: Array<Ack<unknown>> } {
  const responses: Array<Ack<unknown>> = [];
  return { ack: (response) => responses.push(response), responses };
}

describe('handler', () => {
  it('acknowledges success with the handler’s result', async () => {
    const d = deps();
    const { ack, responses } = collector();
    const run = handler(EVENT, payloadSchema, d, async (payload) => ({ moved: payload.cardId }));

    await run({ cardId: 'card-1' }, ack);

    expect(responses).toEqual([{ ok: true, data: { moved: 'card-1' } }]);
  });

  it('acknowledges a result-less handler with an empty object', async () => {
    // `emptyAckSchema` is `{ ok: true, data: {} }` and is `.strict()`. A handler
    // returning undefined would ack `{ ok: true, data: undefined }`, which fails
    // that schema on the client and throws inside its own ack callback.
    const d = deps();
    const { ack, responses } = collector();
    const run = handler(EVENT, payloadSchema, d, async () => undefined);

    await run({ cardId: 'card-1' }, ack);

    expect(responses[0]).toEqual({ ok: true, data: {} });
    expect(ackSchema(z.object({}).strict()).safeParse(responses[0]).success).toBe(true);
  });

  it('refuses a malformed payload as INVALID, without running the handler', async () => {
    const d = deps();
    const { ack, responses } = collector();
    const run = vi.fn(async () => ({}));

    await handler(EVENT, payloadSchema, d, run)({ cardId: '' }, ack);

    expect(run).not.toHaveBeenCalled();
    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'INVALID', event: EVENT } });
  });

  it('leaks no zod issues into the refusal', async () => {
    // `INVALID` means a bug in the client, and the client parses the same schema
    // module, so it can say which field itself. Forwarding the issue list would
    // make the server's internal field names part of the wire contract.
    const d = deps();
    const { ack, responses } = collector();
    await handler(EVENT, payloadSchema, d, async () => ({}))({ cardId: '' }, ack);

    expect(JSON.stringify(responses[0])).not.toMatch(/cardId|too_small|invalid_type/);
  });

  it('refuses over the rate limit before parsing or running anything', async () => {
    const d = deps(1);
    const { ack, responses } = collector();
    const run = vi.fn(async () => ({}));
    const wrapped = handler(EVENT, payloadSchema, d, run);

    await wrapped({ cardId: 'card-1' }, ack);
    // Deliberately malformed: if the limiter did not come first, this would be
    // refused as INVALID and the ordering would be untested.
    await wrapped({ nonsense: true }, ack);

    expect(run).toHaveBeenCalledOnce();
    expect(responses[1]).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });

  it.each([
    ['STALE', stale('This card changed while you were moving it.')],
    ['FORBIDDEN', forbidden('A viewer may not move cards on this board.')],
    ['CONFLICT', new BoardOpError('CONFLICT', 'Could not allocate a position.')],
  ])('passes a %s from the domain straight through', async (code, error) => {
    const d = deps();
    const { ack, responses } = collector();

    await handler(EVENT, payloadSchema, d, async () => {
      throw error;
    })({ cardId: 'card-1' }, ack);

    expect(responses[0]).toEqual({
      ok: false,
      error: { code, message: (error as Error).message, event: EVENT },
    });
  });

  it('turns an unknown failure into INTERNAL and tells nobody why', async () => {
    // A Prisma error text can carry a connection string. The real error goes to
    // the log; the client gets a fixed sentence.
    const d = deps();
    const { ack, responses } = collector();
    const secret = new Error('connect ECONNREFUSED postgresql://kan:hunter2@10.0.0.4:5437');

    await handler(EVENT, payloadSchema, d, async () => {
      throw secret;
    })({ cardId: 'card-1' }, ack);

    expect(responses[0]).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(JSON.stringify(responses[0])).not.toMatch(/hunter2|10\.0\.0\.4/);
    expect(d.internals).toEqual([secret]);
  });

  it('never rejects, whatever the handler does', async () => {
    // A throw into Socket.io's emitter takes down the connection for an error the
    // protocol already has a code for.
    const d = deps();
    const { ack } = collector();
    await expect(
      handler(EVENT, payloadSchema, d, async () => {
        throw new Error('boom');
      })({ cardId: 'card-1' }, ack),
    ).resolves.toBeUndefined();
  });

  it('emits server.error when the client sent no ack callback', async () => {
    // A refusal nobody hears leaves the client showing an optimistic change the
    // server rejected.
    const d = deps();

    await handler(EVENT, payloadSchema, d, async () => {
      throw stale('Gone.');
    })({ cardId: 'card-1' });

    expect(d.emitted).toHaveLength(1);
    expect(d.emitted[0]?.[0]).toBe(SERVER_EVENTS.error);
    expect(socketErrorSchema.safeParse(d.emitted[0]?.[1]).success).toBe(true);
  });

  it('stays quiet on success when the client sent no ack callback', async () => {
    // The broadcast is the result. An extra event here would be a second
    // notification of the same write.
    const d = deps();
    await handler(EVENT, payloadSchema, d, async () => ({ ok: 1 }))({ cardId: 'card-1' });
    expect(d.emitted).toEqual([]);
  });

  it('produces an ack that satisfies the protocol’s envelope', async () => {
    const d = deps();
    const { ack, responses } = collector();
    const envelope = ackSchema(z.object({ moved: z.string() }));

    await handler(EVENT, payloadSchema, d, async (p) => ({ moved: p.cardId }))(
      { cardId: 'card-1' },
      ack,
    );
    await handler(EVENT, payloadSchema, d, async () => {
      throw forbidden('No.');
    })({ cardId: 'card-1' }, ack);

    for (const response of responses) {
      expect(envelope.safeParse(response).success).toBe(true);
    }
  });
});
