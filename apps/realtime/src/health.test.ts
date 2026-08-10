import { realtimeHealthSchema } from '@kan/shared';
import { describe, expect, it, vi } from 'vitest';

import { checkHealth, timed, type HealthDeps } from './health';

/**
 * Fakes rather than a real Redis.
 *
 * What this file pins is the *shape* of the report and the rules around it: that
 * one failing dependency degrades the whole thing, that a failure names itself,
 * that a slow probe is a failure rather than a hang. Whether the adapter's
 * round trip actually reaches a second replica is not a question a fake can
 * answer, and it is proven where it can be -- in the integration lane, with two
 * gateways and a real Redis.
 */
function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  const ok = () => Promise.resolve('PONG');
  return {
    prisma: {
      $queryRaw: () => Promise.resolve([{ '?column?': 1 }]),
    } as unknown as HealthDeps['prisma'],
    pub: { ping: ok, publish: () => Promise.resolve(1) } as unknown as HealthDeps['pub'],
    sub: {
      subscribe: () => Promise.resolve(1),
      unsubscribe: () => Promise.resolve(1),
      on: (_event: string, listener: (channel: string, message: string) => void) => {
        // Loop the nonce straight back, which is what a working adapter does.
        queueMicrotask(() => listener('socket.io#health', lastNonce ?? ''));
      },
      off: () => undefined,
    } as unknown as HealthDeps['sub'],
    version: '0.1.0',
    startedAt: Date.now() - 42_000,
    counts: () => ({ connectedSockets: 3, rooms: 2 }),
    ...overrides,
  };
}

/**
 * The fake `sub` has to echo the nonce `roundTrip` generated, and `roundTrip`
 * generates it internally. Capturing it off `publish` is how the fake learns it.
 */
let lastNonce: string | null = null;
function capturingPub(): HealthDeps['pub'] {
  return {
    ping: () => Promise.resolve('PONG'),
    publish: (_channel: string, message: string) => {
      lastNonce = message;
      return Promise.resolve(1);
    },
  } as unknown as HealthDeps['pub'];
}

describe('checkHealth', () => {
  it('reports ok with all three probes green', async () => {
    const health = await checkHealth(deps({ pub: capturingPub() }));

    expect(health.status).toBe('ok');
    expect(health.checks.map((check) => check.name)).toEqual(['postgres', 'redis', 'adapter']);
    expect(health.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('satisfies the shared health contract', async () => {
    // The /status page renders the API's report and this one with one component.
    // A field this process invents is a field that page cannot show.
    const health = await checkHealth(deps({ pub: capturingPub() }));
    expect(realtimeHealthSchema.safeParse(health).success).toBe(true);
  });

  it('carries the socket and room counts', async () => {
    const health = await checkHealth(deps({ pub: capturingPub() }));
    expect(health.connectedSockets).toBe(3);
    expect(health.rooms).toBe(2);
  });

  it('counts uptime from when the process could serve, not from process start', async () => {
    const health = await checkHealth(deps({ pub: capturingPub() }));
    expect(health.uptimeSeconds).toBe(42);
  });

  it('degrades when Postgres is unreachable, and says so', async () => {
    const health = await checkHealth(
      deps({
        pub: capturingPub(),
        prisma: {
          $queryRaw: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5437')),
        } as unknown as HealthDeps['prisma'],
      }),
    );

    expect(health.status).toBe('degraded');
    const postgres = health.checks.find((check) => check.name === 'postgres');
    expect(postgres?.status).toBe('fail');
    expect(postgres?.detail).toContain('ECONNREFUSED');
  });

  it('degrades when the adapter round trip never comes back', async () => {
    // The failure this endpoint exists for: the process is alive, Redis answers
    // PING, sockets are connected -- and nothing this replica publishes reaches
    // any other one. A liveness probe reports green through all of it.
    const silent = {
      subscribe: () => Promise.resolve(1),
      unsubscribe: () => Promise.resolve(1),
      on: () => undefined,
      off: () => undefined,
    } as unknown as HealthDeps['sub'];

    const health = await checkHealth(deps({ pub: capturingPub(), sub: silent }));

    expect(health.status).toBe('degraded');
    const adapter = health.checks.find((check) => check.name === 'adapter');
    expect(adapter?.status).toBe('fail');
    expect(adapter?.detail).toMatch(/timed out/);
    // Redis itself is fine, which is exactly why the adapter probe is separate.
    expect(health.checks.find((check) => check.name === 'redis')?.status).toBe('ok');
  }, 10_000);
});

describe('timed', () => {
  it('reports a latency and no detail on success', async () => {
    const check = await timed('probe', async () => 'fine');
    expect(check).toMatchObject({ name: 'probe', status: 'ok', detail: null });
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('turns a rejection into a named failure rather than throwing', async () => {
    const check = await timed('probe', async () => {
      throw new Error('nope');
    });
    expect(check).toMatchObject({ name: 'probe', status: 'fail', detail: 'nope' });
  });

  it('clears its timer, so a fast success does not hold the event loop open', async () => {
    // Without the `finally`, /health becomes the reason a process takes two
    // seconds to exit on SIGTERM.
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await timed('probe', async () => 'fine');
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
