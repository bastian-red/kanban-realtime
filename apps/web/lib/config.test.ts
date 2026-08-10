import { describe, expect, it } from 'vitest';

import {
  apiBaseUrl,
  appBaseUrl,
  authSecret,
  presenceHeartbeatSeconds,
  realtimeBaseUrl,
  realtimeReplicaUrl,
} from './config';

describe('base URLs', () => {
  it.each([
    [apiBaseUrl, 'API_BASE_URL', 'http://api:4000', 'http://localhost:4000'],
    [realtimeBaseUrl, 'REALTIME_BASE_URL', 'http://realtime:4100', 'http://localhost:4100'],
    [appBaseUrl, 'APP_BASE_URL', 'https://board.example', 'http://localhost:3000'],
  ])('reads %o from the environment, or falls back', (read, name, value, fallback) => {
    expect(read({ [name]: value })).toBe(value);
    expect(read({})).toBe(fallback);
  });

  it('treats a missing second replica as "there is only one"', () => {
    // Null rather than a default, because /status renders a row per replica and a
    // defaulted URL would show a permanently red second gateway on every
    // single-replica setup.
    expect(realtimeReplicaUrl({})).toBeNull();
    expect(realtimeReplicaUrl({ REALTIME_BASE_URL_2: 'http://localhost:4101' })).toBe(
      'http://localhost:4101',
    );
  });
});

describe('presenceHeartbeatSeconds', () => {
  it('reads the same variable the gateway validates against', () => {
    expect(presenceHeartbeatSeconds({ PRESENCE_HEARTBEAT_SECONDS: '15' })).toBe(15);
  });

  it('falls back to the documented default', () => {
    expect(presenceHeartbeatSeconds({})).toBe(10);
  });

  it.each(['', 'soon', '0', '-5'])('refuses %o rather than heartbeating at NaN', (value) => {
    // A NaN interval makes `setInterval` fire immediately and continuously, which
    // turns the presence heartbeat into the rate limiter's first customer.
    expect(presenceHeartbeatSeconds({ PRESENCE_HEARTBEAT_SECONDS: value })).toBe(10);
  });
});

describe('authSecret', () => {
  it('returns a usable secret', () => {
    const secret = 'test-secret-at-least-sixteen-chars';
    expect(authSecret({ AUTH_SECRET: secret })).toBe(secret);
  });

  it.each([
    ['missing', {}],
    ['empty', { AUTH_SECRET: '' }],
    ['too short', { AUTH_SECRET: 'short' }],
  ])('throws when it is %s, rather than minting a token nobody can verify', (_label, env) => {
    // Defaulting here would produce 401s on every request and a failed handshake
    // on every board, with nothing in either message naming the variable.
    expect(() => authSecret(env)).toThrow(/AUTH_SECRET/);
  });
});
