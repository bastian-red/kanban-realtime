/**
 * Refusals that a schema cannot express.
 *
 * `loadConfig` checks the *shape* of every value. This checks values whose shape
 * is fine and whose meaning is not -- the ones that would otherwise fail hours
 * later, on a request that has nothing to do with the mistake.
 *
 * Called from `main.ts` before `NestFactory.create`, so a bad value is one
 * printed line rather than a Nest dependency-resolution stack with the real
 * message four frames down.
 */
import { ConfigError } from './config';
import type { ApiConfig } from './config';

export function assertBootable(config: ApiConfig): void {
  const problems: string[] = [];

  // A relative APP_BASE_URL parses as a string and fails at the point something
  // builds a link with it, which here is the activity feed's board links.
  if (!/^https?:\/\//.test(config.appBaseUrl)) {
    problems.push(
      `APP_BASE_URL must be absolute (http:// or https://), got ${JSON.stringify(config.appBaseUrl)}.`,
    );
  }

  // Postgres and Redis URLs that name the wrong scheme are a common copy-paste
  // between the two lines of .env, and the failure is a connection error that
  // names neither variable.
  if (!/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    problems.push('DATABASE_URL must start with postgresql://');
  }
  if (!/^rediss?:\/\//.test(config.redisUrl)) {
    problems.push('REDIS_URL must start with redis:// or rediss://');
  }

  /**
   * A production process with the development secret.
   *
   * The placeholder is allowlisted in .gitleaks.toml because CI and the test
   * lanes use it deliberately. That is exactly why it needs refusing here: an
   * allowlisted string is one nobody's scanner will ever complain about again,
   * so the only thing standing between it and production is this check.
   */
  if (config.nodeEnv === 'production' && config.authSecret.startsWith('ci-secret')) {
    problems.push(
      'AUTH_SECRET is the CI placeholder and NODE_ENV is production. ' +
        'Generate a real one: openssl rand -base64 32',
    );
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `The API cannot start:\n${problems.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}
