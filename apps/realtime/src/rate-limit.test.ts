import { describe, expect, it } from 'vitest';

import { DEFAULT_WINDOW_MS, SocketRateLimiter } from './rate-limit';

/** A clock the test moves by hand, so a one-minute window costs no seconds. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

describe('SocketRateLimiter', () => {
  it('allows exactly the limit, then refuses', () => {
    const limiter = new SocketRateLimiter({ limit: 3, now: clock().now });
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('drains as the window slides, one event at a time', () => {
    // The property that makes this a sliding window rather than a fixed one:
    // capacity comes back gradually as individual events age out, not all at once
    // on a boundary.
    const time = clock();
    const limiter = new SocketRateLimiter({ limit: 2, now: time.now });

    expect(limiter.take()).toBe(true);
    time.advance(30_000);
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);

    // The first event is now 60.001s old and has left the window; the second is
    // 30s old and has not.
    time.advance(30_001);
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  it('does not let a fixed-window boundary allow twice the limit', () => {
    // A fixed window resets on the minute, so a client sends the whole budget at
    // 59.9s and the whole budget again at 60.1s: 2x the limit in 200ms, which is
    // the exact burst the limit exists to stop.
    const time = clock();
    const limiter = new SocketRateLimiter({ limit: 4, now: time.now });

    time.advance(59_900);
    for (let i = 0; i < 4; i += 1) expect(limiter.take()).toBe(true);

    time.advance(200);
    expect(limiter.take()).toBe(false);
  });

  it('does not count refused events, so a burst is not a permanent block', () => {
    // If refusals were recorded, a client that keeps sending would keep the window
    // full forever and never recover.
    const time = clock();
    const limiter = new SocketRateLimiter({ limit: 1, now: time.now });

    expect(limiter.take()).toBe(true);
    for (let i = 0; i < 50; i += 1) expect(limiter.take()).toBe(false);

    time.advance(DEFAULT_WINDOW_MS + 1);
    expect(limiter.take()).toBe(true);
  });

  it('reports what is left, for the refusal message', () => {
    const time = clock();
    const limiter = new SocketRateLimiter({ limit: 3, now: time.now });

    expect(limiter.remaining()).toBe(3);
    limiter.take();
    expect(limiter.remaining()).toBe(2);
    time.advance(DEFAULT_WINDOW_MS + 1);
    expect(limiter.remaining()).toBe(3);
  });

  it('refuses to be built with a limit that would refuse everything', () => {
    expect(() => new SocketRateLimiter({ limit: 0 })).toThrow(/positive integer/);
    expect(() => new SocketRateLimiter({ limit: -1 })).toThrow(/positive integer/);
    expect(() => new SocketRateLimiter({ limit: 1.5 })).toThrow(/positive integer/);
  });
});
