import { describe, expect, it } from 'vitest';

import { assertBootable } from './boot';
import { ConfigError, loadConfig } from './config';

const base = (overrides: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    DATABASE_URL: 'postgresql://kan:kan@localhost:5437/kan?schema=public',
    REDIS_URL: 'redis://localhost:6384',
    AUTH_SECRET: 'a-secret-that-is-long-enough',
    ...overrides,
  });

describe('assertBootable', () => {
  it('accepts a sane configuration', () => {
    expect(() => assertBootable(base())).not.toThrow();
  });

  it('refuses a relative APP_BASE_URL', () => {
    // Parses fine as a string; fails at the point something builds a link with
    // it, which is the activity feed, on a request unrelated to the mistake.
    expect(() => assertBootable(base({ APP_BASE_URL: '/boards' }))).toThrow(/APP_BASE_URL/);
  });

  it('refuses a Redis URL in the Postgres slot', () => {
    // The copy-paste between two adjacent lines of .env. Without this the failure
    // is a connection error naming neither variable.
    expect(() => assertBootable(base({ DATABASE_URL: 'redis://localhost:6384' }))).toThrow(
      /DATABASE_URL/,
    );
    expect(() =>
      assertBootable(base({ REDIS_URL: 'postgresql://kan@localhost:5437/kan' })),
    ).toThrow(/REDIS_URL/);
  });

  it('refuses the CI placeholder secret in production', () => {
    // That string is allowlisted in .gitleaks.toml so CI can use it, which means
    // no scanner will ever object to it again. This check is the only thing
    // between it and a production deploy.
    expect(() =>
      assertBootable(
        base({ AUTH_SECRET: 'ci-secret-at-least-32-characters-long', NODE_ENV: 'production' }),
      ),
    ).toThrow(ConfigError);

    // And it is allowed everywhere else, because the test lanes genuinely use it.
    expect(() =>
      assertBootable(base({ AUTH_SECRET: 'ci-secret-at-least-32-characters-long' })),
    ).not.toThrow();
  });

  it('reports every problem at once', () => {
    try {
      assertBootable(base({ APP_BASE_URL: 'boards', REDIS_URL: 'http://localhost:6384' }));
      throw new Error('expected a ConfigError');
    } catch (error) {
      expect((error as Error).message).toMatch(/APP_BASE_URL/);
      expect((error as Error).message).toMatch(/REDIS_URL/);
    }
  });
});
