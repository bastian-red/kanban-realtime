import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, PACKAGE_VERSION } from './config';

/** The two names with no default. Everything else may be absent. */
const REQUIRED = {
  DATABASE_URL: 'postgresql://kan:kan@localhost:5437/kan',
  REDIS_URL: 'redis://localhost:6384',
  AUTH_SECRET: 'test-secret-at-least-sixteen-chars',
};

describe('loadConfig', () => {
  it('reads a full environment', () => {
    const config = loadConfig({
      ...REQUIRED,
      NODE_ENV: 'production',
      REALTIME_PORT: '4100',
      APP_VERSION: '1.2.3',
      APP_BASE_URL: 'https://board.example',
      MOVE_RETRY_ATTEMPTS: '7',
      PRESENCE_HEARTBEAT_SECONDS: '10',
      PRESENCE_TTL_SECONDS: '25',
      SOCKET_MAX_PAYLOAD_BYTES: '65536',
      SOCKET_EVENT_RATE_LIMIT: '240',
    });

    expect(config).toEqual({
      nodeEnv: 'production',
      port: 4100,
      version: '1.2.3',
      databaseUrl: REQUIRED.DATABASE_URL,
      redisUrl: REQUIRED.REDIS_URL,
      authSecret: REQUIRED.AUTH_SECRET,
      appBaseUrl: 'https://board.example',
      moveRetryAttempts: 7,
      presence: { heartbeatSeconds: 10, ttlSeconds: 25 },
      socket: { maxPayloadBytes: 65_536, eventRateLimit: 240 },
    });
  });

  it('falls back to the documented defaults', () => {
    const config = loadConfig(REQUIRED);
    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 4100,
      version: PACKAGE_VERSION,
      appBaseUrl: 'http://localhost:3000',
      moveRetryAttempts: 5,
      presence: { heartbeatSeconds: 10, ttlSeconds: 25 },
      socket: { maxPayloadBytes: 65_536, eventRateLimit: 240 },
    });
  });

  it('lets PORT win over REALTIME_PORT', () => {
    // This is how infra/docker-compose.yml runs a second replica of the same
    // image on 4101. If REALTIME_PORT won, both replicas would bind 4100 and the
    // horizontal-scaling proof would have nothing to prove.
    expect(loadConfig({ ...REQUIRED, PORT: '4101', REALTIME_PORT: '4100' }).port).toBe(4101);
  });

  it('treats an empty value as unset, because .env files are full of NAME=', () => {
    const config = loadConfig({ ...REQUIRED, APP_VERSION: '', REALTIME_PORT: '' });
    expect(config.version).toBe(PACKAGE_VERSION);
    expect(config.port).toBe(4100);
  });

  it('does not turn an empty numeric variable into NaN', () => {
    // `z.preprocess(fn, schema).default(x)` never applies the default, because
    // preprocess always produces a value and zod only reaches a default when the
    // field is absent. The result is NaN where a number was expected, several
    // layers away.
    const config = loadConfig({ ...REQUIRED, MOVE_RETRY_ATTEMPTS: '' });
    expect(Number.isNaN(config.moveRetryAttempts)).toBe(false);
    expect(config.moveRetryAttempts).toBe(5);
  });

  it.each([
    ['DATABASE_URL', { ...REQUIRED, DATABASE_URL: '' }],
    ['REDIS_URL', { ...REQUIRED, REDIS_URL: '' }],
    ['AUTH_SECRET', { ...REQUIRED, AUTH_SECRET: 'too-short' }],
  ])('refuses to start without a usable %s, and names it', (name, env) => {
    // A gateway that boots with AUTH_SECRET undefined does not fail at boot: every
    // handshake fails instead, which presents as a board that renders and never
    // moves.
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it('names PORT and REALTIME_PORT together when the port is unusable', () => {
    expect(() => loadConfig({ ...REQUIRED, REALTIME_PORT: '70000' })).toThrow(
      /PORT \(or REALTIME_PORT\)/,
    );
  });

  it('refuses an out-of-range presence heartbeat rather than silently defaulting', () => {
    expect(() => loadConfig({ ...REQUIRED, PRESENCE_HEARTBEAT_SECONDS: '0' })).toThrow(
      /PRESENCE_HEARTBEAT_SECONDS/,
    );
  });

  it('reports every problem at once', () => {
    // One line per variable. Fixing them one restart at a time is how a five-line
    // .env mistake becomes five deploys.
    let message = '';
    try {
      loadConfig({ AUTH_SECRET: 'short' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/REDIS_URL/);
    expect(message).toMatch(/AUTH_SECRET/);
  });
});
