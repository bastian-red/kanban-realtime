/**
 * Everything the API reads from the environment, read once, in one place.
 *
 * A plain function rather than `@nestjs/config`, for two reasons that are both
 * load-bearing rather than stylistic.
 *
 * **`env` is a parameter with a default.** `loadConfig(fake)` is how every branch
 * below gets a unit test without touching `process.env` and without the tests
 * having to run serially. It is also what `scripts/env-contract.mjs` can see: the
 * scanner matches `env.NAME`, so a name read through a helper, a destructure or a
 * loop over a list of keys is invisible to it, and an invisible read is exactly
 * the one that goes undeclared in `turbo.json` and gets stripped in strict mode.
 * Every name below is therefore spelled out as `env.NAME`, once, in the literal.
 *
 * **It throws, naming the variable.** An API that boots with `AUTH_SECRET`
 * undefined does not fail at boot: it fails on the first request that verifies a
 * token, three layers down, as a 500 with a stack trace about `undefined`. Three
 * sibling projects in this portfolio all shipped that way. Failing here costs one
 * line of output and names the knob to fix.
 */
import { z } from 'zod';

/**
 * Mirrors the `version` field of `apps/api/package.json`.
 *
 * A constant rather than an import of the manifest: `rootDir` is `src`, so
 * reaching up to `../../package.json` puts a file outside the compilation root
 * and `tsc` refuses. `APP_VERSION` is what a real deployment sets anyway, from
 * the image tag; this is the value that shows up when nobody set it.
 */
export const PACKAGE_VERSION = '0.1.0';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface RateLimitConfig {
  /** Requests per minute, per client address. */
  global: number;
  auth: number;
}

export interface ApiConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  version: string;
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  appBaseUrl: string;
  /**
   * How many times a move re-generates its fractional index after Postgres
   * rejects it with a unique violation on (list_id, position).
   *
   * Passed to `services/board-ops` on every call rather than read there, so the
   * service stays free of environment access and its tests can vary it.
   */
  moveRetryAttempts: number;
  activityPageSize: number;
  rateLimits: RateLimitConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** An empty string is an unset variable. `.env` files are full of `NAME=`. */
const blankToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || value === '' ? undefined : value;

const toNumber = (value: unknown): unknown =>
  blankToUndefined(value) === undefined ? undefined : Number(value);

/**
 * Defaults and `.optional()` sit on the **inner** schema, never outside the
 * preprocess.
 *
 * `z.preprocess(fn, schema).default(x)` never applies the default, because
 * preprocess always produces a value (`undefined` counts) and zod only reaches a
 * default when the field is absent. The result is `NaN` where a number was
 * expected, several layers from here.
 */
const port = (fallback: number) =>
  z.preprocess(toNumber, z.number().int().min(1).max(65_535).default(fallback));

const count = (fallback: number, max: number) =>
  z.preprocess(toNumber, z.number().int().min(1).max(max).default(fallback));

const schema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: port(4000),
  version: z.string().min(1).default(PACKAGE_VERSION),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  redisUrl: z.string().min(1, 'REDIS_URL is required'),
  // 16, matching scripts/dev.sh's check. The two have to agree or `pnpm dev`
  // passes its own preflight and the process then refuses to start.
  authSecret: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
  appBaseUrl: z.string().min(1),
  moveRetryAttempts: count(5, 20),
  activityPageSize: count(25, 100),
  rateLimits: z.object({
    global: count(240, 1_000_000),
    auth: count(5, 1_000_000),
  }),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse({
    nodeEnv: blankToUndefined(env.NODE_ENV),
    // PORT wins over API_PORT: it is the name every container runtime injects,
    // and infra/Dockerfile.api's healthcheck reads the same precedence.
    port: blankToUndefined(env.PORT) ?? blankToUndefined(env.API_PORT),
    version: blankToUndefined(env.APP_VERSION),
    databaseUrl: blankToUndefined(env.DATABASE_URL),
    redisUrl: blankToUndefined(env.REDIS_URL),
    authSecret: blankToUndefined(env.AUTH_SECRET),
    appBaseUrl: blankToUndefined(env.APP_BASE_URL) ?? 'http://localhost:3000',
    moveRetryAttempts: blankToUndefined(env.MOVE_RETRY_ATTEMPTS),
    activityPageSize: blankToUndefined(env.ACTIVITY_PAGE_SIZE),
    rateLimits: {
      global: blankToUndefined(env.RATE_LIMIT_GLOBAL),
      auth: blankToUndefined(env.RATE_LIMIT_AUTH),
    },
  });

  if (!parsed.success) {
    // One line per problem, each naming the variable. `path` is the schema's
    // field name, which is camelCase, so it is mapped back to the environment
    // name a reader can actually set.
    const problems = parsed.error.issues
      .map(
        (issue) =>
          `  ${ENV_NAME_FOR[issue.path.join('.')] ?? issue.path.join('.')}: ${issue.message}`,
      )
      .join('\n');
    throw new ConfigError(`The API cannot start. Fix these in .env:\n${problems}`);
  }

  return parsed.data;
}

/** Schema field path -> the environment variable a reader sets. */
const ENV_NAME_FOR: Record<string, string> = {
  nodeEnv: 'NODE_ENV',
  port: 'PORT (or API_PORT)',
  version: 'APP_VERSION',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
  authSecret: 'AUTH_SECRET',
  appBaseUrl: 'APP_BASE_URL',
  moveRetryAttempts: 'MOVE_RETRY_ATTEMPTS',
  activityPageSize: 'ACTIVITY_PAGE_SIZE',
  'rateLimits.global': 'RATE_LIMIT_GLOBAL',
  'rateLimits.auth': 'RATE_LIMIT_AUTH',
};
