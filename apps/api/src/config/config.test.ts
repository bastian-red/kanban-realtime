import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, PACKAGE_VERSION } from './config';

/**
 * A complete, valid environment. Every test starts from this and breaks one
 * thing, so a failure names the one variable it is about.
 */
const VALID = {
  DATABASE_URL: 'postgresql://kan:kan@localhost:5437/kan?schema=public',
  REDIS_URL: 'redis://localhost:6384',
  AUTH_SECRET: 'a-secret-that-is-long-enough',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('reads a valid environment', () => {
    const config = loadConfig(VALID);
    expect(config.databaseUrl).toBe(VALID.DATABASE_URL);
    expect(config.authSecret).toBe(VALID.AUTH_SECRET);
  });

  it('applies every default', () => {
    // The defaults are the documented behaviour of a fresh clone, so they are
    // asserted rather than assumed. They also have to agree with .env.example,
    // which scripts/env-contract.mjs keeps honest in the other direction.
    const config = loadConfig(VALID);
    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe('development');
    expect(config.version).toBe(PACKAGE_VERSION);
    expect(config.moveRetryAttempts).toBe(5);
    expect(config.activityPageSize).toBe(25);
    expect(config.rateLimits).toEqual({ global: 240, auth: 5 });
  });

  it('applies a default through the preprocess, which is the trap', () => {
    // `z.preprocess(fn, schema).default(x)` never applies the default: preprocess
    // always produces a value (undefined counts) and zod only reaches a default
    // when the field is absent. The result is NaN where a number was expected,
    // several layers away. The defaults here sit on the inner schema, and this
    // asserts it: an empty string must become the default, not NaN.
    const config = loadConfig({ ...VALID, PORT: '', MOVE_RETRY_ATTEMPTS: '' });
    expect(config.port).toBe(4000);
    expect(config.moveRetryAttempts).toBe(5);
    expect(Number.isNaN(config.port)).toBe(false);
  });

  it('prefers PORT over API_PORT', () => {
    // PORT is the name every container runtime injects, and
    // infra/Dockerfile.api's healthcheck reads the same precedence. If they
    // disagreed the container would probe a port nothing is listening on and
    // restart-loop a perfectly healthy process.
    expect(loadConfig({ ...VALID, API_PORT: '4000', PORT: '9999' }).port).toBe(9999);
    expect(loadConfig({ ...VALID, API_PORT: '4001' }).port).toBe(4001);
  });

  it('refuses a missing DATABASE_URL, naming it', () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = VALID;
    expect(() => loadConfig(withoutDatabase)).toThrow(ConfigError);
    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('refuses a short AUTH_SECRET at the same length scripts/dev.sh checks', () => {
    // 16. If these two disagreed, `pnpm dev` would pass its own preflight and the
    // process would then refuse to start, which reads as a broken repo rather
    // than a short secret.
    expect(() => loadConfig({ ...VALID, AUTH_SECRET: 'short' })).toThrow(/at least 16/);
    expect(loadConfig({ ...VALID, AUTH_SECRET: 'x'.repeat(16) }).authSecret).toHaveLength(16);
  });

  it('refuses a port outside the range rather than binding to nothing', () => {
    expect(() => loadConfig({ ...VALID, PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, PORT: 'four thousand' })).toThrow(ConfigError);
  });

  it('refuses a retry ceiling of zero', () => {
    // Zero attempts means every contended move fails immediately with CONFLICT,
    // which would look exactly like the concurrency bug this project exists to
    // avoid while actually being a misconfiguration.
    expect(() => loadConfig({ ...VALID, MOVE_RETRY_ATTEMPTS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, MOVE_RETRY_ATTEMPTS: '-1' })).toThrow(ConfigError);
  });

  it('reports every problem at once, not the first', () => {
    // A reader fixing one variable per restart is a reader restarting five times.
    const { DATABASE_URL: _d, REDIS_URL: _r, ...broken } = VALID;
    try {
      loadConfig({ ...broken, AUTH_SECRET: 'tiny' });
      throw new Error('expected a ConfigError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/DATABASE_URL/);
      expect(message).toMatch(/REDIS_URL/);
      expect(message).toMatch(/AUTH_SECRET/);
    }
  });

  it('names PORT the way a reader sets it, not the way the schema spells it', () => {
    // The schema field is `port`; the thing to edit in .env is PORT or API_PORT.
    // An error that says "port: expected number" sends somebody looking for a
    // lowercase variable that does not exist.
    try {
      loadConfig({ ...VALID, PORT: 'nonsense' });
      throw new Error('expected a ConfigError');
    } catch (error) {
      expect((error as Error).message).toMatch(/PORT \(or API_PORT\)/);
    }
  });

  it('does not read process.env when handed an environment', () => {
    // The property that lets these tests run in parallel and lets the API be
    // instantiated twice in one process (which the integration lane does).
    const config = loadConfig({ ...VALID, APP_VERSION: '9.9.9' });
    expect(config.version).toBe('9.9.9');
  });
});
