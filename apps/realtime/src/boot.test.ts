import { describe, expect, it } from 'vitest';

import { assertBootable } from './boot';
import { ConfigError, type RealtimeConfig } from './config';

const base = (): RealtimeConfig => ({
  nodeEnv: 'development',
  port: 4100,
  version: '0.1.0',
  databaseUrl: 'postgresql://kan:kan@localhost:5437/kan',
  redisUrl: 'redis://localhost:6384',
  authSecret: 'test-secret-at-least-sixteen-chars',
  appBaseUrl: 'http://localhost:3000',
  moveRetryAttempts: 5,
  presence: { heartbeatSeconds: 10, ttlSeconds: 25 },
  socket: { maxPayloadBytes: 65_536, eventRateLimit: 240 },
});

describe('assertBootable', () => {
  it('accepts the shipped .env.example values', () => {
    expect(() => assertBootable(base())).not.toThrow();
  });

  it.each([
    ['a relative APP_BASE_URL', { appBaseUrl: '/board' }, /APP_BASE_URL/],
    ['a mysql DATABASE_URL', { databaseUrl: 'mysql://kan@localhost/kan' }, /DATABASE_URL/],
    ['an http REDIS_URL', { redisUrl: 'http://localhost:6384' }, /REDIS_URL/],
  ])('refuses %s', (_label, overrides, pattern) => {
    expect(() => assertBootable({ ...base(), ...overrides })).toThrow(ConfigError);
    expect(() => assertBootable({ ...base(), ...overrides })).toThrow(pattern);
  });

  it('refuses a presence TTL at or below twice the heartbeat', () => {
    // At exactly 2x, one dropped heartbeat evicts somebody who is still looking
    // at the board, and a presence bar that flickers is worse than one that is a
    // few seconds stale. Checked at boot rather than when the first socket
    // connects, so a misconfigured gateway does not pass its own health check and
    // then throw on the first ping.
    expect(() =>
      assertBootable({ ...base(), presence: { heartbeatSeconds: 10, ttlSeconds: 20 } }),
    ).toThrow(/PRESENCE_TTL_SECONDS/);
  });

  it('refuses a rate limit that would throttle presence itself', () => {
    // A client sends 6 heartbeats a minute at the default interval before it does
    // anything a person asked for. A limit near that starts refusing drags on a
    // board nobody is even using -- and the refusal would look like a bug in the
    // drag rather than a number in .env.
    expect(() =>
      assertBootable({ ...base(), socket: { maxPayloadBytes: 65_536, eventRateLimit: 10 } }),
    ).toThrow(/SOCKET_EVENT_RATE_LIMIT/);
  });

  it('accepts a rate limit with room for heartbeats plus real work', () => {
    expect(() =>
      assertBootable({ ...base(), socket: { maxPayloadBytes: 65_536, eventRateLimit: 24 } }),
    ).not.toThrow();
  });

  it('refuses the CI placeholder secret in production', () => {
    // The placeholder is allowlisted in .gitleaks.toml because the test lanes use
    // it deliberately, which is exactly why it needs refusing here: an
    // allowlisted string is one nobody's scanner will ever complain about again.
    expect(() =>
      assertBootable({ ...base(), nodeEnv: 'production', authSecret: 'ci-secret-for-tests-only' }),
    ).toThrow(/AUTH_SECRET/);
  });

  it('allows the CI placeholder outside production, because the lanes need it', () => {
    expect(() =>
      assertBootable({ ...base(), nodeEnv: 'test', authSecret: 'ci-secret-for-tests-only' }),
    ).not.toThrow();
  });

  it('reports every problem at once, one line each', () => {
    let message = '';
    try {
      assertBootable({
        ...base(),
        appBaseUrl: 'board',
        databaseUrl: 'mysql://x',
        redisUrl: 'http://x',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message.split('\n')).toHaveLength(4);
  });
});
